// Pong on the campaign's RV16 cores (riscv/rv16/pong16.ts) on the io bench (campaign/bench.ts: a 32 × 32 screen at
// 0xF000, switches at 0xFFFA): the golden model's screen option, the game played out on the golden model, and the
// gate-level reference core (Examples ▸) and a learner-style pipelined core in lock step with it, the screen
// pixel for pixel equal to what the model's stores paint, the switches read a few cycles late by the pipeline.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { addPongBench, PONG16_TEST } from '../src/campaign/bench';
import { levelChallenge } from '../src/campaign/levels';
import { nodeById } from '../src/campaign/nodes';
import { detectRv16, Rv16Monitor } from '../src/editor/cpu16';
import { addExample, EXAMPLES } from '../src/editor/examples';
import { ioNodes, ioState, type ScreenState } from '../src/editor/ioparts';
import { UserLibrary } from '../src/editor/library';
import { emptyWorkspace, type Workspace } from '../src/editor/model';
import { EditorSim } from '../src/editor/runtime';
import { assemble16 } from '../src/riscv/rv16/asm16';
import { MMIO16, SCREEN16_IO } from '../src/riscv/rv16/isa16';
import { Iss16 } from '../src/riscv/rv16/iss16';
import { PONG16, PONG16_RAM as R, PONG16_WIN } from '../src/riscv/rv16/pong16';
import { registry } from '../src/lib/define';
import { regenerable } from '../src/lib/resolve';
import { breathe } from './setup';

// What a fresh page has registered before anything builds a bench.
const atLoad = new Set(registry.keys());

describe('the golden model’s screen', () => {
  it('stores to 0xF000 … 0xF3FF paint pixels and leave the data memory alone; loads read the data memory', () => {
    const src = `
        lui  sp, 960
        li   t0, 0x1f
        sw   t0, 0(sp)
        sw   t0, 31(sp)
        addi sp, sp, 31
        addi sp, sp, 1
        sw   t0, 1(sp)
        lw   a0, 1(sp)
        lw   a1, -6(zero)
        halt`;
    for (const screen of [false, true]) {
      const iss = new Iss16(assemble16(src).words, { dmemWords: 64, wrap: true, screen });
      iss.switches = 0x81;
      iss.run(100);
      expect(iss.halted).toBe(true);
      expect(iss.x[4]).toBe(0x81); // a1: the switches
      if (screen) {
        expect([iss.screen[0], iss.screen[31], iss.screen[33]]).toEqual([0x1f, 0x1f, 0x1f]);
        expect(iss.dmem.every((v) => v === 0)).toBe(true);
        expect(iss.x[3]).toBe(0); // a0: the data memory's word 33 mod 64
      } else {
        expect(iss.screen.every((v) => v === 0)).toBe(true);
        expect(iss.dmem[33]).toBe(0x1f);
      }
    }
  });

  it('nextLoad names the address the next instruction loads from', () => {
    const iss = new Iss16(assemble16('li t0, 3\nlw a0, -6(zero)\nlw a1, 2(t0)\nhalt').words);
    expect(iss.nextLoad()).toBeNull();
    iss.step();
    expect(iss.nextLoad()).toBe(MMIO16.SWITCHES);
    iss.step();
    expect(iss.nextLoad()).toBe(5);
  });
});

