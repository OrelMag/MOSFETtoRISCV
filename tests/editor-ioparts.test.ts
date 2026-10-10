// The console, switch bank and pixel screen parts (editor/ioparts.ts): definitions, semantics on
// the editor's simulation (cycle and gate mode, at depth), state through rebuilds, Back and Reset,
// colour decoding, documents (sanitizer, share links), Verilog and cost.

import { describe, expect, it } from 'vitest';
import { compileChip } from '../src/editor/compile';
import { deriveBehavior } from '../src/editor/derive';
import { consoleChip, screenChip } from '../src/editor/examples';
import {
  clearedState, COLOR_BITS, COLOR_FORMATS, colorRgb, consoleAppend, consoleInit, consolePart, consoleRows, consoleText, type ConsoleState,
  flipSwitch, IO_MAX_BITS, ioNodes, ioState, MONO_ON, PAL16, paintScreen, pixelsOf, PX_OFF, PX_X, screenPart, screenProblem, type ScreenRef,
  type ScreenState, switchAt, switchBank, switchCell, type SwitchState,
} from '../src/editor/ioparts';
import { type ChipDoc, type PartRef, polyline } from '../src/editor/model';
import { lintChip } from '../src/editor/lint';
import { MAX_WIDTH, partDef } from '../src/editor/parts';
import { EditorSim } from '../src/editor/runtime';
import { decodeShare, encodeShare } from '../src/editor/share';
import { loadWorkspace, saveWorkspace, type KV } from '../src/editor/store';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { stats } from '../src/sim/stats';
import { exportHdl } from '../src/sim/svexport';
import { B0, B1, BX, type Bit, isExternal } from '../src/sim/types';
import { pack } from '../src/sim/values';
import { structuralVerilog } from '../src/sim/verilog';
import { chip, compileLib, part, pin, wire, workspace } from './editorkit';

const clock = (id: string, at: [number, number]) => ({ ...pin(id, 'in', at), kind: 'clock' as const });
const def = (ref: PartRef) => {
  const d = partDef(ref, () => undefined);
  if ('error' in d) throw new Error(d.error);
  return d;
};
const sim = (doc: ChipDoc) => {
  const es = new EditorSim({ debounceMs: 0 });
  es.update(compileLib(doc), doc.pins);
  return es;
};
const pinOf = (doc: ChipDoc, name: string) => doc.pins.find((p) => p.name === name)!;
const stateOf = <T>(es: EditorSim, path: string[]): T => {
  const io = ioNodes(es.sim!.design.root).find((n) => n.path.join('.') === path.join('.'))!;
  return ioState(es.sim!, io.node) as T;
};

/** A console fed by pins data / we, clocked by clk. */
const conChip = (id = 'u_con'): ChipDoc => chip(id, 'Con', {
  pins: [pin('data', 'in', [0, 2], 8), pin('we', 'in', [0, 4]), clock('clk', [0, 14])],
  parts: [part('con1', { console: { cols: 16, rows: 4 } }, [6, 0])],
  wires: [wire('w1', 'pin:data', 'con1.data'), wire('w2', 'pin:we', 'con1.we'), wire('w3', 'pin:clk', 'con1.clk')],
});
const text = (es: EditorSim, path = ['con1']) => consoleText(stateOf<ConsoleState>(es, path));
const type = (es: EditorSim, doc: ChipDoc, s: string) => {
  es.setInput(pinOf(doc, 'we'), 1);
  for (const ch of s) {
    es.setInput(pinOf(doc, 'data'), ch.charCodeAt(0));
    es.stepOnce();
  }
  es.setInput(pinOf(doc, 'we'), 0);
};

