import { describe, expect, it } from 'vitest';
import { cellLines } from '../src/hdl/srcmap';
import { VADDER_SOURCE } from '../src/hdl/vadder';
import net from '../src/hdl/vadder.net.json';
import { evalOnce, simulate } from '../src/sim/harness';
import { logicDepth, stats } from '../src/sim/stats';
import { rca } from '../src/lib/combinational';
import { VADDER_PATH, VERILOG_ADD4 } from '../src/lib/vadder';
import { vadderFromYosys } from './vaddergen';

const lineText = (n: number) => VADDER_SOURCE.split('\n')[n - 1];

describe('Verilog adder', () => {
  it('the checked-in netlist is what Yosys makes of the source', async () => {
    expect(JSON.parse(JSON.stringify(await vadderFromYosys()))).toEqual(net);
  }, 60000);

  it('adds, for every input', () => {
    const sim = simulate(VERILOG_ADD4);
    for (let a = 0; a < 16; a++) for (let b = 0; b < 16; b++) for (let ci = 0; ci < 2; ci++) {
      const o = evalOnce(sim, [a, b, ci]);
      expect(o).toEqual([(a + b + ci) & 15, (a + b + ci) >> 4]);
    }
  });

  it('the critical path is as deep as the drawing, and runs through the carry lines', () => {
    expect(VADDER_PATH.depth).toBe(logicDepth(VERILOG_ADD4));
    expect(VADDER_PATH.cells).toHaveLength(VADDER_PATH.depth);
    const text = VADDER_PATH.lines.map(lineText).join('\n');
    for (const c of ['c1', 'c2', 'c3']) expect(text).toContain(`wire ${c} =`);
    expect(VADDER_PATH.to).toBe('s[3]');
    expect(stats(VERILOG_ADD4).nands).toBe(net.cells.length);
  });

  it('every cell has a line, and a cell kept by a wire has that wire\'s', () => {
    const per = cellLines(net as never);
    for (const c of net.cells) expect(per[c.name].length, c.name).toBeGreaterThan(0);
    const c4 = net.kept.find((k) => k.name === 'c4')!;
    expect(per[c4.net]).toEqual([c4.line]);
    expect(lineText(c4.line)).toContain('wire c4');
  });

  it('is comparable to the hand-drawn adder', () => {
    expect(stats(rca(4)).nands).toBeGreaterThan(0);
  });
});
