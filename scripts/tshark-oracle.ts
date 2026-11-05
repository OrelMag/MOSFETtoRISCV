// Does tshark read what Save capture writes (roadmap, Phase 21, decision 5)? Writes each chapter's capture as a .pcap, has tshark decode it, and holds every
// frame to what its bytes claim: no malformed packets, no warnings, every checksum verified good. The captures come from the gates and the frames the
// chapters use, not only from hand-built ones. A set of broken captures must be caught, or the check is worthless.
//   npx vite-node scripts/tshark-oracle.ts --out <dir> [--tshark <path>] [--only <substring>] [--no-gates] [--dump]
// --dump only writes the files (no tshark needed: Windows). Exits 1 on any difference. <dir> keeps every .pcap, tshark's output and summary.json.
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { captureRecord, CLOCK_NS } from '../src/comm/mac';
import { FastPathModel, S_RX } from '../src/net/fastpath';
import { hostIp, Internet, traceroute } from '../src/net/internet';
import { Resolver, SITE, TYPE_A, TYPE_NS, type DnsMessage } from '../src/net/internetdns';
import { BROADCAST, frameBody } from '../src/comm/ethframe';
import { arpFrame, icmpEchoFrame, udpFrame } from '../src/comm/netframes';
import { LINKTYPE_USB_2_0, pcapFile, type Captured } from '../src/comm/pcap';
import { CLOCK_NS, dataBytes, handshakeBytes, PID, REQ, setupData, sofBytes, tokenBytes, UsbBench, UsbMonitor, type BenchOptions, type Pump, type UsbHost } from '../src/comm/usb';
import { GateDev } from '../tests/usbkit';
import { stackProgram } from '../src/comm/stack';
import { DEFAULT_STACK } from '../src/comm/stack/all';
import { HOSTS, hostApp, pingApp, udpClientApp, udpEchoApp } from '../src/comm/stack/apps';
import { runSwitchSpec, SW_MAX_FRAME } from '../src/campaign/capcomm';
import { ethSwitch } from '../src/lib/ethswitch';
import { ethSegment, ethStationMac } from '../src/lib/ethstation';
import { lanComputers } from '../src/lib/lan';
import { DualSim } from '../src/sim/dualsim';
import { benchDone, tcpBench, type BenchOptions } from '../src/net/tcpbench';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { pack } from '../src/sim/values';
import type { Stage } from '../src/view/stage';
import { segmentFrame } from '../src/widgets/ethernet2';
import { Rig } from '../src/widgets/ethswitch';
import { LAPTOP, traceCapture, WWW } from '../src/widgets/internet';
import { CH_ADJ, CH_TRIE, FP_FRAMES, FP_INPUTS, ROUTER_SCENE_DEF } from '../src/widgets/router';
import { claimOf, compareCapture, FIELDS, parseRows, TCP_LOSS_WARNINGS, tsharkArgs, USB_FIELDS, usbClaimOf, type Claim } from './tshark-lib';

const args = process.argv.slice(2);
const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const out = resolve(opt('--out') ?? 'tshark-report'), tshark = opt('--tshark') ?? 'tshark', only = opt('--only');
const dump = args.includes('--dump'), gates = !args.includes('--no-gates');

interface Case { name: string; usb?: boolean; /** More tshark options for this capture. */ extra?: string[]; frames: () => Captured[] | Promise<Captured[]>; claims?: (frames: Captured[]) => Claim[]; allow?: RegExp; must?: (frames: Captured[]) => string | null }

