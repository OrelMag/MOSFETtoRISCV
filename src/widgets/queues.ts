// Queues and congestion's explainers, all on comm/queues.ts, a labelled model of one bottleneck: delay against load, two senders on a plane, a window under loss, and the lab where senders meet a queue's discipline.

import { bottleneck, chiuJain, cubicWindow, jain, md1Wait, mm1Quantile, mm1Wait, queueRun, renoWindow, type AqmKind, type CcKind, type FlowSpec, type SimResult } from '../comm/queues';
import { h, s } from '../ui/dom';
import type { Widget } from '../view/stage';
import { line, mkChips, plotOf } from './line';
import { slider } from './mosparts';
import '../styles/line.css';
import '../styles/queues.css';

const btn = (label: string, title: string, f: () => void, cls = 'btn sm'): HTMLButtonElement => {
  const b = h('button', { class: cls, type: 'button', title }, label) as HTMLButtonElement;
  b.addEventListener('click', f);
  return b;
};
const selectOf = (aria: string, opts: readonly (readonly [string, string])[], value: string, on: (v: string) => void): HTMLSelectElement => {
  const e = h('select', { 'aria-label': aria }, ...opts.map(([v, t]) => h('option', { value: v, selected: v === value ? true : undefined }, t))) as HTMLSelectElement;
  e.addEventListener('change', () => on(e.value));
  return e;
};

// ---- delay against load ---------------------------------------------------------------------------------------------------

export function delayWidget(): Widget {
  let rho = 0.7, mbps = 100;
  const plot = plotOf({ W: 640, H: 260, x: [0, 1], y: [0, 20], yTicks: [0, 5, 10, 15, 20], xLabel: 'load ρ', yLabel: 'wait, packet times', aria: 'Mean wait against load, for random and for fixed packet sizes, with measured points' });
  plot.setX(1);
  const chips = mkChips(4), note = h('p', { class: 'sub mos-note' });
  const measured = [0.3, 0.5, 0.7, 0.8, 0.9, 0.95].map((r) => [r, queueRun(r, 60000, { seed: 3 }).meanWait, queueRun(r, 60000, { service: 'fixed', seed: 4 }).meanWait]);
  const paint = () => {
    plot.clear();
    const xs = Array.from({ length: 96 }, (_, i) => i / 100);
    line(plot, xs, xs.map((x) => Math.min(25, mm1Wait(x))), 'ln-s real');
    line(plot, xs, xs.map((x) => Math.min(25, md1Wait(x))), 'ln-s near');
    for (const [r, a, b] of measured) { plot.layer.append(s('circle', { cx: plot.X(r), cy: plot.Y(a), r: 3.5, class: 'qu-dot a' }), s('circle', { cx: plot.X(r), cy: plot.Y(b), r: 3.5, class: 'qu-dot b' })); }
    plot.layer.append(s('line', { x1: plot.X(rho), x2: plot.X(rho), y1: plot.Y(0), y2: plot.Y(20), class: 'qu-mark' }));
    const pkt = (1500 * 8) / (mbps * 1e6) * 1000, w = mm1Wait(rho), q = mm1Quantile(rho, 0.01);
    chips.set(0, w.toFixed(1), 'packets ahead, on average');
    chips.set(1, `${(w * pkt).toFixed(2)} ms`, `mean wait at ${mbps} Mb/s, 1500 bytes`);
    chips.set(2, `${(q * pkt).toFixed(2)} ms`, 'the wait 1 packet in 100 passes');
    chips.set(3, `${(100 * (1 - rho)).toFixed(0)} %`, 'of the link idle');
    note.textContent = `The solid curve is random packet sizes, the fainter one fixed; the dots are a queue simulated packet by packet. Nothing here is full and nothing is wrong: the wait comes from arrivals being random against a server that cannot save up idle time.`;
  };
  paint();
  return { el: h('div', { class: 'widget mos sr-w' },
    h('div', { class: 'panel' }, h('h3', null, 'The wait, from load alone'), plot.el),
    h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row fr-ctl' },
      slider('Load', 0.05, 0.98, 0.01, rho, (v) => v.toFixed(2), (v) => { rho = v; paint(); }).el,
      selectOf('Link speed', [['10', '10 Mb/s'], ['100', '100 Mb/s'], ['1000', '1 Gb/s']], '100', (v) => { mbps = Number(v); paint(); })), chips.el, note)) };
}

