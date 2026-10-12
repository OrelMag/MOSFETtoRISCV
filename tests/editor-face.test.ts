// Chip appearance (editor/face.ts): a packaged chip's box shaped by hand (size, pins on any side
// at any offset) and the displays inside it shown on its box, live, from any depth.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import {
  autoFace, autoLayout, explicitFace, faceHit, faceItems, faceOf, isEmptyFace, movePin, nodeAt, pinToSide, placeDisplay, resizeFace,
  resolveFace, shownBox, shownNets, toggleDisplay,
} from '../src/editor/face';
import { switchCell, SW_PITCH } from '../src/editor/ioparts';
import { toggleSwitch } from '../src/editor/ioface';
import { UserLibrary } from '../src/editor/library';
import { emptyWorkspace, type FaceDoc, type Workspace } from '../src/editor/model';
import { EditorSim } from '../src/editor/runtime';
import { sanitizeChip } from '../src/editor/store';
import { symbolGeom } from '../src/sim/geometry';
import { boxText, labelRect } from '../src/view/boxtext';
import { chip, compileLib, halfAdder, part, pin, wire } from './editorkit';

function sim(ws: Workspace, id: string): EditorSim {
  const lib = new UserLibrary(ws);
  const es = new EditorSim({ debounceMs: 0 });
  es.update(lib.compiled(id)!, ws.chips[id].pins);
  return es;
}

const ws = (...chips: ReturnType<typeof chip>[]): Workspace => ({ ...emptyWorkspace(), chips: Object.fromEntries(chips.map((c) => [c.id, c])) });

/** A 4-bit input shown on an LED bank, and a 4-switch bank driving an output. */
const inner = (face?: FaceDoc) => chip('u_in', 'Inner', {
  pins: [pin('v', 'in', [0, 2], 4), pin('q', 'out', [30, 2], 4)],
  parts: [part('l', { display: 'led', width: 4 }, [6, 0]), part('sw', { switches: 4 }, [6, 6]), part('h', { display: 'halt' }, [6, 12])],
  wires: [wire('w1', 'pin:v', 'l.a'), wire('w2', 'sw.q', 'pin:q')],
  ...(face ? { face } : {}),
});

describe('the automatic face', () => {
  it('is the box compile.ts always drew: no face, nothing changes', () => {
    const doc = halfAdder();
    const c = compileLib(doc);
    const g = symbolGeom(c.def);
    const auto = autoFace(doc.pins, doc.name);
    expect([auto.w, auto.h]).toEqual([g.w, g.h]);
    for (const p of doc.pins) {
      const at = auto.pins.get(p.id)!;
      expect(g.ports[p.name].pos).toEqual(at.side === 'left' ? [0, at.at] : [g.w, at.at]);
    }
    expect(faceOf(c.def)).toBeNull();
    expect(resolveFace(undefined, doc.pins, doc.name, []).pins).toEqual(auto.pins);
  });
});

