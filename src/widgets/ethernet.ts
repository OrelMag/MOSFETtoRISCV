// Chapter 48's scenes and widgets (Ethernet): the frame builder, the transmitter, receiver and carrier-sense scenes on the
// gate-level station (lib/ethernet.ts), shared helpers for the segment scene and the model-driven widgets in
// widgets/ethernet2.ts. Models: comm/mac.ts (clock by clock, equal to the gates), comm/macexp.ts.

import '../styles/clocks.css';
import '../styles/uart.css';
import '../styles/ethernet.css';
import { crc32, fcsBytes } from '../comm/crc';
import { BROADCAST, ETHERTYPE_ARP, ETHERTYPE_IPV4, frameBody, MAX_PAYLOAD, MIN_PAYLOAD, wireBytes, type FrameSpec } from '../comm/ethframe';
import { BIT_CLOCKS, captureRecord, clocksToUs, frameBitTimes, GAP_BITS, LINK_MBPS, WHY_NAMES } from '../comm/mac';
import { ETH_EV, ethStation, ethStationMac } from '../lib/ethstation';
import { pcapFile } from '../comm/pcap';
import { h, s } from '../ui/dom';
import type { Scene, Stage, Widget } from '../view/stage';
import { pack } from '../sim/values';
import { slider } from './mosparts';

export const hex2 = (v: number): string => v.toString(16).padStart(2, '0');
export const FIELD_CLS = ['pre', 'dst', 'src', 'type', 'data', 'pad', 'fcs'] as const;
export const FIELD_NAME: Record<(typeof FIELD_CLS)[number], string> = { pre: 'preamble, SFD', dst: 'destination', src: 'source', type: 'EtherType', data: 'payload', pad: 'pad', fcs: 'FCS' };

export const btn = (label: string, title: string, f: () => void, cls = 'btn sm'): HTMLButtonElement => { const b = h('button', { class: cls, title }, label); b.addEventListener('click', f); return b; };
export function select(label: string, opts: [string, string][], value: string, on: (v: string) => void): HTMLSelectElement {
  const sel = h('select', { class: 'mc-sel', 'aria-label': label }) as HTMLSelectElement;
  for (const [v, t] of opts) sel.append(h('option', { value: v }, t));
  sel.value = value;
  sel.addEventListener('change', () => on(sel.value));
  return sel;
}

/** What each byte of a frame (from the preamble on) is. */
export function fieldMap(payloadLen: number, withWire = true): (typeof FIELD_CLS)[number][] {
  const out: (typeof FIELD_CLS)[number][] = [];
  if (withWire) for (let i = 0; i < 8; i++) out.push('pre');
  for (let i = 0; i < 6; i++) out.push('dst');
  for (let i = 0; i < 6; i++) out.push('src');
  out.push('type', 'type');
  for (let i = 0; i < payloadLen; i++) out.push('data');
  for (let i = payloadLen; i < MIN_PAYLOAD; i++) out.push('pad');
  for (let i = 0; i < 4; i++) out.push('fcs');
  return out;
}

/** A hex dump with one colour per field, rows of 16. */
export function hexDump(bytes: number[], cls: string[], from = 0): HTMLElement {
  const box = h('div', { class: 'eth-hex', role: 'group', 'aria-label': 'Frame bytes, coloured by field' });
  for (let r = 0; r < bytes.length; r += 16) {
    const row = h('div', { class: 'eth-row' }, h('span', { class: 'eth-off' }, (from + r).toString(16).padStart(4, '0')));
    for (let i = r; i < Math.min(bytes.length, r + 16); i++) row.append(h('span', { class: `eth-b f-${cls[i] ?? 'data'}` }, hex2(bytes[i])));
    box.append(row);
  }
  return box;
}

export function legend(used: Iterable<string>): HTMLElement {
  const set = new Set(used);
  return h('div', { class: 'eth-legend' }, FIELD_CLS.filter((k) => set.has(k)).map((k) => h('span', null, h('i', { class: `eth-sw f-${k}` }), FIELD_NAME[k])));
}

export const macLabel = (m: readonly number[]): string => m.map(hex2).join(':');
export const ETHERTYPES: [string, string][] = [[String(ETHERTYPE_IPV4), '0x0800 IPv4'], [String(ETHERTYPE_ARP), '0x0806 ARP'], [String(0x88b5), '0x88B5 local experimental']];
const utf8 = (t: string): number[] => Array.from(new TextEncoder().encode(t));

