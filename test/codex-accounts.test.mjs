import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, beforeEach } from 'node:test';

// Several Codex accounts: archive, archived polling + refresh, switching.
// Isolated files and mocked APIs; no real account, token or network.
const home = mkdtempSync(join(tmpdir(), 'agent-usage-cxacct-'));
Object.assign(process.env, {
  HOME: home, XDG_CONFIG_HOME: join(home, 'config'),
  CODEX_HOME: join(home, 'codex'), CLAUDE_CONFIG_DIR: join(home, 'claude'), PATH: home,
});
after(() => rmSync(home, { recursive: true, force: true }));
const { CODEX_ACCOUNTS_DIR, CODEX_AUTH_FILE, CODEX_TOKEN_URL, CODEX_USAGE_URL, CODEX_RESET_CREDITS_URL } = await import('../src/config.mjs');
const { archiveCodexActive, codexLogin, listCodexAccounts, readCodexAccount, storeCodexLogin, switchCodexTo, resolveCodexAccount } = await import('../src/codex-accounts.mjs');
const { createApp } = await import('../src/app.mjs');
const { rowList, render } = await import('../src/render.mjs');

const day = 86_400_000;
const jwt = data => `test.${Buffer.from(JSON.stringify(data)).toString('base64url')}.test`;
const authFile = (id, email, { exp = Date.now() + 5 * day, rt = `rt-${id}` } = {}) => ({
  auth_mode: 'chatgpt', OPENAI_API_KEY: null, last_refresh: new Date().toISOString(),
  tokens: { account_id: id, access_token: jwt({ exp: exp / 1000, tok: `${id}-${exp}` }), id_token: jwt({ email }), refresh_token: rt },
});
const login = raw => { mkdirSync(process.env.CODEX_HOME, { recursive: true }); writeFileSync(CODEX_AUTH_FILE, JSON.stringify(raw)); };
const activeId = () => JSON.parse(readFileSync(CODEX_AUTH_FILE, 'utf8')).tokens.account_id;
const usage = percent => ({ rate_limit: { secondary_window: { used_percent: percent, reset_at: (Date.now() + 3 * day) / 1000, limit_window_seconds: 7 * 86400 } } });

function mockApi(t, { refreshStatus = 200 } = {}) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, o) => {
    const account = o?.headers?.['chatgpt-account-id'];
    requests.push({ url, account, body: o?.body });
    let data, status = 200;
    if (url === CODEX_USAGE_URL) data = usage(account === 'acct-a' ? 10 : 42);
    else if (url === CODEX_RESET_CREDITS_URL) data = { credits: [] };
    else if (url === CODEX_TOKEN_URL) { status = refreshStatus; data = status === 200 ? { access_token: jwt({ exp: (Date.now() + 10 * day) / 1000, tok: 'fresh' }), refresh_token: 'rt-rotated' } : { error: { code: 'refresh_token_reused' } }; }
    else throw new Error(`unexpected request ${url}`);
    return { ok: status === 200, status, headers: new Headers(), json: async () => data };
  });
  return requests;
}

beforeEach(() => { rmSync(CODEX_ACCOUNTS_DIR, { recursive: true, force: true }); rmSync(CODEX_AUTH_FILE, { force: true }); });

test('the logged-in account is archived on start; a second login waits in the archive', () => {
  login(authFile('acct-a', 'a@example.com'));
  createApp();
  assert.deepEqual(listCodexAccounts().map(r => r.key), ['acct-a']);
  const r = storeCodexLogin(authFile('acct-b', 'b@example.com'));
  assert.equal(r.activated, false);
  assert.equal(activeId(), 'acct-a');
  assert.deepEqual(listCodexAccounts().map(r => r.email).sort(), ['a@example.com', 'b@example.com']);
});

test('a login with nobody logged in becomes the logged-in account', () => {
  const r = storeCodexLogin(authFile('acct-b', 'b@example.com'));
  assert.equal(r.activated, true);
  assert.equal(activeId(), 'acct-b');
});

test('switching archives the current tokens first, then writes the archived file', () => {
  login(authFile('acct-a', 'a@example.com'));
  archiveCodexActive();
  storeCodexLogin(authFile('acct-b', 'b@example.com'));
  // The CLI rotated A's tokens after it was archived: the switch must keep them.
  const rotated = authFile('acct-a', 'a@example.com', { rt: 'rt-a-rotated' });
  login(rotated);
  assert.equal(switchCodexTo('acct-b').already, false);
  assert.equal(activeId(), 'acct-b');
  assert.equal(readCodexAccount('acct-a').authFile.tokens.refresh_token, 'rt-a-rotated');
  assert.equal(switchCodexTo('acct-b').already, true);
  assert.equal(switchCodexTo('acct-a').already, false);
  assert.equal(JSON.parse(readFileSync(CODEX_AUTH_FILE, 'utf8')).tokens.refresh_token, 'rt-a-rotated');
});

