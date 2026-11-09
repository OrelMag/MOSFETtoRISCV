// Chapter 42's widgets (Crossing clocks): what a receiver decides (noise margins and gain), the Schmitt trigger's
// hysteresis and a noisy slow edge, why unrelated clocks land in the setup window, the metastability model's MTBF, what a
// sampler reads mid-change (binary against Gray), and the panel that ticks two clocks separately over a gate-level
// circuit. Models: phys/inverter.ts, schmitt.ts, metastable.ts; comm/phase.ts, graybus.ts, asyncfifo.ts.

import '../styles/clocks.css';
import { EdgeSchedule, AsyncFifoModel, RATIOS, fromGray } from '../comm/asyncfifo';
import { meanGarbage, readings, table } from '../comm/graybus';
import { landings, reduce, windowFraction } from '../comm/phase';
import { curve, metrics, MOBILITY_RATIO, point } from '../phys/inverter';
import { fmtDuration, fmtLog10, log10Mtbf, PAIR, resolveTime, resolutionTime, T0_PS, TAU_PS, V_DECIDED, voltage, windowRate, AGE_OF_UNIVERSE_YEARS } from '../phys/metastable';
import { KEEPER, keeperLimit, mNode, noisyEdge, receive, thresholds, transitions, VM } from '../phys/schmitt';
import { findNode } from '../sim/flatten';
import { CLK_TO_Q, PS_PER_NAND, SETUP } from '../sim/timing';
import { pack } from '../sim/values';
import { asyncFifo, BIN2GRAY, GRAY2BIN, SYNC_BENCH, PULSE_SYNC } from '../lib/sync';
import { stats } from '../sim/stats';
import { h, s } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { VDD } from './mosphys';
import { fitText, slider } from './mosparts';
import { MS_TIMING } from '../chapters/seq/timing';

const nf = (x: number, d = 2) => x.toFixed(d);
const decimals = (step: number): number => String(step).split('.')[1]?.length ?? 0;

/** A plot frame: grid, ticks and axis labels in a viewBox, returning the scales. */
function frame(W: number, H: number, xr: [number, number], yr: [number, number], xl: string, yl: string, label: string, xt: number, yt: number, m = { l: 50, r: 14, t: 14, b: 38 }) {
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'mos-plot', role: 'img', 'aria-label': label }) as SVGSVGElement;
  fitText(svg, W);
  const X = (v: number) => m.l + ((v - xr[0]) / (xr[1] - xr[0])) * (W - m.l - m.r);
  const Y = (v: number) => H - m.b - ((v - yr[0]) / (yr[1] - yr[0])) * (H - m.t - m.b);
  if (xt > 0) for (let v = xr[0]; v <= xr[1] + 1e-9; v += xt) svg.append(s('line', { x1: X(v), x2: X(v), y1: m.t, y2: H - m.b, class: 'grid' }), s('text', { x: X(v), y: H - m.b + 14, 'text-anchor': 'middle', class: 'tick' }, nf(v, decimals(xt))));
  for (let v = yr[0]; v <= yr[1] + 1e-9; v += yt) svg.append(s('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), class: 'grid' }), s('text', { x: m.l - 6, y: Y(v) + 3.5, 'text-anchor': 'end', class: 'tick' }, nf(v, decimals(yt))));
  svg.append(s('line', { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, class: 'ax' }), s('line', { x1: m.l, x2: m.l, y1: m.t, y2: H - m.b, class: 'ax' }),
    s('text', { x: W - m.r, y: H - 4, 'text-anchor': 'end', class: 'axl' }, xl),
    s('text', { x: 6, y: m.t, 'text-anchor': 'end', 'dominant-baseline': 'hanging', transform: `rotate(-90 6 ${m.t})`, class: 'axl' }, yl));
  return { svg, X, Y, W, H, m };
}

const path = (pts: [number, number][]) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');

// ---- 1. what a receiver decides --------------------------------------------------------------------------------------

export function receiverWidget(): Widget {
  let noise = 0.3, vin = 0.9;
  const m = metrics(1);
  const f = frame(520, 300, [0, VDD], [0, VDD], 'Vin (V)', 'Vout (V)', 'Inverter transfer curve with its undefined zone', 0.3, 0.3);
  f.svg.appendChild(s('rect', { class: 'clk-zone', x: f.X(m.vil), width: f.X(m.vih) - f.X(m.vil), y: f.m.t, height: f.H - f.m.t - f.m.b }));
  f.svg.append(s('path', { class: 'cur', d: path(curve(1, 240).map((p) => [f.X(p.vin), f.Y(p.vout)])) }),
    s('text', { class: 'rl sat', x: f.X(m.vm), y: f.m.t + 12, 'text-anchor': 'middle' }, 'undefined'));
  const dot = f.svg.appendChild(s('circle', { r: 5.5, class: 'op' }));
  const lad = frame(260, 300, [0, 2], [0, VDD], '', '', 'Driver levels against receiver thresholds', 0, 0.3, { l: 40, r: 8, t: 14, b: 22 });
  const rect = (x0: number, x1: number, y0: number, y1: number, cls: string) => lad.svg.appendChild(s('rect', { x: lad.X(x0), width: lad.X(x1) - lad.X(x0), y: lad.Y(y1), height: lad.Y(y0) - lad.Y(y1), class: cls }));
  rect(0.1, 0.9, 0, m.vol, 'clk-lo'); rect(0.1, 0.9, m.voh, VDD, 'clk-hi');
  rect(1.1, 1.9, 0, m.vil, 'clk-lo'); rect(1.1, 1.9, m.vil, m.vih, 'clk-zone'); rect(1.1, 1.9, m.vih, VDD, 'clk-hi');
  const bandH = rect(0.1, 0.9, 0, 0, 'clk-noise'), bandL = rect(0.1, 0.9, 0, 0, 'clk-noise');
  lad.svg.append(
    s('text', { x: lad.X(0.5), y: lad.H - 6, 'text-anchor': 'middle', class: 'tick' }, 'driver'), s('text', { x: lad.X(1.5), y: lad.H - 6, 'text-anchor': 'middle', class: 'tick' }, 'receiver'),
    s('text', { x: lad.X(1.5), y: lad.Y((m.vil + m.vih) / 2) + 4, 'text-anchor': 'middle', class: 'rl sat' }, 'neither'));
  const worstH = lad.svg.appendChild(s('line', { x1: lad.X(0.1), x2: lad.X(1.9), class: 'bound' })), worstL = lad.svg.appendChild(s('line', { x1: lad.X(0.1), x2: lad.X(1.9), class: 'bound' }));
  const chips = [h('div'), h('div'), h('div'), h('div')];
  const verdict = h('p', { class: 'clk-verdict', role: 'status' });
  const paint = () => {
    const p = point(vin, 1);
    dot.setAttribute('cx', String(f.X(vin))); dot.setAttribute('cy', String(f.Y(p.vout)));
    const hiLow = m.voh - noise, loHigh = m.vol + noise;
    const set = (el: SVGRectElement, y0: number, y1: number) => { el.setAttribute('y', String(lad.Y(y1))); el.setAttribute('height', String(Math.max(0, lad.Y(y0) - lad.Y(y1)))); };
    set(bandH, hiLow, m.voh); set(bandL, m.vol, loHigh);
    worstH.setAttribute('y1', String(lad.Y(hiLow))); worstH.setAttribute('y2', String(lad.Y(hiLow)));
    worstL.setAttribute('y1', String(lad.Y(loHigh))); worstL.setAttribute('y2', String(lad.Y(loHigh)));
    const d = vin < m.vil ? 'reads 0' : vin > m.vih ? 'reads 1' : 'reads neither';
    const vals: [string, string][] = [[`${nf(vin)} V`, `Vin: ${d}`], [`${nf(p.vout)} V`, 'Vout'], [`${nf(m.nmL)} / ${nf(m.nmH)} V`, 'NML / NMH'], [`${nf(m.gain, 0)}`, 'peak gain |dVout/dVin|']];
    chips.forEach((c, i) => c.replaceChildren(h('b', null, vals[i][0]), h('span', null, vals[i][1])));
    const left = Math.min(m.nmL, m.nmH) - noise;
    verdict.className = `clk-verdict ${left > 0 ? 'ok' : 'bad'}`;
    verdict.textContent = left > 0
      ? `With ${nf(noise)} V of noise the worst-case level still clears the threshold by ${nf(left * 1000, 0)} mV.`
      : `${nf(noise)} V of noise exceeds the margin by ${nf(-left * 1000, 0)} mV: a driven level can land in the zone the receiver cannot decide.`;
  };
  const nSl = slider('Noise', 0, 1, 0.01, noise, (v) => `${nf(v)} V`, (v) => { noise = v; paint(); });
  const vSl = slider('Vin', 0, VDD, 0.01, vin, (v) => `${nf(v)} V`, (v) => { vin = v; paint(); });
  const el = h('div', { class: 'widget mos clk-w' },
    h('div', { class: 'clk-two' },
      h('div', { class: 'panel' }, h('h3', null, 'The receiver is an amplifier'), f.svg),
      h('div', { class: 'panel' }, h('h3', null, 'Levels and margins'), lad.svg)),
    h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' }, vSl.el, nSl.el),
      h('p', { class: 'sub mos-note' }, `Matched inverter of chapter 2 (Wp/Wn = ${MOBILITY_RATIO}, VDD ${VDD} V). VIL ${nf(m.vil)} V and VIH ${nf(m.vih)} V are where the slope is −1; the driver's levels are the outputs there (VOL ${nf(m.vol)} V, VOH ${nf(m.voh)} V). Noise is the worst-case offset added at the receiver by supply bounce, crosstalk and reflections, chapter 41.`)),
    h('div', { class: 'mos-chips' }, ...chips), verdict);
  paint();
  return { el };
}