// ---- two senders on a plane ------------------------------------------------------------------------------------------------

export function chiuWidget(): Widget {
  let x0 = 70, y0 = 5, kind: 'aimd' | 'aiad' | 'mimd' = 'aimd';
  const S = 300, P = (v: number) => 24 + (v / 110) * (S - 40), Q = (v: number) => S - 24 - (v / 110) * (S - 40);
  const svg = s('svg', { viewBox: `0 0 ${S} ${S}`, class: 'mos-plot qu-plane', role: 'img', 'aria-label': 'Two senders\' rates on a plane: the line of full use, the line of fair shares, and the path the two follow' }) as SVGSVGElement;
  const chips = mkChips(3), note = h('p', { class: 'sub mos-note' });
  const paint = () => {
    const path = chiuJain(x0, y0, kind, 600), tail = path.slice(-120), a = tail.reduce((v, c) => v + c.x, 0), b = tail.reduce((v, c) => v + c.y, 0);
    const d = path.map((c, i) => `${i ? 'L' : 'M'}${P(c.x).toFixed(1)} ${Q(c.y).toFixed(1)}`).join(' ');
    svg.replaceChildren(
      s('line', { x1: P(0), y1: Q(0), x2: P(110), y2: Q(0), class: 'qu-axis' }), s('line', { x1: P(0), y1: Q(0), x2: P(0), y2: Q(110), class: 'qu-axis' }),
      s('line', { x1: P(100), y1: Q(0), x2: P(0), y2: Q(100), class: 'qu-full' }), s('line', { x1: P(0), y1: Q(0), x2: P(105), y2: Q(105), class: 'qu-fair' }),
      s('text', { x: P(58), y: Q(48), class: 'qu-lab' }, 'full'), s('text', { x: P(86), y: Q(94), class: 'qu-lab' }, 'fair'),
      s('text', { x: P(104), y: Q(0) + 14, 'text-anchor': 'end', class: 'qu-lab' }, 'sender 1'), s('text', { x: 4, y: Q(108), class: 'qu-lab' }, 'sender 2'),
      s('path', { d, class: 'qu-path' }), s('circle', { cx: P(x0), cy: Q(y0), r: 4, class: 'qu-dot a' }));
    chips.set(0, jain([a, b]).toFixed(3), 'fairness, once it has run');
    chips.set(1, `${(a / tail.length).toFixed(0)} / ${(b / tail.length).toFixed(0)}`, 'mean shares of 100');
    chips.set(2, `${((a + b) / tail.length).toFixed(0)} %`, 'of the link used');
    note.textContent = kind === 'aimd' ? 'An increase moves along a 45° line, which keeps the difference. A halving moves towards the origin, which halves it. So each cycle shrinks the gap, and it ends on the fair line wherever it started.'
      : kind === 'aiad' ? 'Up and down the same 45° line: the difference between the two never changes. The first to arrive keeps its lead for ever.'
        : 'Multiplying moves along a line through the origin in both directions: the ratio never changes. Fast, and permanently unfair.';
  };
  paint();
  return { el: h('div', { class: 'widget mos sr-w' },
    h('div', { class: 'panel qu-center' }, h('h3', null, 'Two senders, one link of 100'), svg),
    h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row fr-ctl' },
      selectOf('Rule', [['aimd', 'Add, halve (AIMD)'], ['aiad', 'Add, subtract'], ['mimd', 'Multiply, halve']], kind, (v) => { kind = v as typeof kind; paint(); }),
      slider('Sender 1 starts at', 0, 100, 1, x0, (v) => String(v), (v) => { x0 = v; paint(); }).el,
      slider('Sender 2 starts at', 0, 100, 1, y0, (v) => String(v), (v) => { y0 = v; paint(); }).el), chips.el, note)) };
}

