import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after } from 'node:test';

// Isolate all files and disable PATH-based keychain lookup. No real account,
// keychain, network, or reset credit is accessed by these tests.
const home = mkdtempSync(join(tmpdir(), 'agent-usage-test-'));
Object.assign(process.env, {
  HOME: home, XDG_CONFIG_HOME: join(home, 'config'),
  CODEX_HOME: join(home, 'codex'), CLAUDE_CONFIG_DIR: join(home, 'claude'), PATH: home,
});
after(() => rmSync(home, { recursive: true, force: true }));
const { CODEX_AUTH_FILE, CONFIG_FILE, CODEX_USAGE_URL, CODEX_RESET_CREDITS_URL, CODEX_RESET_CONSUME_URL } = await import('../src/config.mjs');
const { codexAutoEnabled, setCodexAuto, codexResetWindows, createCodexResetGuard, CODEX_AUTO_INTERVAL_MS, CODEX_AUTO_RETRY_MS, startCodexPolling } = await import('../src/codex-auto.mjs');
const { createApp } = await import('../src/app.mjs');
const { rowList, render } = await import('../src/render.mjs');
const { forgetCodexAccount } = await import('../src/codex-accounts.mjs');
const cli = new URL('../bin/agent-usage.mjs', import.meta.url).pathname;
const day = 86_400_000;
const now = Math.floor(Date.now() / 1000) * 1000;
const auth = { accountId: 'test-account', accessToken: 'test-token' };
const window = (percent = 95, remaining = day, seconds = 7 * 86400) => ({
  used_percent: percent, reset_at: (now + remaining) / 1000, limit_window_seconds: seconds,
});
const usage = (percent = 95, remaining = 2 * day) => ({ rate_limit: { secondary_window: window(percent, remaining) } });
const credit = (id, days = 3, extra = {}) => ({ id, status: 'available', expires_at: new Date(now + days * day).toISOString(), ...extra });
const credits = { credits: [credit('later', 5), credit('soon', 2)] };

test('threshold and reset countdown are inclusive and apply to the same window', () => {
  assert.equal(codexResetWindows(usage(95, day), now).length, 1);
  assert.equal(codexResetWindows(usage(100, day), now).length, 1);
  assert.equal(codexResetWindows(usage(94.999, day), now).length, 0);
  assert.equal(codexResetWindows(usage(95, day - 1), now).length, 0);
  assert.equal(codexResetWindows(usage(100, -day), now).length, 0);
  for (const percent of [null, undefined, 'unknown', Infinity]) {
    assert.equal(codexResetWindows({ rate_limit: { primary_window: { ...window(), used_percent: percent } } }, now).length, 0);
  }
  assert.equal(codexResetWindows(null, now).length, 0);
  assert.equal(codexResetWindows({ rate_limit: { primary_window: window(100, 5 * 3600000, 18000), secondary_window: window(20, 5 * day) } }, now).length, 0);
  assert.equal(codexResetWindows({ additional_rate_limits: [{ rate_limit: usage().rate_limit }] }, now).length, 0);
  assert.equal(codexResetWindows({ rate_limit: { primary_window: { used_percent: 100 } } }, now).length, 0);
});

test('selects the soonest-expiring usable credit and requires live auth', () => {
  const guard = createCodexResetGuard();
  const mixed = { credits: [credit('expired', -1), credit('busy', 1, { redeem_started_at: 'started' }), credit('unsupported', 1, { is_supported_by_plan: false }), credit('spent', 1, { status: 'redeemed' }), credit('future', 1, { granted_at: new Date(now + day).toISOString() }), ...credits.credits] };
  assert.equal(guard.target(auth, usage(), mixed, now).grant.id, 'soon');
  assert.equal(guard.target(auth, usage(), null, now), null);
  assert.equal(guard.target(auth, usage(), { credits: [] }, now), null);
  assert.equal(guard.target({ ...auth, expiresAt: now }, usage(), credits, now), null);
  assert.equal(guard.target(null, usage(), credits, now), null);
});

