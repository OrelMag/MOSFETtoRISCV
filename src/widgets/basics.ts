// Chapter 0's explainers (Basics: before the switch): a battery, a switch and a lamp on one loop; why a wire carries two
// levels, not ten; counting on lamps; a rule as a table (two switches and a lamp); a four-instruction program stepped on
// SAP-1's golden model (Appendix C's computer). Every number on them is computed here, and the prose reads it from here.

import '../styles/basics.css';
import '../styles/watertoggle.css';
import { assembleSap } from '../sap/asm';
import { SapISS } from '../sap/iss';
import { SAP_PROGRAMS } from '../sap/programs';
import { h, s } from '../ui/dom';
import type { Widget } from '../view/stage';
import { reducedMotion } from '../ui/motion';
import { loadOf, VDD } from './mosphys';
import { LOOP_RANGE } from './water';
import type { WaterMount } from './waterkit';

/** The loop: a 1.5 V cell and a lamp of 15 Ω (hot), so 0.1 A and 0.15 W. */
export const LOOP = { volts: 1.5, ohms: 15 };
export const loopAmps = (lamps: number, volts = LOOP.volts, ohms = LOOP.ohms) => volts / (ohms * lamps);
const fmt = (x: number, d = 2) => x.toFixed(d);

const btn = (label: string, onclick: () => void, extra = '') => h('button', { class: `btn sm${extra}`, type: 'button', onclick }, label);
const readout = (...cells: [string, string][]) => h('div', { class: 'readout' }, ...cells.map(([v, l]) => h('div', null, h('b', null, v), h('span', null, l))));

/** The loop's pieces, shared by step 1 and step 2 (the bucket): the cell, left, at x 62..118; the switch on the top wire, x 230..300. */
function cellDrawing(volts: number): SVGElement[] {
  return [
    // the cell: long plate +, short plate −
    s('line', { x1: 62, y1: 108, x2: 118, y2: 108, class: 'bx-sym' }), s('line', { x1: 76, y1: 122, x2: 104, y2: 122, class: 'bx-sym thick' }),
    s('line', { x1: 62, y1: 138, x2: 118, y2: 138, class: 'bx-sym' }), s('line', { x1: 76, y1: 152, x2: 104, y2: 152, class: 'bx-sym thick' }),
    s('text', { x: 126, y: 112, class: 'bx-lbl' }, '+'), s('text', { x: 126, y: 158, class: 'bx-lbl' }, '−'),
    s('text', { x: 14, y: 135, class: 'bx-big' }, `${volts} V`),
  ];
}
function switchDrawing(closed: boolean, w: string): SVGElement[] {
  return [
    s('circle', { cx: 230, cy: 50, r: 5, class: 'bx-pin' }), s('circle', { cx: 300, cy: 50, r: 5, class: 'bx-pin' }),
    s('line', closed ? { x1: 233, y1: 48, x2: 297, y2: 48, class: w } : { x1: 233, y1: 47, x2: 290, y2: 18, class: 'bx-wire' }),
  ];
}

