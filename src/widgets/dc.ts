// Inside the data centre's explainers, on comm/dc.ts and comm/queues.ts, labelled models: a fat tree drawn and counted, flows hashed onto paths, an incast read, DCTCP's queue, go-back-N against loss, and priority flow control with its victim and its deadlock.

import { arqRun, ecmpAssign, ecmpCarried, ecmpExpected, fanoutHalf, fanoutSlow, fatTree, gbnGoodput, incast, pfcHeadroom, pfcRun, ringRun, srGoodput } from '../comm/dc';
import { bottleneck } from '../comm/queues';
import { h, s } from '../ui/dom';
import type { Widget } from '../view/stage';
import { line, mkChips, plotOf } from './line';
import { slider } from './mosparts';
import '../styles/line.css';
import '../styles/dc.css';
import { groupNum } from '../sim/numfmt';

const selectOf = (aria: string, opts: readonly (readonly [string, string])[], value: string, on: (v: string) => void): HTMLSelectElement => {
  const e = h('select', { 'aria-label': aria }, ...opts.map(([v, t]) => h('option', { value: v, selected: v === value ? true : undefined }, t))) as HTMLSelectElement;
  e.addEventListener('change', () => on(e.value));
  return e;
};
const btn = (label: string, title: string, f: () => void): HTMLButtonElement => { const b = h('button', { class: 'btn sm', type: 'button', title }, label) as HTMLButtonElement; b.addEventListener('click', f); return b; };
const n0 = (x: number) => groupNum(Math.round(x));

// ---- the fabric ------------------------------------------------------------------------------------------------------------------

export function fabricWidget(): Widget {
  let k = 48, flow = 0;
  const svg = s('svg', { viewBox: '0 0 640 230', class: 'mos-plot dc-map', role: 'img', 'aria-label': 'A fat tree of 4-port switches: hosts, edge, aggregation and core, with one path between two pods lit' }) as SVGSVGElement;
  const chips = mkChips(4), note = h('p', { class: 'sub mos-note' });
  // always k = 4 on the drawing: the larger counts are below it
  const draw = () => {
    const X = (i: number, n: number) => 20 + (i + 0.5) * ((640 - 40) / n), Y = [24, 88, 152, 214], parts: SVGElement[] = [];
    const core = 4, pods = 4;
    const lit = new Set<string>(), up = flow % 2, cr = (flow >> 1) % 2;
    const src = { pod: 0, edge: 0 }, dst = { pod: 3, edge: 1 };
    const aggA = up, c = aggA * 2 + cr;
    lit.add(`e${src.pod}${src.edge}-a${src.pod}${aggA}`); lit.add(`a${src.pod}${aggA}-c${c}`); lit.add(`a${dst.pod}${aggA}-c${c}`); lit.add(`e${dst.pod}${dst.edge}-a${dst.pod}${aggA}`);
    const seg = (x1: number, y1: number, x2: number, y2: number, id: string) => parts.push(s('line', { x1, y1, x2, y2, class: lit.has(id) ? 'dc-link on' : 'dc-link' }));
    for (let p = 0; p < pods; p++) for (let a = 0; a < 2; a++) {
      const ax = X(p * 2 + a, 8);
      for (let c2 = 0; c2 < 2; c2++) seg(ax, Y[1], X(a * 2 + c2, core), Y[0], `a${p}${a}-c${a * 2 + c2}`);
      for (let e = 0; e < 2; e++) seg(ax, Y[1], X(p * 2 + e, 8), Y[2], `e${p}${e}-a${p}${a}`);
    }
    for (let p = 0; p < pods; p++) for (let e = 0; e < 2; e++) for (let i = 0; i < 2; i++) seg(X(p * 2 + e, 8), Y[2], X(p * 4 + e * 2 + i, 16), Y[3], `h`);
    for (let i = 0; i < core; i++) parts.push(s('rect', { x: X(i, core) - 14, y: Y[0] - 8, width: 28, height: 16, rx: 3, class: 'dc-sw' }));
    for (let i = 0; i < 8; i++) { parts.push(s('rect', { x: X(i, 8) - 14, y: Y[1] - 8, width: 28, height: 16, rx: 3, class: 'dc-sw' }), s('rect', { x: X(i, 8) - 14, y: Y[2] - 8, width: 28, height: 16, rx: 3, class: 'dc-sw' })); }
    for (let i = 0; i < 16; i++) parts.push(s('circle', { cx: X(i, 16), cy: Y[3], r: 5, class: 'dc-host' }));
    parts.push(s('text', { x: 4, y: Y[0] + 4, class: 'dc-lab' }, 'core'), s('text', { x: 4, y: Y[1] + 4, class: 'dc-lab' }, 'agg'), s('text', { x: 4, y: Y[2] + 4, class: 'dc-lab' }, 'edge'));
    svg.replaceChildren(...parts);
  };
  const paint = () => {
    const f = fatTree(k);
    chips.set(0, n0(f.hosts), `hosts, on ${k}-port switches`);
    chips.set(1, n0(f.switches), 'switches');
    chips.set(2, n0(f.core), 'paths between two pods');
    chips.set(3, n0(f.links), 'cables in all, hosts included');
    note.textContent = `The drawing is k = 4. Every switch is the same cheap ${k}-port part, and the links up equal the hosts down, so every host could have its port's full rate to any other if the traffic spreads evenly: the exchange's Clos network, folded, in Ethernet.`;
    draw();
  };
  paint();
  return { el: h('div', { class: 'widget mos sr-w' },
    h('div', { class: 'panel' }, h('h3', null, 'A fat tree, and one of the paths between two pods'), svg),
    h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row fr-ctl' },
      selectOf('Switch ports', [['4', '4 ports'], ['16', '16 ports'], ['48', '48 ports'], ['64', '64 ports'], ['128', '128 ports']], String(k), (v) => { k = Number(v); paint(); }),
      btn('Another path', 'One of the paths the hash could choose', () => { flow++; draw(); })), chips.el, note)) };
}

