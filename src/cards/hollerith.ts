// The IBM 80-column card's character code as the IBM 029 keypunch punched it (1964; the 026's letters and digits
// are the same). A column holds one character as holes in up to three of its twelve rows: the zone rows 12, 11 and 0
// at the top, then the digit rows 1–9. A digit is one hole, a letter a zone and a digit (A = 12-1, J = 11-1, S = 0-2),
// a sign a zone or none, a digit and the 8 row.
//
// A column is a 12-bit mask here, bit i for the i-th row from the top: bit 0 = row 12, bit 1 = row 11, bit 2 = row 0,
// bit 3 = row 1, …, bit 11 = row 9.

/** The rows from the top edge, as printed on the card (12 and 11 are unprinted: the zone rows above 0). */
export const ROWS = ['12', '11', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;
export type RowName = (typeof ROWS)[number];

/** The bit of a row in a column mask. */
export const rowBit = (r: RowName): number => 1 << ROWS.indexOf(r);
/** Bit of row 9 (the bottom row; object cards punch their word in it). */
export const ROW9 = 1 << 11;

const CODE: Record<string, RowName[]> = { ' ': [] };
for (let i = 0; i <= 9; i++) CODE[String(i)] = [String(i) as RowName];
'ABCDEFGHI'.split('').forEach((c, i) => { CODE[c] = ['12', String(i + 1) as RowName]; });
'JKLMNOPQR'.split('').forEach((c, i) => { CODE[c] = ['11', String(i + 1) as RowName]; });
'STUVWXYZ'.split('').forEach((c, i) => { CODE[c] = ['0', String(i + 2) as RowName]; });
Object.assign(CODE, {
  '&': ['12'], '-': ['11'], '/': ['0', '1'], '¢': ['12', '2', '8'],
  '.': ['12', '3', '8'], '<': ['12', '4', '8'], '(': ['12', '5', '8'], '+': ['12', '6', '8'], '|': ['12', '7', '8'],
  '!': ['11', '2', '8'], '$': ['11', '3', '8'], '*': ['11', '4', '8'], ')': ['11', '5', '8'], ';': ['11', '6', '8'], '¬': ['11', '7', '8'],
  ',': ['0', '3', '8'], '%': ['0', '4', '8'], '_': ['0', '5', '8'], '>': ['0', '6', '8'], '?': ['0', '7', '8'],
  ':': ['2', '8'], '#': ['3', '8'], '@': ['4', '8'], "'": ['5', '8'], '=': ['6', '8'], '"': ['7', '8'],
} satisfies Record<string, RowName[]>);

const maskOfRows = (rs: readonly RowName[]) => rs.reduce((m, r) => m | rowBit(r), 0);

const PUNCH = new Map<string, number>(Object.entries(CODE).map(([c, rs]) => [c, maskOfRows(rs)]));
const CHAR = new Map<number, string>([...PUNCH].map(([c, m]) => [m, c]));

/** The characters the 029 punches (a lower-case letter punches as its capital). */
export const CHARSET: readonly string[] = [...PUNCH.keys()];

/** Can `ch` be punched (after upper-casing)? */
export const punchable = (ch: string): boolean => PUNCH.has(ch.toUpperCase());

/** The column mask that punches `ch` (lower case as upper case); null for a character the 029 has no code for. */
export function punchOf(ch: string): number | null {
  return PUNCH.get(ch.toUpperCase()) ?? null;
}

/** The character a column says, or null for a pattern that is no character (a binary column). */
export function charOf(mask: number): string | null {
  return CHAR.get(mask & 0xfff) ?? null;
}

/** The rows a column has holes in, top to bottom ('12-1' for A, '' for a blank column). */
export function rowsOf(mask: number): string {
  return ROWS.filter((_, i) => mask & (1 << i)).join('-');
}

/** The holes of a character, as rows ('12-1' for A); null when it has no code. */
export function rowsOfChar(ch: string): string | null {
  const m = punchOf(ch);
  return m === null ? null : rowsOf(m);
}
