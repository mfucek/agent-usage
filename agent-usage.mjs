#!/usr/bin/env node
// agent-usage — live Claude (Max/Pro OAuth) quota in the terminal.
//
// Reads the Claude Code OAuth token from the macOS keychain, polls the
// zero-spend usage endpoint (`/api/oauth/usage`) and renders a teamclaude-style
// status panel. Local transcripts (~/.claude/projects) are scanned incrementally
// to show requests/tokens in the current 5h session window.
//
// Zero dependencies. Node >= 18 (or bun).

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { unlinkSync } from 'node:fs';
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
  --json           print raw usage JSON and exit
  --no-local       skip local transcript scan (Usage row)
  --no-color       disable ANSI colors

live keys: r = probe now, q = quit`);
  process.exit(0);
}

const ONCE = has('-1') || has('--once');
const JSON_OUT = has('--json');
const NO_LOCAL = has('--no-local');
const INTERVAL_MS = Math.max(30, Number(opt('-i', opt('--interval', 60))) || 60) * 1000;
const COLOR = !has('--no-color') && !!process.stdout.isTTY && !process.env.NO_COLOR;

const HOME = homedir();
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const CRED_FILE = join(HOME, '.claude', '.credentials.json');
const CLAUDE_JSON = join(HOME, '.claude.json');
const PROJECTS_DIR = join(HOME, '.claude', 'projects');
// Shared with ~/.claude/statusline-command.sh: whoever fetched last writes here,
// everyone else reads. One request per CACHE_TTL across all tools/sessions —
// the endpoint is aggressively rate limited (429, retry-after: 0) and a 429
// never clears while anything keeps polling.
const CACHE_FILE = '/tmp/.claude-usage-cache';
const FAIL_FILE = `${CACHE_FILE}.fail`; // statusline's negative-cache stamp
const CACHE_TTL_MS = 120_000;
const MIN_BACKOFF_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;
const FIVE_H = 5 * 3600 * 1000;

// ─── Credentials ────────────────────────────────────────────────────────────
function loadCredentials() {
  let raw = null;
  if (process.platform === 'darwin') {
    try {
      raw = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch { /* fall through */ }
  }
  if (!raw && existsSync(CRED_FILE)) raw = readFileSync(CRED_FILE, 'utf8');
  if (!raw) throw new Error('no Claude Code credentials found (keychain or ~/.claude/.credentials.json). Log in with `claude` first.');
  const o = JSON.parse(raw)?.claudeAiOauth;
  if (!o?.accessToken) throw new Error('credentials found but no claudeAiOauth.accessToken. Log in with `claude` first.');
  return o;
}

function loadAccount() {
  try {
    const a = JSON.parse(readFileSync(CLAUDE_JSON, 'utf8'))?.oauthAccount || {};
    return { email: a.emailAddress || null, org: a.organizationName || null, type: a.organizationType || null };
  } catch { return { email: null, org: null, type: null }; }
}

// ─── Probe ──────────────────────────────────────────────────────────────────
async function fetchUsage(accessToken, timeoutMs = 10_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        Accept: 'application/json',
        'User-Agent': 'agent-usage/1.0',
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
    writeCache(data);
    return { data, fetchedAt: Date.now() };
  } catch (err) {
    return { error: err?.name === 'AbortError' ? 'probe timed out' : (err?.message || String(err)) };
  } finally { clearTimeout(t); }
}

function readCache() {
  try {
    const st = statSync(CACHE_FILE);
    const data = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
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
  const session = bucket('Session', byKind('session')) || bucket('Session', data?.five_hour);
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

function usageBar(percent, width = 18) {
  if (percent == null) return `[${paint.gray('?'.repeat(width))}]`;
  const ratio = Math.max(0, Math.min(1, percent / 100));
  const full = Math.round(ratio * width);
  let fill = '';
  for (let i = 0; i < full; i++) { const [r, g, b] = gradientColor(i, width); fill += paint.rgb(r, g, b, '█'); }
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

function quotaLine(row, now) {
  const resetTs = row.resetsAt ? Date.parse(row.resetsAt) : null;
  const reset = resetTs && resetTs > now ? ` reset ${fmtDur(resetTs - now)}` : '';
  const p = row.percent == null ? paint.gray('n/a') : pct(row.percent);
  return `${paint.dim(row.label.padEnd(8))} ${usageBar(row.percent)} ${p}${reset}`;
}

function accountStatus(rows) {
  const ps = rows.map(r => r.percent).filter(p => p != null);
  if (!ps.length) return paint.gray('unknown');
  if (ps.some(p => p >= 100)) return paint.red('exhausted');
  if (rows.some(r => r.severity === 'critical') || ps.some(p => p >= 90)) return paint.yellow('near limit');
  return paint.green('active');
}

function render(state, now) {
  const L = [];
  const acct = state.account;
  const tier = (state.cred.rateLimitTier || '').replace(/^default_claude_/, '').replace('_', ' ');
  const sub = state.cred.subscriptionType || '';
  const plan = tier.startsWith(sub) ? tier : [sub, tier].filter(Boolean).join(' ');

  L.push(paint.bold('agent-usage'));
  L.push(`${paint.dim('Account'.padEnd(12))} ${paint.cyan(acct.email || 'unknown')}${plan ? paint.dim(` (${plan})`) : ''}`);
  const tokExp = state.cred.expiresAt ? Date.parse(state.cred.expiresAt) || Number(state.cred.expiresAt) : null;
  if (tokExp && tokExp <= now) {
    L.push(`${paint.dim('Token'.padEnd(12))} ${paint.red('expired — run `claude` to refresh')}`);
  }
  L.push('');

  const u = state.usage;
  const limited = state.error && /429/.test(state.error);
  const stale = u && state.error && state.usageAt ? paint.dim(` (cached ${fmtDur(now - state.usageAt)} ago)`) : '';
  const status = (u ? accountStatus(u.rows) : (limited ? paint.yellow('rate limited') : state.error ? paint.red('error') : paint.gray('probing…'))) + stale;
  L.push(`${paint.cyan('>')} ${paint.bold('Claude Code')} ${paint.dim('(oauth)')} ${status}`);
  if (u) {
    for (const row of u.rows) L.push(`  ${quotaLine(row, now)}`);
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
  if (!ONCE) { L.push(''); L.push(paint.dim(`probe every ${fmtDur(INTERVAL_MS)} · r probe now · q quit`)); }
  return L.join('\n');
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const cred = loadCredentials();
  const state = {
    cred, account: loadAccount(), usage: null, error: null,
    probing: false, lastProbeAt: null, lastProbeMs: 0, nextProbeAt: null,
    startedAt: Date.now(), local: { req: 0, tok: 0, last: null }, backoffMs: 0,
  };

  async function probe(force = false) {
    if (state.probing) return;
    state.probing = true;
    // Re-read credentials/account each probe so a re-login (different account)
    // is picked up without restarting.
    try { state.cred = loadCredentials(); } catch { /* keep last known */ }
    state.account = loadAccount();
    const t0 = Date.now();
    // Prefer a fresh shared cache (statusline or another agent-usage may have
    // just fetched). Only hit the network when it is stale or missing.
    const cached = force ? null : readCache();
    let r;
    if (cached && t0 - cached.fetchedAt < CACHE_TTL_MS) r = cached;
    else if (!force && cached && state.backoffMs && t0 < (state.backoffUntil || 0)) r = cached; // still backing off: show stale
    else r = await fetchUsage(state.cred.accessToken);
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
      // Fall back to whatever the last good response was (ours or statusline's).
      const stale = readCache();
      if (stale) { state.usage = normalize(stale.data); state.usageAt = stale.fetchedAt; }
      if (JSON_OUT) { console.error(r.error); process.exit(1); }
    }
    else {
      state.error = null;
      state.backoffMs = 0; state.backoffUntil = 0;
      if (JSON_OUT) { console.log(JSON.stringify(r.data, null, 2)); process.exit(0); }
      state.usage = normalize(r.data);
      state.usageAt = r.fetchedAt;
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
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
    process.stdin.on('data', k => {
      if (k === 'q' || k === '\x03') process.exit(0); // q or Ctrl-C
      if (k === 'r') probe(true).then(draw);
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