// ---- ECMP -------------------------------------------------------------------------------------------------------------------------

export function ecmpWidget(): Widget {
  let n = 16, m = 16, seed = 1;
  const svg = s('svg', { viewBox: '0 0 640 120', class: 'mos-plot dc-map', role: 'img', 'aria-label': 'How many flows the hash put on each path' }) as SVGSVGElement;
  const chips = mkChips(3), note = h('p', { class: 'sub mos-note' });
  const paint = () => {
    const b = ecmpAssign(n, m, seed), W = 620 / m, top = Math.max(4, ...b);
    svg.replaceChildren(...b.flatMap((c, i) => {
      const H = (c / top) * 92, x = 10 + i * W;
      return [s('rect', { x, y: 100 - H, width: Math.max(1, W - 2), height: Math.max(H, 0.5), class: c > 1 ? 'dc-bar hot' : c ? 'dc-bar' : 'dc-bar idle' }), ...(m <= 32 ? [s('text', { x: x + W / 2 - 1, y: 114, 'text-anchor': 'middle', class: 'dc-lab' }, String(c))] : [])];
    }));
    chips.set(0, `${(100 * ecmpCarried(b) / Math.min(n, m)).toFixed(0)} %`, 'of the flows\' possible rate, in this draw');
    chips.set(1, `${(100 * ecmpExpected(n, m) / Math.min(1, n / m)).toFixed(0)} %`, 'expected over all draws');
    chips.set(2, String(Math.max(...b)), 'the most flows on one path');
    note.textContent = 'Each flow fills a path if it is alone on it. A hash cannot look at load, so collisions sit on one path while another is idle. Every packet of a flow goes the same way, to stay in order.';
  };
  paint();
  return { el: h('div', { class: 'widget mos sr-w' },
    h('div', { class: 'panel' }, h('h3', null, 'Flows on paths'), svg),
    h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row fr-ctl' },
      slider('Flows', 1, 64, 1, n, (v) => String(v), (v) => { n = v; paint(); }).el, slider('Paths', 2, 64, 1, m, (v) => String(v), (v) => { m = v; paint(); }).el, btn('New hash', 'Another hash seed', () => { seed++; paint(); })), chips.el, note)) };
}

