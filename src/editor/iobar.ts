// The sandbox's I/O bar: the open chip's pins as the workbench's bottom bar draws them (inputs
// raised, with ▸ before them, a 1-bit one a switch; outputs as lamps and readouts on a sunken
// strip, ▸ after), above the run bar. On a big circuit the pins scroll out of view; here they stay
// at hand. Every control does what a click on the pin does (Editor.setPinValue, the clocks, a
// held button), so values stay in step with the canvas, are saved alike and are never undone.
// After the pins: the switch banks and keys inside the chips this one places (ionested.ts), each
// headed by its path, flippable / held here; past IOBAR_BANKS banks the rest fold behind "+n".

import { closePopover, editNumber } from '../view/popover';
import { formatBits } from '../sim/values';
import { B0, B1, BZ, type Bit } from '../sim/types';
import { h } from '../ui/dom';
import { nextDrive, pinOrder } from './chips';
import { type Editor, registerEditorPlugin, registerToolbarAction } from './editor';
import { bankValue, controlPath, flipBank, IOBAR_BANKS, type NestedControl, nestedControls } from './ionested';
import { type ChipDoc, type PinDoc, pinBig, pinValue } from './model';

const PREF = 'mosfet2riscv:sandbox:iobar';
/** Shown unless the user hid it (per browser; storage may be unavailable). */
let wanted = (() => { try { return localStorage.getItem(PREF) !== '0'; } catch { return true; } })();

const DIR = () => h('span', { class: 'dir', 'aria-hidden': 'true' }, '▸');
const label = (t: string) => h('span', { class: 'label' }, t);

class IoBar {
  readonly el = h('div', { class: 'controls sb-iobar', role: 'group', 'aria-label': 'Inputs and outputs' });
  private key = '';
  /** Per output pin: how to show its value. */
  private outs: { pin: PinDoc; el: HTMLElement; v?: HTMLElement }[] = [];
  /** Per input-side pin: refresh its control from the simulation / document. */
  private ins: { pin: PinDoc | null; paint(bits: Bit[] | null): void }[] = [];
  private held: PinDoc | null = null;
  /** A nested key held from the bar (released on up, or when the bar goes). */
  private heldKey: string | null = null;
  /** Nested banks past IOBAR_BANKS shown (per editor, this session). */
  private allBanks = false;

  constructor(private ed: Editor) {
    ed.slots.bottom.append(this.el);
    this.update();
  }

  get visible(): boolean {
    return wanted && (this.ed.doc.pins.length > 0 || nestedControls(this.ed.sim.sim).length > 0);
  }

  /** After every repaint: rebuild when the pins changed, else refresh the values. */
  update(): void {
    const doc = this.ed.doc;
    this.el.hidden = !this.visible;
    if (this.el.hidden) { this.key = ''; return; }
    const key = JSON.stringify([this.ed.chipId, doc.pins.map((p) => [p.id, p.name, p.dir, p.width, p.kind ?? '', p.at]), this.simSerial(), this.allBanks]);
    if (key !== this.key) {
      this.key = key;
      this.build(doc);
    }
    this.paint();
  }

  private build(doc: ChipDoc): void {
    this.el.replaceChildren();
    this.ins = [];
    this.outs = [];
    const { left, right } = pinOrder(doc);
    const data = left.filter((p) => p.kind !== 'clock');
    const clocks = left.filter((p) => p.kind === 'clock');
    if (data.length) this.el.append(label('Inputs'), ...data.map((p) => this.input(p)));
    if (right.length) {
      this.el.append(h('span', { class: 'ctl-group out-strip' }, label('Outputs'), right.map((p) => this.output(p))));
    }
    if (clocks.length) this.el.append(label('Clock'), ...clocks.map((p) => this.clock(p)));
    this.nested(nestedControls(this.ed.sim.sim));
  }

  /** A number per simulation, so a rebuild (new nodes) rebuilds the nested controls. */
  private sims = new WeakMap<object, number>();
  private simSerial(): number {
    const sim = this.ed.sim.sim;
    if (!sim) return 0;
    if (!this.sims.has(sim)) this.sims.set(sim, nextSim++);
    return this.sims.get(sim)!;
  }

