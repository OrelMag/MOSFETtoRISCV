// The golden model of the campaign's two-warp core (act 9, k_warps): W warps of the lane golden model
// (simt16.ts) over one data memory, each with its own PC, mask, stack and lane registers. Every warp
// starts at address 0 at reset (there is no wspawn in RV16); tid = warp · lanes + lane.
//
// The hardware is a barrel: issue slots go to the warps in turn, warp 0 first, whether or not the warp
// can use its slot (one that waits at the barrier or has ended wastes it). step() runs one slot, so
// steps counts cycles; stepWarp(w) runs one instruction of warp w, for other issue orders (tests).
//
//   bar   the warp waits until every other warp has arrived too, or has ended: its mask is 0
//         (tmc x0). The last to arrive releases them all and carries on. A warp that halts with
//         lanes still on (halt, jal x0, 0) never arrives: a warp waiting for it is a deadlock, an
//         error here (the hardware would wait forever).
//
// k_frame adds a rasterizer as a device (raster: true): lane 0's stores to RAST16 … RAST16 + 5 set v0x … v2y (7-bit
// quarter pixels), its store to RAST16 + 6 sets the colour and draws the triangle at once into the screen, the
// words FB16 + 32·y + x (gfx/raster16.ts). The hardware draws one pixel a cycle and holds the warps that would
// touch the rasterizer or read the screen meanwhile; the picture is the same.
//
// Warps share data only across a bar: a kernel that also gives the same memory under another issue
// order is correct on any scheduler (tests/warps16.test.ts checks the campaign's kernels that way).

import { FB16, RAST16, rasterize16, SCREEN16 } from '../../gfx/raster16';
import type { Vtx } from '../../gfx/raster';
import { decode16, MMIO16 } from './isa16';
import { popcount16, Simt16, type Simt16Options, type Warp16Step } from './simt16';

export interface Warps16Options extends Omit<Simt16Options, 'warp' | 'dmem'> {
  /** Warps (default 2, as the hardware). */
  warps?: number;
  /** The rasterizer device of k_frame. */
  raster?: boolean;
}

/** A triangle the device drew: its vertices, colour, pixels (in the hardware's order) and the rasterizer's busy cycles. */
export interface Draw16 { v: Vtx[]; col: number; pixels: { x: number; y: number }[]; cycles: number }

export interface Warps16Slot {
  warp: number;
  /** The instruction the warp ran, or null when the slot went unused. */
  step: Warp16Step | null;
  /** Why the slot went unused. */
  idle?: 'waiting' | 'ended';
}

export class Warps16 {
  readonly W: number;
  readonly n: number;
  readonly warps: Simt16[];
  readonly dmem: Uint16Array;
  /** Waiting at the barrier. */
  waiting: boolean[];
  /** Issue slots so far (= cycles). */
  steps = 0;
  /** Lane-steps that did work, every warp together. */
  activeLaneSteps = 0;
  /** Words stored to OUT, in issue order. */
  out: number[] = [];
  error: string | null = null;
  readonly raster: boolean;
  /** The device's registers: v0x, v0y, v1x, v1y, v2x, v2y. */
  rv = [0, 0, 0, 0, 0, 0];
  /** The triangles drawn so far. */
  draws: Draw16[] = [];

  constructor(program: ArrayLike<number>, opts: Warps16Options = {}, data?: Map<number, number>) {
    this.W = opts.warps ?? 2;
    this.raster = !!opts.raster;
    this.n = opts.lanes ?? 4;
    this.dmem = new Uint16Array(opts.dmemWords ?? 65536);
    for (const [a, v] of data ?? []) if (a < this.dmem.length) this.dmem[a] = v & 0xffff;
    this.warps = Array.from({ length: this.W }, (_, w) => new Simt16(program, { ...opts, warp: w, dmem: this.dmem }));
    this.waiting = this.warps.map(() => false);
  }

  /** Every warp has finished, or the model stopped on an error. */
  get halted(): boolean {
    return this.error !== null || this.warps.every((w) => w.halted);
  }

