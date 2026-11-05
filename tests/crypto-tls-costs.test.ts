// src/crypto/tls/costs.json is what scripts/tls-costs.ts measured; this re-measures and holds the file to the code. Sizes and the deterministic handshake (RFC 8448) must
// match exactly; the figures that depend on data (GHASH's conditional XORs, the final compares of the Montgomery product, a PSS signature's random salt) to within 1 %.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { measureCosts, type Costs } from '../scripts/tls-costs-measure';

const file: Costs = JSON.parse(readFileSync(new URL('../src/crypto/tls/costs.json', import.meta.url), 'utf8'));
const close = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol * Math.max(a, b);

describe('the checked-in costs are the measured ones', () => {
  it('lines, words, RAM, primitives and handshake phases', async () => {
    const now = await measureCosts();
    expect(now.model).toBe(file.model);
    expect(now.lines).toEqual(file.lines);
    expect(now.words).toEqual(file.words);
    expect(now.ram).toEqual(file.ram);
    expect(Object.keys(now.primitives)).toEqual(Object.keys(file.primitives));
    for (const [k, v] of Object.entries(now.primitives)) expect(close(v, file.primitives[k]), `${k}: ${v} vs ${file.primitives[k]}`).toBe(true);
    expect(Object.keys(now.handshake)).toEqual(Object.keys(file.handshake));
    for (const [k, h] of Object.entries(now.handshake)) {
      const f = file.handshake[k];
      expect(h.rsaBits).toBe(f.rsaBits);
      expect(close(h.cycles, f.cycles), `${k} total`).toBe(true);
      for (const [p, c] of Object.entries(h.phases)) expect(close(c, f.phases[p], 0.02), `${k} / ${p}`).toBe(true);
      expect({ a: h.clientHelloBytes, b: h.bytesSent, c: h.bytesReceived }).toEqual({ a: f.clientHelloBytes, b: f.bytesSent, c: f.bytesReceived });
    }
    expect(now.rv32i.words).toBe(file.rv32i.words);
    for (const [k, v] of Object.entries(now.rv32i.primitives)) expect(close(v, file.rv32i.primitives[k]), `rv32i ${k}`).toBe(true);
    expect(now.rv32i.handshake.cycles).toBe(file.rv32i.handshake.cycles);
    // the replay of RFC 8448 has no randomness at all: its cycle count is exact
    const rfc = 'rfc8448 (1024-bit RSA, three cipher suites offered)';
    expect(now.handshake[rfc].cycles).toBe(file.handshake[rfc].cycles);
  }, 120_000);
});
