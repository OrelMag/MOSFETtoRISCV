// A three-phase CCD in 3D (loaded on demand, ccd3d.ts): the corner of a full-frame sensor on the studio renderer
// (ccd3dkit.ts: overlapping gates, channel stops, the channel potential as a moving surface, electrons as beads, the light
// and the package as layers), with the charge from ccd3dparts.ts's CcdRun. The learner exposes, steps the clocks a phase
// at a time or runs a whole readout, and turns the charge transfer efficiency down to see the smear it leaves.

import '../styles/ccd3d.css';
import { h, s } from '../ui/dom';
import { groupNum } from '../sim/numfmt';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { packInstances } from '../gl/instances';
import { fitView } from '../gl/kit/scene';
import { sphere } from '../gl/kit/geo';
import { M } from '../gl/kit/materials';
import { frameLoop } from './mosfet';
import { studioStage, type StudioStage } from './studiostage';
import { CCD42_40, ccdRetained } from '../phys/imagesensor';
import { CcdRun, CG_UV, COLS, CTE_DATASHEET, FULL_WELL, GATE, highAt, PITCH, ROWS, scene, SI_DEPTH, STEPS, type Cte, type Phase } from './ccd3dparts';
import { BEAT_LAYERS, FRAME_GROUPS, HOME, KNOBS, PACKAGE, ccdModel, electrons, highs, type CcdLayer, type CcdLook } from './ccd3dkit';

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
const BEAD = sphere(0.7, 8, 5);
const FALLBACK: CcdLook['rgb'] = { si: [0.47, 0.5, 0.63], p: [0.31, 0.53, 0.72], n: [0.79, 0.38, 0.48], poly: [0.85, 0.42, 0.42], oxide: [0.77, 0.83, 0.9], metal: [0.64, 0.67, 0.74], well: [0.35, 0.53, 0.85], charge: [0.24, 0.8, 0.54], hot: [1, 0.75, 0.29] };

