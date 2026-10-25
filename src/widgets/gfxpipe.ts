// Chapter 33 widgets: the pipeline scene (the vertex kernel's warp core, the command unit, chapter 32's GPU) with
// its panel (the screen, frames per second measured in the page, what each unit did in the last frame, the vertex
// kernel in lock-step with its golden model and every frame checked against the reference picture), and the cost
// widget (NANDs per stage, cycles per frame by phase, the same frame drawn in software on the lanes).

import { FB_W } from '../gfx/raster';
import { type FrameCost, FrameRecorder, type FrameRecord, framePicture, PIPE_COSTS, type SpanKind } from '../gfx/pipeline';
import { type CuState, cuState, gpu31 } from '../lib/gfxpipe';
import { assemble } from '../riscv/asm';
import { GFX, meshById, meshData, MESHES, type Mesh, vertexKernel } from '../riscv/gfxprograms';
import { WarpISS } from '../riscv/warps';
import type { HierNode } from '../sim/flatten';
import type { Sim } from '../sim/sim';
import { pack } from '../sim/values';
import { h, s } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { FrameMemory } from './framemem';
import { backFrame, ScanCapture } from './screen';

const kid = (n: HierNode, ...p: string[]) => p.reduce((x, k) => x.children!.get(k)!, n);
const u = (sim: Sim, node: HierNode, port: string) => pack(sim.getBits(node.ports[port])) >>> 0;
const fmt = (n: number) => n.toLocaleString('en').replace(/,/g, ' ');

export interface PipeSceneOptions {
  highlight?: string[];
  path?: string[];
  /** How the back frame is cleared: chapter 32's rasterizer (default), or step 5's clear unit, a word a cycle. */
  clear?: 'pixel' | 'word';
  /** Step 5: a switch between the two clears, and their frames compared. */
  clearSwitch?: boolean;
}

/** The whole pipeline drawing a mesh, on the cycle engine (hundreds of thousands of gates). */
export function pipelineScene(mesh: Mesh['id'], opts: PipeSceneOptions = {}): Scene {
  return {
    root: gpu31(meshById(mesh), { clear: opts.clear }), inputs: { clk: 0 }, path: opts.path, highlight: opts.highlight ?? ['cmd'], autoClock: false, engine: 'cycle',
    panels: [pipelinePanel(mesh, opts)],
  };
}

/** What the command unit is doing in each state (p: the vertex buffer this frame reads). */
const CU_TEXT: Record<CuState, (p: number) => string> = {
  start: () => 'waits for the kernel\'s first run',
  launch: () => 'launch: the kernel on the next frame, and the clear',
  clear: () => 'waits for the clear',
  count: () => 'reads the triangle count',
  tri: () => 'reads a triangle: three indices, a colour',
  v0: (p) => `reads vertex 0 from buffer ${p}`,
  v1: (p) => `reads vertex 1 from buffer ${p}`,
  v2: (p) => `reads vertex 2 from buffer ${p}`,
  go: () => 'go: the rasterizer starts',
  draw: () => 'waits for the rasterizer',
  swap: () => 'swap',
  flip: () => 'waits for the flip at vsync and the kernel',
};

/** Colours of the timeline's kinds (categorical, fixed order) and their names. */
const KIND: Record<SpanKind, { c: string; name: string }> = {
  clear: { c: 'var(--series-1)', name: 'clear' },
  draw: { c: 'var(--series-2)', name: 'triangles' },
  wait: { c: 'var(--series-3)', name: 'waiting for vsync' },
  kernel: { c: 'var(--series-4)', name: 'vertex kernel' },
  read: { c: 'var(--muted)', name: 'reads' },
};

/** The last frame as three lanes over its cycles. */
function timeline(f: FrameRecord | null): SVGElement | HTMLElement {
  if (!f) return h('p', { class: 'cpu-sec-hint' }, 'Run a frame to see who works when.');
  const W = 270, LH = 14, X0 = 0, lanes: [string, keyof FrameRecord['lanes']][] = [['warp core', 'kernel'], ['rasterizer', 'raster'],
    ...(f.lanes.clear.length ? [['clear unit', 'clear'] as [string, keyof FrameRecord['lanes']]] : []), ['command unit', 'cmd']];
  const sx = (t: number) => X0 + (t / f.cycles) * W;
  const svg = s('svg', { class: 'gfx-timeline', viewBox: `0 0 ${W} ${lanes.length * (LH + 16)}`, role: 'img',
    'aria-label': `The last frame: ${f.cycles} cycles. Clear ${f.totals.clear}, triangles ${f.totals.draw}, waiting for vsync ${f.totals.wait}; the vertex kernel ran ${f.totals.kernel}.` });
  lanes.forEach(([name, key], i) => {
    const y = i * (LH + 16);
    svg.append(s('text', { x: 0, y: y + 10, class: 'gfx-tl-name' }, name));
    svg.append(s('rect', { x: X0, y: y + 13, width: W, height: LH, rx: 3, class: 'gfx-tl-bg' }));
    for (const sp of f.lanes[key]) {
      const r = s('rect', { x: sx(sp.from), y: y + 13, width: Math.max(1.5, sx(sp.to) - sx(sp.from)), height: LH, rx: 2, fill: KIND[sp.kind].c });
      r.append(s('title', null, `${KIND[sp.kind].name}: cycles ${fmt(sp.from)} – ${fmt(sp.to - 1)} (${fmt(sp.to - sp.from)})`));
      svg.append(r);
    }
  });
  return svg;
}

