// Chapter 48's model-driven widgets (the collision timeline, the minimum-frame arithmetic, the throughput curve) and the
// segment scene: four gate-level stations on one cable, frames moving, collisions counted, Save capture.

import '../styles/clocks.css';
import '../styles/uart.css';
import '../styles/ethernet.css';
import { BROADCAST, ETHERTYPE_IPV4, frameBody, MAX_PAYLOAD, MIN_FRAME, type FrameSpec } from '../comm/ethframe';
import {
  ATTEMPT_LIMIT, BACKOFF_LIMIT, BIT_CLOCKS, CLOCK_NS, frameBitTimes, GAP_CLOCKS, JAM_BYTES, LINK_MBPS, maxCableMetres, SLOT_BITS,
} from '../comm/mac';
import { maxThroughput, runLoad, runPair, type LoadResult } from '../comm/macexp';
import { ethSegment, ethStationMac } from '../lib/ethstation';
import { h, s } from '../ui/dom';
import { saveFile } from '../view/image';
import type { Scene, Stage, Widget } from '../view/stage';
import { Bench, btn, Capture, Loop, select, strip, txStateName } from './ethernet';
import { slider } from './mosparts';

const C_LIGHT = 299792458;
const utf8 = (t: string): number[] => Array.from(new TextEncoder().encode(t));

