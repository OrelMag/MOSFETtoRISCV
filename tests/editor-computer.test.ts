// The sandbox's computer example: an RV32I core, a program ROM, the memory map (a user chip),
// 4K words of RAM, a 64 × 64 screen, a console, LEDs and switches. It resolves on a fresh page
// load, draws cleanly, runs on EditorSim's cycle engine to its halt with the golden model in
// lock-step, prints the greeting and paints exactly the picture the ISS's stores to the screen
// describe. The ISS's mmio mode (console, LEDs, switches only, decoded exactly) is checked here too.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { CpuMonitor, mismatchText, resolveCpu } from '../src/editor/cpu';
import { addExample, computerChip, EXAMPLES } from '../src/editor/examples';
import { consoleText, type ConsoleState, ioNodes, ioState, type ScreenState } from '../src/editor/ioparts';
import { UserLibrary } from '../src/editor/library';
import { lintChip } from '../src/editor/lint';
import { emptyWorkspace, type PartRef, polyline, type Workspace } from '../src/editor/model';
import { partDef } from '../src/editor/parts';
import { EditorSim } from '../src/editor/runtime';
import { registry } from '../src/lib/define';
import { regenerable } from '../src/lib/resolve';
import { assemble } from '../src/riscv/asm';
import { COMPUTER_PROGRAMS, DONE_TEXT, GREETING, packChars, PICTURE } from '../src/riscv/ioprograms';
import { IO, ISS } from '../src/riscv/iss';
import { breathe } from './setup';

// What a fresh page has registered before anything builds a CPU.
const atLoad = new Set(registry.keys());
const EX = EXAMPLES.find((e) => e.id === 'computer')!;
const SCREEN = 0xc0000000;

/** The program on the ISS as the computer's CPU drawer runs it, and the picture its screen stores paint. */
function reference(src: string, switches: number, steps = 100000) {
  const iss = new ISS(assemble(src).words, { mmio: true, imemWords: 1024, dmemWords: 4096 });
  iss.switches = switches;
  const px = new Int32Array(64 * 64);
  const store = iss.store.bind(iss);
  iss.store = (addr, f3, v) => {
    if (addr >>> 0 >= SCREEN) px[(addr >>> 2) & 4095] = v & 0xff;
    store(addr, f3, v);
  };
  for (let n = 0; n < steps && !iss.halted; n++) iss.step();
  return { iss, px };
}

/** The example in a workspace, compiled, on an EditorSim with the CPU drawer's monitor. */
function open(src?: string): { ws: Workspace; id: string; es: EditorSim; mon: CpuMonitor; lib: UserLibrary } {
  let { ws, id } = addExample(emptyWorkspace(), EX);
  if (src) ws = { ...ws, chips: { ...ws.chips, [id]: computerChip(id, ws.chips[id].name, `${id}_map`, src) } };
  const lib = new UserLibrary(ws);
  const es = new EditorSim({ debounceMs: 0 });
  es.update(lib.compiled(id)!, ws.chips[id].pins);
  const mon = new CpuMonitor(es, () => ws.chips[id], () => ws.chips);
  return { ws, id, es, mon, lib };
}

const leaf = (es: EditorSim, path: string) => es.sim!.design.leaves.findIndex((l) => l.node.path.join('.') === path);
const io = (es: EditorSim, kind: 'console' | 'screen') => {
  const n = ioNodes(es.sim!.design.root).find((x) => x.info.kind === kind)!;
  return ioState(es.sim!, n.node);
};

/** Clock until the monitor says done (or `cap` cycles), yielding to the worker now and then. */
async function run(es: EditorSim, mon: CpuMonitor, cap: number, stop = () => mon.done): Promise<void> {
  while (es.cycles < cap && !stop()) {
    es.runCycles(Math.min(2000, cap - es.cycles), stop, 1e9);
    await breathe();
  }
}

describe('ISS memory-mapped I/O without the system (mmio)', () => {
  it('decodes the console, LEDs and switches exactly; other I/O addresses are dropped', () => {
    const iss = new ISS(assemble(`
      li s1, 0x80000000
      li t0, 'A'
      sw t0, 0(s1)
      li t0, 0x1a5
      sw t0, 4(s1)
      lw a0, 8(s1)
      lw a1, 4(s1)
      sw t0, 16(s1)
      lw a2, 16(s1)
      li s0, 0xC0000000
      sw t0, 0(s0)
      lw a3, 0(s0)
      sw t0, 0(zero)
      csrr a4, mhartid
h:    j h`).words, { mmio: true });
    iss.switches = 0x5a;
    iss.run(100);
    expect(iss.halted).toBe(true);
    expect(iss.console).toBe('A');
    expect(iss.leds).toBe(0xa5);
    expect(iss.x[10]).toBe(0x5a); // switches
    expect(iss.x[11]).toBe(0xa5); // the LEDs read back
    expect(iss.x[12]).toBe(0); // 0x8000_0010: no timer without the system
    expect(iss.x[13]).toBe(0); // the screen is write-only to the model
    expect(iss.dmem[0]).toBe(0x1a5); // only the RAM store reached memory
    expect(iss.mtime).toBe(0);
    expect(iss.x[14]).toBe(0);
    // without mmio the same addresses are plain (wrapping) memory
    const plain = new ISS(assemble(`li s1, 0x80000000\nli t0, 7\nsw t0, 4(s1)\nh: j h`).words);
    plain.run(10);
    expect(plain.dmem[1]).toBe(7);
    expect(plain.console).toBe('');
    expect(IO.SWITCHES).toBe(0x80000008);
  });

  it('packs text four characters to a word, the first in the low byte', () => {
    expect(packChars('Hell')).toBe(0x6c6c6548);
    expect(packChars('V!\n')).toBe(0x000a2156);
  });

  it.each(COMPUTER_PROGRAMS.map((p) => [p.id, p.source] as const))('%s assembles into the 1K-word ROM and runs on the ISS', (_id, src) => {
    const a = assemble(src);
    expect(a.errors).toEqual([]);
    expect(a.words.length).toBeLessThan(1024);
    // word accesses only: the single-cycle core has no byte / halfword loads and stores
    for (const l of a.lines) expect(l.text).not.toMatch(/^\s*(lb|lbu|lh|lhu|sb|sh)\b/);
    const { iss } = reference(src, 0x1c, 20000);
    expect(iss.console.length).toBeGreaterThan(0);
  });
});