// ---- hand-built: each protocol's frame by itself ----------------------------------------------------------------------------------
const A = HOSTS.A, B = HOSTS.B;
const built = (): Captured[] => {
  const hdr = { srcMac: A.mac, dstMac: B.mac, src: A.ip, dst: B.ip };
  const list = [
    arpFrame({ op: 1, sha: A.mac, spa: A.ip, tha: [0, 0, 0, 0, 0, 0], tpa: B.ip }).bytes,
    arpFrame({ op: 2, sha: B.mac, spa: B.ip, tha: A.mac, tpa: A.ip }).bytes,
    icmpEchoFrame({ ...hdr, id: 1, ident: 0x1234, seq: 1, data: Array.from({ length: 32 }, (_, i) => 16 + i) }).bytes,
    icmpEchoFrame({ ...hdr, id: 2, reply: true, ident: 0x1234, seq: 1, data: [] }).bytes,
    udpFrame({ ...hdr, id: 3, sport: 5000, dport: 7, data: [1, 2, 3, 4, 5] }).bytes,
    udpFrame({ ...hdr, id: 4, sport: 5000, dport: 7, data: [] }).bytes,
    udpFrame({ ...hdr, id: 5, sport: 5000, dport: 7, data: new Array<number>(1472).fill(0x5a) }).bytes,
    udpFrame({ ...hdr, id: 6, ttl: 1, sport: 5000, dport: 7, data: new Array<number>(19).fill(0xa5) }).bytes,
  ];
  // the widgets write frames padded to the minimum, without an FCS
  return list.map((b, i) => ({ us: i * 2_500_001, bytes: frameBody({ dst: b.slice(0, 6), src: b.slice(6, 12), type: (b[12] << 8) | b[13], payload: b.slice(14) }) }));
};

// ---- chapter 48: the frames its panel queues, through the gates of the segment, as station 4 keeps them ---------------------------
async function segmentCapture(): Promise<Captured[]> {
  const sim = new GateSim(flatten(ethSegment(4))), root = sim.design.root;
  sim.reset('zero');
  const set = (o: Record<string, number>) => { for (const [k, v] of Object.entries(o)) sim.setInput(k, v); sim.settle(); };
  const get = (p: string) => pack(sim.getBits(root.ports[p]));
  const host = (o: Record<string, number> = {}) => set({ rst: 0, sel: 0, wa: 0, wd: 0, we: 0, len: 0, go: 0, ra: 0, hrd: 0, promisc: 8, ...o });
  const tick = () => { set({ clk: 1 }); set({ clk: 0 }); };
  host({ rst: 1 }); tick(); tick();
  const bodies = [segmentFrame(0, 1, 'hello from station 1'), segmentFrame(1, 'all', 'hello everyone, a longer message')];
  bodies.forEach((b, k) => b.forEach((v, i) => { host({ sel: k, wa: i, wd: v, we: 1 }); tick(); }));
  host({ sel: 0, len: bodies[0].length, go: 1 }); tick(); host();
  const marks: { clock: number; from: number; to: number }[] = [];
  let last = 0;
  for (let c = 0; c < 9000; c++) {
    if (c === 3500) { host({ sel: 1, len: bodies[1].length, go: 1 }); tick(); host(); } else tick();
    const cp = get('cp3');
    if (cp !== last) { marks.push({ clock: c, from: last, to: cp }); last = cp; }
  }
  return marks.map((mk) => {
    const bytes: number[] = [];
    for (let a = mk.from; a < mk.to; a++) { host({ sel: 3, ra: a, hrd: 1 }); bytes.push(get('rd3')); }
    return captureRecord(mk.clock, bytes);
  });
}

// ---- chapter 49: the rig's own capture of a port, on a gate-level switch -------------------------------------------------------------
/** What the switch capstone's reference delivers on its bench, each frame as a port sent it. */
function capstoneSwitchCapture(): Captured[] {
  const out: Captured[] = [];
  const r = runSwitchSpec(ethSwitch({ cellK: 8 }), 'gate', (bytes) => out.push({ us: out.length * 100, bytes }));
  if (r.failures.length) throw new Error(`the reference fails its bench: ${r.failures[0]}`);
  return out;
}

async function switchCapture(): Promise<Captured[]> {
  const OPTS = { cellK: 7, tableK: 4, tickLog2: 5 }, def = ethSwitch(OPTS), sim = new GateSim(flatten(def));
  sim.reset('zero');
  for (const p of def.ports) if (p.dir === 'in') sim.setInput(p.name, 0);
  sim.settle();
  const stage = { sim } as unknown as Stage, rig = new Rig(OPTS);
  const run = (n: number) => { for (let i = 0; i < n; i++) { rig.before(stage); sim.setInput('clk', 1); sim.settle(); rig.after(); sim.setInput('clk', 0); sim.settle(); } };
  rig.teach(); run(500);
  rig.send(0, ethStationMac(1), 64); rig.send(0, BROADCAST, 80);
  run(1500);
  return [...rig.rxCaps[0], ...rig.txCaps[0]].sort((a, b) => a.us - b.us);
}

