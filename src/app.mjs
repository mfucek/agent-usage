// Entry: one-shot commands, then the probe loop + TUI.
import { statSync } from 'node:fs';
import { HELP, opts } from './cli.mjs';
import {
  CACHE_TTL_MS, CLAUDE_JSON, FIVE_H, MAX_BACKOFF_MS, MIN_BACKOFF_MS, OTHER_INTERVAL_MS, PS_POLL_MS,
  REFRESH_AHEAD_MS, REFRESH_RETRY_MS,
} from './config.mjs';
import { archiveActive, archiveUsage, forgetAccount, listAccounts, logActiveAccount, readAccount, saveAccount } from './archive.mjs';
import { loadAccount, loadCredentialBlob, loadCredentials, planLabel, writeCredentials } from './credentials.mjs';
import { ESC, fmtDur, paint } from './format.mjs';
import { countClaudeProcs, localSummaryBy, scanLocal } from './local.mjs';
import { browserLogin, refreshOauth } from './oauth.mjs';
import { activeIndex, cardList, render } from './render.mjs';
import { HANDOVER_NOTE, storeLogin, switchTo } from './switch.mjs';
import { fetchUsage, markFail, normalize, readCache } from './usage.mjs';

const firstLine = e => String(e?.message || e).split('\n')[0];
const backoff = (prev, retryAfterMs) => Math.max(retryAfterMs || 0, Math.min((prev || MIN_BACKOFF_MS / 2) * 2, MAX_BACKOFF_MS));

// ─── One-shot commands ───────────────────────────────────────────────────────
async function runCommand() {
  if (opts.help) { console.log(HELP); return true; }
  if (opts.accounts) {
    const cur = loadAccount().email;
    const list = listAccounts();
    if (!list.length) { console.log('no archived accounts yet — run agent-usage while logged in and they get archived automatically'); return true; }
    const now = Date.now();
    for (const r of list) {
      const exp = Number(r.oauth?.expiresAt) || 0, rexp = Number(r.oauth?.refreshTokenExpiresAt) || 0;
      console.log(`${r.email === cur ? '*' : ' '} ${r.email.padEnd(28)} ${planLabel(r.oauth).padEnd(10)} seen ${fmtDur(now - (r.seenAt || 0)).padEnd(6)} ago  token ${exp > now ? `valid ${fmtDur(exp - now)}` : 'expired'}  refresh ${rexp ? (rexp > now ? `valid ${fmtDur(rexp - now)}` : 'EXPIRED') : '?'}`);
    }
    return true;
  }
  if (opts.forget != null) {
    if (!opts.forget) throw new Error('--forget needs an email');
    console.log(forgetAccount(opts.forget) ? `forgot ${opts.forget}` : `${opts.forget}: nothing archived`);
    return true;
  }
  if (opts.switchTo != null) {
    if (!opts.switchTo) throw new Error('--switch needs an email');
    const r = switchTo(opts.switchTo);
    console.log(r.already ? `${opts.switchTo} is already the logged-in account` : `switched Claude Code to ${opts.switchTo}${r.running ? ` — ${r.running} running claude session(s) ${HANDOVER_NOTE}` : ''}`);
    return true;
  }
  if (opts.login) {
    const r = await browserLogin({ onStatus: m => console.error(m) });
    console.log(storeLogin(r, { activate: true }));
    return true;
  }
  return false;
}

