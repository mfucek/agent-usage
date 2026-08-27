// Claude Code's credential store (macOS keychain or .credentials.json) and the
// `oauthAccount` identity in .claude.json.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { CLAUDE_JSON, CLAUDE_JSON_LOCK, CRED_FILE, KEYCHAIN_SERVICE } from './config.mjs';
import { withLock } from './lock.mjs';

const quiet = { stdio: ['ignore', 'pipe', 'ignore'] };
// Claude Code always filters the keychain item by account name (getUsername()).
const username = () => { try { return process.env.USER || userInfo().username; } catch { return 'claude'; } };

// Set when Claude Code sessions are pinned to a token by the environment: the
// keychain is ignored by them, so a switch would not affect those sessions.
export const ENV_TOKEN_OVERRIDE = !!(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR);

// The keychain item holds one JSON blob: { claudeAiOauth: {...}, mcpOAuth: {...} }.
// Only claudeAiOauth is account-specific; mcpOAuth (Figma, Cloudflare, ...) is
// shared and must survive a switch. Claude Code reads keychain first and only
// falls back to the file when the keychain has nothing, so we write back to
// whichever store the blob actually came from.
export function loadCredentialBlob() {
  let raw = null, fromKeychain = false;
  const acct = username();
  if (process.platform === 'darwin') {
    try {
      raw = execFileSync('security', ['find-generic-password', '-a', acct, '-s', KEYCHAIN_SERVICE, '-w'], quiet).toString().trim();
      fromKeychain = !!raw;
    } catch { /* fall through to the file */ }
  }
  if (!raw && existsSync(CRED_FILE)) raw = readFileSync(CRED_FILE, 'utf8');
  let json = null;
  if (raw) { try { json = JSON.parse(raw); } catch { json = null; } }
  return { json, acct, fromKeychain };
}

export function loadCredentials() {
  const { json } = loadCredentialBlob();
  if (!json) throw new Error(`no Claude Code credentials found (keychain or ${CRED_FILE}). Log in with \`claude\` first.`);
  const o = json.claudeAiOauth;
  if (!o?.accessToken) throw new Error('credentials found but no claudeAiOauth.accessToken. Log in with `claude` first.');
  return o;
}

export function loadAccount() {
  try {
    const a = JSON.parse(readFileSync(CLAUDE_JSON, 'utf8'))?.oauthAccount || {};
    return { email: a.emailAddress || null, raw: a };
  } catch { return { email: null, raw: null }; }
}

export function planLabel(oauth) {
  const tier = (oauth?.rateLimitTier || '').replace(/^default_claude_/, '').replace('_', ' ');
  const sub = oauth?.subscriptionType || '';
  return tier.startsWith(sub) ? tier : [sub, tier].filter(Boolean).join(' ');
}

function writeKeychain(acct, value) {
  // `security -i` (stdin) silently truncates lines at 4 KiB and the blob is
  // ~10-15 KiB, so the value has to go via argv (same as Claude Code does).
  execFileSync('security', ['add-generic-password', '-a', acct, '-s', KEYCHAIN_SERVICE, '-U', '-w', value], { stdio: ['ignore', 'ignore', 'pipe'] });
  const back = execFileSync('security', ['find-generic-password', '-a', acct, '-s', KEYCHAIN_SERVICE, '-w'], quiet).toString().trim();
  if (back !== value) throw new Error('keychain write did not round-trip');
}

function atomicWrite(path, text, mode) {
  const tmp = `${path}.${process.pid}`;
  writeFileSync(tmp, text, mode ? { mode } : undefined);
  renameSync(tmp, path);
}

// Fields Claude Code itself persists in claudeAiOauth (src/utils/auth.ts
// saveOAuthTokensIfNeeded). Anything else we put in the blob is dropped on its
// next refresh, so extras like refreshTokenExpiresAt live in the archive only.
const BLOB_FIELDS = ['accessToken', 'refreshToken', 'expiresAt', 'scopes', 'subscriptionType', 'rateLimitTier'];
export const blobOauth = oauth => Object.fromEntries(BLOB_FIELDS.filter(k => oauth?.[k] !== undefined).map(k => [k, oauth[k]]));

// Replace claudeAiOauth in the credential store, keeping everything else in
// the blob (mcpOAuth ...).
export function writeCredentials(blob, oauth) {
  const serialized = JSON.stringify({ ...(blob.json || {}), claudeAiOauth: blobOauth(oauth) });
  if (process.platform === 'darwin' && (blob.fromKeychain || !existsSync(CRED_FILE))) writeKeychain(blob.acct, serialized);
  else atomicWrite(CRED_FILE, serialized, 0o600);
}

// Read-modify-write under Claude Code's own lock, so a running session's
// concurrent write to .claude.json (it writes often) is not lost.
export function writeOauthAccount(oauthAccount) {
  withLock(CLAUDE_JSON_LOCK, () => {
    let cj = {}; try { cj = JSON.parse(readFileSync(CLAUDE_JSON, 'utf8')); } catch { /* fresh file */ }
    cj.oauthAccount = oauthAccount;
    atomicWrite(CLAUDE_JSON, JSON.stringify(cj, null, 2));
  });
}