// ---- step 1: the frame builder -----------------------------------------------------------------------------------------

export function frameWidget(): Widget {
  let text = 'hello from A', dst = 'b', type = ETHERTYPE_IPV4;
  const out = h('div'), read = h('div', { class: 'mc-status' });
  const paint = () => {
    const payload = utf8(text).slice(0, MAX_PAYLOAD);
    const spec: FrameSpec = { dst: dst === 'all' ? BROADCAST : ethStationMac(dst === 'b' ? 1 : 2), src: ethStationMac(0), type, payload };
    const wire = wireBytes(spec), cls = fieldMap(payload.length);
    const fcs = fcsBytes(crc32(frameBody(spec)));
    const bits = frameBitTimes(wire.length - 8);
    out.replaceChildren(hexDump(wire, cls), legend(cls));
    const pad = Math.max(0, MIN_PAYLOAD - payload.length), bytes = wire.length - 8;
    read.replaceChildren(
      h('span', null, 'payload ', h('b', null, `${payload.length} B`)), h('span', null, 'pad ', h('b', null, `${pad} B`)), h('span', null, 'frame ', h('b', null, `${bytes} B`), ' + 8 B preamble'),
      h('span', null, 'FCS ', h('b', null, fcs.map(hex2).join(' ')), ' (sent first byte first)'),
      h('span', null, 'on the wire ', h('b', null, `${bits} bit times`), ' + 96 gap'),
      h('span', null, 'at ', h('b', null, '10 Mb/s'), ' ', h('b', null, `${(bits / 10).toFixed(1)} µs`)), h('span', null, 'at ', h('b', null, `${LINK_MBPS.toFixed(0)} Mb/s`), ' (4 clocks a bit) ', h('b', null, `${(bits / LINK_MBPS).toFixed(1)} µs`)),
      h('span', null, 'payload share ', h('b', null, `${((100 * payload.length) / (bits + GAP_BITS) * 8).toFixed(1)} %`), ' of the time'));
  };
  const inp = h('input', { type: 'text', class: 'comm-input', value: text, maxlength: 200, 'aria-label': 'Message', spellcheck: 'false' }) as HTMLInputElement;
  inp.addEventListener('input', () => { text = inp.value; paint(); });
  const toSel = select('Destination', [['b', 'station 2 (02:00:00:00:00:02)'], ['c', 'station 3 (02:00:00:00:00:03)'], ['all', 'everyone (ff:ff:ff:ff:ff:ff)']], dst, (v) => { dst = v; paint(); });
  const tSel = select('EtherType', ETHERTYPES, String(type), (v) => { type = Number(v); paint(); });
  paint();
  return {
    el: h('div', { class: 'widget mos clk-w comm' }, h('div', { class: 'panel' }, h('h3', null, 'A frame, byte by byte'),
      inp, h('div', { class: 'mc-row' }, h('label', { class: 'mos-sl' }, h('span', null, 'To'), toSel), h('label', { class: 'mos-sl' }, h('span', null, 'Type'), tSel)),
      out, read,
      h('p', { class: 'sub' }, 'Sent from station 1. Bytes go out left to right, each least significant bit first. The FCS is the CRC-32 of chapter 47 over everything from the destination to the pad; the preamble and SFD are not covered.'))),
  };
}

// ---- a bench around the station on the stage ---------------------------------------------------------------------------

