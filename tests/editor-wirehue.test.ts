import { describe, expect, it } from 'vitest';
import { UserLibrary } from '../src/editor/library';
import type { ChipDoc, DefOf } from '../src/editor/model';
import { partDef } from '../src/editor/parts';
import { decodeShare, encodeShare } from '../src/editor/share';
import { sanitizeChip } from '../src/editor/store';
import { collapseWire, unravelPointer } from '../src/editor/unravel';
import { colourNets, hueOfNets, netMembers, userHues, WIRE_HUES } from '../src/editor/wirehue';
import { netlistOf } from '../src/sim/types';
import { setNetHue, USER_HUE } from '../src/view/nethue';
import { chip, compileLib, halfAdder, lbl, part, pin, wire, workspace } from './editorkit';

const defOf: DefOf = (p) => { const r = partDef(p.ref, () => undefined); return 'error' in r ? undefined : r; };
const netCount = (c: ReturnType<typeof compileLib>) => netlistOf(c.def)!.nets.length;
const hueOf = (doc: ChipDoc, wire: string) => {
  const c = compileLib(doc);
  return userHues(doc, c, netCount(c))[c.netOfWire.get(wire)!];
};

describe('net colours', () => {
  // halfAdder: net a = w1 + w2 (a branch), net b = w3 + w4, s = w5, c = w6.
  const doc = halfAdder();
  const built = compileLib(doc);

  it('colour the whole net of a wire, and only that net', () => {
    expect(netMembers(doc, built, ['w2'], []).wires).toEqual(new Set(['w1', 'w2']));
    const d = colourNets(doc, built, ['w2'], [], 150);
    expect(d.wires.filter((w) => w.hue === 150).map((w) => w.id)).toEqual(['w1', 'w2']);
    expect(d.wires.find((w) => w.id === 'w3')).toBe(doc.wires.find((w) => w.id === 'w3')); // untouched objects kept
    expect(hueOf(d, 'w1')).toBe(150);
    expect(hueOf(d, 'w5')).toBeUndefined();
    expect(hueOfNets(d, built, ['w1'], [])).toBe(150);
    expect(hueOfNets(d, built, ['w1', 'w5'], [])).toBeNull(); // mixed
    expect(colourNets(d, built, ['w1'], [], 150)).toBe(d); // nothing to change
    const cleared = colourNets(d, built, ['w1'], [], undefined);
    expect(cleared.wires.some((w) => 'hue' in w)).toBe(false);
    expect(colourNets(doc, built, ['w5'], [], 'auto').wires.find((w) => w.id === 'w5')!.hue).toBe('auto');
  });

  it('a net shows the colour most of its pieces carry; a later wire takes it', () => {
    const mixed: ChipDoc = { ...doc, wires: doc.wires.map((w) => (w.id === 'w1' ? { ...w, hue: 45 } : w.id === 'w2' ? { ...w, hue: 290 } : w)) };
    // A tie goes to the colour that sorts first, whatever the order of the wires.
    expect(hueOf(mixed, 'w1')).toBe(290);
    expect(hueOf({ ...mixed, wires: [...mixed.wires].reverse() }, 'w1')).toBe(290);
    // The larger colour group wins; an uncoloured wire on the net does not vote.
    const joined: ChipDoc = { ...mixed, pins: [...mixed.pins, pin('t', 'out', [2, -4])], wires: [...mixed.wires, wire('w7', { wire: 'w1', at: [2, 2] }, 'pin:t', [], { hue: 45 })] };
    expect(compileLib(joined).netOfWire.get('w7')).toBe(compileLib(joined).netOfWire.get('w2'));
    expect(hueOf(joined, 'w2')).toBe(45);
    const plain = colourNets(doc, built, ['w5'], [], 220);
    const grown: ChipDoc = { ...plain, pins: [...plain.pins, pin('t', 'out', [24, 3])], wires: [...plain.wires, wire('w8', { wire: 'w5', at: [16, 3] }, 'pin:t', [[16, 3]])] };
    expect(hueOf(grown, 'w8')).toBe(220);
  });

  it('never reach the compiler', () => {
    const lib = new UserLibrary(workspace(doc));
    const before = lib.compiled('u_ha');
    lib.update(workspace(colourNets(doc, built, ['w1'], [], 120)));
    expect(lib.compiled('u_ha')).toBe(before);
  });

  it('are saved, shared and sanitized', async () => {
    const d = colourNets(colourNets(doc, built, ['w1'], [], 120), built, ['w5'], [], 'auto');
    const back = await decodeShare(await encodeShare([d]));
    expect('error' in back ? back : back[0].wires.map((w) => w.hue)).toEqual(d.wires.map((w) => w.hue));
    const dirty = sanitizeChip({ ...doc, wires: doc.wires.map((w, i) => ({ ...w, hue: [370, -10, 'red', 'auto', 12.4, undefined][i] })) as never });
    expect(dirty?.wires.map((w) => w.hue)).toEqual([10, 350, undefined, 'auto', 12, undefined]);
    expect(sanitizeChip({ ...doc, labels: [{ id: 'l', name: 'n', at: [0, 0], hue: 200 }] })?.labels[0].hue).toBe(200);
  });

  it('outlive collapsing a wire into pointers and unravelling them again', () => {
    const d = colourNets(doc, built, ['w5'], [], 255);
    const c = collapseWire(d, 'w5', 'sum', defOf);
    expect(c.reason).toBeUndefined();
    expect(c.labels!.map((id) => c.doc.labels.find((l) => l.id === id)!.hue)).toEqual([255, 255]);
    expect(hueOf(c.doc, c.wires![0])).toBe(255);
    const u = unravelPointer(c.doc, 'sum', defOf);
    expect(u.reason).toBeUndefined();
    expect(u.doc.wires.filter((w) => w.hue === 255)).toHaveLength(1);
    const g = compileLib(u.doc);
    expect(userHues(u.doc, g, netCount(g))[g.netOfEnd.get('pin:s')!]).toBe(255);
  });

  it('colour a pointer’s net from the pointer', () => {
    const p = chip('u_p', 'P', {
      pins: [pin('a', 'in', [0, 2]), pin('y', 'out', [20, 2])],
      parts: [part('g', { lib: 'not' }, [8, 1])],
      labels: [lbl('l1', 'sig', [4, 2]), lbl('l2', 'sig', [6, 2], 'left')],
      wires: [wire('w1', 'pin:a', 'lbl:l1'), wire('w2', 'lbl:l2', 'g.a'), wire('w3', 'g.y', 'pin:y')],
    });
    const c = compileLib(p);
    const d = colourNets(p, c, [], ['l2'], 185);
    expect(d.labels.map((l) => l.hue)).toEqual([185, 185]);
    expect(d.wires.map((w) => w.hue)).toEqual([185, 185, undefined]);
    expect(hueOfNets(d, c, [], ['l1'])).toBe(185);
  });

  it('swatches avoid the X red and a user hue is marked on the element', () => {
    for (const { hue } of WIRE_HUES) expect(hue >= 40 && hue <= 320).toBe(true);
    const props = new Map<string, string>();
    const el = { style: { setProperty: (k: string, v: string) => void props.set(k, v), removeProperty: (k: string) => void props.delete(k) } } as unknown as SVGElement;
    setNetHue(el, USER_HUE + 80);
    expect(Object.fromEntries(props)).toEqual({ '--nh': '80', '--net-user': '1' });
    setNetHue(el, 80);
    expect(Object.fromEntries(props)).toEqual({ '--nh': '80' });
    setNetHue(el, undefined);
    expect(props.size).toBe(0);
  });
});
