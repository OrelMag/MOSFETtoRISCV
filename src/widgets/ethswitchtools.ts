// Chapter 49's explainers that need no circuit: shared capacity against reserved, the address table's price and hit rate, the
// latency of store-and-forward against cut-through, head-of-line blocking measured on the golden model, and what full duplex removed.
// Models: comm/ethswitch.ts.

import '../styles/clocks.css';
import '../styles/ethswitch.css';
import '../styles/uart.css';
import { MAX_FRAME } from '../comm/ethframe';
import { addrOf, binomialPmf, binomialTail, holSaturation, HOL_LIMIT, HOL_N4, hostMac, MacTable, rng, runTraffic, sharedCapacity, singleFrame, type Pattern } from '../comm/ethswitch';
import { cam } from '../lib/storage';
import { registry } from '../lib/define';
import { macTable } from '../lib/ethswitch';
import { stats } from '../sim/stats';
import { h, s } from '../ui/dom';
import type { Widget } from '../view/stage';
import { slider } from './mosparts';

const n0 = (x: number) => Math.round(x).toLocaleString('en').replace(/,/g, ' ');
const pct = (x: number, d = 1) => `${(100 * x).toFixed(d)} %`;
const select = (label: string, opts: [string, string][], value: string, on: (v: string) => void) => {
  const sel = h('select', { class: 'mc-sel', 'aria-label': label }) as HTMLSelectElement;
  for (const [v, t] of opts) sel.append(h('option', { value: v }, t));
  sel.value = value;
  sel.addEventListener('change', () => on(sel.value));
  return sel;
};
const shell = (title: string, ...kids: (Node | string)[]) => h('div', { class: 'widget mos clk-w sw-w' }, h('div', { class: 'panel' }, h('h3', null, title), ...kids));
const reading = (...pairs: [string, string][]) => h('div', { class: 'mc-status' }, ...pairs.map(([k, v]) => h('span', null, `${k} `, h('b', null, v))));

// ---- shared capacity against reserved -----------------------------------------------------------------------------------------

export function muxWidget(): Widget {
  let n = 20, p = 0.1, eps = 1e-6;
  const plot = h('div', { class: 'sw-plot' }), read = h('div');
  const paint = () => {
    const C = sharedCapacity(n, p, eps), mean = n * p;
    const W = 760, H = 190, L = 28, B = 24, top = 10;
    const kmax = Math.min(n, Math.max(C + 4, Math.ceil(mean * 2.2) + 3));
    const pm = Array.from({ length: kmax + 1 }, (_, k) => binomialPmf(n, p, k)), pmax = Math.max(...pm);
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'sw-chart', role: 'img', 'aria-label': `Number of sources sending at once, ${n} sources each active ${pct(p, 0)} of the time; a shared link of ${C} units covers all but ${eps} of the time` });
    const bw = (W - L - 6) / (kmax + 1);
    pm.forEach((v, k) => svg.append(s('rect', { x: L + k * bw + 1, y: top + (1 - v / pmax) * (H - B - top), width: Math.max(1, bw - 2), height: Math.max(0.5, (v / pmax) * (H - B - top)), class: k > C ? 'bar over' : 'bar' })));
    svg.append(s('line', { x1: L + (C + 1) * bw, x2: L + (C + 1) * bw, y1: top - 2, y2: H - B, class: 'cap' }), s('text', { x: L + (C + 1) * bw + 3, y: top + 8, class: 'tick' }, `link: ${C}`));
    svg.append(s('text', { x: L, y: H - 6, class: 'tick' }, '0'), s('text', { x: W - 8, y: H - 6, class: 'tick', 'text-anchor': 'end' }, `${kmax} sources active at once`));
    plot.replaceChildren(svg);
    read.replaceChildren(reading(['circuit switching reserves', `${n} units (one per source, for its peak)`], ['mean demand', `${mean.toFixed(1)} units`], ['a shared packet link needs', `${C} units for overflow below ${eps.toExponential(0)}`], ['gain', `${(n / C).toFixed(1)} ×`], ['overflow at that size', binomialTail(n, p, C).toExponential(1)]));
  };
  const nS = slider('Sources', 2, 100, 1, n, (v) => String(v), (v) => { n = v; paint(); });
  const pS = slider('Active fraction', 1, 60, 1, p * 100, (v) => `${v} %`, (v) => { p = v / 100; paint(); });
  const eS = select('Overflow target', [['1e-3', '0.1 %'], ['1e-6', '1 in a million'], ['1e-9', '1 in a billion']], '1e-6', (v) => { eps = Number(v); paint(); });
  paint();
  return { el: shell('A reserved circuit against a shared link', nS.el, pS.el, h('div', { class: 'mc-row' }, h('label', { class: 'sw-lbl' }, 'overflow', eS)), plot, read,
    h('p', { class: 'sub' }, 'n independent sources, each sending at a fixed peak rate with probability p. A circuit reserves the peak for every source; a packet link needs only enough for the sources active at once, and queues the rest.')) };
}

