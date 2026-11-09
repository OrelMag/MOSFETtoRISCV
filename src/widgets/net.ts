// Chapter glass's widgets (Computers on a network): the path a byte takes from software to the wire, the descriptor ring, the checksum worked by hand and on
// the CPU, frames field by field, the NIC on a loopback bench, two computers and a switch with their consoles and a capture, and the cost of a packet.
// Models: comm/nic.ts (the NIC), comm/netframes.ts (frames and the checksum), the stack in comm/stack/ (Python compiled for the CPU).

import '../styles/clocks.css';
import '../styles/uart.css';
import '../styles/net.css';
import { CLOCK_NS } from '../comm/mac';
import { arpFrame, checksum, dissect, icmpEchoFrame, ip4, ipText, onesSum, udpFrame, type Built, type Layer } from '../comm/netframes';
import { pcapFile, type Captured } from '../comm/pcap';
import { runPy } from '../lang/interp';
import { DEFAULT_STACK } from '../comm/stack/all';
import { hostApp, PING_DATA, pingApp } from '../comm/stack/apps';
import { stackProgram } from '../comm/stack';
import NET_COSTS from '../comm/stack/netcosts.json';
import { lanComputers, nicLoopback } from '../lib/lan';
import { assemble } from '../riscv/asm';
import { nicIrqSource, nicPollSource } from '../riscv/nicprograms';
import { findNode } from '../sim/flatten';
import { h, s } from '../ui/dom';
import { saveFile } from '../view/image';
import type { Scene, Stage, Widget } from '../view/stage';
import { dmaRx, dmaTx, MIN_FRAME_TIME, PING_FRAME, PING_FRAME_TIME, wireBytes, wireClocks } from '../comm/stack/netfacts';
import { slider } from './mosparts';
import { btn, outAt, outp, pulse, select, waveSvg } from './uart';
import { numOf } from '../chapters/order';
import { groupNum } from '../sim/numfmt';

/**
 * Like uart.ts's Loop, but each tick simulates for a time budget instead of a fixed number of steps: a computer pair on the cycle engine runs at a few
 * thousand clocks a second, so a fixed batch would hold the page for most of every tick. One history checkpoint at the start.
 */
class SliceLoop {
  private t: ReturnType<typeof setTimeout> | null = null;
  constructor(private stage: Stage, private step: () => boolean, private after: () => void, private budgetMs = 18, private gapMs = 6) {}
  get running(): boolean { return this.t !== null; }
  start(): void {
    if (this.t) return;
    this.stage.checkpoint();
    const tick = () => {
      const end = performance.now() + this.budgetMs;
      let go = true;
      do go = this.step(); while (go && performance.now() < end);
      this.stage.refresh(); this.after();
      this.t = go ? setTimeout(tick, this.gapMs) : null;
      if (!go) this.after();
    };
    this.t = setTimeout(tick, 0);
  }
  stop(): void { if (this.t) clearTimeout(this.t); this.t = null; this.after(); }
}

const hex2 = (v: number) => v.toString(16).padStart(2, '0');
const hex4 = (v: number) => v.toString(16).padStart(4, '0');
const n0 = (x: number) => groupNum(Math.round(x));
const words = (src: string): number[] => { const a = assemble(src); if (a.errors.length) throw new Error(a.errors[0].message); return a.words; };

export { dmaRx, dmaTx, wireBytes, wireClocks };

const LAYER_NAME: Record<Layer, string> = { eth: 'Ethernet', arp: 'ARP', ip: 'IPv4', icmp: 'ICMP', udp: 'UDP', tcp: 'TCP', data: 'data', pad: 'padding', fcs: 'FCS' };

// ---- the path ---------------------------------------------------------------------------------------------------------

