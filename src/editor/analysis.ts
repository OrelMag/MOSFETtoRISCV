// The sandbox's analysis tools, plugged into the editor through its registries (no edits to the
// editing code): probes and the timing panel (a LogicAnalyzer docked under the canvas), static
// timing with the critical path drawn on the chip, and lint warnings with hints on open inputs.
//
// Lanes follow what the user drew (probes.ts): after every rebuild of the simulator they are
// resolved again and the analyzer rebinds to the new simulation, keeping what it recorded. Each
// chip keeps its own lanes for the session. Everything here is gate level: the switch-level
// solver has no time axis.

import { instPort, type Vec } from '../sim/geometry';
import type { Sim } from '../sim/sim';
import { CLK_TO_Q, PS_PER_NAND, SETUP } from '../sim/timing';
import { h, icon, s } from '../ui/dom';
import { settings } from '../ui/settings';
import { LogicAnalyzer, type Lane } from '../view/analyzer';
import { textWidth } from '../view/route';
import type { Compiled } from './compile';
import { type Editor, registerDiagSource, registerEditorPlugin, registerToolbarAction } from './editor';
import type { Hit } from './geom';
import { lintChip, type LintResult } from './lint';
import type { ChipDoc } from './model';
import { type ProbeTarget, resolveProbe, sameTarget } from './probes';
import { registerPropsSection } from './props';
import type { EditorSim } from './runtime';
import { type ChipTiming, chipTiming } from './sta';

/** Port lanes a chip starts with (the analyzer gets crowded beyond that). */
const PIN_LANES = 8;

interface ChipLanes {
  lanes: { target: ProbeTarget; color: number; probe: boolean; clock: boolean }[];
  /** Pins whose lane the user removed (not added back automatically). */
  dismissed: Set<string>;
}

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

class Analysis {
  readonly la = new LogicAnalyzer();
  probing = false;
  open = false;
  showCrit = false;
  /** Lane id → what it follows (current chip). */
  private targets = new Map<number, ProbeTarget>();
  private chips = new Map<string, ChipLanes>();
  private dismissed = new Set<string>();
  private chip = '';
  private esim: EditorSim | null = null;
  private sim: Sim | null = null;
  private resets = 0;
  private internal = false;
  private note: HTMLElement;
  private gFlags: SVGGElement;
  private gCrit: SVGGElement;
  private gHints: SVGGElement;
  private timingEl = h('section', { class: 'sb-sec-props sb-timing' });
  private timingKey: unknown[] = [];
  private timing: ChipTiming | null = null;
  private timingTimer: ReturnType<typeof setTimeout> | null = null;
  private lintCache: { built: Compiled | null; doc: ChipDoc | null; r: LintResult } = { built: null, doc: null, r: { diags: [], open: [] } };
  private off: (() => void)[] = [];

