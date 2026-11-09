// The FPGA chapter's numbers: every one computed (src/fpga/facts.ts) from the library and fpgacosts.json, so these pin
// what the prose says against independent derivations, and the chapter loads on its own (facts resolves parts by id).
import { describe, expect, it } from 'vitest';
import { chFpga } from '../src/chapters/ch-fpga';
import { bsramFor, COMPUTER, coverOf, kSweep, lutConfigBits, lutCost, nandsPerLut, pathShares, RAM_BITS, RAM_WORDS, ROM_WORDS } from '../src/fpga/facts';

const text = () => chFpga.steps.map((s) => `${s.body} ${Object.values(s.more ?? {}).join(' ')}`).join(' ');

describe('the FPGA chapter', () => {
  it('loads with its parts resolved and every step body built', () => {
    expect(chFpga.steps.length).toBeGreaterThanOrEqual(9);
    for (const s of chFpga.steps) expect(s.body.length).toBeGreaterThan(200);
    expect(text()).not.toMatch(/undefined|NaN/);
  });

  it('a LUT4 is fifteen 2:1 multiplexers and 16 bits', () => {
    expect(lutCost(4)).toEqual({ k: 4, nands: 15 * 4, bits: 16 });
  });

  it('covers: the full adder in 2 LUTs and 1 level; the ripple adder trades LUTs for a level', () => {
    expect(coverOf('full_adder')).toMatchObject({ nands: 9, luts: 2, levels: 1 });
    const r4 = coverOf('rca4');
    expect(r4.levels).toBeLessThan(4); // a LUT per bit's carry would be 4 levels in 8 LUTs
    expect(r4.luts).toBeGreaterThan(8);
  });

  it('larger LUTs: fewer of them and fewer levels, each costing twice the multiplexer', () => {
    const k = kSweep();
    for (let i = 1; i < k.length; i++) {
      expect(k[i].luts).toBeLessThan(k[i - 1].luts);
      expect(k[i].levels).toBeLessThanOrEqual(k[i - 1].levels);
      expect(k[i].muxNands).toBe(2 * k[i - 1].muxNands + 4);
    }
  });

  it('memories: the block RAMs the report shows are the RAM\'s and the ROM\'s bits over 16 Kbit', () => {
    expect(bsramFor(RAM_WORDS, RAM_BITS)).toBe(8);
    expect(bsramFor(ROM_WORDS, 32)).toBe(2);
    expect(bsramFor(RAM_WORDS, RAM_BITS) + bsramFor(ROM_WORDS, 32)).toBe(COMPUTER.device.bsram.used);
    expect(lutConfigBits()).toBe(COMPUTER.device.lut4.available * 16);
  });

  it('the critical path: its parts add up and routing dominates, as the prose says', () => {
    const p = pathShares();
    expect(p.skew + p.clkToQ + p.logic + p.routing + p.setup).toBeCloseTo(p.ns, 2);
    expect(p.routing).toBeGreaterThan(p.logic);
    expect(p.lut4 + p.wideMux).toBe(p.luts);
    expect(nandsPerLut()).toBeGreaterThan(1);
  });
});