// ---- incast -----------------------------------------------------------------------------------------------------------------------

export function incastWidget(): Widget {
  let rto = 200, buffer = 32;
  const NS = [1, 2, 4, 8, 12, 16, 24, 32, 48, 64];
  const plot = plotOf({ W: 640, H: 240, x: [0, 64], y: [0, 1.05], yTicks: [0, 0.25, 0.5, 0.75, 1], xLabel: 'servers answering', yLabel: 'goodput, of 1 Gb/s', aria: 'Goodput of a synchronized read against the number of servers, at this timer and buffer', xFmt: (v) => String(v) });
  plot.setX(64);
  const chips = mkChips(3), note = h('p', { class: 'sub mos-note' });
  const paint = () => {
    const rs = NS.map((N) => incast({ senders: N, blockBytes: 256 * 1024, bufferPkts: buffer, rtoMs: rto }));
    plot.clear();
    line(plot, NS, rs.map((r) => r.share), 'ln-s real');
    rs.forEach((r, i) => plot.layer.append(s('circle', { cx: plot.X(NS[i]), cy: plot.Y(r.share), r: 3.5, class: 'dc-dot' })));
    const worst = rs.reduce((a, b) => (b.share < a.share ? b : a)), first = NS[rs.findIndex((r) => r.timeouts > 0)];
    chips.set(0, first ? String(first) : 'none', 'servers before the first timeout', first ? 'bad' : 'ok');
    chips.set(1, `${(worst.goodputGbps * 1000).toFixed(0)} Mb/s`, 'at the worst point', worst.share < 0.5 ? 'bad' : 'ok');
    chips.set(2, `${rs[rs.length - 1].ms.toFixed(1)} ms`, `to read 256 KB from each of ${NS[NS.length - 1]}`);
    note.textContent = 'One read: every server sends its 256 KB through one port at the same moment, and the next read waits for the last packet. A flow that loses the end of its burst has no duplicate ACKs to tell it, so it waits for a timer far longer than the whole transfer.';
  };
  paint();
  return { el: h('div', { class: 'widget mos sr-w' },
    h('div', { class: 'panel' }, h('h3', null, 'Reading from many servers at once'), plot.el),
    h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row fr-ctl' },
      selectOf('Retransmission timer', [['200', 'RTO 200 ms'], ['10', 'RTO 10 ms'], ['1', 'RTO 1 ms']], '200', (v) => { rto = Number(v); paint(); }),
      slider('Port buffer', 8, 512, 8, buffer, (v) => `${v} pkts`, (v) => { buffer = v; paint(); }).el), chips.el, note)) };
}

// ---- DCTCP ------------------------------------------------------------------------------------------------------------------------

