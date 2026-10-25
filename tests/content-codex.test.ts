// The codex's quoted numbers against the library, read from the entries' text: a change to either side fails here.
// (The codex files are plain strings; this test is their guard. Re-measure with stats() / corePeriod before editing.)

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { CODEX, codexById } from '../src/campaign/codex';
import { chapterSkip, Glossary } from '../src/campaign/glossary';
import { chapters } from '../src/chapters';
import { moreOf } from '../src/campaign/codexmore';
import { corePeriod } from '../src/campaign/corecheck';
import { CELL_C, BITLINE_C } from '../src/lib/dram';
import { resolveComponent } from '../src/lib/resolve';
import { rv16Core } from '../src/lib/rv16/cpu';
import { LANEDEC16, LANES16, RV16_SIMD } from '../src/lib/rv16/lanes16';
import { DEC3, DET101, RF8, RV16_ALU16, RV16_DFF, RV16_MUX4, RV16_MUX8, RV16_REG16 } from '../src/lib/rv16/logic';
import { RV16_MULTI } from '../src/lib/rv16/multi';
import { RV16_PIPE } from '../src/lib/rv16/pipe';
import { RV16_CPU_TRAP } from '../src/lib/rv16/system';
import { SENSE_OFFSET, VDD_VOLTS } from '../src/sim/switchsim';
import { stats } from '../src/sim/stats';
import { netlistOf, type ComponentDef } from '../src/sim/types';

const nands = (d: ComponentDef) => stats(d).nands;
/** A number as the codex writes it: 4,741 or 4 741 (thin or plain space). */
const num = (s: string) => Number(s.replace(/[,\s\u2009\u202f\u00a0]/g, ''));
const N = '(\\d{1,3}(?:[,\\s\\u2009\\u202f\\u00a0]\\d{3})*|\\d+)';
/** The numbers a pattern captures in a text (each `#` in the pattern is a number). */
function grab(text: string, pattern: string): number[] {
  const re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/#/g, N).replace(/ /g, '\\s+'));
  const m = re.exec(text);
  if (!m) throw new Error(`"${pattern}" not found in: ${text.slice(0, 120)}…`);
  return m.slice(1).map(num);
}
const idea = (id: string) => moreOf(id)!.idea;
const example = (id: string) => moreOf(id)!.example!.body;
const mistakes = (id: string) => moreOf(id)!.mistakes!.join(' ');
const summary = (id: string) => codexById(id)!.body;

/** Instances of a definition anywhere below `d`, counted per copy. */
function copies(d: ComponentDef, id: string): number {
  return (netlistOf(d)?.instances ?? []).reduce((n, i) => n + (i.def.id === id ? 1 : copies(i.def, id)), 0);
}
/** Two-input mux bits and their NANDs below `d` (a 16-bit RV16 mux counts 16 bits). */
function muxBits(d: ComponentDef): { bits: number; nands: number } {
  if (d.id === 'rv16_mux16') return { bits: 16, nands: nands(d) };
  if (d.id === 'mux2') return { bits: 1, nands: nands(d) };
  const r = { bits: 0, nands: 0 };
  for (const i of netlistOf(d)?.instances ?? []) { const s = muxBits(i.def); r.bits += s.bits; r.nands += s.nands; }
  return r;
}

const CPU = rv16Core(true), KS = rv16Core(true, true), MUL = rv16Core(true, false, 'mul');
const cpu = nands(CPU), rf = nands(RF8), alu = nands(RV16_ALU16);
const lane = nands(LANES16) / 4, laneTotal = rf + lane + nands(RV16_MUX4), simd = nands(RV16_SIMD);
const pct = (x: number) => Math.round(100 * x);

