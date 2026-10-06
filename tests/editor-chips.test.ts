// Chips as chips (src/editor/chips.ts, remix.ts): relations, pin order, renames that keep the
// parents wired, flip-flop guesses, bidirectional pins driven from the editor, and "Open in
// Sandbox" (a library circuit or a CPU as an editable chip that simulates the same).

import { describe, expect, it } from 'vitest';
import { guessFf, nextDrive, pinOrder, relations, renamePin } from '../src/editor/chips';
import { UserLibrary } from '../src/editor/library';
import { type ChipDoc, emptyWorkspace, type Workspace } from '../src/editor/model';
import { remixDef, remixIntoStorage, stableRef } from '../src/editor/remix';
import { EditorSim } from '../src/editor/runtime';
import { KEY, type KV, loadWorkspace } from '../src/editor/store';
import { singleCycleCpu } from '../src/lib/cpu';
import { resolveComponent } from '../src/lib/resolve';
import { assemble } from '../src/riscv/asm';
import { PROGRAMS } from '../src/riscv/programs';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { evalOnce, forEachInput, simulate } from '../src/sim/harness';
import { B0, B1, BZ, type ComponentDef, inPorts, outPorts } from '../src/sim/types';
import { pack } from '../src/sim/values';
import { chip, compileLib, halfAdder, part, pin, wire } from './editorkit';

const fullAdder = (): ChipDoc => chip('u_fa', 'FA', {
  pins: [pin('a', 'in', [0, 2]), pin('b', 'in', [0, 4]), pin('cin', 'in', [0, 10]), pin('s', 'out', [40, 2]), pin('cout', 'out', [40, 10])],
  parts: [part('h1', { chip: 'u_ha' }, [6, 0]), part('h2', { chip: 'u_ha' }, [18, 0]), part('o', { lib: 'or' }, [30, 8])],
  wires: [
    wire('w1', 'pin:a', 'h1.a'), wire('w2', 'pin:b', 'h1.b'), wire('w3', 'h1.s', 'h2.a'), wire('w4', 'pin:cin', 'h2.b'),
    wire('w5', 'h2.s', 'pin:s'), wire('w6', 'h1.c', 'o.a'), wire('w7', 'h2.c', 'o.b'), wire('w8', 'o.y', 'pin:cout'),
  ],
});
const top = (): ChipDoc => chip('u_top', 'Top', { parts: [part('f', { chip: 'u_fa' }, [0, 0])] });
const ws = (...chips: ChipDoc[]): Workspace => ({ ...emptyWorkspace(), chips: Object.fromEntries(chips.map((c) => [c.id, c])), open: [chips[0].id] });

const memKV = (): KV & { m: Map<string, string> } => {
  const m = new Map<string, string>();
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
};

