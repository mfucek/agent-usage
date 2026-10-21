// Auto-switch: when the logged-in session (or its weekly) hits the threshold,
// move to the eligible account whose session window resets soonest. Eligible =
// session, weekly and Fable all under the threshold, refresh token alive. An idle account (no
// active window) counts as a full 5h from reset — a fresh window starts on use.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CONFIG_FILE, FIVE_H, config } from './config.mjs';
import { listAccounts } from './archive.mjs';
import { normalize, projectRows } from './usage.mjs';

export const AUTO_THRESHOLD = Math.min(100, Number(config.autoThreshold) || 90);

let enabled = !!config.autoSwitch;
export const autoEnabled = () => enabled;
export function setAuto(on) {
  enabled = !!on;
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) || {}; } catch { /* fresh config */ }
  cfg.autoSwitch = enabled;
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
  return enabled;
}

// {sess, week, fable, tts} from a normalized usage snapshot, aged to `now`.
// tts = ms until the session window resets; idle/ended windows count as 5h.
export function usageSummary(u, now = Date.now()) {
  if (!u) return null;
  const rows = projectRows(u.rows, now);
  const s = rows.find(r => r.window === 'session');
  const w = rows.find(r => r.label === 'Weekly');
  const f = rows.find(r => r.label === 'Fable');
  const t = s?.resetsAt && !s.ended ? Date.parse(s.resetsAt) - now : null;
  return { sess: s?.percent ?? 0, week: w?.percent ?? 0, fable: f?.percent ?? 0, tts: t && t > 0 ? t : FIVE_H };
}

// The account we would (or will) switch to, from the archived snapshots.
// `others` is the TUI's live probe state when available (skips dead auth).
export function pickCandidate(activeEmail, others = new Map(), now = Date.now()) {
  const cands = [];
  for (const rec of listAccounts()) {
    if (rec.email.toLowerCase() === (activeEmail || '').toLowerCase()) continue;
    const rexp = Number(rec.oauth?.refreshTokenExpiresAt) || 0;
    if (rexp && rexp < now) continue;
    if (others.get(rec.email)?.authDead) continue;
    const s = rec.usage ? usageSummary(normalize(rec.usage), now) : null;
    if (!s) continue; // never probed: usage unknown, do not switch blind
    // A free session is useless once the weekly bucket is spent.
    if (s.sess < AUTO_THRESHOLD && s.week < AUTO_THRESHOLD && s.fable < AUTO_THRESHOLD) cands.push({ email: rec.email, ...s });
  }
  cands.sort((a, b) => a.tts - b.tts);
  return cands[0] || null;
}
