// Entry: one-shot commands, then the probe loop + TUI.
import { statSync, unlinkSync } from 'node:fs';
import { HELP, opts } from './cli.mjs';
import {
  ACTIVE_REFRESH_AHEAD_MS, CACHE_FILE, CACHE_TTL_MS, CLAUDE_JSON, CODEX_INTERVAL_MS, FAIL_FILE, MAX_BACKOFF_MS, MIN_BACKOFF_MS, OTHER_INTERVAL_MS, PS_POLL_MS,
  REFRESH_AHEAD_MS, REFRESH_LOCK, REFRESH_RETRY_MS, RESET_CONFIRM_MS,
} from './config.mjs';
import { consumeCodexResetCredit, countCodexProcs, fetchCodexResetCredits, fetchCodexUsage, loadCodexAuth, normalizeCodexCredits } from './codex.mjs';
import { CODEX_AUTO_INTERVAL_MS, CODEX_AUTO_THRESHOLD, codexAutoEnabled, createCodexResetGuard, reloadCodexAuto, setCodexAuto, startCodexPolling } from './codex-auto.mjs';
import { archiveActive, archiveUsage, forgetAccount, listAccounts, logActiveAccount, readAccount, saveAccount } from './archive.mjs';
import { ENV_TOKEN_OVERRIDE, loadAccount, loadCredentialBlob, loadCredentials, planLabel, writeCredentials } from './credentials.mjs';
import { ESC, fmtDur, paint, skeletonShown } from './format.mjs';
import { countClaudeProcs } from './local.mjs';
import { withLockAsync } from './lock.mjs';
import { browserLogin, refreshOauth } from './oauth.mjs';
import { AUTO_THRESHOLD, autoEnabled, pickCandidate, setAuto, usageSummary } from './auto.mjs';
import { activeIndex, cardList, render, rowList } from './render.mjs';
import { createFrameWriter } from './terminal.mjs';
import { HANDOVER_NOTE, storeLogin, switchTo } from './switch.mjs';
import { bankedCount, claimReset, fetchUsage, markFail, normalize, projectRows, readCache, usableGrant } from './usage.mjs';

const firstLine = e => String(e?.message || e).split('\n')[0];
const sameEmail = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const backoff = (prev, retryAfterMs) => Math.max(retryAfterMs || 0, Math.min((prev || MIN_BACKOFF_MS / 2) * 2, MAX_BACKOFF_MS));


// Accept a partial email for select/forget: an exact match wins, otherwise a
// unique case-insensitive substring of an archived account's email.
function resolveEmail(input) {
  const q = input.toLowerCase();
  const all = listAccounts().map(r => r.email);
  const exact = all.filter(e => e.toLowerCase() === q);
  const matches = exact.length ? exact : all.filter(e => e.toLowerCase().includes(q));
  if (matches.length > 1) throw new Error(`'${input}' matches several accounts: ${matches.join(', ')}`);
  return matches[0] || input; // no match: pass through, the command reports "nothing archived"
}

// Session-bucket summary from the archived usage snapshot, aged to `now`.
function sessionSummary(rec, now) {
  if (!rec.usage) return '';
  const rows = projectRows(normalize(rec.usage).rows, now);
  const s = rows.find(r => r.window === 'session');
  if (!s) return '';
  if (s.resetsAt == null || s.percent == null) return '  session idle';
  return `  session ${Math.round(s.percent)}%${s.percent >= 100 ? ' FULL' : ''} resets ${fmtDur(Date.parse(s.resetsAt) - now)}`;
}

