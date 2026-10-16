// The memory map of chapter 35's computer, as the golden model sees it: RAM from address 0 (code beyond
// the boot ROM and every load and store below the flash), the flash read-only at 0x1000_0000, the DMA
// engine's registers at 0x4000_0000, nothing elsewhere (reads 0). The DMA copies at once when started:
// the hardware takes cycles (two bus transactions a word) but leaves the same memory.

/** A memory the golden model reads and writes instead of its own (riscv/iss.ts IssOptions.bus). */
export interface BusMemory {
  /** The word at a word-aligned address. */
  read(addr: number): number;
  /** Write the bytes of `value` whose bit is set in `strb` (bit i: byte i). */
  write(addr: number, value: number, strb: number): void;
}

/** Top address nibble of each region (lib/axi.ts BUS_MAP and the SoC's decoder agree). */
export const MAP = { ram: 0x0, flash: 0x1, dma: 0x4 } as const;

export class BusModel implements BusMemory {
  readonly ram: Uint32Array;
  readonly flash: Uint32Array;
  dma = { src: 0, dst: 0, len: 0, done: false };
  /** Words copied by DMA so far (all at once, at each start). */
  copied = 0;

  constructor(ramK: number, flashImage: ArrayLike<number> = [], flashWords = 4096) {
    this.ram = new Uint32Array(2 ** ramK);
    this.flash = new Uint32Array(flashWords).fill(0xffffffff);
    for (let i = 0; i < Math.min(flashImage.length, flashWords); i++) this.flash[i] = flashImage[i] >>> 0;
  }

  /** The DMA's interrupt line. */
  get irq(): boolean { return this.dma.done; }

  read(addr: number): number {
    const a = addr >>> 0, nib = a >>> 28, w = (a >>> 2);
    if (nib === MAP.ram) return this.ram[w & (this.ram.length - 1)];
    if (nib === MAP.flash) return this.flash[w & (this.flash.length - 1)];
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
    if (nib === MAP.ram) {
      const i = w & (this.ram.length - 1);
      let m = 0;
      for (let b = 0; b < 4; b++) if ((strb >> b) & 1) m |= 0xff << (8 * b);
      this.ram[i] = ((this.ram[i] & ~m) | (value & m)) >>> 0;
    } else if (nib === MAP.dma) {
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