describe('pins and size', () => {
  it('places pins on any side at any offset, and the box is the size asked for', () => {
    const doc = { ...halfAdder(), face: { w: 10, h: 6, pins: { a: { side: 'top' as const, at: 3 }, b: { side: 'bottom' as const, at: 7 }, s: { side: 'right' as const, at: 2 }, c: { side: 'left' as const, at: 4 } } } };
    const g = symbolGeom(compileLib(doc).def);
    expect([g.w, g.h]).toEqual([10, 6]);
    expect(g.ports.a).toEqual({ pos: [3, 0], exit: 'up' });
    expect(g.ports.b).toEqual({ pos: [7, 6], exit: 'down' });
    expect(g.ports.s).toEqual({ pos: [10, 2], exit: 'right' });
    expect(g.ports.c).toEqual({ pos: [0, 4], exit: 'left' });
  });

  it('grows the box to hold every pin, never on a corner, and moves a pin off a taken spot', () => {
    const doc = halfAdder();
    const r = resolveFace({ w: 4, h: 4, pins: { a: { side: 'top', at: 9 }, b: { side: 'top', at: 9 }, s: { side: 'right', at: 1 } } }, doc.pins, doc.name, []);
    expect(r.w).toBe(10);
    expect(r.pins.get('a')).toEqual({ side: 'top', at: 9 });
    // b asked for a's spot; c has no entry: both go to their default side, 2 past the last pin there
    expect(r.pins.get('b')).toEqual({ side: 'left', at: 2 });
    expect(r.pins.get('c')).toEqual({ side: 'right', at: 3 });
    const keys = [...r.pins.values()].map((p) => `${p.side}:${p.at}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('a pin dropped on another swaps with it; pinToSide finds a free even spot or grows the side', () => {
    const doc = halfAdder();
    const r0 = resolveFace(undefined, doc.pins, doc.name, []);
    const a0 = r0.pins.get('a')!, b0 = r0.pins.get('b')!;
    const f1 = movePin({}, r0, 'a', b0.side, b0.at);
    expect(f1.pins!.a).toEqual(b0);
    expect(f1.pins!.b).toEqual(a0);
    const r1 = resolveFace(f1, doc.pins, doc.name, []);
    const f2 = pinToSide(f1, r1, 'c', 'top');
    expect(f2.pins!.c.side).toBe('top');
    expect(f2.pins!.c.at % 2).toBe(0);
    // a side 2 long has one spot: the second pin there makes it grow
    const r2 = resolveFace({ w: 2, h: 4, pins: { a: { side: 'top', at: 1 } } }, doc.pins, doc.name, []);
    const f3 = pinToSide({ w: 2, h: 4, pins: { a: { side: 'top', at: 1 } } }, r2, 'b', 'top');
    expect(f3.w).toBe(4);
    expect(f3.pins!.b).toEqual({ side: 'top', at: 3 });
  });

  it('never resizes below what the box holds; Auto layout keeps the displays', () => {
    const doc = halfAdder();
    const f = explicitFace(undefined, resolveFace(undefined, doc.pins, doc.name, []));
    const r = resolveFace(f, doc.pins, doc.name, []);
    const small = resizeFace(f, r, 1, 1);
    expect(small.h).toBe(Math.max(...[...r.pins.values()].map((p) => p.at)) + 1);
    expect(resizeFace(f, r, 30.4, 12.6)).toMatchObject({ w: 30, h: 13 });
    expect(autoLayout({ ...f, displays: [{ path: ['x'], at: [0, 0] }] })).toEqual({ displays: [{ path: ['x'], at: [0, 0] }] });
    expect(autoLayout(f)).toBeUndefined();
    expect(isEmptyFace({})).toBe(true);
  });
});

describe('displays on the face', () => {
  it('offers displays and I/O parts (not the halt part), and what placed chips show', () => {
    const lib = new UserLibrary(ws(inner({ displays: [{ path: ['l'], at: [1, 1] }] })));
    const c = lib.compiled('u_in')!;
    const items = faceItems([{ doc: part('i', { chip: 'u_in' }, [0, 0]), def: c.def }], () => -1);
    expect(items.map((it) => [it.path.join('.'), it.kind, it.width])).toEqual([['i.l', 'led', 4]]);
    const own = faceItems(inner().parts.map((p) => ({ doc: p, def: c.def.netlist!().instances.find((i) => i.name === p.id)!.def })), () => 0);
    expect(own.map((it) => it.kind)).toEqual(['led', 'switches']);
  });

  it('shows an LED bank live, on the chip and on the chip that places it', () => {
    const mid = chip('u_mid', 'Mid', {
      pins: [pin('v', 'in', [0, 2], 4)],
      parts: [part('i', { chip: 'u_in' }, [10, 0])],
      wires: [wire('w1', 'pin:v', 'i.v')],
      face: { displays: [{ path: ['i', 'l'], at: [0, 0], scale: 2 }] },
    });
    const w = ws(inner({ displays: [{ path: ['l'], at: [1, 1] }] }), mid);
    const es = sim(w, 'u_mid');
    es.setInput(w.chips.u_mid.pins[0], 5);
    const lib = new UserLibrary(w);
    const midDef = lib.compiled('u_mid')!.def, inDef = lib.compiled('u_in')!.def;
    const d = faceOf(midDef)!.displays[0];
    expect(d.path).toEqual(['i', 'l']);
    // the box grew to hold the doubled LED bank
    const g = symbolGeom(midDef);
    expect(g.w).toBeGreaterThanOrEqual(d.crop.w * 2);
    const root = es.sim!.design.root;
    expect(es.sim!.getBits(shownNets(root, d)!).map(Number)).toEqual([1, 0, 1, 0]);
    // the inner chip's own face, read below its node in the same simulation
    const di = faceOf(inDef)!.displays[0];
    expect(es.sim!.getBits(shownNets(root.children!.get('i'), di)!).map(Number)).toEqual([1, 0, 1, 0]);
  });

  it('flips a switch bank shown on a placed chip', () => {
    const top = chip('u_top', 'Top', {
      pins: [pin('q', 'out', [40, 2], 4)],
      parts: [part('i', { chip: 'u_in' }, [10, 0], true)],
      wires: [wire('w1', 'i.q', 'pin:q')],
    });
    const w = ws(inner({ displays: [{ path: ['sw'], at: [2, 1], scale: 1.5 }] }), top);
    const es = sim(w, 'u_top');
    const def = new UserLibrary(w).compiled('u_in')!.def;
    const d = faceOf(def)!.displays[0];
    const b = shownBox(d, symbolGeom(def).w, true);
    const [cx, cy] = switchCell(4, 0);
    const hit = faceHit(def, true, b.x + (cx + SW_PITCH / 2) * d.scale, b.y + (cy + 0.8) * d.scale)!;
    expect(hit.d.kind).toBe('switches');
    toggleSwitch(es, nodeAt(es.sim!.design.root.children!.get('i'), hit.d.path)!, 0);
    expect(es.pinBits('q')!.map(Number)).toEqual([1, 0, 0, 0]);
  });

  it('keeps the label off the displays, or leaves it off the box', () => {
    const roomy = compileLib({ ...inner(), face: { w: 14, h: 10, displays: [{ path: ['l'], at: [1, 1] }] } }).def;
    const t = boxText(roomy);
    const keep = roomy.symbol.keepOut![0];
    const lr = labelRect(t.label!);
    expect(lr.y >= keep.y + keep.h || lr.y + lr.h <= keep.y).toBe(true);
    const full = compileLib({ ...inner(), face: { displays: [{ path: ['l'], at: [0, 0], scale: 4 }] } }).def;
    expect(boxText(full).label).toBeNull();
    expect(compileLib({ ...inner(), face: { noLabel: true } }).def.symbol.label).toBe('');
  });

  it('warns about a display the chip no longer has', () => {
    const c = compileLib({ ...inner(), face: { displays: [{ path: ['gone'], at: [0, 0] }] } });
    expect(c.diags.some((d) => d.level === 'warn' && d.msg.includes("'gone'"))).toBe(true);
    expect(faceOf(c.def)).toBeNull();
  });

  it('adds a display below the others and moves / scales it on half units', () => {
    const doc = inner();
    const c = compileLib(doc);
    const items = faceItems(doc.parts.map((p) => ({ doc: p, def: c.def.netlist!().instances.find((i) => i.name === p.id)!.def })), () => -1);
    let f = toggleDisplay(undefined, resolveFace(undefined, doc.pins, doc.name, items), items[0], true)!;
    let r = resolveFace(f, doc.pins, doc.name, items);
    f = toggleDisplay(f, r, items[1], true)!;
    r = resolveFace(f, doc.pins, doc.name, items);
    expect(r.displays[1].y).toBeGreaterThanOrEqual(r.displays[0].y + r.displays[0].crop.h);
    f = placeDisplay(f, ['l'], [2.3, 0.74], 1.333);
    expect(f.displays![0]).toEqual({ path: ['l'], at: [2.5, 0.5], scale: 1.35 });
    expect(toggleDisplay(toggleDisplay(f, r, items[0], false), r, items[1], false)).toBeUndefined();
  });
});

describe('the store', () => {
  it('keeps a valid face and drops what does not belong', () => {
    const doc = sanitizeChip({
      ...inner(),
      face: {
        w: 12, h: 2.5, noLabel: true,
        pins: { v: { side: 'top', at: 3 }, q: { side: 'middle', at: 2 }, ghost: { side: 'left', at: 2 }, x: { side: 'left', at: 0 } },
        displays: [{ path: ['l'], at: [1, 1], scale: 2 }, { path: ['bad id'], at: [0, 0] }, { path: ['sw'], at: [1] }, { path: ['sw'], at: [3, 4], scale: 9 }],
      },
    })!;
    expect(doc.face).toEqual({ w: 12, noLabel: true, pins: { v: { side: 'top', at: 3 } }, displays: [{ path: ['l'], at: [1, 1], scale: 2 }, { path: ['sw'], at: [3, 4] }] });
    expect(sanitizeChip({ ...inner(), face: { pins: {}, displays: [] } })!.face).toBeUndefined();
  });
});
