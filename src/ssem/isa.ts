// The Manchester Baby's (SSEM, 1948) order code. Sources: C. P. Burton, The Manchester University Small-Scale
// Experimental Machine Programmer's Reference Manual, Issue 2, 1997 (the 1998 replica's: function numbers, modern
// mnemonics); S. H. Lavington, A History of Manchester Computers, 1998; G. C. Tootill's notebook, 18 July 1948 (the
// notation of the day). A word is 32 digits, digit 0 the least significant and written on the LEFT, as the display tube
// and the notebook show it. An instruction uses two fields only: the line number in digits 0–4 and the function number
// in digits 13–15; the other digits are ignored. Numbers are two's complement (digit 31 the sign).

export const LINES = 32;

/** Function numbers 0–7 (function 5 is a second SUB: digit 15 is not decoded for subtraction). */
export const FN = { JMP: 0, JRP: 1, LDN: 2, STO: 3, SUB: 4, CMP: 6, STP: 7 } as const;
export type FnName = keyof typeof FN;

/** Modern mnemonic per function number (Burton's). */
export const MNEMONIC = ['JMP', 'JRP', 'LDN', 'STO', 'SUB', 'SUB', 'CMP', 'STP'] as const;

/** What each does, in the replica manual's terms. */
export const MEANING = [
  'CI = S: jump to the line whose number is held in line S (indirect), plus one',
  'CI = CI + S: jump relative by the number held in line S',
  'A = −S: load the negative of line S',
  'S = A: store the accumulator in line S',
  'A = A − S: subtract line S',
  'A = A − S: subtract line S (function 5 acts as 4)',
  'if A < 0, CI = CI + 1: skip the next line when the accumulator is negative',
  'stop: light the Stop lamp and halt',
] as const;

/** Whether the function uses its line number (CMP and STP do not). */
export const usesLine = (f: number): boolean => f !== 6 && f !== 7;

/** The 1948 notation as Tootill's notebook writes it (C the accumulator, Cl the control, "c" its contents). */
export function notebook(f: number, s: number): string {
  switch (f) {
    case 0: return `${s} to Cl`;
    case 1: return `Add ${s} to Cl`;
    case 2: return `−${s} to C`;
    case 3: return `c to ${s}`;
    case 4: case 5: return `Sub ${s}`;
    case 6: return 'Test';
    default: return 'Stop';
  }
}

export const encode = (f: number, s: number): number => ((s & 31) | ((f & 7) << 13)) | 0;
export const fnOf = (w: number): number => (w >>> 13) & 7;
export const lineOf = (w: number): number => w & 31;

/** A word as the display shows it: digit 0 first, '-' for a 1 (a dash), '.' for a 0 (a dot). */
export function digits(w: number, one = '-', zero = '.'): string {
  let s = '';
  for (let d = 0; d < 32; d++) s += (w >>> d) & 1 ? one : zero;
  return s;
}

/** n binary digits of v, least significant first (the notebook's way). */
export function lsbFirst(v: number, n: number): string {
  let s = '';
  for (let d = 0; d < n; d++) s += (v >>> d) & 1;
  return s;
}

/** An instruction word disassembled; a word whose other digits are set is shown with its value too. */
export function disasm(w: number): string {
  const f = fnOf(w), s = lineOf(w);
  return usesLine(f) ? `${MNEMONIC[f]} ${s}` : MNEMONIC[f];
}
