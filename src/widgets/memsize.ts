// Panel that rebuilds the RAM scene at a size of the learner's choosing.

import { ram } from '../lib';
import { stats } from '../sim/stats';
import { h } from '../ui/dom';
import type { ScenePanel, Stage, Widget } from '../view/stage';
import { memGridPanel } from './memgrid';

export const memSizePanel: ScenePanel = (stage: Stage): Widget => {
  const root = stage.scene!.root;
  const words = root.ports.find((p) => p.name === 'addr')!.width;
  const width = root.ports.find((p) => p.name === 'din')!.width;
  const wSel = h('select', { 'aria-label': 'words' }) as HTMLSelectElement;
  for (let k = 2; k <= 6; k++) wSel.append(h('option', { value: k, selected: k === words }, `${2 ** k} words`));
  const bSel = h('select', { 'aria-label': 'bits per word' }) as HTMLSelectElement;
  for (const b of [4, 8, 16]) bSel.append(h('option', { value: b, selected: b === width }, `${b} bits`));
  const st = stats(root);
  const info = h('span', { style: 'color:var(--muted);font:12px var(--font-mono)' },
    `${(2 ** words * width).toLocaleString()} bits · ${st.transistors.toLocaleString()} transistors`);
  const rebuild = () => {
    const k = Number(wSel.value), w = Number(bSel.value);
    stage.load({ root: ram(k, w), inputs: { addr: 0, din: 0, we: 1, clk: 0 }, panels: [memSizePanel, memGridPanel] });
  };
  wSel.addEventListener('change', rebuild);
  bSel.addEventListener('change', rebuild);
  const el = h('div', { class: 'mem-panel', style: 'bottom:auto;top:44px;left:12px;right:auto' },
    h('h4', null, 'Memory size'), h('div', { class: 'param-row' }, wSel, '×', bSel), h('div', { style: 'margin-top:6px' }, info));
  return { el };
};
