import { describe, expect, it } from 'vitest';
import { compileChip } from '../src/editor/compile';
import { deriveBehavior } from '../src/editor/derive';
import type { ChipDoc } from '../src/editor/model';
import { codeGlyph, KEYBOARD, KEYBOARD_DEPTH, keyBindOf, keyCode, keyLabel, keyPart, normalizeKey, partDef } from '../src/editor/parts';
import { EditorSim } from '../src/editor/runtime';
import { loadWorkspace, saveWorkspace, type KV } from '../src/editor/store';
import { stats } from '../src/sim/stats';
import { exportHdl } from '../src/sim/svexport';
import { B0, B1, isExternal } from '../src/sim/types';
import { structuralVerilog } from '../src/sim/verilog';
import { pack } from '../src/sim/values';
import { chip, compileLib, part, pin, wire, workspace } from './editorkit';

/** A key part on an output pin, and through a NOT gate on another. */
const keyChip = (id = 'u_k'): ChipDoc => chip(id, 'K', {
  pins: [pin('q', 'out', [20, 1]), pin('y', 'out', [20, 5])],
  parts: [part('key1', { key: 'a' }, [4, 0]), part('n', { lib: 'not' }, [12, 4])],
  wires: [wire('w1', 'key1.q', 'pin:q'), wire('w2', { wire: 'w1', at: [10, 1] }, 'n.a', [[10, 5]]), wire('w3', 'n.y', 'pin:y')],
});

/** A keyboard whose ack comes from a pin; `clocked` adds a clock pin (ack is then sampled at rising edges). */
const kbdChip = (clocked: boolean): ChipDoc => chip('u_kb', 'KB', {
  pins: [
    pin('ack', 'in', [0, 2]), pin('code', 'out', [30, 1], 8), pin('ready', 'out', [30, 3]),
    ...(clocked ? [{ ...pin('clk', 'in', [0, 8]), kind: 'clock' as const }] : []),
  ],
  parts: [part('kbd1', { keyboard: true }, [10, 0])],
  wires: [wire('w1', 'pin:ack', 'kbd1.ack'), wire('w2', 'kbd1.code', 'pin:code'), wire('w3', 'kbd1.ready', 'pin:ready')],
});

const sim = (doc: ChipDoc) => {
  const es = new EditorSim({ debounceMs: 0 });
  es.update(compileLib(doc), doc.pins);
  return es;
};
const bit = (es: EditorSim, name: string) => es.pinBits(name)![0];
const word = (es: EditorSim, name: string) => pack(es.pinBits(name)!);