function legend(f: FrameRecord | null): HTMLElement {
  const t = f?.totals;
  return h('div', { class: 'gfx-legend' }, ...(['clear', 'draw', 'wait', 'kernel'] as SpanKind[]).map((k) =>
    h('span', null, h('i', { style: `background:${KIND[k].c}` }), KIND[k].name, t ? h('b', null, fmt(t[k as keyof typeof t])) : '')));
}

function pipelinePanel(meshId: Mesh['id'], opts: PipeSceneOptions): ScenePanel {
  const mesh = meshById(meshId);
  const words = assemble(vertexKernel(mesh)).words;
  return (stage: Stage): Widget => {
    let running: number | null = null, rate = 0;
    const runBtn = h('button', { class: 'btn sm primary' }, 'Run');
    const frameBtn = h('button', { class: 'btn sm', title: 'run until the next frame is drawn and the scan-out has sent it to the screen' }, 'One frame');
    const stop = () => { if (running) cancelAnimationFrame(running); running = null; runBtn.textContent = 'Run'; };
    const cap = new ScanCapture(stage, stop);
    const mem = new FrameMemory(stage, cap, {
      gpu: true, depth: true,
      rows: (sim) => {
        const st = cuState(u(sim, node(sim, 'cmd'), 'state')), running = u(sim, node(sim, 'core'), 'halted') === 0;
        return [
          { unit: 'Command unit', hue: 'wait', text: CU_TEXT[st](rec.frames & 1) },
          { unit: 'Warp core', hue: 'kernel', text: running ? `vertex kernel: frame ${rec.frames + 1} into buffer ${(rec.frames + 1) & 1}` : 'halted: the kernel is done' },
        ];
      },
    }, () => paint());
    const memLabel = h('span', { class: 'gfx-mem-label' });
    let rec = new FrameRecorder();
    // the vertex kernel's golden model, launched with the hardware's warp, stepped when it issues
    const fresh = () => new WarpISS(words, { warps: 1, lanes: 4, dmemWords: 2 ** 7, data: meshData(mesh), mul: true });
    let m = fresh();
    let mismatch: string | null = null, stepped = false;
    let checked = null as { frame: number; bad: number } | null, vbufOk = null as boolean | null;
    /** Wall-clock times of the frames shown, for frames per second. */
    let shownAt: number[] = [];
    const node = (sim: Sim, ...p: string[]) => kid(sim.design.root, ...p);

    stage.edgeHooks.add({
      before: () => {
        const sim = stage.sim;
        if (!sim) return;
        const cmd = node(sim, 'cmd'), core = node(sim, 'core');
        const st = cuState(u(sim, cmd, 'state')), busy = u(sim, core, 'halted') === 0;
        stepped = false;
        if (u(sim, cmd, 'launch')) m.launch();
        else if (u(sim, core, 'retire') && !mismatch) {
          try { m.step(0); stepped = true; } catch (e) { mismatch = (e as Error).message; }
        }
        // the command unit starts reading this frame's vertex buffer (the kernel's stores landed long ago): the model's
        if (st === 'count' && !mismatch) {
          const p = rec.frames & 1;
          vbufOk = mesh.verts.every((_, i) => u(sim, node(sim, 'core', 'mem', 'mem', `w${GFX.vbuf + 8 * p + i}`), 'q') === m.dmem[GFX.vbuf + 8 * p + i]);
          if (!vbufOk) mismatch = 'the vertex buffer differs from the golden model';
        }
        // the frame is drawn: the back frame against the reference picture
        if (st === 'swap') {
          const pic = backFrame(sim), want = framePicture(mesh, rec.frames);
          let bad = 0;
          if (pic) for (let i = 0; i < pic.length; i++) if (pic[i] !== want[i]) bad++;
          checked = { frame: rec.frames, bad };
        }
        const clr = sim.design.root.children?.get('clear');
        if (rec.sample(stage.cycles, st, busy, u(sim, node(sim, 'rast'), 'busy') === 1, !!clr && u(sim, clr, 'busy') === 1)) {
          shownAt.push(performance.now());
          if (shownAt.length > 6) shownAt = shownAt.slice(-6);
        }
      },
      after: () => {
        const sim = stage.sim;
        if (!sim || !stepped || mismatch) return;
        if (u(sim, node(sim, 'core', 'warp0'), 'pc') !== m.warps[0].pc) mismatch = 'the warp\'s PC differs from the golden model';
      },
    });
    type Saved = { w: ReturnType<WarpISS['warps'][number]['save']>; active: boolean[]; dmem: Uint32Array; rec: unknown; mismatch: string | null; checked: typeof checked; vbufOk: boolean | null };
    stage.historyHooks.add({
      save: (): Saved => ({ w: m.warps[0].save(), active: m.active.slice(), dmem: m.dmem.slice(), rec: rec.save(), mismatch, checked, vbufOk }),
      restore: (v) => {
        const st = v as Saved;
        stop();
        m.warps[0].restore(st.w); m.active = st.active.slice(); m.dmem.set(st.dmem);
        rec.restore(st.rec);
        mismatch = st.mismatch; checked = st.checked; vbufOk = st.vbufOk;
        shownAt = [];
      },
    });
    // Reset (the stage's or this panel's): the kernel's model and the frame count start again with the hardware
    stage.resetHooks.add(() => {
      m = fresh(); rec = new FrameRecorder();
      mismatch = null; checked = null; vbufOk = null; shownAt = [];
    });

    const runFor = (until: () => boolean) => {
      if (running) return stop();
      stage.checkpoint();
      runBtn.textContent = 'Pause';
      // cycles for ~12 ms of each animation frame, then one redraw
      const tick = () => {
        const t0 = performance.now(), deadline = t0 + 12;
        const n = stage.runCycles(1e7, () => until() || performance.now() > deadline);
        const dt = performance.now() - t0;
        if (n > 0 && dt > 0) rate = Math.round((n * 1000) / Math.max(dt, 16.7));
        if (until() || mismatch) return stop();
        running = requestAnimationFrame(tick);
      };
      running = requestAnimationFrame(tick);
    };
    runBtn.addEventListener('click', () => runFor(() => false));
    frameBtn.addEventListener('click', () => {
      stop();
      // the frame is drawn at the flip; the screen has it a scan-out later (the next vsync)
      const f = rec.frames;
      let sent = -1;
      runFor(() => {
        if (sent < 0 && rec.frames > f) sent = cap.frames;
        return sent >= 0 && cap.frames > sent;
      });
    });
    const resetSel = h('select', { class: 'gfx-reset', 'aria-label': 'reset', title: 'reset options' }, h('option', { value: '' }, 'Reset…'),
      h('option', { value: 'power' }, 'Power-cycle: start again from frame 0'),
      h('option', { value: 'forget' }, 'Forget what the screen showed')) as HTMLSelectElement;
    resetSel.addEventListener('change', () => {
      const k = resetSel.value;
      resetSel.value = '';
      if (k === 'power') stage.powerCycle();
      else if (k === 'forget') { cap.forget(); paint(); }
    });
    const meshSel = h('select', { 'aria-label': 'mesh' }, ...MESHES.map((x) => h('option', { value: x.id }, x.title))) as HTMLSelectElement;
    meshSel.value = meshId;
    meshSel.addEventListener('change', () => stage.load(pipelineScene(meshSel.value as Mesh['id'], opts)));
    const clearSel = h('select', { 'aria-label': 'clear', title: 'how the command unit clears the back frame: the scene rebuilds' },
      h('option', { value: 'pixel' }, 'Clear: a pixel a cycle'), h('option', { value: 'word' }, 'Clear: a word a cycle')) as HTMLSelectElement;
    clearSel.value = opts.clear ?? 'pixel';
    clearSel.addEventListener('change', () => stage.load(pipelineScene(meshId, { ...opts, clear: clearSel.value as 'pixel' | 'word' })));
    // step 5: this mesh's frame both ways, measured (PIPE_COSTS, pinned by tests/gfxpipe.test.ts)
    const compare = opts.clearSwitch ? h('div', null, h('div', { class: 'cpu-sec' }, 'Frame 1, cleared', h('span', { class: 'cpu-sec-hint' }, 'hover a bar for its cycles')),
      framesTable(PIPE_COSTS.frames.filter((x) => x.id === meshId || x.id === `${meshId}_w`), opts.clear === 'word' ? `${meshId}_w` : meshId, (x) => (x.id.endsWith('_w') ? 'a word a cycle' : 'a pixel a cycle'))) : null;

    const cv = h('canvas', { class: 'gfx-screen', width: 256, height: 256, 'aria-label': 'the screen' }) as HTMLCanvasElement;
    const status = h('div', { class: 'cpu-status' });
    const checks = h('div', { class: 'cpu-status' });
    const tl = h('div', { class: 'gfx-tl-wrap' });
    // the two vertex buffers in the core's memory, packed X | Y << 8 | Z << 16: the kernel writes the next frame's while
    // the command unit reads this frame's
    const vbuf = h('div', { class: 'gfx-vbuf' });
    const paintVbuf = (sim: Sim) => {
      const st = cuState(u(sim, node(sim, 'cmd'), 'state')), running = u(sim, node(sim, 'core'), 'halted') === 0;
      const reading = ['count', 'tri', 'v0', 'v1', 'v2', 'go', 'draw'].includes(st) ? rec.frames & 1 : -1;
      const writing = running ? (rec.frames + 1) & 1 : -1;
      vbuf.replaceChildren(...[0, 1].map((p) => h('div', { class: `gfx-vbuf-box${p === writing ? ' writing' : p === reading ? ' reading' : ''}` },
        h('div', { class: 'gfx-vbuf-cap' }, h('span', null, `buffer ${p}`), h('span', null, p === writing ? 'the kernel writes' : p === reading ? 'the command unit reads' : '')),
        h('table', null, h('tr', null, ...['word', 'packed', 'X', 'Y', 'Z'].map((t) => h('th', null, t))),
          ...mesh.verts.map((_, i) => {
            const a = GFX.vbuf + 8 * p + i, w = u(sim, node(sim, 'core', 'mem', 'mem', `w${a}`), 'q');
            return h('tr', null, h('td', null, String(a)), h('td', null, w.toString(16).padStart(6, '0')),
              h('td', null, String(w & 255)), h('td', null, String((w >> 8) & 255)), h('td', null, String((w >> 16) & 255)));
          })))));
    };
    const paint = () => {
      const sim = stage.sim;
      if (!sim) return;
      if (mem.sel === 'screen') {
        cap.paint(cv);
        cap.beam(cv);
        memLabel.textContent = 'Screen: what the scan-out sent';
        if (cap.blank()) cap.note(cv, rec.frames ? ['The next frame is on its way:', 'the scan-out sends it after the swap.'] : ['Nothing drawn yet.', 'Run, or One frame.']);
      } else memLabel.textContent = mem.paintLarge(cv);
      mem.update();
      paintVbuf(sim);
      const span = shownAt.length > 1 ? (shownAt[shownAt.length - 1] - shownAt[0]) / 1000 : 0;
      const fps = running && span > 0 ? (shownAt.length - 1) / span : 0;
      const engine = 'engine' in sim ? (sim as unknown as { engine: string }).engine : 'gate';
      status.replaceChildren(
        h('span', null, `cycle ${fmt(stage.cycles)}`),
        h('span', { title: 'frames the command unit has finished (each one swapped to the screen at vsync)' }, `${rec.frames} frame${rec.frames === 1 ? '' : 's'} drawn`),
        ...(running && rate ? [h('span', { title: `gate level in this page, on the ${engine === 'cycle' ? 'cycle engine (settled values at every edge)' : 'event-driven simulator'}` }, `${fmt(rate)} cycles/s`)] : []),
        ...(fps ? [h('span', { title: 'frames drawn per second of wall-clock time, measured here' }, `${fps.toFixed(fps < 10 ? 2 : 1)} frames/s`)] : []));
      checks.replaceChildren(
        mismatch ? h('span', { class: 'bad' }, `Vertex kernel: ${mismatch}`)
          : h('span', { class: vbufOk ? 'good' : '' }, vbufOk ? 'Vertex kernel: in step with its golden model' : 'Vertex kernel: lock-step with its golden model'),
        ...(checked ? [h('span', { class: checked.bad ? 'bad' : 'good' }, checked.bad ? `Frame ${checked.frame}: ${checked.bad} pixels differ from the reference` : `Frame ${checked.frame}: the reference picture, pixel for pixel`)] : []));
      tl.replaceChildren(h('div', { class: 'cpu-sec' }, rec.last ? `The last frame: ${fmt(rec.last.cycles)} cycles` : 'The last frame'), timeline(rec.last), legend(rec.last));
    };
    const title = h('h4', null, 'Screen 64 × 64 · the pipeline', h('span', { class: 'fold-hint' }));
    const el = h('div', { class: 'mem-panel cpu-panel gfx-panel', 'data-dock': 'right', 'data-phone': 'flow' }, title,
      h('div', { class: 'cpu-body' },
        h('div', { class: 'param-row', style: 'margin-bottom:6px' }, meshSel, ...(opts.clearSwitch ? [clearSel] : [])),
        h('div', { class: 'gfx-screen-wrap' }, cv, memLabel),
        h('div', { class: 'param-row', style: 'margin-top:6px' }, runBtn, frameBtn, resetSel), status, checks, mem.el,
        h('details', { class: 'gfx-mem-fold', open: true }, h('summary', null, `Vertex buffers · word ${GFX.vbuf} on`), vbuf), tl, compare,
        h('p', { class: 'cpu-sec-hint' }, `The screen shows what the scan-out sends, ${FB_W} × ${FB_W}. Run simulates every gate of the pipeline on the cycle engine; probes and the timing diagram need gate delays, so they are off here.`)));
    paint();
    return { el, update: paint, destroy: stop };
  };
}

