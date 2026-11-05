// The canvas's right-click menu: the actions that apply to what is under the cursor (selected
// first), each with its shortcut, or the canvas's own (paste here, add a comment or pointer, fit).
// Everything it runs is also on a key or in the properties: the menu only makes it findable.
// A plugin (ui/pages/sandbox.ts imports it): it needs the inspector, which needs the editor.

import type { Vec } from '../sim/geometry';
import { h } from '../ui/dom';
import { closeMenu, type MenuEntry, showMenu, showPicker } from '../ui/menu';
import { type Editor, registerEditorPlugin } from './editor';
import { canTurn } from './face';
import { canLookInside, lookInside } from './inside';
import { inspect } from './inspect';
import { nextSameName } from './geom';
import { clearBends, setPin, setStraight } from './ops';
import { collapseAll, collapseDialog, unravel, unravelDialog } from './pointerui';
import { canPaste } from './tools';
import { canUnravel, pointersOf } from './unravel';
import { hueSwatches } from './hueswatch';
import { colourNets, hueOfNets } from './wirehue';
import { netMembers, netOfSelection } from './netsel';
import { factsOf, type NetEnd } from '../view/netfacts';
import { ViewCtx } from '../view/context';
import { elsewhereGroup, elsewhereRows, type MeasureHost, partHeader, partMeasure, wireHeader, wireRows } from '../view/tracemenu';
import { probeRow } from './probehook';
import type { ProbeTarget } from './probes';
import { exportImage, shareDialog } from './fileui';
import { copyAsChip, explainOn, handout } from './levelgate';
import type { WireDoc } from './model';

