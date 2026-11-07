// A wire's colour on any schematic (view/layout.ts hues, the stage's right-click menu): kept per component id in
// localStorage like the learner's layout, sanitized on load, cleared one net at a time or all at once, undone and redone;
// carried through applyLayout onto the net (so a rebuilt level, a moved part or a net drawn as pointers keeps it), held by
// spreadHues while its neighbours move away, drawn as a user hue, and taken into the sandbox by Open in Sandbox.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../src/lib';
import { registry } from '../src/lib/define';
import { netlistOf, type ComponentDef, type Netlist } from '../src/sim/types';
import { drawnHue, netHue, netKey, spreadHues, USER_HUE } from '../src/view/nethue';
import { docFromDef } from '../src/editor/fromdef';

const KEY = 'mosfet2riscv:layouts:v1';

/** A fresh layout.ts over a stub localStorage holding `raw` (its store is read once per module instance). */
async function freshLayout(raw?: string) {
  const mem = new Map<string, string>(raw === undefined ? [] : [[KEY, raw]]);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  });
  vi.resetModules();
  const L = await import('../src/view/layout');
  return { L, saved: () => JSON.parse(mem.get(KEY) ?? '{}') as Record<string, { hues?: Record<string, unknown> }> };
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe('stage net colours: storage', () => {
  it('a colour is saved per component and net, read back by a fresh load, and cleared again', async () => {
    const a = await freshLayout();
    a.L.setColour('xor', 'n1', 185);
    a.L.setColour('xor', 'y', 'auto');
    a.L.setColour('fa9', 'cout', 45);
    expect(a.saved().xor.hues).toEqual({ n1: 185, y: 'auto' });
    expect(a.saved().fa9.hues).toEqual({ cout: 45 });

    // a reload: a new module instance reads what was saved
    const b = await freshLayout(JSON.stringify(a.saved()));
    expect(b.L.colourOf('xor', 'n1')).toBe(185);
    expect(b.L.colourOf('xor', 'y')).toBe('auto');
    expect(b.L.colourOf('xor', 'cout')).toBeUndefined(); // a colour belongs to its own component
    // clearing one net keeps the others; clearing the last drops the component's record altogether
    b.L.setColour('xor', 'n1', undefined);
    expect(b.saved().xor.hues).toEqual({ y: 'auto' });
    b.L.setColour('xor', 'y', undefined);
    expect(b.saved().xor).toBeUndefined();
    expect(b.L.layoutOf('xor')).toBeUndefined();
    // Reset colours on a level with a moved part too: the arrangement stays
    b.L.editLayout('fa9', (e) => (e.at.g1 = [4, 4]));
    b.L.resetColours('fa9');
    expect(b.L.layoutOf('fa9')).toEqual({ at: { g1: [4, 4] }, wired: [], tagged: [] });
    // and Reset layout keeps the colours
    b.L.setColour('fa9', 'cout', 45);
    b.L.resetLayout('fa9');
    expect(b.L.layoutOf('fa9')?.hues).toEqual({ cout: 45 });
  });

  it('sanitizes what it reads: junk dropped, hues wrapped to a turn, the rest of the layout kept', async () => {
    const raw = JSON.stringify({
      xor: { at: { g1: [1, 2] }, wired: [], tagged: [], hues: { a: 400, b: -30, c: 'red', d: null, e: Infinity, f: 'auto', g: [1], h: 90.5 } },
      onlyjunk: { at: {}, wired: [], tagged: [], hues: { x: 'blue' } },
      nothues: { at: {}, wired: [], tagged: [], hues: 'all of them' },
    });
    const { L } = await freshLayout(raw);
    expect(L.layoutOf('xor')?.hues).toEqual({ a: 40, b: 330, f: 'auto', h: 90.5 });
    expect(L.layoutOf('xor')?.at).toEqual({ g1: [1, 2] });
    expect(L.layoutOf('onlyjunk')).toBeUndefined();
    expect(L.layoutOf('nothues')).toBeUndefined();
    // an unreadable store starts over instead of throwing
    const bad = await freshLayout('{not json');
    expect(bad.L.layoutOf('xor')).toBeUndefined();
    // and a value set in code is sanitized the same way
    bad.L.setColour('xor', 'n', 725);
    expect(bad.L.colourOf('xor', 'n')).toBe(5);
    bad.L.setColour('xor', 'm', Number.NaN);
    expect(bad.L.colourOf('xor', 'm')).toBeUndefined();
  });

  it('a colour is one undo step: undo takes it back, redo puts it again', async () => {
    const { L } = await freshLayout();
    L.setColour('mux2', 'sel', 255);
    L.setColour('mux2', 'sel', 120);
    expect(L.undoLayout('mux2')).toBe(true);
    expect(L.colourOf('mux2', 'sel')).toBe(255);
    expect(L.undoLayout('mux2')).toBe(true);
    expect(L.colourOf('mux2', 'sel')).toBeUndefined();
    expect(L.undoLayout('mux2', true)).toBe(true);
    expect(L.colourOf('mux2', 'sel')).toBe(255);
  });
});

