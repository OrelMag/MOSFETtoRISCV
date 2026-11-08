// The chip built mask by mask (loaded on demand, modelhost.ts): fabWidget's cross-section is one slice; this is the same
// steps on a standard cell of the layout step. Each step shows its reticle above the die and what the step does to the
// wafer below it. Two controls make the quiz's point visible: shift the poly mask, and implant before the gate.

import '../styles/masks3d.css';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';
import { modelStage } from './modelstage';
import { LAND_AT, LAYER_NAME, LAYERS, MASK_AT, MASK_NAME, maskRects, masksAnchors, masksParts, misalignment, type MasksPalette, type MasksState } from './masks3dparts';
import { CELLS, FAB } from './silicon';

/** The masks this cell's flow needs in sky130 (nwell, diff, poly, nsdm, psdm, licon1, li1, mcon, met1); the model draws seven. */
const MASKS_DRAWN = 7, MASKS_REAL = 9;

export function masksView(): Widget {
  // The layout step opens on NAND2; so does this.
  let cell = CELLS[1];
  const st: MasksState = { step: 6, spread: 0.35, shift: 0, aligned: true };
  const panel = h('div', { class: 'panel' });
  const stage = modelStage(panel, {
    aria: 'A standard cell in 3D, built mask by mask; the current step’s reticle floats above it',
    camera: { target: [0, 3, 0], yaw: -0.75, pitch: 0.7, dist: 78 },
    limits: { minDist: 30, maxDist: 240 },
    note: 'The cell’s footprint is to scale (1 λ = 62 nm, so the 44 λ row is sky130’s 2.72 µm); heights and depths are exaggerated and the layers pulled apart. The reticle is drawn 1×, one cell, over the die; a real one is 4× and carries the whole die.',
    draw,
  });
  const palette = (): MasksPalette => ({
    psub: stage.rgb('--mk-psub'), sti: stage.rgb('--mk-sti'), gox: stage.rgb('--mk-gox'), resist: stage.rgba('--mk-resist', 0.8), ild: stage.rgba('--mk-ild', 0.22),
    uv: stage.rgba('--mk-uv', 0.5), chrome: stage.rgba('--mk-chrome', 0.6), plate: stage.rgba('--mk-plate', 0.4), pell: stage.rgba('--mk-pell', 0.18), frame: stage.rgb('--mk-frame'),
    layer: Object.fromEntries(LAYERS.map((l) => [l, stage.rgb(`--mk-${l}`)])) as MasksPalette['layer'],
  });
  function draw(): void { stage.paint(masksParts(cell, st, palette()), masksAnchors(cell, st)); }

  const read = h('p', { class: 'mk-read' });
  const verdict = h('p', { class: 'mk-verdict', 'aria-live': 'polite' });
  const readout = () => {
    const m = MASK_AT[st.step];
    const note = m
      ? `Reticle: ${MASK_NAME[m]}, ${maskRects(cell, m, st.shift).length} rectangles. ${m === 'nsdm' || m === 'psdm' ? 'A window, not the diffusion’s shape: the ions land only where it meets bare active area.' : m === 'diff' ? 'Chrome over the active area; everything else is etched into trenches.' : ''}`
      : 'Reticle: none; this step covers the whole wafer.';
    read.replaceChildren(h('strong', null, `${st.step + 1}. ${FAB[st.step][0]}`), ' ', FAB[st.step][1], h('span', { class: 'mk-mask' }, `${note} ${MASKS_DRAWN} of the ~${MASKS_REAL} masks this cell needs are drawn (li1 and mcon are folded into licon1 and met1).`));
    const { overlap, gap } = misalignment(cell, st.shift, st.aligned);
    const sign = st.shift > 0 ? '+' : st.shift < 0 ? '−' : '';
    verdict.textContent = st.step < LAND_AT.ndiff ? 'Shift the poly mask or switch the implant order: the effect shows from the n+ implant on.'
      : st.aligned ? (st.shift === 0 ? 'Self-aligned: the implant stops at the gate wherever the gate is.' : `Poly shifted ${sign}${Math.abs(st.shift)} λ: source and drain moved with it. Gate overlap 0, uncovered channel 0.`)
        : `Implant before the gate: gate over source/drain ${overlap} λ² (extra gate-drain capacitance), channel left uncovered ${gap} λ² (no inversion layer there: the transistor cannot turn fully on).`;
    verdict.classList.toggle('bad', st.step >= LAND_AT.ndiff && !st.aligned && (overlap > 0 || gap > 0));
  };

  const range = (label: string, min: number, max: number, step: number, val: number, text: (v: number) => string, on: (v: number) => void) => {
    const input = h('input', { type: 'range', min, max, step, value: val, 'aria-label': label }) as HTMLInputElement;
    const out = h('output', null, text(val));
    input.addEventListener('input', () => { out.textContent = text(Number(input.value)); on(Number(input.value)); });
    return { input, out, row: h('label', { class: 'r3-sl' }, h('span', null, label), input, out) };
  };
  const prev = h('button', { type: 'button', class: 'btn sm' }, '◀ previous') as HTMLButtonElement;
  const next = h('button', { type: 'button', class: 'btn sm primary' }, 'next ▶') as HTMLButtonElement;
  const stepper = range('Step', 0, FAB.length - 1, 1, st.step, (v) => `${v + 1} / ${FAB.length}`, (v) => go(v));
  const spread = range('Pull apart', 0, 1, 0.05, st.spread, (v) => `${Math.round(v * 100)} %`, (v) => { st.spread = v; draw(); });
  const sh = range('Shift poly mask', -2, 2, 0.5, st.shift, (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)} λ`, (v) => { st.shift = v; readout(); draw(); });
  sh.row.classList.add('mk-wide');
  const alignedBox = h('input', { type: 'checkbox' }) as HTMLInputElement;
  alignedBox.addEventListener('change', () => { st.aligned = !alignedBox.checked; readout(); draw(); });
  const cells = CELLS.map((c) => {
    const b = h('button', { type: 'button', class: `btn sm${c === cell ? ' primary' : ''}`, 'aria-pressed': String(c === cell) }, c.name) as HTMLButtonElement;
    b.addEventListener('click', () => {
      cell = c;
      cells.forEach((x, i) => { x.classList.toggle('primary', CELLS[i] === c); x.setAttribute('aria-pressed', String(CELLS[i] === c)); });
      readout(); draw();
    });
    return b;
  });
  function go(v: number): void {
    st.step = Math.max(0, Math.min(FAB.length - 1, v));
    stepper.input.value = String(st.step);
    stepper.out.textContent = `${st.step + 1} / ${FAB.length}`;
    prev.disabled = st.step === 0;
    next.disabled = st.step === FAB.length - 1;
    readout();
    stage.chips.replaceChildren(...LAYERS.filter((l) => st.step >= LAND_AT[l]).map((l) => h('span', { class: 'r3-chip' }, h('i', { class: 'mk-sw', style: `background: var(--mk-${l})` }), LAYER_NAME[l])));
    draw();
  }
  prev.addEventListener('click', () => go(st.step - 1));
  next.addEventListener('click', () => go(st.step + 1));

  panel.append(
    h('h3', { class: 'm3-title' }, 'The same steps, on the cell'),
    h('p', { class: 'm3-sub' }, 'The cross-section above is one slice through the wafer. Here is a whole standard cell from the layout step taken through sky130’s flow: isolation, well, gate, implants, contacts, metal. Each mask is a plate floating over the die; what the step does is drawn on the wafer below. The implant windows are bigger than the diffusion: move the poly mask and see where the n+ lands.'),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' },
        h('div', { class: 'r3-ctl' }, h('div', { class: 'r3-btns', role: 'group', 'aria-label': 'Cell' }, ...cells), h('div', { class: 'r3-btns' }, prev, next), stepper.row, spread.row, sh.row,
          h('label', { class: 'r3-sl mk-chk' }, alignedBox, h('span', null, 'Implant before the gate (not self-aligned)')), h('div', { class: 'r3-btns' }, stage.resetBtn)),
        stage.el, stage.hint, verdict, read)));
  go(st.step);
  return { el: panel, destroy: () => stage.destroy() };
}
