// Export a processor as synthesizable Verilog plus an OpenROAD-flow-scripts design configuration
// (SkyWater 130 nm, sky130hd), with our own estimates of it (NAND count per block, static timing) in
// source.json for the site to set beside the flow's reports.
// Run: npx vite-node scripts/export-layout.ts [dual | sys] [outDir]
//   dual: the dual-core of chapter 24 (program ROMs as instruction ports, the shared memory inside)
//   sys:  the RV32IM + Zicsr system core (systemCore({ m: true }), both memories outside its ports,
//         as SRAM macros would be; the module verify-export.ts checks as core-m)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dualCore, systemCore } from '../src/lib';
import { flatten } from '../src/sim/flatten';
import { stats } from '../src/sim/stats';
import { analyzeTiming, CLK_TO_Q, PS_PER_NAND, SETUP } from '../src/sim/timing';
import { netlistOf } from '../src/sim/types';
import { synthVerilog } from '../src/sim/vexport';

const DESIGNS = {
  dual: { top: () => dualCore([], 5, true), name: 'Dual-core RV32I (chapter 24)' },
  sys: { top: () => systemCore({ m: true }), name: 'System CPU core, RV32IM + Zicsr' },
};
const design = (process.argv[2] ?? 'dual') as keyof typeof DESIGNS;
if (!DESIGNS[design]) throw new Error(`unknown design ${design}: ${Object.keys(DESIGNS).join(' | ')}`);
const out = process.argv[3] ?? 'layout/design';
mkdirSync(out, { recursive: true });
const top = DESIGNS[design].top();
const v = synthVerilog(top, 'mosfet_riscv');
writeFileSync(join(out, 'mosfet_riscv.v'), v.verilog);
// A relaxed clock: the point is a complete, legal layout, not maximum frequency, so the tools do not trade
// area for speed. Zero input / output delays: the memories outside the ports are not counted, as in ours.
writeFileSync(join(out, 'constraint.sdc'), `create_clock -name clk -period 40.0 [get_ports clk]
set_input_delay 0.0 -clock clk [delete_from_list [all_inputs] [get_ports clk]]
set_output_delay 0.0 -clock clk [all_outputs]
`);
writeFileSync(join(out, 'config.mk'), `export DESIGN_NICKNAME = mosfet_riscv
export DESIGN_NAME = mosfet_riscv
export PLATFORM    = sky130hd
export VERILOG_FILES = $(DESIGN_HOME)/src/$(DESIGN_NICKNAME)/mosfet_riscv.v
export SDC_FILE      = $(DESIGN_HOME)/$(PLATFORM)/$(DESIGN_NICKNAME)/constraint.sdc
export CORE_UTILIZATION = 35
export PLACE_DENSITY = 0.55
# keep the big modules (cores, memory) so cell names carry their block; flatten the rest
export SYNTH_HIERARCHICAL = 1
export SYNTH_MINIMUM_KEEP_SIZE = 2000
`);

// Our side. Blocks: the top level's instances holding at least 1 % of the NANDs (the flow's cell names start
// with the instance name); the rest is "other". Each with its Verilog module: Yosys reports the area of every
// module it kept whole (synth_stat.txt), which is the fair comparison (a flattened module's cells lose its name).
const nands = stats(top).nands;
const topText = /^module mosfet_riscv\b[\s\S]*?^endmodule/m.exec(v.verilog)![0];
const moduleOf = new Map([...topText.matchAll(/^ {2}(\S+) (\S+) \(/gm)].map((m) => [m[2], m[1].replace(/^\\/, '')]));
const blocks = netlistOf(top)!.instances
  .map((i) => ({ name: i.name, label: i.label ?? i.name, nands: stats(i.def).nands, module: moduleOf.get(i.name) ?? null }))
  .filter((b) => b.nands >= nands / 100)
  .sort((a, b) => b.nands - a.nands);
// outputs: a path into a port counts, as the flow's zero output delay counts it
const t = analyzeTiming(flatten(top, { mode: 'gate' }), { outputs: true })!;
// the critical path by block, one level down when a single block holds most of it (the dual-core's core0)
const byBlock = (depth: number) => {
  const st: { block: string; arrival: number }[] = [];
  for (const p of t.path) {
    const block = p.node.slice(0, depth).join('.');
    if (st.length && st[st.length - 1].block === block) st[st.length - 1].arrival = p.arrival;
    else st.push({ block, arrival: p.arrival });
  }
  return st;
};
let stages = byBlock(1);
if (stages.some((s, i) => s.arrival - (i ? stages[i - 1].arrival : 0) > t.period / 2)) stages = byBlock(2);
const source = {
  design, name: DESIGNS[design].name, id: top.id, nands, modules: v.modules, top: v.top, blocks,
  timing: { period: t.period, clkToQ: CLK_TO_Q, setup: SETUP, psPerNand: PS_PER_NAND, launch: t.launch.join('.'), capture: t.capture.join('.'), stages },
};
writeFileSync(join(out, 'source.json'), JSON.stringify(source, null, 1));
console.log(`wrote ${out}: ${design}, ${v.modules} modules, ${nands} NAND equivalents, period ${t.period} NAND delays, ${v.verilog.length} bytes`);
