import assert from 'node:assert/strict';
import test from 'node:test';
import xterm from '@xterm/headless';
import { createFrameWriter } from '../src/terminal.mjs';

const CSI = '\x1b[';
const flush = terminal => new Promise(resolve => terminal.write('', resolve));
function harness(t, columns = 80, rows = 24, options) {
  const terminal = new xterm.Terminal({ cols: columns, rows, allowProposedApi: true, convertEol: true });
  t.after(() => terminal.dispose());
  const writes = [];
  const out = { isTTY: true, columns, rows, write(value) { writes.push(value); terminal.write(value); } };
  terminal.write(`${CSI}?1049h${CSI}?25l`);
  return { terminal, writes, out, writer: createFrameWriter(out, options) };
}
function screen(terminal) {
  return Array.from({ length: terminal.rows }, (_, y) => {
    const line = terminal.buffer.active.getLine(y);
    return Array.from({ length: terminal.cols }, (_, x) => {
      const cell = line.getCell(x);
      return [cell.getChars() || ' ', cell.getWidth(), cell.getFgColorMode(), cell.getFgColor(), cell.isBold(), cell.isDim()];
    });
  });
}
const lines = terminal => Array.from({ length: terminal.rows }, (_, y) => terminal.buffer.active.getLine(y).translateToString(true));

test('a timestamp tick patches only the header; an unchanged frame writes nothing', async t => {
  const h = harness(t);
  h.writer.write('agent-usage                 probed 40s ago\n\nClaude\n  Session  [████░░] 60%');
  h.writer.write('agent-usage                 probed 41s ago\n\nClaude\n  Session  [████░░] 60%');
  assert.equal(h.writes.length, 2);
  assert.ok(!h.writes[1].includes(`${CSI}2J`));
  assert.ok(!h.writes[1].includes('Session'));
  assert.ok(h.writes[1].startsWith(`${CSI}?2026h`));
  assert.ok(h.writes[1].endsWith(`${CSI}?2026l`));
  h.writer.write('agent-usage                 probed 41s ago\n\nClaude\n  Session  [████░░] 60%');
  assert.equal(h.writes.length, 2);
  await flush(h.terminal);
  assert.equal(lines(h.terminal)[3], '  Session  [████░░] 60%');
});

test('shorter rows and disappearing messages leave no stale text', async t => {
  const h = harness(t, 30, 6);
  h.writer.write('probed 59s ago\ncard\nmessage line 1\nmessage line 2\nfooter');
  h.writer.write('probed 1m ago\ncard\nfooter');
  await flush(h.terminal);
  assert.deepEqual(lines(h.terminal), ['probed 1m ago', 'card', 'footer', '', '', '']);
});

test('wrapped colors, indentation and Unicode match normal terminal rendering', async t => {
  const h = harness(t, 20, 12);
  const reference = harness(t, 20, 12);
  const frame = `  ${CSI}1m${CSI}38;2;30;150;90mLong colored text wrapping across rows${CSI}0m\n  [█░░] 50%\n  界界 e\u0301 👩‍💻\nfooter`;
  h.writer.write(frame);
  reference.terminal.write(frame);
  await Promise.all([flush(h.terminal), flush(reference.terminal)]);
  assert.deepEqual(screen(h.terminal), screen(reference.terminal));
  // Repaint a wrapped continuation row in isolation, including its color.
  const next = frame.replace('across', 'ACROSS');
  h.writer.write(next);
  reference.terminal.write(`${CSI}0m${CSI}H${CSI}2J${next}`);
  await Promise.all([flush(h.terminal), flush(reference.terminal)]);
  assert.deepEqual(screen(h.terminal), screen(reference.terminal));
});

test('full-width bottom row does not scroll or lose its last character', async t => {
  const h = harness(t, 5, 3);
  h.writer.write('12345\nabcde\nABCDE');
  h.writer.write('12345\nabcde\nABCD!');
  await flush(h.terminal);
  assert.deepEqual(lines(h.terminal), ['12345', 'abcde', 'ABCD!']);
  assert.ok(!h.writes[1].includes('\n'));
});

test('overflow stays inside the viewport and hidden changes emit nothing', async t => {
  const h = harness(t, 10, 3);
  h.writer.write('header\nrow two\nrow three\nhidden');
  h.writer.write('header\nrow two\nrow three\nhidden change');
  await flush(h.terminal);
  assert.equal(h.writes.length, 1);
  assert.deepEqual(lines(h.terminal), ['header', 'row two', 'row three']);
});

test('resizing invalidates physical rows and reveals previously clipped content', async t => {
  const h = harness(t, 10, 3);
  const frame = 'abcdefghijklmno\nsecond\nthird';
  h.writer.write(frame);
  await flush(h.terminal);
  h.terminal.resize(20, 5); h.out.columns = 20; h.out.rows = 5;
  h.writer.write(frame);
  await flush(h.terminal);
  assert.deepEqual(lines(h.terminal), ['abcdefghijklmno', 'second', 'third', '', '']);
  assert.ok(h.writes[1].includes(`${CSI}2J`));
  h.terminal.resize(5, 3); h.out.columns = 5; h.out.rows = 3;
  h.writer.invalidate(); h.writer.write(frame);
  await flush(h.terminal);
  assert.deepEqual(lines(h.terminal), ['abcde', 'fghij', 'klmno']);
});

test('style-only changes repaint, and output also works without synchronized updates', async t => {
  const h = harness(t, 10, 3, { synchronized: false });
  h.writer.write(`${CSI}31mquota${CSI}0m`);
  h.writer.write(`${CSI}32mquota${CSI}0m`);
  await flush(h.terminal);
  assert.equal(h.terminal.buffer.active.getLine(0).getCell(0).getFgColor(), 2);
  assert.ok(!h.writes[1].includes('?2026'));
});

test('redirected output keeps its plain frame behavior', () => {
  const writes = [];
  const writer = createFrameWriter({ isTTY: false, write: value => writes.push(value) });
  writer.write('first'); writer.write('first'); writer.write('second');
  assert.deepEqual(writes, ['first\n\n', 'second\n\n']);
});