/** Step 1: a closed loop lights the lamp; open it anywhere and the current is 0 all round. */
export function loopWidget(): Widget {
  let closed = false, cut = false, lamps = 1, volts = LOOP.volts, ohms = LOOP.ohms;
  const svg = s('svg', { viewBox: '0 0 560 270', class: 'bx-svg', role: 'img' });
  const ctl = h('div', { class: 'bx-row' });
  const out = h('div');
  // Wire | Water: the same loop drawn as pipes (the analogy, in 3D on the site's WebGL renderer, loaded on first use). Both views
  // read this widget's own state, so a switch thrown in either is thrown in both.
  let view: 'wire' | 'water' = 'wire', water: WaterMount | null = null, dead = false;
  const wireBtn = h('button', { type: 'button', 'aria-pressed': 'true', onclick: () => setView('wire') }, 'Wire');
  const waterBtn = h('button', { type: 'button', 'aria-pressed': 'false', onclick: () => setView('water') }, 'Water');
  const seg = h('div', { class: 'wt-seg', role: 'group', 'aria-label': 'How to draw the loop' }, wireBtn, waterBtn);
  const host = h('div', { class: 'wt-host' });
  // Try other values (Water view only; the text above quotes the defaults): they feed this widget's own readout too.
  const slider = (label: string, [min, max]: readonly [number, number], step: number, value: number, unit: string, set: (v: number) => void) => {
    const out = h('output', null, `${value} ${unit}`);
    const input = h('input', { type: 'range', min, max, step, value, 'aria-label': label }) as HTMLInputElement;
    input.addEventListener('input', () => { set(Number(input.value)); out.textContent = `${input.value} ${unit}`; render(); });
    return { input, out, el: h('label', { class: 'wt-try-sl' }, h('span', null, label), input, out) };
  };
  const vSl = slider('Cell', LOOP_RANGE.volts, 0.1, volts, 'V', (v) => { volts = v; });
  const oSl = slider('Lamp', LOOP_RANGE.ohms, 1, ohms, 'Ω', (v) => { ohms = v; });
  const reset = h('button', { type: 'button', class: 'btn sm', onclick: () => {
    volts = LOOP.volts; ohms = LOOP.ohms;
    vSl.input.value = String(volts); oSl.input.value = String(ohms); vSl.out.textContent = `${volts} V`; oSl.out.textContent = `${ohms} Ω`; render();
  } }, `Back to ${LOOP.volts} V, ${LOOP.ohms} Ω`);
  const tryRow = h('div', { class: 'wt-try' }, h('span', { class: 'wt-try-k' }, 'Try other values'), vSl.el, oSl.el, reset);
  tryRow.style.display = 'none';
  const el = h('div', { class: 'widget' }, h('div', { class: 'panel' }, h('h3', null, 'A battery, a switch and a lamp'),
    h('p', { class: 'sub' }, 'Current flows only around a closed loop. Close the switch, then break the loop somewhere else.'), seg, svg, host, tryRow, ctl, out));

  function setView(v: 'wire' | 'water'): void {
    view = v;
    wireBtn.setAttribute('aria-pressed', String(v === 'wire'));
    waterBtn.setAttribute('aria-pressed', String(v === 'water'));
    svg.style.display = v === 'wire' ? '' : 'none';
    host.style.display = v === 'water' ? '' : 'none';
    tryRow.style.display = v === 'water' ? '' : 'none';
    if (v === 'water' && !water && !host.firstChild) {
      host.style.minHeight = '260px';
      host.textContent = 'Loading the water view…';
      import('./waterscenes')
        .then((m) => {
          if (dead) return;
          host.textContent = ''; host.style.minHeight = '';
          water = m.mountLoop(host, () => ({ closed, cut, lamps, volts, ohms }));
        })
        .catch((e: unknown) => { if (!dead) host.textContent = `The water view did not load (${String(e)}).`; });
    } else water?.kick();
  }
  host.style.display = 'none';

  function lampAt(cx: number, cy: number, p: number): SVGElement {
    const lit = Math.min(1, p / (loopAmps(1) * LOOP.volts));
    return s('g', null,
      s('circle', { cx, cy, r: 40, class: 'bx-glow', style: `opacity:${lit}` }),
      s('circle', { cx, cy, r: 24, class: `bx-lamp${lit > 0 ? ' on' : ''}`, style: lit > 0 ? `opacity:${0.35 + 0.65 * lit}` : '' }),
      s('path', { d: `M${cx - 15} ${cy - 11} L${cx + 15} ${cy + 11} M${cx + 15} ${cy - 11} L${cx - 15} ${cy + 11}`, class: 'bx-sym' }));
  }

  function render(): void {
    const amps = closed && !cut ? loopAmps(lamps, volts, ohms) : 0;
    const vLamp = amps * ohms, p = amps * vLamp;
    const w = amps > 0 ? 'bx-wire on' : 'bx-wire';
    const lampY = lamps === 1 ? [135] : [95, 175];
    svg.replaceChildren(
      s('path', { class: w, d: 'M90 100 V50 H230' }),
      s('path', { class: w, d: 'M300 50 H460 V' + (lampY[0] - 24) }),
      ...(lamps === 2 ? [s('path', { class: w, d: `M460 ${lampY[0] + 24} V${lampY[1] - 24}` })] : []),
      s('path', { class: w, d: `M460 ${lampY[lampY.length - 1] + 24} V225 H${cut ? 300 : 90}` }),
      s('path', { class: w, d: `M${cut ? 260 : 90} 225 H90 V160` }),
      ...(cut ? [s('text', { x: 280, y: 214, class: 'bx-lbl', 'text-anchor': 'middle' }, 'cut')] : []),
      ...cellDrawing(volts),
      ...switchDrawing(closed, w),
      s('text', { x: 265, y: 82, class: 'bx-lbl', 'text-anchor': 'middle' }, closed ? 'switch closed' : 'switch open'),
      ...lampY.map((y) => lampAt(460, y, p)),
      s('text', { x: 500, y: lampY[0] + 5, class: 'bx-lbl' }, lamps === 1 ? 'lamp' : 'lamps'),
      s('text', { x: 175, y: 252, class: 'bx-lbl' }, 'return wire: ground, the 0 V we measure from'),
      ...(amps > 0 ? [s('text', { x: 330, y: 40, class: 'bx-lbl' }, `${fmt(amps)} A →`)] : []));
    ctl.replaceChildren(
      btn(closed ? 'Open the switch' : 'Close the switch', () => { closed = !closed; render(); }, closed ? '' : ' primary'),
      btn(cut ? 'Mend the return wire' : 'Cut the return wire', () => { cut = !cut; render(); }),
      btn(lamps === 1 ? 'Two lamps in a row' : 'One lamp', () => { lamps = 3 - lamps; render(); }));
    out.replaceChildren(readout([`${fmt(vLamp)} V`, lamps === 1 ? 'across the lamp' : 'across each lamp'], [`${fmt(amps)} A`, 'current, the same all round'],
      [`${fmt(p)} W`, lamps === 1 ? 'power in the lamp, V × I' : 'power in each lamp'], [amps > 0 ? (lamps === 1 ? 'bright' : 'dim') : 'off', 'the lamp']));
    if (view === 'water') water?.kick();
  }
  render();
  return { el, destroy() { dead = true; water?.destroy(); water = null; } };
}

