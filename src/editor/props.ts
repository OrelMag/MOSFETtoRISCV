// The properties panel: what the selection is and what can be changed about it; with nothing
// selected, the chip itself (name, colour, notes, port order, level, cost). The diagnostics of
// the chip are listed below, each one locating its objects when clicked. Later phases add
// sections through registerPropsSection (a ROM's program, the inspector, ...).
//
// Fields commit on 'change' (Enter or leaving the field), each one undo step. The panel is
// rebuilt only when the selection or the selected objects change, never while typing.

import { familyOf } from '../lib/resolve';
import type { Vec } from '../sim/geometry';
import { logicDepth, stats } from '../sim/stats';
import { type ComponentDef, netlistOf } from '../sim/types';
import { parseBig } from '../sim/values';
import { h, icon } from '../ui/dom';
import type { Diag } from './compile';
import type { Editor } from './editor';
import { pinKnob, pointerGeom } from './geom';
import { renamePin } from './chips';
import { removeChip } from './library';
import { allOnes, type ChipDoc, type DisplayKind, type ExitDir, type LabelDoc, type PartDoc, type PartRef, pinBig, type PinDoc, pinValue, type WireDoc } from './model';
import { deleteSel, flipParts, setLabel, setPart, setPin, setRef, setWire } from './ops';
import { MAX_RAM_K, MAX_WIDTH } from './parts';
import { openChip } from './session';

export interface PropsSection {
  id: string;
  /** Position among the sections (built-in selection section: 10; diagnostics come last). */
  order: number;
  /** A section for the current state of the editor, or null when it has nothing to show. */
  render(ed: Editor): HTMLElement | null;
}

const sections: PropsSection[] = [];

/** Add a section to the properties panel (or replace the one with the same id). */
export function registerPropsSection(sec: PropsSection): void {
  const i = sections.findIndex((q) => q.id === sec.id);
  if (i >= 0) sections[i] = sec;
  else sections.push(sec);
  sections.sort((a, b) => a.order - b.order);
}

const serials = new WeakMap<object, number>();
let serialN = 1;
const ser = (o: object | undefined) => (o ? serials.get(o) ?? (serials.set(o, serialN), serialN++) : 0);

const FACES: ExitDir[] = ['right', 'left', 'up', 'down'];

