// Automatic Codex resets use the same banked credits as the manual action.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONFIG_FILE, config } from './config.mjs';
import { normalizeCodex, normalizeCodexCredits } from './codex.mjs';
import { bankedCount, usableGrant } from './usage.mjs';

export const CODEX_AUTO_THRESHOLD = 95;
export const CODEX_AUTO_MIN_RESET_MS = 24 * 60 * 60 * 1000;
export const CODEX_AUTO_INTERVAL_MS = 30_000;
export const CODEX_AUTO_RETRY_MS = 60_000;

let enabled = config.codexAutoReset === true;
export const codexAutoEnabled = () => enabled;
export function reloadCodexAuto() {
  try { enabled = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')).codexAutoReset === true; }
  catch { /* keep the last setting during a partial write */ }
  return enabled;
}
export function setCodexAuto(on) {
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) || {}; } catch { /* fresh config */ }
  cfg.codexAutoReset = !!on;
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
  enabled = !!on;
  return enabled;
}

export function codexResetWindows(usage, now = Date.now()) {
  return normalizeCodex(usage).rows.filter(r =>
    Number.isFinite(r.percent) && r.percent >= CODEX_AUTO_THRESHOLD &&
    Date.parse(r.resetsAt) - now >= CODEX_AUTO_MIN_RESET_MS);
}

// Successful claims suppress duplicate spending until usage recovers. Failed
// claims retry after a cooldown, but only with the SAME still-usable credit.
// An uncertain response also keeps the request ID, never selecting another
// credit while the first one's outcome is unknown.
export function createCodexResetGuard() {
  const attempts = new Map();
  const accountKey = auth => auth?.accountId || auth?.email || null;
  const windowKey = r => `${r.label}:${r.resetsAt}`;
  function observe(auth, usage, now) {
    const account = accountKey(auth);
    const windows = codexResetWindows(usage, now);
    const current = attempts.get(account) || new Map();
    // Missing/unknown rows are not evidence that a claimed window recovered.
    for (const row of normalizeCodex(usage).rows) {
      if (Number.isFinite(row.percent) && row.percent < CODEX_AUTO_THRESHOLD) current.delete(windowKey(row));
    }
    if (account) attempts.set(account, current);
    return { account, windows, current };
  }
  return {
    target(auth, usage, credits, now = Date.now()) {
      const { account, windows, current } = observe(auth, usage, now);
      if (!account || !auth.accessToken || (auth.expiresAt && auth.expiresAt <= now) || !windows.length) return null;
      const previous = windows.map(row => current.get(windowKey(row))).filter(Boolean);
      if (previous.some(a => a.done || now < a.retryAt)) return null;
      const attempt = previous[0];
      const resets = normalizeCodexCredits(credits, now);
      const retryResets = attempt && resets ? { ...resets, grants: resets.grants.filter(g => g.id === attempt.creditId) } : resets;
      const grant = usableGrant(retryResets, now);
      return grant ? { kind: 'codex', name: 'codex', auth, grant, banked: bankedCount(resets, now), attempt } : null;
    },
    markAttempt(target, usage, now = Date.now()) {
      const { account, windows, current } = observe(target.auth, usage, now);
      const attempt = target.attempt || { creditId: target.grant.id, requestId: randomUUID(), done: false };
      attempt.retryAt = now + CODEX_AUTO_RETRY_MS;
      if (account) for (const row of windows) current.set(windowKey(row), attempt);
      return attempt;
    },
    finishAttempt(attempt, result, now = Date.now()) {
      attempt.done = result.windowsReset > 0;
      attempt.retryAt = now + Math.max(CODEX_AUTO_RETRY_MS, result.retryAfterMs || 0);
      // A definite no-op may be cached by request ID; a new attempt can use
      // a new ID. Transport/HTTP failures keep the original ID instead.
      if (!result.error && !attempt.done) attempt.requestId = randomUUID();
    },
  };
}

// A separate heartbeat keeps Codex independent of Claude backoff, slow probes,
// and the dashboard's -i interval. probeCodex owns due times and single-flight.
export function startCodexPolling(probeCodex, onError = () => {}) {
  const tick = () => { Promise.resolve().then(() => probeCodex()).catch(onError); };
  const timer = setInterval(tick, 1000);
  tick();
  return () => clearInterval(timer);
}
