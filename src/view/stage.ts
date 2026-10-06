// The stage: a scene (root component + inputs) simulated live, viewed through a schematic
// that can drill into any instance, with input controls, clock, propagation animation and
// the inspector. Chapters and the workbench are thin wrappers around it.

import { flatten } from '../sim/flatten';
import { GateSim } from '../sim/gatesim';
import { needsSwitchLevel } from '../sim/harness';
import { completeEdge, type Edge, riseEdge, stepEdge } from '../sim/edge';
import type { PowerOnMode, Sim } from '../sim/sim';
import { SwitchSim } from '../sim/switchsim';
import { B0, B1, type Bit, type ComponentDef, inPorts, netlistOf, outPorts, type PortDef } from '../sim/types';
import { formatBits, formatNumber, mask, pack, type Radix } from '../sim/values';
import { LogicAnalyzer, netKey } from './analyzer';
import { h, icon } from '../ui/dom';
import { settings } from '../ui/settings';
import { ViewCtx } from './context';
import { Inspector } from './inspector';
import { closePopover, editNumber } from './popover';
import { SchematicView } from './schematic';

export interface Scene {
  root: ComponentDef;
  inputs?: Record<string, number>;
  /** Open this deep on load (instance names). */
  path?: string[];
  highlight?: string[];
  /** Name of the clock input (gets Pulse / Run buttons). Defaults to any port marked clock or named clk. */
  clock?: string;
  powerOn?: PowerOnMode;
  /** Extra overlay panels. */
  panels?: ScenePanel[];
  /** Hide these inputs from the control bar (driven by the chapter). */
  hiddenInputs?: string[];
  /** Always animate propagation in this scene, regardless of the global setting. */
  animate?: boolean;
  /** Open the timing panel (logic analyzer) on load. */
  analyzer?: boolean;
}

export interface Widget {
  el: HTMLElement;
  update?(): void;
  destroy?(): void;
}

/** A panel overlaid on the canvas that reads the live scene (e.g. the memory grid). */
export type ScenePanel = (stage: Stage) => Widget;

/** Factory for "leaf" explainers, e.g. opening a single MOSFET. */
export type LeafWidgetFactory = (def: ComponentDef, gate: () => Bit) => Widget;

const LEVEL_NAME: Record<string, string> = {
  transistor: 'transistors', cell: 'transistors', gate: 'gates', arithmetic: 'gates & blocks',
  routing: 'gates & blocks', sequential: 'latches & flip-flops', memory: 'memory', plumbing: 'wiring', cpu: 'processor',
};

export class Stage {
  readonly el: HTMLElement;
  readonly inspector: Inspector;
  scene: Scene | null = null;
  sim: Sim | null = null;
  rootCtx: ViewCtx | null = null;
  ctx: ViewCtx | null = null;
  private view: SchematicView;
  private crumbs: HTMLElement;
  private controls: HTMLElement;
  private canvas: HTMLElement;
  private levelBadge: HTMLElement;
  private status: HTMLElement;
  private leaf: { name: string; widget: Widget } | null = null;
  private widget: { w: Widget; host: HTMLElement } | null = null;
  private panels: Widget[] = [];
  private anim: ReturnType<typeof setInterval> | null = null;
  private runClock: ReturnType<typeof setInterval> | null = null;
  private runBtn: HTMLElement | null = null;
  private changeStart = 0;
  private lastSettle: number | null = null;
  private listeners = new Set<() => void>();
  private navListeners = new Set<(path: string[]) => void>();
  readonly analyzer = new LogicAnalyzer();
  private probeMode = false;
  private probeBtn: HTMLButtonElement;
  private timingBtn: HTMLButtonElement;
  /** Fixed clock period in gate delays (null: every edge waits for the logic to settle). */
  private period: number | null = null;
  private nextEdge = 0;
  /** Events still pending at the last rising edge (fixed period only). */
  private lateEvents = 0;
  private lateCount = 0;
  /** Per-output radix chosen by clicking its value (else the global setting). */
  private outRadix = new Map<string, Radix>();
  private flash: string | null = null;
  private selected: string | null = null;
  leafFactory: LeafWidgetFactory | null = null;
  /** Rising clock edges since the scene was loaded or reset. */
  cycles = 0;
  /** Observers of every rising clock edge: before (inputs still old) and after it settled. */
  readonly edgeHooks = new Set<{ before?: () => void; after?: () => void }>();
  /** The rising edge in progress (slow mode plays it one gate delay at a time). */
  private edge: Edge | null = null;
  private edgePeriod = 0;
  private beforeEdge(): void { this.edgeHooks.forEach((h) => h.before?.()); }
  private afterEdge(): void { this.edgeHooks.forEach((h) => h.after?.()); }