// ---- 2. the Schmitt trigger's hysteresis -------------------------------------------------------------------------------

/** The panel on the Schmitt scene: keeper strength, the node m against Vin in both keeper states, the thresholds. */
export const schmittPanel: ScenePanel = (): Widget => {
  let kappa = KEEPER;
  const f = frame(300, 200, [0, VDD], [0, VDD], 'Vin (V)', 'node m (V)', 'Node m against input voltage for the two keeper states', 0.6, 0.6, { l: 52, r: 10, t: 10, b: 32 });
  const hi = f.svg.appendChild(s('path', { class: 'cur' })), lo = f.svg.appendChild(s('path', { class: 'clk-lo-curve' }));
  f.svg.appendChild(s('line', { class: 'vt', x1: f.X(0), x2: f.X(VDD), y1: f.Y(VM), y2: f.Y(VM) }));
  const up = f.svg.appendChild(s('line', { class: 'bound', y1: f.m.t, y2: f.H - f.m.b })), dn = f.svg.appendChild(s('line', { class: 'bound', y1: f.m.t, y2: f.H - f.m.b }));
  f.svg.append(s('text', { x: f.X(VDD) - 2, y: f.Y(VM) - 4, 'text-anchor': 'end', class: 'tick' }, 'B switches here'));
  const read = h('div', { class: 'mc-status' });
  const note = h('p', { class: 'sub' });
  const paint = () => {
    const pts = (st: 'hi' | 'lo') => path(Array.from({ length: 91 }, (_, i): [number, number] => { const v = (i / 90) * VDD; return [f.X(v), f.Y(mNode(v, kappa, st))]; }));
    hi.setAttribute('d', pts('hi')); lo.setAttribute('d', pts('lo'));
    const t = thresholds(kappa);
    for (const [el, v] of [[up, t.up], [dn, t.down]] as const) { el.setAttribute('x1', String(f.X(v ?? 0))); el.setAttribute('x2', String(f.X(v ?? 0))); el.style.display = v === null ? 'none' : ''; }
    read.replaceChildren(h('span', null, 'VT− ', h('b', null, t.down === null ? 'never' : `${nf(t.down)} V`)), h('span', null, 'VT+ ', h('b', null, t.up === null ? 'never' : `${nf(t.up)} V`)),
      h('span', null, 'width ', h('b', null, t.width === null ? '–' : `${nf(t.width)} V`)));
    note.textContent = t.width === null
      ? `The keeper is ${nf(kappa)}× the input devices: past ${nf(keeperLimit())}× the input inverter can no longer flip node m, and the output sticks.`
      : `Solid: the keeper holds m high (output 0), so the input must rise to ${nf(t.up!)} V before m falls below B's threshold. Light: the keeper holds m low, so the input must fall to ${nf(t.down!)} V.`;
  };
  const kSl = slider('Keeper', 0, 1.2, 0.01, kappa, (v) => `${nf(v)}×`, (v) => { kappa = v; paint(); });
  const el = h('div', { class: 'mem-panel cpu-panel mc-panel clk-panel', 'data-dock': 'right' }, h('h4', null, 'Thresholds from the current balance', h('span', { class: 'fold-hint' })),
    f.svg, kSl.el, read, note, h('p', { class: 'sub' }, 'Square-law model of chapter 1 (phys/schmitt.ts). The switch-level circuit beside it shows who wins by strength; this shows at what voltage.'));
  paint();
  return { el };
};

// ---- 3. a noisy slow edge --------------------------------------------------------------------------------------------

