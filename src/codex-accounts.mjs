// Codex (ChatGPT) accounts: the archive, switching, refresh, and login.
// The logged-in account is whatever `$CODEX_HOME/auth.json` holds. Every
// account seen there is archived (the whole file, as Codex wrote it), and a
// switch writes an archived copy back. Archived tokens are refreshed by us
// with the Codex CLI's own call; the logged-in one is left to the CLI.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_ACCOUNTS_DIR, CODEX_AUTH_FILE, CODEX_CLIENT_ID, CODEX_HOME, CODEX_TOKEN_URL, orderRank } from './config.mjs';
import { safeReaddir } from './archive.mjs';
import { codexAuthFromFile, codexKey, codexPlanLabel, countCodexProcs, readCodexAuthFile } from './codex.mjs';
import { withLockAsync } from './lock.mjs';

// One file per account: { key, email, accountId, plan, authFile, usage,
// usageAt, credits, creditsAt, seenAt, savedAt }. `authFile` is auth.json
// verbatim; `seenAt` is when it was last the logged-in account.
const accountFile = key => join(CODEX_ACCOUNTS_DIR, `${String(key).toLowerCase().replace(/[^a-z0-9@._+-]/g, '_')}.json`);

export function readCodexAccount(key) {
  try { return JSON.parse(readFileSync(accountFile(key), 'utf8')); } catch { return null; }
}
export function saveCodexAccount(rec) {
  mkdirSync(CODEX_ACCOUNTS_DIR, { recursive: true, mode: 0o700 });
  const f = accountFile(rec.key), tmp = `${f}.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
  renameSync(tmp, f);
}
export function listCodexAccounts() {
  const out = [];
  for (const f of safeReaddir(CODEX_ACCOUNTS_DIR)) {
    if (!f.endsWith('.json')) continue;
    try { const r = JSON.parse(readFileSync(join(CODEX_ACCOUNTS_DIR, f), 'utf8')); if (r?.key) out.push(r); } catch { /* skip */ }
  }
  return out.sort((a, b) => orderRank(a.email) - orderRank(b.email) || (b.seenAt || 0) - (a.seenAt || 0));
}
export function forgetCodexAccount(key) { try { unlinkSync(accountFile(key)); return true; } catch { return false; } }

// `email`, or `email · plan` when another archived workspace shares the email.
export function codexName(rec, all = listCodexAccounts()) {
  const twin = all.some(r => r.key !== rec.key && r.email === rec.email);
  return twin && rec.plan ? `${rec.email} · ${codexPlanLabel(rec.plan)}` : rec.email || rec.key;
}

const identity = auth => ({ key: codexKey(auth), email: auth.email, accountId: auth.accountId, plan: auth.plan });

// Archive the logged-in account (auth.json as it is now). Called every Codex
// probe, so a token the CLI rotated is picked up within one interval.
export function archiveCodexActive(raw = readCodexAuthFile(), { force = false } = {}) {
  const auth = codexAuthFromFile(raw);
  if (!auth || !codexKey(auth)) return null;
  const id = identity(auth);
  const rec = readCodexAccount(id.key) || {};
  const changed = JSON.stringify(rec.authFile) !== JSON.stringify(raw) || rec.email !== id.email || rec.plan !== id.plan;
  Object.assign(rec, id, { authFile: raw, seenAt: Date.now() });
  if (force || changed || !rec.savedAt || Date.now() - rec.savedAt > 10 * 60_000) { rec.savedAt = Date.now(); saveCodexAccount(rec); }
  return rec;
}

// Last usage / credits responses, so an archived card shows numbers.
export function archiveCodexSnapshot(key, patch) {
  const rec = readCodexAccount(key); if (!rec) return;
  Object.assign(rec, patch, { savedAt: Date.now() }); saveCodexAccount(rec);
}

function writeCodexAuthFile(raw) {
  mkdirSync(CODEX_HOME, { recursive: true, mode: 0o700 });
  const tmp = `${CODEX_AUTH_FILE}.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2), { mode: 0o600 });
  renameSync(tmp, CODEX_AUTH_FILE);
}

// Make an archived account the logged-in one. Returns { already, running }.
export function switchCodexTo(key) {
  const rec = readCodexAccount(key);
  if (!rec?.authFile) throw new Error(`no archived codex tokens for ${key} — log in with l`);
  const cur = archiveCodexActive(undefined, { force: true }); // whoever is logged in now keeps their latest tokens
  const running = countCodexProcs();
  if (cur?.key === rec.key) return { already: true, running };
  writeCodexAuthFile(rec.authFile);
  rec.seenAt = Date.now(); saveCodexAccount(rec);
  return { already: false, running };
}

