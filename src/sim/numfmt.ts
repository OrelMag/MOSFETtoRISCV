/** The site's one way to write a big number: SI style, groups of three joined by U+202F (narrow no-break space), so a
 *  number never wraps across lines and never reads as a comma-separated list. Only the integer part is grouped, and
 *  only from 5 digits up (`1024`, `4096`, years stay whole). Not for anything parsed back: use `ungroupDigits` there. */
export const THIN = ' ';

export function groupDigits(n: number | bigint): string {
  const s = String(n);
  const m = /^(-?)(\d+)(\.\d+)?$/.exec(s);
  if (!m) return s; // NaN, Infinity, exponent forms
  const [, sign, int, frac = ''] = m;
  if (int.length < 5) return s;
  return sign + int.replace(/\B(?=(\d{3})+$)/g, THIN) + frac;
}

/** Undo `groupDigits` (and plain / no-break spaces and commas used as separators) in text that is read back as a number. */
export const ungroupDigits = (s: string): string => s.replace(/[    ,](?=\d{3}(?!\d))/g, '');
