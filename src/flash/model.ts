// Chapter 36's flash as reference models: a NAND device (pages programmed once per erase, only 1 → 0;
// blocks erased whole; busy times; blocks that wear out) and the flash translation layer a controller
// runs on it (a logical-to-physical table, writes out of place, greedy garbage collection, wear
// levelling, bad blocks skipped). Chapter 37's system reads its flash through FlashDevice.

/** Busy time of each operation in our clock cycles: SLC NAND's 25 µs / 200 µs / 1.5 ms scaled by about 1/100, the ratios kept. */
export const FLASH_TIMES = { read: 64, program: 512, erase: 4096 } as const;
export const FLASH_REAL_US = { read: 25, program: 200, erase: 1500 } as const;

export interface FlashGeometry { blocks: number; pagesPerBlock: number; wordsPerPage: number }

export type FlashOp = { kind: 'read' | 'program' | 'erase'; page?: number; block?: number; ok: boolean; why?: string; cycles: number };

/**
 * A NAND flash device. Erased words read all ones; a program can only clear bits, and a page takes
 * one program per erase; an erase sets a whole block back. A block wears out after `endurance` erases
 * (its erase then fails and it is bad); `factoryBad` blocks are bad from the start.
 */
export class FlashDevice {
  readonly data: Uint32Array;
  readonly programmed: Uint8Array;
  readonly erases: Int32Array;
  readonly bad: Uint8Array;
  cycles = 0;
  readonly log: FlashOp[] = [];

  constructor(readonly g: FlashGeometry, readonly endurance = Infinity, factoryBad: number[] = []) {
    const pages = g.blocks * g.pagesPerBlock;
    this.data = new Uint32Array(pages * g.wordsPerPage).fill(0xffffffff);
    this.programmed = new Uint8Array(pages);
    this.erases = new Int32Array(g.blocks);
    this.bad = new Uint8Array(g.blocks);
    for (const b of factoryBad) this.bad[b] = 1;
  }

  get pages(): number { return this.g.blocks * this.g.pagesPerBlock; }
  blockOf(page: number): number { return Math.floor(page / this.g.pagesPerBlock); }

  private op(o: FlashOp): FlashOp {
    this.cycles += o.cycles;
    this.log.push(o);
    if (this.log.length > 4096) this.log.shift();
    return o;
  }

  read(page: number): number[] {
    this.op({ kind: 'read', page, ok: true, cycles: FLASH_TIMES.read });
    const w = this.g.wordsPerPage;
    return Array.from(this.data.subarray(page * w, page * w + w));
  }

  program(page: number, words: number[]): FlashOp {
    const b = this.blockOf(page);
    if (this.bad[b]) return this.op({ kind: 'program', page, ok: false, why: `block ${b} is bad`, cycles: FLASH_TIMES.program });
    if (this.programmed[page]) return this.op({ kind: 'program', page, ok: false, why: `page ${page} already programmed since its erase`, cycles: FLASH_TIMES.program });
    const w = this.g.wordsPerPage;
    for (let i = 0; i < w; i++) this.data[page * w + i] &= words[i] >>> 0; // only 1 → 0
    this.programmed[page] = 1;
    return this.op({ kind: 'program', page, ok: true, cycles: FLASH_TIMES.program });
  }

  erase(block: number): FlashOp {
    if (this.bad[block]) return this.op({ kind: 'erase', block, ok: false, why: `block ${block} is bad`, cycles: FLASH_TIMES.erase });
    this.erases[block]++;
    if (this.erases[block] > this.endurance) {
      this.bad[block] = 1;
      return this.op({ kind: 'erase', block, ok: false, why: `block ${block} worn out after ${this.endurance} erases`, cycles: FLASH_TIMES.erase });
    }
    const p0 = block * this.g.pagesPerBlock, w = this.g.wordsPerPage;
    this.data.fill(0xffffffff, p0 * w, (p0 + this.g.pagesPerBlock) * w);
    this.programmed.fill(0, p0, p0 + this.g.pagesPerBlock);
    return this.op({ kind: 'erase', block, ok: true, cycles: FLASH_TIMES.erase });
  }
}

export interface FtlOptions {
  /** Pages the host sees (the rest is spare: over-provisioning). */
  logical: number;
  /** Pick the free block with the fewest erases (else the lowest-numbered). */
  wearLevel: boolean;
  /** Free blocks the FTL keeps in hand: it collects garbage when it is down to these (at least 1). */
  reserve?: number;
}

/** What one host write cost on the device. */
export interface FtlEvent { lpn: number; page: number; copies: number[]; erased: number[] }

/**
 * A page-mapped flash translation layer. A write goes to the next free page of the active block and
 * the old copy goes stale; when free blocks run short, garbage collection takes the block with the
 * fewest valid pages, copies them to the active block and erases it. Bad blocks are never used.
 */