// Refresh an archived account's tokens (refresh tokens rotate). Under a
// per-account lock, re-reading the archive inside it, so two agent-usage
// processes never spend the same refresh token. Never touches the logged-in
// account: the Codex CLI owns that one. Returns { rec } | { skipped } | { error, dead }.
export async function refreshCodexAccount(key, { timeoutMs = 15_000 } = {}) {
  mkdirSync(CODEX_ACCOUNTS_DIR, { recursive: true, mode: 0o700 });
  return withLockAsync(`${accountFile(key)}.lock`, async () => {
    if (codexKey(codexAuthFromFile(readCodexAuthFile())) === key) return { skipped: true };
    const rec = readCodexAccount(key);
    const rt = rec?.authFile?.tokens?.refresh_token;
    if (!rt) return { error: 'no refresh token', dead: true };
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(CODEX_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'agent-usage' },
        body: JSON.stringify({ client_id: CODEX_CLIENT_ID, grant_type: 'refresh_token', refresh_token: rt, scope: 'openid profile email' }),
        signal: ctrl.signal,
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = b?.error?.code || b?.error?.message || b?.error_description || (typeof b?.error === 'string' ? b.error : '');
        return { error: `refresh HTTP ${res.status}${detail ? ': ' + detail : ''}`, dead: res.status === 400 || res.status === 401 };
      }
      const tokens = { ...rec.authFile.tokens, ...(b.id_token ? { id_token: b.id_token } : {}), ...(b.access_token ? { access_token: b.access_token } : {}), ...(b.refresh_token ? { refresh_token: b.refresh_token } : {}) };
      rec.authFile = { ...rec.authFile, tokens, last_refresh: new Date().toISOString() };
      const auth = codexAuthFromFile(rec.authFile);
      if (auth) Object.assign(rec, { email: auth.email || rec.email, plan: auth.plan || rec.plan });
      rec.savedAt = Date.now(); saveCodexAccount(rec); // not a login: seenAt stays
      return { rec };
    } catch (err) {
      return { error: err?.name === 'AbortError' ? 'refresh timed out' : `refresh: ${err?.message || err}` };
    } finally { clearTimeout(t); }
  });
}

// Browser login for another account: `codex login` itself, pointed at a
// throwaway CODEX_HOME so the logged-in account is untouched. Resolves with
// the new auth.json object. The temp dir is deleted, never logged out (a
// logout would revoke the fresh tokens).
export function codexLogin({ onStatus = () => {}, timeoutMs = 10 * 60_000 } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'agent-usage-codex-'));
  const cleanup = () => { try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ } };
  return new Promise((resolve, reject) => {
    let out = '', announced = false, done = false;
    const child = spawn('codex', ['login', '-c', 'cli_auth_credentials_store="file"'], { env: { ...process.env, CODEX_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (err, val) => { if (done) return; done = true; clearTimeout(timer); cleanup(); err ? reject(err) : resolve(val); };
    const timer = setTimeout(() => { child.kill(); finish(new Error(`codex login timed out (${Math.round(timeoutMs / 60_000)} min)`)); }, timeoutMs);
    const onData = d => {
      out += d;
      const url = /https:\/\/auth\.openai\.com\/\S+/.exec(out)?.[0];
      if (url && !announced) { announced = true; onStatus('browser opened — finish the Codex login there', url); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => finish(new Error(e.code === 'ENOENT' ? 'codex CLI not found on PATH — install it first' : e.message)));
    child.on('close', code => {
      if (done) return;
      let raw = null;
      try { raw = JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8')); } catch { /* none */ }
      if (code === 0 && codexAuthFromFile(raw)) return finish(null, raw);
      const why = out.trim().split('\n').filter(Boolean).pop() || `exit ${code}`;
      finish(new Error(`codex login: ${why}`));
    });
  });
}

// Store a fresh login. It becomes the logged-in account when nobody is
// logged in, or when it is the logged-in account again; otherwise it waits in
// the archive for a switch. Returns { key, activated, text }.
export function storeCodexLogin(raw) {
  const auth = codexAuthFromFile(raw);
  if (!auth || !codexKey(auth)) throw new Error('codex login produced no ChatGPT tokens');
  const id = identity(auth);
  const rec = { ...(readCodexAccount(id.key) || {}), ...id, authFile: raw, savedAt: Date.now() };
  const cur = codexAuthFromFile(readCodexAuthFile());
  const activate = !cur || codexKey(cur) === id.key;
  if (activate) { writeCodexAuthFile(raw); rec.seenAt = Date.now(); }
  saveCodexAccount(rec);
  const name = codexName(rec);
  return { key: id.key, activated: activate, text: activate ? `codex logged in as ${name}` : `codex: logged in as ${name} (archived; enter on its card to switch)` };
}

// Accept a key, an email, or a unique substring of one, for the CLI.
export function resolveCodexAccount(input) {
  const q = String(input || '').toLowerCase();
  const all = listCodexAccounts();
  const exact = all.filter(r => r.key.toLowerCase() === q || (r.email || '').toLowerCase() === q);
  const matches = exact.length ? exact : all.filter(r => (r.email || '').toLowerCase().includes(q));
  if (matches.length > 1) throw new Error(`'${input}' matches several codex accounts: ${matches.map(r => `${r.email} (${r.plan || r.key})`).join(', ')} — use the account id: ${matches.map(r => r.key).join(', ')}`);
  if (!matches.length) throw new Error(`codex: no archived account matches '${input}'`);
  return matches[0];
}
