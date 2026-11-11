// The machines of chapter "Designing state machines" (chapters/ch-fsm.ts), DOM-free. Each is a state diagram
// (editor/fsmchip.ts FsmDoc) built into a circuit the way the sandbox's state-machine chip builds it: a next-state
// table and an output table, minimized, around the state flip-flops. So the chapter's circuits, their costs
// (encodingCosts), their diagrams (specOf) and their read-back (sim/fsmread.ts) all come from one description.
// Importing the editor's DOM-free model is the point: the chapter shows what the sandbox's builder makes.

import { encodingCosts, FSM_TEMPLATE, setFsm, specOf, type EncodingCost } from '../editor/fsmchip';
import { controllerOf, fsmdStep, GCD_FSMD, type FsmdState } from '../editor/fsmd';
import { UserLibrary } from '../editor/library';
import { emptyChip, emptyWorkspace, type FsmDoc, type TableDoc } from '../editor/model';
import { equation } from '../editor/ttable';
import { flipBits } from '../sim/faults';
import { pathBits } from '../sim/fsmread';
import { simulate } from '../sim/harness';
import { stats } from '../sim/stats';
import type { Sim } from '../sim/sim';
import type { ComponentDef } from '../sim/types';
import { pack } from '../sim/values';
import { Builder } from './builder';
import { define } from './define';
import type { FsmSpec } from './fsm';

type Encoding = FsmDoc['encoding'];
export const ENCODING_NAMES: Record<Encoding, string> = { binary: 'Binary', gray: 'Gray', onehot: 'One-hot' };

// ---- the machines -------------------------------------------------------------------------------------------------------

/** The Mealy "101" detector (three states; y = 1 on the x that completes 1, 0, 1). */
export const MEALY101: FsmDoc = FSM_TEMPLATE;

/** The same detector as a Moore machine: a fourth state S3 "just saw 101" holds y = 1 for the cycle after the last 1. */
export const MOORE101: FsmDoc = {
  ins: ['x'], outs: ['y'],
  states: [
    { name: 'S0', at: [70, 100] }, { name: 'S1', at: [170, 100] }, { name: 'S2', at: [270, 100] }, { name: 'S3', at: [370, 100], out: ['y'] },
  ],
  arcs: [
    { from: 0, to: 0, when: { x: 0 } }, { from: 0, to: 1, when: { x: 1 } },
    { from: 1, to: 1, when: { x: 1 } }, { from: 1, to: 2, when: { x: 0 } },
    { from: 2, to: 0, when: { x: 0 } }, { from: 2, to: 3, when: { x: 1 } },
    { from: 3, to: 1, when: { x: 1 } }, { from: 3, to: 2, when: { x: 0 } },
  ],
  reset: 0, encoding: 'binary', form: 'nand',
};

/** A three-phase sequencer, one lamp per state; with `go` = 1 it steps A → B → C → A. Used one-hot, with and without `safe`. */
export const RING3: FsmDoc = {
  ins: ['go'], outs: ['a', 'b', 'c'],
  states: [{ name: 'A', at: [90, 100], out: ['a'] }, { name: 'B', at: [220, 100], out: ['b'] }, { name: 'C', at: [350, 100], out: ['c'] }],
  arcs: [
    { from: 0, to: 1, when: { go: 1 } }, { from: 1, to: 2, when: { go: 1 } }, { from: 2, to: 0, when: { go: 1 } },
  ],
  reset: 0, encoding: 'onehot', form: 'nand',
};

/** Three circuits for the read-back step: the detector as drawn, and two that look right on the obvious input. */
export const CANDIDATES: { key: string; name: string; doc: FsmDoc; right: boolean; fault: string }[] = (() => {
  const arcs = MEALY101.arcs;
  // S2 on a 1 should go to S1 (the 1 that completes the pattern starts the next); this one restarts
  const noOverlap = arcs.map((a, i) => (i === 4 ? { ...a, to: 0 } : a));
  // the output on the 1 → 0 arc: it reports the "10", one input early
  const early = arcs.map((a, i) => (i === 3 ? { ...a, out: ['y'] } : i === 4 ? { from: a.from, to: a.to, when: a.when } : a));
  return [
    { key: 'a', name: 'Circuit A', doc: { ...MEALY101, arcs: noOverlap }, right: false, fault: 'restarts after a match: the last 1 does not count as the first 1 of the next pattern' },
    { key: 'b', name: 'Circuit B', doc: MEALY101, right: true, fault: '' },
    { key: 'c', name: 'Circuit C', doc: { ...MEALY101, arcs: early }, right: false, fault: 'raises y one input early: on the 0 of 1, 0, before the last 1 has arrived' },
  ];
})();