export function noisyEdgeWidget(): Widget {
  let sigma = 0.04, seed = 7, kappa = KEEPER;
  const N = 400;
  const f = frame(560, 210, [0, N], [0, VDD], 'sample', 'input (V)', 'A slow noisy edge with the receivers thresholds', 100, 0.6, { l: 44, r: 10, t: 10, b: 30 });
  const trace = f.svg.appendChild(s('path', { class: 'clk-in' }));
  const lines = [0, 1, 2].map((i) => f.svg.appendChild(s('line', { class: i ? 'bound' : 'vt', x1: f.X(0), x2: f.X(N) })));
  const dig = (cls: string) => { const sv = s('svg', { viewBox: `0 0 560 44`, class: 'mos-plot clk-dig', role: 'img' }) as SVGSVGElement; fitText(sv, 560); return { sv, p: sv.appendChild(s('path', { class: cls })) }; };
  const a = dig('clk-out-plain'), b = dig('clk-out-sch');
  a.sv.setAttribute('aria-label', 'Output of a plain receiver'); b.sv.setAttribute('aria-label', 'Output of a Schmitt trigger');
  const cA = h('b'), cB = h('b');
  const stat = h('p', { class: 'sub mos-note' });
  const digPath = (bits: number[]) => path(bits.flatMap((v, i): [number, number][] => [[44 + (i / (N - 1)) * (560 - 54), 38 - v * 32], [44 + ((i + 1) / (N - 1)) * (560 - 54), 38 - v * 32]]));
  const paint = () => {
    const tr = noisyEdge(seed, sigma, N), t = thresholds(kappa);
    const upv = t.up ?? VDD + 1, dnv = t.down ?? -1;
    trace.setAttribute('d', path(tr.map((v, i): [number, number] => [f.X(i), f.Y(v)])));
    [VM, upv, dnv].forEach((v, i) => { lines[i].setAttribute('y1', String(f.Y(v))); lines[i].setAttribute('y2', String(f.Y(v))); lines[i].style.display = i && (i === 1 ? t.up === null : t.down === null) ? 'none' : ''; });
    const pb = receive(tr, VM, VM), sb = receive(tr, upv, dnv);
    a.p.setAttribute('d', digPath(pb)); b.p.setAttribute('d', digPath(sb));
    cA.textContent = String(transitions(pb)); cB.textContent = String(transitions(sb));
    let sumP = 0, sumS = 0, worst = 0;
    for (let k = 1; k <= 200; k++) { const x = noisyEdge(k * 7919, sigma, N), p1 = transitions(receive(x, VM, VM)), s1 = transitions(receive(x, upv, dnv)); sumP += p1; sumS += s1; worst = Math.max(worst, p1); }
    stat.textContent = `Over 200 seeds at this noise: the plain receiver makes ${nf(sumP / 200, 1)} transitions per edge on average (worst ${worst}), the Schmitt trigger ${nf(sumS / 200, 1)}. The ideal is 1.`;
  };
  const sSl = slider('Noise σ', 0, 0.4, 0.01, sigma, (v) => `${nf(v)} V`, (v) => { sigma = v; paint(); });
  const kSl = slider('Keeper', 0, 0.8, 0.01, kappa, (v) => `${nf(v)}×`, (v) => { kappa = v; paint(); });
  const roll = h('button', { class: 'btn sm', title: 'Draw another noise sequence' }, 'New noise');
  roll.addEventListener('click', () => { seed = (seed * 31 + 17) % 100003; paint(); });
  const el = h('div', { class: 'widget mos clk-w' },
    h('div', { class: 'panel' }, h('h3', null, 'A slow edge with Gaussian noise'), f.svg),
    h('div', { class: 'panel clk-outs' },
      h('div', null, h('span', { class: 'lbl' }, 'Plain receiver, one threshold at VM ', cA, ' transitions'), a.sv),
      h('div', null, h('span', { class: 'lbl' }, 'Schmitt trigger, thresholds apart ', cB, ' transitions'), b.sv)),
    h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' }, sSl.el, kSl.el, roll), stat,
      h('p', { class: 'sub mos-note' }, `Input: a ramp of ${N} samples from 0 to ${VDD} V plus seeded Gaussian noise on every sample. Dashed: VM ${nf(VM)} V; green: the Schmitt thresholds for this keeper.`)));
  paint();
  return { el };
}

// ---- 4. why unrelated clocks land in the window ----------------------------------------------------------------------

export function windowWidget(): Widget {
  let ratio = 1.37, offset = 0.4;
  const N = 600;
  const f = frame(560, 200, [0, N], [0, 1], 'edge of clock A', 'phase in B\'s period', 'Phase of each of clock A\'s edges inside clock B\'s period', 100, 0.25, { l: 44, r: 10, t: 10, b: 30 });
  const win = f.svg.appendChild(s('rect', { class: 'clk-zone', x: f.X(0), width: f.X(N) - f.X(0) }));
  const win2 = f.svg.appendChild(s('rect', { class: 'clk-zone', x: f.X(0), width: f.X(N) - f.X(0) }));
  const dots = f.svg.appendChild(s('g', { class: 'clk-dots' }));
  const out = h('div', { class: 'mc-status' }), note = h('p', { class: 'sub mos-note' });
  const fb = 1e9; // clock B, for the picoseconds only
  const paint = () => {
    const ms = MS_TIMING(), win0 = (ms.setup * PS_PER_NAND) / (1e12 / fb), winA = (ms.hold * PS_PER_NAND) / (1e12 / fb); // before the edge: setup; after: hold, in periods of B
    const l = landings(ratio, 1, N, win0, winA, offset);
    win.setAttribute('y', String(f.Y(1))); win.setAttribute('height', String(f.Y(1 - win0) - f.Y(1)));
    win2.setAttribute('y', String(f.Y(winA))); win2.setAttribute('height', String(f.Y(0) - f.Y(winA)));
    dots.replaceChildren(...l.phases.map((p, i) => s('circle', { cx: f.X(i), cy: f.Y(p), r: 1.8 })));
    const [pq, qq] = reduce(ratio);
    out.replaceChildren(h('span', null, 'fA : fB ', h('b', null, `${pq} : ${qq}`)), h('span', null, 'distinct phases ', h('b', null, String(l.distinct))),
      h('span', null, `edges in the window of ${N} `, h('b', null, String(l.hits))), h('span', null, 'expected if uniform ', h('b', null, nf(N * windowFraction(win0, winA), 1))));
    note.textContent = l.distinct <= 5
      ? `Related clocks: the edge lands on ${l.distinct} fixed phase${l.distinct === 1 ? '' : 's'} for ever. Static timing checks each one; it either always meets setup and hold or never does.`
      : `${l.distinct} different phases and counting: no analysis can list them, and with real oscillators drifting by parts per million the phase wanders through all of them. Sooner or later an edge lands in the window.`;
  };
  const rSl = slider('fA / fB', 0.3, 3, 0.01, ratio, (v) => nf(v), (v) => { ratio = v; paint(); });
  const oSl = slider('Phase', 0, 1, 0.01, offset, (v) => nf(v), (v) => { offset = v; paint(); });
  const el = h('div', { class: 'widget mos clk-w' }, h('div', { class: 'panel' }, h('h3', null, 'Where A\'s data changes, seen from B\'s clock'), f.svg),
    h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' }, rSl.el, oSl.el), out, note,
      h('p', { class: 'sub mos-note' }, `Shaded: the window around B's rising edge, ${MS_TIMING().setup} NAND delays before it (setup) and ${MS_TIMING().hold} after (hold), as measured on the flip-flop in chapter 8, at a B clock of ${fb / 1e6} MHz and ${PS_PER_NAND} ps per NAND delay. Try 1.00 (the same clock), 1.50 (3 : 2), then 1.37.`)));
  paint();
  return { el };
}

