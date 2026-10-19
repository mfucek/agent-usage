import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

// Isolated HOME, no keychain on PATH: nobody is logged in, one archived
// account. No real account or network is touched.
const home = mkdtempSync(join(tmpdir(), 'agent-usage-test-'));
Object.assign(process.env, {
  HOME: home, XDG_CONFIG_HOME: join(home, 'config'),
  CODEX_HOME: join(home, 'codex'), CLAUDE_CONFIG_DIR: join(home, 'claude'), PATH: home,
});
after(() => rmSync(home, { recursive: true, force: true }));
const { OTHER_BACKOFF_MS, OTHER_INTERVAL_MS, USAGE_URL } = await import('../src/config.mjs');
const { saveAccount, savePollState } = await import('../src/archive.mjs');
const { createApp } = await import('../src/app.mjs');
const { render } = await import('../src/render.mjs');

const EMAIL = 'archived@example.com';
const t0 = Math.floor(Date.now() / 1000) * 1000;
const min = 60_000;

function setup(t) {
  let time = t0;
  t.mock.method(Date, 'now', () => time);
  t.mock.method(Math, 'random', () => 0.5); // jitter factor 1.0
  saveAccount({ email: EMAIL, oauth: { accessToken: 'tok', expiresAt: t0 + 30 * 86_400_000 } });
  savePollState(new Map());
  const api = { status: 429, retryAfter: 0, calls: 0 };
  t.mock.method(globalThis, 'fetch', async url => {
    if (!String(url).startsWith(USAGE_URL)) throw new Error(`unexpected network request: ${url}`);
    api.calls++;
    const ok = api.status === 200;
    return { ok, status: api.status, headers: new Headers(api.retryAfter ? { 'retry-after': String(api.retryAfter) } : {}), json: async () => (ok ? { five_hour: { utilization: 10 } } : { error: { message: 'Rate limited.' } }) };
  });
  return { api, advance: ms => { time += ms; }, now: () => time };
}

test('429s wait 5 → 10 → 30 min, then park until r; r + 429 stays parked', async t => {
  const { api, advance, now } = setup(t);
  const app = createApp({ live: true });
  const o = () => app.state.others.get(EMAIL);

  await app.probe();
  assert.equal(api.calls, 1);
  assert.equal(o().nextAt, now() + OTHER_BACKOFF_MS[0]);

  await app.probe(true); // r does not cut a 429 wait short
  app.probeOthersDue();
  assert.equal(api.calls, 1);

  for (const [i, step] of OTHER_BACKOFF_MS.entries()) {
    advance(step - 1); app.probeOthersDue(); await app.probe();
    assert.equal(api.calls, 1 + i, 'not due before the wait ends');
    advance(1); await app.probe();
    assert.equal(api.calls, 2 + i);
  }
  assert.equal(o().parked, true);
  assert.match(render(app.state, now()), /paused, r retries/);

  advance(24 * 60 * min); app.probeOthersDue(); await app.probe();
  assert.equal(api.calls, 4, 'parked: no automatic retries');

  await app.probe(true);
  assert.equal(api.calls, 5, 'r retries a parked account');
  assert.equal(o().parked, true, 'r + 429 stays parked, no new schedule');
  assert.equal(o().nextAt, 0);

  // A restart keeps the park.
  const again = createApp({ live: true });
  assert.equal(again.state.others.get(EMAIL).parked, true);
  await again.probe();
  assert.equal(api.calls, 5);

  api.status = 200;
  await again.probe(true);
  assert.equal(api.calls, 6);
  const r = again.state.others.get(EMAIL);
  assert.deepEqual([r.parked, r.strikes, r.live], [false, 0, true], 'r + 200 resumes');
  assert.equal(r.nextAt, now() + OTHER_INTERVAL_MS);
});

test('server retry-after longer than the step wins; a 200 resets the ladder', async t => {
  const { api, advance, now } = setup(t);
  const app = createApp({ live: true });
  api.retryAfter = 3600;
  await app.probe();
  assert.equal(app.state.others.get(EMAIL).nextAt, now() + 3600_000);
  advance(3600_000); api.status = 200; api.retryAfter = 0;
  await app.probe();
  assert.equal(app.state.others.get(EMAIL).strikes, 0);
  advance(OTHER_INTERVAL_MS); api.status = 429;
  await app.probe();
  assert.equal(app.state.others.get(EMAIL).nextAt, now() + OTHER_BACKOFF_MS[0]);
});

test('regular polls are jittered ±20% around otherInterval', async t => {
  const { api, now } = setup(t);
  api.status = 200;
  const app = createApp({ live: true });
  Math.random.mock.mockImplementation(() => 0);
  await app.probe();
  assert.equal(app.state.others.get(EMAIL).nextAt, now() + OTHER_INTERVAL_MS * 0.8);
  Math.random.mock.mockImplementation(() => 0.999999);
  await app.probe(true);
  assert.ok(app.state.others.get(EMAIL).nextAt - now() > OTHER_INTERVAL_MS * 1.19);
});