/** A traffic-light controller: the main road is green until a car waits on the side road. Moore outputs. */
export const TRAFFIC: FsmDoc = {
  ins: ['car'], outs: ['mg', 'my', 'sg', 'sy'],
  states: [
    { name: 'MG', at: [90, 90], out: ['mg'] }, { name: 'MY', at: [270, 90], out: ['my'] },
    { name: 'SG', at: [270, 230], out: ['sg'] }, { name: 'SY', at: [90, 230], out: ['sy'] },
  ],
  arcs: [
    { from: 0, to: 0, when: { car: 0 } }, { from: 0, to: 1, when: { car: 1 } },
    { from: 1, to: 2, when: {} },
    { from: 2, to: 2, when: { car: 1 } }, { from: 2, to: 3, when: { car: 0 } },
    { from: 3, to: 0, when: {} },
  ],
  reset: 0, encoding: 'binary', form: 'nand',
};

/** What the sandbox's #/sandbox/new/traffic starts from: the four states with their lamps, no arcs yet. */
export const TRAFFIC_START: FsmDoc = { ...TRAFFIC, arcs: [] };

// ---- circuits -----------------------------------------------------------------------------------------------------------

const circuits = new Map<string, { def: ComponentDef; lib: UserLibrary; id: string }>();

function build(key: string, doc: FsmDoc, label: string): { def: ComponentDef; lib: UserLibrary; id: string } {
  const k = `${key}_${doc.encoding}${doc.safe ? '_safe' : ''}`;
  let c = circuits.get(k);
  if (!c) {
    const id = `fsmb_${k}`;
    const r = setFsm({ ...emptyWorkspace(), chips: { [id]: emptyChip(id, label) } }, id, doc);
    if ('error' in r) throw new Error(`${k}: ${r.error}`);
    const lib = new UserLibrary(r);
    const def = lib.defOf(id);
    if (!def) throw new Error(`${k}: does not compile`);
    circuits.set(k, (c = { def, lib, id }));
  }
  return c;
}

/** The circuit the sandbox's builder draws for this machine (memoized by key and encoding): pins = ins, rst, clk → outs. */
export function fsmCircuit(key: string, doc: FsmDoc, label = 'FSM'): ComponentDef {
  return build(key, doc, label).def;
}

/** One of the machine's two table chips compiled: 'next' (state, inputs → next state) or 'out'. */
export function fsmTableChip(key: string, doc: FsmDoc, which: 'next' | 'out'): ComponentDef {
  const c = build(key, doc, 'FSM');
  const def = c.lib.defOf(`${c.id}_${which}`);
  if (!def) throw new Error('no table chip');
  return def;
}

/** The diagram of a machine over its circuit (state bits s0… in the flip-flops). */
export const fsmSpecOf = (doc: FsmDoc, implicit = false): FsmSpec => specOf(doc, implicit);

/** NAND count of the circuit built for this machine in this encoding. */
export const circuitNands = (key: string, doc: FsmDoc): number => stats(fsmCircuit(key, doc)).nands;

// ---- the cost of the codes ----------------------------------------------------------------------------------------------

export interface CodeCosts { mealy: EncodingCost[]; moore: EncodingCost[] }

/** Flip-flops, logic and NANDs of each encoding, for the Mealy detector and for its Moore version (all computed). */
export function codeCosts(): CodeCosts {
  return { mealy: encodingCosts(MEALY101), moore: encodingCosts(MOORE101) };
}

// ---- Moore against Mealy ------------------------------------------------------------------------------------------------

