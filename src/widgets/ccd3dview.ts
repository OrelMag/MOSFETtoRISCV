// A three-phase CCD in 3D (loaded on demand, ccd3d.ts): the corner of a full-frame sensor, its horizontal register and
// output amplifier, with the charge from ccd3dparts.ts's CcdRun. The learner exposes, steps the clocks a phase at a time
// or runs a whole readout, and turns the charge transfer efficiency down to see the smear it leaves.

import '../styles/ccd3d.css';
import { h, s } from '../ui/dom';
import { groupNum } from '../sim/numfmt';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { frameLoop } from './mosfet';
import { modelStage } from './modelstage';
import { CCD42_40, ccdRetained } from '../phys/imagesensor';
import { ccdAnchors, ccdParts, CcdRun, CG_UV, COLS, CTE_DATASHEET, FULL_WELL, GATE, PITCH, ROWS, scene, STEPS, type CcdPalette, type Cte, type Phase } from './ccd3dparts';

/** One clock step is drawn over this long; a run takes one after another. */
const STEP_MS = 360, RUN_STEP_MS = 130;
/** The CTE slider: 1 − 10^−k for k from 1 to 5, then the datasheet's pair (99.9999 % parallel, 99.9993 % serial). */
const K_MIN = 1, K_MAX = 6;
const cteOf = (k: number): Cte => (k >= K_MAX ? CTE_DATASHEET : { v: 1 - 10 ** -k, h: 1 - 10 ** -k });
const pc = (c: number): string => `${+(c * 100).toFixed(4)} %`;
const cteText = (k: number): string => { const c = cteOf(k); return k >= K_MAX ? `datasheet: ${pc(c.v)} down, ${pc(c.h)} across` : pc(c.v); };
const phs = (p: readonly number[]): string => p.map((x) => `φ${x}`).join(' + ');
const e = (n: number): string => `${groupNum(Math.round(n))} e⁻`;