  private nested(all: NestedControl[]): void {
    const banks = all.filter((c) => c.kind === 'switches');
    const keys = all.filter((c) => c.kind === 'key');
    if (!banks.length && !keys.length) return;
    const shown = this.allBanks ? banks : banks.slice(0, IOBAR_BANKS);
    const group = h('span', { class: 'ctl-group sb-io-nested' }, label('Inside'), shown.map((c) => this.bank(c)));
    if (banks.length > IOBAR_BANKS) {
      group.append(h('button', { class: 'btn ghost sm', title: this.allBanks ? 'Show fewer switch banks' : 'Show every switch bank inside', onclick: () => { this.allBanks = !this.allBanks; this.update(); } },
        this.allBanks ? 'fewer' : `+${banks.length - IOBAR_BANKS} more`));
    }
    group.append(...keys.map((c) => this.key1(c)));
    this.el.append(group);
  }

  /** A nested switch bank: its path, a toggle per switch (the most significant first), its value. */
  private bank(c: Extract<NestedControl, { kind: 'switches' }>): HTMLElement {
    const ed = this.ed;
    const btns = Array.from({ length: c.width }, (_, i) => {
      const bit = c.width - 1 - i;
      return h('button', { class: 'bank-sw', role: 'switch', 'aria-checked': 'false', title: `${controlPath(c)}: switch ${bit}`, onclick: () => flipBank(ed.sim, c, bit) }, h('span', { class: 'knob' }));
    });
    const v = h('span', { class: 'bank-v' });
    let last = -1;
    this.ins.push({ pin: null, paint: () => {
      const val = bankValue(ed.sim.sim, c);
      if (val === last) return;
      last = val;
      btns.forEach((b, i) => { const on = Math.floor(val / 2 ** (c.width - 1 - i)) % 2 === 1; b.classList.toggle('v1', on); b.setAttribute('aria-checked', String(on)); });
      v.textContent = formatBits(Array.from({ length: c.width }, (_, i) => (Math.floor(val / 2 ** i) % 2 ? B1 : B0)), ed.view.radix);
    } });
    return h('span', { class: 'in-num in-bank', title: `${controlPath(c)} (a switch bank inside: click a switch to flip it)` }, DIR(), controlPath(c), h('span', { class: 'bank-row' }, btns), v);
  }