export function pathWidget(): Widget {
  let n = 32;
  const box = h('div'), read = h('div', { class: 'mc-status' });
  const paint = () => {
    const sizes: [string, number, string][] = [['Application data', n, 'what the program put in the buffer'], ['ICMP header', 8, 'type, code, checksum, identifier, sequence'], ['IPv4 header', 20, 'addresses, length, TTL, protocol, checksum'], ['Ethernet header', 14, 'destination, source, EtherType']];
    const frame = n + 8 + 20 + 14, pad = Math.max(0, 60 - frame);
    const rows = [...sizes, ...(pad ? [['Padding', pad, 'the MAC fills a short frame to 60 bytes'] as [string, number, string]] : []), ['FCS', 4, 'CRC-32 added by the MAC'], ['Preamble and SFD', 8, 'seven 0x55 and 0xD5: the receiver finds its bit clock']];
    const total = wireBytes(frame);
    const tbl = h('table', { class: 'net-fields' }, h('tr', null, h('th', null, 'Layer'), h('th', null, 'Bytes'), h('th', null, 'Added by')));
    const who = ['the program', 'icmp.ts', 'ip.ts', 'ip_send, eth.ts', 'the MAC', 'the MAC', 'the MAC'];
    rows.forEach(([name, bytes, note], i) => tbl.append(h('tr', null, h('td', null, name), h('td', { class: 'hex' }, String(bytes)), h('td', null, `${who[Math.min(i, who.length - 1)] ?? ''} ${note ? '· ' + note : ''}`))));
    box.replaceChildren(h('div', { class: 'net-wide' }, tbl));
    read.replaceChildren(h('span', null, 'on the wire ', h('b', null, `${total} bytes`)), h('span', null, 'cable busy ', h('b', null, `${n0(wireClocks(frame))} clocks`)), h('span', null, 'at 3.95 ns ', h('b', null, `${(wireClocks(frame) * CLOCK_NS / 1000).toFixed(1)} µs`)),
      h('span', null, 'payload share ', h('b', null, `${(100 * n / total).toFixed(0)} %`)));
  };
  const sl = slider('Echo data', 0, 86, 1, n, (v) => String(v), (v) => { n = v; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos clk-w net-w' }, h('div', { class: 'panel' }, h('h3', null, 'From a buffer to the wire'), sl.el, box, read,
    h('p', { class: 'sub' }, 'Each layer prepends its header; the MAC wraps the result. One byte takes 32 clocks on this link (a bit every 4 clocks).'))) };
}

// ---- the descriptor ring ----------------------------------------------------------------------------------------------

export function ringWidget(): Widget {
  const N = 8;
  const own: boolean[] = Array(N).fill(true); // true: the NIC holds it
  let nicHead = 0, swHead = 0, bad = 0, frames = 0;
  const log: string[] = [];
  const svg = s('svg', { viewBox: '0 0 420 270', class: 'net-ring', role: 'img', 'aria-label': 'A ring of eight receive descriptors: the NIC fills the one at its head, the software drains the one at its own' }) as SVGSVGElement;
  const logEl = h('div', { class: 'net-log', 'aria-live': 'polite' });
  const say = (t: string) => { log.push(t); if (log.length > 6) log.shift(); };
  const paint = () => {
    svg.replaceChildren();
    for (let i = 0; i < N; i++) {
      const a = (i / N) * 2 * Math.PI - Math.PI / 2, cx = 210 + 92 * Math.cos(a), cy = 130 + 92 * Math.sin(a);
      svg.append(s('rect', { x: cx - 30, y: cy - 20, width: 60, height: 40, rx: 6, class: `slot${own[i] ? ' nic' : ''}${i === nicHead ? ' head' : ''}` }),
        s('text', { x: cx, y: cy - 4 }, `#${i}`), s('text', { x: cx, y: cy + 11 }, own[i] ? 'OWN=1' : 'OWN=0'));
    }
    svg.append(s('text', { x: 210, y: 122, class: 'lab' }, `NIC head ${nicHead}`), s('text', { x: 210, y: 140, class: 'lab' }, `software ${swHead}`), s('text', { x: 210, y: 158, class: 'lab' }, `frames ${frames}, bad ${bad}`));
    logEl.replaceChildren(...log.map((t) => h('div', null, t)));
  };
  const arrive = (good: boolean) => {
    if (!own[nicHead]) { say(`frame arrives, descriptor #${nicHead} is the software's (OWN=0): dropped, STATUS.MISS`); paint(); return; }
    if (!good) { bad++; say(`frame arrives, written into buffer ${nicHead}; FCS wrong: the descriptor is left alone, the next frame overwrites the buffer`); paint(); return; }
    own[nicHead] = false; frames++; say(`frame arrives, written into buffer ${nicHead}, then word 1 = length, OWN cleared (commit); head moves to ${(nicHead + 1) % N}`);
    nicHead = (nicHead + 1) % N; paint();
  };
  const take = () => {
    if (own[swHead]) { say(`software looks at #${swHead}: OWN=1, the NIC still has it: nothing there`); paint(); return; }
    own[swHead] = true; say(`software reads buffer ${swHead}, hands the descriptor back (OWN=1)`); swHead = (swHead + 1) % N; paint();
  };
  paint();
  return { el: h('div', { class: 'widget mos clk-w net-w' }, h('div', { class: 'panel' }, h('h3', null, 'A receive ring'),
    h('div', { class: 'mc-row' }, btn('Frame arrives', 'A good frame reaches the NIC', () => arrive(true)), btn('Bad frame arrives', 'A frame with a wrong FCS reaches the NIC', () => arrive(false)), btn('Software polls', 'The driver looks at its descriptor', take)),
    svg, logEl, h('p', { class: 'sub' }, 'The NIC and the software never write the same word at the same time: the one who sets OWN gives the descriptor away and does not touch it again until it comes back.'))) };
}

