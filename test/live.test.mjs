import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { mergeLive } from '../src/usage.mjs';

// The statusline's per-session files (see LIVE_DIR) folded into the logged-in
// card. Uses a temp dir; no account, keychain or network is touched.
const dir = mkdtempSync(join(tmpdir(), 'agent-usage-live-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const now = Date.parse('2026-10-08T16:00:00Z');
const H = 3600_000;
const iso = t => new Date(t).toISOString();
const sec = t => Math.round(t / 1000);
const WEEK = now + 5 * 24 * H;
const usage = (sess, week) => ({
  rows: [
    { label: 'Session', percent: sess, resetsAt: iso(now + 2 * H), window: 'session' },
    { label: 'Weekly', percent: week, resetsAt: iso(WEEK) },
    { label: 'Fable', percent: 30, resetsAt: iso(WEEK), dedicated: true },
  ],
  sessionResetsAt: iso(now + 2 * H),
});
const put = (name, five, seven, mtime = now) => {
  const p = join(dir, `${name}.json`);
  writeFileSync(p, JSON.stringify({ five_hour: five, seven_day: seven }));
  utimesSync(p, new Date(mtime), new Date(mtime));
};

test('higher live figure in the same window wins; Fable untouched', () => {
  put('a', { used_percentage: 70, resets_at: sec(now + 2 * H) }, { used_percentage: 25, resets_at: sec(WEEK + 60_000) });
  put('b', { used_percentage: 65, resets_at: sec(now + 2 * H) }, { used_percentage: 24, resets_at: sec(WEEK) });
  const m = mergeLive(usage(61, 20), now, 0, dir);
  assert.equal(m.rows[0].percent, 70);
  assert.equal(m.rows[1].percent, 25);
  assert.equal(m.rows[2].percent, 30);
});

test('a lower live figure never pulls the endpoint number down', () => {
  const u = usage(90, 40);
  assert.equal(mergeLive(u, now, 0, dir), u); // a/b say 70/25: endpoint is newer
});

test('a newer session window replaces an ended one', () => {
  const u = usage(100, 20);
  u.rows[0].resetsAt = iso(now - H);
  put('c', { used_percentage: 3, resets_at: sec(now + 4 * H) }, { used_percentage: 21, resets_at: sec(WEEK) });
  const m = mergeLive(u, now, 0, dir);
  assert.equal(m.rows[0].percent, 3);
  assert.equal(m.rows[0].resetsAt, iso(now + 4 * H));
  assert.equal(m.sessionResetsAt, iso(now + 4 * H));
});

test('another account (different weekly reset), stale files and pre-claim files are ignored', () => {
  for (const f of ['a', 'b', 'c']) rmSync(join(dir, `${f}.json`));
  put('other', { used_percentage: 99, resets_at: sec(now + 2 * H) }, { used_percentage: 99, resets_at: sec(WEEK + 2 * 24 * H) });
  put('old', { used_percentage: 99, resets_at: sec(now + 2 * H) }, { used_percentage: 99, resets_at: sec(WEEK) }, now - 6 * H);
  put('preclaim', { used_percentage: 99, resets_at: sec(now + 2 * H) }, { used_percentage: 99, resets_at: sec(WEEK) }, now - 60_000);
  const u = usage(10, 20);
  assert.equal(mergeLive(u, now, now - 30_000, dir), u);
  assert.equal(mergeLive(null, now, 0, dir), null);
});
