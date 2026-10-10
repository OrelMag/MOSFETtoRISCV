// The canvas's right-click menu: the actions that apply to what is under the cursor (selected
// first), each with its shortcut, or the canvas's own (paste here, add a comment or pointer, fit).
// Everything it runs is also on a key or in the properties: the menu only makes it findable.
// A plugin (ui/pages/sandbox.ts imports it): it needs the inspector, which needs the editor.

import type { Vec } from '../sim/geometry';
import { h } from '../ui/dom';
import { type Editor, registerEditorPlugin } from './editor';
import { canLookInside, lookInside } from './inside';
import { inspect } from './inspect';
import { nextSameName } from './geom';
import { clearBends, setPin, setStraight } from './ops';
import { collapseAll, collapseDialog, unravel, unravelDialog } from './pointerui';
import { canPaste } from './tools';
import { canUnravel, pointersOf } from './unravel';

interface Item { label: string; key?: string; run(): void; disabled?: boolean }
type Entry = Item | null;

let menu: HTMLElement | null = null;
const onOutside = (e: PointerEvent) => { if (menu && !menu.contains(e.target as Node)) closeContextMenu(); };
const onKey = (e: KeyboardEvent) => {
  if (!menu) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeContextMenu(); return; }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  e.stopPropagation();
  const items = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  const i = items.indexOf(document.activeElement as HTMLButtonElement);
  items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
};

export function closeContextMenu(): void {
  menu?.remove();
  menu = null;
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
}

