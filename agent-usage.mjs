#!/usr/bin/env node
// agent-usage — live Claude (Max/Pro OAuth) quota in the terminal, multi-account.
//
// Reads the Claude Code OAuth token from the macOS keychain, polls the
// zero-spend usage endpoint (`/api/oauth/usage`) and renders a teamclaude-style
// status panel. Local transcripts (~/.claude/projects) are scanned incrementally
// to show requests/tokens in the current 5h session window.
//
// Every account it ever sees logged in is archived (tokens + last usage) under
// ~/.local/state/agent-usage/accounts/. Archived accounts render as gray cards
// below the active one and can be switched into (↑/↓ + Enter): the archived
// OAuth blob is written back to the keychain + ~/.claude.json, so the next
// `claude` you start runs as that account.
//
// Zero dependencies. Node >= 18 (or bun).

import { execFileSync } from 'node:child_process';
import {
  readFileSync, readdirSync, statSync, openSync, readSync, closeSync, existsSync,
  writeFileSync, renameSync, unlinkSync, mkdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

// ─── CLI ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };

if (has('-h') || has('--help')) {
  console.log(`agent-usage — live Claude quota in the terminal

usage: agent-usage [options]

  (no args)        live mode: re-probe every 60s
  -i, --interval N probe interval in seconds (min 30, default 60)
  -1, --once       print once and exit
  --json           print raw usage JSON (active account) and exit
  --no-local       skip local transcript scan (Usage row)
  --no-color       disable ANSI colors

accounts (archived under ~/.local/state/agent-usage/accounts/):
  --accounts       list archived accounts and exit
  --switch EMAIL   make EMAIL the logged-in Claude Code account and exit
  --forget EMAIL   delete EMAIL's archived tokens/usage and exit
  --login          log in via the browser (PKCE, like \`claude /login\`), archive
                   the account, make it the logged-in one, and exit

live keys: ↑/↓ select account · enter switch · l login in browser · r probe now · q quit`);
  process.exit(0);
}

const ONCE = has('-1') || has('--once');
const JSON_OUT = has('--json');
const NO_LOCAL = has('--no-local');
const INTERVAL_MS = Math.max(30, Number(opt('-i', opt('--interval', 60))) || 60) * 1000;
const COLOR = !has('--no-color') && !!process.stdout.isTTY && !process.env.NO_COLOR;

const HOME = homedir();
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// Same OAuth client Claude Code uses (see its TOKEN_URL / CLIENT_ID constants).
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_SCOPES = ['org:create_api_key', 'user:profile', 'user:inference', 'user:file_upload', 'user:mcp_servers', 'user:sessions:claude_code'];
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const CRED_FILE = join(HOME, '.claude', '.credentials.json');
const CLAUDE_JSON = join(HOME, '.claude.json');
const PROJECTS_DIR = join(HOME, '.claude', 'projects');
const STATE_DIR = join(HOME, '.local', 'state', 'agent-usage');
const ACCOUNTS_DIR = join(STATE_DIR, 'accounts');
// Shared with ~/.claude/statusline-command.sh: whoever fetched last writes here,
// everyone else reads. One request per CACHE_TTL across all tools/sessions —
// the endpoint is aggressively rate limited (429, retry-after: 0) and a 429
// never clears while anything keeps polling. Entries we write carry
// `_account` so a cache left over from another account is never shown.
const CACHE_FILE = '/tmp/.claude-usage-cache';
const FAIL_FILE = `${CACHE_FILE}.fail`; // statusline's negative-cache stamp
const CACHE_TTL_MS = 120_000;
const MIN_BACKOFF_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;
// Archived (not logged-in) accounts: poll usage once an hour and refresh their
// access token when it is within REFRESH_AHEAD_MS of expiring (or already
// expired). A refresh rotates the refresh token, so it is only ever done for
// tokens no running `claude` session can hold: archived accounts, or the
// active account while no `claude` process is running.
const OTHER_INTERVAL_MS = 60 * 60_000;
const REFRESH_AHEAD_MS = 30 * 60_000;
const REFRESH_RETRY_MS = 10 * 60_000;
const FIVE_H = 5 * 3600 * 1000;
const WEEK_MS = 7 * 24 * 3600 * 1000;
const MSG_TTL_MS = 60_000;

// ─── Credentials ────────────────────────────────────────────────────────────
// The keychain item holds one JSON blob: { claudeAiOauth: {...}, mcpOAuth: {...} }.
// Only claudeAiOauth is account-specific; mcpOAuth (Figma, Cloudflare, ...) is
// shared and must survive a switch.
function loadCredentialBlob() {
  let raw = null, acct = process.env.USER || 'claude';
  if (process.platform === 'darwin') {
    try {
      raw = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      const meta = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      const m = meta.match(/"acct"<blob>="([^"]*)"/); if (m) acct = m[1];
    } catch { /* fall through */ }
  }
  if (!raw && existsSync(CRED_FILE)) raw = readFileSync(CRED_FILE, 'utf8');
  let json = null;
  if (raw) { try { json = JSON.parse(raw); } catch { json = null; } }
  return { json, acct, fromKeychain: !!raw && process.platform === 'darwin' && !existsSync(CRED_FILE) };
}

function loadCredentials() {
  const { json } = loadCredentialBlob();
  if (!json) throw new Error('no Claude Code credentials found (keychain or ~/.claude/.credentials.json). Log in with `claude` first.');
  const o = json.claudeAiOauth;
  if (!o?.accessToken) throw new Error('credentials found but no claudeAiOauth.accessToken. Log in with `claude` first.');
  return o;
}

