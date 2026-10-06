// Every library component with a netlist, opened in the sandbox (docFromDef) and compiled back
// (compileChip), is the same circuit: same leaves in the same hierarchy, the same nets between
// them, the same power-on hints and charge-keeping nets; and where there is a spec, the same
// truth table.

import { describe, expect, it } from 'vitest';
import { compileChip } from '../src/editor/compile';
import { docFromDef } from '../src/editor/fromdef';
import type { ChipDoc } from '../src/editor/model';
import { partDef } from '../src/editor/parts';
import { cachedMemory, dualCore, multicycleCpu, pipelinedCpu, singleCycleCpu, systemCpu } from '../src/lib';
import { reachableDefs, resolveComponent } from '../src/lib/resolve';
import { assemble } from '../src/riscv/asm';
import { PROGRAMS } from '../src/riscv/programs';
import { flatten, type FlatDesign } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { inputBits } from '../src/sim/harness';
import { SwitchSim } from '../src/sim/switchsim';
import { type ComponentDef, inPorts, netlistOf, outPorts } from '../src/sim/types';
import { pack } from '../src/sim/values';
import { lcg } from './util';

// The parametric designs the chapters show (as in route.test.ts), so they are covered too.
const words = assemble(PROGRAMS[0].source).words;
singleCycleCpu(words);
singleCycleCpu(words, { adder: 'ks' });
pipelinedCpu(words, { adder: 'ks', balanced: true, predictor: true });
pipelinedCpu(words);
systemCpu(words, { m: true });
multicycleCpu(words, { control: 'fsm' });
multicycleCpu(words, { control: 'micro' });
dualCore(words);
cachedMemory(6, 2);

/**
 * Components that cannot be drawn in the sandbox, and why. Keep this short: fix docFromDef
 * instead where the sandbox can express the circuit.
 */
const CANNOT: Record<string, RegExp> = {
  // Its bit lines are bidirectional ports; sandbox pins are inputs or outputs. (Placed as a part,
  // e.g. in the SRAM column, it is fine: part ports may be inout.)
  sram6t: /bidirectional/,
  // Pipeline registers and register-file read ports wider than a sandbox pin (64 bits: a value
  // the editor shows and drives must fit in a number). They are fine as parts of a chip.
  // (The pipeline registers: register, clearable register and the AND that clears them.)
  ...Object.fromEntries([97, 130, 169, 170, 192, 229].flatMap((n) => [`reg${n}`, `creg${n}`, `andx${n}`].map((id) => [id, /bits wide/]))),
  readport32x32: /bits wide/,
  readport16x62: /bits wide/,
};

const defs = reachableDefs().filter((d) => netlistOf(d));

/** Expand the root even when it prefers its behaviour (the ROM); keep the parts' preference. */
const flat = (def: ComponentDef, mode: 'gate' | 'switch') =>
  flatten(def, { mode, expand: (d, node) => node.parent === null || !d.preferBehavior });

/**
 * The circuit as numbers: root ports (by name) and every leaf (in hierarchy order: kind, def,
 * path, then each terminal's net), with nets renumbered in order of first appearance; then the
 * power-on hints and the charge-keeping nets. Equal signatures = isomorphic circuits.
 */
function signature(def: ComponentDef, d: FlatDesign): string[] {
  const canon = new Map<number, number>();
  const c = (n: number) => {
    let k = canon.get(n);
    if (k === undefined) canon.set(n, (k = canon.size));
    return k;
  };
  const nets = (a: number[][]) => a.map((b) => b.map(c).join(',')).join('|');
  const out: string[] = [];
  for (const p of [...def.ports].sort((a, b) => (a.name < b.name ? -1 : 1))) out.push(`${p.name}: ${d.root.ports[p.name].map(c).join(',')}`);
  for (const l of d.leaves) {
    out.push(`${l.node.path.join('.')} ${l.kind} ${l.def.id}: ${nets(l.inputs)} > ${nets(l.outputs)}${l.terminals ? ` t ${l.terminals.map(c).join(',')}` : ''}`);
  }
  out.push(`powerOn ${[...d.powerOn].map(([n, v]) => `${c(n)}=${v}`).sort().join(' ')}`);
  out.push(`caps ${[...d.caps].map(c).sort((a, b) => a - b).join(' ')}`);
  return out;
}

