// public/doom/doom.img (scripts/doom/build.mjs): little-endian words, a header then the
// instruction ROM's words then the initial RAM words.
//   magic 'RVIM', version 1, entry, textBase, textWords, dataBase, dataWords, bssEnd

export interface DoomImage {
  entry: number;
  textBase: number;
  /** Instruction ROM words from textBase. */
  text: Uint32Array;
  dataBase: number;
  /** Initial RAM words from dataBase (.rodata, .data; .bss is zero). */
  data: Uint32Array;
  bssEnd: number;
}

export const IMG_MAGIC = 0x4d495652;
const HEADER = 8;

export function parseImage(buf: ArrayBuffer | Uint8Array): DoomImage {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const w = new Uint32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + (bytes.byteLength & ~3)));
  if (w.length < HEADER || w[0] !== IMG_MAGIC) throw new Error('doom.img: not an RVIM image');
  if (w[1] !== 1) throw new Error(`doom.img: version ${w[1]}, expected 1`);
  const [entry, textBase, textWords, dataBase, dataWords, bssEnd] = w.subarray(2, 8);
  if (entry !== 0 || textBase !== 0) throw new Error('doom.img: the ROM must start at 0 and the program there (our CPUs reset to PC 0)');
  if (HEADER + textWords + dataWords > w.length) throw new Error('doom.img: truncated');
  return {
    entry, textBase, text: w.slice(HEADER, HEADER + textWords),
    dataBase, data: w.slice(HEADER + textWords, HEADER + textWords + dataWords), bssEnd,
  };
}

/** A function symbol of doom.syms.json: [address, size, name]. */
export type DoomSymbol = [number, number, string];

/** The function containing pc (symbols sorted by address), by binary search. */
export function symbolAt(syms: readonly DoomSymbol[], pc: number): DoomSymbol | null {
  let lo = 0, hi = syms.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (syms[mid][0] <= pc) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (best < 0) return null;
  const s = syms[best];
  return pc < s[0] + Math.max(s[1], 4) ? s : null;
}
