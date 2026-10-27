// The breadboard view: a scene drawn as the hardware is built (Scene.breadboard, view/bblayout.ts), over the stage's
// own simulation. Every LED, switch, digit, bus wire and active ring is a net of that simulation, read in one call per
// repaint (BbNets) and painted only where it changed. A chip is a button: hover or focus shows its card (part, role,
// what is inside, its cost), a click selects it (the inspector shows it), a double-click or Enter opens its schematic
// (the stage's drill path), where pinCard lists its DIP pins live. The SVG's viewBox is the whole layout, so it
// scales to any canvas (a phone too) without scrolling.

import '../styles/breadboard.css';
import { findNode, type HierNode } from '../sim/flatten';
import type { Sim } from '../sim/sim';
import { stats } from '../sim/stats';
import { B0, B1, type Bit, type ComponentDef, netlistOf } from '../sim/types';
import { formatBits, type Radix } from '../sim/values';
import { h, s } from '../ui/dom';
import {
  BB, type BbBoard, type BbBus, type BbChip, type BbNet, BbNets, type BbPin, type Box, type BreadboardLayout, HEX_SEGMENTS, layoutBounds,
  packBits, pinName, pinSides, planBoard, stubOf,
} from './bblayout';

export interface BreadboardHooks {
  /** Flip bit `bit` of the root's input `port` (a DIP switch). */
  toggle(port: string, bit: number): void;
  /** The root input's value now. */
  input(port: string): number;
  /** Open this instance's schematic. */
  open(path: string[]): void;
  /** A chip was selected (null: none): the inspector follows. */
  select(chip: BbChip | null): void;
}

/** 'built': jumpers in their wire colours (the bus's yellow brighter where a bit is 1); 'value': the site's wire colours by value. */
export type WireLook = 'built' | 'value';

const vOf = (b: Bit | undefined) => (b === B1 ? '1' : b === B0 ? '0' : 'x');

/** Segment boxes of a digit 2.1 × 3.4 holes (a…g), and dp. */
const SEG: [number, number, number, number][] = [
  [0.32, 0, 1.47, 0.3], [1.79, 0.32, 0.3, 1.26], [1.79, 1.79, 0.3, 1.26], [0.32, 3.05, 1.47, 0.3], [0, 1.79, 0.3, 1.26], [0, 0.32, 0.3, 1.26], [0.32, 1.53, 1.47, 0.3],
];

let uid = 0;

export class BreadboardView {
  readonly el: HTMLElement;
  private svg: SVGSVGElement;
  private caption: HTMLElement;
  private card: HTMLElement;
  private nets: BbNets | null = null;
  private root: HierNode | null = null;
  private paints: ((bits: Bit[]) => void)[] = [];
  /** The chip whose card is shown (pinned: clicked, it stays until another click or Esc). */
  private carded: { chip: BbChip; el: SVGGElement; live: HTMLElement | null } | null = null;
  private pinned = false;
  private chipEls = new Map<BbChip, SVGGElement>();
  /** What highlight() can light: a board by its module, a bus strip by its path, a chip by its path or a prefix of it
   *  (unless its board is lit already: 'flags' lights the flag chips on the ALU's board). */
  private lightable: { key: string; el: SVGGElement; chip?: { prefixes: string[]; board: SVGGElement } }[] = [];
  selected: BbChip | null = null;
  radix: Radix = 'hex';
  private last: Bit[] = [];

