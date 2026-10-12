import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { countClaudeSubagents } from '../src/local.mjs';

// Running subagents, read from a fake Claude config dir: a session registry
// entry per process and a transcript per subagent. No real session is touched.
const dir = mkdtempSync(join(tmpdir(), 'agent-usage-subagents-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const now = Date.parse('2026-10-12T18:00:00Z');
const MIN = 60_000;
const DEAD_PID = 2 ** 22 + 12345; // above any pid macOS or Linux hands out by default
const session = (pid, sessionId, cwd = '/work/app') => {
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  writeFileSync(join(dir, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, cwd }));
};
const agent = (sessionId, id, last, age = 5000, project = '-work-app') => {
  const d = join(dir, 'projects', project, sessionId, 'subagents');
  mkdirSync(d, { recursive: true });
  const p = join(d, `agent-${id}.jsonl`);
  writeFileSync(p, `${JSON.stringify({ type: 'user', message: { content: 'go' } })}\n${typeof last === 'string' ? last : JSON.stringify(last)}\n`);
  utimesSync(p, new Date(now - age), new Date(now - age));
  writeFileSync(join(d, `agent-${id}.meta.json`), '{}');
};
const assistant = (content, stop_reason = null) => ({ type: 'assistant', message: { stop_reason, content } });
const toolUse = assistant([{ type: 'tool_use', name: 'Bash', input: {} }], 'tool_use');
const toolResult = { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } };
const done = assistant([{ type: 'text', text: 'finished' }], 'end_turn');

test('counts transcripts that have not ended, in live sessions only', () => {
  session(process.pid, 'live');
  agent('live', 'tool', toolUse);
  agent('live', 'result', toolResult);
  agent('live', 'reminder', { type: 'attachment', attachment: { type: 'total_tokens_reminder' } });
  agent('live', 'huge', JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x'.repeat(200_000) }] } }));
  agent('live', 'streaming', assistant([{ type: 'text', text: 'let me' }]));
  agent('live', 'done', done);
  agent('live', 'last-word', assistant([{ type: 'text', text: 'all done' }]), 5 * MIN);
  agent('live', 'interrupted', { type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
  agent('live', 'stale', toolUse, 45 * MIN);
  session(DEAD_PID, 'gone');
  agent('gone', 'tool', toolUse);
  assert.equal(countClaudeSubagents(now, dir), 5);
});

test('finds the transcript dir when the project name is not the cwd slug', () => {
  session(process.pid, 'moved', '/somewhere/else'); // replaces the 'live' entry: one pid, one session
  agent('moved', 'tool', toolUse, 5000, '-work-app--claude-worktrees-x');
  assert.equal(countClaudeSubagents(now, dir), 1);
});

test('no session registry: zero', () => {
  assert.equal(countClaudeSubagents(now, join(dir, 'missing')), 0);
});
