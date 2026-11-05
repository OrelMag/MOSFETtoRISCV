// The tier capstones as build challenges (learn/capstones.ts lists them): one design per tier from a spec sheet,
// graded by benches the campaign already has, with no walkthrough, hints or "Do it for me" until it is passed.
// A capstone is a BuildChallenge like a level's (campaign/levels.ts) but not a campaign node: its progress is kept
// under its own id in the campaign state (progress.ts), its chip is u_ch_<id>, and it is played on
// ui/pages/capstone.ts (#/campaign/play/<id>). No DOM.

import { groupDigits } from '../sim/numfmt';
import { type AnyCapstone, CAPSTONES, COMM_CAPSTONES, type Capstone, type CapstoneStatus, capstoneStatus } from '../learn/capstones';
import { type BuildChallenge, type ChallengeCheck, type CheckResult, checkChallenge, type LibRule, type PinSpec, type SeqStep } from '../editor/challenges';
import { docFromDef } from '../editor/fromdef';
import { UserLibrary } from '../editor/library';
import { type ChipDoc, emptyWorkspace } from '../editor/model';
import { Builder } from '../lib/builder';
import { FULL_ADDER, HALF_ADDER } from '../lib/combinational';
import { define, merger, ones, splitter } from '../lib/define';
import { AND, MUX2, NOT } from '../lib/gates';
import { rv16Core } from '../lib/rv16/cpu';
import { RV16_DFF } from '../lib/rv16/logic';
import { rv16Pipe } from '../lib/rv16/pipe';
import { PONG16 } from '../riscv/rv16/pong16';
import { stats } from '../sim/stats';
import type { ComponentDef } from '../sim/types';
import { UART_CORE } from '../lib/uart';
import { pinsOf } from './buildcomm';
import { CONSOLE_ERR, runConsole } from './capcomm';
import { CORE_BRIEF, CORE_PINS } from './build5';
import { BRIEF_BUDGET, briefSpec, briefTests } from './brief';
import { type CoreCheck, coreCheck, type CoreTest, corePeriod } from './corecheck';
import { coreTests, pipeTests } from './coretests';
import { rng } from './drills';
import { ruleFor, unlockedPartCount } from './graph';

export const capstoneById = (id: string): AnyCapstone | undefined => CAPSTONES.find((c) => c.id === id) ?? COMM_CAPSTONES.find((c) => c.id === id);

/** What the console may place beyond the two levels: the blocks it is not about. */
const CONSOLE_GIVEN = ['fifo16x8', 'baud12'];

export const capstoneChipId = (id: string): string => `u_ch_${id}`;

export const capstoneOfChip = (chipId: string): AnyCapstone | undefined => [...CAPSTONES, ...COMM_CAPSTONES].find((c) => capstoneChipId(c.id) === chipId);

/** True once the capstone is passed: only then do its reference answer and "Do it for me" open. */
export const solutionsOpen = (id: string, nodes: Record<string, { status?: string } | undefined>): boolean => capstoneStatus(id, nodes) === ('passed' satisfies CapstoneStatus);

// ---- the parts each capstone allows ------------------------------------------------------------------

/**
 * What the capstone may be built from: the parts the tier's last levels unlock (campaign/graph.ts ruleFor over the
 * closure of those levels), minus the finished blocks the capstone is about, so it cannot be solved by placing one.
 */
function tierRule(ids: readonly string[], drop: readonly string[]): LibRule {
  const lib = new Set<string>(['nand']);
  for (const id of ids) for (const u of ruleFor(id).lib) lib.add(u);
  for (const d of drop) lib.delete(d);
  const n = unlockedPartCount({ lib: [...lib] });
  return { lib: [...lib].sort(), label: `NAND + ${n} unlocked part${n === 1 ? '' : 's'}`, gates: true };
}

