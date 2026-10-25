// The Unit / Load switch, the heavy-net list and the slack heatmap's switch and key shared by the Timing panels
// (widgets/timing.ts on the chapters' CPU scenes, editor/analysis.ts in the sandbox).

import { DELAY_NOTE, type DelayModel, fmtDelay, heavyNets } from '../sim/delay';
import { SLACK_BAND_LABELS } from '../sim/slack';
import type { TimingReport } from '../sim/timing';
import { h } from '../ui/dom';
import { settings } from '../ui/settings';

/** Which model a panel opens on: the learner's default (the view menu's Load-dependent delay). */
export const defaultDelay = (): DelayModel => (settings.loadDelay ? 'load' : 'unit');

/** Segmented Unit / Load buttons; a click picks one (and does not reach a collapsible title under it). */
export function delaySwitch(model: DelayModel, pick: (m: DelayModel) => void): HTMLElement {
  const btn = (m: DelayModel, label: string, title: string) => h('button', {
    class: m === model ? 'on' : '', 'aria-pressed': String(m === model), title,
    onclick: (e: Event) => { e.stopPropagation(); if (m !== model) pick(m); },
  }, label);
  return h('div', { class: 'seg delay-seg', role: 'group', 'aria-label': 'Delay model' },
    btn('unit', 'Unit', 'Every NAND one delay: the numbers the chapters quote'),
    btn('load', 'Load', DELAY_NOTE));
}

/** The heaviest nets on a load-model path: fan-out, delay and the buffering assumed. */
export function heavyList(r: TimingReport): HTMLElement | null {
  const rows = heavyNets(r);
  if (!rows.length) return null;
  return h('div', { class: 'delay-heavy', title: 'Inverter pairs ("buf") are assumed in front of a heavy load where they make it faster; they are not counted in the NANDs.' },
    h('div', { class: 'hd' }, h('span', null, 'Heaviest nets on the path'), h('span', null, 'fan-out'), h('span', null, 'delay')),
    rows.map((x) => h('div', { class: 'row' },
      h('span', { class: 'n', title: x.node.join('.') }, x.node.slice(0, -1).join('.') || x.node.join('.')),
      h('span', null, String(x.fanout)),
      h('span', { class: 'd' }, `${fmtDelay(x.delay, 'load')}${x.pairs ? ` · ${x.pairs} buf` : ''}`))));
}

/** The slack heatmap's switch (beside a panel's critical-path toggle). */
export function heatToggle(on: boolean, flip: () => void): HTMLElement {
  return h('button', {
    class: `btn sm toggle${on ? ' on' : ''}`, 'aria-pressed': String(on),
    title: 'Tint every part by its slack: how much shorter the slowest path through it is than the critical path',
    onclick: (e: Event) => { e.stopPropagation(); flip(); },
  }, 'Slack heatmap');
}

/** The heatmap's key: the bands as swatches, and what is measured. */
export function heatLegend(clocked: boolean): HTMLElement {
  return h('div', { class: 'slack-legend' },
    h('div', { class: 'sk-key', role: 'list', 'aria-label': 'Slack, as a share of the period' },
      SLACK_BAND_LABELS.map((l, i) => h('span', { role: 'listitem' }, h('i', { class: `sk${i}` }), l))),
    h('p', null, clocked
      ? 'How close the slowest path through each part comes to the critical path: slack = period − (arrival at the part + the longest path on from it to a flip-flop), as a share of the period. Untinted: no register-to-register path crosses it.'
      : 'No flip-flops: how close the slowest input → output path through each part comes to the longest one, as a share of it. Untinted: no input → output path crosses it.'));
}
