#!/usr/bin/env bash
# Runs inside the openroad/orfs container. Synthesizes, places and routes layout/design with
# OpenROAD-flow-scripts on sky130hd, then dumps the placement and renders the GDS as image tiles.
set -uo pipefail
export WORK=${WORK:-/work}
ORFS=${ORFS:-/OpenROAD-flow-scripts}
OUT=$WORK/layout/out
mkdir -p "$OUT"
cd "$ORFS"
[ -f ./env.sh ] && source ./env.sh
cd flow
mkdir -p designs/sky130hd/mosfet_riscv designs/src/mosfet_riscv
cp "$WORK/layout/design/config.mk" "$WORK/layout/design/constraint.sdc" designs/sky130hd/mosfet_riscv/
cp "$WORK/layout/design/mosfet_riscv.v" designs/src/mosfet_riscv/
CFG=designs/sky130hd/mosfet_riscv/config.mk
start=$(date +%s)
make DESIGN_CONFIG=$CFG 2>&1 | tee "$OUT/flow.log"
status=${PIPESTATUS[0]}
echo "{\"seconds\": $(( $(date +%s) - start )), \"status\": $status}" > "$OUT/run.json"
# keep the reports, metrics and logs, whatever happened
for d in reports logs; do [ -d "$d/sky130hd/mosfet_riscv" ] && cp -r "$d/sky130hd/mosfet_riscv" "$OUT/$d"; done
RES=results/sky130hd/mosfet_riscv/base
if [ "$status" -ne 0 ] || [ ! -f "$RES/6_final.odb" ]; then echo "flow failed ($status)"; exit 1; fi
openroad -no_init -exit "$WORK/scripts/layout/dump.tcl" 2>&1 | tail -5
LYP=$(ls platforms/sky130hd/*.lyp 2>/dev/null | head -1)
if command -v klayout >/dev/null && [ -f "$RES/6_final.gds" ]; then
  mkdir -p "$OUT/tiles"
  klayout -zz -r "$WORK/scripts/layout/render.py" -rd gds="$RES/6_final.gds" -rd lyp="$LYP" -rd out="$OUT/tiles" 2>&1 | tail -5
else
  echo "klayout or the GDS is missing: no tiles"
fi
ls -la "$OUT"
