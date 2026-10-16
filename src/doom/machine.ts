// The Doom computer (Appendix B): our system CPU (RV32IM + Zicsr, machine mode) with 8 MiB of RAM,
// the game data as a read-only region and a 320 × 200 indexed frame buffer. ports/doom/README.md is
// the program's side of the same map.
//
//   0x0000_0000  RAM, 8 MiB (data space; the instruction ROM is separate, as on all our CPUs)
//   0x1000_0000  WAD, read only: the file's bytes (length: WADLEN)
//   0x8000_0000  the system CPU's I/O registers, (addr >>> 2) & 7: 0 CONSOLE, 1 LEDS, 2 SWITCHES,
//                3 WADLEN, 4 MTIME, 5 MTIMECMP, 6 KEY (a read pops one event), 7 FLIP (a frame is done)
//   0xC000_0000  frame buffer: 320 × 200 bytes, a palette index each, row-major
//   0xC001_0000  palette: 256 words 0x00RRGGBB
//
// DoomDevices holds the devices; FastDoom (the fast interpreter) and GoldenDoom (the golden model,
// for lock-step checks) both route their non-RAM accesses to it.

import { FastISS, DEV } from '../riscv/fastiss';
import { ISS } from '../riscv/iss';
import type { DoomImage } from './image';

export const SCREEN_W = 320, SCREEN_H = 200;
export const RAM_WORDS = 1 << 21;
export const WAD_BASE = 0x10000000, FB_BASE = 0xc0000000, PALETTE_BASE = 0xc0010000;
export const REG = { WADLEN: 3, KEY: 6, FLIP: 7 } as const;
/** Nominal clock: game milliseconds = cycles / CLOCK_KHZ (the port extends mtime to 64 bits). */
export const CLOCK_KHZ = 40_000;

export class DoomDevices {
  /** The WAD, padded to whole words. */
  readonly wad: Uint8Array;
  readonly wadLength: number;
  private readonly wad32: Uint32Array;
  /** Frame buffer (64 000 bytes from 0) and palette (from 0x10000), 128 KiB. */
  readonly fb = new Uint8Array(0x20000);
  private readonly fb16 = new Uint16Array(this.fb.buffer);
  private readonly fb32 = new Uint32Array(this.fb.buffer);
  /** Key events not read yet: (pressed << 8) | Doom key code. */
  readonly keys: number[] = [];
  /** FLIP stores so far. */
  flips = 0;
  /** The last completed frame (palette indices) and its palette, copied at FLIP. */
  readonly shown = new Uint8Array(SCREEN_W * SCREEN_H);
  readonly shownPalette = new Uint32Array(256);
  onFlip: (() => void) | null = null;

  constructor(wad: Uint8Array) {
    this.wadLength = wad.length;
    this.wad = new Uint8Array((wad.length + 3) & ~3);
    this.wad.set(wad);
    this.wad32 = new Uint32Array(this.wad.buffer);
  }

  /** Press (true) or release a key: Doom reads it at its next tic. */
  key(code: number, pressed: boolean): void {
    this.keys.push((pressed ? 0x100 : 0) | (code & 0xff));
  }

  /** The 32-bit word at a WAD or frame-buffer address (undefined: not ours). */
  readWord(addr: number): number | undefined {
    if (addr >>> 28 === 1) {
      const o = addr - WAD_BASE;
      return o < this.wad.length ? this.wad32[o >>> 2] : 0;
    }
    if (addr >= FB_BASE) return this.fb32[(addr & 0x1ffff) >>> 2];
    return undefined;
  }

  /** A store to the WAD (ignored: read only) or the frame buffer; false: not ours. */
  write(addr: number, f3: number, v: number): boolean {
    if (addr >>> 28 === 1) return true;
    if (addr >= FB_BASE) {
      const o = addr & 0x1ffff;
      if (f3 === 0) this.fb[o] = v; else if (f3 === 2) this.fb32[o >>> 2] = v; else this.fb16[o >>> 1] = v;
      return true;
    }
    return false;
  }

