// Chapter 8's clock-skew scene: a panel to choose how many buffers delay the second flip-flop's clock, and the delay model
// (Unit: 2 gate delays a buffer; Load: each NAND by what it drives, so a buffer's last inverter, driving the flip-flop's
// clock inputs, is slower). How late the clock arrives under each is measured (widgets/finedelay.ts FINE.skew).

import { skewPair } from '../lib/seqdeep';
import { h } from '../ui/dom';
import { delaySwitch } from '../view/delayui';
import type { ScenePanel, Stage, Widget } from '../view/stage';
import { FINE } from './finedelay';

export const SKEW_BUFFERS = [0, 1, 2, 3];

export const skewPanel: ScenePanel = (stage: Stage): Widget => {
  const k = Number(stage.scene!.root.id.replace('skewpair', ''));
  const model = stage.delayOf(stage.scene!);
  const load = (n: number, m: 'unit' | 'load') => stage.load({ root: skewPair(n), inputs: { d: 1, clk: 0 }, autoClock: false, panels: [skewPanel], ...(m === 'load' ? { delay: 'load' } : {}) });
  const sel = h('select', { 'aria-label': 'buffers on the second flip-flop\'s clock' }) as HTMLSelectElement;
  for (const n of SKEW_BUFFERS) {
    const late = FINE.skew[model][n].late;
    sel.append(h('option', { value: n, selected: n === k }, `${n} buffer${n === 1 ? '' : 's'} (${late} ${model === 'unit' ? 'delays' : 'units'} late)`));
  }
  sel.addEventListener('change', () => load(Number(sel.value), model));
  const el = h('div', { class: 'mem-panel', style: 'bottom:auto;top:44px;left:12px;right:auto' }, h('h4', null, 'Clock skew'),
    h('div', { class: 'param-row' }, sel),
    h('div', { class: 'param-row' }, delaySwitch(model, (m) => load(k, m === 'load' ? 'load' : 'unit'))));
  return { el };
};