// ─── One-shot commands ───────────────────────────────────────────────────────
async function runCommand() {
  if (opts.help) { console.log(HELP); return true; }
  if (opts.whoami) { console.log(loadAccount().email || 'nobody logged in'); return true; }
  if (opts.accounts) {
    const cur = loadAccount().email;
    const list = listAccounts();
    if (!list.length) { console.log('no archived accounts yet — run agent-usage while logged in and they get archived automatically'); return true; }
    const now = Date.now();
    for (const r of list) {
      const exp = Number(r.oauth?.expiresAt) || 0, rexp = Number(r.oauth?.refreshTokenExpiresAt) || 0;
      console.log(`${r.email === cur ? '*' : ' '} ${r.email.padEnd(28)} ${planLabel(r.oauth).padEnd(10)} seen ${fmtDur(now - (r.seenAt || 0)).padEnd(6)} ago  token ${exp > now ? `valid ${fmtDur(exp - now)}` : 'expired'}  refresh ${rexp ? (rexp > now ? `valid ${fmtDur(rexp - now)}` : 'EXPIRED') : '?'}${sessionSummary(r, now)}`);
    }
    return true;
  }
  if (opts.forget != null) {
    if (!opts.forget) throw new Error('forget needs an email');
    const email = resolveEmail(opts.forget);
    console.log(forgetAccount(email) ? `forgot ${email}` : `${email}: nothing archived`);
    return true;
  }
  if (opts.switchTo != null) {
    if (!opts.switchTo) throw new Error('select needs an email');
    const email = resolveEmail(opts.switchTo);
    const r = switchTo(email);
    console.log(r.already ? `${email} is already the logged-in account` : `switched Claude Code to ${email}${r.running ? ` — ${r.running} running claude session(s) ${HANDOVER_NOTE}` : ''}`);
    return true;
  }
  if (opts.login) {
    const r = await browserLogin({ onStatus: m => console.error(m) });
    console.log(storeLogin(r, { activate: true }));
    return true;
  }
  if (opts.auto != null) {
    const v = opts.auto.toLowerCase();
    if (v === 'on' || v === 'off') setAuto(v === 'on');
    else if (v) throw new Error(`auto takes 'on' or 'off', not '${opts.auto}'`);
    console.log(`auto-switch: ${autoEnabled() ? 'on' : 'off'} (at ${AUTO_THRESHOLD}% session usage, while the TUI runs)`);
    const c = pickCandidate(loadAccount().email);
    console.log(c
      ? `next: ${c.email} (session ${Math.round(c.sess)}%, fable ${Math.round(c.fable)}%, resets ${fmtDur(c.tts)})`
      : 'next: no eligible account');
    return true;
  }
  if (opts.reset != null) {
    if (!opts.reset) throw new Error('reset needs a target: an account email (or unique substring) or `codex`');
    const app = createApp();
    await app.probe(true); // fresh numbers, fresh grant list (the plain shared cache carries no grants)
    const t = /^codex$/i.test(opts.reset) ? app.resetTargetFor({ kind: 'codex' }) : app.resetTargetFor({ kind: 'claude', email: resolveEmail(opts.reset) });
    if (t.error) throw new Error(t.error);
    const r = await app.useReset(t);
    console.log(r.text);
    process.exit(r.ok ? 0 : 1);
  }
  if (opts.autoReset != null) {
    const v = opts.autoReset.toLowerCase();
    if (v === 'on' || v === 'off') setCodexAuto(v === 'on');
    else if (v) throw new Error(`auto-reset takes 'on' or 'off', not '${opts.autoReset}'`);
    console.log(`codex auto use reset: ${codexAutoEnabled() ? 'on' : 'off'} (usage ≥${CODEX_AUTO_THRESHOLD}% and that window's reset ≥1 day away, checked every ${CODEX_AUTO_INTERVAL_MS / 1000}s while live mode runs)`);
    return true;
  }
  return false;
}