const rules = new Map<string, LibRule>();
/** The capstone's allowed parts (memoized). */
export function capstoneRule(id: string): LibRule | undefined {
  let r = rules.get(id);
  if (!r) {
    // tier 1: the gates, adders and flip-flops of acts 1–3 (the enable flip-flop and registers are what it builds)
    if (id === 'cap_t1') r = tierRule(['a_add4', 's_reg4'], []);
    // tiers 2 and 3: everything the core levels unlocked, not the finished core
    else if (id === 'cap_t2') r = tierRule(['c_fast'], ['rv16_cpu']);
    else if (id === 'cap_t3') r = tierRule(['pi_core3'], ['rv16_cpu']);
    // tier 4: everything the core levels of acts 5–6 unlocked (the multicycle and predicting cores too), not the finished cores
    else if (id === 'cap_t4') r = tierRule(['pi_core3', 'o_mc', 'o_bpred'], ['rv16_cpu', 'rv16_mc']);
    // the serial console: the transmitter and receiver levels' parts, and the FIFO and the baud generator as given blocks
    else if (id === 'cap_console') { const t = tierRule(['l_uarttx', 'l_uartrx'], ['uart_full']); r = { ...t, lib: [...new Set([...t.lib, ...CONSOLE_GIVEN])].sort() }; }
    if (r) rules.set(id, r);
  }
  return r;
}

// ---- tier 1: an adding machine -----------------------------------------------------------------------

const pins = (ins: [string, number?][], outs: [string, number?][], clock?: string): PinSpec[] => [
  ...ins.map(([name, width = 1]): PinSpec => ({ name, dir: 'in', width, ...(name === clock ? { clock: true } : {}) })),
  ...outs.map(([name, width = 1]): PinSpec => ({ name, dir: 'out', width })),
];

/** The accumulator's rule at each rising edge: rst clears both, else add adds d and keeps the carry out, else hold. */
export function accNext(s: { acc: number; c: number }, d: number, add: number, rst: number): { acc: number; c: number } {
  if (rst) return { acc: 0, c: 0 };
  if (!add) return s;
  const t = s.acc + d;
  return { acc: t & 15, c: t >> 4 };
}

function accSteps(): SeqStep[] {
  const r = rng(4107);
  let s = { acc: 0, c: 0 };
  const st: SeqStep[] = [];
  const tick = (d: number, add: number, rst: number) => {
    s = accNext(s, d, add, rst);
    st.push({ set: { d, add, rst }, tick: true, expect: { acc: s.acc, c: s.c } });
  };
  tick(0, 0, 1);
  // directed: a plain sum, hold with add = 0, the carry out and its holding, reset beating add, d wiggling between edges
  tick(5, 1, 0); tick(9, 1, 0); tick(3, 0, 0); tick(3, 1, 0); tick(0, 0, 0); tick(0, 1, 0); tick(15, 1, 0); tick(15, 1, 0);
  tick(7, 1, 1); tick(1, 1, 0);
  st.push({ set: { d: 9, add: 1 }, expect: { acc: s.acc, c: s.c } }); // nothing happens between edges
  st.push({ set: { d: 4, add: 0 }, expect: { acc: s.acc, c: s.c } });
  tick(4, 1, 0);
  for (let i = 0; i < 48; i++) {
    const d = Math.floor(r() * 16), add = r() < 0.7 ? 1 : 0, rst = r() < 0.08 ? 1 : 0;
    tick(d, add, rst);
  }
  return st;
}

