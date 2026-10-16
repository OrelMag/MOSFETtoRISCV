import { describe, expect, it } from 'vitest';
import '../src/lib';
import { resolveCpu } from '../src/editor/cpu';
import { addExample, EXAMPLES } from '../src/editor/examples';
import { consoleText, type ConsoleState, ioNodes, ioState, type ScreenState } from '../src/editor/ioparts';
import { UserLibrary } from '../src/editor/library';
import { emptyWorkspace } from '../src/editor/model';
import { EditorSim } from '../src/editor/runtime';
import { deviceIn } from '../src/dram/controller';
import type { HierNode } from '../src/sim/flatten';
import { pack } from '../src/sim/values';
import { breathe } from './setup';

// Examples ▸ System on a bus: compiled from its document, booted from the flash's ROM part by DMA, then
// typed at; the console, the DRAM line, the screen and the timer's ticks are what the program says.

const EX = EXAMPLES.find((e) => e.id === 'bussystem')!;
const child = (n: HierNode, ...p: string[]) => p.reduce((x, k) => x.children!.get(k)!, n);

function open() {
  const { ws, id } = addExample(emptyWorkspace(), EX);
  const lib = new UserLibrary(ws);
  const def = lib.compiled(id)!;
  const es = new EditorSim({ debounceMs: 0 });
  es.update(def, ws.chips[id].pins);
  return { ws, id, lib, es, def };
}

async function run(es: EditorSim, cycles: number, stop = () => false) {
  const end = es.cycles + cycles;
  while (es.cycles < end && !stop()) { es.runCycles(Math.min(2000, end - es.cycles), stop, 1e9); await breathe(); }
}

describe('Examples ▸ System on a bus', () => {
  it('is not taken for a CPU the drawer can follow (its memory is behind a bus)', () => {
    const { ws, id } = open();
    expect(resolveCpu(ws.chips[id], ws.chips)).toBeNull();
  });

  it('boots from the flash, echoes keys, keeps the line in DRAM, draws, and counts timer ticks', async () => {
    const { es } = open();
    expect(es.sim).toBeTruthy();
    const con = () => consoleText(ioState(es.sim!, ioNodes(es.sim!.design.root).find((x) => x.info.kind === 'console')!.node) as ConsoleState);
    await run(es, 3000, () => con().includes('>'));
    expect(con()).toBe('>');
    for (const c of 'hi\n') es.typeKey(c.charCodeAt(0));
    await run(es, 8000, () => con().endsWith('ih\n>'));
    expect(con()).toBe('>hi\nih\n>');
    const root = es.sim!.design.root;
    const dev = deviceIn(es.sim!.leafState(child(root, 'dram', 'core', 'dev').leafIndex!))!;
    expect([dev.read(0), dev.read(1)]).toEqual([104, 105]);
    const px = (ioState(es.sim!, ioNodes(root).find((x) => x.info.kind === 'screen')!.node) as ScreenState).px;
    expect([px[0], px[5], px[5 * 64 + 5], px[6], px[8], px[64 * 6]]).toEqual([104, 104, 104, 0, 105, 0]);
    const before = pack(es.sim!.getBits(child(root, 'cpu', 'core', 'rf', 'w25').ports.q));
    await run(es, 5000);
    const ticks = pack(es.sim!.getBits(child(root, 'cpu', 'core', 'rf', 'w25').ports.q));
    expect(ticks - before).toBeGreaterThanOrEqual(4); // a tick every 1000 cycles
  }, 120000);
});