// ---- Step 2: a bucket of charge. The closed form v(t) = V·(1 − e^(−t/RC)), DOM-free, then the widget that animates it. ----

/** The bucket: the loop's 1.5 V cell through 1 kΩ into 1 000 µF, so RC = 1 s, Q = 1.5 mC. The slider' ranges are in Ω and µF. */
export const RC = { volts: LOOP.volts, ohms: 1000, farads: 1e-3 };
export const RC_RANGE = { ohms: [100, 10000] as const, microfarads: [100, 4700] as const };
/** A gate driving two inputs, from the MOSFET chapter's own constants (widgets/mosphys.ts): 5 fF, 1.8 V, C·V² = 16 fJ a swing. */
export const GATE = { femtofarads: loadOf(2), volts: VDD, femtojoules: loadOf(2) * VDD * VDD };

export interface RcPart { volts: number; ohms: number; farads: number }
/** The switch: connected to the cell (charge), open, or the cell taken out and the bucket emptied through R (discharge). */
export type RcMode = 'charge' | 'open' | 'discharge';
export interface RcEvent { at: number; mode: RcMode }

/** The time constant R·C, in seconds. */
export const rc = (p: Pick<RcPart, 'ohms' | 'farads'>): number => p.ohms * p.farads;
/** After t = RC the voltage has covered 1 − 1/e of the way: 63.2 %. After 5 RC, 99.3 %. */
export const FRACTION_AT_RC = 1 - Math.exp(-1);
export const FRACTION_AT_5RC = 1 - Math.exp(-5);

/** Voltage on C, t seconds after the switch went to `mode` with v0 on C. */
export function voltageAt(t: number, p: RcPart, mode: RcMode, v0 = 0): number {
  if (mode === 'open') return v0;
  const target = mode === 'charge' ? p.volts : 0;
  return target + (v0 - target) * Math.exp(-t / rc(p));
}
/** Current into C (A; negative while emptying): the voltage left to push, over R. */
export function currentAt(t: number, p: RcPart, mode: RcMode, v0 = 0): number {
  if (mode === 'open') return 0;
  return ((mode === 'charge' ? p.volts : 0) - voltageAt(t, p, mode, v0)) / p.ohms;
}
/** Q = C·V, in coulombs. */
export const chargeOf = (p: Pick<RcPart, 'farads'>, v: number): number => p.farads * v;
/** Energy so far, J: `drawn` is what the cell has pushed (Q·V for the charge it has moved); ½C·v² is stored, the rest warmed R. */
export function energies(p: Pick<RcPart, 'farads'>, v: number, drawn: number): { battery: number; stored: number; heat: number } {
  const stored = 0.5 * p.farads * v * v;
  return { battery: drawn, stored, heat: drawn - stored };
}

export interface RcNow { v: number; i: number; q: number; battery: number; stored: number; heat: number }
/** The bucket at time t (s) when it starts empty and the switch is thrown at each event in turn. */
export function rcRun(p: RcPart, events: readonly RcEvent[], t: number): RcNow {
  let v = 0, drawn = 0, mode: RcMode = 'open', at = 0;
  const to = (when: number): number => {
    const v1 = voltageAt(Math.max(0, when - at), p, mode, v);
    if (mode === 'charge') drawn += (v1 - v) * p.farads * p.volts;
    return v1;
  };
  for (const e of events) {
    if (e.at >= t) break;
    v = to(e.at); at = e.at; mode = e.mode;
  }
  const i = currentAt(Math.max(0, t - at), p, mode, v);
  v = to(t);
  return { v, i, q: chargeOf(p, v), ...energies(p, v, drawn) };
}