describe('the codex\'s RV16 core sizes', () => {
  it('quotes the single-cycle core as measured', () => {
    expect(grab(idea('cpu'), 'rv16_cpu</code> is # NANDs')).toEqual([cpu]);
    expect(grab(idea('cpu'), 'is # flip-flops (# for the PC, # for x1–x7)')).toEqual([copies(CPU, 'rv16_dff'), 16, 7 * 16]);
    expect(grab(idea('singlecycle'), 'rv16_cpu</code> (# NANDs) has a period of # NAND delays')).toEqual([cpu, corePeriod(CPU)]);
    expect(grab(idea('traps'), 'takes it from # to # NANDs')).toEqual([cpu, nands(RV16_CPU_TRAP)]);
    expect(grab(mistakes('multicycle'), '(# against # NANDs)')).toEqual([nands(RV16_MULTI), cpu]);
    expect(grab(idea('multicycle'), 'the period only falls from # to #')).toEqual([corePeriod(CPU), corePeriod(RV16_MULTI)]);
  });

  it('quotes the abstraction ladder', () => {
    const ex = example('abstraction');
    expect(grab(ex, '16-bit ALU # NANDs')).toEqual([alu]);
    expect(grab(ex, 'rv16_cpu # NANDs (# transistors)')).toEqual([cpu, stats(CPU).transistors]);
    expect(grab(ex, 'RV16 pipeline # NANDs')).toEqual([nands(RV16_PIPE)]);
    const fa = copies(CPU, 'full_adder');
    expect(grab(idea('abstraction'), 'appears # times')).toEqual([fa]);
    expect(grab(idea('abstraction'), 'saves # NANDs')).toEqual([fa * (13 - 9)]);
  });

  it('quotes the datapath\'s multiplexers', () => {
    const m = muxBits(CPU);
    expect(grab(idea('datapath'), '# bits of two-input mux make # of its # NANDs')).toEqual([m.bits, m.nands, cpu]);
    expect(m.nands / cpu).toBeGreaterThan(0.4);
    expect(m.nands / cpu).toBeLessThan(0.5); // "nearly half"
    const [inRf, inAlu] = grab(idea('datapath'), 'NANDs, nearly half: # in the register file\'s read ports and write enables, # in the ALU');
    expect([inRf, inAlu]).toEqual([muxBits(RF8).bits, muxBits(RV16_ALU16).bits]);
  });

  it('quotes one unit setting every period', () => {
    const ex = example('singlecycle');
    expect(grab(ex, 'rv16_cpu # NANDs period #')).toEqual([cpu, corePeriod(CPU)]);
    expect(grab(ex, 'with a Kogge–Stone ALU # NANDs period # (−#% time, +#% NANDs)'))
      .toEqual([nands(KS), corePeriod(KS), pct(1 - corePeriod(KS)! / corePeriod(CPU)!), pct(nands(KS) / cpu - 1)]);
    expect(grab(ex, 'with the array multiplier # NANDs period #')).toEqual([nands(MUL), corePeriod(MUL)]);
    expect(grab(example('cpi'), 'for # more NANDs (# → #')).toEqual([nands(KS) - cpu, cpu, nands(KS)]);
  });

  it('adds up the pipeline\'s E stage to its period', () => {
    const p = corePeriod(RV16_PIPE)!;
    expect(grab(idea('pipeline'), 'Its period is # NAND delays against the single-cycle core\'s #')).toEqual([p, corePeriod(CPU)]);
    const parts = grab(idea('pipeline'), '(# + # + # + # delays, then # through the E/M register\'s clear and enable muxes, plus # of clk-to-q and setup)');
    expect(parts.reduce((a, b) => a + b)).toBe(p);
    expect(grab(mistakes('pipeline'), 'has # flip-flops against the single-cycle core\'s #')).toEqual([copies(RV16_PIPE, 'rv16_dff'), copies(CPU, 'rv16_dff')]);
  });

  it('quotes the register file and its parts', () => {
    const [regs, muxes, dec] = grab(idea('regfile'), 'file is # NANDs: # of registers, # for the two 8:1 read muxes, # for the write decoder').slice(1);
    expect(grab(idea('regfile'), 'file is # NANDs')).toEqual([rf]);
    expect([regs, muxes, dec]).toEqual([7 * nands(RV16_REG16), 2 * nands(RV16_MUX8), nands(DEC3)]);
    expect(regs + muxes + dec).toBe(rf);
    expect(grab(example('register'), '= # of its # NANDs; the two 8:1 read muxes are # more')).toEqual([7 * nands(RV16_REG16), rf, 2 * nands(RV16_MUX8)]);
    expect(grab(example('register'), 'enable and clear: # NANDs')).toEqual([nands(resolveComponent('rv16_preg')!)]);
  });
});

