/* The MOSFET -> RISC-V Doom machine: memory map and device registers.
   Devices: address bit 31 set, below 0xC000_0000; register = (addr >>> 2) & 7, word access. */
#ifndef MOSFET_H
#define MOSFET_H

#include <stdint.h>

#define MOSFET_IO(r)      (*(volatile uint32_t *)(0x80000000u + 4u * (r)))
#define MOSFET_CONSOLE    MOSFET_IO(0)   /* write: low byte = a character */
#define MOSFET_LEDS       MOSFET_IO(1)
#define MOSFET_SWITCHES   MOSFET_IO(2)
#define MOSFET_WADLEN     MOSFET_IO(3)   /* read: the WAD's length in bytes */
#define MOSFET_MTIME      MOSFET_IO(4)   /* read: cycles, 32 bits, wraps */
#define MOSFET_MTIMECMP   MOSFET_IO(5)
#define MOSFET_KEY        MOSFET_IO(6)   /* read pops an event: 0 none, bit 8 pressed, bits 7:0 Doom key */
#define MOSFET_FLIP       MOSFET_IO(7)   /* write: the frame buffer holds a complete frame */

#define MOSFET_WAD        ((const unsigned char *)0x10000000u)
#define MOSFET_FB         ((unsigned char *)0xC0000000u)   /* 320 x 200 palette indices */
#define MOSFET_PALETTE    ((volatile uint32_t *)0xC0010000u) /* 256 x 0x00RRGGBB */

/* nominal clock: 40 MHz */
#define MOSFET_HZ         40000000u
#define MOSFET_CYCLES_PER_MS (MOSFET_HZ / 1000u)

/* The IWAD name main() passes with -iwad; _open maps it onto MOSFET_WAD. */
#define MOSFET_IWAD_NAME  "freedoom1.wad"

uint64_t mosfet_cycles(void);
void mosfet_halt(void) __attribute__((noreturn));
void mosfet_puts(const char *s);

#endif
