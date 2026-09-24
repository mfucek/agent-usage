// Incremental output for the existing ANSI layout. Each cached row is a
// physical terminal row, with its own styles, so it can be replaced in isolation.
import stringWidth from 'string-width';

const CSI = '\x1b[';
const RESET = `${CSI}0m`;
const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const sgr = /^\x1b\[[0-9;:]*m$/;

function screenRows(frame, columns, height) {
  const rows = [];
  let text = '', width = 0, styles = '';
  const finish = () => {
    rows.push({ text: text + RESET, width });
    text = styles; width = 0;
  };
  const put = (char, size) => {
    if (width + size > columns) finish();
    text += char; width += size;
  };
  for (const token of frame.split(/(\x1b\[[0-9;:]*m)/)) {
    if (sgr.test(token)) {
      text += token;
      // Replaying SGR since the last reset also preserves nested/truecolor
      // styles across a wrap, without interpreting color codes ourselves.
      styles = /^\x1b\[(?:0)?m$/.test(token) ? '' : styles + token;
      continue;
    }
    for (const { segment } of segments.segment(token)) {
      if (rows.length >= height) return rows.slice(0, height);
      if (segment === '\n' || segment === '\r\n') { finish(); continue; }
      if (segment === '\t') {
        const spaces = 8 - (width % 8);
        for (let i = 0; i < spaces; i++) put(' ', 1);
        continue;
      }
      if (/[\x00-\x1f\x7f]/.test(segment)) continue;
      const size = stringWidth(segment);
      // A wide glyph cannot fit in a one-column terminal.
      put(size > columns ? '�' : segment, Math.min(size, columns));
    }
  }
  if (rows.length < height) finish();
  return rows.slice(0, height);
}

export function createFrameWriter(out, { synchronized = true } = {}) {
  let previous = [], lastFrame, lastColumns, lastHeight;
  return {
    invalidate() { lastFrame = undefined; lastColumns = undefined; },
    write(frame) {
      if (!out.isTTY) {
        if (frame !== lastFrame) out.write(`${frame}\n\n`);
        lastFrame = frame;
        return;
      }
      const columns = Math.max(1, out.columns || 80);
      const height = Math.max(1, out.rows || 24);
      const reset = columns !== lastColumns || height !== lastHeight;
      if (!reset && frame === lastFrame) return;
      const next = screenRows(frame, columns, height);
      let patch = reset ? `${RESET}${CSI}H${CSI}2J` : '';
      for (let y = 0; y < Math.max(next.length, reset ? 0 : previous.length); y++) {
        const row = next[y];
        if (!reset && row?.text === previous[y]?.text) continue;
        patch += `${CSI}${y + 1};1H${RESET}${row?.text || ''}`;
        // EL at the right margin would erase the last glyph while the
        // terminal is in pending-wrap state. A full row has no stale tail.
        if (!row || row.width < columns) patch += `${CSI}K`;
      }
      if (patch) {
        // Explicit positioning, no newline: never scroll at the bottom edge.
        patch += `${RESET}${CSI}H`;
        out.write(synchronized ? `${CSI}?2026h${patch}${CSI}?2026l` : patch);
      }
      previous = next; lastFrame = frame;
      lastColumns = columns; lastHeight = height;
    },
  };
}