// ---- 5. metastability: resolution and MTBF -----------------------------------------------------------------------------

export function metastableWidget(): Widget {
  let dvExp = -4, stages = 2, fclkMHz = 1000, fdataMHz = 100, logic = 8;
  const T = 400; // ps shown
  const f = frame(520, 200, [0, T], [-V_DECIDED, V_DECIDED], 't after the sampling edge (ps)', 'difference (V)', 'A cross-coupled pair resolving from a small difference', 100, 0.45, { l: 50, r: 12, t: 10, b: 30 });
  const curveP = f.svg.appendChild(s('path', { class: 'cur' }));
  const per = f.svg.appendChild(s('line', { class: 'bound', y1: f.m.t, y2: f.H - f.m.b }));
  const tmark = f.svg.appendChild(s('text', { class: 'rl sat', 'text-anchor': 'end' }));
  const g = frame(520, 220, [0.2, 3], [0, 70], 'receiving clock (GHz)', 'log10 MTBF (s)', 'MTBF against clock rate for one, two and three flip-flops', 0.4, 10, { l: 50, r: 12, t: 10, b: 32 });
  const curves = [1, 2, 3].map((n) => g.svg.appendChild(s('path', { class: `clk-mt c${n}` })));
  const age = g.svg.appendChild(s('line', { class: 'vt', x1: g.X(0.2), x2: g.X(3) }));
  g.svg.append(s('text', { x: g.X(3) - 2, class: 'tick', 'text-anchor': 'end', id: 'clk-age' }));
  const pt = g.svg.appendChild(s('circle', { r: 5, class: 'op' }));
  const legend = h('div', { class: 'clk-legend' }, ...[1, 2, 3].map((n) => h('span', { class: `c${n}` }, n === 1 ? '1 flop + logic' : `${n} flops`)));
  const readout = h('div', { class: 'mos-chips' }, h('div'), h('div'), h('div'), h('div'));
  const verdict = h('p', { class: 'clk-verdict', role: 'status' });
  const paint = () => {
    const dv = 10 ** dvExp, tr = resolveTime(dv);
    curveP.setAttribute('d', path(Array.from({ length: 161 }, (_, i): [number, number] => [f.X((i / 160) * T), f.Y(voltage(dv, (i / 160) * T))])));
    const periodPs = 1e6 / fclkMHz;
    per.setAttribute('x1', String(f.X(Math.min(T, periodPs)))); per.setAttribute('x2', String(f.X(Math.min(T, periodPs))));
    per.style.display = periodPs <= T ? '' : 'none';
    tmark.setAttribute('x', String(f.X(Math.min(T, tr)) + 8)); tmark.setAttribute('y', String(f.Y(V_DECIDED) + 16)); tmark.setAttribute('text-anchor', 'start');
    tmark.textContent = tr > T ? `decided at ${nf(tr, 0)} ps` : `decided at ${nf(tr, 0)} ps = ${nf(tr / TAU_PS, 1)} τ`;
    curves.forEach((c, i) => c.setAttribute('d', path(Array.from({ length: 80 }, (_, k): [number, number] => {
      const gh = 0.2 + (k / 79) * 2.8, l = log10Mtbf({ stages: i + 1, fclk: gh * 1e9, fdata: fdataMHz * 1e6, logic });
      return [g.X(gh), g.Y(Math.max(0, Math.min(70, l)))];
    }))));
    const yAge = Math.log10(AGE_OF_UNIVERSE_YEARS * 365.25 * 86400);
    age.setAttribute('y1', String(g.Y(yAge))); age.setAttribute('y2', String(g.Y(yAge)));
    const inp = { stages, fclk: fclkMHz * 1e6, fdata: fdataMHz * 1e6, logic };
    const l = log10Mtbf(inp), trs = resolutionTime(stages, 1e6 / fclkMHz, logic * PS_PER_NAND), rate = windowRate(inp.fclk, inp.fdata);
    pt.setAttribute('cx', String(g.X(fclkMHz / 1000))); pt.setAttribute('cy', String(g.Y(Math.max(0, Math.min(70, l)))));
    const vals: [string, string][] = [[`${nf(trs, 0)} ps`, 'resolution time t_r'], [`${rate.toExponential(1)} /s`, 'events in the window T0·fclk·fdata'], [`${nf(Math.exp(-trs / TAU_PS) > 0 ? trs / TAU_PS : 0, 1)} τ`, 'e-foldings available'], [fmtLog10(l), 'MTBF']];
    readout.querySelectorAll('div').forEach((c, i) => (c as HTMLElement).replaceChildren(h('b', null, vals[i][0]), h('span', null, vals[i][1])));
    const y = 10 ** (l - Math.log10(365.25 * 86400));
    verdict.className = `clk-verdict ${y > 1e3 ? 'ok' : 'bad'}`;
    verdict.textContent = y > AGE_OF_UNIVERSE_YEARS ? `A failure every ${fmtLog10(l)}: longer than the universe has existed (${AGE_OF_UNIVERSE_YEARS.toExponential(2)} years). Not zero, but not a design risk.`
      : y > 1e3 ? `One failure in ${fmtLog10(l)}.` : `One failure in ${fmtLog10(l)}: a product that ships ten million units fails somewhere every ${fmtDuration(10 ** l / 1e7)}.`;
    void tr;
  };
  const dSl = slider('Δ at the edge', -9, -1, 0.1, dvExp, (v) => `${(10 ** v).toExponential(0)} V`, (v) => { dvExp = v; paint(); });
  const sSl = slider('Flops', 1, 3, 1, stages, (v) => String(v), (v) => { stages = v; paint(); });
  const cSl = slider('fclk', 200, 3000, 50, fclkMHz, (v) => `${v} MHz`, (v) => { fclkMHz = v; paint(); });
  const fSl = slider('fdata', 1, 500, 1, fdataMHz, (v) => `${v} MHz`, (v) => { fdataMHz = v; paint(); });
  const lSl = slider('Logic', 0, 20, 1, logic, (v) => `${v} NAND`, (v) => { logic = v; paint(); });
  const el = h('div', { class: 'widget mos clk-w' },
    h('div', { class: 'panel' }, h('h3', null, 'The pair resolves exponentially'), f.svg, h('div', { class: 'mos-row' }, dSl.el),
      h('p', { class: 'sub mos-note' }, `V(t) = Δ·e^(t/τ) with τ = ${nf(TAU_PS / PS_PER_NAND, 1)} NAND delays = ${nf(TAU_PS, 0)} ps, until a node is ${V_DECIDED} V from the balance point. The dashed line is one clock period.`)),
    h('div', { class: 'panel' }, h('h3', null, 'MTBF = e^(t_r / τ) / (T0 · fclk · fdata)'), g.svg, legend,
      h('div', { class: 'mos-row' }, sSl.el, cSl.el, fSl.el, lSl.el), readout, verdict,
      h('p', { class: 'sub mos-note' }, `T0 = ${nf(T0_PS / PS_PER_NAND, 0)} NAND delay (${T0_PS} ps), τ = ${nf(TAU_PS / PS_PER_NAND, 1)} NAND delays, ${PS_PER_NAND} ps per NAND delay, clock-to-q ${CLK_TO_Q} and setup ${SETUP} delays per hop: illustrative constants of phys/metastable.ts, not a characterized cell. These figures are the model's. The dashed line is the age of the universe.`)));
  paint();
  return { el };
}

