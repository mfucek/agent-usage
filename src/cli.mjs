// Argument parsing. Parsed once at import; every module reads `opts` from here.

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };

export const HELP = `agent-usage — live Claude quota in the terminal

usage: agent-usage [options]

  (no args)        live mode: re-probe every 60s
  -i, --interval N probe interval in seconds (min 30, default 60)
  -1, --once       print once and exit
  --json           print raw usage JSON (active account) and exit
  --no-local       skip local transcript scan (Usage row)
  --no-color       disable ANSI colors

accounts (archived under ~/.local/state/agent-usage/accounts/):
  --accounts       list archived accounts and exit
  --switch EMAIL   make EMAIL the logged-in Claude Code account and exit
  --forget EMAIL   delete EMAIL's archived tokens/usage and exit
  --login          log in via the browser (PKCE, like \`claude /login\`), archive
                   the account, make it the logged-in one, and exit

config (~/.config/agent-usage/config.json):
  { "order": ["a@x.com", "b@y.com"] }   fixed card order; others follow, newest first

live keys: ↑/↓ select account · enter switch · l login in browser · r probe now · q quit`;

export const opts = {
  help: has('-h') || has('--help'),
  once: has('-1') || has('--once'),
  json: has('--json'),
  noLocal: has('--no-local'),
  intervalMs: Math.max(30, Number(opt('-i', opt('--interval', 60))) || 60) * 1000,
  color: !has('--no-color') && !!process.stdout.isTTY && !process.env.NO_COLOR,
  accounts: has('--accounts'),
  login: has('--login'),
  switchTo: has('--switch') ? opt('--switch', '') : null,
  forget: has('--forget') ? opt('--forget', '') : null,
};