export function dctcpWidget(): Widget {
  let K = 20, flows = 1;
  const plot = plotOf({ W: 640, H: 240, x: [0, 8], y: [0, 100], yTicks: [0], xLabel: 'ms', yLabel: 'queue, packets', aria: 'The queue over a few milliseconds, with DCTCP and with a sender that halves on a mark' });
  plot.setX(8);
  const chips = mkChips(4), note = h('p', { class: 'sub mos-note' });
  const run = (cc: 'dctcp' | 'reno') => bottleneck({ mbps: 10000, bufferPkts: 400, aqm: 'step', markK: K, trace: { from: 0.3, every: 32 } }, Array.from({ length: flows }, () => ({ cc, rttMs: 0.1, ecn: true })), 0.6, 0.3);
  const paint = () => {
    const d = run('dctcp'), r = run('reno'), tail = (x: typeof d) => x.samples.filter((v) => v.t >= 0.3 && v.t < 0.308);
    const a = tail(d), b = tail(r), ts = a.map((v) => (v.t - 0.3) * 1000), qa = a.map((v) => v.queue), qb = b.map((v) => v.queue), top = Math.max(K * 1.6, 10, ...qa, ...qb);
    plot.setY(0, top); plot.clear();
    if (ts.length > 1) { line(plot, ts, qa, 'ln-s real'); line(plot, ts, qb, 'ln-s near'); }
    plot.layer.append(s('line', { x1: plot.X(0), x2: plot.X(8), y1: plot.Y(K), y2: plot.Y(K), class: 'dc-k' }));
    chips.set(0, `${(100 * d.utilization).toFixed(1)} %`, 'DCTCP: the link used', d.utilization > 0.97 ? 'ok' : 'bad');
    chips.set(1, `${(100 * r.utilization).toFixed(1)} %`, 'halving on a mark');
    chips.set(2, `${d.meanQueue.toFixed(0)} pkts`, `DCTCP's mean queue, ${((d.meanQueue * 1.2)).toFixed(0)} µs`);
    chips.set(3, (d.dctcpAlpha ?? 0).toFixed(2), 'α, the share marked');
    note.textContent = '10 Gb/s, 100 µs of round trip, a pipe of 83 packets. The dashed line is K. Halving on a mark leaves the queue nowhere near K, and sometimes empties it. Reducing in proportion to the share marked keeps it there.';
  };
  paint();
  return { el: h('div', { class: 'widget mos sr-w' },
    h('div', { class: 'panel' }, h('h3', null, 'Eight milliseconds of queue'), h('div', { class: 'ln-key' }, h('span', { class: 'k-far' }, 'DCTCP'), h('span', { class: 'k-near' }, 'Halve on a mark')), plot.el),
    h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row fr-ctl' },
      slider('Mark at K', 2, 80, 1, K, (v) => `${v} pkts`, (v) => { K = v; paint(); }).el,
      slider('Flows', 1, 16, 1, flows, (v) => String(v), (v) => { flows = v; paint(); }).el), chips.el, note)) };
}

// ---- go-back-N ---------------------------------------------------------------------------------------------------------------------

export function arqWidget(): Widget {
  let gbps = 100, rttUs = 10;
  const plot = plotOf({ W: 640, H: 240, x: [1, 7], y: [0, 1.05], yTicks: [0, 0.25, 0.5, 0.75, 1], xLabel: 'one loss in 10^x packets', yLabel: 'goodput, of the link', aria: 'Goodput against loss rate for go-back-N and selective repeat', xFmt: (v) => String(v) });
  plot.setX(7);
  const chips = mkChips(3), note = h('p', { class: 'sub mos-note' });
  const paint = () => {
    const W = Math.max(1, Math.round((gbps * 1e9 * rttUs * 1e-6) / (1024 * 8))), xs = Array.from({ length: 61 }, (_, i) => 1 + i / 10);
    plot.clear();
    line(plot, xs, xs.map((x) => gbnGoodput(10 ** -x, W)), 'ln-s real');
    line(plot, xs, xs.map((x) => srGoodput(10 ** -x)), 'ln-s near');
    for (const x of [2, 3, 4, 5]) plot.layer.append(s('circle', { cx: plot.X(x), cy: plot.Y(arqRun(10 ** -x, W, 'gbn', 60000, x + 1)), r: 3.5, class: 'dc-dot' }));
    chips.set(0, n0(W), 'packets in the pipe, of 1 KB');
    chips.set(1, `1 in ${n0(9 * W)}`, 'the loss that costs go-back-N 10 %');
    chips.set(2, `${(100 * gbnGoodput(1e-5, W)).toFixed(1)} %`, 'at one loss in 100 000');
    note.textContent = 'A NIC that delivers into memory on its own finds it far easier to demand packets in order and resend all after a gap. The price grows with the pipe, and the pipe grows with the rate. The dots are the same rule, run a packet at a time.';
  };
  paint();
  return { el: h('div', { class: 'widget mos sr-w' },
    h('div', { class: 'panel' }, h('h3', null, 'What a loss costs, by how it is repaired'), h('div', { class: 'ln-key' }, h('span', { class: 'k-far' }, 'go-back-N'), h('span', { class: 'k-near' }, 'selective repeat')), plot.el),
    h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row fr-ctl' },
      selectOf('Link', [['25', '25 Gb/s'], ['100', '100 Gb/s'], ['400', '400 Gb/s']], '100', (v) => { gbps = Number(v); paint(); }),
      slider('Round trip', 2, 50, 1, rttUs, (v) => `${v} µs`, (v) => { rttUs = v; paint(); }).el), chips.el, note)) };
}