test('attempt guard blocks repeated stale windows, including a different credit', () => {
  const guard = createCodexResetGuard();
  guard.finishAttempt(guard.markAttempt(guard.target(auth, usage(), credits, now), usage(), now), { windowsReset: 1 }, now);
  assert.equal(guard.target(auth, usage(), credits, now), null);
  assert.equal(guard.target(auth, usage(99), { credits: [credit('new-credit')] }, now), null);
  assert.equal(guard.target(auth, {}, credits, now), null);
  assert.equal(guard.target(auth, usage(), credits, now), null);
  assert.ok(guard.target({ ...auth, accountId: 'other' }, usage(), credits, now));
  assert.ok(guard.target(auth, usage(95, 3 * day), credits, now));
  assert.equal(guard.target(auth, usage(0), credits, now), null);
  assert.ok(guard.target(auth, usage(), credits, now));
});

test('CLI persists the toggle, preserves unrelated config, and rejects invalid values', () => {
  assert.equal(codexAutoEnabled(), false);
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify({ order: ['test@example.com'], autoSwitch: true }));
  const run = (...args) => execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(run('auto-reset'), /auto use reset: off/);
  assert.match(run('auto-reset', 'on'), /auto use reset: on/);
  assert.match(run('auto-reset'), /auto use reset: on/);
  assert.deepEqual(JSON.parse(readFileSync(CONFIG_FILE, 'utf8')), { order: ['test@example.com'], autoSwitch: true, codexAutoReset: true });
  assert.match(run('auto-reset', 'off'), /auto use reset: off/);
  assert.throws(() => run('auto-reset', 'maybe'), /takes 'on' or 'off'/);
  assert.equal(JSON.parse(readFileSync(CONFIG_FILE, 'utf8')).codexAutoReset, false);
});

function mockAccount(t, options = {}) {
  const jwt = data => `test.${Buffer.from(JSON.stringify(data)).toString('base64url')}.test`;
  mkdirSync(process.env.CODEX_HOME, { recursive: true });
  writeFileSync(CODEX_AUTH_FILE, JSON.stringify({ tokens: { account_id: auth.accountId, access_token: jwt({ exp: (now + day) / 1000 }), id_token: jwt({ email: 'test@example.com' }) } }));
  setCodexAuto(true);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, fetchOptions) => {
    requests.push({ url, ...fetchOptions });
    let data;
    let failed = false;
    if (url === CODEX_USAGE_URL) { data = options.usageData ?? usage(); failed = options.failUsage; }
    else if (url === CODEX_RESET_CREDITS_URL) { data = options.creditsData ?? credits; failed = options.failCredits; }
    else if (url === CODEX_RESET_CONSUME_URL) {
      if (options.failConsume) throw new Error('connection lost after sending');
      data = options.consumeResult ?? { code: 'reset', windows_reset: 2 };
    } else throw new Error(`unexpected network request: ${url}`);
    return { ok: !failed, status: failed ? (options.failStatus || 503) : 200, headers: new Headers(options.retryAfter ? { 'retry-after': String(options.retryAfter) } : {}), json: async () => data };
  });
  return { requests, claims: () => requests.filter(r => r.url === CODEX_RESET_CONSUME_URL) };
}

test('live probes spend once, refresh immediately, and ignore repeated high usage', async t => {
  const api = mockAccount(t);
  const app = createApp({ live: true });
  await app.probe(true);
  assert.equal(api.claims().length, 1);
  const body = JSON.parse(api.claims()[0].body);
  assert.equal(body.credit_id, 'soon');
  assert.ok(body.redeem_request_id);
  assert.equal(api.requests.filter(r => r.url === CODEX_USAGE_URL).length, 2);
  assert.match(app.state.msg, /auto use reset.*codex reset used/);
  assert.equal(app.state.claiming, false);
  await app.probe(true);
  assert.equal(api.claims().length, 1);
});

test('one-shot probes and disabled automation never spend', async t => {
  const api = mockAccount(t);
  await createApp().probe(true);
  assert.equal(api.claims().length, 0);
  setCodexAuto(false);
  await createApp({ live: true }).probe(true);
  assert.equal(api.claims().length, 0);
});

for (const failure of ['failUsage', 'failCredits']) {
  test(`a failed fresh probe cannot authorize a claim (${failure})`, async t => {
    const api = mockAccount(t, { [failure]: true });
    const app = createApp({ live: true });
    app.state.codex.usage = usage(); app.state.codex.credits = credits;
    await app.probe(true);
    assert.equal(api.claims().length, 0);
  });
}

