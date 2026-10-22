// Entry: one-shot commands, then the probe loop + TUI.
import { statSync, unlinkSync } from 'node:fs';
import { HELP, opts } from './cli.mjs';
import {
  ACTIVE_REFRESH_AHEAD_MS, CACHE_FILE, CACHE_TTL_MS, CLAUDE_JSON, CODEX_INTERVAL_MS, CODEX_REFRESH_AHEAD_MS, FAIL_FILE, MAX_BACKOFF_MS, MIN_BACKOFF_MS, OTHER_BACKOFF_MS, OTHER_INTERVAL_MS, PS_POLL_MS,
  MSG_TTL_MS, REFRESH_AHEAD_MS, REFRESH_LOCK, REFRESH_RETRY_MS, RESET_CONFIRM_MS,
} from './config.mjs';
import { codexAuthFromFile, codexKey, codexPlanLabel, consumeCodexResetCredit, countCodexProcs, fetchCodexResetCredits, fetchCodexUsage, loadCodexAuth, normalizeCodexCredits, readCodexAuthFile } from './codex.mjs';
import {
  archiveCodexActive, archiveCodexSnapshot, codexLogin, codexName, forgetCodexAccount, listCodexAccounts, readCodexAccount, refreshCodexAccount,
  resolveCodexAccount, storeCodexLogin, switchCodexTo,
} from './codex-accounts.mjs';
import { CODEX_AUTO_INTERVAL_MS, CODEX_AUTO_THRESHOLD, codexAutoEnabled, createCodexResetGuard, reloadCodexAuto, setCodexAuto, startCodexPolling } from './codex-auto.mjs';
import { archiveActive, archiveUsage, forgetAccount, listAccounts, loadPollState, logActiveAccount, readAccount, saveAccount, savePollState } from './archive.mjs';
import { ENV_TOKEN_OVERRIDE, loadAccount, loadCredentialBlob, loadCredentials, planLabel, writeCredentials } from './credentials.mjs';
import { ESC, fmtDur, paint, skeletonShown } from './format.mjs';
import { countClaudeProcs, countClaudeSubagents } from './local.mjs';
import { withLockAsync } from './lock.mjs';
import { browserLogin, refreshOauth } from './oauth.mjs';
import { AUTO_THRESHOLD, autoEnabled, pickCandidate, setAuto, toggleDisabled, usageSummary } from './auto.mjs';
import { activeIndex, animating, bannerButtons, cardList, codexCardList, render, rowList } from './render.mjs';
import { createFrameWriter } from './terminal.mjs';
import { HANDOVER_NOTE, storeLogin, switchTo } from './switch.mjs';
import { UPDATE_CHECK_MS, UPDATED_FROM_ENV, autoUpdateEnabled, changesSince, checkForUpdate, relaunch, reloadAutoUpdate, runUpdate, setAutoUpdate } from './update.mjs';
import { bankedCount, claimReset, fetchUsage, markFail, mergeLive, normalize, projectRows, readCache, usableGrant } from './usage.mjs';

const firstLine = e => String(e?.message || e).split('\n')[0];
const sameEmail = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const backoff = (prev, retryAfterMs) => Math.max(retryAfterMs || 0, Math.min((prev || MIN_BACKOFF_MS / 2) * 2, MAX_BACKOFF_MS));
// ±20%, so archived-account polls do not land on a fixed rhythm.
const jittered = ms => Math.round(ms * (0.8 + Math.random() * 0.4));

// Probe state of one archived account. `nextAt` is its next due time (a
// regular poll or the end of a 429 wait); `strikes` counts 429s in a row.
const newOther = () => ({ live: false, error: null, authDead: false, lastAt: 0, nextAt: 0, strikes: 0, parked: false, inFlight: false, refreshTriedAt: 0, refreshError: null });
const unpark = o => { o.strikes = 0; o.parked = false; o.nextAt = 0; o.error = null; };
// Probe state of one archived Codex account. `unauthorized` (a 401) asks for a
// token refresh before the next poll.
const newCodexOther = () => ({ live: false, error: null, authDead: false, unauthorized: false, nextAt: 0, inFlight: false, refreshTriedAt: 0 });
// `codex:EMAIL` (or `codex:` + account id) names a Codex account on the CLI.
const codexArg = s => { const m = /^codex(?::(.*))?$/i.exec(s || ''); return m ? (m[1] ?? '') : null; };