export function ccdView(): Widget {
  let k = K_MAX, level = 1, run = new CcdRun(cteOf(k)), t = 1, moving: Phase = 'idle', running = false;
  run.expose(level);
  const panel = h('div', { class: 'panel ccd3d' });
  const stage = modelStage(panel, {
    aria: `A three-phase CCD in 3D: ${COLS} columns of ${ROWS} pixels with three polysilicon gates each, the horizontal register below them and the output amplifier, with charge packets in potential wells under the gates`,
    camera: { target: [16, -4, 12], yaw: 2.05, pitch: 0.8, dist: 96 },
    limits: { minDist: 35, maxDist: 320 },
    note: `Across the chip the drawing is to scale (the CCD42-40's ${PITCH} µm pixels, each gate ${GATE} µm: a third of the pitch, derived, since the datasheet gives the pitch and not the gate lengths); the layers are drawn about four times thicker than they are. A well's depth stands for the channel potential under its gate, not a hole in the silicon, and a packet's volume is its charge (full well ${groupNum(FULL_WELL)} e⁻). Only ${COLS} × ${ROWS} of the 2048 × 2048 pixels are drawn, and charge beyond full well, which would bloom up and down the column, is clipped. Consumer interline CCDs such as Sony's ICX285 clock their vertical registers in four phases.`,
    draw: () => draw(),
  });
  const palette = (): CcdPalette => ({
    si: stage.rgba('--ccd-si', 0.3), p: stage.rgb('--m3-p'), n: stage.rgb('--m3-n'), chan: stage.rgba('--m3-n', 0.18), poly: stage.rgb('--m3-poly'), oxide: stage.rgba('--m3-oxide', 0.28),
    metal: stage.rgb('--m3-metal'), well: stage.rgba('--ccd-well', 0.85), charge: stage.rgb('--m3-charge'), hot: stage.rgb('--ccd-hot'),
  });
  const draw = () => stage.paint(ccdParts({ run, t, moving }, palette()), ccdAnchors());

  const chipV = h('span', { class: 'r3-chip' }), chipH = h('span', { class: 'r3-chip' }), kv = h('div', { class: 'r3-kv' });
  stage.chips.append(chipV, chipH);
  const live = h('div', { class: 'sr-only', 'aria-live': 'polite' });
  const plotBox = h('div');

  function plot(): SVGSVGElement {
    const W = 300, H = 120, n = ROWS * COLS, bw = W / n, y = (v: number) => H - 14 - (v / FULL_WELL) * (H - 24);
    const svg = s('svg', { class: 'ccd-plot', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `The output: each pixel's charge as it is read, against what it collected (${run.samples.length} of ${n} read)` }) as SVGSVGElement;
    svg.append(s('line', { class: 'ax', x1: 0, x2: W, y1: H - 14, y2: H - 14 }));
    for (let i = 0; i < n; i++) {
      const r = Math.floor(i / COLS), c = i % COLS, want = Math.min(FULL_WELL, Math.round(level * scene(r, c) * FULL_WELL)), got = run.samples[i];
      svg.append(s('rect', { class: 'want', x: i * bw + 2, width: bw - 4, y: y(want), height: H - 14 - y(want) }));
      if (got) svg.append(s('rect', { class: 'got', x: i * bw + 5, width: bw - 10, y: y(got.e), height: H - 14 - y(got.e) }));
      if (c === 0) svg.append(s('text', { x: i * bw + 2, y: H - 2 }, `row ${r}`));
    }
    return svg;
  }

  function readout(): void {
    const ck = run.clocks(), nx = run.next();
    const vOn = moving === 'vertical' || run.vs > 0, hOn = moving === 'horizontal' || run.hs > 0;
    chipV.textContent = `columns: ${phs(vOn ? ck.v : [1])} high`;
    chipV.className = `r3-chip ${vOn ? 'warn' : ''}`;
    chipH.textContent = `horizontal: ${phs(hOn ? ck.h : [1])} high`;
    chipH.className = `r3-chip ${hOn ? 'warn' : ''}`;
    const last = run.samples[run.samples.length - 1];
    const rows: [string, string][] = [
      ['Pixels read', `${run.samples.length} of ${ROWS * COLS}`],
      ['Next step', nx === 'idle' ? 'none: all read (Expose again)' : nx === 'vertical' ? `the columns, step ${run.vs + 1} of ${STEPS}` : `the horizontal register, step ${run.hs + 1} of ${STEPS}`],
      ['On the floating diffusion', run.fd > 0 ? e(run.fd) : 'reset'],
      ['Output swing', last ? `${groupNum(Math.round(last.uv))} µV (${CG_UV} µV/e⁻)` : '—'],
      ['CTE', cteText(k)],
      ['Far corner here', `${ROWS} down + ${COLS} across: keeps ${pc(cteOf(k).v ** ROWS * cteOf(k).h ** COLS)}`],
      [`Far corner of ${groupNum(CCD42_40.cols)} × ${groupNum(CCD42_40.rows)}`, `${groupNum(CCD42_40.rows)} + ${groupNum(CCD42_40.cols)} transfers: keeps ${pc(k >= K_MAX ? ccdRetained(CCD42_40.rows - 1, CCD42_40.cols - 1) : cteOf(k).v ** (CCD42_40.rows + CCD42_40.cols))}`],
    ];
    kv.replaceChildren(...rows.flatMap(([a, b]) => [h('span', null, a), h('span', { class: 'v' }, b)]));
    plotBox.replaceChildren(h('h4', null, 'Read out, against collected'), plot());
    stepBtn.disabled = runBtn.disabled = nx === 'idle' && !running;
    runBtn.textContent = running ? 'Pause' : 'Run readout';
    runBtn.setAttribute('aria-pressed', String(running));
  }

  const loop = frameLoop((_now, dt) => {
    if (t < 1) t = Math.min(1, t + (dt * 1000) / (running ? RUN_STEP_MS : STEP_MS));
    else if (running && !advance()) running = false;
    readout();
    draw();
  }, () => t < 1 || running);

  function advance(): boolean {
    if (run.done()) return false;
    moving = run.step();
    t = reducedMotion() ? 1 : 0;
    const s0 = run.samples.length, last = run.samples[s0 - 1];
    if (moving === 'horizontal' && run.hs === 2 && last) live.textContent = `Row ${last.row}, column ${last.col}: ${e(last.e)}, ${groupNum(Math.round(last.uv))} µV`;
    return true;
  }
  function repaint(): void { readout(); draw(); loop.kick(); }

  const exposeBtn = h('button', { type: 'button', class: 'btn sm primary' }, 'Expose');
  exposeBtn.addEventListener('click', () => { running = false; run = new CcdRun(cteOf(k)); run.expose(level); moving = 'idle'; t = 1; live.textContent = 'Exposed: every pixel holds its charge under φ1'; repaint(); });
  const stepBtn = h('button', { type: 'button', class: 'btn sm' }, 'Step a phase') as HTMLButtonElement;
  stepBtn.addEventListener('click', () => { running = false; t = 1; advance(); repaint(); });
  const runBtn = h('button', { type: 'button', class: 'btn sm on', 'aria-pressed': 'false' }, 'Run readout') as HTMLButtonElement;
  runBtn.addEventListener('click', () => { running = !running; repaint(); });

  const cte = h('input', { type: 'range', min: K_MIN, max: K_MAX, step: 1, value: k, 'aria-label': 'Charge transfer efficiency' }) as HTMLInputElement;
  const cteOut = h('output', null, k >= K_MAX ? 'datasheet' : pc(cteOf(k).v));
  cte.addEventListener('input', () => { k = Number(cte.value); run.cte = { ...cteOf(k) }; cteOut.textContent = k >= K_MAX ? 'datasheet' : pc(cteOf(k).v); repaint(); });
  const lvl = h('input', { type: 'range', min: 10, max: 100, step: 5, value: level * 100, 'aria-label': 'Exposure: the brightest pixel as a share of full well' }) as HTMLInputElement;
  const lvlOut = h('output', null, `${Math.round(level * 90)} % full`);
  lvl.addEventListener('input', () => { level = Number(lvl.value) / 100; lvlOut.textContent = `${Math.round(level * 90)} % full`; });

  panel.append(
    h('h3', { class: 'm3-title' }, 'Charge, moved a gate at a time'),
    h('p', { class: 'm3-sub' }, `The gates are cut away over the right-hand column and the near half of the horizontal register. Under each gate the blue floor is the channel potential: deep under a high gate, shallow under a low one, so a packet (green, its volume its charge) sits where the clock lets it. Step a phase to watch the wells move and the packets follow half a gate at a time; a row drops into the horizontal register, which carries it to the floating diffusion beside the output.`),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' },
        h('div', { class: 'r3-ctl' }, h('div', { class: 'r3-btns' }, exposeBtn, stepBtn, runBtn, stage.resetBtn)),
        h('div', { class: 'r3-ctl' },
          h('label', { class: 'r3-sl' }, h('span', null, 'CTE'), cte, cteOut),
          h('label', { class: 'r3-sl' }, h('span', null, 'Light'), lvl, lvlOut)),
        stage.el, stage.hint, live),
      h('div', { class: 'r3-side' }, h('div', null, h('h4', null, 'This readout ', h('span', { class: 'r3-badge' }, 'model')), kv), plotBox)));

  readout();
  draw();
  return { el: panel, destroy() { loop.stop(); stage.destroy(); } };
}
