// The logic analyzer: root ports and probed nets over time, in gate delays. Values are
// recorded from the simulator's trace hook, so every transition (glitches included) sits
// at the exact instant it happened. Docked under the schematic.

import type { Sim } from '../sim/sim';
import { formatNumber, pack, type Radix } from '../sim/values';
import { toVcd, type TraceSignal } from '../sim/vcd';
import { h, icon, s } from '../ui/dom';

export interface Lane {
  id: number;
  label: string;
  /** Full hierarchical name, for the tooltip and VCD. */
  title: string;
  /** Flat nets in the root simulation, LSB first. */
  nets: number[];
  width: number;
  /** Probe colour index (−1 = neutral, used for ports). */
  color: number;
  probe: boolean;
  clock: boolean;
  /** Identity of the signal: its flat nets. */
  key: string;
}

interface Trace {
  t: number[];
  v: number[];
}

const LANE_H = 24;
const RULER_H = 18;
export const PROBE_COLORS = 8;
export const netKey = (nets: readonly number[]) => nets.join(',');

export class LogicAnalyzer {
  readonly el: HTMLElement;
  lanes: Lane[] = [];
  radix: Radix = 'hex';
  /** Called when lanes are added or removed (the schematic redraws its probe flags). */
  onLanesChange: () => void = () => {};
  /** Called when the user closes the panel. */
  onClose: () => void = () => {};
  private sim: Sim | null = null;
  private traces = new Map<number, Trace>();
  private byNet = new Map<number, Lane[]>();
  private edges: number[] = [];
  private late: number[] = [];
  private nextId = 1;
  private start = 0;
  private t0 = 0;
  private span = 60;
  private follow = true;
  private cursorA: number | null = null;
  private cursorB: number | null = null;
  private names: HTMLElement;
  private plot: HTMLElement;
  private svg: SVGSVGElement;
  private readout: HTMLElement;
  private followBtn: HTMLButtonElement;
  private queued = false;
  private hoverT: number | null = null;

  constructor() {
    const btn = (ic: string, title: string, fn: () => void, label?: string) =>
      h('button', { class: `btn ghost sm${label ? '' : ' icon-only'}`, title, 'aria-label': title, onclick: fn }, icon(ic, 14), label ?? null);
    this.readout = h('span', { class: 'la-readout' });
    this.followBtn = btn('play', 'Follow the newest time', () => {
      this.follow = !this.follow;
      this.render();
    }, 'Live') as HTMLButtonElement;
    const head = h('div', { class: 'la-head' },
      h('b', null, 'Timing'), h('span', { class: 'la-hint' }, 'gate delays · click: cursor A · shift-click: B · wheel: zoom · drag: pan'),
      h('span', { class: 'spacer' }), this.readout,
      this.followBtn,
      btn('fit', 'Fit everything recorded', () => this.fit()),
      btn('reset', 'Clear the recording (keep the lanes)', () => this.clear()),
      btn('code', 'Download as VCD (GTKWave, Surfer)', () => this.downloadVcd(), 'VCD'),
      btn('close', 'Close the timing panel', () => this.onClose()));
    this.names = h('div', { class: 'la-names' });
    this.svg = s('svg', { class: 'la-svg' });
    this.plot = h('div', { class: 'la-plot' }, this.svg);
    const grip = h('div', { class: 'la-grip', title: 'Drag to resize' });
    this.el = h('section', { class: 'analyzer', 'aria-label': 'Timing diagram' }, grip, head, h('div', { class: 'la-body' }, this.names, this.plot));
    this.installPointer();
    this.installResize(grip);
    new ResizeObserver(() => this.render()).observe(this.plot);
  }

  /** Start recording a simulation (a fresh scene, or after a reset). */
  attach(sim: Sim): void {
    this.sim = sim;
    sim.onTrace = (net) => this.record(net);
    this.traces.clear();
    for (const l of this.lanes) {
      sim.watch(l.nets);
      this.traces.set(l.id, { t: [sim.time], v: [this.valueOf(l)] });
    }
    this.edges = [];
    this.late = [];
    this.start = sim.time;
    this.cursorA = this.cursorB = null;
    this.follow = true;
    this.span = 60;
    this.render();
  }

