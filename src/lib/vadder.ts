// The 4-bit adder written in Verilog (hdl/vadder.ts) as Yosys mapped it onto NANDs and inverters: the checked-in netlist
// (hdl/vadder.net.json, held equal to Yosys's output by tests/vadder.test.ts) drawn as a component. Instances are the cells'
// names (g0 … g51), so hdl/srcmap.ts's critical path and Verilog lines address the drawing directly.

import { criticalPathOf, cellLines, type GateNet } from '../hdl/srcmap';
import net from '../hdl/vadder.net.json';
import { Builder } from './builder';
import { define, merger, ones, splitter } from './define';
import { NOT } from './gates';
import { layered } from './layered';
import { NAND } from './transistors';
import type { PortDef } from '../sim/types';

export const VADDER_NET = net as GateNet;
export const VADDER_PATH = criticalPathOf(VADDER_NET);
export const VADDER_LINES = cellLines(VADDER_NET);

const bit = (name: string, dir: 'in' | 'out'): PortDef => ({ name, width: 1, dir });

export const VERILOG_ADD4 = (() => {
  const b = new Builder(10, 6, 3);
  b.pins('a', 'b', 'ci');
  const ports: PortDef[] = [{ name: 'a', width: 4, dir: 'in' }, { name: 'b', width: 4, dir: 'in' }, bit('ci', 'in'),
    { name: 's', width: 4, dir: 'out' }, bit('co', 'out')];
  b.add(splitter(ones(4)), 'a', 'sa');
  b.add(splitter(ones(4)), 'b', 'sb');
  b.wire('a', 'sa.in');
  b.wire('b', 'sb.in');
  const drv = (n: string): string => {
    const m = /^([ab])(\d)$/.exec(n);
    if (m) return `s${m[1]}.o${m[2]}`;
    return n === 'ci' ? 'ci' : `${n}.y`;
  };
  // column per level
  const level = new Map<string, number>();
  for (const c of net.cells) level.set(c.name, 1 + Math.max(0, ...c.in.map((i) => level.get(i) ?? 0)));
  const maxL = Math.max(...level.values());
  for (let l = 1; l <= maxL; l++) {
    b.next();
    for (const c of net.cells) {
      if (level.get(c.name) !== l) continue;
      const nm = b.add(c.type === 'NAND' ? NAND : NOT, undefined, c.name);
      c.in.forEach((i, k) => b.wire(drv(i), `${nm}.${c.type === 'NAND' ? 'ab'[k] : 'a'}`));
    }
  }
  b.next();
  const sP = net.ports.find((p) => p.name === 's')!;
  b.add(merger(ones(4)), 's', 'ms');
  sP.nets.forEach((n, i) => b.wire(drv(n), `ms.i${i}`));
  b.wire('ms.out', 's');
  b.wire(drv(net.ports.find((p) => p.name === 'co')!.nets[0]), 'co');
  return define({
    id: 'verilog_add4', name: '4-bit adder from Verilog', category: 'arithmetic',
    summary: 'The 4-bit adder of the Faster adders chapter\'s last step: Verilog with one line per recipe step, mapped by Yosys onto NANDs and inverters.',
    ports, symbol: { kind: 'box', label: 'ADD4' },
    spec: ([a, bb, ci]) => { const t = a + bb + ci; return [t & 15, t >> 4]; },
    netlist: () => layered(ports, b, { gap: 6 }),
  });
})();