  /** I/O register reads this machine adds (undefined: the CPU's own). */
  ioRead(reg: number): number | undefined {
    if (reg === REG.WADLEN) return this.wadLength;
    if (reg === REG.KEY) return this.keys.shift() ?? 0;
    return undefined;
  }

  /** I/O register writes this machine adds (false: the CPU's own). */
  ioWrite(reg: number): boolean {
    if (reg !== REG.FLIP) return false;
    this.flips++;
    this.shown.set(this.fb.subarray(0, SCREEN_W * SCREEN_H));
    this.shownPalette.set(this.fb32.subarray(PALETTE_BASE - FB_BASE >>> 2, (PALETTE_BASE - FB_BASE >>> 2) + 256));
    this.onFlip?.();
    return true;
  }

  /** A frame (default: the last shown) as RGBA pixels. */
  rgba(out = new Uint8ClampedArray(SCREEN_W * SCREEN_H * 4), live = false): Uint8ClampedArray {
    const px = live ? this.fb : this.shown;
    const pal = live ? this.fb32.subarray(PALETTE_BASE - FB_BASE >>> 2) : this.shownPalette;
    for (let i = 0, o = 0; i < SCREEN_W * SCREEN_H; i++, o += 4) {
      const c = pal[px[i]];
      out[o] = c >>> 16; out[o + 1] = c >>> 8; out[o + 2] = c; out[o + 3] = 255;
    }
    return out;
  }
}

/** Extract a byte / half / word (ISS.load's rules) from the word containing addr. */
function extract(w: number, addr: number, f3: number): number {
  const sh = (addr & 3) * 8;
  switch (f3) {
    case 0: return ((w >>> sh) << 24) >> 24;
    case 1: return ((w >>> (addr & 2) * 8) << 16) >> 16;
    case 4: return (w >>> sh) & 0xff;
    case 5: return (w >>> (addr & 2) * 8) & 0xffff;
    default: return w | 0;
  }
}

const opts = (img: DoomImage) => ({ system: true, m: true, dmemWords: RAM_WORDS, imemWords: Math.max(64, 2 ** Math.ceil(Math.log2(img.text.length))) });

/** Put the image's initial RAM words in place. */
function loadData(dmem: Uint32Array, img: DoomImage): void {
  dmem.set(img.data, img.dataBase >>> 2);
}

/** The Doom computer on the fast interpreter. */
export class FastDoom extends FastISS {
  constructor(readonly image: DoomImage, readonly dev: DoomDevices) {
    super(image.text, opts(image));
    loadData(this.dmem, image);
    this.region[1] = DEV;
  }

  protected override load(addr: number, f3: number): number {
    const w = this.dev.readWord(addr);
    return w === undefined ? super.load(addr, f3) : extract(w, addr, f3);
  }

  protected override store(addr: number, f3: number, v: number): void {
    if (!this.dev.write(addr, f3, v)) super.store(addr, f3, v);
  }

  protected override ioRead(addr: number): number {
    return this.dev.ioRead((addr >>> 2) & 7) ?? super.ioRead(addr);
  }

  protected override ioWrite(addr: number, f3: number, v: number): void {
    if (!this.dev.ioWrite((addr >>> 2) & 7)) super.ioWrite(addr, f3, v);
  }
}

/** The Doom computer on the golden model (slow: for lock-step checks of FastDoom). */
export class GoldenDoom extends ISS {
  constructor(readonly image: DoomImage, readonly dev: DoomDevices) {
    super([...image.text], opts(image));
    loadData(this.dmem, image);
  }

  override load(addr: number, f3: number): number {
    addr >>>= 0;
    const w = addr >= 0x80000000 && addr < FB_BASE ? this.dev.ioRead((addr >>> 2) & 7) : this.dev.readWord(addr);
    return w === undefined ? super.load(addr, f3) : extract(w >>> 0, addr, f3);
  }

  override store(addr: number, f3: number, v: number): void {
    addr >>>= 0;
    if (addr >= 0x80000000 && addr < FB_BASE ? this.dev.ioWrite((addr >>> 2) & 7) : this.dev.write(addr, f3, v)) return;
    super.store(addr, f3, v);
  }
}