const thin = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const sig = (x: number, n = 3): string => String(+x.toPrecision(n));
/** 1 000 Ω → "1 kΩ"; 100 Ω → "100 Ω". */
export const fmtOhms = (r: number): string => (r >= 1000 ? `${sig(r / 1000)} kΩ` : `${sig(r)} Ω`);
export const fmtMicrofarads = (f: number): string => `${thin(f * 1e6)} µF`;
export const fmtSeconds = (t: number): string => (t >= 0.1 ? `${sig(t)} s` : `${sig(t * 1e3)} ms`);
export const fmtMilli = (x: number, unit: string, d = 4): string => `${+(x * 1e3).toPrecision(d)} m${unit}`;

/** Step 2: close the switch and watch a capacitor fill through a resistor; open it, or empty it again. */
export function bucketWidget(): Widget {
  const part: RcPart = { ...RC };
  let events: RcEvent[] = [], T = 0, raf = 0, last = 0, dead = false;
  const mode = (): RcMode => events[events.length - 1]?.mode ?? 'open';
  const since = (): number => T - (events[events.length - 1]?.at ?? 0);
  /** Still moving: a switch position that changes the voltage, and not yet 8 RC after it was thrown. */
  const running = (): boolean => mode() !== 'open' && since() < 8 * rc(part);

  const loop = s('svg', { viewBox: '0 0 560 270', class: 'bx-svg', role: 'img' });
  const curve = s('svg', { viewBox: '0 0 460 270', class: 'bx-svg', role: 'img' });
  const sw = h('div', { class: 'bx-row', role: 'group', 'aria-label': 'The switch' });
  const wait = btn('Wait one RC', () => { T += rc(part); render(); });
  const out = h('div'), bars = h('div', { class: 'bx-bars' });
  const slider = (label: string, min: number, max: number, value: number, text: (x: number) => string, set: (x: number) => void) => {
    const o = h('output', null, text(value));
    const input = h('input', { type: 'range', min, max, step: 0.01, value: Math.log10(value), 'aria-label': label, 'aria-valuetext': text(value) }) as HTMLInputElement;
    input.addEventListener('input', () => {
      const x = +(10 ** +input.value).toPrecision(3);
      o.textContent = text(x); input.setAttribute('aria-valuetext', text(x));
      set(x); restart();
    });
    return h('label', { class: 'slider' }, h('span', null, label), input, o);
  };
  const rSl = slider('R', Math.log10(RC_RANGE.ohms[0]), Math.log10(RC_RANGE.ohms[1]), part.ohms, fmtOhms, (x) => { part.ohms = x; });
  const cSl = slider('C', Math.log10(RC_RANGE.microfarads[0]), Math.log10(RC_RANGE.microfarads[1]), part.farads * 1e6, (x) => fmtMicrofarads(x * 1e-6), (x) => { part.farads = x * 1e-6; });
  const el = h('div', { class: 'widget' }, h('div', { class: 'wgrid' },
    h('div', { class: 'panel' }, h('h3', null, 'A cell, a switch, a resistor and a capacitor'),
      h('p', { class: 'sub' }, 'Close the switch to fill the capacitor, open it to hold the charge, Discharge to empty it through R. Moving a slider starts again from empty.'),
      loop, sw, rSl, cSl),
    h('div', { class: 'panel' }, h('h3', null, 'The voltage on the capacitor'),
      h('p', { class: 'sub' }, 'Drawn as time passes. The dashed line marks one RC: 63 % of the way.'), curve, out, bars)));

  /** Slider moved: the parts changed, so the bucket is empty again and the switch open. */
  function restart(): void { events = []; T = 0; render(); }
  function throwTo(m: RcMode): void {
    if (mode() === m) return;
    events.push({ at: T, mode: m });
    render();
  }

  function frame(ts: number): void {
    raf = 0;
    T += Math.min(0.1, (ts - last) / 1000); last = ts;
    render();
  }
  function kick(): void {
    if (raf || dead || reducedMotion() || !running()) return;
    last = performance.now(); raf = requestAnimationFrame(frame);
  }

  function drawLoop(now: RcNow): void {
    const m = mode(), tau = rc(part), frac = now.v / part.volts;
    const flowing = Math.abs(now.i) > 0.003 * part.volts / part.ohms;
    const w = flowing ? 'bx-wire on' : 'bx-wire';
    const n = Math.round(5 * frac);
    loop.setAttribute('aria-label', `A ${part.volts} V cell, a switch, a ${fmtOhms(part.ohms)} resistor and a ${fmtMicrofarads(part.farads)} capacitor in a loop. Switch ${m === 'charge' ? 'closed' : m === 'open' ? 'open' : 'set to discharge'}. The capacitor holds ${sig(now.v)} V.`);
    loop.replaceChildren(
      s('path', { class: w, d: 'M90 100 V50 H230' }), s('path', { class: w, d: 'M300 50 H330' }),
      s('path', { class: w, d: 'M330 50 l8 -14 l12 28 l12 -28 l12 28 l12 -28 l8 14', style: 'stroke-width:3' }), s('path', { class: w, d: 'M394 50 H460 V110' }),
      s('path', { class: w, d: 'M460 130 V225 H90 V160' }),
      s('g', { class: m === 'discharge' ? 'bx-dim' : '' }, ...cellDrawing(part.volts)),
      ...(m === 'discharge' ? [s('path', { class: w, d: 'M90 100 V160' })] : []),
      ...switchDrawing(m !== 'open', w),
      s('text', { x: 265, y: 82, class: 'bx-lbl', 'text-anchor': 'middle' }, m === 'charge' ? 'switch closed' : m === 'open' ? 'switch open' : 'cell taken out'),
      s('text', { x: 362, y: 84, class: 'bx-lbl', 'text-anchor': 'middle' }, `R ${fmtOhms(part.ohms)}`),
      // the capacitor: two plates with a gap, the gap tinted by how full it is
      s('rect', { x: 430, y: 110, width: 60, height: 20, class: 'bx-glow', style: `opacity:${frac}` }),
      s('line', { x1: 430, y1: 110, x2: 490, y2: 110, class: 'bx-sym thick' }), s('line', { x1: 430, y1: 130, x2: 490, y2: 130, class: 'bx-sym thick' }),
      s('text', { x: 500, y: 108, class: 'bx-lbl bx-pos' }, '+'.repeat(n)), s('text', { x: 500, y: 140, class: 'bx-lbl bx-neg' }, '−'.repeat(n)),
      s('text', { x: 470, y: 168, class: 'bx-lbl' }, `C ${fmtMicrofarads(part.farads)}`),
      s('text', { x: 470, y: 186, class: 'bx-lbl' }, `${sig(now.v)} V`),
      ...(flowing ? [s('text', { x: 400, y: 40, class: 'bx-lbl' }, now.i > 0 ? `${fmtMilli(now.i, 'A', 3)} →` : `← ${fmtMilli(-now.i, 'A', 3)}`)] : []),
      s('text', { x: 175, y: 252, class: 'bx-lbl' }, `RC = ${fmtSeconds(tau)}`));
  }

  function drawCurve(): void {
    const tau = rc(part), xmax = Math.max(6 * tau, T * 1.04);
    const L = 48, R = 446, Tp = 24, B = 226, X = (t: number) => L + (t / xmax) * (R - L), Y = (v: number) => B - (v / part.volts) * (B - Tp);
    const N = 140, pts: string[] = [];
    for (let k = 0; k <= N; k++) { const t = Math.min(T, (k / N) * xmax); pts.push(`${X(t).toFixed(1)} ${Y(rcRun(part, events, t).v).toFixed(1)}`); if (t >= T) break; }
    const first = events[0]?.mode === 'charge' && events[0].at === 0;
    const ticks: SVGElement[] = [];
    for (let k = 1; k <= 8 && k * tau <= xmax; k++) ticks.push(s('line', { x1: X(k * tau), y1: B, x2: X(k * tau), y2: B + 5, class: 'bx-axis' }));
    const now = rcRun(part, events, T);
    curve.setAttribute('aria-label', `Voltage on the capacitor against time: ${sig(now.v)} V of ${part.volts} V after ${fmtSeconds(T)}.`);
    curve.replaceChildren(
      s('line', { x1: L, y1: B, x2: R, y2: B, class: 'bx-axis' }), s('line', { x1: L, y1: Tp, x2: L, y2: B, class: 'bx-axis' }),
      s('line', { x1: L, y1: Y(part.volts), x2: R, y2: Y(part.volts), class: 'bx-grid' }),
      s('text', { x: L - 6, y: Y(part.volts) + 4, class: 'bx-lbl', 'text-anchor': 'end' }, `${part.volts} V`), s('text', { x: L - 6, y: B + 4, class: 'bx-lbl', 'text-anchor': 'end' }, '0'),
      ...ticks,
      ...(xmax <= 8 * tau ? [s('text', { x: X(tau), y: B + 20, class: 'bx-lbl', 'text-anchor': 'middle' }, 'RC'), ...(xmax >= 5 * tau ? [s('text', { x: X(5 * tau), y: B + 20, class: 'bx-lbl', 'text-anchor': 'middle' }, '5 RC')] : [])] : []),
      ...(first ? [s('line', { x1: X(tau), y1: B, x2: X(tau), y2: Y(FRACTION_AT_RC * part.volts), class: 'bx-mark' }), s('line', { x1: L, y1: Y(FRACTION_AT_RC * part.volts), x2: X(tau), y2: Y(FRACTION_AT_RC * part.volts), class: 'bx-mark' }),
        s('text', { x: X(tau) + 8, y: Y(FRACTION_AT_RC * part.volts) + 16, class: 'bx-lbl bx-markt' }, `${(FRACTION_AT_RC * 100).toFixed(0)} % at ${fmtSeconds(tau)}`)] : []),
      s('path', { d: `M${pts.join(' L')}`, class: 'bx-curve' }),
      s('circle', { cx: X(Math.min(T, xmax)), cy: Y(now.v), r: 5, class: 'bx-now' }),
      ...(xmax > 8 * tau ? [s('text', { x: (L + R) / 2, y: B + 20, class: 'bx-lbl', 'text-anchor': 'middle' }, `0 … ${fmtSeconds(xmax)}`)] : []),
      s('text', { x: R, y: B - 6, class: 'bx-lbl', 'text-anchor': 'end' }, 'time →'), s('text', { x: L + 6, y: Tp - 8, class: 'bx-lbl' }, 'voltage on C'));
  }

  function render(): void {
    const now = rcRun(part, events, T), m = mode();
    drawLoop(now); drawCurve();
    sw.replaceChildren(
      ...([['charge', 'Close'], ['open', 'Open'], ['discharge', 'Discharge']] as const).map(([k, label]) =>
        h('button', { class: `btn sm${m === k ? ' primary' : ''}`, type: 'button', 'aria-pressed': String(m === k), onclick: () => throwTo(k) }, label)),
      ...(reducedMotion() && m !== 'open' ? [wait] : []));
    out.replaceChildren(readout([`${fmtMilli(now.i, 'A', 3)}`, 'current now'], [`${fmtMilli(now.q, 'C', 3)}`, 'charge Q = C·V'],
      [`${sig(now.v)} V`, 'voltage on C'], [fmtSeconds(T), 'time so far']));
    const full = part.farads * part.volts ** 2, row = (cls: string, k: string, e: number) =>
      h('div', { class: `bx-bar ${cls}` }, h('span', { class: 'k' }, k), h('i', null, h('b', { style: `width:${Math.max(0, Math.min(100, (e / full) * 100)).toFixed(1)}%` })), h('span', { class: 'v' }, fmtMilli(e, 'J')));
    bars.replaceChildren(h('p', { class: 'bx-cap' }, `Energy so far (the bars end at C·V² = ${fmtMilli(full, 'J')})`),
      row('bat', 'from the cell', now.battery), row('sto', 'stored in C', now.stored), row('heat', 'heat in R', now.heat));
    kick();
  }
  render();
  return { el, destroy() { dead = true; if (raf) cancelAnimationFrame(raf); raf = 0; } };
}

