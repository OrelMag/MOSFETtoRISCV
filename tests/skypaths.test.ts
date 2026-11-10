// scripts/skypathlib.ts: OpenSTA's full path reports read as the layout flow writes them (lines as in the sky130
// runs' 6_finish.rpt), and endpoint names split into our instance names.

import { describe, expect, it } from 'vitest';
import { isBuffer, isFlop, parsePaths, segmentsOf, spread } from '../scripts/skypathlib';

const FROM_INPUT = `Startpoint: instr[21] (input port clocked by clk)
Endpoint: rf.w15.ff29.q$_DFFE_PP_
          (rising edge-triggered flip-flop clocked by clk)
Path Group: clk
Path Type: max

Fanout     Cap    Slew   Delay    Time   Description
-----------------------------------------------------------------------------
                          0.00    0.00   clock clk (rise edge)
                          0.00    0.00   clock network delay (propagated)
                          0.00    0.00 ^ input external delay
     1    0.00    0.00    0.00    0.00 ^ instr[21] (in)
                                         instr[21] (net)
                  0.00    0.00    0.00 ^ input492/A (sky130_fd_sc_hd__clkdlybuf4s50_1)
     1    0.00    0.05    0.45    0.45 ^ input492/X (sky130_fd_sc_hd__clkdlybuf4s50_1)
                                         net491 (net)
                  0.05    0.00    0.45 ^ place1739/A (sky130_fd_sc_hd__buf_4)
    29    0.22    0.61    0.47    0.92 ^ place1739/X (sky130_fd_sc_hd__buf_4)
                                         net1738 (net)
                  0.62    0.06    0.98 ^ rf.rp2.mux/_1439_/S (sky130_fd_sc_hd__mux2i_1)
     1    0.00    0.15    0.27    1.25 ^ rf.rp2.mux/_1439_/Y (sky130_fd_sc_hd__mux2i_1)
                                         rf.rp2.mux/_0305_ (net)
                  0.15    0.02    1.27 ^ rf.w15.ff29.q$_DFFE_PP_/D (sky130_fd_sc_hd__edfxtp_1)
                                  1.27   data arrival time

                         40.00   40.00   clock clk (rise edge)
     1    0.08    0.00    0.00   40.00 ^ clk (in)
                                 -0.12   39.88   library setup time
                                 39.88   data required time
`;

const FROM_FLOP = `Startpoint: core0/pc.ff3.q$_DFFE_PN_
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
  const [a, b] = parsePaths(`${FROM_INPUT}\n${FROM_FLOP}`);
  it('a path from an input port', () => {
    expect(a.start).toBe('instr[21]');
    expect(a.end).toBe('rf.w15.ff29.q$_DFFE_PP_');
    expect(a.port).toBe(false);
    expect(a.launch).toBe(0);
    expect(a.arrival).toBe(1.27);
    expect(a.setup).toBe(0.12);
    expect(a.cells.map((c) => c.master)).toEqual(['clkdlybuf4s50_1', 'buf_4', 'mux2i_1']);
    expect(a.cells[1]).toEqual({ inst: 'place1739', master: 'buf_4', delay: 0.47, time: 0.92, fanout: 29, net: 'net1738' });
    expect(a.wire).toBeCloseTo(0.08, 9);
  });
  it('a path from a flip-flop: the clock tree is the launch, not the data', () => {
    expect(b.port).toBe(true);
    expect(b.end).toBe('pcOut[3]');
    expect(b.launch).toBeCloseTo(0.24, 9);
    expect(b.cells.map((c) => c.inst)).toEqual(['core0/pc.ff3.q$_DFFE_PN_', 'output12']);
    expect(b.wire).toBeCloseTo(0.03, 9);
    expect(b.setup).toBe(0);
  });
  it('cell kinds and names', () => {
    expect(isFlop('edfxtp_1') && isFlop('dfxtp_1') && !isFlop('nand2_1')).toBe(true);
    expect(isBuffer('buf_4') && isBuffer('clkdlybuf4s50_1') && !isBuffer('inv_1')).toBe(true);
    expect(segmentsOf('md/mul.m/_14801_')).toEqual(['md', 'mul', 'm', '_14801_']);
    expect(segmentsOf('\\core0/rf.w3.ff1.q')).toEqual(['core0', 'rf', 'w3', 'ff1', 'q']);
  });
  it('spread', () => {
    const s = spread([1, 2, 3, 4, 5]);
    expect(s.median).toBe(3);
    expect(s.cv).toBeCloseTo(Math.sqrt(2) / 3, 9);
  });
});
