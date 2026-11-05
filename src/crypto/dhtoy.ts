// Diffie-Hellman with numbers small enough to read (DOM-free): the idea X25519 runs on a curve, and how big a search stops being one.

/** 2^31 − 1, a Mersenne prime, and a generator of its whole multiplicative group (tests/secret-tls-steps.test.ts proves that). */
export const DH_P = 2147483647n, DH_G = 16807n;

export function modpow(b: bigint, e: bigint, m: bigint): bigint {
  let r = 1n, x = b % m, k = e;
  while (k > 0n) { if (k & 1n) r = (r * x) % m; x = (x * x) % m; k >>= 1n; }
  return r;
}

export interface DhRun { a: bigint; b: bigint; A: bigint; B: bigint; sharedA: bigint; sharedB: bigint }
export function dh(a: bigint, b: bigint): DhRun {
  const A = modpow(DH_G, a, DH_P), B = modpow(DH_G, b, DH_P);
  return { a, b, A, B, sharedA: modpow(B, a, DH_P), sharedB: modpow(A, b, DH_P) };
}

/** Eve with only A: multiply by g until it comes up. Stepped, so a page can keep drawing; found is the exponent, or null. */
export function eveSearch(A: bigint): { step(n: number): bigint | null; tried(): number } {
  let x = 1n, e = 0n, tried = 0;
  return {
    tried: () => tried,
    step(n: number) {
      for (let i = 0; i < n; i++) {
        e += 1n; x = (x * DH_G) % DH_P; tried++;
        if (x === A) return e;
      }
      return null;
    },
  };
}
