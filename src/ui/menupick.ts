// The picker: a keyboard's way to a part or a wire, which have no focus of their own. Loaded when the menu's
// "Pick a part or wire…" is chosen, so a stage page does not carry it.

import { h } from './dom';
import { closeMenu, setPickerClose } from './menu';

export interface PickEntry { label: string; note?: string; run(): void }

/** The rows a filter leaves, the ones starting with it first; past `max` the count of the rest. */
export function pickRows(all: readonly PickEntry[], q: string, max = 200): { rows: PickEntry[]; more: number } {
  const t = q.trim().toLowerCase();
  const hit = !t ? [...all] : all.filter((x) => x.label.toLowerCase().includes(t) || x.note?.toLowerCase().includes(t));
  if (t) hit.sort((a, b) => Number(b.label.toLowerCase().startsWith(t)) - Number(a.label.toLowerCase().startsWith(t)));
  return { rows: hit.slice(0, max), more: Math.max(0, hit.length - max) };
}

let picker: { el: HTMLElement; off(): void; owner?: object } | null = null;

/** Close the picker (`owner`: only if it opened it). */
function closePicker(owner?: object): void {
  if (owner && picker?.owner !== owner) return;
  picker?.off();
  picker?.el.remove();
  picker = null;
}

/** A filter box over a list; a pick closes it and runs the row. Esc gives the focus back to `back`. */
export function showPicker(title: string, all: readonly PickEntry[], back?: HTMLElement | SVGElement | null, owner?: object): void {
  closeMenu();
  closePicker();
  const input = h('input', { type: 'text', 'aria-label': `${title}: filter`, placeholder: 'Type to filter' }) as HTMLInputElement;
  const list = h('ul', { role: 'listbox', 'aria-label': title });
  const pick = (x: PickEntry) => {
    closePicker();
    x.run();
  };
  const draw = () => {
    const { rows, more } = pickRows(all, input.value);
    list.replaceChildren(...rows.map((x) => h('li', { role: 'presentation' }, h('button', { role: 'option', onclick: () => pick(x) }, h('span', null, x.label), x.note ? h('small', null, x.note) : null))),
      ...(more ? [h('li', { class: 'ctx-note' }, `${more} more: type to narrow it down`)] : []),
      ...(!rows.length ? [h('li', { class: 'ctx-note' }, 'Nothing by that name')] : []));
  };
  const leave = () => {
    closePicker();
    if (back?.isConnected) back.focus({ preventScroll: true });
  };
  const el = h('div', { class: 'ctx-pick', role: 'dialog', 'aria-label': title }, h('h3', null, title), input, list);
  input.addEventListener('input', draw);
  el.addEventListener('keydown', (e) => {
    e.stopPropagation();
    const rows = [...list.querySelectorAll<HTMLElement>('button')];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      leave();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      rows[at + 1 < rows.length ? at + 1 : 0]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (at <= 0) input.focus();
      else rows[at - 1].focus();
    } else if (e.key === 'Enter' && document.activeElement === input) {
      e.preventDefault();
      rows[0]?.click();
    }
  });
  const outside = (e: PointerEvent) => { if (!el.contains(e.target as Node)) closePicker(); };
  document.addEventListener('pointerdown', outside, true);
  const onRoute = () => closePicker();
  addEventListener('hashchange', onRoute);
  picker = { el, ...(owner ? { owner } : {}), off: () => {
    document.removeEventListener('pointerdown', outside, true);
    removeEventListener('hashchange', onRoute);
  } };
  draw();
  document.body.append(el);
  input.focus();
}

setPickerClose(closePicker);
