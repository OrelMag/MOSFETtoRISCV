// What the sandbox editor derives from a user's circuit (no DOM). A chip built from transistors
// is solved at switch level; to reuse it as a brick inside gate-level circuits, the way the
// library NAND is a gate-level primitive whose inside is four transistors, it needs a gate-level
// model. deriveBehavior() computes one: the chip's whole truth table, solved by the switch-level
// simulator. That is only honest for a combinational chip, so state is detected and refused.

import { flatten, type FlatDesign } from '../sim/flatten';
import { inputBits, reachesTransistors } from '../sim/harness';
import { SwitchSim } from '../sim/switchsim';
import { B0, B1, BZ, type Behavior, type ComponentDef, inPorts, outPorts } from '../sim/types';
import { pack } from '../sim/values';

export type CircuitMode = 'gate' | 'switch';

/**
 * 'switch' when a gate-level flatten would reach a transistor or a rail (not hidden under a
 * NAND primitive or a component with a behaviour), so the circuit needs the switch-level solver.
 */
export function circuitMode(def: ComponentDef): CircuitMode {
  return reachesTransistors(def) ? 'switch' : 'gate';
}

/** Largest truth table derived (input bits): 4096 rows. */
export const MAX_DERIVE_BITS = 12;

export type Derived =
  | { ok: true; behavior: Behavior; spec: (inputs: number[]) => number[] }
  | { ok: false; reason: string };

const STATE = 'has state (e.g. a latch or memory cell): switch level only';

/**
 * Gate-level behaviour of a transistor-level chip, from its exhaustive truth table. Inputs are
 * packed per input port (the Behavior contract); an output that is contested (X) for some input
 * is X (-1) there, and any X input gives all-X outputs. An output that can float (Z) is refused:
 * on a shared bus its Z is not an X, so such a chip stays at switch level. Delay 1, like a NAND.
 *
 * State detection: the table is solved several times, each from a different initial node state
 * (all 0, all 1, alternating, pseudo-random: storage loops and stored charge start from it) and
 * reaching each input vector from different predecessors (Gray-code sweeps up and down). Every
 * node, not only the outputs, must come out the same every time, and every solve must settle;
 * otherwise the chip remembers something (or oscillates) and is refused.
 */
export function deriveBehavior(def: ComponentDef): Derived {
  const ins = inPorts(def), outs = outPorts(def);
  const nIn = inputBits(def);
  if (nIn > MAX_DERIVE_BITS) return fail(`too many inputs (${nIn} bits, at most ${MAX_DERIVE_BITS}): switch level only`);
  // a behaviour's values are JS numbers: exact to 53 bits per port
  const wide = outs.find((p) => p.width > 53);
  if (wide) return fail(`output '${wide.name}' is ${wide.width} bits wide (a behaviour holds at most 53): switch level only`);
  let design: FlatDesign;
  try {
    design = flatten(def, { mode: 'switch' });
  } catch (e) {
    return fail(`cannot be solved at switch level: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (design.leaves.some((l) => l.kind === 'behavior')) return fail('contains a behavioural part (no transistors inside it to solve)');
  if (!design.leaves.some((l) => l.kind === 'nmos' || l.kind === 'pmos')) return fail('no transistors');

  const sim = new SwitchSim(design);
  const rows = 2 ** nIn;
  const apply = (v: number): void => {
    let off = 0;
    for (const p of ins) {
      sim.setInput(p.name, Math.floor(v / 2 ** off) % 2 ** p.width);
      off += p.width;
    }
    sim.settle();
  };

  const n = design.netCount;
  let seed = 0x9e3779b9;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 16) & 1;
  const starts: Uint8Array[] = [
    new Uint8Array(n).fill(B0),
    new Uint8Array(n).fill(B1),
    Uint8Array.from({ length: n }, (_, i) => (i & 1 ? B1 : B0)),
    Uint8Array.from({ length: n }, () => (rnd() ? B1 : B0)),
  ];
  const snaps: Uint8Array[] = new Array(rows);
  for (let t = 0; t < starts.length; t++) {
    sim.restore(starts[t]);
    for (let k = 0; k < rows; k++) {
      const i = t & 1 ? rows - 1 - k : k;
      const v = i ^ (i >> 1); // Gray code: one input bit changes per step
      apply(v);
      if (sim.unstable) return fail(`${STATE} (it does not settle)`);
      const s = sim.snapshot();
      if (t === 0) snaps[v] = s;
      else if (!same(s, snaps[v])) return fail(STATE);
    }
  }
  if (def.ports.some((p) => p.dir === 'inout')) return fail('has bidirectional (inout) ports: switch level only');
  // A floating output is not "unknown": on a shared bus another driver or a pull-up decides it.
  // A gate-level model would turn its Z into X, so a chip that can let go of an output (a
  // tri-state driver, an open-drain stage) stays at switch level, and so do the chips around it.
  for (const p of outs) {
    const v = snaps.findIndex((s) => design.root.ports[p.name].some((net) => s[net] === BZ));
    if (v >= 0) return fail(`output '${p.name}' floats (Z) for some inputs, e.g. ${inputText(ins, v)}: a tri-state or open-drain output, which a gate-level model would turn into X; switch level only`);
  }

  const table = snaps.map((s) => outs.map((p) => pack(design.root.ports[p.name].map((net) => s[net]))));
  const eval_ = (inputs: number[]): number[] => {
    let v = 0, off = 0;
    for (let i = 0; i < ins.length; i++) {
      const x = inputs[i];
      if (x === undefined || x < 0) return outs.map(() => -1);
      v += (x % 2 ** ins[i].width) * 2 ** off;
      off += ins[i].width;
    }
    return table[v].slice();
  };
  return { ok: true, behavior: { delay: 1, eval: eval_ }, spec: eval_ };
}

/** Input vector v (packed, first port lowest) as `a = 1, en = 0`. */
function inputText(ins: { name: string; width: number }[], v: number): string {
  let off = 0;
  return ins.map((p) => {
    const x = Math.floor(v / 2 ** off) % 2 ** p.width;
    off += p.width;
    return `${p.name} = ${x}`;
  }).join(', ') || 'no inputs';
}

function fail(reason: string): Derived {
  return { ok: false, reason };
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
