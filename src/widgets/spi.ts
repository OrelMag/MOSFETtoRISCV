// Chapter 44's SPI widgets: the four modes drawn from the gate-level master (not from a picture), chip selects against a
// daisy chain, and the panel that drives the master-and-two-memories scene with whole transactions.

import '../styles/clocks.css';
import '../styles/spi.css';
import { edgeKind, modeNumber, SPI_MODES, type SpiMode } from '../comm/spi';
import { masterRun, spiDevice, spiMaster, spiPair } from '../lib/spi';
import { decoder } from '../lib/combinational';
import { stats } from '../sim/stats';
import { h, s } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { fitText, slider } from './mosparts';

const hex = (x: number, n = 2) => x.toString(16).toUpperCase().padStart(n, '0');

// ---- shared: digital traces ------------------------------------------------------------------------------------------

export interface WaveRow { label: string; bits: (number | null)[]; /** bit labels placed at [from, to) spans of the row */ spans?: { from: number; to: number; text: string }[]; cls?: string }
export interface WaveMarks { x: number; kind: 'sample' | 'change'; row?: number }

/** Digital traces on a grid of `n` slots: a level line per row, unknown (null) as a gap, spans labelled, vertical marks. */
export function waveSvg(rows: WaveRow[], n: number, opts: { marks?: WaveMarks[]; slotW?: number; rowH?: number; label?: string; labelW?: number } = {}): SVGSVGElement {
  const slotW = opts.slotW ?? 12, rowH = opts.rowH ?? 34, LW = opts.labelW ?? 46, pad = 10;
  const W = LW + n * slotW + pad, H = rows.length * rowH + 16;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'mos-plot spi-wave', role: 'img', 'aria-label': opts.label ?? 'Digital traces' }) as SVGSVGElement;
  fitText(svg, W);
  const X = (t: number) => LW + t * slotW;
  for (const m of opts.marks ?? []) {
    svg.append(s('line', { x1: X(m.x), x2: X(m.x), y1: 4, y2: H - 10, class: `spi-mark ${m.kind}` }));
  }
  rows.forEach((r, i) => {
    const y0 = 8 + i * rowH, hi = y0 + 6, lo = y0 + rowH - 12;
    svg.append(s('text', { x: 2, y: (hi + lo) / 2 + 4, class: 'tick spi-lab' }, r.label));
    let d = '', prevLevel: number | null | undefined;
    for (let t = 0; t < n; t++) {
      const v = r.bits[t] ?? null;
      if (v === null) { prevLevel = null; continue; }
      const yv = v ? hi : lo;
      d += prevLevel === undefined || prevLevel === null ? `M${X(t)},${yv}` : prevLevel !== v ? `L${X(t)},${yv}` : '';
      d += `L${X(t + 1)},${yv}`;
      prevLevel = v;
    }
    svg.append(s('path', { d, class: `spi-line ${r.cls ?? ''}` }));
    // unknown stretches as a light band
    let t = 0;
    while (t < n) { if ((r.bits[t] ?? null) === null) { let e = t; while (e < n && (r.bits[e] ?? null) === null) e++; svg.append(s('line', { x1: X(t), x2: X(e), y1: (hi + lo) / 2, y2: (hi + lo) / 2, class: 'spi-z' })); t = e; } else t++; }
    for (const sp of r.spans ?? []) svg.append(s('text', { x: (X(sp.from) + X(sp.to)) / 2, y: lo - 3 - 0, 'text-anchor': 'middle', class: 'spi-bit' }, sp.text));
  });
  return svg;
}

// ---- 1. a byte on a UART and on SPI --------------------------------------------------------------------------------------------