// ---- the table's price and hit rate ------------------------------------------------------------------------------------------------

function hitRate(t: number, hosts: number, how: 'seq' | 'rand', ops = 12000): { hash: number; evict: number; lru: number } {
  const R = rng(5), T = new MacTable(t, 24);
  // random addresses: six random bytes, the first with its group bit clear (a unicast address)
  const addr = Array.from({ length: hosts }, (_, i) => (how === 'seq' ? addrOf(hostMac(0)) + i : addrOf(Array.from({ length: 6 }, (_k, b) => { const v = Math.floor(R() * 256); return b === 0 ? v & 0xfe : v; }))));
  const lru: number[] = [], cap = 2 ** t;
  let hit = 0, n = 0, lh = 0;
  for (let k = 0; k < ops; k++) {
    const si = Math.floor(R() * hosts); let di = Math.floor(R() * hosts); if (di === si) di = (di + 1) % hosts;
    const r = T.op(addr[di], addr[si], si % 4);
    const li = lru.indexOf(addr[di]);
    if (k >= ops / 3) { n++; if (r.hit) hit++; if (li >= 0) lh++; }
    const sj = lru.indexOf(addr[si]); if (sj >= 0) lru.splice(sj, 1); lru.push(addr[si]); if (lru.length > cap) lru.shift();
  }
  return { hash: hit / n, evict: T.evicted / ops, lru: lh / n };
}

export function tableWidget(): Widget {
  let t = 5, hosts = 24, how: 'seq' | 'rand' = 'seq';
  const read = h('div'), cost = h('div', { class: 'scroll' });
  const paint = () => {
    const r = hitRate(t, hosts, how);
    read.replaceChildren(reading(['entries', String(2 ** t)], ['hosts', String(hosts)], ['hit rate, hashed RAM', pct(r.hash)], ['hit rate, CAM with LRU', pct(r.lru)], ['evictions per frame (hashed)', r.evict.toFixed(3)]));
    const rows = [2, 3, 4, 5, 6, 7].map((k) => {
      const a = stats(macTable(k, 4)).nands, ram = stats(registry.get(`mac_table${k}_4_ram`)!).nands, c48 = stats(cam(k, 48)).nands, c59 = stats(cam(k, 59)).nands;
      return h('tr', { class: k === t ? 'sel' : '' }, h('td', null, String(2 ** k)), h('td', { class: 'num' }, n0(a)), h('td', { class: 'num' }, n0(ram)), h('td', { class: 'num' }, n0(c59)), h('td', { class: 'num' }, n0(c48)));
    });
    cost.replaceChildren(h('table', { class: 'uart-tbl' }, h('tr', null, h('th', null, 'entries'), h('th', null, 'table as built'), h('th', null, 'its two RAM blocks'), h('th', null, 'CAM, 59-bit entries'), h('th', null, 'CAM, 48-bit keys')), ...rows));
  };
  const tS = slider('Entries', 2, 7, 1, t, (v) => String(2 ** v), (v) => { t = v; paint(); });
  const hS = slider('Hosts', 4, 200, 2, hosts, (v) => String(v), (v) => { hosts = v; paint(); });
  const how_ = select('Address assignment', [['seq', 'consecutive NICs'], ['rand', 'random addresses']], how, (v) => { how = v as 'seq' | 'rand'; paint(); });
  paint();
  return { el: shell('The table: hashed in RAM against a CAM', tS.el, hS.el, h('div', { class: 'mc-row' }, h('label', { class: 'sw-lbl' }, 'addresses', how_)), read, cost,
    h('p', { class: 'sub' }, 'Uniform conversation among the hosts, 4 ports, no ageing. A miss is flooded; a CAM is exact up to its size, then replaces the least recently used entry. The hashed table pays for collisions at any size. Costs, in NANDs: the whole table as built (RAM, XOR-fold hash, comparators, ageing, four counters); only its two RAM blocks, which hold the 59-bit entries with two ports; and the library cam(k, w) at the entry width and at the key width. Compare the RAM blocks with the CAM columns, not the first column with them.')) };
}

// ---- store-and-forward against cut-through ----------------------------------------------------------------------------------------

const RATES: [string, number][] = [['10 Mb/s', 10e6], ['100 Mb/s', 100e6], ['1 Gb/s', 1e9], ['10 Gb/s', 10e9]];