describe('the computer example', () => {
  it('places only parts a fresh page load resolves, and draws without lint warnings', () => {
    const { ws, id } = addExample(emptyWorkspace(), EX);
    const lib = new UserLibrary(ws);
    const lost = Object.values(ws.chips).flatMap((c) => c.parts).flatMap((p) => ('lib' in p.ref && !atLoad.has(p.ref.lib) && !regenerable(p.ref.lib) ? [p.ref.lib] : []));
    expect(lost).toEqual([]);
    expect(Object.keys(ws.chips).filter((k) => k.startsWith(id))).toEqual([`${id}_map`, id]);
    for (const [cid, doc] of Object.entries(ws.chips)) {
      const c = lib.compiled(cid)!;
      expect(c.diags, cid).toEqual([]);
      const defOf = (p: { ref: PartRef }) => {
        const d = 'chip' in p.ref ? lib.defOf(p.ref.chip) : partDef(p.ref, (x) => lib.defOf(x));
        return !d || 'error' in d ? undefined : d;
      };
      const polys = new Map(doc.wires.flatMap((w) => { const p = polyline(doc, w, defOf); return p ? [[w.id, p] as const] : []; }));
      expect(lintChip(doc, c, polys).diags, cid).toEqual([]);
    }
  });

  it('the CPU drawer recognizes the core: its register file, the ROM, RAM and memory-mapped I/O', () => {
    const { ws, id } = addExample(emptyWorkspace(), EX);
    const d = resolveCpu(ws.chips[id], ws.chips)!;
    expect(d).toMatchObject({ rom: 'imem', regs: 'cpu.rf', dmem: 'ram', pc: { part: 'imem', port: 'addr' }, iss: { mmio: true } });
    expect(d.retire).toBeUndefined();
    expect(d.pipeline).toBeUndefined();
  });

  it('runs to its halt on the cycle engine in lock-step: the greeting, the LEDs and the picture', async () => {
    const SW = 0xe3;
    const { es, mon } = open();
    es.pokeLeaf(leaf(es, 'sw'), { v: SW });
    expect(mon.checking).toBe(true);
    await run(es, mon, 12000);
    expect(es.engine).toBe('cycle');
    expect(mon.mismatch && mismatchText(mon.mismatch)).toBeNull();
    expect(mon.iss!.halted).toBe(true);
    expect(es.halted).toBe(true); // the halt part saw `j .`
    expect(es.cycles).toBeLessThan(11000);
    const ref = reference(PICTURE, SW);
    expect(mon.retired).toBe(ref.iss.retired);
    expect(consoleText(io(es, 'console') as ConsoleState)).toBe(GREETING + DONE_TEXT);
    expect(mon.console).toBe(GREETING + DONE_TEXT);
    expect(mon.leds).toBe(SW);
    const px = (io(es, 'screen') as ScreenState).px;
    const diff = [...px].findIndex((v, i) => v !== ref.px[i]);
    expect(diff, `pixel (${diff % 64}, ${diff >> 6})`).toBe(-1);
    expect(px[10 * 64 + 32]).toBe(SW); // the apex, in the switches' colour
    expect(px[63 * 64 + 63]).toBe(0xfd); // the gradient's corner: red 7, green 7, blue 1
  });

  it('live switches: a flipped switch repaints the square, the model following the switch bank', async () => {
    const src = COMPUTER_PROGRAMS.find((p) => p.id === 'liveswitches')!.source;
    const { es, mon } = open(src);
    await run(es, mon, 1500);
    es.pokeLeaf(leaf(es, 'sw'), { v: 0x1c });
    await run(es, mon, 3500);
    expect(mon.mismatch && mismatchText(mon.mismatch)).toBeNull();
    expect(mon.leds).toBe(0x1c);
    const px = (io(es, 'screen') as ScreenState).px;
    expect(px[30 * 64 + 30]).toBe(0x1c);
    expect(px[10 * 64 + 10]).toBe(0);
  });

  it('a console that disagrees with the model is a mismatch', async () => {
    // the hardware console drops a character the model prints: write enable cut
    const { ws, id } = addExample(emptyWorkspace(), EX);
    const doc = ws.chips[id];
    const cut = { ...ws, chips: { ...ws.chips, [id]: { ...doc, wires: doc.wires.filter((w) => w.id !== 'conWe'), parts: [...doc.parts, { id: 'off', ref: { const: { width: 1, value: 0 } }, at: [90, 52] as [number, number] }] } } };
    cut.chips[id].wires.push({ id: 'off', a: { part: 'off', port: 'y' }, b: { part: 'con', port: 'we' }, pts: [] });
    const lib = new UserLibrary(cut);
    const es = new EditorSim({ debounceMs: 0 });
    es.update(lib.compiled(id)!, cut.chips[id].pins);
    const mon = new CpuMonitor(es, () => cut.chips[id], () => cut.chips);
    await run(es, mon, 400);
    expect(mon.mismatch?.what).toBe('console');
    expect(mismatchText(mon.mismatch!)).toMatch(/expected "H", got ""/);
  });
});