function loadAccount() {
  try {
    const a = JSON.parse(readFileSync(CLAUDE_JSON, 'utf8'))?.oauthAccount || {};
    return { email: a.emailAddress || null, org: a.organizationName || null, type: a.organizationType || null, raw: a };
  } catch { return { email: null, org: null, type: null, raw: null }; }
}

function planLabel(oauth) {
  const tier = (oauth?.rateLimitTier || '').replace(/^default_claude_/, '').replace('_', ' ');
  const sub = oauth?.subscriptionType || '';
  return tier.startsWith(sub) ? tier : [sub, tier].filter(Boolean).join(' ');
}

// ─── Account archive ────────────────────────────────────────────────────────
// One file per account: { email, oauth, oauthAccount, usage, usageAt, seenAt }.
// `oauth` is re-copied from the keychain on every probe while that account is
// the logged-in one, so a refresh performed by Claude Code (rotated tokens) is
// picked up within one interval.
const accountFile = email => join(ACCOUNTS_DIR, `${email.toLowerCase().replace(/[^a-z0-9@._+-]/g, '_')}.json`);

function readAccount(email) {
  try { return JSON.parse(readFileSync(accountFile(email), 'utf8')); } catch { return null; }
}
function saveAccount(rec) {
  mkdirSync(ACCOUNTS_DIR, { recursive: true, mode: 0o700 });
  const f = accountFile(rec.email), tmp = `${f}.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
  renameSync(tmp, f);
}
function listAccounts() {
  const out = [];
  for (const f of safeReaddir(ACCOUNTS_DIR)) {
    if (!f.endsWith('.json')) continue;
    try { const r = JSON.parse(readFileSync(join(ACCOUNTS_DIR, f), 'utf8')); if (r?.email) out.push(r); } catch { /* skip */ }
  }
  return out.sort((a, b) => (b.seenAt || 0) - (a.seenAt || 0));
}
function forgetAccount(email) { try { unlinkSync(accountFile(email)); return true; } catch { return false; } }

// Archive the currently logged-in account's tokens + identity. Returns the record.
function archiveActive(oauth, account) {
  if (!account?.email || !oauth?.accessToken) return null;
  const rec = readAccount(account.email) || { email: account.email };
  const changed = JSON.stringify(rec.oauth) !== JSON.stringify(oauth) || JSON.stringify(rec.oauthAccount) !== JSON.stringify(account.raw);
  rec.oauth = oauth; rec.oauthAccount = account.raw; rec.seenAt = Date.now();
  if (changed || !rec.savedAt || Date.now() - rec.savedAt > 10 * 60_000) { rec.savedAt = Date.now(); saveAccount(rec); }
  return rec;
}
function archiveUsage(email, data, at) {
  const rec = readAccount(email); if (!rec) return;
  rec.usage = data; rec.usageAt = at; rec.savedAt = Date.now(); saveAccount(rec);
}

// ─── Switching ──────────────────────────────────────────────────────────────
function countClaudeProcs() {
  try { return execFileSync('pgrep', ['-x', 'claude'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n').filter(Boolean).length; } catch { return 0; }
}

function writeKeychain(acct, value) {
  // NOTE: `security -i` (stdin) silently truncates lines at 4 KiB and the blob
  // is ~10-15 KiB, so the value has to go via argv (same as Claude Code does).
  execFileSync('security', ['add-generic-password', '-a', acct, '-s', KEYCHAIN_SERVICE, '-U', '-w', value], { stdio: ['ignore', 'ignore', 'pipe'] });
  // Verify the round trip.
  const back = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  if (back !== value) throw new Error('keychain write did not round-trip');
}

// Replace claudeAiOauth in the Claude Code credential store (keychain or file),
// keeping everything else in the blob (mcpOAuth ...).
function writeCredentials(blob, oauth) {
  const next = { ...(blob.json || {}), claudeAiOauth: oauth };
  const serialized = JSON.stringify(next);
  if (process.platform === 'darwin' && (blob.fromKeychain || !existsSync(CRED_FILE))) writeKeychain(blob.acct, serialized);
  else { const tmp = `${CRED_FILE}.${process.pid}`; writeFileSync(tmp, serialized, { mode: 0o600 }); renameSync(tmp, CRED_FILE); }
}
function writeOauthAccount(oauthAccount) {
  let cj = {}; try { cj = JSON.parse(readFileSync(CLAUDE_JSON, 'utf8')); } catch { /* fresh */ }
  cj.oauthAccount = oauthAccount;
  const tmp = `${CLAUDE_JSON}.${process.pid}`; writeFileSync(tmp, JSON.stringify(cj, null, 2)); renameSync(tmp, CLAUDE_JSON);
}

function switchTo(email) {
  const rec = readAccount(email);
  if (!rec?.oauth?.accessToken) throw new Error(`no archived tokens for ${email} — log in once with \`claude /login\` while agent-usage runs`);
  const now = Date.now();
  const rexp = Number(rec.oauth.refreshTokenExpiresAt) || 0;
  if (rexp && rexp < now) throw new Error(`${email}: refresh token expired — run \`claude /login\` as that account`);

  // Make sure whoever is logged in right now is archived before we overwrite them.
  const blob = loadCredentialBlob();
  const cur = loadAccount();
  if (blob.json?.claudeAiOauth?.accessToken && cur.email) archiveActive(blob.json.claudeAiOauth, cur);
  if (cur.email === email) return { already: true, running: countClaudeProcs() };

  writeCredentials(blob, rec.oauth);
  if (rec.oauthAccount) writeOauthAccount(rec.oauthAccount);
  for (const f of [CACHE_FILE, FAIL_FILE]) { try { unlinkSync(f); } catch { /* none */ } }
  return { already: false, running: countClaudeProcs() };
}