/** One byte as a UART frame (8N1, LSB first) and as SPI mode 0, on the same time axis: what the clock wire replaces. */
export function frameCompareWidget(): Widget {
  let byte = 0xa5;
  const view = h('div', { class: 'spi-view' }), note = h('p', { class: 'clk-verdict ok', role: 'status' });
  const paint = () => {
    const Q = 4; // slots per bit time
    const bitAt = (i: number) => (byte >> i) & 1;
    // UART: idle, start, d0 … d7, stop, idle
    const uart: number[] = [], uspans: { from: number; to: number; text: string }[] = [];
    const putBit = (v: number, text: string) => { uspans.push({ from: uart.length, to: uart.length + Q, text }); for (let k = 0; k < Q; k++) uart.push(v); };
    for (let k = 0; k < Q; k++) uart.push(1);
    putBit(0, 'S'); for (let i = 0; i < 8; i++) putBit(bitAt(i), String(bitAt(i))); putBit(1, 'P');
    for (let k = 0; k < Q; k++) uart.push(1);
    const n = uart.length;
    // SPI mode 0: CS low a bit time before the first edge, then 8 clocks of Q slots (MOSI changes at the falling edge)
    const cs: number[] = [], sclk: number[] = [], mosi: number[] = [], sspans: { from: number; to: number; text: string }[] = [];
    const lead = Q;
    for (let k = 0; k < n; k++) {
      const t = k - lead - Q;
      const inFrame = k >= lead && k < lead + Q + 8 * Q + Q;
      cs.push(inFrame ? 0 : 1);
      const rel = t; // slot index from the first clock edge
      sclk.push(rel >= 0 && rel < 8 * Q ? (Math.floor(rel / (Q / 2)) % 2 === 0 ? 1 : 0) : 0);
      const bi = rel < 0 ? 0 : Math.min(7, Math.floor(rel / Q));
      mosi.push(inFrame ? (byte >> (7 - bi)) & 1 : 1);
    }
    for (let i = 0; i < 8; i++) sspans.push({ from: lead + Q + i * Q, to: lead + Q + (i + 1) * Q, text: String((byte >> (7 - i)) & 1) });
    const marks: WaveMarks[] = Array.from({ length: 8 }, (_, i) => ({ x: lead + Q + i * Q, kind: 'sample' as const }));
    const svg = waveSvg([
      { label: 'UART', bits: uart, spans: uspans, cls: 'mosi' },
      { label: 'CS', bits: cs, cls: 'cs' },
      { label: 'SCLK', bits: sclk, cls: 'clk' },
      { label: 'MOSI', bits: mosi, spans: sspans, cls: 'mosi' },
    ], n, { marks, slotW: Math.max(5, Math.min(12, 520 / n)), label: 'One byte on a UART line and on SPI mode 0, on the same time axis' });
    view.replaceChildren(svg);
    note.textContent = `The UART line carries 10 bit times for 0x${hex(byte)}: a start bit (0), the 8 bits least significant first, a stop bit (1), and the receiver samples in the middle of each of them with a clock of its own. SPI carries the same 8 bits in 8 clock periods, most significant first, each sampled on the rising edge of SCLK (dashed marks); CS brackets the byte. Same time per bit here, 20 % fewer bit times, and no guess about when to look.`;
  };
  const sl = slider('Byte', 0, 255, 1, byte, (v) => `0x${hex(v)}`, (v) => { byte = v; paint(); });
  const el = h('div', { class: 'widget mos clk-w' }, h('div', { class: 'panel' }, h('h3', null, 'The same byte, with and without a clock wire'), view, h('div', { class: 'mos-row' }, sl.el), note));
  paint();
  return { el };
}

// ---- 3. the four modes ------------------------------------------------------------------------------------------------------