export function latencyWidget(): Widget {
  let bytes = 512, rate = 100e6, bad = false; // bytes: the frame with its FCS, as the standard counts it
  const read = h('div'), meas = h('div');
  const paint = () => {
    const wire = (bytes + 8) * 8, saf = wire / rate, ct = ((8 + 14) * 8) / rate;
    read.replaceChildren(reading(['frame on the wire', `${bytes} B + 8 preamble = ${wire} bits`], ['store-and-forward adds', `${(saf * 1e6).toFixed(2)} µs`], ['cut-through adds (preamble + 14 B header)', `${(ct * 1e6).toFixed(2)} µs`], ['the difference', `${((saf - ct) * 1e6).toFixed(2)} µs`]));
    const len = Math.min(120, Math.max(60, bytes - 4));
    const a = singleFrame({ cellK: 7 }, len, bad), b = singleFrame({ cellK: 7, cut: true }, len, bad);
    const row = (name: string, r: ReturnType<typeof singleFrame>) => h('tr', null, h('td', null, name), h('td', { class: 'num' }, r.firstOut < 0 ? '—' : String(r.firstOut)), h('td', { class: 'num' }, r.lastOut < 0 ? '—' : String(r.lastOut)), h('td', { class: 'num' }, String(r.delivered)), h('td', { class: 'num' }, String(r.bad)));
    meas.replaceChildren(h('div', { class: 'scroll' }, h('table', { class: 'uart-tbl' }, h('tr', null, h('th', null, `the model the gates are checked against, a ${len}-byte frame, 1 byte a cycle`), h('th', null, 'first byte out (cycle)'), h('th', null, 'last byte out'), h('th', null, 'frames out'), h('th', null, 'bad FCS seen')), row('store-and-forward', a), row('cut-through', b))),
      h('p', { class: 'sub' }, bad ? 'The receiving MAC flags the frame at its last byte. Store-and-forward has not sent anything yet and drops it; cut-through has sent it all, and this bench has no way to mark it bad downstream.' : `The frame's last byte enters at cycle ${len - 1}. Store-and-forward starts after it; cut-through starts once the table has answered, about cycle 12 plus the lookup.`));
  };
  const bS = slider('Frame', 64, MAX_FRAME, 2, bytes, (v) => `${v} B`, (v) => { bytes = v; paint(); });
  const rSel = select('Link rate', RATES.map(([t]) => [t, t] as [string, string]), '100 Mb/s', (v) => { rate = RATES.find(([t]) => t === v)![1]; paint(); });
  const badBox = h('input', { type: 'checkbox', 'aria-label': 'The FCS is bad' }) as HTMLInputElement;
  badBox.addEventListener('change', () => { bad = badBox.checked; paint(); });
  paint();
  return { el: shell('One hop: when does the first byte leave?', bS.el, h('div', { class: 'mc-row' }, h('label', { class: 'sw-lbl' }, 'link', rSel), h('label', { class: 'sw-chk' }, badBox, ' bad FCS')), read, meas) };
}

// ---- head-of-line blocking ----------------------------------------------------------------------------------------------------------

const LOADS = [0.2, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];

