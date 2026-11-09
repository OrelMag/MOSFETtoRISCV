// The overlay bar in the sandbox (view/overlays.ts, view/overlaybar.ts): the four buttons at the end of the run row, O /
// Shift O, the legend over the canvas's bottom left (the minimap holds the bottom right). Marks go on the chip's own
// drawing: parts by id, wires and pointers through the compiled chip's net maps, set again after every repaint (the view
// redraws elements in place). Activity puts the simulation on the gate-level engine while it is on (the cycle engine
// keeps no toggle counts), and gives it back after.

import type { DelayModel } from '../sim/delay';
import { DualSim } from '../sim/dualsim';
import { GateSim } from '../sim/gatesim';
import type { FlatDesign } from '../sim/flatten';
import type { Sim } from '../sim/sim';
import { matches, shortcutAllowed, typing } from '../ui/keys';
import { s } from '../ui/dom';
import { settings } from '../ui/settings';
import { OverlayBar, nextOverlay, overlayLegend } from '../view/overlaybar';
import { type OverlayKind, type OverlayResult, activityOverlay, loadOverlay, overlayRefusal, slackOverlay, unknownOverlay } from '../view/overlays';
import { type Editor, registerEditorPlugin } from './editor';

const LIVE_MS = 100;

class SandboxOverlay {
  kind: OverlayKind | null = null;
  model: DelayModel | null = null;
  private bar: OverlayBar;
  private legend: HTMLElement | null = null;
  private cache = new Map<string, { design: FlatDesign; r: OverlayResult | null }>();
  private win: { sim: GateSim; base: Uint32Array; cycles: number; changes: number; sig: string } | null = null;
  private last = 0;
  private lastDoc: unknown = null;
  private off: (() => void)[] = [];
  readonly listeners = new Set<() => void>();

