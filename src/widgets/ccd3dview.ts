// A three-phase CCD in 3D (loaded on demand, ccd3d.ts): the corner of a full-frame sensor, its horizontal register and
// output amplifier, with the charge from ccd3dparts.ts's CcdRun. The learner exposes, steps the clocks a phase at a time
// or runs a whole readout, and turns the charge transfer efficiency down to see the smear it leaves.

import '../styles/ccd3d.css';
import { h, s } from '../ui/dom';
import { groupNum } from '../sim/numfmt';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { frameLoop } from './mosfet';
import { LOOKS } from '../gl/kit/looks';
import { modelStage } from './modelstage';
import { CCD42_40, ccdRetained } from '../phys/imagesensor';
import { ccdAnchors, ccdParts, CcdRun, CG_UV, COLS, CTE_DATASHEET, FULL_WELL, GATE, PITCH, ROWS, scene, SI_DEPTH, STEPS, type CcdPalette, type Cte, type Phase } from './ccd3dparts';

/** One clock step is drawn over this long; a run takes one after another. */
const STEP_MS = 360, RUN_STEP_MS = 130;
/** The CTE slider: 1 − 10^−k for k from 1 to 5, then the datasheet's pair (99.9999 % parallel, 99.9993 % serial). */
const K_MIN = 1, K_MAX = 6;
const cteOf = (k: number): Cte => (k >= K_MAX ? CTE_DATASHEET : { v: 1 - 10 ** -k, h: 1 - 10 ** -k });
const pc = (c: number): string => `${+(c * 100).toFixed(4)} %`;
const cteText = (k: number): string => { const c = cteOf(k); return k >= K_MAX ? `datasheet: ${pc(c.v)} down, ${pc(c.h)} across` : pc(c.v); };
const uv = (v: number): string => (v >= 1000 ? `${groupNum(Math.round(v))} µV (${(v / 1000).toFixed(1)} mV)` : `${groupNum(Math.round(v))} µV`);
const phs = (p: readonly number[]): string => p.map((x) => `φ${x}`).join(' + ');
const e = (n: number): string => `${groupNum(Math.round(n))} e⁻`;

