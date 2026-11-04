// Chapter 49's scenes: the four-port switch at gate level with a rig of four hosts around it. The rig is a bench: it plays
// frames into the receive streams, reads the transmit streams and runs the golden model (comm/ethswitch.ts) beside the gates,
// comparing every output at every edge. It hangs on the stage's edge hooks, so Pulse, Step and Run clock it as well as its own button.

import '../styles/clocks.css';
import '../styles/ethswitch.css';
import { BROADCAST, frameBody, macText, parseFrame, type Mac } from '../comm/ethframe';
import { addrOf, hostMac, idleIn, PORTS, rng, SwitchModel, type Pattern, type SwitchIn, type SwitchOpts } from '../comm/ethswitch';
import { CYCLE_NS } from '../comm/serdes';
import { pcapFile, type Captured } from '../comm/pcap';
import { ethSwitch } from '../lib/ethswitch';
import { pack } from '../sim/values';
import { h } from '../ui/dom';
import { saveFile } from '../view/image';
import type { Scene, Stage, Widget } from '../view/stage';
import { slider } from './mosparts';

const outp = (st: Stage, name: string): number => pack(st.sim!.getBits(st.sim!.design.root.ports[name]));
const PORT_COLOURS = ['var(--probe-0, #4c8)', 'var(--probe-1, #48c)', 'var(--probe-2, #c84)', 'var(--probe-3, #a5c)'];

interface Job { bytes: number[]; err: boolean; startAt: number; k: number; what: string }
export interface Seen { port: number; src: Mac; dst: Mac; bytes: number; at: number; kind: 'flood' | 'unicast'; id: number }

export interface Gen { on: boolean; pattern: Pattern; load: number; bytes: number }

/** The bench around one switch: queued frames in, frames out, the model beside the gates. */
export class Rig {
  model: SwitchModel;
  cycle = 0;
  jobs: Job[][] = Array.from({ length: PORTS }, () => []);
  checked = 0; mismatches = 0; firstBad = '';
  seen: Seen[] = [];
  rxCaps: Captured[][] = Array.from({ length: PORTS }, () => []);
  txCaps: Captured[][] = Array.from({ length: PORTS }, () => []);
  /** Per output, the input driving it in each of the last cycles (-1: idle). */
  timeline: number[][] = Array.from({ length: PORTS }, () => []);
  gen: Gen = { on: false, pattern: 'uniform', load: 0.5, bytes: 64 };
  private R = rng(7);
  private gap = Array(PORTS).fill(0);
  private txCur: number[][] = Array.from({ length: PORTS }, () => []);
  private txAt = Array(PORTS).fill(0);
  private rxCur: number[][] = Array.from({ length: PORTS }, () => []);
  private rxAt = Array(PORTS).fill(0);
  private applied: SwitchIn = idleIn();
  private nextId = 1;
  taught = false;
  sent = 0;
  /** Frames received on each port that found no free cell: left out of the capture. */
  rxDropped = Array(PORTS).fill(0);
  private dropAtStart = Array(PORTS).fill(0);
  constructor(readonly opts: Partial<SwitchOpts>) { this.model = new SwitchModel(opts); }

  reset(): void {
    this.model = new SwitchModel(this.opts);
    this.cycle = 0; this.checked = 0; this.mismatches = 0; this.firstBad = '';
    this.jobs.forEach((j) => { j.length = 0; });
    this.seen = []; this.rxCaps.forEach((c) => { c.length = 0; }); this.txCaps.forEach((c) => { c.length = 0; });
    this.timeline = Array.from({ length: PORTS }, () => []);
    this.txCur = Array.from({ length: PORTS }, () => []); this.rxCur = Array.from({ length: PORTS }, () => []);
    this.gap = Array(PORTS).fill(0); this.taught = false; this.sent = 0; this.gen.on = false; this.R = rng(7); this.rxDropped = Array(PORTS).fill(0); this.dropAtStart = Array(PORTS).fill(0);
  }

