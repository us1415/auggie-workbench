/**
 * Terminal output sanitization.
 *
 * Command output captured from VS Code shell integration (and from raw shells)
 * is littered with terminal control sequences that render as noise in the chat
 * action cards: SGR color codes, cursor moves, and — most visibly — the OSC 633
 * / OSC 133 markers VS Code injects to track command boundaries. None of it
 * carries meaning once the output is shown as plain text, so we strip it before
 * the output reaches a card (or Auggie's tool result).
 *
 * Patterns use explicit \x escapes (ESC = \x1b, BEL = \x07, ST = \x1b\\) rather
 * than literal control bytes so they stay readable and reviewable.
 */

// OSC string: ESC ] ... terminated by BEL or ST (or the C1 OSC \x9d). Covers
// the VS Code shell-integration markers (OSC 633/133) and window-title
// sequences. Non-greedy so adjacent OSC strings aren't merged into one match.
const OSC = /(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\)/g;

// DCS/PM/APC/SOS strings: ESC (P|X|^|_) ... ST. Rare in command output but
// cheap to strip and would otherwise leave a trailing garble.
const STRING_SEQ = /\x1b[PX^_][\s\S]*?(?:\x07|\x1b\\)/g;

// Control Sequence Introducer: ESC [ params intermediates final-byte, e.g.
// "\x1b[0m" (color), "\x1b[2K" (clear line). Also the C1 single-byte CSI \x9b.
const CSI = /(?:\x1b\[|\x9b)[0-9;?]*[ -/]*[@-~]/g;

// Remaining single-/two-char escapes, e.g. ESC (B, ESC =, ESC >. Runs after the
// sequences above so it never eats their leading ESC.
const OTHER_ESC = /\x1b[ -/]*[0-~]/g;

// Leftover C0 controls and DEL. Tab (\x09) and newline (\x0a) are preserved;
// carriage returns are normalized to newlines beforehand.
const C0 = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/**
 * Strip ANSI/OSC and other terminal control sequences from a string, and
 * normalize line endings. Operates on the fully-accumulated output (not a
 * partial chunk), so escape sequences are never split across a boundary.
 *
 * Idempotent: sanitizing already-clean text returns it unchanged.
 */
export function sanitizeTerminalOutput(raw: string): string {
  if (!raw) {
    return raw;
  }

  return raw
    .replace(OSC, '')
    .replace(STRING_SEQ, '')
    .replace(CSI, '')
    .replace(OTHER_ESC, '')
    .replace(/\r\n?/g, '\n')
    .replace(C0, '');
}
