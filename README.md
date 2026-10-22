# agent-usage

Live Claude (Max/Pro) quota in the terminal, for every account you log into. Switch Claude Code between accounts with one keypress, spend a banked limit reset with another. Codex (ChatGPT) accounts get the same treatment: one card each, switch with Enter.

## Screenshot

```
┌─ agent-usage ──────────────────────────────────────────────────────────────┐
│ agent-usage                                                 probed 12s ago │
│                                                                            │
│ Claude                                                                     │
│   ○ matija@example.com · 4h · live                                         │
│   Session  [██████████████████] 98%  1h2m                                  │
│   Weekly   [███░░░░░░░░░░░░░░░] 16%  6d7h                                  │
│   Fable    [███░░░░░░░░░░░░░░░] 16%  6d7h                                  │
│            Extra      Resets       Sessions                                │
│            off        ⟲ –          0                                       │
│                                                                            │
│ > ● luka@example.com · logged in · ok                                      │
│   Session  [████░░░░░░░░░░░░░░] 20%  2m                                    │
│   Weekly   [█░░░░░░░░░░░░░░░░░]  8%  5d17h                                 │
│   Fable    [███░░░░░░░░░░░░░░░] 14%  5d17h                                 │
│            Extra      Resets       Sessions                                │
│            off        ⟲ 1 · 29d    7                                       │
│                                                                            │
│   ○ nino@example.com · 1h · last known · token expired                     │
│   Session  [░░░░░░░░░░░░░░░░░░]  0%  ended                                 │
│   Weekly   [█████████░░░░░░░░░] 50%  2d                                    │
│   Fable    [░░░░░░░░░░░░░░░░░░]  0%  6d21h (reset)                         │
│            Extra      Resets       Sessions                                │
│            off        ⟲ 1 · 29d    0                                       │
│                                                                            │
│   [x] auto-switch → matija                                                 │
│                                                                            │
│ Codex                                                                      │
│   ● matija@example.com · ok                                                │
│   Weekly   [░░░░░░░░░░░░░░░░░░]  0%  6d23h                                 │
│            Extra      Resets       Sessions                                │
│            –          ⟲ 3 · 10d    1                                       │
│                                                                            │
│   [ ] auto use reset · ≥95% · reset ≥1d away                               │
│                                                                            │
│ ↑↓ select · enter switch/toggle · u use reset · l login · r probe · q quit │
└────────────────────────────────────────────────────────────────────────────┘
```

`●` = logged in now, `○` = archived account, `>` = selected card. Bars are a green → yellow → red gradient, so a fuller bar reaches further into red.

## Install

**Requirements**

- Node.js ≥ 18 (`node --version`)
- Claude Code, logged in at least once (`claude /login`)
- macOS (tokens in the keychain) or Linux (tokens in `~/.claude/.credentials.json`)
- Optional: the Codex CLI, logged in with ChatGPT, for the Codex card

**One-liner** (clones to `~/.local/share/agent-usage`, runs `npm ci`, puts an `agent-usage` launcher in `~/.local/bin`):

```sh
curl -fsSL https://raw.githubusercontent.com/mfucek/agent-usage/main/install.sh | bash
```

Then:

1. Check it works: `agent-usage --once`. You should see one card for the account Claude Code is logged into.
2. Run the live dashboard: `agent-usage`.
3. Add more accounts: press `l` in the dashboard and pick `c` (Claude) or `x` (Codex) for a browser login, or run `claude /login` with another account while the dashboard is open. Each account gets its own card and stays there.

If the installer warns that `~/.local/bin` is not on your `PATH`, add `export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc` and open a new terminal.

**Manual install** (any directory you like):

```sh
git clone https://github.com/mfucek/agent-usage.git
cd agent-usage
npm ci
npm link        # or: alias agent-usage="node $PWD/bin/agent-usage.mjs"
```

