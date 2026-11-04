import { describe, expect, it } from 'vitest';
import { emptyWorkspace } from '../src/editor/model';
import { remixDef } from '../src/editor/remix';
import { busComputer } from '../src/lib/soc';
import { UART_CORE, UART_RX_BENCH, UART_TX_BENCH } from '../src/lib/uart';
import { twoComputers } from '../src/lib/uartlink';
import { deadInstances } from '../src/sim/dead';
import { netlistOf } from '../src/sim/types';
import { backwardEnds, labelOverlaps, symbolOverlaps } from '../src/view/route';
import { assemble } from '../src/riscv/asm';
import { uartChatSource } from '../src/riscv/uartprograms';
import { DualSim } from '../src/sim/dualsim';
import { flatten } from '../src/sim/flatten';
import { pack } from '../src/sim/values';
import { tick } from './yieldtick';

const words = (src: string) => { const a = assemble(src); if (a.errors.length) throw new Error(a.errors[0].message); return a.words; };

/** Two computers on the cycle engine; clock B runs `ratio` times as fast as clock A (edges merged in time order). */
function pair(srcA: string, srcB: string, ratio: number) {
  const def = twoComputers(words(srcA), words(srcB));
  const sim = new DualSim(flatten(def));
  sim.preferFast = true;
  sim.reset('zero');
  for (const p of ['clkA', 'clkB', 'noiseAB', 'noiseBA']) sim.setInput(p, 0);
  sim.settle(); sim.prepare(); sim.settle();
  const root = sim.design.root;
  const out = (p: string) => pack(sim.getBits(root.ports[p]));
  const kbd = (c: 'a' | 'b') => root.children!.get(c)!.children!.get('kbd')!;
  const consoles = { A: '', B: '' };
  let tA = 1, tB = 1 / ratio, edgesA = 0, edgesB = 0;
  const step = () => {
    const a = tA <= tB;
    const clk = a ? 'clkA' : 'clkB', S = a ? 'A' : 'B';
    if (out(`consoleValid${S}`) === 1) consoles[S] += String.fromCharCode(out(`consoleData${S}`));
    sim.setInput(clk, 1); sim.settle(); sim.setInput(clk, 0); sim.settle();
    if (a) { tA += 1; edgesA++; } else { tB += 1 / ratio; edgesB++; }
  };
  const type = (c: 'a' | 'b', text: string) => {
    const st = sim.leafState(kbd(c).leafIndex!) as { q: number[]; clk: number; ack: number };
    sim.poke(kbd(c).leafIndex!, { ...st, q: [...st.q, ...[...text].map((x) => x.charCodeAt(0))] });
    sim.settle();
  };
  return { sim, out, step, type, consoles, edges: () => [edgesA, edgesB] };
}

describe('two computers on the cycle engine', () => {
  it('chat: keys typed on one appear on the other\'s console, at equal clocks and 4 % apart', async () => {
    for (const [ratio, irq] of [[1, false], [1.04, false], [0.96, true]] as const) {
      const p = pair(uartChatSource(2, false), uartChatSource(2, irq), ratio);
      for (let i = 0; i < 400; i++) p.step();
      p.type('a', 'Hi'); p.type('b', 'yo');
      for (let i = 0; i < 9000 && (p.consoles.B.length < 2 || p.consoles.A.length < 2); i++) { p.step(); if (i % 2000 === 0) await tick(); }
      expect(p.consoles.B, `ratio ${ratio}`).toBe('Hi');
      expect(p.consoles.A, `ratio ${ratio}`).toBe('yo');
    }
  }, 240000);
});

describe('two computers: how far apart the clocks may be', () => {
  it('works at +-4 %, fails at +-9 % (see step 4)', async () => {
    const result: Record<string, string> = {};
    for (const ratio of [1.04, 0.96, 1.09, 0.91]) {
      const p = pair(uartChatSource(2, false), uartChatSource(2, true), ratio);
      for (let i = 0; i < 400; i++) p.step();
      p.type('a', 'Hello');
      for (let i = 0; i < 14000; i++) { p.step(); if (i % 3000 === 0) await tick(); }
      result[ratio] = p.consoles.B;
    }
    expect(result[1.04]).toBe('Hello');
    expect(result[0.96]).toBe('Hello');
    expect(result[1.09]).not.toBe('Hello');
    expect(result[0.91]).not.toBe('Hello');
  }, 240000);
});

describe('the chapter scenes as drawings', () => {
  const A = words(uartChatSource(2)), B = words(uartChatSource(2, true));
  const tops = [twoComputers(A, B), busComputer(A, [0], { imemK: 8, ramK: 8, uart: true, keys: true }), UART_TX_BENCH, UART_RX_BENCH, UART_CORE];
  it.each(tops.map((d) => [d.id, d] as const))('%s: no overlapping labels or symbols, nothing dead, and Open in Sandbox works', (_, d) => {
    const nl = netlistOf(d)!;
    expect(labelOverlaps(d, nl)).toEqual([]);
    expect(symbolOverlaps(nl)).toEqual([]);
    expect(backwardEnds(d, nl)).toEqual([]);
    expect(deadInstances(nl, d.ports)).toEqual([]);
    const r = remixDef(emptyWorkspace(), d);
    expect('error' in r ? r.error : '').toBe('');
  }, 120000);
});
