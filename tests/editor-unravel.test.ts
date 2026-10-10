// Unravel and collapse pointers never change connectivity: every library component opened in the
// sandbox (docFromDef draws far ends as pointers), every example and every challenge answer is
// compiled before and after unravelling all of its pointers, and after collapsing all of its
// wires, and the nets (their ends, stored charge, power-on value) must be the same.

import { describe, expect, it } from 'vitest';
import { CHALLENGES } from '../src/editor/challengeset';
import { compileChip } from '../src/editor/compile';
import { EXAMPLES, addExample } from '../src/editor/examples';
import { docFromDef } from '../src/editor/fromdef';
import { UserLibrary } from '../src/editor/library';
import { type ChipDoc, type DefOf, emptyWorkspace, polyline, type Workspace } from '../src/editor/model';
import { partDef } from '../src/editor/parts';
import { remixDef } from '../src/editor/remix';
import { canUnravel, collapseWire, collapseWires, pointersOf, suggestName, unravelPointer, unravelPointers, wireTree } from '../src/editor/unravel';
import { reachableDefs } from '../src/lib/resolve';
import { type ComponentDef, netlistOf } from '../src/sim/types';
import { chip, compileLib, lbl, part, pin, wire, workspace } from './editorkit';
import { cpuTops } from './tops';

/** The nets of a compiled chip as text: sorted ends, charge, power-on value; sorted. */
function nets(def: ComponentDef): string[] {
  const nl = netlistOf(def)!;
  const po = (def as { powerOn?: Record<string, 0 | 1> }).powerOn ?? {};
  return nl.nets.map((n) => `${[...n.ends].sort().join(',')}${n.cap ? ' cap' : ''}${n.name && po[n.name] !== undefined ? ` =${po[n.name]}` : ''}`).sort();
}

const errors = (c: ReturnType<typeof compileChip>) => c.diags.filter((d) => d.level === 'error').map((d) => d.msg);

/** A chip in its workspace: compile and a defOf, through the workspace's own chips. */
function harness(ws: Workspace, id: string) {
  const compile = (doc: ChipDoc) => new UserLibrary({ ...ws, chips: { ...ws.chips, [doc.id]: doc } }).compiled(doc.id)!;
  const lib = new UserLibrary(ws);
  const defOf: DefOf = (p) => { const r = partDef(p.ref, (c) => lib.compiled(c)?.def); return 'error' in r ? undefined : r; };
  return { doc: ws.chips[id], compile, defOf };
}

/** Unravel every pointer name, then collapse every wire: both keep the nets. */
function roundTrip(ws: Workspace, id: string) {
  const { doc, compile, defOf } = harness(ws, id);
  const before = compile(doc);
  expect(errors(before)).toEqual([]);
  const want = nets(before.def);

  const names = [...new Set(doc.labels.map((l) => l.name))].filter((n) => canUnravel(doc, n));
  const u = unravelPointers(doc, names, defOf);
  expect(u.reason).toBeUndefined();
  if (names.length) expect(u.doc.labels.some((l) => names.includes(l.name))).toBe(false);
  const cu = compile(u.doc);
  expect(errors(cu)).toEqual([]);
  const offWire = (c: typeof before) => c.diags.filter((d) => /branch does not start/.test(d.msg)).length;
  expect(offWire(cu)).toBe(offWire(before));
  expect(nets(cu.def)).toEqual(want);

  const c = collapseWires(u.doc, u.doc.wires.map((w) => w.id), defOf);
  expect(c.reason).toBeUndefined();
  const cc = compile(c.doc);
  expect(errors(cc)).toEqual([]);
  expect(nets(cc.def)).toEqual(want);
  return { names, unravelled: u.doc, collapsed: c.doc };
}

