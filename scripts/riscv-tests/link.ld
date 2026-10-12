/* Our CPUs are Harvard machines: code in the ROM from address 0, data in a RAM that wraps around its
   size. Data is linked at 0x10000, which is word 0 of any data memory up to 16 K words; tohost comes
   first so the harness watches word 0. */
OUTPUT_ARCH("riscv")
ENTRY(_start)

SECTIONS
{
  . = 0x0;
  .text : { *(.text.init) *(.text) *(.text.*) }
  . = 0x10000;
  .tohost : { *(.tohost) }
  .data : { *(.data) *(.data.*) *(.sdata) *(.sdata.*) *(.rodata) *(.rodata.*) *(.srodata) *(.srodata.*) }
  .bss : { *(.bss) *(.bss.*) *(.sbss) *(.sbss.*) }
  _end = .;
}
