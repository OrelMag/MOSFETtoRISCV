// What the chapter's key-exchange and handshake steps show: the toy's numbers, the data carried to the browser, and each button's real outcome.
import { describe, expect, it } from 'vitest';
import { DH_G, DH_P, dh, eveSearch, modpow } from '../src/crypto/dhtoy';
import FLIGHT from '../src/crypto/tls/rfc8448.json';
import { flight } from '../scripts/tls-flight';
import { rfc8448Offer } from '../src/crypto/tls/hello';
import { collectTls, type Tamper, type Transport } from '../src/crypto/tls/run';

const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));
const hexOf = (b: ArrayLike<number>) => Array.from(b as ArrayLike<number> & Iterable<number>, (x) => x.toString(16).padStart(2, '0')).join('');

describe('the toy', () => {
  it('16807 generates the whole group mod 2^31 − 1: its order divides nothing smaller', () => {
    const order = DH_P - 1n, primes = [2n, 3n, 7n, 11n, 31n, 151n, 331n];
    expect(primes.reduce((a, q) => { let n = a; while (n % q === 0n) n /= q; return n; }, order)).toBe(1n);
    expect(modpow(DH_G, order, DH_P)).toBe(1n);
    for (const q of primes) expect(modpow(DH_G, order / q, DH_P)).not.toBe(1n);
  });
  it('both sides reach one number that was never sent', () => {
    for (const [a, b] of [[2n, 3n], [1234567n, 7654321n], [9999999n, 17n]]) {
      const r = dh(a, b);
      expect(r.sharedA).toBe(r.sharedB);
      expect(r.sharedA).toBe(modpow(DH_G, a * b, DH_P));
    }
  });
  it('Eve really does find the exponent', () => {
    const e = eveSearch(dh(54321n, 3n).A);
    let found: bigint | null = null;
    while (found === null) found = e.step(4000);
    expect(found).toBe(54321n);
    expect(e.tried()).toBe(54321);
  });
});

describe('what the browser gets', () => {
  it('rfc8448.json is the RFC text, regenerated: npm run the script when it differs', () => {
    expect(FLIGHT).toEqual(flight());
  });
});

describe('each button', () => {
  const server = (): Transport => {
    let q = unhex(FLIGHT.server.join(''));
    return { send: () => undefined, recv: (n) => { const k = Math.min(n, q.length), o = q.slice(0, k); q = q.slice(k); return o; } };
  };
  const run = (pin: Uint8Array | undefined, tamper?: Tamper) => collectTls({ config: { random: unhex(FLIGHT.random), privateKey: unhex(FLIGHT.privateKey), pin, offer: rfc8448Offer() }, transport: server(), tamper }).then((x) => x.result);
  const pin = unhex(FLIGHT.pin);
  it('as recorded: complete, and the client says what the RFC says, byte for byte', async () => {
    const r = await run(pin);
    expect(r.ok).toBe(true);
    expect(hexOf(r.sent[0])).toBe(FLIGHT.clientHello);
    expect(hexOf(r.sent[r.sent.length - 1])).toBe(FLIGHT.clientFinished);
    expect(r.checks.pin).toBe('pass');
  });
  it('a bit of the encrypted flight: a GCM tag catches it', async () => {
    const r = await run(pin, { flip: { record: 1, byte: 20, mask: 1 } });
    expect(r.ok).toBe(false); expect(r.error).toBe('mac');
  });
  it('a bit of the plain ServerHello: the keys change, and the next tag catches it', async () => {
    const r = await run(pin, { flip: { record: 0, byte: 20, mask: 1 } });
    expect(r.ok).toBe(false); expect(r.error).toBe('mac');
  });
  it('another key: stopped at the pin, before the signature is looked at', async () => {
    const r = await run(pin.map((b) => b ^ 0x5a));
    expect(r.ok).toBe(false); expect(r.error).toBe('pin');
    expect(r.checks.certificate_verify).toBe('not_reached');
  });
  it('no pin: it completes, to whoever answered', async () => {
    const r = await run(undefined);
    expect(r.ok).toBe(true);
    expect(r.checks.pin).toBe('not_configured');
  });
});