// ---- a window under loss -----------------------------------------------------------------------------------------------------

export function lossWidget(): Widget {
  let rtt = 0.1;
  const plot = plotOf({ W: 640, H: 260, x: [0, 9], y: [0, 6], yTicks: [0, 1, 2, 3, 4, 5, 6], xLabel: 'one loss in 10^x packets', yLabel: 'window, packets', aria: 'Average window against the loss rate, for Reno and CUBIC', xFmt: (v) => String(v), yFmt: (v) => `10^${v}` });
  plot.setX(9);
  const chips = mkChips(4), note = h('p', { class: 'sub mos-note' });
  const cubicIn = (x: number) => Math.max(cubicWindow(10 ** -x, rtt), renoWindow(10 ** -x));
  const paint = () => {
    plot.clear();
    const xs = Array.from({ length: 73 }, (_, i) => 1 + i / 9);
    line(plot, xs, xs.map((x) => Math.log10(renoWindow(10 ** -x))), 'ln-s near');
    line(plot, xs, xs.map((x) => Math.log10(cubicIn(x))), 'ln-s real');
    const pipe = (1e9 * rtt) / (1500 * 8), pR = 1.5 / pipe ** 2, K = Math.cbrt((pipe * 0.3) / 0.4);
    plot.layer.append(s('line', { x1: plot.X(0), x2: plot.X(9), y1: plot.Y(Math.log10(pipe)), y2: plot.Y(Math.log10(pipe)), class: 'qu-mark' }), s('text', { x: plot.X(0.1), y: plot.Y(Math.log10(pipe)) - 4, class: 'qu-lab' }, 'the pipe of 1 Gb/s'));
    chips.set(0, Math.round(pipe).toLocaleString('en'), 'packets in the pipe, 1 Gb/s');
    chips.set(1, `1 in ${(1 / pR).toExponential(1)}`, 'loss Reno can bear and fill it');
    chips.set(2, `${((pipe / 2) * rtt).toFixed(0)} s`, 'Reno\'s climb back after one loss');
    chips.set(3, `${K.toFixed(1)} s`, 'CUBIC\'s climb back, K');
    note.textContent = 'Reno\'s line is 1.22 / √p. CUBIC\'s is steeper in the loss and depends on the RTT, and where it would fall below Reno, its Reno-friendly region takes over.';
  };
  paint();
  return { el: h('div', { class: 'widget mos sr-w' },
    h('div', { class: 'panel' }, h('h3', null, 'The window a loss rate allows'), h('div', { class: 'ln-key' }, h('span', { class: 'k-near' }, 'Reno'), h('span', { class: 'k-far' }, 'CUBIC')), plot.el),
    h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row fr-ctl' }, slider('RTT', 0.01, 0.3, 0.01, rtt, (v) => `${Math.round(v * 1000)} ms`, (v) => { rtt = v; paint(); }).el), chips.el, note)) };
}

// ---- the lab ---------------------------------------------------------------------------------------------------------------

export interface LabPreset { aqm: AqmKind; buffer: number; flows: FlowSpec[]; rtt?: number; mbps?: number; lossP?: number; note?: string }
const CC_NAME: Record<CcKind, string> = { reno: 'Reno', cubic: 'CUBIC', bbr: 'BBR', dctcp: 'DCTCP' };
const FLOW_SETS: Record<string, CcKind[]> = { reno: ['reno'], cubic: ['cubic'], bbr: ['bbr'], cubic2: ['cubic', 'cubic'], bbr2: ['bbr', 'cubic'], reno3: ['reno', 'reno', 'reno'] };

/** One run of the lab: what the chapter's text quotes comes from the same call. */
export function labRun(p: LabPreset, seconds = 60): SimResult {
  return bottleneck({ mbps: p.mbps ?? 20, bufferPkts: p.buffer, aqm: p.aqm, pingMs: 20, lossP: p.lossP }, p.flows.map((f) => ({ ...f, rttMs: f.rttMs ?? p.rtt ?? 50 })), seconds, seconds / 4);
}

export function labWidget(start: LabPreset): Widget {
  let aqm = start.aqm, buffer = start.buffer, rtt = start.rtt ?? 50, ecn = !!start.flows[0].ecn, set = Object.entries(FLOW_SETS).find(([, v]) => v.length === start.flows.length && v.every((c, i) => c === start.flows[i].cc))?.[0] ?? 'cubic';
  const win = plotOf({ W: 640, H: 170, x: [0, 60], y: [0, 100], yTicks: [0], xLabel: 'seconds', yLabel: 'window, packets', aria: 'Each sender\'s window over the run' });
  const dly = plotOf({ W: 640, H: 150, x: [0, 60], y: [0, 100], yTicks: [0], xLabel: 'seconds', yLabel: 'queue, ms', aria: 'The queue\'s delay over the run' });
  win.setX(60); dly.setX(60);
  const chips = mkChips(4), note = h('p', { class: 'sub mos-note' });
  const paint = () => {
    const ccs = FLOW_SETS[set], r = labRun({ aqm, buffer, rtt, flows: ccs.map((cc, i) => ({ cc, rttMs: rtt, ecn, startS: i * 2 })) });
    const ts = r.samples.map((x) => x.t), top = Math.max(10, ...r.samples.flatMap((x) => x.cwnd)) * 1.1, qs = r.samples.map((x) => x.queue * r.slotMs), qTop = Math.max(10, ...qs) * 1.1;
    win.setY(0, top); dly.setY(0, qTop); win.clear(); dly.clear();
    ccs.forEach((_, i) => line(win, ts, r.samples.map((x) => x.cwnd[i]), i ? 'ln-s near' : 'ln-s real'));
    line(dly, ts, qs, 'ln-s real');
    chips.set(0, r.goodputMbps.length > 1 ? r.goodputMbps.map((g) => g.toFixed(1)).join(' + ') + ' Mb/s' : `${r.goodputMbps[0].toFixed(1)} Mb/s`, `of ${20}, ${ccs.map((c) => CC_NAME[c]).join(' + ')}`);
    chips.set(1, `${r.pingMeanMs.toFixed(0)} ms`, `a video call's added delay; 1 in 20 over ${r.pingP95Ms.toFixed(0)} ms`, r.pingMeanMs > 100 ? 'bad' : 'ok');
    chips.set(2, ecn ? String(r.marks) : String(r.drops), `${ecn ? 'packets marked' : 'packets dropped'} in the last 45 s`);
    chips.set(3, `${(r.bdpPkts).toFixed(0)} packets`, 'the pipe, one BDP');
    note.textContent = start.note ?? 'A labelled model: one link, one packet time a slot, senders with their published rules. Change one thing at a time.';
  };
  const buf = slider('Buffer', 10, 2000, 10, buffer, (v) => `${v} pkts`, (v) => { buffer = v; paint(); });
  const ec = h('input', { type: 'checkbox', checked: ecn ? true : undefined }) as HTMLInputElement;
  ec.addEventListener('change', () => { ecn = ec.checked; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos sr-w' },
    h('div', { class: 'panel' }, h('h3', null, 'Senders\' windows'), win.el, h('h3', null, 'What the queue adds'), dly.el),
    h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row fr-ctl' },
      selectOf('Senders', [['reno', 'One Reno'], ['cubic', 'One CUBIC'], ['bbr', 'One BBR'], ['cubic2', 'Two CUBIC'], ['reno3', 'Three Reno'], ['bbr2', 'BBR and CUBIC']], set, (v) => { set = v; paint(); }),
      selectOf('Queue', [['tail', 'Tail drop'], ['red', 'RED'], ['codel', 'CoDel'], ['fq', 'FQ-CoDel']], aqm, (v) => { aqm = v as AqmKind; paint(); }),
      buf.el, slider('RTT', 10, 200, 10, rtt, (v) => `${v} ms`, (v) => { rtt = v; paint(); }).el,
      h('label', { class: 'qu-check' }, ec, ' ECN')), chips.el, note)) };
}

