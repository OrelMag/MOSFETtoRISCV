// The device puzzles on a CPU (puzzles/devcpu.ts): the ready-wired RV32I computer with each reference program passes every
// test on its gates, steps the world exactly as the reference controller does, scores the pinned point (cycles, NANDs, words),
// and is graded as the stream puzzles are; the golden model sits out on a device chip, and a device paced by en shows the
// pins of its last step.

import { describe, expect, it } from 'vitest';
import { DEVICES, playWorld } from '../src/puzzles/devices';
import { REFERENCE_CONTROLLERS } from '../src/puzzles/devrefs';
import { DEVICE_CPU_REFS, DEVICE_PROGRAMS, deviceComputerChip, deviceIo, pinFields, starterProgram } from '../src/puzzles/devcpu';
import { cpuRecordId, DEVICE_PUZZLES, deviceCpuStars, deviceTests, findDevice, playDeviceTest, runDevicePuzzle } from '../src/puzzles/devpuzzles';
import { hardwareNands, programRoms, programWords } from '../src/puzzles/run';
import { isReferenceProgram, PuzzleProgress } from '../src/puzzles/grade';
import { withProgram } from '../src/puzzles/start';
import { type DeviceState } from '../src/editor/devparts';
import { faceInput } from '../src/editor/devface';
import { simHasPuzzlePorts } from '../src/editor/puzzleparts';
import { UserLibrary } from '../src/editor/library';
import { emptyWorkspace } from '../src/editor/model';
import { EditorSim } from '../src/editor/runtime';
import { decodeShare, encodeShare } from '../src/editor/share';
import { tick } from './yieldtick';

const compile = (doc: ReturnType<typeof deviceComputerChip>) => {
  const ws = { ...emptyWorkspace(), chips: { [doc.id]: doc } };
  const c = new UserLibrary(ws).compiled(doc.id)!;
  expect(c.diags.filter((d) => d.level === 'error')).toEqual([]);
  return { ws, c };
};

describe('the device computer and its reference programs', () => {
  for (const p of DEVICE_PUZZLES) {
    it(`${p.title}: every test passes on the gates, step for step the reference controller, at the pinned point`, async () => {
      const doc = deviceComputerChip(p.dev, `u_pz_${p.id}`, p.title);
      const { ws, c } = compile(doc);
      const r = runDevicePuzzle(p, c, doc.pins);
      expect(r.problems).toEqual([]);
      expect(r.en).toBe(true);
      for (const t of r.results) expect(t.ok, `${t.name}: ${t.why}`).toBe(true);
      expect({ nands: hardwareNands(c.def), cycles: r.cycles, words: programWords(doc, ws.chips) })
        .toEqual({ nands: DEVICE_CPU_REFS[p.dev].nands, cycles: DEVICE_CPU_REFS[p.dev].cycles, words: DEVICE_CPU_REFS[p.dev].words });
      await tick();
      const es = new EditorSim({ debounceMs: 0 });
      es.setMode('cycle');
      es.update(c, doc.pins);
      const found = findDevice(es, p);
      if (Array.isArray(found)) throw new Error(found.join('; '));
      expect(found.en).toBe(true);
      // the CPU drawer's golden model sits out: it has no device
      expect(simHasPuzzlePorts(es.sim)).toBe(true);
      deviceTests(p).forEach((t, k) => {
        playDeviceTest(es, found, p, k);
        const st = es.sim!.leafState(found.li) as DeviceState;
        const want = playWorld(DEVICES[p.dev], t, REFERENCE_CONTROLLERS[p.dev]());
        expect(st.frames.map((f) => [f.drive, f.sense]), t.name).toEqual(want.frames.map((f) => [f.drive, f.sense]));
        // between two stores the pins carry the CPU's store data: the face shows the last step's
        const node = es.sim!.design.leaves[found.li].node;
        expect(faceInput(es.sim, node).drive).toEqual(st.frames.at(-1)?.drive ?? null);
      });
      expect(es.engine, 'cycle engine').toBe('cycle');
      es.destroy();
    });
  }

  it('the starter program assembles and fails cleanly (nothing driven, every test a fault or unfinished)', () => {
    const p = DEVICE_PUZZLES[0];
    const doc = deviceComputerChip(p.dev, 'u_pz_crossing', 'Start', starterProgram(p.dev));
    const { c } = compile(doc);
    const r = runDevicePuzzle(p, c, doc.pins);
    expect(r.problems).toEqual([]);
    expect(r.results.every((x) => !x.ok)).toBe(true);
    expect(r.results[0].why).toMatch(/no car lamp lit/);
  });

  it('the I/O text names every pin with its bits, in pin order', () => {
    expect(pinFields(DEVICES.vend.drive)).toBe('bit 0 vend, bits 2:1 chg');
    expect(pinFields(DEVICES.vend.sense)).toBe('bits 1:0 coin, bit 2 buy, bit 3 refund');
    expect(deviceIo('maze')).toContain('bit 0 wall_f, bit 1 wall_l, bit 2 wall_r, bit 3 goal');
  });

  it('graded as the stream puzzles: dominated ★, a trade-off ★★, cycles × NANDs below ★★★; a CPU record apart', () => {
    const p = DEVICE_PUZZLES[1], ref = DEVICE_CPU_REFS[p.dev];
    expect(deviceCpuStars(p, { cycles: ref.cycles, nands: ref.nands, words: 23 })).toBe(1);
    expect(deviceCpuStars(p, { cycles: ref.cycles - 1, nands: 2 * ref.nands, words: 23 })).toBe(2);
    expect(deviceCpuStars(p, { cycles: ref.cycles / 2, nands: ref.nands, words: 23 })).toBe(3);
    const kv = new Map<string, string>();
    const pg = new PuzzleProgress({ getItem: (k) => kv.get(k) ?? null, setItem: (k, v) => void kv.set(k, v) });
    pg.record(p.id, { cycles: 1, nands: 30, words: null }, 3);
    pg.record(cpuRecordId(p), { cycles: ref.cycles, nands: ref.nands, words: 23 }, 1);
    expect([pg.get(p.id)?.stars, pg.get(cpuRecordId(p))?.stars]).toEqual([3, 1]);
  });

  it('Do it for me on the computer: the reference program in its ROM, recognized as the reference; a share link keeps the chip', async () => {
    const p = DEVICE_PUZZLES[2];
    const doc = deviceComputerChip(p.dev, 'u_pz_vending', 'Vend', starterProgram(p.dev));
    const next = withProgram(doc, DEVICE_PROGRAMS[p.dev])!;
    expect(next.parts.length).toBe(doc.parts.length);
    const srcs = programRoms(next, {}).map((x) => (x.part.ref as { rom: { src: string } }).rom.src);
    expect(srcs.some((s) => isReferenceProgram(s, DEVICE_PROGRAMS[p.dev]))).toBe(true);
    expect(next.parts.find((q) => 'device' in q.ref)?.ref).toEqual({ device: 'vend', en: true });
    const back = await decodeShare(await encodeShare([next]));
    if ('error' in back) throw new Error(back.error);
    expect(back[0]).toEqual(next);
  });
});