  constructor(private readonly hooks: BreadboardHooks) {
    this.svg = s('svg', { class: 'breadboard', role: 'group', 'aria-label': 'Breadboards' });
    this.caption = h('div', { class: 'bb-caption' });
    this.card = h('div', { class: 'bb-card', role: 'tooltip', hidden: true });
    this.el = h('div', { class: 'bb-host', hidden: true }, this.caption, this.svg, this.card);
    this.svg.addEventListener('pointerdown', (e) => {
      if (!(e.target as Element).closest('.bb-chip')) this.pick(null);
    });
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && (this.pinned || this.selected)) {
        e.stopPropagation();
        this.pick(null);
      }
    });
  }

  /** The look of the jumpers (the stage's Wires as built | By value). */
  set wires(w: WireLook) {
    this.svg.dataset.wires = w;
  }

  clear(): void {
    this.svg.replaceChildren();
    this.paints = [];
    this.nets = null;
    this.root = null;
    this.chipEls.clear();
    this.lightable = [];
    this.switches = [];
    this.selected = null;
    this.hideCard(true);
  }

  /** Draw `layout` over a flattened design's root (Stage.sim.design.root), whose simulation update() then reads. */
  show(layout: BreadboardLayout, root: HierNode): void {
    this.clear();
    this.root = root;
    const nets = this.nets = new BbNets(root);
    const id = `bb${++uid}`;
    const { w, h: H } = layoutBounds(layout);
    const M = 2;
    this.svg.setAttribute('viewBox', `${-M} ${-M} ${w + 2 * M} ${H + 2 * M}`);
    this.svg.append(s('defs', null,
      s('pattern', { id: `${id}-holes`, width: 1, height: 1, patternUnits: 'userSpaceOnUse' }, s('circle', { class: 'bb-hole', cx: 0.5, cy: 0.5, r: 0.15 })),
      s('pattern', { id: `${id}-ribbon`, width: 1, height: 0.55, patternUnits: 'userSpaceOnUse' }, s('rect', { class: 'bb-ribbon', x: 0, y: 0, width: 1, height: 0.27 })),
      s('filter', { id: `${id}-glow`, x: '-1', y: '-1', width: '3', height: '3' }, s('feGaussianBlur', { stdDeviation: 0.32 }))));
    const ctx = { id, nets };
    const buses = new Map((layout.buses ?? []).map((b) => [b.id, b]));
    // the ribbons under the boards, then the strips, then the boards
    for (const b of layout.boards) {
      const bus = b.bus !== undefined ? buses.get(b.bus) : undefined;
      const st = bus && stubOf(b, bus);
      if (st) this.svg.append(s('rect', { class: 'bb-stub', x: st.x, y: st.y, width: st.w, height: st.h, fill: `url(#${id}-ribbon)` }));
    }
    for (const b of layout.buses ?? []) {
      const g = this.drawBus(b, ctx);
      this.lightable.push({ key: b.path.join('.'), el: g });
      this.svg.append(g);
    }
    for (const b of layout.boards) {
      const g = this.drawBoard(b, ctx);
      if (b.module) this.lightable.push({ key: b.module.join('.'), el: g });
      this.svg.append(g);
      for (const c of b.chips) {
        const el = this.chipEls.get(c);
        if (!c.path || !el) continue;
        const prefixes = c.path.map((_, i) => c.path!.slice(0, i + 1).join('.'));
        this.lightable.push({ key: c.path.join('.'), el, chip: { prefixes, board: g } });
      }
    }
    const ics = layout.boards.reduce((n, b) => n + b.chips.length, 0);
    this.caption.textContent = `${layout.note ?? `${ics} chips`} · every LED is a net of the same simulation`;
    this.last = [];
  }

  /** Light the boards, bus strips and chips named by instance paths from the root ('a', 'ctl.romhi'); [] clears. */
  highlight(names: readonly string[]): void {
    const on = new Set(names);
    for (const { key, el, chip } of this.lightable) if (!chip) el.classList.toggle('hl', on.has(key));
    for (const { el, chip } of this.lightable) if (chip) el.classList.toggle('hl', !chip.board.classList.contains('hl') && chip.prefixes.some((p) => on.has(p)));
  }

  /** Repaint from the simulation: only the elements whose bits changed. */
  update(sim: Sim | null): void {
    if (!sim || !this.nets) return;
    const bits = this.nets.read(sim);
    const last = this.last;
    let same = last.length === bits.length;
    for (let i = 0; same && i < bits.length; i++) same = bits[i] === last[i];
    if (!same) {
      for (const p of this.paints) p(bits);
      this.last = bits;
    }
    if (this.carded?.live) this.paintLive(this.carded.chip, this.carded.live, sim);
    this.paintSwitches();
  }

  // ---- drawing ----

  private drawBoard(b: BbBoard, ctx: { id: string; nets: BbNets }): SVGGElement {
    const [W, H] = b.size;
    const plan = planBoard(b);
    const g = s('g', { class: 'bb-board', transform: `translate(${b.at[0]} ${b.at[1]})` });
    const ring = s('rect', { class: 'bb-ring', x: -0.35, y: -0.35, width: W + 0.7, height: H + 0.7, rx: 0.9 });
    g.append(ring,
      s('rect', { class: 'bb-base', width: W, height: H, rx: 0.6 }),
      s('rect', { x: 0.6, y: 1.9, width: W - 1.2, height: H - 3.8, fill: `url(#${ctx.id}-holes)` }),
      s('line', { class: 'bb-rail pos', x1: 1, x2: W - 1, y1: 0.7, y2: 0.7 }),
      s('line', { class: 'bb-rail neg', x1: 1, x2: W - 1, y1: 1.3, y2: 1.3 }),
      s('line', { class: 'bb-rail neg', x1: 1, x2: W - 1, y1: H - 1.3, y2: H - 1.3 }),
      s('line', { class: 'bb-rail pos', x1: 1, x2: W - 1, y1: H - 0.7, y2: H - 0.7 }));
    const title = s('text', { class: 'bb-title', x: 1.4, y: 3 }, b.title.toUpperCase());
    if (b.module) {
      const mod = b.module;
      const t = s('g', { class: 'bb-open', role: 'button', tabindex: 0, 'aria-label': `${b.title}: open its schematic` }, title);
      t.addEventListener('dblclick', () => this.hooks.open(mod));
      t.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.hooks.open(mod);
        }
      });
      g.append(t);
    } else g.append(title);
    b.chips.forEach((c, i) => g.append(this.drawChip(c, plan.chips[i], b)));
    (b.beside ?? []).forEach((l, i) => g.append(this.drawLed(l.net, l.color ?? 'red', l.label, plan.beside[i], ctx)));
    (b.switches ?? []).forEach((sw, i) => g.append(this.drawSwitch(sw.port, sw.bit ?? 0, sw.label, plan.switches[i])));
    (b.leds ?? []).forEach((l, i) => g.append(this.drawLed(l.net, l.color ?? 'red', l.label, plan.leds[i], ctx)));
    if (plan.window) g.append(s('rect', { class: 'bb-segwin', x: plan.window.x, y: plan.window.y, width: plan.window.w, height: plan.window.h, rx: 0.3 }));
    (b.digits ?? []).forEach((d, i) => g.append(this.drawDigit(d, plan.digits[i], ctx)));
    // driving / loading: a ring and a pill
    if (b.drives || b.loads) {
      const pill = s('g', { class: 'bb-pill' });
      const ptext = s('text', { y: 0.4 });
      const prect = s('rect', { y: -1.1, height: 2.2, rx: 1.1 });
      pill.append(prect, ptext);
      g.append(pill);
      const dr = b.drives ? ctx.nets.net(b.drives) : -1, ld = b.loads ? ctx.nets.net(b.loads) : -1;
      let shown = '';
      this.paints.push((bits) => {
        const act = dr >= 0 && bits[dr] === B1 ? 'drive' : ld >= 0 && bits[ld] === B1 ? 'load' : '';
        if (act === shown) return;
        shown = act;
        g.dataset.act = act;
        const a = act === 'drive' ? b.drives : act === 'load' ? b.loads : undefined;
        const label = a ? a.label ?? (act === 'drive' ? 'drives the bus' : 'loads at the next edge') : '';
        ptext.textContent = label;
        const pw = label.length * 0.66 + 2;
        prect.setAttribute('width', String(pw));
        prect.setAttribute('x', String(W - 1 - pw));
        ptext.setAttribute('x', String(W - 1 - pw / 2));
        g.setAttribute('aria-label', a ? `${b.title}: ${label}` : b.title);
      });
    }
    g.setAttribute('aria-label', b.title);
    g.setAttribute('role', 'group');
    return g;
  }

  private drawChip(c: BbChip, r: Box, board: BbBoard): SVGGElement {
    const n = c.dip / 2;
    const name = `${c.ref ? `${c.ref}, ` : ''}${c.part}`;
    const g = s('g', {
      class: `bb-chip${c.path ? '' : ' drawn'}`, transform: `translate(${r.x} ${r.y})`, role: 'button', tabindex: 0,
      'aria-label': c.path ? `${name} on ${board.title}: Enter opens it, Space selects it` : `${name} on ${board.title} (drawn, not simulated)`,
    });
    g.append(s('rect', { class: 'bb-sel', x: -0.7, y: -1, width: r.w + 1.4, height: r.h + 2, rx: 0.4 }));
    for (let i = 0; i < n; i++) {
      g.append(s('rect', { class: 'bb-leg', x: i + 0.3, y: -0.5, width: 0.4, height: 0.5 }),
        s('rect', { class: 'bb-leg', x: i + 0.3, y: r.h, width: 0.4, height: 0.5 }));
    }
    g.append(s('rect', { class: 'bb-body', width: r.w, height: r.h, rx: 0.18 }),
      s('path', { class: 'bb-notch', d: `M0 ${r.h / 2 - 0.5} A0.5 0.5 0 0 1 0 ${r.h / 2 + 0.5} Z` }));
    const fs = Math.min(1.25, (r.w - 0.6) / (c.part.length * 0.62));
    g.append(s('text', { class: 'bb-part', x: r.w / 2, y: r.h / 2 + (c.ref ? 0 : 0.4), 'font-size': fs }, c.part));
    if (c.ref) g.append(s('text', { class: 'bb-ref', x: r.w / 2, y: r.h / 2 + 1.15, 'font-size': Math.min(0.95, fs) }, c.ref));
    g.addEventListener('pointerenter', () => this.showCard(c, g));
    g.addEventListener('pointerleave', () => this.hideCard());
    g.addEventListener('focus', () => this.showCard(c, g));
    g.addEventListener('blur', () => this.hideCard());
    g.addEventListener('click', () => this.pick(c));
    g.addEventListener('dblclick', () => c.path && this.hooks.open(c.path));
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (c.path) this.hooks.open(c.path);
      } else if (e.key === ' ') {
        e.preventDefault();
        this.pick(this.selected === c ? null : c);
      }
    });
    this.chipEls.set(c, g);
    return g;
  }

  private drawLed(net: BbNet, color: string, label: string | undefined, r: Box, ctx: { id: string; nets: BbNets }): SVGGElement {
    const i = ctx.nets.net(net);
    const cx = r.w / 2, cy = BB.led / 2;
    const what = `${label ? `${label}: ` : ''}${[...net.path, net.port].join('.')}${net.bit !== undefined ? `[${net.bit}]` : ''}`;
    const g = s('g', { class: `bb-led c-${color}`, transform: `translate(${r.x} ${r.y})`, 'data-v': 'x', role: 'img', 'aria-label': `${what} unknown` },
      s('title', null, what),
      s('circle', { class: 'halo', cx, cy, r: 0.95, filter: `url(#${ctx.id}-glow)` }),
      s('circle', { class: 'lens', cx, cy, r: 0.55 }));
    if (label) g.append(s('text', { class: 'bb-ll', x: cx, y: r.h - 0.12 }, label));
    let shown = '';
    this.paints.push((bits) => {
      const v = vOf(bits[i]);
      if (v === shown) return;
      shown = v;
      g.dataset.v = v;
      g.setAttribute('aria-label', `${what} ${v === 'x' ? 'unknown' : v === '1' ? 'on' : 'off'}`);
    });
    return g;
  }

  private switches: { g: SVGGElement; port: string; bit: number; on: boolean | null; what: string }[] = [];

  private drawSwitch(port: string, bit: number, label: string | undefined, r: Box): SVGGElement {
    const x = (r.w - BB.sw) / 2;
    const what = `${label ?? port}${label ? '' : `[${bit}]`}`;
    const g = s('g', { class: 'bb-sw', transform: `translate(${r.x} ${r.y})`, role: 'button', tabindex: 0, 'aria-pressed': 'false', 'aria-label': `Switch ${what}` },
      s('title', null, `Switch ${what}: click to flip`),
      // a finger's target: the bank's switches are a hole wide
      s('rect', { class: 'hit', x: 0, y: -0.6, width: r.w, height: r.h + 1.2 }),
      s('rect', { class: 'body', x, width: BB.sw, height: 1.8 }),
      s('rect', { class: 'knob', x: x + 0.3, y: 0.95, width: BB.sw - 0.6, height: 0.6 }));
    if (label) g.append(s('text', { class: 'bb-ll', x: r.w / 2, y: r.h - 0.12 }, label));
    const flip = () => this.hooks.toggle(port, bit);
    g.addEventListener('click', flip);
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        flip();
      }
    });
    this.switches.push({ g, port, bit, on: null, what });
    return g;
  }

  private paintSwitches(): void {
    for (const sw of this.switches) {
      if (!sw.g.isConnected) continue;
      const on = ((this.hooks.input(sw.port) >> sw.bit) & 1) === 1;
      if (on === sw.on) continue;
      sw.on = on;
      sw.g.classList.toggle('on', on);
      sw.g.setAttribute('aria-pressed', String(on));
      sw.g.querySelector('.knob')!.setAttribute('y', on ? '0.25' : '0.95');
    }
  }

  private drawDigit(d: { path: string[]; port: string; bit?: number; hex?: boolean }, r: Box, ctx: { id: string; nets: BbNets }): SVGGElement {
    const idx = ctx.nets.bus(d, d.hex ? 4 : 8);
    const g = s('g', { class: 'bb-digit', transform: `translate(${r.x + 0.25} ${r.y}) skewX(-6)`, role: 'img', 'aria-label': 'digit' });
    const segs = SEG.map(([x, y, w, hh]) => s('rect', { class: 'seg', x, y, width: w, height: hh, rx: 0.1 }));
    const dp = s('circle', { class: 'seg', cx: 2.3, cy: 3.2, r: 0.17 });
    g.append(...segs, dp);
    let shown = -2;
    this.paints.push((bits) => {
      const v = packBits(idx.map((i) => bits[i]));
      const on = v < 0 ? -1 : d.hex ? HEX_SEGMENTS[v] : v;
      if (on === shown) return;
      shown = on;
      [...segs, dp].forEach((e, k) => e.classList.toggle('on', on >= 0 && ((on >> k) & 1) === 1));
      g.classList.toggle('vx', on < 0);
      g.setAttribute('aria-label', on < 0 ? 'digit: unknown' : d.hex ? `digit ${v.toString(16).toUpperCase()}` : `digit: segments ${on.toString(2).padStart(8, '0')}`);
    });
    return g;
  }

  private drawBus(b: BbBus, ctx: { id: string; nets: BbNets }): SVGGElement {
    const node = this.root && findNode(this.root, b.path);
    const n = node?.ports[b.port]?.length ?? 1;
    const idx = ctx.nets.bus(b, n);
    const [W, H] = b.size;
    const g = s('g', { class: 'bb-bus', transform: `translate(${b.at[0]} ${b.at[1]})`, role: 'group', 'aria-label': `${b.title ?? 'Bus'} strip` });
    // the jumpers, MSB on the left
    const pitch = Math.min(BB.busPitch, (W - 1) / n);
    const x0 = W / 2 - (pitch * (n - 1)) / 2;
    const wires: SVGLineElement[] = [];
    for (let k = 0; k < n; k++) {
      const x = x0 + (n - 1 - k) * pitch;
      wires.push(s('line', { class: 'bb-wire', x1: x, x2: x, y1: BB.busHead, y2: H, 'data-v': 'x' }));
    }
    g.append(...wires);
    // the head: a small board with an LED per bit and the value
    const rows = n <= 4 ? 1 : 2, per = Math.ceil(n / rows);
    const lp = Math.min(1.6, (W - 1.6) / per);
    g.append(s('rect', { class: 'bb-base', width: W, height: BB.busHead, rx: 0.6 }),
      s('line', { class: 'bb-rail pos', x1: 0.8, x2: W - 0.8, y1: 0.7, y2: 0.7 }),
      s('text', { class: 'bb-title', x: 1, y: 2.4 }, (b.title ?? 'Bus').toUpperCase()));
    const leds: SVGGElement[] = [];
    for (let k = 0; k < n; k++) {
      const row = Math.floor(k / per), col = k % per;
      const cx = W / 2 - (lp * (per - 1)) / 2 + col * lp, cy = 3.4 + row * 1.25;
      const led = s('g', { class: 'bb-led c-yellow', 'data-v': 'x' },
        s('circle', { class: 'halo', cx, cy, r: 0.8, filter: `url(#${ctx.id}-glow)` }), s('circle', { class: 'lens', cx, cy, r: 0.45 }));
      leds.push(led);
    }
    g.append(...leds);
    const val = s('text', { class: 'bb-val', x: W / 2, y: BB.busHead - 0.55 });
    g.append(val);
    let shown = '';
    this.paints.push((bits) => {
      const bb = idx.map((i) => bits[i]);
      const key = bb.join('');
      if (key === shown) return;
      shown = key;
      bb.forEach((v, k) => {
        const c = vOf(v);
        wires[k].dataset.v = c;
        leds[n - 1 - k].dataset.v = c;
      });
      const v = packBits(bb);
      val.textContent = v < 0 ? formatBits(bb, 'bin') : n > 4 ? `0x${v.toString(16).toUpperCase().padStart(Math.ceil(n / 4), '0')} = ${v}` : `${v.toString(2).padStart(n, '0')} = ${v}`;
      g.setAttribute('aria-label', `${b.title ?? 'Bus'} strip: ${val.textContent}`);
    });
    return g;
  }

  // ---- the chip card ----

  /** Select a chip (its card stays) or none. */
  private pick(c: BbChip | null): void {
    if (this.selected) this.chipEls.get(this.selected)?.classList.remove('sel');
    this.selected = c;
    this.pinned = !!c;
    if (c) {
      const el = this.chipEls.get(c)!;
      el.classList.add('sel');
      this.showCard(c, el, true);
    } else this.hideCard(true);
    this.hooks.select(c);
  }

  private showCard(c: BbChip, el: SVGGElement, force = false): void {
    if (this.pinned && !force && this.carded?.chip !== c) return;
    const node = c.path && this.root ? findNode(this.root, c.path) : null;
    const def = node?.def;
    const card = this.card;
    card.replaceChildren(
      h('div', { class: 'bb-card-h' }, h('b', null, [c.ref, c.part].filter(Boolean).join(' · ')), def ? h('span', null, def.name) : null),
      ...(c.role ? [h('p', null, c.role)] : []),
      h('p', { class: 'in' }, def ? insideOf(def) : 'Drawn only: not part of the simulation.'),
    );
    let live: HTMLElement | null = null;
    if (def) {
      live = h('p', { class: 'live' });
      card.append(live, h('p', { class: 'foot' }, `${c.path!.join('.')} · double-click or Enter to open`));
    }
    card.hidden = false;
    this.carded = { chip: c, el, live };
    if (live && this.lastSim) this.paintLive(c, live, this.lastSim);
    this.placeCard(el);
  }

  private lastSim: Sim | null = null;

  /** The simulation the view reads (set by the stage before every update). */
  set sim(sim: Sim | null) {
    this.lastSim = sim;
  }

  private placeCard(el: SVGGElement): void {
    const host = this.el.getBoundingClientRect(), r = el.getBoundingClientRect(), card = this.card;
    const cw = card.offsetWidth, ch = card.offsetHeight;
    let x = r.left + r.width / 2 - host.left - cw / 2;
    x = Math.max(8, Math.min(x, host.width - cw - 8));
    let y = r.top - host.top - ch - 10;
    const below = y < 8;
    if (below) y = r.bottom - host.top + 10;
    card.classList.toggle('below', below);
    card.style.left = `${x}px`;
    card.style.top = `${Math.max(8, Math.min(y, host.height - ch - 8))}px`;
    card.style.setProperty('--tip', `${Math.max(12, Math.min(cw - 12, r.left + r.width / 2 - host.left - x))}px`);
  }

  private hideCard(force = false): void {
    if (this.pinned && !force) {
      // back to the pinned chip's card
      if (this.selected && this.carded?.chip !== this.selected) this.showCard(this.selected, this.chipEls.get(this.selected)!, true);
      return;
    }
    this.card.hidden = true;
    this.carded = null;
  }

  private paintLive(c: BbChip, el: HTMLElement, sim: Sim): void {
    const node = c.path && this.root ? findNode(this.root, c.path) : null;
    if (!node) return;
    const outs = node.def.ports.filter((p) => p.dir === 'out').slice(0, 4);
    const txt = outs.map((p) => `${p.name} = ${formatBits(sim.getBits(node.ports[p.name]), p.width === 1 ? 'bin' : this.radix)}`).join(' · ');
    if (el.textContent !== txt) el.textContent = txt;
  }
}