// A probe that never settles froze polling for good (seen 2026-10-08: probing
// stuck, no socket, no pending abort timer). Every probe now settles within
// PROBE_DEADLINE_MS, worst-case legit runs (refreshes + reset claim) included.
const PROBE_DEADLINE_MS = 120_000;
function within(p, ms, what) {
  let t;
  const late = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${what} stuck for ${ms / 1000}s — abandoned`)), ms); });
  return Promise.race([p, late]).finally(() => clearTimeout(t));
}

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
    if (!opts.noCodex) {
      try { archiveCodexActive(); } catch { /* best effort */ }
      const cx = listCodexAccounts();
      const curKey = codexKey(loadCodexAuth());
      if (cx.length) console.log('codex:');
      for (const r of cx) {
        const exp = codexAuthFromFile(r.authFile)?.expiresAt || 0;
        console.log(`${r.key === curKey ? '*' : ' '} ${r.email.padEnd(28)} ${codexPlanLabel(r.plan).padEnd(10)} ${(r.seenAt ? `seen ${fmtDur(now - r.seenAt).padEnd(6)} ago` : 'never logged in').padEnd(17)}  token ${exp > now ? `valid ${fmtDur(exp - now)}` : 'expired'}  id ${r.key}`);
      }
    }
    return true;
  }
  if (opts.forget != null) {
    if (!opts.forget) throw new Error('forget needs an email');
    const cq = codexArg(opts.forget);
    if (cq != null) {
      const rec = resolveCodexAccount(cq);
      console.log(forgetCodexAccount(rec.key) ? `forgot codex ${codexName(rec)}${rec.key === codexKey(loadCodexAuth()) ? ' (still logged in to codex; it is archived again on the next probe)' : ''}` : `codex ${rec.email}: nothing archived`);
      return true;
    }
    const email = resolveEmail(opts.forget);
    console.log(forgetAccount(email) ? `forgot ${email}` : `${email}: nothing archived`);
    return true;
  }
  if (opts.switchTo != null) {
    if (!opts.switchTo) throw new Error('select needs an email');
    const cq = codexArg(opts.switchTo);
    if (cq != null) {
      const rec = resolveCodexAccount(cq);
      const r = switchCodexTo(rec.key);
      console.log(r.already ? `${codexName(rec)} is already the logged-in codex account` : `switched codex to ${codexName(rec)}${r.running ? ` — ${r.running} running codex session(s) may keep the old account until restarted` : ''}`);
      return true;
    }
    const email = resolveEmail(opts.switchTo);
    const r = switchTo(email);
    console.log(r.already ? `${email} is already the logged-in account` : `switched Claude Code to ${email}${r.running ? ` — ${r.running} running claude session(s) ${HANDOVER_NOTE}` : ''}`);
    return true;
  }
  if (opts.login) {
    if (/^codex$/i.test(opts.loginProvider)) {
      const raw = await codexLogin({ onStatus: (m, url) => console.error(url ? `${m}\n${url}` : m) });
      console.log(storeCodexLogin(raw).text);
      return true;
    }
    if (opts.loginProvider && !/^claude$/i.test(opts.loginProvider)) throw new Error(`login takes 'claude' or 'codex', not '${opts.loginProvider}'`);
    const r = await browserLogin({ onStatus: m => console.error(m) });
    console.log(storeLogin(r, { activate: true }));
    return true;
  }
  if (opts.auto != null) {
    const v = opts.auto.toLowerCase();
    if (v === 'on' || v === 'off') setAuto(v === 'on');
    else if (v) throw new Error(`auto takes 'on' or 'off', not '${opts.auto}'`);
    console.log(`auto-switch: ${autoEnabled() ? 'on' : 'off'} (at ${AUTO_THRESHOLD}% session or weekly usage, while the TUI runs)`);
    const c = pickCandidate(loadAccount().email);
    console.log(c
      ? `next: ${c.email} (session ${Math.round(c.sess)}%, weekly ${Math.round(c.week)}%, fable ${Math.round(c.fable)}%, resets ${fmtDur(c.tts)})`
      : 'next: no eligible account');
    return true;
  }
  if (opts.reset != null) {
    if (!opts.reset) throw new Error('reset needs a target: an account email (or unique substring) or `codex`');
    const app = createApp();
    await app.probe(true); // fresh numbers, fresh grant list (the plain shared cache carries no grants)
    const cq = codexArg(opts.reset);
    let row = { kind: 'claude', email: cq == null ? resolveEmail(opts.reset) : null };
    if (cq === '') row = { kind: 'codex' };
    else if (cq != null) { const rec = resolveCodexAccount(cq); row = { kind: 'codex', key: rec.key, active: rec.key === codexKey(app.state.codex.auth) }; }
    const t = app.resetTargetFor(row);
    if (t.error) throw new Error(t.error);
    const r = await app.useReset(t);
    console.log(r.text);
    process.exit(r.ok ? 0 : 1);
  }
  if (opts.update) {
    const u = await checkForUpdate();
    if (!u) { console.log('agent-usage is up to date (or this is not a git checkout with an upstream)'); return true; }
    console.log(`${u.behind} commit${u.behind === 1 ? '' : 's'} behind — updating…`);
    const r = await runUpdate();
    if (!r.ok) throw new Error(r.message);
    const changes = changesSince(r.from);
    console.log(`updated:${changes.map(c => `\n  • ${c}`).join('')}`);
    return true;
  }
  if (opts.autoUpdate != null) {
    const v = opts.autoUpdate.toLowerCase();
    if (v === 'on' || v === 'off') setAutoUpdate(v === 'on');
    else if (v) throw new Error(`auto-update takes 'on' or 'off', not '${opts.autoUpdate}'`);
    console.log(`auto-update: ${autoUpdateEnabled() ? 'on' : 'off'} (live mode checks GitHub every ${UPDATE_CHECK_MS / 60_000} min, pulls, and restarts itself)`);
    return true;
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
    probing: false, pendingForce: false, backoffMs: 0, backoffUntil: 0, failedAt: 0, liveSince: 0, activeRefresh: null, activeRefreshTriedAt: 0,
    sessions: 0, subagents: 0, others: new Map(), sel: 0, msg: null, msgAt: 0, probedAt: 0,
    // Last banked-reset block seen for the logged-in account. A probe served
    // from the shared cache (written by the statusline, plain endpoint) has
    // none, so the card keeps showing this until our next own fetch.
    resets: null, confirm: null, claiming: false,
    // Self-update: upstream status, the banner's focus, what the last update brought.
    update: null, updating: false, bannerSel: false, bannerBtn: 0, whatsNew: null,
    codex: { auth: opts.noCodex ? null : loadCodexAuth(), usage: null, usageAt: null, error: null, lastAt: 0, nextProbeAt: 0, backoffUntil: 0, sessions: 0, credits: null, creditsAt: null },
    codexOthers: new Map(), // archived Codex accounts' probe state, by key
  };
  // The logged-in Codex account is the first archived one.
  if (!opts.noCodex) { try { archiveCodexActive(); } catch { /* best effort */ } }
  for (const [email, saved] of Object.entries(loadPollState())) state.others.set(email, { ...newOther(), ...saved });
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
    state.subagents = countClaudeSubagents();
    state.usage = mergeLive(state.usage, Date.now(), state.liveSince);
    if (!opts.noCodex) state.codex.sessions = countCodexProcs();
  }

  // A single-flight gate shared by manual probes and the independent timer.
  let codexProbe = null;
  function probeCodex(force = false) {
    if (codexProbe) return codexProbe;
    const p = within(doProbeCodex(force), PROBE_DEADLINE_MS, 'codex probe').finally(() => { if (codexProbe === p) codexProbe = null; });
    return (codexProbe = p);
  }

  // Poll faster while automation is enabled; claims require fresh probes.
  // Re-read auth.json each time — the Codex CLI rotates the token in place,
  // and a switch or `codex login` may have put another account there.
  async function doProbeCodex(force) {
    if (opts.noCodex) return;
    const cx = state.codex;
    const wasEnabled = codexAutoEnabled();
    const auto = live && reloadCodexAuto();
    if (auto && !wasEnabled) cx.lastAt = 0;
    const interval = auto ? CODEX_AUTO_INTERVAL_MS : CODEX_INTERVAL_MS;
    const raw = readCodexAuthFile();
    const auth = codexAuthFromFile(raw);
    if (auth) { try { archiveCodexActive(raw); } catch { /* best effort */ } }
    if (codexKey(auth) !== codexKey(cx.auth)) {
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
    const snap = { ...(r.error ? {} : { usage: r.data, usageAt: r.fetchedAt }), ...(c.error ? {} : { credits: c.data, creditsAt: c.fetchedAt }) };
    if (Object.keys(snap).length) { try { archiveCodexSnapshot(codexKey(cx.auth), snap); } catch { /* best effort */ } }
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

  // ─── Archived Codex accounts ─────────────────────────────────────────────
  // Same idea as the archived Claude cards: each polls usage + credits on its
  // own jittered schedule and keeps its token alive (refreshCodexAccount).
  const cxOther = key => { let o = state.codexOthers.get(key); if (!o) state.codexOthers.set(key, o = newCodexOther()); return o; };

  async function probeCodexOther(rec, force) {
    const o = cxOther(rec.key);
    if (o.inFlight) return;
    o.inFlight = true;
    try { await probeCodexOtherNow(rec, o, force); } finally { o.inFlight = false; }
  }

  async function probeCodexOtherNow(rec, o, force) {
    const now = Date.now();
    let auth = codexAuthFromFile(rec.authFile);
    if (!auth) { o.authDead = true; o.live = false; return; }
    if (!o.authDead && (o.unauthorized || auth.expiresAt - now < CODEX_REFRESH_AHEAD_MS) && (force || now - o.refreshTriedAt > REFRESH_RETRY_MS)) {
      o.refreshTriedAt = now;
      const r = await refreshCodexAccount(rec.key);
      if (r.skipped) return; // it became the logged-in account meanwhile
      if (r.error) { o.error = r.error; if (r.dead) o.authDead = true; }
      else { rec = r.rec; auth = codexAuthFromFile(rec.authFile); o.unauthorized = false; o.error = null; o.nextAt = 0; }
    }
    if (o.authDead || !(auth.expiresAt > now)) { o.live = false; return; }
    if (!force && now < o.nextAt) return;
    const u = await fetchCodexUsage(auth);
    const at = Date.now();
    if (u.error) {
      o.live = false; o.error = u.error;
      if (u.status === 401) o.unauthorized = true;
      o.nextAt = at + Math.max(u.retryAfterMs || 0, jittered(MIN_BACKOFF_MS));
      return;
    }
    const c = await fetchCodexResetCredits(auth);
    o.live = true; o.error = c.error ? `resets: ${c.error}` : null;
    o.nextAt = at + jittered(CODEX_INTERVAL_MS);
    archiveCodexSnapshot(rec.key, { usage: u.data, usageAt: u.fetchedAt, ...(c.error ? {} : { credits: c.data, creditsAt: c.fetchedAt }) });
  }

  // Archived Codex accounts that are due (all of them when forced).
  function probeCodexOthers(force) {
    if (opts.noCodex) return Promise.resolve();
    const now = Date.now();
    const activeKey = codexKey(state.codex.auth);
    const jobs = [];
    for (const rec of listCodexAccounts()) {
      if (rec.key === activeKey) continue;
      const o = state.codexOthers.get(rec.key);
      if (!force && o && (o.inFlight || o.authDead || now < o.nextAt)) continue;
      jobs.push(probeCodexOther(rec, force).catch(e => { cxOther(rec.key).error = firstLine(e); }));
    }
    return Promise.all(jobs);
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

  const other = email => { let o = state.others.get(email); if (!o) state.others.set(email, o = newOther()); return o; };

  // 429 on an archived account: wait OTHER_BACKOFF_MS[0], [1], [2], then park.
  // Only `r` asks a parked account again, and a 429 there keeps it parked.
  function rateLimited(o, retryAfterMs, now) {
    if (o.parked) return;
    const step = OTHER_BACKOFF_MS[o.strikes++];
    if (step == null) { o.parked = true; o.nextAt = 0; return; }
    o.nextAt = now + Math.max(retryAfterMs || 0, jittered(step));
  }

  async function probeOther(rec, force) {
    const o = other(rec.email);
    if (o.inFlight) return;
    o.inFlight = true;
    try { await probeOtherNow(rec, o, force); } finally { o.inFlight = false; }
  }

  async function probeOtherNow(rec, o, force) {
    const now = Date.now();
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
    // `r` skips the regular wait, not a 429 wait; a parked account waits for `r` alone.
    const due = o.parked ? force : now >= o.nextAt || (force && !o.strikes);
    if (rec.oauth?.accessToken && exp > now && !o.authDead && due) {
      o.lastAt = now;
      const r = await fetchUsage(rec.oauth.accessToken);
      const at = Date.now();
      if (r.error) {
        o.live = false; o.error = r.error;
        if (r.status === 401 || r.status === 403) o.authDead = true;
        else if (r.status === 429) rateLimited(o, r.retryAfterMs, at);
        else o.nextAt = at + jittered(MIN_BACKOFF_MS);
      } else {
        o.live = true; unpark(o); o.nextAt = at + jittered(OTHER_INTERVAL_MS);
        archiveUsage(rec.email, r.data, r.fetchedAt);
      }
      savePollState(state.others);
    } else if (!(exp > now)) o.live = false;
  }

  // Live mode checks archived accounts every second against their own
  // jittered due times, so their requests line up with neither the main tick
  // nor each other. The main tick still visits every account, so a parked one
  // keeps its token refreshed.
  function probeOthersDue() {
    const now = Date.now();
    for (const rec of listAccounts()) {
      if (sameEmail(rec.email, state.account.email)) continue;
      const o = state.others.get(rec.email);
      if (o && (o.parked || o.inFlight || now < o.nextAt)) continue;
      probeOther(rec, false).catch(e => { other(rec.email).error = firstLine(e); });
    }
    probeCodexOthers(false);
  }

  // `email` / `cred` are snapshots: pollSessions may swap state.account while
  // we are awaiting, and the response must be filed under the account it was
  // fetched for.
  async function probeActive(force, email, cred) {
    const t0 = Date.now();
    if (!cred?.accessToken) { state.error = 'not logged in — press l or switch to an archived account'; return; }
    // Prefer a fresh shared cache (statusline or another agent-usage may have
    // just fetched). Only hit the network when it is stale or missing.
    // While a 429 backoff runs, only the network call waits: a cache someone
    // else wrote since is still taken, and the live feed keeps the bars moving.
    const cached = force ? null : readCache(email);
    let r, served = false;
    if (cached && t0 - cached.fetchedAt < CACHE_TTL_MS) { r = cached; served = true; }
    else if (!force && t0 < state.backoffUntil) {
      if (!cached || cached.fetchedAt <= (state.usageAt || 0)) return;
      r = cached; served = true;
    } else r = await fetchUsage(cred.accessToken, { cacheAs: email });

    if (r.error) {
      state.error = r.error; state.failedAt = Date.now();
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
    // A cache fetched after our last failure means the endpoint answers again.
    if (!served || r.fetchedAt > state.failedAt) { state.error = null; state.backoffMs = 0; state.backoffUntil = 0; }
    // Answering as the logged-in account clears its archived-card 429 park.
    const parked = email && state.others.get(email);
    if (parked && (parked.strikes || parked.parked)) { unpark(parked); savePollState(state.others); }
    if (opts.json) { const { _account, ...data } = r.data; console.log(JSON.stringify(data, null, 2)); process.exit(0); }
    state.usage = mergeLive(normalize(r.data), Date.now(), state.liveSince);
    state.usageAt = r.fetchedAt;
    if (state.usage.resets) state.resets = state.usage.resets;
    if (email && !served) { try { archiveUsage(email, r.data, r.fetchedAt); } catch { /* best effort */ } }
  }

  // `probing` is a generation number, so an abandoned probe that wakes up late
  // cannot clear the flag of the one that replaced it.
  let probeGen = 0;
  async function probe(force = false) {
    if (state.probing) { if (force) state.pendingForce = true; return; }
    const gen = state.probing = ++probeGen;
    // Start Codex before awaiting any Claude network work.
    const codexTask = Promise.all([
      probeCodex(force).catch(e => { state.codex.error = firstLine(e); }),
      within(probeCodexOthers(force), PROBE_DEADLINE_MS, 'codex accounts probe').catch(() => {}),
    ]);
    try { await within(probeClaude(force), PROBE_DEADLINE_MS, 'claude probe'); }
    finally { if (state.probing === gen) state.probing = 0; await codexTask; } // codexTask has its own deadline
    if (state.pendingForce) { state.pendingForce = false; return probe(true); }
  }

  async function probeClaude(force) {
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
    // Archived accounts in parallel: each has its own token and 429 budget, so
    // one tick costs one round-trip, not one per card.
    await Promise.all(listAccounts().filter(rec => !sameEmail(rec.email, email)).map(rec =>
      probeOther(rec, force).catch(e => { other(rec.email).error = firstLine(e); })));
    state.probedAt = Date.now();
  }

  // ─── Banked resets ─────────────────────────────────────────────────────────
  // What a `u` press (or `reset TARGET`) would spend, for a row of rowList().
  // Returns { error } when there is nothing usable.
  function resetTargetFor(row) {
    const now = Date.now();
    if (row.kind === 'codex' && row.key && !row.active) {
      const rec = readCodexAccount(row.key);
      const auth = codexAuthFromFile(rec?.authFile);
      const name = `codex ${rec ? codexName(rec) : row.key}`;
      if (!auth) return { error: `${name}: no archived tokens — log in with l` };
      if (!(auth.expiresAt > now)) return { error: `${name}: token expired — wait for its refresh or log in with l` };
      const resets = normalizeCodexCredits(rec.credits, now);
      const g = usableGrant(resets, now);
      if (!g) return rec.credits ? { error: `${name}: no banked reset credits` } : { error: `${name}: reset credits not loaded yet`, notLoaded: true };
      return { kind: 'codex', name, key: row.key, active: false, auth, usage: rec.usage, grant: g, banked: bankedCount(resets, now) };
    }
    if (row.kind === 'codex') {
      const cx = state.codex;
      if (!cx.auth) return { error: 'codex: not logged in (no ~/.codex/auth.json tokens)' };
      const resets = normalizeCodexCredits(cx.credits, now);
      const g = usableGrant(resets, now);
      if (!g) return cx.credits ? { error: 'codex: no banked reset credits' } : { error: 'codex: reset credits not loaded yet', notLoaded: true };
      return { kind: 'codex', name: 'codex', key: codexKey(cx.auth), active: true, auth: cx.auth, usage: cx.usage, grant: g, banked: bankedCount(resets, now) };
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
      const archived = t.active === false;
      const attempt = codexResetGuard.markAttempt(t, t.usage ?? state.codex.usage);
      const r = await consumeCodexResetCredit(t.auth, t.grant.id, { requestId: attempt.requestId });
      codexResetGuard.finishAttempt(attempt, r);
      // Re-fetch quota + credits on the next probe.
      if (archived) cxOther(t.key).nextAt = 0;
      else { state.codex.lastAt = 0; state.codex.backoffUntil = 0; }
      const on = archived ? ` on ${paint.cyan(t.name.replace(/^codex /, ''))}` : '';
      if (r.error) return { ok: false, text: `${paint.red('codex reset failed:')}${on} ${r.error}` };
      if (r.windowsReset > 0) return { ok: true, text: `${paint.green('codex reset used')}${on} · ${r.windowsReset} window${r.windowsReset === 1 ? '' : 's'} reset · ${Math.max(0, t.banked - 1)} left` };
      return { ok: false, text: `${paint.yellow('codex: nothing reset')}${on} · server said ${r.code}` };
    }
    const r = await claimReset(t.token, t.org, t.grant.id);
    for (const f of [CACHE_FILE, FAIL_FILE]) { try { unlinkSync(f); } catch { /* none */ } } // stale numbers: everyone re-fetches
    if (t.active) { state.usage = null; state.usageAt = null; state.backoffMs = 0; state.backoffUntil = 0; state.liveSince = Date.now(); }
    else { const o = state.others.get(t.email); if (o) { unpark(o); savePollState(state.others); } }
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

  return { state, probe, probeCodex, probeCodexOthers, probeOthersDue, pollSessions, resetTargetFor, useReset };
}

// ─── Live TUI ────────────────────────────────────────────────────────────────
function runLive({ state, probe, probeCodex, probeCodexOthers, probeOthersDue, pollSessions, resetTargetFor, useReset }) {
  const out = process.stdout;
  const altScreen = !!out.isTTY;
  if (altScreen) out.write(`${ESC}?1049h${ESC}?25l`);
  let restored = false;
  const restoreTerminal = () => {
    if (restored) return;
    restored = true;
    if (process.stdin.isTTY) { process.stdin.setRawMode(false); process.stdin.pause(); }
    if (altScreen) out.write(`${ESC}?2026l${ESC}?25h${ESC}?1049l`);
  };
  process.on('exit', restoreTerminal);
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
      say(on ? `${paint.green('auto-switch on')} — switches at ${AUTO_THRESHOLD}% session or weekly usage while this TUI runs` : paint.dim('auto-switch off'));
      return;
    }
    if (row?.kind === 'codex-auto') {
      const on = setCodexAuto(!codexAutoEnabled());
      say(on ? `${paint.green('codex auto use reset on')} — usage ≥${CODEX_AUTO_THRESHOLD}% and reset ≥1 day away` : paint.dim('codex auto use reset off'));
      if (on) reprobe();
      return;
    }
    if (row?.kind === 'codex') {
      if (row.active) { say(paint.dim('already the logged-in codex account — u spends a banked reset')); return; }
      switchCodex(row);
      return;
    }
    if (!row || row.active) { say(paint.dim('already the logged-in account')); return; }
    switchToEmail(row.email, 'switched to');
  }

  // Write an archived Codex account into auth.json. Not while its token is
  // being refreshed: the write could carry a refresh token about to rotate.
  function switchCodex(row) {
    if (state.codexOthers.get(row.key)?.inFlight) { say(paint.dim(`${row.name}: probe in flight — press enter again in a moment`)); return; }
    try {
      const r = switchCodexTo(row.key);
      say(`${paint.green('codex switched to')} ${paint.cyan(row.name)}${r.running ? paint.yellow(` — ${r.running} running codex session(s) may keep the old account until restarted`) : ''}`);
      const cx = state.codex;
      Object.assign(cx, { usage: null, usageAt: null, credits: null, creditsAt: null, lastAt: 0, backoffUntil: 0, error: null });
      Promise.all([probeCodex(true), probeCodexOthers(true)]).catch(e => say(`${paint.red('probe failed:')} ${firstLine(e)}`)).then(draw);
    } catch (e) { say(`${paint.red('codex switch failed:')} ${firstLine(e)}`); }
  }

  // `d` on a Claude card opts that account out of (or back into) auto-switching.
  function doToggleDisabled() {
    const row = rowList(state)[state.sel];
    if (row?.kind !== 'claude') { say(paint.dim('d works on a Claude account card')); return; }
    const off = toggleDisabled(row.email);
    say(off ? `${paint.dim('disabled')} ${row.email} — auto-switch skips it` : `${paint.green('enabled')} ${paint.cyan(row.email)} — auto-switch may pick it again`);
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

  // After each probe: if enabled and the active session or weekly is at the
  // threshold, move to the best candidate. The new account starts under the
  // threshold, so this fires once per exhausted window, not every probe.
  function maybeAutoSwitch() {
    if (!autoEnabled()) return;
    const a = usageSummary(state.usage);
    if (!a || (a.sess < AUTO_THRESHOLD && a.week < AUTO_THRESHOLD)) return;
    const c = pickCandidate(state.account.email, state.others);
    const which = a.sess >= AUTO_THRESHOLD ? `session ${Math.round(a.sess)}%` : `weekly ${Math.round(a.week)}%`;
    if (!c) { say(paint.yellow(`${which} — auto-switch found no eligible account`)); return; }
    switchToEmail(c.email, 'auto-switched to');
  }

  // `l` asks which provider; the next key answers (c / x), anything else cancels.
  let loggingIn = false, loginPickAt = 0;
  function askLogin() {
    if (loggingIn) { say(paint.dim('login already in progress — finish it in the browser')); return; }
    if (opts.noCodex) { doLogin(); return; }
    loginPickAt = Date.now();
    say(`${paint.cyan('log in to which provider?')} ${paint.bold('c')} Claude · ${paint.bold('x')} Codex ${paint.dim('· any other key cancels')}`);
  }
  function loginPickKey(k) {
    if (!loginPickAt) return false;
    const fresh = Date.now() - loginPickAt < MSG_TTL_MS;
    loginPickAt = 0;
    if (!fresh) return false;
    if (k === 'c' || k === 'C') doLogin();
    else if (k === 'x' || k === 'X') doCodexLogin();
    else if (k === 'q' || k === '\x03') return false;
    else say(paint.dim('login cancelled'));
    return true;
  }

  function doCodexLogin() {
    loggingIn = true;
    say(paint.cyan('starting codex login…'));
    codexLogin({ onStatus: m => { say(paint.cyan(m)); draw(); } })
      .then(raw => {
        const r = storeCodexLogin(raw);
        say(paint.green(r.text));
        const o = state.codexOthers.get(r.key);
        if (o) Object.assign(o, { authDead: false, unauthorized: false, error: null, nextAt: 0, refreshTriedAt: 0 });
        if (r.activated) state.codex.lastAt = 0;
        return Promise.all([probeCodex(true), probeCodexOthers(true)]).then(() => {
          const i = rowList(state).findIndex(x => x.kind === 'codex' && x.key === r.key);
          if (i >= 0) state.sel = i;
        });
      })
      .catch(e => say(`${paint.red('codex login failed:')} ${firstLine(e)}`))
      .finally(() => { loggingIn = false; draw(); });
  }

  function doLogin() {
    if (loggingIn) { say(paint.dim('login already in progress — finish it in the browser')); return; }
    const row = rowList(state)[state.sel];
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
        if (o) { Object.assign(o, { authDead: false, refreshError: null }); unpark(o); savePollState(state.others); }
        resetActive();
        pollSessions();
        return probe(true).then(() => { state.sel = activeIndex(cardList(state)); });
      })
      .catch(e => say(`${paint.red('login failed:')} ${firstLine(e)}`))
      .finally(() => { loggingIn = false; draw(); });
  }

  // ─── Self-update ───────────────────────────────────────────────────────────
  const updatedFrom = process.env[UPDATED_FROM_ENV];
  if (updatedFrom) state.whatsNew = { changes: changesSince(updatedFrom), at: Date.now() };
  let checking = false, autoFailedFor = null;
  function checkUpdate() {
    if (checking || state.updating) return;
    checking = true;
    checkForUpdate().then(u => {
      state.update = u;
      if (!u) { state.bannerSel = false; return; }
      // Auto-update: skip a working copy with local edits, a moment where a
      // reset claim or login is in flight, and an upstream that already failed.
      if (reloadAutoUpdate() && !u.dirty && !state.claiming && !loggingIn && autoFailedFor !== u.upstream) doUpdate(true);
    }).finally(() => { checking = false; draw(); });
  }

  function doUpdate(auto = false) {
    if (state.updating) return;
    state.updating = true; state.bannerSel = false;
    draw();
    const upstream = state.update?.upstream;
    runUpdate().then(r => {
      if (r.ok) { restoreTerminal(); process.stdout.write('agent-usage: updated — restarting…\n'); relaunch(r.from); }
      if (auto) autoFailedFor = upstream;
      state.updating = false;
      say(`${paint.red(auto ? 'auto-update failed:' : 'update failed:')} ${r.message}`);
      draw();
    });
  }

  // ↑ on the first card focuses the banner; ←/→ pick a button; enter runs it;
  // ↓ leaves. Any other key leaves the banner and does its usual thing.
  function bannerKey(k) {
    if (!state.update || state.updating) return false;
    const up = k === '\x1b[A' || k === 'k';
    if (!state.bannerSel) {
      if (!up || state.sel !== 0) return false;
      state.bannerSel = true; state.bannerBtn = 0;
      return true;
    }
    const buttons = bannerButtons();
    if (up) return true;
    if (k === '\x1b[B' || k === 'j') { state.bannerSel = false; return true; }
    if (k === '\x1b[D') { state.bannerBtn = Math.max(0, state.bannerBtn - 1); return true; }
    if (k === '\x1b[C') { state.bannerBtn = Math.min(buttons.length - 1, state.bannerBtn + 1); return true; }
    if (k === '\r' || k === '\n') {
      if (buttons[state.bannerBtn] === 'auto') { setAutoUpdate(true); say(`${paint.green('auto-update on')} — new versions install and restart on their own`); }
      doUpdate();
      return true;
    }
    state.bannerSel = false;
    return false;
  }

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
    process.stdin.on('data', k => {
      if (k !== 'u') state.confirm = null; // anything but the second `u` cancels a pending reset
      state.whatsNew = null; // the what's-new card goes away on the first keypress
      if (loginPickKey(k)) { draw(); return; }
      if (bannerKey(k)) { draw(); return; }
      if (k === 'q' || k === '\x03') process.exit(0); // q or Ctrl-C
      else if (k === 'r') reprobe();
      else if (k === '\x1b[A' || k === 'k') state.sel = Math.max(0, state.sel - 1);
      else if (k === '\x1b[B' || k === 'j') state.sel = Math.min(rowList(state).length - 1, state.sel + 1);
      else if (k === '\r' || k === '\n') doSwitch();
      else if (k === 'l') askLogin();
      else if (k === 'u') doUseReset();
      else if (k === 'd') doToggleDisabled();
      draw();
    });
  }

  // Due times are wall-clock and checked every second: a long setTimeout
  // drifts across macOS sleep (its clock pauses) and dies with its probe.
  let nextProbeAt = 0;
  function tick() {
    if (state.probing || Date.now() < nextProbeAt) return;
    nextProbeAt = Date.now() + opts.intervalMs;
    probe().catch(e => say(`${paint.red('probe failed:')} ${firstLine(e)}`)).then(() => {
      maybeAutoSwitch();
      draw();
      nextProbeAt = Date.now() + opts.intervalMs; // a 429 backoff only holds the logged-in account's fetch
    });
  }
  pollSessions();
  // Wall-clock due time on the 1s tick, like the probes: sleep-safe.
  if (out.isTTY) { let nextUpdateAt = 0; setInterval(() => { if (Date.now() >= nextUpdateAt) { nextUpdateAt = Date.now() + UPDATE_CHECK_MS; checkUpdate(); } }, 1000); }
  if (!opts.noCodex) startCodexPolling(probeCodex, e => { state.codex.error = firstLine(e); });
  tick();
  setInterval(tick, 1000);
  setInterval(probeOthersDue, 1000);
  draw();
  // Once a second for the countdowns; ~10×/s while a skeleton bar is on screen
  // so its wave moves. draw() skips the write when nothing changed.
  let lastDraw = 0;
  setInterval(() => { const now = Date.now(); if (skeletonShown(now) || animating(state, now) || now - lastDraw >= 1000) { lastDraw = now; draw(); } }, 100);
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