describe('console part', () => {
  it('is a zero-cost external sink, one id for every size, a comment in Verilog', () => {
    const d = def({ console: { cols: 32, rows: 8 } });
    expect(isExternal(d)).toBe(true);
    expect(stats(d)).toMatchObject({ nands: 0, transistors: 0 });
    expect(d.ports.map((p) => p.name)).toEqual(['data', 'we', 'clk']);
    expect(consolePart(32, 8)).toBe(d);
    expect(consolePart(40, 10).id).toBe(d.id);
    expect(partDef({ console: { cols: 2, rows: 8 } }, () => undefined)).toMatchObject({ error: expect.stringMatching(/console/) });
    const v = structuralVerilog(compileLib(conChip()).def)!;
    expect(v).toMatch(/\/\/ con1: Console/);
    expect(exportHdl(compileLib(conChip()).def, 'synth').text).toMatch(/con1: Console/);
  });

  it('prints on rising clk edges with we = 1 only', () => {
    const doc = conChip();
    const es = sim(doc);
    expect(text(es)).toBe('');
    es.setInput(pinOf(doc, 'data'), 65);
    es.stepOnce(); // we = 0
    expect(text(es)).toBe('');
    es.setInput(pinOf(doc, 'we'), 1);
    expect(text(es)).toBe(''); // a level, not an edge
    es.stepOnce();
    expect(text(es)).toBe('A');
    type(es, doc, 'BC\nD');
    expect(text(es)).toBe('ABC\nD');
    // gate mode: the edge reaches the console one delay after the clock pin
    es.setMode('gate');
    es.setInput(pinOf(doc, 'we'), 1);
    es.setInput(pinOf(doc, 'data'), 69);
    for (let i = 0; i < 6; i++) es.stepOnce();
    expect(text(es)).toBe('ABC\nDE');
  });

  it('handles backspace, form feed, tabs, CR and non-printing codes', () => {
    const st = consoleInit();
    for (const c of 'ab\bc\r\n\tx') consoleAppend(st, c.charCodeAt(0));
    expect(consoleText(st)).toBe('ac\n        x');
    consoleAppend(st, 1);
    consoleAppend(st, 127);
    consoleAppend(st, 200);
    consoleAppend(st, -1);
    expect(consoleText(st).slice(-4)).toBe('␁␡·▒');
    consoleAppend(st, 12);
    expect(consoleText(st)).toBe('');
    expect(st.n).toBe(13);
    for (let i = 0; i < 600; i++) consoleAppend(st, 10);
    expect(st.lines).toHaveLength(500);
  });

  it('wraps at the width and shows the last rows', () => {
    const st = consoleInit();
    for (const c of 'abcdefghij\nxy\n\nlast') consoleAppend(st, c.charCodeAt(0));
    expect(consoleRows(st, 4, 10)).toEqual(['abcd', 'efgh', 'ij', 'xy', '', 'last']);
    expect(consoleRows(st, 4, 3)).toEqual(['xy', '', 'last']);
    expect(consoleRows(st, 4, 5)).toEqual(['efgh', 'ij', 'xy', '', 'last']);
  });

  it('keeps its text through a rebuild, a resize and Back; Reset clears it', () => {
    const doc = conChip();
    const es = sim(doc);
    type(es, doc, 'hi');
    // an unrelated edit, then a resize: the same id, so the text carries over
    const edited = { ...doc, parts: [...doc.parts, part('d', { display: 'led' }, [30, 0])] };
    es.update(compileLib(edited), edited.pins);
    expect(text(es)).toBe('hi');
    const resized = { ...edited, parts: edited.parts.map((p) => (p.id === 'con1' ? { ...p, ref: { console: { cols: 40, rows: 10 } } } : p)) };
    es.update(compileLib(resized), resized.pins);
    expect(text(es)).toBe('hi');
    type(es, resized, '!');
    expect(text(es)).toBe('hi!');
    // Back: a saved state of the same simulation comes back exactly (a fresh one, not the old)
    const es2 = sim(doc);
    type(es2, doc, 'ab');
    const s2 = es2.sim!.saveState();
    type(es2, doc, 'cd');
    es2.sim!.restoreState(s2);
    expect(text(es2)).toBe('ab');
    type(es2, doc, 'X');
    es2.sim!.restoreState(s2);
    expect(text(es2)).toBe('ab');
    es.reset();
    expect(text(es)).toBe('');
  });

  it('clears from outside, keeping the clock it saw', () => {
    const doc = conChip();
    const es = sim(doc);
    type(es, doc, 'abc');
    const io = ioNodes(es.sim!.design.root)[0];
    es.pokeLeaf(io.node.leafIndex!, clearedState(io.info, ioState(es.sim!, io.node)));
    expect(text(es)).toBe('');
    type(es, doc, 'z');
    expect(text(es)).toBe('z');
  });

  it('works inside a placed chip, and refuses a gate-level derivation', () => {
    const inner = conChip('u_in');
    const top = chip('u_top', 'Top', {
      pins: [pin('data', 'in', [0, 2], 8), pin('we', 'in', [0, 4]), clock('clk', [0, 14])],
      parts: [part('c', { chip: 'u_in' }, [10, 0])],
      wires: [wire('a', 'pin:data', 'c.data'), wire('b', 'pin:we', 'c.we'), wire('k', 'pin:clk', 'c.clk')],
    });
    const defs = new Map<string, ReturnType<typeof compileChip>>();
    const comp = (d: ChipDoc) => { const c = compileChip(d, (ref) => partDef(ref, (id) => defs.get(id)?.def)); defs.set(d.id, c); return c; };
    comp(inner);
    const es = new EditorSim({ debounceMs: 0 });
    es.update(comp(top), top.pins);
    type(es, top, 'deep');
    expect(ioNodes(es.sim!.design.root).map((n) => n.path.join('.'))).toEqual(['c.con1']);
    expect(text(es, ['c', 'con1'])).toBe('deep');
    expect(deriveBehavior(compileLib(inner).def)).toMatchObject({ ok: false });
  });
});

