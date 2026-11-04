// Reed-Solomon over GF(256) (DOM-free): chapter 47's golden model for lib/rs.ts, and the decoder, which is built only here.
// The field is the widely used one, x^8 + x^4 + x^3 + x^2 + 1 (0x11D), with primitive element 2; the generator's roots are
// α^0 … α^(2t-1). That is QR's code and DVB's RS(204, 188) shortened from (255, 239): tests/comm-codes.test.ts holds the encoder to
// published QR vectors. CCSDS's 0x187, dual-basis code is a different one.

export const GF_POLY = 0x11d;

export const GF_EXP = new Uint8Array(512);
export const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) { GF_EXP[i] = x; GF_LOG[x] = i; x <<= 1; if (x & 0x100) x ^= GF_POLY; }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

export const gfMul = (a: number, b: number): number => (a && b ? GF_EXP[GF_LOG[a] + GF_LOG[b]] : 0);
const gfInv = (a: number): number => GF_EXP[255 - GF_LOG[a]];
export const gfPow = (e: number): number => GF_EXP[((e % 255) + 255) % 255];

/** The generator ∏ (x + α^i), i < nsym, highest power first; the leading coefficient is 1. */
export function rsGenerator(nsym: number): number[] {
  let g = [1];
  for (let i = 0; i < nsym; i++) {
    const a = gfPow(i), next = new Array<number>(g.length + 1).fill(0);
    g.forEach((c, j) => { next[j] ^= c; next[j + 1] ^= gfMul(c, a); });
    g = next;
  }
  return g;
}

/** One LFSR step, as the gates do it: state[0] is the highest power's register; feedback = byte ^ state[0]. */
export function rsStep(g: readonly number[], state: readonly number[], byte: number): number[] {
  const f = byte ^ state[0], n = state.length, out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = (i + 1 < n ? state[i + 1] : 0) ^ gfMul(f, g[i + 1]);
  return out;
}

/** The nsym parity bytes of a message. */
export function rsEncode(msg: ArrayLike<number>, nsym: number): number[] {
  const g = rsGenerator(nsym);
  let st = new Array<number>(nsym).fill(0);
  for (let i = 0; i < msg.length; i++) st = rsStep(g, st, msg[i]);
  return st;
}

/** S[i] = word(α^i): all zero exactly when the word is a multiple of the generator. */
export function rsSyndromes(word: ArrayLike<number>, nsym: number): number[] {
  const s = new Array<number>(nsym).fill(0);
  for (let i = 0; i < word.length; i++) for (let j = 0; j < nsym; j++) s[j] = gfMul(s[j], gfPow(j)) ^ word[i];
  return s;
}

export interface RsDecoded {
  /** The corrected word, or null when the decoder knows it cannot. */
  word: number[] | null;
  /** Positions it changed (index into the word). */
  fixed: number[];
  /** The locator's degree. */
  errors: number;
}

/** Berlekamp-Massey: the error locator Λ(x), lowest power first, from the syndromes. */
export function berlekampMassey(s: readonly number[]): number[] {
  let lam = [1], prev = [1], L = 0, m = 1, b = 1;
  for (let r = 0; r < s.length; r++) {
    let d = s[r];
    for (let i = 1; i <= L; i++) d ^= gfMul(lam[i] ?? 0, s[r - i]);
    if (d === 0) { m++; continue; }
    const coef = gfMul(d, gfInv(b)), next = lam.slice();
    while (next.length < prev.length + m) next.push(0);
    prev.forEach((c, i) => { next[i + m] ^= gfMul(coef, c); });
    if (2 * L <= r) { L = r + 1 - L; prev = lam; b = d; m = 1; } else m++;
    lam = next;
  }
  lam.length = Math.min(lam.length, L + 1);
  while (lam.length < L + 1) lam.push(0);
  return lam;
}

/** Bounded-distance decoding: up to nsym/2 byte errors corrected; more are refused, or (rarely) miscorrected into another code word. */
export function rsDecode(word: ArrayLike<number>, nsym: number): RsDecoded {
  const w = Array.from(word), s = rsSyndromes(w, nsym);
  if (s.every((x) => x === 0)) return { word: w, fixed: [], errors: 0 };
  const lam = berlekampMassey(s), L = lam.length - 1, n = w.length;
  if (2 * L > nsym) return { word: null, fixed: [], errors: L };
  // Chien: position p (from the word's end) is in error when Λ(α^-p) = 0. Forney with first root 0: e = X · Ω(X⁻¹) / Λ'(X⁻¹).
  const omega = new Array<number>(nsym).fill(0);
  for (let i = 0; i < nsym; i++) for (let j = 0; j <= Math.min(i, L); j++) omega[i] ^= gfMul(lam[j], s[i - j]);
  const fixed: number[] = [];
  for (let p = 0; p < n; p++) {
    const xinv = gfPow(-p);
    let v = 0;
    for (let i = L; i >= 0; i--) v = gfMul(v, xinv) ^ lam[i];
    if (v !== 0) continue;
    let om = 0, der = 0;
    for (let i = nsym - 1; i >= 0; i--) om = gfMul(om, xinv) ^ omega[i];
    for (let i = L; i >= 1; i--) if (i & 1) der ^= gfMul(lam[i], gfPow(-p * (i - 1)));
    if (der === 0) return { word: null, fixed: [], errors: L };
    const e = gfMul(gfMul(gfPow(p), om), gfInv(der));
    w[n - 1 - p] ^= e;
    fixed.push(n - 1 - p);
  }
  if (fixed.length !== L || rsSyndromes(w, nsym).some((x) => x !== 0)) return { word: null, fixed: [], errors: L };
  return { word: w, fixed: fixed.sort((a, b) => a - b), errors: L };
}

const logChoose = (n: number, k: number): number => { let r = 0; for (let i = 1; i <= k; i++) r += Math.log((n - k + i) / i); return r; };

/**
 * Bit error rate after a bounded-distance RS(n, k) on independent bit errors at p: bytes are wrong with probability P = 1 - (1 - p)^8;
 * i > t wrong bytes stay wrong (a miscorrection adds at most t more, ignored: the usual approximation), and within a wrong byte a bit is
 * wrong with probability p / P: at small p a wrong byte has one wrong bit, not four.
 */
export function rsBer(n: number, k: number, p: number): number {
  const t = Math.floor((n - k) / 2), P = 1 - (1 - p) ** 8;
  if (P <= 0) return 0;
  let sum = 0;
  for (let i = t + 1; i <= n; i++) sum += (i / n) * Math.exp(logChoose(n, i) + i * Math.log(P) + (n - i) * Math.log1p(-P));
  return sum * (p / P);
}
