// Chapter codes's explorers: segments on a ladder that any one of can be lost, the window, the timer, the sawtooth (all on net/tcpsim.ts, which is net/tcp.ts over a modelled
// bottleneck), the Python TCP itself on the model-speed bench, and a gate window on it.

import '../styles/tcp.css';
import { CLOCK_NS } from '../comm/mac';
import { tcpFlagText, tcpFrame } from '../comm/netframes';
import { pcapFile } from '../comm/pcap';
import { GateWindow, isQuiet } from '../net/gatewindow';
import { ACK, ESTABLISHED, STATE_NAMES, TCP_K } from '../net/tcp';
import { benchDone, HOST_A, HOST_B, homeOf, tcpBench, type BenchOptions, type TcpBenchRun } from '../net/tcpbench';
import { runTcp, type SegRec, type SimResult, type TracePoint } from '../net/tcpsim';
import { DualSim } from '../sim/dualsim';
import { busComputer } from '../lib/soc';
import { lanSoc } from '../lib/lan';
import { FLASH } from '../lib/uartlink';
import { h, keepFocus, s } from '../ui/dom';
import { saveFile } from '../view/image';
import type { Scene, Stage, Widget } from '../view/stage';
import { slider } from './mosparts';
import { groupNum } from '../sim/numfmt';

const n0 = (x: number) => groupNum(Math.round(x));
const btn = (label: string, title: string, f: () => void, cls = 'btn sm') => { const b = h('button', { class: cls, title, type: 'button' }, label); b.addEventListener('click', f); return b; };
const stat = (name: string, value: string) => h('span', null, `${name} `, h('b', null, value));

/** Mb/s for bytes over clocks of our clock. */
export const mbps = (bytes: number, clocks: number): number => (bytes * 8 * 1000) / (clocks * CLOCK_NS);

// ---- a time plot: one measure, steps, one axis -----------------------------------------------------------------------------------

/** A round step of about a quarter of the range: 1, 2 or 5 times a power of ten. */
const niceStep = (range: number): number => {
  const p = 10 ** Math.floor(Math.log10(range / 4 || 1)), m = range / 4 / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
};

interface Series { name: string; cls: string; points: [number, number][]; dots?: boolean }
function plot(series: Series[], o: { h?: number; yLabel: string; xLabel?: string; yMax?: number; xMax?: number; marks?: { x: number; cls: string; label: string }[]; label: string }): SVGSVGElement {
  const W = 620, H = o.h ?? 190, M = { l: 54, r: 26, t: 22, b: 24 };
  const xMax = o.xMax ?? Math.max(1, ...series.flatMap((v) => v.points.map((p) => p[0])));
  const top = o.yMax ?? Math.max(1, ...series.flatMap((v) => v.points.map((p) => p[1]))), yStep = niceStep(top), yMax = Math.ceil(top / yStep - 1e-9) * yStep, xStep = niceStep(xMax);
  const X = (x: number) => M.l + (x / xMax) * (W - M.l - M.r), Y = (y: number) => H - M.b - (y / yMax) * (H - M.t - M.b);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'tcp-plot', role: 'img', 'aria-label': o.label }) as SVGSVGElement;
  for (let v = 0; v <= yMax + 1e-9; v += yStep) {
    svg.append(s('line', { x1: M.l, x2: W - M.r, y1: Y(v), y2: Y(v), class: 'grid' }), s('text', { x: M.l - 6, y: Y(v) + 4, 'text-anchor': 'end', class: 'tick' }, v >= 1000 ? n0(v) : String(Math.round(v * 10) / 10)));
  }
  for (let v = 0; v <= xMax; v += xStep) svg.append(s('text', { x: X(v), y: H - M.b + 16, 'text-anchor': v === 0 ? 'start' : 'middle', class: 'tick' }, n0(v)));
  svg.append(s('text', { x: M.l, y: 13, class: 'axl' }, o.yLabel), s('text', { x: W - M.r, y: 13, 'text-anchor': 'end', class: 'axl' }, o.xLabel ?? 'time: clock cycles'));
  for (const m of o.marks ?? []) svg.append(s('line', { x1: X(m.x), x2: X(m.x), y1: M.t, y2: H - M.b, class: `mark ${m.cls}` }));
  for (const v of series) {
    if (v.dots) { for (const [x, y] of v.points) svg.append(s('circle', { cx: X(x), cy: Y(y), r: 2.2, class: `dot ${v.cls}` })); continue; }
    let d = '';
    v.points.forEach(([x, y], i) => { d += i === 0 ? `M${X(x).toFixed(1)} ${Y(y).toFixed(1)}` : `H${X(x).toFixed(1)}V${Y(y).toFixed(1)}`; });
    svg.append(s('path', { d, class: `ln ${v.cls}` }));
  }
  return svg;
}
const legend = (items: { name: string; cls: string }[]) => h('div', { class: 'tcp-legend' }, ...items.map((i) => h('span', null, h('i', { class: i.cls }), i.name)));