/** The stage's simulation seen through the host port of a station (or of the segment: `sel` picks the station). */
export class Bench {
  constructor(readonly st: Stage) {}
  get sim() { return this.st.sim!; }
  private raw(name: string): number { return pack(this.sim.getBits(this.sim.design.root.ports[name])); }
  /**
   * A port by name. The station packs its events (ev), states (stat) and counters (counts); here they read by name, and on a
   * segment (ports ev0, ev1 …) one bit or field a station is packed into a number, station 0 lowest.
   */
  get(name: string): number {
    const ports = this.sim.design.root.ports;
    const single = (n: string, f: (v: number) => number): number => (n in ports ? f(this.raw(n)) : -1);
    const spread = (src: string, f: (v: number) => number, w: number): number => {
      const one = single(src, f);
      if (one >= 0) return one;
      let v = 0;
      for (let i = 0; `${src}${i}` in ports; i++) v += f(this.raw(`${src}${i}`)) * 2 ** (w * i);
      return v;
    };
    if (name in ETH_EV) return spread('ev', (v) => (v >> ETH_EV[name as keyof typeof ETH_EV]) & 1, 1);
    if (name === 'txstate') return spread('stat', (v) => v & 7, 3);
    if (name === 'att') return spread('stat', (v) => (v >> 3) & 15, 4);
    if (name === 'rxstate') return spread('stat', (v) => (v >> 7) & 3, 2);
    if (name === 'ngood') return spread('counts', (v) => v & 255, 8);
    if (name === 'nbad') return spread('counts', (v) => Math.floor(v / 256) & 255, 8);
    if (name === 'ncol') return spread('counts', (v) => Math.floor(v / 65536) & 255, 8);
    if (name === 'cp' && !('cp' in ports)) return spread('cp', (v) => v, 11);
    return this.raw(name);
  }
  set(name: string, v: number): void { this.sim.setInput(name, v); }
  clock(): void { const m = this.sim; m.settle(); m.setInput('clk', 1); m.settle(); m.setInput('clk', 0); m.settle(); }
  reset(): void { this.set('rst', 1); this.clock(); this.clock(); this.set('rst', 0); this.sim.settle(); }
  /** Write a frame into the buffer (one clock a byte), then pulse go. */
  send(bytes: number[], sel?: number): void {
    if (sel !== undefined) this.set('sel', sel);
    bytes.forEach((b, i) => { this.set('wa', i); this.set('wd', b); this.set('we', 1); this.clock(); });
    this.set('we', 0); this.set('len', bytes.length); this.set('go', 1); this.clock(); this.set('go', 0);
  }
  /** A byte of the receive buffer, through the host read port. */
  rx(addr: number, sel?: number): number {
    if (sel !== undefined) this.set('sel', sel);
    this.set('ra', addr); this.set('hrd', 1); this.sim.settle();
    const v = 'rd' in this.sim.design.root.ports ? this.get('rd') : this.get(`rd${sel ?? 0}`);
    this.set('hrd', 0); this.sim.settle();
    return v;
  }
}

/** Frames kept by one station's receive buffer: noticed when the commit pointer moves, read out through the host port. */
export class Capture {
  frames: { clock: number; bytes: number[] }[] = [];
  private last = 0;
  constructor(private b: Bench, private cp: () => number, private sel?: number) {}
  poll(clock: number): void {
    const cp = this.cp();
    if (cp === this.last) return;
    const bytes: number[] = [];
    for (let a = this.last; a !== cp; a = (a + 1) & 0x7ff) bytes.push(this.b.rx(a, this.sel));
    this.frames.push({ clock, bytes });
    this.last = cp;
  }
  reset(cp = 0): void { this.frames = []; this.last = cp; }
  pcap(): Uint8Array { return pcapFile(this.frames.map((f) => captureRecord(f.clock, f.bytes))); }
}

/** A row of digital signals as step lines, `labels` down the left. */
export function strip(rows: { label: string; data: number[]; cls?: string }[], total: number, aria: string, marks: { x: number; text: string; cls?: string }[] = []): SVGSVGElement {
  const W = 640, L = 62, R = 8, RH = 26, H = rows.length * RH + 14 + (marks.length ? 48 : 10);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'mos-plot uart-wave eth-strip', role: 'img', 'aria-label': aria }) as SVGSVGElement;
  const X = (i: number) => L + (i / Math.max(1, total)) * (W - L - R);
  rows.forEach((r, k) => {
    const y1 = 6 + k * RH, y0 = y1 + 16;
    svg.append(s('text', { x: 2, y: y0 - 3, class: 'tick' }, r.label));
    let d = '';
    r.data.forEach((v, i) => { const y = v ? y1 : y0; d += i === 0 ? `M${X(0)},${y}` : `L${X(i)},${r.data[i - 1] ? y1 : y0}L${X(i)},${y}`; });
    if (r.data.length) d += `L${X(r.data.length)},${r.data[r.data.length - 1] ? y1 : y0}`;
    svg.append(s('path', { d, class: `uart-line ${r.cls ?? ''}` }));
  });
  marks.forEach((m, k) => svg.append(s('line', { x1: X(m.x), x2: X(m.x), y1: 2, y2: H - 8 - (k % 4) * 11 - 10, class: `eth-mark ${m.cls ?? ''}` }), s('text', { x: Math.min(W - 90, X(m.x) + 3), y: H - 8 - (k % 4) * 11, class: 'tick' }, m.text)));
  return svg;
}

