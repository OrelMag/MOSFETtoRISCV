// Does tshark read what Save capture writes (roadmap, Phase 21, decision 5)? Writes each chapter's capture as a .pcap, has tshark decode it, and holds every
// frame to what its bytes claim: no malformed packets, no warnings, every checksum verified good. The captures come from the gates and the frames the
// chapters use, not only from hand-built ones. A set of broken captures must be caught, or the check is worthless.
//   npx vite-node scripts/tshark-oracle.ts --out <dir> [--tshark <path>] [--only <substring>] [--no-gates] [--dump]
// --dump only writes the files (no tshark needed: Windows). Exits 1 on any difference. <dir> keeps every .pcap, tshark's output and summary.json.
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { captureRecord, CLOCK_NS } from '../src/comm/mac';
import { BROADCAST, frameBody } from '../src/comm/ethframe';
import { arpFrame, icmpEchoFrame, udpFrame } from '../src/comm/netframes';
import { pcapFile, type Captured } from '../src/comm/pcap';
import { stackProgram } from '../src/comm/stack';
import { DEFAULT_STACK } from '../src/comm/stack/all';
import { HOSTS, hostApp, pingApp, udpClientApp, udpEchoApp } from '../src/comm/stack/apps';
import { ethSwitch } from '../src/lib/ethswitch';
import { ethSegment, ethStationMac } from '../src/lib/ethstation';
import { lanComputers } from '../src/lib/lan';
import { DualSim } from '../src/sim/dualsim';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { pack } from '../src/sim/values';
import type { Stage } from '../src/view/stage';
import { segmentFrame } from '../src/widgets/ethernet2';
import { Rig } from '../src/widgets/ethswitch';
import { claimOf, compareCapture, FIELDS, parseRows, tsharkArgs, type Claim } from './tshark-lib';

const args = process.argv.slice(2);
const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const out = resolve(opt('--out') ?? 'tshark-report'), tshark = opt('--tshark') ?? 'tshark', only = opt('--only');
const dump = args.includes('--dump'), gates = !args.includes('--no-gates');

interface Case { name: string; frames: () => Captured[] | Promise<Captured[]> }

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

const CASES: Case[] = [
  { name: 'built', frames: built },
  ...(gates ? [
    { name: 'ch48-segment', frames: segmentCapture },
    { name: 'ch49-switch', frames: switchCapture },
    { name: 'ch50-ping', frames: () => lanCapture(pingApp(1, 32), hostApp(), 'done', 90_000) },
    { name: 'ch50-udp', frames: () => lanCapture(udpClientApp(3, 16), udpEchoApp(), 'done', 120_000) },
  ] : []),
];

// ---- broken on purpose: each of these must be reported ---------------------------------------------------------------------------------
const good = () => icmpEchoFrame({ srcMac: A.mac, dstMac: B.mac, src: A.ip, dst: B.ip, id: 9, ident: 7, seq: 1, data: [1, 2, 3, 4] }).bytes;
const goodUdp = () => udpFrame({ srcMac: A.mac, dstMac: B.mac, src: A.ip, dst: B.ip, id: 9, sport: 5000, dport: 7, data: [1, 2, 3, 4] }).bytes;
const flip = (b: number[], i: number) => { const c = [...b]; c[i] ^= 0x10; return c; };
interface Broken { name: string; frames: Captured[]; claims?: Claim[]; cut?: number; want: RegExp }
const BROKEN: Broken[] = [
  { name: 'bad-ip-checksum', frames: [{ us: 0, bytes: flip(good(), 24) }], want: /ip\.checksum\.status/ },
  { name: 'bad-icmp-checksum', frames: [{ us: 0, bytes: flip(good(), 36) }], want: /icmp\.checksum\.status/ },
  { name: 'bad-udp-checksum', frames: [{ us: 0, bytes: flip(goodUdp(), 40) }], want: /udp\.checksum\.status/ },
  { name: 'not-really-ipv4', frames: [{ us: 0, bytes: frameBody({ dst: B.mac, src: A.mac, type: 0x0800, payload: Array.from('hello from station 1', (c) => c.charCodeAt(0)) }) }], want: /ip\.|malformed|expert/ },
  { name: 'ip-longer-than-frame', frames: [{ us: 0, bytes: good().slice(0, 40) }], want: /malformed|expert|icmp|data/ },
  { name: 'a-wrong-claim', frames: [{ us: 0, bytes: good() }], claims: [{ ...claimOf(good(), 0), fields: { ...claimOf(good(), 0).fields, 'ip.src': '10.9.9.9' } }], want: /ip\.src/ },
  { name: 'a-wrong-time', frames: [{ us: 1_000_000, bytes: good() }], claims: [claimOf(good(), 2_000_000)], want: /time_epoch/ },
  { name: 'file-cut-short', frames: [{ us: 0, bytes: good() }, { us: 1, bytes: good() }], cut: 20, want: /tshark/ },
];

const runTshark = (file: Uint8Array): Promise<{ text: string; err: string; code: number }> => new Promise((ok) => {
  const p = execFile(tshark, tsharkArgs(), { maxBuffer: 1 << 26, timeout: 120_000 }, (e, so, se) => ok({ text: so, err: se, code: e ? (typeof e.code === 'number' ? e.code : 1) : 0 }));
  p.stdin!.on('error', () => {}); // it may stop reading early: its exit says why
  p.stdin!.end(file);
});

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'fields.txt'), FIELDS.join('\n'));

async function check(name: string, frames: Captured[], claims?: Claim[], cut = 0): Promise<string[]> {
  const file = join(out, `${name}.pcap`), whole = pcapFile(frames), bytes = cut ? whole.slice(0, whole.length - cut) : whole;
  writeFileSync(file, bytes);
  if (dump) return [];
  const r = await runTshark(bytes);
  writeFileSync(join(out, `${name}.tsv`), r.text);
  const problems = compareCapture(frames, parseRows(r.text), claims);
  if (r.code !== 0 || r.err.trim()) problems.unshift(`tshark exit ${r.code}: ${r.err.trim().slice(0, 300)}`);
  return problems;
}

const summary: Record<string, unknown> = {};
let failed = 0;
for (const c of CASES) {
  if (only && !c.name.includes(only)) continue;
  const t0 = Date.now();
  const frames = await c.frames(), problems = await check(c.name, frames);
  summary[c.name] = { frames: frames.length, kinds: [...new Set(frames.map((f) => claimOf(f.bytes, 0).chain))], problems };
  console.log(`${problems.length ? 'FAIL' : 'ok  '} ${c.name}: ${frames.length} frames, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  for (const p of problems.slice(0, 40)) console.log(`     ${p}`);
  if (frames.length === 0) { console.log('     no frames: nothing was checked'); failed++; }
  if (problems.length) failed++;
}
for (const b of BROKEN) {
  if (dump || (only && !b.name.includes(only))) continue;
  const problems = await check(`broken-${b.name}`, b.frames, b.claims, b.cut), caught = problems.some((p) => b.want.test(p));
  summary[`broken-${b.name}`] = { caught, problems };
  console.log(`${caught ? 'ok  ' : 'FAIL'} broken ${b.name}: ${caught ? 'caught' : `NOT caught, reported ${JSON.stringify(problems)}`}`);
  if (!caught) failed++;
}
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 1));
console.log(dump ? `tshark oracle: files written to ${out}, nothing compared` : failed ? `tshark oracle: ${failed} failed` : 'tshark oracle: all agree');
process.exit(failed ? 1 : 0);
