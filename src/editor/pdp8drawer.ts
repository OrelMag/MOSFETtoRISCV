// The CPU drawer's front panel for a PDP-8 in gates (editor/pdp8mon.ts): the lamps read the processor's own registers
// (PC, MA, MB, AC with L, MQ, IR, the major state, RUN, ION), the switch register is the instruction builder on its
// toggles, in octal groups as DEC coloured them, and drives the SR pin; each key drives its pin for one rising edge (the
// processor acts on a key's first edge). The look of the panel the model runs behind (pdp8panel.ts), sized for a drawer.

import '../styles/pdp8.css';
import { oct4 } from '../pdp8/pdp8';
import { h } from '../ui/dom';
import { type Pdp8Key, type Pdp8Read, pdp8StateName } from './pdp8mon';

const KEY_LABEL: [Pdp8Key, string, string][] = [
  ['ld', 'LOAD ADD', 'PC ← the switch register'],
  ['start', 'START', 'Clear AC, L, MQ and the flags, then run from PC'],
  ['dep', 'DEP', 'Core at PC ← the switch register, then PC + 1'],
  ['exam', 'EXAM', 'MB ← core at PC, then PC + 1'],
  ['cont', 'CONT', 'Run on from PC, nothing cleared'],
  ['stop', 'STOP', 'Stop at the end of the instruction under way'],
  ['sstep', 'SING INST', 'One instruction, then stop (the real panel’s SING INST switch with CONT; its SING STEP was one memory cycle)'],
];

export interface Pdp8PanelHooks {
  /** Drive a key's pin for one rising edge. */
  press(k: Pdp8Key): void;
  /** Set the SR pin. */
  setSr(v: number): void;
}

export class Pdp8DrawerPanel {
  readonly el: HTMLElement;
  private rows: Record<string, { set(v: number): void }>;
  private link = h('span', { class: 'p8-lamp', title: 'L, the link' });
  private lamps = { run: h('span', { class: 'p8-lamp' }), ion: h('span', { class: 'p8-lamp' }), f: h('span', { class: 'p8-lamp' }), d: h('span', { class: 'p8-lamp' }), e: h('span', { class: 'p8-lamp' }) };
  private keyBtns = new Map<Pdp8Key, HTMLButtonElement>();
  private sw: HTMLButtonElement[] = [];
  private srVal = h('code', { class: 'p8-val' });
  private srShown = -1;
  private srBox: HTMLElement;

  constructor(hooks: Pdp8PanelHooks) {
    const lampRow = (label: string, bits: number, extra?: HTMLElement) => {
      const lamps = Array.from({ length: bits }, () => h('span', { class: 'p8-lamp' }));
      const val = h('code', { class: 'p8-val' });
      const groups: HTMLElement[] = [];
      for (let g = 0; g < bits; g += 3) groups.push(h('span', { class: 'p8-grp' }, lamps.slice(g, g + 3)));
      const el = h('div', { class: 'p8-row' }, h('span', { class: 'p8-name' }, label), extra ?? h('span', { class: 'p8-l' }), h('span', { class: 'p8-lamps' }, groups), val);
      return {
        el,
        set(v: number) {
          lamps.forEach((l, i) => l.classList.toggle('on', v >= 0 && !!((v >> (bits - 1 - i)) & 1)));
          val.textContent = v < 0 ? '????' : bits === 3 ? String(v) : oct4(v);
        },
      };
    };
    const rows = {
      pc: lampRow('PC', 12), ma: lampRow('MA', 12), mb: lampRow('MB', 12),
      ac: lampRow('AC', 12, h('span', { class: 'p8-l' }, this.link, h('small', null, 'L'))), mq: lampRow('MQ', 12), ir: lampRow('IR', 3),
    };
    this.rows = rows;
    const L = this.lamps;
    const state = h('div', { class: 'p8-state', title: 'The major state the next edge ends (one edge per memory cycle), and the RUN and ION flip-flops' },
      h('span', null, L.f, 'FETCH'), h('span', null, L.d, 'DEFER'), h('span', null, L.e, 'EXECUTE'), h('span', null, L.run, 'RUN'), h('span', null, L.ion, 'ION'));
    // the switch register: twelve toggles, bit 0 (DEC's most significant) on the left
    this.sw = Array.from({ length: 12 }, (_, i) => h('button', {
      type: 'button', class: 'p8-sw', 'aria-pressed': 'false', 'aria-label': `switch ${i}`,
      onclick: () => { if (this.srShown >= 0) hooks.setSr(this.srShown ^ (1 << (11 - i))); },
    }) as HTMLButtonElement);
    const swGroups: HTMLElement[] = [];
    for (let g = 0; g < 12; g += 3) swGroups.push(h('span', { class: 'p8-grp' }, this.sw.slice(g, g + 3)));
    this.srBox = h('div', { class: 'p8-row p8-srrow', title: 'The switch register: LOAD ADD and DEP take it; OSR ORs it into AC' }, h('span', { class: 'p8-name' }, 'SR'), h('span', { class: 'p8-l' }), h('span', { class: 'p8-lamps' }, swGroups), this.srVal);
    const keys = h('div', { class: 'p8-keys' }, KEY_LABEL.map(([k, label, title]) => {
      const b = h('button', { type: 'button', class: 'btn sm p8-key', title, onclick: () => hooks.press(k) }, label) as HTMLButtonElement;
      this.keyBtns.set(k, b);
      return b;
    }));
    this.el = h('div', { class: 'p8-drawer' },
      h('div', { class: 'p8-panel', role: 'group', 'aria-label': 'Front panel lamps: the processor\'s registers' }, h('div', { class: 'p8-regs' }, Object.values(rows).map((r) => r.el)), state),
      h('div', { class: 'p8-panel p8-srpanel' }, this.srBox, keys));
  }

  update(r: Pdp8Read | null, sr: number | null, wired: Partial<Record<Pdp8Key, string>>, srWired: boolean): void {
    for (const k of ['pc', 'ma', 'mb', 'ac', 'mq', 'ir'] as const) this.rows[k].set(r ? r[k] : -1);
    this.link.classList.toggle('on', r?.l === 1);
    const L = this.lamps;
    L.run.classList.toggle('on', r?.run === 1);
    L.ion.classList.toggle('on', r?.ie === 1);
    L.f.classList.toggle('on', r?.state === 0);
    L.d.classList.toggle('on', r?.state === 1);
    L.e.classList.toggle('on', r?.state === 2);
    L.f.title = L.d.title = L.e.title = r ? pdp8StateName(r.state) : '';
    for (const [k, b] of this.keyBtns) {
      b.disabled = !wired[k];
      if (!wired[k]) b.title = 'No input pin drives this key\'s port of the processor';
    }
    this.srBox.toggleAttribute('inert', !srWired);
    const v = sr !== null && sr >= 0 ? sr : -1;
    if (v !== this.srShown) {
      this.srShown = v;
      this.sw.forEach((b, i) => { const on = v >= 0 && !!((v >> (11 - i)) & 1); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
      this.srVal.textContent = v < 0 ? (srWired ? '????' : 'no pin') : oct4(v);
    }
  }
}