describe('key and keyboard parts', () => {
  it('are external sources: behaviour only, zero cost, memoized, found by id', () => {
    const k = partDef({ key: 'a' }, () => undefined);
    if ('error' in k) throw new Error(k.error);
    expect(k.id).toBe('key_61');
    expect(isExternal(k)).toBe(true);
    expect(stats(k)).toMatchObject({ nands: 0, transistors: 0 });
    expect(keyPart('a')).toBe(k);
    expect(keyBindOf(keyPart('ArrowUp'))).toBe('ArrowUp');
    expect(keyBindOf(keyPart(' '))).toBe(' ');
    expect(keyBindOf(KEYBOARD)).toBeNull();
    expect(partDef({ keyboard: true }, () => undefined)).toBe(KEYBOARD);
    expect(isExternal(KEYBOARD)).toBe(true);
    expect(stats(KEYBOARD).nands).toBe(0);
    expect(partDef({ key: '' }, () => undefined)).toMatchObject({ error: expect.stringMatching(/key/) });
  });

  it('names keys the same way from any KeyboardEvent.key, with labels and 8-bit codes', () => {
    expect(normalizeKey('A')).toBe('a');
    expect(normalizeKey('a')).toBe('a');
    expect(normalizeKey(' ')).toBe(' ');
    expect(normalizeKey('ArrowUp')).toBe('ArrowUp');
    expect(normalizeKey('Shift')).toBeNull();
    expect(normalizeKey('Escape')).toBeNull();
    expect(normalizeKey('')).toBeNull();
    expect(keyLabel(' ')).toBe('Space');
    expect(keyLabel('a')).toBe('A');
    expect(keyLabel('Enter')).toBe('⏎');
    expect(keyLabel('F5')).toBe('F5');
    expect(keyCode('a')).toBe(97);
    expect(keyCode('A')).toBe(65);
    expect(keyCode(' ')).toBe(32);
    expect(keyCode('Enter')).toBe(10);
    expect(keyCode('ArrowRight')).toBe(131);
    expect(keyCode('Shift')).toBeNull();
    expect(keyCode('é')).toBeNull();
    expect(codeGlyph(97)).toBe('a');
    expect(codeGlyph(10)).toBe('⏎');
    expect(codeGlyph(32)).toBe('␣');
    expect(codeGlyph(3)).toBe('03');
  });

  it('survive a save and the sanitizer drops malformed ones', () => {
    const doc = chip('u_s', 'S', { parts: [part('key1', { key: 'ArrowUp' }, [0, 0]), part('kbd1', { keyboard: true }, [10, 0])] });
    const m = new Map<string, string>();
    const kv: KV = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
    saveWorkspace(workspace(doc), kv);
    expect(loadWorkspace(kv).chips.u_s.parts.map((p) => p.ref)).toEqual([{ key: 'ArrowUp' }, { keyboard: true }]);
    const bad = chip('u_b', 'B', { parts: [part('p1', { key: '' } as never, [0, 0]), part('p2', { keyboard: false } as never, [0, 0]), part('p3', { key: 'x'.repeat(40) }, [0, 0])] });
    saveWorkspace(workspace(bad), kv);
    expect(loadWorkspace(kv).chips.u_b.parts).toEqual([]);
  });

  it('a key drives its net while held, at once in cycle mode and one delay at a time in gate mode', () => {
    const es = sim(keyChip());
    expect(es.keyBinds).toEqual(['a']);
    expect(es.hasKeyboard).toBe(false);
    expect(bit(es, 'q')).toBe(B0);
    expect(bit(es, 'y')).toBe(B1);
    expect(es.setKey('a', true)).toBe(true);
    expect(bit(es, 'q')).toBe(B1);
    expect(bit(es, 'y')).toBe(B0);
    expect(es.setKey('b', true)).toBe(false); // nothing listens to b
    es.setKey('a', false);
    expect(bit(es, 'q')).toBe(B0);
    es.setMode('gate');
    es.setKey('a', true);
    expect(bit(es, 'q')).toBe(B0); // the run loop propagates it
    es.stepOnce();
    expect(bit(es, 'q')).toBe(B1);
    expect(bit(es, 'y')).toBe(B1);
    es.stepOnce();
    expect(bit(es, 'y')).toBe(B0);
  });

  it('a held key stays pressed through a rebuild and a reset, and a release lets go', () => {
    const doc = keyChip();
    const es = sim(doc);
    es.setKey('a', true);
    const edited = { ...doc, parts: [...doc.parts, part('d', { display: 'led' }, [24, 4])], wires: [...doc.wires, wire('w4', { wire: 'w3', at: [17, 5] }, 'd.a')] };
    es.update(compileLib(edited), edited.pins);
    expect(bit(es, 'q')).toBe(B1);
    expect(bit(es, 'y')).toBe(B0);
    es.reset();
    expect(bit(es, 'q')).toBe(B1);
    es.releaseKeys();
    expect(bit(es, 'q')).toBe(B0);
  });

  it('listens from inside a placed chip, at any depth', () => {
    const inner = keyChip();
    const top = chip('u_t', 'T', {
      pins: [pin('q', 'out', [30, 1])],
      parts: [part('k', { chip: 'u_k' }, [10, 0])],
      wires: [wire('a', 'k.q', 'pin:q')],
    });
    const defs = new Map<string, ReturnType<typeof compileChip>>();
    const comp = (d: ChipDoc) => {
      const c = compileChip(d, (ref) => partDef(ref, (id) => defs.get(id)?.def));
      defs.set(d.id, c);
      return c;
    };
    comp(inner);
    const es = new EditorSim({ debounceMs: 0 });
    es.update(comp(top), top.pins);
    expect(es.keyBinds).toEqual(['a']);
    es.setKey('a', true);
    expect(bit(es, 'q')).toBe(B1);
  });

  it('drives a transistor circuit at switch level, which then cannot become a gate-level brick', () => {
    // a CMOS inverter: the key on both gates, PMOS to VDD, NMOS to GND
    const doc = chip('u_sw', 'SW', {
      pins: [pin('y', 'out', [30, 6])],
      parts: [part('key1', { key: ' ' }, [0, 5]), part('p', { lib: 'pmos' }, [12, 0]), part('n', { lib: 'nmos' }, [12, 8]), part('v', { lib: 'vdd' }, [12, -4]), part('g', { lib: 'gnd' }, [12, 14])],
      wires: [
        wire('w1', 'key1.q', 'p.g', [[8, 6], [8, 2]]), wire('w2', { wire: 'w1', at: [8, 6] }, 'n.g', [[8, 10]]),
        wire('w3', 'v.p', 'p.s'), wire('w4', 'p.d', 'n.d'), wire('w5', 'n.s', 'g.p'), wire('w6', { wire: 'w4', at: [14, 6] }, 'pin:y'),
      ],
    });
    const c = compileLib(doc);
    expect(c.mode).toBe('switch');
    expect(deriveBehavior(c.def)).toMatchObject({ ok: false, reason: expect.stringMatching(/key/) });
    const es = new EditorSim({ debounceMs: 0 });
    es.update(c, doc.pins);
    expect(es.keyBinds).toEqual([' ']);
    expect(bit(es, 'y')).toBe(B1);
    es.setKey(' ', true);
    expect(bit(es, 'y')).toBe(B0);
    es.setKey(' ', false);
    expect(bit(es, 'y')).toBe(B1);
  });

  it('a keyboard queues typed keys and drops the oldest when ack reads 1 at a rising edge', () => {
    const es = sim(kbdChip(true));
    expect(es.hasKeyboard).toBe(true);
    expect(es.keyBinds).toEqual([]);
    expect(word(es, 'code')).toBe(0);
    expect(bit(es, 'ready')).toBe(B0);
    es.typeKey(97);
    es.typeKey(98);
    expect(word(es, 'code')).toBe(97);
    expect(bit(es, 'ready')).toBe(B1);
    expect(es.keyboardQueue('kbd1')).toEqual([97, 98]);
    expect(es.keyboardQueue('nope')).toBeNull();
    es.stepOnce(); // ack = 0: nothing happens at the edge
    expect(es.keyboardQueue('kbd1')).toEqual([97, 98]);
    const ack = kbdChip(true).pins[0];
    es.setInput(ack, 1);
    expect(es.keyboardQueue('kbd1')).toEqual([97, 98]); // sampled at the edge, not at the level change
    es.stepOnce();
    expect(es.keyboardQueue('kbd1')).toEqual([98]);
    expect(word(es, 'code')).toBe(98);
    es.stepOnce();
    expect(es.keyboardQueue('kbd1')).toEqual([]);
    expect(word(es, 'code')).toBe(0);
    expect(bit(es, 'ready')).toBe(B0);
    es.stepOnce(); // nothing left to drop
    es.setInput(ack, 0);
    for (let i = 0; i < KEYBOARD_DEPTH + 4; i++) es.typeKey(65 + i);
    expect(es.keyboardQueue('kbd1')).toHaveLength(KEYBOARD_DEPTH);
    es.clearKeyboards();
    expect(es.keyboardQueue('kbd1')).toEqual([]);
    expect(bit(es, 'ready')).toBe(B0);
  });

  it('without a clock, ack is read as soon as the logic settles; a reset empties the queue', () => {
    const doc = kbdChip(false);
    const es = sim(doc);
    es.typeKey(65);
    expect(bit(es, 'ready')).toBe(B1);
    es.setInput(doc.pins[0], 1);
    expect(es.keyboardQueue('kbd1')).toEqual([]);
    expect(bit(es, 'ready')).toBe(B0);
    es.typeKey(66); // ack still 1: taken at once
    expect(es.keyboardQueue('kbd1')).toEqual([]);
    es.setInput(doc.pins[0], 0);
    es.typeKey(67);
    expect(word(es, 'code')).toBe(67);
    // gate mode: the drop propagates one delay at a time once the logic is quiet
    es.setMode('gate');
    es.setInput(doc.pins[0], 1);
    for (let i = 0; i < 6; i++) es.stepOnce();
    expect(es.keyboardQueue('kbd1')).toEqual([]);
    expect(word(es, 'code')).toBe(0);
    es.setMode('cycle');
    es.setInput(doc.pins[0], 0);
    es.typeKey(68);
    es.reset();
    expect(es.keyboardQueue('kbd1')).toEqual([]);
    expect(bit(es, 'ready')).toBe(B0);
  });

  it('has no module in Verilog: a comment, with the whole hierarchy still exportable', () => {
    const c = compileLib(keyChip());
    const v = structuralVerilog(c.def)!;
    expect(v).toMatch(/\/\/ key1: Key A/);
    expect(v).not.toMatch(/key_61\s+\w+\s*\(/);
    const hdl = exportHdl(c.def, 'structure');
    expect(hdl.text).not.toMatch(/module\s+key_61/);
    expect(hdl.text).toMatch(/module\s+not/);
    const kb = compileLib(kbdChip(true));
    expect(exportHdl(kb.def, 'synth').text).toMatch(/kbd1: Keyboard/);
  });
});
