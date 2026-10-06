# Dump every placed instance (name, master, bounding box in µm) and the die and core areas.
read_db results/sky130hd/mosfet_riscv/base/6_final.odb
set block [ord::get_db_block]
set dbu [$block getDbUnitsPerMicron]
set f [open $::env(WORK)/layout/out/instances.csv w]
proc um {v} { global dbu; return [format %.3f [expr {$v / double($dbu)}]] }
set die [$block getDieArea]
set core [$block getCoreArea]
puts $f "#die,[um [$die xMin]],[um [$die yMin]],[um [$die xMax]],[um [$die yMax]]"
puts $f "#core,[um [$core xMin]],[um [$core yMin]],[um [$core xMax]],[um [$core yMax]]"
foreach inst [$block getInsts] {
  set b [$inst getBBox]
  puts $f "[$inst getName],[[$inst getMaster] getName],[um [$b xMin]],[um [$b yMin]],[um [$b xMax]],[um [$b yMax]]"
}
close $f
puts "dumped [llength [$block getInsts]] instances"