test('archived cards poll with their own token and render under Codex', async t => {
  const requests = mockApi(t);
  login(authFile('acct-a', 'a@example.com'));
  storeCodexLogin(authFile('acct-b', 'b@example.com'));
  const app = createApp();
  await app.probe(true);
  const usageCalls = requests.filter(r => r.url === CODEX_USAGE_URL).map(r => r.account).sort();
  assert.deepEqual(usageCalls, ['acct-a', 'acct-b']);
  assert.equal(readCodexAccount('acct-b').usage.rate_limit.secondary_window.used_percent, 42);
  const codexRows = rowList(app.state).filter(r => r.kind === 'codex');
  assert.deepEqual(codexRows.map(r => [r.email, r.active]), [['a@example.com', true], ['b@example.com', false]]);
  const out = render(app.state, Date.now());
  assert.match(out, /a@example\.com · logged in/);
  assert.match(out, /b@example\.com · .* · live/);
  assert.match(out, /42%/);
});

test('an archived token near expiry is refreshed and rotated in the archive; the logged-in one never', async t => {
  const requests = mockApi(t);
  login(authFile('acct-a', 'a@example.com', { exp: Date.now() + 60_000 }));
  storeCodexLogin(authFile('acct-b', 'b@example.com', { exp: Date.now() + 60_000 }));
  await createApp().probe(true);
  const refreshes = requests.filter(r => r.url === CODEX_TOKEN_URL).map(r => JSON.parse(r.body));
  assert.equal(refreshes.length, 1);
  assert.equal(refreshes[0].refresh_token, 'rt-acct-b');
  assert.equal(readCodexAccount('acct-b').authFile.tokens.refresh_token, 'rt-rotated');
  assert.equal(JSON.parse(readFileSync(CODEX_AUTH_FILE, 'utf8')).tokens.refresh_token, 'rt-acct-a');
});

test('a rejected refresh marks the card as needing a login', async t => {
  mockApi(t, { refreshStatus: 401 });
  login(authFile('acct-a', 'a@example.com'));
  storeCodexLogin(authFile('acct-b', 'b@example.com', { exp: Date.now() - 1000 }));
  const app = createApp();
  await app.probe(true);
  assert.equal(app.state.codexOthers.get('acct-b').authDead, true);
  assert.match(render(app.state, Date.now()), /b@example\.com · .* · needs login/);
});

test('same email in two workspaces: names carry the plan, the CLI asks for the id', () => {
  const withPlan = (id, plan) => { const f = authFile(id, 'same@example.com'); f.tokens.access_token = jwt({ exp: (Date.now() + 5 * day) / 1000, 'https://api.openai.com/auth': { chatgpt_plan_type: plan } }); return f; };
  storeCodexLogin(withPlan('acct-p', 'plus'));
  storeCodexLogin(withPlan('acct-t', 'team'));
  assert.throws(() => resolveCodexAccount('same'), /several codex accounts.*acct-p, acct-t/);
  assert.equal(resolveCodexAccount('acct-t').key, 'acct-t');
});

test('codex login runs in a throwaway CODEX_HOME and leaves the logged-in account alone', async () => {
  login(authFile('acct-a', 'a@example.com'));
  // A stand-in `codex` on PATH: prints the auth URL like the real one, then
  // writes auth.json into whatever CODEX_HOME it was given.
  const bin = join(home, 'bin'), path = process.env.PATH;
  mkdirSync(bin, { recursive: true });
  const fake = join(bin, 'codex');
  writeFileSync(fake, `#!/bin/sh\necho "$CODEX_HOME" > "${join(home, 'login-home')}"\necho "navigate to https://auth.openai.com/oauth/authorize?x=1" >&2\nprintf '%s' '${JSON.stringify(authFile('acct-b', 'b@example.com'))}' > "$CODEX_HOME/auth.json"\n`);
  chmodSync(fake, 0o755);
  const seen = [];
  process.env.PATH = bin;
  const raw = await codexLogin({ onStatus: (m, url) => seen.push(url) }).finally(() => { process.env.PATH = path; });
  assert.equal(raw.tokens.account_id, 'acct-b');
  assert.deepEqual(seen, ['https://auth.openai.com/oauth/authorize?x=1']);
  const loginHome = readFileSync(join(home, 'login-home'), 'utf8').trim();
  assert.notEqual(loginHome, process.env.CODEX_HOME);
  assert.equal(existsSync(loginHome), false);
  assert.equal(activeId(), 'acct-a');
});
