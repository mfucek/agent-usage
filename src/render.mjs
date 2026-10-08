// The status panel: a `Claude` section (one card per account, the auto-switch
// line) and a `Codex` section (one card). Identical rows on every card.
import { opts } from './cli.mjs';
import { CLAUDE_TOKEN_CACHE_MS, MSG_TTL_MS, orderRank } from './config.mjs';
import { lastSwitchAt, listAccounts } from './archive.mjs';
import { fmtAge, fmtDur, label, paint, pct, usageBar } from './format.mjs';
import { accountStatus, bankedCount, normalize, projectRows } from './usage.mjs';
import { autoEnabled, pickCandidate } from './auto.mjs';
import { normalizeCodex, normalizeCodexCredits } from './codex.mjs';
import { CODEX_AUTO_THRESHOLD, codexAutoEnabled } from './codex-auto.mjs';

const PLACEHOLDER_ROWS = ['Session', 'Weekly', 'Fable'];
const STATUS_PAINT = { ok: paint.green, 'near limit': paint.yellow, exhausted: paint.red, unknown: paint.gray };
const GUTTER = ' '.repeat(11); // the columns sit under the bars, not under the row labels
const shortName = email => String(email || '').split('@')[0];

export function cardList(state) {
  const others = listAccounts().filter(r => r.email !== state.account.email);
  const cards = [{ email: state.account.email, active: true }, ...others.map(r => ({ email: r.email, active: false, rec: r }))];
  // listAccounts() is already ordered; the active card slots in by rank.
  return cards.sort((a, b) => orderRank(a.email) - orderRank(b.email) || (a.active ? -1 : b.active ? 1 : 0));
}
export const activeIndex = cards => Math.max(0, cards.findIndex(c => c.active));

// Everything the cursor can land on, top to bottom: the Claude cards, the
// auto-switch line, and the Codex card and reset toggle (when present).
// `state.sel` indexes this.
export function rowList(state) {
  const rows = cardList(state).map(c => ({ kind: 'claude', ...c }));
  rows.push({ kind: 'auto' });
  if (state.codex?.auth) rows.push({ kind: 'codex' }, { kind: 'codex-auto' });
  return rows;
}

export function render(state, now) {
  const L = [];
  const rows = rowList(state);
  if (state.sel > rows.length - 1) state.sel = rows.length - 1;
  const cursor = i => (!opts.once && i === state.sel ? paint.cyan('>') : ' ');

  const title = 'agent-usage';
  const probed = state.probedAt ? `probed ${fmtDur(now - state.probedAt)} ago` : 'probing…';
  const width = Math.max(40, process.stdout.columns || 80);
  L.push(paint.bold(title) + ' '.repeat(Math.max(1, width - title.length - probed.length - 1)) + paint.dim(probed));
  L.push('');
  L.push(paint.bold('Claude'));
  rows.forEach((r, i) => {
    if (r.kind === 'claude') { r.active ? renderActive(L, state, now, cursor(i)) : renderArchived(L, state, now, cursor(i), r); L.push(''); }
    else if (r.kind === 'auto') renderAutoSwitch(L, state, now, cursor(i));
    else if (r.kind === 'codex') { L.push(''); L.push(paint.bold('Codex')); renderCodex(L, state, now, cursor(i)); }
    else if (r.kind === 'codex-auto') {
      const on = codexAutoEnabled();
      L.push('');
      L.push(`${cursor(i)} ${on ? paint.green('[x]') : paint.dim('[ ]')} auto use reset · ≥${CODEX_AUTO_THRESHOLD}% · reset ≥1d away`);
      if (on && !opts.once) L.push(paint.dim(`      next check ${fmtDur(Math.max(0, (state.codex.nextProbeAt || now) - now))}`));
    }
  });

  if (!opts.once) {
    L.push('');
    if (state.msg && now - state.msgAt < MSG_TTL_MS) { L.push(...messageBox(state.msg, width)); L.push(''); }
    L.push(paint.dim('↑↓ select · enter switch/toggle · u use reset · l login · r probe · q quit'));
  }
  return L.join('\n');
}

