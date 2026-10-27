// The breadboard view: a scene drawn as the hardware is built (Scene.breadboard, view/bblayout.ts), over the stage's
// own simulation. Every LED, switch, digit, bus wire and active ring is a net of that simulation, read in one call per
// repaint (BbNets) and painted only where it changed. A chip is a button: hover or focus shows its card (part, role,
// what is inside, its cost), a click selects it (the inspector shows it), a double-click or Enter opens its schematic
// (the stage's drill path), where pinCard lists its DIP pins live. The boards pan and zoom like a schematic (wheel,
// pinch, drag, Fit): they open fitted whole, or, where the layout whole would not read (a phone), on its one-column
// arrangement (BreadboardLayout.narrow) as wide as the canvas, the rest a pan away.

import '../styles/breadboard.css';
import { findNode, type HierNode } from '../sim/flatten';
import type { Sim } from '../sim/sim';
import { romSize, stats } from '../sim/stats';
import { B0, B1, type Bit, type ComponentDef, netlistOf } from '../sim/types';
import { formatBits, type Radix } from '../sim/values';
import { h, s } from '../ui/dom';
import { Camera, fitBox, installPanZoom } from './camera';
import {
  BB, type BbBoard, type BbCrumb, type BbDrill, type BbDriver, busDrivers, driverOf, fitBoards, netIdOf, pickArrangement, rovingMove, type BbBus, type BbChip, type BbNet, BbNets, type BbPin, type Box, type BreadboardLayout, HEX_SEGMENTS, layoutBounds,
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

/** An LED or a bus bit: what its card says and what a click lights. */
interface NetInfo {
  /** The LED (a bus bit: its LED on the strip's head). */
  el: SVGGElement;
  label: string;
  /** Its net by path: 'a.q[3]'. */
  name: string;
  net: BbNet;
  /** Its bit and its whole port's bits (low first), as indices into the bits update() reads. */
  idx: number;
  word: number[];
  bus?: BbBus;
  /** Computed on first use (undefined: not yet). */
  driver?: BbDriver;
}

const NAV_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];

