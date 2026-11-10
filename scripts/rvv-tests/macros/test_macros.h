// riscv-vector-tests' macros (macros/general/test_macros.h, BSD-licensed, from riscv-tests) with one change: TEST_CASE
// compares against an immediate (li) where the original loads the expected value from a .quad placed in the code.
// Our CPUs are Harvard machines (the code in a ROM, loads from the data memory), so a load from the text segment
// would read the data memory instead. The comparison, the test numbers and the jump to fail are otherwise the same.
#include_next "test_macros.h"

#undef TEST_CASE
#define TEST_CASE( testnum, testreg, correctval, code... ) \
test_ ## testnum: \
    li  TESTNUM, testnum; \
    code; \
    li  x7, MASK_XLEN(correctval); \
    beq testreg, x7, test_ ## testnum ## _success; \
    la  x7, fail; \
    jr  x7; \
test_ ## testnum ## _success:
