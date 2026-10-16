# Doom for the Doom computer

Doom, built for the site's RV32IM machine: the C engine of
[doomgeneric](https://github.com/ozkl/doomgeneric) (a portable fork of Chocolate Doom), plus a small
platform layer for our memory map. The build produces `public/doom/doom.img` (instruction ROM and
initial RAM) and `public/doom/doom.syms.json` (every function's address, size and name), which the
site's interpreter runs with Freedoom's `freedoom1.wad`.

## Licence

This directory and the image built from it (`public/doom/doom.img`, `doom.syms.json`) are under the
**GNU General Public License, version 2** (`LICENSE`, upstream's copy), like Doom's source release.
The rest of the site is MIT. The game data, Freedoom, is BSD-licensed and is never checked in:
`scripts/doom/fetch-wad.mjs` downloads it into `.cache/doom/` (with its `COPYING.txt`).

## Upstream

- `doomgeneric/`: <https://github.com/ozkl/doomgeneric>, commit
  `e257a09527062bfb986b6e5e0780839b6cbd5b71` (2026-10-11), its `doomgeneric/` directory only.
- Removed from the vendored copy (platform front ends, sound back ends, build files we do not use):
  `Makefile*`, `doomgeneric.vcxproj*`, `doomgeneric_{allegro,emscripten,linuxvt,sdl,soso,sosox,win,xlib}.c`,
  `i_allegromusic.c`, `i_allegrosound.c`, `i_sdlmusic.c`, `i_sdlsound.c`, `icon.c`, `gusconf.[ch]`,
  `mus2mid.[ch]`. Every remaining `.c` file is compiled (the list is in `scripts/doom/build.mjs`).

### Patches to upstream files

All are under `#ifdef MOSFET_RISCV` (the build defines it), so `diff` against upstream shows each one:

1. `w_file.c`, `W_OpenFile`: open every WAD with `mosfet_wad_file` (platform/w_file_mosfet.c), whose
   `mapped` points at the WAD in memory, so `W_CacheLumpNum` returns lumps in place, copying nothing.
2. `i_video.c`: `I_InitGraphics` sets `I_VideoBuffer` to the frame buffer at `0xC000_0000` (no zone
   allocation; Doom's renderer stores straight into it); `I_ShutdownGraphics` does not free it;
   `I_FinishUpdate` only calls `DG_DrawFrame` (a store to FLIP) instead of converting to 32-bit pixels;
   `I_SetPalette` also writes the 256 palette registers (after Doom's gamma table, as upstream).
3. `doomgeneric.c`: no `DG_ScreenBuffer` (it would take 1 MiB of RAM and nothing reads it).
4. `i_system.c`, `I_Quit`: `exit(0)` at the end, so quitting from the menu halts the machine
   (upstream returns and the game carries on).
5. `g_game.c`, `G_DoSaveGame`: when the save file cannot be opened, print a line and show
   "CAN'T SAVE: NO STORAGE ON THIS MACHINE" instead of `I_Error` (which would end the program).

## The machine

RV32IM + Zicsr in machine mode, as the golden model `src/riscv/iss.ts` with `system: true, m: true`.

- Harvard: instructions are fetched from their own ROM (word `pc >>> 2`), linked at 0. Loads and
  stores never see it, so everything else (`.rodata`, `.srodata`, `.data`, `.sdata`, `.bss`,
  `.sbss`, heap, stack) is in RAM (`platform/link.ld`; the build refuses an image with data in the ROM).
- RAM: 8 MiB at `0x0000_0000` (wraps). Data starts at `0x0000_1000` (the NULL page is left free;
  reading it returns memory). Stack top `0x0080_0000`; the heap runs from the end of `.bss`, and
  `_sbrk` keeps 256 KiB below the stack top free.
- The WAD: read-only, mapped at `0x1000_0000`; its length is the WADLEN register. Lumps are used in
  place, so every lump the engine reads with halfword or word loads must be aligned: all 3163 lumps
  of `freedoom1.wad` start on a 4-byte boundary. A WAD that is not aligned would trap.
- Devices (word access, register `(addr >>> 2) & 7` above `0x8000_0000`): CONSOLE `0x8000_0000`
  (stdout and stderr), LEDS, SWITCHES, WADLEN `0x8000_000C`, MTIME `0x8000_0010` (a 32-bit cycle
  counter, extended to 64 bits in software; 40 MHz nominal), MTIMECMP, KEY `0x8000_0018` (pops an
  event: bit 8 pressed, bits 7:0 a `doomkeys.h` code; doomgeneric takes one release per tic),
  FLIP `0x8000_001C`.
- Frame buffer `0xC000_0000` (320 × 200 palette indices, row-major); palette `0xC001_0000 + 4 i`
  (`0x00RRGGBB`).
- The program halts with a jump to itself: after `exit` / `I_Error` (the message is on the console
  first, then `[exit n]`), and in the trap handler, which prints `trap mcause=… mepc=… mtval=…`.

## Memory budget

| | bytes |
|---|---|
| text (ROM, not in RAM) | ~226 KiB |
| `.rodata` + `.data` + `.sdata` | ~157 KiB |
| `.bss` + `.sbss` | ~235 KiB |
| zone (`-mb 6`) | 6 MiB |
| other `malloc` (lump directory, hash table, …) | ~90 KiB measured |
| free between the heap and the stack's reserve | ~1.3 MiB |
| stack reserve | 256 KiB (a few KiB used, measured over the title and a demo) |

The zone is 6 MiB (`ZONE_MB` in the build script, passed to Doom as `-mb`): upstream's default,
and far more than a mapped WAD needs, since lumps are never copied into it (only level data,
textures composed from patches, and the like). 7 MiB would also fit, with ~300 KiB to spare.

## What does not work

- Sound and music: there is no sound device (`i_sound.c` without `FEATURE_SOUND`).
- Saving: there is no writable storage. `_open` fails for anything but the IWAD, so the config is
  never written (Doom ignores that), save slots read as empty, and saving shows a message.
- No mouse, joystick or network.

## Building

```
node scripts/doom/fetch-wad.mjs      # once: Freedoom into .cache/doom/ (pinned URL and sha256)
node scripts/doom/build.mjs          # ports/doom/build/doom.elf -> public/doom/doom.img + doom.syms.json
node scripts/doom/run-raw.mjs        # dev check: a separate strict interpreter, to the title screen
```

The compiler is the xPack GNU RISC-V Embedded GCC 15.2.0-1 (`riscv-none-elf-gcc`, newlib-nano,
multilib `rv32im/ilp32`), from
<https://github.com/xpack-dev-tools/riscv-none-elf-gcc-xpack/releases/tag/v15.2.0-1>. The build looks
for it at `E:/toolchains/xpack-riscv-none-elf-gcc-15.2.0-1/`, or takes `--cc <path>` or `$DOOM_CC`,
else `riscv-none-elf-gcc` on the PATH. Flags: `-march=rv32im -mabi=ilp32 -O2 -std=gnu99 -fpermissive`
(the engine is C89-era code), `-ffunction-sections -fdata-sections`, linked with `--specs=nano.specs
-nostartfiles -Wl,--gc-sections` and `platform/link.ld`. The same compiler gives the same image,
byte for byte. Text size: 192 KiB at `-Os`, 226 KiB at `-O2`, 273 KiB at `-O3`.

`doom.img` is little-endian 32-bit words: `0x4D495652` ('RVIM'), version 1, entry, textBase,
textWords, dataBase, dataWords, bssEnd; then textWords instruction words; then dataWords initial
RAM words from dataBase (`.bss` is not stored: it is zero).

## Files

- `doomgeneric/`: the engine (upstream, patched as listed above).
- `platform/crt0.S`: start-up (gp, sp, mtvec, zero `.bss`, `main`, `exit`, halt) and the trap entry.
- `platform/link.ld`: the Harvard memory map.
- `platform/syscalls.c`: newlib's system calls (console, the IWAD as the only file, `_sbrk`, halt).
- `platform/doomgeneric_mosfet.c`: `DG_*` and `main` (`doom -iwad freedoom1.wad -mb 6 -nogui`).
- `platform/w_file_mosfet.c`: the memory-mapped WAD file class.
- `platform/mosfet.h`: the memory map and device registers.