test('uncertain consume failures are not immediately retried on the same window', async t => {
  const api = mockAccount(t, { failConsume: true });
  const app = createApp({ live: true });
  await app.probe(true);
  await app.probe(true);
  assert.equal(api.claims().length, 1);
  assert.match(app.state.msg, /reset failed/);
  assert.equal(app.state.claiming, false);
});

test('manual confirmations and in-flight claims block auto spending', async t => {
  const api = mockAccount(t);
  const app = createApp({ live: true });
  app.state.confirm = { at: Date.now() };
  await app.probe(true);
  assert.equal(api.claims().length, 0);
  app.state.confirm = null; app.state.claiming = true;
  await app.probe(true);
  assert.equal(api.claims().length, 0);
  app.state.claiming = false;
  app.state.confirm = { at: Date.now() - 11000 };
  await app.probe(true);
  assert.equal(api.claims().length, 1);
});

test('manual reset attempts also suppress duplicate automatic claims', async t => {
  const api = mockAccount(t);
  const app = createApp({ live: true });
  setCodexAuto(false);
  await app.probe(true);
  await app.useReset(app.resetTargetFor({ kind: 'codex' }));
  setCodexAuto(true);
  await app.probe(true);
  assert.equal(api.claims().length, 1);
});

test('Codex toggle is selectable and reflects the persisted setting', t => {
  mockAccount(t);
  const app = createApp();
  assert.equal(rowList(app.state).at(-1).kind, 'codex-auto');
  assert.match(render(app.state, now), /\[x\] auto use reset/);
  setCodexAuto(false);
  assert.match(render(app.state, now), /\[ \] auto use reset/);
  // Logged out of codex: the archived card (and the toggle) stay until forgotten.
  app.state.codex.auth = null;
  assert.ok(rowList(app.state).some(row => row.kind === 'codex' && !row.active));
  forgetCodexAccount(auth.accountId);
  assert.ok(!rowList(app.state).some(row => row.kind === 'codex-auto'));
});

function clock(t) {
  let time = now;
  t.mock.method(Date, 'now', () => time);
  return { advance(ms) { time += ms; } };
}

test('independent live timer crosses 95% within 30s even while Claude is blocked', async t => {
  const time = clock(t);
  const responses = { usageData: usage(94.9) };
  const api = mockAccount(t, responses);
  const app = createApp({ live: true });
  // Simulate an ongoing Claude probe and a 30-minute backoff. Its dashboard
  // loop cannot call probe() again, but the Codex heartbeat must keep working.
  app.state.probing = true;
  app.state.backoffMs = 30 * 60_000;
  app.state.backoffUntil = now + app.state.backoffMs;
  let heartbeat;
  t.mock.method(globalThis, 'setInterval', (fn, ms) => {
    assert.equal(ms, 1000);
    heartbeat = fn;
    return 'heartbeat';
  });
  const clear = t.mock.method(globalThis, 'clearInterval', id => assert.equal(id, 'heartbeat'));
  const jobs = [];
  const errors = [];
  const stop = startCodexPolling(() => { const p = app.probeCodex(); jobs.push(p); return p; }, e => errors.push(e));
  const finishTick = async () => { await Promise.resolve(); await jobs.at(-1); };
  await finishTick();
  assert.equal(api.claims().length, 0);
  assert.equal(api.requests.length, 2);
  responses.usageData = usage(95);
  time.advance(CODEX_AUTO_INTERVAL_MS - 1000);
  heartbeat(); await finishTick();
  assert.equal(api.requests.length, 2);
  time.advance(1000);
  heartbeat(); await finishTick();
  assert.equal(api.claims().length, 1);
  assert.match(render(app.state, Date.now()), /next check 30s/);
  assert.deepEqual(errors, []);
  stop();
  assert.equal(clear.mock.callCount(), 1);
});

test('a failed claim retries in the same process using the same credit and request ID', async t => {
  const time = clock(t);
  const responses = { failConsume: true };
  const api = mockAccount(t, responses);
  const app = createApp({ live: true });
  await app.probeCodex();
  assert.equal(api.claims().length, 1);
  responses.failConsume = false;
  time.advance(CODEX_AUTO_INTERVAL_MS);
  await app.probeCodex();
  assert.equal(api.claims().length, 1);
  time.advance(CODEX_AUTO_RETRY_MS - CODEX_AUTO_INTERVAL_MS);
  await app.probeCodex();
  assert.equal(api.claims().length, 2);
  assert.deepEqual(JSON.parse(api.claims()[0].body), JSON.parse(api.claims()[1].body));
  assert.match(app.state.msg, /codex reset used/);
  // A successful retry must still protect against later stale high readings.
  time.advance(5 * CODEX_AUTO_RETRY_MS);
  await app.probeCodex();
  assert.equal(api.claims().length, 2);
});