// ---- the checksum ----------------------------------------------------------------------------------------------------

const PARSE = (t: string): number[] => (t.replace(/[^0-9a-fA-F]/g, '').match(/../g) ?? []).map((x) => parseInt(x, 16));

export function checksumWidget(): Widget {
  const input = h('textarea', { class: 'net-hexin', 'aria-label': 'Bytes in hexadecimal', spellcheck: 'false' }, '45 00 00 73 00 00 40 00 40 11 00 00 c0 a8 00 01 c0 a8 00 c7') as HTMLTextAreaElement;
  const out = h('div'), cpu = h('div', { class: 'mc-status' });
  const paint = () => {
    const b = PARSE(input.value).slice(0, 64);
    const ws = Array.from({ length: Math.ceil(b.length / 2) }, (_, i) => (b[2 * i] << 8) | (b[2 * i + 1] ?? 0));
    let run = 0;
    const cells: HTMLElement[] = [];
    for (const w of ws) { const before = run; run += w; cells.push(h('span', null, `${hex4(w)} `, h('span', { class: 'c' }, run > 0xffff && before <= 0xffff ? '+carry' : ''))); }
    const folded = onesSum(b), ck = checksum(b);
    out.replaceChildren(h('div', { class: 'net-sum' }, ...cells),
      h('div', { class: 'mc-status' }, h('span', null, 'sum of the words ', h('b', null, `0x${run.toString(16)}`)), h('span', null, 'carries folded back ', h('b', null, `0x${hex4(folded)}`)), h('span', null, 'complement = the checksum ', h('b', null, `0x${hex4(ck)}`)),
        h('span', null, 'a block with its checksum in sums to 0xffff: ', h('b', { class: folded === 0xffff ? 'net-ok' : '' }, folded === 0xffff ? 'this one does' : 'this one does not'))));
    // the same sum on the CPU's Python: the stack's ones_sum, run on the reference interpreter
    try {
      const prog = `${b.map((v, i) => `store8(${4096 + i}, ${v})`).join('\n')}\nprint(ones_sum(4096, ${b.length}, 0))\n`;
      const r = runPy(stackProgram(DEFAULT_STACK, prog).source, { maxSteps: 400000 });
      const got = r.output[0];
      cpu.replaceChildren(h('span', null, 'ones_sum() in the stack, run on the Python reference: ', h('b', { class: got === folded ? 'net-ok' : 'net-bad' }, `0x${hex4(got ?? 0)}`), got === folded ? ' (agrees)' : ' (differs)'));
    } catch { cpu.replaceChildren(h('span', null, 'ones_sum() could not run here')); }
  };
  input.addEventListener('input', paint);
  const setHdr = (t: string) => btn(t, 'Load an example', () => { input.value = EXAMPLES[t]; paint(); });
  const EXAMPLES: Record<string, string> = { 'IPv4 header': '45 00 00 73 00 00 40 00 40 11 00 00 c0 a8 00 01 c0 a8 00 c7', 'RFC 1071 §3': '00 01 f2 03 f4 f5 f6 f7', 'Odd length': '01 02 03', 'All ones': 'ff ff ff ff' };
  paint();
  return { el: h('div', { class: 'widget mos clk-w net-w' }, h('div', { class: 'panel' }, h('h3', null, 'The Internet checksum'),
    h('div', { class: 'mc-row' }, ...Object.keys(EXAMPLES).map(setHdr)), input, out, cpu,
    h('p', { class: 'sub' }, 'Sixteen-bit words added with the carry brought around (ones\' complement), then inverted. Any order of the words gives the same sum, and a changed word changes it, with a few exceptions: a word 0x0000 turned into 0xffff, or two words swapped, leave it as it was.'))) };
}

// ---- frames field by field ---------------------------------------------------------------------------------------------

type Kind = 'arp-req' | 'arp-rep' | 'echo-req' | 'echo-rep' | 'udp';
const KIND_LABEL: [Kind, string][] = [['arp-req', 'ARP request'], ['arp-rep', 'ARP reply'], ['echo-req', 'ICMP echo request'], ['echo-rep', 'ICMP echo reply'], ['udp', 'UDP datagram']];
const A_MAC = [2, 0, 0, 0, 0, 1], B_MAC = [2, 0, 0, 0, 0, 2];