/** A board's (or the bus strip's) controls, one Tab stop for them all: arrows move among them (rovingMove). */
function roving(g: SVGGElement, items: { el: SVGGElement; box: Box }[]): void {
  if (!items.length) return;
  items.forEach((it, i) => it.el.setAttribute('tabindex', i ? '-1' : '0'));
  g.addEventListener('focusin', (e) => {
    const i = items.findIndex((it) => it.el === e.target);
    if (i >= 0) items.forEach((it, k) => it.el.setAttribute('tabindex', k === i ? '0' : '-1'));
  });
  g.addEventListener('keydown', (e) => {
    const i = items.findIndex((it) => it.el === e.target);
    if (i < 0 || !NAV_KEYS.includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    items[rovingMove(items.map((it) => it.box), i, e.key)].el.focus();
  });
}

export class BreadboardView {
  readonly el: HTMLElement;
  private svg: SVGSVGElement;
  private caption: HTMLElement;
  private card: HTMLElement;
  private nets: BbNets | null = null;
  private root: HierNode | null = null;
  private paints: ((bits: Bit[]) => void)[] = [];
  /** The chip whose card is shown (pinned: clicked, it stays until another click or Esc). */
  private carded: { chip?: BbChip; net?: NetInfo; el: Element; live: HTMLElement | null } | null = null;
  /** LEDs and bus bits (and the bus's jumpers) by element. */
  private netInfo = new Map<Element, NetInfo>();
  /** The LED clicked: what drives it stays lit and its card shown, until another click or Esc. */
  private pinNet: NetInfo | null = null;
  private litEls: Element[] = [];
  /** Per bus strip: each driving board's drive line (index into the bits) and its bus drivers (busDrivers). */
  private busBoards = new Map<string, { title: string; line: string; idx: number; chips: BbChip[] }[]>();
  private pinned = false;
  private chipEls = new Map<BbChip, SVGGElement>();
  /** What highlight() can light: a board by its module, a bus strip by its path, a chip by its path or a prefix of it
   *  (unless its board is lit already: 'flags' lights the flag chips on the ALU's board). */
  private lightable: { key: string; el: SVGGElement; chip?: { prefixes: string[]; board: SVGGElement } }[] = [];
  selected: BbChip | null = null;
  radix: Radix = 'hex';
  private last: Bit[] = [];
  private cam: Camera;
  /** The layout given to show(), and the arrangement of it on screen. */
  private layout: BreadboardLayout | null = null;
  private arrangement: 'wide' | 'narrow' = 'wide';
  /** The drill pane (Stage: a chip opened from its board): its breadcrumb, the board, and under it what the stage puts there. */
  private drillHead: HTMLElement;
  readonly drillFoot: HTMLElement;
  private drilled: BbDrill | null = null;
  private drillArgs: { crumbs: BbCrumb[]; go: (to: 'boards' | string[]) => void } = { crumbs: [], go: () => {} };
  private boardEls = new Map<string, { g: SVGGElement; board: BbBoard }>();

  constructor(private readonly hooks: BreadboardHooks) {
    this.svg = s('svg', { class: 'breadboard', role: 'group', 'aria-label': 'Breadboards' });
    this.cam = new Camera(this.svg);
    // shown, hidden, beside a panel that folds, on a phone turned: the svg's own size decides the arrangement and fit
    new ResizeObserver(() => this.resized()).observe(this.svg);
    this.caption = h('div', { class: 'bb-caption' });
    this.card = h('div', { class: 'bb-card', role: 'tooltip', hidden: true });
    this.drillHead = h('div', { class: 'bb-drill-head', hidden: true });
    this.drillFoot = h('div', { class: 'bb-drill-foot', hidden: true });
    this.el = h('div', { class: 'bb-host', hidden: true }, this.caption, this.drillHead, this.svg, this.drillFoot, this.card);
    // a press on a chip, a switch or a board's title is theirs; anywhere else it pans, and a tap lets go of the chip
    // (an LED or a bus jumper too: a tap on one lights what drives it)
    installPanZoom(this.svg, this.cam, {
      canStart: (e) => !(e.target as Element).closest('.bb-chip, .bb-sw, .bb-open'),
      onTap: (target) => {
        const hit = target.closest('.bb-led, .bb-wire-hit');
        const info = hit ? this.netInfo.get(hit) : undefined;
        if (info) this.pinLed(info);
        else this.pick(null);
      },
    });
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && (this.pinned || this.selected || this.pinNet)) {
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
    this.drilled = null;
    this.el.classList.remove('drill');
    this.svg.classList.remove('drilled');
    this.drillHead.hidden = this.drillFoot.hidden = true;
    this.caption.hidden = false;
    this.paints = [];
    this.nets = null;
    this.root = null;
    this.chipEls.clear();
    this.boardEls.clear();
    this.netInfo.clear();
    this.busBoards.clear();
    this.pinNet = null;
    this.litEls = [];
    this.lightable = [];
    this.switches = [];
    this.selected = null;
    this.hideCard(true);
  }

  /** Draw `layout` over a flattened design's root (Stage.sim.design.root), whose simulation update() then reads. */
  show(layout: BreadboardLayout, root: HierNode): void {
    const r = this.svg.getBoundingClientRect();
    this.layout = layout;
    this.arrangement = pickArrangement(layout, r.width, r.height);
    this.draw(this.arrangement === 'narrow' ? layout.narrow! : layout, root);
  }

  /**
   * The drill pane (null: the boards): `d`'s board zoomed with the others dimmed, its chip ringed, `crumbs` above it
   * (a click: `go`), and drillFoot under it for the stage's pin card.
   */
  drill(d: BbDrill | null, crumbs: BbCrumb[] = [], go: (to: 'boards' | string[]) => void = () => {}): void {
    const was = this.drilled;
    this.drillArgs = { crumbs, go };
    this.drilled = d;
    this.el.classList.toggle('drill', !!d);
    this.drillHead.hidden = this.drillFoot.hidden = !d;
    this.caption.hidden = !!d;
    this.svg.classList.toggle('drilled', !!d);
    for (const [title, { g }] of this.boardEls) g.classList.toggle('focus', title === d?.board.title);
    for (const [c, el] of this.chipEls) el.classList.toggle('open', !!d?.chip && c === d.chip);
    if (!d) {
      this.drillHead.replaceChildren();
      this.drillFoot.replaceChildren();
      if (was) this.fit();
      return;
    }
    if (this.selected || this.pinned) this.pick(null);
    else this.hideCard(true);
    const nav = h('nav', { class: 'bb-crumbs', 'aria-label': 'Where this chip is' });
    crumbs.forEach((c, i) => {
      if (i) nav.append(h('span', { class: 'sep', 'aria-hidden': 'true' }, '›'));
      const to = c.to;
      const kind = c.kind ? h('span', { class: 'kind' }, c.kind) : null;
      nav.append(to ? h('button', { class: 'crumb', onclick: () => go(to) }, c.label, kind)
        : h('span', { class: `crumb${i === crumbs.length - 1 ? ' cur' : ''}`, ...(i === crumbs.length - 1 ? { 'aria-current': 'location' } : {}) }, c.label, kind));
    });
    this.drillHead.replaceChildren(nav, h('button', { class: 'btn sm bb-back', title: 'Back to all the boards (Esc goes up one level)', onclick: () => go('boards') }, '‹ Boards'));
    if (!was || was.board.title !== d.board.title || this.cam.fitted) this.fitDrill();
  }

  /** The drilled board, zoomed to the drill pane. */
  private fitDrill(): void {
    const b = this.drilled && this.boardEls.get(this.drilled.board.title)?.board;
    if (!b) return;
    const r = this.svg.getBoundingClientRect();
    this.cam.show(fitBox({ x: b.at[0] - 1, y: b.at[1] - 1, w: b.size[0] + 2, h: b.size[1] + 2 }, r.width, r.height, 0, 0));
  }

  /** Show the whole arrangement: centred, or a column as wide as the canvas from its top (in the drill: its board). */
  fit(): void {
    if (this.drilled) return this.fitDrill();
    const lay = this.shown();
    if (!lay) return;
    const r = this.svg.getBoundingClientRect();
    this.cam.show(fitBoards(layoutBounds(lay), r.width, r.height, this.arrangement === 'narrow'));
  }

  /** Scale the view by `factor` (< 1 zooms in) around its centre (the stage bar's zoom buttons). */
  zoom(factor: number): void {
    this.cam.zoom(factor);
  }

  /** The canvas changed size: another arrangement when the other one now reads better, a fitted view fitted again,
   *  a zoomed one keeping its scale. */
  resized(): void {
    const r = this.svg.getBoundingClientRect();
    if (!this.layout || !this.root || r.width <= 0 || r.height <= 0) return;
    const a = pickArrangement(this.layout, r.width, r.height);
    if (a !== this.arrangement) {
      const sel = this.selected?.path?.join('.');
      this.arrangement = a;
      const d = this.drilled;
      this.draw(a === 'narrow' ? this.layout.narrow! : this.layout, this.root);
      if (this.lastSim) this.update(this.lastSim);
      if (d) this.drill(d, this.drillArgs.crumbs, this.drillArgs.go);
      for (const [c] of this.chipEls) if (sel && c.path?.join('.') === sel) this.pick(c);
      this.fit();
      return;
    }
    if (!this.cam.resized()) this.fit();
  }

  private shown(): BreadboardLayout | null {
    return this.layout && (this.arrangement === 'narrow' ? this.layout.narrow ?? this.layout : this.layout);
  }

  private draw(layout: BreadboardLayout, root: HierNode): void {
    this.clear();
    this.root = root;
    const nets = this.nets = new BbNets(root);
    const id = `bb${++uid}`;
    this.fit();
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
      this.boardEls.set(b.title, { g, board: b });
      if (b.module) this.lightable.push({ key: b.module.join('.'), el: g });
      this.svg.append(g);
      for (const c of b.chips) {
        const el = this.chipEls.get(c);
        if (!c.path || !el) continue;
        const prefixes = c.path.map((_, i) => c.path!.slice(0, i + 1).join('.'));
        this.lightable.push({ key: c.path.join('.'), el, chip: { prefixes, board: g } });
      }
    }
    for (const bus of layout.buses ?? []) {
      const drv = busDrivers(layout, root, bus);
      this.busBoards.set(bus.id, layout.boards.filter((b) => b.bus === bus.id && b.drives).map((b) => ({
        title: b.title, line: (b.drives!.label ?? '').split(' · ')[0], idx: nets.net(b.drives!), chips: drv.get(b.title) ?? [],
      })));
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
    if (this.carded?.live && this.carded.chip) this.paintLive(this.carded.chip, this.carded.live, sim);
    if (this.carded?.net && this.carded.live) this.paintNet(this.carded.net, this.carded.live);
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
    const items: { el: SVGGElement; box: Box }[] = [];
    if (b.module) {
      const mod = b.module;
      const t = s('g', { class: 'bb-open', role: 'button', 'aria-label': `${b.title} board: Enter opens it` }, title);
      items.push({ el: t, box: { x: 1.4, y: 1.8, w: b.title.length * 0.8, h: 1.4 } });
      t.addEventListener('dblclick', () => this.hooks.open(mod));
      t.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.hooks.open(mod);
        }
      });
      g.append(t);
    } else g.append(title);
    const add = (el: SVGGElement, box: Box) => {
      items.push({ el, box });
      g.append(el);
    };
    b.chips.forEach((c, i) => add(this.drawChip(c, plan.chips[i], b), plan.chips[i]));
    (b.beside ?? []).forEach((l, i) => add(this.drawLed(l.net, l.color ?? 'red', l.label, plan.beside[i], ctx), plan.beside[i]));
    (b.switches ?? []).forEach((sw, i) => add(this.drawSwitch(sw.port, sw.bit ?? 0, sw.label, plan.switches[i]), plan.switches[i]));
    (b.leds ?? []).forEach((l, i) => add(this.drawLed(l.net, l.color ?? 'red', l.label, plan.leds[i], ctx), plan.leds[i]));
    roving(g, items);
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
      class: `bb-chip${c.path ? '' : ' drawn'}`, transform: `translate(${r.x} ${r.y})`, role: 'button',
      'aria-label': c.path ? `${name} on ${board.title}: Enter opens it, Space selects it` : `${name} on ${board.title} (drawn, not simulated)`,
    });
    g.append(s('rect', { class: 'bb-sel', x: -0.7, y: -1, width: r.w + 1.4, height: r.h + 2, rx: 0.4 }));
    for (let i = 0; i < n; i++) {
      g.append(s('rect', { class: 'bb-leg', x: i + 0.3, y: -0.5, width: 0.4, height: 0.5 }),
        s('rect', { class: 'bb-leg', x: i + 0.3, y: r.h, width: 0.4, height: 0.5 }));
    }
    g.append(s('rect', { class: 'bb-body', width: r.w, height: r.h, rx: 0.18 }),
      s('path', { class: 'bb-notch', d: `M0 ${r.h / 2 - 0.5} A0.5 0.5 0 0 1 0 ${r.h / 2 + 0.5} Z` }));
    const fs = Math.min(1.5, (r.w - 0.6) / (c.part.length * 0.62));
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
    const width = (this.root && findNode(this.root, net.path)?.ports[net.port]?.length) ?? 1;
    const name = `${[...net.path, net.port].join('.')}${width > 1 ? `[${net.bit ?? 0}]` : ''}`;
    const what = label && label !== net.port ? `${label}, ${name}` : name;
    const g = s('g', { class: `bb-led c-${color}`, transform: `translate(${r.x} ${r.y})`, 'data-v': 'x', role: 'button', 'aria-pressed': 'false', 'aria-label': `LED ${what} unknown` },
      s('rect', { class: 'hit', x: Math.min(0, cx - 0.8), y: -0.3, width: Math.max(r.w, 1.6), height: r.h + 0.3 }),
      s('circle', { class: 'halo', cx, cy, r: 0.95, filter: `url(#${ctx.id}-glow)` }),
      s('circle', { class: 'lens', cx, cy, r: 0.55 }));
    if (label) g.append(s('text', { class: 'bb-ll', x: cx, y: r.h - 0.12 }, label));
    const info: NetInfo = { el: g, label: label && label !== net.port ? label : name, name, net, idx: i, word: width > 1 ? ctx.nets.bus({ ...net, bit: 0 }, width) : [i] };
    this.netLed(g, info);
    let shown = '';
    this.paints.push((bits) => {
      const v = vOf(bits[i]);
      if (v === shown) return;
      shown = v;
      g.dataset.v = v;
      g.setAttribute('aria-label', `LED ${what} ${v === 'x' ? 'unknown' : v === '1' ? 'on' : 'off'}`);
    });
    return g;
  }

  private switches: { g: SVGGElement; port: string; bit: number; on: boolean | null; what: string }[] = [];

  private drawSwitch(port: string, bit: number, label: string | undefined, r: Box): SVGGElement {
    const x = (r.w - BB.sw) / 2;
    const what = `${label ?? port}${label ? '' : `[${bit}]`}`;
    const g = s('g', { class: 'bb-sw', transform: `translate(${r.x} ${r.y})`, role: 'button', 'aria-pressed': 'false', 'aria-label': `Switch ${what}` },
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
    const wires: SVGLineElement[] = [], hits: SVGLineElement[] = [];
    for (let k = 0; k < n; k++) {
      const x = x0 + (n - 1 - k) * pitch;
      wires.push(s('line', { class: 'bb-wire', x1: x, x2: x, y1: BB.busHead, y2: H, 'data-v': 'x' }));
      hits.push(s('line', { class: 'bb-wire-hit', x1: x, x2: x, y1: BB.busHead, y2: H, 'stroke-width': pitch }));
    }
    g.append(...wires, ...hits);
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
      const bit = n - 1 - k;
      const led = s('g', { class: 'bb-led c-yellow', 'data-v': 'x', role: 'button', 'aria-pressed': 'false', 'aria-label': `${b.title ?? 'Bus'} bit ${bit}` },
        s('circle', { class: 'halo', cx, cy, r: 0.8, filter: `url(#${ctx.id}-glow)` }), s('circle', { class: 'lens', cx, cy, r: 0.45 }));
      leds.push(led);
      const info: NetInfo = { el: led, label: `${b.title ?? 'Bus'} bit ${bit}`, name: `${[...b.path, b.port].join('.')}[${bit}]`, net: { path: b.path, port: b.port, bit }, idx: idx[bit], word: idx, bus: b };
      this.netLed(led, info);
      this.netLed(hits[bit], info, led);
    }
    g.append(...leds);
    roving(g, leds.map((el, k) => ({ el, box: { x: k, y: 0, w: 1, h: 1 } })));
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

  // ---- LEDs and bus bits ----

  /** Hover, focus and keys of an LED (or a bus jumper standing for its bit's LED `led`). */
  private netLed(el: SVGElement, info: NetInfo, led: SVGGElement = info.el): void {
    this.netInfo.set(el, info);
    el.addEventListener('pointerenter', () => this.showNetCard(info, el));
    el.addEventListener('pointerleave', () => this.hideCard());
    if (el !== led) return;
    el.addEventListener('focus', () => this.showNetCard(info, el));
    el.addEventListener('blur', () => this.hideCard());
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.pinLed(info);
      }
    });
  }

  /** Who drives an LED's net (computed once). */
  private driverOfNet(info: NetInfo): BbDriver {
    if (info.driver === undefined) {
      const lay = this.shown();
      info.driver = lay && this.root ? driverOf(lay, this.root, netIdOf(this.root, info.net)) : null;
    }
    return info.driver;
  }

  /** The boards driving a bus strip now (their drive line is 1). */
  private drivingNow(bus: BbBus): { title: string; line: string; chips: BbChip[] }[] {
    return (this.busBoards.get(bus.id) ?? []).filter((b) => this.last[b.idx] === B1);
  }

  /** What an LED's card and a click on it light: the chip that drives it (a bus bit: the boards' bus drivers now). */
  private driverEls(info: NetInfo): Element[] {
    if (info.bus) return this.drivingNow(info.bus).flatMap((b) => b.chips.map((c) => this.chipEls.get(c)).filter((e): e is SVGGElement => !!e));
    const d = this.driverOfNet(info);
    const el = d && 'chip' in d ? this.chipEls.get(d.chip) : undefined;
    return el ? [el] : [];
  }

  private light(info: NetInfo | null): void {
    for (const el of this.litEls) el.classList.remove('lit');
    this.litEls = info ? this.driverEls(info) : [];
    for (const el of this.litEls) el.classList.add('lit');
  }

  /** Pin an LED (again: let it go): what drives it stays lit, its card shown. */
  private pinLed(info: NetInfo): void {
    if (this.pinNet === info) return this.pick(null);
    this.pick(null, false);
    this.pinNet = info;
    info.el.setAttribute('aria-pressed', 'true');
    info.el.classList.add('pinned');
    this.showNetCard(info, info.el);
  }

  private showNetCard(info: NetInfo, el: Element): void {
    const live = h('div', { class: 'net-live' });
    this.card.replaceChildren(
      h('div', { class: 'bb-card-h' }, h('b', null, info.label), info.label !== info.name ? h('span', null, info.name) : null),
      live,
      h('p', { class: 'foot' }, this.pinNet === info ? 'Lit: what drives it · click again or Esc to let go' : 'Click to keep what drives it lit'));
    this.card.hidden = false;
    this.carded = { net: info, el, live };
    this.paintNet(info, live, true);
    this.light(info);
    this.placeCard(el);
  }

  /** An LED's card, live: its value and its port's (in the site's radix), and who drives it. */
  private paintNet(info: NetInfo, el: HTMLElement, force = false): void {
    const bits = this.last;
    if (!bits.length) return;
    const v = vOf(bits[info.idx]).toUpperCase(), word = info.word.map((i) => bits[i]);
    const port = info.bus ? [...info.bus.path, info.bus.port].join('.') : [...info.net.path, info.net.port].join('.');
    const value = word.length > 1 ? `${info.name} = ${v} · ${port} = ${formatBits(word, this.radix)}` : `${info.name} = ${v}`;
    const chipName = (c: BbChip) => [c.ref, c.part].filter(Boolean).join(' · ');
    let drive: string;
    if (info.bus) {
      const now = this.drivingNow(info.bus);
      drive = !now.length ? 'No board drives the bus now: its pull-downs read 0.'
        : `Driven now by ${now.map((b) => `${b.title}${b.line ? ` (${b.line})` : ''}${b.chips.length ? ` through ${b.chips.map(chipName).join(', ')}` : ''}`).join(' and ')}${now.length > 1 ? ': two drivers at once, a clash' : ''}.`;
    } else {
      const d = this.driverOfNet(info);
      const wide = (n: number[] | undefined) => (n?.length ?? 1) > 1;
      drive = !d ? 'Driven inside its module (by no chip of its own on the boards).'
        : 'chip' in d ? `Driven by ${chipName(d.chip)}, its output ${d.port}${this.root && wide(findNode(this.root, d.chip.path!)?.ports[d.port]) ? `[${d.bit}]` : ''}.`
          : `Set by the scene's input ${d.input}${wide(this.root?.ports[d.input]) ? `[${d.bit}]` : ''}.`;
    }
    const key = `${value}|${drive}`;
    if (!force && el.dataset.key === key) return;
    el.dataset.key = key;
    el.replaceChildren(h('p', { class: 'live' }, value), h('p', null, drive));
    // a bus bit's drivers change from step to step: what is lit follows
    if (!force && info.bus) this.light(info);
  }

  // ---- the chip card ----

  /** Select a chip (its card stays) or none; a pinned LED lets go. `notify`: tell the stage (the inspector). */
  private pick(c: BbChip | null, notify = true): void {
    if (this.pinNet) {
      this.pinNet.el.setAttribute('aria-pressed', 'false');
      this.pinNet.el.classList.remove('pinned');
      this.pinNet = null;
      this.light(null);
    }
    if (this.selected) this.chipEls.get(this.selected)?.classList.remove('sel');
    this.selected = c;
    this.pinned = !!c;
    if (c) {
      const el = this.chipEls.get(c)!;
      el.classList.add('sel');
      this.showCard(c, el, true);
    } else this.hideCard(true);
    if (notify) this.hooks.select(c);
  }

  private showCard(c: BbChip, el: SVGGElement, force = false): void {
    if (this.pinned && !force && this.carded?.chip !== c) return;
    if (!this.pinNet) this.light(null);
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

  private placeCard(el: Element): void {
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
    if (this.pinNet && !force) {
      // back to the pinned LED's card
      if (this.carded?.net !== this.pinNet) this.showNetCard(this.pinNet, this.pinNet.el);
      return;
    }
    if (this.carded?.net) this.light(null);
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
  // a ROM chip's mux tree (stats' rom) is not logic: its bytes instead
  const n = st.nands - (st.rom?.nands ?? 0), rom = st.rom ? `${romSize(st.rom)} of ROM` : '';
  const logic = n ? `${n.toLocaleString('en-US')} NAND${n === 1 ? '' : 's'}` : st.transistors && !st.rom ? `${st.transistors} transistors` : '';
  const cost = [logic, rom].filter(Boolean).join(' + ');
  if (!nl) return cost ? `A leaf of the simulation · ${cost}` : 'A leaf of the simulation';
  const kinds = new Map<string, number>();
  for (const i of nl.instances) if (i.def.prim !== 'alias') kinds.set(i.def.name, (kinds.get(i.def.name) ?? 0) + 1);
  const list = [...kinds].sort((a, b) => b[1] - a[1]);
  const shown = list.slice(0, 4).map(([k, n]) => `${n} × ${k}`).join(', ') + (list.length > 4 ? `, ${list.length - 4} more kinds` : '');
  return `Inside: ${shown || 'wiring'}${cost ? ` · ${cost}` : ''}`;
}

/** Under the drilled board, beside the pins: what the chip (or the board's module) is, its role here, what is inside. */
export function drillNotes(d: BbDrill, def: ComponentDef | undefined): HTMLElement {
  const c = d.chip;
  const head = c ? `${c.ref ? `${c.ref} · ` : ''}${c.part}` : d.board.title;
  return h('div', { class: 'panel bb-notes' },
    h('h4', null, head, def ? h('span', { class: 'kind' }, def.name) : null),
    c?.role ? h('p', null, c.role) : null,
    def ? h('p', { class: 'in' }, insideOf(def)) : null,
    h('p', { class: 'foot' }, c ? 'Live on the right, the same nets as the board: double-click a part there to keep going down.' : 'Its chips on the left, its schematic on the right: double-click a chip on either to open it.'));
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