/** Four modes, drawn from the gate-level master against a peer that follows the mode's rules. */
export function spiModesWidget(): Widget {
  let mode: SpiMode = SPI_MODES[0], tx = 0xa5, peer = 0x3c;
  const view = h('div', { class: 'spi-view' }), note = h('p', { class: 'clk-verdict', role: 'status' });
  const paint = () => {
    const r = masterRun(mode, tx, peer);
    const n = r.clocks.length;
    const bitsRow = (key: 'sclk' | 'mosi' | 'miso' | 'cs_n') => r.clocks.map((c) => c[key]);
    const spans = (byte: number, pre: number, sampled: boolean) => {
      // a bit lies between the change edge before its sample edge and the one after it
      const sample = r.edges.filter((_, e) => edgeKind(mode, e).sample), change = r.edges.filter((_, e) => !edgeKind(mode, e).sample);
      void sampled; void pre;
      return sample.map((_c, i) => {
        const from = mode.cpha === 0 ? (i === 0 ? 0 : change[i - 1]) : change[i];
        const to = mode.cpha === 0 ? (i === 7 ? n : change[i]) : (i === 7 ? n : change[i + 1]);
        return { from, to, text: String((byte >> (7 - i)) & 1) };
      });
    };
    const marks: WaveMarks[] = r.edges.map((c, e) => ({ x: c, kind: edgeKind(mode, e).sample ? 'sample' : 'change' }));
    const csBits = bitsRow('cs_n');
    const svg = waveSvg([
      { label: 'CS', bits: csBits, cls: 'cs' },
      { label: 'SCLK', bits: bitsRow('sclk'), cls: 'clk' },
      { label: 'MOSI', bits: bitsRow('mosi'), spans: spans(tx, 0, true), cls: 'mosi' },
      { label: 'MISO', bits: bitsRow('miso'), spans: spans(peer, 0, true), cls: 'miso' },
    ], n, { marks, slotW: Math.max(5, Math.min(12, 520 / n)), label: `SPI mode ${modeNumber(mode)}: CS, SCLK, MOSI and MISO for one byte each way, with the sampling edges marked` });
    view.replaceChildren(svg);
    const first = edgeKind(mode, 0);
    note.className = 'clk-verdict ok';
    note.textContent = `Mode ${modeNumber(mode)}: SCLK idles ${mode.cpol ? 'high' : 'low'}. Data are sampled on the ${edgeKind(mode, 0).sample ? (first.rising ? 'rising' : 'falling') : (edgeKind(mode, 1).rising ? 'rising' : 'falling')} edge (the ${mode.cpha === 0 ? 'first, leading' : 'second, trailing'} one) and changed on the ${mode.cpha === 0 ? 'trailing' : 'leading'} edge. The master read 0x${hex(r.rx)} while sending 0x${hex(tx)}.`;
  };
  const toggle = (label: string, get: () => number, set: (v: number) => void) => {
    const b = h('button', { class: 'btn sm', 'aria-pressed': String(!!get()) }, `${label} = ${get()}`);
    b.addEventListener('click', () => { set(get() ? 0 : 1); b.setAttribute('aria-pressed', String(!!get())); b.textContent = `${label} = ${get()}`; paint(); });
    return b;
  };
  const cpol = toggle('CPOL', () => mode.cpol, (v) => { mode = { ...mode, cpol: v as 0 | 1 }; });
  const cpha = toggle('CPHA', () => mode.cpha, (v) => { mode = { ...mode, cpha: v as 0 | 1 }; });
  const tSl = slider('Master sends', 0, 255, 1, tx, (v) => `0x${hex(v)}`, (v) => { tx = v; paint(); });
  const pSl = slider('Peer sends', 0, 255, 1, peer, (v) => `0x${hex(v)}`, (v) => { peer = v; paint(); });
  const el = h('div', { class: 'widget mos clk-w' },
    h('div', { class: 'panel' }, h('h3', null, 'One byte each way, from the gates of the master'), view,
      h('div', { class: 'mos-row' }, cpol, cpha), h('div', { class: 'mos-row' }, tSl.el, pSl.el), note,
      h('p', { class: 'sub mos-note' }, `The traces are the outputs of lib/spi.ts spiMaster() clocked once per system clock (${stats(spiMaster()).nands} NANDs), against a peer that changes MISO on the edge its mode says. Dashed marks: the 8 sampling edges (solid) and the 8 changing edges (light). Flipping CPOL inverts SCLK and moves nothing else; flipping CPHA moves every data change half a period.`)));
  paint();
  return { el };
}