// A one-off message (switch done, reset used, error…) in a box whose border
// takes the message's own colour: the first SGR colour code in the text, or
// dim when it has none. Long messages wrap on spaces inside the box.
function messageBox(msg, width) {
  const m = /\x1b\[(3[1-7]|9[0-7])m/.exec(msg);
  const border = m ? (v => (opts.color ? `\x1b[${m[1]}m${v}\x1b[0m` : String(v))) : paint.dim;
  const inner = Math.max(20, width - 4);
  const lines = [];
  let cur = '';
  for (const word of msg.split(' ')) {
    if (cur && visibleLen(cur) + 1 + visibleLen(word) > inner) { lines.push(cur); cur = word; }
    else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) lines.push(cur);
  const bar = '─'.repeat(inner + 2);
  return [
    border(`┌${bar}┐`),
    ...lines.map(l => `${border('│')} ${padCol(l, inner)} ${border('│')}`),
    border(`└${bar}┘`),
  ];
}

function renderAutoSwitch(L, state, now, cur) {
  const on = autoEnabled();
  const c = pickCandidate(state.account.email, state.others, now);
  const text = `auto-switch → ${c ? shortName(c.email) : 'none eligible'}`;
  L.push(`${cur} ${on ? paint.green('[x]') : paint.dim('[ ]')} ${on ? text : paint.dim(text)}`);
}

function quotaLine(row, now, muted = false) {
  const resetTs = row.resetsAt ? Date.parse(row.resetsAt) : null;
  let reset = resetTs && resetTs > now ? `  ${fmtDur(resetTs - now)}` : '';
  if (row.ended && row.window === 'session') reset = paint.gray('  ended');
  else if (row.projected) reset = paint.gray(`${reset} (reset)`);
  const p = row.percent == null ? paint.gray('  –') : (muted ? paint.dim(pct(row.percent).padStart(3)) : pct(row.percent).padStart(3));
  const full = row.percent >= 100 ? `  ${paint.red('exhausted')}` : '';
  return `  ${label(row.label)} ${usageBar(row.percent, 18, muted, now)} ${p}${reset}${full}`;
}

// Bars, then the three columns: Extra · Resets · Sessions.
function quotaRows(L, usage, now, muted) {
  if (usage) for (const row of projectRows(usage.rows, now)) L.push(quotaLine(row, now, muted));
  else for (const name of PLACEHOLDER_ROWS) L.push(quotaLine({ label: name, percent: null }, now, muted));
}

// `Resets` value: ⟲ N · <time until the soonest use-by>, or ⟲ – for none,
// ⟲ ? until the block has been fetched.
function resetsValue(resets, now) {
  if (!resets) return paint.gray('⟲ ?');
  const n = bankedCount(resets, now);
  if (!n) return paint.gray('⟲ –');
  const soonest = resets.grants.filter(g => g.left > 0 && g.endsAt && Date.parse(g.endsAt) > now).map(g => Date.parse(g.endsAt)).sort()[0];
  return `⟲ ${n}${soonest ? paint.dim(' · ') + fmtAge(soonest - now) : ''}`;
}

function extraValue(ex) {
  if (!ex) return paint.gray('–');
  if (!ex.enabled) return paint.gray('off');
  return `${pct(ex.percent)}${ex.limit != null ? paint.dim(` of ${ex.limit}`) : ''}`;
}

// Two lines: dim labels, then values, under the bars. Column widths are fixed
// so cards line up with each other.
const COLS = [['Extra', 11], ['Resets', 13], ['Sessions', 0]];
const visibleLen = s => String(s).replace(/\x1b\[[0-9;]*m/g, '').length;
const padCol = (s, w) => s + ' '.repeat(Math.max(0, w - visibleLen(s)));
function columnRows(L, values, muted) {
  const lab = COLS.map(([name, w]) => padCol(name, w)).join('');
  L.push(`${GUTTER}${paint.dim(lab)}`);
  L.push(`${GUTTER}${COLS.map(([, w], i) => padCol(muted ? paint.dim(values[i]) : values[i], w)).join('')}`);
}

function sessionsValue(state, email, now) {
  const n = email === state.account.email ? state.sessions : 0;
  const handover = n && now - lastSwitchAt() < CLAUDE_TOKEN_CACHE_MS ? paint.yellow(` switching ≤${CLAUDE_TOKEN_CACHE_MS / 1000}s`) : '';
  return `${n}${handover}`;
}

function renderActive(L, state, now, cur) {
  const acct = state.account;
  const u = state.usage;
  const limited = state.error && /429/.test(state.error);
  let status;
  if (u) { const s = accountStatus(projectRows(u.rows, now)); status = STATUS_PAINT[s](s); }
  else status = limited ? paint.yellow('rate limited') : state.error ? paint.red('error') : paint.gray('probing…');
  L.push(`${cur} ${paint.green('●')} ${paint.bold(paint.cyan(acct.email || 'unknown'))} ${paint.dim('· logged in ·')} ${status}`);

  const tokExp = state.cred.expiresAt ? Date.parse(state.cred.expiresAt) || Number(state.cred.expiresAt) : null;
  if (state.activeRefresh) L.push(`  ${label('Token')} ${paint.yellow(state.activeRefresh)}`);
  else if (tokExp && tokExp <= now) L.push(`  ${label('Token')} ${paint.red('expired — press l to log in')}`);
  quotaRows(L, u, now, false);
  columnRows(L, [extraValue(u?.extra), resetsValue(u?.resets || state.resets, now), sessionsValue(state, acct.email, now)], false);
  if (limited) L.push(`  ${paint.dim(`rate limited — retrying in ${fmtDur(Math.max(0, (state.backoffUntil || 0) - now))}`)}`);
  else if (state.error) L.push(`  ${paint.red('probe error:')} ${state.error}`);
}

// The Codex (ChatGPT) card: one account, no switching; selectable so `u` can
// spend one of its banked reset credits.
function renderCodex(L, state, now, cur) {
  const cx = state.codex;
  const email = cx.usage?.email || cx.auth.email || 'codex';
  const nu = cx.usage ? normalizeCodex(cx.usage) : null;
  let status;
  if (nu) { const s = accountStatus(projectRows(nu.rows, now)); status = STATUS_PAINT[s](s); }
  else status = cx.error ? paint.red('error') : paint.gray('probing…');
  L.push(`${cur} ${paint.green('●')} ${paint.bold(paint.cyan(email))} ${paint.dim('·')} ${status}`);
  if (cx.auth.expiresAt && cx.auth.expiresAt <= now) L.push(`  ${label('Token')} ${paint.yellow('expired — codex refreshes it on its next run')}`);
  if (nu) for (const row of projectRows(nu.rows, now)) L.push(quotaLine(row, now, false));
  else L.push(quotaLine({ label: 'Weekly', percent: null }, now, false));
  columnRows(L, [paint.gray('–'), resetsValue(cx.credits ? normalizeCodexCredits(cx.credits, now) : null, now), String(cx.sessions)], false);
  if (cx.error) L.push(`  ${paint.red('probe error:')} ${cx.error}`);
}

function renderArchived(L, state, now, cur, c) {
  const rec = c.rec;
  const o = state.others.get(c.email) || {};
  const exp = Number(rec.oauth?.expiresAt) || 0;
  const rexp = Number(rec.oauth?.refreshTokenExpiresAt) || 0;
  let src;
  if (o.authDead || (rexp && rexp < now)) src = paint.red('needs login');
  else if (o.live) src = paint.green('live');
  else src = paint.gray(exp > now ? 'last known' : 'last known · token expired');
  const seen = rec.seenAt ? paint.gray(fmtAge(now - rec.seenAt)) : paint.gray('?');
  L.push(`${cur} ${paint.gray('○')} ${paint.dim(c.email)} ${paint.dim('·')} ${seen} ${paint.dim('·')} ${src}`);

  const nu = rec.usage ? normalize(rec.usage) : null;
  quotaRows(L, nu, now, true);
  columnRows(L, [extraValue(nu?.extra), resetsValue(nu?.resets, now), sessionsValue(state, c.email, now)], true);
  if (o.error && !o.authDead) L.push(`  ${paint.dim(`probe: ${o.error}`)}`);
}