/** The actions for the current selection (after a right-click selected what was under it). */
function entries(ed: Editor, at: Vec): Entry[] {
  const t = ed.tools;
  const s = ed.sel;
  const n = ed.selCount;
  const edits: Entry[] = [
    { label: 'Duplicate', key: 'Ctrl+D', run: () => t.dup() },
    { label: 'Copy', key: 'Ctrl+C', run: () => t.copy() },
    { label: 'Cut', key: 'Ctrl+X', run: () => { t.copy(); t.del(); } },
    { label: 'Delete', key: 'Del', run: () => t.del() },
  ];
  if (!n) {
    return [
      { label: 'Paste here', key: 'Ctrl+V', run: () => t.paste(), disabled: !canPaste() },
      null,
      { label: 'Add a comment here', key: 'T', run: () => t.placeAt({ id: 'comment', name: 'Comment', place: { comment: true } }, at) },
      { label: 'Add a pointer here', key: 'L', run: () => t.placeAt({ id: 'pointer', name: 'Pointer', place: { pointer: true } }, at) },
      null,
      { label: 'Select all', key: 'Ctrl+A', run: () => ed.select({ parts: ed.doc.parts.map((p) => p.id), pins: ed.doc.pins.map((p) => p.id), wires: ed.doc.wires.map((w) => w.id), labels: ed.doc.labels.map((l) => l.id), ...(ed.doc.comments?.length ? { comments: ed.doc.comments.map((c) => c.id) } : {}) }), disabled: !ed.doc.parts.length && !ed.doc.pins.length && !ed.doc.wires.length && !ed.doc.labels.length && !ed.doc.comments?.length },
      { label: 'Fit to view', run: () => ed.view.fit(ed.defOf) },
      { label: 'Undo', key: 'Ctrl+Z', run: () => ed.undo() },
    ];
  }
  const flip: Item = { label: 'Flip', key: 'F', run: () => t.flip() };
  // Wires: straight (simple connections) or square, bends out.
  const wireIds = s.wires ?? [];
  const wires = ed.doc.wires.filter((w) => wireIds.includes(w.id));
  const shape: Entry[] = !wires.length ? [] : [
    wires.some((w) => !w.straight)
      ? { label: n > 1 ? 'Make the wires simple connections' : 'Make it a simple connection', run: () => ed.edit((d) => setStraight(d, wireIds, true, ed.defOf)) }
      : { label: n > 1 ? 'Square the wires' : 'Square it', run: () => ed.edit((d) => setStraight(d, wireIds, false, ed.defOf)) },
    { label: 'Remove all bends', run: () => ed.edit((d) => clearBends(d, wireIds, ed.defOf)), disabled: !wires.some((w) => w.pts.length) },
  ];
  // Pointers: those the selection touches unravel into wires (picked from a list), wires collapse into pointers.
  const touching = pointersOf(ed.doc, s);
  const pick: Entry[] = touching.length ? [{ label: 'Unravel pointers…', run: () => unravelDialog(ed, touching) }] : [];
  if (n > 1) {
    const named = [...new Set((s.labels ?? []).map((id) => ed.doc.labels.find((l) => l.id === id)?.name ?? ''))].filter((nm) => canUnravel(ed.doc, nm));
    const ptrs: Entry[] = [
      ...(named.length ? [{ label: 'Unravel selected', run: () => unravel(ed, named) }] : []),
      ...(wires.length ? [{ label: 'Collapse selected', run: () => collapseAll(ed, wireIds) }] : []),
      ...pick,
    ];
    return [flip, ...shape, ...(ptrs.length ? [null, ...ptrs] : []), null, ...edits];
  }
  if (s.parts?.length) {
    const p = ed.doc.parts.find((q) => q.id === s.parts![0]);
    if (!p) return edits;
    const chip = 'chip' in p.ref ? p.ref.chip : null;
    return [
      { label: 'Rename', key: 'F2', run: () => t.rename({ k: 'part', id: p.id }) },
      chip
        ? { label: 'Edit chip', key: 'double-click', run: () => ed.editChip(chip) }
        : { label: 'Look inside', key: 'double-click', run: () => lookInside(ed, [p.id]), disabled: !canLookInside(ed, p.id) },
      { label: 'Inspect', run: () => inspect(ed, p.id) },
      flip, ...(pick.length ? [null, ...pick] : []), null, ...edits,
    ];
  }
  if (s.pins?.length) {
    const pin = ed.doc.pins.find((q) => q.id === s.pins![0]);
    if (!pin) return edits;
    const kinds: Entry[] = pin.dir === 'in' && pin.width === 1
      ? (['toggle', 'button', 'clock'] as const).filter((k) => (pin.kind ?? 'toggle') !== k).map((k) => ({
        label: k === 'toggle' ? 'Make it a toggle' : k === 'button' ? 'Make it a button' : 'Make it a clock',
        run: () => {
          const r = setPin(ed.doc, pin.id, { kind: k === 'toggle' ? undefined : k, value: undefined }, ed.defOf);
          if (r.reason) ed.toast(r.reason, 'err');
          else ed.edit(() => r.doc);
        },
      }))
      : [];
    return [{ label: 'Rename', key: 'F2', run: () => t.rename({ k: 'pin', id: pin.id }) }, ...kinds, flip, null, ...edits];
  }
  if (s.labels?.length) {
    const id = s.labels[0];
    const name = ed.doc.labels.find((l) => l.id === id)?.name ?? '';
    return [
      { label: 'Rename', key: 'F2', run: () => t.rename({ k: 'label', id }) },
      { label: 'Jump to the next one', key: 'click', run: () => t.jump(id), disabled: !nextSameName(ed.doc, id) },
      { label: 'Unravel into wires', run: () => unravel(ed, [name]), disabled: !canUnravel(ed.doc, name) },
      flip, null, ...edits,
    ];
  }
  if (s.comments?.length) {
    const id = s.comments[0];
    return [{ label: 'Edit text', key: 'double-click', run: () => t.editComment(id) }, null, ...edits];
  }
  if (wires.length) {
    const id = wires[0].id;
    const j = t.cornerAt(id, at);
    return [
      { label: 'Add a bend here', run: () => t.bendAt(id, at), disabled: j >= 0 },
      { label: 'Remove this bend', key: 'double-click', run: () => t.unbend(id, j), disabled: j < 0 },
      ...shape, null,
      { label: 'Collapse to pointers…', run: () => collapseDialog(ed, id) },
      ...pick,
      null, { label: 'Delete', key: 'Del', run: () => t.del() },
    ];
  }
  return [{ label: 'Delete', key: 'Del', run: () => t.del() }];
}

/** Open the menu at a screen point for the current selection (empty: the canvas's actions at `at`). */
export function openContextMenu(ed: Editor, x: number, y: number, at: Vec): void {
  closeContextMenu();
  const m = h('div', { class: 'sb-ctx', role: 'menu', 'aria-label': 'Actions' });
  for (const it of entries(ed, at)) {
    if (!it) { if (m.lastElementChild && m.lastElementChild.tagName !== 'HR') m.append(h('hr')); continue; }
    m.append(h('button', {
      role: 'menuitem', disabled: it.disabled ? true : null,
      onclick: () => { closeContextMenu(); it.run(); },
    }, h('span', null, it.label), it.key ? h('kbd', null, it.key) : null));
  }
  menu = m;
  document.body.append(m);
  // Keep it on screen: open up / left of the cursor when it would overflow.
  const w = m.offsetWidth, hh = m.offsetHeight;
  m.style.left = `${Math.max(8, x + w > innerWidth - 8 ? x - w : x)}px`;
  m.style.top = `${Math.max(8, y + hh > innerHeight - 8 ? y - hh : y)}px`;
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  m.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
}

registerEditorPlugin((ed) => {
  ed.tools.onContext = (x, y, at) => openContextMenu(ed, x, y, at);
  return () => {
    ed.tools.onContext = null;
    closeContextMenu();
  };
});