/** The reference accumulator: four adders (a half adder at bit 0), a flip-flop per bit with its hold / clear gating, and a carry flag. */
/** noReset: the clear gating left out (the tests' broken variant). */
export function accumulatorDef(noReset = false): ComponentDef {
  const b = new Builder(12, 10, 4);
  b.pins('d', 'add', 'rst', 'clk');
  const nrst = b.op1(NOT, [noReset ? 'add' : 'rst'], noReset ? 'not add' : 'not rst');
  const sd = b.op(splitter(ones(4), 4), ['d'], undefined, 'sd');
  b.next();
  // the flip-flops come first in the netlist so their outputs can feed the adders (Builder labels the feedback)
  const q = [0, 1, 2, 3].map((i) => b.add(RV16_DFF, `acc[${i}]`, `ff${i}`));
  const qc = b.add(RV16_DFF, 'carry flag', 'ffc');
  b.next();
  const sum: string[] = [];
  let carry = '';
  for (let i = 0; i < 4; i++) {
    const add = i === 0 ? b.op(HALF_ADDER, [`${q[i]}.q`, `${sd}.o${i}`], 'bit 0', `add${i}`) : b.op(FULL_ADDER, [`${q[i]}.q`, `${sd}.o${i}`, carry], `bit ${i}`, `add${i}`);
    sum.push(`${add}.s`);
    carry = `${add}.${i === 0 ? 'c' : 'cout'}`;
  }
  b.next();
  // next = ¬rst · (add ? sum : q)
  const next = sum.map((s, i) => b.op1(AND, [b.op1(MUX2, [`${q[i]}.q`, s, 'add'], `bit ${i}: add or hold`), nrst], `bit ${i}: clear`));
  const nextC = b.op1(AND, [b.op1(MUX2, [`${qc}.q`, carry, 'add'], 'carry: add or hold'), nrst], 'carry: clear');
  next.forEach((n, i) => b.wire(n, `${q[i]}.d`));
  b.wire(nextC, `${qc}.d`);
  for (const f of [...q, qc]) b.wire('clk', `${f}.clk`);
  b.next();
  b.wire(b.op1(merger(ones(4), 4), q.map((f) => `${f}.q`), 'acc'), 'acc');
  b.wire(`${qc}.q`, 'c');
  const R = b.right;
  return define({
    id: noReset ? 'cap_acc_broken' : 'cap_acc', name: 'Accumulator (4 bits)', category: 'sequential',
    summary: 'acc ← 0 on rst, acc ← acc + d on add (the carry out kept in c), else hold.',
    ports: [{ name: 'd', width: 4, dir: 'in' }, { name: 'add', width: 1, dir: 'in' }, { name: 'rst', width: 1, dir: 'in' }, { name: 'clk', width: 1, dir: 'in', clock: true },
      { name: 'acc', width: 4, dir: 'out' }, { name: 'c', width: 1, dir: 'out' }],
    symbol: { kind: 'box', label: 'ACC' },
    netlist: () => ({ pins: { d: [0, 6], add: [0, 10], rst: [0, 14], clk: [0, 18], acc: [R, 6], c: [R, 10] }, instances: b.instances, nets: b.nets() }),
  });
}

export const ACCUMULATOR = accumulatorDef();

const answers = new Map<string, ChipDoc[]>();
const refOf = (id: string, def: () => ComponentDef, name: string) => (): ChipDoc[] => {
  let a = answers.get(id);
  if (!a) {
    const doc = docFromDef(def(), { id: `u_ref_${id}`, name: `${name} (reference)` });
    if ('error' in doc) throw new Error(`reference ${id}: ${doc.error}`);
    answers.set(id, (a = [{ ...doc, notes: `Reference answer. ${def().summary ?? ''}`.trim() }]));
  }
  return a;
};

// ---- tiers 2 and 3: a core, and Pong on it -----------------------------------------------------------------

/** Instructions of Pong the core must reproduce (a game that never halts: the golden model's first steps, every write compared). */
export const PONG_STEPS = 4000;

const PONG_TEST: CoreTest = {
  name: 'Pong', bounded: PONG_STEPS,
  what: `the game of Pong (${groupDigits(PONG_STEPS)} instructions: the serve, the paddles drawn, the ball from the middle to the left edge, off the top wall, past the paddle, and the point scored)`,
  src: PONG16,
};

const t2Tests = (): CoreTest[] => [...coreTests(3), PONG_TEST];
const t3Tests = (): CoreTest[] => [...pipeTests(3), PONG_TEST];

/** A five-stage core's first register write after reset: F, D, E, M, W (cycle 5; a single-cycle core writes in cycle 1). */
export const PIPE_FIRST_WRITE = 4;

/** The period of the reference single-cycle core: a pipeline must beat it. */
let singleCycle: number | null | undefined;
export const singleCyclePeriod = (): number | null => (singleCycle === undefined ? (singleCycle = corePeriod(rv16Core(true))) : singleCycle);

