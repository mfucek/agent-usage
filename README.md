# agent-usage

Live Claude (Max/Pro) quota in the terminal, teamclaude-style. Zero dependencies, Node >= 18.

```
agent-usage
Account      you@example.com (max 20x)

> Claude Code (oauth) active
  Session  [███░░░░░░░░░░░░░░░] 18% reset 2h47m
  Weekly   [██████░░░░░░░░░░░░] 34% reset 5d15h
  Fable    [████████░░░░░░░░░░] 42% reset 5d15h
  Extra    off
  Usage    375 req, 4.2m tok (local, 5h window)
```

## How it works

- OAuth token comes from the macOS keychain (`Claude Code-credentials`), falling back to `~/.claude/.credentials.json`. Nothing is written back; if the token expires, open `claude` once to refresh it.
- Quota comes from `GET https://api.anthropic.com/api/oauth/usage` — the same zero-spend endpoint Claude Code and teamclaude use. It never consumes message quota.
- `Fable` always gets a dedicated row (from the `weekly_scoped` limit); other scoped buckets (Sonnet/Opus) appear automatically if the plan exposes them.
- The endpoint is aggressively rate limited (HTTP 429, `retry-after: 0`, small sliding window per account). To stay under it, agent-usage and `~/.claude/statusline-command.sh` share one cache at `/tmp/.claude-usage-cache` (120s TTL): whoever fetched last writes, everyone else reads. On 429 the last good response is shown with a `(cached Xm ago)` tag and the next network probe backs off 5→30 min (`r` forces a probe). The statusline also writes `/tmp/.claude-usage-cache.fail` and skips fetching for 5 min after any failure, so dozens of renders across sessions cannot keep the limit tripped.
- The `Usage` row is computed locally from `~/.claude/projects/**/*.jsonl`: assistant messages in the current 5h session window, deduped by requestId. Tokens = input + cache-writes + output (cache reads excluded). Files are read incrementally (byte offsets), so only the first probe scans history.

## Usage

```
agent-usage              # live: probe every 60s (r = probe now, q = quit)
agent-usage -i 30        # probe every 30s (min 30)
agent-usage --once       # print once and exit
agent-usage --json       # raw endpoint JSON
agent-usage --no-local   # skip the local transcript scan
```

Aliased in `~/.zshrc`:

```sh
alias agent-usage="node ~/Documents/agent-tooling/agent-usage/agent-usage.mjs"
```