export class PropsPanel {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private diagEl: HTMLElement;
  private key = '';
  private diagKey = '';
  private depthTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private ed: Editor) {
    this.body = h('div', { class: 'sb-props-body' });
    this.diagEl = h('div', { class: 'sb-diags' });
    this.el = h('aside', { class: 'sb-props', 'aria-label': 'Properties' }, this.body, this.diagEl);
    // An update skipped while a field had focus happens when the focus leaves.
    this.body.addEventListener('focusout', () => setTimeout(() => this.update()));
  }

  /** Rebuild even though nothing it keys on changed (a section was registered late). */
  rebuild(): void {
    this.key = '';
    this.update();
  }

  /** Rebuild if what it shows changed (`force`: even if the user is typing in it). */
  update(force = false): void {
    const ed = this.ed;
    const doc = ed.doc;
    if (!doc) return;
    const s = ed.sel;
    const objs = [
      ...(s.parts ?? []).map((id) => doc.parts.find((p) => p.id === id)),
      ...(s.pins ?? []).map((id) => doc.pins.find((p) => p.id === id)),
      ...(s.labels ?? []).map((id) => doc.labels.find((p) => p.id === id)),
      ...(s.wires ?? []).map((id) => doc.wires.find((p) => p.id === id)),
    ];
    const none = !objs.length;
    const key = JSON.stringify([ed.chipId, s, objs.map(ser), none ? [doc.name, doc.hue, doc.notes, ser(doc.pins), ser(ed.compiled?.def), Object.keys(ed.ws.chips).length] : 0,
      s.labels?.length ? doc.labels.map((l) => l.name) : 0]);
    if (key !== this.key && (force || !this.body.contains(document.activeElement))) {
      this.key = key;
      this.body.replaceChildren();
      const own = none ? this.chip(doc) : objs.length > 1 ? this.many(objs.length) : this.one(doc);
      if (own) this.body.append(own);
      for (const sec of sections) {
        const el = sec.render(ed);
        if (el) this.body.append(el);
      }
    }
    this.diags(ed.diags);
  }

  // ---- building blocks ---------------------------------------------------------------------

  private section(title: string, ...children: (Node | null | false)[]): HTMLElement {
    return h('section', { class: 'sb-sec-props' }, h('h3', null, title), ...children);
  }

  private row(label: string, ctl: Node, hint?: string): HTMLElement {
    return h('label', { class: 'sb-row', title: hint ?? null }, h('span', null, label), ctl);
  }

  private text(value: string, commit: (v: string) => void, attrs: Record<string, string> = {}): HTMLInputElement {
    const i = h('input', { type: 'text', value, spellcheck: 'false', ...attrs }) as HTMLInputElement;
    i.addEventListener('change', () => commit(i.value));
    i.addEventListener('keydown', (e) => { if (e.key === 'Enter') i.blur(); });
    return i;
  }

  private num(value: number, min: number, max: number, commit: (v: number) => void): HTMLInputElement {
    const i = h('input', { type: 'number', value: String(value), min: String(min), max: String(max), step: '1' }) as HTMLInputElement;
    i.addEventListener('change', () => {
      const v = Number(i.value);
      if (Number.isInteger(v) && v >= min && v <= max) commit(v);
      else i.value = String(value);
    });
    return i;
  }

  private select<T extends string | number>(value: T, options: [T, string][], commit: (v: T) => void): HTMLSelectElement {
    const sel = h('select', null, options.map(([v, l]) => h('option', { value: String(v), selected: v === value }, l))) as HTMLSelectElement;
    sel.addEventListener('change', () => commit(options.find(([v]) => String(v) === sel.value)![0]));
    return sel;
  }

  private btn(label: string, title: string, f: () => void, ic?: string): HTMLButtonElement {
    return h('button', { class: 'btn sm', title, onclick: f }, ic ? icon(ic, 14) : null, label) as HTMLButtonElement;
  }

  /** Apply an edit that may be refused (the reason becomes a toast). */
  private apply(f: (doc: ChipDoc) => { doc: ChipDoc; reason?: string }): boolean {
    const r = f(this.ed.doc);
    if (r.reason) {
      this.ed.toast(r.reason, 'err');
      this.key = '';
      this.update(true);
      return false;
    }
    this.ed.edit(() => r.doc);
    return true;
  }

  // ---- the selection -----------------------------------------------------------------------

  private many(n: number): HTMLElement {
    const ed = this.ed;
    return this.section(`${n} objects selected`,
      h('div', { class: 'sb-btns' },
        this.btn('Flip', 'Mirror left–right (F)', () => ed.edit((d) => flipParts(d, ed.sel.parts ?? [], ed.defOf))),
        this.btn('Delete', 'Delete (Del)', () => { ed.edit((d) => deleteSel(d, ed.sel)); ed.select({}); })));
  }

  private one(doc: ChipDoc): HTMLElement | null {
    const s = this.ed.sel;
    if (s.parts?.length) return this.part(doc.parts.find((p) => p.id === s.parts![0])!);
    if (s.pins?.length) return this.pin(doc.pins.find((p) => p.id === s.pins![0])!);
    if (s.labels?.length) return this.pointer(doc, doc.labels.find((p) => p.id === s.labels![0])!);
    if (s.wires?.length) return this.wire(doc.wires.find((p) => p.id === s.wires![0])!);
    return null;
  }

  private part(p: PartDoc): HTMLElement {
    const ed = this.ed;
    const def = ed.defOf(p);
    const ref = p.ref;
    const setR = (r: PartRef) => this.apply((d) => setRef(d, p.id, r, ed.defOf));
    const out = this.section(def?.name ?? 'Unresolved part',
      def?.summary ? h('p', { class: 'sb-sum' }, def.summary) : null,
      this.row('Name', this.text(p.id, (v) => {
        if (this.apply((d) => setPart(d, p.id, { id: v.trim() }, ed.defOf))) ed.select({ parts: [v.trim()] });
      }), 'Instance name: unique in this chip (letters, digits, _)'),
      this.row('Caption', this.text(p.label ?? '', (v) => this.apply((d) => setPart(d, p.id, { label: v.trim() || undefined })), { placeholder: p.id })));

    if ('lib' in ref) {
      const f = familyOf(ref.lib);
      if (f) {
        for (const prm of f.fam.params) {
          out.append(this.row(prm.name, this.select(f.values[prm.name], prm.values.map((v): [number, string] => [v, prm.label ? prm.label(v) : String(v)]),
            (v) => setR({ lib: f.fam.key({ ...f.values, [prm.name]: v }) }))));
        }
      }
      out.append(h('p', { class: 'sb-links' }, h('a', { href: `#/workbench/${ref.lib}`, title: 'Open this part on its own in the workbench' }, icon('bench', 13), 'Open in workbench')));
    } else if ('chip' in ref) {
      out.append(h('div', { class: 'sb-btns' }, this.btn('Edit chip', 'Open this chip for editing (or double-click it); Back returns here', () => ed.editChip(ref.chip), 'chip')));
    } else if ('split' in ref || 'merge' in ref) {
      const ws = 'split' in ref ? ref.split : ref.merge;
      const mk = (w: number[], pitch?: number): PartRef => {
        const pt = pitch && pitch !== 2 ? { pitch } : {};
        return 'split' in ref ? { split: w, ...pt } : { merge: w, ...pt };
      };
      out.append(this.row('Widths', this.text(ws.join(', '), (v) => {
        const w = v.split(/[\s,+]+/).filter(Boolean).map(Number);
        if (w.length && w.every((x) => Number.isInteger(x) && x >= 1)) setR(mk(w, ref.pitch));
        else ed.toast('Widths: a list of positive integers, e.g. 8, 8', 'err');
      }), 'Bus widths, first = bit 0 upwards'),
      this.row('Pitch', this.select(ref.pitch ?? 2, [[1, '1'], [2, '2'], [3, '3'], [4, '4']], (v) => setR(mk(ws, v))), 'Spacing of the taps in grid units'));
    } else if ('const' in ref) {
      const { width, value } = ref.const;
      out.append(this.row('Width', this.num(width, 1, 53, (w) => setR({ const: { width: w, value: value % 2 ** w } }))),
        this.row('Value', this.text(width > 4 ? `0x${value.toString(16).toUpperCase()}` : String(value), (v) => {
          const n = parseNum(v);
          if (n === null || n >= 2 ** width) return void ed.toast(`Value: 0 to ${2 ** width - 1}`, 'err');
          setR({ const: { width, value: n } });
        }), 'Decimal, 0x hex or 0b binary'));
    } else if ('display' in ref) {
      const kinds: [DisplayKind, string][] = [['led', 'LED'], ['seg7', '7-segment'], ['hex', 'Hex digit'], ['value', 'Value'], ['halt', 'Halt (stops Run)']];
      out.append(this.row('Shows', this.select(ref.display, kinds, (k) => setR({ display: k, width: k === 'led' || k === 'halt' ? 1 : k === 'hex' ? 4 : k === 'seg7' ? 8 : ref.width ?? 8 }))),
        this.row('Width', this.num(ref.width ?? 1, 1, MAX_WIDTH, (w) => setR({ display: ref.display, width: w }))));
    } else if ('ram' in ref) {
      const { k, w } = ref.ram;
      out.append(this.row('Words', this.select(k, Array.from({ length: MAX_RAM_K }, (_, i): [number, string] => [i + 1, String(2 ** (i + 1))]), (v) => setR({ ram: { ...ref.ram, k: v } }))),
        this.row('Word width', this.select(w, [1, 2, 4, 8, 16, 32].map((v): [number, string] => [v, `${v} bits`]), (v) => setR({ ram: { ...ref.ram, w: v } }))));
    } // a ROM's size, addressing and program: memui.ts's section
    if (def) out.append(costLine(def));
    out.append(h('div', { class: 'sb-btns' },
      this.btn('Flip', 'Mirror left–right (F)', () => ed.edit((d) => flipParts(d, [p.id], ed.defOf))),
      this.btn('Delete', 'Delete (Del)', () => { ed.edit((d) => deleteSel(d, { parts: [p.id] })); ed.select({}); })));
    return out;
  }

  private pin(p: PinDoc): HTMLElement {
    const ed = this.ed;
    const set = (patch: Partial<PinDoc>) => this.apply((d) => setPin(d, p.id, patch, ed.defOf));
    // A rename also rewires the port in every chip that places this one (renamePort).
    const rename = (v: string) => {
      const r = renamePin(ed.ws, ed.chipId, p.id, v.trim(), ed.defOf);
      if ('reason' in r) {
        ed.toast(r.reason, 'err');
        this.key = '';
        this.update(true);
      } else ed.editWs(() => r.ws);
    };
    const out = this.section(p.dir === 'in' ? 'Input pin' : p.dir === 'inout' ? 'Bidirectional pin' : 'Output pin',
      this.row('Name', this.text(p.name, rename), 'The port name of the chip (chips that use it keep their wires)'),
      this.row('Direction', this.select(p.dir, [['in', 'input'], ['out', 'output'], ['inout', 'bidirectional']],
        (v) => set({ dir: v, ...(v !== 'in' ? { kind: undefined, value: undefined } : {}) })), 'Bidirectional: switch level only'),
      this.row('Width', this.num(p.width, 1, MAX_WIDTH, (w) => set({ width: w, value: undefined }))),
      this.row('Faces', this.select(p.face ?? (p.dir === 'in' ? 'right' : 'left'), FACES.map((f): [ExitDir, string] => [f, f]), (f) => set({ face: f })), 'Direction the wire leaves the pin'));
    if (p.dir === 'inout') {
      out.append(h('p', { class: 'sb-sum' }, 'A transistor terminal brought out, like an SRAM cell’s bit line: the chip and its parent may both drive it, so it needs switch level (transistors inside). Click the pin to drive it: Z (nothing) → 0 → 1 → Z.'),
        this.row('Drives', this.select(p.value === undefined ? 'z' : String(p.value), [['z', 'Z (undriven)'], ['0', '0'], [String(allOnes(p.width)), p.width === 1 ? '1' : `0x${pinBig(allOnes(p.width)).toString(16).toUpperCase()}`]],
          (v) => ed.setPinValue(p.id, v === 'z' ? undefined : pinValue(BigInt(v)))), 'What the outside drives onto the pin'));
    }
    if (p.dir === 'in') {
      out.append(this.row('Kind', this.select(p.kind ?? 'toggle', [['toggle', 'toggle'], ['button', 'button (momentary)'], ['clock', 'clock']], (k) => set({ kind: k === 'toggle' ? undefined : k })),
        'A clock pin is driven by Run / Step and becomes a clock input of the chip'));
      if (p.kind !== 'clock' && p.kind !== 'button') {
        out.append(this.row('Value', this.text(p.width > 4 ? `0x${pinBig(p.value).toString(16).toUpperCase()}` : String(p.value ?? 0), (v) => {
          const n = parseBig(v);
          if (n === null || n >> BigInt(p.width)) return void ed.toast(`Value: 0 to ${p.width > 16 ? `2^${p.width} − 1` : 2 ** p.width - 1}`, 'err');
          ed.setPinValue(p.id, pinValue(n));
        }), 'Decimal, 0x hex or 0b binary (or click the pin)'));
      }
    }
    out.append(h('div', { class: 'sb-btns' },
      this.btn('Delete', 'Delete (Del)', () => { ed.edit((d) => deleteSel(d, { pins: [p.id] })); ed.select({}); })));
    return out;
  }

  private pointer(doc: ChipDoc, l: LabelDoc): HTMLElement {
    const ed = this.ed;
    const names = [...new Set(doc.labels.map((q) => q.name))];
    const nameIn = this.text(l.name, (v) => this.apply((d) => setLabel(d, l.id, { name: v }, ed.defOf)), { list: 'sb-ptr-names' });
    const same = doc.labels.filter((q) => q.name === l.name);
    const out = this.section('Pointer',
      h('p', { class: 'sb-sum' }, 'Every pointer with the same name is the same net: no wire needed between them.'),
      this.row('Name', nameIn), h('datalist', { id: 'sb-ptr-names' }, names.map((n) => h('option', { value: n }))),
      this.row('Faces', this.select(l.face ?? 'right', FACES.map((f): [ExitDir, string] => [f, f]), (f) => this.apply((d) => setLabel(d, l.id, { face: f }, ed.defOf)))));
    out.append(h('div', { class: 'sb-same' }, h('b', null, `${same.length} named “${l.name}”`),
      same.map((q) => h('button', { class: `sb-chip-btn${q.id === l.id ? ' on' : ''}`, title: 'Go to this pointer', onclick: () => this.goto({ labels: [q.id] }, pointerGeom(q).tip) }, `${q.id} (${q.at[0]}, ${q.at[1]})`))));
    if (same.length > 1) out.append(h('div', { class: 'sb-btns' }, this.btn('Next', 'Jump to the next pointer with this name (click it again, or double-click)', () => ed.tools.jump(l.id))));
    out.append(h('div', { class: 'sb-btns' }, this.btn('Delete', 'Delete (Del)', () => { ed.edit((d) => deleteSel(d, { labels: [l.id] })); ed.select({}); })));
    return out;
  }

  private wire(w: WireDoc): HTMLElement {
    const ed = this.ed;
    const set = (patch: Partial<WireDoc>) => this.apply((d) => setWire(d, w.id, patch, ed.defOf));
    const net = ed.compiled?.netOfWire.get(w.id) ?? -1;
    return this.section('Wire',
      h('p', { class: 'sb-sum' }, net >= 0 ? `On net ${netlistOf(ed.compiled.def)?.nets[net]?.name ?? `#${net}`}.` : 'Not part of a working net (see the diagnostics).'),
      this.row('Net name', this.text(w.name ?? '', (v) => set({ name: v.trim() || undefined }), { placeholder: 'optional' }), 'Shown in the inside view and in Verilog'),
      this.row('Capacitive', (() => {
        const c = h('input', { type: 'checkbox', checked: !!w.cap }) as HTMLInputElement;
        c.addEventListener('change', () => set({ cap: c.checked || undefined }));
        return c;
      })(), 'Switch level: the net keeps its charge when nothing drives it (a DRAM node, a bit line)'),
      this.row('Power-on', this.select(w.init === undefined ? '' : String(w.init), [['', 'none'], ['0', '0'], ['1', '1']], (v) => set({ init: v === '' ? undefined : (Number(v) as 0 | 1) })),
        'Value of the net at power-on in "power on: 0" mode (the bit a latch starts with)'),
      h('div', { class: 'sb-btns' }, this.btn('Delete', 'Delete (Del)', () => { ed.edit((d) => deleteSel(d, { wires: [w.id] })); ed.select({}); })));
  }

  // ---- the chip ----------------------------------------------------------------------------

  private chip(doc: ChipDoc): HTMLElement {
    const ed = this.ed;
    const c = ed.compiled;
    const editDoc = (patch: Partial<ChipDoc>) => ed.edit((d) => {
      const n = { ...d, ...patch } as ChipDoc & Record<string, unknown>;
      for (const [k, v] of Object.entries(patch)) if (v === undefined) delete n[k];
      return n;
    });
    const hue = h('input', { type: 'range', min: '0', max: '359', value: String(doc.hue ?? 250), 'aria-label': 'Colour' }) as HTMLInputElement;
    const swatch = h('span', { class: 'sb-hue', style: `--chip-h:${doc.hue ?? 250}` });
    hue.addEventListener('input', () => swatch.setAttribute('style', `--chip-h:${hue.value}`));
    hue.addEventListener('change', () => editDoc({ hue: Number(hue.value) }));
    const notes = h('textarea', { rows: '3', placeholder: 'What it does, how to use it…' }, doc.notes ?? '') as HTMLTextAreaElement;
    notes.addEventListener('change', () => editDoc({ notes: notes.value.trim() || undefined }));
    const ports = c?.def.ports ?? [];
    const out = this.section('Chip',
      this.row('Name', this.text(doc.name, (v) => v.trim() && editDoc({ name: v.trim() }))),
      this.row('Colour', h('span', { class: 'sb-hue-row' }, swatch, hue)),
      this.row('Notes', notes),
      h('div', { class: 'sb-badges' },
        h('span', { class: `sb-level ${c?.mode ?? 'gate'}` }, c?.mode === 'switch' ? 'switch level' : 'gate level'),
        c?.mode === 'switch' && c.derived ? h('span', { class: `sb-derived${c.derived.ok ? ' ok' : ''}`, title: c.derived.ok ? 'Its truth table is used as a gate-level model, so it can be a brick of gate-level chips' : c.derived.reason },
          c.derived.ok ? 'usable as a gate-level brick' : `switch level only: ${c.derived.reason.replace(/: switch level only$/, '')}`) : null),
      c?.mode === 'switch' && c.derived?.ok ? h('p', { class: 'sb-sum' }, 'Combinational: its truth table, derived from its transistors, models it when a gate-level chip places it.') : null,
      h('div', { class: 'sb-ports' }, h('b', null, 'Ports, in order'),
        ports.length ? h('ol', null, ports.map((p) => h('li', null, h('span', { class: `sb-dir ${p.dir}` }, p.dir), ` ${p.name}`, p.width > 1 ? h('small', null, ` [${p.width - 1}:0]`) : null, p.clock ? h('small', null, ' clock') : null)))
          : h('p', { class: 'sb-sum' }, 'No pins yet: place inputs and outputs from the palette.')),
      c ? costLine(c.def, (el) => this.depthLater(c.def, el)) : null);
    const users = ed.lib.usedBy(doc.id);
    out.append(h('p', { class: 'sb-sum' }, `id ${doc.id}`),
      h('div', { class: 'sb-btns' }, this.btn('Delete chip', users.length ? 'Remove it from the chips that use it first' : 'Delete this chip (Ctrl+Z brings it back)', () => this.deleteChip(doc))));
    return out;
  }

  private deleteChip(doc: ChipDoc): void {
    const ed = this.ed;
    const r = removeChip(ed.ws, doc.id);
    if ('error' in r) return void ed.toast(`Cannot delete: ${r.error}`, 'err');
    let ws = r.ws;
    if (!Object.keys(ws.chips).length) {
      const blank = { id: 'u_main', name: 'Main', pins: [], parts: [], wires: [], labels: [] };
      ws = { ...ws, chips: { u_main: blank }, open: ['u_main'] };
    } else if (!ws.open.length) ws = openChip({ ...ws, open: [] }, Object.keys(ws.chips)[0]);
    ed.editWs(() => ws);
    ed.toast(`Deleted ${doc.name} (Ctrl+Z to undo)`);
  }

  /** Logic depth needs a full flatten: computed shortly after the chip stops changing. */
  private depthLater(def: ComponentDef, el: HTMLElement): void {
    if (this.depthTimer) clearTimeout(this.depthTimer);
    this.depthTimer = setTimeout(() => {
      if (this.ed.compiled?.def !== def || this.ed.compiled.mode !== 'gate') return;
      const d = logicDepth(def);
      el.textContent = d === null ? 'sequential' : `depth ${d}`;
    }, 300);
  }

  private goto(sel: { labels?: string[]; parts?: string[]; pins?: string[]; wires?: string[] }, at: Vec | null): void {
    this.ed.select(sel);
    if (at) this.ed.view.centerOn(at);
  }

  // ---- diagnostics -------------------------------------------------------------------------

  private diags(ds: Diag[]): void {
    const key = JSON.stringify(ds);
    if (key === this.diagKey) return;
    this.diagKey = key;
    this.diagEl.replaceChildren();
    if (!ds.length) return;
    const errs = ds.filter((d) => d.level === 'error').length;
    this.diagEl.append(h('h3', null, errs ? `${errs} problem${errs > 1 ? 's' : ''}` : 'Warnings', ds.length > errs ? h('small', null, ` · ${ds.length - errs} warning${ds.length - errs > 1 ? 's' : ''}`) : null));
    for (const d of ds.slice(0, 50)) {
      const b = h('button', { class: `sb-diag ${d.level}`, title: 'Show where' }, h('span', { class: 'sb-dot' }), d.msg);
      b.addEventListener('click', () => this.locate(d));
      this.diagEl.append(b);
    }
  }

  private locate(d: Diag): void {
    const ed = this.ed;
    const doc = ed.doc;
    const sel = {
      ...(d.parts?.length ? { parts: d.parts.filter((id) => doc.parts.some((p) => p.id === id)) } : {}),
      ...(d.pins?.length ? { pins: d.pins } : {}),
      ...(d.wires?.length ? { wires: d.wires } : {}),
      ...(d.labels?.length ? { labels: d.labels } : {}),
    };
    let at: Vec | null = null;
    const part = doc.parts.find((p) => d.parts?.includes(p.id));
    const pin = doc.pins.find((p) => d.pins?.includes(p.id));
    const lbl = doc.labels.find((l) => d.labels?.includes(l.id));
    const wire = d.wires?.map((id) => ed.view.polys.get(id)).find((p) => p);
    if (part) at = part.at;
    else if (pin) at = pinKnob(pin);
    else if (lbl) at = lbl.at;
    else if (wire) at = wire[Math.floor(wire.length / 2)];
    this.goto(sel, at);
    if (part) ed.view.ping('part', part.id);
  }
}

