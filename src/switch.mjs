// Making an archived (or freshly logged-in) account the logged-in one.
import { unlinkSync } from 'node:fs';
import { CACHE_FILE, CLAUDE_TOKEN_CACHE_MS, FAIL_FILE } from './config.mjs';
import { archiveActive, logActiveAccount, readAccount, saveAccount } from './archive.mjs';
import { loadAccount, loadCredentialBlob, writeCredentials, writeOauthAccount } from './credentials.mjs';
import { countClaudeProcs } from './local.mjs';

export const HANDOVER_NOTE = `pick it up on their next request (≤${CLAUDE_TOKEN_CACHE_MS / 1000}s)`;
const sameEmail = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

function dropSharedCache() {
  for (const f of [CACHE_FILE, FAIL_FILE]) { try { unlinkSync(f); } catch { /* none */ } }
}

// Returns { already, running }. Throws when the archive cannot be used.
export function switchTo(email) {
  const rec = readAccount(email);
  if (!rec?.oauth?.accessToken) throw new Error(`no archived tokens for ${email} — log in once with \`claude /login\` while agent-usage runs`);
  const rexp = Number(rec.oauth.refreshTokenExpiresAt) || 0;
  if (rexp && rexp < Date.now()) throw new Error(`${email}: refresh token expired — run \`claude /login\` as that account`);

  // Make sure whoever is logged in right now is archived before we overwrite them.
  const blob = loadCredentialBlob();
  const cur = loadAccount();
  if (blob.json?.claudeAiOauth?.accessToken && cur.email) archiveActive(blob.json.claudeAiOauth, cur);
  const running = countClaudeProcs();
  if (sameEmail(cur.email, email)) return { already: true, running };

  writeCredentials(blob, rec.oauth);
  if (rec.oauthAccount) writeOauthAccount(rec.oauthAccount);
  dropSharedCache();
  logActiveAccount(rec.email);
  return { already: false, running };
}

// Store a fresh login: always archive; make it the logged-in account when
// `activate` (or when nobody is logged in). Returns a summary string.
export function storeLogin({ oauth, account }, { activate }) {
  const email = account.emailAddress;
  const rec = readAccount(email) || { email };
  rec.oauth = oauth; rec.oauthAccount = { ...(rec.oauthAccount || {}), ...account }; rec.savedAt = Date.now();
  saveAccount(rec);
  const blob = loadCredentialBlob();
  const cur = loadAccount();
  const nobody = !blob.json?.claudeAiOauth?.accessToken || !cur.email;
  if (!activate && !nobody && !sameEmail(cur.email, email)) return `logged in as ${email} (archived; enter to switch)`;
  if (!nobody && cur.email && !sameEmail(cur.email, email)) archiveActive(blob.json.claudeAiOauth, cur);
  rec.seenAt = Date.now(); saveAccount(rec); // becomes the logged-in account now
  writeCredentials(blob, oauth);
  writeOauthAccount(rec.oauthAccount);
  dropSharedCache();
  logActiveAccount(email);
  const running = countClaudeProcs();
  return `logged in as ${email}${running ? ` — ${running} running claude session(s) ${HANDOVER_NOTE}` : ''}`;
}
