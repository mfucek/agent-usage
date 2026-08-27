// The status panel: one card per account, identical rows on every card.
import { opts } from './cli.mjs';
import { CLAUDE_TOKEN_CACHE_MS, MSG_TTL_MS, orderRank } from './config.mjs';
import { lastSwitchAt, listAccounts } from './archive.mjs';
import { planLabel } from './credentials.mjs';
import { fmtDur, fmtNum, label, paint, pct, usageBar } from './format.mjs';
import { accountStatus, normalize, projectRows } from './usage.mjs';

const PLACEHOLDER_ROWS = ['Session', 'Weekly', 'Fable'];
const STATUS_PAINT = { ok: paint.green, 'near limit': paint.yellow, exhausted: paint.red, unknown: paint.gray };

export function cardList(state) {
  const others = listAccounts().filter(r => r.email !== state.account.email);
  const cards = [{ email: state.account.email, active: true }, ...others.map(r => ({ email: r.email, active: false, rec: r }))];
  // listAccounts() is already ordered; the active card slots in by rank.
  return cards.sort((a, b) => orderRank(a.email) - orderRank(b.email) || (a.active ? -1 : b.active ? 1 : 0));
}
export const activeIndex = cards => Math.max(0, cards.findIndex(c => c.active));

export function render(state, now) {
  const L = [];
  const cards = cardList(state);
  if (state.sel >= cards.length) state.sel = cards.length - 1;
  const cursor = i => (!opts.once && i === state.sel ? paint.cyan('>') : ' ');

  L.push(paint.bold('agent-usage'));
  cards.forEach((c, i) => {
    L.push('');
    if (c.active) renderActive(L, state, now, cursor(i));
    else renderArchived(L, state, now, cursor(i), c);
  });

  if (!opts.once) {
    L.push('');
    if (state.msg && now - state.msgAt < MSG_TTL_MS) L.push(state.msg);
    L.push(paint.dim(`probe every ${fmtDur(opts.intervalMs)} · ↑↓ select · enter switch · l login · r probe now · q quit`));
  }
  return L.join('\n');
}

function quotaLine(row, now, muted = false) {
  const resetTs = row.resetsAt ? Date.parse(row.resetsAt) : null;
  let reset = resetTs && resetTs > now ? ` reset ${fmtDur(resetTs - now)}` : '';
  if (row.ended && row.window === 'session') reset = paint.gray(' window ended');
  else if (row.projected) reset = paint.gray(`${reset} (was reset)`);
  const p = row.percent == null ? paint.gray('n/a') : (muted ? paint.dim(pct(row.percent)) : pct(row.percent));
  return `  ${label(row.label)} ${usageBar(row.percent, 18, muted)} ${p}${reset}`;
}

function quotaRows(L, usage, now, muted) {
  if (usage) for (const row of projectRows(usage.rows, now)) L.push(quotaLine(row, now, muted));
  else for (const name of PLACEHOLDER_ROWS) L.push(quotaLine({ label: name, percent: null }, now, muted));
  const ex = usage?.extra;
  L.push(`  ${label('Extra')} ${!ex ? paint.gray('—') : ex.enabled ? `${pct(ex.percent)}${ex.limit != null ? paint.dim(` of ${ex.limit}`) : ''}` : paint.gray('off')}`);
}

// Machine-side rows every card shows, logged in or not.
function localRows(L, state, email, now) {
  const n = email === state.account.email ? state.sessions : 0;
  const handover = n && now - lastSwitchAt() < CLAUDE_TOKEN_CACHE_MS ? paint.yellow(` · picking up this account (≤${CLAUDE_TOKEN_CACHE_MS / 1000}s)`) : '';
  L.push(`  ${label('Claude')} ${n ? `${n} running session${n === 1 ? '' : 's'}` : paint.gray('no running sessions')}${paint.dim(' (local)')}${handover}`);
  if (!opts.noLocal) {
    const s = state.localBy.get(email) || { req: 0, tok: 0 };
    L.push(`  ${label('Usage')} ${s.req} req, ${fmtNum(s.tok)} tok${paint.dim(' (local, 5h window)')}`);
  }
}

function renderActive(L, state, now, cur) {
  const acct = state.account;
  const plan = planLabel(state.cred);
  const u = state.usage;
  const limited = state.error && /429/.test(state.error);
  const stale = u && state.error && state.usageAt ? paint.dim(` (cached ${fmtDur(now - state.usageAt)} ago)`) : '';
  let status;
  if (u) { const s = accountStatus(u.rows); status = STATUS_PAINT[s](s); }
  else status = limited ? paint.yellow('rate limited') : state.error ? paint.red('error') : paint.gray('probing…');
  L.push(`${cur} ${paint.green('●')} ${paint.bold(paint.cyan(acct.email || 'unknown'))}${plan ? paint.dim(` (${plan})`) : ''} ${paint.dim('· logged in ·')} ${status}${stale}`);

  const tokExp = state.cred.expiresAt ? Date.parse(state.cred.expiresAt) || Number(state.cred.expiresAt) : null;
  if (state.activeRefresh) L.push(`  ${label('Token')} ${paint.yellow(state.activeRefresh)}`);
  else if (tokExp && tokExp <= now) L.push(`  ${label('Token')} ${paint.red('expired — press l to log in')}`);
  quotaRows(L, u, now, false);
  localRows(L, state, acct.email, now);
  if (limited) L.push(`  ${paint.dim(`rate limited — retrying in ${fmtDur(Math.max(0, (state.backoffUntil || 0) - now))}`)}`);
  else if (state.error) L.push(`  ${paint.red('probe error:')} ${state.error}`);
}

function renderArchived(L, state, now, cur, c) {
  const rec = c.rec;
  const o = state.others.get(c.email) || {};
  const exp = Number(rec.oauth?.expiresAt) || 0;
  const rexp = Number(rec.oauth?.refreshTokenExpiresAt) || 0;
  let src;
  if (o.authDead || (rexp && rexp < now)) src = paint.red('needs login — press l');
  else if (o.live) src = paint.green('live');
  else src = paint.gray(exp > now ? 'last known' : 'last known · token expired');
  const seen = rec.seenAt ? paint.dim(`last seen ${fmtDur(now - rec.seenAt)} ago`) : '';
  const plan = planLabel(rec.oauth);
  L.push(`${cur} ${paint.gray('○')} ${paint.dim(c.email)}${plan ? paint.dim(` (${plan})`) : ''} ${paint.dim('·')} ${seen} ${paint.dim('·')} ${src}`);

  const nu = rec.usage ? normalize(rec.usage) : null;
  quotaRows(L, nu, now, true);
  localRows(L, state, c.email, now);
  if (nu && rec.usageAt && !o.live) L.push(`  ${label('Data')} ${paint.dim(`from ${fmtDur(now - rec.usageAt)} ago`)}`);
  if (o.error && !o.authDead) L.push(`  ${paint.dim(`probe: ${o.error}`)}`);
}