/** Calls step every `ms` until it returns false; one history checkpoint at the start. */
export class Loop {
  private t: ReturnType<typeof setInterval> | null = null;
  constructor(private stage: Stage, private step: () => boolean, private after: () => void, private perTick = 40, private ms = 30) {}
  get running(): boolean { return this.t !== null; }
  start(): void {
    if (this.t) return;
    this.stage.checkpoint();
    this.t = setInterval(() => {
      let go = true;
      for (let i = 0; i < this.perTick && go; i++) go = this.step();
      this.stage.refresh(); this.after();
      if (!go) this.stop();
    }, this.ms);
  }
  stop(): void { if (this.t) clearInterval(this.t); this.t = null; this.after(); }
}

const TX_STATES = ['idle', 'preamble + SFD', 'frame bytes', 'FCS', 'jam', 'backoff'];
export const txStateName = (v: number): string => TX_STATES[v] ?? '?';
const RX_STATES = ['idle', 'hunting for the SFD', 'receiving'];

/** The station on the stage as the scenes use it: address 1, nothing on the wire, a seed. */
const stationInputs = (): Record<string, number> => ({ me: 1, promisc: 0, rxd: 0, crs: 0, rst: 0, wa: 0, wd: 0, we: 0, len: 0, go: 0, ra: 0, hrd: 0 });
const HIDDEN = ['me', 'promisc', 'rxd', 'crs', 'rst', 'wa', 'wd', 'we', 'len', 'go', 'ra', 'hrd'];

// ---- step 2: the transmitter -------------------------------------------------------------------------------------------

export interface TxState { sentBytes: number[]; expected: number[]; done: boolean; send(text: string): void }
const txStates = new WeakMap<Stage, TxState>();
export const txState = (st: Stage): TxState | undefined => txStates.get(st);

