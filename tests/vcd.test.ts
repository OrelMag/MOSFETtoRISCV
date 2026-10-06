import { describe, expect, it } from 'vitest';
import { toVcd } from '../src/sim/vcd';

describe('VCD export', () => {
  it('declares signals, dumps initial values once, then changes in time order', () => {
    const vcd = toVcd([
      { name: 'clk', width: 1, t: [0, 5, 10], v: [0, 1, 0] },
      { name: 'fa0.s', width: 4, t: [0, 7], v: [-1, 9] },
    ], { scope: 'adder 4' });
    const lines = vcd.trim().split('\n');
    expect(lines).toContain('$timescale 1ns $end');
    expect(lines).toContain('$scope module adder_4 $end');
    expect(lines).toContain('$var wire 1 ! clk $end');
    expect(lines).toContain('$var wire 4 " fa0.s [3:0] $end');
    const body = lines.slice(lines.indexOf('$enddefinitions $end') + 1);
    expect(body).toEqual(['#0', '$dumpvars', '0!', 'bx "', '$end', '#5', '1!', '#7', 'b1001 "', '#10', '0!']);
  });
});