  constructor(inspector: Inspector) {
    this.inspector = inspector;
    this.crumbs = h('nav', { class: 'crumbs', 'aria-label': 'Hierarchy' });
    const btn = (ic: string, title: string, fn: () => void) =>
      h('button', { class: 'btn ghost icon-only', title, 'aria-label': title, onclick: fn }, icon(ic, 16));
    this.probeBtn = h('button', { class: 'btn ghost sm toggle probe-btn', title: 'Probe mode (P): click any wire to add it to the timing diagram', onclick: () => this.setProbeMode(!this.probeMode) },
      icon('probe', 15), h('span', { class: 'lbl' }, 'Probe')) as HTMLButtonElement;
    this.timingBtn = h('button', { class: 'btn ghost sm toggle', title: 'Timing diagram: probed nets and ports over time', onclick: () => this.showAnalyzer(!this.el.classList.contains('with-analyzer')) },
      icon('wave', 15), h('span', { class: 'lbl' }, 'Timing')) as HTMLButtonElement;
    const bar = h('div', { class: 'stage-bar' },
      this.crumbs, this.probeBtn, this.timingBtn,
      btn('up', 'Up one level (Esc)', () => this.up()),
      btn('minus', 'Zoom out', () => this.view.zoom(1.25)),
      btn('plus', 'Zoom in', () => this.view.zoom(0.8)),
      btn('fit', 'Fit to screen', () => this.view.fit()));
    this.canvas = h('div', { class: 'canvas' });
    this.levelBadge = h('div', { class: 'level-badge' });
    this.canvas.append(this.levelBadge, h('div', { class: 'hint-badge' }, 'double-click a part to open it · drag to pan · wheel to zoom'));
    this.controls = h('div', { class: 'controls' });
    this.status = h('div', { class: 'status' });
    this.el = h('section', { class: 'stage' }, bar, this.canvas, this.analyzer.el, this.controls);
    this.analyzer.onClose = () => this.showAnalyzer(false);
    this.analyzer.onLanesChange = () => this.view.drawProbes();
    this.view = new SchematicView(this.canvas, {
      open: (c) => this.open(c),
      select: (c) => this.select(c),
      toggleInput: (p) => this.toggleInput(p),
      editInput: (p, r) => this.editInput(p, r),
      netClick: (i) => this.netClick(i),
      probeOf: (i) => this.probeOf(i),
    });
    this.el.tabIndex = -1;
    this.el.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.key === 'p' || e.key === 'P') this.setProbeMode(!this.probeMode);
      if (e.key === 'Escape' && this.probeMode) {
        this.setProbeMode(false);
        return;
      }
      if (e.key === 'Escape' || e.key === 'Backspace') {
        e.preventDefault();
        this.up();
      }
    });
    settings.onChange(() => {
      this.analyzer.radix = settings.radix;
      this.view.radix = settings.radix;
      this.inspector.radix = settings.radix;
      this.refresh();
    });
    this.view.radix = settings.radix;
    this.inspector.radix = settings.radix;
    new ResizeObserver(() => this.view.fit()).observe(this.canvas);
  }

  onChange(f: () => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  onNavigate(f: (path: string[]) => void): () => void {
    this.navListeners.add(f);
    return () => this.navListeners.delete(f);
  }

  /** Replace the schematic with a bespoke widget (null returns to schematic mode). */
  showWidget(w: Widget | null): void {
    if (this.widget) {
      this.widget.w.destroy?.();
      this.widget.host.remove();
      this.widget = null;
    }
    this.el.classList.toggle('widget-mode', !!w);
    if (!w) return;
    this.stopAnim();
    this.stopClock();
    const host = h('div', { class: 'widget-host' }, w.el);
    this.canvas.append(host);
    this.widget = { w, host };
  }

  load(scene: Scene): void {
    this.edgeHooks.clear();
    this.showWidget(null);
    this.stopAnim();
    this.stopClock();
    closePopover();
    this.scene = scene;
    const level = needsSwitchLevel(scene.root) ? 'switch' : 'gate';
    const design = flatten(scene.root, { mode: level });
    const sim: Sim = level === 'switch' ? new SwitchSim(design) : new GateSim(design);
    for (const [k, v] of Object.entries(scene.inputs ?? {})) sim.setInput(k, v);
    sim.reset(scene.powerOn ?? 'zero');
    sim.settle();
    this.sim = sim;
    this.edge = null;
    this.cycles = 0;
    this.rootCtx = new ViewCtx(sim, design.root);
    this.lastSettle = null;
    this.period = null;
    this.lateEvents = 0;
    this.setProbeMode(false);
    this.initAnalyzer();
    this.goTo(scene.path ?? [], false);
    this.buildControls();
    this.panels.forEach((p) => { p.destroy?.(); p.el.remove(); });
    this.view.highlight(scene.highlight ?? []);
    this.panels = (scene.panels ?? []).map((f) => f(this));
    for (const p of this.panels) this.canvas.append(p.el);
    const docked = this.panels.filter((p) => p.el.dataset.dock === 'right');
    this.view.insetRight = docked.length ? Math.max(...docked.map((p) => p.el.getBoundingClientRect().width)) + 24 : 0;
    this.view.fit();
    this.refresh();
  }

  /** Navigate to a path of instance names from the root. */
  goTo(path: string[], notify = true): void {
    if (!this.rootCtx) return;
    this.closeLeaf();
    let ctx = this.rootCtx;
    let leafName: string | null = null;
    for (let i = 0; i < path.length; i++) {
      const name = path[i];
      const c = ctx.child(name);
      if (!c) {
        const def = ctx.node.children?.get(name)?.def;
        if (def && (def.prim === 'nmos' || def.prim === 'pmos') && i === path.length - 1) leafName = name;
        break;
      }
      ctx = c;
    }
    this.ctx = ctx;
    this.selected = null;
    this.view.show(ctx, ctx === this.rootCtx);
    if (ctx === this.rootCtx && this.scene) this.view.highlight(this.scene.highlight ?? []);
    if (leafName) this.openLeaf(leafName);
    this.renderCrumbs();
    this.showInspector();
    if (notify) this.navListeners.forEach((f) => f(this.path));
  }

  get path(): string[] {
    const p = this.ctx?.path ?? [];
    return this.leaf ? [...p, this.leaf.name] : p;
  }

  open(child: string): void {
    if (!this.ctx) return;
    const def = this.ctx.node.children?.get(child)?.def;
    if (def && (def.prim === 'nmos' || def.prim === 'pmos')) {
      this.openLeaf(child);
      this.renderCrumbs();
      this.showInspector();
      this.navListeners.forEach((f) => f(this.path));
      return;
    }
    if (!this.ctx.canOpen(child)) return;
    this.goTo([...this.ctx.path, child]);
  }

  up(): void {
    if (this.leaf) {
      this.closeLeaf();
      this.renderCrumbs();
      this.navListeners.forEach((f) => f(this.path));
      return;
    }
    if (this.ctx?.parent) this.goTo(this.ctx.parent.path);
  }

  select(child: string | null): void {
    this.selected = child;
    this.showInspector();
  }

  private openLeaf(name: string): void {
    if (!this.leafFactory || !this.ctx) return;
    const ctx = this.ctx;
    const def = ctx.node.children!.get(name)!.def;
    const widget = this.leafFactory(def, () => ctx.transistorGate(name));
    const host = h('div', { class: 'widget-host' }, widget.el);
    widget.el = host;
    this.canvas.append(host);
    this.leaf = { name, widget };
    this.levelBadge.textContent = 'level: a single transistor';
  }

  private closeLeaf(): void {
    if (!this.leaf) return;
    this.leaf.widget.destroy?.();
    this.leaf.widget.el.remove();
    this.leaf = null;
  }

  // ---- inputs ------------------------------------------------------------------------------

  private clockPort(): string | null {
    const r = this.scene?.root;
    if (!r) return null;
    if (this.scene!.clock) return this.scene!.clock;
    const p = r.ports.find((q) => q.dir === 'in' && (q.clock || q.name === 'clk'));
    return p?.name ?? null;
  }

  setInput(port: string, value: number): void {
    if (!this.sim) return;
    this.sim.setInput(port, value);
    this.propagate();
  }

  setInputs(values: Record<string, number>): void {
    if (!this.sim) return;
    for (const [k, v] of Object.entries(values)) this.sim.setInput(k, v);
    this.propagate();
  }

  getInput(port: string): number {
    return this.sim?.getInput(port) ?? 0;
  }

  /** Packed value of a root port (-1 if any bit is X/Z). */
  value(port: string): number {
    if (!this.sim) return -1;
    return pack(this.sim.getBits(this.sim.design.root.ports[port]));
  }

  toggleInput(port: string): void {
    const v = this.getInput(port) ? 0 : 1;
    if (port === this.clockPort()) this.finishEdge(false);
    const edge = v === 1 && port === this.clockPort();
    if (edge) {
      this.beforeEdge();
      this.cycles++;
      this.sim?.setInput(port, 1);
      this.sim?.settle();
      this.afterEdge();
      this.lastSettle = null;
      this.refresh();
      return;
    }
    this.setInput(port, v);
  }

  private editInput(port: string, anchor: DOMRect): void {
    const p = this.scene!.root.ports.find((q) => q.name === port)!;
    editNumber(anchor, port, p.width, this.getInput(port), (v) => this.setInput(port, v));
  }

  /**
   * One full clock cycle. With no fixed period every half waits until the logic has
   * settled; with a period P the rising edge comes every P gate delays whether or not
   * the logic is done (which is how real hardware fails when overclocked).
   */
  private cycle(clk: string): void {
    this.rise(clk);
    completeEdge(this.sim!, this.edge!);
    this.fall();
  }

  /** Raise the clock (the edge hooks' `before` runs first); the logic has not moved yet. */
  private rise(clk: string): void {
    const sim = this.sim!;
    let end: number | null = null;
    if (this.period && sim.runUntil) {
      const P = this.period;
      const E = Math.max(sim.time, this.nextEdge);
      sim.runUntil(E);
      this.lateEvents = sim.busy() ? 1 : 0;
      if (this.lateEvents) {
        this.lateCount++;
        this.analyzer.markLate(E);
      }
      end = E + Math.ceil(P / 2);
      this.edgePeriod = P;
    }
    this.beforeEdge();
    this.edge = riseEdge(sim, clk, end);
    this.changeStart = this.edge.start;
    this.cycles++;
  }

  /** End of the high phase: the edge hooks' `after`, then the falling half of the cycle. */
  private fall(): void {
    const sim = this.sim!;
    const e = this.edge!;
    this.edge = null;
    this.afterEdge();
    if (e.end !== null) {
      // e.start is the edge time E; the next one comes at E + P (the period the edge started with).
      const P = this.edgePeriod;
      sim.setInput(e.clk, 0);
      sim.runUntil!(e.start + P);
      this.nextEdge = e.start + P;
      this.lastSettle = null;
      return;
    }
    // Measure the rising edge: that is when the flip-flops launch new values through the logic.
    this.lastSettle = sim.time - e.start;
    sim.setInput(e.clk, 0);
    sim.settle();
  }

  /** A rising edge is being played one gate delay at a time. */
  get inEdge(): boolean {
    return !!this.edge;
  }

  /** Slow mode: raise the clock and show the instant of the edge; edgeStep() plays the rest. */
  startEdge(): boolean {
    const clk = this.clockPort();
    if (!clk || !this.sim) return false;
    this.finishEdge(false);
    this.stopAnim();
    this.rise(clk);
    this.refresh();
    return true;
  }

  /** Slow mode: one gate delay of the edge in progress. Returns true while it is still propagating. */
  edgeStep(flowMs: number): boolean {
    if (!this.edge || !this.sim) return false;
    const more = stepEdge(this.sim, this.edge);
    if (!more) this.fall();
    this.refreshFlowing(flowMs);
    return more;
  }

  /** Complete a slow-mode edge at once (before anything else touches the clock). */
  finishEdge(refresh = true): void {
    if (!this.edge || !this.sim) return;
    completeEdge(this.sim, this.edge);
    this.fall();
    if (refresh) this.refresh();
  }

  /** One full clock cycle, then refresh (changed wires show a travelling front for flowMs). */
  pulse(flowMs = 0): void {
    const clk = this.clockPort();
    if (!clk || !this.sim) return;
    this.finishEdge(false);
    this.stopAnim();
    this.cycle(clk);
    this.refreshFlowing(flowMs);
  }

  /** Run n clock cycles as fast as possible, refreshing the view once at the end. */
  runCycles(n: number, stop?: () => boolean, flowMs = 0): number {
    const clk = this.clockPort();
    if (!clk || !this.sim) return 0;
    this.finishEdge(false);
    this.stopAnim();
    let i = 0;
    for (; i < n && !(stop && stop()); i++) this.cycle(clk);
    this.lastSettle = null;
    this.refreshFlowing(flowMs);
    return i;
  }

  /** Clock period in gate delays (null: wait for the logic to settle at every edge). */
  setPeriod(p: number | null): void {
    this.period = p && p > 1 ? Math.round(p) : null;
    if (this.sim) this.nextEdge = this.sim.time;
    this.lateEvents = 0;
    this.lateCount = 0;
    this.updateControls();
  }

  // ---- probes & timing ---------------------------------------------------------------------

  private initAnalyzer(): void {
    const sim = this.sim!;
    const gate = sim.kind === 'gate';
    this.timingBtn.hidden = !gate;
    this.probeBtn.hidden = !gate;
    if (!gate) {
      this.showAnalyzer(false, false);
      return;
    }
    const r = this.scene!.root;
    const clk = this.clockPort();
    const ports = [...r.ports].sort((a, b) => Number(b.name === clk) - Number(a.name === clk)).slice(0, 8);
    this.analyzer.radix = settings.radix;
    this.analyzer.setLanes(ports.map((p) => ({
      label: p.name, title: p.name, nets: [...sim.design.root.ports[p.name]], width: p.width,
      color: -1, probe: false, clock: p.name === clk,
    })));
    this.analyzer.attach(sim);
    this.showAnalyzer(!!this.scene!.analyzer || settings.analyzer, false);
  }

  showAnalyzer(on: boolean, remember = true): void {
    this.el.classList.toggle('with-analyzer', on);
    this.timingBtn.classList.toggle('on', on);
    if (remember) settings.set('analyzer', on);
    if (on) this.analyzer.update();
  }

  private setProbeMode(on: boolean): void {
    if (on && this.sim?.kind !== 'gate') return;
    this.probeMode = on;
    this.probeBtn.classList.toggle('on', on);
    this.canvas.classList.toggle('probing', on);
    if (on && !this.el.classList.contains('with-analyzer')) this.showAnalyzer(true);
  }

  /** Flat nets of a net in the current view, if it lives in the scene's own simulation. */
  private flatNets(idx: number): number[] | null {
    const ctx = this.ctx;
    if (!ctx || ctx.sim !== this.sim) return null;
    return ctx.node.nets?.[idx] ? [...ctx.node.nets[idx]] : null;
  }

  private probeOf(idx: number): { color: number; label: string } | null {
    const nets = this.flatNets(idx);
    const lane = nets && this.analyzer.probeFor(netKey(nets));
    return lane ? { color: lane.color, label: lane.label } : null;
  }

  /** In probe mode a click on a wire adds (or removes) a probe instead of selecting. */
  private netClick(idx: number): boolean {
    if (!this.probeMode || !this.ctx) return false;
    const nets = this.flatNets(idx);
    if (!nets) {
      this.flash = 'This level is a separate lock-step simulation: probe its ports from the level above.';
      this.updateControls();
      return true;
    }
    const hit = this.analyzer.probeFor(netKey(nets));
    if (hit) {
      this.analyzer.remove(hit.id);
      return true;
    }
    const nl = netlistOf(this.ctx.def)!;
    const net = nl.nets[idx];
    const name = net.name ?? net.ends.find((e) => !e.includes('.')) ?? net.ends[0];
    const where = this.ctx.path;
    this.analyzer.add({
      label: [...where.slice(-1), name].join('.'), title: [...where, name].join('.'),
      nets, width: nets.length, color: this.analyzer.nextColor(), probe: true, clock: false,
    });
    return true;
  }

  private propagate(): void {
    if (!this.sim) return;
    this.changeStart = this.sim.time;
    if ((settings.animate || this.scene?.animate) && this.sim.kind === 'gate') {
      this.startAnim();
    } else {
      this.sim.settle();
      this.lastSettle = this.sim.time - this.changeStart;
      this.refresh();
    }
  }

  private startAnim(): void {
    this.stopAnim();
    const sim = this.sim!;
    const tick = () => {
      if (!sim.step()) {
        this.stopAnim();
        this.lastSettle = sim.time - this.changeStart;
      }
      this.refreshFlowing(950 / settings.speed);
    };
    tick();
    if (sim.busy()) this.anim = setInterval(tick, 1000 / settings.speed);
  }

  stopAnim(): void {
    if (this.anim) clearInterval(this.anim);
    this.anim = null;
  }

  /** Stop the stage's own Run (the CPU panel's slow mode takes over the clock). */
  stopClock(): void {
    this.runBtn?.classList.remove('on');
    if (this.runClock) clearInterval(this.runClock);
    this.runClock = null;
  }

  /** Step one gate delay (works whether or not animation is on). */
  stepOnce(): void {
    if (!this.sim) return;
    this.stopAnim();
    if (!this.sim.step()) this.lastSettle = this.sim.time - this.changeStart;
    this.refreshFlowing(Math.max(350, 950 / settings.speed));
  }

  /** Refresh after one gate delay: changed wires show the new value travelling as a front. */
  private refreshFlowing(ms: number): void {
    this.view.flowMs = ms;
    this.refresh();
    this.view.flowMs = 0;
  }

  private buildControls(): void {
    const c = this.controls;
    c.replaceChildren();
    const root = this.scene!.root;
    const ins = inPorts(root).filter((p) => !(this.scene!.hiddenInputs ?? []).includes(p.name));
    const clk = this.clockPort();
    if (ins.length) c.append(h('span', { class: 'label' }, 'Inputs'));
    for (const p of ins) {
      if (p.name === clk) continue;
      c.append(p.width === 1 ? this.bitToggle(p) : this.numInput(p));
    }
    const outs = outPorts(root);
    if (outs.length) {
      // One group, so the label wraps together with its chips.
      c.append(h('span', { class: 'ctl-group' }, h('span', { class: 'label', style: 'margin-left:6px' }, 'Outputs'),
        outs.map((p) => (p.width === 1 ? this.bitLamp(p) : this.numOutput(p)))));
    }
    if (clk) {
      c.append(h('span', { class: 'label', style: 'margin-left:6px' }, 'Clock'));
      c.append(this.bitToggle(root.ports.find((q) => q.name === clk)!));
      c.append(h('button', { class: 'btn sm', title: 'One full clock cycle', onclick: () => this.pulse() }, icon('clock', 14), 'Pulse'));
      const run = this.runBtn = h('button', { class: 'btn sm toggle', title: 'Run the clock' }, icon('play', 14), 'Run');
      run.addEventListener('click', () => {
        if (this.runClock) {
          this.stopClock();
        } else {
          this.runClock = setInterval(() => this.pulse(), 500);
          run.classList.add('on');
        }
      });
      c.append(run);
      if (this.sim?.runUntil) {
        const per = h('input', { type: 'text', inputmode: 'numeric', placeholder: 'settle', 'aria-label': 'Clock period in gate delays', value: this.period ?? '' }) as HTMLInputElement;
        per.addEventListener('change', () => {
          const n = parseInt(per.value, 10);
          this.setPeriod(Number.isFinite(n) ? n : null);
          per.value = this.period ? String(this.period) : '';
        });
        c.append(h('label', { class: 'period', title: 'Clock period in gate delays. Empty: each edge waits until the logic has settled. A number: edges come on time, settled or not.' }, 'period', per));
      }
    }
    if (this.sim?.kind === 'gate') {
      c.append(h('button', { class: 'btn sm ghost', title: 'Advance one gate delay', onclick: () => this.stepOnce() }, icon('step', 14), 'Step'));
    }
    c.append(h('button', { class: 'btn sm ghost', title: 'Power-cycle the circuit', onclick: () => this.powerCycle() }, icon('reset', 14), 'Reset'));
    c.append(this.status);
  }

  powerCycle(): void {
    if (!this.sim || !this.scene) return;
    this.stopAnim();
    this.stopClock();
    this.edge = null;
    this.cycles = 0;
    this.sim.reset(this.scene.powerOn ?? 'zero');
    this.sim.settle();
    this.lastSettle = null;
    this.nextEdge = this.sim.time;
    this.lateEvents = 0;
    this.analyzer.attach(this.sim);
    this.refresh();
  }

  private bitToggle(p: PortDef): HTMLElement {
    const el = h('button', { class: 'in-toggle', 'data-port': p.name, title: `Toggle ${p.name}`, onclick: () => this.toggleInput(p.name) },
      h('span', { class: 'knob' }), p.name);
    return el;
  }

  private numInput(p: PortDef): HTMLElement {
    const inp = h('input', { type: 'text', 'data-port': p.name, spellcheck: 'false', 'aria-label': p.name }) as HTMLInputElement;
    inp.addEventListener('change', () => {
      const t = inp.value.trim().toLowerCase();
      const n = t.startsWith('0x') ? parseInt(t.slice(2), 16) : t.startsWith('0b') ? parseInt(t.slice(2), 2) : parseInt(t, 10);
      if (!Number.isNaN(n)) this.setInput(p.name, ((n % (mask(p.width) + 1)) + mask(p.width) + 1) % (mask(p.width) + 1));
    });
    const bump = (d: number) => this.setInput(p.name, (this.getInput(p.name) + d + mask(p.width) + 1) % (mask(p.width) + 1));
    return h('span', { class: 'in-num' }, p.name,
      h('button', { title: '−1', onclick: () => bump(-1) }, '−'), inp, h('button', { title: '+1', onclick: () => bump(1) }, '+'),
      h('button', { title: 'Edit bits', onclick: (e: Event) => this.editInput(p.name, (e.currentTarget as HTMLElement).getBoundingClientRect()) }, '⋯'));
  }

  /** A 1-bit output: a lamp, like an input toggle but not clickable. */
  private bitLamp(p: PortDef): HTMLElement {
    return h('span', { class: 'out-lamp', 'data-out': p.name, title: `${p.name} (output)` }, h('span', { class: 'knob' }), p.name);
  }

  /** A bus output: its value; click to cycle hex → bin → dec → signed for this output. */
  private numOutput(p: PortDef): HTMLElement {
    const val = h('button', { class: 'v', title: 'Click to change the radix of this output' });
    val.addEventListener('click', () => {
      const order: Radix[] = ['hex', 'bin', 'dec', 'sdec'];
      this.outRadix.set(p.name, order[(order.indexOf(this.outRadixOf(p)) + 1) % order.length]);
      this.updateControls();
    });
    return h('span', { class: 'out-num', 'data-out': p.name }, p.name, val);
  }

  private outRadixOf(p: PortDef): Radix {
    return this.outRadix.get(p.name) ?? (settings.radix === 'bin' && p.width > 8 ? 'hex' : settings.radix);
  }

  private updateControls(): void {
    if (!this.sim) return;
    const root = this.sim.design.root;
    for (const el of this.controls.querySelectorAll<HTMLElement>('[data-out]')) {
      const p = this.scene!.root.ports.find((q) => q.name === el.dataset.out)!;
      const bits = this.sim.getBits(root.ports[p.name]);
      const x = bits.some((b) => b !== B0 && b !== B1);
      el.classList.toggle('vx', x);
      if (p.width === 1) el.classList.toggle('v1', bits[0] === B1);
      else el.querySelector('.v')!.textContent = formatBits(bits, this.outRadixOf(p));
    }
    for (const el of this.controls.querySelectorAll<HTMLElement>('.in-toggle')) {
      const v = this.getInput(el.dataset.port!);
      el.classList.toggle('v1', v === 1);
    }
    for (const el of this.controls.querySelectorAll<HTMLInputElement>('.in-num input')) {
      const p = this.scene!.root.ports.find((q) => q.name === el.dataset.port)!;
      if (document.activeElement !== el) el.value = formatNumber(this.getInput(p.name), p.width, settings.radix === 'bin' && p.width > 8 ? 'hex' : settings.radix);
    }
    const sim = this.sim;
    const busy = sim.busy();
    let msg: string;
    if (this.flash) {
      msg = this.flash;
      this.flash = null;
    } else if (this.period && this.cycles && !this.anim && !sim.unstable) {
      msg = this.lateCount
        ? `period ${this.period}: ${this.lateCount} edge${this.lateCount > 1 ? 's' : ''} came while the logic was still switching`
        : `period ${this.period}: logic settled before every edge`;
    } else if (sim.unstable) msg = 'race detected: resolved (metastability)';
    else if (busy) msg = `propagating… t = ${sim.time - this.changeStart}`;
    else if (this.lastSettle !== null && sim.kind === 'gate') msg = `${this.clockPort() && this.cycles ? 'clock edge ' : ''}settled in ${this.lastSettle} gate delay${this.lastSettle === 1 ? '' : 's'}`;
    else msg = sim.kind === 'switch' ? 'switch level: solved instantly' : 'settled';
    const warn = sim.unstable || (!!this.period && this.lateCount > 0);
    this.status.replaceChildren(h('span', { class: `pulse${busy ? ' busy' : ''}${warn ? ' warn' : ''}` }), msg);
  }

  // ---- rendering --------------------------------------------------------------------------

  refresh(): void {
    if (!this.ctx) return;
    this.view.update();
    this.leaf?.widget.update?.();
    this.panels.forEach((p) => p.update?.());
    this.analyzer.update();
    this.showInspector();
    this.updateControls();
    if (!this.leaf) this.levelBadge.textContent = `level: ${LEVEL_NAME[this.levelOf()] ?? 'blocks'}`;
    this.listeners.forEach((f) => f());
  }

  private levelOf(): string {
    const nl = this.ctx ? netlistOf(this.ctx.def) : undefined;
    if (!nl) return 'gate';
    if (nl.level === 'switch') return 'transistor';
    const kinds = nl.instances.filter((i) => i.def.prim !== 'alias').map((i) => i.def);
    if (kinds.every((d) => d.prim === 'nand')) return 'gate';
    return this.ctx!.def.category;
  }

  private showInspector(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const sel = this.leaf ? this.leaf.name : this.selected;
    const child = sel ? ctx.node.children?.get(sel) : undefined;
    if (child) {
      this.inspector.show({
        def: child.def, instance: sel!,
        portBits: (p) => ctx.sim.getBits(child.ports[p]),
        canOpen: !this.leaf && (ctx.canOpen(sel!) || child.def.prim === 'nmos' || child.def.prim === 'pmos'),
        onOpen: () => this.open(sel!),
      });
    } else {
      this.inspector.show({ def: ctx.def, portBits: (p) => ctx.portBits(p), instance: ctx.path[ctx.path.length - 1] });
    }
  }

  private renderCrumbs(): void {
    const c = this.crumbs;
    c.replaceChildren();
    if (!this.rootCtx) return;
    const chain: { label: string; kind: string; path: string[] }[] = [];
    let ctx: ViewCtx | null = this.ctx;
    while (ctx) {
      const name = ctx.path[ctx.path.length - 1];
      chain.unshift({ label: name ?? ctx.def.name, kind: name ? ctx.def.name : '', path: ctx.path });
      ctx = ctx.parent;
    }
    if (this.leaf) {
      const def = this.ctx!.node.children!.get(this.leaf.name)!.def;
      chain.push({ label: this.leaf.name, kind: def.name, path: this.path });
    }
    chain.forEach((item, i) => {
      if (i) c.append(h('span', { class: 'sep' }, '›'));
      const last = i === chain.length - 1;
      c.append(h('button', { class: last ? 'cur' : '', onclick: () => (last ? null : this.goTo(item.path)) },
        item.label, item.kind ? h('span', { class: 'kind' }, item.kind) : null));
    });
  }

  /** Open `path` and highlight (and bring into view) the instance `name` inside it. */
  reveal(path: string[], name: string): void {
    this.goTo(path);
    this.view.highlight([name]);
    this.view.focusInst(name);
  }

  /** Highlight instances in the current view (empty list clears). */
  highlight(names: string[], focus = false): void {
    this.view.highlight(names, focus);
  }

  /** Colour nets of the current view (index in its netlist → classes); cleared on navigation. */
  markNets(marks: Map<number, string>): void {
    this.view.markNets(marks);
  }

  /** Reserve screen space on the right for a docked panel and refit. */
  setInset(px: number): void {
    this.view.insetRight = px;
    this.view.fit();
  }

  /** Bits of a root port as 0/1 booleans (helper for challenges). */
  high(port: string): boolean {
    return this.sim?.getBits(this.sim.design.root.ports[port])[0] === B1;
  }

  destroy(): void {
    this.showWidget(null);
    this.stopAnim();
    this.stopClock();
    this.panels.forEach((p) => p.destroy?.());
    this.leaf?.widget.destroy?.();
    closePopover();
  }
}