export function txScene(): Scene {
  return {
    root: ethStation(), inputs: stationInputs(), hiddenInputs: HIDDEN, autoClock: false, engine: 'cycle',
    panels: [(stage: Stage): Widget => {
      const b = new Bench(stage);
      let text = 'hello from A', dst = 'b';
      let bits: number[] = [], wire: number[] = [], run = 0, done = false, cls: string[] = [], clock = 0, wave: number[][] = [[], []], plen = 0;
      const hexBox = h('div'), read = h('div', { class: 'mc-status' }), waveBox = h('div', { class: 'uart-svg' }), verdict = h('div', { class: 'clk-verdict' });
      const bytes = (): number[] => { const o: number[] = []; for (let k = 0; k + 8 <= bits.length; k += 8) o.push(bits.slice(k, k + 8).reduce((v, x, j) => v | (x << j), 0)); return o; };
      const record = () => {
        clock++;
        const en = b.get('txen'), d = b.get('txd');
        if (en) { if (run % BIT_CLOCKS === 0) bits.push(d); run++; }
        wave[0].push(en); wave[1].push(d);
        if (wave[0].length > 8 * BIT_CLOCKS * 3) { wave[0].shift(); wave[1].shift(); }
        if (b.get('sent') === 1) done = true;
      };
      const S: TxState = { sentBytes: [], expected: [], done: false, send: (t) => { text = t; start(); } };
      txStates.set(stage, S);
      const loop = new Loop(stage, () => { b.clock(); record(); return !done || run === 0 ? clock < 12000 : false; }, () => paint(), 80, 30);
      const start = () => {
        if (loop.running) return;
        stage.checkpoint();
        b.reset();
        const payload = utf8(text).slice(0, MAX_PAYLOAD);
        const spec: FrameSpec = { dst: dst === 'all' ? BROADCAST : ethStationMac(1), src: ethStationMac(0), type: ETHERTYPE_IPV4, payload };
        wire = wireBytes(spec); cls = fieldMap(payload.length); plen = payload.length; bits = []; run = 0; done = false; clock = 0; wave = [[], []];
        S.expected = wire; S.done = false; S.sentBytes = [];
        b.send(frameBody(spec));
        stage.refresh();
        loop.start();
      };
      const paint = () => {
        const got = bytes();
        S.sentBytes = got; S.done = done;
        hexBox.replaceChildren(got.length ? hexDump(got, cls) : h('p', { class: 'sub' }, 'Nothing sent yet. The buffer is loaded and the transmitter waits out the 96-bit-time gap.'), legend(cls.slice(0, got.length)));
        const st = b.get('txstate');
        read.replaceChildren(h('span', null, 'state ', h('b', null, txStateName(st))), h('span', null, 'gap counter ', h('b', null, `${b.get('gap')} / ${GAP_BITS * BIT_CLOCKS}`)),
          h('span', null, 'bytes out ', h('b', null, `${got.length} / ${wire.length || '-'}`)), h('span', null, 'clocks ', h('b', null, String(clock))), h('span', null, 'time ', h('b', null, `${clocksToUs(clock).toFixed(1)} µs`)));
        waveBox.replaceChildren(strip([{ label: 'txen', data: wave[0] }, { label: 'txd', data: wave[1] }], 8 * BIT_CLOCKS * 3, 'Carrier enable and serial data of the transmitter, the last 24 bits'));
        if (done) {
          const ok = got.length === wire.length && got.every((v, i) => v === wire[i]);
          verdict.className = `clk-verdict ${ok ? 'ok' : 'bad'}`;
          verdict.textContent = ok ? `The gates sent ${got.length} bytes, equal to the frame builder's: ${wire.length - 8 - 4} bytes of frame (${Math.max(0, MIN_PAYLOAD - plen)} of them pad) behind 8 of preamble, with the CRC-32 the unit computed on the way out as the last four. Frame time ${frameBitTimes(wire.length - 8)} bit times = ${(frameBitTimes(wire.length - 8) * BIT_CLOCKS)} clocks.`
            : 'The bytes differ from the frame builder\'s.';
        } else { verdict.className = 'clk-verdict'; verdict.textContent = ''; }
      };
      stage.resetHooks.add(() => { bits = []; run = 0; done = false; wire = []; cls = []; clock = 0; wave = [[], []]; paint(); });
      stage.historyHooks.add({ save: () => ({ bits: [...bits], run, done, clock, wave: wave.map((w) => [...w]) }), restore: (v) => { const x = v as { bits: number[]; run: number; done: boolean; clock: number; wave: number[][] }; bits = x.bits; run = x.run; done = x.done; clock = x.clock; wave = x.wave; paint(); } });
      const inp = h('input', { type: 'text', class: 'uart-text', value: text, maxlength: 60, 'aria-label': 'Message to send', spellcheck: 'false' }) as HTMLInputElement;
      inp.addEventListener('input', () => { text = inp.value; });
      const toSel = select('Destination', [['b', 'station 2'], ['all', 'everyone']], dst, (v) => { dst = v; });
      paint();
      const el = h('div', { class: 'mem-panel cpu-panel mc-panel clk-panel eth-panel', 'data-dock': 'right', 'data-phone': 'flow' }, h('h4', null, 'The transmitter, byte by byte', h('span', { class: 'fold-hint' })),
        h('div', { class: 'mc-row' }, inp, toSel, btn('Send', 'Load the frame into the buffer and run the clock until the last FCS bit is out', start, 'btn sm primary')),
        read, hexBox, waveBox, verdict,
        h('p', { class: 'sub' }, 'The frame leaves a bit every 4 clocks. Watch the state: idle until the gap counter reaches 96 bit times, then the preamble and SFD, the frame, the FCS.'));
      return { el, update: paint, destroy: () => { loop.stop(); } };
    }],
  };
}

// ---- step 3: the receiver ----------------------------------------------------------------------------------------------

/** The line as the receiver sees it: idle, then the bytes' bits (LSB first, BIT_CLOCKS clocks each) with the carrier up. */
export function lineOf(bytes: number[], lead = 12, tail = 40, flip = -1): { rxd: number[]; crs: number[] } {
  const rxd: number[] = Array(lead).fill(0), crs: number[] = Array(lead).fill(0);
  let n = 0;
  for (const by of bytes) for (let k = 0; k < 8; k++, n++) {
    const v = ((by >> k) & 1) ^ (n === flip ? 1 : 0);
    for (let c = 0; c < BIT_CLOCKS; c++) { rxd.push(v); crs.push(1); }
  }
  for (let c = 0; c < tail; c++) { rxd.push(0); crs.push(0); }
  return { rxd, crs };
}

export interface RxState { verdict: string; delivered: number[]; kept: number; discarded: number; last: { err: number; why: number } | null; send(opt: { text?: string; flip?: boolean; dst?: 'me' | 'other' | 'all'; cut?: boolean }): void }
const rxStates = new WeakMap<Stage, RxState>();
export const rxState = (st: Stage) => rxStates.get(st);

