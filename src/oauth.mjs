// Token refresh and the browser PKCE login (same client + flow as `claude /login`).
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import {
  AUTHORIZE_URL, LOGIN_PORT, OAUTH_BETA, OAUTH_CLIENT_ID, OAUTH_SCOPES, PROFILE_URL, REFRESH_SCOPES, TOKEN_URL, USER_AGENT,
} from './config.mjs';

// organization_type -> subscriptionType, as Claude Code derives it
// (src/services/oauth/client.ts, "Reuse the logic from fetchSubscriptionType").
const SUBSCRIPTION_BY_ORG_TYPE = { claude_max: 'max', claude_pro: 'pro', claude_enterprise: 'enterprise', claude_team: 'team' };

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': USER_AGENT };
const b64url = b => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// fetch() with a hard timeout; rejects with a readable error.
async function fetchTimeout(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); }
  catch (err) { throw new Error(err?.name === 'AbortError' ? `${new URL(url).host}: timed out after ${timeoutMs / 1000}s` : (err?.message || String(err))); }
  finally { clearTimeout(t); }
}

// Map a /v1/oauth/token response onto the claudeAiOauth blob shape Claude Code stores.
export function tokenResponseToOauth(body, prev = {}) {
  const now = Date.now();
  const out = {
    ...prev,
    accessToken: body.access_token,
    refreshToken: body.refresh_token || prev.refreshToken,
    expiresAt: now + (Number(body.expires_in) || 8 * 3600) * 1000,
    scopes: typeof body.scope === 'string' && body.scope ? body.scope.split(' ') : (prev.scopes || OAUTH_SCOPES),
  };
  if (body.refresh_token_expires_in) out.refreshTokenExpiresAt = now + Number(body.refresh_token_expires_in) * 1000;
  else if (body.refresh_token) delete out.refreshTokenExpiresAt; // rotated: the old expiry no longer applies
  const acct = body.account || {};
  if (acct.subscription_type || body.subscription_type) out.subscriptionType = acct.subscription_type || body.subscription_type;
  if (acct.rate_limit_tier || body.rate_limit_tier) out.rateLimitTier = acct.rate_limit_tier || body.rate_limit_tier;
  return out;
}

// Exchange a refresh token for a new access token (+ rotated refresh token).
// Returns a claudeAiOauth-shaped object, or { error, status, dead }. `dead`
// means the refresh token itself was rejected: only a browser login helps.
export async function refreshOauth(oauth, { timeoutMs = 15_000 } = {}) {
  if (!oauth?.refreshToken) return { error: 'no refresh token', dead: true };
  try {
    const res = await fetchTimeout(TOKEN_URL, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: oauth.refreshToken, client_id: OAUTH_CLIENT_ID, scope: REFRESH_SCOPES.join(' ') }),
    }, timeoutMs);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = body?.error_description || body?.error?.message || body?.error || '';
      const dead = res.status === 400 || res.status === 401 || res.status === 403;
      return { error: `refresh HTTP ${res.status}${detail ? ': ' + detail : ''}`, status: res.status, dead };
    }
    return tokenResponseToOauth(body, oauth);
  } catch (err) { return { error: `refresh: ${err.message}` }; }
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); return true; } catch { return false; }
}

