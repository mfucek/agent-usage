// Self-update from git (ported from xfarm): the live TUI fetches upstream
// every few minutes, shows a banner when the checkout is behind, and pulls
// fast-forward only. Dependencies are reinstalled when the lockfile changed,
// then the TUI relaunches itself in the same terminal and lists what changed.
// Silent on every failure mode of the check (no git, no remote, no network,
// no upstream), so a tarball checkout never sees a spurious banner.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE, config } from './config.mjs';

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const UPDATE_CHECK_MS = 5 * 60_000;
// Set on the relaunched process: the commit we updated from, for "what's new".
export const UPDATED_FROM_ENV = 'AGENT_USAGE_UPDATED_FROM';

// Auto-update defaults to on, like xfarm; `"autoUpdate": false` turns it off.
// Re-read on every check so `agent-usage auto-update off` reaches a running TUI.
let enabled = config.autoUpdate !== false;
export const autoUpdateEnabled = () => enabled;
export function reloadAutoUpdate() {
  try { enabled = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')).autoUpdate !== false; }
  catch { /* no config file (default on), or a partial write: keep the last setting */ }
  return enabled;
}
export function setAutoUpdate(on) {
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) || {}; } catch { /* fresh config */ }
  cfg.autoUpdate = !!on;
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
  enabled = !!on;
  return enabled;
}

// Never rejects: { code, stdout }, code -1 on spawn error or timeout.
function run(cmd, args, timeoutMs, cwd) {
  return new Promise(resolve => {
    let child;
    try { child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { resolve({ code: -1, stdout: '' }); return; }
    let out = '';
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve({ code: -1, stdout: '' }); }, timeoutMs);
    child.stdout.on('data', b => { out += b; });
    child.on('error', () => { clearTimeout(t); resolve({ code: -1, stdout: '' }); });
    child.on('close', code => { clearTimeout(t); resolve({ code: code ?? -1, stdout: out }); });
  });
}
const git = (root, args, timeoutMs = 5_000) => run('git', args, timeoutMs, root);
const isCheckout = root => existsSync(join(root, '.git'));

// { behind, ahead, upstream, dirty } when upstream has commits we don't, else null.
export async function checkForUpdate(root = REPO_ROOT) {
  if (!isCheckout(root)) return null;
  if ((await git(root, ['fetch', '--quiet'], 15_000)).code !== 0) return null;
  const counts = await git(root, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
  if (counts.code !== 0) return null;
  const [ahead, behind] = counts.stdout.trim().split(/\s+/).map(Number);
  if (!Number.isFinite(behind) || behind <= 0) return null;
  const upstream = (await git(root, ['rev-parse', '@{u}'])).stdout.trim();
  // Tracked edits only: auto-update leaves a working copy someone is editing alone.
  const dirty = (await git(root, ['status', '--porcelain', '--untracked-files=no'])).stdout.trim() !== '';
  return { behind, ahead: ahead || 0, upstream, dirty };
}

// Fast-forward-only pull, then `npm ci` when package.json / the lockfile
// changed (or node_modules is missing). Refuses to merge or rebase, so local
// changes or divergent history give a clear error instead of a half-finished
// merge. Returns { ok, message, from } — `from` is the commit before the pull.
export async function runUpdate(root = REPO_ROOT) {
  if (!isCheckout(root)) return { ok: false, message: 'not a git checkout — reinstall with install.sh' };
  const from = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
  const pull = await git(root, ['pull', '--ff-only', '--quiet'], 60_000);
  if (pull.code === -1) return { ok: false, message: 'git pull timed out' };
  if (pull.code !== 0) return { ok: false, message: 'git pull failed (local changes or diverged from upstream)' };
  const deps = (await git(root, ['diff', '--name-only', from, 'HEAD', '--', 'package.json', 'package-lock.json'])).stdout.trim();
  if (deps || !existsSync(join(root, 'node_modules'))) {
    const npm = await run('npm', ['ci', '--no-audit', '--no-fund', '--silent'], 180_000, root);
    if (npm.code !== 0) return { ok: false, from, message: `pulled, but npm ci failed — run \`npm ci\` in ${root}` };
  }
  return { ok: true, from, message: 'updated' };
}

// Commit subjects between `from` and HEAD, newest first. Sync: runs once at startup.
export function changesSince(from, root = REPO_ROOT) {
  if (!from || !isCheckout(root)) return [];
  const r = spawnSync('git', ['log', '--no-merges', '--format=%s', `${from}..HEAD`], { cwd: root, encoding: 'utf8', timeout: 5_000 });
  return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [];
}

// Run the new code in this same terminal: the child inherits stdio and this
// process waits for it, so the user sees one continuous session. Call after
// the terminal is restored to cooked mode / the main screen.
export function relaunch(from) {
  const r = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: 'inherit', env: { ...process.env, [UPDATED_FROM_ENV]: from },
  });
  process.exit(r.status ?? 0);
}