/** "Inside: 4 × D flip-flop, 2 × NOR · 52 NANDs": a definition's parts by kind and its cost. */
export function insideOf(def: ComponentDef): string {
  const nl = netlistOf(def);
  const st = stats(def);
  const cost = st.nands ? `${st.nands.toLocaleString('en-US')} NAND${st.nands === 1 ? '' : 's'}` : st.transistors ? `${st.transistors} transistors` : '';
  if (!nl) return cost ? `A leaf of the simulation · ${cost}` : 'A leaf of the simulation';
  const kinds = new Map<string, number>();
  for (const i of nl.instances) if (i.def.prim !== 'alias') kinds.set(i.def.name, (kinds.get(i.def.name) ?? 0) + 1);
  const list = [...kinds].sort((a, b) => b[1] - a[1]);
  const shown = list.slice(0, 4).map(([k, n]) => `${n} × ${k}`).join(', ') + (list.length > 4 ? `, ${list.length - 4} more kinds` : '');
  return `Inside: ${shown || 'wiring'}${cost ? ` · ${cost}` : ''}`;
}

/**
 * A chip's DIP pins, live (shown while the chip is open on the schematic): pins 1 … n/2 down the left side, the rest
 * up the right, as on the package, each with its name and a dot by value. `back` returns to the boards.
 */