describe('stage net colours: drawing', () => {
  const def = (): ComponentDef => {
    const d = [...registry.values()].find((x) => x.netlist && netlistOf(x)!.nets.length >= 6 && netlistOf(x)!.nets.length < 40 && netlistOf(x)!.nets.some((n) => !n.tags));
    expect(d).toBeDefined();
    return d!;
  };

  it('applyLayout puts the colour on the net, and a rebuilt level or a moved part keeps it', async () => {
    const { L } = await freshLayout();
    const d = def(), nl = netlistOf(d)!;
    const i = nl.nets.findIndex((n) => !n.tags), key = netKey(nl.nets[i]);
    L.setColour(d.id, key, 220);
    const out = L.applyLayout(nl, L.layoutOf(d.id));
    expect(out.nets[i].hue).toBe(220);
    expect(out.nets.filter((n) => n.hue !== undefined)).toHaveLength(1);
    // the same level built again (a new netlist object, as a rebuild makes): found by its key, not by identity
    const again: Netlist = { ...nl, nets: nl.nets.map((n) => ({ ...n })) };
    expect(L.applyLayout(again, L.layoutOf(d.id)).nets[i].hue).toBe(220);
    // a part moved, and the net drawn as pointers: still coloured
    const inst = nl.instances[0].name;
    L.editLayout(d.id, (e) => { e.at[inst] = [(nl.instances[0].at?.[0] ?? 0) + 3, (nl.instances[0].at?.[1] ?? 0) + 2]; e.tagged.push(key); });
    const moved = L.applyLayout(nl, L.layoutOf(d.id));
    expect(moved.nets[i].hue).toBe(220);
    expect(moved.nets[i].tags).toBe(true);
    // the authored netlist is never touched
    expect(nl.nets[i].hue).toBeUndefined();
  });

  it('spreadHues keeps a picked hue and moves its neighbours away from it', () => {
    // two parallel nets whose own hues are far apart; pick one onto the other's hue
    const a = { key: 'a', polys: [[[0, 0], [20, 0]] as [number, number][]] }, b = { key: 'b', polys: [[[0, 1], [20, 1]] as [number, number][]] };
    const free = spreadHues([a, b]);
    const pinned = spreadHues([{ ...a, fixed: free[1] }, b]);
    expect(pinned[0]).toBe(free[1]);
    expect(Math.min(Math.abs(pinned[1] - pinned[0]), 360 - Math.abs(pinned[1] - pinned[0]))).toBeGreaterThanOrEqual(30);
    // a net no one picked and no neighbour crowds keeps its own hue
    expect(spreadHues([a])[0]).toBe(netHue('a'));
  });

  it('a picked colour is drawn as a user hue (shown with colour per net off); auto is the net\'s own hue as a user hue', () => {
    expect(drawnHue(140, undefined)).toBe(140);
    expect(drawnHue(140, 255)).toBe(USER_HUE + 255);
    expect(drawnHue(140, 'auto')).toBe(USER_HUE + 140);
  });

  it('Open in Sandbox takes the colour onto every wire and pointer of the net, and nowhere else', async () => {
    const { L } = await freshLayout();
    const d = def(), nl = netlistOf(d)!;
    const i = nl.nets.findIndex((n) => !n.tags && n.ends.length >= 2), key = netKey(nl.nets[i]);
    L.setColour(d.id, key, 290);
    const shown: ComponentDef = { ...d, netlist: () => L.applyLayout(nl, L.layoutOf(d.id)) };
    const doc = docFromDef(shown, { id: 'u_colour_test' });
    if ('error' in doc) throw new Error(doc.error);
    const coloured = doc.wires.filter((w) => w.hue !== undefined);
    expect(coloured.length).toBeGreaterThanOrEqual(nl.nets[i].ends.length - 1);
    expect(coloured.every((w) => w.hue === 290)).toBe(true);
    // the pointers of a net drawn as pointers carry it too
    L.editLayout(d.id, (e) => e.tagged.push(key));
    const doc2 = docFromDef({ ...d, netlist: () => L.applyLayout(nl, L.layoutOf(d.id)) }, { id: 'u_colour_test2' });
    if ('error' in doc2) throw new Error(doc2.error);
    expect(doc2.labels.length).toBeGreaterThan(0);
    expect(doc2.labels.filter((l) => l.hue === 290).length).toBeGreaterThan(0);
    expect(doc2.labels.every((l) => l.hue === undefined || l.hue === 290)).toBe(true);
  });
});