/** A switch bank on an output pin. */
const swChip = (w: number, id = 'u_sw'): ChipDoc => chip(id, 'Sw', {
  pins: [pin('q', 'out', [20, 1], w)],
  parts: [part('sw1', { switches: w }, [4, 0])],
  wires: [wire('w1', 'sw1.q', 'pin:q')],
});
const flip = (es: EditorSim, bit: number, path = ['sw1']) => {
  const io = ioNodes(es.sim!.design.root).find((n) => n.path.join('.') === path.join('.'))!;
  const s = ioState(es.sim!, io.node) as SwitchState;
  es.pokeLeaf(io.node.leafIndex!, { v: flipSwitch(s.v, bit) });
};

describe('switch bank part', () => {
  it('is an external source with geometry for its switches', () => {
    const d = def({ switches: 8 });
    expect(isExternal(d)).toBe(true);
    expect(switchBank(8)).toBe(d);
    expect(stats(d).nands).toBe(0);
    expect(partDef({ switches: 33 }, () => undefined)).toMatchObject({ error: expect.stringMatching(/switch/) });
    for (const w of [1, 5, 8, 12, 32]) {
      for (let b = 0; b < w; b++) {
        const [x, y] = switchCell(w, b);
        expect(switchAt(w, x + 0.7, y + 1)).toBe(b);
      }
    }
    expect(switchAt(8, -1, 1)).toBeNull();
    expect(flipSwitch(0, 31)).toBe(2 ** 31);
    expect(flipSwitch(2 ** 32 - 1, 31)).toBe(2 ** 31 - 1);
  });

  it('drives its output, keeps positions through a rebuild and a reset, and Back restores them', () => {
    const doc = swChip(8);
    const es = sim(doc);
    expect(pack(es.pinBits('q')!)).toBe(0);
    flip(es, 0);
    flip(es, 7);
    expect(pack(es.pinBits('q')!)).toBe(0x81);
    const edited = { ...doc, parts: [...doc.parts, part('d', { display: 'led' }, [30, 0])] };
    es.update(compileLib(edited), edited.pins);
    expect(pack(es.pinBits('q')!)).toBe(0x81);
    es.reset();
    expect(pack(es.pinBits('q')!)).toBe(0x81);
    const es2 = sim(doc);
    flip(es2, 3);
    const s = es2.sim!.saveState();
    flip(es2, 4);
    es2.sim!.restoreState(s);
    es2.sim!.settle();
    expect(pack(es2.pinBits('q')!)).toBe(8);
    // a fresh simulation (a check) reads them all off
    const g = new GateSim(flatten(compileLib(doc).def));
    g.reset('zero');
    g.settle();
    expect(pack(g.getBits(g.design.root.ports.q))).toBe(0);
  });

  it('is 32 bits exact and propagates one delay at a time in gate mode', () => {
    const es = sim(swChip(32));
    flip(es, 31);
    flip(es, 0);
    expect(pack(es.pinBits('q')!)).toBe(2 ** 31 + 1);
    es.setMode('gate');
    flip(es, 1);
    expect(pack(es.pinBits('q')!)).toBe(2 ** 31 + 1);
    es.stepOnce();
    expect(pack(es.pinBits('q')!)).toBe(2 ** 31 + 3);
  });

  it('works inside a placed chip', () => {
    const inner = swChip(4, 'u_in');
    const top = chip('u_top', 'Top', { pins: [pin('q', 'out', [30, 1], 4)], parts: [part('c', { chip: 'u_in' }, [10, 0])], wires: [wire('a', 'c.q', 'pin:q')] });
    const defs = new Map<string, ReturnType<typeof compileChip>>();
    const comp = (d: ChipDoc) => { const c = compileChip(d, (ref) => partDef(ref, (id) => defs.get(id)?.def)); defs.set(d.id, c); return c; };
    comp(inner);
    const es = new EditorSim({ debounceMs: 0 });
    es.update(comp(top), top.pins);
    flip(es, 2, ['c', 'sw1']);
    expect(pack(es.pinBits('q')!)).toBe(4);
    es.reset();
    expect(pack(es.pinBits('q')!)).toBe(4);
  });
});