/** A small seeded generator, so the noise is the same on every visit. */
function rng(seed: number): () => number {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; };
}

export const NOISE = { symbols: 48, start: 0.1 };

/** Symbols misread out of NOISE.symbols with `levels` evenly spaced levels on a 1 V wire, noise uniform in ±amp. */
export function misreads(levels: number, amp: number, seed = 7): number {
  const r = rng(seed), top = levels - 1;
  let bad = 0;
  for (let i = 0; i < NOISE.symbols; i++) {
    const k = Math.floor(r() * levels), v = k / top + (2 * r() - 1) * amp;
    if (Math.min(top, Math.max(0, Math.round(v * top))) !== k) bad++;
  }
  return bad;
}

/** Step 2: the same noise on a wire read as 2 levels or as 10. */
export function noiseWidget(): Widget {
  let amp = NOISE.start;
  const plots = h('div', { class: 'bx-plots' });
  const slider = h('input', { type: 'range', min: 0, max: 0.7, step: 0.01, value: amp, 'aria-label': 'noise' }) as HTMLInputElement;
  const val = h('output');
  const out = h('div');
  slider.addEventListener('input', () => { amp = +slider.value; render(); });
  const el = h('div', { class: 'widget' }, h('div', { class: 'panel' }, h('h3', null, 'Two levels, not ten'),
    h('p', { class: 'sub' }, `${NOISE.symbols} symbols sent over a 1 V wire with noise added. Each dot is what arrived; the bands show how it is read.`),
    h('label', { class: 'slider' }, h('span', null, 'noise (±)'), slider, val), plots, out));

  function plot(levels: number): SVGElement {
    const W = 460, H = 150, top = levels - 1, r = rng(7);
    const y = (v: number) => 12 + (1 - v) * (H - 24);
    const g: SVGElement[] = [];
    for (let k = 0; k < levels; k++) {
      const lo = Math.max(0, (k - 0.5) / top), hi = Math.min(1, (k + 0.5) / top);
      g.push(s('rect', { x: 0, y: y(hi), width: W, height: y(lo) - y(hi), class: `bx-band${k % 2 ? ' alt' : ''}` }));
    }
    for (let i = 0; i < NOISE.symbols; i++) {
      const k = Math.floor(r() * levels), v = k / top + (2 * r() - 1) * amp;
      const ok = Math.min(top, Math.max(0, Math.round(v * top))) === k;
      g.push(s('circle', { cx: 10 + i * ((W - 20) / (NOISE.symbols - 1)), cy: y(Math.max(-0.1, Math.min(1.1, v))), r: 3.5, class: ok ? 'bx-dot' : 'bx-dot bad' }));
    }
    return s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'bx-svg', role: 'img', 'aria-label': `${levels} levels` }, ...g);
  }

  function render(): void {
    val.textContent = `${fmt(amp)} V`;
    const two = misreads(2, amp), ten = misreads(10, amp);
    plots.replaceChildren(
      h('div', null, h('div', { class: 'bx-cap' }, `2 levels (0 V, 1 V): ${two} of ${NOISE.symbols} misread`), plot(2)),
      h('div', null, h('div', { class: 'bx-cap' }, `10 levels (0.0 V … 1.0 V): ${ten} of ${NOISE.symbols} misread`), plot(10)));
    out.replaceChildren(readout([`±${fmt(0.5)} V`, 'noise 2 levels survive'], [`±${fmt(1 / 18, 3)} V`, 'noise 10 levels survive'],
      ['1 bit', 'per symbol, 2 levels'], [`${fmt(Math.log2(10))} bits`, 'per symbol, 10 levels']));
  }
  render();
  return { el };
}

