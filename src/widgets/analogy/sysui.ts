// Small controls shared by the merge H figures (kitchen, squad, movers, doorbell, fourway), and their stylesheet.

import '../../styles/analogy-h.css';
import { h } from '../../ui/dom';
import { button } from './common';

/** A row of buttons of which one is pressed: `pick(i)` runs on a click; the returned function marks the pressed one. */
export function choice(labels: string[], pick: (i: number) => void): { el: HTMLElement; mark: (i: number) => void } {
  const bs = labels.map((l, i) => button(l, () => pick(i), false));
  return { el: h('span', { class: 'af-choice', role: 'group' }, ...bs), mark: (i) => bs.forEach((b, k) => b.setAttribute('aria-pressed', String(k === i))) };
}

/** `− n +` with a name, for a count between min and max. */
export function stepper(name: string, get: () => number, set: (v: number) => void, min: number, max: number): { el: HTMLElement; refresh: () => void } {
  const out = h('output', { class: 'af-num' });
  const dec = button('−', () => set(Math.max(min, get() - 1)));
  const inc = button('+', () => set(Math.min(max, get() + 1)));
  dec.setAttribute('aria-label', `${name}: one fewer`); inc.setAttribute('aria-label', `${name}: one more`);
  dec.classList.add('af-step'); inc.classList.add('af-step');
  return { el: h('span', { class: 'af-stepper' }, h('span', { class: 'af-stepname' }, name), dec, out, inc), refresh: () => { out.textContent = String(get()); dec.disabled = get() <= min; inc.disabled = get() >= max; } };
}

let uid = 0;
/** A labelled range input; `set` runs on every input. */
export function slider(label: string, min: number, max: number, step: number, value: number, set: (v: number) => void): { el: HTMLElement; input: HTMLInputElement } {
  const input = h('input', { type: 'range', min, max, step, value, id: `afh-${uid++}` });
  const out = h('output', { class: 'af-num' }, String(value));
  input.addEventListener('input', () => { out.textContent = input.value; set(+input.value); });
  return { el: h('label', { for: input.id, class: 'af-slide' }, label, input, out), input };
}
