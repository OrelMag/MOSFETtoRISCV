import { describe, expect, it } from 'vitest';
import { twoComputers } from '../src/lib/uartlink';
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
