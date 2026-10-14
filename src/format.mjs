// ANSI painting and small formatters.
import { opts } from './cli.mjs';

export const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const wrap = code => v => opts.color ? `${ESC}${code}m${v}${RESET}` : String(v);

export const paint = {
  rgb: (r, g, b, v) => opts.color ? `${ESC}38;2;${r};${g};${b}m${v}${RESET}` : String(v),
  bold: wrap(1), dim: wrap(2), reverse: wrap(7), gray: wrap(90), green: wrap(32), yellow: wrap(33), red: wrap(31), cyan: wrap(36),
  alert: wrap('1;97;41'), // bold white on red
};

function gradientColor(i, width) {
  const t = width <= 1 ? 1 : i / (width - 1);
  const from = t < 0.5 ? [35, 209, 96] : [245, 185, 40];
  const to = t < 0.5 ? [245, 185, 40] : [239, 68, 68];
  const p = t < 0.5 ? t * 2 : (t - 0.5) * 2;
  return from.map((v, k) => Math.round(v + (to[k] - v) * p));
}

// Moving rainbow (from xfarm's update banner): hue shifts along the text and
// cycles every 4s, so callers redraw ~10×/s while one is on screen.
function rainbow(i, total, now) {
  const h = ((now / 4000) % 1 + (i / Math.max(1, total)) * 0.35) % 1;
  const s = 0.85, l = 0.62, a = s * Math.min(l, 1 - l);
  const f = n => { const k = (n + h * 12) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return [f(0), f(8), f(4)];
}
export const gradientText = (text, now) => [...text].map((ch, i, all) => paint.rgb(...rainbow(i, all.length, now), ch)).join('');

const visible = s => String(s).replace(/\x1b\[[0-9;]*m/g, '');
// A box `width` columns wide around `lines` (padded, truncated to fit). The
// border is `border` (a paint function), or a rainbow flowing around the
// perimeter when border is 'rainbow'.
export function box(lines, width, border = paint.dim, now = Date.now()) {
  const inner = Math.max(2, width - 4), horiz = width - 2;
  const ring = horiz * 2 + lines.length * 2;
  let n = 0;
  const b = s => border === 'rainbow' ? [...s].map(ch => paint.rgb(...rainbow(n++, ring, now), ch)).join('') : border(s);
  const fit = l => { const v = visible(l); return v.length > inner ? v.slice(0, inner - 1) + '…' : l + ' '.repeat(inner - v.length); };
  const out = [b(`┌${'─'.repeat(horiz)}┐`)];
  for (const l of lines) out.push(`${b('│')} ${fit(l)} ${b('│')}`);
  out.push(b(`└${'─'.repeat(horiz)}┘`));
  return out;
}

// Unknown value: a skeleton — dim ░ cells with a brightness wave sliding
// left to right, so "still loading" reads as motion instead of a question mark.
// Anyone rendering it should redraw ~10×/s (see skeletonShown()).
const SKELETON_STEP_MS = 90, SKELETON_PERIOD = 12;
let skeletonAt = 0;
export const skeletonShown = now => now - skeletonAt < 1000;
function skeleton(width, now) {
  skeletonAt = now;
  if (!opts.color) return `[${'░'.repeat(width)}]`;
  const phase = Math.floor(now / SKELETON_STEP_MS);
  let s = '';
  for (let i = 0; i < width; i++) {
    const t = ((i - phase) % SKELETON_PERIOD + SKELETON_PERIOD) % SKELETON_PERIOD / SKELETON_PERIOD;
    const v = Math.round(70 + 90 * (0.5 - 0.5 * Math.cos(2 * Math.PI * t))); // 70 → 160 → 70
    s += paint.rgb(v, v, v, '░');
  }
  return `[${s}]`;
}

export function usageBar(percent, width = 18, muted = false, now = Date.now()) {
  if (percent == null) return skeleton(width, now);
  const ratio = Math.max(0, Math.min(1, percent / 100));
  const full = Math.round(ratio * width);
  let fill = '';
  if (muted) fill = paint.rgb(150, 150, 150, '█'.repeat(full));
  else for (let i = 0; i < full; i++) { const [r, g, b] = gradientColor(i, width); fill += paint.rgb(r, g, b, '█'); }
  return `[${fill}${paint.gray('░'.repeat(width - full))}]`;
}

export const pct = v => (v == null ? '-' : `${Math.round(v)}%`);
// "Oct 22" — for use-by dates, where the day matters more than the countdown.
export const fmtDate = iso => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '?'; };
export const label = s => paint.dim(s.padEnd(8));

export function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}m`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

// Coarsest unit only: "18d", "5h", "12m" — for ages and use-by countdowns.
export const fmtAge = ms => fmtDur(ms).replace(/^(\d+[dhms]).*$/, '$1');

export function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), mm = m % 60;
  if (h < 24) return mm ? `${h}h${mm}m` : `${h}h`;
  const d = Math.floor(h / 24), hh = h % 24;
  return hh ? `${d}d${hh}h` : `${d}d`;
}
