/* The MOSFET -> RISC-V Doom machine: Harvard. Instructions live in their own ROM (fetched
   at pc >>> 2, linked at 0); loads and stores see only the 8 MiB RAM at 0 (the NULL page
   at 0x0000-0x0FFF is left free), the WAD at 0x1000_0000 and the devices. The two address
   spaces overlap on purpose, so the build links with --no-check-sections. */

OUTPUT_ARCH(riscv)
ENTRY(_start)

MEMORY
{
  ROM (rx)  : ORIGIN = 0x00000000, LENGTH = 4M
  RAM (rw)  : ORIGIN = 0x00001000, LENGTH = 8M - 4K
}

__stack_top = 0x00800000;
/* _sbrk keeps at least this much between the heap and the stack top */
__stack_reserve = 256K;

SECTIONS
{
  .text : {
    KEEP(*(.text.init))
    *(.text.unlikely .text.unlikely.*)
    *(.text.startup .text.startup.*)
    *(.text .text.*)
    *(.gnu.linkonce.t.*)
    . = ALIGN(4);
  } > ROM

  /* Everything below is data, in RAM: no constant may land in the instruction ROM. */
  .rodata : {
    __data_start = .;
    *(.rodata .rodata.*)
    *(.gnu.linkonce.r.*)
    . = ALIGN(4);
  } > RAM

  .init_array : {
    PROVIDE_HIDDEN(__preinit_array_start = .);
    KEEP(*(.preinit_array))
    PROVIDE_HIDDEN(__preinit_array_end = .);
    PROVIDE_HIDDEN(__init_array_start = .);
    KEEP(*(SORT_BY_INIT_PRIORITY(.init_array.*) SORT_BY_INIT_PRIORITY(.ctors.*)))
    KEEP(*(.init_array .ctors))
    PROVIDE_HIDDEN(__init_array_end = .);
    PROVIDE_HIDDEN(__fini_array_start = .);
    KEEP(*(SORT_BY_INIT_PRIORITY(.fini_array.*) SORT_BY_INIT_PRIORITY(.dtors.*)))
    KEEP(*(.fini_array .dtors))
    PROVIDE_HIDDEN(__fini_array_end = .);
    . = ALIGN(4);
  } > RAM

  .data : {
    *(.data .data.*)
    *(.gnu.linkonce.d.*)
    . = ALIGN(8);
  } > RAM

  .sdata : {
    __global_pointer$ = . + 0x800;
    *(.srodata.cst16) *(.srodata.cst8) *(.srodata.cst4) *(.srodata.cst2) *(.srodata .srodata.*)
    *(.sdata .sdata.* .gnu.linkonce.s.*)
    . = ALIGN(4);
    __data_end = .;
  } > RAM

  .sbss (NOLOAD) : {
    __bss_start = .;
    *(.sbss .sbss.* .gnu.linkonce.sb.*)
    *(.scommon)
  } > RAM

  .bss (NOLOAD) : {
    *(.bss .bss.*)
    *(.gnu.linkonce.b.*)
    *(COMMON)
    . = ALIGN(8);
    __bss_end = .;
  } > RAM

  _end = .;
  end = .;

  /DISCARD/ : { *(.eh_frame .eh_frame_hdr .note.* .comment) }
}
