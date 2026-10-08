// The zero-spend usage endpoint, the shared on-disk cache, and response normalisation.
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE_FILE, CLI_HEADERS, FAIL_FILE, LIVE_DIR, LIVE_MAX_AGE_MS, OAUTH_BETA, RESET_PROGRAM, USAGE_QUERY, USAGE_URL, WEEK_MS, resetUrl } from './config.mjs';

const num = v => (v == null || Number.isNaN(Number(v)) ? null : Number(v));

export async function fetchUsage(accessToken, { cacheAs = null, timeoutMs = 10_000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // Asked with Claude Code's own headers so the response carries the banked
    // reset block (see USAGE_QUERY / CLI_HEADERS); everything else is unchanged.
    const res = await fetch(USAGE_URL + USAGE_QUERY, {
      headers: { Authorization: `Bearer ${accessToken}`, 'anthropic-beta': OAUTH_BETA, Accept: 'application/json', ...CLI_HEADERS },
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

export function readCache(email) {
  try {
    const st = statSync(CACHE_FILE);
    const data = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    if (data?._account && data._account !== email) return null; // another account's numbers (or nobody logged in)
    if (data?.five_hour || data?.limits) return { data, fetchedAt: st.mtimeMs };
  } catch { /* no cache */ }
  return null;
}
export function writeCache(data) {
  try { const tmp = `${CACHE_FILE}.${process.pid}`; writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 }); renameSync(tmp, CACHE_FILE); } catch { /* best effort */ }
  try { unlinkSync(FAIL_FILE); } catch { /* none */ }
}
export function markFail() { try { writeFileSync(FAIL_FILE, ''); } catch { /* best effort */ } }

// Normalise the response into rows: Session, Weekly, Fable (always), plus any
// other scoped weekly buckets (Sonnet, Opus, ...) the plan exposes.
export function normalize(data) {
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
  rows.push(bucket('Fable', fable, { dedicated: true, scoped: true }) || { label: 'Fable', percent: null, resetsAt: null, severity: null, dedicated: true, scoped: true });

  for (const l of scoped) if (l !== fable) rows.push(bucket(scopedName(l), l, { scoped: true }));
  if (data?.seven_day_sonnet && !rows.some(r => r.label === 'Sonnet')) rows.push(bucket('Sonnet', data.seven_day_sonnet, { scoped: true }));
  if (data?.seven_day_opus && !rows.some(r => r.label === 'Opus')) rows.push(bucket('Opus', data.seven_day_opus, { scoped: true }));

  const extra = data?.extra_usage || {};
  return {
    rows,
    extra: { enabled: !!extra.is_enabled, percent: num(extra.utilization), used: extra.used_credits, limit: extra.monthly_limit },
    sessionResetsAt: session?.resetsAt || null,
    resets: normalizeResets(data?.cedar_ember),
  };
}

// ─── Banked resets ───────────────────────────────────────────────────────────
// The `cedar_ember` block: grants the account has banked, each with a number
// of resets left, a use-by date and the buckets it clears. `null` when the
// response was fetched without the block (old cache / other tool).
const CLEARS_LABEL = { five_hour: 'session', seven_day: 'weekly', seven_day_overage_included: 'extra', seven_day_opus: 'opus', seven_day_sonnet: 'sonnet' };
export function normalizeResets(ce) {
  if (!ce || typeof ce !== 'object') return null;
  const grants = (Array.isArray(ce.grants) ? ce.grants : []).map(g => ({
    id: String(g.id || ''),
    label: g.label || '',
    left: Math.max(0, Number(g.resets_left) || 0),
    total: Math.max(0, Number(g.resets_total) || 0),
    startsAt: g.starts_at || null,
    endsAt: g.ends_at || null,
    usableNow: !!g.usable_now,
    paused: !!g.paused,
    atLimitOnly: g.use_requires_limit !== false,
    clears: (Array.isArray(g.clears) ? g.clears : []).map(c => CLEARS_LABEL[c] || c),
  })).filter(g => g.id);
  return {
    eligible: !!ce.eligible,
    reason: ce.ineligible_reason || null,
    atLimit: !!ce.at_limit,
    grants,
    nextGrantId: ce.next_grant_id || null,
    cooldownUntil: ce.cooldown_until || null,
    weeklyResetsAt: ce.weekly_resets_at || null,
  };
}

// The grant a `u` press would spend: the server's pick when it is still
// usable, else the first usable one. `now` ages out expired grants.
export function usableGrant(resets, now = Date.now()) {
  if (!resets) return null;
  const ok = g => g.left > 0 && !g.paused && g.usableNow && !(g.endsAt && Date.parse(g.endsAt) <= now) && !(g.startsAt && Date.parse(g.startsAt) > now);
  const live = resets.grants.filter(ok);
  return live.find(g => g.id === resets.nextGrantId) || live[0] || null;
}
export const bankedCount = (resets, now = Date.now()) => (resets ? resets.grants.filter(g => g.left > 0 && !(g.endsAt && Date.parse(g.endsAt) <= now)).reduce((n, g) => n + g.left, 0) : 0);

// Spend one reset: the same POST Claude Code's /limit-reset sends. Returns
// { result, resetsLeft, cleared, cooldownUntil } — `result` is the server's word
// (reset | already_used | not_limited | cooldown | ineligible | unavailable) —
// or { error }.
export async function claimReset(accessToken, orgUuid, grantId, { timeoutMs = 25_000 } = {}) {
  if (!orgUuid) return { error: 'no organization uuid for this account — log in again (l)' };
  if (!/^[a-z0-9_-]{1,40}$/.test(grantId || '')) return { error: 'no usable grant' };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(resetUrl(orgUuid), {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'anthropic-beta': OAUTH_BETA, Accept: 'application/json', 'Content-Type': 'application/json', ...CLI_HEADERS },
      body: JSON.stringify({ program: RESET_PROGRAM, grant_id: grantId, request_id: randomUUID() }),
      signal: ctrl.signal,
    });
    let body = {}; try { body = await res.json(); } catch { /* no body */ }
    if (!res.ok) return { error: `HTTP ${res.status}${body?.error?.message ? ': ' + body.error.message : ''}`, status: res.status };
    return {
      result: body.result || 'unavailable',
      reason: body.reason || null,
      resetsLeft: body.resets_left ?? null,
      cleared: (Array.isArray(body.cleared) ? body.cleared : []).map(c => CLEARS_LABEL[c] || c),
      cooldownUntil: body.cooldown_until || null,
    };
  } catch (err) {
    return { error: err?.name === 'AbortError' ? 'claim timed out' : (err?.message || String(err)) };
  } finally { clearTimeout(t); }
}