// ---- 6. a bus cannot be synchronized bit by bit -----------------------------------------------------------------------

export function grayBusWidget(): Widget {
  const n = 4;
  let step = 7, code: 'binary' | 'gray' = 'binary';
  const bin = (x: number) => x.toString(2).padStart(n, '0');
  const rows = { binary: table(n, 'binary'), gray: table(n, 'gray') };
  const list = h('div', { class: 'clk-reads' }), info = h('div', { class: 'mc-status' }), bars = h('div', { class: 'clk-bars' });
  // the bars are built once and updated in place, so a keyboard user keeps the focus on the bar they pressed
  const barBtns = Array.from({ length: 2 ** n }, (_, i) => {
    const b = h('button', { class: 'clk-bar' }, h('i'), h('span', null, String(i)));
    b.addEventListener('click', () => { step = i; paint(); });
    return b;
  });
  bars.append(...barBtns);
  const gates = h('p', { class: 'sub mos-note' });
  const paint = () => {
    const r = rows[code][step], rd = readings(r.from, r.to);
    list.replaceChildren(...rd.map((w) => h('span', { class: `clk-rd ${w === r.from ? 'old' : w === r.to ? 'new' : 'bad'}`, title: w === r.from ? 'the old value' : w === r.to ? 'the new value' : 'neither the old nor the new value' }, h('b', null, bin(w)), h('span', null, `${w}`))));
    info.replaceChildren(h('span', null, 'bus ', h('b', null, `${bin(r.from)} → ${bin(r.to)}`)), h('span', null, 'bits changing ', h('b', null, String(r.flips))), h('span', null, 'possible readings ', h('b', null, String(r.reads))),
      h('span', null, 'garbage ', h('b', null, String(r.bad))), h('span', null, 'worst error ', h('b', null, code === 'binary' ? `${r.err} counts` : `${r.err} (a Gray word)`)));
    rows[code].forEach((q, i) => {
      const b = barBtns[i];
      b.className = `clk-bar${i === step ? ' on' : ''}${q.bad ? ' bad' : ''}`;
      b.title = `${bin(q.from)} → ${bin(q.to)}: ${q.reads} readings`;
      b.setAttribute('aria-label', `step ${i}: ${q.reads} possible readings`);
      b.setAttribute('aria-pressed', String(i === step));
      b.style.setProperty('--hgt', `${(q.reads / 16) * 100}%`);
    });
    gates.textContent = `Mean chance that a mid-change sample is garbage over all ${2 ** n} steps: binary ${nf(meanGarbage(n, 'binary') * 100, 0)} %, Gray 0 %. In gates: binary → Gray is ${stats(BIN2GRAY(n)).nands} NANDs (${n - 1} XORs, one level), Gray → binary ${stats(GRAY2BIN(n)).nands} NANDs (a chain ${n - 1} deep). In Gray mode the words shown are code words.`;
  };
  const sel = h('div', { class: 'mos-row' });
  for (const c of ['binary', 'gray'] as const) {
    const b = h('button', { class: 'btn sm', 'aria-pressed': String(c === code) }, c === 'binary' ? 'Binary count' : 'Gray count');
    b.addEventListener('click', () => { code = c; sel.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); paint(); });
    sel.append(b);
  }
  const el = h('div', { class: 'widget mos clk-w' }, h('div', { class: 'panel' }, h('h3', null, 'A counter on a bus, sampled by an unrelated clock'), sel,
    h('p', { class: 'sub' }, 'Pick a step of the count (bar height: how many words the sampler might read). Each changing bit has its own wire delay, so the sampler may catch any subset of them already flipped.'), bars, info, list, gates));
  paint();
  return { el };
}

// ---- two clocks over a gate-level circuit ---------------------------------------------------------------------------------

export interface ClockRow { label: string; read: (stage: Stage) => number | string; domain?: 'a' | 'b'; bits?: number }
export interface TwoClockConfig {
  title: string;
  a: { clk: string; name: string };
  b: { clk: string; name: string };
  /** Ratios offered (fa : fb). */
  ratios?: readonly [number, number][];
  ratio?: number;
  /** Before each edge: set the data inputs for it. n counts that domain's edges. */
  drive?: (edge: 'a' | 'b', n: number, stage: Stage) => void;
  rows: ClockRow[];
  /** Buttons that act on the circuit between edges (they may queue what drive uses). */
  actions?: { label: string; title: string; run: (stage: Stage, start: () => void) => void }[];
  /** A summary beneath the strip, rebuilt after every edge. */
  extra?: (stage: Stage) => HTMLElement[];
  /** Called when the stage resets the circuit (a power cycle): the scene's own bookkeeping goes back to its start. Clear strip does not call it. */
  reset?: () => void;
  /** Controls built once and kept (sliders, selects): unlike `extra` they are not rebuilt after every edge, so they can be dragged and keep focus. */
  controls?: (stage: Stage) => HTMLElement[];
  /** A word for the scene's outcome so far ('lost', 'seen' …): what the chapter's challenges check. */
  status?: () => string;
  /** The scene's own state that Back puts back with the circuit. */
  history?: { save(): unknown; restore(v: unknown): void };
  hint?: string;
}

export interface ClockApi { status(): string; setRatio(i: number): void; action(i: number): void; steps(n: number): void }
/** What a challenge (check, solve) can ask of a scene's panel. */
export const clockApi = new WeakMap<Stage, ClockApi>();