/** Step 3: four lamps count from 0 to 15, each worth twice the one to its right. */
export function lampCountWidget(): Widget {
  let v = 11, timer: ReturnType<typeof setInterval> | null = null, note = '';
  const row = h('div', { class: 'bx-lamps' });
  const sum = h('p', { class: 'bx-sum' });
  const ctl = h('div', { class: 'bx-row' });
  const el = h('div', { class: 'widget' }, h('div', { class: 'panel' }, h('h3', null, 'Counting with lamps'),
    h('p', { class: 'sub' }, 'Click a lamp to switch it. Each is worth twice the one to its right.'), row, sum, ctl));
  const stop = () => { if (timer) clearInterval(timer); timer = null; };
  const inc = () => { note = v === 15 ? '15 + 1 needs a fifth lamp: with four, the count wraps to 0.' : ''; v = (v + 1) % 16; };
  function render(): void {
    row.replaceChildren(...[3, 2, 1, 0].map((i) => {
      const on = (v >> i) & 1;
      return h('button', { class: `bx-lampb${on ? ' on' : ''}`, type: 'button', 'aria-pressed': on ? 'true' : 'false', 'aria-label': `lamp worth ${1 << i}`,
        onclick: () => { stop(); v ^= 1 << i; note = ''; render(); } }, h('i'), h('span', null, String(1 << i)));
    }));
    const terms = [3, 2, 1, 0].map((i) => `${1 << i}·${(v >> i) & 1}`).join(' + ');
    sum.replaceChildren(h('code', null, `${terms} = ${v}`), h('span', null, ` · binary ${v.toString(2).padStart(4, '0')}`), note ? h('em', null, ` ${note}`) : '');
    ctl.replaceChildren(btn('+1', () => { stop(); inc(); render(); }, ' primary'),
      btn(timer ? 'Stop' : 'Count up', () => { if (timer) stop(); else timer = setInterval(() => { inc(); render(); }, 700); render(); }),
      btn('All off', () => { stop(); v = 0; note = ''; render(); }));
  }
  render();
  return { el, destroy: stop };
}

