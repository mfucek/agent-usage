// The status panel: a `Claude` section (one card per account, the auto-switch
// line) and a `Codex` section (one card per account, the auto reset line).
// Identical rows on every card.
import { opts } from './cli.mjs';
import { CLAUDE_TOKEN_CACHE_MS, MSG_TTL_MS, VERSION, orderRank } from './config.mjs';
import { lastSwitchAt, listAccounts } from './archive.mjs';
import { box, fmtAge, fmtDur, gradientText, label, paint, pct, usageBar } from './format.mjs';
import { accountStatus, bankedCount, normalize, projectRows } from './usage.mjs';
import { autoEnabled, isDisabled, pickCandidate } from './auto.mjs';
import { codexAuthFromFile, codexKey, normalizeCodex, normalizeCodexCredits } from './codex.mjs';
import { codexName, listCodexAccounts } from './codex-accounts.mjs';
import { CODEX_AUTO_THRESHOLD, codexAutoEnabled } from './codex-auto.mjs';
import { autoUpdateEnabled } from './update.mjs';

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

// Codex cards: the logged-in account (auth.json) and the archived ones, in
// the same order rules as the Claude cards.
export function codexCardList(state) {
  if (opts.noCodex) return [];
  const activeKey = codexKey(state.codex?.auth);
  const all = listCodexAccounts();
  const card = (rec, active) => ({ kind: 'codex', key: rec.key, email: rec.email, active, rec, name: codexName(rec, all) });
  const cards = all.filter(r => r.key !== activeKey).map(r => card(r, false));
  if (activeKey) cards.unshift(card(all.find(r => r.key === activeKey) || { key: activeKey, email: state.codex.auth.email, plan: state.codex.auth.plan }, true));
  return cards.sort((a, b) => orderRank(a.email) - orderRank(b.email) || (a.active ? -1 : b.active ? 1 : 0));
}

// Everything the cursor can land on, top to bottom: the Claude cards, the
// auto-switch line, and the Codex cards and reset toggle (when present).
// `state.sel` indexes this.
export function rowList(state) {
  const rows = cardList(state).map(c => ({ kind: 'claude', ...c }));
  rows.push({ kind: 'auto' });
  const codex = codexCardList(state);
  if (codex.length) rows.push(...codex, { kind: 'codex-auto' });
  return rows;
}