/** What the panel queues: station f's message, for station t or everyone. The tshark oracle reads these too. */
export function segmentFrame(f: number, t: number | 'all', txt: string): number[] {
  const spec: FrameSpec = { dst: t === 'all' ? BROADCAST : ethStationMac(t), src: ethStationMac(f), type: ETHERTYPE_IPV4, payload: utf8(txt).slice(0, MAX_PAYLOAD) };
  return frameBody(spec);
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const us = (clocks: number): string => `${((clocks * CLOCK_NS) / 1000).toFixed(2)} µs`;

// ---- step 5: collisions, from the model --------------------------------------------------------------------------------

export function collisionWidget(): Widget {
  let d = 24, off = 0;
  const box = h('div', { class: 'uart-svg' }), read = h('div', { class: 'mc-status' }), verdict = h('div', { class: 'clk-verdict' });
  const paint = () => {
    const W = Math.max(320, 2 * d + off + 200);
    const t = runPair(d, off, W, 7000);
    const marks = [
      ...(t.startB >= 0 ? [{ x: t.startB, text: 'B starts', cls: '' }] : []), { x: d, text: 'A\'s bit reaches B', cls: '' },
      ...(t.detectB >= 0 ? [{ x: t.detectB, text: 'B detects', cls: 'bad' }] : []), ...(t.detectA >= 0 ? [{ x: t.detectA, text: 'A detects', cls: 'bad' }] : []),
    ];
    box.replaceChildren(strip([{ label: 'A sends', data: t.txenA }, { label: 'B sends', data: t.txenB }, { label: 'A hears', data: t.hearA, cls: 'heard' }, { label: 'B hears', data: t.hearB, cls: 'heard' }, { label: 'A jam', data: t.jamA, cls: 'jam' }, { label: 'B jam', data: t.jamB, cls: 'jam' }],
      W, 'Two stations starting close together: who sends, who hears whom, who detects the collision', marks));
    read.replaceChildren(h('span', null, 'one-way delay ', h('b', null, `${d} clocks`), ` = ${(d / BIT_CLOCKS).toFixed(1)} bit times`), h('span', null, 'B starts ', h('b', null, `${t.startB} clocks`), ' after A'),
      h('span', null, 'A detects ', h('b', null, t.detectA >= 0 ? `at ${t.detectA}` : 'never')), h('span', null, 'B detects ', h('b', null, t.detectB >= 0 ? `at ${t.detectB}` : 'never')),
      h('span', null, 'backoff draws ', h('b', null, `A ${t.drawsA.join(', ') || '-'} · B ${t.drawsB.join(', ') || '-'}`), ' slots'),
      h('span', null, 'frames kept ', h('b', null, `A ${t.goodA} · B ${t.goodB}`)));
    if (t.detectA >= 0 || t.detectB >= 0) {
      verdict.className = 'clk-verdict bad';
      verdict.textContent = t.detectB >= 0 && t.startB < d
        ? `Both started before the other's first bit arrived. B hears A at ${d} and detects at ${t.detectB}; A hears B at ${t.startB + d} and detects at ${t.detectA}. Each sends a ${JAM_BYTES * 8}-bit jam so that everyone sees the collision, then draws a backoff. In the end A kept ${t.goodA} and B kept ${t.goodB} frames.`
        : `B started at ${t.startB}, about when A's carrier reached it (${d}): its decision to start came a clock or two before the carrier showed.`;
    } else {
      verdict.className = 'clk-verdict ok';
      verdict.textContent = t.startB > d ? `B's carrier sense saw A's frame (arriving at ${d}) before it was ready: it deferred and went after the gap. No collision. A kept ${t.goodA} and B kept ${t.goodB} frames.` : 'No collision.';
    }
  };
  const sd = slider('Cable delay', 2, 150, 2, d, (v) => `${v} clocks`, (v) => { d = v; paint(); });
  const so = slider('B starts', 0, 300, 1, off, (v) => `+${v} clocks`, (v) => { off = v; paint(); });
  paint();
  return {
    el: h('div', { class: 'widget mos clk-w comm' }, h('div', { class: 'panel' }, h('h3', null, 'Two stations, one cable'),
      h('div', { class: 'mc-row' }, sd.el, so.el), read, box, verdict,
      h('p', { class: 'sub' }, 'The model of comm/mac.ts, the machine the gates were compared with: both stations have a minimum frame queued and have waited out the gap. A station hears the other only after the cable delay, so for that long it believes the wire is free.'))),
  };
}

// ---- step 6: why a minimum frame --------------------------------------------------------------------------------------

const RATES: [string, number][] = [['10 Mb/s', 10], ['100 Mb/s', 100], ['1 Gb/s', 1000], [`${LINK_MBPS.toFixed(0)} Mb/s (this book)`, LINK_MBPS]];

/** The model's verdict for a minimum frame and a cable of `d` clocks, B starting as late as it can without hearing A: [A saw the collision at, A's frame ended at]. */
export function worstCase(d: number): { detectA: number; end: number; sentA: number } {
  const t = runPair(d, Math.max(0, d - 1), 3200 + 2 * d, 4000);
  return { detectA: t.detectA, end: frameBitTimes(MIN_FRAME) * BIT_CLOCKS, sentA: t.sentA };
}

export function minFrameWidget(): Widget {
  let v = 0.66, d = 800;
  const tbl = h('div', { class: 'eth-scroll' }), box = h('div', { class: 'uart-svg' }), read = h('div', { class: 'mc-status' }), verdict = h('div', { class: 'clk-verdict' });
  const paint = () => {
    const rows = RATES.map(([n, r]) => {
      const bits = frameBitTimes(MIN_FRAME), slot = SLOT_BITS / r;
      return h('tr', null, h('td', null, n), h('td', null, `${(1000 / r).toFixed(1)} ns`), h('td', null, `${slot.toFixed(2)} µs`), h('td', null, `${maxCableMetres(bits, v, r).toFixed(0)} m`), h('td', null, `${maxCableMetres(SLOT_BITS, v, r).toFixed(0)} m`));
    });
    tbl.replaceChildren(h('table', { class: 'comm-table' }, h('thead', null, h('tr', null, h('th', null, 'rate'), h('th', null, 'bit'), h('th', null, '512 bit times'), h('th', null, 'cable, whole frame'), h('th', null, 'cable, 512 bits'))), h('tbody', null, rows)));
    const w = worstCase(d), metres = d * CLOCK_NS * 1e-9 * v * C_LIGHT;
    const roundTrip = 2 * d - 1, ok = w.detectA >= 0;
    const W = Math.max(w.end, roundTrip) + 200;
    const A = Array.from({ length: W }, (_, i) => (i < w.end ? 1 : 0)), Bq = Array.from({ length: W }, (_, i) => (i >= d - 1 && i < d - 1 + w.end ? 1 : 0));
    box.replaceChildren(strip([{ label: 'A sends', data: A }, { label: 'B sends', data: Bq }], W, 'A minimum frame from A and the latest start of B that does not yet hear A', [{ x: w.end, text: 'A ends', cls: '' }, { x: roundTrip, text: 'B\'s news reaches A', cls: ok ? 'bad' : '' }]));
    read.replaceChildren(h('span', null, 'cable ', h('b', null, `${metres.toFixed(0)} m`), ` one way (${d} clocks at ${v.toFixed(2)} c)`), h('span', null, 'round trip ', h('b', null, `${roundTrip} clocks`)), h('span', null, 'frame on the wire ', h('b', null, `${w.end} clocks`), ` (${frameBitTimes(MIN_FRAME)} bit times)`),
      h('span', null, 'A detects ', h('b', null, ok ? `at ${w.detectA}` : 'never')));
    verdict.className = `clk-verdict ${ok ? 'ok' : 'bad'}`;
    verdict.textContent = ok ? `B starts at ${d - 1}, the instant before A's signal reaches it. The news of the collision gets back at ${roundTrip}, while A is still sending (it sends until ${w.end}): A detects it, jams and backs off, and the frame is repeated.`
      : `B's signal reaches A at ${roundTrip}, after A has finished (${w.end}). A never sees the collision, sends no jam and does not repeat the frame: it counts it sent (sent = ${w.sentA}). The receivers saw a mangled frame and dropped it, and nothing above the MAC knows.`;
  };
  const sv = slider('Propagation speed', 0.5, 0.9, 0.01, v, (x) => `${x.toFixed(2)} c`, (x) => { v = x; paint(); });
  const sd = slider('Cable delay', 100, 1400, 50, d, (x) => `${x} clocks`, (x) => { d = x; paint(); });
  paint();
  return {
    el: h('div', { class: 'widget mos clk-w comm' }, h('div', { class: 'panel' }, h('h3', null, 'The minimum frame and the longest cable'),
      h('div', { class: 'mc-row' }, sv.el), tbl,
      h('p', { class: 'sub' }, `A sender has to still be sending when the news of a collision at the far end comes back, 2d/v later. For the frame of ${MIN_FRAME} bytes plus preamble and SFD that gives d ≤ v · T / 2, with T the frame's time on the wire; the standard's slot time of ${SLOT_BITS} bit times is the 64 bytes from destination to FCS, and the preamble and SFD are margin on top.`),
      h('div', { class: 'mc-row' }, sd.el), read, box, verdict)),
  };
}

// ---- step 7: backoff and throughput ------------------------------------------------------------------------------------

export interface LoadWidgetState { n: number; payload: number; points: LoadResult[]; saturated: LoadResult | null; compute(): Promise<void> }
const loadStates = new WeakMap<HTMLElement, LoadWidgetState>();
export const loadState = (w: Widget) => loadStates.get(w.el);
const LOADS = [0.2, 0.4, 0.6, 0.8, 1.0, 1.4, 2.0, 3.0];

export function throughputWidget(): Widget {
  const S: LoadWidgetState = { n: 4, payload: 46, points: [], saturated: null, compute: async () => compute() };
  const plot = h('div', { class: 'uart-svg' }), read = h('div', { class: 'mc-status' }), tbl = h('div', { class: 'eth-scroll' }), prog = h('span', { class: 'sub', role: 'status' });
  let busy = false, gen = 0;
  const paint = () => {
    const W = 640, H = 246, L = 40, R = 10, T = 12, B = 30, gx = (g: number) => L + (g / 3) * (W - L - R), gy = (v: number) => H - B - v * (H - B - T);
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'mos-plot eth-plot', role: 'img', 'aria-label': 'Throughput against offered load' }) as SVGSVGElement;
    for (const v of [0, 0.25, 0.5, 0.75, 1]) svg.append(s('line', { x1: L, x2: W - R, y1: gy(v), y2: gy(v), class: 'grid' }), s('text', { x: 4, y: gy(v) + 4, class: 'tick' }, v.toFixed(2)));
    for (const g of [0, 1, 2, 3]) svg.append(s('text', { x: gx(g), y: H - 16, 'text-anchor': 'middle', class: 'tick' }, String(g)));
    svg.append(s('text', { x: (L + W) / 2, y: H - 1, 'text-anchor': 'middle', class: 'tick' }, 'offered load (fraction of capacity)'));
    const mx = maxThroughput(S.payload);
    svg.append(s('path', { d: `M${gx(0)},${gy(0)}L${gx(mx)},${gy(mx)}L${gx(3)},${gy(mx)}`, class: 'eth-ideal' }));
    if (S.points.length) svg.append(s('path', { d: S.points.map((p, i) => `${i ? 'L' : 'M'}${gx(p.offered)},${gy(p.throughput)}`).join(''), class: 'eth-curve' }), ...S.points.map((p) => s('circle', { cx: gx(p.offered), cy: gy(p.throughput), r: 3.5, class: 'eth-dot' })));
    plot.replaceChildren(svg);
    read.replaceChildren(h('span', null, 'limit ', h('b', null, mx.toFixed(3)), ' (frame / frame + gap)'), h('span', null, 'stations ', h('b', null, String(S.n))), h('span', null, 'frame ', h('b', null, `${Math.max(MIN_FRAME, 18 + S.payload)} B`)),
      h('span', null, 'peak ', h('b', null, S.points.length ? Math.max(...S.points.map((p) => p.throughput)).toFixed(3) : '-')), prog);
    const sat = S.saturated;
    tbl.replaceChildren(sat ? h('table', { class: 'comm-table' }, h('thead', null, h('tr', null, h('th', null, 'saturated'), ...sat.sent.map((_, i) => h('th', null, `st ${i + 1}`)))),
      h('tbody', null, h('tr', null, h('td', null, 'frames sent'), ...sat.sent.map((c) => h('td', null, String(c)))), h('tr', null, h('td', null, 'mean run'), h('td', { colspan: sat.sent.length }, `${sat.meanRun.toFixed(1)} frames in a row from one station`)),
        h('tr', null, h('td', null, 'collisions'), h('td', { colspan: sat.sent.length }, `${sat.collisions} (${sat.drops} dropped after ${ATTEMPT_LIMIT})`)))) : h('p', { class: 'sub' }, 'Press Run to compute the curve and the saturated case.'));
  };
  const compute = async () => {
    if (busy) return;
    busy = true; const my = ++gen;
    S.points = []; S.saturated = null; paint();
    const clocks = Math.max(300000, 24 * (8 + Math.max(MIN_FRAME, 18 + S.payload)) * 32);
    for (let i = 0; i < LOADS.length; i++) {
      prog.textContent = `computing ${i + 1} / ${LOADS.length + 1}…`;
      await tick();
      if (my !== gen) { busy = false; return; }
      S.points.push(runLoad({ n: S.n, payload: S.payload, load: LOADS[i], clocks, seed: 1 }));
      paint();
    }
    prog.textContent = `computing ${LOADS.length + 1} / ${LOADS.length + 1}…`;
    await tick();
    S.saturated = runLoad({ n: S.n, payload: S.payload, load: 1e6, clocks: clocks * 2, seed: 1 });
    prog.textContent = '';
    busy = false; paint();
  };
  const nSel = select('Stations', [['2', '2 stations'], ['4', '4 stations'], ['8', '8 stations']], '4', (v) => { S.n = Number(v); gen++; busy = false; S.points = []; S.saturated = null; paint(); });
  const pSel = select('Frame size', [['46', '64-byte frames'], ['500', '500-byte payload'], ['1500', '1500-byte payload']], '46', (v) => { S.payload = Math.min(MAX_PAYLOAD, Number(v)); gen++; busy = false; S.points = []; S.saturated = null; paint(); });
  paint();
  const el = h('div', { class: 'widget mos clk-w comm' }, h('div', { class: 'panel' }, h('h3', null, 'Throughput against load'),
    h('div', { class: 'mc-row' }, nSel, pSel, btn('Run', 'Run the model at eight loads and once saturated', () => { void compute(); }, 'btn sm primary')),
    plot, read, tbl,
    h('p', { class: 'sub' }, `Poisson arrivals into stations that hold one frame each, on a cable a few clocks long; the MAC model clock by clock. Offered load counts every arrival, including those turned away because the station was still busy. The dashed line is the most a wire can carry: one frame every frame + ${GAP_CLOCKS / BIT_CLOCKS}-bit-time gap.`)));
  loadStates.set(el, S);
  return { el, destroy: () => { gen++; } };
}