export function frameWidget(kinds: Kind[] = ['arp-req', 'arp-rep', 'echo-req', 'echo-rep', 'udp']): Widget {
  let kind: Kind = kinds[0], seq = 1, text = 'abcd';
  const dump = h('div'), table = h('div', { class: 'net-wide' }), sums = h('div'), key = h('div', { class: 'net-key' });
  const build = (): Built => {
    const A = ip4(10, 0, 0, 1), B = ip4(10, 0, 0, 2);
    switch (kind) {
      case 'arp-req': return arpFrame({ op: 1, sha: A_MAC, spa: A, tha: [0, 0, 0, 0, 0, 0], tpa: B });
      case 'arp-rep': return arpFrame({ op: 2, sha: B_MAC, spa: B, tha: A_MAC, tpa: A });
      case 'echo-req': return icmpEchoFrame({ srcMac: A_MAC, dstMac: B_MAC, src: A, dst: B, id: 1, ident: 0x1234, seq, data: Array.from({ length: PING_DATA }, (_, i) => 16 + i) });
      case 'echo-rep': return icmpEchoFrame({ srcMac: B_MAC, dstMac: A_MAC, src: B, dst: A, id: 1, ident: 0x1234, seq, data: Array.from({ length: PING_DATA }, (_, i) => 16 + i), reply: true });
      case 'udp': return udpFrame({ srcMac: A_MAC, dstMac: B_MAC, src: A, dst: B, id: 1, sport: 1234, dport: 7, data: [...text].slice(0, 16).map((c) => c.charCodeAt(0) & 255) });
    }
  };
  let hot = -1;
  let paint = () => {
    const f = build();
    const owner: { layer: Layer; field: number }[] = [];
    f.fields.forEach((fl, k) => fl.bytes.forEach(() => owner.push({ layer: fl.layer, field: k })));
    const rows: HTMLElement[] = [];
    for (let o = 0; o < f.bytes.length; o += 16) {
      const row = h('div', { class: 'row' });
      f.bytes.slice(o, o + 16).forEach((b, i) => row.append(h('span', { class: `b${owner[o + i].field === hot ? ' on' : ''}`, 'data-l': owner[o + i].layer }, hex2(b))));
      rows.push(h('div', { class: 'off' }, o.toString(16).padStart(4, '0')), row);
    }
    dump.replaceChildren(h('div', { class: 'net-dump', role: 'group', 'aria-label': 'The frame in hexadecimal' }, ...rows));
    const tb = h('table', { class: 'net-fields' }, h('tr', null, h('th', null, 'Layer'), h('th', null, 'Field'), h('th', null, 'Bytes'), h('th', null, 'Value')));
    f.fields.forEach((fl, k) => {
      const tr = h('tr', { 'data-l': fl.layer, tabindex: '0' }, h('td', { class: 'lay' }, LAYER_NAME[fl.layer]), h('td', null, fl.name), h('td', { class: 'hex' }, fl.bytes.slice(0, 12).map(hex2).join(' ') + (fl.bytes.length > 12 ? ' …' : '')), h('td', null, fl.value));
      const on = () => { hot = k; paint(); };
      tr.addEventListener('mouseenter', on); tr.addEventListener('focus', on);
      tb.append(tr);
    });
    table.replaceChildren(tb);
    key.replaceChildren(...[...new Set(f.fields.map((x) => x.layer))].map((l) => h('span', { 'data-l': l }, LAYER_NAME[l])));
    // the checksums, worked: the IP header's ten words, then the transport's
    const ipf = f.fields.filter((x) => x.layer === 'ip');
    sums.replaceChildren();
    if (ipf.length) {
      const hdr = ipf.flatMap((x) => x.bytes), zeroed = hdr.map((v, i) => (i === 10 || i === 11 ? 0 : v));
      const ws = Array.from({ length: 10 }, (_, i) => (zeroed[2 * i] << 8) | zeroed[2 * i + 1]);
      sums.append(h('div', { class: 'cpu-sec' }, 'IPv4 header checksum'), h('div', { class: 'net-sum' }, ...ws.map((w) => h('span', null, hex4(w)))),
        h('div', { class: 'mc-status' }, h('span', null, 'sum ', h('b', null, `0x${hex4(onesSum(zeroed))}`)), h('span', null, '~sum ', h('b', null, `0x${hex4(checksum(zeroed))}`)), h('span', null, 'in the frame ', h('b', null, `0x${hex4((hdr[10] << 8) | hdr[11])}`))));
    }
  };
  const sel = select('Kind', KIND_LABEL.filter(([k]) => kinds.includes(k)), kind, (v) => { kind = v as Kind; paint(); });
  const seqSl = slider('Sequence', 1, 9, 1, seq, (v) => String(v), (v) => { seq = v; paint(); });
  const txt = h('input', { type: 'text', value: text, maxlength: 16, class: 'uart-text', 'aria-label': 'UDP data' }) as HTMLInputElement;
  txt.addEventListener('input', () => { text = txt.value; paint(); });
  // the sequence slider belongs to an echo, the text to a datagram
  const paintControls = () => { seqSl.el.style.display = kind.startsWith('echo') ? '' : 'none'; txt.style.display = kind === 'udp' ? '' : 'none'; };
  const basePaint = paint;
  paint = () => { basePaint(); paintControls(); };
  paint();
  return { el: h('div', { class: 'widget mos clk-w net-w' }, h('div', { class: 'panel' }, h('h3', null, 'A frame, field by field'), h('div', { class: 'mc-row' }, sel, ...(kinds.some((k) => k.startsWith('echo')) ? [seqSl.el] : []), ...(kinds.includes('udp') ? [txt] : [])),
    key, dump, table, sums, h('p', { class: 'sub' }, 'Computed by comm/netframes.ts, a second implementation of what the Python stack builds on the CPU; a test compares them byte for byte. Hover a row to find its bytes.'))) };
}