export function holWidget(): Widget {
  let pattern: Pattern = 'uniform';
  let token = 0;
  const plot = h('div', { class: 'sw-plot' }), read = h('div'), prog = h('p', { class: 'sub' });
  interface Pt { fifo: number; voq4: number; voq8: number; voq16: number }
  let pts: (Pt | null)[] = [];
  const draw = () => {
    const W = 760, H = 300, L = 40, B = 26, T = 12, R = 12;
    const X = (v: number) => L + v * (W - L - R), Y = (v: number) => T + (1 - v) * (H - B - T);
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'sw-chart', role: 'img', 'aria-label': 'Throughput against offered load for one FIFO per input and for virtual output queues' });
    for (const v of [0, 0.25, 0.5, 0.75, 1]) svg.append(s('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), class: 'grid' }), s('text', { x: L - 4, y: Y(v) + 3, class: 'tick', 'text-anchor': 'end' }, v.toFixed(2)), s('text', { x: X(v), y: H - 8, class: 'tick', 'text-anchor': 'middle' }, v.toFixed(2)));
    svg.append(s('line', { x1: X(0), y1: Y(0), x2: X(1), y2: Y(1), class: 'ideal' }));
    for (const [v, t, dy] of [[HOL_N4, 'published, N = 4: 0.6553', -4], [HOL_LIMIT, 'published, large N: 0.5858', 12]] as const) svg.append(s('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), class: 'theory' }), s('text', { x: L + 6, y: Y(v) + dy, class: 'tick' }, t));
    const line = (key: keyof Pt, cls: string) => {
      const p = LOADS.map((l, i) => (pts[i] ? [l, pts[i]![key]] : null)).filter(Boolean) as number[][];
      if (p.length) svg.append(s('path', { d: p.map((q, i) => `${i ? 'L' : 'M'}${X(q[0])},${Y(q[1])}`).join(''), class: `ln ${cls}` }));
    };
    line('fifo', 'fifo'); line('voq4', 'voq'); line('voq8', 'voq8'); line('voq16', 'voq16');
    plot.replaceChildren(svg, h('div', { class: 'sw-key' }, h('span', { class: 'k fifo' }, 'one FIFO per input'), h('span', { class: 'k voq' }, 'VOQ, 4 cells'), h('span', { class: 'k voq8' }, 'VOQ, 8 cells'), h('span', { class: 'k voq16' }, 'VOQ, 16 cells'), h('span', { class: 'k ideal' }, 'ideal'), h('span', { class: 'k theory' }, 'published saturation')));
    const last = pts[LOADS.length - 1];
    read.replaceChildren(reading(['pattern', pattern], ['FIFO at full load', last ? last.fifo.toFixed(3) : '…'], ['VOQ, 4 / 8 / 16 cells', last ? `${last.voq4.toFixed(3)} / ${last.voq8.toFixed(3)} / ${last.voq16.toFixed(3)}` : '…'], ['abstract cells, N = 4', holSaturation(4, false, 200000, 3).toFixed(3)], ['abstract cells, N = 64', holSaturation(64, false, 6000, 3).toFixed(3)]));
  };
  const go = () => {
    const me = ++token; pts = LOADS.map(() => null); draw();
    let i = 0;
    const next = () => {
      if (me !== token) return;
      if (i >= LOADS.length) { prog.textContent = 'Measured on the golden model, 40 000 cycles a point, 64-byte frames, drop-on-full.'; return; }
      const load = LOADS[i], o = (voq: boolean, cells: number) => runTraffic({ pattern, load, frameBytes: 64, cycles: 40000, seed: 11, opts: { cellK: 7, voq, cells } }).throughput;
      pts[i] = { fifo: o(false, 4), voq4: o(true, 4), voq8: o(true, 8), voq16: o(true, 16) };
      i++; prog.textContent = `Measuring ${i} / ${LOADS.length} …`; draw();
      setTimeout(next, 0);
    };
    prog.textContent = 'Measuring …';
    setTimeout(next, 0);
  };
  const pS = select('Traffic pattern', [['uniform', 'uniform over the other three hosts'], ['permutation', 'permutation: A→B, B→C, C→D, D→A'], ['hotspot', 'hot spot: half the frames to host A']], pattern, (v) => { pattern = v as Pattern; go(); });
  draw();
  setTimeout(go, 0);
  return { el: shell('Throughput against offered load', h('div', { class: 'mc-row' }, h('label', { class: 'sw-lbl' }, 'traffic', pS)), plot, read, prog), destroy: () => { token++; } };
}

// ---- full duplex ---------------------------------------------------------------------------------------------------------------------------

/** Idealised slotted contention for n always-backlogged stations: a slot is won with probability A = (1 − 1/n)^(n − 1). */
export function sharedEfficiency(n: number, frameBits: number, slotBits = 512): number {
  const A = n <= 1 ? 1 : (1 - 1 / n) ** (n - 1), W = (1 - A) / A;
  return frameBits / (frameBits + W * slotBits);
}

export function duplexWidget(): Widget {
  let n = 4, bytes = 64;
  const read = h('div');
  const paint = () => {
    const frameBits = (bytes + 8 + 12) * 8;
    const e = sharedEfficiency(n, frameBits);
    read.replaceChildren(reading(['stations', String(n)], ['frame with preamble, FCS and gap', `${frameBits} bits`], ['shared wire, one conversation at a time', `${pct(e, 0)} of one link`], ['switch, each port full duplex, best case', `${n} × 2 links = ${2 * n}× one link, no collisions`]));
  };
  const nS = slider('Stations', 2, 16, 1, n, (v) => String(v), (v) => { n = v; paint(); });
  const bS = slider('Frame', 64, MAX_FRAME, 2, bytes, (v) => `${v} B`, (v) => { bytes = v; paint(); });
  paint();
  return { el: shell('One shared wire against a wire each way', nS.el, bS.el, read, h('p', { class: 'sub' }, 'Shared: the idealised slotted model of contention (probability that exactly one of n stations transmits in a slot, slot = 512 bit times, the 10 and 100 Mb/s Ethernet slot); real CSMA/CD with binary exponential backoff differs in detail. Switched: a port can carry a frame each way at once, and no two ports share a wire.')) };
}

