// The PCIe half of chapter `pcie`: the explorers (a parallel bus against a lane, a TLP byte by byte, the numbers) and the gate-level link's panel. The panel
// runs comm/pcie.ts's PcieLink beside the gates, reads what arrives on each lane as a bus analyser would (LaneLog: framing, CRCs), and says whether the two agree.

import { crc32, fcsBytes } from '../comm/crc';
import { BUF_BITS, dataCredits, dlWrap, dllpCrc, dllpName, DL_NAMES, K_COM, K_EDB, K_END, K_SDP, K_STP, LINK_IN0, LT_NAMES, MAX_DW, parseTlp, PcieLink, tlpBytes, type LinkIn, type TlpKind } from '../comm/pcie';
import { creditGate, pcieEpTl, pcieLink, pcieRootTl, pciePort, PORT_STATUS, readStatus } from '../lib/pcie';
import { bigRamWithInit } from '../lib/bigmem';
import { stats } from '../sim/stats';
import { h } from '../ui/dom';
import { bench } from '../chapters/types';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { slider } from './mosparts';
import { frameRun } from './slowctl';
import '../styles/serial.css';
import '../styles/pcie.css';

const btn = (label: string, title: string, f: () => void, cls = 'btn sm') => { const b = h('button', { class: cls, title, type: 'button' }, label); b.addEventListener('click', f); return b; };
const hex2 = (v: number) => v.toString(16).padStart(2, '0');
const hex3 = (v: number) => v.toString(16).padStart(3, '0');
const nf = (x: number, d = 1) => x.toFixed(d);

// ---- a parallel bus against a lane -------------------------------------------------------------------------------------
export interface LaneGen { name: string; gts: number; coding: string; eff: number; year: number }
/** Per lane, one direction. Flit mode (6.0) spends 14 of 256 bytes on CRC and FEC. */
export const PCIE_GENS: LaneGen[] = [
  { name: '1.0', gts: 2.5, coding: '8b/10b', eff: 0.8, year: 2003 }, { name: '2.0', gts: 5, coding: '8b/10b', eff: 0.8, year: 2007 },
  { name: '3.0', gts: 8, coding: '128b/130b', eff: 128 / 130, year: 2010 }, { name: '4.0', gts: 16, coding: '128b/130b', eff: 128 / 130, year: 2017 },
  { name: '5.0', gts: 32, coding: '128b/130b', eff: 128 / 130, year: 2019 }, { name: '6.0', gts: 64, coding: 'PAM4, flits', eff: 242 / 256, year: 2022 },
];
export const laneGBs = (g: LaneGen, lanes = 1): number => (g.gts * g.eff * lanes) / 8;
/** A common clock: the data must settle and be sampled within a period less the skew; half a period of margin is what a parallel design can spend. */
export const parallelMHz = (skewPs: number): number => 1e6 / (2 * skewPs);
export const parallelGBs = (skewPs: number, width: number): number => (parallelMHz(skewPs) * 1e6 * width) / 8 / 1e9;

export function busWidget(): Widget {
  const out = h('div', { class: 'pc-out' });
  let skew = 1000, width = 64;
  const draw = () => {
    const mhz = parallelMHz(skew), gb = parallelGBs(skew, width);
    const row = (g: LaneGen, n: number) => h('tr', { class: laneGBs(g, n) > gb ? 'win' : '' }, h('td', null, `PCIe ${g.name} ×${n}`), h('td', { class: 'num' }, `${g.gts} GT/s`), h('td', null, g.coding), h('td', { class: 'num' }, `${n * 4}`), h('td', { class: 'num' }, `${nf(laneGBs(g, n), 2)} GB/s`));
    out.replaceChildren(
      h('div', { class: 'mc-status' }, h('span', null, 'Fastest clock with half a period left ', h('b', null, `${nf(mhz, 0)} MHz`)), h('span', null, 'Bus, one way at a time ', h('b', null, `${nf(gb, 2)} GB/s`)), h('span', null, 'Signal pins ', h('b', null, `${width}+`))),
      h('div', { class: 'pc-scroll' }, h('table', { class: 'pc-table' }, h('thead', null, h('tr', null, h('th', null, 'Link'), h('th', null, 'Lane rate'), h('th', null, 'Line code'), h('th', null, 'Signal pins'), h('th', null, 'Each way'))),
        h('tbody', null, row(PCIE_GENS[0], 1), row(PCIE_GENS[0], 16), row(PCIE_GENS[2], 4), row(PCIE_GENS[3], 4), row(PCIE_GENS[4], 16), row(PCIE_GENS[5], 16)))),
    );
  };
  const a = slider('Skew across the bus', 100, 3000, 50, skew, (v) => `${v} ps`, (v) => { skew = v; draw(); });
  const b = slider('Bus width', 8, 128, 8, width, (v) => `${v} bits`, (v) => { width = v; draw(); });
  draw();
  return { el: h('div', { class: 'pc-w' }, h('div', { class: 'mc-row' }, a.el), h('div', { class: 'mc-row' }, b.el), out) };
}