// ---- the cost of a packet -------------------------------------------------------------------------------------------


export interface CostRow { who: 'a' | 'b'; what: string; instr: number; clocks: number; loads: number; stores: number; layers: Record<string, { instr: number; clocks: number }> }
const WHAT: Record<string, string> = { arp_request: 'send an ARP request', icmp_echo: 'send an echo request' };
export function costRows(): CostRow[] {
  const seen = new Set<string>();
  return (NET_COSTS.windows as unknown as { computer: 'a' | 'b'; entry: string; visited: string[]; total: { instr: number; clocks: number; loads: number; stores: number }; layers: CostRow['layers'] }[]).map((w) => {
    let what = WHAT[w.entry] ?? 'handle a frame';
    if (w.entry === 'eth_input') what = w.visited.includes('icmp_input') ? (w.visited.includes('ip_send') ? 'handle an echo request, send the reply' : 'handle an echo reply') : w.visited.includes('tx_commit') ? 'handle an ARP request, send the reply' : 'handle an ARP reply';
    const key = `${w.computer}${what}`;
    seen.add(key);
    return { who: w.computer, what, instr: w.total.instr, clocks: w.total.clocks, loads: w.total.loads, stores: w.total.stores, layers: w.layers };
  });
}

export function costWidget(): Widget {
  const rows = costRows();
  const layers = ['eth', 'arp', 'ip', 'icmp', 'bytes'];
  const tbl = h('table', { class: 'net-frames' }, h('tr', null, h('th', null, 'Computer'), h('th', null, 'Work'), h('th', null, 'Instr.'), h('th', null, 'Clocks'), h('th', null, 'Loads'), h('th', null, 'Stores'), ...layers.map((l) => h('th', { title: 'clocks in this layer' }, l))));
  for (const r of rows) tbl.append(h('tr', null, h('td', null, r.who.toUpperCase()), h('td', null, r.what), h('td', { class: 'num' }, String(r.instr)), h('td', { class: 'num' }, String(r.clocks)), h('td', { class: 'num' }, String(r.loads)), h('td', { class: 'num' }, String(r.stores)),
    ...layers.map((l) => h('td', { class: 'num' }, r.layers[l] ? String(r.layers[l].clocks) : '–'))));
  const wire = `A frame shorter than 60 bytes is padded to 60, so an ARP packet (42 bytes) holds the cable for ${n0(MIN_FRAME_TIME)} clocks; the ping's echo is ${PING_FRAME} bytes and holds it for ${n0(PING_FRAME_TIME)}, the 12-byte gap included`;
  return { el: h('div', { class: 'widget mos clk-w net-w' }, h('div', { class: 'panel' }, h('h3', null, 'What a packet costs the computers'), h('div', { class: 'net-wide' }, tbl),
    h('div', { class: 'mc-status' }, h('span', null, 'round trip of the first ping ', h('b', null, `${n0(NET_COSTS.rtt)} clocks`)), h('span', null, `${(NET_COSTS.rtt * CLOCK_NS / 1000).toFixed(1)} µs at 3.95 ns`), h('span', null, 'one polling pass ', h('b', null, `${NET_COSTS.pollPass.b} clocks`))),
    h('p', { class: 'sub' }, `Measured on the gates over the first ping and the ARP exchange before it, by program counter, the retire strobe and the bus handshakes of every clock; the stack is ${NET_COSTS.words.a} and ${NET_COSTS.words.b} instructions. ${wire}.`))) };
}

