// Browser keys → Doom's key codes (ports/doom/doomgeneric/doomkeys.h), as the Doom computer's KEY
// register delivers them. Doom's own default bindings (m_controls.c) then apply: arrows move,
// Ctrl fires, Space uses, Alt strafes, Shift runs, , and . strafe, Escape opens the menu, Enter
// selects, Tab shows the map, digits pick weapons, letters type (y / n, cheats).

export const DOOM_KEY = {
  RIGHT: 0xae, LEFT: 0xac, UP: 0xad, DOWN: 0xaf, STRAFE_L: 0xa0, STRAFE_R: 0xa1, USE: 0xa2, FIRE: 0xa3,
  ESCAPE: 27, ENTER: 13, TAB: 9, BACKSPACE: 0x7f, PAUSE: 0xff, EQUALS: 0x3d, MINUS: 0x2d,
  RSHIFT: 0x80 + 0x36, RCTRL: 0x80 + 0x1d, RALT: 0x80 + 0x38, F1: 0x80 + 0x3b,
} as const;

const BY_CODE: Record<string, number> = {
  ArrowRight: DOOM_KEY.RIGHT, ArrowLeft: DOOM_KEY.LEFT, ArrowUp: DOOM_KEY.UP, ArrowDown: DOOM_KEY.DOWN,
  Comma: DOOM_KEY.STRAFE_L, Period: DOOM_KEY.STRAFE_R, Space: DOOM_KEY.USE,
  ControlLeft: DOOM_KEY.FIRE, ControlRight: DOOM_KEY.FIRE,
  AltLeft: DOOM_KEY.RALT, AltRight: DOOM_KEY.RALT, ShiftLeft: DOOM_KEY.RSHIFT, ShiftRight: DOOM_KEY.RSHIFT,
  Escape: DOOM_KEY.ESCAPE, Enter: DOOM_KEY.ENTER, NumpadEnter: DOOM_KEY.ENTER, Tab: DOOM_KEY.TAB,
  Backspace: DOOM_KEY.BACKSPACE, Pause: DOOM_KEY.PAUSE, Equal: DOOM_KEY.EQUALS, Minus: DOOM_KEY.MINUS,
};

/**
 * The Doom key code for a KeyboardEvent's `code` (physical key, so a layout or Shift does not
 * change it), or null when Doom has no use for it.
 */
export function doomKey(code: string): number | null {
  const k = BY_CODE[code];
  if (k !== undefined) return k;
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1].toLowerCase().charCodeAt(0);
  m = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (m) return m[1].charCodeAt(0);
  m = /^F([1-9]|1[0-2])$/.exec(code);
  if (m) { const n = Number(m[1]); return n <= 10 ? DOOM_KEY.F1 + n - 1 : 0x80 + 0x57 + n - 11; }
  return null;
}

/** What the controls hint shows. */
export const DOOM_CONTROLS: [string, string][] = [
  ['↑ ↓ ← →', 'move'], ['Ctrl', 'fire'], ['Space', 'use / open'], ['Alt', 'strafe'], ['Shift', 'run'],
  [', .', 'strafe'], ['1–7', 'weapon'], ['Tab', 'map'], ['Esc', 'menu'], ['Enter', 'select'],
];
