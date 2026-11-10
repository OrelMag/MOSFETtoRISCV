/* riscv-vector-tests (scripts/rvv-tests/build.mjs): as scripts/riscv-tests/link.ld, with the data at 0x100000 because a
   generated test's code can pass 64 KB. 0x100000 is word 0 of any data memory up to 256 K words; tohost comes first, then a
   1 KB gap. */
OUTPUT_ARCH("riscv")
ENTRY(_start)

SECTIONS
{
  . = 0x0;
  .text : { *(.text.init) *(.text) *(.text.*) }
  . = 0x100000;
  .tohost : { *(.tohost) }
  /* a gap: a strided access with a negative stride reaches below its base (at most 4 bytes × 128 elements), and must not land on tohost */
  . = 0x100400;
  .data : { *(.data) *(.data.*) *(.sdata) *(.sdata.*) *(.rodata) *(.rodata.*) *(.srodata) *(.srodata.*) }
  .bss : { *(.bss) *(.bss.*) *(.sbss) *(.sbss.*) }
  _end = .;
}
