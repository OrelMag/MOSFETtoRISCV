// A circuit read back as a state machine, beside the spec it should implement (lib/fsm.ts). From the
// reset state, every input combination is applied for one clock cycle, breadth first, until no new state
// appears. A state is the settled value of every net with the inputs at a fixed combination: no flip-flop
// has to be found or named, so it works on whatever the learner drew. Each state found is paired with
// the spec state the same input sequence reaches, so a wrong transition shows as an arc that leaves the
// spec. Also the live panels' readers (state code, input values). No DOM.

import { fsmArc, fsmInputCombos, fsmNext, fsmOut, type FsmArc, type FsmInputs, type FsmSpec, type FsmState } from '../lib/fsm';
import { hintBits } from './flatten';
import type { HierNode } from './flatten';
import type { Sim } from './sim';
import { pack } from './values';

/** Bits of a port or dotted path from the root (concatenated, least significant first), or null. */
export function pathBits(root: HierNode, paths: string[]): number[] | null {
  const out: number[] = [];
  for (const p of paths) {
    const b = hintBits(root, p);
    if (!b) return null;
    out.push(...b);
  }
  return out;
}

/** The current state (index into spec.states), −1 for a code the spec does not have or an X. */
export function fsmStateOf(sim: Sim, spec: FsmSpec, paths = spec.stateBits): number {
  const b = pathBits(sim.design.root, paths);
  if (!b) return -1;
  const code = pack(sim.getBits(b));
  return code < 0 ? -1 : spec.states.findIndex((s) => s.code === code);
}

/** Values of the spec's inputs (paths override where they are read), −1 for X. */
export function fsmInputsOf(sim: Sim, spec: FsmSpec, paths: Record<string, string> = {}): FsmInputs {
  const o: FsmInputs = {};
  for (const n of spec.inputs) {
    const b = pathBits(sim.design.root, [paths[n] ?? n]);
    o[n] = b ? pack(sim.getBits(b)) : -1;
  }
  return o;
}

export interface ReadState {
  /** The spec state reached by the same inputs (−1: the spec was already off the rails). */
  spec: number;
  name: string;
}

export interface ReadArc {
  from: number;
  to: number;
  inp: FsmInputs;
  /** Outputs before the edge (−1: X). */
  out: Record<string, number>;
  specTo: number;
  specOut: Record<string, number>;
  ok: boolean;
}

export interface FsmReadback {
  states: ReadState[];
  arcs: ReadArc[];
  /** Stopped at maxStates. */
  truncated: boolean;
}

/** Explore `sim` (a fresh simulation of the circuit) from reset. Throws when it does not settle. */
export function readFsm(sim: Sim, spec: FsmSpec, maxStates = 32): FsmReadback {
  const def = sim.design.root.def;
  const ins = def.ports.filter((p) => p.dir === 'in');
  const clk = ins.find((p) => p.clock)?.name ?? 'clk';
  const outs = spec.outputs.filter((o) => def.ports.some((p) => p.name === o && p.dir === 'out'));
  const combos = fsmInputCombos(spec);
  const rest = { ...Object.fromEntries(ins.map((p) => [p.name, 0])), ...combos[0] };
  const settle = () => {
    sim.settle();
    if (sim.unstable) throw new Error('the circuit does not settle');
  };
  const apply = (inp: FsmInputs) => { for (const [k, v] of Object.entries(inp)) if (k !== clk && ins.some((p) => p.name === k)) sim.setInput(k, v); };
  const tick = () => { sim.setInput(clk, 1); settle(); sim.setInput(clk, 0); settle(); };
  const all = Array.from({ length: sim.design.netCount }, (_, i) => i);
  const key = () => sim.getBits(all).join('');

  apply(rest);
  sim.setInput(clk, 0);
  sim.reset('zero');
  settle();
  if (spec.resetIn) { apply(spec.resetIn); settle(); tick(); apply(rest); settle(); }
  const states: ReadState[] = [{ spec: spec.reset, name: spec.states[spec.reset].name }];
  const keys = new Map([[key(), 0]]);
  const snaps = [sim.saveState()];
  const arcs: ReadArc[] = [];
  let truncated = false;
  for (let i = 0; i < states.length; i++) {
    for (const c of combos) {
      // A combination the spec has no arc for cannot happen (MemAdr with a non-memory opcode: the IR
      // holds the one Decode saw): a don't care, not explored.
      if (states[i].spec >= 0 && fsmNext(spec, states[i].spec, c) < 0) continue;
      sim.restoreState(snaps[i]);
      apply(c);
      settle();
      const out = Object.fromEntries(outs.map((o) => [o, pack(sim.getBits(sim.design.root.ports[o]))]));
      tick();
      apply(rest);
      settle();
      const k = key(), s = states[i].spec;
      const specTo = s >= 0 ? fsmNext(spec, s, c) : -1;
      let j = keys.get(k);
      if (j === undefined) {
        if (states.length >= maxStates) { truncated = true; continue; }
        j = states.length;
        const twins = states.filter((x) => x.spec === specTo && specTo >= 0).length;
        states.push({ spec: specTo, name: specTo >= 0 ? spec.states[specTo].name + '′'.repeat(twins) : `?${j}` });
        keys.set(k, j);
        snaps.push(sim.saveState());
      }
      const specOut = s >= 0 ? fsmOut(spec, s, c) : {};
      const ok = specTo >= 0 && states[j].spec === specTo && outs.every((o) => out[o] === specOut[o]);
      arcs.push({ from: i, to: j, inp: c, out, specTo, specOut, ok });
    }
  }
  return { states, arcs, truncated };
}

