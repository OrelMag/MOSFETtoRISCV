// The right-click menu's pointer actions: unravel pointers into wires (directly, or picked from a
// list of those a part, wire or selection touches) and collapse wires into pointers (named in a
// small dialog, or each under its suggested name). Each is one undo step; the result is selected.

import { h, icon } from '../ui/dom';
import type { Editor } from './editor';
import { collapseWire, collapseWires, suggestName, unravelPointers } from './unravel';

/** Unravel the pointers with these names; refusals are reported, the rest still happens. */
export function unravel(ed: Editor, names: string[]): void {
  const r = unravelPointers(ed.doc, names, ed.defOf);
  if (r.doc !== ed.doc) {
    ed.edit(() => r.doc);
    ed.select({ wires: r.wires.filter((id) => r.doc.wires.some((w) => w.id === id)) });
  }
  if (r.reason) ed.toast(r.reason, 'err');
}

/** Collapse each drawn tree among these wires under its suggested name. */
export function collapseAll(ed: Editor, ids: string[]): void {
  const r = collapseWires(ed.doc, ids, ed.defOf);
  if (r.doc !== ed.doc) {
    ed.edit(() => r.doc);
    ed.select({ labels: r.labels });
  }
  if (r.reason) ed.toast(r.reason, 'err');
}

/** A small modal over the editor (Esc or a click outside closes it); Enter in a field runs `ok`. */
function modal(ed: Editor, title: string, body: (Node | string)[], okLabel: string, ok: () => boolean) {
  const close = () => {
    ov.remove();
    ed.view.svg.focus({ preventScroll: true });
  };
  const run = () => { if (ok()) close(); };
  const ov = h('div', { class: 'sb-help sb-dlg', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, onclick: (e: Event) => { if (e.target === ov) close(); } },
    h('div', { class: 'panel' },
      h('div', { class: 'sb-help-head' }, h('h3', null, title), h('button', { class: 'btn ghost icon-only', 'aria-label': 'Close', onclick: close }, icon('close', 16))),
      h('div', { class: 'sb-dlg-body' }, body),
      h('div', { class: 'sb-dlg-foot' },
        h('button', { class: 'btn sm ghost', onclick: close }, 'Cancel'),
        h('button', { class: 'btn sm primary', onclick: run }, okLabel))));
  ov.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type === 'text') run();
  });
  ed.el.append(ov);
  return ov;
}

/** "Unravel pointers…": the names offered with check boxes (all ticked), All / None. */
export function unravelDialog(ed: Editor, names: string[]): void {
  const boxes = names.map((n) => {
    const count = ed.doc.labels.filter((l) => l.name === n).length;
    const cb = h('input', { type: 'checkbox', checked: true, value: n });
    return { n, cb, row: h('label', { class: 'sb-ptr-row' }, cb, h('b', null, n), h('small', null, `${count} pointers`)) };
  });
  const msg = h('p', { class: 'sb-dlg-msg', role: 'status' });
  const all = (on: boolean) => { for (const b of boxes) b.cb.checked = on; };
  const ov = modal(ed, 'Unravel pointers', [
    h('p', { class: 'sb-dlg-lead' }, 'Each pointer chosen and its twins become wires, drawn from the one on the driver. The circuit stays the same.'),
    h('div', { class: 'sb-ptr-tools' },
      h('button', { class: 'btn sm ghost', onclick: () => all(true) }, 'All'),
      h('button', { class: 'btn sm ghost', onclick: () => all(false) }, 'None')),
    h('div', { class: 'sb-ptr-list' }, boxes.map((b) => b.row)),
    msg,
  ], 'Unravel', () => {
    const chosen = boxes.filter((b) => b.cb.checked).map((b) => b.n);
    if (!chosen.length) { msg.textContent = 'Tick at least one pointer.'; msg.className = 'sb-dlg-msg err'; return false; }
    unravel(ed, chosen);
    return true;
  });
  ov.querySelector<HTMLButtonElement>('.sb-dlg-foot .primary')?.focus();
}

/** "Collapse to pointers…": the wire's tree becomes pointers, named here (the suggestion selected). */
export function collapseDialog(ed: Editor, wireId: string): void {
  const name = h('input', { type: 'text', value: suggestName(ed.doc, wireId, ed.defOf), 'aria-label': 'Pointer name', spellcheck: 'false' });
  const msg = h('p', { class: 'sb-dlg-msg', role: 'status' });
  modal(ed, 'Collapse to pointers', [
    h('p', { class: 'sb-dlg-lead' }, 'The wire, with every wire branching from it, goes: each of its ends gets a pointer of this name instead. The circuit stays the same.'),
    h('label', { class: 'sb-row' }, h('span', null, 'Name'), name),
    msg,
  ], 'Collapse', () => {
    const r = collapseWire(ed.doc, wireId, name.value, ed.defOf);
    if (r.reason) { msg.textContent = r.reason; msg.className = 'sb-dlg-msg err'; return false; }
    ed.edit(() => r.doc);
    ed.select({ labels: r.labels });
    return true;
  });
  name.focus();
  name.select();
}
