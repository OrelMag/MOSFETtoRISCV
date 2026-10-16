// The memory map of chapter 35's computer, as the golden model sees it: RAM from address 0 (code beyond
// the boot ROM and every load and store below the flash), the flash read-only at 0x1000_0000, the DRAM at
// 0x2000_0000, the DMA engine's registers at 0x4000_0000, the screen's frame buffer at 0x5000_0000, the
// keyboard at 0x6000_0000, nothing elsewhere (reads 0). The DMA copies at once when started: the hardware
// takes cycles (two bus transactions a word) but leaves the same memory. DRAM, screen and keyboard exist
// only when the computer has them (BusDevices), as in lib/soc.ts busComputer.

/** A memory the golden model reads and writes instead of its own (riscv/iss.ts IssOptions.bus). */
export interface BusMemory {
  /** The word at a word-aligned address. */
  read(addr: number): number;
  /** Write the bytes of `value` whose bit is set in `strb` (bit i: byte i). */
  write(addr: number, value: number, strb: number): void;
}

/** Top address nibble of each region (lib/axi.ts BUS_MAP and the SoC's decoder agree). */
export const MAP = { ram: 0x0, flash: 0x1, dram: 0x2, dma: 0x4, screen: 0x5, keys: 0x6 } as const;

/** The optional slaves: a DRAM of 2^dramK words, an n × n screen (a byte a pixel), a keyboard. */
export interface BusDevices { dramK?: number; screen?: number; keys?: boolean }

/** Merge the strobed bytes of `value` into `old`. */
const merge = (old: number, value: number, strb: number) => {
  let m = 0;
  for (let b = 0; b < 4; b++) if ((strb >> b) & 1) m |= 0xff << (8 * b);
  return ((old & ~m) | (value & m)) >>> 0;
};

export class BusModel implements BusMemory {
  readonly ram: Uint32Array;
  readonly flash: Uint32Array;
  readonly dram: Uint32Array | null;
  /** The screen's frame buffer: n·n bytes, four pixels a word (pixel (x, y) at byte n·y + x). */
  readonly screen: Uint32Array | null;
  /** Keys waiting, oldest first (a read of 0x6000_0000 takes one). */
  readonly keys: number[] | null;
  dma = { src: 0, dst: 0, len: 0, done: false };
  /** Words copied by DMA so far (all at once, at each start). */
  copied = 0;

  constructor(ramK: number, flashImage: ArrayLike<number> = [], flashWords = 4096, dev: BusDevices = {}) {
    this.ram = new Uint32Array(2 ** ramK);
    this.flash = new Uint32Array(flashWords).fill(0xffffffff);
    for (let i = 0; i < Math.min(flashImage.length, flashWords); i++) this.flash[i] = flashImage[i] >>> 0;
    this.dram = dev.dramK ? new Uint32Array(2 ** dev.dramK) : null;
    this.screen = dev.screen ? new Uint32Array((dev.screen * dev.screen) / 4) : null;
    this.keys = dev.keys ? [] : null;
  }

  /** The DMA's interrupt line. */
  get irq(): boolean { return this.dma.done; }

  read(addr: number): number {
    const a = addr >>> 0, nib = a >>> 28, w = (a >>> 2);
    if (nib === MAP.ram) return this.ram[w & (this.ram.length - 1)];
    if (nib === MAP.flash) return this.flash[w & (this.flash.length - 1)];
    if (nib === MAP.dram && this.dram) return this.dram[w & (this.dram.length - 1)];
    if (nib === MAP.screen && this.screen) return this.screen[w & (this.screen.length - 1)];
    if (nib === MAP.keys && this.keys) return w & 1 ? (this.keys.length ? 1 : 0) : (this.keys.shift() ?? 0);
    if (nib === MAP.dma) {
      switch (w & 3) {
        case 0: return this.dma.src;
        case 1: return this.dma.dst;
        case 2: return this.dma.len & 0xffff;
        default: return this.dma.done ? 2 : 0;
      }
    }
    return 0;
  }

  write(addr: number, value: number, strb: number): void {
    const a = addr >>> 0, nib = a >>> 28, w = a >>> 2;
    const store = (m: Uint32Array) => { const i = w & (m.length - 1); m[i] = merge(m[i], value, strb); };
    if (nib === MAP.ram) store(this.ram);
    else if (nib === MAP.dram && this.dram) store(this.dram);
    else if (nib === MAP.screen && this.screen) store(this.screen);
    else if (nib === MAP.dma) {
      switch (w & 3) {
        case 0: this.dma.src = value >>> 0; break;
        case 1: this.dma.dst = value >>> 0; break;
        case 2: this.dma.len = value & 0xffff; break;
        default:
          if (value & 2) this.dma.done = false;
          if (value & 1 && this.dma.len) this.copy();
      }
    }
  }

  private copy(): void {
    const d = this.dma;
    while (d.len) {
      this.write(d.dst, this.read(d.src), 15);
      d.src = (d.src + 4) >>> 0;
      d.dst = (d.dst + 4) >>> 0;
      d.len--;
      this.copied++;
    }
    d.done = true;
  }
}
