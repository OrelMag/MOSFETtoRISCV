// The MOSFET explainer: a cross-section whose channel forms as the gate voltage rises (mosxsec.ts),
// readouts, and the two I–V views (current against the gate, and against the drain). Used both as a
// chapter step and as the "inside" of any transistor opened from a schematic. Everything that moves
// is computed from the device model in mosphys.ts.

import { B1, type Bit } from '../sim/types';
import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { tween, VDD } from './mosphys';
import { chips, idVdsChart, idVgsChart, slider } from './mosparts';
import { crossSection, type MosType } from './mosxsec';

export interface MosfetOptions {
  type?: MosType;
  allowTypeSwitch?: boolean;
  /** Live gate value from a running circuit (leaf mode). */
  gate?: () => Bit;
  caption?: string;
}

const RAMP_MS = 600; // leaf mode: how long the gate takes to follow a logic edge
export const volts = (v: number): string => `${v.toFixed(2)} V`;

/** Runs `frame(now, dt)` on animation frames while `moving()` holds; kick() restarts it after a change. */
export function frameLoop(frame: (now: number, dt: number) => void, moving: () => boolean) {
  let raf = 0, lastT = 0;
  const loop = (now: number) => {
    raf = 0;
    const dt = Math.min(0.05, Math.max(0, (now - lastT) / 1000)); // no jump after a hidden tab
    lastT = now;
    frame(now, dt);
    if (moving()) raf = requestAnimationFrame(loop);
  };
  return {
    kick() { if (raf || !moving()) return; lastT = performance.now(); raf = requestAnimationFrame(loop); },
    stop() { cancelAnimationFrame(raf); raf = 0; },
  };
}

export function mosfetWidget(opts: MosfetOptions = {}): Widget {
  let type: MosType = opts.type ?? 'n';
  let vg = 0, vd = 0.9;
  let lastGate: Bit | null = null;
  let flowing = false;

  const xs = crossSection('device');
  const gSl = slider('Gate', 0, VDD, 0.01, vg, volts, (v) => { stopSweep(); vg = v; repaint(); });
  const dSl = slider('Drain', 0, VDD, 0.01, vd, volts, (v) => { vd = v; repaint(); });
  const readout = chips();
  const vgsChart = idVgsChart(), vdsChart = idVdsChart();
  const howTo = h('p', { class: 'sub' });
  const typeSel = h('div', { class: 'seg' });
  const sweepBtn = h('button', { class: 'btn sm', type: 'button', onclick: () => (tw ? stopSweep() : sweep()) });

  // ── Gate-voltage animation: a queue of tweens (a sweep is up, hold, down) ──
  let tw: ReturnType<typeof tween> | null = null;
  let queue: { to: number; ms: number }[] = [];
  const syncSweep = () => { sweepBtn.textContent = tw ? '■ Stop' : '▶ Sweep'; };
  const next = (now: number) => {
    const seg = queue.shift();
    tw = seg ? tween(vg, seg.to, now, seg.ms) : null;
    syncSweep();
  };
  const play = (segs: { to: number; ms: number }[]) => { queue = segs; next(performance.now()); loop.kick(); };
  const stopSweep = () => { queue = []; tw = null; syncSweep(); };
  const sweep = () => {
    // Off to fully on and back. For PMOS "on" is the gate pulled down to 0 V.
    const off = type === 'n' ? 0 : VDD, on = VDD - off;
    vg = off;
    play([{ to: on, ms: 3200 }, { to: on, ms: 900 }, { to: off, ms: 2000 }]);
  };

  const setType = (t: MosType) => {
    type = t;
    stopSweep();
    for (const b of typeSel.querySelectorAll('button')) b.classList.toggle('on', b.dataset.t === t);
    vd = t === 'p' ? VDD - 0.9 : 0.9;
    vg = t === 'p' ? VDD : 0;
    dSl.set(vd);
    howTo.textContent = t === 'n'
      ? 'Raise the gate past the threshold and a channel of electrons connects source to drain.'
      : 'The source sits at VDD: pull the gate down and a channel of holes connects source to drain.';
    paint(0);
  };
  for (const t of ['n', 'p'] as const) typeSel.append(h('button', { 'data-t': t, onclick: () => setType(t) }, t === 'n' ? 'NMOS' : 'PMOS'));

  function paint(dt: number): void {
    const p = type === 'p', vs = p ? VDD : 0;
    const drive = Math.max(0, p ? vs - vg : vg - vs), vds = Math.abs(vd - vs);
    flowing = xs.paint(type, vg, vd, dt);
    gSl.set(vg);
    readout.paint(drive, vds, p);
    vgsChart.paint(drive, vds, p);
    vdsChart.paint(drive, vds, p);
  }

  // The loop runs only while something moves: a gate ramp, or carriers in a conducting channel.
  const loop = frameLoop((now, dt) => {
    if (tw) {
      const r = tw(now);
      vg = r.v;
      if (r.done) next(now);
    }
    paint(dt);
  }, () => tw !== null || (flowing && !reducedMotion()));
  function repaint(): void { paint(0); loop.kick(); }

  const el = h('div', { class: 'widget mos' },
    h('div', { class: 'panel mos-xpanel' },
      h('div', { class: 'mos-head' }, h('h3', null, 'Inside a MOSFET'), opts.allowTypeSwitch !== false ? typeSel : null),
      opts.caption ? h('p', { class: 'sub' }, opts.caption) : null,
      xs.el),
    h('div', { class: 'panel mos-ctl' },
      howTo,
      h('div', { class: 'mos-row' }, gSl.el, dSl.el,
        // The circuit drives the gate in leaf mode; a sweep is motion the user asked for, but reduced
        // motion still gets the slider instead.
        opts.gate || reducedMotion() ? null : sweepBtn)),
    readout.el,
    h('div', { class: 'mos-charts' },
      h('div', { class: 'panel' }, h('h3', null, 'Current against gate voltage'), vgsChart.el),
      h('div', { class: 'panel' }, h('h3', null, 'Current against drain voltage'), vdsChart.el)));

  syncSweep();
  setType(type);
  loop.kick();

  return {
    el,
    update() {
      if (!opts.gate) return;
      const gv = opts.gate();
      if (gv === lastGate) return;
      // The first value arrives as the widget opens: show it as is. Later edges ramp.
      const ms = lastGate === null || reducedMotion() ? 0 : RAMP_MS;
      lastGate = gv;
      const to = gv === B1 ? VDD : 0;
      if (ms) play([{ to, ms }]);
      else { stopSweep(); vg = to; repaint(); }
    },
    destroy() { loop.stop(); },
  };
}

/** Leaf factory for the stage: opening a transistor shows this widget, driven live. */
export function transistorLeaf(def: { prim?: string; name: string }, gate: () => Bit): Widget {
  const w = mosfetWidget({
    type: def.prim === 'pmos' ? 'p' : 'n', allowTypeSwitch: false, gate,
    caption: 'This is one transistor from the circuit you were looking at. Its gate follows the live logic value (1 = 1.8 V, 0 = 0 V), ramping as the bit flips. Toggle inputs in the bar below and watch it switch.',
  });
  w.update?.();
  return w;
}