test('a definite no-op retries after cooldown with a new request ID', async t => {
  const time = clock(t);
  const responses = { consumeResult: { code: 'not_limited', windows_reset: 0 } };
  const api = mockAccount(t, responses);
  const app = createApp({ live: true });
  await app.probeCodex();
  assert.match(app.state.msg, /nothing reset/);
  responses.consumeResult = { code: 'reset', windows_reset: 1 };
  time.advance(CODEX_AUTO_RETRY_MS);
  await app.probeCodex();
  assert.equal(api.claims().length, 2);
  const [first, second] = api.claims().map(r => JSON.parse(r.body));
  assert.equal(first.credit_id, second.credit_id);
  assert.notEqual(first.redeem_request_id, second.redeem_request_id);
});

test('an uncertain claim never moves on to another credit while usage remains high', async t => {
  const time = clock(t);
  const responses = { failConsume: true };
  const api = mockAccount(t, responses);
  const app = createApp({ live: true });
  await app.probeCodex();
  responses.failConsume = false;
  responses.creditsData = { credits: [credit('later', 5)] };
  time.advance(CODEX_AUTO_RETRY_MS);
  await app.probeCodex();
  assert.equal(api.claims().length, 1);
  // Once usage recovers, a later threshold crossing is a new reset cycle.
  responses.usageData = usage(0);
  time.advance(CODEX_AUTO_INTERVAL_MS);
  await app.probeCodex();
  responses.usageData = usage(95);
  time.advance(CODEX_AUTO_INTERVAL_MS);
  await app.probeCodex();
  assert.equal(api.claims().length, 2);
  assert.equal(JSON.parse(api.claims()[1].body).credit_id, 'later');
});

for (const endpoint of ['failUsage', 'failCredits']) {
  test(`${endpoint}: transient probe failures retry on the next 30s check`, async t => {
    const time = clock(t);
    const responses = { [endpoint]: true };
    const api = mockAccount(t, responses);
    const app = createApp({ live: true });
    await app.probeCodex();
    responses[endpoint] = false;
    time.advance(CODEX_AUTO_INTERVAL_MS - 1);
    await app.probeCodex();
    assert.equal(api.requests.length, 2);
    time.advance(1);
    await app.probeCodex();
    assert.equal(api.claims().length, 1);
  });

  test(`${endpoint}: server Retry-After takes precedence over the 30s timer`, async t => {
    const time = clock(t);
    const responses = { [endpoint]: true, failStatus: 429, retryAfter: 120 };
    const api = mockAccount(t, responses);
    const app = createApp({ live: true });
    await app.probeCodex();
    assert.equal(app.state.codex.nextProbeAt, now + 120_000);
    responses[endpoint] = false;
    time.advance(119_999);
    await app.probeCodex();
    assert.equal(api.requests.length, 2);
    time.advance(1);
    await app.probeCodex();
    assert.equal(api.claims().length, 1);
  });
}

test('external CLI setting changes apply without restarting the live app', async t => {
  const time = clock(t);
  const responses = {};
  const api = mockAccount(t, responses);
  setCodexAuto(false);
  const app = createApp({ live: true });
  await app.probeCodex();
  assert.equal(api.claims().length, 0);
  const run = value => execFileSync(process.execPath, [cli, 'auto-reset', value], { stdio: 'pipe' });
  run('on');
  time.advance(1000);
  await app.probeCodex();
  assert.equal(api.claims().length, 1);
  run('off');
  responses.usageData = usage(95, 3 * day);
  time.advance(5 * 60_000);
  await app.probeCodex();
  assert.equal(codexAutoEnabled(), false);
  assert.equal(api.claims().length, 1);
});

test('timer, dashboard, and forced probes share a single in-flight Codex request', async t => {
  clock(t);
  const api = mockAccount(t);
  const app = createApp({ live: true });
  await Promise.all([app.probeCodex(), app.probeCodex(true), app.probe(true)]);
  assert.equal(api.claims().length, 1);
  assert.equal(api.requests.filter(r => r.url === CODEX_USAGE_URL).length, 2);
});
