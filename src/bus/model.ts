import { idleIn, NicCore, type NicIn, type NicOut } from '../comm/nic';
import { UartCore, type UartIn } from '../comm/uart';
// The memory map of chapter 38's computer, as the golden model sees it: RAM from address 0 (code beyond
// the boot ROM and every load and store below the flash), the flash read-only at 0x1000_0000, the DRAM at
// 0x2000_0000, the DMA engine's registers at 0x4000_0000, the screen's frame buffer at 0x5000_0000, the
// keyboard at 0x6000_0000, the card reader at 0x7000_0000, nothing elsewhere (reads 0). The DMA copies at once
// when started: the hardware takes cycles (two bus transactions a word) but leaves the same memory. DRAM, screen,
// keyboard and card reader exist only when the computer has them (BusDevices), as in lib/soc.ts busComputer.
//
// The UART is the other one (UartDevice).
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
export const MAP = { ram: 0x0, flash: 0x1, dram: 0x2, uart: 0x3, dma: 0x4, screen: 0x5, keys: 0x6, cards: 0x7, nic: 0x7 } as const;

/** A card reader's deck as the model reads it: a word a card, and the edges between taking a card and the next one. */
export interface CardDeck { items: readonly number[]; feed: number }

/** The optional slaves: a DRAM of 2^dramK words, an n × n screen (a byte a pixel), a keyboard, a card reader. */
export interface BusDevices {
  dramK?: number; screen?: number; keys?: boolean; cards?: CardDeck;
  /** A UART at 0x3000_0000 (comm/uart.ts UartCore); `rx` is the line level at its pin before edge e (zero-based), default idle. */
  uart?: { rx?: (edge: number) => number };
  /** A NIC at 0x7000_0000 (comm/nic.ts NicCore stepped edge by edge, its descriptors and frames in this model's RAM); `line` gives the serial pair at its pins before edge e. */
  nic?: { line?: (edge: number) => { rxd: number; crs: number } };
  /** Where each region sits (its top address nibble), when not at MAP: the memory-map designer's applied map (editor/memmap.ts busMapOf). */
  map?: Partial<Record<keyof typeof MAP, number>>;
}

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

/** The UART at 0x3000_0000 as the golden model sees it: comm/uart.ts's core stepped edge by edge, reads and writes landing at the handshake edge (`now` − 1). */
export class UartDevice {
  readonly core = new UartCore();
  /** Edges the core has had. */
  done = 0;
  /** Set to an array to log the line level after every edge (tests). */
  trace: number[] | undefined;
  private pending = new Map<number, UartIn>();
  constructor(public rx: (edge: number) => number = () => 1) {}
  /** Step the core until it has had n edges (the strobes scheduled for an edge go with it). */
  advanceTo(n: number): void {
    while (this.done < n) {
      const p = this.pending.get(this.done + 1);
      this.pending.delete(this.done + 1);
      this.core.edge({ ...p, rx: this.rx(this.done) });
      this.done++;
      this.trace?.push(this.core.tx);
    }
  }
  private at(edge: number, i: UartIn): void { this.pending.set(edge, { ...this.pending.get(edge), ...i }); }
  /** A load retiring at edge `now` saw the state before its handshake edge now − 1; reading DATA pops the FIFO at edge `now`. */
  read(reg: number, now: number): number {
    this.advanceTo(Math.max(0, now - 2));
    const c = this.core;
    switch (reg) {
      case 0: if (c.rxq.length) this.at(now, { rx: 1, pop: true }); return c.rxData;
      case 1: return c.status;
      case 2: return c.div;
      default: return c.ie;
    }
  }
  /** A store retiring at edge `now` happens at its handshake edge now − 1. */
  write(reg: number, value: number, now: number): void {
    this.advanceTo(Math.max(0, now - 2));
    const e = now - 1;
    if (reg === 0) this.at(e, { rx: 1, push: true, data: value & 255 });
    else if (reg === 1) this.at(e, { rx: 1, clrWe: true, wval: value & 0xfff });
    else if (reg === 2) this.at(e, { rx: 1, divWe: true, wval: value & 0xfff });
    else this.at(e, { rx: 1, ieWe: true, wval: value & 0xfff });
  }
}