  constructor(private ed: Editor) {
    this.note = h('div', { class: 'sb-la-note' });
    ed.slots.bottom.append(this.la.el, this.note);
    this.la.onClose = () => this.setOpen(false);
    this.la.onLanesChange = () => this.lanesChanged();
    const svg = ed.view.svg;
    this.gCrit = s('g', { class: 'ed-crit-wires' });
    this.gHints = s('g', { class: 'ed-open-ins' });
    this.gFlags = s('g', { class: 'probes ed-probes' });
    // Under the wires: a halo; over everything but the editing overlays: hints and flags.
    svg.insertBefore(this.gCrit, svg.querySelector('g.wires'));
    svg.insertBefore(this.gHints, svg.querySelector('g.ed-over'));
    svg.insertBefore(this.gFlags, svg.querySelector('g.ed-over'));
    ed.tools.onPress = (hit, e) => this.press(hit, e);
    this.off.push(ed.onChange(() => this.sync(true)), ed.onSimChange(() => this.sync(false)));
    const key = (e: KeyboardEvent) => {
      // Esc is also the editor's (cancel, clear the selection): it leaves probe mode as well.
      if (e.key === 'Escape' && this.probing && !typing(e.target)) return this.setProbing(false);
      if (typing(e.target) || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if ((e.target as HTMLElement | null)?.closest?.('.sb-help')) return;
      if (e.key === 'p' || e.key === 'P') { e.preventDefault(); this.setProbing(!this.probing); }
    };
    document.addEventListener('keydown', key);
    this.off.push(() => document.removeEventListener('keydown', key), settings.onChange(() => { this.la.radix = settings.radix; this.la.update(); }));
    this.la.radix = settings.radix;
  }

  destroy(): void {
    this.off.forEach((f) => f());
    if (this.sim) this.sim.onTrace = undefined;
    if (this.timingTimer) clearTimeout(this.timingTimer);
    this.ed.tools.onPress = null;
  }

  private get gate(): boolean {
    return this.ed.compiled?.mode !== 'switch';
  }

  // ---- modes ---------------------------------------------------------------------------------

  setOpen(on: boolean): void {
    this.open = on;
    if (!on && this.probing) this.setProbing(false);
    this.layout();
    this.ed.renderActions();
  }

  setProbing(on: boolean): void {
    if (on && !this.gate) {
      this.ed.toast('Probes record gate delays: this chip is solved at switch level, without time');
      on = false;
    }
    this.probing = on;
    this.ed.el.querySelector('.sb-canvas')?.classList.toggle('probing', on);
    if (on && !this.open) this.open = true;
    this.layout();
    this.ed.renderActions();
    if (on) this.ed.toast('Probe mode: click a wire or pointer to record it, again to remove it (P or Esc to leave)');
  }

  private layout(): void {
    const sw = !this.gate;
    this.la.el.classList.toggle('open', this.open && !sw);
    this.note.classList.toggle('open', this.open && sw);
    this.note.replaceChildren(h('span', null, 'Switch level: transistors are solved as switches, with no time between events, so there is no timing diagram. Probes and the timing panel work on gate-level chips.'),
      h('button', { class: 'btn ghost icon-only sm', title: 'Close', 'aria-label': 'Close', onclick: () => this.setOpen(false) }, icon('close', 14)));
    this.gFlags.style.display = this.open || this.probing ? '' : 'none';
    if (this.open) this.la.update();
  }

  // ---- lanes ---------------------------------------------------------------------------------

  /** Follow the editor: another chip, a rebuilt or reset simulation, new pins. */
  private sync(structural: boolean): void {
    const ed = this.ed;
    const es = ed.sim;
    if (!ed.compiled) return;
    let simChanged = true;
    if (ed.chipId !== this.chip) {
      if (this.chip) this.chips.set(this.chip, this.save());
      this.chip = ed.chipId;
      const saved = this.chips.get(this.chip);
      this.dismissed = saved?.dismissed ?? new Set();
      this.attach(saved);
      this.layout();
    } else if (es !== this.esim || es.sim !== this.sim || es.resets !== this.resets) {
      const rebuilt = es === this.esim && es.resets === this.resets && this.sim && es.sim?.kind === 'gate';
      if (rebuilt) this.rebind();
      else this.attach(this.save());
    } else simChanged = false;
    if (structural || simChanged) {
      this.addPins();
      this.layout();
      this.scheduleTiming();
    }
    if (this.open) this.la.update();
    if (structural || this.flagsStale) this.drawOverlays();
  }

  /** Created after the editor's first refresh: show what this adds right away. */
  start(): void {
    this.sync(true);
    this.ed.view.setDiags(this.ed.diags);
    this.ed.props.rebuild();
  }

  private flagsStale = false;

  /** The lanes of the current chip, to be restored when it is open again. */
  private save(): ChipLanes {
    return {
      lanes: this.la.lanes.flatMap((l) => {
        const t = this.targets.get(l.id);
        return t ? [{ target: t, color: l.color, probe: l.probe, clock: l.clock }] : [];
      }),
      dismissed: this.dismissed,
    };
  }

  /** Start recording the editor's simulation with these lanes (a new chip, a power cycle). */
  private attach(saved: ChipLanes | undefined): void {
    const es = this.ed.sim;
    if (this.sim) this.sim.onTrace = undefined;
    this.esim = es;
    this.resets = es.resets;
    const sim = es.sim?.kind === 'gate' ? es.sim : null;
    this.sim = sim;
    const want = saved?.lanes ?? this.pinLanes();
    this.internal = true;
    this.targets.clear();
    const lanes: Omit<Lane, 'id' | 'key'>[] = [];
    const ts: ProbeTarget[] = [];
    for (const w of want) {
      const r = sim && es.built ? resolveProbe(w.target, this.ed.doc, es.built, sim.design) : null;
      // Without a simulation the lanes wait (kept with no nets until the next build).
      if (!r && sim) continue;
      lanes.push({ label: r?.label ?? '…', title: this.title(r?.label ?? ''), nets: r?.nets ?? [], width: r?.nets.length ?? 1, color: w.color, probe: w.probe, clock: w.clock });
      ts.push(r?.target ?? w.target);
    }
    this.la.setLanes(lanes);
    this.la.lanes.forEach((l, i) => this.targets.set(l.id, ts[i]));
    if (sim) this.la.attach(sim);
    this.internal = false;
    this.flagsStale = true;
  }

  /** The simulator was rebuilt (connectivity changed): same lanes, new net numbers. */
  private rebind(): void {
    const es = this.ed.sim;
    const sim = es.sim!;
    const built = es.built!;
    this.sim = sim;
    this.internal = true;
    this.la.rebind(sim, (l) => {
      const t = this.targets.get(l.id);
      const r = t ? resolveProbe(t, this.ed.doc, built, sim.design) : null;
      if (!r) { this.targets.delete(l.id); return null; }
      this.targets.set(l.id, r.target);
      if (l.probe) { l.label = r.label; l.title = this.title(r.label); }
      return r.nets;
    });
    this.internal = false;
    this.flagsStale = true;
  }

  private title(label: string): string {
    return `${this.ed.doc.name}.${label}`.replace(/\s+/g, '_');
  }

  /** Lanes for the chip's pins: clocks first, then inputs and outputs in port order. */
  private pinLanes(): ChipLanes['lanes'] {
    const doc = this.ed.doc;
    const order = (this.ed.compiled?.def.ports ?? []).map((p) => p.name);
    const pins = doc.pins.filter((p) => order.includes(p.name))
      .sort((a, b) => Number(b.kind === 'clock') - Number(a.kind === 'clock') || order.indexOf(a.name) - order.indexOf(b.name));
    return pins.slice(0, PIN_LANES).map((p) => ({ target: { pin: p.id }, color: -1, probe: false, clock: p.kind === 'clock' }));
  }

  /** A pin placed since: a lane of its own (while there is room and it was not removed). */
  private addPins(): void {
    const sim = this.sim, built = this.ed.sim.built;
    if (!sim || !built) return;
    const have = new Set([...this.targets.values()].flatMap((t) => ('pin' in t ? [t.pin] : [])));
    const pinCount = have.size;
    let room = PIN_LANES - pinCount;
    for (const w of this.pinLanes()) {
      const id = (w.target as { pin: string }).pin;
      if (room <= 0 || have.has(id) || this.dismissed.has(id)) continue;
      const r = resolveProbe(w.target, this.ed.doc, built, sim.design);
      if (!r) continue;
      this.internal = true;
      const lane = this.la.add({ label: r.label, title: this.title(r.label), nets: r.nets, width: r.nets.length, color: -1, probe: false, clock: w.clock });
      this.internal = false;
      this.targets.set(lane.id, r.target);
      room--;
    }
  }

  /** Lanes removed in the panel (× or "Clear probes"). */
  private lanesChanged(): void {
    if (!this.internal) {
      const ids = new Set(this.la.lanes.map((l) => l.id));
      for (const [id, t] of this.targets) {
        if (ids.has(id)) continue;
        if ('pin' in t) this.dismissed.add(t.pin);
        this.targets.delete(id);
      }
    }
    this.drawFlags();
  }

  /** In probe mode, a click on a wire, pointer or pin adds its lane (or removes it). */
  private press(hit: Hit, e: PointerEvent): boolean {
    if (!this.probing) return false;
    const flag = (e.target as Element | null)?.closest?.('.probe-flag');
    if (flag) {
      this.la.remove(Number(flag.getAttribute('data-lane')));
      return true;
    }
    const doc = this.ed.doc;
    let target: ProbeTarget;
    if (hit.k === 'wire') target = { wires: [hit.id] };
    else if (hit.k === 'label') target = { pointer: doc.labels.find((l) => l.id === hit.id)?.name ?? '' };
    // Pins keep toggling in probe mode: they have lanes of their own from the start.
    else return false;
    const sim = this.sim, built = this.ed.sim.built;
    if (!sim || !built) {
      this.ed.toast(this.gate ? 'Not simulated yet: finish the wiring (see the diagnostics)' : 'Switch level: nothing to record', 'err');
      return true;
    }
    for (const [id, t] of this.targets) {
      if (sameTarget(t, target, doc, built)) {
        this.la.remove(id);
        return true;
      }
    }
    const r = resolveProbe(target, doc, built, sim.design);
    if (!r) {
      this.ed.toast('This wire is not on a working net (see the diagnostics)', 'err');
      return true;
    }
    this.internal = true;
    const lane = this.la.add({
      label: r.label, title: this.title(r.label), nets: r.nets, width: r.nets.length, color: this.la.nextColor(), probe: true, clock: false,
    });
    this.internal = false;
    this.targets.set(lane.id, r.target);
    this.drawFlags();
    return true;
  }

  // ---- drawing on the canvas -----------------------------------------------------------------

  private drawOverlays(): void {
    this.flagsStale = false;
    this.drawFlags();
    this.drawHints();
    this.drawCrit();
  }

  /** A flag on every probed net, on its longest drawn segment (or at its pointer). */
  private drawFlags(): void {
    const g = this.gFlags;
    g.replaceChildren();
    const polys = this.ed.view.polys;
    for (const l of this.la.lanes) {
      const t = this.targets.get(l.id);
      if (!l.probe || !t || 'pin' in t) continue;
      let at: Vec | null = null;
      if ('wires' in t) {
        let len = -1;
        for (const id of t.wires) {
          const p = polys.get(id);
          for (let i = 1; p && i < p.length; i++) {
            const [a, b] = [p[i - 1], p[i]];
            const d = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
            if (d > len) { len = d; at = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
          }
        }
      } else at = this.ed.doc.labels.find((q) => q.name === t.pointer)?.at ?? null;
      if (!at) continue;
      const tw = textWidth(l.label, 0.78) + 0.7;
      const f = s('g', { class: `probe-flag p${l.color}`, transform: `translate(${at[0]},${at[1]})`, 'data-lane': String(l.id) });
      f.append(s('title', null, `${l.label}: probe ${this.probing ? '(click to remove)' : ''}`),
        s('circle', { r: 0.42, class: 'probe-tip' }),
        s('path', { d: 'M0,0 L0.9,-1.6', class: 'probe-pole' }),
        s('rect', { x: 0.9, y: -2.65, width: tw, height: 1.2, rx: 0.3 }),
        s('text', { x: 0.9 + tw / 2, y: -1.8, 'text-anchor': 'middle' }, l.label));
      g.append(f);
    }
  }

  /** A small mark on every part input left open (it reads X). */
  private drawHints(): void {
    const g = this.gHints;
    g.replaceChildren();
    const doc = this.ed.doc;
    for (const o of this.lint().open) {
      const p = doc.parts.find((q) => q.id === o.part);
      const def = p && this.ed.defOf(p);
      if (!p || !def) continue;
      let pos: Vec;
      try {
        pos = instPort(def, p.at, p.flip, o.port).pos;
      } catch {
        continue;
      }
      const m = s('g', { class: 'ed-open-in', transform: `translate(${pos[0]},${pos[1]})` });
      m.append(s('title', null, `${o.part}.${o.port} is not connected: it reads X`), s('circle', { r: 0.32 }), s('path', { d: 'M-0.14,-0.14 L0.14,0.14 M0.14,-0.14 L-0.14,0.14' }));
      g.append(m);
    }
  }

  // ---- lint ----------------------------------------------------------------------------------

  lint(): LintResult {
    const ed = this.ed;
    const c = this.lintCache;
    if (c.built !== ed.compiled || c.doc !== ed.doc) {
      this.lintCache = { built: ed.compiled, doc: ed.doc, r: ed.compiled ? lintChip(ed.doc, ed.compiled, ed.view.polys) : { diags: [], open: [] } };
    }
    return this.lintCache.r;
  }

  // ---- static timing -------------------------------------------------------------------------

  /** Timing waits for the chip to stop changing (and for the simulator's flattening). */
  private scheduleTiming(): void {
    if (this.timingTimer) clearTimeout(this.timingTimer);
    this.timingTimer = setTimeout(() => { this.timingTimer = null; this.updateTiming(); }, 200);
  }

  private updateTiming(): void {
    const ed = this.ed, es = ed.sim;
    const c = ed.compiled;
    const design = es.sim && es.sim.kind === 'gate' && es.built?.connKey === c?.connKey ? es.sim.design : null;
    const key = [c, design, this.showCrit];
    if (key.every((k, i) => k === this.timingKey[i])) return;
    this.timingKey = key;
    this.timing = c ? chipTiming(ed.doc, c, design) : null;
    this.renderTiming();
    this.drawCrit();
  }

  timingSection(): HTMLElement {
    this.scheduleTiming();
    return this.timingEl;
  }

  private renderTiming(): void {
    const el = this.timingEl;
    const t = this.timing;
    el.replaceChildren(h('h3', null, 'Timing'));
    if (!t) return void el.append(h('p', { class: 'sb-sum' }, 'Computing…'));
    if (!t.ok) return void el.append(h('p', { class: 'sb-sum' }, t.why));
    const r = t.report;
    const maxA = Math.max(1, r.stages[r.stages.length - 1]?.arrival ?? 1);
    let prev = 0;
    const btn = h('button', { class: `btn sm toggle${this.showCrit ? ' on' : ''}`, 'aria-pressed': String(this.showCrit), title: 'Highlight the parts and wires of the longest register-to-register path',
      onclick: () => { this.showCrit = !this.showCrit; this.timingKey = []; this.updateTiming(); } }, icon('wave', 14), this.showCrit ? 'Hide critical path' : 'Show critical path');
    el.append(
      h('div', { class: 'sb-tm-read' },
        h('div', null, h('b', null, String(r.period)), h('span', null, 'NAND delays per cycle')),
        h('div', null, h('b', null, t.mhz >= 1000 ? `${(t.mhz / 1000).toFixed(2)} GHz` : `${t.mhz.toFixed(0)} MHz`), h('span', null, `max clock at ~${PS_PER_NAND} ps / NAND`))),
      h('p', { class: 'sb-sum' }, `clk→q ${CLK_TO_Q} + logic ${r.logic} + setup ${SETUP}. Launch ${r.launch.join('.') || 'an input'}, capture ${r.capture.join('.')}.`),
      h('div', { class: 'tstages sb-tm-stages' }, r.stages.map((st) => {
        const w = Math.max(2, ((st.arrival - prev) / maxA) * 100);
        prev = st.arrival;
        return h('div', { class: 'ts' }, h('span', { class: 'n' }, st.inst || '(chip)'), h('span', { class: 'bar', style: `width:${w}%` }), h('span', { class: 'a' }, String(st.arrival)));
      })),
      ...(r.byCapture.length > 1 ? [h('details', { class: 'sb-tm-caps' }, h('summary', null, `Period needed at each of ${r.byCapture.length} capturing parts`),
        h('ol', null, r.byCapture.slice(0, 12).map((b) => h('li', null, h('span', null, b.inst || '(chip)'), h('b', null, String(b.period))))))] : []),
      h('div', { class: 'sb-btns' }, btn));
  }

  /** The critical path on the canvas: a halo under its wires, its parts and pins outlined. */
  private drawCrit(): void {
    const g = this.gCrit;
    g.replaceChildren();
    const svg = this.ed.view.svg;
    svg.querySelectorAll('.ed-crit').forEach((e) => e.classList.remove('ed-crit'));
    const t = this.timing;
    if (!this.showCrit || !t?.ok) return;
    for (const id of t.path.wires) {
      const p = this.ed.view.polys.get(id);
      if (p) g.append(s('path', { class: 'ed-crit-wire', d: p.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' ') }));
    }
    for (const id of t.path.parts) svg.querySelector(`[data-part="${CSS.escape(id)}"]`)?.classList.add('ed-crit');
    for (const id of t.path.pins) svg.querySelector(`[data-pin-id="${CSS.escape(id)}"]`)?.classList.add('ed-crit');
  }
}

const of = new WeakMap<Editor, Analysis>();

registerEditorPlugin((ed) => {
  const a = new Analysis(ed);
  of.set(ed, a);
  a.start();
  return () => a.destroy();
});

registerToolbarAction({
  id: 'probe', title: 'Probe mode (P): click wires to record them in the timing panel', icon: 'probe', label: 'Probe', order: 60,
  run: (ed) => { const a = of.get(ed); a?.setProbing(!a.probing); },
  active: (ed) => !!of.get(ed)?.probing,
});
registerToolbarAction({
  id: 'timing', title: 'Timing panel: pins and probed wires over time, in gate delays', icon: 'wave', label: 'Timing', order: 61,
  run: (ed) => { const a = of.get(ed); a?.setOpen(!a.open); },
  active: (ed) => !!of.get(ed)?.open,
});

registerDiagSource((ed) => of.get(ed)?.lint().diags ?? []);

registerPropsSection({
  id: 'timing', order: 15,
  render: (ed) => (ed.selCount ? null : of.get(ed)?.timingSection() ?? null),
});
