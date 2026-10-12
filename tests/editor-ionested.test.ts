// The I/O bar's nested controls (editor/ionested.ts): which switch banks and keys inside placed
// chips are listed (not the open chip's own), flipping a bank's switch on the editor's
// simulation, and holding a nested key.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { addExample, EXAMPLES } from '../src/editor/examples';
import { bankValue, controlPath, flipBank, nestedControls } from '../src/editor/ionested';
import { UserLibrary } from '../src/editor/library';
import { emptyWorkspace, type Workspace } from '../src/editor/model';
import { EditorSim } from '../src/editor/runtime';
import { chip, part, pin, wire } from './editorkit';

function sim(ws: Workspace, id: string): EditorSim {
  const lib = new UserLibrary(ws);
  const es = new EditorSim({ debounceMs: 0 });
  es.update(lib.compiled(id)!, ws.chips[id].pins);
  return es;
}

describe('nested controls on the I/O bar', () => {
  it("lists the computer's switch bank inside its devices, and flips it there", () => {
    const { ws, id } = addExample(emptyWorkspace(), EXAMPLES.find((e) => e.id === 'computer')!);
    const es = sim(ws, id);
    const cs = nestedControls(es.sim);
    expect(cs.map((c) => [c.kind, controlPath(c)])).toEqual([['switches', 'dev › sw']]);
    expect(nestedControls(es.sim)).toBe(cs); // found once per simulation
    const bank = cs[0] as Extract<typeof cs[0], { kind: 'switches' }>;
    expect(bank.width).toBe(8);
    expect(bankValue(es.sim, bank)).toBe(0);
    flipBank(es, bank, 3);
    flipBank(es, bank, 7);
    expect(bankValue(es.sim, bank)).toBe(0x88);
    // the devices' sw output follows at once (the bank is a leaf the circuit reads)
    expect(es.sim!.getBits(es.sim!.design.root.children!.get('dev')!.ports.sw).map(Number)).toEqual([0, 0, 0, 1, 0, 0, 0, 1]);
    flipBank(es, bank, 3);
    expect(bankValue(es.sim, bank)).toBe(0x80);
    // open the devices chip itself: its bank is on its canvas, not on the bar
    expect(nestedControls(sim(ws, `${id}_dev`).sim)).toEqual([]);
  });

  it('lists nested keys once per key, held through the editor', () => {
    const inner = chip('u_in', 'In', {
      pins: [pin('y', 'out', [10, 2])],
      parts: [part('k', { key: 'a' }, [0, 0]), part('k2', { key: 'a' }, [0, 6]), part('sw', { switches: 2 }, [0, 12])],
      wires: [wire('w', 'k.q', 'pin:y')],
    });
    const top = chip('u_top', 'Top', {
      pins: [pin('q', 'out', [30, 2])],
      parts: [part('i', { chip: 'u_in' }, [0, 0]), part('j', { chip: 'u_in' }, [0, 10]), part('own', { key: 'b' }, [0, 20])],
      wires: [wire('w', 'i.y', 'pin:q')],
    });
    const es = sim({ ...emptyWorkspace(), chips: { u_in: inner, u_top: top } }, 'u_top');
    const cs = nestedControls(es.sim);
    expect(cs.map((c) => [c.kind, controlPath(c)])).toEqual([['switches', 'i › sw'], ['switches', 'j › sw'], ['key', 'i › k']]);
    const key = cs[2] as Extract<typeof cs[0], { kind: 'key' }>;
    expect(key.bind).toBe('a');
    es.setKey(key.bind, true);
    expect(es.keyHeld('a')).toBe(true);
    expect(es.pinBits('q')).toEqual([1]);
    es.setKey(key.bind, false);
    expect(es.pinBits('q')).toEqual([0]);
  });
});