  save(): unknown {
    return structuredClone({ model: this.model.save(), cycle: this.cycle, jobs: this.jobs, checked: this.checked, mismatches: this.mismatches, firstBad: this.firstBad, seen: this.seen,
      rxCaps: this.rxCaps.map((c) => c.map((f) => ({ us: f.us, bytes: Array.from(f.bytes) }))), txCaps: this.txCaps.map((c) => c.map((f) => ({ us: f.us, bytes: Array.from(f.bytes) }))), timeline: this.timeline,
      txCur: this.txCur, txAt: this.txAt, rxCur: this.rxCur, rxAt: this.rxAt, gap: this.gap, taught: this.taught, sent: this.sent, nextId: this.nextId, gen: this.gen, rxDropped: this.rxDropped, dropAtStart: this.dropAtStart });
  }
  restore(saved: unknown): void {
    const s = structuredClone(saved) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    this.model.restore(s.model);
    this.cycle = s.cycle; this.jobs = s.jobs; this.checked = s.checked; this.mismatches = s.mismatches; this.firstBad = s.firstBad; this.seen = s.seen;
    this.rxCaps = s.rxCaps; this.txCaps = s.txCaps; this.timeline = s.timeline; this.txCur = s.txCur; this.txAt = s.txAt; this.rxCur = s.rxCur; this.rxAt = s.rxAt;
    this.gap = s.gap; this.taught = s.taught; this.sent = s.sent; this.nextId = s.nextId; this.gen = s.gen; this.rxDropped = s.rxDropped; this.dropAtStart = s.dropAtStart;
  }

  send(port: number, dst: Mac, bytes = 64, o: { err?: boolean; delay?: number; what?: string } = {}): void {
    const id = this.nextId++;
    const src = hostMac(port), payload = Array.from({ length: Math.max(4, bytes - 14) }, (_, k) => (k < 4 ? (id >> (8 * (3 - k))) & 255 : (id + k) & 255));
    const b = frameBody({ dst, src, type: 0x0800, payload });
    this.jobs[port].push({ bytes: b, err: !!o.err, startAt: this.cycle + (o.delay ?? 0), k: 0, what: o.what ?? '' });
    this.sent++;
  }
  /** Each host says something to the broadcast address, one after another. */
  teach(): void {
    for (let p = 0; p < PORTS; p++) {
      const id = this.nextId++;
      const b = frameBody({ dst: BROADCAST, src: hostMac(p), type: 0x0806, payload: [0, 0, 0, id & 255] });
      this.jobs[p].push({ bytes: b, err: false, startAt: this.cycle + 80 * p, k: 0, what: 'hello' });
      this.sent++;
    }
    this.taught = true;
  }
  pending(): boolean { return this.jobs.some((j) => j.length > 0) || !this.model.quiet(); }

  private pickDst(i: number): number {
    if (this.gen.pattern === 'permutation') return (i + 1) % PORTS;
    const others = [0, 1, 2, 3].filter((x) => x !== i);
    if (this.gen.pattern === 'hotspot' && i !== 0 && this.R() < 0.5) return 0;
    return others[Math.floor(this.R() * others.length)];
  }