describe('chip relations and pins', () => {
  it('relations are direct, both ways', () => {
    const w = ws(halfAdder(), fullAdder(), top());
    expect(relations(w, 'u_ha')).toEqual({ usedBy: ['u_fa'], uses: [] });
    expect(relations(w, 'u_fa')).toEqual({ usedBy: ['u_top'], uses: ['u_ha'] });
    expect(relations(w, 'u_top')).toEqual({ usedBy: [], uses: ['u_fa'] });
  });

  it('pin order: inputs then inouts on the left, outputs on the right, top to bottom', () => {
    const doc = chip('u_x', 'X', { pins: [pin('b', 'in', [0, 6]), pin('io', 'inout', [0, 1]), pin('a', 'in', [0, 2]), pin('z', 'out', [9, 9]), pin('y', 'out', [9, 0])] });
    const { left, right } = pinOrder(doc);
    expect(left.map((p) => p.name)).toEqual(['a', 'b', 'io']);
    expect(right.map((p) => p.name)).toEqual(['y', 'z']);
  });

  it('renaming a pin keeps every parent wired, and the full adder still adds', () => {
    const w0 = ws(halfAdder(), fullAdder(), top());
    const r = renamePin(w0, 'u_ha', 'c', 'carry');
    if ('reason' in r) throw new Error(r.reason);
    expect(r.ws.chips.u_ha.pins.map((p) => p.name)).toEqual(['a', 'b', 's', 'carry']);
    expect(r.ws.chips.u_fa.wires.filter((x) => 'part' in x.a && x.a.port === 'carry').map((x) => x.id)).toEqual(['w6', 'w7']);
    expect(r.ws.chips.u_top).toBe(w0.chips.u_top);
    const lib = new UserLibrary(r.ws);
    expect(lib.compiled('u_fa')!.diags).toEqual([]);
    const def = lib.defOf('u_fa')!;
    const sim = simulate(def);
    forEachInput(def, ([a, b, c]) => expect(evalOnce(sim, [a, b, c])).toEqual([(a + b + c) & 1, (a + b + c) >> 1]));
    // refused: a taken name, a bad name (nothing changes)
    expect(renamePin(w0, 'u_ha', 'c', 's')).toEqual({ reason: "a pin is already called 's'" });
    expect('reason' in renamePin(w0, 'u_ha', 'c', '1x')).toBe(true);
  });

  it('flip-flop guesses: names first, else the first fitting pins', () => {
    const dff = chip('u_d', 'DFF', { pins: [pin('D', 'in', [0, 0]), { ...pin('clk', 'in', [0, 4]), kind: 'clock' }, pin('en', 'in', [0, 6]), pin('q', 'out', [9, 0]), pin('nq', 'out', [9, 2])] });
    expect(guessFf(dff)).toEqual({ d: 'D', q: 'q', clk: 'clk', en: 'en' });
    const plain = chip('u_p', 'P', { pins: [pin('x', 'in', [0, 0]), pin('c', 'in', [0, 2]), pin('o', 'out', [9, 0])] });
    expect(guessFf(plain)).toEqual({ d: 'x', q: 'o', clk: 'c' });
    expect(guessFf(chip('u_n', 'N', { pins: [pin('x', 'in', [0, 0]), pin('o', 'out', [9, 0])] }))).toBeNull();
  });

  it('a bidirectional pin is driven from outside: Z, 0, 1, Z', () => {
    expect([undefined, 0, 1].map((v) => nextDrive({ ...pin('io', 'inout', [0, 0]), ...(v === undefined ? {} : { value: v }) }))).toEqual([0, 1, undefined]);
    expect(nextDrive({ ...pin('io', 'inout', [0, 0], 4), value: 0 })).toBe(15);
    // A pass transistor from the inout pin to an output: what the editor drives gets through.
    const doc = chip('u_pass', 'pass', {
      pins: [pin('io', 'inout', [0, 0]), pin('y', 'out', [20, 4]), { ...pin('g', 'in', [0, 8]), value: 1 }],
      parts: [part('t', { lib: 'nmos' }, [6, 2])],
      wires: [wire('a', 'pin:io', 't.d'), wire('b', 't.s', 'pin:y'), wire('c', 'pin:g', 't.g')],
    });
    const es = new EditorSim({ debounceMs: 0 });
    es.update(compileLib(doc), doc.pins);
    expect(es.pinBits('y')).toEqual([BZ]);
    const io = doc.pins[0];
    es.driveInout(io, 1);
    expect(es.pinBits('y')).toEqual([B1]);
    es.driveInout(io, 0);
    expect(es.pinBits('y')).toEqual([B0]);
    es.driveInout(io, undefined);
    expect(es.pinBits('y')).toEqual([BZ]);
    // A saved drive value is applied when the simulator is built.
    const es2 = new EditorSim({ debounceMs: 0 });
    const pins = [{ ...io, value: 1 }, ...doc.pins.slice(1)];
    es2.update(compileLib({ ...doc, pins }), pins);
    expect(es2.pinBits('y')).toEqual([B1]);
  });
});

/** Run both circuits clock cycle by clock cycle (inputs at 0) and compare every output. */
function sameRun(a: ComponentDef, b: ComponentDef, cycles: number): void {
  const sa = new GateSim(flatten(a, { mode: 'gate' })), sb = new GateSim(flatten(b, { mode: 'gate' }));
  const clk = inPorts(a).find((p) => p.clock || p.name === 'clk')?.name;
  for (const s of [sa, sb]) {
    for (const p of inPorts(a)) s.setInput(p.name, 0);
    s.reset('zero');
    s.settle();
  }
  const outs = (s: GateSim) => outPorts(a).map((p) => pack(s.getBits(s.design.root.ports[p.name])));
  for (let i = 0; i < cycles; i++) {
    expect(outs(sb), `cycle ${i}`).toEqual(outs(sa));
    if (!clk) break;
    for (const s of [sa, sb]) {
      s.setInput(clk, 1);
      s.settle();
      s.setInput(clk, 0);
      s.settle();
    }
  }
}

