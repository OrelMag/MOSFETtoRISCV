// The fault brush (docs/PLAN-ONI.md, D): break what you drew, on purpose, and watch what fails.
//
// B (or the Timing menu's Fault brush) arms it; a click on a wire, pointer or pin then offers: stuck at 0, stuck at 1
// (the whole net or one bit of a bus), slow (+k gate delays on its driving gate) and flip once (a stored bit, now). The
// first three are saved on the chip (ChipDoc.faults: undoable, never compiled into it) and applied to every build of its
// simulation (runtime.ts withFaults, sim/faults.ts applyFaults); flip once acts on the running simulation only. Faults
// are drawn as lightning badges, listed in the properties (switch each on or off, remove, clear all) and in the
// diagnostics, so a chip that misbehaves says why. A fault whose target is gone (its wire deleted) is kept, marked stale.

import { flipBits, flipRamBit, MAX_SLOW } from '../sim/faults';
import type { Vec } from '../sim/geometry';
import type { RamState } from '../lib/bigmem';
import { h, s } from '../ui/dom';
import { matches, shortcutAllowed } from '../ui/keys';
import { type MenuEntry, showMenu } from '../ui/menu';
import type { Diag } from './compile';
import { type Editor, registerDiagSource, registerEditorPlugin, registerToolbarAction } from './editor';
import type { Hit } from './geom';
import type { ChipDoc, FaultDoc } from './model';
import { type ProbeTarget, resolveProbe, sameTarget } from './probes';
import { registerPropsSection } from './props';
import { MAX_FAULTS } from './store';

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

const SLOW_STEPS = [1, 2, 4, 8, 16, MAX_SLOW];
/** Bit rows offered in a menu (a wider bus: the first ones; the list sets any bit). */
const MENU_BITS = 32;

const KIND_WORD: Record<FaultDoc['kind'], string> = { stuck0: 'stuck at 0', stuck1: 'stuck at 1', slow: 'slow' };

