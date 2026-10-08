// Act 8's later side quests: the MD opcode in the single-cycle core (multiplies, then stalling
// divides), a direct-mapped cache, a multicycle core and branch prediction in the pipeline. The
// reference answers are library blocks drawn as chips; the multiplier and divider units come along
// as chips of their own, so they are built (and checked) under the level's rule as well. No DOM.

import type { BuildChallenge, PinSpec, SeqStep } from '../editor/challenges';
import { docFromDef } from '../editor/fromdef';
import type { ChipDoc, PartRef } from '../editor/model';
import { CORE_PORTS, rv16Core } from '../lib/rv16/cpu';
import { DIV16, MUL16 } from '../lib/rv16/md';
import { RV16_CACHE, RV16_MULTI } from '../lib/rv16/multi';
import { rv16Pipe } from '../lib/rv16/pipe';
import type { ComponentDef } from '../sim/types';
import { coreCheck } from './corecheck';
import { coreTests, mdTests, predictTests } from './coretests';
import { rng } from './drills';

const CORE_PINS: PinSpec[] = CORE_PORTS.map((p) => ({ name: p.name, dir: p.dir === 'out' ? 'out' : 'in', width: p.width, ...(p.name === 'clk' ? { clock: true } : {}) }));
const CORE_NOTE = 'Same pins and bench as the single-cycle cores (instr and drdata served in the same cycle; register writes and stores compared in order with the golden model).';

const answers = new Map<string, ChipDoc[]>();
/** A reference answer: the top def drawn as a chip, and `subs` (def → chip) drawn as chips it places. */
const refOf = (id: string, def: () => ComponentDef, name: string, subs: () => [ComponentDef, string][] = () => []) => (): ChipDoc[] => {
  let a = answers.get(id);
  if (a) return a;
  const chips = new Map(subs().map(([d, n], i) => [d, { id: `u_ref_cp_${id}_${i}`, name: `${n} ref` }]));
  const refOfDef = (d: ComponentDef): PartRef | undefined => (chips.has(d) ? { chip: chips.get(d)!.id } : undefined);
  const docs: ChipDoc[] = [];
  for (const [d, c] of chips) {
    const doc = docFromDef(d, { ...c, refOf: refOfDef });
    if ('error' in doc) throw new Error(`reference ${id} (${d.id}): ${doc.error}`);
    docs.push({ ...doc, notes: `Part of the reference answer. ${d.summary ?? ''}`.trim() });
  }
  const top = docFromDef(def(), { id: `u_ref_cp_${id}`, name: `${name} ref`, refOf: refOfDef });
  if ('error' in top) throw new Error(`reference ${id}: ${top.error}`);
  answers.set(id, (a = [...docs, { ...top, notes: `Reference answer. ${def().summary ?? ''}`.trim() }]));
  return a;
};

/**
 * The cache's bench: a seeded access sequence with locality and conflicts. Main memory (mdata) is
 * served by the bench, but only on a miss: on a hit it carries junk, so the line must answer.
 */
function cacheSteps(n: number): SeqStep[] {
  const r = rng(77);
  const mem = Array.from({ length: 256 }, () => Math.floor(r() * 0x10000));
  const lines = Array.from({ length: 8 }, () => ({ valid: false, tag: 0, data: 0 }));
  const hot = [0x10, 0x11, 0x12, 0x13, 0x58, 0x90, 0x91, 0xd0]; // 0x10 / 0x90 / 0xd0 / 0x58 collide in pairs
  const st: SeqStep[] = [];
  for (let i = 0; i < n; i++) {
    const addr = r() < 0.7 ? hot[Math.floor(r() * hot.length)] : Math.floor(r() * 256);
    const u = r();
    const rd = u < 0.6 ? 1 : 0, wr = !rd && u < 0.9 ? 1 : 0;
    const wdata = Math.floor(r() * 0x10000);
    const l = lines[addr & 7], tag = addr >> 3;
    const hit = l.valid && l.tag === tag;
    const mdata = hit ? Math.floor(r() * 0x10000) : mem[addr];
    st.push({ set: { addr, rd, wr, wdata, mdata }, expect: { hit: hit ? 1 : 0, ...(rd ? { rdata: mem[addr] } : {}) } });
    st.push({ tick: true, expect: {} });
    if (wr) {
      mem[addr] = wdata;
      Object.assign(l, { valid: true, tag, data: wdata });
    } else if (rd && !hit) Object.assign(l, { valid: true, tag, data: mem[addr] });
  }
  return st;
}