export function rxScene(): Scene {
  return {
    root: ethStation(), inputs: stationInputs(), hiddenInputs: HIDDEN, autoClock: false, engine: 'cycle',
    panels: [(stage: Stage): Widget => {
      const b = new Bench(stage);
      let text = 'hello from B', flip = false, dst: 'me' | 'other' | 'all' = 'me', cut = false, promisc = false;
      let q: { rxd: number[]; crs: number[] } = { rxd: [], crs: [] }, k = 0, delivered: number[] = [], lastV: { err: number; why: number } | null = null, sfdAt = -1, state = 0, clock = 0, kept = 0, gone = 0;
      const cap = new Capture(b, () => b.get('cp'));
      const line = h('div', { class: 'uart-svg' }), read = h('div', { class: 'mc-status' }), hexBox = h('div'), verdict = h('div', { class: 'clk-verdict' }), buf = h('div', { class: 'eth-buf' });
      const record = () => {
        clock++;
        if (b.get('rxv') === 1) { delivered.push(b.get('rxbyte')); if (b.get('rxl') === 1) lastV = { err: b.get('rxe'), why: b.get('why') }; }
        const st = b.get('rxstate');
        if (st === 2 && state !== 2 && sfdAt < 0) sfdAt = k;
        state = st;
        cap.poll(clock);
        kept = b.get('ngood'); gone = b.get('nbad');
      };
      const S: RxState = { verdict: '', delivered, kept: 0, discarded: 0, last: null, send: (o) => { if (o.text !== undefined) text = o.text; if (o.flip !== undefined) flip = o.flip; if (o.dst) dst = o.dst; if (o.cut !== undefined) cut = o.cut; start(); } };
      rxStates.set(stage, S);
      const loop = new Loop(stage, () => {
        b.set('rxd', k < q.rxd.length ? q.rxd[k] : 0); b.set('crs', k < q.crs.length ? q.crs[k] : 0);
        b.clock(); record(); k++;
        return k < q.rxd.length + 160;
      }, () => paint(), 60, 30);
      const start = () => {
        if (loop.running) return;
        stage.checkpoint();
        b.reset(); b.set('promisc', promisc ? 1 : 0);
        const payload = utf8(text).slice(0, MAX_PAYLOAD);
        const spec: FrameSpec = { dst: dst === 'all' ? BROADCAST : dst === 'me' ? ethStationMac(0) : ethStationMac(2), src: ethStationMac(1), type: ETHERTYPE_IPV4, payload };
        let bytes = wireBytes(spec);
        if (cut) bytes = bytes.slice(0, 8 + 40);
        const bitIdx = 8 * (8 + 14 + Math.min(payload.length, 10)) + 3;
        q = lineOf(bytes, 12, 40, flip ? bitIdx : -1);
        k = 0; delivered = []; lastV = null; sfdAt = -1; state = 0; clock = 0; cap.reset();
        S.delivered = delivered;
        loop.start();
      };
      const paint = () => {
        S.delivered = delivered; S.last = lastV; S.kept = kept; S.discarded = gone;
        const u = cap.frames.length;
        read.replaceChildren(h('span', null, 'receiver ', h('b', null, RX_STATES[b.get('rxstate')] ?? '?')), h('span', null, 'SFD seen at ', h('b', null, sfdAt >= 0 ? `clock ${sfdAt}` : '-')),
          h('span', null, 'bytes delivered ', h('b', null, String(delivered.length))), h('span', null, 'frames kept ', h('b', null, String(kept))), h('span', null, 'thrown away ', h('b', null, String(gone))), h('span', null, 'buffer ', h('b', null, `commit ${b.get('cp')}, write ${b.get('wp')}`)));
        const rcls = delivered.map((_, j) => (j < 6 ? 'dst' : j < 12 ? 'src' : j < 14 ? 'type' : 'data'));
        hexBox.replaceChildren(delivered.length ? hexDump(delivered, rcls) : h('p', { class: 'sub' }, 'Send a frame: its bytes appear here as the receiver hands them over, four bytes behind the wire.'), ...(delivered.length ? [legend(rcls), h('p', { class: 'sub' }, 'Payload and pad are one run here: the receiver cannot tell them apart.')] : []));
        const at = loop.running || sfdAt < 0 ? k : Math.min(q.rxd.length, sfdAt + 56), from = Math.max(0, at - 96);
        line.replaceChildren(strip([{ label: 'rxd', data: q.rxd.slice(from, at) }, { label: 'crs', data: q.crs.slice(from, at) }], 96, 'The receive wire: data and carrier, 24 bits, the last of the preamble and the SFD once the frame is in'));
        if (lastV) {
          const why = WHY_NAMES.filter((_, i) => (lastV!.why >> i) & 1);
          verdict.className = `clk-verdict ${lastV.err ? 'bad' : 'ok'}`;
          verdict.textContent = lastV.err ? `Verdict at last: err = 1 (${why.join(', ')}). The consumer's write pointer goes back to the commit pointer: the ${delivered.length} bytes it was handed are gone from the buffer.`
            : `Verdict at last: err = 0. ${delivered.length} bytes, FCS good, the commit pointer moves to the end: the frame is kept.`;
        } else { verdict.className = 'clk-verdict'; verdict.textContent = ''; }
        buf.replaceChildren(...(u ? [h('div', { class: 'sub' }, `Receive buffer holds ${u} frame${u > 1 ? 's' : ''}:`)] : []), ...cap.frames.map((f, i) => h('div', { class: 'eth-bufrow' }, `#${i + 1} `, h('b', null, `${f.bytes.length} B`), ` ${f.bytes.slice(0, 18).map(hex2).join(' ')} …`)));
      };
      stage.resetHooks.add(() => { q = { rxd: [], crs: [] }; k = 0; delivered = []; lastV = null; sfdAt = -1; clock = 0; cap.reset(); paint(); });
      const inp = h('input', { type: 'text', class: 'uart-text', value: text, maxlength: 60, 'aria-label': 'Message in the frame', spellcheck: 'false' }) as HTMLInputElement;
      inp.addEventListener('input', () => { text = inp.value; });
      const toSel = select('Destination of the frame', [['me', 'to this station'], ['other', 'to station 3'], ['all', 'to everyone']], dst, (v) => { dst = v as typeof dst; });
      const chk = (label: string, on: (v: boolean) => void) => { const c = h('input', { type: 'checkbox' }) as HTMLInputElement; c.addEventListener('change', () => on(c.checked)); return h('label', { class: 'comm-check' }, c, label); };
      paint();
      const el = h('div', { class: 'mem-panel cpu-panel mc-panel clk-panel eth-panel', 'data-dock': 'right', 'data-phone': 'flow' }, h('h4', null, 'The receiver', h('span', { class: 'fold-hint' })),
        h('div', { class: 'mc-row' }, inp, toSel, btn('Send into the receiver', 'Drive rxd and crs with the frame, a bit every 4 clocks', start, 'btn sm primary')),
        h('div', { class: 'mc-row' }, chk('flip one bit in the payload', (v) => { flip = v; }), chk('cut it short (runt)', (v) => { cut = v; }), chk('promiscuous', (v) => { promisc = v; })),
        read, line, hexBox, verdict, buf);
      return { el, update: paint, destroy: () => loop.stop() };
    }],
  };
}

