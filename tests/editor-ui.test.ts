// The DOM-free parts of the sandbox editor: snapping, hit testing, the wire being drawn, the
// session helpers (tabs, volatile state across undo), the palette registry, and the live
// simulation (EditorSim: rebuild only on connectivity changes, state carried, run modes).

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { resolveComponent } from '../src/lib/resolve';
import { compileChip } from '../src/editor/compile';
import {
  branchPoint, drives, elbow, hitTest, nextSameName, partAnchor, pointerGeom, snapPt, wireGroups, WireDraft,
} from '../src/editor/geom';
import { emptyWorkspace, type ChipDoc, type DefOf, type PartRef } from '../src/editor/model';
import { addPart, addPin, addWire, moveSel } from '../src/editor/ops';
import { paletteGroups, registerPaletteGroup, visibleItems, type PaletteCtx } from '../src/editor/palette';
import { partDef } from '../src/editor/parts';
import { EditorSim, simKey } from '../src/editor/runtime';
import { activeChip, closeChip, keepVolatile, newChip, openChip, setPinValue } from '../src/editor/session';
import { symbolGeom } from '../src/sim/geometry';
import { B1 } from '../src/sim/types';
import { chip, end, halfAdder, lbl, part, pin, wire } from './editorkit';

const defOf: DefOf = (p) => {
  const r = partDef(p.ref, () => undefined);
  return 'error' in r ? undefined : r;
};
const compile = (doc: ChipDoc) => compileChip(doc, (ref: PartRef) => partDef(ref, () => undefined));

describe('snapping', () => {
  it('puts every port of a placed part on the grid', () => {
    for (const id of ['nand', 'xor', 'not', 'mux2', 'nmos', 'vdd', 'gnd', 'counter4', 'rca4', 'dff']) {
      const d = resolveComponent(id)!;
      for (const c of [[3.3, 7.8], [-2.5, 0.49], [10, 10]] as [number, number][]) {
        const at = partAnchor(d, c);
        for (const pg of Object.values(symbolGeom(d).ports)) {
          expect(Number.isInteger(at[0] + pg.pos[0]) && Number.isInteger(at[1] + pg.pos[1]), `${id} ${pg.pos}`).toBe(true);
        }
        // roughly centred under the cursor
        const g = symbolGeom(d);
        expect(Math.abs(at[0] + g.w / 2 - c[0])).toBeLessThanOrEqual(1);
        expect(Math.abs(at[1] + g.h / 2 - c[1])).toBeLessThanOrEqual(1);
      }
    }
  });

  it('half-unit ports (a splitter of pitch 1): most ports land on the grid', () => {
    const d = partDef({ split: [1, 1, 1, 1], pitch: 1 }, () => undefined);
    if ('error' in d) throw new Error(d.error);
    const at = partAnchor(d, [5.2, 5.2]);
    const on = Object.values(symbolGeom(d).ports).filter((pg) => Number.isInteger(at[1] + pg.pos[1]));
    expect(on.length).toBe(4); // the four taps; the bus input sits between two grid lines
  });

  it('snapPt rounds to the nearest grid point', () => {
    expect(snapPt([1.49, -2.51])).toEqual([1, -3]);
  });
});

describe('hit testing', () => {
  const doc = halfAdder();
  it('ports first, then bodies, then wires', () => {
    expect(hitTest(doc, defOf, [8.1, 2.1], 0.4)).toEqual({ k: 'port', end: { part: 'x', port: 'a' }, pos: [8, 2] });
    expect(hitTest(doc, defOf, [0, 2], 0.4)).toMatchObject({ k: 'port', end: { pin: 'a' } });
    expect(hitTest(doc, defOf, [10, 3], 0.4)).toEqual({ k: 'part', id: 'x' });
    // the pin's knob sits 0.9 behind its connection point
    expect(hitTest(doc, defOf, [-0.9, 2], 0.4)).toEqual({ k: 'pin', id: 'a' });
    // w5 runs x.y (12,3) → s (20,3)
    expect(hitTest(doc, defOf, [16, 3.2], 0.4)).toEqual({ k: 'wire', id: 'w5', at: [16, 3] });
    expect(hitTest(doc, defOf, [30, 30], 0.4)).toEqual({ k: 'none' });
  });

  it('pointers: the attach point is a port, the flag selects', () => {
    const d = chip('u_p', 'P', { labels: [lbl('l1', 'clk', [5, 5])] });
    expect(hitTest(d, defOf, [5, 5], 0.4)).toMatchObject({ k: 'port', end: { label: 'l1' } });
    expect(hitTest(d, defOf, [7, 5], 0.4)).toEqual({ k: 'label', id: 'l1' });
  });

  it('branchPoint snaps onto the wire', () => {
    expect(branchPoint([[0, 0], [10, 0]], [3.4, 0.3])).toEqual([3, 0]);
    expect(branchPoint([[0, 0.5], [10, 0.5]], [3.4, 0.3])).toEqual([3, 0.5]);
  });

  it('drives: part outputs and chip inputs', () => {
    expect(drives(doc, end('x.y'), defOf)).toBe(true);
    expect(drives(doc, end('pin:a'), defOf)).toBe(true);
    expect(drives(doc, end('x.a'), defOf)).toBe(false);
    expect(drives(doc, end('pin:s'), defOf)).toBe(false);
  });
});