/** Is the circuit exactly the spec (every reachable state one spec state, every arc right)? */
export const readbackOk = (r: FsmReadback): boolean => !r.truncated && r.arcs.every((a) => a.ok) && new Set(r.states.map((s) => s.spec)).size === r.states.length;

/**
 * The read-back as a diagram spec: circuit states at their spec states' places (twins and unknowns below),
 * right arcs as the spec draws them, wrong ones red ('bad') with the expected arc dashed ('spec').
 */
export function readbackSpec(spec: FsmSpec, r: FsmReadback): FsmSpec {
  const [W, H] = spec.size;
  let extra = 0;
  const states: FsmState[] = r.states.map((s, i) => {
    const home = s.spec >= 0 && r.states.findIndex((x) => x.spec === s.spec) === i;
    const at: [number, number] = home ? spec.states[s.spec].at : [60 + 90 * extra++, H + 50];
    return { name: s.name, code: s.spec >= 0 ? spec.states[s.spec].code : -1, at, cls: home ? undefined : 'unknown' };
  });
  // the spec states the circuit never reached, where a wrong arc should have gone
  const ghostOf = new Map<number, number>();
  const target = (specTo: number) => {
    const j = r.states.findIndex((x) => x.spec === specTo);
    if (j >= 0) return j;
    if (!ghostOf.has(specTo)) { ghostOf.set(specTo, states.length); states.push({ ...spec.states[specTo], cls: 'ghost' }); }
    return ghostOf.get(specTo)!;
  };
  const shown = spec.inputs.filter((n) => !(n in (spec.resetIn ?? {})));
  const label = (inp: FsmInputs, out: Record<string, number>) =>
    `${shown.map((n) => inp[n]).join('')}/${spec.outputs.filter((o) => o in out).map((o) => (out[o] < 0 ? 'X' : out[o])).join('')}`;
  const like = (from: number, to: number): Partial<FsmArc> => {
    const a = spec.arcs.find((x) => x.from === r.states[from]?.spec && x.to === r.states[to]?.spec);
    return a ? { bend: a.bend, t: a.t, dx: a.dx, dy: a.dy, loop: a.loop, rail: a.rail } : from === to ? { loop: 0 } : { bend: 30 };
  };
  const groups = new Map<string, FsmArc>();
  const add = (from: number, to: number, text: string, cls: string | undefined, geo: Partial<FsmArc>) => {
    const k = `${from}>${to}>${cls ?? ''}`, g = groups.get(k);
    if (g) g.label = `${g.label}, ${text}`;
    else groups.set(k, { from, to, label: text, cls, ...geo });
  };
  for (const a of r.arcs) {
    if (a.ok) {
      const s = r.states[a.from].spec, sa = spec.arcs[fsmArc(spec, s, a.inp)];
      add(a.from, a.to, sa?.label ?? label(a.inp, a.out), undefined, like(a.from, a.to));
      continue;
    }
    // Right state, wrong output: one red arc saying both (an expected arc would lie on top of it).
    if (a.specTo >= 0 && r.states[a.to].spec === a.specTo) {
      add(a.from, a.to, `${label(a.inp, a.out)} (want ${label(a.inp, a.specOut)})`, 'bad', like(a.from, a.to));
      continue;
    }
    add(a.from, a.to, label(a.inp, a.out), 'bad', like(a.from, a.to));
    if (a.specTo >= 0) {
      const t = target(a.specTo), sa = spec.arcs[fsmArc(spec, r.states[a.from].spec, a.inp)];
      add(a.from, t, sa?.label ?? label(a.inp, a.specOut), 'spec', sa ? { bend: sa.bend, t: sa.t, loop: sa.loop } : { bend: -30 });
    }
  }
  const tall = states.some((s) => s.at[1] > H);
  return {
    ...spec, title: `${spec.title} (your circuit)`, states, arcs: [...groups.values()],
    size: [Math.max(W, 60 + 90 * extra), tall ? H + 90 : H], rail: undefined,
  };
}