// ---- chapter 50: two computers and a switch on the gates, running the compiled stack -------------------------------------------------
async function lanCapture(appA: string, appB: string, until: string, max: number): Promise<Captured[]> {
  const a = stackProgram(DEFAULT_STACK, appA), b = stackProgram(DEFAULT_STACK, appB);
  if (a.compiled.error || b.compiled.error) throw new Error(`the stack does not compile: ${a.compiled.error ?? b.compiled.error}`);
  const sim = new DualSim(flatten(lanComputers(a.compiled.words, b.compiled.words)));
  sim.preferFast = true;
  sim.reset('zero'); sim.setInput('clk', 0); sim.settle(); sim.prepare(); sim.settle();
  const root = sim.design.root, get = (p: string) => pack(sim.getBits(root.ports[p]));
  let con = '';
  const frames: { clock: number; bytes: number[]; err: number }[] = [], cur: (number[] | null)[] = [null, null], start = [0, 0];
  for (let c = 0; c < max && !con.includes(until); c++) {
    if (get('consoleValidA') === 1) con += String.fromCharCode(get('consoleDataA'));
    for (const p of [0, 1]) {
      if (get(`rxValid${p}`) !== 1) continue;
      if (!cur[p]) { cur[p] = []; start[p] = c; }
      cur[p]!.push(get(`rxData${p}`));
      if (get(`rxLast${p}`) === 1) { frames.push({ clock: start[p], bytes: cur[p]!, err: get(`rxErr${p}`) }); cur[p] = null; }
    }
    sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle();
  }
  if (!con.includes(until)) throw new Error(`the run did not finish: ${con}`);
  // as widgets/net.ts does
  return frames.sort((x, y) => x.clock - y.clock).filter((f) => !f.err).map((f) => ({ us: (f.clock * CLOCK_NS) / 1000, bytes: f.bytes }));
}

// ---- chapter 51: the frames its panel sends that a reader can parse, in and out of the fast path's gates: the TTL and the checksum as the rewrite left them --------
function routerCapture(): Captured[] {
  const sim = new GateSim(flatten(ROUTER_SCENE_DEF)), root = sim.design.root, m = new FastPathModel(CH_TRIE, CH_ADJ);
  sim.reset('zero');
  const inputs: Record<string, number> = { ...FP_INPUTS };
  const set = (o: Record<string, number>) => { for (const [k, v] of Object.entries(o)) { inputs[k] = v; sim.setInput(k, v); } sim.settle(); };
  const get = (p: string) => pack(sim.getBits(root.ports[p]));
  set({ clk: 0 });
  const out: Captured[] = [];
  let clock = 0;
  const us = () => (clock * CLOCK_NS) / 1000;
  for (const n of [0, 1, 2, 3, 4, 5]) {
    const frame = FP_FRAMES[n].frame(), tx: number[] = [];
    out.push({ us: us(), bytes: frame });
    let i = 0;
    for (let guard = 0; guard < 4000; guard++) {
      const v = i < frame.length && m.s === S_RX, x = { rxd: v ? frame[i] : 0, rxv: v ? 1 : 0, rxl: v && i === frame.length - 1 ? 1 : 0, txr: 1 };
      set(x);
      if (get('txv') === 1) { tx.push(get('txd')); if (get('txl') === 1) { out.push({ us: us(), bytes: [...tx] }); tx.length = 0; } }
      m.step(x);
      if (v) i++;
      set({ clk: 1 }); set({ clk: 0 });
      clock++;
      if (i >= frame.length && m.s === S_RX && m.i === 0) break;
    }
  }
  return out;
}