/** Step 4: two switches and a lamp, wired in a row or side by side, with the table of every case. */
export function switchTableWidget(): Widget {
  let a = 0, b = 0, parallel = false;
  const svg = s('svg', { viewBox: '0 0 460 200', class: 'bx-svg', role: 'img' });
  const table = h('table', { class: 'bx-table' });
  const ctl = h('div', { class: 'bx-row' });
  const el = h('div', { class: 'widget' }, h('div', { class: 'wgrid' },
    h('div', { class: 'panel' }, h('h3', null, 'Two switches, one lamp'), h('p', { class: 'sub' }, 'Flip A and B. Then change the wiring.'), svg, ctl),
    h('div', { class: 'panel' }, h('h3', null, 'Every case'), h('p', { class: 'sub' }, 'Four cases: two switches, each open (0) or closed (1).'), table)));
  const lit = (x: number, y: number) => (parallel ? x | y : x & y);
  function sw(x: number, y: number, on: number, name: string): SVGElement[] {
    return [s('circle', { cx: x, cy: y, r: 4, class: 'bx-pin' }), s('circle', { cx: x + 50, cy: y, r: 4, class: 'bx-pin' }),
      s('line', on ? { x1: x + 3, y1: y - 2, x2: x + 47, y2: y - 2, class: 'bx-wire on' } : { x1: x + 3, y1: y - 3, x2: x + 42, y2: y - 24, class: 'bx-wire' }),
      s('text', { x: x + 25, y: y + 22, class: 'bx-lbl', 'text-anchor': 'middle' }, name)];
  }
  function render(): void {
    const on = lit(a, b), w = on ? 'bx-wire on' : 'bx-wire';
    const body = parallel
      ? [s('path', { class: w, d: 'M40 100 H110 V60 H140 M110 100 V140 H140 M190 60 H230 V140 H190 M230 100 H330' }), ...sw(140, 60, a, 'A'), ...sw(140, 140, b, 'B')]
      : [s('path', { class: w, d: 'M40 100 H110 M160 100 H200 M250 100 H330' }), ...sw(110, 100, a, 'A'), ...sw(200, 100, b, 'B')];
    svg.replaceChildren(s('text', { x: 10, y: 96, class: 'bx-lbl' }, '+'), ...body,
      s('circle', { cx: 360, cy: 100, r: 34, class: 'bx-glow', style: `opacity:${on}` }),
      s('circle', { cx: 360, cy: 100, r: 20, class: `bx-lamp${on ? ' on' : ''}` }),
      s('path', { d: 'M347 91 L373 109 M373 91 L347 109', class: 'bx-sym' }),
      s('path', { class: w, d: 'M380 100 H420 V185 H40 V110' }),
      s('text', { x: 230, y: 198, class: 'bx-lbl', 'text-anchor': 'middle' }, parallel ? 'side by side: either closes the loop' : 'in a row: both must close it'));
    ctl.replaceChildren(btn(`A: ${a ? 'closed' : 'open'}`, () => { a ^= 1; render(); }, a ? ' primary' : ''),
      btn(`B: ${b ? 'closed' : 'open'}`, () => { b ^= 1; render(); }, b ? ' primary' : ''),
      btn(parallel ? 'Wire them in a row' : 'Wire them side by side', () => { parallel = !parallel; render(); }));
    table.replaceChildren(h('thead', null, h('tr', null, h('th', null, 'A'), h('th', null, 'B'), h('th', null, 'lamp'))),
      h('tbody', null, ...[0, 1, 2, 3].map((r) => {
        const x = r >> 1, y = r & 1;
        return h('tr', { class: x === a && y === b ? 'cur' : '' }, h('td', null, String(x)), h('td', null, String(y)), h('td', null, lit(x, y) ? '1 lit' : '0'));
      })));
  }
  render();
  return { el };
}

