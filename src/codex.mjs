// Codex (ChatGPT) usage and banked resets. auth.json is never written — the
// Codex CLI refreshes its own token; we read it to poll usage or spend a reset.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CODEX_AUTH_FILE, CODEX_RESET_CONSUME_URL, CODEX_RESET_CREDITS_URL, CODEX_USAGE_URL } from './config.mjs';
import { fmtDur } from './format.mjs';

const num = v => (v == null || Number.isNaN(Number(v)) ? null : Number(v));
const jwtClaims = tok => { try { return JSON.parse(Buffer.from(String(tok).split('.')[1], 'base64url').toString()); } catch { return {}; } };

const PLAN = { prolite: 'pro lite', plus: 'plus', pro: 'pro', free: 'free', team: 'team', business: 'business', enterprise: 'enterprise', edu: 'edu' };
export const codexPlanLabel = p => (p ? PLAN[p] || p : '');

export function loadCodexAuth() {
  let j; try { j = JSON.parse(readFileSync(CODEX_AUTH_FILE, 'utf8')); } catch { return null; }
  const t = j?.tokens;
  if (!t?.access_token) return null; // API-key-only auth has no usage endpoint
  const claims = jwtClaims(t.access_token);
  const auth = claims['https://api.openai.com/auth'] || {};
  return {
    accessToken: t.access_token,
    accountId: t.account_id || auth.chatgpt_account_id || '',
    email: jwtClaims(t.id_token).email || '',
    plan: auth.chatgpt_plan_type || '',
    expiresAt: (Number(claims.exp) || 0) * 1000,
  };
}

async function codexFetch(auth, url, { method = 'GET', body = null, timeoutMs = 10_000, retryChallenge = true } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res;
    for (let attempt = 0; ; attempt++) {
      res = await fetch(url, {
        method,
        // Cloudflare on chatgpt.com challenges any UA containing "name/version";
        // a bare word passes. Do not add the version here. It also challenges
        // intermittently (~first request on a fresh connection), so one retry.
        headers: {
          Authorization: `Bearer ${auth.accessToken}`, 'chatgpt-account-id': auth.accountId, Accept: 'application/json', 'User-Agent': 'agent-usage',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      if (retryChallenge && attempt === 0 && res.headers.get('cf-mitigated') === 'challenge') continue;
      break;
    }
    if (!res.ok) {
      let detail = '';
      try { const b = await res.json(); detail = b?.detail || b?.error?.message || JSON.stringify(b).slice(0, 120); } catch { /* ignore */ }
      const ra = Number(res.headers.get('retry-after')) || 0;
      return { error: `HTTP ${res.status}${detail ? ': ' + detail : ''}`, status: res.status, retryAfterMs: ra * 1000 };
    }
    return { data: await res.json(), fetchedAt: Date.now() };
  } catch (err) {
    return { error: err?.name === 'AbortError' ? 'probe timed out' : (err?.message || String(err)) };
  } finally { clearTimeout(t); }
}

export const fetchCodexUsage = (auth, o) => codexFetch(auth, CODEX_USAGE_URL, o);

// ─── Banked reset credits ────────────────────────────────────────────────────
// GET returns { credits: [{ id, status, expires_at, redeemed_at, title, ... }],
// available_count }. `/codex/usage` only carries the count
// (rate_limit_reset_credits.available_count), so the list is a second call.
export const fetchCodexResetCredits = (auth, o) => codexFetch(auth, CODEX_RESET_CREDITS_URL, o);

// Same shape as the Claude side's `resets` so render/app treat both alike:
// grants of one reset each, soonest-expiring first.
export function normalizeCodexCredits(data, now = Date.now()) {
  if (!data || typeof data !== 'object') return null;
  const grants = (Array.isArray(data.credits) ? data.credits : [])
    .filter(c => c?.id && c.status === 'available' && c.is_supported_by_plan !== false)
    .map(c => ({
      id: String(c.id), label: c.title || 'reset', left: 1, total: 1,
      startsAt: c.granted_at || null, endsAt: c.expires_at || null,
      usableNow: !c.redeem_started_at, paused: false, atLimitOnly: false, clears: ['all windows'],
    }))
    .filter(g => !(g.endsAt && Date.parse(g.endsAt) <= now))
    .sort((a, b) => (a.endsAt ? Date.parse(a.endsAt) : Infinity) - (b.endsAt ? Date.parse(b.endsAt) : Infinity));
  return { eligible: true, reason: null, atLimit: false, grants, nextGrantId: grants[0]?.id || null, cooldownUntil: null, weeklyResetsAt: null };
}

// Spend one credit: POST { credit_id, redeem_request_id }. The server answers
// 200 even when nothing happened: { code: "no_credit" | ..., credit, windows_reset }.
// A bogus id yields code "no_credit" and windows_reset 0 (verified), so
// `windows_reset > 0` is the success signal, `code` the server's word.
export async function consumeCodexResetCredit(auth, creditId, o = {}) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(creditId || '')) return { error: 'no usable credit' };
  const { requestId = randomUUID(), ...fetchOptions } = o;
  const r = await codexFetch(auth, CODEX_RESET_CONSUME_URL, { ...fetchOptions, method: 'POST', body: { credit_id: creditId, redeem_request_id: requestId }, timeoutMs: 25_000 });
  if (r.error) return r;
  const d = r.data || {};
  return { code: d.code || 'unknown', windowsReset: Number(d.windows_reset) || 0, credit: d.credit || null };
}

// Normalise into the same row shape as the Claude side, so quotaLine /
// projectRows / accountStatus apply unchanged. A window ≤6h behaves like a
// Claude session (starts on first use, simply ends); a ~7d window recurs.
const SIX_H = 6 * 3600;
const windowLabel = secs => (!secs ? 'Usage' : secs <= SIX_H ? 'Session' : secs >= 6 * 24 * 3600 ? 'Weekly' : fmtDur(secs * 1000));
const shortName = s => String(s || '').split('-').pop() || 'Extra';

function row(label, w) {
  if (!w) return null;
  const secs = Number(w.limit_window_seconds) || 0;
  return {
    label,
    percent: num(w.used_percent),
    resetsAt: w.reset_at ? new Date(w.reset_at * 1000).toISOString() : null,
    severity: null,
    ...(secs && secs <= SIX_H ? { window: 'session' } : {}),
  };
}

export function normalizeCodex(data) {
  const rows = [];
  const rl = data?.rate_limit || {};
  const p = row(windowLabel(rl.primary_window?.limit_window_seconds), rl.primary_window);
  const s = row(windowLabel(rl.secondary_window?.limit_window_seconds), rl.secondary_window);
  if (p) rows.push(p);
  if (s) rows.push(s);
  // additional_rate_limits (separately-metered models like Spark) are
  // deliberately not shown — unused rows, they'd only add noise to the card.
  return { rows };
}

// Interactive codex processes; the shared daemon and server modes don't count.
const CODEX_WORD = /(^|\/)codex$/;
const CODEX_DAEMON = new Set(['app-server', 'mcp-server', 'exec-server', 'remote-control']);
export function countCodexProcs() {
  try {
    const out = execFileSync('ps', ['-Ao', 'args='], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    let n = 0;
    for (const line of out.split('\n')) {
      const [a0 = '', a1 = ''] = line.trim().split(/\s+/);
      if (CODEX_WORD.test(a0) && !CODEX_DAEMON.has(a1)) n++;
    }
    return n;
  } catch { return 0; }
}
