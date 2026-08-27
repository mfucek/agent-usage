# agent-usage

Live Claude (Max/Pro) quota in the terminal, for every account you log into. Switch Claude Code between accounts with one keypress.

Zero dependencies. Node ≥ 18. macOS keychain or `.credentials.json`.

```
agent-usage

  ○ matija@example.com (max 20x) · last seen 4h ago · live
  Session  [██████████████████] 98% reset 1h2m
  Weekly   [███░░░░░░░░░░░░░░░] 16% reset 6d7h
  Fable    [███░░░░░░░░░░░░░░░] 16% reset 6d7h
  Extra    off
  Claude   no running sessions (local)
  Usage    0 req, 0 tok (local, 5h window)

> ● luka@example.com (max 20x) · logged in · ok
  Session  [████░░░░░░░░░░░░░░] 20% reset 2m
  Weekly   [█░░░░░░░░░░░░░░░░░] 8% reset 5d17h
  Fable    [███░░░░░░░░░░░░░░░] 14% reset 5d17h
  Extra    off
  Claude   7 running sessions (local)
  Usage    428 req, 6.2m tok (local, 5h window)

  ○ nino@example.com (max 20x) · last seen 1h ago · last known · token expired
  Session  [░░░░░░░░░░░░░░░░░░] 0% window ended
  Weekly   [█████████░░░░░░░░░] 50% reset 2d
  Fable    [░░░░░░░░░░░░░░░░░░] 0% reset 6d21h (was reset)
  Extra    off
  Claude   no running sessions (local)
  Usage    0 req, 0 tok (local, 5h window)
  Data     from 5h ago

probe every 1m · ↑↓ select · enter switch · l login · r probe now · q quit
```

## Install

```sh
git clone <this repo> ~/Documents/agent-tooling/agent-usage
echo 'alias agent-usage="node ~/Documents/agent-tooling/agent-usage/bin/agent-usage.mjs"' >> ~/.zshrc
# or: cd agent-usage && npm link
```

Optional: pin the card order in `~/.config/agent-usage/config.json`.

```json
{ "order": ["matija@example.com", "luka@example.com"] }
```

Cards keep that order no matter which account is logged in; accounts not listed follow, newest-seen first.

## Usage

```
agent-usage                  # live: probe every 60s
agent-usage -i 30            # probe every 30s (min 30)
agent-usage --once           # print once and exit
agent-usage --json           # endpoint JSON for the logged-in account (may come from the shared cache)
agent-usage --no-local       # skip the local transcript scan (Usage row)
agent-usage --no-color

agent-usage --accounts       # list archived accounts (token / refresh validity)
agent-usage --switch EMAIL   # make EMAIL the logged-in Claude Code account
agent-usage --forget EMAIL   # drop an archived account
agent-usage --login          # browser login (PKCE), archive + activate
```

Live keys: `↑/↓` (or `j/k`) select · `Enter` switch · `l` browser login · `r` probe now · `q` quit.

## The rows

Every card shows the same rows, logged in or not.