export class Ftl {
  readonly l2p: Int32Array;
  readonly p2l: Int32Array;
  /** Per block: valid pages. */
  readonly valid: Int32Array;
  active = -1;
  next = 0;
  hostWrites = 0;
  programs = 0;
  copies = 0;
  readonly free: number[] = [];
  readonly reserve: number;

  constructor(readonly dev: FlashDevice, readonly o: FtlOptions) {
    this.l2p = new Int32Array(o.logical).fill(-1);
    this.p2l = new Int32Array(dev.pages).fill(-1);
    this.valid = new Int32Array(dev.g.blocks);
    this.reserve = o.reserve ?? 1;
    for (let b = 0; b < dev.g.blocks; b++) if (!dev.bad[b]) this.free.push(b);
    // spare: the reserve, plus at least a page, so garbage collection always frees something
    if (o.logical >= (this.free.length - this.reserve - 1) * dev.g.pagesPerBlock) throw new Error('Ftl: not enough spare pages');
  }

  get writeAmplification(): number { return this.hostWrites ? this.programs / this.hostWrites : 1; }

  /** Take a free block: the least-erased one with wear levelling, else the first. */
  private takeFree(): number {
    let k = 0;
    if (this.o.wearLevel) for (let i = 1; i < this.free.length; i++) if (this.dev.erases[this.free[i]] < this.dev.erases[this.free[k]]) k = i;
    return this.free.splice(k, 1)[0];
  }

  /** The next free page, opening a new active block when this one is full. */
  private allocate(): number {
    const ppb = this.dev.g.pagesPerBlock;
    if (this.active < 0 || this.next === ppb) {
      if (!this.free.length) throw new Error('Ftl: out of free blocks');
      this.active = this.takeFree();
      this.next = 0;
    }
    return this.active * ppb + this.next++;
  }

  /** Program a logical page's words into a fresh physical page. */
  private place(lpn: number, words: number[]): number {
    for (;;) {
      const page = this.allocate();
      const r = this.dev.program(page, words);
      this.programs++;
      if (!r.ok) { this.next = this.dev.g.pagesPerBlock; continue; } // a bad block: move on
      const old = this.l2p[lpn];
      if (old >= 0) { this.p2l[old] = -1; this.valid[this.dev.blockOf(old)]--; }
      this.l2p[lpn] = page;
      this.p2l[page] = lpn;
      this.valid[this.dev.blockOf(page)]++;
      return page;
    }
  }

  /** Collect garbage until enough blocks are free; returns the copies made and the blocks erased. */
  private collect(ev: FtlEvent): void {
    const ppb = this.dev.g.pagesPerBlock;
    for (let guard = 0; this.free.length <= this.reserve; guard++) {
      if (guard > 4 * this.dev.g.blocks) throw new Error('Ftl: garbage collection makes no progress');
      let victim = -1;
      for (let b = 0; b < this.dev.g.blocks; b++) {
        if (b === this.active || this.dev.bad[b] || this.free.includes(b)) continue;
        if (victim < 0 || this.valid[b] < this.valid[victim]) victim = b;
      }
      if (victim < 0) throw new Error('Ftl: nothing to collect');
      for (let i = 0; i < ppb; i++) {
        const p = victim * ppb + i, lpn = this.p2l[p];
        if (lpn < 0) continue;
        const words = this.dev.read(p);
        ev.copies.push(this.place(lpn, words));
        this.copies++;
      }
      const r = this.dev.erase(victim);
      ev.erased.push(victim);
      if (r.ok) this.free.push(victim);
    }
  }

  write(lpn: number, words: number[]): FtlEvent {
    if (!(lpn >= 0 && lpn < this.o.logical)) throw new Error(`Ftl: no logical page ${lpn}`);
    const ev: FtlEvent = { lpn, page: -1, copies: [], erased: [] };
    this.hostWrites++;
    ev.page = this.place(lpn, words);
    // keep blocks in hand: the next active block, and room for garbage collection to copy into
    if (this.free.length <= this.reserve) this.collect(ev);
    return ev;
  }

  read(lpn: number): number[] | null {
    const p = this.l2p[lpn];
    return p < 0 ? null : this.dev.read(p);
  }
}

/** A seeded workload: host writes to `logical` pages, `hot` of them taking `hotShare` of the writes. */
export function randomWrites(n: number, logical: number, seed = 1, hot = 0, hotShare = 0): number[] {
  let s = seed >>> 0 || 1;
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 8) / 2 ** 24;
  return Array.from({ length: n }, () => (hot && rnd() < hotShare ? Math.floor(rnd() * hot) : Math.floor(rnd() * logical)));
}
