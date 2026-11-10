// scripts/skypathlib.ts: OpenSTA's full path reports as the layout flow writes them, and endpoint names split into our
// instance names. The first two paths are cut from the sys run's paths_max.rpt (layout run 42776050778: three decimals, no
// net lines, the launch clock as one latency line); the third has the net lines and the expanded clock tree of 6_finish.rpt.

import { describe, expect, it } from 'vitest';
import { flopPath, isBuffer, isFlop, parsePaths, sameStart, segmentsOf, spread } from '../scripts/skypathlib';

const FROM_INPUT = `[WARNING STA-0168] unknown field nets.
Startpoint: instr[21] (input port clocked by clk)
Endpoint: rf.w15.ff29.q$_DFFE_PP_
          (rising edge-triggered flip-flop clocked by clk)
Path Group: clk
Path Type: max

Fanout      Cap     Slew    Delay     Time   Description
---------------------------------------------------------------------------------
                            0.000    0.000   clock clk (rise edge)
                            0.000    0.000   clock network delay (propagated)
                            0.000    0.000 ^ input external delay
     1    0.004    0.000    0.000    0.000 ^ instr[21] (in)
                   0.000    0.000    0.000 ^ input492/A (sky130_fd_sc_hd__clkdlybuf4s50_1)
     1    0.003    0.046    0.451    0.451 ^ input492/X (sky130_fd_sc_hd__clkdlybuf4s50_1)
                   0.046    0.000    0.451 ^ place1739/A (sky130_fd_sc_hd__buf_4)
    29    0.223    0.609    0.473    0.924 ^ place1739/X (sky130_fd_sc_hd__buf_4)
                   0.618    0.061    0.985 ^ rf.rp2.mux/place1732/A (sky130_fd_sc_hd__buf_4)
    35    0.239    0.648    0.634    1.619 ^ rf.rp2.mux/place1732/X (sky130_fd_sc_hd__buf_4)
                   0.124    0.000   15.004 v _1961_/B1 (sky130_fd_sc_hd__o21ai_2)
    31    0.117    1.253    0.491   15.494 ^ _1961_/Y (sky130_fd_sc_hd__o21ai_2)
                   1.254    0.025   15.519 ^ rf.w15.ff29.q$_DFFE_PP_/D (sky130_fd_sc_hd__edfxtp_1)
                                    15.519   data arrival time

                           40.000   40.000   clock clk (rise edge)
                           -0.374   40.478   library setup time
                                    40.478   data required time
`;

const FROM_FLOP = `Startpoint: io/mtime.r.ff0.q$_DFF_P_
            (rising edge-triggered flip-flop clocked by clk)
Endpoint: io/mtime.r.ff31.q$_DFF_P_
          (rising edge-triggered flip-flop clocked by clk)
Path Group: clk
Path Type: max

Fanout      Cap     Slew    Delay     Time   Description
---------------------------------------------------------------------------------
                            0.000    0.000   clock clk (rise edge)
                            0.768    0.768   clock network delay (propagated)
                   0.051    0.000    0.768 ^ io/mtime.r.ff0.q$_DFF_P_/CLK (sky130_fd_sc_hd__dfxtp_1)
     6    0.031    0.145    0.393    1.160 v io/mtime.r.ff0.q$_DFF_P_/Q (sky130_fd_sc_hd__dfxtp_1)
                   0.145    0.000    1.161 v io/_353_/A (sky130_fd_sc_hd__ha_1)
     2    0.007    0.060    0.256    1.417 v io/_353_/COUT (sky130_fd_sc_hd__ha_1)
                   0.060    0.002    1.419 v io/mtime.r.ff31.q$_DFF_P_/D (sky130_fd_sc_hd__dfxtp_1)
                                     1.419   data arrival time
`;