  /** A nested key: held while pressed, like its keyboard key. */
  private key1(c: Extract<NestedControl, { kind: 'key' }>): HTMLElement {
    const ed = this.ed;
    const el = h('button', { class: 'in-toggle in-button', title: `${controlPath(c)}: key ${c.label} (held while pressed; or the key itself)` },
      DIR(), h('span', { class: 'track' }, h('span', { class: 'knob' })), c.label) as HTMLButtonElement;
    const up = () => { if (this.heldKey) { ed.sim.setKey(this.heldKey, false); this.heldKey = null; } };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch { /* a synthetic press */ }
      this.heldKey = c.bind;
      ed.sim.setKey(c.bind, true);
    });
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    this.ins.push({ pin: null, paint: () => el.classList.toggle('v1', ed.sim.keyHeld(c.bind)) });
    return el;
  }

  private input(p: PinDoc): HTMLElement {
    const ed = this.ed;
    if (p.dir === 'inout') {
      // Driven Z → 0 → all ones → Z, as a click on the pin (switch level only).
      const v = h('button', { class: 'sb-io-v', title: 'Drive Z, 0 or 1 (as a click on the pin)', onclick: () => ed.setPinValue(p.id, nextDrive(cur(ed, p))) });
      this.ins.push({ pin: p, paint: () => { const q = cur(ed, p); v.textContent = q.value === undefined ? 'Z' : formatBits(bitsOf(q), ed.view.radix); } });
      return h('span', { class: 'in-num', title: `${p.name} (bidirectional)` }, DIR(), p.name, v);
    }
    if (p.kind === 'button') {
      // Held: 1 while pressed, like the pin.
      const el = h('button', { class: 'in-toggle in-button', title: `${p.name} (button: 1 while held)` },
        DIR(), h('span', { class: 'track' }, h('span', { class: 'knob' })), p.name) as HTMLButtonElement;
      const up = () => { if (this.held) { ed.sim.setInput(this.held, 0); this.held = null; } };
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        try { el.setPointerCapture(e.pointerId); } catch { /* a synthetic press: no capture, release on up */ }
        this.held = p;
        ed.sim.setInput(p, 1);
      });
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      this.ins.push({ pin: p, paint: (b) => el.classList.toggle('v1', b?.[0] === B1) });
      return el;
    }
    if (p.width === 1) {
      const el = h('button', { class: 'in-toggle', role: 'switch', 'aria-checked': 'false', title: `Toggle ${p.name} (input)`,
        onclick: () => { const q = cur(ed, p); ed.setPinValue(p.id, q.value ? 0 : 1); } },
      DIR(), h('span', { class: 'track' }, h('span', { class: 'knob' })), p.name);
      // What the simulation is driven with (the test player drives it without the document).
      this.ins.push({ pin: p, paint: (b) => { const on = b ? b[0] === B1 : !!cur(ed, p).value; el.classList.toggle('v1', on); el.setAttribute('aria-checked', String(on)); } });
      return el;
    }
    // A bus: its value (click to edit the bits), −1 / +1, exact at any width.
    const m = (1n << BigInt(p.width)) - 1n;
    const bump = (d: bigint) => { const q = cur(ed, p); ed.setPinValue(p.id, pinValue((pinBig(q.value) + d) & m)); };
    const v = h('button', { class: 'sb-io-v', title: 'Edit the value' }) as HTMLButtonElement;
    v.addEventListener('click', () => { const q = cur(ed, p); editNumber(v.getBoundingClientRect(), q.name, q.width, pinBig(q.value), (n) => ed.setPinValue(q.id, pinValue(n))); });
    this.ins.push({ pin: p, paint: (b) => { v.textContent = formatBits(b && b.length === p.width ? b : bitsOf(cur(ed, p)), ed.view.radix); } });
    return h('span', { class: 'in-num', title: `${p.name} (input)` }, DIR(), p.name,
      h('button', { title: '−1', onclick: () => bump(m) }, '−'), v, h('button', { title: '+1', onclick: () => bump(1n) }, '+'));
  }

  private clock(p: PinDoc): HTMLElement {
    const el = h('button', { class: 'in-toggle', title: `${p.name}: the next clock half period (as a click on the pin)`, onclick: () => this.ed.sim.toggleClocks() },
      DIR(), h('span', { class: 'track' }, h('span', { class: 'knob' })), p.name);
    this.ins.push({ pin: p, paint: (b) => el.classList.toggle('v1', b?.[0] === B1) });
    return el;
  }

  private output(p: PinDoc): HTMLElement {
    if (p.width === 1) {
      const el = h('span', { class: 'out-lamp', title: `${p.name} (output)` }, h('span', { class: 'knob' }), p.name, DIR());
      this.outs.push({ pin: p, el });
      return el;
    }
    const v = h('span', { class: 'v' });
    const el = h('span', { class: 'out-num', title: `${p.name} (output)` }, p.name, v, DIR());
    this.outs.push({ pin: p, el, v });
    return el;
  }

  private paint(): void {
    const sim = this.ed.sim;
    for (const c of this.ins) c.paint(c.pin ? sim.pinBits(c.pin.name) : null);
    for (const o of this.outs) {
      const bits = sim.pinBits(o.pin.name);
      const z = !!bits && bits.every((b) => b === BZ), x = !bits || (!z && bits.some((b) => b !== B0 && b !== B1));
      o.el.classList.toggle('vx', x && !!bits);
      o.el.classList.toggle('vz', z);
      if (o.v) o.v.textContent = bits ? formatBits(bits, this.ed.view.radix) : '–';
      else o.el.classList.toggle('v1', bits?.[0] === B1);
    }
  }

  destroy(): void {
    if (this.held) this.ed.sim.setInput(this.held, 0);
    if (this.heldKey) this.ed.sim.setKey(this.heldKey, false);
    closePopover();
    this.el.remove();
  }
}

/** The pin as the document holds it now (a control built earlier must not act on a stale copy). */
const cur = (ed: Editor, p: PinDoc): PinDoc => ed.doc.pins.find((q) => q.id === p.id) ?? p;
const bitsOf = (p: PinDoc): Bit[] => Array.from({ length: p.width }, (_, i) => ((pinBig(p.value) >> BigInt(i)) & 1n ? B1 : B0));

let nextSim = 1;
const bars = new WeakMap<Editor, IoBar>();

registerEditorPlugin((ed) => {
  const bar = new IoBar(ed);
  bars.set(ed, bar);
  const paint = () => bar.update();
  ed.paintHooks.add(paint);
  return () => {
    ed.paintHooks.delete(paint);
    bar.destroy();
    bars.delete(ed);
  };
});

registerToolbarAction({
  id: 'iobar', title: 'Inputs and outputs bar: the chip\'s pins above the run bar', icon: 'io', label: 'I/O', order: 59,
  run: (ed) => {
    wanted = !wanted;
    try { localStorage.setItem(PREF, wanted ? '1' : '0'); } catch { /* per session only */ }
    bars.get(ed)?.update();
    ed.renderActions();
  },
  active: () => wanted,
});
