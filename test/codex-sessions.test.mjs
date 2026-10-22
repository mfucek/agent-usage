import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

// Running Codex threads from fake rollout files; no real session is read.
const home = mkdtempSync(join(tmpdir(), 'agent-usage-cxsess-'));
process.env.CODEX_HOME = join(home, 'codex');
after(() => rmSync(home, { recursive: true, force: true }));
const { countCodexThreads, usageWindows } = await import('../src/codex-sessions.mjs');

const now = new Date();
const dir = join(process.env.CODEX_HOME, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
mkdirSync(dir, { recursive: true });
const line = o => JSON.stringify({ timestamp: now.toISOString(), ...o }) + '\n';
const event = (type, extra = {}) => line({ type: 'event_msg', payload: { type, ...extra } });
const billed = resetsAt => event('token_count', { rate_limits: { primary: { used_percent: 30, window_minutes: 10080, resets_at: resetsAt } } });
const rollout = (name, creator, subagent = false) => {
  const p = join(dir, `rollout-${name}.jsonl`);
  writeFileSync(p, line({ type: 'session_meta', payload: { creator_account_id: creator, source: subagent ? { subagent: { thread_spawn: {} } } : 'vscode' } }));
  return p;
};
const windows = usageWindows([{ key: 'acct-a', usage: { rate_limit: { primary_window: { reset_at: 1000 } } } }, { key: 'acct-b', usage: { rate_limit: { primary_window: { reset_at: 2000 } } } }]);

test('running threads count under the account their turns are billed to', () => {
  const a = rollout('a', 'acct-a');
  appendFileSync(a, event('task_started'));
  const resumed = rollout('resumed', 'acct-a'); // created on A, now running in a process pinned to B
  appendFileSync(resumed, event('task_started') + billed(2030));
  const sub = rollout('sub', 'acct-b', true);
  appendFileSync(sub, event('task_started'));
  const done = rollout('done', 'acct-b');
  appendFileSync(done, event('task_started') + event('task_complete'));
  // The same words inside a message are not a turn event.
  const quoted = rollout('quoted', 'acct-b');
  appendFileSync(quoted, line({ type: 'response_item', payload: { text: '{"type":"event_msg","payload":{"type":"task_started"}}' } }));
  assert.deepEqual(Object.fromEntries(countCodexThreads(Date.now(), windows)), {
    'acct-a': { sessions: 1, subagents: 0 },
    'acct-b': { sessions: 1, subagents: 1 },
  });
  // Appends are read incrementally; a finished turn stops counting.
  appendFileSync(a, event('task_complete'));
  appendFileSync(resumed, event('turn_aborted'));
  assert.deepEqual(Object.fromEntries(countCodexThreads(Date.now() + 1, windows)), { 'acct-b': { sessions: 0, subagents: 1 } });
});
