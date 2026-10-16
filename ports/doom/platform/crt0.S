/* Start-up code for the MOSFET -> RISC-V Doom machine (RV32IM + Zicsr, machine mode).
   Harvard: this code runs from the instruction ROM at 0; every data address is RAM. */

	.option arch, +zicsr
	.section .text.init, "ax"
	.globl _start
	.type _start, @function
_start:
	.option push
	.option norelax
	la	gp, __global_pointer$
	.option pop
	la	sp, __stack_top
	la	t0, trap_entry
	csrw	mtvec, t0

	/* zero .sbss / .bss (word aligned by the linker script) */
	la	t0, __bss_start
	la	t1, __bss_end
1:	bgeu	t0, t1, 2f
	sw	zero, 0(t0)
	addi	t0, t0, 4
	j	1b
2:
	li	a0, 0
	li	a1, 0
	call	main
	call	exit			/* runs atexit handlers, flushes stdio, then _exit halts */
	.globl	_halt
_halt:
	j	_halt
	.size _start, . - _start

/* Any exception: report it on the console and halt. The handler runs on whatever stack
   was live; it only needs a few words of it. */
	.balign 4
	.type trap_entry, @function
trap_entry:
	addi	sp, sp, -16
	csrr	a0, mcause
	csrr	a1, mepc
	csrr	a2, mtval
	call	mosfet_trap		/* never returns */
3:	j	3b
	.size trap_entry, . - trap_entry