export function ccdView(): Widget {
  let k = K_MAX, level = 1, run = new CcdRun(cteOf(k)), t = 1, moving: Phase = 'idle', running = false, flatAt = 0;
  run.expose(level);
  const mine = new Set<CcdLayer>();
  let shown: ReadonlySet<CcdLayer> = mine, stageRef: StudioStage | null = null;
  const rgb = (): CcdLook['rgb'] => {
    const st = stageRef;
    return st ? { si: st.rgb('--ccd-si'), p: st.rgb('--m3-p'), n: st.rgb('--m3-n'), poly: st.rgb('--m3-poly'), oxide: st.rgb('--m3-oxide'), metal: st.rgb('--m3-metal'), well: st.rgb('--ccd-well'), charge: st.rgb('--m3-charge'), hot: st.rgb('--ccd-hot') } : FALLBACK;
  };
  const panel = h('div', { class: 'panel ccd3d' });
  const stage = studioStage({
    aria: `A three-phase back-illuminated CCD in 3D: ${COLS} columns of ${ROWS} pixels with three overlapping polysilicon gates each over the oxide and the buried channel, cut open along the last column; under the gates the channel potential as a surface whose wells move with the clocks, electrons filling them; the horizontal register below with an output amplifier at each end and a dump drain; layers show the light entering the back and the ceramic package`,
    home: HOME,
    homeFrame: ['cornerbox'],
    homeRadius: 46,
    aspect: 1.05,
    hidden: [...FRAME_GROUPS],
    knobs: KNOBS,
    limits: { minDist: 20, maxDist: 400000, maxPan: 60000 },
    onBeat: (i) => { shown = i >= 0 ? new Set(BEAT_LAYERS[i] ?? []) : mine; syncChips(); draw(); },
    note: `Across the chip the drawing is to scale (the CCD42-40's ${PITCH} µm pixels, each gate ${GATE} µm: a third of the pitch, derived, since the datasheet gives the pitch and not the gate lengths) and the silicon is drawn ${SI_DEPTH} µm deep, the collecting depth the chapter's quantum-efficiency model uses for the deep-depleted part (the datasheet's text gives no thickness). Exaggerated: the oxide about eight times and the gates about three times as thick as they are, and the buried channel, drawn 2.5 µm down, which in a real device lies within about a micrometre of the oxide. The overlapping gates are the textbook three-phase structure; this part's process is not published. The blue surface's depth stands for the channel potential under each gate, not a hole in the silicon; the electrons are beads, about ${groupNum(Math.round(FULL_WELL / 70))} electrons each (full well, ${groupNum(FULL_WELL)} e⁻, fills a well to the channel). The chip is back-illuminated, so light enters from the back and the gates face away from it; it has two output amplifiers, one at each end of the register (this run reads through A; B is drawn the same, idle) and a gated dump drain on the register (its place along the register is ours; the datasheet's text gives none). The bias voltages on the parts' cards are the datasheet's typical ones; the package's ${PACKAGE.w} × ${PACKAGE.l} mm, pins and image area are its general data, its thickness and pin length drawn. Left out: the register's wider pixels and transfer gate, the dual-responsivity output gate, the follower's second stage and load, the clamp circuit, and the anti-blooming of the real part: charge beyond full well is clipped, not spilled. Only ${COLS} × ${ROWS} of the 2048 × 2048 pixels are drawn. Consumer interline CCDs such as Sony's ICX285 clock their vertical registers in four phases.`,
    build: (detail) => ccdModel({ detail, run, t, moving, layers: shown, rgb: rgb() }),
  });
  stageRef = stage;
  const beadMat = M.beam([0, 0, 0], 1, 'electrons (a bead stands for about two thousand)');
  const NONE = new Float32Array(0);
  /** The electrons, instanced (none in the package view: they would be inside a speck). */
  const putElectrons = () => {
    if (stage.isFlat()) return;
    stage.instances('e', BEAD, beadMat, shown.has('package') ? NONE : packInstances(electrons(run, t, moving, stage.rgb('--m3-charge'))));
  };
  /** The model is rebuilt when its state changes (wells, lit gates, layers); between, only the electrons glide. */
  let lastKey = '';
  function draw(frame = false): void {
    const key = `${run.vs}|${run.hs}|${moving}|${run.resetting()}|${run.fd > 0}|${[...shown].join()}`;
    const now = performance.now();
    if ((key !== lastKey || !frame) && !(frame && stage.isFlat() && now - flatAt < 150)) { flatAt = now; lastKey = key; stage.refresh(); }
    putElectrons();
  }

  const chipV = h('span', { class: 'r3-chip' }), chipH = h('span', { class: 'r3-chip' }), kv = h('div', { class: 'r3-kv' });
  stage.chips.append(chipV, chipH);
  const live = h('div', { class: 'sr-only', 'aria-live': 'polite' });
  const plotBox = h('div'), clockBox = h('div', { class: 'ccd-clock' });

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
  /** The three clocks over the six steps of a pixel transfer, the step now marked: lit where a phase is high. */
  function clocks(): SVGSVGElement {
    const reg: 'v' | 'h' = moving === 'horizontal' || run.hs > 0 ? 'h' : 'v', step = reg === 'h' ? run.hs : run.vs, W = 300, H = 56, cw = (W - 30) / STEPS, rh = 16;
    const svg = s('svg', { class: 'ccd-clk', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `The ${reg === 'h' ? 'horizontal register' : 'image'} clocks over a pixel's six steps; step ${step} now, ${phs(highAt(step))} high` }) as SVGSVGElement;
    for (let p = 1; p <= 3; p++) {
      svg.append(s('text', { x: 0, y: (p - 1) * rh + 18 }, `φ${p}`));
      for (let st = 0; st < STEPS; st++) svg.append(s('rect', { class: `c${highAt(st).includes(p) ? ' hi' : ''}${st === step ? ' now' : ''}`, x: 30 + st * cw + 1, y: (p - 1) * rh + 6, width: cw - 2, height: rh - 3 }));
    }
    return svg;
  }

  /** What the far corner keeps at the chosen CTE, against the same corner at 99 % per transfer (the chapter's point). */
  function bars(far: number, far99: number): HTMLElement {
    const row = (label: string, v: number) => h('div', { class: 'ccd-bar' }, h('span', null, label), h('i', { style: `width:${Math.max(0.5, v * 100)}%` }), h('b', null, pc(v)));
    return h('div', { class: 'ccd-bars' }, row(k >= K_MAX ? 'datasheet CTE' : pc(cteOf(k).v), far), row('99 % per transfer', far99));
  }

  function readout(): void {
    const ck = highs(run, moving), nx = run.next();
    const far = k >= K_MAX ? ccdRetained(CCD42_40.rows - 1, CCD42_40.cols - 1) : cteOf(k).v ** (CCD42_40.rows + CCD42_40.cols), far99 = 0.99 ** (CCD42_40.rows + CCD42_40.cols);
    const vOn = moving === 'vertical' || run.vs > 0, hOn = moving === 'horizontal' || run.hs > 0;
    chipV.textContent = `columns: ${phs(ck.v)} high`;
    chipV.className = `r3-chip ${vOn ? 'warn' : ''}`;
    chipH.textContent = `horizontal: ${phs(ck.h)} high`;
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
    clockBox.replaceChildren(clocks());
    stepBtn.disabled = runBtn.disabled = nx === 'idle' && !running;
    runBtn.textContent = running ? 'Pause' : 'Run readout';
    runBtn.setAttribute('aria-pressed', String(running));
  }

  const loop = frameLoop((_now, dt) => {
    if (t < 1) t = Math.min(1, t + (dt * 1000) / (running ? RUN_STEP_MS : STEP_MS));
    else if (running && !advance()) running = false;
    readout();
    draw(true);
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

  // layers: the light entering the back; the whole chip (with its own view: the package, the corner a speck)
  const CHIPS: [CcdLayer, string, string][] = [['light', 'Light', 'Light entering the back of the thinned silicon'], ['package', 'The whole chip', 'The ceramic package and the image area, the drawn corner marked']];
  const chipBtns = CHIPS.map(([key, label, title]) => {
    const b = h('button', { type: 'button', class: 'btn sm', title, 'aria-pressed': 'false' }, label) as HTMLButtonElement;
    b.addEventListener('click', () => {
      if (shown !== mine) { mine.clear(); for (const l of shown) mine.add(l); }
      if (mine.has(key)) mine.delete(key); else mine.add(key);
      shown = mine; syncChips(); draw();
      if (key !== 'package') return;
      const st = stage.studio(), cv = stage.el.querySelector('canvas');
      if (!st || !cv) return;
      if (!shown.has('package')) { st.camera.reset(); st.invalidate(); return; }
      const P = PACKAGE, mm = 1000, yaw = 2.4, pitch = 0.75, cx = (P.image * mm) / 2;
      const f = fitView({ min: [cx - (P.w * mm) / 2, -12000, cx - (P.rows * mm) / 2 - 500], max: [cx + (P.w * mm) / 2, 2000, cx + (P.rows * mm) / 2 + 500] }, yaw, pitch, st.camera.fov, cv.clientWidth / Math.max(1, cv.clientHeight), 0.06);
      const c = st.camera;
      c.limits.maxDist = Math.max(c.limits.maxDist, f.dist * 1.5);
      c.target = f.target; c.yaw = yaw; c.pitch = pitch; c.dist = f.dist;
      st.invalidate();
    });
    return b;
  });
  function syncChips(): void { chipBtns.forEach((b, i) => { const on = shown.has(CHIPS[i][0]); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }); }

  stage.slot.append(
    h('div', { class: 'r3-ctl' }, h('div', { class: 'r3-btns' }, exposeBtn, stepBtn, runBtn), h('div', { class: 'r3-btns', role: 'group', 'aria-label': 'Layers' }, ...chipBtns)),
    h('div', { class: 'r3-ctl' },
      h('label', { class: 'r3-sl' }, h('span', null, 'CTE'), cte, cteOut),
      h('label', { class: 'r3-sl' }, h('span', null, 'Brightest pixel'), lvl, lvlOut)),
    clockBox, live);
  panel.append(
    h('h3', { class: 'm3-title' }, 'Charge, moved a gate at a time'),
    h('p', { class: 'm3-sub' }, `Light enters through the back; the gates face away from it. The silicon is cut open along the right-hand column, and the gates over the near half of the horizontal register are left off, so the charge shows. Under the gates the blue surface is the channel potential: deep under a high gate, shallow under a low one, so the electrons (green) sit where the clock lets them. Step a phase to watch the wells move and the electrons follow half a gate at a time; a row drops into the horizontal register, which carries it to the floating diffusion beside output A. Before each packet arrives the reset gate lights and the diffusion's level is sampled (1); once the packet is on it, it is sampled again (2), and the difference is the signal.`),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' }, stage.el),
      h('div', { class: 'r3-side' }, h('div', null, h('h4', null, 'This readout ', h('span', { class: 'r3-badge' }, 'model')), kv), plotBox)));

  syncChips();
  readout();
  const ready = setInterval(() => { if (stage.studio() || stage.isFlat()) { clearInterval(ready); draw(); } }, 100);
  return { el: panel, destroy() { clearInterval(ready); loop.stop(); stage.destroy(); } };
}
