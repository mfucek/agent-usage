// ANSI painting and small formatters.
import { opts } from './cli.mjs';

export const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const wrap = code => v => opts.color ? `${ESC}${code}m${v}${RESET}` : String(v);

export const paint = {
  rgb: (r, g, b, v) => opts.color ? `${ESC}38;2;${r};${g};${b}m${v}${RESET}` : String(v),
  bold: wrap(1), dim: wrap(2), gray: wrap(90), green: wrap(32), yellow: wrap(33), red: wrap(31), cyan: wrap(36),
};

function gradientColor(i, width) {
  const t = width <= 1 ? 1 : i / (width - 1);
  const from = t < 0.5 ? [35, 209, 96] : [245, 185, 40];
  const to = t < 0.5 ? [245, 185, 40] : [239, 68, 68];
  const p = t < 0.5 ? t * 2 : (t - 0.5) * 2;
  return from.map((v, k) => Math.round(v + (to[k] - v) * p));
}

export function usageBar(percent, width = 18, muted = false) {
  if (percent == null) return `[${paint.gray('?'.repeat(width))}]`;
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
