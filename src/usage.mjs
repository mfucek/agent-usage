// The zero-spend usage endpoint, the shared on-disk cache, and response normalisation.
import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { CACHE_FILE, FAIL_FILE, OAUTH_BETA, USAGE_URL, USER_AGENT, WEEK_MS } from './config.mjs';

const num = v => (v == null || Number.isNaN(Number(v)) ? null : Number(v));

export async function fetchUsage(accessToken, { cacheAs = null, timeoutMs = 10_000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, 'anthropic-beta': OAUTH_BETA, Accept: 'application/json', 'User-Agent': USER_AGENT },
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
  rows.push(bucket('Fable', fable, { dedicated: true }) || { label: 'Fable', percent: null, resetsAt: null, severity: null, dedicated: true });

  for (const l of scoped) if (l !== fable) rows.push(bucket(scopedName(l), l));
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
export function projectRows(rows, now) {
  return rows.map(r => {
    const t = r.resetsAt ? Date.parse(r.resetsAt) : null;
    if (!t || t > now) return r;
    if (r.window === 'session') return { ...r, percent: r.percent == null ? null : 0, resetsAt: null, ended: true };
    let n = t; while (n <= now) n += WEEK_MS;
    return { ...r, percent: r.percent == null ? null : 0, resetsAt: new Date(n).toISOString(), ended: true, projected: true };
  });
}

// Worst-bucket summary for the card header.
export function accountStatus(rows) {
  const ps = rows.map(r => r.percent).filter(p => p != null);
  if (!ps.length) return 'unknown';
  if (ps.some(p => p >= 100)) return 'exhausted';
  if (rows.some(r => r.severity === 'critical') || ps.some(p => p >= 90)) return 'near limit';
  return 'ok';
}