// ---- a TLP, byte by byte -------------------------------------------------------------------------------------------------
interface Field { name: string; from: number; to: number; cls: string; say: string }
function fieldsOf(kind: TlpKind, wire: number[]): Field[] {
  const n = wire.length, end = n - 4, tlpAt = 2, cpl = kind === 'CplD';
  const f = parseTlp(wire.slice(2, end));
  const rows: Field[] = [
    { name: 'Sequence', from: 0, to: 2, cls: 'f0', say: `4 reserved bits, then ${(((wire[0] & 15) << 8) | wire[1])}: added by the data link layer, covered by the LCRC` },
    { name: 'Fmt, Type', from: tlpAt, to: tlpAt + 1, cls: 'f1', say: `${kind}: Fmt says 3-dword header ${kind === 'MRd' ? 'without' : 'with'} data, Type says ${cpl ? 'completion' : 'memory'}` },
    { name: 'Length', from: tlpAt + 1, to: tlpAt + 4, cls: 'f2', say: `${f.len} dword${f.len > 1 ? 's' : ''} (attributes and traffic class are the zeros in front)` },
  ];
  if (cpl) {
    rows.push({ name: 'Completer', from: tlpAt + 4, to: tlpAt + 6, cls: 'f3', say: `bus ${f.completer >> 8}, device ${(f.completer >> 3) & 31}, function ${f.completer & 7}` });
    rows.push({ name: 'Status, bytes left', from: tlpAt + 6, to: tlpAt + 8, cls: 'f4', say: `successful, ${f.byteCount} bytes still to come in all` });
    rows.push({ name: 'Requester, tag', from: tlpAt + 8, to: tlpAt + 11, cls: 'f3', say: `sent back as they came, tag ${f.tag}: how the requester knows which read this answers` });
    rows.push({ name: 'Lower address', from: tlpAt + 11, to: tlpAt + 12, cls: 'f5', say: `0x${f.lower.toString(16)}: where in the buffer the data starts` });
  } else {
    rows.push({ name: 'Requester', from: tlpAt + 4, to: tlpAt + 6, cls: 'f3', say: `bus ${f.requester >> 8}, device ${(f.requester >> 3) & 31}, function ${f.requester & 7}: where a completion goes` });
    rows.push({ name: 'Tag', from: tlpAt + 6, to: tlpAt + 7, cls: 'f4', say: `${f.tag}: one of the requester's outstanding reads` });
    rows.push({ name: 'Byte enables', from: tlpAt + 7, to: tlpAt + 8, cls: 'f6', say: `last ${f.lastBe.toString(2).padStart(4, '0')}, first ${f.firstBe.toString(2).padStart(4, '0')}: which bytes of the end dwords count` });
    rows.push({ name: 'Address', from: tlpAt + 8, to: tlpAt + 12, cls: 'f5', say: `0x${f.addr.toString(16).padStart(8, '0')}: dword aligned` });
  }
  if (end > tlpAt + 12) rows.push({ name: 'Payload', from: tlpAt + 12, to: end, cls: 'f7', say: `${end - tlpAt - 12} bytes, ${dataCredits(f.len)} data credit${dataCredits(f.len) > 1 ? 's' : ''}` });
  rows.push({ name: 'LCRC', from: end, to: n, cls: 'f8', say: 'CRC-32 over the sequence number and the TLP: the register Ethernet uses' });
  return rows;
}
export function tlpWidget(): Widget {
  let kind: TlpKind = 'MWr', dw = 2, seq = 5, flip = -1, flipBit = 0;
  const body = h('div', { class: 'pc-tlp' });
  const draw = () => {
    const data = Array.from({ length: dw * 4 }, (_, i) => (0xa0 + i) & 255);
    const tlp = tlpBytes(kind === 'MRd' ? { kind, len: dw, tag: 3, addr: 0x1000, requester: 0x0100 } : kind === 'MWr' ? { kind, len: dw, tag: 3, addr: 0x1000, requester: 0x0100, data } : { kind, len: dw, tag: 3, requester: 0x0100, completer: 0x0200, addr: 0x1000, data });
    const clean = dlWrap(seq, tlp);
    const wire = clean.map((b, i) => (i === flip ? b ^ (1 << flipBit) : b));
    const fields = fieldsOf(kind, clean), fieldAt = (i: number) => fields.find((f) => i >= f.from && i < f.to);
    const chip = (i: number, b: number) => {
      const f = fieldAt(i)!;
      const c = h('button', { class: `pc-byte ${f.cls}${i === flip ? ' flipped' : ''}`, type: 'button', title: `${f.name}: click to flip a bit` }, hex2(b));
      c.addEventListener('click', () => { if (flip === i) { flipBit = (flipBit + 1) % 8; } else { flip = i; flipBit = 0; } draw(); });
      return c;
    };
    const chk = fcsBytes(crc32(wire.slice(0, -4))), good = chk.every((v, i) => v === wire[wire.length - 4 + i]);
    const overhead = 2 + 12 + 4 + 2, payload = kind === 'MRd' ? 0 : dw * 4;
    body.replaceChildren(
      h('div', { class: 'pc-bytes' }, h('span', { class: 'pc-k' }, 'STP'), ...wire.map((b, i) => chip(i, b)), h('span', { class: 'pc-k' }, 'END')),
      h('div', { class: `sr-lock ${good ? 'ok' : 'bad'}` }, good ? `LCRC good: the receiver takes it, if the sequence number is the one it expects.` : `LCRC wrong: the receiver throws the TLP away and sends a Nak. It cannot tell which byte was hit, or whether the hit was in the header, so it trusts none of it.`),
      h('div', { class: 'pc-scroll' }, h('table', { class: 'pc-table' }, h('tbody', null, ...fields.map((f) => h('tr', null, h('td', null, h('span', { class: `pc-swatch ${f.cls}` }), f.name), h('td', { class: 'mono' }, clean.slice(f.from, f.to).map(hex2).join(' ').slice(0, 23) + (f.to - f.from > 8 ? ' …' : '')), h('td', null, f.say)))))),
      h('div', { class: 'mc-status' }, h('span', null, 'On the wire ', h('b', null, `${wire.length + 2} bytes`)), h('span', null, 'Payload ', h('b', null, `${payload}`)), h('span', null, 'Framing and headers ', h('b', null, `${overhead}`)), payload ? h('span', null, 'Efficiency ', h('b', null, `${nf((100 * payload) / (payload + overhead), 0)} %`)) : null),
    );
  };
  const sel = h('select', { class: 'mc-sel', 'aria-label': 'TLP kind' }, ...(['MWr', 'MRd', 'CplD'] as TlpKind[]).map((k) => h('option', { value: k }, k === 'MWr' ? 'Memory write' : k === 'MRd' ? 'Memory read' : 'Completion with data')));
  sel.addEventListener('change', () => { kind = sel.value as TlpKind; flip = -1; draw(); });
  const l = slider('Length', 1, MAX_DW, 1, dw, (v) => `${v} dw`, (v) => { dw = v; flip = -1; draw(); });
  const s = slider('Sequence number', 0, 4095, 1, seq, (v) => String(v), (v) => { seq = v; flip = -1; draw(); });
  const clear = btn('Repair', 'Put back the flipped bit', () => { flip = -1; draw(); });
  draw();
  return { el: h('div', { class: 'pc-w' }, h('div', { class: 'mc-row' }, sel, clear), h('div', { class: 'mc-row' }, l.el), h('div', { class: 'mc-row' }, s.el), body) };
}