// Fold the statusline's live numbers (see LIVE_DIR) into the Session and
// Weekly rows. They carry no account, so the weekly reset fingerprints it: a
// file counts only when its 7d window resets within an hour of this account's.
// Usage only grows within a window, so the latest window's highest figure is
// the newest. Files written before `since` (a reset claim) are ignored.
const SAME_WINDOW_MS = 10 * 60_000;
export function mergeLive(usage, now = Date.now(), since = 0, dir = LIVE_DIR) {
  const weekly = usage && projectRows(usage.rows, now).find(r => r.label === 'Weekly');
  const wk = weekly?.resetsAt ? Date.parse(weekly.resetsAt) : 0;
  if (!wk) return usage;
  const live = [];
  let files = [];
  try { files = readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return usage; }
  for (const f of files) {
    try {
      const p = join(dir, f), mt = statSync(p).mtimeMs;
      if (now - mt > LIVE_MAX_AGE_MS || mt < since) continue;
      const j = JSON.parse(readFileSync(p, 'utf8'));
      if (Math.abs(Number(j?.seven_day?.resets_at) * 1000 - wk) <= 3600_000) live.push(j);
    } catch { /* half-written or gone */ }
  }
  if (!live.length) return usage;
  const merge = (row, key) => {
    const c = live.map(j => j[key]).filter(b => b && Number.isFinite(Number(b.used_percentage)) && Number(b.resets_at) > 0)
      .map(b => ({ percent: Number(b.used_percentage), t: Number(b.resets_at) * 1000 }));
    if (!c.length) return row;
    if (row?.percent != null && row.resetsAt) c.push({ percent: row.percent, t: Date.parse(row.resetsAt), own: true });
    const latest = Math.max(...c.map(x => x.t));
    const win = c.filter(x => x.t >= latest - SAME_WINDOW_MS);
    const percent = Math.max(...win.map(x => x.percent));
    const resetsAt = win.some(x => x.own) ? row.resetsAt : new Date(latest).toISOString();
    return row ? (row.percent === percent && row.resetsAt === resetsAt ? row : { ...row, percent, resetsAt }) : null;
  };
  const rows = usage.rows.map(r => r.window === 'session' ? merge(r, 'five_hour') : r.label === 'Weekly' ? merge(r, 'seven_day') : r);
  return rows.every((r, i) => r === usage.rows[i]) ? usage : { ...usage, rows, sessionResetsAt: rows.find(r => r.window === 'session')?.resetsAt || null };
}

// Age stale rows: once a bucket's reset moment has passed, its bar is empty.
// Weekly buckets recur on a fixed 7-day schedule, so the countdown rolls
// forward; a 5h session window simply ends (a new one starts on first use).
export function projectRows(rows, now) {
  return rows.map(r => {
    const t = r.resetsAt ? Date.parse(r.resetsAt) : null;
    if (!t || t > now) return r;
    if (r.window === 'session') return { ...r, percent: r.percent == null ? null : 0, resetsAt: null, ended: true };
    let n = t; while (n <= now) n += WEEK_MS;
    return { ...r, percent: r.percent == null ? null : 0, resetsAt: new Date(n).toISOString(), ended: true, projected: true };
  });
}

// Card-header summary from the account-wide buckets only. A model-scoped
// bucket (Fable, Sonnet…) at 100% locks that model, not the account; its own
// row says so.
export function accountStatus(allRows) {
  const rows = allRows.filter(r => !r.scoped);
  const ps = rows.map(r => r.percent).filter(p => p != null);
  if (!ps.length) return 'unknown';
  if (ps.some(p => p >= 100)) return 'exhausted';
  if (rows.some(r => r.severity === 'critical') || ps.some(p => p >= 90)) return 'near limit';
  return 'ok';
}
