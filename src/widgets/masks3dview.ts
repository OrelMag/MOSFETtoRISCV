// The chip built mask by mask (loaded on demand, modelhost.ts): fabWidget's cross-section is one slice; this is the same
// steps on the layout step's own cell. Each step shows its mask as a flat pattern above the die, and the layer it
// patterns lands below with exactly the rectangles of the pattern.

import '../styles/masks3d.css';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';
import { modelStage } from './modelstage';
import { landed, layerRects, MASK_AT, masksAnchors, masksParts, STAGE_NAME, type MasksPalette, type MasksState, type Stage } from './masks3dparts';
import { CELLS, FAB } from './silicon';

const STAGES: Stage[] = ['nwell', 'poly', 'ndiff', 'pdiff', 'contact', 'metal'];

export function masksView(): Widget {
  const cell = CELLS[0], st: MasksState = { step: 6, spread: 0.6 };
  const panel = h('div', { class: 'panel' });
  const stage = modelStage(panel, {
    aria: 'An inverter cell in 3D, built layer by layer; the current step’s mask floats above it',
    camera: { target: [0, 4, 0], yaw: -1.3, pitch: 0.45, dist: 70 },
    limits: { minDist: 30, maxDist: 220 },
    note: 'The cell’s footprint is to scale; heights are exaggerated and the layers pulled apart. The mask is drawn above the die only to show its pattern.',
    draw,
  });
  const palette = (): MasksPalette => ({
    psub: stage.rgb('--mk-psub'), plate: stage.rgba("--mk-plate", 0.45), chan: stage.rgb('--mk-chan'),
    layer: Object.fromEntries(STAGES.map((l) => [l, stage.rgb(`--mk-${l}`)])) as Record<Stage, [number, number, number]>,
  });
  function draw(): void { stage.paint(masksParts(cell, st, palette()), masksAnchors(cell, st)); }

  const read = h('p', { class: 'mk-read' });
  const readout = () => {
    const m = MASK_AT[st.step];
    read.replaceChildren(h('strong', null, `${st.step + 1}. ${FAB[st.step][0]}`), ' ', FAB[st.step][1],
      h('span', { class: 'mk-mask' }, m ? `Mask: ${STAGE_NAME[m]}, ${layerRects(cell, m).length} rectangles of this cell.` : 'Mask: none of this cell’s; the step covers the whole wafer or is not a layer of the layout.'));
  };

  const range = (label: string, min: number, max: number, step: number, val: number, text: (v: number) => string, on: (v: number) => void) => {
    const input = h('input', { type: 'range', min, max, step, value: val, 'aria-label': label }) as HTMLInputElement;
    const out = h('output', null, text(val));
    input.addEventListener('input', () => { out.textContent = text(Number(input.value)); on(Number(input.value)); });
    return { input, row: h('label', { class: 'r3-sl' }, h('span', null, label), input, out) };
  };
  const prev = h('button', { type: 'button', class: 'btn sm' }, '◀ previous') as HTMLButtonElement;
  const next = h('button', { type: 'button', class: 'btn sm primary' }, 'next ▶') as HTMLButtonElement;
  const stepper = range('Step', 0, FAB.length - 1, 1, st.step, (v) => `${v + 1} / ${FAB.length}`, (v) => go(v));
  const spread = range('Pull apart', 0, 1, 0.05, st.spread, (v) => `${Math.round(v * 100)} %`, (v) => { st.spread = v; draw(); });
  function go(v: number): void {
    st.step = Math.max(0, Math.min(FAB.length - 1, v));
    stepper.input.value = String(st.step);
    stepper.row.querySelector('output')!.textContent = `${st.step + 1} / ${FAB.length}`;
    prev.disabled = st.step === 0;
    next.disabled = st.step === FAB.length - 1;
    readout();
    stage.chips.replaceChildren(...landed(st.step).map((l) => h('span', { class: 'r3-chip' }, h('i', { class: 'mk-sw', style: `background: var(--mk-${l})` }), STAGE_NAME[l])));
    draw();
  }
  prev.addEventListener('click', () => go(st.step - 1));
  next.addEventListener('click', () => go(st.step + 1));

  panel.append(
    h('h3', { class: 'm3-title' }, 'The same steps, on the cell'),
    h('p', { class: 'm3-sub' }, 'The cross-section above is one slice through the wafer. Here is the whole inverter cell from the layout step, built in the order above. Where a step uses a mask, its pattern floats over the die: the rectangles you see there are the ones that land in the layer below, and the layout step drew those same rectangles flat.'),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' }, h('div', { class: 'r3-ctl' }, h('div', { class: 'r3-btns' }, prev, next), stepper.row, spread.row, h('div', { class: 'r3-btns' }, stage.resetBtn)), stage.el, stage.hint, read)));
  go(st.step);
  return { el: panel, destroy: () => stage.destroy() };
}