// ---- 4. chip selects against a daisy chain -----------------------------------------------------------------------------------

export function spiChainWidget(): Widget {
  let n = 4, mhz = 10;
  const body = h('div');
  const paint = () => {
    const k = Math.max(1, Math.ceil(Math.log2(n)));
    const dec = n > 1 ? stats(decoder(k, true)).nands : 0;
    const bits = 8, tByte = bits / (mhz * 1e6);
    const row = (a: string, b: string, c: string) => h('tr', null, h('th', { scope: 'row' }, a), h('td', null, b), h('td', null, c));
    body.replaceChildren(h('table', { class: 'spi-table' },
      h('thead', null, h('tr', null, h('th'), h('th', null, 'One CS per device'), h('th', null, 'Daisy chain'))),
      h('tbody', null,
        row('Wires from the master', `${3 + n} (SCLK, MOSI, MISO, ${n} CS)`, '4 (SCLK, MOSI, MISO, one CS)'),
        row('Master pins, with a 1-of-n decoder', `${3 + k + 1} pins, ${dec} NANDs of decoder`, '4 pins'),
        row('Bytes to change one device', '1 register byte (plus command)', `${n} bytes: the data pass through every device (each shifts the next one's)`),
        row(`Time at ${mhz} MHz SCLK`, `${(tByte * 1e6).toFixed(2)} µs a byte`, `${(n * tByte * 1e6).toFixed(2)} µs for the whole chain`),
        row('Reading device j back', 'its own CS, any order', `${n} bytes, the answer arrives j bytes later`),
        row('Needs from the part', 'nothing special', 'a shift-register output (SDO) that echoes SDI delayed by 8 clocks'))),
      h('p', { class: 'sub' }, `A daisy chain turns the n devices into one long shift register of 8n bits: the ring of the previous step, each device's MISO feeding the next MOSI. Fewer wires, but every update is as long as the chain. Typical users: LED drivers, shift-register ICs, some ADC arrays. ${n} chip selects need ${k} address lines and a ${k}-to-${n} decoder with enable (${dec} NANDs), or ${n} pins.`));
  };
  const nSl = slider('Devices', 1, 8, 1, n, (v) => String(v), (v) => { n = v; paint(); });
  const fSl = slider('SCLK', 1, 50, 1, mhz, (v) => `${v} MHz`, (v) => { mhz = v; paint(); });
  const el = h('div', { class: 'widget mos clk-w' }, h('div', { class: 'panel' }, h('h3', null, 'Many devices: select, or chain'), h('div', { class: 'mos-row' }, nSl.el, fSl.el), body));
  paint();
  return { el };
}

// ---- the scene -------------------------------------------------------------------------------------------------------------

interface Row { role: string; tx: number; rx: number }

const OPS: { label: string; title: string; bytes: number[]; roles: string[] }[] = [
  { label: 'Write A5 5A 3C at 0x10', title: 'command 0x02, address 0x10, three data bytes, CS held low throughout', bytes: [0x02, 0x10, 0xa5, 0x5a, 0x3c], roles: ['command: write', 'address', 'data', 'data', 'data'] },
  { label: 'Read 3 bytes from 0x10', title: 'command 0x03, address 0x10, then three bytes clocked out with dummy data', bytes: [0x03, 0x10, 0, 0, 0], roles: ['command: read', 'address', 'dummy → data', 'dummy → data', 'dummy → data'] },
];

export interface SpiApi { run(i: number): void; log(): Row[] }
export const spiApi = new WeakMap<Stage, SpiApi>();