interface StripEv { e: 'a' | 'b'; n: number; vals: string[] }
const STRIP = 22;

/** Read a port of a node somewhere below the root (path of instance names), packed. */
export function portAt(stage: Stage, path: string[], port: string): number {
  const sim = stage.sim!;
  const node = path.length ? findNode(sim.design.root, path) : sim.design.root;
  return node ? pack(sim.getBits(node.ports[port])) : -1;
}

/**
 * The panel that ticks two clocks one edge at a time in a chosen ratio (EdgeSchedule: never two at once), applies the
 * circuit's data inputs for each, and keeps a strip of what the watched signals were after every edge. Run steps the
 * schedule at a steady rate. Back and Reset restore the strip with the circuit.
 */
export function twoClockPanel(cfg: TwoClockConfig): ScenePanel {
  return (stage: Stage): Widget => {
    const ratios = cfg.ratios ?? RATIOS;
    let ri = cfg.ratio ?? 0, sched = new EdgeSchedule(...ratios[ri]);
    const log: StripEv[] = [];
    let count = { a: 0, b: 0 }, timer: ReturnType<typeof setInterval> | null = null;
    const snap = () => ({ log: log.map((e) => ({ ...e, vals: [...e.vals] })), i: sched.i, j: sched.j, count: { ...count }, ri });
    stage.historyHooks.add({
      save: () => ({ ...snap(), own: cfg.history?.save() }),
      restore: (v) => { const x = v as ReturnType<typeof snap> & { own: unknown }; cfg.history?.restore(x.own); ri = x.ri; sched = new EdgeSchedule(...ratios[ri]); sched.i = x.i; sched.j = x.j; count = { ...x.count }; log.length = 0; log.push(...x.log); sel.value = String(ri); update(); },
    });
    const clearStrip = () => { log.length = 0; update(); };
    const clear = () => { log.length = 0; count = { a: 0, b: 0 }; sched = new EdgeSchedule(...ratios[ri]); cfg.reset?.(); update(); };
    stage.resetHooks.add(() => { stopRun(); clear(); });
    const fmt = (v: number | string, bits?: number) => (typeof v === 'string' ? v : v < 0 ? 'X' : bits && bits > 1 ? v.toString(16).toUpperCase() : String(v));
    const edge = (e: 'a' | 'b') => {
      const sim = stage.sim;
      if (!sim) return;
      const clk = e === 'a' ? cfg.a.clk : cfg.b.clk;
      cfg.drive?.(e, count[e], stage);
      sim.settle(); // the data is steady before the clock moves: an edge is an event after the inputs, never with them
      sim.setInput(clk, 1); sim.settle(); sim.setInput(clk, 0); sim.settle();
      record(e);
    };
    const record = (e: 'a' | 'b') => {
      count[e]++;
      log.push({ e, n: count[e], vals: cfg.rows.map((r) => fmt(r.read(stage), r.bits)) });
      if (log.length > STRIP) log.shift();
    };
    // the stage's own clock (the bottom bar's Pulse, Run, Step) is clock A: its edges go through the same drive and strip
    const hook = {
      before: () => { cfg.drive?.('a', count.a, stage); stage.sim?.settle(); },
      after: () => { record('a'); update(); },
    };
    stage.edgeHooks.add(hook);
    const act = (f: () => void) => { stage.checkpoint(); f(); stage.refresh(); update(); };
    const next = () => edge(sched.next() === 'w' ? 'a' : 'b');
    const stopRun = () => { if (timer) clearInterval(timer); timer = null; runBtn.textContent = 'Run'; runBtn.setAttribute('aria-pressed', 'false'); };
    const startRun = () => { if (timer) return; runBtn.textContent = 'Pause'; runBtn.setAttribute('aria-pressed', 'true'); timer = setInterval(() => { stage.checkpoint(); next(); stage.refresh(); update(); }, 380); };
    const btn = (label: string, title: string, f: () => void, cls = 'btn sm') => { const b = h('button', { class: cls, title }, label); b.addEventListener('click', f); return b; };
    const runBtn = btn('Run', 'Tick the two clocks in the chosen ratio at a steady rate', () => (timer ? stopRun() : startRun()), 'btn sm primary');
    runBtn.setAttribute('aria-pressed', 'false');
    const sel = h('select', { class: 'mc-sel', 'aria-label': `Clock ratio ${cfg.a.name} : ${cfg.b.name}` }) as HTMLSelectElement;
    ratios.forEach(([x, y], i) => sel.append(h('option', { value: String(i) }, `${cfg.a.name} : ${cfg.b.name} = ${x} : ${y}`)));
    sel.value = String(ri);
    sel.addEventListener('change', () => { ri = Number(sel.value); stage.checkpoint(); sched = new EdgeSchedule(...ratios[ri]); update(); });
    const strip = h('div', { class: 'clk-strip', role: 'group', 'aria-label': 'What each signal was after each clock edge' });
    const extra = h('div', { class: 'clk-extra' });
    const controls = h('div', { class: 'clk-extra' }, ...(cfg.controls?.(stage) ?? []));
    const el = h('div', { class: 'mem-panel cpu-panel mc-panel clk-panel', 'data-dock': 'right' },
      h('h4', null, cfg.title, h('span', { class: 'fold-hint' })),
      h('div', { class: 'mc-row' }, sel),
      h('div', { class: 'dram-ops' },
        btn(`${cfg.a.name} edge`, `One rising edge of ${cfg.a.clk}`, () => act(() => edge('a'))),
        btn(`${cfg.b.name} edge`, `One rising edge of ${cfg.b.clk}`, () => act(() => edge('b'))),
        btn('Next', 'The next edge in the ratio\'s order', () => act(next)), runBtn,
        ...(cfg.actions ?? []).map((a) => btn(a.label, a.title, () => act(() => a.run(stage, () => { startRun(); })))),
        btn('Clear strip', 'Forget the strip (the circuit and the scene keep their state)', () => act(clearStrip))),
      h('div', { class: 'cpu-sec' }, `Every edge, the last ${STRIP}`), strip, extra, controls, cfg.hint ? h('p', { class: 'sub' }, cfg.hint) : null);
    const update = () => {
      const lab = (t: string, cls: string) => h('span', { class: `clk-lab ${cls}` }, t);
      strip.replaceChildren(
        h('div', { class: 'clk-row' }, lab('edge', ''), ...log.map((ev) => h('span', { class: `clk-c ${ev.e}`, title: `${ev.e === 'a' ? cfg.a.clk : cfg.b.clk} edge ${ev.n}` }, ev.e === 'a' ? cfg.a.name : cfg.b.name))),
        ...cfg.rows.map((r, k) => h('div', { class: 'clk-row' }, lab(r.label, r.domain ?? ''), ...log.map((ev, i) => {
          const v = ev.vals[k], prev = i ? log[i - 1].vals[k] : v;
          return h('span', { class: `clk-c v${v === '0' ? '0' : v === 'X' ? 'x' : '1'}${v !== prev ? ' chg' : ''}` }, v);
        }))));
      if (!log.length) strip.append(h('div', { class: 'sub' }, 'Press Run, or tick one clock at a time.'));
      extra.replaceChildren(...(cfg.extra?.(stage) ?? []));
    };
    update();
    clockApi.set(stage, {
      status: () => cfg.status?.() ?? '',
      setRatio: (i) => act(() => { ri = i; sel.value = String(i); sched = new EdgeSchedule(...ratios[ri]); }),
      action: (i) => act(() => cfg.actions![i].run(stage, () => undefined)),
      steps: (n) => act(() => { for (let k = 0; k < n; k++) next(); }),
    });
    return { el, update, destroy: () => { stopRun(); stage.edgeHooks.delete(hook); clockApi.delete(stage); } };
  };
}

