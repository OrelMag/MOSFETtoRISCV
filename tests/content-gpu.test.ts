// Chapters 26–31 (ch-gpu.ts, ch-gfx.ts): the numbers and claims their prose quotes that the text cannot compute in place,
// measured here and read back from the text, so a change to either side fails.
import { describe, expect, it } from 'vitest';
import '../src/lib';
import { laneCore, multiCore, regfile, rom, warpCore } from '../src/lib';
import { chFeed, chLanes, chSimt, chWarps } from '../src/chapters/ch-gpu';
import { chGfxPipeline, chPixels } from '../src/chapters/ch-gfx';
import { PIPE_COSTS, frameOps } from '../src/gfx/pipeline';
import { CLEAR_CYCLES, RefFrame, rasterize } from '../src/gfx/raster';
import { assemble } from '../src/riscv/asm';
import { GFX, MESHES, meshById, vertexKernel } from '../src/riscv/gfxprograms';
import { SimtISS } from '../src/riscv/simt';
import { SAXPY_CORES, SIMT_PROGRAMS } from '../src/riscv/simtprograms';
import { WARP_DMEM_K, WARP_PROGRAMS } from '../src/riscv/warpprograms';
import { stats } from '../src/sim/stats';
import { type ComponentDef, netlistOf } from '../src/sim/types';
import { DEPTH_SCRIPTS } from '../src/widgets/screen';
import type { Chapter } from '../src/chapters/types';

const fmt = (n: number) => n.toLocaleString('en-US').replace(/,/g, ' ');
const nands = (d: ComponentDef) => stats(d).nands;
const inst = (d: ComponentDef, name: string) => netlistOf(d)!.instances.find((i) => i.name === name)!.def;
const flat = (s: string) => s.replace(/\s+/g, ' ');
const step = (c: Chapter, title: string) => flat(c.steps.find((s) => s.title === title)!.body);
const keep = (c: Chapter) => flat(c.recap!.keep.join(' '));
const quizText = (c: Chapter, title: string) => {
  const q = c.steps.find((s) => s.title === title)!.challenge!;
  return q.kind === 'quiz' ? flat(`${q.question} ${q.options.join(' ')} ${q.explain}`) : '';
};

describe('chapter 26: lanes against cores', () => {
  it('the saving with and without the program ROMs, as the text quotes it', () => {
    const sax = SIMT_PROGRAMS.find((p) => p.id === 'saxpy')!;
    const LC = laneCore(assemble(sax.source).words, 4), MC = multiCore(assemble(SAXPY_CORES).words, 4);
    const lcRom = nands(inst(LC, 'imem'));
    const cores = netlistOf(MC)!.instances.filter((i) => /^core\d$/.test(i.name));
    expect(cores.length).toBe(4);
    const mcRom = cores.reduce((a, c) => a + nands(inst(c.def, 'imem')), 0);
    const saved = nands(MC) - nands(LC), romSaved = mcRom - lcRom;
    const pct = Math.round((100 * saved) / nands(MC));
    const pctNoRom = Math.round((100 * (saved - romSaved)) / (nands(MC) - mcRom));
    expect([pct, pctNoRom]).toEqual([18, 6]);
    for (const text of [step(chLanes, 'Lanes against cores'), keep(chLanes)]) {
      for (const q of [`${pct} %`, `${pctNoRom} %`, fmt(romSaved), fmt(saved), fmt(nands(regfile(5, 32))), fmt(nands(inst(LC, 'lane0')))]) expect(text, q).toContain(q);
    }
    expect(romSaved / saved).toBeGreaterThan(0.5); // "most of that is program ROM"
  }, 120000);

  it('saxpy cycles and the lane utilization chapter 27 quotes', () => {
    const run = (id: string) => { const m = new SimtISS(assemble(SIMT_PROGRAMS.find((p) => p.id === id)!.source).words, { lanes: 4 }); m.run(5000); return m; };
    const s = run('saxpy');
    expect([s.retired, s.cycles]).toEqual([74, 134]);
    expect(keep(chLanes)).toContain('74 instructions in 134 cycles');
    const [tmc, nested] = ['tmc', 'nested'].map((id) => Math.round(100 * run(id).utilization));
    expect(step(chSimt, 'The active mask')).toContain(`${tmc} % of the lane-steps`);
    expect(step(chSimt, 'An if inside an if')).toContain(`${nested} % of the lane-steps`);
    expect(keep(chSimt)).toContain(`${nested} % of the lane-steps did work with the nested ifs`);
    expect(keep(chSimt)).toContain(`${tmc} % in the tmc kernel`);
  });
});

