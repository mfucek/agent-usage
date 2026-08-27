// Paths, endpoints, tunables, and the user's config file.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const VERSION = '2.0.0';
export const USER_AGENT = `agent-usage/${VERSION}`;

const HOME = homedir();

// ─── Claude Code's files ─────────────────────────────────────────────────────
// Claude Code keeps everything under CLAUDE_CONFIG_DIR (default ~/.claude):
// `.claude.json` (settings + oauthAccount), `.credentials.json` (non-macOS
// token store) and `projects/` (transcripts). ~/.claude.json is only used
// when CLAUDE_CONFIG_DIR is unset.
export const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || join(HOME, '.claude');
export const CLAUDE_JSON = process.env.CLAUDE_CONFIG_DIR ? join(CLAUDE_CONFIG_DIR, '.claude.json') : join(HOME, '.claude.json');
export const CRED_FILE = join(CLAUDE_CONFIG_DIR, '.credentials.json');
export const PROJECTS_DIR = join(CLAUDE_CONFIG_DIR, 'projects');
export const KEYCHAIN_SERVICE = 'Claude Code-credentials';

// ─── OAuth (same client as Claude Code) ──────────────────────────────────────
export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
export const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
export const AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
export const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const OAUTH_SCOPES = ['org:create_api_key', 'user:profile', 'user:inference', 'user:file_upload', 'user:mcp_servers', 'user:sessions:claude_code'];
export const OAUTH_BETA = 'oauth-2025-04-20';
export const LOGIN_PORT = 54545;

// Claude Code re-reads the keychain before every API request, through a 30s
// cache (KEYCHAIN_CACHE_TTL_MS in src/utils/secureStorage/macOsKeychainHelpers.ts).
// After a switch, every running session is on the new account by its next
// request, at most this much later.
export const CLAUDE_TOKEN_CACHE_MS = 30_000;

// ─── Our state ───────────────────────────────────────────────────────────────
export const STATE_DIR = join(HOME, '.local', 'state', 'agent-usage');
export const ACCOUNTS_DIR = join(STATE_DIR, 'accounts');
// Append-only history of which account was logged in from when. Transcripts
// carry no account id, so local usage is attributed to the account that was
// logged in at each request's timestamp.
export const SWITCH_LOG = join(STATE_DIR, 'switch-log.jsonl');
export const CONFIG_FILE = join(process.env.XDG_CONFIG_HOME || join(HOME, '.config'), 'agent-usage', 'config.json');

// Shared with ~/.claude/statusline-command.sh: whoever fetched last writes here,
// everyone else reads. One request per CACHE_TTL across all tools/sessions —
// the endpoint is aggressively rate limited (429, retry-after: 0) and a 429
// never clears while anything keeps polling. Entries we write carry
// `_account` so a cache left over from another account is never shown.
export const CACHE_FILE = '/tmp/.claude-usage-cache';
export const FAIL_FILE = `${CACHE_FILE}.fail`; // statusline's negative-cache stamp
export const CACHE_TTL_MS = 120_000;
export const MIN_BACKOFF_MS = 5 * 60_000;
export const MAX_BACKOFF_MS = 30 * 60_000;

// Archived (not logged-in) accounts: poll usage once an hour and refresh their
// access token when it is within REFRESH_AHEAD_MS of expiring.
export const OTHER_INTERVAL_MS = 60 * 60_000;
export const REFRESH_AHEAD_MS = 30 * 60_000;
export const REFRESH_RETRY_MS = 10 * 60_000;
export const PS_POLL_MS = 2000;
export const MSG_TTL_MS = 60_000;
export const FIVE_H = 5 * 3600 * 1000;
export const WEEK_MS = 7 * 24 * 3600 * 1000;

// ─── User config ─────────────────────────────────────────────────────────────
// { "order": ["first@x.com", "second@y.com"] } — cards keep this order no
// matter which account is logged in; emails not listed go after, newest-seen first.
function loadConfig() {
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) || {}; } catch { return {}; }
}
export const config = loadConfig();
const ORDER = Array.isArray(config.order) ? config.order.map(e => String(e).toLowerCase()) : [];
export const orderRank = email => { const i = ORDER.indexOf((email || '').toLowerCase()); return i < 0 ? ORDER.length : i; };