// ---- the NIC on a bench -----------------------------------------------------------------------------------------------

export interface NicApi { run(): void; clocks(): number; result(): { done: boolean; kick: number; seen: number; len: number; setup: number; back: number } }
const nicApis = new WeakMap<Stage, NicApi>();
export const nicApi = (st: Stage) => nicApis.get(st);

export function nicScene(irq = false): Scene {
  const src = irq ? nicIrqSource() : nicPollSource();
  return {
    root: nicLoopback(words(src)), inputs: { clk: 0 }, autoClock: false, engine: 'cycle',
    panels: [(stage: Stage): Widget => {
      let clocks = 0, txen: number[] = [], irqH: number[] = [];
      const reg = (i: number) => { const n = findNode(stage.sim!.design.root, ['c', 'cpu', 'rf', `w${i}`]); return n ? (outAt(stage, ['c', 'cpu', 'rf', `w${i}`], 'q') >>> 0) : 0; };
      const result = () => ({ done: reg(23) === 1, kick: reg(20), seen: reg(21), len: reg(24), setup: reg(25), back: reg(26) });
      const status = h('div', { class: 'mc-status' }), strip = h('div', { class: 'uart-svg' });
      const after = () => { clocks++; if (clocks % 8 === 0) { txen.push(outp(stage, 'txen')); irqH.push(outAt(stage, ['c', 'nic'], 'irq')); if (txen.length > 480) { txen = txen.slice(-480); irqH = irqH.slice(-480); } } };
      const hook = { before: () => {}, after };
      stage.edgeHooks.add(hook);
      const loop = new SliceLoop(stage, () => { pulse(stage, 'clk'); after(); return !result().done; }, () => paint());
      const paint = () => {
        run.textContent = loop.running ? 'Pause' : 'Run';
        const r = result();
        status.replaceChildren(h('span', null, 'clocks ', h('b', null, n0(clocks))), h('span', null, 'pc ', h('b', null, `0x${(outp(stage, 'pcOut') >>> 0).toString(16)}`)),
          h('span', null, 'doorbell at ', h('b', null, r.kick ? n0(r.kick) : '–')), h('span', null, 'frame seen at ', h('b', null, r.seen ? n0(r.seen) : '–')), h('span', null, 'length ', h('b', null, r.len ? String(r.len) : '–')),
          h('span', null, 'NIC irq ', h('b', null, String(outAt(stage, ['c', 'nic'], 'irq')))));
        strip.replaceChildren(waveSvg(txen, 480, -1, 1, [], 'txen over the last 3840 clocks (one point every 8)'), ...(irq ? [waveSvg(irqH, 480, -1, 1, [], 'The NIC interrupt line')] : []));
      };
      const run = btn('Run', 'Clock the computer until the driver has the frame back', () => { if (loop.running) loop.stop(); else { loop.start(); paint(); } }, 'btn sm primary');
      nicApis.set(stage, { run: () => { if (!loop.running) { loop.start(); paint(); } }, clocks: () => clocks, result });
      stage.resetHooks.add(() => { clocks = 0; txen = []; irqH = []; paint(); });
      stage.historyHooks.add({ save: () => ({ clocks, txen: [...txen], irqH: [...irqH] }), restore: (v) => { const x = v as { clocks: number; txen: number[]; irqH: number[] }; clocks = x.clocks; txen = x.txen; irqH = x.irqH; paint(); } });
      paint();
      const el = h('div', { class: 'mem-panel cpu-panel mc-panel clk-panel', 'data-dock': 'right', 'data-fold': 'narrow', 'data-phone': 'flow' }, h('h4', null, irq ? 'A frame to itself, by interrupt' : 'A frame to itself, polled', h('span', { class: 'fold-hint' })),
        h('div', { class: 'mc-row' }, run), status, h('div', { class: 'cpu-sec' }, 'txen: the cable is busy'), strip,
        h('p', { class: 'sub' }, irq ? 'The driver enables the receive interrupt and counts in a loop; the NIC raises irq when it has committed the frame, and the handler hands the buffer back.' : 'The driver builds a 64-byte frame addressed to itself, rings the doorbell and spins on the receive descriptor. Open the NIC (one level down) to follow the descriptor fetch and the DMA.'));
      return { el, update: paint, destroy: () => { loop.stop(); stage.edgeHooks.delete(hook); } };
    }],
  };
}