  constructor(private ed: Editor) {
    this.bar = new OverlayBar((k) => this.set(k));
    this.bar.el.classList.add('sb-ov-bar');
    ed.slots.run.append(this.bar.el);
    const paint = () => this.tick();
    ed.paintHooks.add(paint);
    this.off.push(() => ed.paintHooks.delete(paint), ed.onSimChange(() => { this.engine(); this.paint(); }));
    const key = (e: KeyboardEvent) => {
      if (!ed.el.isConnected || typing(e.target) || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if ((e.target as HTMLElement | null)?.closest?.('.sb-help, .key-help')) return;
      if (matches(e, 'sb.overlay') && shortcutAllowed(e)) {
        e.preventDefault();
        this.set(nextOverlay(this.kind, this.refusals(), e.shiftKey));
      }
    };
    document.addEventListener('keydown', key);
    this.off.push(() => document.removeEventListener('keydown', key));
    this.paint();
  }

  destroy(): void {
    this.kind = null;
    this.engine();
    this.off.forEach((f) => f());
    this.bar.el.remove();
    this.legend?.remove();
  }

  private sim(): Sim | null {
    return this.ed.sim.sim;
  }

  refusals(): Partial<Record<OverlayKind, string>> {
    const sim = this.sim();
    if (!sim) return {};
    const out: Partial<Record<OverlayKind, string>> = {};
    for (const k of ['slack', 'activity', 'load', 'unknown'] as const) {
      const why = overlayRefusal(k, { level: sim.kind });
      if (why) out[k] = why;
    }
    return out;
  }

  set(kind: OverlayKind | null, model?: DelayModel): void {
    if (model) this.model = model;
    if (kind && this.refusals()[kind]) kind = null;
    if (kind === 'activity' && this.kind !== 'activity') this.win = null;
    this.kind = kind;
    if (kind && settings.overlay !== kind) settings.set('overlay', kind);
    this.engine();
    this.paint();
    this.listeners.forEach((f) => f());
  }

  /** Activity on: GateSim, which counts toggles; off: the run mode's engine again. */
  private engine(): void {
    const sim = this.sim();
    if (sim instanceof DualSim) sim.preferFast = this.kind === 'activity' ? false : this.ed.sim.mode === 'cycle';
  }

  private gate(): GateSim | null {
    const sim = this.sim();
    return sim instanceof DualSim ? sim.gate : sim instanceof GateSim ? sim : null;
  }

  private tick(): void {
    if (!this.kind) return;
    const docChanged = this.ed.doc !== this.lastDoc;
    // a switch to cycle mode meanwhile set the engine back: Activity keeps GateSim
    if (this.kind === 'activity') { this.engine(); this.count(); }
    if (docChanged || ((this.kind === 'activity' || this.kind === 'unknown') && performance.now() - this.last >= LIVE_MS)) this.paint();
    else this.mark(this.result);
  }

  /** Activity's window: toggles since the overlay came on, over the clock cycles or input changes since. */
  private count(): { units: number; clocked: boolean } | null {
    const g = this.gate(), sim = this.sim();
    if (!g || !sim) return null;
    const es = this.ed.sim;
    const sig = sim.design.root.def.ports.filter((p) => p.dir === 'in').map((p) => sim.getInputBits(p.name).join('')).join('|');
    if (!this.win || this.win.sim !== g) {
      if (!g.toggles) g.countToggles();
      this.win = { sim: g, base: new Uint32Array(g.toggles!), cycles: es.cycles, changes: 0, sig };
    } else if (sig !== this.win.sig) {
      this.win.sig = sig;
      this.win.changes++;
    }
    return es.hasClock ? { units: es.cycles - this.win.cycles, clocked: true } : { units: this.win.changes, clocked: false };
  }

  private result: OverlayResult | null = null;

  private paint(): void {
    this.last = performance.now();
    this.lastDoc = this.ed.doc;
    const sim = this.sim(), kind = this.kind;
    this.bar.set(kind, this.refusals());
    let r: OverlayResult | null = null;
    if (kind && sim && !this.refusals()[kind]) {
      const design = sim.design;
      if (kind === 'slack' || kind === 'load') {
        const model = this.model ?? (settings.loadDelay ? 'load' : 'unit');
        const key = `${kind}|${model}`, hit = this.cache.get(key);
        if (hit && hit.design === design) r = hit.r;
        else {
          r = kind === 'slack' ? slackOverlay(design, [], model) : loadOverlay(design, design.root);
          this.cache.set(key, { design, r });
        }
      } else if (kind === 'unknown') r = unknownOverlay(sim, design.root);
      else {
        const w = this.count();
        if (w && this.win) r = activityOverlay(design.root, this.win.sim.toggles!, this.win.base, w.units, w.clocked);
      }
    }
    this.result = r;
    this.mark(r);
    const old = this.legend;
    this.legend = r ? overlayLegend(r, () => this.set(null)) : null;
    this.legend?.classList.add('sb-ov-legend');
    if (old && this.legend) old.replaceWith(this.legend);
    else if (old) old.remove();
    else if (this.legend) this.ed.slots.overlay.append(this.legend);
  }

  /** The marks on the chip's drawing: parts by id; wires, pointers and bus values by their compiled net. */
  private mark(r: OverlayResult | null): void {
    const svg = this.ed.view.svg, built = this.ed.sim.built;
    for (const c of [...svg.classList]) if (c.startsWith('ov-')) svg.classList.remove(c);
    svg.classList.toggle('ov', !!r);
    if (r) svg.classList.add(`ov-${r.kind}`);
    for (const g of svg.querySelectorAll<SVGGElement>('g.ed-part[data-part]')) {
      const m = r?.inst.get(g.getAttribute('data-part')!);
      const tip = g.querySelector(':scope > title.ov-tip');
      if (!m) {
        tip?.remove();
        g.removeAttribute('data-ov');
        g.removeAttribute('data-ov-src');
        continue;
      }
      g.setAttribute('data-ov', String(m.band));
      g.toggleAttribute('data-ov-src', !!m.src);
      if (tip?.textContent !== m.tip) { tip?.remove(); g.prepend(s('title', { class: 'ov-tip' }, m.tip)); }
    }
    const netMark = (n: number | undefined) => (n === undefined || n < 0 ? undefined : r?.net.get(n));
    const paintEl = (el: Element, m: ReturnType<typeof netMark>) => {
      if (m) el.setAttribute('data-ov', String(m.band));
      else el.removeAttribute('data-ov');
    };
    for (const el of svg.querySelectorAll('[data-wire]')) {
      const m = netMark(built?.netOfWire.get(el.getAttribute('data-wire')!));
      paintEl(el, m);
      if (el.classList.contains('wire-hit')) {
        const t = el.querySelector('title');
        if (!m) t?.remove();
        else if (t?.textContent !== m.tip) { t?.remove(); el.append(s('title', null, m.tip)); }
      }
    }
    for (const g of svg.querySelectorAll('g.ed-ptr[data-label]')) {
      const m = netMark(built?.netOfLabel.get(g.getAttribute('data-label')!));
      paintEl(g, m);
      for (const w of g.querySelectorAll('.wire')) paintEl(w, m);
    }
  }
}

const of = new WeakMap<Editor, SandboxOverlay>();

/** The sandbox's overlay on (the Timing section's heat toggle reads and sets it). */
export const editorOverlay = (ed: Editor): OverlayKind | null => of.get(ed)?.kind ?? null;
export function setEditorOverlay(ed: Editor, kind: OverlayKind | null, model?: DelayModel): void {
  of.get(ed)?.set(kind, model);
}
export function onEditorOverlay(ed: Editor, f: () => void): () => void {
  const o = of.get(ed);
  o?.listeners.add(f);
  return () => o?.listeners.delete(f);
}

registerEditorPlugin((ed) => {
  const o = new SandboxOverlay(ed);
  of.set(ed, o);
  return () => { o.destroy(); of.delete(ed); };
});