// ---- the screen -------------------------------------------------------------------------------

const scr = (r: Partial<ScreenRef>): ScreenRef => ({ mode: 'write', size: 8, color: 'mono', ...r });

/** A write-mode screen on pins x, y, color, we, clk (and vsync out). */
const writeChip = (r: Partial<ScreenRef> = {}): ChipDoc => {
  const s = scr(r), lg = Math.log2(s.size), c = COLOR_BITS[s.color];
  return chip('u_w', 'W', {
    pins: [pin('x', 'in', [0, 2], lg), pin('y', 'in', [0, 4], lg), pin('color', 'in', [0, 6], c), pin('we', 'in', [0, 8]), clock('clk', [0, 30]),
      ...(s.vsync ? [pin('vsync', 'out', [60, 2])] : [])],
    parts: [part('s1', { screen: s }, [6, 0])],
    wires: [wire('a', 'pin:x', 's1.x'), wire('b', 'pin:y', 's1.y'), wire('c', 'pin:color', 's1.color'), wire('d', 'pin:we', 's1.we'), wire('e', 'pin:clk', 's1.clk'),
      ...(s.vsync ? [wire('f', 's1.vsync', 'pin:vsync')] : [])],
  });
};
const picture = (es: EditorSim, path = ['s1']) => stateOf<ScreenState>(es, path);