// ---- two computers and a switch ---------------------------------------------------------------------------------------

export interface LanApi { run(): void; consoleOf(side: 'A' | 'B'): string; frames(): { clock: number; from: 'A' | 'B'; bytes: number[]; err: boolean }[]; clocks(): number; pcap(): Uint8Array }
const lanApis = new WeakMap<Stage, LanApi>();
export const lanApi = (st: Stage) => lanApis.get(st);

/** The ping scene's two programs (compiled once). */
let lanProgs: { a: number[]; b: number[] } | undefined;
const lanWords = () => {
  if (!lanProgs) {
    const a = stackProgram(DEFAULT_STACK, pingApp(3, PING_DATA)), b = stackProgram(DEFAULT_STACK, hostApp());
    if (a.compiled.error || b.compiled.error) throw new Error('the stack does not compile');
    lanProgs = { a: a.compiled.words, b: b.compiled.words };
  }
  return lanProgs;
};

export function lanScene(): Scene {
  const w = lanWords();
  return {
    root: lanComputers(w.a, w.b), inputs: { clk: 0 }, autoClock: false, engine: 'cycle', clock: 'clk',
    panels: [(stage: Stage): Widget => {
      let clocks = 0, started = 0;
      const text = { A: '', B: '' };
      const frames: { clock: number; from: 'A' | 'B'; bytes: number[]; err: boolean }[] = [];
      const cur: (number[] | null)[] = [null, null];
      let first = [0, 0];
      let sel = -1;
      const cons = { A: h('pre', { class: 'uart-console', 'aria-label': 'Console A' }), B: h('pre', { class: 'uart-console', 'aria-label': 'Console B' }) };
      const list = h('div', { class: 'net-wide' }), detail = h('div'), read = h('div', { class: 'mc-status' });
      // what the panel sees of every rising edge: before it (the consoles and the switch's receive streams as they are) and after it (the count). The stage's Pulse, Step and Run reach the same hooks.
      const before = () => {
        for (const S of ['A', 'B'] as const) if (outp(stage, `consoleValid${S}`) === 1) text[S] += String.fromCharCode(outp(stage, `consoleData${S}`));
        for (const p of [0, 1] as const) {
          if (outp(stage, `rxValid${p}`) === 1) {
            if (!cur[p]) { cur[p] = []; first[p] = clocks; }
            cur[p]!.push(outp(stage, `rxData${p}`));
            if (outp(stage, `rxLast${p}`) === 1) { frames.push({ clock: first[p], from: p === 0 ? 'A' : 'B', bytes: cur[p]!, err: outp(stage, `rxErr${p}`) === 1 }); cur[p] = null; frames.sort((x, y) => x.clock - y.clock); }
          }
        }
      };
      const after = () => { clocks++; };
      const hook = { before, after };
      stage.edgeHooks.add(hook);
      let t0 = 0, c0 = 0; // wall time and clock count when the loop last started: the speed readout counts from there
      const loop = new SliceLoop(stage, () => { before(); pulse(stage, 'clk'); after(); return !text.A.includes('done'); }, () => paint());
      const paint = () => {
        run.textContent = loop.running ? 'Pause' : 'Run';
        cons.A.textContent = text.A || ' '; cons.B.textContent = text.B || ' ';
        const secs = started ? (performance.now() - t0) / 1000 : 0;
        read.replaceChildren(h('span', null, 'clocks ', h('b', null, n0(clocks))), h('span', null, 'time ', h('b', null, `${(clocks * CLOCK_NS / 1000).toFixed(1)} µs`)), h('span', null, 'frames on the cable ', h('b', null, String(frames.length))),
          ...(loop.running || secs ? [h('span', null, 'speed ', h('b', null, secs > 0.5 ? `${n0((clocks - c0) / secs)} clocks/s` : '…'))] : []));
        const tb = h('table', { class: 'net-frames' }, h('tr', null, h('th', null, '#'), h('th', null, 'µs'), h('th', null, 'From'), h('th', null, 'Bytes'), h('th', null, 'Frame')));
        frames.forEach((f, i) => {
          const tr = h('tr', { tabindex: '0', 'aria-selected': String(i === sel), role: 'row' }, h('td', { class: 'num' }, String(i + 1)), h('td', { class: 'num' }, (f.clock * CLOCK_NS / 1000).toFixed(1)), h('td', null, f.from), h('td', { class: 'num' }, String(f.bytes.length)), h('td', null, f.err ? 'bad FCS' : dissect(f.bytes)));
          const pick = () => { sel = i; paint(); };
          tr.addEventListener('click', pick); tr.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter' || (e as KeyboardEvent).key === ' ') pick(); });
          tb.append(tr);
        });
        list.replaceChildren(tb);
        const f = frames[sel];
        detail.replaceChildren(...(f ? [h('div', { class: 'net-dump' }, ...Array.from({ length: Math.ceil(f.bytes.length / 16) }, (_, r) => [h('div', { class: 'off' }, (16 * r).toString(16).padStart(4, '0')), h('div', { class: 'row' }, ...f.bytes.slice(16 * r, 16 * r + 16).map((b, i) => h('span', { class: 'b', 'data-l': layerAt(f.bytes, 16 * r + i) }, hex2(b))))]).flat())] : []));
      };
      const api: LanApi = {
        run: () => { if (!loop.running) { t0 = performance.now(); c0 = clocks; started = 1; loop.start(); paint(); } },
        consoleOf: (side) => text[side], frames: () => frames, clocks: () => clocks,
        pcap: () => pcapFile(frames.filter((f) => !f.err).map((f): Captured => ({ us: f.clock * CLOCK_NS / 1000, bytes: f.bytes }))),
      };
      lanApis.set(stage, api);
      stage.historyHooks.add({
        save: () => ({ sel, started, clocks, a: text.A, b: text.B, frames: frames.map((f) => ({ ...f, bytes: [...f.bytes] })), cur: cur.map((c) => (c ? [...c] : null)), first: [...first] }),
        restore: (v) => { const x = v as { sel: number; started: number; clocks: number; a: string; b: string; frames: typeof frames; cur: (number[] | null)[]; first: number[] }; clocks = x.clocks; text.A = x.a; text.B = x.b; frames.length = 0; frames.push(...x.frames); cur[0] = x.cur[0]; cur[1] = x.cur[1]; first = x.first; sel = x.sel < frames.length ? x.sel : -1; started = x.started; t0 = performance.now(); c0 = clocks; paint(); },
      });
      stage.resetHooks.add(() => { clocks = 0; text.A = text.B = ''; frames.length = 0; cur[0] = cur[1] = null; sel = -1; started = 0; paint(); });
      const run = btn('Run', 'Clock both computers and the switch', () => { if (loop.running) loop.stop(); else api.run(); }, 'btn sm primary');
      const save = btn('Save capture', 'Write the frames seen so far as a .pcap file Wireshark or tcpdump opens', () => saveFile('ping.pcap', new Blob([api.pcap().slice().buffer], { type: 'application/vnd.tcpdump.pcap' }), 'application/vnd.tcpdump.pcap'));
      paint();
      const el = h('div', { class: 'mem-panel cpu-panel mc-panel clk-panel uart-two net-w', 'data-dock': 'right', 'data-fold': 'narrow', 'data-phone': 'flow' }, h('h4', null, 'A pings B', h('span', { class: 'fold-hint' })),
        h('div', { class: 'mc-row' }, run, save), read,
        h('div', { class: 'uart-cons2' }, h('div', null, h('div', { class: 'cpu-sec' }, 'Console A'), cons.A), h('div', null, h('div', { class: 'cpu-sec' }, 'Console B'), cons.B)),
        h('div', { class: 'cpu-sec' }, 'Frames at the switch'), list, detail,
        h('p', { class: 'sub' }, `Both computers run the stack of this chapter, compiled from Python, on the gates of chapter ${numOf('bus')} with a NIC; the switch is chapter ${numOf('switch')}'s. About 28 000 clocks to the first reply: seconds to tens of seconds at the speed shown.`));
      return { el, update: paint, destroy: () => { loop.stop(); stage.edgeHooks.delete(hook); } };
    }],
  };
}

/** The layer of byte i of a captured frame, for the dump's colours. */
function layerAt(b: number[], i: number): string {
  if (i < 14) return 'eth';
  const type = (b[12] << 8) | b[13];
  if (type === 0x0806) return i < 42 ? 'arp' : 'pad';
  if (type !== 0x0800) return 'data';
  if (i < 34) return 'ip';
  const total = (b[16] << 8) | b[17], end = 14 + total;
  if (i >= end) return 'pad';
  return b[23] === 1 ? (i < 42 ? 'icmp' : 'data') : b[23] === 17 ? (i < 42 ? 'udp' : 'data') : 'data';
}

void ipText;
