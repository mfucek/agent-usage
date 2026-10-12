// Local, machine-side signals: running `claude` processes and their subagents.
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_CONFIG_DIR, SUBAGENT_STALE_MS } from './config.mjs';

// Claude Code processes. The launcher's comm is `claude`; the native
// installer's versioned binary runs as ~/.local/share/claude/versions/<v>; an
// npm install runs as `node .../bin/claude`. Look at the first two argv words.
const CLAUDE_WORD = /(^|\/)claude$|\/share\/claude\/versions\//;
export function countClaudeProcs() {
  try {
    const out = execFileSync('ps', ['-Ao', 'args='], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    let n = 0;
    for (const line of out.split('\n')) {
      const [a0 = '', a1 = ''] = line.trim().split(/\s+/);
      if (CLAUDE_WORD.test(a0) || (/(^|\/)(node|bun)$/.test(a0) && CLAUDE_WORD.test(a1))) n++;
    }
    return n;
  } catch { return 0; }
}

// Subagents run inside their session's process, so `ps` cannot see them. Each
// one appends to <projects>/<project>/<sessionId>/subagents/agent-<id>.jsonl,
// and each running process registers itself in <configDir>/sessions/<pid>.json.
// A subagent counts as running while its session's process is alive and its
// transcript has not ended: the last line is not a finished assistant turn or
// an interrupt, and it was written to within SUBAGENT_STALE_MS (a killed agent
// leaves no marker).
const TAIL_BYTES = 65536;
const STREAMING_MS = 30_000; // a text block with no stop_reason yet: mid-reply, or the last word
function lastLine(file, size) {
  const fd = openSync(file, 'r');
  try {
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8').trimEnd();
    const nl = text.lastIndexOf('\n');
    return nl < 0 && len < size ? null : text.slice(nl + 1); // null: the line is longer than the tail
  } finally { closeSync(fd); }
}

export function subagentRunning(file, now = Date.now()) {
  try {
    const st = statSync(file);
    const age = now - st.mtimeMs;
    if (!st.size || age > SUBAGENT_STALE_MS) return false;
    const line = lastLine(file, st.size);
    if (line == null) return true; // only tool calls and their results get that long
    const e = JSON.parse(line);
    const content = Array.isArray(e.message?.content) ? e.message.content : [];
    if (e.type === 'user') return !content.some(c => c.type === 'text' && /^\[Request interrupted/.test(c.text || ''));
    if (e.type !== 'assistant') return true;
    if (content.some(c => c.type === 'tool_use')) return true;
    return e.message?.stop_reason ? false : age < STREAMING_MS;
  } catch { return false; }
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const subagentDirs = new Map(); // sessionId → its subagents dir
function subagentDir(configDir, sessionId, cwd) {
  const known = subagentDirs.get(sessionId);
  if (known && existsSync(known)) return known;
  const projects = join(configDir, 'projects');
  const candidates = [String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-')];
  try { candidates.push(...readdirSync(projects)); } catch { /* no transcripts */ }
  for (const project of candidates) {
    const dir = join(projects, project, sessionId, 'subagents');
    if (project && existsSync(dir)) { subagentDirs.set(sessionId, dir); return dir; }
  }
  return null;
}

export function countClaudeSubagents(now = Date.now(), configDir = CLAUDE_CONFIG_DIR) {
  let n = 0;
  let files;
  try { files = readdirSync(join(configDir, 'sessions')); } catch { return 0; }
  for (const f of files) {
    if (!/^\d+\.json$/.test(f)) continue;
    try {
      const s = JSON.parse(readFileSync(join(configDir, 'sessions', f), 'utf8'));
      if (!s.sessionId || !alive(s.pid)) continue;
      const dir = subagentDir(configDir, s.sessionId, s.cwd);
      if (!dir) continue;
      for (const a of readdirSync(dir)) if (/^agent-.*\.jsonl$/.test(a) && subagentRunning(join(dir, a), now)) n++;
    } catch { /* unreadable entry */ }
  }
  return n;
}