export function pinCard(chip: BbChip, node: HierNode, back: () => void): { el: HTMLElement; update(sim: Sim): void } {
  const sides = pinSides(chip.dip);
  const dots: { el: HTMLElement; net: number | null }[] = [];
  const pinRow = (n: number, right: boolean) => {
    const pin: BbPin | undefined = chip.pins?.[n];
    const port = typeof pin === 'object' ? node.def.ports.find((p) => p.name === pin.port) : undefined;
    const net = typeof pin === 'object' ? node.ports[pin.port]?.[pin.bit ?? 0] ?? null : null;
    const dot = h('span', { class: `dot${net === null ? ' supply' : ''}`, 'data-v': 'x' });
    dots.push({ el: dot, net });
    const name = h('span', { class: 'nm' }, pinName(pin, port?.width ?? 1));
    const num = h('span', { class: 'n' }, String(n));
    return h('div', { class: 'pin', title: typeof pin === 'object' ? `pin ${n}: ${pin.port}${port && port.width > 1 ? `[${pin.bit ?? 0}]` : ''}` : `pin ${n}` },
      ...(right ? [dot, name, num] : [num, name, dot]));
  };
  const el = h('div', { class: 'panel bb-pincard', role: 'group', 'aria-label': `${chip.ref ?? chip.part} pins` },
    h('h4', null, `${chip.ref ? `${chip.ref} · ` : ''}${chip.part} pins, live`),
    h('div', { class: 'bb-dip' },
      h('div', { class: 'side' }, sides.left.map((n) => pinRow(n, false))),
      h('div', { class: 'pkg', 'aria-hidden': 'true' }, h('span', { class: 'notch' })),
      h('div', { class: 'side r' }, sides.right.map((n) => pinRow(n, true)))),
    h('button', { class: 'btn sm', onclick: back }, 'Back to the board'));
  const nets = dots.filter((d) => d.net !== null);
  return {
    el,
    update(sim) {
      const bits = sim.getBits(nets.map((d) => d.net!));
      nets.forEach((d, i) => {
        const v = vOf(bits[i]);
        if (d.el.dataset.v !== v) d.el.dataset.v = v;
      });
    },
  };
}
