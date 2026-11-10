# Every endpoint's worst setup path after routing, for scripts/sky-paths.ts (our load-model estimate path by path).
# Loads the final database as ORFS's final report does (the typical-corner library, the parasitics it extracted),
# then writes one full path per endpoint: flip-flop data pins and output ports. (This OpenSTA warns "unknown field nets";
# an unknown field only warns, so both spellings are passed and the net lines come out either way.)
read_liberty platforms/sky130hd/lib/sky130_fd_sc_hd__tt_025C_1v80.lib
set res results/sky130hd/mosfet_riscv/base
read_db $res/6_final.odb
read_sdc $res/6_final.sdc
source platforms/sky130hd/setRC.tcl
set_propagated_clock [all_clocks]
if {[file exists $res/6_final.spef]} {
  read_spef $res/6_final.spef
  puts "parasitics: 6_final.spef"
} else {
  define_process_corner -ext_model_index 0 X
  extract_parasitics -ext_model_file platforms/sky130hd/rcx_patterns.rules
  puts "parasitics: extracted here"
}
file mkdir $::env(WORK)/layout/out/paths
report_checks -path_delay max -group_path_count 1000000 -endpoint_path_count 1 \
  -fields {input_pins slew cap fanout net nets} -digits 3 > $::env(WORK)/layout/out/paths/paths_max.rpt
puts "paths written: [file size $::env(WORK)/layout/out/paths/paths_max.rpt] bytes"