export function render(state, now) {
  const L = [];
  const rows = rowList(state);
  if (state.sel > rows.length - 1) state.sel = rows.length - 1;
  const cursor = i => (!opts.once && !state.bannerSel && i === state.sel ? paint.cyan('>') : ' ');

  const title = `agent-usage v${VERSION}`;
  const probed = state.probedAt ? `probed ${fmtDur(now - state.probedAt)} ago` : 'probing…';
  const width = Math.max(40, process.stdout.columns || 80);
  const banner = updateBanner(state, width, now);
  if (banner.length) L.push(...banner, '');
  L.push(paint.bold('agent-usage') + paint.dim(` v${VERSION}`) + ' '.repeat(Math.max(1, width - title.length - probed.length - 1)) + paint.dim(probed));
  L.push('');
  const news = whatsNewCard(state, width, now);
  if (news.length) L.push(...news, '');
  L.push(paint.bold('Claude'));
  rows.forEach((r, i) => {
    if (r.kind === 'claude') { r.active ? renderActive(L, state, now, cursor(i)) : renderArchived(L, state, now, cursor(i), r); L.push(''); }
    else if (r.kind === 'auto') renderAutoSwitch(L, state, now, cursor(i));
    else if (r.kind === 'codex') {
      L.push('');
      if (rows[i - 1]?.kind !== 'codex') L.push(paint.bold('Codex'));
      r.active ? renderCodex(L, state, now, cursor(i), r) : renderCodexArchived(L, state, now, cursor(i), r);
    }
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
    L.push(paint.dim('↑↓ select · enter switch/toggle · u use reset · d disable · l login · r probe · q quit'));
  }
  return L.join('\n');
}

// ─── Self-update ─────────────────────────────────────────────────────────────
export const WHATS_NEW_MS = 2 * 60_000;
const whatsNewShown = (state, now) => !!state.whatsNew && now - state.whatsNew.at < WHATS_NEW_MS;
// Rainbow text and borders move: the TUI redraws ~10×/s while this is true.
export const animating = (state, now) => !!state.update || whatsNewShown(state, now);

// The buttons the update banner offers right now, left to right.
export const bannerButtons = () => (autoUpdateEnabled() ? ['update'] : ['update', 'auto']);

// "New update available" banner above the title (xfarm's design): focused by
// pressing ↑ on the first card, ←/→ pick a button, enter runs it.
function updateBanner(state, width, now) {
  const u = state.update;
  if (!u || opts.once) return [];
  const behind = paint.dim(`${u.behind} commit${u.behind === 1 ? '' : 's'} behind`);
  if (state.updating) return box([`✦ ${gradientText('UPDATING…', now)}  ${behind}`], width, paint.dim, now);
  const names = { update: '[ Update ]', auto: '[ Enable Auto-Update ]' };
  const ctas = bannerButtons().map((b, i) => (state.bannerSel && state.bannerBtn === i ? paint.reverse(paint.bold(names[b])) : paint.bold(names[b]))).join(' ');
  const why = u.dirty && autoUpdateEnabled() ? paint.dim(' · local changes, auto-update paused') : '';
  const left = `✦ ${gradientText('NEW UPDATE AVAILABLE', now)}  ${behind}${why}`;
  const gap = Math.max(1, width - 4 - visibleLen(left) - visibleLen(ctas));
  return box([`${left}${' '.repeat(gap)}${ctas}`], width, state.bannerSel ? paint.yellow : paint.dim, now);
}

// After a relaunch: what the update brought in, in a rainbow-bordered card.
// Gone after WHATS_NEW_MS or the first keypress.
function whatsNewCard(state, width, now) {
  if (!whatsNewShown(state, now) || opts.once) return [];
  const { changes } = state.whatsNew;
  const MAX = 6;
  const lines = [`✦ ${gradientText(`UPDATED TO v${VERSION}`, now)}  ${paint.dim(`${changes.length} change${changes.length === 1 ? '' : 's'}`)}`];
  for (const c of changes.slice(0, MAX)) lines.push(`  ${paint.dim('•')} ${c}`);
  if (changes.length > MAX) lines.push(paint.dim(`  … and ${changes.length - MAX} more`));
  return box(lines, width, 'rainbow', now);
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
  const full = row.percent >= 100 ? `  ${paint.alert(' ‼ ')}` : '';
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

// Running sessions, then `(+N)` for the subagents running inside them.
function sessionsValue(state, email, now) {
  const n = email === state.account.email ? state.sessions : 0;
  const handover = n && now - lastSwitchAt() < CLAUDE_TOKEN_CACHE_MS ? paint.yellow(` switching ≤${CLAUDE_TOKEN_CACHE_MS / 1000}s`) : '';
  const sub = n && state.subagents ? paint.dim(` (+${state.subagents})`) : '';
  return `${n}${sub}${handover}`;
}

function renderActive(L, state, now, cur) {
  const acct = state.account;
  const u = state.usage;
  const limited = state.error && /429/.test(state.error);
  let status;
  if (u) { const s = accountStatus(projectRows(u.rows, now)); status = STATUS_PAINT[s](s); }
  else status = limited ? paint.yellow('rate limited') : state.error ? paint.red('error') : paint.gray('probing…');
  const off = isDisabled(acct.email) ? paint.gray(' · disabled') : '';
  L.push(`${cur} ${paint.green('●')} ${paint.bold(paint.cyan(acct.email || 'unknown'))} ${paint.dim('· logged in ·')} ${status}${off}`);

  const tokExp = state.cred.expiresAt ? Date.parse(state.cred.expiresAt) || Number(state.cred.expiresAt) : null;
  if (state.activeRefresh) L.push(`  ${label('Token')} ${paint.yellow(state.activeRefresh)}`);
  else if (tokExp && tokExp <= now) L.push(`  ${label('Token')} ${paint.red('expired — press l to log in')}`);
  quotaRows(L, u, now, false);
  columnRows(L, [extraValue(u?.extra), resetsValue(u?.resets || state.resets, now), sessionsValue(state, acct.email, now)], false);
  if (limited) L.push(`  ${paint.dim(`rate limited — retrying in ${fmtDur(Math.max(0, (state.backoffUntil || 0) - now))}`)}`);
  else if (state.error) L.push(`  ${paint.red('probe error:')} ${state.error}`);
}

// Running Codex threads created by this account, then `(+N)` spawned subagents.
// An archived card can have some: they run in an app-server started before a switch.
function codexThreadsValue(state, key) {
  const c = state.codex?.threads?.get(key);
  if (!c) return '0';
  return `${c.sessions}${c.subagents ? paint.dim(` (+${c.subagents})`) : ''}`;
}

// The logged-in Codex (ChatGPT) account; `u` spends one of its banked reset
// credits, the auto use reset line acts on it.
function renderCodex(L, state, now, cur, c) {
  const cx = state.codex;
  const email = c.name || cx.usage?.email || cx.auth.email || 'codex';
  const nu = cx.usage ? normalizeCodex(cx.usage) : null;
  let status;
  if (nu) { const s = accountStatus(projectRows(nu.rows, now)); status = STATUS_PAINT[s](s); }
  else status = cx.error ? paint.red('error') : paint.gray('probing…');
  L.push(`${cur} ${paint.green('●')} ${paint.bold(paint.cyan(email))} ${paint.dim('· logged in ·')} ${status}`);
  if (cx.auth.expiresAt && cx.auth.expiresAt <= now) L.push(`  ${label('Token')} ${paint.yellow('expired — codex refreshes it on its next run')}`);
  if (nu) for (const row of projectRows(nu.rows, now)) L.push(quotaLine(row, now, false));
  else L.push(quotaLine({ label: 'Weekly', percent: null }, now, false));
  columnRows(L, [paint.gray('–'), resetsValue(cx.credits ? normalizeCodexCredits(cx.credits, now) : null, now), codexThreadsValue(state, c.key)], false);
  if (cx.error) L.push(`  ${paint.red('probe error:')} ${cx.error}`);
}

// An archived Codex account: last known numbers, kept fresh by its own
// polls; Enter writes it into auth.json.
function renderCodexArchived(L, state, now, cur, c) {
  const rec = c.rec;
  const o = state.codexOthers?.get(c.key) || {};
  const exp = codexAuthFromFile(rec.authFile)?.expiresAt || 0;
  let src;
  if (o.authDead) src = paint.red('needs login');
  else if (o.live) src = paint.green('live');
  else src = paint.gray(exp > now ? 'last known' : 'last known · token expired');
  const seen = rec.seenAt ? paint.gray(fmtAge(now - rec.seenAt)) : paint.gray('?');
  L.push(`${cur} ${paint.gray('○')} ${paint.dim(c.name)} ${paint.dim('·')} ${seen} ${paint.dim('·')} ${src}`);
  const nu = rec.usage ? normalizeCodex(rec.usage) : null;
  if (nu?.rows.length) for (const row of projectRows(nu.rows, now)) L.push(quotaLine(row, now, true));
  else L.push(quotaLine({ label: 'Weekly', percent: null }, now, true));
  columnRows(L, [paint.gray('–'), resetsValue(rec.credits ? normalizeCodexCredits(rec.credits, now) : null, now), codexThreadsValue(state, c.key)], true);
  if (o.error && !o.live) L.push(`  ${paint.dim(`probe: ${o.error}`)}`);
}

// A disabled card is drawn as usual, then flattened to plain gray (the
// cursor keeps its colour).
const strip = s => String(s).replace(/\x1b\[[0-9;]*m/g, '');
function renderArchived(L, state, now, cur, c) {
  if (!isDisabled(c.email)) return renderCard(L, state, now, cur, c, false);
  const lines = [];
  renderCard(lines, state, now, ' ', c, true);
  lines.forEach((l, i) => L.push(i ? paint.gray(strip(l)) : `${cur} ${paint.gray(strip(l).slice(2))}`));
}

function renderCard(L, state, now, cur, c, disabled) {
  const rec = c.rec;
  const o = state.others.get(c.email) || {};
  const exp = Number(rec.oauth?.expiresAt) || 0;
  const rexp = Number(rec.oauth?.refreshTokenExpiresAt) || 0;
  let src;
  if (disabled) src = 'disabled';
  else if (o.authDead || (rexp && rexp < now)) src = paint.red('needs login');
  else if (o.live) src = paint.green('live');
  else src = paint.gray(exp > now ? 'last known' : 'last known · token expired');
  const seen = rec.seenAt ? paint.gray(fmtAge(now - rec.seenAt)) : paint.gray('?');
  L.push(`${cur} ${paint.gray('○')} ${paint.dim(c.email)} ${paint.dim('·')} ${seen} ${paint.dim('·')} ${src}`);

  const nu = rec.usage ? normalize(rec.usage) : null;
  quotaRows(L, nu, now, true);
  columnRows(L, [extraValue(nu?.extra), resetsValue(nu?.resets, now), sessionsValue(state, c.email, now)], true);
  if (o.authDead) return;
  if (o.parked) L.push(`  ${paint.dim('rate limited — paused, r retries')}`);
  else if (o.strikes && o.nextAt > now) L.push(`  ${paint.dim(`rate limited — retrying in ${fmtDur(o.nextAt - now)}`)}`);
  else if (o.error) L.push(`  ${paint.dim(`probe: ${o.error}`)}`);
}
