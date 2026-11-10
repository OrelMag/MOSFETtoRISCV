// The bare environment (scripts/riscv-tests/env/bare: no CSRs, no traps, tohost at word 0 of the data memory) for the
// generated riscv-vector-tests: they open with RVTEST_RV32UVX (Zve32x). Nothing to enable: our CPUs have no mstatus.VS,
// the vector unit is always on.
#include "../../riscv-tests/env/bare/riscv_test.h"

#define RVTEST_RV32UV RVTEST_RV32U
#define RVTEST_RV32UVX RVTEST_RV32U