// ---- the credit gate's scene -----------------------------------------------------------------------------------------------
export const creditScene = (): Scene => ({ root: bench(creditGate(8)), inputs: { limit: 4, consumed: 2, want: 1 } });

// ---- reading a lane ---------------------------------------------------------------------------------------------------------
export interface LogItem { clock: number; dir: 'a' | 'b'; text: string; bad: boolean; cls: string }
/** Packets from the symbols that arrive on a lane, as an analyser reads them: the CRCs recomputed from what came. */
export class LaneLog {
  cur: number[] | null = null; mode = ''; ts = 0; items: LogItem[] = []; lastTs = '';
  constructor(private dir: 'a' | 'b') {}
  feed(d: number, k: number, clock: number, on: (x: LogItem) => void): void {
    if (this.cur === null) {
      if (k && d === K_STP) { this.cur = []; this.mode = 't'; }
      else if (k && d === K_SDP) { this.cur = []; this.mode = 'd'; }
      else if (k && d === K_COM) this.ts++;
      return;
    }
    if (!k) { if (this.cur.length < 200) this.cur.push(d); return; }
    const b = this.cur; this.cur = null;
    const ended = d === K_END;
    if (d === K_COM) this.ts++;
    if (this.mode === 't') {
      if (!ended || b.length < 6) { on({ clock, dir: this.dir, text: `TLP cut off by ${d === K_EDB ? 'EDB' : 'a stray symbol'}`, bad: true, cls: 'tlp' }); return; }
      const body = b.slice(0, -4), z = fcsBytes(crc32(body)), good = z.every((v, i) => v === b[b.length - 4 + i]);
      const seq = ((body[0] & 15) << 8) | body[1];
      if (!good) { on({ clock, dir: this.dir, text: `TLP seq ${seq} LCRC wrong`, bad: true, cls: 'tlp' }); return; }
      const f = parseTlp(body.slice(2));
      on({ clock, dir: this.dir, text: f.kind === 'CplD' ? `CplD seq ${seq} tag ${f.tag}, ${f.len} dw` : `${f.kind} seq ${seq} tag ${f.tag}, ${f.len} dw at 0x${f.addr.toString(16)}`, bad: false, cls: 'tlp' });
    } else {
      if (!ended || b.length !== 6) { on({ clock, dir: this.dir, text: 'DLLP cut off', bad: true, cls: 'dllp' }); return; }
      const good = dllpCrc(b.slice(0, 4)) === (b[4] | (b[5] << 8));
      const word = (b[1] << 16) | (b[2] << 8) | b[3], nm = dllpName(b[0]), ack = (b[0] >> 4) < 2;
      const fc = `hdr ${(word >> 14) & 255}, data ${word & 0xfff}`;
      on({ clock, dir: this.dir, text: good ? `${nm} ${ack ? `seq ${word & 0xfff}` : fc}` : `${nm} CRC wrong`, bad: !good, cls: ack ? (b[0] >> 4 ? 'nak' : 'ack') : 'fc' });
    }
  }
}