describe('chapter 28: a warp\'s program port', () => {
  it('every warp slot reads the program through a ROM of its own: 8 064 NANDs, the copy the text describes', () => {
    const p = WARP_PROGRAMS.find((x) => x.id === 'saxpy64')!;
    const words = assemble(p.source(4)).words;
    const core = warpCore(words, { warps: 4, lanes: 4, latency: 8, dmemK: WARP_DMEM_K, data: p.data() });
    const ims = netlistOf(core)!.instances.filter((i) => /^im\d$/.test(i.name));
    expect(ims.map((i) => i.name)).toEqual(['im0', 'im1', 'im2', 'im3']);
    const one = nands(rom(words, 6));
    expect(ims.every((i) => nands(i.def) === one)).toBe(true);
    expect(step(chWarps, 'Occupancy')).toContain(`a copy of the ROM (${fmt(one)})`);
    expect(step(chWarps, 'Many warps resident')).toContain('a read port in gates is a whole ROM');
    expect(keep(chWarps)).toContain('which in gates is a copy of the ROM');
  }, 120000);

  it('the scoreboard quiz is hypothetical: in saxpy64 the add on y[i] is not right behind its load', () => {
    const src = WARP_PROGRAMS.find((x) => x.id === 'saxpy64')!.source(4).split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
    const i = src.findIndex((l) => /^lw\s+a1, 256\(t4\)/.test(l));
    expect(src[i + 1]).toMatch(/^slli\s+a0, t5, 1/);
    expect(src[i + 3]).toMatch(/^add\s+a0, a0, a1/); // two instructions later: issued in cycle 20, not 19
    expect(quizText(chWarps, 'A scoreboard')).toContain('If add a0, a0, a1 came right after the second load');
    expect(quizText(chWarps, 'A scoreboard')).toContain('that add issues in cycle 20');
  });
});

describe('chapter 29: atomics scoped to this core', () => {
  it('the text says real GPUs serialize only lanes on one word', () => {
    expect(step(chFeed, 'Atomics')).toContain('This core serves it <strong>one lane per access</strong>');
    expect(step(chFeed, 'Atomics')).toContain('only lanes on the same word take turns');
    expect(keep(chFeed)).toContain('this core serves it one lane per access');
  });
});

describe('chapter 30: the clear and the depth test', () => {
  it('one clear count from go, explained once', () => {
    expect(CLEAR_CYCLES + 1).toBe(4437);
    expect(step(chPixels, 'Depth')).toContain(`${fmt(CLEAR_CYCLES + 1)} cycles from go (84 before the walk starts, then 256 tiles of 17`);
    expect(84 + 256 * 17).toBe(CLEAR_CYCLES);
    // chapter 31's clear phase is the launch cycle and the same clear
    expect(PIPE_COSTS.frames.find((f) => f.id === 'triangle')!.clear).toBe(CLEAR_CYCLES + 2);
    expect(step(chGfxPipeline, 'The pipeline').replace(/<\/?a[^>]*>/g, '')).toContain(`the clear 4 438 (the launch cycle, then chapter 30's ${fmt(CLEAR_CYCLES + 1)}-cycle clear`);
  });

  it('the two crossing triangles never tie at a pixel centre, so both orders give the same picture', () => {
    const pic = (ops: (typeof DEPTH_SCRIPTS)[number]['ops']) => { const r = new RefFrame(); for (const o of ops) r.draw(o); return Array.from(r.fb); };
    expect(pic(DEPTH_SCRIPTS[0].ops)).toEqual(pic(DEPTH_SCRIPTS[1].ops));
    expect(step(chPixels, 'Depth')).toContain('these two never tie at a pixel centre');
  });
});