// ─── Browser login (PKCE, same flow as `claude /login`) ─────────────────────
const LOGIN_PORT = 54545;
const b64url = b => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); return true; } catch { return false; }
}

// Runs the whole flow: local callback listener -> browser -> code exchange ->
// profile lookup. Resolves { oauth, account } (account = oauthAccount shape).
// `onStatus(msg)` receives progress lines. Rejects on failure/timeout.
async function browserLogin({ onStatus = () => {}, timeoutMs = 5 * 60_000 } = {}) {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const stateNonce = b64url(randomBytes(32));
  const redirectUri = `http://localhost:${LOGIN_PORT}/callback`;

  const code = await new Promise((resolve, reject) => {
    let done = false;
    const finish = (err, val) => { if (done) return; done = true; clearTimeout(timer); server.close(); err ? reject(err) : resolve(val); };
    const server = createServer((req, res) => {
      const u = new URL(req.url, redirectUri);
      if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
      const err = u.searchParams.get('error');
      const c = u.searchParams.get('code'), st = u.searchParams.get('state');
      const ok = !err && c && st === stateNonce;
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset=utf-8><body style="font:16px system-ui;padding:2em">${ok ? 'agent-usage: login complete, you can close this tab.' : `agent-usage: login failed (${err || 'bad state'}).`}</body>`);
      if (ok) finish(null, c); else finish(new Error(err ? `authorization denied: ${err}` : 'state mismatch in callback'));
    });
    const timer = setTimeout(() => finish(new Error('login timed out (5 min)')), timeoutMs);
    server.on('error', e => finish(new Error(e.code === 'EADDRINUSE' ? `port ${LOGIN_PORT} busy (another login running?)` : e.message)));
    server.listen(LOGIN_PORT, '127.0.0.1', () => {
      const url = new URL(AUTHORIZE_URL);
      for (const [k, v] of Object.entries({
        code: 'true', client_id: OAUTH_CLIENT_ID, response_type: 'code', redirect_uri: redirectUri,
        scope: OAUTH_SCOPES.join(' '), code_challenge: challenge, code_challenge_method: 'S256', state: stateNonce,
      })) url.searchParams.set(k, v);
      const opened = openBrowser(url.toString());
      onStatus(opened ? 'browser opened — finish login there' : `open this URL to log in: ${url}`);
    });
  });

  onStatus('exchanging code…');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'agent-usage/1.2' },
    body: JSON.stringify({ grant_type: 'authorization_code', code, state: stateNonce, redirect_uri: redirectUri, client_id: OAUTH_CLIENT_ID, code_verifier: verifier }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`token exchange HTTP ${res.status}: ${body?.error_description || body?.error?.message || body?.error || ''}`);
  const oauth = tokenResponseToOauth(body, {});

  // Identity, so the account can be archived / written to ~/.claude.json.
  const pr = await fetch(PROFILE_URL, { headers: { Authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json', 'User-Agent': 'agent-usage/1.2' } });
  const prof = await pr.json().catch(() => ({}));
  if (!pr.ok) throw new Error(`profile HTTP ${pr.status}`);
  const a = prof.account || {}, org = prof.organization || {};
  if (!a.email_address) throw new Error('profile response had no email');
  const account = {
    accountUuid: a.uuid, emailAddress: a.email_address, displayName: a.display_name || a.full_name || undefined, fullName: a.full_name || undefined,
    organizationUuid: org.uuid, organizationName: org.name, organizationType: org.organization_type, organizationRole: org.role || undefined,
    billingType: org.billing_type || undefined, hasExtraUsageEnabled: a.has_extra_usage_enabled ?? org.has_extra_usage_enabled ?? undefined,
    organizationRateLimitTier: org.rate_limit_tier || undefined, userRateLimitTier: a.rate_limit_tier || undefined, profileFetchedAt: Date.now(),
  };
  for (const k of Object.keys(account)) if (account[k] === undefined) delete account[k];
  if (!oauth.subscriptionType && (org.subscription_type || a.subscription_type)) oauth.subscriptionType = org.subscription_type || a.subscription_type;
  if (!oauth.rateLimitTier && (org.rate_limit_tier || a.rate_limit_tier)) oauth.rateLimitTier = org.rate_limit_tier || a.rate_limit_tier;
  return { oauth, account, profile: prof };
}

// Store a fresh login: always archive; make it the logged-in account when
// `activate` (or when nobody is logged in). Returns a summary string.
function storeLogin({ oauth, account }, { activate }) {
  const email = account.emailAddress;
  const rec = readAccount(email) || { email };
  rec.oauth = oauth; rec.oauthAccount = { ...(rec.oauthAccount || {}), ...account }; rec.seenAt = Date.now(); rec.savedAt = Date.now();
  saveAccount(rec);
  const blob = loadCredentialBlob();
  const cur = loadAccount();
  const nobody = !blob.json?.claudeAiOauth?.accessToken || !cur.email;
  if (!activate && !nobody && cur.email !== email) return `logged in as ${email} (archived; enter to switch)`;
  if (!nobody && cur.email && cur.email !== email) archiveActive(blob.json.claudeAiOauth, cur);
  writeCredentials(blob, oauth);
  writeOauthAccount(rec.oauthAccount);
  for (const f of [CACHE_FILE, FAIL_FILE]) { try { unlinkSync(f); } catch { /* none */ } }
  const running = countClaudeProcs();
  return `logged in as ${email}${running ? ` — ${running} running claude session(s) keep their old tokens until restarted` : ''}`;
}

// ─── Probe ──────────────────────────────────────────────────────────────────
async function fetchUsage(accessToken, { cacheAs = null, timeoutMs = 10_000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        Accept: 'application/json',
        'User-Agent': 'agent-usage/1.1',
      },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      let detail = '';
      try { const b = await res.json(); detail = b?.error?.message || JSON.stringify(b).slice(0, 120); } catch { /* ignore */ }
      const ra = Number(res.headers.get('retry-after')) || 0;
      return { error: `HTTP ${res.status}${detail ? ': ' + detail : ''}`, status: res.status, retryAfterMs: ra * 1000 };
    }
    const data = await res.json();
    if (cacheAs) writeCache({ ...data, _account: cacheAs });
    return { data, fetchedAt: Date.now() };
  } catch (err) {
    return { error: err?.name === 'AbortError' ? 'probe timed out' : (err?.message || String(err)) };
  } finally { clearTimeout(t); }
}

// Exchange a refresh token for a new access token (+ rotated refresh token).
// Returns a new claudeAiOauth-shaped object, or { error, status, dead }.
// `dead` means the refresh token itself was rejected: only a browser login helps.
async function refreshOauth(oauth, { timeoutMs = 15_000 } = {}) {
  if (!oauth?.refreshToken) return { error: 'no refresh token', dead: true };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'agent-usage/1.2' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: oauth.refreshToken, client_id: OAUTH_CLIENT_ID, scope: (oauth.scopes || OAUTH_SCOPES).join(' ') }),
      signal: ctrl.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = body?.error_description || body?.error?.message || body?.error || '';
      const dead = res.status === 400 || res.status === 401 || res.status === 403;
      return { error: `refresh HTTP ${res.status}${detail ? ': ' + detail : ''}`, status: res.status, dead };
    }
    return tokenResponseToOauth(body, oauth);
  } catch (err) {
    return { error: err?.name === 'AbortError' ? 'refresh timed out' : (err?.message || String(err)) };
  } finally { clearTimeout(t); }
}

// Map a /v1/oauth/token response onto the claudeAiOauth blob shape Claude Code stores.
function tokenResponseToOauth(body, prev = {}) {
  const now = Date.now();
  const out = {
    ...prev,
    accessToken: body.access_token,
    refreshToken: body.refresh_token || prev.refreshToken,
    expiresAt: now + (Number(body.expires_in) || 8 * 3600) * 1000,
    scopes: typeof body.scope === 'string' && body.scope ? body.scope.split(' ') : (prev.scopes || OAUTH_SCOPES),
  };
  if (body.refresh_token_expires_in) out.refreshTokenExpiresAt = now + Number(body.refresh_token_expires_in) * 1000;
  else if (body.refresh_token && !prev.refreshTokenExpiresAt) delete out.refreshTokenExpiresAt;
  if (body.account?.subscription_type || body.subscription_type) out.subscriptionType = body.account?.subscription_type || body.subscription_type;
  if (body.account?.rate_limit_tier || body.rate_limit_tier) out.rateLimitTier = body.account?.rate_limit_tier || body.rate_limit_tier;
  return out;
}

function readCache(email) {
  try {
    const st = statSync(CACHE_FILE);
    const data = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    if (data?._account && email && data._account !== email) return null; // another account's numbers
    if (data?.five_hour || data?.limits) return { data, fetchedAt: st.mtimeMs };
  } catch { /* no cache */ }
  return null;
}
function writeCache(data) {
  try { const tmp = `${CACHE_FILE}.${process.pid}`; writeFileSync(tmp, JSON.stringify(data)); renameSync(tmp, CACHE_FILE); } catch { /* best effort */ }
  try { unlinkSync(FAIL_FILE); } catch { /* none */ }
}

// Normalise the response into rows: Session, Weekly, Fable (always), plus any
// other scoped weekly buckets (Sonnet, Opus, ...) the plan exposes.
function normalize(data) {
  const rows = [];
  const bucket = (label, b, extra = {}) => b ? { label, percent: num(b.utilization ?? b.percent), resetsAt: b.resets_at || null, severity: b.severity || null, ...extra } : null;

  const limits = Array.isArray(data?.limits) ? data.limits : [];
  const byKind = k => limits.find(l => l.kind === k);
  const session = bucket('Session', byKind('session'), { window: 'session' }) || bucket('Session', data?.five_hour, { window: 'session' });
  const weekly = bucket('Weekly', byKind('weekly_all')) || bucket('Weekly', data?.seven_day);
  if (session) rows.push(session);
  if (weekly) rows.push(weekly);

  const scoped = limits.filter(l => l.kind === 'weekly_scoped');
  const scopedName = l => l?.scope?.model?.display_name || l?.scope?.model?.id || l?.scope?.surface || 'Scoped';
  let fable = scoped.find(l => /fable/i.test(scopedName(l)));
  if (!fable) {
    // Older shape: a top-level key containing "fable".
    const k = Object.keys(data || {}).find(k => /fable/i.test(k) && data[k]?.utilization != null);
    if (k) fable = data[k];
  }
  rows.push(bucket('Fable', fable, { dedicated: true }) || { label: 'Fable', percent: null, resetsAt: null, severity: null, dedicated: true });

  for (const l of scoped) {
    if (l === fable) continue;
    rows.push(bucket(scopedName(l), l));
  }
  if (data?.seven_day_sonnet && !rows.some(r => r.label === 'Sonnet')) rows.push(bucket('Sonnet', data.seven_day_sonnet));
  if (data?.seven_day_opus && !rows.some(r => r.label === 'Opus')) rows.push(bucket('Opus', data.seven_day_opus));

  const extra = data?.extra_usage || {};
  return {
    rows,
    extra: { enabled: !!extra.is_enabled, percent: num(extra.utilization), used: extra.used_credits, limit: extra.monthly_limit },
    sessionResetsAt: session?.resetsAt || null,
  };
}

// Age stale rows: once a bucket's reset moment has passed, its bar is empty.
// Weekly buckets recur on a fixed 7-day schedule, so the countdown rolls
// forward; a 5h session window simply ends (a new one starts on first use).
function projectRows(rows, now) {
  return rows.map(r => {
    const t = r.resetsAt ? Date.parse(r.resetsAt) : null;
    if (!t || t > now) return r;
    if (r.window === 'session') return { ...r, percent: r.percent == null ? null : 0, resetsAt: null, ended: true };
    let n = t; while (n <= now) n += WEEK_MS;
    return { ...r, percent: r.percent == null ? null : 0, resetsAt: new Date(n).toISOString(), ended: true, projected: true };
  });
}

const num = v => (v == null || Number.isNaN(Number(v)) ? null : Number(v));

// ─── Local transcript scan (incremental) ────────────────────────────────────
// Tracks per-file read offsets so each probe only parses appended bytes.
// Requests are deduped by requestId (Claude Code writes one assistant line per
// content block, each repeating the same usage object).
const fileState = new Map(); // path -> { offset, rest }
const requests = new Map();  // requestId -> { ts, tokens }

function scanLocal(windowStart) {
  if (!existsSync(PROJECTS_DIR)) return;
  const files = [];
  for (const proj of safeReaddir(PROJECTS_DIR)) {
    const dir = join(PROJECTS_DIR, proj);
    for (const f of safeReaddir(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const p = join(dir, f);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.mtimeMs >= windowStart) files.push({ p, size: st.size });
    }
  }
  for (const { p, size } of files) {
    const st = fileState.get(p) || { offset: 0, rest: '' };
    if (size < st.offset) { st.offset = 0; st.rest = ''; } // truncated/rotated
    if (size === st.offset) continue;
    let fd; try { fd = openSync(p, 'r'); } catch { continue; }
    try {
      const buf = Buffer.alloc(size - st.offset);
      const n = readSync(fd, buf, 0, buf.length, st.offset);
      st.offset += n;
      const text = st.rest + buf.toString('utf8', 0, n);
      const lines = text.split('\n');
      st.rest = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.includes('"usage"')) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        const u = j?.message?.usage;
        if (!u || j.type !== 'assistant') continue;
        const ts = Date.parse(j.timestamp);
        if (!ts || ts < windowStart) continue;
        const id = j.requestId || j.message?.id || `${p}:${st.offset}:${ts}`;
        const tokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
        const prev = requests.get(id);
        requests.set(id, { ts, tokens: Math.max(prev?.tokens || 0, tokens) });
      }
    } finally { closeSync(fd); }
    fileState.set(p, st);
  }
  for (const [id, r] of requests) if (r.ts < windowStart) requests.delete(id);
}

function safeReaddir(d) { try { return readdirSync(d); } catch { return []; } }

function localSummary() {
  let req = 0, tok = 0, last = 0;
  for (const r of requests.values()) { req++; tok += r.tokens; if (r.ts > last) last = r.ts; }
  return { req, tok, last: last || null };
}

// ─── Rendering ──────────────────────────────────────────────────────────────
const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const wrap = code => v => COLOR ? `${ESC}${code}m${v}${RESET}` : String(v);
const paint = {
  rgb: (r, g, b, v) => COLOR ? `${ESC}38;2;${r};${g};${b}m${v}${RESET}` : String(v),
  bold: wrap(1), dim: wrap(2), gray: wrap(90), green: wrap(32), yellow: wrap(33), red: wrap(31), cyan: wrap(36),
};

function gradientColor(i, width) {
  const t = width <= 1 ? 1 : i / (width - 1);
  const from = t < 0.5 ? [35, 209, 96] : [245, 185, 40];
  const to = t < 0.5 ? [245, 185, 40] : [239, 68, 68];
  const p = t < 0.5 ? t * 2 : (t - 0.5) * 2;
  return from.map((v, k) => Math.round(v + (to[k] - v) * p));
}

function usageBar(percent, width = 18, muted = false) {
  if (percent == null) return `[${paint.gray('?'.repeat(width))}]`;
  const ratio = Math.max(0, Math.min(1, percent / 100));
  const full = Math.round(ratio * width);
  let fill = '';
  if (muted) fill = paint.rgb(150, 150, 150, '█'.repeat(full));
  else for (let i = 0; i < full; i++) { const [r, g, b] = gradientColor(i, width); fill += paint.rgb(r, g, b, '█'); }
  return `[${fill}${paint.gray('░'.repeat(width - full))}]`;
}

const pct = v => (v == null ? '-' : `${Math.round(v)}%`);
function fmtNum(n) { n = Number(n) || 0; if (n >= 1e6) return `${(n / 1e6).toFixed(1)}m`; if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`; return String(n); }
function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), mm = m % 60;
  if (h < 24) return mm ? `${h}h${mm}m` : `${h}h`;
  const d = Math.floor(h / 24), hh = h % 24;
  return hh ? `${d}d${hh}h` : `${d}d`;
}

function quotaLine(row, now, muted = false) {
  const resetTs = row.resetsAt ? Date.parse(row.resetsAt) : null;
  let reset = resetTs && resetTs > now ? ` reset ${fmtDur(resetTs - now)}` : '';
  if (row.ended && row.window === 'session') reset = paint.gray(' window ended');
  else if (row.projected) reset = paint.gray(`${reset} (was reset)`);
  const p = row.percent == null ? paint.gray('n/a') : (muted ? paint.dim(pct(row.percent)) : pct(row.percent));
  return `${paint.dim(row.label.padEnd(8))} ${usageBar(row.percent, 18, muted)} ${p}${reset}`;
}

function accountStatus(rows) {
  const ps = rows.map(r => r.percent).filter(p => p != null);
  if (!ps.length) return paint.gray('unknown');
  if (ps.some(p => p >= 100)) return paint.red('exhausted');
  if (rows.some(r => r.severity === 'critical') || ps.some(p => p >= 90)) return paint.yellow('near limit');
  return paint.green('ok');
}

function cardList(state) {
  const others = listAccounts().filter(r => r.email !== state.account.email);
  return [{ email: state.account.email, active: true }, ...others.map(r => ({ email: r.email, active: false, rec: r }))];
}

function render(state, now) {
  const L = [];
  const cards = cardList(state);
  if (state.sel >= cards.length) state.sel = cards.length - 1;
  const cursor = i => (!ONCE && i === state.sel ? paint.cyan('>') : ' ');

  L.push(paint.bold('agent-usage'));
  L.push('');

  // ── active account ──
  const acct = state.account;
  const plan = planLabel(state.cred);
  const u = state.usage;
  const limited = state.error && /429/.test(state.error);
  const stale = u && state.error && state.usageAt ? paint.dim(` (cached ${fmtDur(now - state.usageAt)} ago)`) : '';
  const status = (u ? accountStatus(u.rows) : (limited ? paint.yellow('rate limited') : state.error ? paint.red('error') : paint.gray('probing…'))) + stale;
  L.push(`${cursor(0)} ${paint.green('●')} ${paint.bold(paint.cyan(acct.email || 'unknown'))}${plan ? paint.dim(` (${plan})`) : ''} ${paint.dim('· logged in ·')} ${status}`);
  const tokExp = state.cred.expiresAt ? Date.parse(state.cred.expiresAt) || Number(state.cred.expiresAt) : null;
  if (state.activeRefresh) L.push(`  ${paint.dim('Token'.padEnd(8))} ${paint.yellow(state.activeRefresh)}`);
  else if (tokExp && tokExp <= now) L.push(`  ${paint.dim('Token'.padEnd(8))} ${paint.red('expired — press l to log in')}`);
  if (u) {
    for (const row of projectRows(u.rows, now)) L.push(`  ${quotaLine(row, now)}`);
    const ex = u.extra;
    L.push(`  ${paint.dim('Extra'.padEnd(8))} ${ex.enabled ? `${pct(ex.percent)}${ex.limit != null ? paint.dim(` of ${ex.limit}`) : ''}` : paint.gray('off')}`);
  } else {
    for (const label of ['Session', 'Weekly', 'Fable']) L.push(`  ${quotaLine({ label, percent: null }, now)}`);
  }
  if (!NO_LOCAL) {
    const s = state.local;
    L.push(`  ${paint.dim('Usage'.padEnd(8))} ${s.req} req, ${fmtNum(s.tok)} tok${paint.dim(' (local, 5h window)')}`);
  }
  if (limited) L.push(`  ${paint.dim(`rate limited — retrying in ${fmtDur(Math.max(0, (state.backoffUntil || 0) - now))}`)}`);
  else if (state.error) L.push(`  ${paint.red('probe error:')} ${state.error}`);

  // ── archived accounts ──
  cards.slice(1).forEach((c, k) => {
    const i = k + 1;
    const rec = c.rec;
    const o = state.others.get(c.email) || {};
    const exp = Number(rec.oauth?.expiresAt) || 0;
    const rexp = Number(rec.oauth?.refreshTokenExpiresAt) || 0;
    let src;
    if (o.authDead || (rexp && rexp < now)) src = paint.red('needs login — press l');
    else if (o.live) src = paint.green('live');
    else src = paint.gray(exp > now ? 'last known' : 'last known · token expired');
    const seen = rec.seenAt ? paint.dim(`last seen ${fmtDur(now - rec.seenAt)} ago`) : '';
    const plan2 = planLabel(rec.oauth);
    L.push('');
    L.push(`${cursor(i)} ${paint.gray('○')} ${paint.dim(c.email)}${plan2 ? paint.dim(` (${plan2})`) : ''} ${paint.dim('·')} ${seen} ${paint.dim('·')} ${src}`);
    const nu = rec.usage ? normalize(rec.usage) : null;
    if (nu) {
      for (const row of projectRows(nu.rows, now)) L.push(`  ${quotaLine(row, now, true)}`);
      if (rec.usageAt && !o.live) L.push(`  ${paint.dim('Data'.padEnd(8))} ${paint.dim(`from ${fmtDur(now - rec.usageAt)} ago`)}`);
    } else {
      for (const label of ['Session', 'Weekly', 'Fable']) L.push(`  ${quotaLine({ label, percent: null }, now, true)}`);
    }
    if (o.error && !o.authDead) L.push(`  ${paint.dim(`probe: ${o.error}`)}`);
  });

  if (!ONCE) {
    L.push('');
    if (state.msg && now - state.msgAt < MSG_TTL_MS) L.push(state.msg);
    L.push(paint.dim(`probe every ${fmtDur(INTERVAL_MS)} · ↑↓ select · enter switch · l login · r probe now · q quit`));
  }
  return L.join('\n');
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  if (has('--accounts')) {
    const cur = loadAccount().email;
    const list = listAccounts();
    if (!list.length) { console.log('no archived accounts yet — run agent-usage while logged in and they get archived automatically'); return; }
    const now = Date.now();
    for (const r of list) {
      const exp = Number(r.oauth?.expiresAt) || 0, rexp = Number(r.oauth?.refreshTokenExpiresAt) || 0;
      console.log(`${r.email === cur ? '*' : ' '} ${r.email.padEnd(28)} ${planLabel(r.oauth).padEnd(10)} seen ${fmtDur(now - (r.seenAt || 0)).padEnd(6)} ago  token ${exp > now ? `valid ${fmtDur(exp - now)}` : 'expired'}  refresh ${rexp ? (rexp > now ? `valid ${fmtDur(rexp - now)}` : 'EXPIRED') : '?'}`);
    }
    return;
  }
  if (has('--forget')) {
    const email = opt('--forget'); if (!email) throw new Error('--forget needs an email');
    console.log(forgetAccount(email) ? `forgot ${email}` : `${email}: nothing archived`); return;
  }
  if (has('--switch')) {
    const email = opt('--switch'); if (!email) throw new Error('--switch needs an email');
    const r = switchTo(email);
    console.log(r.already ? `${email} is already the logged-in account` : `switched Claude Code to ${email}${r.running ? ` — ${r.running} running claude session(s) keep their old account until restarted` : ''}`);
    return;
  }

  if (has('--login')) {
    const r = await browserLogin({ onStatus: m => console.error(m) });
    console.log(storeLogin(r, { activate: true }));
    return;
  }

  const cred = loadCredentials();
  const state = {
    cred, account: loadAccount(), usage: null, error: null,
    probing: false, lastProbeAt: null, lastProbeMs: 0, nextProbeAt: null,
    startedAt: Date.now(), local: { req: 0, tok: 0, last: null }, backoffMs: 0,
    others: new Map(), sel: 0, msg: null, msgAt: 0,
  };

  // Refresh the logged-in account's token ourselves only when no `claude`
  // process is running: a refresh rotates the refresh token, and a running
  // session holding the old one would be forced to re-login.
  async function maybeRefreshActive() {
    const now = Date.now();
    const exp = Number(state.cred?.expiresAt) || 0, rexp = Number(state.cred?.refreshTokenExpiresAt) || 0;
    state.activeRefresh = null;
    if (!state.cred?.refreshToken || exp - now >= REFRESH_AHEAD_MS || (rexp && rexp < now)) return;
    if (now - (state.activeRefreshTriedAt || 0) < REFRESH_RETRY_MS) return;
    const running = countClaudeProcs();
    if (running) { state.activeRefresh = `token ${exp <= now ? 'expired' : 'expiring'} — ${running} claude session(s) running, leaving refresh to them`; return; }
    state.activeRefreshTriedAt = now;
    const r = await refreshOauth(state.cred);
    if (r.error) { state.activeRefresh = r.error; return; }
    try { writeCredentials(loadCredentialBlob(), r); state.cred = r; state.activeRefresh = null; }
    catch (e) { state.activeRefresh = `refreshed but could not store: ${e.message.split('\n')[0]}`; }
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
        else if (r.status === 429) { o.backoffMs = Math.max(r.retryAfterMs || 0, Math.min((o.backoffMs || MIN_BACKOFF_MS / 2) * 2, MAX_BACKOFF_MS)); o.backoffUntil = now + o.backoffMs; }
        else o.backoffUntil = now + MIN_BACKOFF_MS;
      } else {
        o.live = true; o.error = null; o.backoffMs = 0; o.backoffUntil = 0;
        archiveUsage(rec.email, r.data, r.fetchedAt);
      }
    } else if (!(exp > now)) o.live = false;
  }

  async function probe(force = false) {
    if (state.probing) return;
    state.probing = true;
    // Re-read credentials/account each probe so a re-login (different account)
    // is picked up without restarting.
    try { state.cred = loadCredentials(); } catch { /* keep last known */ }
    state.account = loadAccount();
    await maybeRefreshActive();
    try { archiveActive(state.cred, state.account); } catch { /* best effort */ }
    const t0 = Date.now();
    // Prefer a fresh shared cache (statusline or another agent-usage may have
    // just fetched). Only hit the network when it is stale or missing.
    const cached = force ? null : readCache(state.account.email);
    let r;
    if (cached && t0 - cached.fetchedAt < CACHE_TTL_MS) r = cached;
    else if (!force && cached && state.backoffMs && t0 < (state.backoffUntil || 0)) r = cached; // still backing off: show stale
    else r = await fetchUsage(state.cred.accessToken, { cacheAs: state.account.email });
    state.lastProbeMs = Date.now() - t0;
    state.lastProbeAt = Date.now();
    state.nextProbeAt = state.lastProbeAt + INTERVAL_MS;
    if (r.error) {
      state.error = r.error;
      if (r.status === 429) {
        state.backoffMs = Math.max(r.retryAfterMs || 0, Math.min((state.backoffMs || MIN_BACKOFF_MS / 2) * 2, MAX_BACKOFF_MS));
        state.backoffUntil = Date.now() + state.backoffMs;
        try { writeFileSync(FAIL_FILE, ''); } catch { /* best effort */ }
      }
      // Fall back to whatever the last good response was (ours, statusline's, or the archive).
      const stale = readCache(state.account.email);
      const arch = state.account.email ? readAccount(state.account.email) : null;
      if (stale) { state.usage = normalize(stale.data); state.usageAt = stale.fetchedAt; }
      else if (arch?.usage) { state.usage = normalize(arch.usage); state.usageAt = arch.usageAt; }
      if (JSON_OUT) { console.error(r.error); process.exit(1); }
    }
    else {
      state.error = null;
      state.backoffMs = 0; state.backoffUntil = 0;
      if (JSON_OUT) { console.log(JSON.stringify(r.data, null, 2)); process.exit(0); }
      state.usage = normalize(r.data);
      state.usageAt = r.fetchedAt;
      if (state.account.email) { try { archiveUsage(state.account.email, r.data, r.fetchedAt); } catch { /* best effort */ } }
    }
    for (const rec of listAccounts()) {
      if (rec.email === state.account.email) continue;
      try { await probeOther(rec, force); } catch (e) { state.others.set(rec.email, { ...(state.others.get(rec.email) || {}), error: e.message }); }
    }
    if (!NO_LOCAL) {
      const resets = state.usage?.sessionResetsAt ? Date.parse(state.usage.sessionResetsAt) : null;
      const windowStart = resets && resets > Date.now() ? resets - FIVE_H : Date.now() - FIVE_H;
      try { scanLocal(windowStart); state.local = localSummary(); } catch { /* best effort */ }
    }
    state.probing = false;
  }

  if (ONCE || JSON_OUT) {
    await probe();
    process.stdout.write(render(state, Date.now()) + '\n');
    process.exit(state.error ? 1 : 0);
  }

  // Live mode.
  const out = process.stdout;
  const altScreen = !!out.isTTY;
  const cleanup = () => { if (altScreen) out.write(`${ESC}?25h${ESC}?1049l`); };
  if (altScreen) out.write(`${ESC}?1049h${ESC}?25l`);
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

  let lastFrame = '';
  const draw = () => {
    const frame = render(state, Date.now());
    if (frame === lastFrame) return;
    lastFrame = frame;
    out.write(`${ESC}H${ESC}2J${frame}\n`);
  };
  const say = (m) => { state.msg = m; state.msgAt = Date.now(); };

  function doSwitch() {
    const cards = cardList(state);
    const c = cards[state.sel];
    if (!c || c.active) { say(paint.dim('already the logged-in account')); return; }
    try {
      const r = switchTo(c.email);
      say(`${paint.green('switched to')} ${paint.cyan(c.email)}${r.running ? paint.yellow(` — ${r.running} running claude session(s) keep the old account until restarted`) : ''}`);
      state.sel = 0;
      state.usage = null; state.usageAt = null; state.error = null; state.backoffMs = 0; state.backoffUntil = 0;
      probe(true).then(draw);
    } catch (e) { say(`${paint.red('switch failed:')} ${e.message.split('\n')[0]}`); }
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
        const activate = !c || c.active || r.account.emailAddress === state.account.email || r.account.emailAddress === c.email;
        say(paint.green(storeLogin(r, { activate })));
        for (const [e, o] of state.others) if (e === r.account.emailAddress) state.others.set(e, { ...o, authDead: false, error: null, refreshError: null, backoffUntil: 0, backoffMs: 0, lastAt: 0 });
        state.sel = 0; state.usage = null; state.usageAt = null; state.error = null; state.backoffMs = 0; state.backoffUntil = 0; state.activeRefreshTriedAt = 0;
        return probe(true);
      })
      .catch(e => say(`${paint.red('login failed:')} ${e.message.split('\n')[0]}`))
      .finally(() => { loggingIn = false; draw(); });
  }

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
    process.stdin.on('data', k => {
      if (k === 'q' || k === '\x03') process.exit(0); // q or Ctrl-C
      else if (k === 'r') probe(true).then(draw);
      else if (k === '\x1b[A' || k === 'k') state.sel = Math.max(0, state.sel - 1);
      else if (k === '\x1b[B' || k === 'j') state.sel = Math.min(cardList(state).length - 1, state.sel + 1);
      else if (k === '\r' || k === '\n') doSwitch();
      else if (k === 'l') doLogin();
      draw();
    });
  }

  const loop = () => probe().then(() => {
    draw();
    const delay = state.backoffMs || INTERVAL_MS;
    setTimeout(loop, delay).unref?.();
  });
  loop();
  draw();
  setInterval(draw, 1000);
}

main().catch(err => { console.error(`agent-usage: ${err.message}`); process.exit(1); });