/** The toy machine's program: SAP-1's "Add two numbers". */
export const TOY = SAP_PROGRAMS.find((p) => p.id === 'add')!;

/** Step 5: a program in memory, run one instruction at a time on SAP-1's golden model. */
export function toyMachineWidget(): Widget {
  const asm = assembleSap(TOY.src);
  let iss = new SapISS(asm.bytes), instrs = 0;
  const list = h('div', { class: 'bx-listing' });
  const regs = h('div');
  const ctl = h('div', { class: 'bx-row' });
  const el = h('div', { class: 'widget' }, h('div', { class: 'wgrid' },
    h('div', { class: 'panel' }, h('h3', null, 'The program in memory'), h('p', { class: 'sub' }, 'Sixteen 8-bit words. The arrow is the program counter: the next step to do.'), list),
    h('div', { class: 'panel' }, h('h3', null, 'The machine'), h('p', { class: 'sub' }, 'A holds a number being worked on; OUT is what it shows.'), regs, ctl)));
  function step(): void {
    if (iss.halted) return;
    let n = 0;
    do iss.cycle(); while (iss.step !== 0 && !iss.halted && ++n < 16);
    instrs++;
  }
  function render(): void {
    list.replaceChildren(...asm.lines.map((l) => h('div', { class: `bx-line${l.addr === iss.pc && !iss.halted ? ' pc' : ''}` },
      h('span', { class: 'a' }, l.addr === iss.pc && !iss.halted ? '→' : ''), h('span', { class: 'n' }, String(l.addr)),
      h('code', null, l.byte.toString(2).padStart(8, '0')), h('span', { class: 't' }, l.text.replace(/\s+/g, ' ')))));
    regs.replaceChildren(readout([String(iss.pc), 'program counter'], [String(iss.a), 'A'], [String(iss.out), 'OUT'], [iss.halted ? 'halted' : String(instrs), iss.halted ? 'the machine' : 'steps done']));
    ctl.replaceChildren(btn('Do one step', () => { step(); render(); }, iss.halted ? '' : ' primary'),
      btn('Run to the end', () => { while (!iss.halted && instrs < 64) step(); render(); }),
      btn('Start again', () => { iss = new SapISS(asm.bytes); instrs = 0; render(); }));
  }
  render();
  return { el };
}