// ---- the ladder ------------------------------------------------------------------------------------------------------------------

const relSeq = (r: SegRec, isnA: number, isnB: number) => {
  const a = r.from === 'a' ? isnA : isnB, b = r.from === 'a' ? isnB : isnA;
  return { seq: (r.seg.seq - a) | 0, ack: r.seg.flags & ACK ? (r.seg.ack - b) | 0 : null };
};

/** Where each arrow's label goes: a fraction along its arrow, and the row height that leaves room for them all. Text is measured as
 *  characters × the widest size it is drawn at (13 px mono on a phone); a label may not touch another's box. Rows grow (18 up to
 *  44 units) until every label fits; if none does, the least crowded height is kept. Pure: tests/tcpladder.test.ts. */
export function placeLabels(segs: SegRec[], texts: string[], rank: Map<number, number>, XA: number, XB: number): { ROW: number; spots: number[]; clash: number } {
  const CW = 7.9, LH = 15, GAP = 3;
  const fr = [0.5, 0.38, 0.62, 0.26, 0.74, 0.14, 0.86, 0.08, 0.92];
  let best: { ROW: number; spots: number[]; clash: number } | null = null;
  for (let ROW = 18; ROW <= 44; ROW += 2) {
    const Y = (t: number) => 24 + ROW * (rank.get(t) ?? 0);
    const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
    const spots: number[] = [];
    let clash = 0;
    segs.forEach((x, i) => {
      const from = x.from === 'a' ? XA : XB, to = x.from === 'a' ? XB : XA, gone = x.fate === 'lost' || x.fate === 'queue';
      const end = gone ? from + (to - from) * 0.6 : to, y1 = Y(x.t), y2 = gone ? (y1 + Y(x.at)) / 2 + 4 : Y(x.at);
      const w = texts[i].length * CW;
      const box = (f: number) => { const cx = from + (end - from) * f, cy = y1 + (y2 - y1) * f - 4; return { x0: cx - w / 2, x1: cx + w / 2, y0: cy - LH + 3, y1: cy + 4 }; };
      let pick = 0, least = Infinity;
      for (let k = 0; k < fr.length && least > 0; k++) {
        const r = box(fr[k]);
        const hit = placed.filter((p) => r.x0 < p.x1 + GAP && p.x0 < r.x1 + GAP && r.y0 < p.y1 && p.y0 < r.y1).length;
        if (hit < least) { least = hit; pick = k; }
      }
      placed.push(box(fr[pick]));
      spots.push(fr[pick]);
      clash += least;
    });
    if (!best || clash < best.clash) best = { ROW, spots, clash };
    if (!clash) break;
  }
  return best!;
}