  /** Edge hook, before the clock rises: drive the receive streams, compare every output, collect the frames. */
  before(st: Stage): void {
    const sim = st.sim!;
    if (this.gen.on) {
      if (!this.taught) this.teach();
      else for (let p = 0; p < PORTS; p++) {
        if (this.jobs[p].length === 0 && this.model.queueLengths(p).every((q) => q < 3)) {
          if (this.gap[p] > 0) this.gap[p]--;
          else {
            this.send(p, hostMac(this.pickDst(p)), this.gen.bytes, { what: 'traffic' });
            const mean = this.gen.load >= 1 ? 0 : this.gen.bytes * (1 - this.gen.load) / this.gen.load;
            this.gap[p] = mean > 0 ? Math.floor(-Math.log(1 - this.R()) * mean) : 0;
          }
        }
      }
    }
    const inp = idleIn();
    for (let p = 0; p < PORTS; p++) {
      const j = this.jobs[p][0];
      if (j && this.cycle >= j.startAt) {
        const last = j.k === j.bytes.length - 1;
        inp.rx[p] = { valid: 1, data: j.bytes[j.k], last: last ? 1 : 0, err: last && j.err ? 1 : 0 };
        if (j.k === 0) { this.rxCur[p] = []; this.rxAt[p] = this.cycle; this.dropAtStart[p] = this.model.out().drops[p]; }
        this.rxCur[p].push(j.bytes[j.k]);
        j.k++;
        if (last) {
          // the drop counter moves one edge after the first byte: a frame that found no cell is not in the capture
          if (this.model.out().drops[p] > this.dropAtStart[p]) this.rxDropped[p]++;
          else this.rxCaps[p].push({ us: this.rxAt[p] * CYCLE_NS / 1000, bytes: this.rxCur[p] });
          this.jobs[p].shift();
        }
      }
      sim.setInput(`rxData${p}`, inp.rx[p].data); sim.setInput(`rxValid${p}`, inp.rx[p].valid); sim.setInput(`rxLast${p}`, inp.rx[p].last); sim.setInput(`rxErr${p}`, inp.rx[p].err);
      sim.setInput(`txReady${p}`, 1);
    }
    sim.settle();
    this.applied = inp;
    const w = this.model.out();
    for (let p = 0; p < PORTS; p++) {
      const got = [outp(st, `txValid${p}`), outp(st, `txData${p}`), outp(st, `txLast${p}`)], want = [w.tx[p].valid, w.tx[p].data, w.tx[p].last];
      if (got.some((v, i) => v !== want[i]) && !this.firstBad) { this.firstBad = `cycle ${this.cycle}, port ${p}: gates ${got.join(',')}, model ${want.join(',')}`; this.mismatches++; } else if (got.some((v, i) => v !== want[i])) this.mismatches++;
      // the frames out are what the gates drive (equal to the model unless the mismatch counter says otherwise)
      if (got[0]) {
        if (this.txCur[p].length === 0) this.txAt[p] = this.cycle;
        this.txCur[p].push(got[1]);
        if (got[2]) this.finishTx(p);
      }
      const tl = this.timeline[p];
      tl.push(this.model.srcOf(p));
      if (tl.length > 360) tl.shift();
    }
    this.checked++;
  }

  private finishTx(p: number): void {
    const bytes = this.txCur[p]; this.txCur[p] = [];
    this.txCaps[p].push({ us: this.txAt[p] * CYCLE_NS / 1000, bytes });
    const f = parseFrame([...bytes, 0, 0, 0, 0]);
    const id = (bytes[14] << 24 | bytes[15] << 16 | bytes[16] << 8 | bytes[17]) >>> 0;
    // a flood is a group address, an address the table did not hold, or a frame that left on more than one port
    let kind: Seen['kind'] = (f.dst[0] & 1) || !this.model.table.peek(addrOf(f.dst), addrOf(f.src), 0).hit ? 'flood' : 'unicast';
    if (this.seen.some((s) => s.id === id && s.port !== p)) { kind = 'flood'; for (const s of this.seen) if (s.id === id) s.kind = 'flood'; }
    this.seen.push({ port: p, src: f.src, dst: f.dst, bytes: bytes.length, at: this.cycle, kind, id });
    if (this.seen.length > 40) this.seen.shift();
  }

  /** Edge hook, after the edge: the model takes the same step. */
  after(): void { this.model.step(this.applied); this.cycle++; }

  capture(port: number): Uint8Array {
    const all = [...this.rxCaps[port], ...this.txCaps[port]].sort((a, b) => a.us - b.us);
    return pcapFile(all);
  }
}

const CHECK_CYCLES = 8;
/** The sources button label follows the rig state, so Reset and Back cannot leave it inverted. */
export const genLabel = (on: boolean): string => (on ? 'Stop sources' : 'Start sources');

