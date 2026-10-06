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

/** Pack little-endian bits into a BigInt, exact at any width; null if any bit is not 0/1. */
export function packBig(bits: ArrayLike<number>): bigint | null {
  let v = 0n;
  for (let i = bits.length - 1; i >= 0; i--) {
    const b = bits[i];
    if (b !== B0 && b !== B1) return null;
    v = (v << 1n) | BigInt(b);
  }
  return v;
}

/** The low `width` bits of a BigInt (two's complement for a negative one), LSB first. */
export function unpackBig(v: bigint, width: number): Bit[] {
  const out: Bit[] = new Array(width);
  for (let i = 0; i < width; i++, v >>= 1n) out[i] = Number(v & 1n) as Bit;
  return out;
}

/**
 * A number or text in decimal, 0x hex or 0b binary ('_' separators allowed), exact at any
 * size; null if it is none of these.
 */
export function parseBig(s: string): bigint | null {
  const t = s.trim().toLowerCase().replace(/_/g, '');
  return /^(0x[0-9a-f]+|0b[01]+|\d+)$/.test(t) ? BigInt(t) : null;
}

export function mask(width: number): number {
  return width >= 32 ? 0xffffffff : 2 ** width - 1;
}

export type Radix = 'hex' | 'bin' | 'dec' | 'sdec';

function bitChar(b: number): string {
  return b === B1 ? '1' : b === B0 ? '0' : b === BZ ? 'z' : 'x';
}

/**
 * Format a bit vector for display, exact at any width (decimal goes through BigInt past 53
 * bits). Handles X/Z per bit (binary) or per nibble (hex). Past 64 bits, hex digits are grouped
 * by eight with '_' so a wide word stays readable.
 */
export function formatBits(bits: ArrayLike<number>, radix: Radix): string {
  const w = bits.length;
  if (w === 1) return bitChar(bits[0]);
  if (w > 53 && (radix === 'dec' || radix === 'sdec')) {
    const b = packBig(bits);
    if (b !== null) return String(radix === 'sdec' && bits[w - 1] === B1 ? b - (1n << BigInt(w)) : b);
  }
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
      if (w > 64 && n > 0 && n % 8 === 0) s += '_';
    }
    return '0x' + s;
  }
  if (radix === 'sdec') return String(toSigned(v, w));
  return String(v);
}

/** A tooltip's value: hex · binary · decimal (no binary past 64 bits: it would not fit). */
export function describeBits(bits: ArrayLike<number>): string {
  if (bits.length === 1) return formatBits(bits, 'bin');
  const bin = bits.length <= 64 ? ` · ${formatBits(bits, 'bin')}` : '';
  return `${formatBits(bits, 'hex')}${bin} · ${formatBits(bits, 'dec')}`;
}

export function toSigned(v: number, w: number): number {
  return v >= 2 ** (w - 1) ? v - 2 ** w : v;
}

/** A packed value (BigInt for any width, number up to 53 bits; negative = unknown). */
export function formatNumber(v: number | bigint, width: number, radix: Radix): string {
  return formatBits(typeof v === 'bigint' ? (v < 0n ? unpack(-1, width) : unpackBig(v, width)) : unpack(v, width), radix);
}