// ---- where the gates go ---------------------------------------------------------------------------------

/** NANDs per stage and cycles per frame by phase, measured (tests/gfxpipe.test.ts checks every number). */
export function costWidget(): Widget {
  const C = PIPE_COSTS;
  const maxN = Math.max(...C.stages.map((x) => x.nands));
  const gates = h('table', { class: 'gfx-cost' },
    h('thead', null, h('tr', null, h('th', null, 'Stage'), h('th', { class: 'n' }, 'NANDs of logic'), h('th', null, ''), h('th', null, 'Memory'))),
    h('tbody', null, ...C.stages.map((x) => h('tr', null, h('td', null, x.name), h('td', { class: 'n' }, fmt(x.nands)),
      h('td', { class: 'bar' }, h('i', { style: `width:${Math.max(0.5, (100 * x.nands) / maxN)}%` })), h('td', { class: 'mem' }, x.memory)))));
  const frames = framesTable(C.frames.filter((f) => !f.id.endsWith('_w')));
  const el = h('div', { class: 'widget gfx-costs' },
    h('div', { class: 'lvc-title' }, 'Gates per stage'), gates,
    h('p', { class: 'cpu-sec-hint' }, 'Memories as flip-flops would be millions of NANDs (the two frames alone 1.35 million); real ones are SRAM or DRAM, so they are counted in bits.'),
    h('div', { class: 'lvc-title', style: 'margin-top:14px' }, 'Cycles in a frame'), frames,
    h('div', { class: 'gfx-legend' }, ...KINDS.map(([, k]) => h('span', null, h('i', { style: `background:${KIND[k].c}` }), KIND[k].name))));
  return { el };
}