/** Wire a rig to a stage: hooks, Back, Reset. Returns a loop that runs the clock until a condition holds. */
export function attachRig(stage: Stage, rig: Rig, paint: () => void) {
  let t: ReturnType<typeof setInterval> | null = null, quietFor = 0;
  stage.edgeHooks.add({ before: () => rig.before(stage), after: () => rig.after() });
  // Reset and Back end a run: the loop would otherwise keep clocking a switch that is no longer where it was
  stage.resetHooks.add(() => { loop.stop(); rig.reset(); paint(); });
  stage.historyHooks.add({ save: () => rig.save(), restore: (v) => { loop.stop(); rig.restore(v); paint(); } });
  const loop = {
    get running() { return t !== null; },
    /** Clock until `until` has held for a few cycles; `force` replaces a run already going (a new stop condition). */
    start(until: () => boolean = () => !rig.pending(), force = false) {
      if (t) { if (!force) return; clearInterval(t); t = null; } else stage.checkpoint();
      quietFor = 0;
      t = setInterval(() => {
        const t0 = performance.now();
        let done = false;
        stage.runCycles(40, undefined, 0, true);
        while (performance.now() - t0 < 14 && !done) {
          stage.runCycles(40, undefined, 0, true);
          if (until()) { quietFor += 40; if (quietFor >= CHECK_CYCLES) done = true; } else quietFor = 0;
        }
        stage.refresh(); paint();
        if (done) loop.stop();
      }, 30);
    },
    stop() { if (t) clearInterval(t); t = null; paint(); },
  };
  return loop;
}

const mac = (m: Mac) => macText(m).slice(9);
const HOSTS = [0, 1, 2, 3].map((p) => ({ name: String.fromCharCode(65 + p), mac: hostMac(p) }));
const hostName = (m: Mac): string => {
  if ((m[0] & 1) === 1) return 'all';
  const k = HOSTS.findIndex((x) => addrOf(x.mac) === addrOf(m));
  return k >= 0 ? HOSTS[k].name : mac(m);
};

const btn = (label: string, title: string, f: () => void, cls = 'btn sm') => { const b = h('button', { class: cls, title }, label); b.addEventListener('click', f); return b; };
const select = (label: string, opts: [string, string][], value: string, on: (v: string) => void) => {
  const sel = h('select', { class: 'mc-sel', 'aria-label': label }) as HTMLSelectElement;
  for (const [v, t] of opts) sel.append(h('option', { value: v }, t));
  sel.value = value;
  sel.addEventListener('change', () => on(sel.value));
  return sel;
};

function inputsFor(): Record<string, number> {
  const o: Record<string, number> = { clk: 0 };
  for (let p = 0; p < PORTS; p++) Object.assign(o, { [`rxData${p}`]: 0, [`rxValid${p}`]: 0, [`rxLast${p}`]: 0, [`rxErr${p}`]: 0, [`txReady${p}`]: 1 });
  return o;
}
const HIDDEN = (() => { const a: string[] = []; for (let p = 0; p < PORTS; p++) a.push(`rxData${p}`, `rxValid${p}`, `rxLast${p}`, `rxErr${p}`, `txReady${p}`); return a; })();

const HIDDEN_OUT = (() => { const a: string[] = ['learned', 'evicted', 'flooded', 'filtered']; for (let p = 0; p < PORTS; p++) a.push(`rxReady${p}`, `drops${p}`, `bad${p}`, `frames${p}`); return a; })();

/** The table as the model holds it: live entries with their port and age. */
function tableView(rig: Rig): HTMLElement {
  const T = rig.model.table, rows = T.entries.map((e, i) => ({ e, i })).filter((x) => T.live(x.e));
  const box = h('div', { class: 'sw-table', role: 'table', 'aria-label': 'Address table' });
  box.append(h('div', { class: 'sw-trow head', role: 'row' }, ...['slot', 'address', 'port', 'age'].map((t) => h('span', { role: 'columnheader' }, t))));
  if (!rows.length) box.append(h('div', { class: 'sw-trow empty', role: 'row' }, 'empty: every unicast is flooded'));
  for (const { e, i } of rows) {
    const age = (T.tick - e.stamp) & 255;
    box.append(h('div', { class: 'sw-trow', role: 'row' }, h('span', { role: 'cell' }, String(i)), h('span', { role: 'cell', class: 'mono' }, `${hostName(Array.from({ length: 6 }, (_, k) => Math.floor(e.key / 2 ** (8 * (5 - k))) % 256))} ${mac(Array.from({ length: 6 }, (_, k) => Math.floor(e.key / 2 ** (8 * (5 - k))) % 256))}`), h('span', { role: 'cell' }, String(e.port)), h('span', { role: 'cell' }, `${age} / 64`)));
  }
  return box;
}