describe('the codex\'s lanes', () => {
  it('quotes a lane and the SIMD core as measured', () => {
    expect(grab(summary('lane'), 'four lanes, # NANDs')).toEqual([lane]);
    expect(grab(idea('lane'), 'lane costs # NANDs (registers #, ALU, mux and nz #, result muxes #), #% of the single-cycle core\'s #'))
      .toEqual([laneTotal, rf, lane, nands(RV16_MUX4), pct(laneTotal / cpu), cpu]);
    expect(grab(idea('lane'), 'only #% smaller than four cores')).toEqual([pct(1 - simd / (4 * cpu))]);
    expect(grab(mistakes('lane'), 'twice the ALU (# against # NANDs)')).toEqual([rf, alu]);
    expect(grab(summary('vrf'), 'register files are # NANDs')).toEqual([4 * rf]);
    expect(4 * rf).toBeGreaterThan(simd / 2); // "more than half the SIMD core"
    expect(grab(idea('vrf'), 'four #-NAND files, # NANDs, #% of the SIMD core; built from flip-flops and mux trees it spends about # transistors per stored bit'))
      .toEqual([rf, 4 * rf, pct(4 * rf / simd), Math.round(4 * rf / (7 * 16))]);
  });

  it('quotes the SIMD core against four cores', () => {
    const ex = example('throughput');
    expect(grab(ex, 'single-cycle core # 98')).toEqual([cpu]);
    expect(grab(ex, 'four cores # 98')).toEqual([4 * cpu]);
    expect(grab(ex, 'SIMD core, 4 lanes # 100')).toEqual([simd]);
    expect(grab(idea('throughput'), 'for #.#× the NANDs')).toEqual([Math.floor(simd / cpu), Math.round(10 * simd / cpu) % 10]);
    const shared = simd - 4 * laneTotal;
    expect(grab(idea('simd'), 'of the SIMD core\'s # NANDs, # are shared and # belong to each lane, and four single-cycle cores would be #'))
      .toEqual([simd, shared, laneTotal, 4 * cpu]);
    const bill = example('simd');
    expect(grab(bill, 'shared, once #')).toEqual([shared]);
    const parts = grab(bill, 'next PC #, branch #, control #, PC # 4:1 muxes (leader rs1, rs2; immediate) # mask #, lane decoder #, PC muxes #, OR #');
    expect(parts.reduce((a, b) => a + b)).toBe(shared);
    expect(parts[6]).toBe(nands(LANEDEC16));
    expect(grab(bill, 'per lane, × 4 # registers #, ALU + mux + nz #')).toEqual([laneTotal, rf, lane]);
    expect(grab(bill, 'total #')).toEqual([simd]);
    expect(grab(bill, 'The register files alone are #: #% of the core')).toEqual([4 * rf, pct(4 * rf / simd)]);
  });
});

