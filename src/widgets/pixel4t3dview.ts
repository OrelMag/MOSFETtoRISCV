// The CMOS 4T pixel in 3D (loaded on demand, pixel4t3d.ts) on the studio renderer: one back-illuminated 2.4 µm pixel in
// true geometry (pixel4t3dkit.ts), cut through its photodiode. Light of the chosen colour falls through the microlens and
// filter and is absorbed at the depth silicon gives that wavelength; its electrons gather in the pinned photodiode. Read
// steps the correlated double sampling sequence (imagesensor.ts cdsSequence): reset, sample the reset level, transfer,
// sample the signal; the floating diffusion's voltage and the column's two samples are plotted beside.

import '../styles/pixel4t3d.css';
import { packInstances, type Instance } from '../gl/instances';
import { M } from '../gl/kit/materials';
import type { Vec3 } from '../gl/math';
import { h, s } from '../ui/dom';
import { groupNum } from '../sim/numfmt';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { absorptionDepth, C_FD_FF, CG_4T, ktcNoise, qe, SF_GAIN, VDD_PIX } from '../phys/imagesensor';
import { frameLoop } from './mosfet';
import { studioStage } from './studiostage';
import { cutAt, ELECTRON, PHOTON, PIX_HIDDEN, PIX_HOME, PIX_HOME_FRAME, pixModel } from './pixel4t3dkit';
import {
  absorbed, dotAt, dots, DRAWN, electronsOf, FD_BOX, FILTER_NM, FULL_WELL, IDLE, LENS, nextPhase, PD_BOX, PHOTONS_PER_FLASH, photonsAt, phaseOf, PITCH, SI_T, sequenceOf,
  type Filter, type Photon, type PixState,
} from './pixel4t3dgeom';

/** A photon falls for FALL_MS, its electron drifts for DRIFT_MS; a CDS phase is held READ_MS while Read runs. */
const FALL_MS = 700, DRIFT_MS = 500, READ_MS = 900;
const e = (n: number): string => `${groupNum(Math.round(n))} e⁻`;
const NAMES: Record<Filter, string> = { b: 'Blue', g: 'Green', r: 'Red' };