export { closeMenu as closeContextMenu, type MenuEntry, showMenu } from '../ui/menu';
type Entry = MenuEntry;
type Item = NonNullable<MenuEntry>;

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
      ...(pickEntries(ed).length ? [{ label: 'Pick a part or wire…', run: () => pickTarget(ed) }, null] : []),
      ...elsewhereOf(ed), ...(ed.doc.parts.length ? [null] : []),
      { label: 'Paste here', key: 'Ctrl+V', run: () => t.paste(), disabled: !canPaste() },
      null,
      { label: 'Add a comment here', key: 'T', run: () => t.placeAt({ id: 'comment', name: 'Comment', place: { comment: true } }, at) },
      { label: 'Add a pointer here', key: 'L', run: () => t.placeAt({ id: 'pointer', name: 'Pointer', place: { pointer: true } }, at) },
      null,
      { label: 'Select all', key: 'Ctrl+A', run: () => ed.select({ parts: ed.doc.parts.map((p) => p.id), pins: ed.doc.pins.map((p) => p.id), wires: ed.doc.wires.map((w) => w.id), labels: ed.doc.labels.map((l) => l.id), ...(ed.doc.comments?.length ? { comments: ed.doc.comments.map((c) => c.id) } : {}) }), disabled: !ed.doc.parts.length && !ed.doc.pins.length && !ed.doc.wires.length && !ed.doc.labels.length && !ed.doc.comments?.length },
      { label: 'Fit to view', run: () => ed.fitView() },
      { label: 'Undo', key: 'Ctrl+Z', run: () => ed.undo() },
    ];
  }
  const flip: Item = { label: 'Flip', key: 'F', run: () => t.flip() };
  // Displays and I/O parts only mirror (face.ts canTurn): a selection of nothing else cannot turn.
  const still = !(s.pins?.length || s.labels?.length) && (s.parts ?? []).every((id) => { const p = ed.doc.parts.find((q) => q.id === id); return !p || !canTurn(p.ref, ed.defOf(p)); });
  const turn: Item[] = [
    { label: 'Rotate clockwise', key: 'R', run: () => t.rotate(1), disabled: still },
    { label: 'Rotate anticlockwise', key: 'Shift+R', run: () => t.rotate(3), disabled: still },
  ];
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
    return [flip, ...turn, ...shape, ...(ptrs.length ? [null, ...ptrs] : []), null, ...edits];
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
      ...measureOf(ed, p.id),
      ...explainOf(ed, p.id),
      ...elsewhereOf(ed, p.id),
      null,
      flip, ...turn, ...(pick.length ? [null, ...pick] : []), null, ...edits,
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
    return [{ label: 'Rename', key: 'F2', run: () => t.rename({ k: 'pin', id: pin.id }) }, ...kinds, flip, ...turn, null, ...edits];
  }
  if (s.labels?.length) {
    const id = s.labels[0];
    const name = ed.doc.labels.find((l) => l.id === id)?.name ?? '';
    return [
      { label: 'Rename', key: 'F2', run: () => t.rename({ k: 'label', id }) },
      { label: 'Jump to the next one', key: 'click', run: () => t.jump(id), disabled: !nextSameName(ed.doc, id) },
      { label: 'Unravel into wires', run: () => unravel(ed, [name]), disabled: !canUnravel(ed.doc, name) },
      flip, ...turn, null, ...edits,
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

const shareRow = (ed: Editor): NonNullable<MenuEntry> => ({ label: 'Share link…', hint: 'A copy of this chip, packed into a URL', run: () => void shareDialog(ed) });

/** Take it elsewhere for a part (or, with none, the chip). On a level only the learner's own may go. */
function elsewhereOf(ed: Editor, partId?: string): MenuEntry[] {
  const say = (m: string, e?: boolean) => ed.toast(m, e ? 'err' : 'info');
  if (partId === undefined) {
    const may = handout({ chipId: ed.chipId, level: !!ed.level, own: true });
    return elsewhereGroup(elsewhereRows({ def: ed.compiled.def, say, verilog: may.verilog, ...(may.image ? { image: (kind: 'svg' | 'png') => exportImage(ed, kind) } : {}), ...(may.link ? { link: shareRow(ed) } : {}) }));
  }
  const p = ed.doc.parts.find((q) => q.id === partId);
  const def = p && ed.defOf(p);
  const sim = ed.sim.sim;
  if (!p || !def) return [];
  const may = handout({ chipId: ed.chipId, level: !!ed.level, own: 'chip' in p.ref });
  if (may.none) return [];
  const node = sim?.design.root.children?.get(partId);
  const inside = () => (sim && node ? new ViewCtx(sim, sim.design.root).child(partId) : null);
  return elsewhereGroup(elsewhereRows({
    def, say,
    ...(may.sandbox ? { sandbox: { label: 'Copy into a new chip', run: () => copyAsChip(ed, def) } } : {}),
    verilog: may.verilog,
    ...(may.image ? { image: node && def.netlist ? (kind: 'svg' | 'png') => {
      const ctx = inside();
      return ctx ? import('../view/image').then((m) => m.exportInside(ctx, ed.view.svg, kind)) : say('It has no inside to draw', true);
    } : 'It has no inside to draw.' } : {}),
    ...(may.link ? { link: shareRow(ed) } : {}),
  }));
}

/** What a probe of the selection names: a wire's net by its wires, a pointer by its name (a pin has a lane from the start). */
function probeTargetOf(ed: Editor): ProbeTarget | null {
  const s = ed.sel;
  if (s.wires?.length) return { wires: [...s.wires] };
  const l = s.labels?.length ? ed.doc.labels.find((x) => x.id === s.labels![0]) : undefined;
  return l ? { pointer: l.name } : null;
}

const timingOf = (ed: Editor): MeasureHost['timing'] => {
  const sim = ed.sim.sim;
  if (ed.compiled.mode === 'switch') return 'Switch level has no gate delay.';
  return sim ? { design: sim.design, at: [] } : 'Not simulated yet: finish the wiring (see the diagnostics).';
};

/** A path lit from the menu, as the chip's parts on it selected (the canvas's own way to light parts). */
function lightParts(ed: Editor, paths: string[][]): void {
  const ids = new Set(paths.map((p) => p[0]).filter((id) => id && ed.doc.parts.some((q) => q.id === id)));
  ed.select({ parts: [...ids] });
  ed.toast(ids.size ? `The slowest path through it: ${ids.size} part${ids.size === 1 ? '' : 's'} selected` : 'Its slowest path runs through no part of this chip');
}

function measureOf(ed: Editor, partId: string): MenuEntry[] {
  return partMeasure(partId, { timing: timingOf(ed), light: (paths) => lightParts(ed, paths), power: () => inspect(ed, partId, 'power') });
}

/** Explain for a part of this chip (a chip of the learner's has no entry to read: its own properties say the rest). */
function explainOf(ed: Editor, partId: string): MenuEntry[] {
  const p = ed.doc.parts.find((q) => q.id === partId);
  const def = p && ed.defOf(p);
  return def ? explainOn(ed, def, (at) => inspect(ed, partId, at)) : [];
}

/** Trace's rows for that net; the header goes into `into`. */
function traceOf(ed: Editor, idx: number, into: HTMLElement): MenuEntry[] {
  // read through the editor each time: a rebuild replaces the simulator while the menu is open
  const flat = () => ed.sim.sim?.design.root.nets?.[idx] ?? [];
  const f = factsOf(ed.compiled.def, idx);
  if (!f || !ed.sim.sim) return [];
  wireHeader(into, f, () => ed.sim.sim?.getBits(flat()) ?? []);
  const jump = (e: NetEnd) => {
    const part = e.inst === null ? null : ed.doc.parts.find((p) => p.id === e.inst);
    const pin = e.inst === null ? ed.doc.pins.find((p) => p.name === e.port) : null;
    if (!part && !pin) return;
    ed.select(part ? { parts: [part.id] } : { pins: [pin!.id] });
    ed.view.centerOn(part ? part.at : pin!.at);
  };
  return [...wireRows(f, {
    // the net's every wire and pointer selected: lit, and ready to colour or delete together
    highlight: () => ed.select(netMembers(ed.compiled, idx)),
    jump,
    whyOff: 'The Why? card is in Look inside and on stages: open this chip’s part, or the chip from a level above.',
    design: () => ed.sim.sim?.design ?? null,
    flat,
    transistors: ed.compiled.mode === 'switch',
    measure: {
      ...(probeTargetOf(ed) ? { probe: probeRow(ed, probeTargetOf(ed)!) } : {}),
      timing: timingOf(ed),
      light: (paths) => lightParts(ed, paths),
      toggles: ed.compiled.mode === 'switch' ? 'Power is counted from gate toggles, and this chip has none.' : () => null,
    },
    more: handout({ chipId: ed.chipId, level: !!ed.level, own: true }).link ? elsewhereGroup(elsewhereRows({ def: null, say: (m, e) => ed.toast(m, e ? 'err' : 'info'), link: shareRow(ed) })) : [],
  }), null];
}

/** What the chip holds, for a keyboard: parts, pins, pointers and wires have no focus of their own. */
function pickEntries(ed: Editor): { label: string; note: string; run(): void }[] {
  const go = (sel: Parameters<Editor['select']>[0]) => () => {
    ed.select(sel);
    ed.tools.keyMenu();
  };
  const d = ed.doc;
  const pinName = (id: string) => d.pins.find((p) => p.id === id)?.name ?? id;
  const end = (e: WireDoc['a']) => ('pin' in e ? pinName(e.pin) : 'part' in e ? `${e.part}.${e.port}` : 'label' in e ? e.label : '·');
  return [
    ...d.parts.map((p) => ({ label: p.id, note: ed.defOf(p)?.name ?? 'part', run: go({ parts: [p.id] }) })),
    ...d.pins.map((p) => ({ label: p.name, note: `${p.dir === 'in' ? 'input' : p.dir === 'out' ? 'output' : 'inout'} pin`, run: go({ pins: [p.id] }) })),
    ...d.labels.map((l) => ({ label: l.name, note: 'pointer', run: go({ labels: [l.id] }) })),
    ...d.wires.map((w) => ({ label: w.name ?? `${end(w.a)} – ${end(w.b)}`, note: 'wire', run: go({ wires: [w.id] }) })),
  ];
}

function pickTarget(ed: Editor): void {
  showPicker('Pick a part or wire', pickEntries(ed), ed.view.svg);
}

/** Open the menu at a screen point for the current selection (empty: the canvas's actions at `at`). */
export function openContextMenu(ed: Editor, x: number, y: number, at: Vec): void {
  closeMenu();
  const m = h('div', {});
  // Wires and pointers: their nets' colour first (wirehue.ts), one undo step.
  const wires = ed.sel.wires ?? [], labels = ed.sel.labels ?? [];
  const net = netOfSelection(ed.compiled, ed.sel);
  const part = ed.selCount === 1 && ed.sel.parts?.length ? ed.doc.parts.find((p) => p.id === ed.sel.parts![0]) : undefined;
  const partDef = part && ed.defOf(part);
  if (wires.length || labels.length) {
    const cur = hueOfNets(ed.doc, ed.compiled, wires, labels);
    m.append(h('div', { class: 'sb-ctx-hues' }, h('span', null, 'Net colour'),
      hueSwatches(cur, (hue) => {
        closeMenu();
        ed.edit((d) => colourNets(d, ed.compiled, wires, labels, hue));
      }, 'menuitemradio')), h('hr'));
  }
  if (part && partDef) partHeader(m, part.id, partDef);
  const trace = net >= 0 ? traceOf(ed, net, m) : [];
  showMenu(x, y, [...trace, ...entries(ed, at)], { into: m, back: ed.view.svg });
}

registerEditorPlugin((ed) => {
  ed.tools.onContext = (x, y, at) => openContextMenu(ed, x, y, at);
  return () => {
    ed.tools.onContext = null;
    closeMenu();
  };
});