export function ccdView(): Widget {
  let k = K_MAX, level = 1, run = new CcdRun(cteOf(k)), t = 1, moving: Phase = 'idle', running = false;
  run.expose(level);
  const panel = h('div', { class: 'panel ccd3d' });
  const stage = modelStage(panel, {
    look: LOOKS.silicon,
    aria: `A three-phase back-illuminated CCD in 3D: ${COLS} columns of ${ROWS} pixels with three polysilicon gates each, the horizontal register below them with an output amplifier at each end and a dump drain, light entering through the back of the silicon, and charge packets in potential wells under the gates`,
    camera: innerWidth < 600 ? { target: [8, -10, 0], yaw: 2.05, pitch: 0.8, dist: 105 } : { target: [12, -12, 2], yaw: 2.05, pitch: 0.8, dist: 125 },
    limits: { minDist: 30, maxDist: 360 },
    note: `Across the chip the drawing is to scale (the CCD42-40's ${PITCH} µm pixels, each gate ${GATE} µm: a third of the pitch, derived, since the datasheet gives the pitch and not the gate lengths) and the silicon is drawn ${SI_DEPTH} µm deep, the collecting depth the chapter's quantum-efficiency model uses for the deep-depleted part (the datasheet's text gives no thickness). Exaggerated: the oxide about eight times and the gates about three times as thick as they are, and the buried channel, drawn 2.5 µm down, which in a real device lies within about a micrometre of the oxide. A well's depth stands for the channel potential under its gate, not a hole in the silicon. A packet is a box standing on its well's floor, filling it as water would (full well, ${groupNum(FULL_WELL)} e⁻, fills it to the channel). The chip is back-illuminated, so light enters from the back and the gates face away from it; it has two output amplifiers, one at each end of the register (this run reads through A; B is drawn the same, idle) and a gated dump drain on the register (its place along the register is ours; the datasheet's text gives none). Left out: the register's wider pixels and transfer gate, the dual-responsivity output gate, the follower's second stage and load, the clamp circuit, and the anti-blooming of the real part: charge beyond full well is clipped, not spilled. Only ${COLS} × ${ROWS} of the 2048 × 2048 pixels are drawn. Consumer interline CCDs such as Sony's ICX285 clock their vertical registers in four phases.`,
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
      const r = Math.floor(i / COLS), c = i % COLS, want = Math.min(FULL_WELL, Math.round(run.level * scene(r, c) * FULL_WELL)), got = run.samples[i];
      svg.append(s('rect', { class: 'want', x: i * bw + 2, width: bw - 4, y: y(want), height: H - 14 - y(want) }));
      if (got) svg.append(s('rect', { class: 'got', x: i * bw + 5, width: bw - 10, y: y(got.e), height: H - 14 - y(got.e) }));
      if (c === 0) svg.append(s('text', { x: i * bw + 2, y: H - 2 }, `row ${r}`));
    }
    return svg;
  }

  /** What the far corner keeps at the chosen CTE, against the same corner at 99 % per transfer (the chapter's point). */
  function bars(far: number, far99: number): HTMLElement {
    const row = (label: string, v: number) => h('div', { class: 'ccd-bar' }, h('span', null, label), h('i', { style: `width:${Math.max(0.5, v * 100)}%` }), h('b', null, pc(v)));
    return h('div', { class: 'ccd-bars' }, row(k >= K_MAX ? 'datasheet CTE' : pc(cteOf(k).v), far), row('99 % per transfer', far99));
  }

  function readout(): void {
    const ck = run.clocks(), nx = run.next();
    const far = k >= K_MAX ? ccdRetained(CCD42_40.rows - 1, CCD42_40.cols - 1) : cteOf(k).v ** (CCD42_40.rows + CCD42_40.cols), far99 = 0.99 ** (CCD42_40.rows + CCD42_40.cols);
    const vOn = moving === 'vertical' || run.vs > 0, hOn = moving === 'horizontal' || run.hs > 0;
    chipV.textContent = `columns: ${phs(vOn ? ck.v : [1])} high`;
    chipV.className = `r3-chip ${vOn ? 'warn' : ''}`;
    chipH.textContent = `horizontal: ${phs(hOn ? ck.h : [1])} high`;
    chipH.className = `r3-chip ${hOn ? 'warn' : ''}`;
    const rows: [string, string][] = [
      ['Pixels read', `${run.samples.length} of ${ROWS * COLS}`],
      ['Next step', nx === 'idle' ? 'none: all read (Expose again)' : nx === 'vertical' ? `the columns, step ${run.vs + 1} of ${STEPS}` : `the horizontal register, step ${run.hs + 1} of ${STEPS}`],
      ['On the floating diffusion', run.fd > 0 ? e(run.fd) : 'reset'],
      ['1 · reset sample', run.cdsRef ? 'V_ref (diffusion reset)' : '—'],
      ['2 · signal sample', run.cdsSig ? `V_ref − ${uv(run.cdsSig.uv)}` : run.cdsRef ? 'waiting for the packet' : '—'],
      ['CDS: 1 − 2', run.cdsSig ? `${uv(run.cdsSig.uv)} = ${e(run.cdsSig.e)} at ${CG_UV} µV/e⁻` : '—'],
      ['CTE', cteText(k)],
      ['Far corner here', `${ROWS} down + ${COLS} across: keeps ${pc(cteOf(k).v ** ROWS * cteOf(k).h ** COLS)}`],
      [`Far corner of ${groupNum(CCD42_40.cols)} × ${groupNum(CCD42_40.rows)}`, `${groupNum(CCD42_40.rows)} + ${groupNum(CCD42_40.cols)} transfers: keeps ${pc(far)}`],
    ];
    kv.replaceChildren(...rows.flatMap(([a, b]) => [h('span', null, a), h('span', { class: 'v' }, b)]));
    plotBox.replaceChildren(h('h4', null, 'Read out, against collected'), plot(), h('h4', null, 'The far corner arrives with'), bars(far, far99));
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
  exposeBtn.addEventListener('click', () => { running = false; run = new CcdRun(cteOf(k)); run.expose(level); moving = 'idle'; t = 1; live.textContent = 'Exposed: every pixel holds its charge under φ1'; lvlText(); repaint(); });
  const stepBtn = h('button', { type: 'button', class: 'btn sm' }, 'Step a phase') as HTMLButtonElement;
  stepBtn.addEventListener('click', () => { running = false; t = 1; advance(); repaint(); });
  const runBtn = h('button', { type: 'button', class: 'btn sm on', 'aria-pressed': 'false' }, 'Run readout') as HTMLButtonElement;
  runBtn.addEventListener('click', () => { running = !running; repaint(); });

  const cte = h('input', { type: 'range', min: K_MIN, max: K_MAX, step: 1, value: k, 'aria-label': 'Charge transfer efficiency' }) as HTMLInputElement;
  const cteOut = h('output', null, k >= K_MAX ? 'datasheet' : pc(cteOf(k).v));
  cte.addEventListener('input', () => { k = Number(cte.value); run.cte = { ...cteOf(k) }; cteOut.textContent = k >= K_MAX ? 'datasheet' : pc(cteOf(k).v); repaint(); });
  const lvl = h('input', { type: 'range', min: 10, max: 100, step: 5, value: level * 100, 'aria-label': 'Brightest pixel, as a share of full well; applies at the next Expose' }) as HTMLInputElement;
  const lvlOut = h('output', null);
  const lvlText = (): void => { lvlOut.textContent = `${Math.round(level * 90)} % of full well${level !== run.level ? ', at next Expose' : ''}`; exposeBtn.classList.toggle('pending', level !== run.level); };
  lvl.addEventListener('input', () => { level = Number(lvl.value) / 100; lvlText(); }); // takes effect at the next Expose
  lvlText();

  panel.append(
    h('h3', { class: 'm3-title' }, 'Charge, moved a gate at a time'),
    h('p', { class: 'm3-sub' }, `Light enters through the back (the glowing beams below the silicon); the gates face away from it. The gates are cut away over the right-hand column and the near half of the horizontal register. Under each gate the blue floor is the channel potential: deep under a high gate, shallow under a low one, so a packet (green, its volume its charge) sits where the clock lets it. Step a phase to watch the wells move and the packets follow half a gate at a time; a row drops into the horizontal register, which carries it to the floating diffusion beside output A. Before each packet arrives the reset gate lights and the diffusion's level is sampled (1); once the packet is on it, it is sampled again (2), and the difference is the signal.`),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' },
        h('div', { class: 'r3-ctl' }, h('div', { class: 'r3-btns' }, exposeBtn, stepBtn, runBtn, stage.resetBtn)),
        h('div', { class: 'r3-ctl' },
          h('label', { class: 'r3-sl' }, h('span', null, 'CTE'), cte, cteOut),
          h('label', { class: 'r3-sl' }, h('span', null, 'Brightest pixel'), lvl, lvlOut)),
        stage.el, stage.hint, live),
      h('div', { class: 'r3-side' }, h('div', null, h('h4', null, 'This readout ', h('span', { class: 'r3-badge' }, 'model')), kv), plotBox)));

  readout();
  draw();
  return { el: panel, destroy() { loop.stop(); stage.destroy(); } };
}