const KINDS: ['clear' | 'draw' | 'wait', SpanKind][] = [['clear', 'clear'], ['draw', 'draw'], ['wait', 'wait']];

/** Frames as stacked bars to one scale (cycles by phase); `mark`: the row of the scene shown; `label`: a short name (the panel: no phase column). */
function framesTable(rows: FrameCost[], mark?: string, label?: (f: FrameCost) => string): HTMLElement {
  const maxC = Math.max(...rows.map((f) => f.clear + f.draw + f.wait));
  return h('table', { class: 'gfx-cost' },
    h('thead', null, h('tr', null, h('th', null, 'One frame'), h('th', { class: 'n' }, 'Cycles'), h('th', null, ''), label ? null : h('th', null, 'Of which'))),
    h('tbody', null, ...rows.map((f) => {
      const tot = f.clear + f.draw + f.wait;
      return h('tr', f.id === mark ? { class: 'on' } : null, h('td', null, label ? label(f) : f.name), h('td', { class: 'n' }, fmt(tot)),
        h('td', { class: 'bar' }, h('div', { class: 'stack' }, ...KINDS.filter(([k]) => f[k] > 0).map(([k, sk]) => h('i', { style: `width:${(100 * f[k]) / maxC}%;background:${KIND[sk].c}`, title: `${KIND[sk].name}: ${fmt(f[k])}` })))),
        label ? null : h('td', { class: 'mem' }, KINDS.filter(([k]) => f[k] > 0).map(([k, sk]) => `${KIND[sk].name} ${fmt(f[k])}`).join(' · ') + (f.kernel ? ` · vertex kernel ${fmt(f.kernel)}, during the clear` : '')));
    })));
}
