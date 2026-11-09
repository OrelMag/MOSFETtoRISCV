// The Verilog adder through Yosys (NAND gate set) as a GateNet: shared by the test and scripts/vadder-netlist.ts.
import './hdlkit';
import { gateNetOf } from '../src/hdl/srcmap';
import { VADDER_SOURCE, VADDER_TOP } from '../src/hdl/vadder';
import { synthesize } from '../src/hdl/yosys';

export async function vadderFromYosys() {
  const r = await synthesize({ 'top.v': VADDER_SOURCE }, { top: VADDER_TOP, gates: 'nand' });
  if (!r.json) throw new Error(`yosys: ${r.diags.map((d) => d.msg).join('; ')}`);
  return gateNetOf(r.json, VADDER_TOP);
}
