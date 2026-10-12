import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

// Self-update against throwaway git repos: a bare "GitHub" remote, a clone
// that pushes, and the clone under test. No network, no real checkout.
const home = mkdtempSync(join(tmpdir(), 'agent-usage-update-'));
Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: join(home, 'config'), GIT_CONFIG_GLOBAL: join(home, 'gitconfig') });
writeFileSync(join(home, 'gitconfig'), '[user]\n\tname = test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
after(() => rmSync(home, { recursive: true, force: true }));

const { autoUpdateEnabled, changesSince, checkForUpdate, reloadAutoUpdate, runUpdate, setAutoUpdate } = await import('../src/update.mjs');
const { CONFIG_FILE } = await import('../src/config.mjs');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const remote = join(home, 'remote.git'), dev = join(home, 'dev'), app = join(home, 'app');
git(home, 'init', '--bare', '-q', remote);
git(home, 'clone', '-q', remote, dev);
writeFileSync(join(dev, '.gitignore'), 'node_modules/\n');
writeFileSync(join(dev, 'a.txt'), 'one\n');
git(dev, 'add', '.'); git(dev, 'commit', '-qm', 'first'); git(dev, 'push', '-q', 'origin', 'main');
git(home, 'clone', '-q', remote, app);
mkdirSync(join(app, 'node_modules')); // deps "installed": no npm ci unless the lockfile changes
const commit = (file, text, msg) => { writeFileSync(join(dev, file), text); git(dev, 'add', '.'); git(dev, 'commit', '-qm', msg); git(dev, 'push', '-q'); };

test('up to date, and not a checkout: no update', async () => {
  assert.equal(await checkForUpdate(app), null);
  assert.equal(await checkForUpdate(home), null);
  assert.equal((await runUpdate(home)).ok, false);
});

test('behind upstream: counts commits, pulls, lists what changed', async () => {
  commit('a.txt', 'two\n', 'second');
  commit('b.txt', 'b\n', 'third');
  const u = await checkForUpdate(app);
  assert.equal(u.behind, 2);
  assert.equal(u.dirty, false);
  assert.equal(u.upstream, git(dev, 'rev-parse', 'HEAD'));
  const before = git(app, 'rev-parse', 'HEAD');
  const r = await runUpdate(app);
  assert.equal(r.ok, true);
  assert.equal(r.from, before);
  assert.equal(readFileSync(join(app, 'a.txt'), 'utf8'), 'two\n');
  assert.deepEqual(changesSince(r.from, app), ['third', 'second']);
  assert.equal(await checkForUpdate(app), null);
});

test('local edits are reported as dirty; a conflicting pull fails without merging', async () => {
  commit('a.txt', 'three\n', 'fourth');
  writeFileSync(join(app, 'a.txt'), 'local edit\n');
  const u = await checkForUpdate(app);
  assert.equal(u.dirty, true);
  const r = await runUpdate(app);
  assert.equal(r.ok, false);
  assert.match(r.message, /git pull failed/);
  assert.equal(readFileSync(join(app, 'a.txt'), 'utf8'), 'local edit\n');
  git(app, 'checkout', '--', 'a.txt');
});

test('diverged history: pull refuses instead of merging', async () => {
  writeFileSync(join(app, 'c.txt'), 'local\n'); git(app, 'add', '.'); git(app, 'commit', '-qm', 'local');
  const u = await checkForUpdate(app);
  assert.equal(u.ahead, 1);
  assert.equal((await runUpdate(app)).ok, false);
});

test('auto-update defaults on, persists off/on in the config file', () => {
  assert.equal(reloadAutoUpdate(), true);
  setAutoUpdate(false);
  assert.equal(JSON.parse(readFileSync(CONFIG_FILE, 'utf8')).autoUpdate, false);
  assert.equal(reloadAutoUpdate(), false);
  setAutoUpdate(true);
  assert.equal(autoUpdateEnabled(), true);
});