// ---- chapter 53: the traceroute Save capture writes, and the resolver's messages, each record held to what the resolver meant to say ----------------------------------
const traceFrames = (): Captured[] => traceCapture(traceroute(new Internet(), LAPTOP, hostIp(WWW)));
const dnsSteps = () => new Resolver(new Internet()).resolve(LAPTOP, SITE, 0).steps;
const dnsFrames = (): Captured[] => { let us = 0; return dnsSteps().map((s) => { const f = { us: Math.round(us), bytes: s.frame }; us += s.ms * 1000; return f; }); };
const ipText = (v: number) => [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.');
/** What a message says beyond its header, from the resolver's own record of it, for tshark to read back through the compression pointers. */
function dnsClaim(m: DnsMessage, base: Claim): Claim {
  const rrs = [...m.answer, ...m.authority, ...m.additional], list = (x: (string | number)[]) => x.join('|');
  const a = rrs.filter((r) => r.type === TYPE_A), ns = rrs.filter((r) => r.type === TYPE_NS);
  const fields: Claim['fields'] = { ...base.fields, 'dns.qry.name': m.qname };
  if (rrs.length) { fields['dns.resp.name'] = list(rrs.map((r) => r.name)); fields['dns.resp.ttl'] = list(rrs.map((r) => r.ttl)); }
  if (a.length) fields['dns.a'] = list(a.map((r) => ipText(r.data as number)));
  if (ns.length) fields['dns.ns'] = list(ns.map((r) => r.data as string));
  return { ...base, fields };
}
const dnsClaims = (frames: Captured[]): Claim[] => { const steps = dnsSteps(); return frames.map((f, i) => dnsClaim(steps[i].msg, claimOf(f.bytes, f.us))); };
const icmpKinds = (frames: Captured[]) => new Set(frames.map((f) => { const b = f.bytes as number[]; return b[23] === 1 ? `${b[34]}.${b[35]}` : ''; }));

// ---- chapter 52: the Python TCP on the bench, a clean transfer as the router received it, open and close ------------------------------
function tcpCapture(bytes = 1000, o?: BenchOptions): Captured[] {
  const t = tcpBench(bytes, o);
  t.router.log = [];
  while (t.bench.c < 3_000_000 && !benchDone(t)) t.bench.clock();
  if (!benchDone(t)) throw new Error('the transfer did not finish');
  if (o && t.router.drops === 0) throw new Error('nothing was lost: this case checks nothing a clean transfer does not');
  return t.router.log.map((l) => ({ us: Math.round(l.t * CLOCK_NS / 1000), bytes: l.bytes }));
}

// ---- USB: every kind of packet by itself, then a transaction: the bytes the chapter's models and gates put on the bus ----------------------------------------
const GET_DEV8 = [0x80, 0x06, 0x00, 0x01, 0x00, 0x00, 0x08, 0x00];
const usbBuilt = (): Captured[] => [
  tokenBytes(PID.SETUP, 0, 0), dataBytes(PID.DATA0, GET_DEV8), handshakeBytes(PID.ACK),
  tokenBytes(PID.IN, 0, 0), dataBytes(PID.DATA1, [0x12, 0x01, 0x00, 0x02, 0x00, 0x00, 0x00, 0x08]), handshakeBytes(PID.ACK),
  tokenBytes(PID.OUT, 0, 0), dataBytes(PID.DATA1, []), handshakeBytes(PID.ACK),
  tokenBytes(PID.IN, 5, 1), handshakeBytes(PID.NAK), tokenBytes(PID.IN, 127, 15), handshakeBytes(PID.STALL), sofBytes(1429),
].map((bytes, i) => ({ us: i * 1_000, bytes }));

/** The gate-level device and the host model on the bus, every packet of the line read by the independent decoder (comm/usb.ts UsbMonitor): a capture as the chapter's Save capture writes it. */
function usbCapture(opt: BenchOptions): Captured[] {
  const b = new UsbBench(new GateDev(), opt);
  b.run(600_000);
  if (b.host.failed) throw new Error(`the host gave up: ${b.host.failed}`);
  const mon = new UsbMonitor();
  for (const [dp, dm] of b.line) mon.push(dp, dm);
  for (const s of mon.seen) if (!s.syncOk || s.stuffError || !s.byteAligned) throw new Error(`a packet at clock ${s.start} is not whole`);
  return mon.seen.map((s) => ({ us: (s.start * CLOCK_NS) / 1000, bytes: s.wire }));
}
/** Reads that end where a descriptor ends (or at its first 8 bytes), at several wLength: packets of every size the device sends. */
function* usbReads(h: UsbHost): Pump<void> {
  yield* h.quiet(40);
  yield* h.busReset();
  const get = (type: number, len: number) => setupData(0x80, REQ.GET_DESCRIPTOR, type << 8, 0, len);
  for (const len of [8, 18, 19, 30, 64]) yield* h.controlRead(0, get(1, len));
  for (const len of [9, 25, 26, 64]) yield* h.controlRead(0, get(2, len));
  yield* h.controlRead(0, setupData(0x80, REQ.GET_STATUS, 0, 0, 2));
}
/** Enumeration, then the things a clean enumeration does not show: STALL, the interrupt endpoint's NAK, a zero-length status, GET_STATUS. */
function* usbOdds(h: UsbHost): Pump<void> {
  yield* h.enumerate();
  const get = (type: number, req: number, value: number, len: number) => setupData(type, req, value, 0, len);
  yield* h.controlRead(5, get(0x80, REQ.GET_DESCRIPTOR, 0x0300, 8)); // a string descriptor: STALL
  yield* h.controlRead(5, get(0x80, REQ.GET_STATUS, 0, 2));
  yield* h.controlRead(5, get(0x80, 0x42, 0, 4)); // an unknown request: STALL
  yield* h.send(tokenBytes(PID.IN, 5, 1)); yield* h.recv(); yield* h.gap(40); // endpoint 1: NAK
  yield* h.controlRead(5, get(0x80, REQ.GET_DESCRIPTOR, 0x0100, 64));
}

const CASES: Case[] = [
  { name: 'built', frames: built },
  { name: 'usb-built', usb: true, frames: usbBuilt },
  ...(gates ? [
    { name: 'usb-enumeration', usb: true, frames: () => usbCapture({}), must: (f: Captured[]) => (f.length > 60 ? null : 'an enumeration is more than 60 packets') },
    // not every read length: the usb dissector reads the descriptors inside a control transfer and calls one cut short mid-descriptor
    // malformed (found by the first run of the full sweep: tests/comm-usb-gates.test.ts keeps those), so these are the ones a host asks for
    { name: 'usb-complete-reads', usb: true, frames: () => usbCapture({ script: usbReads }), must: (f: Captured[]) => (f.length > 100 ? null : 'the reads are more than 100 packets') },
    { name: 'usb-stall-nak', usb: true, frames: () => usbCapture({ script: usbOdds, nak: (c) => (c > 2800 && c < 3100 ? 1 : 0) }),
      must: (f: Captured[]) => (new Set(f.map((x) => (x.bytes as number[])[0])).has(0x5a) && new Set(f.map((x) => (x.bytes as number[])[0])).has(0x1e) ? null : 'NAK (5A) and STALL (1E) must both appear') },
  ] : []),
  ...(gates ? [
    { name: 'ch48-segment', frames: segmentCapture },
    { name: 'ch49-switch', frames: switchCapture },
    { name: 'capstone-switch', frames: capstoneSwitchCapture, must: (f) => (f.some((x) => (x.bytes as number[]).length === SW_MAX_FRAME) && f.some((x) => (x.bytes as number[])[0] === 0x01) ? null : `the bench must deliver a ${SW_MAX_FRAME}-byte frame and a group frame`) },
    { name: 'ch50-ping', frames: () => lanCapture(pingApp(1, 32), hostApp(), 'done', 90_000) },
    { name: 'ch50-udp', frames: () => lanCapture(udpClientApp(3, 16), udpEchoApp(), 'done', 120_000) },
    { name: 'ch51-router', frames: routerCapture, must: (f) => (f.filter((x) => (x.bytes as number[])[22] === 63).length === 3 ? null : 'three frames must leave the gates with TTL 63') },
    { name: 'ch52-tcp', frames: () => tcpCapture() },
    // the chapter's "A short queue", the run that loses segments: Save capture writes this too
    { name: 'ch52-tcp-loss', frames: () => tcpCapture(1500, { queue: 3, byteClocks: 400, delay: 10_000 }), allow: TCP_LOSS_WARNINGS },
    { name: 'ch53-traceroute', frames: traceFrames, must: (f) => { const k = icmpKinds(f); return k.has('11.0') && k.has('3.3') ? null : 'a trace must hold time exceeded and port unreachable'; } },
    { name: 'ch53-dns', frames: dnsFrames, claims: dnsClaims },
  ] : []),
];

// ---- broken on purpose: each of these must be reported ---------------------------------------------------------------------------------
const good = () => icmpEchoFrame({ srcMac: A.mac, dstMac: B.mac, src: A.ip, dst: B.ip, id: 9, ident: 7, seq: 1, data: [1, 2, 3, 4] }).bytes;
const goodUdp = () => udpFrame({ srcMac: A.mac, dstMac: B.mac, src: A.ip, dst: B.ip, id: 9, sport: 5000, dport: 7, data: [1, 2, 3, 4] }).bytes;
/** A forwarded frame whose TTL fell with the checksum left alone: what a broken rewrite would send. */
const staleChecksum = () => { const c = FP_FRAMES[0].frame(); c[22] -= 1; return c; };
/** A question whose name is a pointer to itself, with the UDP and IP checksums made right so that only the name is wrong. */
function dnsLoop(): number[] {
  const f = [...dnsSteps()[0].frame], t = 34, d = t + 8;
  f[d + 12] = 0xc0; f[d + 13] = 12;
  f[t + 6] = 0; f[t + 7] = 0; // UDP's checksum off: 0 means none
  return f;
}
const flip = (b: number[], i: number) => { const c = [...b]; c[i] ^= 0x10; return c; };
interface Broken { name: string; usb?: boolean; frames: Captured[]; claims?: Claim[]; cut?: number; want: RegExp }
const dnsGood = () => dnsSteps()[3];
const usbFlip = (b: number[], i: number, m = 0x10) => { const c = [...b]; c[i] ^= m; return c; };
const BROKEN: Broken[] = [
  { name: 'usb-bad-crc5', usb: true, frames: [{ us: 0, bytes: usbFlip(tokenBytes(PID.SETUP, 3, 0), 1, 0x01) }], claims: [usbClaimOf(tokenBytes(PID.SETUP, 3, 0), 0)], want: /usbll.(crc5|device_addr)/ },
  { name: 'usb-bad-crc16', usb: true, frames: [{ us: 0, bytes: usbFlip(dataBytes(PID.DATA0, GET_DEV8), 3) }], want: /usbll.crc16/ },
  { name: 'usb-wrong-claim', usb: true, frames: [{ us: 0, bytes: tokenBytes(PID.IN, 5, 0) }], claims: [usbClaimOf(tokenBytes(PID.IN, 6, 0), 0)], want: /usbll.device_addr/ },
  { name: 'usb-bad-pid-check', usb: true, frames: [{ us: 0, bytes: [0xd1] }], want: /expert|usbll.pid|protocols|malformed/ },
  { name: 'dns-wrong-record', frames: [{ us: 0, bytes: dnsGood().frame }], claims: [dnsClaim({ ...dnsGood().msg, qname: 'www.other.example' }, claimOf(dnsGood().frame, 0))], want: /dns\.qry\.name/ },
  { name: 'dns-pointer-to-itself', frames: [{ us: 0, bytes: dnsLoop() }], claims: [dnsClaim(dnsSteps()[0].msg, claimOf(dnsLoop(), 0))], want: /dns\.qry\.name/ },
  { name: 'router-ttl-not-updated', frames: [{ us: 0, bytes: staleChecksum() }], want: /ip\.checksum\.status/ },
  { name: 'bad-ip-checksum', frames: [{ us: 0, bytes: flip(good(), 24) }], want: /ip\.checksum\.status/ },
  { name: 'bad-icmp-checksum', frames: [{ us: 0, bytes: flip(good(), 36) }], want: /icmp\.checksum\.status/ },
  { name: 'bad-udp-checksum', frames: [{ us: 0, bytes: flip(goodUdp(), 40) }], want: /udp\.checksum\.status/ },
  { name: 'not-really-ipv4', frames: [{ us: 0, bytes: frameBody({ dst: B.mac, src: A.mac, type: 0x0800, payload: Array.from('hello from station 1', (c) => c.charCodeAt(0)) }) }], want: /ip\.|malformed|expert/ },
  { name: 'ip-longer-than-frame', frames: [{ us: 0, bytes: good().slice(0, 40) }], want: /malformed|expert|icmp|data/ },
  { name: 'a-wrong-claim', frames: [{ us: 0, bytes: good() }], claims: [{ ...claimOf(good(), 0), fields: { ...claimOf(good(), 0).fields, 'ip.src': '10.9.9.9' } }], want: /ip\.src/ },
  { name: 'a-wrong-time', frames: [{ us: 1_000_000, bytes: good() }], claims: [claimOf(good(), 2_000_000)], want: /time_epoch/ },
  { name: 'file-cut-short', frames: [{ us: 0, bytes: good() }, { us: 1, bytes: good() }], cut: 20, want: /cut short/ },
];

const runTshark = (file: string, usb = false, extra: string[] = []): Promise<{ text: string; err: string; code: number }> => new Promise((ok) => {
  const pipe = 'f=$1; t=$2; shift 2; cat "$f" | "$t" "$@"';
  execFile('sh', ['-c', pipe, 'sh', file, tshark, ...tsharkArgs(usb ? USB_FIELDS : FIELDS, extra)], { maxBuffer: 1 << 26, timeout: 120_000 }, (e, so, se) => ok({ text: so, err: se, code: e ? (typeof e.code === 'number' ? e.code : 1) : 0 }));
});

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'fields.txt'), FIELDS.join('\n'));

