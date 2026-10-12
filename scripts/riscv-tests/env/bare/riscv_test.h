// The "bare" environment for the official riscv-tests, for our CPUs without CSRs or traps (single-cycle,
// multicycle, pipelined, F). The test bodies (isa/rv64ui/*.S, isa/macros/scalar/test_macros.h) are
// unchanged; only the environment differs from env/p: no trap vector, no ecall. Same contract: the test
// number in gp, tohost written with 1 (pass) or (test << 1) | 1 (fail), then the hart halts on a jump to
// itself. With MOSFET_MP every hart but hart 0 parks (csrr mhartid, as env/p does).

#ifndef _ENV_MOSFET_BARE_H
#define _ENV_MOSFET_BARE_H

#include "encoding.h"

#define RVTEST_RV32U .macro init; .endm
#define RVTEST_RV64U RVTEST_RV32U
#define RVTEST_RV32UF .macro init; csrwi fcsr, 0; .endm
#define RVTEST_RV64UF RVTEST_RV32UF

#define INIT_XREG \
  li x1, 0; li x2, 0; li x3, 0; li x4, 0; li x5, 0; li x6, 0; li x7, 0; li x8, 0; \
  li x9, 0; li x10, 0; li x11, 0; li x12, 0; li x13, 0; li x14, 0; li x15, 0; li x16, 0; \
  li x17, 0; li x18, 0; li x19, 0; li x20, 0; li x21, 0; li x22, 0; li x23, 0; li x24, 0; \
  li x25, 0; li x26, 0; li x27, 0; li x28, 0; li x29, 0; li x30, 0; li x31, 0;

#ifdef MOSFET_MP
#define RISCV_MULTICORE_DISABLE csrr a0, mhartid; 1: bnez a0, 1b;
#else
#define RISCV_MULTICORE_DISABLE
#endif

// Word 0 is a jal: the loader (tests/verify/images.ts) points it at the data initialisation it appends.
#define RVTEST_CODE_BEGIN \
        .section .text.init; \
        .align 2; \
        .globl _start; \
_start: \
        j reset_vector; \
reset_vector: \
        INIT_XREG; \
        RISCV_MULTICORE_DISABLE; \
        li TESTNUM, 0; \
        init; \

#define RVTEST_CODE_END unimp

#define TESTNUM gp

#define RVTEST_PASS \
        li TESTNUM, 1; \
        sw TESTNUM, tohost, t5; \
1:      j 1b;

#define RVTEST_FAIL \
1:      beqz TESTNUM, 1b; \
        sll TESTNUM, TESTNUM, 1; \
        or TESTNUM, TESTNUM, 1; \
        sw TESTNUM, tohost, t5; \
1:      j 1b;

#define EXTRA_DATA

#define RVTEST_DATA_BEGIN \
        EXTRA_DATA \
        .pushsection .tohost,"aw",@progbits; \
        .align 2; .global tohost; tohost: .word 0; .size tohost, 4; \
        .popsection; \
        .align 4; .global begin_signature; begin_signature:

#define RVTEST_DATA_END .align 4; .global end_signature; end_signature:

#endif
