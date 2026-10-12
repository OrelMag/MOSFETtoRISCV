// Act 6's build levels: the pipeline register, the forwarding and hazard units, and four pipeline
// cores, each adding one mechanism (none, forwarding, the load-use stall, the branch flush). No DOM.

import type { BuildChallenge, PinSpec, SeqStep } from '../editor/challenges';
import { docFromDef } from '../editor/fromdef';
import type { ChipDoc } from '../editor/model';
import { CORE_PORTS } from '../lib/rv16/cpu';
import { FWD16, fwdSel, HAZ16, PREG16, type Rv16PipeOptions, rv16Pipe } from '../lib/rv16/pipe';
import type { ComponentDef } from '../sim/types';
import { coreCheck } from './corecheck';
import { pipeTests } from './coretests';
import { rng } from './drills';

const pins = (ins: [string, number?][], outs: [string, number?][], clock?: string): PinSpec[] => [
  ...ins.map(([name, width = 1]): PinSpec => ({ name, dir: 'in', width, ...(name === clock ? { clock: true } : {}) })),
  ...outs.map(([name, width = 1]): PinSpec => ({ name, dir: 'out', width })),
];

const answers = new Map<string, ChipDoc[]>();
const refOf = (id: string, def: () => ComponentDef, name: string) => (): ChipDoc[] => {
  let a = answers.get(id);
  if (!a) {
    const doc = docFromDef(def(), { id: `u_ref_cp_${id}`, name: `${name} ref` });
    if ('error' in doc) throw new Error(`reference ${id}: ${doc.error}`);
    answers.set(id, (a = [{ ...doc, notes: `Reference answer. ${def().summary ?? ''}`.trim() }]));
  }
  return a;
};

function pregSeq(): SeqStep[] {
  const r = rng(61);
  let q = 0;
  const st: SeqStep[] = [{ set: { d: 0xbeef, en: 1, clr: 0 }, tick: true, expect: { q: (q = 0xbeef) } }];
  for (let i = 0; i < 60; i++) {
    const d = Math.floor(r() * 0x10000), u = r();
    const en = u < 0.6 ? 1 : 0, clr = r() < 0.2 ? 1 : 0;
    q = clr ? 0 : en ? d : q;
    st.push({ set: { d, en, clr }, tick: true, expect: { q } });
  }
  return st;
}

const CORE_PINS: PinSpec[] = CORE_PORTS.map((p) => ({ name: p.name, dir: p.dir === 'out' ? 'out' : 'in', width: p.width, ...(p.name === 'clk' ? { clock: true } : {}) }));

const PIPE_BRIEF = (what: string) => `${what} Same pins as the single-cycle cores; the bench still serves instr = imem[pc] and drdata = dmem[daddr] in the same cycle. Report register writes from W (rwe, rwa, rwd) and stores from M (dwe, daddr, dwdata). Graded on NANDs, clock period and cycles.`;

const pipeLevel = (id: string, title: string, stage: 0 | 1 | 2 | 3, o: Rv16PipeOptions, cpi: number, brief: string, what: string) => (): BuildChallenge => ({
  id, title, level: 'cpu', allowed: 'nand', brief: PIPE_BRIEF(brief), ports: CORE_PINS,
  check: coreCheck({ tests: () => pipeTests(stage), budget: { cpi, extra: 8 } }, `${pipeTests(stage).length} programs: ${what}`),
  answer: refOf(id, () => rv16Pipe(o), title),
});

export const BUILD6: Record<string, () => BuildChallenge> = {
  pi_reg: () => ({
    id: 'pi_reg', title: 'Pipeline register', level: 'sequential', allowed: 'nand',
    brief: 'At the rising edge: <b>q ← 0</b> if <code>clr</code> (a bubble: all-zero control does nothing), else <b>q ← d</b> if <code>en</code>, else hold (a stall). Clear wins.',
    ports: pins([['d', 16], ['en'], ['clr'], ['clk']], [['q', 16]], 'clk'), check: { kind: 'sequence', steps: pregSeq() },
    answer: refOf('pi_reg', () => PREG16, 'Pipeline register'),
  }),
  pi_fwd: () => ({
    id: 'pi_fwd', title: 'Forwarding unit', level: 'cpu', allowed: 'nand',
    brief: 'For each source register of the instruction in E (<code>rs1</code>, <code>rs2</code>): <b>1</b> if the instruction in M writes it (<code>rweM</code>, <code>rdM</code>, not x0), else <b>2</b> if the one in W does, else <b>0</b>. The newest value wins: M before W.',
    ports: pins([['rs1', 3], ['rs2', 3], ['rdM', 3], ['rweM'], ['rdW', 3], ['rweW']], [['fa', 2], ['fb', 2]]),
    check: { kind: 'table', spec: ([rs1, rs2, rdM, rweM, rdW, rweW]) => [fwdSel(rs1, rdM, rweM, rdW, rweW), fwdSel(rs2, rdM, rweM, rdW, rweW)] },
    answer: refOf('pi_fwd', () => FWD16, 'Forwarding unit'),
  }),
  pi_haz: () => ({
    id: 'pi_haz', title: 'Hazard unit', level: 'cpu', allowed: 'nand',
    brief: '<b>stall</b> = 1 when a load is in E (<code>loadE</code>) and its destination <code>rdE</code> (not x0) is a source of the instruction in D (<code>rs1</code> or <code>rs2</code>). Its value only exists after M: one cycle too late to forward.',
    ports: pins([['rs1', 3], ['rs2', 3], ['rdE', 3], ['loadE']], [['stall']]),
    check: { kind: 'table', spec: ([rs1, rs2, rdE, loadE]) => [loadE && rdE && (rdE === rs1 || rdE === rs2) ? 1 : 0] },
    answer: refOf('pi_haz', () => HAZ16, 'Hazard unit'),
  }),
  pi_core0: pipeLevel('pi_core0', 'Pipeline I: five stages', 0, { fwd: false, stall: false, flush: false }, 1,
    'Cut your core into F, D, E, M, W with pipeline registers. The programs leave two independent instructions between every producer and its user, and have no branches: no hazards yet.',
    'two nops after every instruction, no branches; one instruction per cycle once the pipeline is full.'),
  pi_core1: pipeLevel('pi_core1', 'Pipeline II: forwarding', 1, { fwd: true, stall: false, flush: false }, 1,
    'Now a result is used by the very next instruction. Forward it from M or W into E instead of waiting for the register file.',
    'dependent instructions back to back (but a nop after every load), no branches; one instruction per cycle.'),
  pi_core2: pipeLevel('pi_core2', 'Pipeline III: load-use', 2, { fwd: true, stall: true, flush: false }, 1.6,
    'A loaded value is used at once: stall the front of the pipeline one cycle (hold PC and F/D, a bubble into E), then forward.',
    'loads used immediately, no branches; within 1.6 cycles per instruction.'),
  pi_core3: pipeLevel('pi_core3', 'Pipeline IV: branches', 3, { fwd: true, stall: true, flush: true }, 2.2,
    'Branches and jumps resolve in E: by then two younger instructions were fetched. On a taken branch or a jump, load the PC with the target and flush F/D and D/E.',
    'everything: loops, calls, every branch condition, random code; within 2.2 cycles per instruction.'),
};