describe('unravel', () => {
  // pin a → pointer 'sig' (l1); pointer 'sig' (l2) → NOT → y; pointer 'sig' (l3) → pin z.
  const doc = chip('u_u', 'U', {
    pins: [pin('a', 'in', [0, 2]), pin('y', 'out', [30, 12]), pin('z', 'out', [30, 20])],
    parts: [part('g', { lib: 'not' }, [16, 11])],
    labels: [lbl('l1', 'sig', [6, 2]), lbl('l2', 'sig', [10, 12], 'left'), lbl('l3', 'sig', [20, 20], 'left'), lbl('l4', 'sig', [40, 40])],
    wires: [wire('w1', 'pin:a', 'lbl:l1'), wire('w2', 'lbl:l2', 'g.a'), wire('w3', 'g.y', 'pin:y'), wire('w4', 'lbl:l3', 'pin:z')],
  });
  const defOf: DefOf = (p) => { const r = partDef(p.ref, () => undefined); return 'error' in r ? undefined : r; };

  it('wires the twins from the driver, keeping the nets, and names the net', () => {
    const r = unravelPointer(doc, 'sig', defOf);
    expect(r.reason).toBeUndefined();
    expect(r.doc.labels).toEqual([]); // the wireless twin goes too
    expect(r.doc.wires.map((w) => w.id).sort()).toEqual(['w1', 'w3', 'w4']); // w2 merged into w1 (the driver's)
    const w1 = r.doc.wires.find((w) => w.id === 'w1')!;
    expect([w1.a, w1.b]).toEqual([{ pin: 'a' }, { part: 'g', port: 'a' }]);
    expect(w1.name).toBe('sig');
    expect(r.doc.wires.find((w) => w.id === 'w4')!.a).toMatchObject({ wire: 'w1' });
    const [c0, c1] = [compileLib(doc), compileLib(r.doc)];
    expect(errors(c1)).toEqual([]);
    expect(nets(c1.def)).toEqual(nets(c0.def));
    expect(netlistOf(c1.def)!.nets.find((n) => n.ends.includes('a'))!.name).toBe('sig');
    for (const w of r.doc.wires) expect(polyline(r.doc, w, defOf)).not.toBeNull();
  });

  it('is refused without a twin to join', () => {
    const one = { ...doc, labels: doc.labels.filter((l) => l.id !== 'l2' && l.id !== 'l3'), wires: doc.wires.filter((w) => w.id !== 'w2' && w.id !== 'w4') };
    expect(canUnravel(one, 'sig')).toBe(false);
    expect(unravelPointer(one, 'sig', defOf).reason).toMatch(/no twin/);
    expect(unravelPointer(one, 'sig', defOf).doc).toBe(one);
  });

  it('lists the pointers a part, a wire or a pointer touches', () => {
    expect(pointersOf(doc, { parts: ['g'] })).toEqual(['sig']);
    expect(pointersOf(doc, { wires: ['w4'] })).toEqual(['sig']);
    expect(pointersOf(doc, { labels: ['l4'] })).toEqual(['sig']);
    expect(pointersOf(doc, { wires: ['w3'] })).toEqual([]);
  });

  it('a wire that ended on a twin branches off where it stood', () => {
    // A second wire on l2: to pin z2.
    const d2 = { ...doc, pins: [...doc.pins, pin('z2', 'out', [30, 6])], wires: [...doc.wires, wire('w5', 'lbl:l2', 'pin:z2', [[10, 6]])] };
    const r = unravelPointer(d2, 'sig', defOf);
    expect(r.reason).toBeUndefined();
    const w5 = r.doc.wires.find((w) => w.id === 'w5')!;
    expect(w5.a).toEqual({ wire: 'w1', at: [10, 12] });
    expect(nets(compileLib(r.doc).def)).toEqual(nets(compileLib(d2).def));
  });
});