// ─── Probe loop ──────────────────────────────────────────────────────────────
export function createApp({ live = false } = {}) {
  const codexResetGuard = createCodexResetGuard();
  let cred = {};
  try { cred = loadCredentials(); } catch { /* nobody logged in: archived cards still work */ }
  const state = {
    cred, account: loadAccount(), usage: null, usageAt: null, error: null,
    probing: false, pendingForce: false, backoffMs: 0, backoffUntil: 0, activeRefresh: null, activeRefreshTriedAt: 0,
    sessions: 0, others: new Map(), sel: 0, msg: null, msgAt: 0, probedAt: 0,
    // Last banked-reset block seen for the logged-in account. A probe served
    // from the shared cache (written by the statusline, plain endpoint) has
    // none, so the card keeps showing this until our next own fetch.
    resets: null, confirm: null, claiming: false,
    codex: { auth: opts.noCodex ? null : loadCodexAuth(), usage: null, usageAt: null, error: null, lastAt: 0, nextProbeAt: 0, backoffUntil: 0, sessions: 0, credits: null, creditsAt: null },
  };
  logActiveAccount(state.account.email);
  state.sel = activeIndex(cardList(state));
  { const arch = state.account.email ? readAccount(state.account.email) : null; if (arch?.usage) state.resets = normalize(arch.usage).resets; }

  // Realtime bits: running claude sessions, and a fast check for an
  // out-of-band re-login (claude /login) so the switch log stays accurate.
  let claudeJsonMtime = 0;
  function pollSessions() {
    try {
      const mt = statSync(CLAUDE_JSON).mtimeMs;
      if (mt !== claudeJsonMtime) { claudeJsonMtime = mt; state.account = loadAccount(); logActiveAccount(state.account.email); }
    } catch { /* no .claude.json */ }
    state.sessions = countClaudeProcs();
    if (!opts.noCodex) state.codex.sessions = countCodexProcs();
  }

  // A single-flight gate shared by manual probes and the independent timer.
  let codexProbe = null;
  function probeCodex(force = false) {
    if (codexProbe) return codexProbe;
    codexProbe = doProbeCodex(force).finally(() => { codexProbe = null; });
    return codexProbe;
  }

  // Poll faster while automation is enabled; claims require fresh probes.
  // Re-read auth.json each time — the Codex CLI rotates the token in place.
  async function doProbeCodex(force) {
    if (opts.noCodex) return;
    const cx = state.codex;
    const wasEnabled = codexAutoEnabled();
    const auto = live && reloadCodexAuto();
    if (auto && !wasEnabled) cx.lastAt = 0;
    const interval = auto ? CODEX_AUTO_INTERVAL_MS : CODEX_INTERVAL_MS;
    const auth = loadCodexAuth();
    if ((auth?.accountId || auth?.email) !== (cx.auth?.accountId || cx.auth?.email)) {
      cx.usage = null; cx.usageAt = null; cx.credits = null; cx.creditsAt = null;
      cx.lastAt = 0; cx.backoffUntil = 0; cx.error = null;
    }
    cx.auth = auth;
    if (!cx.auth) return;
    const now = Date.now();
    cx.nextProbeAt = Math.max(cx.lastAt ? cx.lastAt + interval : 0, cx.backoffUntil);
    if (!force && now < cx.nextProbeAt) return;
    cx.lastAt = now;
    cx.nextProbeAt = now + interval;
    const r = await fetchCodexUsage(cx.auth);
    if (r.error) {
      cx.error = r.error;
      cx.backoffUntil = now + Math.max(r.retryAfterMs || 0, auto ? CODEX_AUTO_INTERVAL_MS : MIN_BACKOFF_MS);
    } else {
      cx.error = null; cx.backoffUntil = 0;
      cx.usage = r.data; cx.usageAt = r.fetchedAt;
    }
    // The banked reset credits live on their own endpoint; same cadence.
    const c = await fetchCodexResetCredits(cx.auth);
    if (!c.error) { cx.credits = c.data; cx.creditsAt = c.fetchedAt; }
    else {
      if (!cx.error) cx.error = `resets: ${c.error}`;
      cx.backoffUntil = Math.max(cx.backoffUntil, now + Math.max(c.retryAfterMs || 0, auto ? CODEX_AUTO_INTERVAL_MS : MIN_BACKOFF_MS));
    }
    cx.nextProbeAt = Math.max(cx.nextProbeAt, cx.backoffUntil);
    // Both reads must succeed in this probe; cached/error snapshots cannot
    // authorize spending a credit. One-shot commands never auto-spend.
    if (r.error || c.error) return;
    // Observe recovery even during the post-claim refresh or while disabled.
    const target = codexResetGuard.target(cx.auth, r.data, c.data);
    if (!live || !reloadCodexAuto() || state.claiming ||
        (state.confirm && Date.now() - state.confirm.at <= RESET_CONFIRM_MS)) return;
    if (!target) return;
    state.claiming = true;
    try {
      const result = await useReset(target);
      state.msg = `auto use reset · ${result.text}`; state.msgAt = Date.now();
      // Refresh immediately; claiming remains set to suppress nested claims.
      await doProbeCodex(true);
    } finally { state.claiming = false; }
  }

  // Refresh the logged-in account's token ourselves only when no `claude`
  // process is running; otherwise the sessions refresh it themselves. Done
  // under Claude Code's refresh lock, re-checking the store once held, exactly
  // like its checkAndRefreshOAuthTokenIfNeeded.
  async function maybeRefreshActive() {
    const now = Date.now();
    const exp = Number(state.cred?.expiresAt) || 0, rexp = Number(state.cred?.refreshTokenExpiresAt) || 0;
    state.activeRefresh = null;
    if (!state.cred?.refreshToken || exp - now >= ACTIVE_REFRESH_AHEAD_MS || (rexp && rexp < now)) return;
    if (now - state.activeRefreshTriedAt < REFRESH_RETRY_MS) return;
    const running = state.sessions; // refreshed every PS_POLL_MS by pollSessions
    if (running) { state.activeRefresh = `token ${exp <= now ? 'expired' : 'expiring'} — ${running} claude session(s) running, leaving refresh to them`; return; }
    state.activeRefreshTriedAt = now;
    try {
      await withLockAsync(REFRESH_LOCK, async () => {
        const blob = loadCredentialBlob();
        const cur = blob.json?.claudeAiOauth;
        if (cur?.accessToken && cur.accessToken !== state.cred.accessToken) { state.cred = cur; return; } // someone else refreshed meanwhile
        const r = await refreshOauth(state.cred);
        if (r.error) { state.activeRefresh = r.error; return; }
        writeCredentials(blob, r); state.cred = r;
      });
    } catch (e) { state.activeRefresh = `refresh: ${firstLine(e)}`; }
  }

  async function probeOther(rec, force) {
    const now = Date.now();
    const o = state.others.get(rec.email) || { live: false, error: null, backoffUntil: 0, backoffMs: 0, authDead: false, lastAt: 0, refreshTriedAt: 0, refreshError: null };
    state.others.set(rec.email, o);
    let exp = Number(rec.oauth?.expiresAt) || 0;
    const rexp = Number(rec.oauth?.refreshTokenExpiresAt) || 0;
    // Keep the archived token alive: refresh when expired / about to expire.
    if (rec.oauth?.refreshToken && !(rexp && rexp < now) && !o.authDead && exp - now < REFRESH_AHEAD_MS && (force || now - o.refreshTriedAt > REFRESH_RETRY_MS)) {
      o.refreshTriedAt = now;
      const r = await refreshOauth(rec.oauth);
      if (r.error) { o.refreshError = r.error; if (r.dead) o.authDead = true; }
      else {
        o.refreshError = null;
        const fresh = readAccount(rec.email) || rec;
        fresh.oauth = r; fresh.savedAt = now; saveAccount(fresh); // not a login: seenAt stays
        rec.oauth = r; exp = Number(r.expiresAt) || 0;
      }
    }
    const due = force || now - o.lastAt >= OTHER_INTERVAL_MS;
    if (rec.oauth?.accessToken && exp > now && !o.authDead && due && now >= o.backoffUntil) {
      o.lastAt = now;
      const r = await fetchUsage(rec.oauth.accessToken);
      if (r.error) {
        o.live = false; o.error = r.error;
        if (r.status === 401 || r.status === 403) o.authDead = true;
        else if (r.status === 429) { o.backoffMs = backoff(o.backoffMs, r.retryAfterMs); o.backoffUntil = now + o.backoffMs; }
        else o.backoffUntil = now + MIN_BACKOFF_MS;
      } else {
        o.live = true; o.error = null; o.backoffMs = 0; o.backoffUntil = 0;
        archiveUsage(rec.email, r.data, r.fetchedAt);
      }
    } else if (!(exp > now)) o.live = false;
  }

  // `email` / `cred` are snapshots: pollSessions may swap state.account while
  // we are awaiting, and the response must be filed under the account it was
  // fetched for.
  async function probeActive(force, email, cred) {
    const t0 = Date.now();
    if (!cred?.accessToken) { state.error = 'not logged in — press l or switch to an archived account'; return; }
    // Prefer a fresh shared cache (statusline or another agent-usage may have
    // just fetched). Only hit the network when it is stale or missing.
    const cached = force ? null : readCache(email);
    let r, served = false;
    if (cached && t0 - cached.fetchedAt < CACHE_TTL_MS) { r = cached; served = true; }
    else if (!force && cached && state.backoffMs && t0 < state.backoffUntil) { r = cached; served = true; } // still backing off: show stale
    else r = await fetchUsage(cred.accessToken, { cacheAs: email });

    if (r.error) {
      state.error = r.error;
      markFail();
      if (r.status === 429) { state.backoffMs = backoff(state.backoffMs, r.retryAfterMs); state.backoffUntil = Date.now() + state.backoffMs; }
      // Fall back to whatever the last good response was (ours, statusline's, or the archive).
      const stale = readCache(email);
      const arch = email ? readAccount(email) : null;
      if (stale) { state.usage = normalize(stale.data); state.usageAt = stale.fetchedAt; }
      else if (arch?.usage) { state.usage = normalize(arch.usage); state.usageAt = arch.usageAt; }
      if (opts.json) { console.error(r.error); process.exit(1); }
      return;
    }
    if (!served) { state.error = null; state.backoffMs = 0; state.backoffUntil = 0; } // a served cache does not clear a live backoff
    if (opts.json) { const { _account, ...data } = r.data; console.log(JSON.stringify(data, null, 2)); process.exit(0); }
    state.usage = normalize(r.data);
    state.usageAt = r.fetchedAt;
    if (state.usage.resets) state.resets = state.usage.resets;
    if (email && !served) { try { archiveUsage(email, r.data, r.fetchedAt); } catch { /* best effort */ } }
  }

  async function probe(force = false) {
    if (state.probing) { if (force) state.pendingForce = true; return; }
    state.probing = true;
    // Start Codex before awaiting any Claude network work.
    const codexTask = probeCodex(force).catch(e => { state.codex.error = firstLine(e); });
    try {
      // Re-read credentials/account each probe so a re-login (different account)
      // is picked up without restarting.
      try { state.cred = loadCredentials(); } catch { state.cred = {}; }
      state.account = loadAccount();
      const { email } = state.account;
      logActiveAccount(email);
      await maybeRefreshActive();
      const cred = state.cred;
      try { archiveActive(cred, state.account); } catch { /* best effort */ }
      await probeActive(force, email, cred);
      for (const rec of listAccounts()) {
        if (sameEmail(rec.email, email)) continue;
        try { await probeOther(rec, force); } catch (e) { state.others.set(rec.email, { ...(state.others.get(rec.email) || {}), error: firstLine(e) }); }
      }
      state.probedAt = Date.now();
    } finally { await codexTask; state.probing = false; }
    if (state.pendingForce) { state.pendingForce = false; return probe(true); }
  }

  // ─── Banked resets ─────────────────────────────────────────────────────────
  // What a `u` press (or `reset TARGET`) would spend, for a row of rowList().
  // Returns { error } when there is nothing usable.
  function resetTargetFor(row) {
    const now = Date.now();
    if (row.kind === 'codex') {
      const cx = state.codex;
      if (!cx.auth) return { error: 'codex: not logged in (no ~/.codex/auth.json tokens)' };
      const resets = normalizeCodexCredits(cx.credits, now);
      const g = usableGrant(resets, now);
      if (!g) return cx.credits ? { error: 'codex: no banked reset credits' } : { error: 'codex: reset credits not loaded yet', notLoaded: true };
      return { kind: 'codex', name: 'codex', auth: cx.auth, grant: g, banked: bankedCount(resets, now) };
    }
    if (row.kind !== 'claude') return { error: 'select an account card or the codex card first' };
    const email = row.email;
    const active = sameEmail(email, state.account.email);
    let token, org, resets;
    if (active) { token = state.cred?.accessToken; org = state.account.raw?.organizationUuid; resets = state.usage?.resets || state.resets; }
    else {
      const rec = readAccount(email);
      if (!rec?.oauth?.accessToken) return { error: `${email}: no archived tokens — press l` };
      if ((Number(rec.oauth.expiresAt) || 0) <= now) return { error: `${email}: token expired — wait for the hourly refresh or press l` };
      token = rec.oauth.accessToken; org = rec.oauthAccount?.organizationUuid; resets = rec.usage ? normalize(rec.usage).resets : null;
    }
    if (!token) return { error: `${email}: not logged in` };
    if (!org) return { error: `${email}: no organization uuid in the archive — log in once with l` };
    if (!resets) return { error: `${email}: banked resets not loaded yet`, notLoaded: true };
    const g = usableGrant(resets, now);
    if (!g) return { error: `${email}: no usable banked reset${resets.reason ? ` (${resets.reason})` : ''}` };
    return { kind: 'claude', name: email, email, active, token, org, grant: g, banked: bankedCount(resets, now) };
  }

  // Spend the target's reset. Returns { ok, text }. Never throws.
  async function useReset(t) {
    if (t.kind === 'codex') {
      const attempt = codexResetGuard.markAttempt(t, state.codex.usage);
      const r = await consumeCodexResetCredit(t.auth, t.grant.id, { requestId: attempt.requestId });
      codexResetGuard.finishAttempt(attempt, r);
      state.codex.lastAt = 0; state.codex.backoffUntil = 0; // re-fetch quota + credits on the next probe
      if (r.error) return { ok: false, text: `${paint.red('codex reset failed:')} ${r.error}` };
      if (r.windowsReset > 0) return { ok: true, text: `${paint.green('codex reset used')} · ${r.windowsReset} window${r.windowsReset === 1 ? '' : 's'} reset · ${Math.max(0, t.banked - 1)} left` };
      return { ok: false, text: `${paint.yellow('codex: nothing reset')} · server said ${r.code}` };
    }
    const r = await claimReset(t.token, t.org, t.grant.id);
    for (const f of [CACHE_FILE, FAIL_FILE]) { try { unlinkSync(f); } catch { /* none */ } } // stale numbers: everyone re-fetches
    if (t.active) { state.usage = null; state.usageAt = null; state.backoffMs = 0; state.backoffUntil = 0; }
    else { const o = state.others.get(t.email); if (o) { o.lastAt = 0; o.backoffUntil = 0; o.backoffMs = 0; } }
    if (r.error) return { ok: false, text: `${paint.red('reset failed:')} ${t.name} · ${r.error}` };
    const left = r.resetsLeft != null ? `${r.resetsLeft} left` : `${Math.max(0, t.banked - 1)} left`;
    switch (r.result) {
      case 'reset': return { ok: true, text: `${paint.green('reset used')} on ${paint.cyan(t.name)} · cleared ${r.cleared.join('+') || 'limits'} · ${left}` };
      case 'not_limited': return { ok: false, text: `${paint.yellow('reset kept')} · ${t.name} is not at a limit and this grant only works at one · ${left}` };
      case 'already_used': return { ok: false, text: `${paint.yellow('reset kept')} · ${t.name}: grant already used · ${left}` };
      case 'cooldown': return { ok: false, text: `${paint.yellow('reset kept')} · ${t.name}: cooldown${r.cooldownUntil ? ` until ${new Date(r.cooldownUntil).toLocaleTimeString()}` : ''} · ${left}` };
      default: return { ok: false, text: `${paint.yellow('reset kept')} · ${t.name}: server said ${r.result}${r.reason ? ` (${r.reason})` : ''}` };
    }
  }

  return { state, probe, probeCodex, pollSessions, resetTargetFor, useReset };
}