// ---- the link's panel --------------------------------------------------------------------------------------------------------
export interface PcieStatus {
  up: boolean; ltA: number; ltB: number; dlA: number; dlB: number; clocks: number; agreed: boolean; wrong: string;
  nextSeq: number; ackd: number; nrcv: number; replays: number; naks: number; recoveries: number; waited: number; bad: number; ram: Uint8Array; lastRead: number[];
}
export interface PcieApi {
  status(): PcieStatus;
  write(addr: number, len: number, seed: number): void;
  read(addr: number, len: number): void;
  flipTlp(): void; flipAck(): void;
  block(on: boolean): void; plug(on: boolean): void; run(n: number): void;
}
export const pcieApi = new WeakMap<Stage, PcieApi>();

const INPUTS = ['rst', 'plug', 'go', 'wr', 'addr', 'len', 'seed', 'flip_ab', 'flip_ba'];
const OUTPUTS = ['a_txd', 'a_txk', 'b_txd', 'b_txk', 'busy', 'wait', 'rd_valid', 'rd_done', 'rd_data', 'rtag', 'ep_st', 'a_status', 'b_status'];

export function pcieScene(view: 'link' | 'train'): Scene {
  return {
    root: pcieLink(), inputs: { rst: 1, plug: view === 'link' ? 1 : 0, go: 0, wr: 1, addr: 0, len: 4, seed: 1, flip_ab: 0, flip_ba: 0 },
    clock: 'clk', autoClock: false, engine: 'cycle', hiddenInputs: INPUTS, hiddenOutputs: OUTPUTS, memory: false,
    panels: [pciePanel(view)],
  };
}