// ---- the scenes ---------------------------------------------------------------------------------------------------------

const seq = (arr: number[]) => {
  let i = 0;
  return { next: () => (i < arr.length ? arr[i++] : 0), set: (a: number[]) => { arr = a; i = 0; }, pending: () => i < arr.length, save: (): [number[], number] => [arr, i], load: (v: [number[], number]) => { arr = v[0]; i = v[1]; } };
};

/** SYNC_BENCH: a one-A-cycle pulse and a held level into a two-flop synchronizer on the other clock. */
export function syncScene(): Scene {
  const plan = seq([]);
  let sent = 0, seen = 0, state: 'idle' | 'pending' | 'seen' | 'lost' = 'idle', bAfter = 0;
  const cfg: TwoClockConfig = {
    title: 'Two clocks, one crossing',
    a: { clk: 'aclk', name: 'A' }, b: { clk: 'bclk', name: 'B' },
    ratios: [[3, 1], [1, 1], [1, 3], [2, 3], [5, 2]], ratio: 0,
    drive: (e, _n, st) => {
      if (e === 'a') { const v = plan.next(); st.sim!.setInput('send', v); if (v) sent++; } else {
        const q = portAt(st, [], 'q'); if (q === 1) seen++;
        if (state === 'pending') { if (!plan.pending()) bAfter++; if (seen > 0) state = 'seen'; else if (bAfter > 4) state = 'lost'; }
      }
    },
    rows: [{ label: 'send', read: (st) => portAt(st, [], 'send'), domain: 'a' }, { label: 'a', read: (st) => portAt(st, [], 'a'), domain: 'a' },
      { label: 'm', read: (st) => portAt(st, ['sy', 'f0'], 'q'), domain: 'b' }, { label: 'q', read: (st) => portAt(st, [], 'q'), domain: 'b' }],
    actions: [
      { label: 'Send 1-cycle pulse', title: 'send = 1 for one A cycle', run: (_s, start) => { plan.set([1, 0]); sent = 0; seen = 0; bAfter = 0; state = 'pending'; start(); } },
      { label: 'Hold send 4 cycles', title: 'send = 1 for four A cycles', run: (_s, start) => { plan.set([1, 1, 1, 1, 0]); sent = 0; seen = 0; bAfter = 0; state = 'pending'; start(); } },
    ],
    status: () => state,
    extra: () => [h('div', { class: `mc-status clk-result ${state}` }, h('span', null, 'last send: ', h('b', null, state === 'idle' ? 'none yet' : state === 'pending' ? 'in flight' : state === 'seen' ? 'seen by B' : 'lost: B never saw it')))],
    reset: () => { plan.set([]); state = 'idle'; sent = seen = bAfter = 0; },
    history: { save: () => ({ p: plan.save(), sent, seen, state, bAfter }), restore: (v) => { const x = v as { p: [number[], number]; sent: number; seen: number; state: typeof state; bAfter: number }; plan.load(x.p); ({ sent, seen, state, bAfter } = x); } },
    hint: 'q is 1 when B has seen the level. The sender flop launches a 1 at A\'s edge; B only samples what is on the wire at its own edges.',
  };
  return { root: SYNC_BENCH, inputs: { send: 0, aclk: 0, bclk: 0 }, clock: 'aclk', autoClock: false, hiddenInputs: ['send', 'bclk'], panels: [twoClockPanel(cfg)] };
}

/** PULSE_SYNC: events in A, events out in B. */
export function pulseScene(): Scene {
  const plan = seq([]);
  let sent = 0, got = 0, prev = 0, quiet = 0;
  const cfg: TwoClockConfig = {
    title: 'One event across',
    a: { clk: 'aclk', name: 'A' }, b: { clk: 'bclk', name: 'B' },
    ratios: [[3, 1], [1, 1], [1, 3], [2, 3], [5, 2]], ratio: 0,
    drive: (e, _n, st) => {
      if (e === 'a') { const v = plan.next(); st.sim!.setInput('pulse', v); if (v) { sent++; quiet = 0; } } else { const o = portAt(st, [], 'out'); if (o && !prev) got++; prev = o; if (sent && !plan.pending()) quiet++; }
    },
    rows: [{ label: 'pulse', read: (st) => portAt(st, [], 'pulse'), domain: 'a' }, { label: 't', read: (st) => portAt(st, ['tg'], 'q'), domain: 'a' },
      { label: 'sync', read: (st) => portAt(st, ['sy'], 'q'), domain: 'b' }, { label: 'out', read: (st) => portAt(st, [], 'out'), domain: 'b' }],
    actions: [
      { label: 'Send 1 pulse', title: 'pulse = 1 for the next A edge', run: (_s, start) => { plan.set([1]); start(); } },
      { label: 'Send 2 close', title: 'two pulses on consecutive A edges', run: (_s, start) => { plan.set([1, 1]); start(); } },
      { label: 'Send 2 apart', title: 'two pulses on A edges five apart', run: (_s, start) => { plan.set([1, 0, 0, 0, 0, 1]); start(); } },
    ],
    status: () => (sent > 1 && quiet > 6 && got < sent ? 'lost' : ''),
    extra: () => [h('div', { class: 'mc-status' }, h('span', null, 'sent ', h('b', null, String(sent))), h('span', null, 'received ', h('b', null, String(got))))],
    reset: () => { plan.set([]); sent = got = prev = quiet = 0; },
    history: { save: () => ({ p: plan.save(), sent, got, prev, quiet }), restore: (v) => { const x = v as { p: [number[], number]; sent: number; got: number; prev: number; quiet: number }; plan.load(x.p); ({ sent, got, prev, quiet } = x); } },
    hint: 'The level t flips on each pulse and holds; B synchronizes the level (sync) and out is high for one B cycle when sync differs from its previous value.',
  };
  return { root: PULSE_SYNC, inputs: { pulse: 0, aclk: 0, bclk: 0 }, clock: 'aclk', autoClock: false, hiddenInputs: ['pulse', 'bclk'], panels: [twoClockPanel(cfg)] };
}