function counters(st: Stage, rig: Rig): HTMLElement {
  const g = (n: string) => outp(st, n);
  const row = (label: string, vals: (number | string)[]) => h('div', { class: 'sw-crow', role: 'row' }, h('b', { role: 'rowheader' }, label), ...vals.map((v) => h('span', { role: 'cell' }, String(v))));
  return h('div', { class: 'sw-counters', role: 'table', 'aria-label': 'Counters' },
    h('div', { class: 'sw-crow head', role: 'row' }, h('b', { role: 'columnheader' }, ''), ...[0, 1, 2, 3].map((p) => h('span', { role: 'columnheader' }, `port ${p}`))),
    row('frames out', [0, 1, 2, 3].map((p) => g(`frames${p}`))), row('dropped (no cell)', [0, 1, 2, 3].map((p) => g(`drops${p}`))), row('bad FCS', [0, 1, 2, 3].map((p) => g(`bad${p}`))),
    h('div', { class: 'sw-crow head', role: 'row' }, h('b', { role: 'columnheader' }, 'table'), ...['learned', 'flooded', 'filtered', 'evicted'].map((t) => h('span', { role: 'columnheader' }, t))),
    row('count', [g('learned'), g('flooded'), g('filtered'), g('evicted')]),
    h('div', { class: `sw-lock${rig.mismatches ? ' bad' : ''}` }, rig.mismatches ? `Gates and model differ: ${rig.firstBad}` : `Gates equal the golden model: ${rig.checked} cycles checked, no difference`));
}

function frameLog(rig: Rig): HTMLElement {
  const box = h('div', { class: 'sw-log', 'aria-label': 'Frames out of the switch', role: 'log' });
  if (!rig.seen.length) box.append(h('div', { class: 'sw-line empty' }, 'No frame has left the switch yet.'));
  for (const s of rig.seen.slice(-8).reverse()) box.append(h('div', { class: `sw-line ${s.kind}` }, h('b', null, `out ${s.port}`), `  ${hostName(s.src)} → ${hostName(s.dst)}  ${s.bytes} B  `, h('i', null, s.kind === 'flood' ? 'flood' : 'unicast')));
  return box;
}

