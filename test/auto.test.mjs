import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

// Isolated HOME, no keychain on PATH: nobody is logged in. No real account
// or network is touched.
const home = mkdtempSync(join(tmpdir(), 'agent-usage-test-'));
Object.assign(process.env, {
  HOME: home, XDG_CONFIG_HOME: join(home, 'config'),
  CODEX_HOME: join(home, 'codex'), CLAUDE_CONFIG_DIR: join(home, 'claude'), PATH: home,
});
after(() => rmSync(home, { recursive: true, force: true }));
const { saveAccount } = await import('../src/archive.mjs');
const { pickCandidate } = await import('../src/auto.mjs');

const now = Date.now();
const iso = ms => new Date(now + ms).toISOString();
const usage = (sess, week, sessIn) => ({
  five_hour: { utilization: sess, resets_at: iso(sessIn) },
  seven_day: { utilization: week, resets_at: iso(3 * 86_400_000) },
});
const acct = (email, u) => saveAccount({ email, oauth: { accessToken: 'tok', expiresAt: now + 86_400_000 }, usage: u, usageAt: now, seenAt: now });

test('a free session on a spent weekly is not a candidate', () => {
  acct('weekly-spent@example.com', usage(5, 100, 10 * 60_000)); // resets soonest, but weekly is gone
  acct('viable@example.com', usage(20, 40, 3 * 3600_000));
  assert.equal(pickCandidate('active@example.com', new Map(), now)?.email, 'viable@example.com');
});