describe('the codex\'s other measured examples', () => {
  it('counts the 1-0-1 detector as the level\'s par does', () => {
    expect(grab(example('fsm'), 'Two #-NAND flip-flops (#) and # NANDs of logic: #')).toEqual([nands(RV16_DFF), 2 * nands(RV16_DFF), nands(DET101) - 2 * nands(RV16_DFF), nands(DET101)]);
  });

  it('gives the sense amplifier its signal in the simulator\'s volts', () => {
    const dv = CELL_C / (CELL_C + BITLINE_C) / 2; // a stored 1 or 0 against VDD/2, as a fraction of VDD
    const mv = Math.round(dv * VDD_VOLTS * 1000);
    for (const t of [summary('senseamp'), idea('senseamp')]) {
      expect(t).toContain(`±${dv} VDD`);
      expect(t).toContain(`${mv} mV at the simulator`);
      expect(t).toContain(`${VDD_VOLTS} V`);
    }
    expect(grab(summary('senseamp'), '# fF on # fF')).toEqual([CELL_C, BITLINE_C]);
    expect(grab(summary('senseamp'), 'offset (about # mV)')).toEqual([Math.round(SENSE_OFFSET * VDD_VOLTS * 1000)]);
  });

  it('quotes the decoders', () => {
    expect(grab(idea('decoder'), '3→8 is # NANDs (# with an enable), 4→16 is #'))
      .toEqual(['dec3', 'dec3e', 'dec4'].map((id) => nands(resolveComponent(id)!)));
    expect(grab(idea('decoder'), 'one 2-input AND per output, # NANDs with the enable')).toEqual([nands(DEC3)]);
  });

  it('quotes the multicycle controllers', () => {
    expect(grab(idea('microcode'), 'hardwired it is # NANDs; microcoded, with 20-bit microwords (14 control bits, a 4-bit next address, 2 sequencing bits), #'))
      .toEqual([nands(resolveComponent('mc_fsm')!), nands(resolveComponent('mc_micro')!)]);
  });
});

describe('the glossary in the chapters', () => {
  const g = new Glossary();
  const ids = (s: string) => g.find(s).map((m) => m.id);
  const plain = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ');

  it('marks the PC as an acronym and the program counter in words', () => {
    expect(ids('The PC holds the address; the program counter is a register.')).toEqual(['pc', 'pc']);
    expect(ids('a pc, the PCIe bus')).toEqual([]);
    expect(ids('An OR of two ANDs, not or and')).toEqual(['or', 'and']);
  });

  it('finds singular and short forms of plural titles', () => {
    expect(ids('a trap, an interrupt, a subnormal')).toEqual(['traps', 'interrupts', 'subnormal']);
    expect(ids('De Morgan turns it around')).toEqual(['demorgan']);
    expect(ids('the setup time and a hold violation')).toEqual(['setuphold', 'setuphold']);
    expect(ids('code 11 is a don\'t care; a precise exception')).toEqual(['dontcare', 'precise']);
    expect(ids('a relay step, an open page, the memory wall')).toEqual(['relaystep', 'pagepolicy', 'memwall']);
  });

  it('leaves phrases that borrow a term\'s word alone', () => {
    expect(ids('four byte lanes, PCIe lanes, the warp threads')).toEqual([]);
    expect(ids('a lane of a warp')).toEqual(['lane', 'warp']);
  });

  it('keeps the GPU act\'s terms out of the chapters before it', () => {
    for (const c of chapters) expect([...chapterSkip(c)].sort(), c.id).toEqual(c.num < 29 ? ['barrier', 'lane', 'warp'] : []);
    // The loom's warp in the prologue is found by the glossary but skipped there.
    const cards = chapters.find((c) => c.id === 'cards')!;
    const found = cards.steps.flatMap((s) => ids(plain(s.body)));
    expect(found).toContain('warp');
    expect(found.filter((id) => !chapterSkip(cards).has(id))).not.toContain('warp');
  });

  it('marks most codex entries somewhere in the chapters', () => {
    const hit = new Set<string>();
    for (const c of chapters) {
      const skip = chapterSkip(c);
      for (const s of c.steps) for (const id of ids(plain(s.body))) if (!skip.has(id)) hit.add(id);
    }
    const never = CODEX.filter((e) => !hit.has(e.id)).map((e) => e.id);
    expect(never.length / CODEX.length, never.join(' ')).toBeLessThanOrEqual(0.25); // 57 of 146 before the aliases
    for (const id of ['pc', 'traps', 'interrupts', 'subnormal', 'demorgan', 'setuphold', 'precise']) expect(hit, id).toContain(id);
  });
});