// Wait for the OAuth redirect on localhost and return the authorization code.
function awaitCallback({ redirectUri, stateNonce, buildUrl, onStatus, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let done = false, timer = null;
    const server = createServer((req, res) => {
      const u = new URL(req.url, redirectUri);
      if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
      const err = u.searchParams.get('error');
      const code = u.searchParams.get('code'), st = u.searchParams.get('state');
      const ok = !err && code && st === stateNonce;
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset=utf-8><body style="font:16px system-ui;padding:2em">${ok ? 'agent-usage: login complete, you can close this tab.' : `agent-usage: login failed (${err || 'bad state'}).`}</body>`);
      if (ok) finish(null, code); else finish(new Error(err ? `authorization denied: ${err}` : 'state mismatch in callback'));
    });
    const finish = (err, val) => {
      if (done) return; done = true; clearTimeout(timer);
      server.close(); server.closeAllConnections?.(); // drop the browser's keep-alive socket so the process can exit
      err ? reject(err) : resolve(val);
    };
    timer = setTimeout(() => finish(new Error(`login timed out (${Math.round(timeoutMs / 60_000)} min)`)), timeoutMs);
    server.on('error', e => finish(new Error(e.code === 'EADDRINUSE' ? `port ${LOGIN_PORT} busy (another login running?)` : e.message)));
    server.listen(LOGIN_PORT, '127.0.0.1', () => {
      const url = buildUrl();
      onStatus(openBrowser(url) ? 'browser opened — finish login there' : `open this URL to log in: ${url}`);
    });
  });
}

// Identity for the archive / .claude.json, in Claude Code's oauthAccount shape.
async function fetchProfile(accessToken) {
  const res = await fetchTimeout(PROFILE_URL, { headers: { Authorization: `Bearer ${accessToken}`, 'anthropic-beta': OAUTH_BETA, Accept: 'application/json', 'User-Agent': USER_AGENT } }, 15_000);
  const prof = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`profile HTTP ${res.status}`);
  const a = prof.account || {}, org = prof.organization || {};
  const email = a.email || a.email_address; // src/services/oauth/client.ts reads `account.email`
  if (!email) throw new Error('profile response had no email');
  // Claude Code's AccountInfo shape (src/utils/config.ts). organizationRole /
  // workspaceRole come from a separate roles endpoint and are left unset.
  const account = {
    accountUuid: a.uuid, emailAddress: email, organizationUuid: org.uuid, organizationName: org.name,
    displayName: a.display_name || a.full_name || undefined, hasExtraUsageEnabled: org.has_extra_usage_enabled ?? a.has_extra_usage_enabled ?? undefined,
    billingType: org.billing_type || undefined, accountCreatedAt: a.created_at || undefined, subscriptionCreatedAt: org.subscription_created_at || undefined,
  };
  for (const k of Object.keys(account)) if (account[k] === undefined) delete account[k];
  return { account, profile: prof, subscriptionType: SUBSCRIPTION_BY_ORG_TYPE[org.organization_type] || null, rateLimitTier: org.rate_limit_tier || a.rate_limit_tier };
}

// Runs the whole flow: local callback listener -> browser -> code exchange ->
// profile lookup. Resolves { oauth, account, profile }. `onStatus(msg)`
// receives progress lines. Rejects on failure/timeout.
export async function browserLogin({ onStatus = () => {}, timeoutMs = 5 * 60_000 } = {}) {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const stateNonce = b64url(randomBytes(32));
  const redirectUri = `http://localhost:${LOGIN_PORT}/callback`;

  const buildUrl = () => {
    const url = new URL(AUTHORIZE_URL);
    for (const [k, v] of Object.entries({
      code: 'true', client_id: OAUTH_CLIENT_ID, response_type: 'code', redirect_uri: redirectUri,
      scope: OAUTH_SCOPES.join(' '), code_challenge: challenge, code_challenge_method: 'S256', state: stateNonce,
    })) url.searchParams.set(k, v);
    return url.toString();
  };
  const code = await awaitCallback({ redirectUri, stateNonce, buildUrl, onStatus, timeoutMs });

  onStatus('exchanging code…');
  const res = await fetchTimeout(TOKEN_URL, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ grant_type: 'authorization_code', code, state: stateNonce, redirect_uri: redirectUri, client_id: OAUTH_CLIENT_ID, code_verifier: verifier }),
  }, 15_000);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`token exchange HTTP ${res.status}: ${body?.error_description || body?.error?.message || body?.error || ''}`);
  const oauth = tokenResponseToOauth(body, {});

  const { account, profile, subscriptionType, rateLimitTier } = await fetchProfile(oauth.accessToken);
  if (!oauth.subscriptionType && subscriptionType) oauth.subscriptionType = subscriptionType;
  if (!oauth.rateLimitTier && rateLimitTier) oauth.rateLimitTier = rateLimitTier;
  return { oauth, account, profile };
}