// ---- BBR against CUBIC, by buffer -----------------------------------------------------------------------------------------------

export const DUEL_BUFFERS = [10, 40, 80, 160, 320, 640, 1280];
export const duelRun = (buffer: number, aqm: AqmKind = 'tail', seconds = 90): SimResult => labRun({ aqm, buffer, rtt: 50, flows: [{ cc: 'bbr', rttMs: 50 }, { cc: 'cubic', rttMs: 50 }] }, seconds);

export function duelWidget(): Widget {
  let aqm: AqmKind = 'tail', job = 0;
  const svg = s('svg', { viewBox: '0 0 640 210', class: 'mos-plot qu-duel', role: 'img', 'aria-label': 'Each sender\'s share of the link and the delay, at each buffer size' }) as SVGSVGElement;
  const note = h('p', { class: 'sub mos-note' });
  const results: (SimResult | null)[] = [];
  const paint = () => {
    const parts: SVGElement[] = [], bw = 640 / DUEL_BUFFERS.length, Y = (v: number) => 158 - (v / 20) * 140;
    DUEL_BUFFERS.forEach((b, i) => {
      const r = results[i], x = i * bw + 10, w = bw - 20;
      parts.push(s('text', { x: x + w / 2, y: 188, 'text-anchor': 'middle', class: 'qu-lab' }, `${b}`));
      if (!r) return;
      const [a, c] = r.goodputMbps;
      parts.push(s('rect', { x, y: Y(a), width: w, height: 158 - Y(a), class: 'qu-bar a' }), s('rect', { x, y: Y(a + c), width: w, height: Y(a) - Y(a + c), class: 'qu-bar b' }), s('text', { x: x + w / 2, y: 204, 'text-anchor': 'middle', class: 'qu-lab' }, `${r.pingMeanMs.toFixed(0)} ms`));
    });
    svg.replaceChildren(s('text', { x: 0, y: 12, class: 'qu-lab' }, 'Mb/s of 20: BBR below, CUBIC above. Under each buffer, in packets, the delay a video call sees.'), ...parts);
  };
  const run = () => {
    const id = ++job;
    results.length = 0;
    note.textContent = 'Running each buffer size for 90 model seconds.';
    paint();
    const next = (i: number) => {
      if (id !== job) return;
      if (i >= DUEL_BUFFERS.length) { note.textContent = aqm === 'tail' ? 'One run each, from one start, so the deep-buffer bars move with small changes. The pattern holds: shallow, BBR takes nearly everything, since it ignores the loss that halts CUBIC. Deep, it has a window of two BDPs at most and CUBIC has the buffer.' : 'Under fair queueing each sender has its own queue and an equal turn, so neither sender\'s rule can take the other\'s share.'; return; }
      results[i] = duelRun(DUEL_BUFFERS[i], aqm);
      paint();
      setTimeout(() => next(i + 1), 0);
    };
    setTimeout(() => next(0), 30);
  };
  run();
  return { el: h('div', { class: 'widget mos sr-w' },
    h('div', { class: 'panel' }, h('h3', null, 'BBR and CUBIC, one link, by buffer'), svg),
    h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row fr-ctl' }, selectOf('Queue', [['tail', 'Tail drop'], ['fq', 'FQ-CoDel']], aqm, (v) => { aqm = v as AqmKind; run(); }), btn('Run again', 'The same runs again', run)), note)),
    destroy: () => { job++; } };
}