describe('collapse', () => {
  const ha = chip('u_c', 'C', {
    pins: [pin('a', 'in', [0, 2]), pin('b', 'in', [0, 6]), pin('s', 'out', [20, 3])],
    parts: [part('x', { lib: 'xor' }, [8, 1])],
    wires: [wire('w1', 'pin:a', 'x.a'), wire('w2', 'pin:b', 'x.b', [[6, 6], [6, 4]]), wire('w3', 'x.y', 'pin:s'), wire('w4', { wire: 'w1', at: [4, 2] }, 'pin:s', [[4, 10], [18, 10]])],
  });
  const defOf: DefOf = (p) => { const r = partDef(p.ref, () => undefined); return 'error' in r ? undefined : r; };

  it('turns a wire and its branches into one pointer per end, pointing away', () => {
    expect(wireTree(ha, 'w4').sort()).toEqual(['w1', 'w4']);
    expect(suggestName(ha, 'w4', defOf)).toBe('a');
    const r = collapseWire(ha, 'w4', 'a', defOf);
    expect(r.reason).toBeUndefined();
    expect(r.doc.labels).toHaveLength(3); // pin a, x.a, pin s
    expect(r.doc.labels.every((l) => l.name === 'a')).toBe(true);
    // Pin a faces right: its pointer sits two units out, flag pointing on to the right.
    expect(r.doc.labels.find((l) => r.doc.wires.some((w) => 'pin' in w.a && w.a.pin === 'a' && 'label' in w.b && w.b.label === l.id))).toMatchObject({ at: [2, 2], face: 'right' });
    expect(r.doc.wires.some((w) => w.id === 'w1' || w.id === 'w4')).toBe(false);
    expect(nets(compileLib(r.doc).def)).toEqual(nets(compileLib(ha).def));
  });

  it('refuses a name another net uses, and a second name for a pointer it reaches', () => {
    const d = collapseWire(ha, 'w3', 's', defOf).doc;
    expect(collapseWire(d, 'w2', 's', defOf).reason).toMatch(/another net/);
    const withPtr = { ...ha, labels: [lbl('lp', 'p', [12, 12])], wires: [...ha.wires, wire('w9', { wire: 'w4', at: [12, 10] }, 'lbl:lp')] };
    expect(suggestName(withPtr, 'w1', defOf)).toBe('p');
    expect(collapseWire(withPtr, 'w1', 'q', defOf).reason).toMatch(/already reaches pointer “p”/);
    const ok = collapseWire(withPtr, 'w1', 'p', defOf);
    expect(ok.reason).toBeUndefined();
    expect(nets(compileLib(ok.doc).def)).toEqual(nets(compileLib(withPtr).def));
  });

  it('then unravels back to the same nets', () => {
    const r = collapseWire(ha, 'w4', 'a', defOf);
    const u = unravelPointer(r.doc, 'a', defOf);
    expect(u.reason).toBeUndefined();
    expect(u.doc.labels).toEqual([]);
    expect(nets(compileLib(u.doc).def)).toEqual(nets(compileLib(ha).def));
  });
});

describe('connectivity never changes', () => {
  it.each(EXAMPLES.map((e) => [e.name, e] as const))('example: %s', (_, ex) => {
    const { ws, id } = addExample(emptyWorkspace(), ex);
    roundTrip(ws, id);
  });

  it.each(CHALLENGES.map((c) => [c.id, c] as const))('challenge answer: %s', (_, c) => {
    const chips = c.answer();
    const ws = workspace(...chips.slice().reverse());
    for (const d of chips) roundTrip(ws, d.id);
  });

  // Library components drawn as sandbox documents: pointers at their far ends, branches for fan-outs.
  const docs = reachableDefs()
    .filter((d) => netlistOf(d))
    .map((d) => docFromDef(d))
    .filter((d): d is ChipDoc => !('error' in d) && d.labels.length > 0);
  it('covers library components with pointers', () => expect(docs.length).toBeGreaterThan(20));
  // The chapters' CPUs, opened in the sandbox: the biggest documents with the most pointers.
  it.each(cpuTops().map((d) => [d.id, d] as const))('CPU: %s', (_, def) => {
    const r = remixDef(emptyWorkspace(), def);
    if ('error' in r) throw new Error(r.error);
    const t = performance.now();
    const { names } = roundTrip(r.ws, r.id);
    expect(names.length).toBeGreaterThan(0);
    expect(performance.now() - t).toBeLessThan(20000);
  });

  it.each(docs.map((d) => [d.id, d] as const))('library: %s', (_, d) => {
    const ws = workspace(d);
    if (errors(compileChip(d, (ref) => partDef(ref, () => undefined))).length) return;
    const { names } = roundTrip(ws, d.id);
    expect(names.length).toBeGreaterThan(0);
  });
});
