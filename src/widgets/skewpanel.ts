// Chapter 8's clock-skew scene: a panel to choose how many buffers delay the second flip-flop's clock (2 gate delays each).

import { skewPair } from '../lib/seqdeep';
import { h } from '../ui/dom';
import type { ScenePanel, Stage, Widget } from '../view/stage';

export const SKEW_BUFFERS = [0, 1, 2, 3];

export const skewPanel: ScenePanel = (stage: Stage): Widget => {
  const k = Number(stage.scene!.root.id.replace('skewpair', ''));
  const sel = h('select', { 'aria-label': 'buffers on the second flip-flop\'s clock' }) as HTMLSelectElement;
  for (const n of SKEW_BUFFERS) sel.append(h('option', { value: n, selected: n === k }, `${n} buffer${n === 1 ? '' : 's'} (${2 * n} delays late)`));
  sel.addEventListener('change', () => stage.load({ root: skewPair(Number(sel.value)), inputs: { d: 1, clk: 0 }, autoClock: false, panels: [skewPanel] }));
  const el = h('div', { class: 'mem-panel', style: 'bottom:auto;top:44px;left:12px;right:auto' }, h('h4', null, 'Clock skew'), h('div', { class: 'param-row' }, sel));
  return { el };
};