/**
 * The NIC at 0x7000_0000 as the golden model sees it: comm/nic.ts's core stepped edge by edge, with the bus answering its master as chapter 38's RAM slave does
 * (a transaction's response comes the clock after its address; one at a time), a register write landing at its handshake edge (`now` − 1) and a read seeing
 * the state before it (`now` − 2), as UartDevice. Frames move between the NIC and this model's RAM at the edges the gates move them.
 *
 * Two ways to drive it. Self-driven (the default): advanceTo(n) steps the core with the bus answers it computes itself, assuming the bus is free whenever the
 * NIC wants it; a CPU transaction at the same time would delay the real one by a few clocks, so lock-step tests that need clock-exactness feed the model
 * what the gates saw instead (replay: the caller calls step() with the inputs of each clock and writeRam() is not needed, the answers coming from the gates).
 */
export class NicDevice {
  readonly core = new NicCore();
  /** Edges the core has had. */
  done = 0;
  /** True when the caller steps the core itself with the inputs the gates saw (a lock-step test): advanceTo, sync and write do nothing, and loads read the recorded register words. */
  replay = false;
  /** The line at the pins before edge e (idle: nothing). */
  line: (edge: number) => { rxd: number; crs: number } = () => ({ rxd: 0, crs: 0 });
  /** What the core drove on its line after each edge (txd, txen), when asked to keep it. */
  trace: { txd: number; txen: number }[] | undefined;
  /** The register words (readReg of 0..7) before each edge, for the loads that retire a couple of edges later. */
  private hist: number[][] = [];
  private pend = new Map<number, { idx: number; data: number }>();
  private resp: 'b' | 'r' | null = null; private busy = false; private rdata = 0;
  constructor(readonly ram: Uint32Array, line?: NicDevice['line']) { if (line) this.line = line; }

  private regs(): number[] {
    const c = this.core;
    return [(c.promisc << 1) | c.en, c.sRx | (c.sTx << 1) | (c.sMiss << 2) | (c.sBad << 3), c.ie, c.rxbase, c.txbase, c.macl >>> 0, c.mach, c.rxhead | (c.txhead << 3) | ((c.ts ? 1 : 0) << 6) | (c.act << 7)];
  }

  /** One clock with the given inputs (the self-driven loop builds them; a replay passes the gates' own). */
  step(i: NicIn): NicOut {
    this.hist[this.done] = this.regs();
    if (this.hist.length > 64) delete this.hist[this.done - 64];
    const o = this.core.out();
    this.core.step(i);
    this.done++;
    this.trace?.push({ txd: o.txd, txen: o.txen });
    return o;
  }