describe('pixel screen part', () => {
  it('validates its settings and costs nothing in every mode', () => {
    expect(IO_MAX_BITS).toBe(MAX_WIDTH);
    expect(screenProblem(scr({ size: 12 }))).toMatch(/size/);
    expect(screenProblem(scr({ mode: 'pixels', size: 32 }))).toBeNull();
    expect(screenProblem(scr({ mode: 'pixels', size: 64 }))).toMatch(/4096-bit/);
    expect(screenProblem(scr({ mode: 'pixels', size: 16, color: 'pal16' }))).toBeNull();
    expect(screenProblem(scr({ mode: 'pixels', size: 16, color: 'rgb332' }))).toMatch(/2048/);
    expect(screenProblem(scr({ mode: 'rows', size: 64, color: 'rgb565' }))).toBeNull();
    expect(screenProblem(scr({ mode: 'rows', size: 128, color: 'rgb565' }))).toMatch(/2048 bits/);
    expect(screenProblem(scr({ mode: 'pixels', vsync: 4 }))).toMatch(/vsync/);
    expect(screenProblem(scr({ size: 128, color: 'rgb565', vsync: 60 }))).toBeNull();
    for (const mode of ['write', 'rows', 'pixels'] as const) {
      const d = def({ screen: scr({ mode, size: 16, color: 'rgb111' }) });
      expect(stats(d)).toMatchObject({ nands: 0, transistors: 0 });
      expect(screenPart(scr({ mode, size: 16, color: 'rgb111' }))).toBe(d);
    }
    // the scale and the look are not part of the id: changing them keeps the picture
    expect(def({ screen: scr({ scale: 4, look: 'dots' }) }).id).toBe(def({ screen: scr({}) }).id);
    expect(def({ screen: scr({ scale: 4 }) })).not.toBe(def({ screen: scr({}) }));
    expect(def({ screen: scr({ scale: 4 }) }).symbol.w).toBeGreaterThan(def({ screen: scr({}) }).symbol.w!);
  });

  it('decodes every colour format', () => {
    expect(colorRgb('mono', 0)).toBe(PX_OFF);
    expect(colorRgb('mono', 1)).toBe(MONO_ON);
    expect(colorRgb('rgb111', 0b100)).toBe(0xff0000);
    expect(colorRgb('rgb111', 0b011)).toBe(0x00ffff);
    expect(colorRgb('rgb111', 7)).toBe(0xffffff);
    PAL16.forEach((c, i) => expect(colorRgb('pal16', i)).toBe(c));
    expect(colorRgb('pal16', 14)).toBe(0xffff55);
    expect(colorRgb('rgb332', 0xe0)).toBe(0xff0000);
    expect(colorRgb('rgb332', 0x1c)).toBe(0x00ff00);
    expect(colorRgb('rgb332', 0x03)).toBe(0x0000ff);
    expect(colorRgb('rgb332', 0xff)).toBe(0xffffff);
    expect(colorRgb('rgb332', 0x92)).toBe(0x9292aa);
    expect(colorRgb('rgb565', 0xf800)).toBe(0xff0000);
    expect(colorRgb('rgb565', 0x07e0)).toBe(0x00ff00);
    expect(colorRgb('rgb565', 0x001f)).toBe(0x0000ff);
    expect(colorRgb('rgb565', 0xffff)).toBe(0xffffff);
    for (const f of COLOR_FORMATS) expect(colorRgb(f, -1)).toBe(PX_X);
  });

  it('write mode: a pixel takes color at a rising edge with we = 1; X is ignored and counted', () => {
    const doc = writeChip({ color: 'rgb332' });
    const es = sim(doc);
    const set = (name: string, v: number) => es.setInput(pinOf(doc, name), v);
    set('x', 3); set('y', 5); set('color', 0xe0);
    es.stepOnce();
    expect(picture(es).writes).toBe(0);
    set('we', 1);
    es.stepOnce();
    expect(picture(es).px[5 * 8 + 3]).toBe(0xe0);
    expect(picture(es).writes).toBe(1);
    set('x', 7); set('y', 0); set('color', 0x1c);
    es.stepOnce();
    expect(picture(es).px[7]).toBe(0x1c);
    expect(picture(es).edges).toBe(3);
    // an unknown colour is stored as unknown; an unknown address writes nothing
    es.sim!.setInputBits('color', [BX, 0, 0, 0, 0, 0, 0, 0]);
    es.stepOnce();
    expect(picture(es).px[7]).toBe(-1);
    set('color', 1);
    es.sim!.setInputBits('x', [BX, 0, 0]);
    const before = picture(es).writes;
    es.stepOnce();
    expect(picture(es).writes).toBe(before);
    expect(picture(es).warns).toBe(1);
  });

  it('write mode keeps its picture through a rebuild, a rescale and Back; Reset clears it', () => {
    const doc = writeChip();
    const es = sim(doc);
    es.setInput(pinOf(doc, 'we'), 1);
    es.setInput(pinOf(doc, 'color'), 1);
    es.setInput(pinOf(doc, 'x'), 2);
    es.stepOnce();
    const s = es.sim!.saveState();
    es.setInput(pinOf(doc, 'x'), 4);
    es.stepOnce();
    expect([picture(es).px[2], picture(es).px[4]]).toEqual([1, 1]);
    es.sim!.restoreState(s);
    expect([picture(es).px[2], picture(es).px[4]]).toEqual([1, 0]);
    const rescaled = { ...doc, parts: doc.parts.map((p) => ({ ...p, ref: { screen: scr({ scale: 4, look: 'dots' }) } })) };
    es.update(compileLib(rescaled), rescaled.pins);
    expect(picture(es).px[2]).toBe(1);
    es.reset();
    expect(picture(es).px[2]).toBe(0);
    expect(picture(es).writes).toBe(0);
  });

  it('vsync is high for one cycle every N rising edges, frames counted', () => {
    const doc = writeChip({ vsync: 3 });
    const es = sim(doc);
    const seen: number[] = [];
    for (let i = 0; i < 9; i++) {
      es.stepOnce();
      seen.push(es.pinBits('vsync')![0]);
    }
    expect(seen).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    expect(picture(es).frames).toBe(3);
  });

  it('rows mode: a row takes data (leftmost pixel in the top bits) at a rising edge with load = 1, through a 128-bit bus', () => {
    const r = scr({ mode: 'rows', size: 64, color: 'rgb111' }); // 192-bit rows: cut into 30-bit chunks
    const doc = chip('u_r', 'R', {
      pins: [pin('row', 'in', [0, 2], 6), pin('data', 'in', [0, 4], 192), pin('load', 'in', [0, 6]), clock('clk', [0, 40])],
      parts: [part('s1', { screen: r }, [6, 0])],
      wires: [wire('a', 'pin:row', 's1.row'), wire('b', 'pin:data', 's1.data'), wire('c', 'pin:load', 's1.load'), wire('d', 'pin:clk', 's1.clk')],
    });
    const es = sim(doc);
    // pixel x = field 63 − x: x = 0 white (field 63, the top 3 bits), x = 1 red, x = 63 blue
    const bits: Bit[] = new Array(192).fill(B0);
    const field = (f: number, v: number) => { for (let b = 0; b < 3; b++) bits[f * 3 + b] = ((v >> b) & 1) as Bit; };
    field(63, 7); field(62, 4); field(0, 1); field(40, 2);
    es.sim!.setInputBits('data', bits);
    es.setInput(pinOf(doc, 'row'), 9);
    es.stepOnce();
    expect(picture(es).writes).toBe(0);
    es.setInput(pinOf(doc, 'load'), 1);
    es.stepOnce();
    const px = picture(es).px;
    expect([px[9 * 64], px[9 * 64 + 1], px[9 * 64 + 63], px[9 * 64 + 23], px[9 * 64 + 2]]).toEqual([7, 4, 1, 2, 0]);
    // an X in a chunk makes its pixels unknown
    bits[100] = BX;
    es.sim!.setInputBits('data', bits);
    es.setInput(pinOf(doc, 'row'), 1);
    es.stepOnce();
    const p1 = picture(es).px.slice(64, 128);
    const chunk = Math.floor(Math.floor(100 / 3) / 10); // fields 30–39
    for (let f = 0; f < 64; f++) expect(p1[63 - f] === -1).toBe(Math.floor(f / 10) === chunk);
    expect(isExternal(def({ screen: r }))).toBe(false); // a splitter around the leaf that holds the picture
    expect(deriveBehavior(compileLib(doc).def)).toMatchObject({ ok: false });
  });

  it('pixels mode shows the bus: the top-left pixel in the top field', () => {
    const r = scr({ mode: 'pixels', size: 8, color: 'mono' });
    const d = def({ screen: r });
    expect(d.prim).toBe('alias');
    const bits: Bit[] = new Array(64).fill(B0);
    bits[63] = B1; // (0, 0)
    bits[0] = B1; // (7, 7)
    bits[63 - 10] = BX; // (2, 1)
    const px = pixelsOf(bits, 8, 'mono');
    expect([px[0], px[63], px[10], px[1]]).toEqual([1, 1, -1, 0]);
    const p4 = pixelsOf([B1, B0, B1, B0, ...new Array(60).fill(B0)], 4, 'pal16');
    expect(p4[15]).toBe(5);
  });

  it('paints pixels, the off colour, dots, grid lines and unknown pixels', () => {
    const th = { off: 0x101010, gap: 0x000000, x: 0xff0000 };
    const out = new Uint32Array(4);
    paintScreen(out, [1, 0, -1, 0], 2, 'mono', 1, undefined, false, th);
    const rgb = (u: number) => [u & 0xff, (u >> 8) & 0xff, (u >> 16) & 0xff];
    expect(rgb(out[0])).toEqual([0x3d, 0xdc, 0x84]);
    expect(rgb(out[1])).toEqual([0x10, 0x10, 0x10]);
    expect(rgb(out[2])).toEqual([0xff, 0, 0]); // (0, 1) unknown, k = 1: a checkerboard of the X colour
    const big = new Uint32Array(8 * 8);
    paintScreen(big, [1], 1, 'mono', 8, 'dots', false, th);
    expect(rgb(big[0])).toEqual([0, 0, 0]); // a corner is outside the dot
    expect(rgb(big[4 * 8 + 4])).toEqual([0x3d, 0xdc, 0x84]);
    paintScreen(big, [-1], 1, 'mono', 8, undefined, false, th);
    expect(rgb(big[0])).toEqual([0xff, 0, 0]); // an X across the cell
    expect(rgb(big[1])).toEqual([0, 0, 0]);
    paintScreen(big, [1], 1, 'mono', 8, undefined, true, th);
    expect(rgb(big[7])).toEqual([0, 0, 0]); // the grid line
    expect(rgb(big[0])).toEqual([0x3d, 0xdc, 0x84]);
  });

  it('works at depth and is a comment in Verilog', () => {
    const inner = { ...writeChip(), id: 'u_in' };
    const top = chip('u_top', 'Top', {
      pins: inner.pins,
      parts: [part('c', { chip: 'u_in' }, [10, 0])],
      wires: ['x', 'y', 'color', 'we', 'clk'].map((n) => wire(n, `pin:${n}`, `c.${n}`)),
    });
    const defs = new Map<string, ReturnType<typeof compileChip>>();
    const comp = (d: ChipDoc) => { const c = compileChip(d, (ref) => partDef(ref, (id) => defs.get(id)?.def)); defs.set(d.id, c); return c; };
    comp(inner);
    const es = new EditorSim({ debounceMs: 0 });
    es.update(comp(top), top.pins);
    es.setInput(pinOf(top, 'we'), 1);
    es.setInput(pinOf(top, 'color'), 1);
    es.setInput(pinOf(top, 'x'), 6);
    es.stepOnce();
    expect(picture(es, ['c', 's1']).px[6]).toBe(1);
    expect(structuralVerilog(compileLib(writeChip()).def)).toMatch(/\/\/ s1: Screen 8×8/);
  });
});