| Row | Source |
| --- | --- |
| **Session / Weekly / Fable** | `GET api.anthropic.com/api/oauth/usage` — the zero-spend endpoint Claude Code itself uses. Fable always gets a row (from the `weekly_scoped` limit); other scoped buckets (Sonnet, Opus) appear when the plan exposes them. Reset moments are applied locally: a 5h window whose reset has passed renders empty ("window ended"); weekly buckets render empty and the countdown rolls forward 7 days ("was reset"). |
| **Extra** | Extra-usage credits: off, or `%` of the monthly limit. |
| **Claude** | Running `claude` processes on this machine, refreshed every 2s. All of them count against the logged-in account (see [Switching](#switching)). |
| **Usage** | Local transcript usage in the current 5h window: assistant messages under `~/.claude/projects/**/*.jsonl`, deduped by `requestId`; tokens = input + cache writes + output (cache reads excluded). Attributed per account via the switch log. Files are read incrementally, so only the first probe scans history. |
| **Data** | Archived cards only: age of the last usage response when it is not live. |

Header: `●` logged in · plan · `ok` / `near limit` / `exhausted`, or `○` archived · plan · last seen · `live` / `last known` / `needs login — press l`.

## Multiple accounts

- Every account seen logged in is archived under `~/.local/state/agent-usage/accounts/<email>.json` (mode 600): its `claudeAiOauth` tokens, `oauthAccount` identity and last usage response. Nothing to configure — log into a second account with `claude /login` (or press `l`) while agent-usage runs and a card appears.
- Archived tokens are kept alive: within 30 min of expiry the access token is refreshed with the archived refresh token (rotated tokens are written back), and usage is polled once an hour. A card only falls back to "last known" when the refresh token itself is dead.
- The logged-in account's tokens are re-copied into the archive every probe, so a refresh performed by Claude Code (which rotates refresh tokens) is picked up within one interval. agent-usage refreshes the logged-in token itself only while no `claude` process is running, with Claude Code's own 5-minute expiry buffer and under its refresh lock (`~/.claude.lock`); otherwise the sessions do it and the `Token` row says so.
- Refresh requests send the same scope set Claude Code sends for claude.ai tokens (`user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload`), so a token stored with a narrower set gets widened by the server instead of frozen.

### Switching

`Enter` (or `--switch EMAIL`) writes the archived `claudeAiOauth` into the keychain item `Claude Code-credentials` (the MCP tokens in the same blob are kept) and swaps `oauthAccount` in `~/.claude.json`. The token is written as archived — if it has expired, the next `claude` request refreshes it (the archive keeps refresh tokens alive while agent-usage runs, so this is rare). A session that happens to rotate its own token in the same second can clobber the switch; press Enter again.

Running sessions follow. Claude Code re-reads the keychain before every API request (`getAnthropicClient` → `checkAndRefreshOAuthTokenIfNeeded` → `invalidateOAuthCacheIfDiskChanged`, through a 30s keychain cache), so every running `claude` is on the new account by its next request, at most 30s later — mid-turn, not at the end of it. A request already in flight finishes on the old account. During that window the `Claude` row shows `picking up this account (≤30s)`.

`~/.local/state/agent-usage/switch-log.jsonl` records when each account became the logged-in one (also when the switch happened outside agent-usage — `~/.claude.json` is watched every 2s). Local `Usage` is attributed by request timestamp against that log. On first run the log is seeded from the archive's last-seen times, so history before that is approximate.

## Playing nice with Claude Code

Everything that touches Claude Code's files mirrors what Claude Code does (checked against its source):

| | Claude Code | agent-usage |
| --- | --- | --- |
| Token store | keychain item `Claude Code-credentials` filtered by `-a $USER`; `.credentials.json` only when the keychain has nothing | same lookup; writes back to whichever store the blob was read from |
| `CLAUDE_CONFIG_DIR` | keychain service gets a `-<sha256[:8]>` suffix, `.claude.json` moves into the dir, legacy `.config.json` wins | same |
| `.claude.json` writes | `proper-lockfile` on `<file>.lock` | same lock (mkdir semantics, 10s stale) |
| Token refresh | lock on `<configDir>.lock`, re-check under the lock, 5-min buffer | same |
| `claudeAiOauth` fields | rewrites exactly `accessToken refreshToken expiresAt scopes subscriptionType rateLimitTier` | writes only those; `refreshTokenExpiresAt` lives in the archive |
| Login | `/api/oauth/profile` → `account.email`, `subscriptionType` from `organization.organization_type` | same |
| Running processes | — | `ps` for `claude` and `~/.local/share/claude/versions/*` (the native binary) |
| Transcript accounting | one line per content block, final usage on the last, `<synthetic>` excluded | dedup by `requestId` taking max, `<synthetic>` excluded |
| `CLAUDE_CODE_OAUTH_TOKEN` | sessions ignore the keychain | warns at startup that switching will not reach those sessions |

Not mirrored, on purpose: Claude Code's `/login` wipes the whole keychain blob (MCP tokens included) and every account-scoped cache; a switch here keeps `mcpOAuth` so Figma/Cloudflare/… stay logged in.

## Rate limits and the shared cache

The usage endpoint is aggressively rate limited (HTTP 429, `retry-after: 0`, small sliding window per account). agent-usage and `~/.claude/statusline-command.sh` share one cache at `/tmp/.claude-usage-cache` (120s TTL): whoever fetched last writes, everyone else reads. Writes are tagged with `_account` and a cache belonging to another account is ignored; a switch deletes it. On 429 the last good response is shown with `(cached Xm ago)` and the next network probe backs off 5 → 30 min (`r` forces one). `/tmp/.claude-usage-cache.fail` tells the statusline to skip fetching for 5 min after any failure.

## Layout

```
bin/agent-usage.mjs   entry
src/cli.mjs           argv → opts, help text
src/config.mjs        paths, endpoints, tunables, ~/.config/agent-usage/config.json
src/credentials.mjs   keychain / .credentials.json blob, oauthAccount in .claude.json
src/lock.mjs          proper-lockfile-compatible locks shared with Claude Code
src/archive.mjs       per-account archive + switch log
src/oauth.mjs         token refresh, browser PKCE login, profile
src/switch.mjs        switchTo / storeLogin
src/usage.mjs         usage endpoint, shared cache, normalisation
src/local.mjs         running claude processes, transcript scan
src/format.mjs        ANSI paint, bars, number/duration formatting
src/render.mjs        the cards
src/app.mjs           one-shot commands, probe loop, TUI
```

`npm run check` syntax-checks every module and runs one `--once` probe. Honors `CLAUDE_CONFIG_DIR` and `NO_COLOR`.
