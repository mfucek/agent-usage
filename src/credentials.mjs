// Claude Code's credential store (macOS keychain or .credentials.json) and the
// `oauthAccount` identity in .claude.json.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { CLAUDE_JSON, CRED_FILE, KEYCHAIN_SERVICE } from './config.mjs';

const quiet = { stdio: ['ignore', 'pipe', 'ignore'] };

// The keychain item holds one JSON blob: { claudeAiOauth: {...}, mcpOAuth: {...} }.
// Only claudeAiOauth is account-specific; mcpOAuth (Figma, Cloudflare, ...) is
// shared and must survive a switch.
export function loadCredentialBlob() {
  let raw = null, acct = process.env.USER || 'claude';
  if (process.platform === 'darwin') {
    try {
      raw = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], quiet).toString().trim();
      const meta = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE], quiet).toString();
      const m = meta.match(/"acct"<blob>="([^"]*)"/); if (m) acct = m[1];
    } catch { /* fall through to the file */ }
  }
  if (!raw && existsSync(CRED_FILE)) raw = readFileSync(CRED_FILE, 'utf8');
  let json = null;
  if (raw) { try { json = JSON.parse(raw); } catch { json = null; } }
  return { json, acct, fromKeychain: !!raw && process.platform === 'darwin' && !existsSync(CRED_FILE) };
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
    return { email: a.emailAddress || null, org: a.organizationName || null, type: a.organizationType || null, raw: a };
  } catch { return { email: null, org: null, type: null, raw: null }; }
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
  const back = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], quiet).toString().trim();
  if (back !== value) throw new Error('keychain write did not round-trip');
}

function atomicWrite(path, text, mode) {
  const tmp = `${path}.${process.pid}`;
  writeFileSync(tmp, text, mode ? { mode } : undefined);
  renameSync(tmp, path);
}

// Replace claudeAiOauth in the credential store, keeping everything else in
// the blob (mcpOAuth ...).
export function writeCredentials(blob, oauth) {
  const serialized = JSON.stringify({ ...(blob.json || {}), claudeAiOauth: oauth });
  if (process.platform === 'darwin' && (blob.fromKeychain || !existsSync(CRED_FILE))) writeKeychain(blob.acct, serialized);
  else atomicWrite(CRED_FILE, serialized, 0o600);
}

export function writeOauthAccount(oauthAccount) {
  let cj = {}; try { cj = JSON.parse(readFileSync(CLAUDE_JSON, 'utf8')); } catch { /* fresh file */ }
  cj.oauthAccount = oauthAccount;
  atomicWrite(CLAUDE_JSON, JSON.stringify(cj, null, 2));
}
