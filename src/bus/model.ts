// The memory map of chapter 35's computer, as the golden model sees it: RAM from address 0 (code beyond
// the boot ROM and every load and store below the flash), the flash read-only at 0x1000_0000, the DRAM at
// 0x2000_0000, the DMA engine's registers at 0x4000_0000, the screen's frame buffer at 0x5000_0000, the
// keyboard at 0x6000_0000, the card reader at 0x7000_0000, nothing elsewhere (reads 0). The DMA copies at once
// when started: the hardware takes cycles (two bus transactions a word) but leaves the same memory. DRAM, screen,
// keyboard and card reader exist only when the computer has them (BusDevices), as in lib/soc.ts busComputer.
//
// The card reader is the one device whose answer depends on time (a card arrives `feed` edges after the last was
// taken), so the model counts clock edges too: whoever steps the golden model sets `now` to the rising edges so far
// before each instruction (CardModel says which edge a read saw).

/** A memory the golden model reads and writes instead of its own (riscv/iss.ts IssOptions.bus). */
export interface BusMemory {
  /** The word at a word-aligned address. */
  read(addr: number): number;
  /** Write the bytes of `value` whose bit is set in `strb` (bit i: byte i). */
  write(addr: number, value: number, strb: number): void;
}

/** Top address nibble of each region (lib/axi.ts BUS_MAP and the SoC's decoder agree). */
export const MAP = { ram: 0x0, flash: 0x1, dram: 0x2, dma: 0x4, screen: 0x5, keys: 0x6, cards: 0x7 } as const;

/** A card reader's deck as the model reads it: a word a card, and the edges between taking a card and the next one. */
export interface CardDeck { items: readonly number[]; feed: number }

/** The optional slaves: a DRAM of 2^dramK words, an n × n screen (a byte a pixel), a keyboard, a card reader. */
export interface BusDevices { dramK?: number; screen?: number; keys?: boolean; cards?: CardDeck }

/**
 * Edges between the reader's state a load sees and the edge the load retires at: the slave latches STATUS or DATA
 * at the read's address handshake (the reader's outputs before that edge, i.e. its state after now − 2 edges), and
 * the CPU retires the load at the next edge, when the answer arrives.
 */
export const CARD_LAG = 2;

/**
 * The card reader (cards/reader.ts) and its slave (lib/axi.ts AXI_CARDS), edge by edge. A read of DATA with a card
 * waiting takes it at the edge after the answer (the slave's `next` flip-flop): the next card is at the station
 * `feed` edges later. State "after s edges" is what the reader's outputs show between edge s and edge s + 1.
 */
export class CardModel {
  /** Cards taken. */
  i = 0;
  /** The current card is at the station from state readyAt on. */
  private readyAt = 0;
  /** The edge a pending take happens at (-1: none). */
  private takeAt = -1;
  constructor(readonly items: readonly number[], readonly feed: number) {}

  private settle(s: number): void {
    if (this.takeAt >= 0 && this.takeAt <= s) {
      this.i++;
      this.readyAt = this.takeAt + this.feed;
      this.takeAt = -1;
    }
  }

  /** Is a card at the station in state s (after s edges)? */
  ready(s: number): boolean { this.settle(s); return this.i < this.items.length && s >= this.readyAt; }
  /** Has the last card been taken by state s? */
  empty(s: number): boolean { this.settle(s); return this.i >= this.items.length; }
  /** STATUS as read in state s. */
  status(s: number): number { return (this.ready(s) ? 1 : 0) | (this.empty(s) ? 2 : 0); }
  /** DATA as read in state s: the card's word, which is then taken (0 and nothing taken when none waits). */
  data(s: number): number {
    if (!this.ready(s)) return 0;
    this.takeAt = s + 2;
    return this.items[this.i] >>> 0;
  }
}

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
  /** The card reader (STATUS at 0x7000_0000, DATA at +4). */
  readonly cards: CardModel | null;
  /** Rising clock edges so far (set by whoever steps the golden model; only the card reader needs it). */
  now = 0;
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
    this.cards = dev.cards ? new CardModel(dev.cards.items, dev.cards.feed) : null;
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
    if (nib === MAP.cards && this.cards) { const s = this.now - CARD_LAG; return w & 1 ? this.cards.data(s) : this.cards.status(s); }
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