describe('pong on the golden model', () => {
  const words = assemble16(PONG16).words;
  it('assembles', () => expect(assemble16(PONG16).errors).toEqual([]));

  /** `steps` instructions with the switches set by `play` before each; the points each side won along the way. */
  function game(steps: number, play: (iss: Iss16) => number) {
    const iss = new Iss16(words, { dmemWords: 64, wrap: true, screen: true });
    let you = 0, cpu = 0, prev = 0, games = 0;
    for (let n = 0; n < steps; n++) {
      iss.switches = play(iss);
      iss.step();
      const s = iss.dmem[R.score], g = iss.dmem[R.games];
      if (g !== games) { // the winning point ended the game
        if ((prev & 15) === PONG16_WIN - 1 && (prev >> 4) !== PONG16_WIN - 1) cpu++; else you++;
        games = g;
      } else if (s !== prev && s) { if ((s & 15) !== (prev & 15)) cpu++; else you++; } // (s = 0: the new game's score)
      prev = s;
    }
    expect(iss.error).toBeNull();
    expect(iss.halted).toBe(false); // it never ends
    return { iss, you, cpu };
  }
  const follow = (m: Iss16, top: number, up: number, down: number) => {
    const aim = m.dmem[R.ballY] - 2;
    return aim > top ? down : aim < top ? up : 0;
  };

  it('a player who stands still loses every point, and five points end a game', () => {
    const { iss, you, cpu } = game(150000, () => 0);
    expect(you).toBe(0);
    expect(cpu).toBeGreaterThanOrEqual(PONG16_WIN);
    expect(iss.dmem[R.games]).toBe(Math.floor(cpu / PONG16_WIN));
    expect(iss.leds).toBe(cpu % PONG16_WIN); // the computer's points, in the low four bits
    expect(iss.dmem[R.frames]).toBeGreaterThan(100);
  });

  it('a player who follows the ball scores, with the angle set by where the ball meets the paddle', () => {
    const { iss, you, cpu } = game(1_000_000, (m) => follow(m, m.dmem[R.left], 0x80, 0x40));
    expect(you).toBeGreaterThan(cpu);
    expect(you).toBeGreaterThanOrEqual(PONG16_WIN);
    expect(iss.dmem[R.games]).toBeGreaterThanOrEqual(1);
  });

  it('switch 4 hands the right paddle to a second player (switches 1 and 0)', () => {
    // the right player stands still: its paddle never leaves the middle, and it loses
    const tops = new Set<number>();
    const { you, cpu } = game(200000, (m) => { tops.add(m.dmem[R.right]); return 0x10 | follow(m, m.dmem[R.left], 0x80, 0x40); });
    expect([...tops].filter((t) => t)).toEqual([13]);
    expect(you).toBeGreaterThan(cpu);
    // switch 1 moves it up to the top (between serves, which put it back in the middle)
    let top = 13;
    game(20000, (m) => { top = Math.min(top, m.dmem[R.right]); return 0x12; });
    expect(top).toBe(0);
  });
});

// ---- on the gates -------------------------------------------------------------------------------

const leafOf = (es: EditorSim, kind: 'switches' | 'screen') => {
  const n = ioNodes(es.sim!.design.root).find((x) => x.info.kind === kind)!.node;
  return { n, i: es.sim!.design.leaves.findIndex((l) => l.node === n) };
};
const hwScreen = (es: EditorSim) => (ioState(es.sim!, leafOf(es, 'screen').n) as ScreenState).px;

/** The first pixel where the hardware's screen and the monitor's picture differ (null: none). */
function screenDiff(es: EditorSim, mon: Rv16Monitor): string | null {
  const hw = hwScreen(es), N = SCREEN16_IO.SIZE;
  const i = [...hw].findIndex((v, j) => v !== mon.screen[j]);
  return i < 0 ? null : `pixel (${i % N}, ${Math.floor(i / N)}): hardware ${hw[i]}, model ${mon.screen[i]}`;
}

function open(ws: Workspace, id: string) {
  const lib = new UserLibrary(ws);
  const es = new EditorSim({ debounceMs: 0 });
  es.update(lib.compiled(id)!, ws.chips[id].pins);
  const mon = new Rv16Monitor(es, () => ws.chips[id], () => ws.chips);
  return { es, mon };
}

async function run(es: EditorSim, mon: Rv16Monitor, cycles: number): Promise<void> {
  const end = es.cycles + cycles;
  while (es.cycles < end && !mon.done) {
    es.runCycles(Math.min(1000, end - es.cycles), () => mon.done, 1e9);
    await breathe();
  }
}

