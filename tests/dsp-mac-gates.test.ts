// lib/macunit.ts, the MAC unit in gates, against dsp/mac.ts: the read path on its own, then the whole unit cycle by cycle on random instruction streams,
// the extremes of the 16-bit range, and the accumulator wrapping past 40 bits.
import { describe, expect, it } from 'vitest';
import { ACC_BITS, accAfter, MAC_F3, macProduct, raccOf, wrapAcc } from '../src/dsp/mac';
import { macRead, macUnit, readShifter } from '../src/lib/macunit';
import { evalOnce, simulate } from '../src/sim/harness';
import { stats } from '../src/sim/stats';
import { pack } from '../src/sim/values';
import { tick } from './yieldtick';

const lcg = (seed: number) => () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
const u40 = (v: bigint) => Number(BigInt.asUintN(ACC_BITS, v));

describe('the read path', () => {
  it('the shifter: every shift of a handful of words, equal to a BigInt shift', () => {
    const sim = simulate(readShifter()), rnd = lcg(1);
    const words = [0, 1, 2 ** 40, 2 ** 40 - 1, 2 ** 39, 2 ** 39 + 12345, ...Array.from({ length: 20 }, () => rnd() * 2 ** 9 + rnd() % 512)];
    for (const x of words) for (let sh = 0; sh < 64; sh++) {
      const want = Number(BigInt.asUintN(41, BigInt.asIntN(41, BigInt(x)) >> BigInt(sh)));
      expect(evalOnce(sim, [x, sh])[0], `${x} >> ${sh}`).toBe(want);
    }
  });
  it('shift, round once, clamp once: all 64 shifts of the edges, and random accumulators, equal to raccOf', () => {
    const sim = simulate(macRead()), rnd = lcg(2);
    const edges = [0n, 1n, -1n, 2n ** 39n - 1n, -(2n ** 39n), 2n ** 31n, -(2n ** 31n), 2n ** 31n - 1n, 2n ** 15n, -(2n ** 15n), 2n ** 15n - 1n, 2n ** 30n + 2n ** 14n];
    const accs = [...edges, ...Array.from({ length: 160 }, () => wrapAcc(BigInt(rnd()) * 256n + BigInt(rnd() % 256)))];
    for (const acc of accs) for (let sh = 0; sh < 64; sh++) {
      const [y, sat] = evalOnce(sim, [u40(acc), sh]), want = raccOf(acc, sh);
      expect(y, `${acc} >> ${sh}`).toBe(want.y >>> 0);
      expect(sat, `sat ${acc} >> ${sh}`).toBe(want.sat ? 1 : 0);
    }
  });
  it('ties round up, toward +infinity: 2.5 -> 3, -2.5 -> -2, -3.5 -> -3 (shift 1)', () => {
    expect(raccOf(5n, 1).y).toBe(3);
    expect(raccOf(-5n, 1).y).toBe(-2);
    expect(raccOf(-7n, 1).y).toBe(-3);
    expect(raccOf(0x7fffffffffn, 0).y).toBe(0x7fffffff);
    expect(raccOf(-(2n ** 39n), 0).y).toBe(-0x80000000);
  });
});

/** The unit against the model, one instruction a clock; returns the number of clamps and wraps seen. */
async function lockstep(ops: [number, number, number][]): Promise<{ sats: number; wraps: number }> {
  const sim = simulate(macUnit());
  const port = (n: string): number => pack(sim.getBits(sim.design.root.ports[n]));
  sim.setInput('a', 0); sim.setInput('b', 0); sim.setInput('op', 0); sim.setInput('en', 0); sim.setInput('sh', 0); sim.setInput('clk', 0);
  sim.reset('zero'); sim.settle();
  let acc = 0n, sats = 0, wraps = 0, i = 0;
  expect(port('acc')).toBe(0);
  for (const [f3, a, b] of ops) {
    sim.setInput('a', a >>> 0); sim.setInput('b', b >>> 0); sim.setInput('op', f3); sim.setInput('en', 1); sim.setInput('sh', a & 63); sim.settle();
    // racc: the result is read before the edge, from the accumulator as it is
    const want = raccOf(acc, a);
    expect(port('y'), `y before edge ${i}`).toBe(want.y >>> 0);
    expect(port('sat'), `sat before edge ${i}`).toBe(want.sat ? 1 : 0);
    sats += want.sat ? 1 : 0;
    sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle();
    const next = accAfter(acc, f3, a, b);
    if (f3 < 2 && acc + macProduct(f3, a, b) !== next) wraps++;
    acc = next;
    expect(port('acc'), `acc after ${i}: op ${f3}`).toBe(u40(acc));
    // en low: the accumulator holds whatever op says
    sim.setInput('en', 0); sim.setInput('op', 0); sim.settle(); sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle();
    expect(port('acc'), `held with en = 0 at ${i}`).toBe(u40(acc));
    if (++i % 64 === 0) await tick();
  }
  return { sats, wraps };
}

describe('the MAC unit, against its model every cycle', () => {
  it('mac, mac2, clracc and racc at the ends of the 16-bit range', async () => {
    const E = [0x8000, 0x7fff, 0xffff, 0, 1, 0x8000_0000, 0x7fff_ffff, 0x8000_7fff, 0x7fff_8000, 0xffff_ffff, 0x0001_ffff];
    const ops: [number, number, number][] = [];
    for (const a of E) for (const b of E) ops.push([MAC_F3.mac, a, b], [MAC_F3.mac2, a, b], [MAC_F3.racc, 15, 0]);
    ops.push([MAC_F3.clracc, 0, 0], [MAC_F3.racc, 0, 0]);
    await lockstep(ops);
  }, 120000);
  it('random streams of all four instructions, shifts 0 to 63, with clamps', async () => {
    const rnd = lcg(7), ops: [number, number, number][] = [];
    for (let i = 0; i < 400; i++) {
      const k = rnd() % 20, f3 = k < 8 ? 0 : k < 14 ? 1 : k < 15 ? 2 : 3;
      ops.push([f3, f3 === 3 ? ((rnd() & ~63) | (rnd() % 3)) >>> 0 : rnd(), rnd()]);
    }
    const r = await lockstep(ops);
    expect(r.sats, 'the clamp acted at least once').toBeGreaterThan(0);
  }, 120000);
  it('past 40 bits the accumulator wraps as two\'s complement, and the read sees the wrapped value', async () => {
    // 2^30 per mac: 2^29 of them make 2^59... a 40-bit register wraps after 512; use mac2 (2^31 each) to wrap in 256 steps
    const ops: [number, number, number][] = [[MAC_F3.clracc, 0, 0]];
    for (let i = 0; i < 300; i++) ops.push([MAC_F3.mac2, 0x8000_8000, 0x8000_8000]);
    ops.push([MAC_F3.racc, 0, 0]);
    const r = await lockstep(ops);
    expect(r.wraps, 'it wrapped').toBeGreaterThan(0);
    let acc = 0n;
    for (let i = 0; i < 300; i++) acc = accAfter(acc, MAC_F3.mac2, 0x8000_8000, 0x8000_8000);
    expect(acc, '300 x 2^31 = 2^31 x 300, minus 2^40 once: positive after the wrap').toBe(wrapAcc(300n * 2n ** 31n));
    expect(acc).toBeLessThan(2n ** 39n);
    expect(acc).not.toBe(300n * 2n ** 31n);
  }, 120000);
});

describe('what it costs', () => {
  it('counted from the gates', () => {
    const n = stats(macUnit()).nands;
    expect(n).toBeGreaterThan(8000);
    expect(n).toBeLessThan(14000);
  });
});
