// The MEMS microphone in 3D (loaded on demand, modelhost.ts): a tone at a chosen sound pressure runs through phys/memsmic.ts
// (the membrane, the two capacitances, the converters chapter's loop and CIC), widgets/mems3dkit.ts draws it on the studio
// renderer. Time is slowed: one period of the tone takes a few seconds, so the membrane can be seen to move; the bits under
// the canvas are the loop's, at the real 3.072 MHz clock.

import '../styles/mems3d.css';
import { SD_LIMIT } from '../dsp/converters';
import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { frameLoop } from './mosfet';
import { studioStage } from './studiostage';
import { bendMembrane, micModel, MIC_HOME, newBitsTex, paintBits, STACK_K, SWING_K, type MicState } from './mems3dkit';
import { capacitances, FS_PER_PA, IM69, MAX_SPL, MEMBRANE, MIC_CHAIN, PCM_RATE, deflection, membraneVolts, micRun, sensitivityDbv, splToPa, type MicRun } from '../phys/memsmic';

/** Wall-clock seconds for one period of the tone, on Run. */
const PERIOD_S = 3;
const SVGNS = 'http://www.w3.org/2000/svg';
const svgEl = <K extends keyof SVGElementTagNameMap>(k: K, a: Record<string, string> = {}): SVGElementTagNameMap[K] => {
  const e = document.createElementNS(SVGNS, k);
  for (const [n, v] of Object.entries(a)) e.setAttribute(n, v);
  return e;
};
const fmtM = (m: number) => { const a = Math.abs(m); return a >= 1e-6 ? `${(m * 1e6).toFixed(2)} µm` : a >= 1e-9 ? `${(m * 1e9).toFixed(2)} nm` : `${(m * 1e12).toFixed(1)} pm`; };
const minus = (s: string) => s.replace('-', '−');

