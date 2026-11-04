// Framing (DOM-free): how a receiver finds where a frame starts and ends in a stream of bits or bytes. Bit-oriented
// HDLC framing (a flag 01111110, a 0 stuffed after every five 1s so the flag cannot occur inside) and byte-oriented
// COBS (no zero byte inside, so a zero ends the frame), each with its overhead worked out exactly, and a frame as
// payload + CRC-32 between flags that the receiver checks (comm/crc.ts).

import { bitsLsb, crc32, fcsBytes } from './crc';

export const FLAG = [0, 1, 1, 1, 1, 1, 1, 0];

/** Insert a 0 after every run of five 1s. */
export function stuff(bits: ArrayLike<number>): number[] {
  const out: number[] = [];
  let run = 0;
  for (let i = 0; i < bits.length; i++) {
    out.push(bits[i]);
    run = bits[i] ? run + 1 : 0;
    if (run === 5) { out.push(0); run = 0; }
  }
  return out;
}

/** Remove the stuffed zeros. Returns null on six 1s in a row (a flag or an abort inside the data). */
export function unstuff(bits: ArrayLike<number>): number[] | null {
  const out: number[] = [];
  let run = 0;
  for (let i = 0; i < bits.length; i++) {
    if (run === 5) { if (bits[i]) return null; run = 0; continue; }
    out.push(bits[i]);
    run = bits[i] ? run + 1 : 0;
  }
  return out;
}

/** Which bits of the stuffed stream are the stuffed ones. */
export function stuffedMask(bits: ArrayLike<number>): { bits: number[]; stuffed: boolean[] } {
  const out: number[] = [], st: boolean[] = [];
  let run = 0;
  for (let i = 0; i < bits.length; i++) {
    out.push(bits[i]); st.push(false);
    run = bits[i] ? run + 1 : 0;
    if (run === 5) { out.push(0); st.push(true); run = 0; }
  }
  return { bits: out, stuffed: st };
}

/**
 * Expected stuffed zeros per data bit for random data, exactly: the chain counts the 1s since the last 0 (0 to 4); a fifth 1
 * is followed by a stuffed 0 and the count restarts. The stationary probability of 4 ones times 1/2 is 1/62.
 */
export function stuffRate(): number {
  let pi = [1, 0, 0, 0, 0];
  for (let k = 0; k < 400; k++) {
    const nx = [0, 0, 0, 0, 0];
    pi.forEach((p, r) => { nx[0] += p / 2; if (r < 4) nx[r + 1] += p / 2; else nx[0] += p / 2; });
    pi = nx;
  }
  return pi[4] / 2;
}

/** Frame: flag, payload and its CRC-32 (bits least significant first, as the register takes them), stuffed, flag. */
export function frame(payload: ArrayLike<number>): number[] {
  const body = [...Array.from(payload), ...fcsBytes(crc32(payload))];
  return [...FLAG, ...stuff(bitsLsb(body)), ...FLAG];
}

export interface Received { payload: number[]; ok: boolean; bits: number }

/** Split a bit stream at flags and check each frame: payload (CRC removed) and whether its CRC-32 and stuffing were good. */
export function receive(stream: ArrayLike<number>): Received[] {
  const out: Received[] = [];
  const at: number[] = [];
  for (let i = 0; i + 8 <= stream.length; i++) {
    let m = true;
    for (let k = 0; k < 8 && m; k++) if (stream[i + k] !== FLAG[k]) m = false;
    if (m) { at.push(i); i += 7; }
  }
  for (let f = 0; f + 1 < at.length; f++) {
    const body = Array.from({ length: at[f + 1] - at[f] - 8 }, (_, k) => stream[at[f] + 8 + k]);
    if (!body.length) continue; // back-to-back flags: idle
    const raw = unstuff(body);
    if (!raw || raw.length % 8 || raw.length < 40) { out.push({ payload: [], ok: false, bits: body.length }); continue; }
    const bytes: number[] = [];
    for (let i = 0; i < raw.length; i += 8) { let v = 0; for (let b = 0; b < 8; b++) v |= raw[i + b] << b; bytes.push(v); }
    const payload = bytes.slice(0, -4), got = bytes.slice(-4), want = fcsBytes(crc32(payload));
    out.push({ payload, ok: got.every((v, i) => v === want[i]), bits: body.length });
  }
  return out;
}

/** Bits on the wire for a payload: payload + 32 FCS bits, stuffing, two flags. */
export const frameBits = (payload: ArrayLike<number>): number => frame(payload).length;

// ---- COBS --------------------------------------------------------------------------------------------------------

/** Consistent Overhead Byte Stuffing: the data without zero bytes, each block led by the distance to the next zero. */
export function cobsEncode(data: ArrayLike<number>): number[] {
  const out: number[] = [0];
  let code = 1, at = 0;
  const close = () => { out[at] = code; at = out.length; out.push(0); code = 1; };
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0) close();
    else { out.push(data[i]); if (++code === 0xff && i < data.length - 1) close(); }
  }
  out[at] = code;
  return out;
}

export function cobsDecode(enc: ArrayLike<number>): number[] | null {
  const out: number[] = [];
  for (let i = 0; i < enc.length;) {
    const code = enc[i];
    if (!code || i + code > enc.length) return null;
    for (let k = 1; k < code; k++) { if (!enc[i + k]) return null; out.push(enc[i + k]); }
    i += code;
    if (code < 0xff && i < enc.length) out.push(0);
  }
  return out;
}

/** Worst-case COBS overhead in bytes for n data bytes: one byte, then one more for every 254 beyond. */
export const cobsWorst = (n: number): number => Math.max(1, Math.ceil(n / 254));
