// Per-account archive (tokens + identity + last usage) and the switch log.
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACCOUNTS_DIR, STATE_DIR, SWITCH_LOG, orderRank } from './config.mjs';

export function safeReaddir(d) { try { return readdirSync(d); } catch { return []; } }

// ─── Accounts ────────────────────────────────────────────────────────────────
// One file per account: { email, oauth, oauthAccount, usage, usageAt, seenAt, savedAt }.
// `oauth` is re-copied from the keychain on every probe while that account is
// the logged-in one, so a refresh performed by Claude Code (rotated tokens) is
// picked up within one interval.
const accountFile = email => join(ACCOUNTS_DIR, `${email.toLowerCase().replace(/[^a-z0-9@._+-]/g, '_')}.json`);

export function readAccount(email) {
  try { return JSON.parse(readFileSync(accountFile(email), 'utf8')); } catch { return null; }
}
export function saveAccount(rec) {
  mkdirSync(ACCOUNTS_DIR, { recursive: true, mode: 0o700 });
  const f = accountFile(rec.email), tmp = `${f}.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
  renameSync(tmp, f);
}
export function listAccounts() {
  const out = [];
  for (const f of safeReaddir(ACCOUNTS_DIR)) {
    if (!f.endsWith('.json')) continue;
    try { const r = JSON.parse(readFileSync(join(ACCOUNTS_DIR, f), 'utf8')); if (r?.email) out.push(r); } catch { /* skip */ }
  }
  return out.sort((a, b) => orderRank(a.email) - orderRank(b.email) || (b.seenAt || 0) - (a.seenAt || 0));
}
export function forgetAccount(email) { try { unlinkSync(accountFile(email)); return true; } catch { return false; } }

// Archive the currently logged-in account's tokens + identity. Returns the record.
export function archiveActive(oauth, account) {
  if (!account?.email || !oauth?.accessToken) return null;
  const rec = readAccount(account.email) || { email: account.email };
  // Claude Code drops fields it does not know when it rewrites the blob;
  // refreshTokenExpiresAt is ours, keep it from the archive.
  const next = { ...oauth };
  if (next.refreshTokenExpiresAt == null && rec.oauth?.refreshTokenExpiresAt != null && rec.oauth.refreshToken === next.refreshToken) next.refreshTokenExpiresAt = rec.oauth.refreshTokenExpiresAt;
  const changed = JSON.stringify(rec.oauth) !== JSON.stringify(next) || JSON.stringify(rec.oauthAccount) !== JSON.stringify(account.raw);
  rec.oauth = next; rec.oauthAccount = account.raw; rec.seenAt = Date.now();
  if (changed || !rec.savedAt || Date.now() - rec.savedAt > 10 * 60_000) { rec.savedAt = Date.now(); saveAccount(rec); }
  return rec;
}
export function archiveUsage(email, data, at) {
  const rec = readAccount(email); if (!rec) return;
  rec.usage = data; rec.usageAt = at; rec.savedAt = Date.now(); saveAccount(rec);
}

// ─── Switch log ──────────────────────────────────────────────────────────────
let switchLog = null; // [{ t, email }] ascending

function writeSwitchLog(entries) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(SWITCH_LOG, entries.map(x => JSON.stringify(x)).join('\n') + (entries.length ? '\n' : ''));
}

export function loadSwitchLog() {
  if (switchLog) return switchLog;
  switchLog = [];
  try {
    for (const line of readFileSync(SWITCH_LOG, 'utf8').split('\n')) {
      if (!line) continue;
      try { const e = JSON.parse(line); if (e?.email && e?.t) switchLog.push(e); } catch { /* skip */ }
    }
  } catch {
    // First run: reconstruct a rough history from the archive. Each account
    // was logged in from the previous account's last-seen time until its own.
    const seen = listAccounts().filter(r => r.seenAt).sort((a, b) => a.seenAt - b.seenAt);
    seen.forEach((r, i) => switchLog.push({ t: i ? seen[i - 1].seenAt : 1, email: r.email }));
    try { writeSwitchLog(switchLog); } catch { /* best effort */ }
  }
  return switchLog;
}

// Record `email` as logged in from now, if that is a change.
export function logActiveAccount(email) {
  if (!email) return;
  const log = loadSwitchLog();
  if (log.length && log[log.length - 1].email === email) return;
  const e = { t: Date.now(), email };
  log.push(e);
  try {
    if (log.length > 500) { switchLog = log.slice(-200); writeSwitchLog(switchLog); }
    else { mkdirSync(STATE_DIR, { recursive: true }); appendFileSync(SWITCH_LOG, JSON.stringify(e) + '\n'); }
  } catch { /* best effort */ }
}

// Account logged in at time `ts` (before the first record, the first recorded account).
export function accountAt(ts) {
  const log = loadSwitchLog();
  let email = log.length ? log[0].email : null;
  for (const e of log) { if (e.t <= ts) email = e.email; else break; }
  return email;
}

export function lastSwitchAt() { const log = loadSwitchLog(); return log.length ? log[log.length - 1].t : 0; }
