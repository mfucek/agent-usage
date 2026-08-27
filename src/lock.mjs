// proper-lockfile-compatible locks, so we never write a file while a running
// `claude` is mid-write. Claude Code locks `<file>.lock` (a directory made with
// mkdir) around .claude.json writes and `<configDir>.lock` around token
// refresh; a lock older than 10s is considered stale.
import { mkdirSync, rmSync, statSync, utimesSync } from 'node:fs';

const STALE_MS = 10_000;
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function acquireLock(lockPath, { waitMs = 5000 } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try { mkdirSync(lockPath); return () => { try { rmSync(lockPath, { recursive: true, force: true }); } catch { /* gone */ } }; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let stale = false;
      try { stale = Date.now() - statSync(lockPath).mtimeMs > STALE_MS; } catch { continue; } // vanished: retry
      if (stale) { try { rmSync(lockPath, { recursive: true, force: true }); } catch { /* race */ } continue; }
      if (Date.now() >= deadline) throw new Error(`${lockPath} is held by another process`);
      sleepSync(50);
    }
  }
}

// Keep a long-held lock fresh so other processes do not treat it as stale.
export function touchLock(lockPath) { try { const now = new Date(); utimesSync(lockPath, now, now); } catch { /* gone */ } }

export function withLock(lockPath, fn, opts) {
  const release = acquireLock(lockPath, opts);
  try { return fn(); } finally { release(); }
}

export async function withLockAsync(lockPath, fn, opts) {
  const release = acquireLock(lockPath, opts);
  const keepalive = setInterval(() => touchLock(lockPath), STALE_MS / 3);
  try { return await fn(); } finally { clearInterval(keepalive); release(); }
}