async function check(name: string, frames: Captured[], claims?: Claim[], cut = 0, allow?: RegExp, usb = false, extra: string[] = []): Promise<string[]> {
  const file = join(out, `${name}.pcap`), whole = pcapFile(frames, usb ? LINKTYPE_USB_2_0 : undefined), bytes = cut ? whole.slice(0, whole.length - cut) : whole;
  writeFileSync(file, bytes);
  if (dump) return [];
  const r = await runTshark(file, usb, extra);
  writeFileSync(join(out, `${name}.tsv`), r.text);
  const problems = compareCapture(frames, parseRows(r.text, usb ? USB_FIELDS : FIELDS), claims ?? (usb ? frames.map((f) => usbClaimOf(f.bytes, Math.max(0, Math.round(f.us)))) : undefined), allow);
  if (r.code !== 0 || r.err.trim()) problems.unshift(`tshark exit ${r.code}: ${r.err.trim().slice(0, 300)}`);
  return problems;
}

const REQUIRED = ['eth:ethertype:arp', 'eth:ethertype:ip:icmp', 'eth:ethertype:ip:udp', 'eth:ethertype:ip:tcp', 'eth:ethertype:ip:udp:dns'];
const seen = new Set<string>();
const summary: Record<string, unknown> = {};
let failed = 0;
for (const c of CASES) {
  if (only && !c.name.includes(only)) continue;
  const t0 = Date.now();
  const frames = await c.frames(), problems = await check(c.name, frames, c.claims?.(frames), 0, c.allow, c.usb, c.extra);
  const short = c.must?.(frames);
  if (short) problems.unshift(short);
  if (c.name !== 'built' && !c.usb) for (const f of frames) seen.add(claimOf(f.bytes, 0).chain);
  summary[c.name] = { frames: frames.length, kinds: c.usb ? ['usbll'] : [...new Set(frames.map((f) => claimOf(f.bytes, 0).chain))], problems };
  console.log(`${problems.length ? 'FAIL' : 'ok  '} ${c.name}: ${frames.length} frames, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  for (const p of problems.slice(0, 40)) console.log(`     ${p}`);
  if (frames.length === 0) { console.log('     no frames: nothing was checked'); failed++; }
  if (problems.length) failed++;
}
for (const b of BROKEN) {
  if (dump || (only && !b.name.includes(only))) continue;
  const problems = await check(`broken-${b.name}`, b.frames, b.claims, b.cut, undefined, b.usb), caught = problems.some((p) => b.want.test(p));
  summary[`broken-${b.name}`] = { caught, problems };
  console.log(`${caught ? 'ok  ' : 'FAIL'} broken ${b.name}: ${caught ? 'caught' : `NOT caught, reported ${JSON.stringify(problems)}`}`);
  if (!caught) failed++;
}
// the real captures between them must hold every protocol we claim to check: a chapter that stops sending one must not pass by silence
if (!only && gates && !dump) for (const want of REQUIRED) if (!seen.has(want)) { console.log(`FAIL no real capture holds ${want}`); failed++; }
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 1));
console.log(dump ? `tshark oracle: files written to ${out}, nothing compared` : failed ? `tshark oracle: ${failed} failed` : 'tshark oracle: all agree');
process.exit(failed ? 1 : 0);