// ─── Probe loop ──────────────────────────────────────────────────────────────
function createApp() {
  const state = {
    cred: loadCredentials(), account: loadAccount(), usage: null, usageAt: null, error: null,
    probing: false, backoffMs: 0, backoffUntil: 0, activeRefresh: null, activeRefreshTriedAt: 0,
    localBy: new Map(), sessions: 0, others: new Map(), sel: 0, msg: null, msgAt: 0,
  };
  logActiveAccount(state.account.email);
  state.sel = activeIndex(cardList(state));

  // Realtime bits: running claude sessions, and a fast check for an
  // out-of-band re-login (claude /login) so the switch log stays accurate.
  let claudeJsonMtime = 0;
  function pollSessions() {
    try {
      const mt = statSync(CLAUDE_JSON).mtimeMs;
      if (mt !== claudeJsonMtime) { claudeJsonMtime = mt; state.account = loadAccount(); logActiveAccount(state.account.email); }
    } catch { /* no .claude.json */ }
    state.sessions = countClaudeProcs();
  }

  // Refresh the logged-in account's token ourselves only when no `claude`
  // process is running; otherwise the sessions refresh it themselves.
  async function maybeRefreshActive() {
    const now = Date.now();
    const exp = Number(state.cred?.expiresAt) || 0, rexp = Number(state.cred?.refreshTokenExpiresAt) || 0;
    state.activeRefresh = null;
    if (!state.cred?.refreshToken || exp - now >= REFRESH_AHEAD_MS || (rexp && rexp < now)) return;
    if (now - state.activeRefreshTriedAt < REFRESH_RETRY_MS) return;
    const running = countClaudeProcs();
    if (running) { state.activeRefresh = `token ${exp <= now ? 'expired' : 'expiring'} — ${running} claude session(s) running, leaving refresh to them`; return; }
    state.activeRefreshTriedAt = now;
    const r = await refreshOauth(state.cred);
    if (r.error) { state.activeRefresh = r.error; return; }
    try { writeCredentials(loadCredentialBlob(), r); state.cred = r; state.activeRefresh = null; }
    catch (e) { state.activeRefresh = `refreshed but could not store: ${firstLine(e)}`; }
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
        fresh.oauth = r; fresh.seenAt = now; fresh.savedAt = now; saveAccount(fresh);
        rec.oauth = r; exp = Number(r.expiresAt) || 0; o.live = false;
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

  async function probeActive(force) {
    const t0 = Date.now();
    // Prefer a fresh shared cache (statusline or another agent-usage may have
    // just fetched). Only hit the network when it is stale or missing.
    const cached = force ? null : readCache(state.account.email);
    let r;
    if (cached && t0 - cached.fetchedAt < CACHE_TTL_MS) r = cached;
    else if (!force && cached && state.backoffMs && t0 < state.backoffUntil) r = cached; // still backing off: show stale
    else r = await fetchUsage(state.cred.accessToken, { cacheAs: state.account.email });

    if (r.error) {
      state.error = r.error;
      if (r.status === 429) { state.backoffMs = backoff(state.backoffMs, r.retryAfterMs); state.backoffUntil = Date.now() + state.backoffMs; markFail(); }
      // Fall back to whatever the last good response was (ours, statusline's, or the archive).
      const stale = readCache(state.account.email);
      const arch = state.account.email ? readAccount(state.account.email) : null;
      if (stale) { state.usage = normalize(stale.data); state.usageAt = stale.fetchedAt; }
      else if (arch?.usage) { state.usage = normalize(arch.usage); state.usageAt = arch.usageAt; }
      if (opts.json) { console.error(r.error); process.exit(1); }
      return;
    }
    state.error = null; state.backoffMs = 0; state.backoffUntil = 0;
    if (opts.json) { console.log(JSON.stringify(r.data, null, 2)); process.exit(0); }
    state.usage = normalize(r.data);
    state.usageAt = r.fetchedAt;
    if (state.account.email) { try { archiveUsage(state.account.email, r.data, r.fetchedAt); } catch { /* best effort */ } }
  }

  async function probe(force = false) {
    if (state.probing) return;
    state.probing = true;
    try {
      // Re-read credentials/account each probe so a re-login (different account)
      // is picked up without restarting.
      try { state.cred = loadCredentials(); } catch { /* keep last known */ }
      state.account = loadAccount();
      logActiveAccount(state.account.email);
      await maybeRefreshActive();
      try { archiveActive(state.cred, state.account); } catch { /* best effort */ }
      await probeActive(force);
      for (const rec of listAccounts()) {
        if (rec.email === state.account.email) continue;
        try { await probeOther(rec, force); } catch (e) { state.others.set(rec.email, { ...(state.others.get(rec.email) || {}), error: firstLine(e) }); }
      }
      if (!opts.noLocal) {
        const resets = state.usage?.sessionResetsAt ? Date.parse(state.usage.sessionResetsAt) : null;
        const windowStart = resets && resets > Date.now() ? resets - FIVE_H : Date.now() - FIVE_H;
        try { scanLocal(windowStart); state.localBy = localSummaryBy(state.account.email); } catch { /* best effort */ }
      }
    } finally { state.probing = false; }
  }

  return { state, probe, pollSessions };
}

// ─── Live TUI ────────────────────────────────────────────────────────────────
function runLive({ state, probe, pollSessions }) {
  const out = process.stdout;
  const altScreen = !!out.isTTY;
  if (altScreen) out.write(`${ESC}?1049h${ESC}?25l`);
  process.on('exit', () => { if (altScreen) out.write(`${ESC}?25h${ESC}?1049l`); });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

  let lastFrame = '';
  const draw = () => {
    const frame = render(state, Date.now());
    if (frame === lastFrame) return;
    lastFrame = frame;
    out.write(`${ESC}H${ESC}2J${frame}\n`);
  };
  const say = m => { state.msg = m; state.msgAt = Date.now(); };
  const resetActive = () => { state.usage = null; state.usageAt = null; state.error = null; state.backoffMs = 0; state.backoffUntil = 0; state.activeRefreshTriedAt = 0; };
  const reprobe = () => probe(true).catch(e => say(`${paint.red('probe failed:')} ${firstLine(e)}`)).then(draw);

  function doSwitch() {
    const c = cardList(state)[state.sel];
    if (!c || c.active) { say(paint.dim('already the logged-in account')); return; }
    try {
      const r = switchTo(c.email);
      say(`${paint.green('switched to')} ${paint.cyan(c.email)}${r.running ? paint.yellow(` — ${r.running} running claude session(s) ${HANDOVER_NOTE}`) : ''}`);
      resetActive();
      pollSessions();
      reprobe();
    } catch (e) { say(`${paint.red('switch failed:')} ${firstLine(e)}`); }
  }

  let loggingIn = false;
  function doLogin() {
    if (loggingIn) { say(paint.dim('login already in progress — finish it in the browser')); return; }
    loggingIn = true;
    const c = cardList(state)[state.sel];
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
      if (k === 'q' || k === '\x03') process.exit(0); // q or Ctrl-C
      else if (k === 'r') reprobe();
      else if (k === '\x1b[A' || k === 'k') state.sel = Math.max(0, state.sel - 1);
      else if (k === '\x1b[B' || k === 'j') state.sel = Math.min(cardList(state).length - 1, state.sel + 1);
      else if (k === '\r' || k === '\n') doSwitch();
      else if (k === 'l') doLogin();
      draw();
    });
  }

  const loop = () => probe().catch(e => say(`${paint.red('probe failed:')} ${firstLine(e)}`)).then(() => {
    draw();
    setTimeout(loop, state.backoffMs || opts.intervalMs).unref?.();
  });
  pollSessions();
  loop();
  draw();
  setInterval(draw, 1000);
  setInterval(pollSessions, PS_POLL_MS);
}

export async function main() {
  if (await runCommand()) return;
  const app = createApp();
  if (opts.once || opts.json) {
    await app.probe();
    app.pollSessions();
    process.stdout.write(render(app.state, Date.now()) + '\n');
    process.exit(app.state.error ? 1 : 0);
  }
  runLive(app);
}