function pciePanel(view: 'link' | 'train'): ScenePanel {
  return (stage: Stage): Widget => {
    let model = new PcieLink(), started = false, clocks = 0, agreed = true, wrong = '', stopRun: (() => void) | null = null, raf = 0;
    let logA = new LaneLog('a'), logB = new LaneLog('b'), items: LogItem[] = [], armTlp = false, armAck = false, blocked = false, flipNow = [0, 0];
    let replays = 0, naks = 0, recov = 0, waited = 0, bad = 0, lastRead: number[] = [], reading: number[] = [], prevReplay = 0, prevLt = 0, tsA: string[] = [], tsB: string[] = [];
    let cmdAddr = 8, cmdLen = 4, cmdSeed = 0x11, nRead = 0;
    const clearState = () => {
      model = new PcieLink(); clocks = 0; agreed = true; wrong = ''; logA = new LaneLog('a'); logB = new LaneLog('b'); items = [];
      armTlp = armAck = blocked = false; replays = naks = recov = waited = bad = 0; lastRead = []; reading = []; prevReplay = 0; prevLt = 0; tsA = []; tsB = [];
    };
    const inp = (n: string) => stage.sim!.getInput(n);
    const st = (port: string) => readStatus(stage.sim!.getBits(stage.sim!.design.root.ports[port]));
    const linkIn = (): LinkIn => ({ rst: inp('rst'), plug: inp('plug'), go: inp('go'), wr: inp('wr'), addr: inp('addr'), len: inp('len'), seed: inp('seed'), flip_ab: inp('flip_ab'), flip_ba: inp('flip_ba') });
    const push = (x: LogItem) => { items.push(x); if (x.bad) bad++; if (x.cls === 'nak' && !x.bad) naks++; if (items.length > 400) items.splice(0, 200); };
    const sym = (d: number, k: number) => (k ? ({ [K_COM]: 'COM', [K_STP]: 'STP', [K_SDP]: 'SDP', [K_END]: 'END', [K_EDB]: 'EDB' } as Record<number, string>)[d] ?? 'K' : hex2(d));
    const hook = {
      before: () => {
        if (!started) return;
        const i = linkIn();
        model.step(i);
        const adat = stage.value('a_txd') ^ flipNow[0], bdat = stage.value('b_txd') ^ flipNow[1], ak = stage.value('a_txk'), bk = stage.value('b_txk');
        logA.feed(adat, ak, clocks, push); logB.feed(bdat, bk, clocks, push);
        tsA.push(sym(adat, ak)); tsB.push(sym(bdat, bk));
        if (tsA.length > 24) { tsA.shift(); tsB.shift(); }
        if (stage.value('rd_valid')) { reading.push(stage.value('rd_data')); if (stage.value('rd_done')) { lastRead = reading; reading = []; nRead++; } }
        if (stage.value('wait')) waited++;
        const sa = st('a_status'), rp = sa.replay;
        if (rp && !prevReplay) replays++;
        prevReplay = rp;
        const lt = sa.lt;
        if (lt === 5 && prevLt !== 5) recov++;
        prevLt = lt;
      },
      after: () => {
        if (!started) return;
        clocks++;
        const w = model.out(linkIn());
        const sa = st('a_status'), sb = st('b_status');
        const check = (n: string, g: number, v: number) => { if (agreed && g !== v) { agreed = false; wrong = `clock ${clocks}: ${n} gates ${g} model ${v}`; } };
        check('A txd', stage.value('a_txd'), w.a.txd); check('B txd', stage.value('b_txd'), w.b.txd); check('A txk', stage.value('a_txk'), w.a.txk); check('B txk', stage.value('b_txk'), w.b.txk);
        for (const [n] of PORT_STATUS) { const ma = w.a as unknown as Record<string, number>, mb = w.b as unknown as Record<string, number>; check(`A ${n}`, sa[n], ma[n]); check(`B ${n}`, sb[n], mb[n]); }
        // the flips are set for the clock after this edge; go and the rest are pulses
        const sim = stage.sim!;
        const kA = sa.kind, kB = sb.kind;
        const fa = blocked || (armTlp && kA === 1 && !stage.value('a_txk')) ? 1 : 0, fb = armAck && kB === 2 && !stage.value('b_txk') && model.b.dt === 0 ? 1 : 0;
        if (fa && armTlp) armTlp = false;
        if (fb) armAck = false;
        flipNow = [fa, fb];
        if (inp('flip_ab') !== fa) sim.setInput('flip_ab', fa);
        if (inp('flip_ba') !== fb) sim.setInput('flip_ba', fb);
        if (inp('go')) sim.setInput('go', 0);
        sim.settle();
        schedule();
      },
    };
    stage.edgeHooks.add(hook);
    const init = () => {
      clearState();
      const pl = view === 'link' ? 1 : 0;
      stage.setInputs({ rst: 1, plug: pl, go: 0, flip_ab: 0, flip_ba: 0 });
      stage.runCycles(1, undefined, 0, true);
      stage.setInputs({ rst: 0 });
      model.step({ ...LINK_IN0, rst: 1, plug: pl });
      started = true;
      if (view === 'link') stage.runCycles(4000, () => st('a_status').dl === 3 && st('b_status').dl === 3, 0, true);
      stage.refresh(); schedule();
    };
    stage.resetHooks.add(() => { stopRun?.(); started = false; requestAnimationFrame(init); });
    const snapModel = () => ({ a: structuredClone({ ...model.a }), b: structuredClone({ ...model.b }), ra: { ...model.ra }, eb: structuredClone({ ...model.eb }), ab: [...model.ab], ba: [...model.ba] });
    const snap = () => ({ m: snapModel(), clocks, agreed, wrong, items: [...items], replays, naks, recov, waited, bad, lastRead: [...lastRead], reading: [...reading], prevReplay, prevLt, tsA: [...tsA], tsB: [...tsB], armTlp, armAck, blocked, flipNow: [...flipNow], la: JSON.stringify({ c: logA.cur, m: logA.mode, t: logA.ts }), lb: JSON.stringify({ c: logB.cur, m: logB.mode, t: logB.ts }) });
    stage.historyHooks.add({
      save: snap,
      restore: (v) => {
        const x = v as ReturnType<typeof snap>;
        Object.assign(model.a, structuredClone(x.m.a)); Object.assign(model.b, structuredClone(x.m.b)); Object.assign(model.ra, x.m.ra); Object.assign(model.eb, structuredClone(x.m.eb));
        model.ab = [...x.m.ab]; model.ba = [...x.m.ba];
        ({ clocks, agreed, wrong, replays, naks, recov, waited, bad, prevReplay, prevLt, armTlp, armAck, blocked } = x);
        items = [...x.items]; lastRead = [...x.lastRead]; reading = [...x.reading]; tsA = [...x.tsA]; tsB = [...x.tsB]; flipNow = [...x.flipNow];
        const la = JSON.parse(x.la), lb = JSON.parse(x.lb);
        logA.cur = la.c; logA.mode = la.m; logA.ts = la.t; logB.cur = lb.c; logB.mode = lb.m; logB.ts = lb.t;
        schedule();
      },
    });

    const act = (f: () => void) => { stopRun?.(); stage.checkpoint(); f(); stage.refresh(); schedule(); };
    const send = (wr: number, addr: number, len: number, seed: number) => {
      if (stage.value('busy')) return;
      stage.setInputs({ go: 1, wr, addr, len, seed });
      stage.runCycles(1, undefined, 0, true);
    };
    const startRun = () => {
      stage.checkpoint();
      runBtn.textContent = 'Pause'; runBtn.setAttribute('aria-pressed', 'true');
      stopRun = frameRun(stage, () => false, () => { stopRun = null; runBtn.textContent = 'Run'; runBtn.setAttribute('aria-pressed', 'false'); schedule(); });
    };
    const runBtn = btn('Run', 'Run the clock as fast as the page can draw', () => (stopRun ? stopRun() : startRun()), 'btn sm primary');
    runBtn.setAttribute('aria-pressed', 'false');
    const addrS = slider('Address', 0, 60, 1, cmdAddr, (v) => `dword ${v}`, (v) => { cmdAddr = v; });
    const lenS = slider('Length', 1, MAX_DW, 1, cmdLen, (v) => `${v} dw`, (v) => { cmdLen = v; });
    const status = h('div', { class: 'mc-status' }), ladder = h('div', { class: 'pc-ladder' }), credits = h('div', { class: 'pc-credits' }), strip = h('div', { class: 'pc-strip' }), log = h('div', { class: 'pc-log', role: 'log' }), verdict = h('div', { class: 'sr-lock' }), memo = h('div', { class: 'pc-mem' });
    const update = () => {
      if (!stage.sim) return;
      const sa = st('a_status'), sb = st('b_status');
      const up = sa.dl === 3 && sb.dl === 3;
      const ladderOf = (name: string, lt: number, dl: number) => h('div', { class: 'pc-lad' }, h('b', null, name),
        h('div', { class: 'pc-steps' }, ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => h('span', { class: `pc-st${i === lt ? ' on' : ''}`, title: LT_NAMES[i] }, LT_NAMES[i].replace('Polling.', 'Poll.').replace('Recovery.', 'Rec.').replace('Config.Idle', 'Cfg.Idle').replace('Polling', 'Poll')))),
        h('span', { class: `pc-dl${dl === 3 ? ' on' : ''}` }, DL_NAMES[dl]));
      ladder.replaceChildren(ladderOf('Port A', sa.lt, sa.dl), ladderOf('Port B', sb.lt, sb.dl));
      status.replaceChildren(
        h('span', null, 'clocks ', h('b', null, String(clocks))),
        h('span', null, 'next seq ', h('b', null, String(sa.seq))), h('span', null, 'acked ', h('b', null, sa.ackd === 0xfff ? 'none' : String(sa.ackd))), h('span', null, 'B expects ', h('b', null, String(sb.nrcv))),
        h('span', null, 'REPLAY_NUM ', h('b', { class: sa.rnum ? 'bad' : '' }, String(sa.rnum))), h('span', null, 'replay timer ', h('b', null, String(sa.rt))),
        h('span', null, 'replays ', h('b', null, String(replays))), h('span', null, 'Naks ', h('b', null, String(naks))), h('span', null, 'Recoveries ', h('b', null, String(recov))), h('span', null, 'waits for credit ', h('b', null, `${waited} clocks`)),
      );
      const bar = (name: string, used: number, lim: number, w: number) => {
        const left = (lim - used + 2 ** w) % 2 ** w;
        return h('div', { class: 'pc-cr' }, h('span', null, name), h('b', { class: left ? '' : 'bad' }, `${left} left`), h('small', null, `limit ${lim}, used ${used}`));
      };
      credits.replaceChildren(bar('Posted hdr', sa.ph_cc, sa.ph_lim, 8), bar('Posted data', sa.pd_cc, sa.pd_lim, 12), bar('Non-posted hdr', sa.nph_cc, sa.nph_lim, 8));
      const line = (nm: string, s: string[]) => h('div', { class: 'pc-sym' }, h('b', null, nm), ...s.map((t) => h('span', { class: t.length > 2 ? 'k' : t === '00' ? 'z' : '' }, t)));
      strip.replaceChildren(line('A→B', tsA), line('B→A', tsB));
      log.replaceChildren(...items.slice(-9).reverse().map((x) => h('div', { class: `pc-row ${x.cls}${x.bad ? ' bad' : ''}` }, h('small', null, String(x.clock)), h('span', null, x.dir === 'a' ? 'A→B' : 'B→A'), h('span', null, x.text))));
      if (lastRead.length) memo.replaceChildren(h('b', null, `Read #${nRead}: `), h('span', { class: 'mono' }, lastRead.slice(0, 16).map(hex2).join(' ') + (lastRead.length > 16 ? ' …' : '')));
      else memo.replaceChildren();
      verdict.className = `sr-lock ${agreed ? 'ok' : 'bad'}`;
      verdict.textContent = agreed ? `Gates and golden model agree on every clock so far (${clocks}), ${up ? 'link up' : 'link not up yet'}.` : `Disagreement: ${wrong}`;
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; update(); }); };
    const plugBtn = btn(view === 'train' ? 'Plug in' : 'Unplug', 'Connect or pull the cable: pulling it is a reset of both ports', () => act(() => {
      const on = inp('plug') ? 0 : 1;
      stage.setInput('plug', on);
      plugBtn.textContent = on ? 'Unplug' : 'Plug in';
    }));
    const write = () => act(() => send(1, cmdAddr, cmdLen, (cmdSeed = (cmdSeed + 0x11) & 255)));
    const read = () => act(() => send(0, cmdAddr, cmdLen, 0));
    const el = h('div', { class: 'mem-panel cpu-panel mc-panel pc-panel', 'data-dock': 'right', 'data-phone': 'flow' },
      h('h4', null, view === 'train' ? 'Link training' : 'PCIe link', h('span', { class: 'fold-hint' })),
      h('div', { class: 'dram-ops' }, plugBtn, btn('Cycle', 'One clock', () => act(() => stage.runCycles(1))), btn('×40', '40 clocks', () => act(() => stage.runCycles(40))), runBtn),
      ladder, view === 'link' ? h('div', { class: 'mc-row' }, addrS.el) : null, view === 'link' ? h('div', { class: 'mc-row' }, lenS.el) : null,
      view === 'link' ? h('div', { class: 'dram-ops' }, btn('Write', 'A memory write of counting bytes to this address', write, 'btn sm primary'), btn('Read', 'A memory read: the completion comes back with its tag', read),
        btn('Flip next TLP byte', 'The next data symbol going A→B has a bit flipped', () => { armTlp = true; schedule(); }), btn('Lose next Ack', 'The next Ack going B→A has a bit flipped: its CRC fails and it is thrown away', () => { armAck = true; schedule(); }),
        btn('Block A→B', 'Every symbol going A→B has a bit flipped: nothing gets through', () => { blocked = !blocked; if (!blocked) { stage.setInput('flip_ab', 0); flipNow[0] = 0; } schedule(); })) : null,
      status, view === 'link' ? credits : null, strip, h('div', { class: 'cpu-sec' }, 'Packets on the lanes'), log, memo, verdict,
      h('p', { class: 'sub' }, 'A symbol a clock: PIPE\'s shape, one lane. The flips and the delay on the lane are a model, labelled as one; everything else is gates.'));
    update();
    requestAnimationFrame(() => { if (stage.sim && !started) init(); });
    pcieApi.set(stage, {
      status: () => {
        const sa = st('a_status'), sb = st('b_status');
        return { up: sa.dl === 3 && sb.dl === 3, ltA: sa.lt, ltB: sb.lt, dlA: sa.dl, dlB: sb.dl, clocks, agreed, wrong, nextSeq: sa.seq, ackd: sa.ackd, nrcv: sb.nrcv, replays, naks, recoveries: recov, waited, bad, ram: model.eb.ram, lastRead };
      },
      write: (a, n, s) => act(() => send(1, a, n, s)), read: (a, n) => act(() => send(0, a, n, 0)),
      flipTlp: () => { armTlp = true; }, flipAck: () => { armAck = true; },
      block: (on) => { blocked = on; if (!on) { stage.setInput('flip_ab', 0); flipNow[0] = 0; } },
      plug: (on) => act(() => { stage.setInput('plug', on ? 1 : 0); plugBtn.textContent = on ? 'Unplug' : 'Plug in'; }),
      run: (n) => act(() => { stage.runCycles(n, undefined, 0, true); }),
    });
    return { el, update, destroy: () => { stopRun?.(); stage.edgeHooks.delete(hook); pcieApi.delete(stage); if (raf) cancelAnimationFrame(raf); } };
  };
}

// ---- what it costs ---------------------------------------------------------------------------------------------------------
const bufs = () => stats(bigRamWithInit(BUF_BITS, 9, new Uint32Array(1 << BUF_BITS))).nands + stats(bigRamWithInit(BUF_BITS, 8, new Uint32Array(1 << BUF_BITS))).nands;
export const pcieCosts = () => ({ port: stats(pciePort()).nands, buffers: bufs(), root: stats(pcieRootTl()).nands, ep: stats(pcieEpTl()).nands, link: stats(pcieLink()).nands, gate8: stats(creditGate(8)).nands, gate12: stats(creditGate(12)).nands });
export { hex3 };
