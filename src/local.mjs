// Local, machine-side signals: running `claude` processes and transcript usage.
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECTS_DIR } from './config.mjs';
import { accountAt, safeReaddir } from './archive.mjs';

// Claude Code processes: comm is `claude` for the launcher, but the native
// installer's versioned binary (~/.local/share/claude/versions/<v>) shows up
// under its own path, so match both.
const isClaudeProc = comm => comm === 'claude' || comm.endsWith('/claude') || /\/share\/claude\/versions\//.test(comm);
export function countClaudeProcs() {
  try {
    return execFileSync('ps', ['-Ao', 'comm='], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\n').map(s => s.trim()).filter(isClaudeProc).length;
  } catch { return 0; }
}

// ─── Transcript scan (incremental) ───────────────────────────────────────────
// Tracks per-file read offsets so each probe only parses appended bytes.
// Requests are deduped by requestId (Claude Code writes one assistant line per
// content block, each repeating the same usage object).
const fileState = new Map(); // path -> { offset, rest }
const requests = new Map();  // requestId -> { ts, tokens }

export function scanLocal(windowStart) {
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
        if (j.message?.model === '<synthetic>') continue; // local placeholder, not an API call (Claude Code excludes these too)
        const ts = Date.parse(j.timestamp);
        if (!ts || ts < windowStart) continue;
        const id = j.requestId || j.message?.id || j.uuid || `${p}:${ts}:${line.length}`;
        const tokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
        const prev = requests.get(id);
        requests.set(id, { ts, tokens: Math.max(prev?.tokens || 0, tokens) });
      }
    } finally { closeSync(fd); }
    fileState.set(p, st);
  }
  for (const [id, r] of requests) if (r.ts < windowStart) requests.delete(id);
}

// email -> { req, tok, last }, each request attributed via the switch log.
export function localSummaryBy(currentEmail) {
  const by = new Map();
  for (const r of requests.values()) {
    const email = accountAt(r.ts) || currentEmail || '?';
    const s = by.get(email) || { req: 0, tok: 0, last: 0 };
    s.req++; s.tok += r.tokens; if (r.ts > s.last) s.last = r.ts;
    by.set(email, s);
  }
  return by;
}