export const BUILD9: Record<string, () => BuildChallenge> = {
  o_mcore: () => ({
    id: 'o_mcore', title: 'Multiply in the core', level: 'cpu', allowed: 'nand',
    brief: `Core III plus the MD opcode's multiplies: <b>mul</b> (low half), <b>mulh</b> (high half, both signed), <b>mulhsu</b> (a signed, b unsigned), <b>mulhu</b> (both unsigned), one per cycle. A 16 × 16 unsigned array multiplier is given; the high half of a signed product is the unsigned one minus b when a &lt; 0 (and minus a when b &lt; 0). ${CORE_NOTE} Divides are not tested here.`,
    ports: CORE_PINS,
    check: coreCheck({ tests: () => mdTests('mul'), budget: { cpi: 1, extra: 2 }, m: true }, `${mdTests('mul').length} programs: every multiply on edge values, random code with multiplies, and Core III's own tests.`),
    answer: refOf('o_mcore', () => rv16Core(true, false, 'mul'), 'Multiply core', () => [[MUL16, 'MD multiplier']]),
  }),
  o_dcore: () => ({
    id: 'o_dcore', title: 'Divide in the core', level: 'cpu', allowed: 'nand',
    brief: `Add <b>div</b>, <b>divu</b>, <b>rem</b>, <b>remu</b>. The iterative divider is given: start it, hold the PC (and write nothing) until done, then write the result. Signed: divide |a| by |b|, then the quotient takes the sign a XOR b and the remainder the sign of a. RISC-V's rules: x / 0 = −1 (all ones), x rem 0 = x; −32768 / −1 = −32768, remainder 0. ${CORE_NOTE}`,
    ports: CORE_PINS,
    check: coreCheck({ tests: () => mdTests('all'), budget: { cpi: 20, extra: 20 }, m: true }, `${mdTests('all').length} programs: every divide on edge values (by zero, overflow, mixed signs), a digit loop, random code with multiplies and divides.`),
    answer: refOf('o_dcore', () => rv16Core(true, false, 'div'), 'Divide core', () => [[DIV16, 'MD divider']]),
  }),
  o_cache: () => ({
    id: 'o_cache', title: 'A cache', level: 'sequential', allowed: 'nand',
    brief: 'A direct-mapped cache of eight one-word lines in front of a 256-word memory: <b>index</b> = addr[2:0], <b>tag</b> = addr[7:3]. <code>hit</code> = the line is valid and holds this tag (combinational, for every access). A read (<code>rd</code>) answers <code>rdata</code> from the line on a hit, else from the memory (<code>mdata</code>), and fills the line at the clock edge. A write (<code>wr</code>) puts wdata in the line (write-through: the bench writes the memory). <b>On a hit the bench does not read the memory</b>: mdata then carries junk.',
    ports: [
      { name: 'clk', dir: 'in', width: 1, clock: true }, { name: 'addr', dir: 'in', width: 8 }, { name: 'rd', dir: 'in', width: 1 }, { name: 'wr', dir: 'in', width: 1 },
      { name: 'wdata', dir: 'in', width: 16 }, { name: 'mdata', dir: 'in', width: 16 }, { name: 'rdata', dir: 'out', width: 16 }, { name: 'hit', dir: 'out', width: 1 },
    ],
    check: { kind: 'sequence', init: { rd: 0, wr: 0 }, steps: cacheSteps(300) },
    answer: refOf('o_cache', () => RV16_CACHE, 'Cache'),
  }),
  o_mc: () => ({
    id: 'o_mc', title: 'Multicycle CPU', level: 'cpu', allowed: 'nand',
    brief: `All of RV16I again, but each instruction over several short cycles run by a state machine: <b>F</b> loads an instruction register, <b>E</b> computes into an ALU register, <b>M</b> (loads and stores) uses memory, <b>W</b> writes the register file and the PC. Keep the PC on the instruction until W. ${CORE_NOTE} Graded on NANDs, clock period and cycles: compare period × cycles with Core III.`,
    ports: CORE_PINS,
    check: coreCheck({ tests: () => coreTests(3), budget: { cpi: 5, extra: 4 } }, `${coreTests(3).length} programs, as Core III, within 5 cycles per instruction.`),
    answer: refOf('o_mc', () => RV16_MULTI, 'Multicycle core'),
  }),
  o_bpred: () => ({
    id: 'o_bpred', title: 'Branch prediction', level: 'cpu', allowed: 'nand',
    brief: 'Pipeline IV loses two cycles on every taken branch or jump. Guess in F instead: decode the fetched word, and when it is a jal or a backward branch (a loop), fetch from pc + imm at once. E then checks the guess and redirects only when it was wrong (to the target, or back to pc + 1). Same pins and bench as the pipelines; graded on cycles first.',
    ports: CORE_PINS,
    check: coreCheck({ tests: () => predictTests(), budget: { cpi: 3, extra: 8 } }, `${predictTests().length} programs: nested loops, a copy loop with calls, a sort, then Pipeline IV's tests.`),
    answer: refOf('o_bpred', () => rv16Pipe({ fwd: true, stall: true, flush: true, predict: true }), 'Predicting pipeline'),
  }),
};
