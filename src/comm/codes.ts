// Morse and ITA2 (Baudot-Murray) codes with their timing (chapter telegraph). DOM-free.

/** International Morse: '.' dot, '-' dash. */
export const MORSE: Record<string, string> = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--',
  N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
  '0': '-----', '1': '.----', '2': '..---', '3': '...--', '4': '....-', '5': '.....', '6': '-....', '7': '--...', '8': '---..', '9': '----.',
  '.': '.-.-.-', ',': '--..--', '?': '..--..', '/': '-..-.', '=': '-...-', '+': '.-.-.', '-': '-....-',
};

/** Units of time: a dot 1, a dash 3, 1 between elements of a letter, 3 between letters, 7 between words. */
export const DOT = 1, DASH = 3, GAP_ELEMENT = 1, GAP_LETTER = 3, GAP_WORD = 7;

export interface MorseResult {
  /** Per word, per letter: the dots and dashes. Characters Morse has no code for are listed in `skipped`. */
  words: string[][];
  skipped: string[];
  /** The line as key-down (true) and key-up (false) runs: [state, units]. */
  runs: [boolean, number][];
  units: number;
}

export function morseEncode(text: string): MorseResult {
  const skipped: string[] = [];
  const words = text.toUpperCase().split(/\s+/).filter(Boolean).map((w) => {
    const letters: string[] = [];
    for (const ch of w) { if (MORSE[ch]) letters.push(MORSE[ch]); else skipped.push(ch); }
    return letters;
  }).filter((w) => w.length);
  const runs: [boolean, number][] = [];
  const push = (on: boolean, n: number) => { const l = runs[runs.length - 1]; if (l && l[0] === on) l[1] += n; else runs.push([on, n]); };
  words.forEach((w, wi) => {
    if (wi) push(false, GAP_WORD);
    w.forEach((l, li) => {
      if (li) push(false, GAP_LETTER);
      [...l].forEach((e, ei) => { if (ei) push(false, GAP_ELEMENT); push(true, e === '.' ? DOT : DASH); });
    });
  });
  return { words, skipped, runs, units: runs.reduce((s, r) => s + r[1], 0) };
}

/** ITA2: the 5-bit code is written with bit 1 as the least significant; bit 1 goes on the line first. */
export const LTRS = 0b11111, FIGS = 0b11011, SPACE = 0b00100, CR = 0b01000, LF = 0b00010;
/** [code, letters case, figures case] ('' where this table leaves the figures case out). */
const ITA2_ROWS: [number, string, string][] = [
  [0b00001, 'E', '3'], [0b00011, 'A', '-'], [0b00101, 'S', "'"], [0b00110, 'I', '8'], [0b00111, 'U', '7'], [0b01001, 'D', ''],
  [0b01010, 'R', '4'], [0b01011, 'J', ''], [0b01100, 'N', ','], [0b01101, 'F', ''], [0b01110, 'C', ':'], [0b01111, 'K', '('],
  [0b10000, 'T', '5'], [0b10001, 'Z', '+'], [0b10010, 'L', ')'], [0b10011, 'W', '2'], [0b10100, 'H', ''], [0b10101, 'Y', '6'],
  [0b10110, 'P', '0'], [0b10111, 'Q', '1'], [0b11000, 'O', '9'], [0b11001, 'B', '?'], [0b11010, 'G', ''], [0b11100, 'M', '.'],
  [0b11101, 'X', '/'], [0b11110, 'V', ''],
];
export const ITA2_LETTERS = new Map<string, number>(), ITA2_FIGURES = new Map<string, number>();
for (const [code, l, f] of ITA2_ROWS) { ITA2_LETTERS.set(l, code); if (f) ITA2_FIGURES.set(f, code); }

/** Start 1 unit, five data units, stop 1.5 units. */
export const ITA2_FRAME = { start: 1, data: 5, stop: 1.5 };
export const ITA2_UNITS = ITA2_FRAME.start + ITA2_FRAME.data + ITA2_FRAME.stop;

export interface Ita2Result {
  /** The codes sent, shifts included: [code, label]. */
  codes: [number, string][];
  skipped: string[];
  shifts: number;
  /** Units on the line: every character takes ITA2_UNITS, back to back. */
  units: number;
}

/** A shift is sent when the case changes; a space is the same in both cases and sends none. */
export function ita2Encode(text: string): Ita2Result {
  const codes: [number, string][] = [], skipped: string[] = [];
  let figs = false, shifts = 0;
  for (const ch of text.toUpperCase()) {
    if (ch === ' ') { codes.push([SPACE, 'SP']); continue; }
    const inL = ITA2_LETTERS.get(ch), inF = ITA2_FIGURES.get(ch);
    if (inL === undefined && inF === undefined) { if (!/\s/.test(ch)) skipped.push(ch); continue; }
    const wantFigs = inL === undefined;
    if (wantFigs !== figs) { codes.push(wantFigs ? [FIGS, 'FIGS'] : [LTRS, 'LTRS']); figs = wantFigs; shifts++; }
    codes.push([(figs ? inF : inL)!, ch]);
  }
  return { codes, skipped, shifts, units: codes.length * ITA2_UNITS };
}

/** The bits of one code in sending order (bit 1 first). */
export const codeBits = (code: number, n = 5): number[] => Array.from({ length: n }, (_, i) => (code >> i) & 1);

/** PARIS, the standard word of the Morse speed: with the gap that follows it, 50 units. */
export const PARIS_UNITS = morseEncode('PARIS').units + GAP_WORD;
/** Unit length (s) of Morse at w words a minute (PARIS convention): 1.2 / w. */
export const morseUnitSeconds = (wpm: number): number => 1.2 / wpm;