const WITH_NETS = `Startpoint: core0/pc.ff3.q$_DFFE_PN_
            (rising edge-triggered flip-flop clocked by clk)
Endpoint: pcOut[3] (output port clocked by clk)
Path Group: clk
Path Type: max

Fanout     Cap    Slew   Delay    Time   Description
-----------------------------------------------------------------------------
                          0.00    0.00   clock clk (rise edge)
                          0.00    0.00   clock source latency
     1    0.08    0.00    0.00    0.00 ^ clk (in)
                                         clk (net)
                  0.01    0.00    0.00 ^ clkbuf_0_clk/A (sky130_fd_sc_hd__clkbuf_16)
     8    0.19    0.20    0.23    0.23 ^ clkbuf_0_clk/X (sky130_fd_sc_hd__clkbuf_16)
                                         clknet_0_clk (net)
                  0.20    0.01    0.24 ^ core0/pc.ff3.q$_DFFE_PN_/CLK (sky130_fd_sc_hd__edfxtp_1)
     2    0.02    0.10    0.40    0.64 v core0/pc.ff3.q$_DFFE_PN_/Q (sky130_fd_sc_hd__edfxtp_1)
                                         pcOut[3] (net)
                  0.10    0.03    0.67 v output12/A (sky130_fd_sc_hd__buf_2)
     1    0.03    0.09    0.20    0.87 v output12/X (sky130_fd_sc_hd__buf_2)
                                         pcOut[3] (net)
                  0.09    0.00    0.87 v pcOut[3] (out)
                                  0.87   data arrival time
`;

describe('OpenSTA paths', () => {
  const [a, b, c] = parsePaths(`${FROM_INPUT}\n${FROM_FLOP}\n${WITH_NETS}`);
  it('a path from an input port', () => {
    expect(a.start).toBe('instr[21]');
    expect(a.end).toBe('rf.w15.ff29.q$_DFFE_PP_');
    expect([a.port, a.launch, a.arrival, a.setup]).toEqual([false, 0, 15.519, 0.374]);
    expect([a.pin, a.endMaster]).toEqual(['D', 'edfxtp_1']);
    expect(a.cells.map((x) => x.master)).toEqual(['clkdlybuf4s50_1', 'buf_4', 'buf_4', 'o21ai_2']);
    expect(a.cells[1]).toEqual({ inst: 'place1739', master: 'buf_4', delay: 0.473, time: 0.924, fanout: 29, net: '', cap: 0.223 });
    expect(a.wire).toBeCloseTo(0.086, 9);
  });
  it('a path from a flip-flop: its clock latency is the launch, its clk-to-q the first cell', () => {
    expect([b.start, b.end, b.pin]).toEqual(['io/mtime.r.ff0.q$_DFF_P_', 'io/mtime.r.ff31.q$_DFF_P_', 'D']);
    expect(b.launch).toBeCloseTo(0.767, 9);
    expect(b.cells.map((x) => x.master)).toEqual(['dfxtp_1', 'ha_1']);
    expect(b.wire).toBeCloseTo(0.002, 9);
  });
  it('an expanded clock tree and net lines: the tree is the launch, the nets are read', () => {
    expect([c.port, c.end, c.pin, c.endMaster]).toEqual([true, 'pcOut[3]', 'pcOut[3]', 'out']);
    expect(c.launch).toBeCloseTo(0.24, 9);
    expect(c.cells.map((x) => [x.inst, x.net])).toEqual([['core0/pc.ff3.q$_DFFE_PN_', 'pcOut[3]'], ['output12', 'pcOut[3]']]);
    expect(c.wire).toBeCloseTo(0.03, 9);
    expect(c.setup).toBe(0);
  });
  it('names', () => {
    expect(segmentsOf('md/mul.m/_14801_')).toEqual(['md', 'mul', 'm', '_14801_']);
    expect(segmentsOf('\\core0/rf.w3.ff1.q')).toEqual(['core0', 'rf', 'w3', 'ff1', 'q']);
    expect(flopPath('core0/rf.w15.ff29.q$_DFFE_PP_')).toEqual(['core0', 'rf', 'w15', 'ff29']);
    // our boundary in an enabled flip-flop is the plain one inside it
    expect(sameStart('rf.w15.ff29.q$_DFFE_PP_', 'rf.w15.ff29.ff')).toBe(true);
    expect(sameStart('instr[21]', 'instr[21]')).toBe(true);
    expect(sameStart('instr[21]', 'rf.w31.ff31.ff')).toBe(false);
  });
  it('cell kinds, spread', () => {
    expect(isFlop('edfxtp_1') && isFlop('dfxtp_1') && !isFlop('nand2_1')).toBe(true);
    expect(isBuffer('buf_4') && isBuffer('clkdlybuf4s50_1') && !isBuffer('inv_1')).toBe(true);
    const s = spread([1, 2, 3, 4, 5]);
    expect(s.median).toBe(3);
    expect(s.cv).toBeCloseTo(Math.sqrt(2) / 3, 9);
  });
});