/** Up to 64 input vectors: all of them for ≤ 6 input bits, else corners and pseudo-random ones. */
function vectors(def: ComponentDef): number[][] {
  const ins = inPorts(def), n = inputBits(def);
  if (n <= 6) {
    return Array.from({ length: 2 ** n }, (_, v) => {
      let off = 0;
      return ins.map((p) => { const x = Math.floor(v / 2 ** off) % 2 ** p.width; off += p.width; return x; });
    });
  }
  const r = lcg(n);
  const rnd = (w: number) => (w > 30 ? r(2 ** 30) * 2 ** (w - 30) + r(2 ** (w - 30)) : r(2 ** w));
  return [ins.map(() => 0), ins.map((p) => 2 ** p.width - 1), ...Array.from({ length: 30 }, () => ins.map((p) => rnd(p.width)))];
}

describe('library → sandbox document → compiled chip', () => {
  it('the signature tells a miswired copy apart', () => {
    const fa = resolveComponent('full_adder')!;
    const doc = docFromDef(fa) as ChipDoc;
    expect(doc.wires.some((w) => 'wire' in w.a)).toBe(true); // fan-outs are drawn as branches
    // Move one sink of m1 (the first NAND's output) to cin's net.
    const w = doc.wires.find((x) => 'part' in x.b && x.b.part === 'g9' && x.b.port === 'a')!;
    const bad: ChipDoc = { ...doc, wires: doc.wires.map((x) => (x === w ? { ...x, a: { pin: 'cin' }, pts: [] } : x)) };
    const sig = (d: ChipDoc) => {
      const c = compileChip(d, (ref) => partDef(ref, () => undefined));
      return signature(c.def, flat(c.def, 'gate'));
    };
    expect(sig(doc)).toEqual(signature(fa, flat(fa, 'gate')));
    expect(sig(bad)).not.toEqual(sig(doc));
  });

  it.each(defs.map((d) => [d.id, d] as const))('%s', (id, def) => {
    const doc = docFromDef(def);
    if ('error' in doc) {
      expect(CANNOT[id], `${id}: ${doc.error}`).toBeDefined();
      expect(doc.error).toMatch(CANNOT[id]);
      return;
    }
    expect(CANNOT[id], `${id} is allowlisted but round-trips`).toBeUndefined();
    const c = compileChip(doc, (ref) => partDef(ref, () => undefined));
    expect(c.diags.filter((x) => x.level === 'error').map((x) => x.msg)).toEqual([]);
    expect(c.def.ports.map((p) => [p.name, p.width, p.dir]).sort()).toEqual(def.ports.map((p) => [p.name, p.width, p.dir]).sort());

    const a = flat(def, c.mode), b = flat(c.def, c.mode);
    expect(b.leaves.length, 'leaves').toBe(a.leaves.length);
    expect(b.netCount, 'nets').toBe(a.netCount);
    const sa = signature(def, a), sb = signature(c.def, b);
    const k = sa.findIndex((s, i) => s !== sb[i]);
    expect(k < 0 ? null : [sb[k], `expected ${sa[k]}`]).toBeNull();

    // Specs compute in JS numbers: exact up to 32 bits per port (bitwise ops), so wider parts
    // are covered by the connectivity check alone.
    if (def.spec && def.ports.every((p) => p.width <= 32) && b.leaves.length < 20000) {
      const sim = c.mode === 'switch' ? new SwitchSim(b) : new GateSim(b);
      for (const v of vectors(def)) {
        inPorts(def).forEach((p, i) => sim.setInput(p.name, v[i]));
        sim.settle();
        const got = outPorts(def).map((p) => pack(sim.getBits(b.root.ports[p.name])));
        expect(got, `${id}(${v})`).toEqual(def.spec(v));
      }
    }
  });
});
