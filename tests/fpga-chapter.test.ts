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

describe('the FPGA codex quotes the chapter\'s numbers', () => {
  it('every number in the entries, their fuller texts and questions comes from facts.ts', async () => {
    const { CODEX_FPGA } = await import('../src/campaign/codexfpga');
    const { MOREFPGA } = await import('../src/campaign/codexmorefpga');
    const { CHECKFPGA } = await import('../src/campaign/codexcheckfpga');
    const { COUNTER, block, fabricBits, pct, ramAsFlipFlops } = await import('../src/fpga/facts');
    const { groupDigits: g } = await import('../src/sim/numfmt');
    const raw = JSON.stringify([CODEX_FPGA, MOREFPGA, CHECKFPGA]);
    // the site's grouping: a narrow no-break space from 5 digits up, never a plain space
    expect(raw).not.toMatch(/\d \d{3}(?!\d)/);
    const all = raw.replace(/ +/g, ' ');
    const has = (s: string) => expect(all, s).toContain(s);
    const D = COMPUTER.device, p = pathShares(), rf = block('cpu.rf'), lb = lutConfigBits(), fb = fabricBits();
    has(`fifteen 2:1 muxes, ${lutCost(4).nands} NANDs`);
    has(`the same ${lutCost(4).bits} bits and ${lutCost(4).nands} NANDs whatever it computes`);
    has(`a LUT6 is ${lutCost(6).bits} bits and ${lutCost(6).nands} NANDs`);
    has(`(${lutCost(4).nands} NANDs at k = 4, ${lutCost(6).nands} at k = 6)`);
    has(`takes ${g(D.lut4.used)} of its ${g(D.lut4.available)} LUTs, ${g(D.dff.used)} flip-flops and ${D.bsram.used} of ${D.bsram.available} block RAMs`);
    has(`allows ${COMPUTER.fmax.clk.toFixed(1)} MHz`);
    has(`LUT4 ${g(D.lut4.used)} of ${g(D.lut4.available)} (${pct(D.lut4.used, D.lut4.available)} %)`);
    has(`uses ${pct(D.lut4.used, D.lut4.available)} % of the GW1NR-9`);
    has(`block RAM ${D.bsram.used} of ${D.bsram.available} (RAM ${bsramFor(RAM_WORDS, RAM_BITS)}, ROM ${bsramFor(ROM_WORDS, 32)})`);
    has(`slowest path ${p.ns.toFixed(1)} ns → ${COMPUTER.fmax.clk.toFixed(1)} MHz (routing ${p.routingPct} %)`);
    const bs = COUNTER.bitstream, extra = COMPUTER.bitstream.frames - bs.frames;
    has(`frames of ${g(bs.frameBits)} bits: ${g(bs.frames)} frames for the fabric, ${g(fb)} bits, of which the LUT tables are only ${g(lb)} (${pct(lb, fb)} %)`);
    has(`adds ${extra} frames`);
    has(`frame ${g(bs.frameBits)} bits`);
    has(`fabric (the counter) ${g(bs.frames)} frames = ${g(fb)} bits`);
    has(`of which LUT tables ${g(lb)} bits (${pct(lb, fb)} %)`);
    has(`our computer ${g(COMPUTER.bitstream.frames)} frames (+${extra}: memory contents)`);
    has(`the LUT tables are ${pct(lb, fb)} %`);
    has(`${extra} frames longer`);
    const rff = ramAsFlipFlops(), ramBits = RAM_WORDS * RAM_BITS, block16 = 16 * 1024;
    has(`has ${D.bsram.available} of 18 Kbit (16 Kbit of data)`);
    has(`takes ${bsramFor(RAM_WORDS, RAM_BITS)} of them; in flip-flops its ${g(ramBits)} bits would be ${rff.times.toFixed(0)} times`);
    has(`stays in ${g(rf.ffs)} flip-flops and ${g(rf.luts)} LUTs`);
    has(`RAM 4K × 32 = ${g(ramBits)} bits → ${bsramFor(RAM_WORDS, RAM_BITS)} blocks`);
    has(`ROM 1K × 32 = ${g(ROM_WORDS * 32)} bits → ${bsramFor(ROM_WORDS, 32)} blocks`);
    has(`→ ${g(rf.ffs)} flip-flops, ${g(rf.luts)} LUTs`);
    has(`${g(ramBits)} bits over 16 Kbit (${g(block16)} bits)`);
    has(`${g(RAM_WORDS)} × ${RAM_BITS} = ${g(ramBits)} bits, and ${g(ramBits)} / ${g(block16)} = ${bsramFor(RAM_WORDS, RAM_BITS)}`);
    has(`It is ${g(rf.ffs)} bits`);
    has(`the ${D.alu.used} carry cells`);
    has(`shows ${D.alu.used} carry cells`);
    has(`routing took ${p.routing.toFixed(1)} ns of ${p.ns.toFixed(1)}, logic ${p.logic.toFixed(1)}`);
    has(`routing ${p.routing.toFixed(1)} ns (${p.routingPct} %)`);
    has(`logic ${p.logic.toFixed(1)} ns (${p.lut4} LUT4s, ${p.wideMux} wide multiplexers)`);
    has(`skew ${p.skew.toFixed(1)} ns`);
    has(`total ${p.ns.toFixed(1)} ns → ${COMPUTER.fmax.clk.toFixed(1)} MHz`);
    has(`routing took ${p.routing.toFixed(1)} ns and logic ${p.logic.toFixed(1)} ns`);
    has(`most of the ${p.ns.toFixed(1)} ns`);
  });
});

describe('the bitstream', () => {
  it('the counter, with no block RAM, gives the fabric; the computer adds frames for its memories\' contents', async () => {
    const { COUNTER, fabricBits, lutConfigBits } = await import('../src/fpga/facts');
    expect(COUNTER.device.bsram.used).toBe(0);
    expect(COMPUTER.bitstream.frameBits).toBe(COUNTER.bitstream.frameBits);
    expect(COMPUTER.bitstream.frames).toBeGreaterThan(COUNTER.bitstream.frames);
    expect(fabricBits()).toBeGreaterThan(10 * lutConfigBits());
  });
});
