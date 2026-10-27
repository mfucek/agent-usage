import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
const { CONFIG_FILE } = await import('../src/config.mjs');
const { saveAccount } = await import('../src/archive.mjs');
const { isDisabled, pickCandidate, toggleDisabled } = await import('../src/auto.mjs');
const { createApp } = await import('../src/app.mjs');
const { render } = await import('../src/render.mjs');

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

test('a spent Fable bucket does not block a candidate', () => {
  acct('fable-spent@example.com', { ...usage(15, 54, 5 * 60_000), seven_day_fable: { utilization: 92, resets_at: iso(86_400_000) } });
  assert.equal(pickCandidate('active@example.com', new Map(), now)?.email, 'fable-spent@example.com');
  acct('fable-spent@example.com', usage(15, 100, 5 * 60_000)); // retire it for the tests below
});

test('d opts an account out of auto-switch and shows it as disabled', () => {
  assert.equal(toggleDisabled('Viable@example.com'), true);
  assert.ok(isDisabled('viable@example.com'));
  assert.deepEqual(JSON.parse(readFileSync(CONFIG_FILE, 'utf8')).disabled, ['viable@example.com']);
  assert.equal(pickCandidate('active@example.com', new Map(), now), null);

  const app = createApp();
  app.state.others.set('viable@example.com', { live: true });
  const out = render(app.state, now);
  const line = out.split('\n').find(l => l.includes('viable@example.com'));
  assert.match(line, /· disabled/);
  assert.doesNotMatch(line, /live/);
  assert.match(out, /auto-switch → none eligible/);

  assert.equal(toggleDisabled('viable@example.com'), false);
  assert.equal(pickCandidate('active@example.com', new Map(), now)?.email, 'viable@example.com');
});
