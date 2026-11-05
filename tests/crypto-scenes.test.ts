// The chapter's scenes (widgets/secretscenes.ts), the vectors they carry, and the measured costs file.
import { describe, expect, it } from 'vitest';
import { SBOX, encryptBlock, encryptTrace } from '../src/crypto/aes';
import gateCosts from '../src/crypto/gatecosts.json';
import { measureSecretCosts } from '../src/crypto/costs';
import { H0, K, blocksOf, compressTrace, roundStep, sha256, utf8 } from '../src/crypto/sha256';
import { APPENDIX_B, SHA_ABC, SHA_TWO_BLOCK } from '../src/crypto/vectors';
import { aesCoreScene, aesRoundScene, sboxScene, secretBenches, shaCoreScene, shaRoundScene } from '../src/widgets/secretscenes';
import { simulate } from '../src/sim/harness';
import type { Sim } from '../src/sim/sim';
import { labelOverlaps } from '../src/view/route';
import { netlistOf } from '../src/sim/types';
import { routeNetlist, wireOverlaps } from '../src/view/route';
import vectors from './crypto/vectors.json';

const V = vectors as unknown as { fips197: { input: number[]; key: number[] }; sha: { messages: { text: string }[] } };
const bytes = (sim: Sim, port: string): number[] => {
  const bits = sim.getBits(sim.design.root.ports[port]);
  return Array.from({ length: bits.length / 8 }, (_, i) => { let v = 0; for (let j = 0; j < 8; j++) v |= bits[8 * i + j] << j; return v; });
};
const pulse = (sim: Sim) => { sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle(); };
const scene = (s: ReturnType<typeof sboxScene>): Sim => {
  const sim = simulate(s.root);
  for (const [k, v] of Object.entries(s.inputs ?? {})) sim.setInput(k, v);
  sim.reset('zero'); sim.settle();
  return sim;
};

describe('vectors', () => {
  it('the constants in src/crypto/vectors.ts are the ones read out of the standards', () => {
    expect(APPENDIX_B.input).toEqual(V.fips197.input);
    expect(APPENDIX_B.key).toEqual(V.fips197.key);
    expect([SHA_ABC, SHA_TWO_BLOCK]).toEqual(V.sha.messages.map((m) => m.text));
  });
});

describe('scenes', () => {
  it('S-box: 0x53 in, SBOX[0x53] out', () => {
    const sim = scene(sboxScene());
    expect(Array.from(sim.getBits(sim.design.root.ports.y)).reduce((a: number, b, i) => a + b * 2 ** i, 0)).toBe(SBOX[0x53]);
  });
  it('AES round 1 of Appendix B: out is the start of round 2; last = 1 skips MixColumns', () => {
    const t = encryptTrace(APPENDIX_B.input, APPENDIX_B.key), sim = scene(aesRoundScene());
    expect(bytes(sim, 'y')).toEqual(t.rounds[1].start);
    sim.setInput('last', 1); sim.settle();
    expect(bytes(sim, 'y')).not.toEqual(t.rounds[1].start);
  });
  it('AES core: start, eleven pulses, done, and the ciphertext of Appendix B', () => {
    const sim = scene(aesCoreScene());
    sim.setInput('start', 1); sim.settle(); pulse(sim); sim.setInput('start', 0); sim.settle();
    for (let i = 0; i < 10; i++) { expect(sim.getBits(sim.design.root.ports.done)[0]).toBe(0); pulse(sim); }
    expect(sim.getBits(sim.design.root.ports.done)[0]).toBe(1);
    expect(bytes(sim, 'out')).toEqual(encryptBlock(APPENDIX_B.input, APPENDIX_B.key));
  }, 60000);
  it('SHA-256 round 0 on "abc": the new a is the NIST table\'s first row', () => {
    const sim = scene(shaRoundScene()), blk = blocksOf(utf8(SHA_ABC))[0];
    const want = roundStep([...H0], K[0], blk[0]);
    const bits = sim.getBits(sim.design.root.ports.y), words = Array.from({ length: 8 }, (_, i) => { let v = 0; for (let j = 0; j < 32; j++) v += bits[32 * i + j] * 2 ** j; return v >>> 0; });
    expect(words).toEqual(want);
    expect(words[0]).toBe(compressTrace(H0, blk).rounds[0].vars[0]);
  });
  it('SHA-256 core: start, 65 pulses, the digest of "abc"', () => {
    const sim = scene(shaCoreScene());
    sim.setInput('start', 1); sim.settle(); pulse(sim); sim.setInput('start', 0); sim.settle();
    for (let i = 0; i < 63; i++) pulse(sim);
    expect(sim.getBits(sim.design.root.ports.done)[0]).toBe(0);
    pulse(sim);
    expect(sim.getBits(sim.design.root.ports.done)[0]).toBe(1);
    const bits = sim.getBits(sim.design.root.ports.out), hex = Array.from({ length: 8 }, (_, i) => { let v = 0; for (let j = 0; j < 32; j++) v += bits[32 * i + j] * 2 ** j; return (v >>> 0).toString(16).padStart(8, '0'); }).join('');
    expect(hex).toBe(sha256(utf8(SHA_ABC)));
  }, 60000);
  it('the benches draw cleanly: no label hides another, no two nets on one line', () => {
    for (const d of secretBenches()) {
      expect(labelOverlaps(d, netlistOf(d)!), d.id).toEqual([]);
      expect(wireOverlaps(routeNetlist(d, netlistOf(d)!).nets), d.id).toEqual([]);
    }
  });
});

describe('measured costs', () => {
  it('gatecosts.json is what the circuits measure today (npx vite-node scripts/secret-costs.ts --write)', () => {
    expect(gateCosts).toEqual(measureSecretCosts());
  }, 60000);
  it('the cores take 11 and 65 clocks to done', () => {
    expect(gateCosts.cores.aes_core.cycles).toBe(11);
    expect(gateCosts.cores.sha_core.cycles).toBe(65);
  });
});

// The chapter's Try text quotes these as the stage prints them, high end first, and the SHA step says to press Run.
describe('what the chapter says the stage shows', () => {
  const shown = (sim: Sim): string => {
    const bits = Array.from(sim.getBits(sim.design.root.ports.out), Number), parts: string[] = [];
    for (let w = bits.length - 32; w >= 0; w -= 32) { let v = 0; for (let i = 31; i >= 0; i--) v = v * 2 + bits[w + i]; parts.push(v.toString(16).toUpperCase().padStart(8, '0')); }
    return `0x${parts.join('_')}`;
  };
  const run = (sim: Sim, n: number) => { sim.setInput('start', 1); sim.settle(); pulse(sim); sim.setInput('start', 0); sim.settle(); for (let i = 0; i < n; i++) pulse(sim); };
  it('AES', () => {
    const sim = scene(aesCoreScene());
    run(sim, 10);
    expect(shown(sim)).toBe('0x320B6A19_978511DC_FB09DC02_1D842539');
  });
  it('SHA-256, and out holds once done is up, so Run cannot overshoot it', () => {
    const sim = scene(shaCoreScene());
    run(sim, 64);
    const want = '0xF20015AD_B410FF61_96177A9C_B00361A3_5DAE2223_414140DE_8F01CFEA_BA7816BF';
    expect(shown(sim)).toBe(want);
    for (let i = 0; i < 5; i++) pulse(sim);
    expect(shown(sim)).toBe(want);
    expect(sim.getBits(sim.design.root.ports.done)[0]).toBe(1);
  });
});