function pipelined(spec: ReturnType<typeof coreCheck>): CoreCheck {
  const custom = spec as Extract<ChallengeCheck, { kind: 'custom' }> & CoreCheck;
  return {
    ...custom,
    run: (def, mode) => {
      const r = custom.run(def, mode);
      const one = singleCyclePeriod();
      if (!r.failures.length && r.period !== undefined && one !== null && r.period >= one) {
        r.failures.push(`correct, but the clock period is ${r.period}, no better than the single-cycle core's ${one}: cut the path with pipeline registers`);
      }
      return r;
    },
  };
}

// ---- the challenges ----------------------------------------------------------------------------------

const cache = new Map<string, BuildChallenge>();

/** The capstone as a build challenge (memoized), or undefined while its tier has none. */
export function capstoneChallenge(id: string): BuildChallenge | undefined {
  let c = cache.get(id);
  if (c) return c;
  const meta = capstoneById(id), allowed = capstoneRule(id);
  if (!meta || !allowed) return undefined;
  const base = { id, title: meta.title, level: 'cpu' as const, allowed };
  if (id === 'cap_t1') {
    c = {
      ...base, level: 'sequential',
      brief: 'A 4-bit adding machine. At each rising edge of <code>clk</code>: if <code>rst</code> = 1, <b>acc ← 0</b> and <b>c ← 0</b> (reset wins over everything); else if <code>add</code> = 1, <b>{c, acc} ← acc + d</b> (c is the carry out of that addition); else both hold. <code>d</code> changing between edges changes nothing. You are given no walkthrough and no hints: only the parts your own levels unlocked.',
      ports: pins([['d', 4], ['add'], ['rst'], ['clk']], [['acc', 4], ['c']], 'clk'),
      check: { kind: 'sequence', steps: accSteps() },
      answer: refOf('cap_t1', () => ACCUMULATOR, 'Accumulator'),
    };
  } else if (id === 'cap_t2') {
    c = {
      ...base,
      brief: CORE_BRIEF('The whole of RV16I in one cycle per instruction: arithmetic, loads and stores, branches and jumps. No walkthrough and no hints: the spec is all you get.')
        + ` Graded on ${coreTests(3).length} programs and then on <b>Pong</b>: the golden model's first ${groupDigits(PONG_STEPS)} instructions of the game, every register write and store compared. Scored on NANDs, clock period and cycles.`,
      ports: CORE_PINS,
      check: coreCheck({ rv16i: true, tests: t2Tests, budget: { cpi: 1, extra: 2 } },
        `${coreTests(3).length} programs (loops, calls, every branch condition, random code) and Pong: every register write and store, in order, one instruction per cycle.`),
      answer: refOf('cap_t2', () => rv16Core(true), 'Single-cycle RV16 core'),
    };
  } else if (id === 'cap_t3') {
    c = {
      ...base,
      brief: CORE_BRIEF('The same RV16I as a five-stage pipeline: forwarding, the load-use stall and the branch flush. Report register writes from W (<code>rwe</code>, <code>rwa</code>, <code>rwd</code>) and stores from M. No walkthrough and no hints.')
        + ` Within 2.2 cycles per instruction on ${pipeTests(3).length} programs and Pong; a pass also needs a clock period below the single-cycle core's. Scored on period × cycles.`,
      ports: CORE_PINS,
      check: pipelined(coreCheck({ rv16i: true, tests: t3Tests, budget: { cpi: 2.2, extra: 8 }, minFirstWrite: PIPE_FIRST_WRITE },
        `${pipeTests(3).length} programs and Pong on a pipeline: every write in order within 2.2 cycles per instruction, and a shorter period than the single-cycle core.`)),
      answer: refOf('cap_t3', () => rv16Pipe({ fwd: true, stall: true, flush: true }), 'Pipelined RV16 core'),
    };
  } else if (id === 'cap_t4') {
    c = {
      ...base,
      brief: CORE_BRIEF('Any core you like: single-cycle, multicycle, pipelined, with fast adders or shared ones. The task is not one target but a trade-off: every design that passes is a point on the cost / speed chart, graded on where it lands against three reference cores.')
        + ` The workload is ${briefTests().length} programs; cost is the NANDs of your core (the program memory is the bench's), speed is the total time: cycles × clock period over all of them.`,
      ports: CORE_PINS,
      check: coreCheck(briefSpec(), `${briefTests().length} programs against the golden model, every register write and store in order, within ${BRIEF_BUDGET.cpi} cycles per instruction; measured for NANDs, clock period and cycles.`),
      answer: refOf('cap_t4', () => rv16Core(true), 'Single-cycle RV16 core'),
    };
  }
  else if (id === 'cap_console') {
    c = {
      ...base, level: 'sequential',
      brief: 'A serial console: a UART with a sixteen-byte FIFO each way. Frames are 8N1, each bit 16 ticks, a tick being <b>div</b> clocks (<code>divWe</code> loads div from <code>wval</code>; a divisor of 1 ticks every clock).'
        + ' <code>push</code> queues <code>data</code> to send. <code>rxData</code> shows the oldest byte received, and <code>pop</code> takes it.'
        + ' <code>status</code>: bit 0 data waiting, 1 transmit FIFO full, 2 transmitter idle (FIFO empty and nothing on the line), 3 framing error, 4 overrun. A frame with a bad stop bit sets 3 and stores nothing; a byte arriving with the FIFO full is dropped and sets 4; both stay until <code>clrWe</code> with a 1 in that bit of <code>wval</code>.'
        + ' <code>ieWe</code> loads the two interrupt enables from <code>wval</code>: <code>irq</code> is (bit 0 and data waiting) or (bit 1 and the transmit FIFO empty).'
        + ` Your frames must read correctly by a far end ${(CONSOLE_ERR * 100).toFixed(1)} % off in clock, either way, and you must read its frames. No walkthrough, no hints: the bench looks only at your pins.`,
      ports: pinsOf(UART_CORE).filter((p) => !['div', 'ie', 'tickOut'].includes(p.name)),
      check: { kind: 'custom', describe: 'Bytes sent at two divisors and read by a far end off in clock both ways, the transmit FIFO filled, frames received from a sender off both ways, overrun, a framing error and its recovery, and the interrupt rules.', run: runConsole },
      answer: refOf('cap_console', () => UART_CORE, 'UART core'),
    };
  }
  if (c) cache.set(id, c);
  return c;
}

