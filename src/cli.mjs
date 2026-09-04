// Argument parsing. Parsed once at import; every module reads `opts` from here.

const argv = process.argv.slice(2);

// Subcommand sugar: `agent-usage list`, `agent-usage select <email>`, … map
// onto the flags below so scripts get a non-TUI interface without the dashes.
const SUB_FLAG = { list: 'accounts', accounts: 'accounts', login: 'login', status: 'once', json: 'json', whoami: 'whoami', current: 'whoami', help: 'help' };
const SUB_ARG = { select: 'switchTo', switch: 'switchTo', forget: 'forget', auto: 'auto' };
const sub = {};
if (argv[0] && !argv[0].startsWith('-')) {
  const cmd = argv.shift();
  if (SUB_FLAG[cmd]) sub[SUB_FLAG[cmd]] = true;
  else if (SUB_ARG[cmd]) sub[SUB_ARG[cmd]] = argv.shift() ?? '';
  else { console.error(`agent-usage: unknown command '${cmd}' — try \`agent-usage help\``); process.exit(2); }
}

const has = f => argv.includes(f);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };

export const HELP = `agent-usage — live Claude quota in the terminal

usage: agent-usage [command] [options]

  (no args)        live mode (TUI): re-probe every 60s

commands (one-shot, script-friendly):
  list             list archived accounts + session usage and exit
  select EMAIL     make EMAIL the logged-in Claude Code account
                   (EMAIL may be any unique substring, e.g. \`select nino\`)
  whoami           print the logged-in account's email
  status           print the dashboard once and exit
  json             print raw usage JSON (active account) and exit
  login            log in via the browser (PKCE, like \`claude /login\`), archive
                   the account, make it the logged-in one, and exit
  forget EMAIL     delete EMAIL's archived tokens/usage
  auto [on|off]    show or set auto-switch: at 90% session usage the live TUI
                   switches to the account with session <90%, Fable <90%, and
                   the nearest session reset (acts only while the TUI runs)

options:
  -i, --interval N probe interval in seconds (min 30, default 60)
  -1, --once       print once and exit
  --json           print raw usage JSON (active account) and exit
  --no-local       skip local transcript scan (Usage row)
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

live keys: ↑/↓ select account · enter switch (or toggle auto-switch) · l login in browser · r probe now · q quit`;

export const opts = {
  help: has('-h') || has('--help') || !!sub.help,
  once: has('-1') || has('--once') || !!sub.once,
  json: has('--json') || !!sub.json,
  noLocal: has('--no-local'),
  intervalMs: Math.max(30, Number(opt('-i', opt('--interval', 60))) || 60) * 1000,
  color: !has('--no-color') && !!process.stdout.isTTY && !process.env.NO_COLOR,
  accounts: has('--accounts') || !!sub.accounts,
  login: has('--login') || !!sub.login,
  whoami: !!sub.whoami,
  switchTo: sub.switchTo ?? (has('--switch') ? opt('--switch', '') : null),
  forget: sub.forget ?? (has('--forget') ? opt('--forget', '') : null),
  auto: sub.auto ?? null,
};
