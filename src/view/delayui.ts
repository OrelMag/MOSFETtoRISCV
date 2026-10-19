// The Unit / Load switch and the heavy-net list shared by the Timing panels (widgets/timing.ts on the chapters'
// CPU scenes, editor/analysis.ts in the sandbox).

import { DELAY_NOTE, type DelayModel, fmtDelay, heavyNets } from '../sim/delay';
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
