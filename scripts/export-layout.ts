// Export the dual-core processor as synthesizable Verilog plus an OpenROAD-flow-scripts design
// configuration (SkyWater 130 nm, sky130hd). Run: npx vite-node scripts/export-layout.ts [outDir]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dualCore } from '../src/lib';
import { stats } from '../src/sim/stats';
import { synthVerilog } from '../src/sim/vexport';

const out = process.argv[2] ?? 'layout/design';
mkdirSync(out, { recursive: true });
const top = dualCore([], 5, true);
const v = synthVerilog(top, 'mosfet_riscv');
writeFileSync(join(out, 'mosfet_riscv.v'), v.verilog);
// A relaxed clock: the point is a complete, legal layout, not maximum frequency.
writeFileSync(join(out, 'constraint.sdc'), `create_clock -name clk -period 40.0 [get_ports clk]
set_input_delay 2.0 -clock clk [delete_from_list [all_inputs] [get_ports clk]]
set_output_delay 2.0 -clock clk [all_outputs]
`);
writeFileSync(join(out, 'config.mk'), `export DESIGN_NICKNAME = mosfet_riscv
export DESIGN_NAME = mosfet_riscv
export PLATFORM    = sky130hd
export VERILOG_FILES = $(DESIGN_HOME)/src/$(DESIGN_NICKNAME)/mosfet_riscv.v
export SDC_FILE      = $(DESIGN_HOME)/$(PLATFORM)/$(DESIGN_NICKNAME)/constraint.sdc
export CORE_UTILIZATION = 35
export PLACE_DENSITY = 0.55
export SYNTH_HIERARCHICAL = 0
`);
writeFileSync(join(out, 'source.json'), JSON.stringify({ nands: stats(top).nands, modules: v.modules, top: v.top }, null, 2));
console.log(`wrote ${out}: ${v.modules} modules, ${stats(top).nands} NAND equivalents, ${v.verilog.length} bytes`);