/** NAND, transistor (and resistor, capacitor) counts; `depth` fills in a slot for the logic depth (computed later). */
function costLine(def: ComponentDef, depth?: (el: HTMLElement) => void): HTMLElement {
  let st;
  try {
    st = stats(def);
  } catch {
    return h('p', { class: 'sb-sum' });
  }
  const slot = depth ? h('span') : null;
  const el = h('p', { class: 'sb-cost' },
    h('span', null, h('b', null, st.nands.toLocaleString()), ' NAND'),
    h('span', null, h('b', null, st.transistors.toLocaleString()), ' transistors'),
    st.resistors ? h('span', null, h('b', null, st.resistors.toLocaleString()), st.resistors > 1 ? ' resistors' : ' resistor') : null,
    st.capacitors ? h('span', null, h('b', null, st.capacitors.toLocaleString()), st.capacitors > 1 ? ' capacitors' : ' capacitor') : null, slot);
  if (depth && slot) depth(slot);
  return el;
}

/** Decimal, 0x hex or 0b binary; null if not a non-negative integer. */
export function parseNum(s: string): number | null {
  const t = s.trim().toLowerCase().replace(/_/g, '');
  const n = /^0x[0-9a-f]+$/.test(t) ? parseInt(t.slice(2), 16) : /^0b[01]+$/.test(t) ? parseInt(t.slice(2), 2) : /^\d+$/.test(t) ? parseInt(t, 10) : NaN;
  return Number.isSafeInteger(n) ? n : null;
}