  setLanes(lanes: Omit<Lane, 'id' | 'key'>[]): void {
    this.lanes = [];
    this.byNet.clear();
    this.traces.clear();
    for (const l of lanes) this.add(l, false);
    this.onLanesChange();
    this.render();
  }

  add(l: Omit<Lane, 'id' | 'key'>, notify = true): Lane {
    const lane: Lane = { ...l, id: this.nextId++, key: netKey(l.nets) };
    this.lanes.push(lane);
    for (const n of lane.nets) {
      const list = this.byNet.get(n) ?? [];
      list.push(lane);
      this.byNet.set(n, list);
    }
    if (this.sim) {
      this.sim.watch(lane.nets);
      this.traces.set(lane.id, { t: [this.sim.time], v: [this.valueOf(lane)] });
    }
    if (notify) {
      this.onLanesChange();
      this.render();
    }
    return lane;
  }

  remove(id: number): void {
    const lane = this.lanes.find((l) => l.id === id);
    if (!lane) return;
    this.lanes = this.lanes.filter((l) => l !== lane);
    for (const n of lane.nets) this.byNet.set(n, (this.byNet.get(n) ?? []).filter((l) => l !== lane));
    this.traces.delete(id);
    this.onLanesChange();
    this.render();
  }

  probeFor(key: string): Lane | undefined {
    return this.lanes.find((l) => l.probe && l.key === key);
  }

  nextColor(): number {
    const used = new Set(this.lanes.filter((l) => l.probe).map((l) => l.color));
    for (let i = 0; i < PROBE_COLORS; i++) if (!used.has(i)) return i;
    return this.lanes.filter((l) => l.probe).length % PROBE_COLORS;
  }

  /** A rising clock edge arrived while events were still pending (fixed-period clock). */
  markLate(t: number): void {
    this.late.push(t);
  }