describe('chapter 31: the vertex kernel and the cube', () => {
  it('the loop is tested at the bottom; a multiple of 4 keeps its branch uniform, three vertices would too', () => {
    const lines = vertexKernel(meshById('triangle')).split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
    const blt = lines.findIndex((l) => /^blt\s+t0, s1, loop$/.test(l));
    expect(lines.slice(lines.findIndex((l) => l.startsWith('loop:')), blt).some((l) => /^sw\s/.test(l))).toBe(true);
    // passes per lane of a bottom-tested loop over vertices tid, tid + 4, …
    const passes = (nv: number) => [0, 1, 2, 3].map((t) => { let k = 0, i = t; do { k++; i += 4; } while (i < nv); return k; });
    expect(passes(3)).toEqual([1, 1, 1, 1]);
    expect(passes(6)).toEqual([2, 2, 1, 1]);
    for (const nv of [5, 6, 7]) expect(new Set(passes(nv)).size).toBe(2);
    for (const m of MESHES) expect(m.verts.length % 4).toBe(0);
    expect(GFX.vbuf).toBe(96);
    const body = step(chGfxPipeline, 'Vertices are a kernel');
    expect(body).toContain('six vertices would send lanes 0 and 1 round twice and lanes 2 and 3 once');
    expect(body).toContain('X = 128 + ((x cos θ − y sin θ) &gt;&gt; 16)');
  });

  it('the cube: half or more of its triangles culled, 2 300 to 3 200 cycles of drawing, frames of whole scan-outs', () => {
    const cube = meshById('cube');
    const frames = Array.from({ length: 64 }, (_, f) => {
      const runs = frameOps(cube, f).slice(1).map((op) => rasterize(op.v, cube.zt));
      return { raster: runs.reduce((a, r) => a + r.cycles, 0), culled: runs.filter((r) => !r.setup.front).length };
    });
    expect([...new Set(frames.map((f) => f.culled))].sort()).toEqual([6, 8]);
    // the command unit's reads around the rasterizer: frame 1's draw phase against its rasterizer cycles
    const c1 = PIPE_COSTS.frames.find((f) => f.id === 'cube')!, cw = PIPE_COSTS.frames.find((f) => f.id === 'cube_w')!;
    const over = c1.draw - frames[1].raster;
    expect(over).toBeGreaterThan(0);
    expect(over).toBeLessThan(5 * 12 + 2);
    const draws = frames.map((f) => f.raster + over);
    const lo = Math.min(...draws), hi = Math.max(...draws);
    expect(Math.round(lo / 100) * 100).toBe(2300);
    expect(Math.ceil(hi / 100) * 100).toBe(3200);
    const snap = (clear: number) => [...new Set(draws.map((d) => Math.ceil((clear + d + 2) / 1024) * 1024))].sort();
    expect(snap(c1.clear)).toEqual([7168, 8192]);
    expect(snap(cw.clear)).toEqual([4096, 5120]);
    const text = step(chGfxPipeline, 'A spinning triangle');
    expect(text).toContain('Half of them or more face away (six or eight, with the angle)');
    expect(text).toContain('Its frames take 7 168 to 8 192 cycles: two or three faces, 2 300 to 3 200 cycles of drawing');
    expect(step(chGfxPipeline, 'A faster clear')).toContain('4 096 or 5 120');
  });
});