/** Run, then flip the left paddle's switch down and run on: no mismatch, the screen the model's, the paddle lower. */
async function play(es: EditorSim, mon: Rv16Monitor, cycles: number): Promise<void> {
  expect(mon.checking).toBe(true);
  await run(es, mon, cycles);
  expect(mon.mismatch).toBeNull();
  expect(screenDiff(es, mon)).toBeNull();
  es.pokeLeaf(leafOf(es, 'switches').i, { v: 0x40 }); // switch 6: your paddle down
  // a serve puts the paddles back in the middle: look at the screen every few hundred cycles
  const N = SCREEN16_IO.SIZE;
  let lowest = 0;
  for (let k = 0; k < 8; k++) {
    await run(es, mon, cycles / 4);
    expect(mon.mismatch).toBeNull();
    expect(screenDiff(es, mon)).toBeNull();
    const px = hwScreen(es);
    const column = (x: number) => [...Array(N).keys()].filter((y) => px[y * N + x] === 0xffff);
    const left = column(1), right = column(30);
    expect([...px].filter((c) => c === 0xffe0).length).toBeLessThanOrEqual(1); // the ball (none between a point and the serve)
    if (left.length !== 6 || right.length !== 6) continue; // (a serve redrawing the columns)
    expect(left[5] - left[0]).toBe(5);
    expect(right[5] - right[0]).toBe(5);
    lowest = Math.max(lowest, left[0]);
  }
  expect(mon.iss!.halted).toBe(false);
  expect(lowest).toBeGreaterThan(13); // it went down from the middle
}