  /** Step the core until it has had n edges. */
  advanceTo(n: number): void {
    if (this.replay) return;
    while (this.done < n) {
      const e = this.done, p = this.pend.get(e);
      this.pend.delete(e);
      const i: NicIn = { ...idleIn(), ...this.line(e) };
      if (p) { i.awvalid = 1; i.wvalid = 1; i.wstrb = 15; i.awaddr = p.idx << 2; i.wdata = p.data; }
      // the RAM as the slave: ready when idle; the response the clock after the handshake
      const ready = !this.busy;
      Object.assign(i, { m_awready: ready ? 1 : 0, m_wready: ready ? 1 : 0, m_arready: ready ? 1 : 0, m_bvalid: this.resp === 'b' ? 1 : 0, m_rvalid: this.resp === 'r' ? 1 : 0, m_rdata: this.resp === 'r' ? this.rdata : 0 });
      const o = this.step(i);
      if (this.resp) { this.resp = null; this.busy = false; }
      else if (ready) {
        if (o.m_awvalid && o.m_wvalid) {
          const w = (o.m_awaddr >>> 2) % this.ram.length;
          let mask = 0;
          for (let b = 0; b < 4; b++) if ((o.m_wstrb >> b) & 1) mask |= 255 << (8 * b);
          this.ram[w] = ((this.ram[w] & ~mask) | (o.m_wdata & mask)) >>> 0;
          this.busy = true; this.resp = 'b';
        } else if (o.m_arvalid) {
          this.rdata = this.ram[(o.m_araddr >>> 2) % this.ram.length];
          this.busy = true; this.resp = 'r';
        }
      }
    }
  }
  /** The RAM as the CPU reads it at edge `now`: the core has had every edge up to the handshake. */
  sync(now: number): void { this.advanceTo(Math.max(0, now - 2)); }
  read(idx: number, now: number): number {
    this.sync(now);
    return (this.hist[Math.max(0, now - 2)] ?? this.regs())[idx & 7] >>> 0;
  }
  write(idx: number, value: number, now: number): void {
    if (this.replay) return;
    this.sync(now);
    this.pend.set(Math.max(this.done, now - 1), { idx: idx & 7, data: value >>> 0 });
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
  /** The UART (0x3000_0000: data +0, status +4, divisor +8, interrupt enables +12). */
  readonly uart: UartDevice | null;
  /** The NIC (0x7000_0000: CTRL +0, STATUS +4, IE +8, RXBASE +12, TXBASE +16, MACL +20, MACH +24, KICK +28, a doorbell). */
  readonly nic: NicDevice | null;
  /** The top nibble of each region. */
  readonly map: Record<keyof typeof MAP, number>;
  /** Rising clock edges so far (set by whoever steps the golden model; only the card reader needs it). */
  now = 0;
  dma = { src: 0, dst: 0, len: 0, done: false };
  /** Words copied by DMA so far (all at once, at each start). */
  copied = 0;

  constructor(ramK: number, flashImage: ArrayLike<number> = [], flashWords = 4096, dev: BusDevices = {}) {
    this.ram = new Uint32Array(2 ** ramK);
    this.flash = new Uint32Array(flashWords).fill(0xffffffff);
    for (let i = 0; i < Math.min(flashImage.length, flashWords); i++) this.flash[i] = flashImage[i] >>> 0;
    this.map = { ...MAP, ...dev.map };
    this.dram = dev.dramK ? new Uint32Array(2 ** dev.dramK) : null;
    this.screen = dev.screen ? new Uint32Array((dev.screen * dev.screen) / 4) : null;
    this.keys = dev.keys ? [] : null;
    this.cards = dev.cards ? new CardModel(dev.cards.items, dev.cards.feed) : null;
    this.uart = dev.uart ? new UartDevice(dev.uart.rx) : null;
    this.nic = dev.nic ? new NicDevice(this.ram, dev.nic.line) : null;
  }

  /** The DMA's interrupt line. */
  get irq(): boolean { return this.dma.done || !!this.nic?.core.irq; }

  read(addr: number): number {
    const a = addr >>> 0, nib = a >>> 28, w = (a >>> 2), MAP = this.map;
    if (nib === MAP.ram) { this.nic?.sync(this.now); return this.ram[w & (this.ram.length - 1)]; }
    if (nib === MAP.flash) return this.flash[w & (this.flash.length - 1)];
    if (nib === MAP.dram && this.dram) return this.dram[w & (this.dram.length - 1)];
    if (nib === MAP.screen && this.screen) return this.screen[w & (this.screen.length - 1)];
    if (nib === MAP.keys && this.keys) return w & 1 ? (this.keys.length ? 1 : 0) : (this.keys.shift() ?? 0);
    if (nib === MAP.cards && this.cards) { const s = this.now - CARD_LAG; return w & 1 ? this.cards.data(s) : this.cards.status(s); }
    if (nib === MAP.uart && this.uart) return this.uart.read(w & 3, this.now);
    if (nib === MAP.nic && this.nic) return this.nic.read(w & 7, this.now);
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
    const a = addr >>> 0, nib = a >>> 28, w = a >>> 2, MAP = this.map;
    const store = (m: Uint32Array) => { const i = w & (m.length - 1); m[i] = merge(m[i], value, strb); };
    if (nib === MAP.ram) { this.nic?.sync(this.now); store(this.ram); }
    else if (nib === MAP.dram && this.dram) store(this.dram);
    else if (nib === MAP.screen && this.screen) store(this.screen);
    else if (nib === MAP.uart && this.uart) this.uart.write(w & 3, value >>> 0, this.now);
    else if (nib === MAP.nic && this.nic) this.nic.write(w & 7, value >>> 0, this.now);
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