describe('pointers', () => {
  it('the flag points away from where wires attach', () => {
    const r = pointerGeom({ at: [0, 0], name: 'abc', face: 'right' });
    expect(r.tip).toEqual([1, 0]);
    expect(r.rect.x).toBe(1);
    const l = pointerGeom({ at: [0, 0], name: 'abc', face: 'left' });
    expect(l.rect.x + l.rect.w).toBeCloseTo(-1);
    const u = pointerGeom({ at: [0, 0], name: 'abc', face: 'up' });
    expect(u.rect.y + u.rect.h).toBeCloseTo(-1);
  });

  it('next same-name pointer wraps around', () => {
    const d = chip('u_p', 'P', { labels: [lbl('l1', 'a', [0, 0]), lbl('l2', 'b', [0, 4]), lbl('l3', 'a', [0, 8])] });
    expect(nextSameName(d, 'l1')!.id).toBe('l3');
    expect(nextSameName(d, 'l3')!.id).toBe('l1');
    expect(nextSameName(d, 'l2')).toBeNull();
  });
});

describe('wire groups (junction dots)', () => {
  it('joins wires on a shared end and branches; separate nets stay apart', () => {
    const groups = wireGroups(halfAdder().wires).map((g) => g.sort().join(','));
    expect(groups.sort()).toEqual(['w1,w2', 'w3,w4', 'w5', 'w6']);
  });
});

describe('WireDraft', () => {
  it('leaves a right-facing port horizontally, turns at right angles, enters a left port horizontally', () => {
    const d = new WireDraft(end('g1.y'), [4, 2], 'right');
    expect(d.preview([10, 6])).toEqual([[4, 2], [10, 2], [10, 6]]);
    d.addCorner([10, 6]);
    expect(d.pts).toEqual([[10, 2], [10, 6]]);
    // last leg vertical → next leg horizontal first
    expect(d.preview([14, 9])).toEqual([[4, 2], [10, 2], [10, 6], [14, 6], [14, 9]]);
    // a left-facing target is entered horizontally
    expect(d.preview([14, 9], 'left')).toEqual([[4, 2], [10, 2], [10, 9], [14, 9]]);
    expect(d.corners([14, 9], 'left')).toEqual([[10, 2], [10, 9]]);
  });

  it('Space flips the L; Backspace takes the last click back', () => {
    const d = new WireDraft(end('pin:a'), [0, 0], 'right');
    d.flip();
    expect(d.preview([5, 5])).toEqual([[0, 0], [0, 5], [5, 5]]);
    d.addCorner([5, 5]);
    d.addCorner([8, 9]);
    expect(d.undo()).toBe(true);
    expect(d.pts).toEqual([[0, 5], [5, 5]]);
    expect(d.undo()).toBe(true);
    expect(d.pts).toEqual([]);
    expect(d.undo()).toBe(false);
  });

  it('elbow is empty for aligned points', () => {
    expect(elbow([0, 0], [5, 0], true)).toEqual([]);
    expect(elbow([0, 0], [5, 3], false)).toEqual([[5, 0]]);
  });

  it('a drawn wire is accepted by addWire as is', () => {
    let doc = chip('u_w', 'W', { pins: [pin('a', 'in', [0, 0]), pin('y', 'out', [20, 9])], parts: [part('g', { lib: 'not' }, [8, 4])] });
    const d1 = new WireDraft(end('pin:a'), [0, 0], 'right');
    d1.addCorner([4, 3]);
    const r1 = addWire(doc, d1.from, end('g.a'), d1.corners([8, 5], 'left'), defOf);
    expect(r1.reason).toBeUndefined();
    doc = r1.doc;
    expect(compile(doc).diags.filter((x) => x.level === 'error')).toEqual([]);
  });
});

