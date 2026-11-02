// The RV64 core's data memory size as a property: one edit of the part's ref (rv64i_d<k>_core), wires kept, the drawer's
// monitor (detectRv64 / Rv64Monitor) following the size, and the build still lock-step with ISS64 at the smallest size.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { addExample, EXAMPLES } from '../src/editor/examples';
import { UserLibrary } from '../src/editor/library';
import { isaMismatch } from '../src/editor/lint';
import { emptyWorkspace } from '../src/editor/model';
import { partDef } from '../src/editor/parts';
import { core64Id, DMEM64_DEFAULT, DMEM64_MAX, DMEM64_MIN, detectRv64, Rv64Monitor, setCore64Memory } from '../src/editor/rv64mon';
import { EditorSim } from '../src/editor/runtime';
import { breathe } from './setup';

function open() {
  const { ws, id } = addExample(emptyWorkspace(), EXAMPLES.find((e) => e.id === 'rv64')!);
  return { ws, id, lib: new UserLibrary(ws) };
}

describe('RV64 core: data memory size', () => {
  it('names the library id the resolver reads back, at every offered size', () => {
    expect(core64Id(false, DMEM64_DEFAULT)).toBe('rv64i_core');
    expect(core64Id(true, 4)).toBe('rv64im_d4_core');
    for (let k = DMEM64_MIN; k <= DMEM64_MAX; k++) {
      const d = partDef({ lib: core64Id(true, k) }, () => undefined);
      expect(d && !('error' in d)).toBe(true);
    }
  });

  it('edits the part ref only: same part, same wires, the size read back by detectRv64 and the lint', () => {
    const { ws, id } = open();
    const doc = ws.chips[id];
    const before = detectRv64(doc)!;
    expect(before).toMatchObject({ core: 'cpu', m: true, dmemK: 6 });
    const r = setCore64Memory(doc, 'cpu', 4);
    expect(r.reason).toBeUndefined();
    expect(r.doc.parts.find((p) => p.id === 'cpu')!.ref).toEqual({ lib: 'rv64im_d4_core' });
    expect(r.doc.wires).toBe(doc.wires);
    expect(r.doc.parts.filter((p) => p.id !== 'cpu')).toEqual(doc.parts.filter((p) => p.id !== 'cpu'));
    expect(detectRv64(r.doc)).toMatchObject({ core: 'cpu', m: true, dmemK: 4 });
    expect(isaMismatch(r.doc)).toEqual(isaMismatch(doc)); // _d<k> still reads as a 64-bit core
    // back to the default drops the suffix
    expect(setCore64Memory(r.doc, 'cpu', DMEM64_DEFAULT).doc.parts.find((p) => p.id === 'cpu')!.ref).toEqual({ lib: 'rv64im_core' });
  });

  it('refuses sizes outside the range and parts that are not 64-bit cores, leaving the document alone', () => {
    const { ws, id } = open();
    const doc = ws.chips[id];
    expect(setCore64Memory(doc, 'cpu', DMEM64_MAX + 1)).toMatchObject({ doc, reason: expect.stringMatching(/2\^4 to 2\^8/) });
    expect(setCore64Memory(doc, 'cpu', 2.5).doc).toBe(doc);
    expect(setCore64Memory(doc, 'imem', 5)).toMatchObject({ doc, reason: expect.stringMatching(/not a 64-bit core/) });
  });

  it('runs in lock step with ISS64 on the smallest memory, the monitor sized to it', async () => {
    const { ws, id } = open();
    ws.chips[id] = setCore64Memory(ws.chips[id], 'cpu', 4).doc;
    const lib = new UserLibrary(ws);
    const es = new EditorSim({ debounceMs: 0 });
    es.update(lib.compiled(id)!, ws.chips[id].pins);
    const mon = new Rv64Monitor(es, () => ws.chips[id]);
    expect(mon.problem).toBe(null);
    while (es.cycles < 4000 && !es.halted) {
      es.runCycles(Math.min(500, 4000 - es.cycles), () => es.halted, 1e9);
      await breathe();
    }
    expect(es.halted).toBe(true);
    expect(mon.mismatch).toBeNull();
    expect(mon.read()!.dmem.length).toBe(2 ** 4);
    expect(mon.read()!.dmem[1]).toBe(2880067194370816120n);
  });
});
