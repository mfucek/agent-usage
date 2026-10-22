// Argument parsing. Parsed once at import; every module reads `opts` from here.

const argv = process.argv.slice(2);

// Subcommand sugar: `agent-usage list`, `agent-usage select <email>`, … map
// onto the flags below so scripts get a non-TUI interface without the dashes.
const SUB_FLAG = { list: 'accounts', accounts: 'accounts', status: 'once', json: 'json', whoami: 'whoami', current: 'whoami', help: 'help', update: 'update' };
const SUB_ARG = { login: 'login', select: 'switchTo', switch: 'switchTo', forget: 'forget', auto: 'auto', 'auto-reset': 'autoReset', 'auto-update': 'autoUpdate', reset: 'reset' };
const sub = {};
if (argv[0] && !argv[0].startsWith('-')) {
  const cmd = argv.shift();
  if (SUB_FLAG[cmd]) sub[SUB_FLAG[cmd]] = true;
  else if (SUB_ARG[cmd]) sub[SUB_ARG[cmd]] = argv[0] && !argv[0].startsWith('-') ? argv.shift() : ''; // a flag is not the argument
  else { console.error(`agent-usage: unknown command '${cmd}' — try \`agent-usage help\``); process.exit(2); }
}

const has = f => argv.includes(f);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };

export const HELP = `agent-usage — live Claude + Codex quota in the terminal

usage: agent-usage [command] [options]

  (no args)        live mode (TUI): re-probe every 60s

commands (one-shot, script-friendly):
  list             list archived accounts (Claude and Codex) + usage and exit
  select EMAIL     make EMAIL the logged-in Claude Code account
                   (EMAIL may be any unique substring, e.g. \`select nino\`)
  select codex:EMAIL make EMAIL the logged-in Codex account (writes auth.json)
  whoami           print the logged-in account's email
  status           print the dashboard once and exit
  json             print raw usage JSON (active account) and exit
  login            log in via the browser (PKCE, like \`claude /login\`), archive
                   the account, make it the logged-in one, and exit
  login codex      add a Codex account (runs \`codex login\` in a throwaway
                   CODEX_HOME); it becomes the logged-in one only when no
                   Codex account is logged in yet
  forget EMAIL     delete EMAIL's archived tokens/usage (codex:EMAIL for Codex)
  auto [on|off]    show or set auto-switch: at 90% session usage the live TUI
                   switches to the account with session <90%, Fable <90%, and
                   the nearest session reset (acts only while the TUI runs)
  reset TARGET     spend one banked limit reset now. TARGET is a Claude account
                   email (or unique substring), \`codex\` (the logged-in Codex
                   account) or \`codex:EMAIL\`. No confirmation.
  auto-reset [on|off] show or set Codex auto use reset: usage >=95% and that
                   window's reset >=1 day away (checks every 30s in live mode;
                   setting changes also apply to an already-running TUI)
  update           pull the latest version from GitHub now (fast-forward only;
                   reinstalls dependencies when the lockfile changed)
  auto-update [on|off] show or set auto-update (default on): live mode checks
                   GitHub every 5 min, pulls, and restarts itself in place

options:
  -i, --interval N probe interval in seconds (min 30, default 60)
  -1, --once       print once and exit
  --json           print raw usage JSON (active account) and exit
  --no-codex       hide the Codex (ChatGPT) card
  --no-color       disable ANSI colors

flag aliases (same as the commands above; archived under
~/.local/state/agent-usage/accounts/):
  --accounts       list archived accounts and exit
  --switch EMAIL   make EMAIL the logged-in Claude Code account and exit
  --forget EMAIL   delete EMAIL's archived tokens/usage and exit
  --login          browser login, archive, activate, exit

config (~/.config/agent-usage/config.json):
  { "order": ["a@x.com", "b@y.com"] }   fixed card order; others follow, newest first
  { "autoSwitch": true }                auto-switch on (the TUI toggle writes this)
  { "autoThreshold": 90 }               auto-switch trigger/eligibility percent
  { "codexAutoReset": true }            Codex auto use reset on (default off)
  { "autoUpdate": false }               auto-update off (default on)

live keys: ↑/↓ select · enter switch (or toggle automation) · u use a banked reset on the
selected card (press twice) · l login in browser (asks: c Claude / x Codex) · r probe now · q quit
update banner: ↑ on the first card to focus it · ←/→ pick a button · enter run it`;

export const opts = {
  help: has('-h') || has('--help') || !!sub.help,
  once: has('-1') || has('--once') || !!sub.once,
  json: has('--json') || !!sub.json,
  noCodex: has('--no-codex'),
  intervalMs: Math.max(30, Number(opt('-i', opt('--interval', 60))) || 60) * 1000,
  color: !has('--no-color') && !!process.stdout.isTTY && !process.env.NO_COLOR,
  accounts: has('--accounts') || !!sub.accounts,
  login: has('--login') || sub.login != null,
  loginProvider: sub.login || '',
  whoami: !!sub.whoami,
  switchTo: sub.switchTo ?? (has('--switch') ? opt('--switch', '') : null),
  forget: sub.forget ?? (has('--forget') ? opt('--forget', '') : null),
  auto: sub.auto ?? null,
  autoReset: sub.autoReset ?? null,
  reset: sub.reset ?? null,
  update: !!sub.update,
  autoUpdate: sub.autoUpdate ?? null,
};