/** Both detectors side by side on x, rst, clk: outputs `ymealy` and `ymoore`. */
let pair: ComponentDef | undefined;
export function mooreMealy(): ComponentDef {
  return (pair ??= (() => {
    const b = new Builder(10, 14, 6);
    b.pins('x', 'rst', 'clk');
    const mealy = b.op(fsmCircuit('mealy', MEALY101, 'Mealy'), ['x', 'rst', 'clk'], 'Mealy: y from the state and x', 'mealy');
    const moore = b.op(fsmCircuit('moore', MOORE101, 'Moore'), ['x', 'rst', 'clk'], 'Moore: y from the state alone', 'moore');
    b.next();
    b.wire(`${mealy}.y`, 'ymealy');
    b.wire(`${moore}.y`, 'ymoore');
    const R = b.right;
    return define({
      id: 'fsmb_moore_mealy', name: 'Mealy and Moore detectors', category: 'sequential',
      summary: 'The 101 detector twice on one input: the Mealy machine (three states, y follows x) and the Moore machine (four states, y follows the state).',
      ports: [
        { name: 'x', width: 1, dir: 'in' }, { name: 'rst', width: 1, dir: 'in' }, { name: 'clk', width: 1, dir: 'in', clock: true },
        { name: 'ymealy', width: 1, dir: 'out' }, { name: 'ymoore', width: 1, dir: 'out' },
      ],
      symbol: { kind: 'box', label: '101 ×2' },
      netlist: () => ({ pins: { x: [0, 4], rst: [0, 8], clk: [0, 12], ymealy: [R, 4], ymoore: [R, 8] }, instances: b.instances, nets: b.nets() }),
    });
  })());
}

/** Run x (one bit per clock edge, rst low) on the pair from reset; per input: the outputs seen just before its edge. */
export function runPair(xs: number[]): { x: number; mealy: number; moore: number }[] {
  const sim = simulate(mooreMealy());
  const out = (p: string) => pack(sim.getBits(sim.design.root.ports[p]));
  sim.setInput('rst', 1); sim.setInput('x', 0); sim.setInput('clk', 0); sim.settle();
  sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle();
  sim.setInput('rst', 0); sim.settle();
  return xs.map((x) => {
    sim.setInput('x', x); sim.settle();
    const row = { x, mealy: out('ymealy'), moore: out('ymoore') };
    sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle();
    return row;
  });
}

// ---- unused codes -------------------------------------------------------------------------------------------------------

/** The sequencer, one-hot, with unused codes left as don't cares (cheapest) or sent to reset. */
export const ringCircuit = (safe: boolean): ComponentDef => fsmCircuit('ring', safe ? { ...RING3, safe: true } : RING3, 'Sequencer');

export interface UpsetResult { start: string; bit: number; held: boolean; code: number; after: number; valid: boolean }

/**
 * A single-event upset on the running sequencer: clock it to state `s` (go = 1), flip state flip-flop `bit`, then clock
 * `cycles` more. `code` is the register right after the flip, `after` at the end; `valid` says it is one-hot again.
 */
export function upset(safe: boolean, s: number, bit: number, cycles = 6): UpsetResult {
  const sim = simulate(ringCircuit(safe));
  const code = (): number => pack(sim.getBits(pathBits(sim.design.root, ['s0.q', 's1.q', 's2.q'])!));
  const tick = () => { sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle(); };
  sim.setInput('go', 1); sim.setInput('rst', 1); sim.setInput('clk', 0); sim.settle();
  tick();
  sim.setInput('rst', 0); sim.settle();
  for (let i = 0; i < s; i++) tick();
  const held = flipBits(sim, pathBits(sim.design.root, [`s${bit}.q`])!)[0];
  const flipped = code();
  for (let i = 0; i < cycles; i++) tick();
  const after = code();
  return { start: RING3.states[s].name, bit, held, code: flipped, after, valid: [1, 2, 4].includes(after) };
}

/** Flip state flip-flop `bit` of a running sequencer scene (the stage's own simulation); true if the flip held. */
export function flipState(sim: Sim, bit: number): boolean {
  const nets = pathBits(sim.design.root, [`s${bit}.q`]);
  return !!nets && flipBits(sim, nets)[0];
}

// ---- controller and datapath --------------------------------------------------------------------------------------------

export const GCD = GCD_FSMD;
export const gcdCircuit = (): ComponentDef => fsmCircuit('gcd', GCD_FSMD, 'GCD');

/**
 * GCD by the reference (editor/fsmd.ts fsmdStep) from power-on: `start` is raised at the first edge. Per edge the state
 * entered and the registers; `cycles` counts edges until the machine enters DONE.
 */
