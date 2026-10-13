// Chapter 31's reference: what one frame of the pipeline draws. The command unit (lib/gfxpipe.ts) clears the back
// frame and draws the mesh's triangles with frame f's vertices, as the vertex kernel (riscv/gfxprograms.ts) left
// them in the vertex buffer; here the same frame comes from plain arithmetic and the rasterizer's reference model.

import { BG, type Mesh, transformed } from '../riscv/gfxprograms';
import { type DrawOp, RefFrame, type Vtx } from './raster';

/** Frame f's draws, in the command unit's order: a clear, then every triangle (depth with the mesh's test). */
export function frameOps(m: Mesh, f: number): DrawOp[] {
  const v = transformed(m, f);
  return [
    { clr: true, v: [[0, 0], [0, 0], [0, 0]], col: BG },
    ...m.tris.map((t): DrawOp => ({
      v: t.i.map((k) => [v[k][0], v[k][1]] as Vtx), z: t.i.map((k) => v[k][2]), col: t.col, zt: m.zt, a: 7,
    })),
  ];
}

/** Frame f as the hardware leaves it in the back frame (64 × 64 RGB332, index y·64 + x). */
export function framePicture(m: Mesh, f: number): Uint8Array {
  const r = new RefFrame();
  for (const op of frameOps(m, f)) r.draw(op);
  return r.fb;
}

// ---- what each unit does in a frame ----------------------------------------------------------------

/** The command unit's states (lib/gfxpipe.ts CU_STATES; 'start' before the first frame). */
export type CuPhase = 'start' | 'launch' | 'clear' | 'count' | 'tri' | 'v0' | 'v1' | 'v2' | 'go' | 'draw' | 'swap' | 'flip';
export type SpanKind = 'kernel' | 'clear' | 'draw' | 'read' | 'wait';
export interface Span { kind: SpanKind; from: number; to: number }
/** One frame, from the cycle the command unit launches the kernel to the next launch. */
export interface FrameRecord {
  start: number;
  cycles: number;
  /** Per lane, runs of cycles relative to the start: the warp core, the rasterizer, the clear unit (step 5), the command unit (reads, waits). */
  lanes: { kernel: Span[]; raster: Span[]; clear: Span[]; cmd: Span[] };
  /** Cycles by what the command unit was doing (clear + draw + wait = cycles), and the kernel's busy cycles. */
  totals: { clear: number; draw: number; wait: number; kernel: number };
}

const READS = new Set<CuPhase>(['count', 'tri', 'v0', 'v1', 'v2', 'go']);

/** Builds frame records from one sample a cycle (taken before each rising edge). */
export class FrameRecorder {
  cur: FrameRecord | null = null;
  last: FrameRecord | null = null;
  /** Frames completed. */
  frames = 0;

  /** Cycle c's sample (clearBusy: the clear unit of step 5); true when it closed a frame (c is a launch). */
  sample(c: number, st: CuPhase, kernelBusy: boolean, rastBusy: boolean, clearBusy = false): boolean {
    let closed = false;
    if (st === 'launch') {
      if (this.cur) { this.cur.cycles = c - this.cur.start; this.last = this.cur; this.frames++; closed = true; }
      this.cur = { start: c, cycles: 0, lanes: { kernel: [], raster: [], clear: [], cmd: [] }, totals: { clear: 0, draw: 0, wait: 0, kernel: 0 } };
    }
    const f = this.cur;
    if (!f) return closed;
    const t = c - f.start;
    const put = (lane: Span[], kind: SpanKind | null) => {
      if (!kind) return;
      const s = lane[lane.length - 1];
      if (s && s.kind === kind && s.to === t) s.to = t + 1;
      else lane.push({ kind, from: t, to: t + 1 });
    };
    const clearing = st === 'launch' || st === 'clear';
    put(f.lanes.kernel, kernelBusy ? 'kernel' : null);
    put(f.lanes.raster, rastBusy ? (clearing ? 'clear' : 'draw') : null);
    put(f.lanes.clear, clearBusy ? 'clear' : null);
    put(f.lanes.cmd, READS.has(st) ? 'read' : st === 'swap' || st === 'flip' ? 'wait' : null);
    f.totals[clearing ? 'clear' : st === 'swap' || st === 'flip' ? 'wait' : 'draw']++;
    if (kernelBusy) f.totals.kernel++;
    return closed;
  }

  save(): unknown {
    return structuredClone({ cur: this.cur, last: this.last, frames: this.frames });
  }

  restore(s: unknown): void {
    const v = structuredClone(s) as { cur: FrameRecord | null; last: FrameRecord | null; frames: number };
    this.cur = v.cur; this.last = v.last; this.frames = v.frames;
  }
}

// ---- where the gates go: measured, and pinned by tests/gfxpipe.test.ts ----------------------------------

export interface StageCost { id: string; name: string; nands: number; memory: string }
export interface FrameCost { id: string; name: string; clear: number; draw: number; wait: number; kernel: number }

export const PIPE_COSTS: { stages: StageCost[]; frames: FrameCost[]; softCore: number; word: { unit: number; cmd: number; rop: number; fb: number } } = {
  /** The software kernels' core: four warps of four lanes with multipliers, logic without its memories. */
  softCore: 488609,
  stages: [
    { id: 'core', name: 'Vertex kernel: a warp core, 4 lanes with multipliers', nands: 182121, memory: '128 data words (4 Kbit), 64 program words' },
    { id: 'cmd', name: 'Command unit', nands: 1997, memory: '' },
    { id: 'rast', name: 'Rasterizer with depth set-up', nands: 26708, memory: '' },
    { id: 'rop', name: 'Depth test and blend', nands: 1421, memory: 'depth buffer, 64 Kbit' },
    { id: 'fb', name: 'Two frames, front and back', nands: 245, memory: '2 × 32 Kbit' },
    { id: 'scan', name: 'Scan-out', nands: 256, memory: '' },
  ],
  frames: [
    { id: 'triangle', name: 'Triangle, the pipeline (frame 1)', clear: 4438, draw: 1268, wait: 438, kernel: 60 },
    { id: 'cube', name: 'Cube with depth, the pipeline (frame 1)', clear: 4438, draw: 2509, wait: 221, kernel: 109 },
    { id: 'soft', name: 'Triangle in software, 16 threads (frame 1)', clear: 804, draw: 6825, wait: 0, kernel: 0 },
    // step 5: the clear unit, a word (four pixels) a cycle
    { id: 'triangle_w', name: 'Triangle, the clear a word a cycle (frame 1)', clear: 1026, draw: 1268, wait: 778, kernel: 60 },
    { id: 'cube_w', name: 'Cube, the clear a word a cycle (frame 1)', clear: 1026, draw: 2509, wait: 561, kernel: 109 },
  ],
  /** Step 5's parts, logic only: the clear unit, the command unit that starts it, the ROP with banked depth, the two frames. */
  word: { unit: 278, cmd: 1963, rop: 1728, fb: 249 },
};