describe('I/O part documents', () => {
  const refs: PartRef[] = [
    { console: { cols: 32, rows: 8 } }, { switches: 12 },
    { screen: { mode: 'write', size: 64, color: 'rgb332', scale: 2, vsync: 100 } },
    { screen: { mode: 'rows', size: 16, color: 'mono', look: 'dots', grid: true, scale: 1 } },
    { screen: { mode: 'pixels', size: 8, color: 'rgb111' } },
  ];
  const doc = chip('u_io', 'IO', { parts: refs.map((r, i) => part(`p${i}`, r, [0, 20 * i])) });

  it('survive a save; the sanitizer drops broken ones', () => {
    const m = new Map<string, string>();
    const kv: KV = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
    saveWorkspace(workspace(doc), kv);
    expect(loadWorkspace(kv).chips.u_io.parts.map((p) => p.ref)).toEqual(refs);
    const bad = chip('u_b', 'B', {
      parts: [
        part('a', { console: { cols: 200, rows: 8 } }, [0, 0]), part('b', { switches: 0 }, [0, 0]), part('c', { switches: 40 }, [0, 0]),
        part('d', { screen: { mode: 'pixels', size: 128, color: 'mono' } }, [0, 0]), part('e', { screen: { mode: 'tv', size: 8, color: 'mono' } } as never, [0, 0]),
        part('f', { screen: null } as never, [0, 0]),
      ],
    });
    saveWorkspace(workspace(bad), kv);
    expect(loadWorkspace(kv).chips.u_b.parts).toEqual([]);
    // unknown extra fields go
    const extra = chip('u_e', 'E', { parts: [part('s', { screen: { mode: 'write', size: 8, color: 'mono', junk: 1, look: 'blobs' } } as never, [0, 0])] });
    saveWorkspace(workspace(extra), kv);
    expect(loadWorkspace(kv).chips.u_e.parts[0].ref).toEqual({ screen: { mode: 'write', size: 8, color: 'mono' } });
  });

  it('survive a share link', async () => {
    const back = await decodeShare(await encodeShare([doc]));
    if ('error' in back) throw new Error(back.error);
    expect(back[0].parts.map((p) => p.ref)).toEqual(refs);
  });
});