// ---- step 4: carrier sense and deferral --------------------------------------------------------------------------------

export interface CsmaState { lastCarrierEnd: number; txStart: number; run(firstBits: number, secondAfter: number): void }
const csmaStates = new WeakMap<Stage, CsmaState>();
export const csmaState = (st: Stage) => csmaStates.get(st);

/** The carrier the scene drives, in clocks from the moment the frame is queued: a burst of `a` bit times, then (if `g` > 0) a second of 30 bit times `g` bit times after it. */
export function carrierPlan(a: number, g: number): [number, number][] {
  const out: [number, number][] = [];
  if (a > 0) out.push([0, a * BIT_CLOCKS]);
  if (a > 0 && g > 0) out.push([(a + g) * BIT_CLOCKS, (a + g + 30) * BIT_CLOCKS]);
  return out;
}

export function csmaScene(): Scene {
  return {
    root: ethStation(), inputs: stationInputs(), hiddenInputs: HIDDEN, autoClock: false, engine: 'cycle',
    panels: [(stage: Stage): Widget => {
      const b = new Bench(stage);
      let first = 100, second = 0;
      let crsW: number[] = [], txW: number[] = [], gapW: number[] = [], clock = 0, txStart = -1, plan: [number, number][] = [];
      const box = h('div', { class: 'uart-svg' }), read = h('div', { class: 'mc-status' }), verdict = h('div', { class: 'clk-verdict' });
      const S: CsmaState = { lastCarrierEnd: -1, txStart: -1, run: (a, g) => { first = a; second = g; start(); } };
      csmaStates.set(stage, S);
      const lastEnd = () => (plan.length ? plan[plan.length - 1][1] : -1);
      const loop = new Loop(stage, () => {
        const on = plan.some(([f, t]) => clock >= f && clock < t) ? 1 : 0;
        b.set('crs', on);
        b.clock();
        crsW.push(on); txW.push(b.get('txen')); gapW.push(b.get('gap'));
        if (txStart < 0 && txW[txW.length - 1] === 1) txStart = clock;
        clock++;
        return clock < lastEnd() + 1100 && !(txStart >= 0 && b.get('sent') === 1);
      }, () => paint(), 60, 30);
      const start = () => {
        if (loop.running) return;
        stage.checkpoint();
        b.reset();
        // the cable has been quiet for a long time before the frame is queued: the gap counter is full
        for (let i = 0; i < GAP_BITS * BIT_CLOCKS + 8; i++) b.clock();
        const spec: FrameSpec = { dst: ethStationMac(1), src: ethStationMac(0), type: ETHERTYPE_IPV4, payload: utf8('deferred') };
        plan = carrierPlan(first, second);
        crsW = []; txW = []; gapW = []; clock = 0; txStart = -1;
        b.send(frameBody(spec));
        stage.refresh();
        loop.start();
      };
      const paint = () => {
        S.txStart = txStart; S.lastCarrierEnd = lastEnd();
        const total = Math.max(crsW.length, 400);
        const end = lastEnd();
        box.replaceChildren(strip([{ label: 'carrier', data: crsW }, { label: 'txen', data: txW }, { label: 'gap full', data: gapW.map((g) => (g >= GAP_BITS * BIT_CLOCKS ? 1 : 0)), cls: 'gap' }], total, 'Carrier from another station, this station\'s carrier enable, and whether its gap counter has reached 96 bit times',
          [...(end >= 0 && crsW.length > end ? [{ x: end, text: 'carrier off', cls: '' }] : []), ...(txStart >= 0 ? [{ x: txStart, text: 'txen', cls: 'ok' }] : [])]));
        const gap = gapW.length ? gapW[gapW.length - 1] : 0;
        read.replaceChildren(h('span', null, 'state ', h('b', null, txStateName(b.get('txstate')))), h('span', null, 'gap counter ', h('b', null, `${gap} / ${GAP_BITS * BIT_CLOCKS}`), ' clocks'), h('span', null, 'clock ', h('b', null, String(clock))));
        if (txStart >= 0) {
          const dly = txStart - Math.max(0, end);
          verdict.className = `clk-verdict ${end < 0 || dly >= GAP_BITS * BIT_CLOCKS ? 'ok' : ''}`;
          verdict.textContent = end > 0
            ? `The last carrier ended at clock ${end}; this station started at clock ${txStart}, ${dly} clocks (${(dly / BIT_CLOCKS).toFixed(0)} bit times) later: the gap of ${GAP_BITS} bit times, counted from the end of the last carrier${second > 0 ? ', and restarted by the second burst' : ''}.`
            : `The wire was quiet and the gap counter already full: the station started at clock ${txStart}, a couple of clocks after the frame was queued.`;
        } else { verdict.className = 'clk-verdict'; verdict.textContent = ''; }
      };
      stage.resetHooks.add(() => { crsW = []; txW = []; gapW = []; clock = 0; txStart = -1; plan = []; paint(); });
      const sl1 = slider('Carrier lasts', 0, 300, 10, first, (v) => `${v} bit times`, (v) => { first = v; });
      const sl2 = slider('Second burst', 0, 90, 10, second, (v) => (v ? `${v} bit times after` : 'none'), (v) => { second = v; });
      paint();
      const el = h('div', { class: 'mem-panel cpu-panel mc-panel clk-panel eth-panel', 'data-dock': 'right', 'data-phone': 'flow' }, h('h4', null, 'Listen before talking', h('span', { class: 'fold-hint' })),
        h('div', { class: 'mc-row' }, sl1.el, sl2.el, btn('Queue a frame', 'Queue one frame with another station talking as set, then run', start, 'btn sm primary')),
        read, box, verdict,
        h('p', { class: 'sub' }, 'Another station\'s carrier (crs) is driven from the moment the frame is queued. The station defers until the cable has been silent for 96 bit times; a second burst that comes inside the gap restarts the count.'));
      return { el, update: paint, destroy: () => loop.stop() };
    }],
  };
}
