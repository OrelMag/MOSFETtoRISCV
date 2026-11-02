/** The site's one way to write a big number: SI style, groups of three joined by U+202F (narrow no-break space), so a
 *  number never wraps across lines and never reads as a comma-separated list. Only the integer part is grouped, and
 *  only from 5 digits up (`1024`, `4096`, years stay whole). Not for anything parsed back: use `ungroupDigits` there. */
export const THIN = String.fromCharCode(0x202f);

function group(s: string): string {
  const m = /^(-?)(\d+)(\.\d+)?$/.exec(s);
  if (!m) return s; // NaN, Infinity, exponent forms
  const [, sign, int, frac = ''] = m;
  if (int.length < 5) return s;
  return sign + int.replace(/\B(?=(\d{3})+$)/g, THIN) + frac;
}

export const groupDigits = (n: number | bigint): string => group(String(n));

/** A number to `d` decimals (trailing zeros kept), the integer part grouped. */
export const groupFixed = (x: number, d: number): string => group(x.toFixed(d));

/** Undo `groupDigits` (and plain / no-break spaces and commas used as separators) in text that is read back as a number. */
const SEPARATORS = new RegExp('[' + THIN + String.fromCharCode(0xa0, 0x2009) + ' ,](?=' + String.fromCharCode(92) + 'd{3}(?!' + String.fromCharCode(92) + 'd))', 'g');
export const ungroupDigits = (s: string): string => s.replace(SEPARATORS, '');