export function gcdRun(x: number, y: number): { cycles: number; states: string[]; a: number[]; b: number[] } {
  let st: FsmdState = { s: GCD_FSMD.reset, regs: { a: 0, b: 0 } };
  const states: string[] = [], a: number[] = [], b: number[] = [];
  let cycles = 0;
  const done = GCD_FSMD.states.findIndex((s) => s.out?.includes('done'));
  while (st.s !== done && cycles < 1000) {
    st = fsmdStep(GCD_FSMD, st, { bits: { start: 1 }, data: { x, y } }).next;
    cycles++;
    states.push(GCD_FSMD.states[st.s].name); a.push(st.regs.a); b.push(st.regs.b);
  }
  return { cycles, states, a, b };
}

/**
 * The GCD machine's diagram for the live panel: specOf's picture (register transfers under the names, tests in the arc
 * labels) with the controller's own arc conditions (controllerOf: start and the status bits st0, st1 that the
 * comparators feed back), so the "next edge" arc follows the comparators.
 */
export function gcdSpec(): FsmSpec {
  const base = specOf(GCD_FSMD);
  const ctl = controllerOf(GCD_FSMD, '');
  if ('error' in ctl) throw new Error(ctl.error);
  return {
    ...base,
    arcs: base.arcs.map((arc, i) => ({ ...arc, when: (inp: Record<string, number>) => Object.entries(ctl.arcs[i].when).every(([k, v]) => inp[k] === v) })),
    inputs: [...ctl.ins, 'rst'],
  };
}

// ---- Karnaugh maps ------------------------------------------------------------------------------------------------------

const GRAY = [0, 1, 3, 2];

/** Output `j` of a truth table as a Karnaugh map (HTML): rows by the first inputs, columns by the rest, Gray order, – for a don't care. */
export function kmapHtml(t: TableDoc, j: number): string {
  const n = t.ins.length, rv = Math.ceil(n / 2), cv = n - rv;
  const order = (k: number) => (k === 1 ? [0, 1] : GRAY);
  const bits = (v: number, k: number) => Array.from({ length: k }, (_, i) => (v >> (k - 1 - i)) & 1).join('');
  const rows = order(rv), cols = order(cv);
  const cell = (r: number, c: number) => t.rows[j][(r << cv) | c];
  const head = `<tr><th>${t.ins.slice(0, rv).join('')} \\ ${t.ins.slice(rv).join('')}</th>${cols.map((c) => `<th>${bits(c, cv)}</th>`).join('')}</tr>`;
  const body = rows.map((r) => `<tr><th>${bits(r, rv)}</th>${cols.map((c) => { const v = cell(r, c); return `<td class="km${v === '1' ? ' one' : ''}">${v === '-' ? '–' : v}</td>`; }).join('')}</tr>`).join('');
  return `<table class="cmp kmap"><caption>${t.outs[j]}</caption>${head}${body}</table>`;
}

export { equation };

// ---- the read-back candidates, a run of any one-input machine, the controller's share ---------------------------------------

/** One of CANDIDATES built (same codes and pins as the detector). */
export const candidateCircuit = (key: string): ComponentDef => {
  const c = CANDIDATES.find((x) => x.key === key);
  if (!c) throw new Error(`no candidate ${key}`);
  return fsmCircuit(`cand_${key}`, c.doc);
};

/** Run x (one bit per clock edge) on a machine with pins x, rst, clk and output y from reset: y as seen just before each edge. */
export function runFsm(def: ComponentDef, xs: number[]): number[] {
  const sim = simulate(def);
  const y = () => pack(sim.getBits(sim.design.root.ports.y));
  sim.setInput('rst', 1); sim.setInput('x', 0); sim.setInput('clk', 0); sim.settle();
  sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle();
  sim.setInput('rst', 0); sim.settle();
  return xs.map((x) => {
    sim.setInput('x', x); sim.settle();
    const v = y();
    sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle();
    return v;
  });
}

/** NANDs of the GCD machine whole and of its controller chip alone (the rest is the datapath). */
export function gcdCosts(): { total: number; controller: number } {
  const c = build('gcd', GCD_FSMD, 'GCD');
  return { total: stats(c.def).nands, controller: stats(c.lib.defOf(`${c.id}_ctl`)!).nands };
}

/** The narrowest debounce counter that ignores a bounce lasting `samples` clock samples: a new level needs 2^n in a row. */
export const debounceBits = (samples: number): number => Math.max(1, Math.ceil(Math.log2(samples + 1)));