describe('I/O examples', () => {
  it('the console example types its message, a character per edge', () => {
    const doc = consoleChip('u_c', 'C');
    const es = sim(doc);
    es.runCycles(20);
    expect(text(es, ['con'])).toBe('Hello, sandbox!\nHell');
  });

  it('the screen example paints in the switches\' colour', () => {
    const doc = screenChip('u_s', 'S');
    const es = sim(doc);
    flip(es, 2, ['colour']);
    flip(es, 0, ['colour']); // colour 5: magenta
    es.runCycles(256);
    const px = picture(es, ['scr']).px;
    expect([...px].every((v) => v === 5)).toBe(true);
    expect(picture(es, ['scr']).writes).toBe(256);
  });
});

describe('I/O examples are drawn cleanly', () => {
  const defOf = (p: { ref: PartRef }) => { const d = partDef(p.ref, () => undefined); return 'error' in d ? undefined : d; };
  it.each([['console', consoleChip], ['screen', screenChip]] as const)('%s: no lint warnings', (_n, build) => {
    const doc = build('u_x', 'X');
    const polys = new Map(doc.wires.flatMap((w) => { const p = polyline(doc, w, defOf); return p ? [[w.id, p] as const] : []; }));
    expect(lintChip(doc, compileLib(doc), polys).diags).toEqual([]);
  });
});