export function micView(): Widget {
  let spl = 114, hz = 1000, phase = 0.25, running = false;
  let run: MicRun = micRun(spl, hz, 1);
  const bitsTex = newBitsTex();
  /** Clocks in one period of the tone; the run covers a warm-up period, then the one shown. */
  const per = () => Math.round(IM69.clock / hz);
  const idx = () => per() + Math.min(per() - 1, Math.floor(phase * per()));
  const recompute = () => { run = micRun(spl, hz, 2 * per() + MIC_CHAIN.R * 8); };
  recompute();
  const state = (): MicState => ({ p: run.pressure[idx()], bits: bitsTex, spl });

  const stage = studioStage({
    aria: 'An Infineon IM69D130 MEMS microphone in 3D, cut open: the substrate with its sound port, the MEMS die with a membrane between two perforated backplates, the ASIC and its bond wires, under a metal lid',
    home: MIC_HOME,
    // the can fitted as a sphere round its middle: it fills the width
    homeRadius: 1.4,
    aspect: 1.6,
    knobs: { cut: 1 },
    scaleBar: (len) => `${len} mm`,
    limits: { minDist: 1.2, maxDist: 40 },
    note: `The package, its port and pads are the IM69D130 datasheet's (Infineon, v1.0, 2017). Inside, the sizes are typical (no teardown of this part was found): a membrane ${(2 * MEMBRANE.a * 1e3).toFixed(1)} mm across, ${MEMBRANE.h * 1e6} µm thick, ${MEMBRANE.gap * 1e6} µm from each backplate, with its stress fitted (${(MEMBRANE.sigma / 1e6).toFixed(1)} MPa) so the stack gives −38 dBV/Pa, the figure Infineon published in 2013 for its analog chips. The plate stack is drawn ${STACK_K} times taller than life and the membrane's swing ${SWING_K} times more again; sizes across are true. The ASIC's gain is set from the datasheet's −36 dBFS at 94 dB SPL, and the chapter's order-${MIC_CHAIN.order} loop and order-${MIC_CHAIN.N} CIC stand in for the real ASIC's, whose design is not published. Time is slowed: one period of the tone takes ${PERIOD_S} s.`,
    build: (detail) => micModel(state(), detail),
  });

  // the plot: one period of the pressure, the bits' density under it (each column the share of 1s), the CIC's words as dots
  const PW = 360, PH = 150, plot = svgEl('svg', { class: 'mm-plot', viewBox: `0 0 ${PW} ${PH}`, role: 'img', 'aria-label': 'One period of the sound pressure, the density of 1s in the bit stream under it, and the CIC output words' });
  const pres = svgEl('polyline', { class: 'mm-p' }), words = svgEl('g', { class: 'mm-w' }), dens = svgEl('g', { class: 'mm-d' }), cur = svgEl('line', { class: 'mm-cur', y1: '4', y2: String(PH - 4) });
  const zoom = svgEl('g', { class: 'mm-z' });
  plot.append(svgEl('line', { class: 'mm-zero', x1: '0', x2: String(PW), y1: '40', y2: '40' }), pres, words, dens, zoom, cur,
    svgEl('text', { x: '2', y: '10', class: 'mm-l' }), svgEl('text', { x: '2', y: '86', class: 'mm-l' }), svgEl('text', { x: '2', y: '118', class: 'mm-l' }));
  const [l1, l2, l3] = [...plot.querySelectorAll('text')];
  l1.textContent = 'pressure (line) · CIC words (dots)'; l2.textContent = 'share of 1s in the bit stream'; l3.textContent = 'the last 96 bits on DATA';
  function drawPlot(): void {
    const n = per(), p0 = n, amp = splToPa(spl) * Math.SQRT2 || 1, Y = (v: number) => (40 - v * 26).toFixed(1);
    const pts: string[] = [];
    for (let k = 0; k <= 180; k++) { const i = p0 + Math.min(n - 1, Math.floor((k / 180) * n)); pts.push(`${((k / 180) * PW).toFixed(1)},${Y(run.pressure[i] / amp)}`); }
    pres.setAttribute('points', pts.join(' '));
    // the words: one per R clocks; the CIC's delay is (N (R − 1)) / 2 clocks, so each word is drawn where its middle input was
    // word j is the filter over the clocks up to taps − 1 + j·R; its middle is N (R − 1) / 2 clocks before that
    const { N, R } = MIC_CHAIN, full = amp * FS_PER_PA, dots: SVGElement[] = [];
    run.words.forEach((w, j) => {
      const at = N * (R - 1) + j * R - (N * (R - 1)) / 2 - p0;
      if (at < 0 || at >= n) return;
      dots.push(svgEl('circle', { cx: ((at / n) * PW).toFixed(1), cy: Y(w / full), r: '1.8' }));
    });
    words.replaceChildren(...dots);
    const cols: SVGElement[] = [], C = 90;
    for (let k = 0; k < C; k++) {
      const a = p0 + Math.floor((k / C) * n), b = p0 + Math.floor(((k + 1) / C) * n);
      let ones = 0; for (let i = a; i < b; i++) ones += run.bits[i];
      const q = ones / Math.max(1, b - a), g = Math.round(20 + 200 * q);
      cols.push(svgEl('rect', { x: ((k / C) * PW).toFixed(1), y: '90', width: (PW / C + 0.3).toFixed(2), height: '18', fill: `rgb(${g},${Math.round(g * 0.85)},${Math.round(g * 0.5)})` }));
    }
    dens.replaceChildren(...cols);
    const i = idx(), ticks: SVGElement[] = [];
    for (let k = 0; k < 96; k++) {
      const b = run.bits[i - 95 + k];
      ticks.push(svgEl('rect', { x: (k * (PW / 96)).toFixed(1), y: b ? '122' : '136', width: (PW / 96 - 0.6).toFixed(2), height: '10', class: b ? 'one' : 'zero' }));
    }
    zoom.replaceChildren(...ticks);
    const x = (Math.min(n - 1, Math.floor(phase * n)) / n) * PW;
    cur.setAttribute('x1', x.toFixed(1)); cur.setAttribute('x2', x.toFixed(1));
  }

  const kv = h('div', { class: 'r3-kv' }), chip = h('span', { class: 'r3-chip good' });
  stage.chips.append(chip);
  function readout(): void {
    const i = idx(), p = run.pressure[i], [c1, c2] = capacitances(MEMBRANE, p), [c10] = capacitances(MEMBRANE, 0);
    const win = run.bits.slice(Math.max(0, i - 255), i + 1), ones = win.reduce((a, b) => a + b, 0) / win.length;
    const rows: [string, string][] = [
      ['Sound', `${spl.toFixed(0)} dB SPL, ${splToPa(spl).toPrecision(3)} Pa RMS, ${hz} Hz`],
      ['Pressure now', `${minus(p.toPrecision(3))} Pa`],
      ['Membrane, middle (real)', `${minus(fmtM(deflection(MEMBRANE, p, 0)))} of ${MEMBRANE.gap * 1e6} µm`],
      ['C₁, C₂ (rest)', `${(c10 * 1e12).toFixed(3)} pF each (typical)`],
      ['C₁ − C₂ now', `${minus(((c1 - c2) * 1e15).toPrecision(3))} fF`],
      ['Membrane voltage', `${minus((membraneVolts(MEMBRANE, p) * 1e3).toPrecision(3))} mV (${sensitivityDbv(MEMBRANE).toFixed(0)} dBV/Pa, fitted)`],
      ['Share of 1s, last 256 clocks', `${(ones * 100).toFixed(0)} %`],
      ['Output', `${(PCM_RATE / 1e3).toFixed(0)} kHz words: ÷ ${MIC_CHAIN.R} by an order-${MIC_CHAIN.N} CIC`],
    ];
    kv.replaceChildren(...rows.flatMap(([k, v]) => [h('span', null, k), h('span', { class: 'v' }, v)]));
    chip.textContent = `${spl.toFixed(0)} dB SPL · DATA ${IM69.clock / 1e6} MHz · ${(ones * 100).toFixed(0)} % ones`;
  }
  function paint(): void {
    paintBits(bitsTex, run.bits.slice(0, idx() + 1));
    bendMembrane(run.pressure[idx()]);
    stage.refresh();
    drawPlot();
    readout();
  }

  const loop = frameLoop((_now, dt) => {
    if (running) phase = (phase + (reducedMotion() ? 0.125 : dt / PERIOD_S)) % 1;
    paint();
  }, () => running);

  const splIn = h('input', { type: 'range', min: 40, max: Math.floor(MAX_SPL * 10) / 10, step: 0.5, value: spl, 'aria-label': 'Sound pressure level' }) as HTMLInputElement;
  const splOut = h('output', null, '');
  splIn.addEventListener('input', () => { spl = Number(splIn.value); splOut.textContent = `${spl.toFixed(1)} dB SPL`; recompute(); paint(); });
  splOut.textContent = `${spl.toFixed(1)} dB SPL`;
  const toneSel = h('select', { 'aria-label': 'Tone' }, ...[250, 1000, 4000].map((f) => h('option', { value: String(f), selected: f === hz }, f >= 1000 ? `${f / 1000} kHz` : `${f} Hz`))) as HTMLSelectElement;
  toneSel.addEventListener('change', () => { hz = Number(toneSel.value); recompute(); paint(); });
  const runBtn = h('button', { type: 'button', class: 'btn sm primary', 'aria-pressed': 'false' }, 'Run') as HTMLButtonElement;
  runBtn.addEventListener('click', () => { running = !running; runBtn.textContent = running ? 'Pause' : 'Run'; runBtn.setAttribute('aria-pressed', String(running)); loop.kick(); });
  const stepBtn = h('button', { type: 'button', class: 'btn sm' }, 'Step ⅛ period') as HTMLButtonElement;
  stepBtn.addEventListener('click', () => { running = false; runBtn.textContent = 'Run'; phase = (Math.round(phase * 8) + 1) / 8 % 1; paint(); });
  stage.slot.append(h('div', { class: 'r3-ctl' },
    h('label', { class: 'r3-sl' }, h('span', null, 'Sound'), splIn, splOut),
    h('label', { class: 'r3-sl' }, h('span', null, 'Tone'), toneSel),
    h('div', { class: 'r3-btns' }, runBtn, stepBtn)));
  const why = h('p', { class: 'r3-hint' }, `The slider stops at ${MAX_SPL.toFixed(1)} dB SPL: the datasheet puts −36 dBFS at 94 dB SPL, so its overload point (${IM69.aop} dB SPL) is the full scale itself, and this chapter's loop only holds ${SD_LIMIT} of full scale before its words wrap. The real microphone's ${IM69.snr} dB(A) signal-to-noise ratio is set by its acoustic and thermal noise, not by this loop.`);
  const panel = h('div', { class: 'panel m3d mm' },
    h('h3', { class: 'm3-title' }, 'A microphone is this chain'),
    h('p', { class: 'm3-sub' }, `An Infineon IM69D130, ${4} × ${3} × ${1.2} mm, cut open. Sound bows a membrane between two plates; the ASIC beside it turns the plates' voltage into one bit per clock with a sigma-delta loop, and a CIC turns the bits into words.`),
    stage.el,
    h('div', { class: 'mm-below' },
      h('div', null, h('h4', null, 'One period of the tone'), plot),
      h('div', null, h('h4', null, 'This microphone ', h('span', { class: 'r3-badge' }, 'model')), kv, why)));
  paint();
  return { el: panel, destroy() { loop.stop(); stage.destroy(); } };
}
