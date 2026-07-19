import * as assert from 'assert';
import { sanitizeTerminalOutput } from '../utils/terminalOutput';

const ESC = '\x1b';
const BEL = '\x07';

suite('sanitizeTerminalOutput', () => {
  test('strips VS Code shell-integration OSC 633 markers (BEL-terminated)', () => {
    const raw = `${ESC}]633;C${BEL}v22.14.0${ESC}]633;D;0${BEL}`;
    assert.strictEqual(sanitizeTerminalOutput(raw), 'v22.14.0');
  });

  test('strips OSC markers terminated by ST (ESC \\)', () => {
    const raw = `${ESC}]0;window title${ESC}\\hello`;
    assert.strictEqual(sanitizeTerminalOutput(raw), 'hello');
  });

  test('strips SGR color codes', () => {
    const raw = `${ESC}[32mpassing${ESC}[0m`;
    assert.strictEqual(sanitizeTerminalOutput(raw), 'passing');
  });

  test('strips cursor/clear-line CSI sequences', () => {
    const raw = `progress${ESC}[2K${ESC}[1Gdone`;
    assert.strictEqual(sanitizeTerminalOutput(raw), 'progressdone');
  });

  test('normalizes CRLF and lone CR to LF', () => {
    assert.strictEqual(sanitizeTerminalOutput('a\r\nb\rc'), 'a\nb\nc');
  });

  test('preserves tabs and newlines in ordinary output', () => {
    const raw = 'line1\n\tindented\nline3';
    assert.strictEqual(sanitizeTerminalOutput(raw), raw);
  });

  test('leaves already-clean text untouched (idempotent)', () => {
    const clean = 'total 4\ndrwxr-xr-x  2 user group';
    assert.strictEqual(sanitizeTerminalOutput(clean), clean);
    assert.strictEqual(
      sanitizeTerminalOutput(sanitizeTerminalOutput(clean)),
      clean,
    );
  });

  test('handles empty string', () => {
    assert.strictEqual(sanitizeTerminalOutput(''), '');
  });

  test('strips a realistic mixed shell-integration line', () => {
    const raw = `${ESC}]633;C${BEL}${ESC}[0m${ESC}[32m✓${ESC}[0m built in 1.2s\r\n${ESC}]633;D;0${BEL}`;
    assert.strictEqual(sanitizeTerminalOutput(raw), '✓ built in 1.2s\n');
  });
});
