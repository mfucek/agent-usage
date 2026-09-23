// Local, machine-side signals: running `claude` processes.
import { execFileSync } from 'node:child_process';

// Claude Code processes. The launcher's comm is `claude`; the native
// installer's versioned binary runs as ~/.local/share/claude/versions/<v>; an
// npm install runs as `node .../bin/claude`. Look at the first two argv words.
const CLAUDE_WORD = /(^|\/)claude$|\/share\/claude\/versions\//;
export function countClaudeProcs() {
  try {
    const out = execFileSync('ps', ['-Ao', 'args='], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    let n = 0;
    for (const line of out.split('\n')) {
      const [a0 = '', a1 = ''] = line.trim().split(/\s+/);
      if (CLAUDE_WORD.test(a0) || (/(^|\/)(node|bun)$/.test(a0) && CLAUDE_WORD.test(a1))) n++;
    }
    return n;
  } catch { return 0; }
}