// ---- priority flow control -------------------------------------------------------------------------------------------------------

export function pfcWidget(): Widget {
  let r1 = 0.25, lossless = true;
  const svg = s('svg', { viewBox: '0 0 640 130', class: 'mos-plot dc-map', role: 'img', 'aria-label': 'What each flow gets, and how much is dropped' }) as SVGSVGElement;
  const chips = mkChips(4), note = h('p', { class: 'sub mos-note' });
  const paint = () => {
    const oneWay = 8, r = pfcRun({ lossless, r1, buffer: 64, headroom: pfcHeadroom(oneWay), oneWay, slots: 30000 });
    const bar = (y: number, v: number, cls: string, t: string) => [s('rect', { x: 110, y, width: (v / 0.5) * 500, height: 26, class: cls }), s('text', { x: 104, y: y + 17, 'text-anchor': 'end', class: 'dc-lab' }, t), s('text', { x: 116 + (v / 0.5) * 500, y: y + 17, class: 'dc-lab' }, v.toFixed(3))];
    svg.replaceChildren(...bar(14, r.f1, 'dc-bar', 'to the slow port'), ...bar(58, r.f2, r.f2 < 0.45 ? 'dc-bar hot' : 'dc-bar', 'to the fast port'), s('text', { x: 110, y: 112, class: 'dc-lab' }, 'each flow offers half of the link; the fast port could take all of that'));
    chips.set(0, n0(r.drops), 'packets dropped', r.drops ? 'bad' : 'ok');
    chips.set(1, `${(100 * r.pausedShare).toFixed(0)} %`, 'of the time the upstream is paused');
    chips.set(2, r.f2.toFixed(2), 'the innocent flow\'s rate', r.f2 < 0.45 ? 'bad' : 'ok');
    chips.set(3, String(pfcHeadroom(oneWay)), 'headroom needed, packets, at this delay');
    note.textContent = lossless ? 'Nothing is lost, and the flow that shares nothing with the slow receiver but a queue is held to its rate: packets for the slow port block those behind them in one FIFO. That is congestion spreading.' : 'Drops in place of pauses: the slow port\'s overflow is simply lost, and that flow must resend, but the other flow never notices.';
  };
  paint();
  return { el: h('div', { class: 'widget mos sr-w' },
    h('div', { class: 'panel' }, h('h3', null, 'Two flows, one upstream queue, one slow receiver'), svg),
    h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row fr-ctl' },
      selectOf('Switch', [['1', 'Lossless, PFC'], ['0', 'Lossy, drops']], '1', (v) => { lossless = v === '1'; paint(); }),
      slider('Slow port\'s rate', 0.05, 0.5, 0.05, r1, (v) => v.toFixed(2), (v) => { r1 = v; paint(); }).el), chips.el, note)) };
}

// ---- deadlock -----------------------------------------------------------------------------------------------------------------------

