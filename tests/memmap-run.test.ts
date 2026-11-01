import { describe, expect, it } from 'vitest';
import '../src/lib';
import { BusModel } from '../src/bus/model';
import { SANDBOX_SOURCE } from '../src/bus/programs';
import { addExample, EXAMPLES } from '../src/editor/examples';
import { consoleText, type ConsoleState, ioNodes, ioState, type ScreenState } from '../src/editor/ioparts';
import { UserLibrary } from '../src/editor/library';
import { applyMap, busMapOf, moveTo, readMap } from '../src/editor/memmap';
import { emptyWorkspace } from '../src/editor/model';
import { EditorSim } from '../src/editor/runtime';
import { assemble } from '../src/riscv/asm';
import { ISS } from '../src/riscv/iss';
import { breathe } from './setup';

// Examples ▸ System on a bus with the screen moved from window 5 to window 7 by the memory-map designer (and the
// program told: its screen base changes), run at gate / cycle level in the sandbox and on the golden model with
// the same map (BusModel's `map`): the console, and every pixel, agree. The old window answers nothing.

const EX = EXAMPLES.find((e) => e.id === 'bussystem')!;
const words = (src: string) => { const a = assemble(src); if (a.errors.length) throw new Error(a.errors[0].message); return a.words; };

describe('System on a bus with a moved region', () => {
  it('the chip and the golden model agree on the console and the screen', async () => {
    const { ws, id } = addExample(emptyWorkspace(), EX);
    const m0 = readMap(ws.chips[id]);
    if ('error' in m0) throw new Error(m0.error);
    const map = moveTo(m0, 4, 7);
    expect(map.regions[4].kind).toBe('screen');
    let doc = applyMap(ws.chips[id], map);
    const src = SANDBOX_SOURCE.replace('0x50000000', '0x70000000');
    expect(src).not.toBe(SANDBOX_SOURCE);
    doc = { ...doc, parts: doc.parts.map((p) => (p.id === 'from' && 'rom' in p.ref ? { ...p, ref: { rom: { ...p.ref.rom, src } } } : p)) };
    const lib = new UserLibrary({ ...ws, chips: { ...ws.chips, [id]: doc } });
    const def = lib.compiled(id)!;
    const es = new EditorSim({ debounceMs: 0 });
    es.update(def, doc.pins);
    const con = () => consoleText(ioState(es.sim!, ioNodes(es.sim!.design.root).find((x) => x.info.kind === 'console')!.node) as ConsoleState);
    const run = async (cycles: number, stop = () => false) => {
      const end = es.cycles + cycles;
      while (es.cycles < end && !stop()) { es.runCycles(Math.min(2000, end - es.cycles), stop, 1e9); await breathe(); }
    };
    await run(3000, () => con().includes('>'));
    expect(con()).toBe('>');
    for (const c of 'hi\n') es.typeKey(c.charCodeAt(0));
    await run(8000, () => con().endsWith('ih\n>'));
    expect(con()).toBe('>hi\nih\n>');
    const px = (ioState(es.sim!, ioNodes(es.sim!.design.root).find((x) => x.info.kind === 'screen')!.node) as ScreenState).px;

    // the golden model: the same program from RAM 0x400, the same map
    const bus = new BusModel(12, [], 4096, { dramK: 12, screen: 64, keys: true, map: busMapOf(map) });
    bus.ram.set(words(src), 0x400 / 4);
    bus.keys!.push(...[...'hi\n'].map((c) => c.charCodeAt(0)));
    const iss = new ISS(words('li t1, 0x400\njr t1'), { system: true, imemWords: 8, bus });
    for (let i = 0; i < 6000 && !iss.halted; i++) iss.step();
    expect(iss.console).toBe('>hi\nih\n>');
    // the model keeps a word a store at word index 64·y + x (the screen's pixel port: base + 256·y + 4·x); its first
    // 16 rows hold what these two keys drew, the chip's pixel (x, y) is the low byte of that word
    const golden = (i: number) => (i < 1024 ? bus.screen![i] & 0xff : 0);
    let lit = 0;
    for (let i = 0; i < 64 * 64; i++) {
      if (golden(i)) lit++;
      expect(px[i], `pixel ${i}`).toBe(golden(i));
    }
    expect(lit).toBe(2 * 36);
    // the old window answers nothing now, on either side
    const before = bus.screen![0];
    bus.write(0x50000000, 0xff, 15);
    expect(bus.screen![0]).toBe(before);
    expect(bus.read(0x50000000)).toBe(0);
  }, 180000);
});