describe('session', () => {
  it('tabs: open moves to the top, close keeps one, new chips get unique names and ids', () => {
    let ws = emptyWorkspace();
    const a = newChip(ws);
    expect(a.id).toBe('u_chip');
    const b = newChip(a.ws);
    expect(b.ws.chips[b.id].name).toBe('Chip 2');
    ws = b.ws;
    expect(activeChip(ws)).toBe(b.id);
    ws = openChip(ws, 'u_main');
    expect(ws.open).toEqual(['u_chip', 'u_chip_2', 'u_main']);
    ws = closeChip(closeChip(closeChip(ws, 'u_main'), 'u_chip'), 'u_chip_2');
    expect(ws.open).toEqual(['u_chip_2']);
  });

  it('undo keeps input values and tabs', () => {
    const ws0 = { ...emptyWorkspace() };
    const doc = addPin(ws0.chips.u_main, 'in', 1, [0, 0]).doc;
    const ws1 = { ...ws0, chips: { u_main: doc } };
    const ws2 = setPinValue(ws1, 'u_main', 'pin1', 1);
    expect(ws2.chips.u_main.pins[0].value).toBe(1);
    // undo back to ws1 (value absent) while the current state has value 1 and another tab
    const cur = { ...ws2, open: ['u_main'], purist: true };
    const r = keepVolatile(ws1, cur);
    expect(r.chips.u_main.pins[0].value).toBe(1);
    expect(r.purist).toBe(true);
    // unchanged chips keep their identity
    expect(keepVolatile(ws2, ws2).chips.u_main).toBe(ws2.chips.u_main);
  });
});

describe('palette', () => {
  const ctx: PaletteCtx = { ws: emptyWorkspace(), chipId: 'u_main', canPlace: () => true };
  it('has the built-in groups, the library included', () => {
    const ids = paletteGroups().map((g) => g.id);
    expect(ids).toEqual(expect.arrayContaining(['io', 'fets', 'const', 'disp', 'wiring', 'lib', 'mine']));
    const lib = paletteGroups().find((g) => g.id === 'lib')!;
    expect(visibleItems(lib, ctx, false).length).toBeGreaterThan(50);
  });

  it('purist mode keeps NAND from the library and drops the rest', () => {
    const lib = paletteGroups().find((g) => g.id === 'lib')!;
    expect(visibleItems(lib, ctx, true).map((i) => i.id)).toEqual(['nand']);
    expect(visibleItems(paletteGroups().find((g) => g.id === 'fets')!, ctx, true).length).toBe(6);
  });

  it('every built-in part resolves', () => {
    for (const g of paletteGroups()) {
      for (const it of g.items(ctx)) {
        if ('part' in it.place) expect(defOf({ id: 'x', ref: it.place.part, at: [0, 0] }), `${g.id}/${it.id}`).toBeDefined();
      }
    }
  });

  it('later phases register groups', () => {
    registerPaletteGroup({ id: 'test', title: 'Test', order: 5, items: () => [{ id: 't', name: 'T', place: { pointer: true } }] });
    expect(paletteGroups()[0].id).toBe('test');
    expect(visibleItems(paletteGroups()[0], ctx, false, 'zz')).toEqual([]);
  });
});