// ---- step 8: the segment ----------------------------------------------------------------------------------------------

export interface SegState {
  clock: number; collisions: number; sent: number; kept: number[]; log: string[]; capture: Capture | null; queued: number[];
  /** Add a frame to a station's queue; it is written into the station's buffer, and sent, when the station has let go of the one before. */
  queue(from: number, to: number | 'all', text: string): void;
  /** Frames for several stations written first, then their go pulses in consecutive clocks: the stations start almost together. */
  together(pairs: [number, number][]): void;
  saveCapture(): Uint8Array | null; run(): void; pause(): void;
}
const segStates = new WeakMap<Stage, SegState>();
export const segState = (st: Stage) => segStates.get(st);

const SAMPLE = 8, WINDOW = 880;
interface HostOp { sel: number; wa: number; wd: number; we: number; len: number; go: number }
const IDLE_OP: HostOp = { sel: 0, wa: 0, wd: 0, we: 0, len: 0, go: 0 };
const writeOps = (k: number, bytes: number[]): HostOp[] => bytes.map((b, i) => ({ ...IDLE_OP, sel: k, wa: i, wd: b, we: 1 }));
const goOp = (k: number, len: number): HostOp => ({ ...IDLE_OP, sel: k, len, go: 1 });

export function segmentScene(): Scene {
  return {
    root: ethSegment(4), inputs: { rst: 0, sel: 0, wa: 0, wd: 0, we: 0, len: 0, go: 0, ra: 0, hrd: 0, promisc: 8 }, hiddenInputs: ['rst', 'sel', 'wa', 'wd', 'we', 'len', 'go', 'ra', 'hrd', 'promisc'], autoClock: false, engine: 'cycle',
    panels: [(stage: Stage): Widget => {
      const b = new Bench(stage);
      let clock = 0, collisions = 0, sent = 0, log: string[] = [], text = 'hello', from = 0, to: number | 'all' = 1;
      const rows: number[][] = [[], [], [], [], []];
      let acc = [0, 0, 0, 0, 0];
      const attempts = [0, 0, 0, 0];
      // frames waiting for their station, and the host port's pending writes: one clock each, one frame at a time
      const queues: number[][][] = [[], [], [], []];
      let ops: HostOp[] = [];
      const cap = new Capture(b, () => b.get('cp3'), 3);
      const strips = h('div', { class: 'uart-svg' }), read = h('div', { class: 'mc-status' }), cards = h('div', { class: 'eth-cards' }), logBox = h('ol', { class: 'eth-log', 'aria-label': 'Events' });
      const field = (name: string, i: number, w: number) => Math.floor(b.get(name) / 2 ** (w * i)) % 2 ** w;
      const note = (t: string) => { log.push(`${clock}: ${t}`); if (log.length > 40) log.shift(); };
      const record = () => {
        clock++;
        const en = b.get('txen'), clash = b.get('clash'), re = b.get('restart'), sn = b.get('sent'), dr = b.get('drop');
        for (let i = 0; i < 4; i++) acc[i] |= (en >> i) & 1;
        acc[4] |= clash;
        if (clock % SAMPLE === 0) { acc.forEach((v, i) => { rows[i].push(v); if (rows[i].length > WINDOW) rows[i].shift(); }); acc = [0, 0, 0, 0, 0]; }
        if (re | dr | sn) for (let i = 0; i < 4; i++) {
          if ((re >> i) & 1) { collisions++; attempts[i]++; note(`station ${i + 1} collided (collision ${attempts[i]} for this frame), waits up to ${2 ** Math.min(BACKOFF_LIMIT, attempts[i]) - 1} slots`); }
          if ((dr >> i) & 1) { note(`station ${i + 1} gave up after ${ATTEMPT_LIMIT} attempts`); attempts[i] = 0; }
          if ((sn >> i) & 1) { sent++; note(`station ${i + 1} sent its frame${attempts[i] ? ` (after ${attempts[i]} collision${attempts[i] > 1 ? 's' : ''})` : ''}`); attempts[i] = 0; }
        }
        const rg = b.get('rxgood'), rb = b.get('rxbad');
        if (rg | rb) for (let i = 0; i < 4; i++) {
          if ((rg >> i) & 1) note(`station ${i + 1} kept a frame`);
          if ((rb >> i) & 1) note(`station ${i + 1} threw a frame away`);
        }
        cap.poll(clock);
      };
      /** The next frame of the first station that has let go and has one waiting, written by the host port: only when the port is free. */
      let waiting: [number, number][] | null = null;
      const togetherOps = (pairs: [number, number][]): HostOp[] => {
        const frames = pairs.map(([f, t]) => frameFor(f, t, `from ${f + 1} to ${t + 1}`));
        return [...pairs.flatMap(([f], k) => writeOps(f, frames[k])), ...pairs.map(([f], k) => goOp(f, frames[k].length))];
      };
      const pump = () => {
        if (ops.length) return;
        const busy = b.get('busy');
        if (waiting && waiting.every(([f]) => !queues[f].length && !((busy >> f) & 1))) { ops.push(...togetherOps(waiting)); note(`stations ${waiting.map(([f]) => f + 1).join(', ')}: frames written, go in consecutive clocks`); waiting = null; return; }
        for (let i = 0; i < 4; i++) {
          if (queues[i].length && !((busy >> i) & 1)) { const f = queues[i].shift()!; ops.push(...writeOps(i, f), goOp(i, f.length)); return; }
        }
      };
      const step = () => {
        pump();
        const op = ops.shift() ?? IDLE_OP;
        b.set('sel', op.sel); b.set('wa', op.wa); b.set('wd', op.wd); b.set('we', op.we); b.set('len', op.len); b.set('go', op.go);
        b.clock(); record();
        return true;
      };
      const loop = new Loop(stage, step, () => paint(), 150, 30);
      const runBtn = btn('Run', 'Run the clock', () => runPause(!loop.running), 'btn sm primary');
      const runPause = (on: boolean) => { if (on && !loop.running) loop.start(); else if (!on && loop.running) loop.stop(); runBtn.textContent = loop.running ? 'Pause' : 'Run'; };
      const frameFor = segmentFrame;
      const queue = (f: number, t: number | 'all', txt: string) => {
        queues[f].push(frameFor(f, t, txt));
        note(`station ${f + 1}: ${txt.length} bytes for ${t === 'all' ? 'everyone' : `station ${t + 1}`} queued (${queues[f].length} waiting)`);
        runPause(true); paint();
      };
      const together = (pairs: [number, number][]) => {
        waiting = pairs;
        note('together: waiting until those stations have let go of earlier frames');
        runPause(true); pump(); paint();
      };
      const S: SegState = {
        clock: 0, collisions: 0, sent: 0, kept: [0, 0, 0, 0], log, capture: cap, queued: [0, 0, 0, 0], queue, together,
        saveCapture: () => (cap.frames.length ? cap.pcap() : null), run: () => runPause(true), pause: () => runPause(false),
      };
      segStates.set(stage, S);
      const paint = () => {
        S.clock = clock; S.collisions = collisions; S.sent = sent; S.log = log; S.kept = [0, 1, 2, 3].map((i) => field('ngood', i, 8)); S.queued = queues.map((q) => q.length);
        strips.replaceChildren(strip([...[0, 1, 2, 3].map((i) => ({ label: `station ${i + 1}`, data: rows[i] })), { label: 'clash', data: rows[4], cls: 'jam' }], WINDOW, `Which stations send, in the last ${(WINDOW * SAMPLE).toLocaleString('en')} clocks (one sample per ${SAMPLE})`));
        const busy = b.get('busy');
        cards.replaceChildren(...[0, 1, 2, 3].map((i) => h('div', { class: `eth-card${i === 3 ? ' mon' : ''}` }, h('b', null, `Station ${i + 1}`), h('div', { class: 'sub' }, i === 3 ? 'monitor' : 'host'),
          h('div', null, txStateName(field('txstate', i, 3)), (busy >> i) & 1 ? ' · frame held' : ''), h('div', null, `kept ${field('ngood', i, 8)} · dropped ${field('nbad', i, 8)}`),
          h('div', null, `collisions ${field('ncol', i, 8)}`), h('div', null, `waiting ${queues[i].length}`))));
        read.replaceChildren(h('span', null, 'clocks ', h('b', null, clock.toLocaleString('en'))), h('span', null, 'time ', h('b', null, us(clock))), h('span', null, 'frames sent ', h('b', null, String(sent))), h('span', { title: 'Each station that detects a collision counts it once: two stations colliding count 2' }, 'collisions detected ', h('b', null, String(collisions))),
          h('span', null, 'station 4 has captured ', h('b', null, `${cap.frames.length} frame${cap.frames.length === 1 ? '' : 's'}`)));
        logBox.replaceChildren(...log.slice(-8).map((l) => h('li', null, l)));
      };
      stage.historyHooks.add({
        save: () => ({ clock, collisions, sent, log: [...log], rows: rows.map((r) => [...r]), acc: [...acc], attempts: [...attempts], queues: queues.map((q) => [...q]), ops: [...ops], cap: cap.save() }),
        restore: (v) => {
          const x = v as { clock: number; collisions: number; sent: number; log: string[]; rows: number[][]; acc: number[]; attempts: number[]; queues: number[][][]; ops: HostOp[]; cap: ReturnType<Capture['save']> };
          clock = x.clock; collisions = x.collisions; sent = x.sent; log = [...x.log]; x.rows.forEach((r, i) => { rows[i] = [...r]; }); acc = [...x.acc]; x.attempts.forEach((a, i) => { attempts[i] = a; });
          x.queues.forEach((q, i) => { queues[i] = q.map((f) => [...f]); }); ops = [...x.ops]; cap.restore(x.cap); paint();
        },
      });
      stage.resetHooks.add(() => { clock = 0; collisions = 0; sent = 0; log = []; rows.forEach((r) => { r.length = 0; }); acc = [0, 0, 0, 0, 0]; attempts.fill(0); queues.forEach((q) => { q.length = 0; }); ops = []; waiting = null; cap.reset(); b.reset(); paint(); });
      b.reset();
      const inp = h('input', { type: 'text', class: 'uart-text', value: text, maxlength: 60, 'aria-label': 'Message', spellcheck: 'false' }) as HTMLInputElement;
      inp.addEventListener('input', () => { text = inp.value; });
      const fSel = select('From', [['0', 'from station 1'], ['1', 'from station 2'], ['2', 'from station 3']], '0', (v) => { from = Number(v); });
      const tSel = select('To', [['1', 'to station 2'], ['0', 'to station 1'], ['2', 'to station 3'], ['all', 'to everyone']], '1', (v) => { to = v === 'all' ? 'all' : Number(v); });
      paint();
      const saveBtn = btn('Save capture', 'Download the frames station 4 received as a .pcap file that Wireshark and tcpdump open', () => {
        const f = S.saveCapture();
        if (f) saveFile('segment.pcap', new Blob([f.buffer as ArrayBuffer], { type: 'application/vnd.tcpdump.pcap' }), 'application/vnd.tcpdump.pcap');
        else note('nothing captured yet: station 4 keeps every good frame it receives');
        paint();
      });
      const el = h('div', { class: 'mem-panel cpu-panel mc-panel clk-panel eth-panel', 'data-dock': 'right', 'data-phone': 'flow' }, h('h4', null, 'Four stations on a cable', h('span', { class: 'fold-hint' })),
        h('div', { class: 'mc-row' }, inp, fSel, tSel, btn('Queue', 'Add the frame to the station\'s queue and run: it is written into the station\'s buffer and sent when the station is free', () => queue(from, to, text))),
        h('div', { class: 'mc-row' }, btn('1 ↔ 2 together', 'Write a frame for each, then tell both to go in consecutive clocks: they collide', () => together([[0, 1], [1, 0]])), btn('1, 2 and 3 together', 'Three stations at once', () => together([[0, 3], [1, 3], [2, 3]])), runBtn, saveBtn),
        read, cards, strips, logBox);
      return { el, update: paint, destroy: () => loop.stop() };
    }],
  };
}