/** The capstones that have a challenge (the ones whose tier is built). */
export const builtCapstones = (): Capstone[] => CAPSTONES.filter((c) => !!capstoneChallenge(c.id));

/** How a capstone's passes are ranked (lower is better, compared in order): its own grading, tier 3's period × cycles. */
export const capstoneRank = (id: string) => (m: { nand?: number; period?: number; cycles?: number }): number[] =>
  (id === 'cap_t3' || id === 'cap_t4') && m.period !== undefined && m.cycles !== undefined ? [m.period * m.cycles, m.nand ?? Infinity] : [m.nand ?? Infinity, m.period ?? Infinity, m.cycles ?? Infinity];

// ---- what the reference scores -------------------------------------------------------------------------

export interface ReferenceScore { nand: number; period?: number | null; cycles?: number; tested: number; ok: boolean }

/** The reference answer run through the capstone's own check: the numbers the spec sheet shows (never typed by hand). */
export function referenceScore(id: string): ReferenceScore | undefined {
  const ch = capstoneChallenge(id);
  if (!ch) return undefined;
  const chips = ch.answer();
  const main = chips[chips.length - 1];
  const ws = { ...emptyWorkspace(), chips: Object.fromEntries(chips.map((d) => [d.id, d])) };
  const r: CheckResult = checkChallenge(ch, new UserLibrary(ws).compiled(main.id));
  return { nand: r.score.nand, period: r.score.period, cycles: r.score.cycles, tested: r.tested, ok: r.ok };
}

/** The reference's NAND count alone (compile and count: no simulation, cheap enough for the spec sheet). */
export function referenceNands(id: string): number | undefined {
  const ch = capstoneChallenge(id);
  if (!ch) return undefined;
  const chips = ch.answer();
  const ws = { ...emptyWorkspace(), chips: Object.fromEntries(chips.map((d) => [d.id, d])) };
  const def = new UserLibrary(ws).compiled(chips[chips.length - 1].id)?.def;
  return def ? stats(def).nands : undefined;
}