export function ringWidget(): Widget {
  let hops = 2, offered = 1;
  const chips = mkChips(3), note = h('p', { class: 'sub mos-note' }), svg = s('svg', { viewBox: '0 0 320 200', class: 'mos-plot dc-ring', role: 'img', 'aria-label': 'Four switches in a ring, each queue waiting on the next' }) as SVGSVGElement;
  const paint = () => {
    const r = ringRun(4, hops, 4, 200000, offered), sum = r.delivered.reduce((a, b) => a + b, 0), stuck = r.stoppedAt !== null, pts = [[160, 30], [270, 100], [160, 170], [50, 100]];
    svg.replaceChildren(...pts.map(([x, y], i) => { const [nx, ny] = pts[(i + 1) % 4]; return s('line', { x1: x, y1: y, x2: nx, y2: ny, class: stuck ? 'dc-link stuck' : 'dc-link on' }); }), ...pts.flatMap(([x, y], i) => {
      const [nx, ny] = pts[(i + 1) % 4], mx = (x + nx) / 2, my = (y + ny) / 2;
      return [s('rect', { x: x - 16, y: y - 11, width: 32, height: 22, rx: 3, class: 'dc-sw' }), s('text', { x: mx + (mx > 160 ? 6 : -6), y: my - 6, 'text-anchor': mx > 160 ? 'start' : 'end', class: 'dc-lab' }, stuck ? 'full' : 'moving')];
    }));
    chips.set(0, stuck ? `slot ${n0(r.stoppedAt!)}` : 'never', 'when everything stopped', stuck ? 'bad' : 'ok');
    chips.set(1, n0(sum), 'packets delivered, of 200 000 slots');
    chips.set(2, hops >= 2 ? 'yes' : 'no', 'cycle of buffer dependencies');
    note.textContent = stuck ? `Each queue's head needs room in the next queue, all the way round. No drop is allowed, so no room ever appears: delivered stops at ${n0(sum)} for good, and no amount of waiting helps.` : hops >= 2 ? 'The dependency is there, but in this run the queues never all filled at once.' : 'Every packet leaves after one link, so no queue ever waits on another. Whatever the load, it keeps moving.';
  };
  paint();
  return { el: h('div', { class: 'widget mos sr-w' },
    h('div', { class: 'panel dc-center' }, h('h3', null, 'A ring of lossless switches'), svg),
    h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row fr-ctl' },
      slider('Hops', 1, 3, 1, hops, (v) => String(v), (v) => { hops = v; paint(); }).el,
      slider('Offered load', 0.1, 1, 0.1, offered, (v) => v.toFixed(1), (v) => { offered = v; paint(); }).el), chips.el, note)) };
}

// ---- the tail ----------------------------------------------------------------------------------------------------------------------

export function tailWidget(): Widget {
  let q = 0.01;
  const plot = plotOf({ W: 640, H: 230, x: [0, 500], y: [0, 1], yTicks: [0, 0.25, 0.5, 0.75, 1], xLabel: 'servers each request waits for', yLabel: 'share of requests slow', aria: 'The share of requests that hit a slow server, against the fan-out', xFmt: (v) => String(v) });
  plot.setX(500);
  const chips = mkChips(3), note = h('p', { class: 'sub mos-note' });
  const paint = () => {
    plot.clear();
    const xs = Array.from({ length: 101 }, (_, i) => i * 5);
    line(plot, xs, xs.map((n) => fanoutSlow(n, q)), 'ln-s real');
    chips.set(0, `${(100 * fanoutSlow(100, q)).toFixed(0)} %`, 'of requests with a fan-out of 100');
    chips.set(1, n0(fanoutHalf(q)), 'servers for half of them to be slow');
    chips.set(2, `${(100 * q).toFixed(2)} %`, 'of each server\'s replies slow');
    note.textContent = 'Slowness that is rare on one server is the normal case for a request that needs all of them. This is why incast\'s 200 ms, rare on any one flow, shows up on the front page.';
  };
  paint();
  return { el: h('div', { class: 'widget mos sr-w' },
    h('div', { class: 'panel' }, h('h3', null, 'The tail at scale'), plot.el),
    h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row fr-ctl' }, slider('A server is slow', 0.001, 0.05, 0.001, q, (v) => `${(100 * v).toFixed(1)} %`, (v) => { q = v; paint(); }).el), chips.el, note)) };
}