describe('Open in Sandbox (remix)', () => {
  it('a library circuit becomes a chip that computes the same', () => {
    const rca4 = resolveComponent('rca4')!;
    const r = remixDef(emptyWorkspace(), rca4);
    if ('error' in r) throw new Error(r.error);
    expect(r.id).toBe('u_rca4_copy');
    expect(r.added).toEqual(['u_rca4_copy']);
    expect(r.ws.open[r.ws.open.length - 1]).toBe('u_rca4_copy');
    expect(r.ws.chips.u_rca4_copy.name).toBe(`${rca4.name} copy`);
    const def = new UserLibrary(r.ws).defOf('u_rca4_copy')!;
    // Same ports (the sandbox orders them by where the pins sit), same function.
    const io = (d: ComponentDef) => d.ports.map((p) => `${p.name} ${p.dir} ${p.width}`).sort();
    expect(io(def)).toEqual(io(rca4));
    const sa = simulate(rca4), sb = simulate(def);
    const ins = inPorts(rca4);
    forEachInput(rca4, (vals) => {
      for (const s of [sa, sb]) ins.forEach((p, i) => s.setInput(p.name, vals[i]));
      sa.settle();
      sb.settle();
      for (const p of outPorts(rca4)) expect(sb.getBits(sb.design.root.ports[p.name])).toEqual(sa.getBits(sa.design.root.ports[p.name]));
    });
    // again: a new id and name; existing chips untouched
    const r2 = remixDef(r.ws, rca4);
    if ('error' in r2) throw new Error(r2.error);
    expect(r2.id).toBe('u_rca4_copy_2');
    expect(r2.ws.chips.u_rca4_copy_2.name).toBe(`${rca4.name} copy 2`);
    expect(r2.ws.chips.u_rca4_copy).toBe(r.ws.chips.u_rca4_copy);
  });

  it('a CPU: pointers come through, the program becomes a ROM part, its data memory a chip; it runs the same', () => {
    const words = assemble(PROGRAMS[0].source).words;
    const cpu = singleCycleCpu(words);
    const r = remixDef(emptyWorkspace(), cpu);
    if ('error' in r) throw new Error(r.error);
    const doc = r.ws.chips[r.id];
    expect(doc.labels.length).toBeGreaterThan(10);
    const rom = doc.parts.find((p) => 'rom' in p.ref);
    expect(rom && 'rom' in rom.ref && rom.ref.rom.addr).toBe('rv32');
    // every library reference resolves on a fresh load; the rest came along as chips
    for (const p of doc.parts) if ('lib' in p.ref) expect(stableRef(resolveComponent(p.ref.lib)!), p.ref.lib).toBe(true);
    expect(r.added).toContain('u_dmem5');
    const lib = new UserLibrary(r.ws);
    for (const id of r.added) expect(lib.compiled(id)!.diags.filter((d) => d.level === 'error'), id).toEqual([]);
    sameRun(cpu, lib.defOf(r.id)!, 12);
    // a second remix reuses the identical data-memory chip
    const r2 = remixDef(r.ws, cpu);
    if ('error' in r2) throw new Error(r2.error);
    expect(r2.added).toEqual([r2.id]);
  });

  it('a user chip is copied as drawn; chips it places stay references', () => {
    const w = ws(halfAdder(), fullAdder());
    const lib = new UserLibrary(w);
    const r = remixDef(w, lib.defOf('u_fa')!);
    if ('error' in r) throw new Error(r.error);
    expect(r.id).toBe('u_fa_copy');
    const { id: _a, name: _b, ...copy } = r.ws.chips.u_fa_copy;
    const { id: _c, name: _d, ...orig } = w.chips.u_fa;
    expect(copy).toEqual(orig);
  });

  it('into storage: saved, opened, and refused cleanly', () => {
    const kv = memKV();
    const r = remixIntoStorage(resolveComponent('rca4')!, kv);
    expect(r).toEqual({ id: 'u_rca4_copy', added: ['u_rca4_copy'] });
    const w = loadWorkspace(kv);
    expect(Object.keys(w.chips)).toEqual(['u_main', 'u_rca4_copy']);
    expect(w.open[w.open.length - 1]).toBe('u_rca4_copy');
    const before = kv.m.get(KEY);
    // a primitive has no circuit to draw: nothing saved
    expect(remixIntoStorage(resolveComponent('nmos')!, kv)).toEqual({ error: expect.stringMatching(/no netlist/) });
    expect(kv.m.get(KEY)).toBe(before);
  });
});
