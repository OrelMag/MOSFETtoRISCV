// What a line part opens onto (roadmap decision 3): the one box that does not end in transistors shows the model it stands for,
// next to what the simulation does with it. Each model is its chapter's widget, loaded on demand: the stage carries none of them.

import type { ComponentDef, ModelPanel } from '../sim/types';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';

const MODELS: Record<ModelPanel, { title: string; text: string; load: () => Promise<Widget> }> = {
  serial: {
    title: 'A channel, not a circuit',
    text: 'Copper has no gates to open, so this box ends here. The simulation only delays each bit and flips it where err is 1. The analog channel below is what that delay stands for: a low-pass line with noise, computed by the line model, and how much of a bit survives it.',
    load: () => import('./serial').then((m) => m.eyeWidget()),
  },
  phone: {
    title: 'A telephone line, not a circuit',
    text: 'Copper, a hybrid transformer and an exchange have no gates to open. The simulation only delays the samples and flips a sign where hit is 1. Below is what that stands for: the same integer modem, with the line\'s noise added to its samples.',
    load: () => import('./modem').then((m) => m.fskWidget()),
  },
  cable: {
    title: 'A cable, not a circuit',
    text: 'A transmission line has no gates to open, so this box ends here. The simulation only delays the level and flips it where noise is 1. Below is what that delay stands for: the wave on the line, its reflections and what terminates them.',
    load: () => import('./line').then((m) => m.terminationWidget()),
  },
};

/** The bits on their way through a line part, next out first: its state's delay buffer (`q`, or `buf` on the cable), else none. */
export function bitsInFlight(state: unknown): number[] | null {
  const s = state as { q?: unknown; buf?: unknown } | undefined;
  const bits = s?.q ?? s?.buf;
  return Array.isArray(bits) ? bits as number[] : null;
}

export function modelLeaf(def: ComponentDef, o: { state: () => unknown; gates?: () => void }): Widget {
  const m = MODELS[def.modelPanel!];
  const flight = h('p', { class: 'sub' }), body = h('div', null, h('p', { class: 'sub' }, 'Loading the model…'));
  const el = h('div', { class: 'widget model-leaf' },
    h('h3', null, m.title), h('p', null, m.text), flight,
    o.gates ? h('button', { class: 'btn sm', onclick: o.gates }, 'Open the delay in gates') : null,
    body);
  let inner: Widget | null = null, gone = false;
  m.load().then((w) => {
    if (gone) { w.destroy?.(); return; }
    inner = w;
    body.replaceChildren(w.el);
    w.update?.();
  }, (e) => body.replaceChildren(h('p', { class: 'sub' }, `The model could not load: ${String(e)}`)));
  const update = () => {
    const bits = bitsInFlight(o.state());
    flight.textContent = bits ? `On the line now, next out first: ${bits.join(' ')}` : '';
    inner?.update?.();
  };
  update();
  return { el, update, destroy: () => { gone = true; inner?.destroy?.(); } };
}
