# agent-usage

Live Claude (Max/Pro) quota in the terminal, teamclaude-style, for every account you log into. Zero dependencies, Node >= 18.

```
agent-usage

> ● you@example.com (max 20x) · logged in · ok
  Session  [███░░░░░░░░░░░░░░░] 18% reset 2h47m
  Weekly   [██████░░░░░░░░░░░░] 34% reset 5d15h
  Fable    [████████░░░░░░░░░░] 42% reset 5d15h
  Extra    off
  Usage    375 req, 4.2m tok (local, 5h window)

  ○ alt@example.com (max 5x) · last seen 6h ago · last known · token expired
  Session  [░░░░░░░░░░░░░░░░░░] 0% window ended
  Weekly   [█████████░░░░░░░░░] 50% reset 2d
  Fable    [░░░░░░░░░░░░░░░░░░] 0% reset 6d21h (was reset)
  Data     from 5h ago

probe every 1m · ↑↓ select · enter switch · r probe now · q quit
```

## Multiple accounts

- Every account seen logged in is archived under `~/.local/state/agent-usage/accounts/<email>.json` (mode 600): its `claudeAiOauth` tokens, `oauthAccount` identity and last usage response. Nothing to configure — log into the second account once with `claude /login` while agent-usage runs (or run `agent-usage --once` afterwards) and it appears.
- Archived accounts render as gray cards below the active one. While their access token is still valid (~8h after last use) they are polled live; after that the card shows the last known numbers. Reset moments are applied locally: a 5h window whose reset has passed renders empty ("window ended"); weekly/Fable buckets render empty and the countdown rolls forward 7 days ("was reset").
- `↑/↓` + `Enter` (or `agent-usage --switch EMAIL`) makes that account the logged-in one: the archived `claudeAiOauth` replaces the one in the keychain (MCP tokens in the same blob are kept) and `~/.claude.json` `oauthAccount` is swapped. Only **new** `claude` sessions pick this up; running sessions keep their in-memory account and will write their own tokens back on their next refresh. The switch message shows how many `claude` processes are running.
- Claude Code rotates refresh tokens; the archive re-copies the active account's tokens every probe, so it stays current as long as agent-usage sees that account logged in. If a switch fails with `needs claude /login`, log into that account once the normal way.
- `agent-usage --accounts` lists the archive (token / refresh-token validity), `--forget EMAIL` deletes an entry.

## How it works

- OAuth token comes from the macOS keychain (`Claude Code-credentials`), falling back to `~/.claude/.credentials.json`. Nothing is written back; if the token expires, open `claude` once to refresh it.
- Quota comes from `GET https://api.anthropic.com/api/oauth/usage` — the same zero-spend endpoint Claude Code and teamclaude use. It never consumes message quota.
- `Fable` always gets a dedicated row (from the `weekly_scoped` limit); other scoped buckets (Sonnet/Opus) appear automatically if the plan exposes them.
- The endpoint is aggressively rate limited (HTTP 429, `retry-after: 0`, small sliding window per account). To stay under it, agent-usage and `~/.claude/statusline-command.sh` share one cache at `/tmp/.claude-usage-cache` (120s TTL): whoever fetched last writes, everyone else reads. agent-usage tags its writes with `_account` and ignores a cache belonging to another account; a switch deletes the cache. On 429 the last good response is shown with a `(cached Xm ago)` tag and the next network probe backs off 5→30 min (`r` forces a probe). The statusline also writes `/tmp/.claude-usage-cache.fail` and skips fetching for 5 min after any failure, so dozens of renders across sessions cannot keep the limit tripped.
- The `Usage` row is computed locally from `~/.claude/projects/**/*.jsonl`: assistant messages in the current 5h session window, deduped by requestId. Tokens = input + cache-writes + output (cache reads excluded). Files are read incrementally (byte offsets), so only the first probe scans history.

## Usage

```
agent-usage              # live: probe every 60s (r = probe now, q = quit)
agent-usage -i 30        # probe every 30s (min 30)
agent-usage --once       # print once and exit
agent-usage --json       # raw endpoint JSON
agent-usage --no-local   # skip the local transcript scan
agent-usage --accounts   # list archived accounts
agent-usage --switch EMAIL   # log Claude Code in as an archived account
agent-usage --forget EMAIL   # drop an archived account
```

Aliased in `~/.zshrc`:

```sh
alias agent-usage="node ~/Documents/agent-tooling/agent-usage/agent-usage.mjs"
```
