import { B0, B1, BX, BZ, type Bit } from './types';

/** Pack little-endian bits into a number; returns -1 if any bit is not 0/1. */
export function pack(bits: ArrayLike<number>): number {
  let v = 0;
  for (let i = 0; i < bits.length; i++) {
    const b = bits[i];
    if (b === B1) v += 2 ** i;
    else if (b !== B0) return -1;
  }
  return v;
}

export function unpack(v: number, width: number): Bit[] {
  const out: Bit[] = new Array(width);
  if (v < 0) return out.fill(BX);
  for (let i = 0; i < width; i++) out[i] = (Math.floor(v / 2 ** i) % 2) as Bit;
  return out;
}

export function mask(width: number): number {
  return width >= 32 ? 0xffffffff : 2 ** width - 1;
}

export type Radix = 'hex' | 'bin' | 'dec' | 'sdec';

function bitChar(b: number): string {
  return b === B1 ? '1' : b === B0 ? '0' : b === BZ ? 'z' : 'x';
}

/** Format a bit vector for display. Handles X/Z per bit (binary) or per nibble (hex). */
export function formatBits(bits: ArrayLike<number>, radix: Radix): string {
  const w = bits.length;
  if (w === 1) return bitChar(bits[0]);
  if (w > 64) return `[${w} wires]`;
  const v = pack(bits);
  if (radix === 'bin' || (v < 0 && radix !== 'hex')) {
    let s = '';
    for (let i = w - 1; i >= 0; i--) {
      s += bitChar(bits[i]);
      if (i > 0 && i % 4 === 0) s += '_';
    }
    return (radix === 'bin' ? '0b' : '') + s;
  }
  if (radix === 'hex') {
    let s = '';
    for (let n = Math.ceil(w / 4) - 1; n >= 0; n--) {
      const nib: number[] = [];
      for (let i = n * 4; i < Math.min(w, n * 4 + 4); i++) nib.push(bits[i]);
      const nv = pack(nib);
      s += nv < 0 ? (nib.every((b) => b === BZ) ? 'z' : 'x') : nv.toString(16).toUpperCase();
    }
    return '0x' + s;
  }
  if (radix === 'sdec') return String(toSigned(v, w));
  return String(v);
}

export function toSigned(v: number, w: number): number {
  return v >= 2 ** (w - 1) ? v - 2 ** w : v;
}

export function formatNumber(v: number, width: number, radix: Radix): string {
  return formatBits(unpack(v, width), radix);
}