export function pixel4tView(): Widget {
  let last: Photon[] = [];
  let st: PixState = { ...IDLE }, filter: Filter = 'g', photons: Photon[] = [], seed = 1, reading = false, held = 0, shown = '';
  const panel = h('div', { class: 'panel px4t' });
  const stage = studioStage({
    aria: 'One back-illuminated CMOS pixel in 3D, cut through its photodiode: microlens, colour filter, thinned silicon with the pinned photodiode, and on the front side the transfer gate, floating diffusion, reset, source follower and row select transistors with their metal to the column line',
    home: PIX_HOME,
    knobs: { cut: 1 },
    homeFrame: PIX_HOME_FRAME,
    hidden: PIX_HIDDEN,
    aspect: 0.78,
    limits: { minDist: 2, maxDist: 40, minPitch: -1.2, maxPan: 6 },
    scaleBar: (len) => (len >= 1 ? `${len} µm` : `${Math.round(len * 1000)} nm`),
    note: `To scale in µm (${PITCH} µm pixel, ${SI_T} µm of silicon), except the gate oxide, not drawn, and the carrier wafer: 1.2 µm of its hundreds. The trenches, films, grid and metal are representative, not the IMX183’s own (Sony does not publish them); the layout is ours and the potential funnel a sketch. A dot is ${groupNum(Math.round(FULL_WELL / 60))} electrons; the conversion gain, ${CG_4T} µV/e⁻, is illustrative.`,
    noteMore: `Drawn to scale in µm (${PITCH} µm pixel, ${SI_T} µm of thinned silicon, absorption depths from Green's 2008 table) except the gate oxide, a few nanometres and not drawn. Representative, not IMX183's own (Sony does not publish them): the deep trench walls (0.08 µm inside each edge, full depth; Sony's are oxide-filled, about 150 nm), the 0.28 µm shallow trench, the HfO₂ / Ta₂O₅ / SiO₂ films (0.03, 0.065 and 0.095 µm, the last two a quarter wave at 550 nm), the 0.25 µm metal grid, the metal levels, and the 1.2 µm drawn of the bonded carrier wafer, which is hundreds of µm thick; the p+ back layer is drawn 0.05 µm, five times the 0.01 µm dead layer the model fits. The microlens is a spherical cap whose corners meet the filter (no IMX183 sag is published). The potential funnel is a sketch: the real field comes from graded doping and deep implants. The layout is ours: a real ${PITCH} µm pixel shares its reset, follower and select transistors among two or four photodiodes. A dot is ${groupNum(Math.round(FULL_WELL / 60))} electrons, and each drawn photon stands for ${PHOTONS_PER_FLASH / DRAWN}. Sony does not publish the IMX183's conversion gain: ${CG_4T} µV/e⁻ is illustrative, and the floating diffusion's ${C_FD_FF.toFixed(2)} fF follows from it as q / CG; the full well (${groupNum(FULL_WELL)} e⁻) is an EMVA 1288 measurement.`,
    onKnobs: () => particles(),
    build: (detail) => pixModel({ s: st, filter }, detail),
  });

  const eMat = M.make({ base: '--m3-charge', metal: 0, rough: 0.4, emit: '--m3-charge', glow: 0.8, label: 'electrons (a dot is many)' });
  const lightMat = (f: Filter) => M.make({ base: `--px-${f}`, metal: 0, rough: 0.4, emit: `--px-${f}`, glow: 1, label: 'a photon (drawn as a streak)' });
  /** Electrons in the photodiode and on FD, drifting electrons and falling photons, in front of the cut left out. */
  function particles(): void {
    const zc = cutAt(stage ? stage.knobs().cut : 1), z0 = Math.max(zc, 0);
    const box = (b: typeof PD_BOX | typeof FD_BOX) => ({ x: b.x, y: b.y, z: [Math.max(z0 + 0.05, b.z[0]), b.z[1]] as const });
    const pd = box(PD_BOX), fd = box(FD_BOX), inPd = dots(st.pd), es: Instance[] = [], ls: Instance[] = [];
    const one = (p: Vec3): Instance => ({ pos: p, color: [1, 1, 1] });
    for (let k = 0; k < inPd; k++) es.push(one(dotAt(k, pd.x, pd.y, pd.z)));
    for (let k = 0; k < dots(st.fd); k++) es.push(one(dotAt(k, fd.x, fd.y, fd.z)));
    for (const f of photons) {
      if (f.z < zc) continue;
      const yHit = SI_T - Math.min(f.depth, SI_T + 0.3), top = LENS[1] + 1.2;
      if (f.t < 1) ls.push({ pos: [f.x, top + (yHit - top) * f.t, f.z], scale: [1, 5, 1], color: [1, 1, 1] });
      else if (absorbed(f) && f.t < 2) {
        const u = f.t - 1, tgt = dotAt(inPd, pd.x, pd.y, pd.z);
        es.push(one([f.x + (tgt[0] - f.x) * u, yHit + (tgt[1] - yHit) * u, f.z + (tgt[2] - f.z) * u]));
      }
    }
    stage.instances('electrons', ELECTRON, eMat, packInstances(es));
    stage.instances('photons', PHOTON, lightMat(filter), packInstances(ls));
  }
  /** The model is rebuilt only when what it draws changes: the phase, the filter, or the FD's charge. */
  function model(): void {
    const key = `${st.phase}|${filter}|${st.fd}|${st.read}`;
    if (key !== shown) { shown = key; stage.refresh(); }
  }

  const chip = h('span', { class: 'r3-chip' }), kv = h('div', { class: 'r3-kv' }), plotBox = h('div'), live = h('div', { class: 'sr-only', 'aria-live': 'polite' });
  stage.chips.append(chip);

  function plot(): SVGSVGElement {
    // Both traces on one axis: FD near the supply, the column a follower's drop below it (SF_GAIN × (FD − Vt)).
    const seq = sequenceOf(st), W = 300, H = 150, x0 = 34, cw = (W - x0 - 6) / 4, vMin = 1, vMax = VDD_PIX + 0.1;
    const y = (v: number) => 8 + ((vMax - v) / (vMax - vMin)) * (H - 30);
    const svg = s('svg', { class: 'px-plot', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'The floating diffusion\'s voltage and the column\'s through the four phases of a read, with the column\'s reset and signal samples' }) as SVGSVGElement;
    for (const v of [VDD_PIX, 2, 1.2]) svg.append(s('line', { class: 'grid', x1: x0, x2: W - 6, y1: y(v), y2: y(v) }), s('text', { x: 0, y: y(v) + 3 }, `${v.toFixed(1)} V`));
    let pts = '', cpts = '';
    const dotsAt: SVGElement[] = [];
    seq.phases.forEach((p, i) => {
      const xa = x0 + i * cw, done = st.phase >= i;
      svg.append(s('text', { class: `ph${st.phase === i ? ' now' : ''}`, x: xa + cw / 2, y: H - 6, 'text-anchor': 'middle' }, p.name));
      if (!done) return;
      pts += ` ${xa},${y(p.fd)} ${xa + cw},${y(p.fd)}`;
      cpts += ` ${xa},${y(p.col)} ${xa + cw},${y(p.col)}`;
      if (p.sample) dotsAt.push(s('circle', { class: `smp ${p.sample}`, cx: xa + cw / 2, cy: y(p.col), r: 4 }));
    });
    if (st.phase >= 0) {
      const lastPh = seq.phases[Math.min(st.phase, 3)];
      svg.append(s('polyline', { class: 'fd', points: pts.trim() }), s('polyline', { class: 'col', points: cpts.trim() }), ...dotsAt,
        s('text', { class: 'lbl', x: W - 8, y: y(lastPh.fd) - 4, 'text-anchor': 'end' }, 'FD'), s('text', { class: 'lbl', x: W - 8, y: y(lastPh.col) - 4, 'text-anchor': 'end' }, 'column'));
    }
    return svg;
  }

  /** Where the last flash's drawn photons stopped, by depth below the lit surface (µm), and how many passed through. */
  function stops(): string {
    if (!last.length) return '—';
    const bins = [0, 0, 0, 0];
    for (const p of last) bins[p.depth < 0.5 ? 0 : p.depth < 1.5 ? 1 : p.depth <= SI_T ? 2 : 3]++;
    return `${bins[0]} < 0.5 µm, ${bins[1]} to 1.5, ${bins[2]} to ${SI_T}, ${bins[3]} through`;
  }

  function readout(): void {
    const nm = FILTER_NM[filter], ph = phaseOf(st), seq = sequenceOf(st);
    chip.textContent = ph ? `${ph.name}: ${ph.note}` : reading ? 'reading' : `integrating under ${NAMES[filter].toLowerCase()} light`;
    chip.className = `r3-chip ${ph ? 'warn' : ''}`;
    const shr = seq.phases[1], shs = seq.phases[3];
    const rows: [string, string][] = [
      ['Light', `${NAMES[filter]}, ${nm} nm`],
      ['1/e absorption depth', `${absorptionDepth(nm) < 1 ? absorptionDepth(nm).toFixed(2) : absorptionDepth(nm).toFixed(1)} µm of ${SI_T} µm`],
      ['QE here', `${Math.round(qe(nm) * 100)} %`],
      ['Drawn photons stopped at', stops()],
      ['In the photodiode', e(st.pd)],
      ['On FD', st.phase < 0 ? '—' : st.phase < 2 ? 'reset, empty' : e(st.fd)],
      ['Column samples', st.phase >= 3 ? `${shr.col.toFixed(3)} V reset, ${shs.col.toFixed(3)} V signal` : st.phase >= 1 ? `${shr.col.toFixed(3)} V reset` : '—'],
      ['CDS: their difference', st.phase >= 3 ? `${(seq.cds * 1000).toFixed(1)} mV = ${e(seq.cdsE)}` : '—'],
      ['Conversion gain', `${CG_4T} µV/e⁻ (C_FD ${C_FD_FF.toFixed(2)} fF), follower ×${SF_GAIN}`],
      ['kTC reset noise', `${ktcNoise(C_FD_FF).toFixed(1)} e⁻ rms, cancelled by CDS`],
      ['Full well', e(FULL_WELL)],
    ];
    kv.replaceChildren(...rows.flatMap(([a, b]) => [h('span', null, a), h('span', { class: 'v' }, b)]));
    plotBox.replaceChildren(h('h4', null, 'Floating diffusion and the column'), plot());
    readBtn.textContent = reading ? 'Pause' : 'Read the row';
    readBtn.setAttribute('aria-pressed', String(reading));
  }

  const moving = () => photons.length > 0 || reading;
  const loop = frameLoop((_now, dt) => {
    const ms = dt * 1000;
    if (photons.length) {
      for (const p of photons) {
        const was = p.t;
        p.t += p.t < 1 ? ms / FALL_MS : ms / DRIFT_MS;
        if (was < 2 && p.t >= 2) st = { ...st, pd: Math.min(FULL_WELL, st.pd + electronsOf(p)) };
      }
      photons = photons.filter((p) => p.t < 2);
    }
    if (reading && !photons.length) {
      held += ms;
      if (held >= READ_MS) { held = 0; step(); if (st.phase < 0) reading = false; }
    }
    readout();
    model();
    particles();
  }, moving);
  function repaint(): void { readout(); model(); particles(); loop.kick(); }

  function flash(): void {
    if (st.phase >= 0) st = { ...IDLE, pd: 0 };
    const fresh = photonsAt(FILTER_NM[filter], DRAWN, seed++);
    last = fresh;
    if (reducedMotion()) { for (const p of fresh) st = { ...st, pd: Math.min(FULL_WELL, st.pd + electronsOf(p)) }; }
    else photons.push(...fresh);
    const lost = fresh.filter((p) => electronsOf(p) === 0).length;
    live.textContent = `${PHOTONS_PER_FLASH} ${NAMES[filter].toLowerCase()} photons: ${DRAWN - lost} of ${DRAWN} drawn are absorbed in the silicon${lost ? `, ${lost} pass through it` : ''}`;
    repaint();
  }
  function step(): void {
    st = nextPhase(st);
    const ph = phaseOf(st);
    live.textContent = ph ? `${ph.name}: ${ph.note}` : 'Read done: the pixel integrates again';
  }

  const filterBtns = (['b', 'g', 'r'] as Filter[]).map((f) => {
    const b = h('button', { type: 'button', class: `btn sm on px-f ${f}`, 'aria-pressed': String(f === filter) }, NAMES[f]) as HTMLButtonElement;
    b.addEventListener('click', () => { filter = f; filterBtns.forEach((x, i) => x.setAttribute('aria-pressed', String(['b', 'g', 'r'][i] === f))); repaint(); });
    return b;
  });
  const flashBtn = h('button', { type: 'button', class: 'btn sm primary' }, 'Expose');
  flashBtn.addEventListener('click', flash);
  const stepBtn = h('button', { type: 'button', class: 'btn sm' }, 'Step the read');
  stepBtn.addEventListener('click', () => { reading = false; photons = []; step(); repaint(); });
  const readBtn = h('button', { type: 'button', class: 'btn sm on', 'aria-pressed': 'false' }, 'Read the row') as HTMLButtonElement;
  readBtn.addEventListener('click', () => { reading = !reading; held = READ_MS; repaint(); });
  const reset = h('button', { type: 'button', class: 'btn sm' }, 'Empty');
  reset.addEventListener('click', () => { reading = false; photons = []; st = { ...IDLE }; repaint(); });
  stage.slot.append(h('div', { class: 'r3-ctl' },
    h('div', { class: 'r3-btns', role: 'group', 'aria-label': 'Colour filter and light' }, ...filterBtns),
    h('div', { class: 'r3-btns' }, flashBtn, stepBtn, readBtn, reset)));

  panel.append(
    h('h3', { class: 'm3-title' }, 'One pixel, cut open'),
    h('p', { class: 'm3-sub' }, `A back-illuminated pixel, drawn with the light coming from above: microlens, colour filter, then ${SI_T} µm of silicon with the pinned photodiode at its foot, and the transistors and metal on the front side below it. Which colour has the lowest QE here? Guess, then expose each in turn. Each photon stops at the depth silicon gives its wavelength (blue near the top, red deep, some red straight through), and its electron is steered into the photodiode by the potential gradient. xfer is the transfer gate, sf the follower, rs the row select; DTI is the deep trench isolation. Then step the read and watch the gates light and the floating diffusion's voltage fall in the plot.`),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' }, stage.el, live),
      h('div', { class: 'r3-side' }, h('div', null, h('h4', null, 'This pixel ', h('span', { class: 'r3-badge' }, 'model')), kv), plotBox)));
  readout();
  particles();
  return { el: panel, destroy() { loop.stop(); stage.destroy(); } };
}