describe('pong on the gates', { timeout: 120000 }, () => {
  it('every library part of the benches resolves on a fresh page load (a constant comparator once came back X)', async () => {
    const { ws } = addExample(emptyWorkspace(), EXAMPLES.find((e) => e.id === 'rv16pong')!);
    const { addBench, PONG16_TEST: t } = await import('../src/campaign/bench');
    const coreDoc = levelChallenge(nodeById('y_irq')!)!.answer().at(-1)!;
    const cw: Workspace = { ...emptyWorkspace(), chips: Object.fromEntries(levelChallenge(nodeById('y_irq')!)!.answer().map((d) => [d.id, d])) };
    const r = addBench(cw, new UserLibrary(cw).compiled(coreDoc.id)!.def, coreDoc.id, t);
    if ('error' in r) throw new Error(r.error);
    const lost = [ws, r.ws].flatMap((w) => Object.values(w.chips)).flatMap((c) => c.parts)
      .flatMap((p) => ('lib' in p.ref && !atLoad.has(p.ref.lib) && !regenerable(p.ref.lib) ? [p.ref.lib] : []));
    expect([...new Set(lost)]).toEqual([]);
  });


  it('the example: the reference core on the io bench, found by the CPU drawer, the screen the golden model’s', async () => {
    const { ws, id } = addExample(emptyWorkspace(), EXAMPLES.find((e) => e.id === 'rv16pong')!);
    const d = detectRv16(ws.chips[id], ws.chips)!;
    expect(d.switches).toBe(true);
    expect(d.screen).toBe(true);
    expect(ws.chips[id].parts.find((p) => p.id === d.core)!.ref).toEqual({ lib: 'rv16_cpu' });
    const { es, mon } = open(ws, id);
    await play(es, mon, 2500);
    expect(es.engine).toBe('cycle');
    expect(mon.retired).toBeGreaterThan(2000);
  });

  it('a five-stage pipeline with forwarding and branches plays it too, reading the switches cycles before it writes them', async () => {
    const coreDoc = levelChallenge(nodeById('pi_core3')!)!.answer().at(-1)!;
    let ws: Workspace = { ...emptyWorkspace(), chips: { [coreDoc.id]: coreDoc } };
    const core = new UserLibrary(ws).compiled(coreDoc.id)!.def;
    const r = addPongBench(ws, core, coreDoc.id);
    if ('error' in r) throw new Error(r.error);
    ws = r.ws;
    expect(ws.open.at(-1)).toBe(r.id);
    expect(ws.chips[r.id].name).toMatch(/^Pong on /);
    const { es, mon } = open(ws, r.id);
    await play(es, mon, 2500);
    // switches flipped every few cycles: some flips land between the load reading them and its write-back
    const sw = leafOf(es, 'switches').i;
    for (let k = 0; k < 400; k++) {
      es.pokeLeaf(sw, { v: [0x40, 0x80, 0, 0xc0][k % 4] });
      es.runCycles(3 + (k % 5));
      if (k % 100 === 99) await breathe();
    }
    expect(mon.mismatch).toBeNull();
    expect(screenDiff(es, mon)).toBeNull();
  });

  it('a switch the core never read is a mismatch at the load (the hardware cannot invent positions)', async () => {
    const { ws, id } = addExample(emptyWorkspace(), EXAMPLES.find((e) => e.id === 'rv16pong')!);
    // the bench's switches swapped for a constant: the core reads 0x40 while the bank says 0
    const doc = ws.chips[id];
    const sw = doc.parts.find((p) => 'switches' in p.ref)!;
    const toY = <T,>(e: T): T => (e && typeof e === 'object' && 'part' in e && (e as { part: string }).part === sw.id ? { ...e, port: 'y' } : e);
    const parts = [...doc.parts.map((p) => (p === sw ? { ...p, ref: { const: { width: 8, value: 0x40 } } } : p)), { id: 'bank', ref: { switches: 8 }, at: [0, 60] as [number, number] }];
    const cut = { ...ws, chips: { ...ws.chips, [id]: { ...doc, parts, wires: doc.wires.map((w) => ({ ...w, a: toY(w.a), b: toY(w.b) })) } } };
    const { es, mon } = open(cut, id);
    await run(es, mon, 2000);
    expect(mon.mismatch).not.toBeNull();
    expect(mon.mismatch!.detail).toMatch(/0x0040/);
    expect(PONG16_TEST.src).toBe(PONG16);
  });
});

describe('Play Pong on your core', { timeout: 300000 }, () => {
  it('every core level that offers it: its reference answer plays Pong in lock step with the golden model', async () => {
    const { NODES } = await import('../src/campaign/nodes');
    const { coreSpecOf } = await import('../src/campaign/corecheck');
    const offered = NODES.filter((n) => n.kind === 'core' && levelChallenge(n) && coreSpecOf(levelChallenge(n)!.check)?.rv16i).map((n) => n.id);
    expect(offered.sort()).toEqual(['c_core3', 'c_fast', 'o_bpred', 'o_dcore', 'o_mc', 'o_mcore', 'pi_core3', 'y_final', 'y_irq', 'y_trap']);
    for (const level of offered) {
      const coreDoc = levelChallenge(nodeById(level)!)!.answer().at(-1)!;
      let ws: Workspace = { ...emptyWorkspace(), chips: Object.fromEntries(levelChallenge(nodeById(level)!)!.answer().map((d) => [d.id, d])) };
      const core = new UserLibrary(ws).compiled(coreDoc.id)!.def;
      const r = addPongBench(ws, core, coreDoc.id);
      if ('error' in r) throw new Error(r.error);
      ws = r.ws;
      const { es, mon } = open(ws, r.id);
      expect(mon.checking, level).toBe(true);
      await run(es, mon, 1500);
      expect(mon.mismatch && `${level}: ${mon.mismatch.detail}`).toBeNull();
      expect(mon.retired, level).toBeGreaterThan(200);
      expect(screenDiff(es, mon), level).toBeNull();
    }
  });
});