// ─── Live TUI ────────────────────────────────────────────────────────────────
function runLive({ state, probe, probeCodex, pollSessions, resetTargetFor, useReset }) {
  const out = process.stdout;
  const altScreen = !!out.isTTY;
  if (altScreen) out.write(`${ESC}?1049h${ESC}?25l`);
  process.on('exit', () => { if (altScreen) out.write(`${ESC}?2026l${ESC}?25h${ESC}?1049l`); });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

  const writer = createFrameWriter(out);
  const draw = () => writer.write(render(state, Date.now()));
  out.on('resize', () => { writer.invalidate(); draw(); });
  const say = m => { state.msg = m; state.msgAt = Date.now(); };
  const resetActive = () => { state.usage = null; state.usageAt = null; state.error = null; state.backoffMs = 0; state.backoffUntil = 0; state.activeRefreshTriedAt = 0; };
  const reprobe = () => probe(true).catch(e => say(`${paint.red('probe failed:')} ${firstLine(e)}`)).then(draw);

  function switchToEmail(email, verb) {
    try {
      const r = switchTo(email);
      say(`${paint.green(verb)} ${paint.cyan(email)}${r.running ? paint.yellow(` — ${r.running} running claude session(s) ${HANDOVER_NOTE}`) : ''}`);
      resetActive();
      pollSessions();
      reprobe();
    } catch (e) { say(`${paint.red('switch failed:')} ${firstLine(e)}`); }
  }

  function doSwitch() {
    const row = rowList(state)[state.sel];
    if (row?.kind === 'auto') {
      const on = setAuto(!autoEnabled());
      say(on ? `${paint.green('auto-switch on')} — switches at ${AUTO_THRESHOLD}% session usage while this TUI runs` : paint.dim('auto-switch off'));
      return;
    }
    if (row?.kind === 'codex-auto') {
      const on = setCodexAuto(!codexAutoEnabled());
      say(on ? `${paint.green('codex auto use reset on')} — usage ≥${CODEX_AUTO_THRESHOLD}% and reset ≥1 day away` : paint.dim('codex auto use reset off'));
      if (on) reprobe();
      return;
    }
    if (row?.kind === 'codex') { say(paint.dim('codex: one account, nothing to switch — u spends a banked reset')); return; }
    if (!row || row.active) { say(paint.dim('already the logged-in account')); return; }
    switchToEmail(row.email, 'switched to');
  }

  // `u` twice within RESET_CONFIRM_MS spends one banked reset on the selected
  // card. Any other key in between cancels. Server-side it is Claude Code's
  // /limit-reset claim, or Codex's credit consume.
  function doUseReset() {
    if (state.claiming) { say(paint.dim('a reset claim is already in flight')); return; }
    const row = rowList(state)[state.sel];
    const t = resetTargetFor(row || {});
    if (t.notLoaded) { state.confirm = null; say(paint.cyan(`${t.error} — fetching, press u again in a moment`)); if (row.kind === 'codex') state.codex.lastAt = 0; reprobe(); return; }
    if (t.error) { state.confirm = null; say(paint.yellow(t.error)); return; }
    const key = `${t.kind}:${t.name}:${t.grant.id}`;
    const now = Date.now();
    if (state.confirm?.key !== key || now - state.confirm.at > RESET_CONFIRM_MS) {
      state.confirm = { key, at: now };
      const what = t.kind === 'codex' ? `1 of ${t.banked} codex reset credit${t.banked === 1 ? '' : 's'} (expires ${new Date(t.grant.endsAt).toLocaleDateString()})` : `1 of ${t.banked} banked reset${t.banked === 1 ? '' : 's'} on ${t.name} (clears ${t.grant.clears.join('+')})`;
      say(`${paint.yellow('use')} ${what}? ${paint.bold('press u again')} within ${RESET_CONFIRM_MS / 1000}s to confirm`);
      return;
    }
    state.confirm = null; state.claiming = true;
    say(paint.cyan(`using reset on ${t.name}…`));
    draw();
    useReset(t)
      .then(r => { say(r.text); return probe(true); })
      .catch(e => say(`${paint.red('reset failed:')} ${firstLine(e)}`))
      .finally(() => { state.claiming = false; draw(); });
  }

  // After each probe: if enabled and the active session is at the threshold,
  // move to the best candidate. The new account starts under the threshold,
  // so this fires once per exhausted session, not every probe.
  function maybeAutoSwitch() {
    if (!autoEnabled()) return;
    const a = usageSummary(state.usage);
    if (!a || a.sess < AUTO_THRESHOLD) return;
    const c = pickCandidate(state.account.email, state.others);
    if (!c) { say(paint.yellow(`session ${Math.round(a.sess)}% — auto-switch found no eligible account`)); return; }
    switchToEmail(c.email, 'auto-switched to');
  }

  let loggingIn = false;
  function doLogin() {
    if (loggingIn) { say(paint.dim('login already in progress — finish it in the browser')); return; }
    const row = rowList(state)[state.sel];
    if (row?.kind === 'codex' || row?.kind === 'codex-auto') { say(paint.dim('codex logs in on its own: run `codex login`')); return; }
    loggingIn = true;
    const c = row?.kind === 'claude' ? row : null;
    say(paint.cyan('starting browser login…'));
    browserLogin({ onStatus: m => { say(paint.cyan(m)); draw(); } })
      .then(r => {
        // Activate when the selected card is (or becomes) the logged-in account,
        // or when the login is for the currently logged-in email.
        const email = r.account.emailAddress;
        const activate = !c || c.active || email === state.account.email || email === c.email;
        say(paint.green(storeLogin(r, { activate })));
        const o = state.others.get(email);
        if (o) state.others.set(email, { ...o, authDead: false, error: null, refreshError: null, backoffUntil: 0, backoffMs: 0, lastAt: 0 });
        resetActive();
        pollSessions();
        return probe(true).then(() => { state.sel = activeIndex(cardList(state)); });
      })
      .catch(e => say(`${paint.red('login failed:')} ${firstLine(e)}`))
      .finally(() => { loggingIn = false; draw(); });
  }

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
    process.stdin.on('data', k => {
      if (k !== 'u') state.confirm = null; // anything but the second `u` cancels a pending reset
      if (k === 'q' || k === '\x03') process.exit(0); // q or Ctrl-C
      else if (k === 'r') reprobe();
      else if (k === '\x1b[A' || k === 'k') state.sel = Math.max(0, state.sel - 1);
      else if (k === '\x1b[B' || k === 'j') state.sel = Math.min(rowList(state).length - 1, state.sel + 1);
      else if (k === '\r' || k === '\n') doSwitch();
      else if (k === 'l') doLogin();
      else if (k === 'u') doUseReset();
      draw();
    });
  }

  const loop = () => probe().catch(e => say(`${paint.red('probe failed:')} ${firstLine(e)}`)).then(() => {
    maybeAutoSwitch();
    draw();
    setTimeout(loop, state.backoffMs || opts.intervalMs).unref?.();
  });
  pollSessions();
  if (!opts.noCodex) startCodexPolling(probeCodex, e => { state.codex.error = firstLine(e); });
  loop();
  draw();
  // Once a second for the countdowns; ~10×/s while a skeleton bar is on screen
  // so its wave moves. draw() skips the write when nothing changed.
  let lastDraw = 0;
  setInterval(() => { const now = Date.now(); if (skeletonShown(now) || now - lastDraw >= 1000) { lastDraw = now; draw(); } }, 100);
  setInterval(pollSessions, PS_POLL_MS);
}

export async function main() {
  if (await runCommand()) return;
  if (ENV_TOKEN_OVERRIDE) console.error('agent-usage: CLAUDE_CODE_OAUTH_TOKEN is set — claude sessions started from this shell ignore the keychain, so switching will not affect them');
  const app = createApp({ live: !opts.once && !opts.json });
  if (opts.once || opts.json) {
    await app.probe();
    app.pollSessions();
    process.stdout.write(render(app.state, Date.now()) + '\n');
    process.exit(app.state.error ? 1 : 0);
  }
  runLive(app);
}