  /** The warp the next slot belongs to. */
  get next(): number {
    return this.steps % this.W;
  }

  /** The PC of the warp that issues next. */
  get pc(): number {
    return this.warps[this.next].pc;
  }

  /** Ended, as the barrier sees it: no lane left (tmc x0). */
  ended(w: number): boolean {
    return this.warps[w].mask === 0;
  }

  /** May warp w issue (not finished, not waiting at the barrier)? */
  runnable(w: number): boolean {
    return !this.warps[w].halted && !this.waiting[w];
  }

  /** Lane-steps that did work over n per slot (1 = every lane of every slot busy). */
  get utilization(): number {
    return this.steps ? this.activeLaneSteps / (this.steps * this.n) : 1;
  }

  /** Idle lane-slots as a percentage, rounded: the kernel puzzles' metric. */
  get idle(): number {
    return Math.round(100 * (1 - this.utilization));
  }

  /** One issue slot: the next warp's instruction, if it can run. */
  step(): Warps16Slot {
    const w = this.next;
    const slot: Warps16Slot = { warp: w, step: null };
    if (this.halted) return slot;
    if (this.warps[w].halted) slot.idle = 'ended';
    else if (this.waiting[w]) slot.idle = 'waiting';
    else slot.step = this.stepWarp(w);
    this.steps++;
    return slot;
  }

  /** One instruction of warp w, whatever the slot (other issue orders). */
  stepWarp(w: number): Warp16Step {
    if (!this.runnable(w)) throw new Error(`warp ${w} issued, but it ${this.waiting[w] ? 'waits at the barrier' : 'has finished'}`);
    const m = this.warps[w];
    const bar = decode16(m.lanes[0].imem[m.pc] ?? 0).spec?.name === 'bar';
    const s = m.step();
    if (m.error) this.error = `warp ${w}: ${m.error}`;
    for (const l of s.lanes) if (l?.store?.addr === MMIO16.OUT) this.out.push(l.store.value);
    const st0 = s.lanes[0]?.store;
    if (this.raster && st0 && st0.addr >= RAST16 && st0.addr <= RAST16 + 6) this.device(st0.addr - RAST16, st0.value);
    this.activeLaneSteps += popcount16(s.mask);
    if (bar && !m.error) this.waiting[w] = true;
    this.release();
    return s;
  }

  /** Lane 0's store to the rasterizer: a vertex coordinate, or the colour, which draws. */
  private device(k: number, value: number): void {
    if (k < 6) { this.rv[k] = value & 0x7f; return; }
    const v: Vtx[] = [[this.rv[0], this.rv[1]], [this.rv[2], this.rv[3]], [this.rv[4], this.rv[5]]];
    const r = rasterize16(v), col = value & 0xffff;
    for (const w of r.writes) this.dmem[FB16 + SCREEN16 * w.y + w.x] = col;
    this.draws.push({ v, col, pixels: r.writes.map((w) => ({ x: w.x, y: w.y })), cycles: r.cycles });
  }

  /** Free the warps at the barrier once every warp waits there or has ended; else spot a deadlock. */
  private release(): void {
    if (!this.waiting.some(Boolean)) return;
    const idx = this.warps.map((_, v) => v);
    if (idx.every((v) => this.waiting[v] || this.ended(v))) {
      this.waiting.fill(false);
      return;
    }
    const gone = idx.find((v) => !this.waiting[v] && this.warps[v].halted);
    if (gone !== undefined && idx.every((v) => this.waiting[v] || this.warps[v].halted)) {
      const w = idx.find((v) => this.waiting[v])!;
      this.error = `deadlock: warp ${w} waits at bar for warp ${gone}, which halted with lanes still on and will never arrive (a warp that skips the barrier must end with tmc x0)`;
    }
  }

  /** Run to the end or `max` slots; returns the slots run. */
  run(max = 100000): number {
    const s0 = this.steps;
    while (!this.halted && this.steps - s0 < max) this.step();
    return this.steps - s0;
  }
}