describe('EditorSim', () => {
  const counterDoc = (extra = false): ChipDoc => chip('u_c', 'C', {
    pins: [pin('en', 'in', [0, 2]), { ...pin('clk', 'in', [0, 8]), kind: 'clock' }, pin('q', 'out', [30, 2], 4)],
    parts: [part('c', { lib: 'counter4' }, [10, 0]), ...(extra ? [part('n', { lib: 'nand' }, [10, 20])] : [])],
    wires: [wire('w1', 'pin:en', 'c.en'), wire('w2', 'pin:clk', 'c.clk', [[14, 8]]), wire('w3', 'c.q', 'pin:q')],
  });

  it('counts clock cycles and keeps its count across a structural rebuild', () => {
    const es = new EditorSim({ debounceMs: 0 });
    let doc = counterDoc();
    doc = { ...doc, pins: doc.pins.map((p) => (p.name === 'en' ? { ...p, value: 1 } : p)) };
    es.update(compile(doc), doc.pins);
    expect(es.sim).not.toBeNull();
    expect(es.hasClock).toBe(true);
    for (let i = 0; i < 5; i++) es.stepOnce();
    expect(es.cycles).toBe(5);
    expect(es.pinBits('q')).toEqual([1, 0, 1, 0]);
    const before = es.sim;
    // moving a part does not rebuild
    const moved = moveSel(doc, { parts: ['c'] }, [0, 1], defOf);
    es.update(compile(moved), moved.pins);
    expect(es.sim).toBe(before);
    // adding one does, and the count survives
    const more = counterDoc(true);
    const more1 = { ...more, pins: more.pins.map((p) => (p.name === 'en' ? { ...p, value: 1 } : p)) };
    es.update(compile(more1), more1.pins);
    expect(es.sim).not.toBe(before);
    expect(es.pinBits('q')).toEqual([1, 0, 1, 0]);
    es.stepOnce();
    expect(es.pinBits('q')).toEqual([0, 1, 1, 0]);
    // values through the compile: the q wire carries 6
    expect(es.wireBits('w3')).toEqual([0, 1, 1, 0]);
    expect(es.endBits('pin:en')).toEqual([B1]);
  });

  it('advance() runs cycles at the chosen rate; gate mode steps one delay at a time', () => {
    const es = new EditorSim({ debounceMs: 0, budgetMs: 10_000 }); // the rate, not this machine's speed: a slow runner must not drop cycles
    const doc = counterDoc();
    es.update(compile(doc), [{ ...doc.pins[0], value: 1 }, doc.pins[1], doc.pins[2]]);
    es.hz = 10;
    expect(es.advance(0.5)).toBe(5);
    expect(es.cycles).toBe(5);
    es.setMode('gate');
    const t0 = es.time;
    es.advance(1 / 12); // one tick at 12 delays/s: the clock rises
    expect(es.cycles).toBe(6);
    es.advance(1 / 12);
    expect(es.time).toBe(t0 + 1);
  });

  it('a rebuild is debounced and keys on connectivity and part definitions', () => {
    const es = new EditorSim({ debounceMs: 50 });
    const doc = halfAdder();
    const c = compile(doc);
    es.update(c, doc.pins);
    expect(es.sim).not.toBeNull(); // the first build is immediate
    const s0 = es.sim;
    const doc2 = { ...doc, wires: doc.wires.filter((w) => w.id !== 'w6') };
    es.update(compile(doc2), doc2.pins);
    expect(es.pending).toBe(true);
    expect(es.sim).toBe(s0);
    es.flush();
    expect(es.sim).not.toBe(s0);
    expect(simKey(compile(doc))).toBe(simKey(compile(doc)));
    es.destroy();
  });

  it('a chip that cannot be simulated reports why, without throwing', () => {
    // two NMOS at gate level are refused by flatten → but compile makes it switch level;
    // a behavioural-only part at switch level cannot be flattened
    const doc = chip('u_bad', 'Bad', {
      pins: [pin('a', 'in', [0, 0])],
      parts: [part('t', { lib: 'nmos' }, [4, 0]), part('r', { lib: 'rom_none_such' } as unknown as { lib: string }, [10, 0])],
      wires: [wire('w1', 'pin:a', 't.g')],
    });
    const es = new EditorSim({ debounceMs: 0 });
    expect(() => es.update(compile(doc), doc.pins)).not.toThrow();
  });
});

describe('placing then wiring with ops (what the tools do)', () => {
  it('a NAND placed by partAnchor is wired straight from pins on the grid', () => {
    let doc: ChipDoc = chip('u_n', 'N', {});
    const nand = resolveComponent('nand')!;
    const r = addPart(doc, { lib: 'nand' }, partAnchor(nand, [10.3, 5.6]));
    doc = r.doc;
    const at = doc.parts[0].at;
    doc = addPin(doc, 'in', 1, [0, at[1] + 1]).doc;
    const w = addWire(doc, end('pin:pin1'), end(`${r.id}.a`), [], defOf);
    expect(w.reason).toBeUndefined();
    expect(w.doc.wires[0].pts).toEqual([]);
  });
});