**Update:** automatic while the dashboard runs (see [Updates](#updates)). By hand: `agent-usage update`, or re-run the installer.

**Uninstall:** `rm -rf ~/.local/share/agent-usage ~/.local/bin/agent-usage` (or `npm unlink -g agent-usage` and delete your checkout), and optionally `rm -rf ~/.local/state/agent-usage ~/.config/agent-usage` (archived account tokens and settings).

## Configuration

Optional: pin the card order in `~/.config/agent-usage/config.json`.

```json
{ "order": ["matija@example.com", "luka@example.com"], "otherInterval": 60 }
```

Cards keep that order no matter which account is logged in; accounts not listed follow, newest-seen first. `otherInterval` is how often (seconds) archived accounts are polled — default 3600, see [Multiple accounts](#multiple-accounts).

## Usage

```
agent-usage                  # live: probe every 60s
agent-usage -i 30            # probe every 30s (min 30)
agent-usage --once           # print once and exit
agent-usage --json           # endpoint JSON for the logged-in account (may come from the shared cache)
agent-usage --no-codex       # hide the Codex (ChatGPT) card
agent-usage --no-color

agent-usage list             # list archived accounts, Claude and Codex (token / refresh validity, session usage)
agent-usage select EMAIL     # make EMAIL the logged-in Claude Code account
agent-usage select codex:EMAIL # make EMAIL the logged-in Codex account (writes ~/.codex/auth.json)
agent-usage whoami           # print the logged-in account's email
agent-usage status           # print the dashboard once and exit (same as --once)
agent-usage json             # same as --json
agent-usage forget EMAIL     # drop an archived account (codex:EMAIL for a Codex one)
agent-usage login            # browser login (PKCE), archive + activate
agent-usage login codex      # add a Codex account (runs `codex login` in a throwaway CODEX_HOME)
agent-usage auto [on|off]    # show or set auto-switch (see below)
agent-usage reset EMAIL      # spend one banked limit reset on that Claude account (no confirmation)
agent-usage reset codex      # spend one Codex reset credit (logged-in Codex account)
agent-usage reset codex:EMAIL # spend one on that archived Codex account
agent-usage auto-reset [on|off] # show or set Codex auto use reset
agent-usage update           # pull the latest version now (see Updates)
agent-usage auto-update [on|off] # show or set auto-update (default on)
```

`select`/`forget` accept any unique substring of an archived email (`agent-usage select nino`, `agent-usage select codex:luka`). When one email has two ChatGPT workspaces (say personal and team), use the account id that `list` prints. The dashed forms (`--accounts`, `--switch EMAIL`, `--forget EMAIL`, `--login`) still work as aliases.

Live keys: `↑/↓` (or `j/k`) select · `Enter` switch (or toggle automation) · `u` use a banked reset on the selected card (press twice) · `d` disable/enable the selected Claude account for auto-switch · `l` browser login (then `c` Claude or `x` Codex; any other key cancels) · `r` probe now · `q` quit.

## Auto-switch

The line after the Claude cards is a toggle (also `agent-usage auto on|off`, persisted as `"autoSwitch"` in the config file):

```
> [x] auto-switch → matija
```

While the TUI is running, each probe checks the logged-in account; at ≥90% session or weekly usage it switches to the account with session <90%, weekly <90%, Fable <90%, a live refresh token, not disabled, and the **nearest session reset** (an idle account counts as a full 5h away). The name after the arrow is always who that would be (`none eligible` when nobody qualifies); `agent-usage auto` prints the same with the numbers. The threshold is `"autoThreshold"` in the config. Nothing switches when the TUI isn't running.

`d` on a Claude card disables that account: auto-switch never picks it, and its card turns gray with `disabled` where `live` / `last known` would be. It is still probed and `Enter` still switches to it by hand. `d` again re-enables it. Persisted as `"disabled": ["email", …]` in the config file.

## Codex auto use reset

Select the `auto use reset` line below the Codex card and press `Enter`, or run `agent-usage auto-reset on` to enable it. It defaults to off and persists as `"codexAutoReset": true` in the config file. `agent-usage auto-reset` shows the setting; `agent-usage auto-reset off` disables it. Running TUIs pick up setting changes on their next polling heartbeat (normally within a second, or when an in-flight probe finishes).

While live mode runs, a successful Codex probe automatically spends the soonest-expiring usable credit when **the same main usage window is at least 95% used and its reset is at least 24 hours away**. Both boundaries are inclusive. Usage and credits must both have been freshly fetched; missing credits, expired authentication, failed probes, or an active manual reset confirmation prevent an automatic claim. With automation enabled, Codex checks every **30 seconds** on its own timer, independently of Claude backoff, slow Claude probes, and `-i`. The toggle shows the next check countdown. With automation off it polls every 5 minutes; `r` probes immediately. Transient probe failures retry on the next 30-second check; server `Retry-After` delays are respected. Triggering depends on the usage endpoint reporting the threshold, so a sudden usage spike can still reach the limit between checks. Usage and credits refresh again after a claim, and the result appears in the dashboard.

Successful claims block duplicate spending for that high-usage window until a fresh snapshot shows recovery or a different reset date. Failed claims retry after 60 seconds (or a longer server `Retry-After`), using fresh usage and credit reads and only the **same still-usable credit**. An uncertain response keeps the same redemption request ID; a definite no-op gets a new request ID. If the credit disappears or is being redeemed, automation waits instead of spending another credit. This guard also covers manual resets and lasts for the live process. Automation does not run for `status`, `--once`, `json`, explicit `reset` commands, or with `--no-codex`.

## Updates

agent-usage updates itself from GitHub, the same way [xfarm](https://github.com/mfucek/xfarm) does. While the dashboard runs it checks the checkout's upstream every 5 minutes (`git fetch`). When there are new commits, a banner appears above the title:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ✦ NEW UPDATE AVAILABLE  2 commits behind   [ Update ] [ Enable Auto-Update ] │
└──────────────────────────────────────────────────────────────────────────────┘
```

Press `↑` on the first card to focus it, `←`/`→` to pick a button, `Enter` to run it. Updating pulls fast-forward only, runs `npm ci` when `package.json` or the lockfile changed, and restarts the dashboard in the same terminal. The restarted dashboard shows what came in, in a rainbow-bordered card that goes away on the first keypress:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ✦ UPDATED TO v2.1.0  2 changes                                               │
│   • Show plan name on each card                                              │
│   • Faster session polling                                                   │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Auto-update is on by default**: the dashboard pulls and restarts on its own, and the banner only flashes `UPDATING…`. It holds off while a reset claim or browser login is in flight, and never touches a checkout with uncommitted edits to tracked files (the banner then says `local changes, auto-update paused`; `[ Update ]` still tries). A pull that fails (diverged history, conflicts) is not retried until upstream moves again. Turn it off with `agent-usage auto-update off` or `{ "autoUpdate": false }` in the config file; the banner then offers `[ Enable Auto-Update ]`.

Checks are silent when the install is not a git checkout, has no upstream, or is offline. One-shot commands (`status`, `--once`, `json`, …) never check.

## The rows

Every card shows the same rows, logged in or not: three bars, then three columns.

| Row | Source |
| --- | --- |
| **Session / Weekly / Fable** | `GET api.anthropic.com/api/oauth/usage` — the zero-spend endpoint Claude Code itself uses. Fable always gets a row (from the `weekly_scoped` limit); other scoped buckets (Sonnet, Opus) appear when the plan exposes them. The number after the bar is the time to that bucket's reset. Reset moments are applied locally: a 5h window whose reset has passed renders empty (`ended`); weekly buckets render empty and the countdown rolls forward 7 days (`(reset)`). |
| **Extra** | Extra-usage credits: `off`, or `%` of the monthly limit. |
| **Resets** | Banked limit resets (see [Banked resets](#banked-resets)): `⟲ N · 29d` = N resets left, the soonest expiring in 29 days. `⟲ –` none; `⟲ ?` until the first probe that carries the block. |
| **Sessions** | Running `claude` processes on this machine, refreshed every 2s. All of them count against the logged-in account (see [Switching](#switching)). `3 (+7)` = 3 sessions with 7 subagents running inside them, read from the sessions' subagent transcripts. |

Header: `●` email · `logged in` · `ok` / `near limit` / `exhausted`, or `○` email · age since last logged in (gray, `18d`) · `live` / `last known` / `needs login`.

## Banked resets

Both vendors hand out "reset your limits now" tokens that sit in the account until used or expired. The `Resets` row shows them; `u` spends one.

**Claude.** The usage endpoint carries a `cedar_ember` block when asked for it (`?cedar_ember=1`) *and* when the request looks like Claude Code's (`x-app: cli` + its `User-Agent` decide the server-side surface; any other client gets `ineligible_reason: surface` and no grants). agent-usage sends those two headers on every usage probe, so every card gets the block. Each grant has `resets_left`, a use-by date (`ends_at`), the buckets it clears (`five_hour`, `seven_day`, …) and whether it is usable now or only while at a limit. This is the same data behind Claude Code's hidden `/limit-reset` command.

Spending one is Claude Code's own claim: `POST /api/organizations/<org>/reset_rate_limits` with `{ program: "cedar_ember", grant_id, request_id }`. The server answers `reset` (done — the row says what was cleared and how many are left), `not_limited` (the grant only works at a limit; nothing spent), `already_used`, `cooldown`, `ineligible` or `unavailable`; nothing is spent on any answer but `reset`. Afterwards the shared cache is dropped and the account re-probed, so the bars refresh within one interval.

The logged-in card can lag: a probe served from the shared cache (written by the statusline, which asks the plain endpoint) has no grant block, so the row keeps the last block agent-usage fetched itself, seeded from the archive at startup. `r` forces an own fetch. Archived cards always have it — they are only ever probed by agent-usage.

**Codex.** `GET chatgpt.com/backend-api/wham/rate-limit-reset-credits` lists the credits (`/codex/usage` only carries the count); each has an `expires_at` and is one full reset. `u` on the Codex card consumes the soonest-expiring one: `POST …/rate-limit-reset-credits/consume` with `{ credit_id, redeem_request_id }`. The server answers 200 either way — `windows_reset` > 0 means it happened, `code: no_credit` means nothing was spent. This is the only write agent-usage ever sends on the Codex side.

**In the TUI** the first `u` shows what would be spent and asks for a second `u` within 10 s; any other key cancels. The one-shot `agent-usage reset EMAIL|codex` skips the confirmation (it re-probes first so it acts on a fresh grant list).

## The Codex cards

When `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`) holds ChatGPT tokens, a Codex card shows its quota: `GET chatgpt.com/backend-api/codex/usage` — the endpoint `codex` itself polls for its rate-limit display — probed every 5 minutes (every 30 seconds with auto use reset enabled), together with the banked reset credits. Rows are the account's main rate-limit windows (a ≤6h window renders like a Session, a 7d one like Weekly; separately-metered extras like Spark are not shown), then the same columns as a Claude card: `Extra` (always `–`), `Resets`, and `Sessions` = Codex threads running a turn right now, `(+N)` for spawned subagents. Those are read from the rollout files in `~/.codex/sessions/`, not from processes, because T3 Code and the Codex app run many threads inside one `codex app-server`. Each thread counts under the account its last turn was billed to (the turn's rate-limit `resets_at` matches that account's usage window), so a thread still pinned to the previous account after a switch shows on that account's card. The logged-in token is never refreshed by agent-usage; the Codex CLI does that itself on its next run. Hide the section with `--no-codex`.

### Several Codex accounts

- Every Codex account seen in `auth.json` is archived under `~/.local/state/agent-usage/codex-accounts/<account id>.json` (mode 600): the whole `auth.json` as Codex wrote it, plus the last usage and credits. The one logged in when you first run this version is imported automatically.
- Add another with `l` → `x` (or `agent-usage login codex`). That runs `codex login` with a throwaway `CODEX_HOME`, so the account you are logged into stays put; the new one lands in the archive as a `○` card. It becomes the logged-in account only when no Codex account is logged in yet. Logging in with `codex login` yourself works too: the new account is picked up and the previous one stays archived.
- `Enter` on an archived card (or `select codex:EMAIL`) archives the current `auth.json` first, then writes the chosen account's file there. New `codex` processes use it. Codex pins the account per process, so threads inside an already-running `codex` or `codex app-server` (T3 Code, the Codex app) stay on the old account: they keep counting on the old card, and once their token needs a refresh they fail with "signed in to another account". Restart the app that runs them to move them over.
- Archived cards poll usage + credits every 5 minutes (jittered), each with its own token. Access tokens last about 10 days; an archived one is refreshed in its last 2 days with the Codex CLI's own refresh call (`auth.openai.com/oauth/token`, same client id and scope), under a per-account lock. The logged-in account is never refreshed by agent-usage. A rejected refresh shows `needs login`: log in to that account again with `l` → `x`.
- `u` works on any Codex card. Auto use reset only acts on the logged-in account.
- The same email can have two ChatGPT workspaces (personal and team); each is its own card, and the plan is shown next to the email to tell them apart.

## Multiple accounts

- Every account seen logged in is archived under `~/.local/state/agent-usage/accounts/<email>.json` (mode 600): its `claudeAiOauth` tokens, `oauthAccount` identity and last usage response. Nothing to configure — log into a second account with `claude /login` (or press `l`) while agent-usage runs and a card appears.
- Archived tokens are kept alive: within 30 min of expiry the access token is refreshed with the archived refresh token (rotated tokens are written back), and usage is polled once an hour by default — set `"otherInterval": 60` (seconds) in the config file to poll archived cards about once a minute. Each poll is jittered ±20% and runs on its own schedule, independent of `-i` and of the other accounts (each account has its own rate-limit budget). A card only falls back to "last known" when the refresh token itself is dead.
- The logged-in account's tokens are re-copied into the archive every probe, so a refresh performed by Claude Code (which rotates refresh tokens) is picked up within one interval. agent-usage refreshes the logged-in token itself only while no `claude` process is running, with Claude Code's own 5-minute expiry buffer and under its refresh lock (`~/.claude.lock`); otherwise the sessions do it and the `Token` row says so.
- Refresh requests send the same scope set Claude Code sends for claude.ai tokens (`user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload`), so a token stored with a narrower set gets widened by the server instead of frozen.

### Switching

`Enter` (or `--switch EMAIL`) writes the archived `claudeAiOauth` into the keychain item `Claude Code-credentials` (the MCP tokens in the same blob are kept) and swaps `oauthAccount` in `~/.claude.json`. The token is written as archived — if it has expired, the next `claude` request refreshes it (the archive keeps refresh tokens alive while agent-usage runs, so this is rare). A session that happens to rotate its own token in the same second can clobber the switch; press Enter again.

Running sessions follow. Claude Code re-reads the keychain before every API request (`getAnthropicClient` → `checkAndRefreshOAuthTokenIfNeeded` → `invalidateOAuthCacheIfDiskChanged`, through a 30s keychain cache), so every running `claude` is on the new account by its next request, at most 30s later — mid-turn, not at the end of it. A request already in flight finishes on the old account. During that window the `Claude` row shows `picking up this account (≤30s)`.

`~/.local/state/agent-usage/switch-log.jsonl` records when each account became the logged-in one (also when the switch happened outside agent-usage — `~/.claude.json` is watched every 2s).

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
| `CLAUDE_CODE_OAUTH_TOKEN` | sessions ignore the keychain | warns at startup that switching will not reach those sessions |

Not mirrored, on purpose: Claude Code's `/login` wipes the whole keychain blob (MCP tokens included) and every account-scoped cache; a switch here keeps `mcpOAuth` so Figma/Cloudflare/… stay logged in.

## Rate limits and the shared cache

The usage endpoint is aggressively rate limited (HTTP 429, `retry-after: 0`, small sliding window per account). agent-usage and `~/.claude/statusline-command.sh` share one cache at `/tmp/.claude-usage-cache` (120s TTL): whoever fetched last writes, everyone else reads. Writes are tagged with `_account` and a cache belonging to another account is ignored; a switch deletes it. On 429 the last good response is shown with `(cached Xm ago)` and the next network probe backs off 5 → 30 min (`r` forces one). `/tmp/.claude-usage-cache.fail` tells the statusline to skip fetching for 5 min after any failure.

Archived cards back off on their own: a 429 waits 5 → 10 → 30 min (a longer `retry-after` wins), and a fourth 429 in a row pauses the card — no more automatic polls. Only `r` asks a paused card again; a 429 there keeps it paused, a 200 resumes normal polling. Logging in to it, spending a reset on it, or a good response while it is the logged-in account also clears the pause. The state lives in `~/.local/state/agent-usage/poll-state.json`, so a restart keeps waiting.

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
src/local.mjs         running claude processes
src/codex.mjs         Codex usage, reset credits, auth.json parsing
src/codex-accounts.mjs Codex archive, switching, archived-token refresh, `codex login`
src/codex-auto.mjs    Codex auto reset setting, thresholds, repeat-claim guard
src/update.mjs        self-update: upstream check, ff-only pull + npm ci, relaunch
src/format.mjs        ANSI paint, bars, number/duration formatting
src/render.mjs        the cards
src/terminal.mjs      incremental physical-row repainting, ANSI/Unicode wrapping
src/app.mjs           one-shot commands, probe loop, TUI
```

`npm run check` syntax-checks every module and runs one `--once` probe. Honors `CLAUDE_CONFIG_DIR` and `NO_COLOR`.

`npm test` checks incremental painting in a headless terminal, Codex automatic resets (thresholds, persistence, fresh probes, and duplicate-claim protection), and self-update against throwaway git repos, using isolated files and mocked APIs. Live output rewrites only changed rows, batches updates with DEC 2026 synchronized-output markers, and clears the full screen only on initialization or resize. Long lines wrap at the terminal width; rows beyond the terminal height are clipped to prevent scrolling. Enlarge the window to see more rows.
