// Running Codex threads per ChatGPT account, read from the rollout files Codex
// writes under $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl. Most Codex
// work runs inside long-lived `codex app-server` processes (T3 Code, the
// desktop app) that host many threads each, so a process count says nothing.
// A thread is running while its last turn event is task_started (no
// task_complete / turn_aborted after it) and its file was written within
// SUBAGENT_STALE_MS. The first line (session_meta) says whether it is a
// spawned subagent (source.subagent).
//
// Which account a thread runs on: Codex pins the account per process, so a
// thread resumed after a switch runs on another account than the one that
// created it (session_meta.creator_account_id). Each turn's token_count
// event carries the rate-limit windows it was billed against, and their
// `resets_at` matches exactly one account's usage window (`reset_at`), so
// that is the account. creator_account_id is the fallback until a thread's
// first token_count, or when no archived usage matches.
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CODEX_HOME, SUBAGENT_STALE_MS } from './config.mjs';

const SESSIONS_DIR = join(CODEX_HOME, 'sessions');
// A full walk finds old threads that were resumed (they append to their
// original day's file); between walks only known-recent files and the last
// two day directories are checked.
const RESCAN_MS = 30_000;
const CHUNK = 4 << 20;
// Matched at line start, so the same text inside a message or tool output never counts.
const TURN_EVENT = /^\{"timestamp":"[^"]*",(?:"ordinal":\d+,)?"type":"event_msg","payload":\{"type":"(task_started|task_complete|turn_aborted|token_count)".*$/gm;
const RESET_SLACK_S = 120;

const files = new Map(); // path -> { mtimeMs, size, offset, account, subagent, running, resets }
let lastWalk = 0;

const ls = d => { try { return readdirSync(d); } catch { return []; } };
const isRollout = n => n.startsWith('rollout-') && n.endsWith('.jsonl');

function walkAll(visit) {
  for (const y of ls(SESSIONS_DIR)) for (const m of ls(join(SESSIONS_DIR, y))) for (const d of ls(join(SESSIONS_DIR, y, m))) {
    const dir = join(SESSIONS_DIR, y, m, d);
    for (const n of ls(dir)) if (isRollout(n)) visit(join(dir, n));
  }
}

function recentDays(now, visit) {
  for (const t of [now, now - 86_400_000]) {
    const dt = new Date(t);
    const dir = join(SESSIONS_DIR, String(dt.getFullYear()), String(dt.getMonth() + 1).padStart(2, '0'), String(dt.getDate()).padStart(2, '0'));
    for (const n of ls(dir)) if (isRollout(n)) visit(join(dir, n));
  }
}

// Read what was appended since last time; only whole lines count, a
// half-written last line is read again next time.
function advance(path, f) {
  let fd;
  try { fd = openSync(path, 'r'); } catch { return; }
  try {
    if (f.account === undefined) {
      const head = Buffer.alloc(Math.min(f.size, 1 << 20));
      readSync(fd, head, 0, head.length, 0);
      const nl = head.indexOf(10);
      if (nl < 0) return; // session_meta not complete yet
      let meta = {};
      try { meta = JSON.parse(head.subarray(0, nl).toString('utf8')).payload || {}; } catch { /* unknown shape */ }
      f.account = meta.creator_account_id || null;
      f.subagent = !!meta.source?.subagent;
      f.offset = nl + 1;
    }
    let carry = '';
    while (f.offset < f.size) {
      const buf = Buffer.alloc(Math.min(CHUNK, f.size - f.offset));
      const n = readSync(fd, buf, 0, buf.length, f.offset);
      if (!n) break;
      f.offset += n;
      const text = carry + buf.subarray(0, n).toString('latin1'); // one char per byte: lengths stay byte counts
      const cut = text.lastIndexOf('\n');
      let billed = null;
      for (const m of (cut >= 0 ? text.slice(0, cut) : '').matchAll(TURN_EVENT)) {
        if (m[1] === 'token_count') billed = m[0];
        else f.running = m[1] === 'task_started';
      }
      if (billed) {
        try {
          const rl = JSON.parse(Buffer.from(billed, 'latin1').toString('utf8')).payload?.rate_limits;
          const resets = [rl?.primary?.resets_at, rl?.secondary?.resets_at].map(Number).filter(Boolean);
          if (resets.length) f.resets = resets;
        } catch { /* keep the previous one */ }
      }
      carry = cut >= 0 ? text.slice(cut + 1) : text;
    }
    f.offset -= carry.length;
  } finally { closeSync(fd); }
}

function check(path, now) {
  let st;
  try { st = statSync(path); } catch { files.delete(path); return; }
  if (now - st.mtimeMs > SUBAGENT_STALE_MS) { files.delete(path); return; }
  let f = files.get(path);
  if (!f) files.set(path, f = { mtimeMs: 0, size: 0, offset: 0, account: undefined, subagent: false, running: false, resets: null });
  if (st.mtimeMs === f.mtimeMs && st.size === f.size) return;
  if (st.size < f.size) Object.assign(f, { offset: 0, account: undefined, running: false }); // rewritten: start over
  f.mtimeMs = st.mtimeMs; f.size = st.size;
  advance(path, f);
}

// `windows`: [{ key, resets: [unix seconds] }] from each account's last usage
// response. Returns the key whose window a thread's last turn was billed to.
function billedTo(f, windows) {
  if (!f.resets) return null;
  for (const w of windows) if (w.resets.some(r => f.resets.some(t => Math.abs(r - t) <= RESET_SLACK_S))) return w.key;
  return null;
}

// Usage-window reset times per account, from codex usage responses.
export function usageWindows(accounts) {
  return accounts.map(({ key, usage }) => {
    const rl = usage?.rate_limit || {};
    return { key, resets: [rl.primary_window?.reset_at, rl.secondary_window?.reset_at].map(Number).filter(Boolean) };
  }).filter(w => w.resets.length);
}

// Map of account id -> { sessions, subagents } for threads running now.
export function countCodexThreads(now = Date.now(), windows = []) {
  const seen = new Set();
  const visit = p => { if (!seen.has(p)) { seen.add(p); check(p, now); } };
  if (now - lastWalk >= RESCAN_MS) { lastWalk = now; walkAll(visit); }
  else { for (const p of [...files.keys()]) visit(p); recentDays(now, visit); }
  const out = new Map();
  for (const f of files.values()) {
    const account = f.running && (billedTo(f, windows) || f.account);
    if (!account) continue;
    const c = out.get(account) || { sessions: 0, subagents: 0 };
    f.subagent ? c.subagents++ : c.sessions++;
    out.set(account, c);
  }
  return out;
}