  /** Schedule a redraw (coalesced to one per frame). */
  update(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.render();
    });
  }

  // ---- recording --------------------------------------------------------------------------

  private valueOf(l: Lane): number {
    return pack(this.sim!.getBits(l.nets));
  }

  private record(net: number): void {
    const lanes = this.byNet.get(net);
    if (!lanes || !this.sim) return;
    const t = this.sim.time;
    for (const l of lanes) {
      const tr = this.traces.get(l.id);
      if (!tr) continue;
      const v = this.valueOf(l);
      const n = tr.t.length - 1;
      const before = tr.t[n] === t ? (n > 0 ? tr.v[n - 1] : NaN) : tr.v[n];
      // Several bits of a bus change in the same instant: keep only the final value.
      if (tr.t[n] === t) {
        tr.v[n] = v;
        if (n > 0 && tr.v[n - 1] === v) { tr.t.pop(); tr.v.pop(); }
      } else if (tr.v[n] !== v) {
        tr.t.push(t);
        tr.v.push(v);
        if (tr.t.length > 200000) { tr.t.splice(0, 50000); tr.v.splice(0, 50000); }
      }
      if (l.clock && v === 1 && before === 0 && this.edges[this.edges.length - 1] !== t) this.edges.push(t);
    }
  }

  clear(): void {
    if (this.sim) this.attach(this.sim);
  }

  private now(): number {
    return this.sim?.time ?? 0;
  }

  // ---- view -------------------------------------------------------------------------------

  private fit(): void {
    this.t0 = this.start;
    this.span = Math.max(8, (this.now() - this.start) * 1.04 + 2);
    this.follow = true;
    this.render();
  }

  private valueAt(tr: Trace, t: number): number {
    let lo = 0, hi = tr.t.length - 1;
    if (hi < 0 || t < tr.t[0]) return NaN;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (tr.t[m] <= t) lo = m; else hi = m - 1;
    }
    return tr.v[lo];
  }

  private fmt(v: number, w: number): string {
    if (Number.isNaN(v)) return '';
    if (v < 0) return 'X';
    return w === 1 ? String(v) : formatNumber(v, w, this.radix);
  }

  private render(): void {
    const W = this.plot.clientWidth;
    if (!W) return;
    const now = this.now();
    if (this.follow) this.t0 = Math.max(this.start, now - this.span * 0.94);
    this.followBtn.classList.toggle('on', this.follow);
    const t0 = this.t0, span = this.span;
    const x = (t: number) => ((t - t0) / span) * W;
    const H = RULER_H + this.lanes.length * LANE_H + 4;
    this.svg.setAttribute('width', String(W));
    this.svg.setAttribute('height', String(H));
    this.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const parts: SVGElement[] = [];

    // Ruler: ticks at a 1-2-5 step giving ~80 px between labels.
    const raw = (span / W) * 80;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 5, 10].map((k) => k * mag).find((k) => k >= raw) ?? raw;
    for (let t = Math.ceil(t0 / step) * step; t <= t0 + span; t += step) {
      parts.push(s('line', { x1: x(t), x2: x(t), y1: RULER_H - 4, y2: H, class: 'la-tick' }));
      parts.push(s('text', { x: x(t) + 3, y: RULER_H - 6, class: 'la-time' }, String(Math.round(t))));
    }
    // Rising clock edges: where flip-flops capture.
    for (const e of this.edges) if (e >= t0 && e <= t0 + span) parts.push(s('line', { x1: x(e), x2: x(e), y1: RULER_H, y2: H, class: 'la-edge' }));
    for (const e of this.late) {
      if (e < t0 || e > t0 + span) continue;
      parts.push(s('path', { d: `M${x(e) - 5},2 L${x(e) + 5},2 L${x(e)},${RULER_H - 6} Z`, class: 'la-late' },
        s('title', null, 'This edge arrived while the logic was still switching: the period is shorter than the path being exercised.')));
    }
    // Lanes
    this.lanes.forEach((l, li) => {
      const tr = this.traces.get(l.id);
      if (!tr || !tr.t.length) return;
      const top = RULER_H + li * LANE_H + 4, bot = top + LANE_H - 8, mid = (top + bot) / 2;
      const cls = `la-trace${l.color >= 0 ? ` p${l.color}` : ''}`;
      // First sample inside or just before the window.
      let i = 0, hi = tr.t.length - 1;
      while (i < hi) { const m = (i + hi + 1) >> 1; if (tr.t[m] <= t0) i = m; else hi = m - 1; }
      const end = Math.min(now, t0 + span);
      if (l.width === 1) {
        let d = '';
        let xs: { a: number; b: number }[] = [];
        for (let k = i; k < tr.t.length && tr.t[k] <= end; k++) {
          const a = Math.max(tr.t[k], t0), b = k + 1 < tr.t.length ? Math.min(tr.t[k + 1], end) : end;
          const v = tr.v[k];
          const y = v === 1 ? top : v === 0 ? bot : mid;
          d += d ? ` V${y} H${x(b)}` : `M${x(a)},${y} H${x(b)}`;
          if (v < 0) xs.push({ a, b });
        }
        parts.push(s('path', { d, class: cls }));
        for (const r of xs) parts.push(s('rect', { x: x(r.a), y: top, width: Math.max(1, x(r.b) - x(r.a)), height: bot - top, class: 'la-x' }));
        xs = [];
      } else {
        for (let k = i; k < tr.t.length && tr.t[k] <= end; k++) {
          const a = Math.max(tr.t[k], t0), b = k + 1 < tr.t.length ? Math.min(tr.t[k + 1], end) : end;
          const xa = x(a), xb = x(b);
          const c = Math.min(3, (xb - xa) / 2);
          const v = tr.v[k];
          parts.push(s('path', { d: `M${xa},${mid} L${xa + c},${top} H${xb - c} L${xb},${mid} L${xb - c},${bot} H${xa + c} Z`, class: `${cls} bus${v < 0 ? ' x' : ''}` }));
          const txt = this.fmt(v, l.width);
          if (xb - xa > txt.length * 6.6 + 8) parts.push(s('text', { x: (xa + xb) / 2, y: mid + 4, 'text-anchor': 'middle', class: 'la-val' }, txt));
        }
      }
    });
    // Now, cursors
    if (now >= t0 && now <= t0 + span) parts.push(s('line', { x1: x(now), x2: x(now), y1: 0, y2: H, class: 'la-now' }));
    for (const [c, cls] of [[this.cursorA, 'a'], [this.cursorB, 'b']] as const) {
      if (c === null || c < t0 || c > t0 + span) continue;
      parts.push(s('line', { x1: x(c), x2: x(c), y1: 0, y2: H, class: `la-cursor ${cls}` }));
      parts.push(s('text', { x: x(c) + 3, y: 10, class: `la-cursor-l ${cls}` }, cls.toUpperCase()));
    }
    if (this.hoverT !== null) parts.push(s('line', { x1: x(this.hoverT), x2: x(this.hoverT), y1: RULER_H, y2: H, class: 'la-hover' }));
    this.svg.replaceChildren(...parts);

    // Names column: value at the hover position, else cursor A, else now.
    const at = this.hoverT ?? this.cursorA ?? now;
    this.names.replaceChildren(h('div', { class: 'la-name ruler' }, `t = ${Math.round(at)}`),
      ...this.lanes.map((l) => {
        const tr = this.traces.get(l.id);
        const v = tr ? this.valueAt(tr, at) : NaN;
        return h('div', { class: 'la-name', title: l.title },
          h('i', { class: `chip${l.color >= 0 ? ` p${l.color}` : ''}${l.clock ? ' clk' : ''}` }),
          h('span', { class: 'n' }, l.label),
          h('span', { class: 'v' }, this.fmt(v, l.width)),
          h('button', { class: 'x', title: 'Remove lane', 'aria-label': `Remove ${l.label}`, onclick: () => this.remove(l.id) }, '×'));
      }));
    const a = this.cursorA, b = this.cursorB;
    this.readout.textContent = a === null ? '' : b === null ? `A = ${a}` : `A = ${a} · B = ${b} · Δ = ${Math.abs(b - a)} gate delays`;
  }

  private installPointer(): void {
    let drag: { x: number; t0: number; moved: boolean } | null = null;
    const tAt = (clientX: number) => {
      const r = this.plot.getBoundingClientRect();
      return this.t0 + ((clientX - r.left) / r.width) * this.span;
    };
    this.plot.addEventListener('wheel', (e) => {
      e.preventDefault();
      const t = tAt(e.clientX);
      const span = Math.min(Math.max(this.span * Math.exp(e.deltaY * 0.0015), 4), 1e8);
      // While following, zoom around "now"; otherwise around the pointer.
      if (!this.follow) this.t0 = t - (t - this.t0) * (span / this.span);
      this.span = span;
      this.render();
    }, { passive: false });
    this.plot.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, t0: this.t0, moved: false };
      this.plot.setPointerCapture(e.pointerId);
    });
    this.plot.addEventListener('pointermove', (e) => {
      if (drag) {
        const dx = e.clientX - drag.x;
        if (Math.abs(dx) > 3) drag.moved = true;
        if (drag.moved) {
          this.t0 = drag.t0 - (dx / this.plot.clientWidth) * this.span;
          this.follow = false;
        }
      }
      this.hoverT = Math.round(tAt(e.clientX));
      this.update();
    });
    this.plot.addEventListener('pointerleave', () => {
      this.hoverT = null;
      this.update();
    });
    this.plot.addEventListener('pointerup', (e) => {
      if (drag && !drag.moved) {
        const t = Math.round(tAt(e.clientX));
        if (e.shiftKey) this.cursorB = t;
        else { this.cursorA = t; this.cursorB = null; }
      }
      drag = null;
      this.render();
    });
    this.plot.addEventListener('dblclick', () => this.fit());
  }

  private installResize(grip: HTMLElement): void {
    grip.addEventListener('pointerdown', (e) => {
      const y0 = e.clientY, h0 = this.el.getBoundingClientRect().height;
      grip.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        this.el.style.height = `${Math.min(Math.max(h0 - (ev.clientY - y0), 110), window.innerHeight * 0.7)}px`;
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
    });
  }

  private downloadVcd(): void {
    const signals: TraceSignal[] = this.lanes.map((l) => {
      const tr = this.traces.get(l.id) ?? { t: [], v: [] };
      return { name: l.title, width: l.width, t: tr.t, v: tr.v };
    });
    const text = toVcd(signals, { date: new Date().toISOString(), scope: 'scene' });
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: 'trace.vcd' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}