const newId = () => `f${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

class Faults {
  brush = false;
  private g: SVGGElement;
  private off: (() => void)[] = [];
  private prevPress: Editor['tools']['onPress'];
  private drawn: unknown[] = [];
  /** The big memory flip form's last choices. */
  private memPick = { leaf: -1, addr: 0, bit: 0 };

  constructor(private ed: Editor) {
    const svg = ed.view.svg;
    this.g = s('g', { class: 'ed-faults' });
    svg.insertBefore(this.g, svg.querySelector('g.ed-over'));
    // probe mode (analysis.ts) takes clicks too: the brush goes first while it is on
    this.prevPress = ed.tools.onPress;
    ed.tools.onPress = (hit, e) => (this.brush ? this.press(hit, e) : this.prevPress?.(hit, e) ?? false);
    this.off.push(ed.onChange(() => this.draw()), ed.onSimChange(() => this.draw()));
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.brush && !typing(e.target)) return this.setBrush(false);
      if (typing(e.target) || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if ((e.target as HTMLElement | null)?.closest?.('.sb-help, .key-help')) return;
      if (matches(e, 'sb.fault') && shortcutAllowed(e)) { e.preventDefault(); this.setBrush(!this.brush); }
    };
    document.addEventListener('keydown', key);
    this.off.push(() => document.removeEventListener('keydown', key));
  }

  destroy(): void {
    this.off.forEach((f) => f());
    this.ed.tools.onPress = this.prevPress;
    this.g.remove();
  }

  private get gate(): boolean {
    return this.ed.compiled?.mode !== 'switch';
  }

  setBrush(on: boolean): void {
    if (on && !this.gate) {
      this.ed.toast('Faults act on gates: this chip is solved at switch level');
      on = false;
    }
    this.brush = on;
    this.ed.el.querySelector('.sb-canvas')?.classList.toggle('faulting', on);
    this.ed.renderActions();
    this.ed.props.update(true);
    if (on) this.ed.toast('Fault brush: click a wire, pointer or pin to break it (B or Esc to leave)');
  }

  // ---- picking -------------------------------------------------------------------------------

  private press(hit: Hit, e: PointerEvent): boolean | (() => void) {
    const doc = this.ed.doc;
    const pill = (e.target as Element | null)?.closest?.('.bus-label')?.getAttribute('data-wire');
    let target: ProbeTarget;
    if (hit.k === 'wire') target = { wires: [hit.id] };
    else if (pill) target = { wires: [pill] };
    else if (hit.k === 'label') target = { pointer: doc.labels.find((l) => l.id === hit.id)?.name ?? '' };
    else if (hit.k === 'pin') target = { pin: hit.id };
    else return false;
    const x = e.clientX, y = e.clientY;
    return () => this.pick(target, x, y);
  }

  /** The nets a target has in the running simulation, LSB first (null: not simulated, or not on a net). */
  private netsOf(t: ProbeTarget): number[] | null {
    const sim = this.ed.sim.sim, built = this.ed.sim.built;
    if (!sim || !built) return null;
    return resolveProbe(t, this.ed.doc, built, sim.design)?.nets ?? null;
  }

  /** The faults already on this target. */
  private on(t: ProbeTarget): FaultDoc[] {
    const built = this.ed.sim.built;
    return (this.ed.doc.faults ?? []).filter((f) => built && sameTarget(f.target, t, this.ed.doc, built));
  }

  pick(t: ProbeTarget, x: number, y: number): void {
    const nets = this.netsOf(t);
    if (!nets) {
      this.ed.toast('Not simulated yet: finish the wiring (see the diagnostics)', 'err');
      return;
    }
    const w = nets.length;
    const bits = (run: (bit: number | undefined) => void, all = true): MenuEntry[] => [
      ...(all ? [{ label: `All ${w} bits`, run: () => run(undefined) }, null] : []),
      ...Array.from({ length: Math.min(w, MENU_BITS) }, (_, b) => ({ label: `Bit ${b}`, run: () => run(b) })),
    ];
    const stuck = (kind: 'stuck0' | 'stuck1'): MenuEntry => (w === 1
      ? { label: kind === 'stuck0' ? 'Stuck at 0' : 'Stuck at 1', hint: 'every part reading it sees this, whatever drives it', run: () => this.add({ kind, target: t }) }
      : { label: kind === 'stuck0' ? 'Stuck at 0' : 'Stuck at 1', sub: bits((bit) => this.add({ kind, target: t, bit })) });
    const had = this.on(t);
    const list: MenuEntry[] = [
      stuck('stuck0'),
      stuck('stuck1'),
      {
        label: 'Slow', hint: 'its gate answers k gate delays late: gate mode and Timing show it',
        sub: SLOW_STEPS.map((k) => ({ label: `+${k} gate delay${k > 1 ? 's' : ''}`, run: () => this.add({ kind: 'slow', target: t, delay: k }) })),
      },
      w === 1
        ? { label: 'Flip once', hint: 'a stored bit changes now (a cosmic ray); a gate puts a computed one back', run: () => this.flip(t, undefined) }
        : { label: 'Flip once', sub: bits((bit) => this.flip(t, bit), false) },
      ...(had.length ? [null, ...had.map((f) => ({ label: `Remove: ${this.describe(f, false)}`, run: () => this.remove(f.id) }))] : []),
    ];
    showMenu(x, y, list, { label: 'Fault', owner: this });
  }

  add(f: Omit<FaultDoc, 'id'>): void {
    const doc = this.ed.doc;
    const built = this.ed.sim.built;
    // one fault per target and bit: a new one replaces it
    const keep = (doc.faults ?? []).filter((q) => !(built && q.bit === f.bit && sameTarget(q.target, f.target, doc, built)));
    if (keep.length >= MAX_FAULTS) {
      this.ed.toast(`A chip holds at most ${MAX_FAULTS} faults`, 'err');
      return;
    }
    const nf: FaultDoc = { id: newId(), ...f };
    this.ed.edit((d) => ({ ...d, faults: [...keep, nf] }));
    this.ed.toast(`Fault: ${this.describe(nf)}. Undo, or switch it off in the properties, to heal it`);
  }

  private setFaults(f: (all: FaultDoc[]) => FaultDoc[]): void {
    this.ed.edit((d) => {
      const next = f(d.faults ?? []);
      return { ...d, faults: next.length ? next : undefined } as ChipDoc;
    });
  }

  remove(id: string): void {
    this.setFaults((all) => all.filter((f) => f.id !== id));
  }

  toggle(id: string, on: boolean): void {
    this.setFaults((all) => all.map((f) => (f.id === id ? { ...f, off: on ? undefined : true } : f)));
  }

  /** Flip a stored bit once in the running simulation (no undo: the next edge, or Reset, moves on). */
  flip(t: ProbeTarget, bit: number | undefined): void {
    const nets = this.netsOf(t);
    const sim = this.ed.sim.sim;
    if (!nets || !sim) return;
    const pick = bit === undefined ? nets : nets[bit] === undefined ? [] : [nets[bit]];
    // a stuck net reads its constant: a flip there changes nothing
    const to = sim.design.stuckTo;
    if (pick.some((n) => to?.has(n))) {
      this.ed.toast('That net is stuck: a flip cannot change it', 'err');
      return;
    }
    const held = flipBits(sim, pick);
    this.ed.sim.notify();
    const n = held.filter(Boolean).length;
    if (!pick.length) return;
    this.ed.toast(n === pick.length
      ? `Flipped${pick.length > 1 ? ` ${n} bits` : ''}: a loop stores it, so it stays until the circuit writes it again`
      : n === 0
        ? 'It went back: a gate computes this net (or it is X, or its latch is open), so a flip there lasts no time'
        : `${n} of ${pick.length} bits stayed flipped; the rest went back (a gate computes them)`);
  }

  // ---- drawing -------------------------------------------------------------------------------

  /** Where a target's badge goes: the middle of its longest wire segment, the pointer, the pin. */
  private spot(t: ProbeTarget): Vec | null {
    const doc = this.ed.doc;
    if ('wires' in t) {
      const polys = this.ed.view.polys;
      let at: Vec | null = null, len = -1;
      for (const id of t.wires) {
        const p = polys.get(id);
        for (let i = 1; p && i < p.length; i++) {
          const [a, b] = [p[i - 1], p[i]];
          const d = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
          if (d > len) { len = d; at = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
        }
      }
      return at;
    }
    if ('pointer' in t) return doc.labels.find((q) => q.name === t.pointer)?.at ?? null;
    if ('pin' in t) return doc.pins.find((p) => p.id === t.pin)?.at ?? null;
    return null;
  }

  draw(): void {
    const doc = this.ed.doc, st = this.ed.sim.faults;
    const key = [doc.faults, st, this.ed.view.polys.size, doc.wires, doc.labels, doc.pins];
    if (key.every((k, i) => k === this.drawn[i])) return;
    this.drawn = key;
    this.g.replaceChildren();
    // badges on one spot stack sideways
    const used = new Map<string, number>();
    for (const f of doc.faults ?? []) {
      const at = this.spot(f.target);
      if (!at) continue;
      const k = `${at[0]},${at[1]}`, n = used.get(k) ?? 0;
      used.set(k, n + 1);
      const stale = st.stale.has(f.id);
      const b = s('g', {
        class: `fault-badge ${f.kind}${f.off ? ' off' : ''}${stale ? ' stale' : ''}`,
        transform: `translate(${at[0] + n * 1.3},${at[1] - 1.1})`, 'data-fault': f.id,
      });
      b.append(
        s('title', null, `Fault: ${this.describe(f)}${f.off ? ' (switched off)' : ''}${stale ? ' (its net is gone)' : ''}`),
        s('circle', { r: 0.62 }),
        s('path', { d: 'M0.1,-0.5 L-0.28,0.06 H0.02 L-0.1,0.5 L0.3,-0.08 H0 Z' }),
      );
      if (f.kind !== 'slow') b.append(s('text', { x: 0.9, y: 0.3 }, f.kind === 'stuck0' ? '0' : '1'));
      this.g.append(b);
    }
  }

  // ---- words ---------------------------------------------------------------------------------

  /** "stuck at 1 on carry (bit 3)" */
  describe(f: FaultDoc, where = true): string {
    const what = f.kind === 'slow' ? `slow +${f.delay ?? 1}` : KIND_WORD[f.kind];
    const bit = f.bit !== undefined ? ` (bit ${f.bit})` : '';
    return where ? `${what} on ${this.nameOf(f.target)}${bit}` : `${what}${bit}`;
  }

  private nameOf(t: ProbeTarget): string {
    if ('pin' in t) return `pin ${this.ed.doc.pins.find((p) => p.id === t.pin)?.name ?? '?'}`;
    if ('pointer' in t) return `pointer ${t.pointer}`;
    const sim = this.ed.sim.sim, built = this.ed.sim.built;
    const r = sim && built ? resolveProbe(t, this.ed.doc, built, sim.design) : null;
    return r ? r.label : 'a wire';
  }

  // ---- the properties and diagnostics -----------------------------------------------------------

  diags(): Diag[] {
    const doc = this.ed.doc, st = this.ed.sim.faults;
    const out: Diag[] = [];
    for (const f of doc.faults ?? []) {
      if (f.off) continue;
      const wires = 'wires' in f.target ? f.target.wires : undefined;
      const pins = 'pin' in f.target ? [f.target.pin] : undefined;
      if (st.stale.has(f.id)) out.push({ level: 'warn', msg: `Fault ${this.describe(f)} is on nothing`, fix: 'its wire, pointer or pin is gone. Remove it in the properties.' });
      else out.push({ level: 'hint', msg: `Fault: ${this.describe(f)}`, fix: 'set with the fault brush (B). Switch it off or remove it in the properties.', wires, pins });
    }
    for (const p of st.problems) out.push({ level: 'warn', msg: 'A fault could not be set', fix: `${p}.` });
    return out;
  }

  section(): HTMLElement | null {
    const doc = this.ed.doc, st = this.ed.sim.faults;
    const all = doc.faults ?? [];
    const mems = this.memories();
    if (!all.length && !this.brush && !mems.length) return null;
    const rows = all.map((f) => {
      const box = h('input', { type: 'checkbox' }) as HTMLInputElement;
      box.checked = !f.off;
      box.addEventListener('change', () => this.toggle(f.id, box.checked));
      const x = h('button', { class: 'btn icon-btn', title: 'Remove this fault', 'aria-label': `Remove fault ${this.describe(f)}` }, '×');
      x.addEventListener('click', () => this.remove(f.id));
      const stale = st.stale.has(f.id);
      return h('div', { class: `sb-fault-row${stale ? ' stale' : ''}` },
        h('label', { class: 'sb-check' }, box, `${this.describe(f)}${stale ? ' (its net is gone)' : ''}`), x);
    });
    const brush = h('button', { class: `btn${this.brush ? ' on' : ''}`, 'aria-pressed': String(this.brush) }, this.brush ? 'Leave the fault brush' : 'Fault brush (B)');
    brush.addEventListener('click', () => this.setBrush(!this.brush));
    const btns = [brush];
    if (all.length) {
      const clear = h('button', { class: 'btn' }, 'Clear all');
      clear.addEventListener('click', () => this.setFaults(() => []));
      btns.push(clear);
    }
    return h('section', { class: 'sb-sec-props sb-faults' },
      h('h3', null, 'Faults'),
      h('p', { class: 'sb-sum' }, all.length
        ? 'Saved with the chip, never part of it: switch one off to heal it, Undo to take it back.'
        : 'Break the circuit on purpose: stuck at 0 or 1, slow, or a bit flipped once. Click a wire with the brush.'),
      ...rows,
      ...st.problems.map((p) => h('p', { class: 'sb-sum warn' }, p)),
      h('div', { class: 'sb-btns' }, ...btns),
      ...(mems.length ? [this.memForm(mems)] : []));
  }

  /** The large memories of the running simulation (their words live in a leaf, not in wires). */
  private memories(): { leaf: number; name: string; words: number }[] {
    const sim = this.ed.sim.sim;
    if (!sim || !this.gate) return [];
    const out: { leaf: number; name: string; words: number }[] = [];
    sim.design.leaves.forEach((l, i) => {
      if (l.kind !== 'behavior' || !l.def.preferBehavior) return;
      const st = sim.leafState(i) as RamState | undefined;
      if (st && st.mem instanceof Uint32Array) out.push({ leaf: i, name: l.node.path.join('.'), words: st.mem.length });
    });
    return out.slice(0, 16);
  }

  /** Flip one bit of a word in a large memory. */
  private memForm(mems: { leaf: number; name: string; words: number }[]): HTMLElement {
    const p = this.memPick;
    if (!mems.some((m) => m.leaf === p.leaf)) p.leaf = mems[0].leaf;
    const sel = h('select', { 'aria-label': 'Memory' }, ...mems.map((m) => h('option', { value: String(m.leaf) }, `${m.name} (${m.words} words)`))) as HTMLSelectElement;
    sel.value = String(p.leaf);
    const num = (v: number, label: string) => h('input', { type: 'number', min: '0', value: String(v), 'aria-label': label, class: 'sb-fault-num' }) as HTMLInputElement;
    const addr = num(p.addr, 'Word address'), bit = num(p.bit, 'Bit');
    const go = h('button', { class: 'btn' }, 'Flip');
    go.addEventListener('click', () => {
      p.leaf = Number(sel.value); p.addr = Math.max(0, Math.floor(Number(addr.value) || 0)); p.bit = Math.min(31, Math.max(0, Math.floor(Number(bit.value) || 0)));
      const sim = this.ed.sim.sim;
      if (!sim) return;
      if (flipRamBit(sim, p.leaf, p.addr, p.bit)) {
        sim.settle();
        this.ed.sim.notify();
        this.ed.toast(`Word ${p.addr}, bit ${p.bit} flipped`);
      } else this.ed.toast('No such word, or it is still X', 'err');
    });
    return h('div', { class: 'sb-fault-mem' },
      h('p', { class: 'sb-sum' }, 'A large memory keeps its words inside: flip one of their bits here.'),
      h('div', { class: 'sb-btns' }, sel, 'word', addr, 'bit', bit, go));
  }
}

const of = new WeakMap<Editor, Faults>();

registerEditorPlugin((ed) => {
  const f = new Faults(ed);
  of.set(ed, f);
  f.draw();
  return () => f.destroy();
});

registerToolbarAction({
  id: 'faults', title: 'Fault brush (B): click a wire to make it stuck, slow, or flip it once', icon: 'flag', label: 'Faults', menu: 'Fault brush (B)', order: 62, under: 'timingmenu',
  run: (ed) => { const f = of.get(ed); f?.setBrush(!f.brush); },
  active: (ed) => !!of.get(ed)?.brush,
});

registerDiagSource((ed) => of.get(ed)?.diags() ?? []);

registerPropsSection({
  id: 'faults', order: 16,
  render: (ed) => (ed.selCount ? null : of.get(ed)?.section() ?? null),
});