/** The asynchronous FIFO with a model beside it. */
export function fifoScene(k = 2, w = 8): Scene {
  type Mode = 'both' | 'fill' | 'drain' | 'idle';
  let mode: Mode = 'both', pw = 60, pr = 60, rng = 12345, wseq = 1, wrote = 0, readN = 0, lost = 0, match = true;
  const model = new AsyncFifoModel(k, w);
  const rnd = (n: number) => { rng = (Math.imul(rng, 1103515245) + 12345) >>> 0; return Math.floor((rng / 4294967296) * n); };
  const traffic = (): { we: number; re: number } => ({
    we: mode === 'fill' ? 1 : mode === 'both' ? +(rnd(100) < pw) : 0, re: mode === 'drain' ? 1 : mode === 'both' ? +(rnd(100) < pr) : 0,
  });
  const cfg: TwoClockConfig = {
    title: 'Two clocks, one FIFO',
    a: { clk: 'wclk', name: 'W' }, b: { clk: 'rclk', name: 'R' },
    ratios: RATIOS, ratio: 0,
    drive: (e, _n, st) => {
      const sim = st.sim!, { we, re } = traffic();
      if (e === 'a') {
        sim.setInput('we', we); sim.setInput('wdata', wseq & 255);
        const r = model.wEdge(!!we, wseq & 255);
        if (r.did) { wseq++; wrote++; }
      } else {
        sim.setInput('re', re);
        const word = pack(sim.getBits(sim.design.root.ports.rdata));
        const r = model.rEdge(!!re);
        if (r.did) { readN++; if (word !== r.word) lost++; }
      }
    },
    rows: [
      { label: 'we', read: (st) => portAt(st, [], 'we') > 0 ? 1 : 0, domain: 'a' }, { label: 'full', read: (st) => portAt(st, [], 'full'), domain: 'a' },
      { label: 're', read: (st) => portAt(st, [], 're') > 0 ? 1 : 0, domain: 'b' }, { label: 'empty', read: (st) => portAt(st, [], 'empty'), domain: 'b' },
      { label: 'rdata', read: (st) => portAt(st, [], 'rdata'), domain: 'b', bits: w },
    ],
    actions: [
      { label: 'Fill', title: 'Write on every W edge, read nothing', run: () => { mode = 'fill'; } },
      { label: 'Drain', title: 'Read on every R edge, write nothing', run: () => { mode = 'drain'; } },
      { label: 'Both', title: 'Write and read at random', run: () => { mode = 'both'; } },
    ],
    status: () => (lost ? 'wrong' : ''),
    controls: () => {
      const rate = (label: string, aria: string, get: () => number, set: (v: number) => void) => {
        const out = h('output', null, String(get()));
        const input = h('input', { type: 'range', min: 0, max: 100, step: 5, value: get(), 'aria-label': aria }) as HTMLInputElement;
        input.addEventListener('input', () => { set(Number(input.value)); out.textContent = input.value; });
        return h('label', { class: 'mos-sl clk-tr' }, h('span', null, label), input, out);
      };
      return [
        rate('Write %', 'Probability of a write at each W edge in Both mode', () => pw, (v) => { pw = v; }),
        rate('Read %', 'Probability of a read at each R edge in Both mode', () => pr, (v) => { pr = v; }),
      ];
    },
    extra: (st) => {
      const wb = portAt(st, ['wb'], 'q'), rb = portAt(st, ['rb'], 'q'), mask = 2 ** (k + 1) - 1;
      const rSeen = fromGray(portAt(st, ['rs'], 'q')), wSeen = fromGray(portAt(st, ['ws'], 'q'));
      const truth = (wb - rb) & mask, wThinks = (wb - rSeen) & mask, rThinks = (wSeen - rb) & mask;
      const full = portAt(st, [], 'full') === 1, empty = portAt(st, [], 'empty') === 1;
      match = model.occupancy === truth && model.full === full && model.empty === empty;
      const N = 2 ** k;
      const cells = Array.from({ length: N }, (_, i) => {
        const n = (i - (rb & (N - 1)) + N) % N, has = n < truth;
        return h('span', { class: `clk-slot${has ? ' on' : ''}${i === (rb & (N - 1)) ? ' head' : ''}`, title: `word ${i}` }, has ? String(portAt(st, [`w${i}`], 'q')) : '');
      });
      return [
        h('div', { class: 'clk-slots', role: 'img', 'aria-label': `${truth} of ${N} words in the FIFO` }, ...cells),
        h('div', { class: 'mc-status' },
          h('span', null, 'truth ', h('b', null, `${truth} / ${N}`)), h('span', null, 'writer believes ', h('b', null, `${N - wThinks} free`)), h('span', null, 'reader believes ', h('b', null, `${rThinks} waiting`))),
        h('div', { class: 'mc-status' },
          h('span', null, 'full ', h('b', { class: full && truth < N ? 'bad' : '' }, full ? (truth < N ? 'high, late' : 'high') : 'low')),
          h('span', null, 'empty ', h('b', { class: empty && truth > 0 ? 'bad' : '' }, empty ? (truth > 0 ? 'high, late' : 'high') : 'low'))),
        h('div', { class: 'mc-status' }, h('span', null, 'written ', h('b', null, String(wrote))), h('span', null, 'read ', h('b', null, String(readN))), h('span', null, 'wrong words ', h('b', { class: lost ? 'bad' : 'good' }, String(lost))),
          h('span', null, 'model ', h('b', { class: match ? 'good' : 'bad' }, match ? 'agrees' : 'differs')))
      ];
    },
    reset: () => { model.s = new AsyncFifoModel(k, w).s; wseq = 1; wrote = readN = lost = 0; mode = 'both'; rng = 12345; },
    history: {
      save: () => ({ s: { ...model.s, mem: [...model.s.mem] }, mode, rng, wseq, wrote, readN, lost }),
      restore: (v) => { const x = v as { s: typeof model.s; mode: Mode; rng: number; wseq: number; wrote: number; readN: number; lost: number }; model.s = { ...x.s, mem: [...x.s.mem] }; ({ mode, rng, wseq, wrote, readN, lost } = x); },
    },
    hint: 'W and R are unrelated clocks. Words are numbered 1, 2, 3 … so a lost, repeated or reordered word shows at once. "late" marks a flag that is up while the other side has already moved on.',
  };
  return { root: asyncFifo(k, w), inputs: { we: 0, re: 0, wdata: 0, wclk: 0, rclk: 0 }, clock: 'wclk', autoClock: false, hiddenInputs: ['we', 're', 'wdata', 'rclk'], panels: [twoClockPanel(cfg)] };
}

export { PAIR };