function timelineView(rig: Rig): SVGSVGElement | HTMLElement {
  const W = 360, rowH = 18, svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W + 44} ${rowH * 4 + 6}`); svg.setAttribute('class', 'sw-timeline'); svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Which input drives each output over the last 360 cycles');
  for (let j = 0; j < PORTS; j++) {
    const t = document.createElementNS(svgNS, 'text'); t.setAttribute('x', '0'); t.setAttribute('y', String(j * rowH + 13)); t.setAttribute('class', 'lbl'); t.textContent = `out ${j}`; svg.append(t);
    const tl = rig.timeline[j];
    let k = 0;
    while (k < tl.length) {
      let e = k; while (e + 1 < tl.length && tl[e + 1] === tl[k]) e++;
      if (tl[k] >= 0) { const r = document.createElementNS(svgNS, 'rect'); r.setAttribute('x', String(40 + ((k + 360 - tl.length) / 360) * W)); r.setAttribute('y', String(j * rowH + 3)); r.setAttribute('width', String(Math.max(1, ((e - k + 1) / 360) * W))); r.setAttribute('height', String(rowH - 6)); r.setAttribute('style', `fill:${PORT_COLOURS[tl[k]]}`); r.setAttribute('class', 'bar'); svg.append(r); }
      k = e + 1;
    }
  }
  return svg;
}

interface PanelOpts { title: string; compose?: boolean; table?: boolean; counters?: boolean; timeline?: boolean; sources?: boolean; capture?: boolean; contend?: boolean; log?: boolean }

function benchPanel(o: PanelOpts, opts: Partial<SwitchOpts>) {
  return (stage: Stage): Widget => {
    const rig = new Rig(opts);
    let from = 0, to = 'host1', len = 64, bad = false;
    let onb: HTMLButtonElement | null = null;
    const body = h('div', { class: 'sw-body' }), controls = h('div', { class: 'sw-controls' });
    const paint = () => {
      body.replaceChildren(
        ...(o.timeline ? [h('div', { class: 'cpu-sec' }, 'Which input drives each output (last 360 cycles)'), timelineView(rig)] : []),
        ...(o.table ? [h('div', { class: 'cpu-sec' }, 'The address table, as the gates hold it'), tableView(rig)] : []),
        ...(o.log ? [h('div', { class: 'cpu-sec' }, 'Frames leaving the switch'), frameLog(rig)] : []),
        ...(o.counters ? [counters(stage, rig)] : []),
      );
      run.textContent = loop.running ? 'Pause' : 'Run';
      if (onb) onb.textContent = genLabel(rig.gen.on);
    };
    const loop = attachRig(stage, rig, paint);
    const run = btn('Run', 'Clock the switch until every frame has left', () => { if (loop.running) loop.stop(); else loop.start(); }, 'btn sm primary');
    const dstOf = (v: string): Mac => (v === 'all' ? BROADCAST : v === 'unknown' ? [0x02, 0, 0, 0, 0x99, 0x01] : hostMac(Number(v.slice(4))));
    if (o.compose) {
      const fromSel = select('Sending host', HOSTS.map((x, i) => [String(i), `host ${x.name} (port ${i})`]), '0', (v) => { from = Number(v); });
      const toSel = select('Destination', [...HOSTS.map((x, i) => [`host${i}`, `host ${x.name}`] as [string, string]), ['all', 'everyone (ff:ff:…)'], ['unknown', 'an address nobody has used']], to, (v) => { to = v; });
      const lenSl = slider('Length', 60, 120, 2, len, (v) => `${v} B`, (v) => { len = v; });
      const badBox = h('input', { type: 'checkbox', 'aria-label': 'Mark the FCS as bad' }) as HTMLInputElement;
      badBox.addEventListener('change', () => { bad = badBox.checked; });
      controls.append(h('div', { class: 'mc-row' }, h('label', { class: 'sw-lbl' }, 'from', fromSel), h('label', { class: 'sw-lbl' }, 'to', toSel)), lenSl.el,
        h('div', { class: 'mc-row' }, btn('Send', 'Queue the frame on the host\'s port', () => { rig.send(from, dstOf(to), len, { err: bad }); if (!loop.running) loop.start(); paint(); }), btn('Teach the table', 'Every host sends one frame to everyone', () => { rig.teach(); if (!loop.running) loop.start(); }), run,
          h('label', { class: 'sw-chk' }, badBox, ' bad FCS')));
    } else controls.append(h('div', { class: 'mc-row' }, run));
    if (o.contend) {
      controls.append(h('div', { class: 'mc-row' },
        btn('Three hosts to D at once', 'Teach the table if needed, then hosts A, B and C each send D a frame in the same cycle', () => {
          const d = rig.taught ? 0 : 340;
          if (!rig.taught) rig.teach();
          for (let p = 0; p < 3; p++) rig.send(p, hostMac(3), 64, { delay: d + 10 });
          if (!loop.running) loop.start(); paint();
        }), btn('Three to different hosts', 'A to B, B to C, C to A: no two want the same output', () => {
          const d = rig.taught ? 0 : 340;
          if (!rig.taught) rig.teach();
          for (let p = 0; p < 3; p++) rig.send(p, hostMac((p + 1) % 3), 64, { delay: d + 10 });
          if (!loop.running) loop.start(); paint();
        })));
    }
    if (o.sources) {
      const pat = select('Traffic pattern', [['uniform', 'uniform: any other host'], ['permutation', 'permutation: A→B, B→C, C→D, D→A'], ['hotspot', 'hot spot: half to host A']], 'uniform', (v) => { rig.gen.pattern = v as Pattern; });
      const ld = slider('Offered load', 10, 100, 5, 50, (v) => `${v} %`, (v) => { rig.gen.load = v / 100; });
      const ln = slider('Frame', 60, 120, 4, 64, (v) => `${v} B`, (v) => { rig.gen.bytes = v; });
      onb = btn(genLabel(false), 'Four hosts send frames at the offered load until stopped', () => {
        rig.gen.on = !rig.gen.on;
        // started: clock until Pause; stopped: clock on until the queues have drained, then stop by itself
        if (rig.gen.on) loop.start(() => false, true); else loop.start(() => !rig.pending(), true);
        paint();
      }, 'btn sm primary');
      controls.append(h('div', { class: 'mc-row' }, pat), ld.el, ln.el, h('div', { class: 'mc-row' }, onb, run));
    }
    if (o.capture) {
      controls.append(h('div', { class: 'mc-row sw-cap', role: 'group', 'aria-label': 'Save capture' }, h('span', { class: 'cpu-sec' }, 'Save capture'),
        ...[0, 1, 2, 3].map((p) => btn(`port ${p}`, `A .pcap of the frames that came in on port ${p} (those that found a cell) and went out of it, as the gates drove them: open it in Wireshark or tcpdump`, () => {
          const f = rig.capture(p);
          saveFile(`switch-port${p}.pcap`, new Blob([f.slice().buffer as ArrayBuffer], { type: 'application/vnd.tcpdump.pcap' }));
        }))));
    }
    const el = h('div', { class: 'mem-panel cpu-panel mc-panel clk-panel sw-panel', 'data-dock': 'right', 'data-fold': 'narrow', 'data-phone': 'flow' }, h('h4', null, o.title, h('span', { class: 'fold-hint' })),
      h('div', { class: 'sw-hosts', 'aria-label': 'The four hosts' }, ...HOSTS.map((x, i) => h('span', { class: 'sw-host', style: `--c:${PORT_COLOURS[i]}` }, h('b', null, `host ${x.name}`), ` port ${i}  `, h('span', { class: 'mono' }, mac(x.mac))))),
      controls, body);
    paint();
    swRigs.set(stage, rig);
    return { el, update: paint, destroy: () => loop.stop() };
  };
}

const swRigs = new WeakMap<Stage, Rig>();
/** The rig of a stage showing one of this chapter's scenes (tests and tries). */
export const rigOf = (st: Stage): Rig | undefined => swRigs.get(st);

const SCENE_SWITCH: Partial<SwitchOpts> = { cellK: 7, tableK: 4, tickLog2: 5 };

function sceneOf(opts: Partial<SwitchOpts>, p: PanelOpts, extra: Partial<Scene> = {}): Scene {
  return { root: ethSwitch(opts), inputs: inputsFor(), hiddenInputs: HIDDEN, hiddenOutputs: HIDDEN_OUT, autoClock: false, engine: 'cycle', panels: [benchPanel(p, opts)], ...extra };
}

/** Step 2: learning. Send frames from any host to any host and watch the table and the floods. */
export const learnScene = (): Scene => sceneOf(SCENE_SWITCH, { title: 'Four hosts on a switch', compose: true, table: true, log: true, counters: true });
/** Step 4: the crossbar. Several inputs for one output; the timeline shows the arbiter's turns. */
export const crossbarScene = (): Scene => sceneOf(SCENE_SWITCH, { title: 'Who drives which output', contend: true, timeline: true, log: true, counters: true });
/** Step 7: the bench. Four sources, live counters, a capture per port. */
export const BENCH_OPTS: Partial<SwitchOpts> = { cellK: 7, cells: 8, voq: true, tableK: 5, tickLog2: 6 };
export const benchScene = (): Scene => sceneOf(BENCH_OPTS, { title: 'Four hosts, a switch, a capture', sources: true, timeline: true, counters: true, capture: true });