/** The panel: whole transactions as byte lists, CS held across them, and the exchange logged byte by byte. */
export const spiPanel: ScenePanel = (stage: Stage): Widget => {
  let queue: number[] = [], roles: string[] = [], inflight: { tx: number; role: string } | null = null, log: Row[] = [], timer: ReturnType<typeof setTimeout> | null = null;
  const v = (p: string) => stage.value(p);
  const hook = {
    before: () => {
      const sim = stage.sim;
      if (!sim) return;
      if (queue.length && !v('busy') && !inflight) {
        const tx = queue.shift()!, role = roles.shift()!;
        inflight = { tx, role };
        sim.setInput('tx', tx); sim.setInput('start', 1); sim.setInput('hold', 1);
      } else {
        sim.setInput('start', 0);
        if (!queue.length && !inflight && !v('busy') && stage.getInput('hold')) sim.setInput('hold', 0);
      }
      sim.settle();
    },
    after: () => {
      if (inflight && v('done') === 1) { log.push({ role: inflight.role, tx: inflight.tx, rx: v('rx') }); inflight = null; paint(); }
    },
  };
  stage.edgeHooks.add(hook);
  stage.historyHooks.add({
    save: () => ({ queue: [...queue], roles: [...roles], inflight: inflight && { ...inflight }, log: log.map((r) => ({ ...r })) }),
    restore: (x) => { const o = x as { queue: number[]; roles: string[]; inflight: typeof inflight; log: Row[] }; queue = [...o.queue]; roles = [...o.roles]; inflight = o.inflight; log = o.log.map((r) => ({ ...r })); paint(); },
  });
  stage.resetHooks.add(() => { stop(); queue = []; roles = []; inflight = null; log = []; paint(); });
  const busy = () => queue.length > 0 || inflight !== null || v('busy') === 1 || stage.getInput('hold') === 1;
  const stop = () => { if (timer) clearTimeout(timer); timer = null; };
  const go = () => {
    stop();
    const slice = () => {
      timer = null;
      stage.checkpoint();
      stage.runCycles(24, undefined, 0, true);
      stage.refresh();
      if (busy()) timer = setTimeout(slice, 30);
      paint();
    };
    slice();
  };
  const run = (i: number) => { if (busy()) return; const op = OPS[i]; queue = [...op.bytes]; roles = [...op.roles]; go(); };
  const table = h('table', { class: 'spi-table spi-log' });
  const paint = () => {
    table.replaceChildren(
      h('thead', null, h('tr', null, h('th', null, 'byte'), h('th', null, 'MOSI (sent)'), h('th', null, 'MISO (received)'))),
      h('tbody', null, ...(log.length ? log.map((r) => h('tr', null, h('th', { scope: 'row' }, r.role), h('td', null, `0x${hex(r.tx)}`), h('td', null, r.rx < 0 ? 'X' : `0x${hex(r.rx)}`))) : [h('tr', null, h('td', { colspan: 3, class: 'sub' }, 'Choose the device with sel, then a transaction.'))])));
  };
  const btn = (label: string, title: string, f: () => void) => { const b = h('button', { class: 'btn sm', title }, label); b.addEventListener('click', f); return b; };
  const el = h('div', { class: 'mem-panel cpu-panel mc-panel clk-panel', 'data-dock': 'right', 'data-fold': 'narrow', 'data-phone': 'flow' },
    h('h4', null, 'Transactions', h('span', { class: 'fold-hint' })),
    h('div', { class: 'dram-ops' }, ...OPS.map((o, i) => btn(o.label, o.title, () => run(i))), btn('Clear log', 'Forget the log', () => { log = []; paint(); })),
    table,
    h('p', { class: 'sub' }, 'Each byte is one 16-edge exchange; hold keeps CS low between bytes, so the memory sees one transaction. While a read command goes out, the bytes received are 0: the memory has nothing to say yet.'));
  paint();
  spiApi.set(stage, { run, log: () => log });
  return { el, update: paint, destroy: () => { stop(); stage.edgeHooks.delete(hook); spiApi.delete(stage); } };
};

/** The master and two memories, with the transaction panel. */
export function spiScene(): Scene {
  return { root: spiPair(), inputs: { sel: 0, mode3: 0, tx: 0, start: 0, hold: 0, rst: 0 }, clock: 'clk', autoClock: false, hiddenInputs: ['tx', 'start', 'hold', 'rst'], panels: [spiPanel], memory: false };
}

export { spiDevice };