/** Segments as arrows between two time lines. A click picks one, and the button loses it (they are numbered in the order sent, which a lost one changes). */
export function ladderWidget(o: { bytes: number; lose?: boolean; close?: boolean; title?: string }): Widget {
  const ISN_A = 0x1000, ISN_B = 0x2000;
  const lost = new Set<number>();
  let sel = 0;
  const host = h('div', { class: 'tcp-ladder' }), info = h('div', { class: 'tcp-fields' }), status = h('div', { class: 'mc-status' }), verdict = h('div', { class: 'err-verdict' });
  const paint = () => {
    const r = runTcp({ bytes: o.bytes, lost, close: o.close, isnA: ISN_A, isnB: ISN_B, delay: 12_000 });
    const segs = r.segs.slice(0, 48);
    if (sel >= segs.length) sel = 0;
    const times = [...new Set(segs.flatMap((x) => [x.t, x.at]))].sort((a, b) => a - b);
    const rank = new Map(times.map((t, i) => [t, i]));
    const W = 560, XA = 90, XB = W - 90;
    const texts = segs.map((x) => { const rel = relSeq(x, ISN_A, ISN_B); return `${tcpFlagText(x.seg.flags)} ${x.seg.data.length ? `seq ${rel.seq}, ${x.seg.data.length} bytes` : rel.ack !== null ? `ack ${rel.ack}` : `seq ${rel.seq}`}`; });
    const { ROW, spots } = placeLabels(segs, texts, rank, XA, XB);
    const H = 30 + ROW * Math.max(6, times.length);
    const Y = (t: number) => 24 + ROW * (rank.get(t) ?? 0);
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'tcp-lad', role: 'group', 'aria-label': 'Segments between computer A and computer B' }) as SVGSVGElement;
    svg.append(s('text', { x: XA, y: 13, 'text-anchor': 'middle', class: 'who' }, 'A'), s('text', { x: XB, y: 13, 'text-anchor': 'middle', class: 'who' }, 'B'),
      s('line', { x1: XA, x2: XA, y1: 18, y2: H, class: 'life' }), s('line', { x1: XB, x2: XB, y1: 18, y2: H, class: 'life' }));
    segs.forEach((x, i) => {
      const from = x.from === 'a' ? XA : XB, to = x.from === 'a' ? XB : XA, gone = x.fate === 'lost' || x.fate === 'queue';
      const end = gone ? from + (to - from) * 0.6 : to, y1 = Y(x.t), y2 = gone ? (y1 + Y(x.at)) / 2 + 4 : Y(x.at);
      const text = texts[i];
      const g = s('g', { class: `arrow ${x.from}${gone ? ' lost' : ''}${x.retrans ? ' again' : ''}${i === sel ? ' on' : ''}`, role: 'button', tabindex: '0', 'aria-label': `Segment ${i + 1}, from ${x.from.toUpperCase()}: ${text}${gone ? ', lost' : ''}${x.retrans ? ', sent again' : ''}` });
      g.append(s('line', { x1: from, y1, x2: end, y2, class: 'hit' }), s('line', { x1: from, y1, x2: end, y2, class: 'ar' }));
      if (gone) g.append(s('path', { d: `M${end - 5} ${y2 - 5}l10 10m0-10l-10 10`, class: 'x' }));
      else g.append(s('circle', { cx: end, cy: y2, r: 3, class: 'head' }));
      g.append(s('text', { x: from + (end - from) * spots[i], y: y1 + (y2 - y1) * spots[i] - 4, 'text-anchor': 'middle', class: 'lab' }, text));
      const pick = () => { sel = i; paint(); (svg.isConnected ? host.querySelectorAll('.arrow')[i] as SVGGElement | undefined : undefined)?.focus({ preventScroll: true }); };
      g.addEventListener('click', pick);
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
      svg.append(g);
    });
    host.replaceChildren(svg);
    const x = segs[sel], bytes = tcpFrame({ srcMac: HOST_A.mac as number[], dstMac: HOST_B.mac as number[], src: x.from === 'a' ? HOST_A.ip : HOST_B.ip, dst: x.from === 'a' ? HOST_B.ip : HOST_A.ip, id: 1, ...x.seg });
    const rows = bytes.fields.filter((f) => f.layer === 'tcp' || (f.layer === 'data' && f.bytes.length));
    info.replaceChildren(h('div', { class: 'cpu-sec' }, `Segment ${sel + 1}, from ${x.from.toUpperCase()}: its bytes`),
      ...rows.map((f) => h('div', { class: 'tcp-frow' }, h('span', null, f.name), h('code', null, f.bytes.length > 8 ? `${f.bytes.slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join(' ')} …` : f.bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ')), h('em', null, f.value))));
    status.replaceChildren(stat('segments', String(r.segs.length)), stat('sent again', String(r.retrans)), stat('timeouts', String(r.timeouts)), stat('fast retransmits', String(r.fast)), stat('A', STATE_NAMES[r.endState.a]), stat('B', STATE_NAMES[r.endState.b]));
    if (o.lose !== false) {
      const right = r.delivered === o.bytes && r.got.every((b, i) => b === ((i + (i >> 8) * 7) & 255));
      verdict.className = `err-verdict ${right || !o.bytes ? 'ok' : ''}`;
      verdict.textContent = o.bytes ? (right ? `All ${n0(o.bytes)} bytes reached B's application, in order${lost.size ? `, ${n0(r.doneAt)} clocks in, with ${lost.size} lost on the way` : `, ${n0(r.doneAt)} clocks in`}.` : 'Not delivered yet.') : (r.endState.a === ESTABLISHED && r.endState.b === ESTABLISHED ? `Both ends are ESTABLISHED${lost.size ? `, after ${r.timeouts} timeout${r.timeouts === 1 ? '' : 's'}` : ''}.` : 'The connection has not opened.');
    }
    loseBtn.textContent = lost.has(sel) ? 'Deliver this segment' : 'Lose this segment';
  };
  const loseBtn = btn('Lose this segment', 'Run again with the picked segment lost on the way', () => { keepFocus(loseBtn, () => { if (lost.has(sel)) lost.delete(sel); else lost.add(sel); paint(); }); }, 'btn sm primary');
  paint();
  return { el: h('div', { class: 'widget tcp-w' }, o.title ? h('h4', null, o.title) : '', host, o.lose === false ? '' : h('div', { class: 'ln-presets' }, loseBtn, btn('Lose none', 'Back to a clean run', () => { lost.clear(); sel = 0; paint(); })), status, verdict, info,
    h('p', { class: 'sub' }, 'Pick an arrow to read its bytes. Sequence numbers are shown from each side\'s first, as a capture tool does. The time axis is stretched so that no two arrows sit on one line.')) };
}

// ---- the receive window ----------------------------------------------------------------------------------------------------------

export function windowWidget(): Widget {
  let every = 0;
  const pl = h('div'), status = h('div', { class: 'mc-status' }), note = h('div', { class: 'err-verdict' });
  const paint = () => {
    const r = runTcp({ bytes: 1500, readEvery: every, readBytes: 128 });
    const pts = (f: (p: TracePoint) => number): [number, number][] => r.trace.slice(1).map((p) => [p.t, f(p)]);
    pl.replaceChildren(plot([{ name: 'held', cls: 's1', points: pts((p) => p.held) }, { name: 'wnd', cls: 's2', points: pts((p) => p.sndWnd) }], { yLabel: 'bytes', yMax: TCP_K.RCV, label: `The bytes B holds unread and the window A last heard, over ${n0(r.doneAt)} clock cycles` }));
    status.replaceChildren(stat('delivered', `${n0(r.delivered)} bytes`), stat('zero-window probes', String(r.probes)), stat('lost', String(r.drops + r.losses)), stat('timeouts', String(r.timeouts)), stat('time', `${n0(r.doneAt)} clocks`));
    const shut = r.trace.some((p) => p.t > 1 && p.sndWnd === 0);
    note.className = `err-verdict ${r.timeouts ? '' : 'ok'}`;
    note.textContent = r.timeouts ? `${r.timeouts} timeout${r.timeouts === 1 ? '' : 's'} on the way.` : r.probes ? `The window shut: A sent ${r.probes} one-byte probe${r.probes === 1 ? '' : 's'} to learn when it opens. Nothing was lost or cut.` : shut ? 'The window shut, and B\'s window update reopened it before a probe was due. Nothing was lost or cut.' : 'B keeps up: the window never shuts.';
  };
  const sl = slider('Read 128 bytes every', 0, 600_000, 20_000, every, (v) => (v ? `${n0(v)} clocks` : 'at once'), (v) => { every = v; paint(); });
  paint();
  return { el: h('div', { class: 'widget tcp-w' }, h('div', { class: 'ln-presets' }, sl.el), legend([{ name: 'Bytes B holds unread', cls: 's1' }, { name: 'Window A last heard', cls: 's2' }]), pl, status, note) };
}

// ---- the timer -------------------------------------------------------------------------------------------------------------------

/** RFC 6298 over a series of samples, in net/tcp.ts's arithmetic. */
export function rtoSeries(samples: number[]): { srtt: number[]; rto: number[] } {
  let srtt = 0, rv = 0;
  const a: number[] = [], b: number[] = [];
  for (const r of samples) {
    if (srtt === 0) { srtt = r; rv = r >> 1; }
    else { rv += (Math.abs(srtt - r) - rv) >> 2; srtt += (r - srtt) >> 3; }
    a.push(srtt);
    b.push(Math.min(Math.max(srtt + 4 * rv, TCP_K.RTO_MIN), TCP_K.RTO_MAX));
  }
  return { srtt: a, rto: b };
}
/** Round trips with the base `base` and a spread: seeded, and a step up half way (a queue has formed). */
export function rttSamples(base: number, spreadPct: number, n = 80): number[] {
  let s0 = 12345;
  const r = () => (s0 = (Math.imul(s0, 1103515245) + 12345) >>> 0) / 2 ** 32;
  return Array.from({ length: n }, (_, i) => Math.round((i > n / 2 ? base * 1.6 : base) * (1 + (spreadPct / 100) * (r() - 0.5) * 2)));
}

export function rtoWidget(): Widget {
  let spread = 30;
  const BASE = 60_000, FIXED = Math.round(BASE * 1.3);
  const pl = h('div'), status = h('div', { class: 'mc-status' });
  const paint = () => {
    const x = rttSamples(BASE, spread), { srtt, rto } = rtoSeries(x);
    const idx = x.map((_, i) => i), half = x.length >> 1;
    const spurious = x.filter((r, i) => i > 0 && r > rto[i - 1]).length, fixedA = x.slice(0, half + 1).filter((r) => r > FIXED).length, fixedB = x.slice(half + 1).filter((r) => r > FIXED).length;
    pl.replaceChildren(plot([
      { name: 'r', cls: 's3', dots: true, points: x.map((v, i) => [idx[i], v]) }, { name: 's', cls: 's1', points: srtt.map((v, i) => [idx[i], v]) }, { name: 't', cls: 's2', points: rto.map((v, i) => [idx[i], v]) },
      { name: 'f', cls: 's4', points: [[0, FIXED], [idx[idx.length - 1], FIXED]] },
    ], { yLabel: 'clocks', xLabel: 'round-trip sample', label: `Round-trip samples, the smoothed estimate, the timer and a fixed timer, over ${x.length} samples` }));
    status.replaceChildren(stat('fired early, adaptive', `${spurious} of ${x.length}`), stat('fired early, fixed', `${fixedA} before the step, ${fixedB} after`), stat('RTO now', `${n0(rto[rto.length - 1])} clocks`), stat('SRTT now', `${n0(srtt[srtt.length - 1])} clocks`));
  };
  const sl = slider('Spread of the round trip', 0, 80, 5, spread, (v) => `±${v} %`, (v) => { spread = v; paint(); });
  paint();
  return { el: h('div', { class: 'widget tcp-w' }, h('div', { class: 'ln-presets' }, sl.el), legend([{ name: 'A round trip measured', cls: 's3' }, { name: 'SRTT', cls: 's1' }, { name: 'RTO', cls: 's2' }, { name: 'A fixed timer', cls: 's4' }]), pl, status,
    h('p', { class: 'sub' }, 'The samples are invented with a seed, and the round trip steps up by 60 % half way, as when a queue forms.')) };
}

// ---- the sawtooth ----------------------------------------------------------------------------------------------------------------

export const SAW_BYTES = 8000;
const SAW_PRESETS = [
  { name: 'Sawtooth', byte: 200, queue: 4, delay: 20_000 },
  { name: 'Queue too short', byte: 400, queue: 2, delay: 10_000 },
  { name: 'Room for the window', byte: 200, queue: 8, delay: 20_000 },
  { name: 'Wire speed', byte: 32, queue: 8, delay: 2000 },
] as const;

const marksOf = (r: SimResult) => r.events.filter((e) => e.why === 'fast' || e.why === 'timeout').map((e) => ({ x: e.t, cls: e.why, label: e.why }));

/** The most data this reference model's link carries: tcpsim charges each frame its bytes + 34 (Ethernet and IP headers, no preamble or gap). */
export const dataCapMbps = (byte: number): number => mbps(TCP_K.MSS, (TCP_K.MSS + 54) * byte);

export function sawWidget(start = 0): Widget {
  let { byte, queue, delay }: { byte: number; queue: number; delay: number } = SAW_PRESETS[start];
  const one = h('div'), two = h('div'), status = h('div', { class: 'mc-status' }), note = h('div', { class: 'err-verdict' }), table = h('div', { class: 'tcp-sweep' });
  const paint = () => {
    const r = runTcp({ bytes: SAW_BYTES, byteClocks: byte, queue, delay });
    const seg = (v: number) => v / TCP_K.MSS, end = r.doneAt > 0 ? r.doneAt : r.trace[r.trace.length - 1].t;
    one.replaceChildren(plot([{ name: 'c', cls: 's1', points: r.trace.map((p) => [p.t, seg(p.cwnd)]) }, { name: 'f', cls: 's2', points: r.trace.map((p) => [p.t, seg(p.flight)]) }], { yLabel: 'segments', xMax: end, marks: marksOf(r), label: `The congestion window and the data in flight, in segments. ${r.fast} fast retransmits, ${r.timeouts} timeouts.` }));
    two.replaceChildren(plot([{ name: 'q', cls: 's3', points: r.trace.map((p) => [p.t, p.q]) }], { h: 120, yLabel: 'frames queued', yMax: Math.max(queue, 1), xMax: end, label: `Frames in the router's queue, at most ${queue}.` }));
    const rtt = r.rtts.length ? r.rtts[r.rtts.length - 1] : 0;
    status.replaceChildren(stat('time', `${n0(end)} clocks`), stat('throughput', `${mbps(SAW_BYTES, end).toFixed(1)} Mb/s`), stat('dropped', String(r.drops)), stat('fast retransmits', String(r.fast)), stat('timeouts', String(r.timeouts)), stat('SRTT', `${n0(rtt)} clocks`));
    const linkMbps = dataCapMbps(byte);
    note.className = `err-verdict ${r.drops ? '' : 'ok'}`;
    note.textContent = r.timeouts && r.timeouts >= r.fast ? `The queue holds too few for three duplicate ACKs: the timer does the work, and each one waits a whole RTO and falls to one segment.` : r.fast ? `The queue fills, one frame is dropped, three duplicate ACKs come back, and the window halves. Data over the link tops out at ${linkMbps.toFixed(1)} Mb/s.` : `No frame dropped: the window stops at the receiver's ${TCP_K.RCV / TCP_K.MSS} segments before the queue fills.`;
    table.replaceChildren(h('div', { class: 'cpu-sec' }, 'The same link, whatever the queue'), h('div', { class: 'tcp-srow head' }, h('span', null, 'Queue'), h('span', null, 'Time, clocks'), h('span', null, 'Dropped'), h('span', null, 'Timeouts'), h('span', null, 'SRTT, clocks')),
      ...[1, 2, 3, 4, 6, 8, 12].map((q) => {
        const x = runTcp({ bytes: SAW_BYTES, byteClocks: byte, queue: q, delay }), e = x.doneAt > 0 ? n0(x.doneAt) : 'gave up';
        return h('div', { class: `tcp-srow${q === queue ? ' on' : ''}` }, h('span', null, String(q)), h('span', null, e), h('span', null, String(x.drops)), h('span', null, String(x.timeouts)), h('span', null, n0(x.rtts[x.rtts.length - 1] ?? 0)));
      }));
  };
  const sb = slider('Link', 32, 600, 8, byte, (v) => `${v} clocks a byte`, (v) => { byte = v; paint(); });
  const sq = slider('Queue', 1, 12, 1, queue, (v) => `${v} frame${v === 1 ? '' : 's'}`, (v) => { queue = v; paint(); });
  const sd = slider('Delay, one way', 1000, 60_000, 1000, delay, (v) => `${n0(v)} clocks`, (v) => { delay = v; paint(); });
  paint();
  return { el: h('div', { class: 'widget tcp-w' }, h('div', { class: 'ln-presets' }, ...SAW_PRESETS.map((p) => btn(p.name, `Link ${p.byte} clocks a byte, queue ${p.queue}, delay ${p.delay}`, () => { byte = p.byte; queue = p.queue; delay = p.delay; sb.set(byte); sq.set(queue); sd.set(delay); paint(); }))),
    h('div', { class: 'tcp-sliders' }, sb.el, sq.el, sd.el), legend([{ name: 'Congestion window', cls: 's1' }, { name: 'In flight', cls: 's2' }, { name: 'Fast retransmit', cls: 'fast' }, { name: 'Timeout', cls: 'timeout' }]), one, two, status, note, table,
    h('p', { class: 'sub' }, `A model of the network with the chapter's TCP rules: ${n0(SAW_BYTES)} bytes, a window of at most ${TCP_K.RCV / TCP_K.MSS} segments (the receive buffer). The next step runs the same rules as compiled Python.`)) };
}

// ---- the real stack on the bench -------------------------------------------------------------------------------------------------

const RUNS: { name: string; bytes: number; o: BenchOptions }[] = [
  { name: 'Wire speed', bytes: 4000, o: { queue: 8, byteClocks: 32, delay: 2000 } },
  { name: 'A slow link', bytes: 3000, o: { queue: 4, byteClocks: 200, delay: 20_000 } },
  { name: 'A short queue', bytes: 1500, o: { queue: 3, byteClocks: 400, delay: 10_000 } },
];

export function realStackWidget(): Widget {
  let run: TcpBenchRun | null = null, pick = 0, raf = 0, cwnd: [number, number][] = [], hc = 0, frames = 0;
  const one = h('div'), status = h('div', { class: 'mc-status' }), con = h('pre', { class: 'tcp-con' }), start = h('div', { class: 'ln-presets' });
  const stop = () => { if (raf) cancelAnimationFrame(raf); raf = 0; };
  const paint = () => {
    if (!run) { status.replaceChildren(h('span', null, 'Pick a run.')); return; }
    const { bench, router } = run, [ha, hb] = bench.hosts;
    one.replaceChildren(plot([{ name: 'c', cls: 's1', points: cwnd.length ? cwnd : [[0, 0]] }], { yLabel: 'segments, read from A\'s RAM', yMax: 16, xMax: Math.max(1, bench.c), label: `The congestion window as the program holds it, over ${n0(bench.c)} clock cycles` }));
    status.replaceChildren(stat('clock', n0(bench.c)), stat('frames', String(frames)), stat('router dropped', String(router.drops)), stat('A retired', n0(ha.iss.retired)), stat('B retired', n0(hb.iss.retired)));
    con.textContent = `A: ${ha.iss.console}\nB: ${hb.iss.console}`;
  };
  const loop = () => {
    raf = 0;
    if (!run) return;
    const { bench, router } = run, t0 = performance.now();
    while (performance.now() - t0 < 12 && !benchDone(run)) {
      for (let i = 0; i < 2000 && !benchDone(run); i++) bench.clock();
      const c = bench.hosts[0].word(hc) / TCP_K.MSS;
      if (!cwnd.length || cwnd[cwnd.length - 1][1] !== c) cwnd.push([bench.c, c]);
    }
    frames = router.log?.length ?? 0;
    paint();
    if (!benchDone(run)) raf = requestAnimationFrame(loop);
  };
  const go = (i: number) => {
    stop();
    pick = i;
    run = tcpBench(RUNS[i].bytes, RUNS[i].o);
    run.router.log = [];
    hc = homeOf(run.a, 'cwnd');
    cwnd = [];
    frames = 0;
    drawStart();
    raf = requestAnimationFrame(loop);
  };
  const save = () => {
    if (!run?.router.log?.length) return;
    saveFile('tcp.pcap', new Blob([pcapFile(run.router.log.map((l) => ({ us: l.t * CLOCK_NS / 1000, bytes: l.bytes }))) as BlobPart], { type: 'application/vnd.tcpdump.pcap' }));
  };
  const drawStart = () => start.replaceChildren(...RUNS.map((r, i) => btn(r.name, `${n0(r.bytes)} bytes: link ${r.o.byteClocks} clocks a byte, queue ${r.o.queue}`, () => go(i), `btn sm${i === pick && run ? ' primary' : ''}`)), btn('Save capture', 'The frames as the router received them, as a .pcap', save));
  drawStart();
  paint();
  return {
    el: h('div', { class: 'widget tcp-w' }, start, legend([{ name: 'Congestion window: cwnd in A\'s data memory', cls: 's1' }]), one, status, con,
      h('p', { class: 'sub' }, 'The golden model on both CPUs, the NIC and MAC models clock by clock, and the router here as a queue. Nothing here but the router is simplified.')),
    destroy: stop,
  };
}

// ---- the gate window -------------------------------------------------------------------------------------------------------------

/** The sender's program with the chapter's stream: its computer is the scene. */
const WINDOW_RUN = { bytes: 3000, o: { queue: 4, byteClocks: 120, delay: 8000 } as BenchOptions };
const windowBench = () => tcpBench(WINDOW_RUN.bytes, WINDOW_RUN.o);

export function tcpWindowScene(): Scene {
  const t = windowBench();
  return { root: busComputer(t.a.compiled.words, FLASH, lanSoc(t.k)), hiddenInputs: ['clk', 'switches', 'rxd', 'crs'], inputs: { switches: 0, rxd: 0, crs: 0 }, autoClock: false, memory: false, noRemix: true, engine: 'cycle', panels: [windowPanel] };
}

/** How far the chapter's window has come, and the button its "Do it for me" presses. */
export const windowApi = new WeakMap<Stage, { state(): { open: boolean; clocks: number; retired: number; mismatch: string | null; frames: number }; open(): void }>();

function windowPanel(stage: Stage): Widget {
  let t = windowBench(), w: GateWindow | null = null, raf = 0, last = { clocks: 0, retired: 0 }, framesAt = 0, rate = 0, running = false;
  t.router.log = [];
  const status = h('div', { class: 'mc-status' }), result = h('div', { class: 'err-verdict' }), row = h('div', { class: 'ln-presets' }), where = h('div', { class: 'tcp-where' });
  const stop = () => { if (raf) cancelAnimationFrame(raf); raf = 0; running = false; };
  const paint = () => {
    const [ha] = t.bench.hosts, st = ha.word(homeOf(t.a, 'tcp_st')), cw = ha.word(homeOf(t.a, 'cwnd')) / TCP_K.MSS;
    status.replaceChildren(stat('clock', n0(t.bench.c)), stat('TCP', STATE_NAMES[st] ?? '?'), stat('cwnd', `${cw} segments`), stat('sent, A', `${(ha.word(homeOf(t.a, 'snd_una')) - ha.word(homeOf(t.a, 'iss'))) | 0} bytes`), w ? stat('on the gates', `${n0(w.clocks)} clocks · ${n0(w.retired)} instructions${rate ? ` · ${n0(rate)} clocks/s` : ''}`) : stat('running on', 'the models'));
    if (w) { const l = t.a.layerOfPc(ha.iss.pc), ln = t.a.compiled.pyOfPc(ha.iss.pc), src = ln ? t.a.source.split('\n')[ln - 1].trim() : ''; where.textContent = `${l ?? 'runtime'}: ${src}`; } else where.textContent = '';
    if (w?.mismatch) { result.className = 'err-verdict'; result.textContent = `The gates and the models disagree: ${w.mismatch}`; }
    else if (w) { result.className = 'err-verdict ok'; result.textContent = `Every register after every instruction, every NIC output every clock: the same. ${(t.router.log?.length ?? 0) - framesAt} frames through these gates' wire so far.`; }
    row.replaceChildren(...(w
      ? [btn(running ? 'Pause' : 'Run on the gates', 'Clock the gates, beside the models', () => { if (running) { stop(); paint(); } else start(); }, 'btn sm primary'), btn('Back to the models', 'Hand the computer back at its next quiet moment', () => closeWindow())]
      : [btn(running ? 'Pause' : 'Run on the models', 'The transfer at model speed', () => { if (running) { stop(); paint(); } else start(); }), btn('Open a gate window', 'At the next quiet moment, put computer A into its gates', () => openWindow(), 'btn sm primary'), btn('Start over', 'A new transfer', () => { stop(); t = windowBench(); t.router.log = []; last = { clocks: 0, retired: 0 }; result.textContent = ''; paint(); })]));
  };
  const openWindow = () => {
    stop();
    if (!(stage.sim instanceof DualSim)) { result.className = 'err-verdict'; result.textContent = 'This scene needs the cycle engine.'; return; }
    // the data phase, then a quiet moment
    let g = 0;
    while (t.bench.hosts[0].word(homeOf(t.a, 'tcp_st')) < ESTABLISHED && g++ < 400_000) t.bench.clock();
    g = 0;
    while (!isQuiet(t.bench, 0) && g++ < 200_000) t.bench.clock();
    if (!isQuiet(t.bench, 0)) { result.className = 'err-verdict'; result.textContent = 'No quiet moment came. Start over.'; return; }
    w = new GateWindow(t.bench, 0, t.k, undefined, stage.sim);
    framesAt = t.router.log?.length ?? 0;
    stage.refresh();
    start();
  };
  const closeWindow = () => {
    if (!w) return;
    stop();
    let g = 0;
    while (!w.tryClose() && !w.mismatch && g++ < 200_000) t.bench.clock();
    last = { clocks: w.clocks, retired: w.retired };
    const done = w.mismatch ? null : w;
    if (done) { result.className = 'err-verdict ok'; result.textContent = `✓ ${n0(done.clocks)} clocks and ${n0(done.retired)} instructions on the gates, and every one agreed. The models carry on from the state the gates reached.`; w = null; }
    stage.refresh();
    paint();
  };
  const frame = () => {
    raf = 0;
    if (!running) return;
    const started = performance.now();
    const budget = 12;
    const before = t.bench.c;
    while (performance.now() - started < budget && !benchDone(t) && !w?.mismatch) for (let i = 0; i < (w ? 8 : 2000) && !benchDone(t) && !w?.mismatch; i++) t.bench.clock();
    if (w) { const ms = performance.now() - started; if (ms > 0) rate = rate ? rate * 0.9 + ((t.bench.c - before) * 1000 / ms) * 0.1 : (t.bench.c - before) * 1000 / ms; stage.refresh(); }
    if (benchDone(t) || w?.mismatch) running = false;
    paint();
    if (running) raf = requestAnimationFrame(frame);
  };
  const start = () => { running = true; paint(); raf = requestAnimationFrame(frame); };
  windowApi.set(stage, { state: () => ({ open: !!w, clocks: w?.clocks ?? last.clocks, retired: w?.retired ?? last.retired, mismatch: w?.mismatch ?? null, frames: (t.router.log?.length ?? 0) - framesAt }), open: () => { if (!w) openWindow(); } });
  paint();
  const title = h('h4', null, 'TCP · models and gates', h('span', { class: 'fold-hint' }));
  const el = h('div', { class: 'mem-panel cpu-panel tcp-panel', 'data-dock': 'right', 'data-phone': 'flow' }, title, h('div', { class: 'cpu-body' }, row, status, where, result,
    h('p', { class: 'cpu-sec-hint' }, 'The circuit is computer A. The far computer and the router stay models on its wire. The window opens when no frame is at A\'s pins, so that nothing mid-frame needs loading.')));
  return { el, destroy: stop };
}

