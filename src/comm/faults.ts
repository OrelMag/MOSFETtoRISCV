// The expert's bench (DOM-free): networks with a fault really in them, and the evidence an engineer would have. Every case runs one of the
// book's models with the fault switched on (net/tcpsim, phys/line, comm/startstop, comm/macexp, comm/ethframe, comm/ethswitch, net/internet, phys/radio, comm/wifi)
// and reads what comes out; nothing here is drawn or typed. `healthy` runs the same case with the fault off, and tests/comm-faults.test.ts
// holds that the symptom comes with the fault and goes without it.

import { ACK, FIN, SYN } from '../net/tcp';
import { runTcp, type SimOptions, type SimResult } from '../net/tcpsim';
import { hostFrame, hostId, HOSTS, Internet, ROUTERS, ASES, LINKS, linkKey, linkBetween, AS_SABLE, hostIp, type Journey } from '../net/internet';
import { berOf, eye, prbs, rng } from '../phys/line';
import { fsplDb, linkBudget, logDistanceDb, WALL_DB, type BudgetResult } from '../phys/radio';
import { frameBytes, parseFrame } from './ethframe';
import { MacTable } from './ethswitch';
import { addrOf, runLoad } from './macexp';
import { receive, UART_8N1 } from './startstop';
import { Air, KIND_DATA, KIND_NAMES, RATES, rateRun } from './wifi';

export type Evidence =
  | { kind: 'series'; title: string; xLabel: string; yLabel: string; lines: { name: string; xs: number[]; ys: number[] }[] }
  | { kind: 'lines'; title: string; lines: string[] }
  | { kind: 'counters'; title: string; rows: [string, string][] }
  /** A noiseless waveform folded on the bit period, with the noise the receiver sees on it. */
  | { kind: 'eye'; title: string; wave: number[]; spu: number; sigma: number };

export type FaultFamily = 'tcp' | 'line' | 'serial' | 'ethernet' | 'routing' | 'radio';

export interface FaultCase {
  id: string;
  family: FaultFamily;
  /** What a user would report. */
  symptom: string;
  evidence: Evidence[];
  /** Causes to choose from, the right one first (the view shuffles them). */
  options: string[];
  /** What the evidence showed, for after the answer. */
  why: string;
  /** Per wrong option, what the evidence says against it. */
  against: string[];
  /** What the case's check reads: the symptom, as numbers. */
  metrics: Record<string, number>;
}

const pct = (x: number) => `${(100 * x).toFixed(1)} %`;
/** A value in 1 … n from a seed, for a case's details. */
const pick = (seed: number, salt: number, n: number): number => Math.floor(rng(seed * 2654435 + salt + 1)() * n);

// ---- TCP ------------------------------------------------------------------------------------------------------------------------------

const TCP_OPTIONS = ['Packets are being lost on the line', 'The receiving program reads too slowly', 'A queue on the path holds far too much', 'A queue on the path is too small for the burst'];

const flagText = (f: number) => [f & SYN ? 'SYN' : '', f & FIN ? 'FIN' : '', f & ACK ? 'ACK' : ''].filter(Boolean).join(' ');

/** The segments as a capture would list them, from the first sign of trouble, or from the middle. */
function captureOf(r: SimResult, n = 8): string[] {
  const first = r.segs.findIndex((s) => s.retrans || (s.from === 'b' && s.seg.wnd === 0));
  const from = Math.max(0, first >= 0 ? first - 2 : r.segs.length >> 1);
  return r.segs.slice(from, from + n).map((s) => {
    const dir = s.from === 'a' ? 'A → B' : 'B → A';
    const fate = s.fate === 'lost' ? '  [lost]' : s.fate === 'queue' ? '  [dropped: queue full]' : '';
    return `${String(s.t).padStart(9)}  ${dir}  ${flagText(s.seg.flags).padEnd(3)} seq ${s.seg.seq}  ack ${s.seg.ack}  win ${s.seg.wnd}  len ${s.seg.data.length}${s.retrans ? '  [retransmission]' : ''}${fate}`;
  });
}

function tcpCase(id: string, o: Omit<SimOptions, 'bytes'>, symptom: string, right: number, why: string, against: string[]): FaultCase {
  const r = runTcp({ bytes: 8000, ...o });
  const n = r.rtts.length, tail = r.rtts.slice(Math.floor(n / 2));
  const late = tail.reduce((a, b) => a + b, 0) / Math.max(1, tail.length);
  const stride = Math.max(1, Math.floor(r.trace.length / 200)), pts = r.trace.filter((_, i) => i % stride === 0);
  const rstride = Math.max(1, Math.floor(n / 200));
  const zero = r.segs.filter((s) => s.from === 'b' && s.seg.wnd === 0).length;
  const options = [TCP_OPTIONS[right], ...TCP_OPTIONS.filter((_, i) => i !== right)];
  return {
    id, family: 'tcp', symptom, options, why, against,
    evidence: [
      { kind: 'series', title: 'Bytes in flight', xLabel: 'clocks', yLabel: 'bytes', lines: [{ name: 'in flight', xs: pts.map((p) => p.t), ys: pts.map((p) => p.flight) }] },
      { kind: 'series', title: 'Round-trip time, measured by the sender', xLabel: 'sample', yLabel: 'clocks', lines: [{ name: 'round trip', xs: r.rtts.filter((_, i) => i % rstride === 0).map((_, i) => i * rstride), ys: r.rtts.filter((_, i) => i % rstride === 0) }] },
      { kind: 'lines', title: 'The capture, at the sender', lines: captureOf(r) },
      { kind: 'counters', title: 'Counters', rows: [
        ['Retransmitted segments', String(r.retrans)], ['Timeouts', String(r.timeouts)], ['Zero windows from the receiver', String(zero)],
        ['Line errors on the path', String(r.losses)], ['Dropped by a full queue', String(r.drops)],
      ] },
    ],
    metrics: { retrans: r.retrans, losses: r.losses, drops: r.drops, zero, first: r.rtts[0], late, done: r.doneAt },
  };
}

// ---- the cases ----------------------------------------------------------------------------------------------------------------------------

const FAST = 16, SLOW = 200;

/** All four read the same to the person reporting it: telling them apart is the evidence's job. */
const SLOW_COPY = 'A long copy between two machines runs far below what the line should carry. Nothing is broken that anybody can see.';

function tcpLoss(seed: number, healthy: boolean): FaultCase {
  return tcpCase('tcp_loss', { byteClocks: FAST, lossPct: healthy ? 0 : 2 + pick(seed, 1, 3), seed }, SLOW_COPY, 0,
    'Retransmissions and timeouts with the round trip flat, and the line\'s own error counter counting. The bytes are going missing on the line, and the sender keeps backing off.',
    ['The window never closes: the receiver is keeping up.', 'A queue holding too much would lengthen the round trip, and here it stays flat.', 'The queue\'s drop counter reads zero. These are line errors.']);
}
function tcpReader(seed: number, healthy: boolean): FaultCase {
  return tcpCase('tcp_reader', healthy ? { byteClocks: FAST } : { byteClocks: FAST, readEvery: 30000 + 5000 * pick(seed, 2, 4), readBytes: 64 }, SLOW_COPY, 1,
    'The receiver keeps advertising a window of zero, and the sender stops and waits. Nothing is lost and the round trip is steady: the network is idle, waiting on the far program.',
    ['No line errors and no retransmissions.', 'The round trip does not grow.', 'Nothing was dropped.']);
}
function tcpBloat(seed: number, healthy: boolean): FaultCase {
  return tcpCase('tcp_bloat', { byteClocks: healthy ? FAST : SLOW + 20 * pick(seed, 3, 4), queue: 64 }, SLOW_COPY, 2,
    'The round trip climbs as the bytes in flight fill the queue, and stays high, with nothing lost. Everything else that shares this line now waits behind the same data.',
    ['Nothing was lost: no retransmissions at all.', 'The window stays open: the receiver is keeping up.', 'A queue too small would drop packets, and none were dropped.']);
}
function tcpTiny(seed: number, healthy: boolean): FaultCase {
  return tcpCase('tcp_tiny', { byteClocks: SLOW + 20 * pick(seed, 4, 4), queue: healthy ? 64 : 2 }, SLOW_COPY, 3,
    'Bursts arrive faster than the slow line drains them, and a queue of two frames throws the rest away: the queue\'s drop counter climbs while the line error counter stays at zero.',
    ['The line error counter reads zero: these drops happen at a queue.', 'The window stays open.', 'A queue holding too much would not drop anything, and this one does.']);
}

const LINE_OPTIONS = ['Too little bandwidth for this rate', 'Too much noise on the channel', 'The clocks at the two ends disagree', 'The sender is transmitting too slowly'];
const LINK_ERRORS = 'A fast link on a new board shows errors. The same design worked on an earlier prototype.';

function lineCase(id: string, band: number, sigma: number, right: number, why: string, against: string[]): FaultCase {
  const rate = 8, e = eye(prbs(9, 1022), { rate, bandwidth: band }), ber = e.opening > 0 ? berOf(e.opening / 2, sigma) : 0.5;
  const take = Math.min(e.wave.length, 400 * e.spu);
  return {
    id, family: 'line', symptom: LINK_ERRORS, why, against, options: [LINE_OPTIONS[right], ...LINE_OPTIONS.filter((_, i) => i !== right)],
    evidence: [
      { kind: 'eye', title: `The eye at ${rate} Gb/s`, wave: Array.from(e.wave.slice(0, take)), spu: e.spu, sigma },
      // the wave runs over ±1, so a swing is 2
      { kind: 'counters', title: 'At the receiver', rows: [['Eye height, without the noise', e.opening > 0 ? `${(e.opening * 50).toFixed(0)} % of the swing` : 'closed'], ['Noise, RMS', `${(sigma * 50).toFixed(0)} % of the swing`], ['Bit error rate', ber > 0.01 ? ber.toFixed(2) : ber.toExponential(0)]] },
    ],
    metrics: { opening: e.opening, ber },
  };
}
function lineBand(seed: number, healthy: boolean): FaultCase {
  return lineCase('line_band', healthy ? 4 : 0.5 + 0.1 * pick(seed, 5, 3), 0.02, 0,
    'The traces are thin, so there is little noise, and they stop short of the rails: each bit is shaped by the ones before it. That is the channel\'s band falling short of the rate.',
    ['The noise reads small: thin traces are not noise.', 'A clock error would not make the traces stop short of the rails.', 'The bit period is the rate asked for.']);
}
function lineNoise(seed: number, healthy: boolean): FaultCase {
  return lineCase('line_noise', 4, healthy ? 0.02 : 0.3 + 0.05 * pick(seed, 6, 3), 1,
    'Without the noise the eye is wide open, so the band is plenty. The spread around it is the noise, and that is what leaves the error rate where it is.',
    ['The eye height without the noise is large: the channel keeps its shape.', 'A clock error would not fatten every trace evenly at every point.', 'The bit period is the rate asked for.']);
}

/** Letters have their top two bits different, digits and punctuation the same; only the first reads wrong when the last sample lands one bit early. */
const CONSOLE_TEXTS = ['BOOT 42, OK', 'LOAD 1024: DONE', 'READY 7, GO', 'CHECK 88: PASS'];

function uartClock(seed: number, healthy: boolean): FaultCase {
  // a receiver fast by 6.3 to 7 %: its sample of the last data bit lands in the bit before, and nothing earlier moves
  const err = healthy ? 0.01 : 0.063 + 0.003 * pick(seed, 7, 3), text = CONSOLE_TEXTS[pick(seed, 8, CONSOLE_TEXTS.length)];
  let wrong = 0, framing = 0;
  const lines = [...text].map((ch) => {
    const code = ch.charCodeAt(0), r = receive(UART_8N1, code, { err });
    if (r.word !== code) wrong++;
    if (!r.stopOk) framing++;
    return `sent ${code.toString(2).padStart(8, '0')} '${ch}'   read ${r.word.toString(2).padStart(8, '0')}${r.word !== code ? '  wrong' : ''}${r.stopOk ? '' : '  framing error'}`;
  });
  return {
    id: 'uart_clock', family: 'serial', symptom: 'A console on one board prints garbled text. Some characters come through intact.',
    options: ['The clocks at the two ends disagree', 'Noise on the line is flipping bits', 'The line is too long for this rate', 'The data pin is wired backwards'],
    why: 'Wrong bytes differ only in the top bit, the last one sent, and only where it differs from the bit before: letters fail, and digits and punctuation read right. Every character also has a framing error, because the stop sample has drifted into the last data bit. The receiver re-times on each start edge and drifts across the character: over about 5 % of total error is too much for 8N1.',
    against: ['Noise would hit any bit of any character, at random.', 'A long line rounds every edge, and would not spare the earlier bits.', 'Inverted data would make every character wrong from its start bit.'],
    evidence: [{ kind: 'lines', title: 'What was sent and what was read, most significant bit first', lines }, { kind: 'counters', title: 'Counters', rows: [['Characters wrong', `${wrong} of ${text.length}`], ['Framing errors', String(framing)]] }],
    metrics: { wrong, framing, chars: text.length },
  };
}

const ETH_OPTIONS = ['Too many stations on a shared segment', 'A damaged cable or connector', 'A switch table too small for its hosts', 'One machine flooding the network'];
const ethOptions = (right: number) => [ETH_OPTIONS[right], ...ETH_OPTIONS.filter((_, i) => i !== right)];

function ethCollide(seed: number, healthy: boolean): FaultCase {
  const load = healthy ? 0.1 : 0.85 + 0.05 * pick(seed, 9, 2), r = runLoad({ n: 8, payload: 46, load, clocks: 300000, seed: seed + 1 });
  return {
    id: 'eth_collide', family: 'ethernet', symptom: 'Eight machines share an old hub. In the morning it is fine; when everybody syncs at once, nobody gets much done.',
    options: ethOptions(0),
    why: `The wire carries frames ${pct(r.throughput)} of the time while stations ask for ${pct(r.offered)}, with ${r.collisions} collisions. On a shared segment more offered load means more collisions, and throughput flattens well short of the rate.`,
    against: ['A damaged cable would not make collisions rise with the load.', 'A hub has no table.', 'The stations\' frames are shared out evenly: no one machine stands out.'],
    evidence: [{ kind: 'counters', title: 'The segment, over the period', rows: [['Offered load', pct(r.offered)], ['Time carrying frames', pct(r.throughput)], ['Collisions', String(r.collisions)], ['Frames sent, by station', r.sent.join(' ')]] }],
    metrics: { collisions: r.collisions, offered: r.offered, throughput: r.throughput },
  };
}

function ethBadFrames(seed: number, healthy: boolean): FaultCase {
  const u = rng(seed + 11), flipEvery = healthy ? Infinity : 15000 + 5000 * pick(seed, 10, 3);
  let bad = 0;
  const N = 400, sample: string[] = [];
  for (let i = 0; i < N; i++) {
    const bytes = frameBytes({ dst: addrOf(1), src: addrOf(2), type: 0x88b5, payload: Array.from({ length: 200 }, (_, k) => (k * 7 + i) & 255) });
    for (let b = 0; b < bytes.length * 8; b++) if (u() < 1 / flipEvery) bytes[b >> 3] ^= 1 << (b & 7);
    if (!parseFrame(bytes).fcsOk) {
      bad++;
      if (sample.length < 4) sample.push(`frame ${i}: ${bytes.length} bytes, check does not match`);
    }
  }
  return {
    id: 'eth_badframe', family: 'ethernet', symptom: 'File copies to one machine are slow, and nothing else on the switch is affected. Both ends of its link are set to full duplex.',
    options: ethOptions(1),
    why: `${bad} of ${N} frames failed their check, each the right length and otherwise normal, on a full-duplex link where nothing can collide. Bits are being changed on the way, and the only place left is the physical path.`,
    against: ['A full-duplex link has no shared segment to saturate.', 'A table problem floods frames, and does not corrupt them.', 'Traffic from another machine would not damage the frames on this link.'],
    evidence: [{ kind: 'counters', title: 'The port', rows: [['Frames received', String(N)], ['Frames failing the check', String(bad)]] }, { kind: 'lines', title: 'The first bad frames', lines: sample.length ? sample : ['none'] }],
    metrics: { bad, frames: N },
  };
}

function switchFlood(seed: number, healthy: boolean): FaultCase {
  const table = new MacTable(healthy ? 7 : 3, 4), u = rng(seed + 21), HOSTS_N = 40;
  const addr = (i: number) => 0x020000000000 + i * 977;
  // every host speaks once, so it could have been learned
  for (let i = 0; i < HOSTS_N; i++) table.op(addr((i + 1) % HOSTS_N), addr(i), i % 4);
  const base = { flooded: table.flooded, evicted: table.evicted };
  const N = 2000;
  for (let i = 0; i < N; i++) {
    const s = Math.floor(u() * HOSTS_N);
    let d = Math.floor(u() * HOSTS_N);
    if (d === s) d = (d + 1) % HOSTS_N;
    table.op(addr(d), addr(s), s % 4);
  }
  const flooded = table.flooded - base.flooded, evicted = table.evicted - base.evicted;
  return {
    id: 'sw_flood', family: 'ethernet', symptom: 'Every machine on a small switch sees other people\'s traffic, though each of them is only talking to one other machine. It began when the office grew to forty machines.',
    options: ethOptions(2),
    why: `${pct(flooded / N)} of frames went to every port, while the table overwrote ${evicted} entries: there are more hosts than its ${table.entries.length} entries hold, so they keep pushing each other out. A frame to an address it has forgotten goes everywhere.`,
    against: ['A switch has no shared segment: each port is its own.', 'Nothing here fails a check, and damage would not spread frames around.', 'The overwritten entries explain the flooding, with every machine talking normally.'],
    evidence: [{ kind: 'counters', title: 'The switch', rows: [['Hosts', String(HOSTS_N)], ['Table entries', String(table.entries.length)], ['Frames', String(N)], ['Sent to every port', pct(flooded / N)], ['Entries overwritten', String(evicted)]] }],
    metrics: { flooded: flooded / N, evicted },
  };
}

// ---- routing ------------------------------------------------------------------------------------------------------------------------------

const endText = (j: Journey): string => (j.end.kind === 'host' ? 'the site answered' : j.end.kind === 'noroute' ? 'destination unreachable: no route' : j.end.kind === 'router' ? 'no answer: the packet ended at this router' : j.end.kind);
const hopLines = (j: Journey): string[] => [
  ...j.hops.map((h, i) => `${String(i + 1).padStart(2)}  ${ROUTERS[h.router].name.padEnd(4)}  ${ASES[ROUTERS[h.router].as].name}`),
  `    ${endText(j)}`,
];
const FROM = ['laptop', 'phone', 'neighbour'] as const;
/** The phone is on the false network itself, so its usual path already runs through it. */
const HIJACK_FROM = ['laptop', 'neighbour'] as const;
const probe = (host: number, ip: number) => hostFrame(host, ip, 32, 17, new Array<number>(12).fill(0));
const SITE_DOWN = (site: string) => `${site} cannot be reached from this network. It worked last week, and nothing here has changed.`;
const ROUTE_OPTIONS = ['A false route for the site\'s addresses', 'A failed link, and no route left', 'The site\'s server has crashed', 'The packets\' TTL is too small'];

function routeHijack(seed: number, healthy: boolean): FaultCase {
  const from = hostId(HIJACK_FROM[seed % HIJACK_FROM.length]), www = hostId('www'), ip = hostIp(www), claim = { as: AS_SABLE, prefix: (ip & 0xffffff00) >>> 0, len: 24 };
  const j = new Internet(healthy ? {} : { hijack: claim }).send(from, probe(from, ip)), clean = new Internet().send(from, probe(from, ip));
  const lastAs = ASES[ROUTERS[j.hops[j.hops.length - 1].router].as];
  return {
    id: 'route_hijack', family: 'routing', symptom: SITE_DOWN(HOSTS[www].name),
    options: ROUTE_OPTIONS,
    why: `The trace now ends inside ${lastAs.name}, which has no business carrying this site's addresses. Routers prefer the longest matching prefix, so a false /24 beats the real /16 wherever it is heard, and nothing in BGP checks who owns it.`,
    against: ['A failed link leaves the packets with no route, and these are carried on into another network.', 'A crashed server would still be reached on the same path.', 'A low TTL ends in a time-exceeded message, not in a different network.'],
    evidence: [{ kind: 'lines', title: 'A week ago: the trace', lines: hopLines(clean) }, { kind: 'lines', title: 'Today: the trace', lines: hopLines(j) }],
    metrics: { sameEnd: ROUTERS[j.hops[j.hops.length - 1].router].as === ROUTERS[clean.hops[clean.hops.length - 1].router].as ? 1 : 0, sable: j.hops.some((h) => ROUTERS[h.router].as === AS_SABLE) ? 1 : 0 },
  };
}

/** Each source, and each link between networks on its path whose loss leaves some other source still reaching the site. */
function downChoices(ip: number): { from: number; link: number; other: number }[] {
  const out: { from: number; link: number; other: number }[] = [];
  for (const name of FROM) {
    const from = hostId(name), before = new Internet().send(from, probe(from, ip));
    for (let i = 1; i < before.hops.length; i++) {
      const link = linkBetween(before.hops[i - 1].router, before.hops[i].router);
      if (link < 0 || ROUTERS[LINKS[link].a].as === ROUTERS[LINKS[link].b].as) continue;
      const net = new Internet({ down: new Set([linkKey(link)]) });
      if (net.send(from, probe(from, ip)).end.kind !== 'noroute') continue;
      const other = FROM.map(hostId).find((o) => o !== from && net.send(o, probe(o, ip)).end.kind === 'host');
      if (other !== undefined) out.push({ from, link, other });
    }
  }
  return out;
}

function routeDown(seed: number, healthy: boolean): FaultCase {
  const www = hostId('www'), ip = hostIp(www), all = downChoices(ip), c = all[seed % all.length];
  const net = healthy ? new Internet() : new Internet({ down: new Set([linkKey(c.link)]) });
  const before = new Internet().send(c.from, probe(c.from, ip)), now = net.send(c.from, probe(c.from, ip)), other = net.send(c.other, probe(c.other, ip));
  return {
    id: 'route_down', family: 'routing', symptom: SITE_DOWN(HOSTS[www].name),
    options: [ROUTE_OPTIONS[1], ROUTE_OPTIONS[0], ROUTE_OPTIONS[2], ROUTE_OPTIONS[3]],
    why: 'The trace stops with no route at all, while a trace from another network still reaches the site. A link between two networks failed, BGP withdrew the route, and the networks\' policy lets nobody else carry this traffic.',
    against: ['A false route would carry the packets on into another network; here they have nowhere to go.', 'The other network still reaches the server.', 'A low TTL ends in a time-exceeded message, and this is no route.'],
    evidence: [
      { kind: 'lines', title: 'A week ago: the trace', lines: hopLines(before) }, { kind: 'lines', title: 'Today: the trace', lines: hopLines(now) },
      { kind: 'lines', title: `Today, from another network (${HOSTS[c.other].name})`, lines: hopLines(other) },
    ],
    metrics: { noroute: now.end.kind === 'noroute' ? 1 : 0, reached: now.end.kind === 'host' ? 1 : 0, otherReached: other.end.kind === 'host' ? 1 : 0, hopsBefore: before.hops.length, hopsNow: now.hops.length },
  };
}

// ---- radio --------------------------------------------------------------------------------------------------------------------------------

const RADIO_OPTIONS = ['Two stations cannot hear each other', 'Too little signal reaches the receiver', 'Too many stations on the channel', 'The channel is too wide for the signal'];
const AIR_SLOW = 'Wi-Fi in the far office has crawled since the refit put up new walls, and the access point reports a lot of retries.';
const AIR = { ghz: 5.5, tx: 20, ga: 2, nf: 6, mhz: 20, n: 3 };
/** 802.11's threshold for a station to notice another's frame on a 20 MHz channel: below it, the air sounds free. */
const CARRIER_SENSE_DBM = -82;
/** A budget indoors: the book's sum, with the path's exponent and the walls as its extra loss. */
function airBudget(m: number, walls: number): BudgetResult {
  const extra = logDistanceDb(m, AIR.ghz, AIR.n) - fsplDb(m / 1000, AIR.ghz) + walls * WALL_DB(AIR.ghz);
  return linkBudget({ txDbm: AIR.tx, gtDbi: AIR.ga, grDbi: AIR.ga, km: m / 1000, ghz: AIR.ghz, extraDb: extra, mhz: AIR.mhz, nfDb: AIR.nf });
}
const minus = (t: string) => t.replace('-', '−');
const dbm = (x: number) => `${minus(x.toFixed(1))} dBm`, db = (x: number) => `${minus(x.toFixed(1))} dB`;

const HIDDEN_FRAME_US = 1000, HIDDEN_CLOCKS = 200_000;
const A_STA = 0, AP_STA = 1, B_STA = 2, STA_NAME = ['A', 'AP', 'B'];
/** Two laptops with frames for the access point between them, on the Wi-Fi chapter's stations: who hears whom comes from the budget. */
function hiddenAir(seed: number, canHear: boolean): Air {
  const air = new Air({ n: 3, lenUs: HIDDEN_FRAME_US, useRts: false, dest: () => AP_STA, saturated: [true, false, true], seeds: [(101 + 37 * seed) % 1023 + 1, 3, (300 + 59 * seed) % 1023 + 1], hears: (i, j) => canHear || !((i === A_STA && j === B_STA) || (i === B_STA && j === A_STA)) });
  air.keepEvents = true;
  for (let c = 0; c < HIDDEN_CLOCKS; c++) air.step();
  return air;
}
/** A sniffer's list around the first two data frames in the air at once, or from the start if there are none. */
function airCapture(air: Air): string[] {
  const data = air.events.filter((e) => e.kind === KIND_DATA);
  const clash = data.findIndex((e, i) => i > 0 && e.from !== data[i - 1].from && e.clock - data[i - 1].clock < HIDDEN_FRAME_US);
  const from = clash > 0 ? Math.max(0, air.events.indexOf(data[clash - 1]) - 1) : 0;
  return air.events.slice(from, from + 8).map((e) => `${String(e.clock).padStart(8)} µs  ${STA_NAME[e.from].padEnd(2)}  ${KIND_NAMES[e.kind].padEnd(4)}${e.kind === KIND_DATA ? `  ${HIDDEN_FRAME_US} µs long` : ''}`);
}

function wifiHidden(seed: number, healthy: boolean): FaultCase {
  const m = 14 + pick(seed, 12, 4), toAp = airBudget(m, 0), across = airBudget(2 * m, healthy ? 0 : 1), hear = across.rx >= CARRIER_SENSE_DBM;
  const air = hiddenAir(seed, hear), s = air.stats, lastWeek = hiddenAir(seed, true).stats;
  const got = s.delivered[A_STA] + s.delivered[B_STA], tries = s.tries[A_STA] + s.tries[B_STA], before = lastWeek.delivered[A_STA] + lastWeek.delivered[B_STA];
  return {
    id: 'wifi_hidden', family: 'radio', symptom: AIR_SLOW, options: [RADIO_OPTIONS[0], ...RADIO_OPTIONS.slice(1)],
    why: `Each laptop reaches the access point at ${db(toAp.snr)} of SNR, far more than the top rate asks. But they now hear each other at ${dbm(across.rx)}, under the ${dbm(CARRIER_SENSE_DBM)} at which a station notices a frame, so each finds the air free while the other is sending. The frames overlap at the access point, which is the one place that hears both. RTS / CTS would let its answer silence the other laptop.`,
    against: ['Both reach the access point with far more SNR than the top rate needs.', `Two is not many: the same two laptops delivered ${before} frames over the same time last week.`, 'The channel is as wide as it was last week, with plenty of SNR in it.'],
    evidence: [
      { kind: 'counters', title: 'The budget, 20 MHz at 5.5 GHz', rows: [['Each laptop to the access point', `${m} m, ${dbm(toAp.rx)}, SNR ${db(toAp.snr)}`], ['Laptop to laptop', `${2 * m} m${healthy ? '' : ', through the new wall'}, ${dbm(across.rx)}`], ['A station notices a frame from', dbm(CARRIER_SENSE_DBM)], ['SNR the top rate needs', db(RATES[RATES.length - 1].snrDb)]] },
      { kind: 'counters', title: `The access point, over ${HIDDEN_CLOCKS / 1000} ms`, rows: [['Frames tried', String(tries)], ['Frames delivered', String(got)], ['Delivered in the same time last week', String(before)], ['Frames given up on', String(s.dropped[A_STA] + s.dropped[B_STA])], ['Time with two stations sending', `${(100 * s.overlapUs / HIDDEN_CLOCKS).toFixed(1)} %`]] },
      { kind: 'lines', title: 'A sniffer beside the access point: each frame as it starts', lines: airCapture(air) },
    ],
    metrics: { delivered: got, tries, before, overlap: s.overlapUs / HIDDEN_CLOCKS, hears: hear ? 1 : 0, snr: toAp.snr },
  };
}

function linkWall(seed: number, healthy: boolean): FaultCase {
  const m = 11 + pick(seed, 13, 4), top = RATES[RATES.length - 1], b = airBudget(m, healthy ? 1 : 2), last = airBudget(m, 1), bytes = 1500, totalUs = 2_000_000;
  const r = rateRun('arf', () => b.snr, rng(seed + 31), bytes, totalUs), was = rateRun('arf', () => last.snr, rng(seed + 31), bytes, totalUs);
  const stride = Math.max(1, Math.floor(r.history.length / 200)), pts = r.history.filter((_, i) => i % stride === 0);
  return {
    id: 'link_wall', family: 'radio', symptom: AIR_SLOW, options: [RADIO_OPTIONS[1], RADIO_OPTIONS[0], ...RADIO_OPTIONS.slice(2)],
    why: `The budget tells it: ${db(b.snr)} of SNR where the top rate needs ${db(top.snrDb)}. The sum came out at ${db(last.snr)} last week, and the ${db(WALL_DB(AIR.ghz))} of the new wall is the whole difference. The laptop's rate adaptation steps down to what the SNR can carry, and still loses frames trying to climb back. No setting recovers that: an access point on this side of the wall does.`,
    against: ['Only one laptop is sending: there is nobody to be hidden from.', 'Only one laptop is sending, so nothing is competing for the air.', `The channel is as narrow as this radio goes, and halving a channel buys only 3 dB of the ${db(WALL_DB(AIR.ghz))} the wall took.`],
    evidence: [
      { kind: 'counters', title: 'The budget, 20 MHz at 5.5 GHz', rows: [['Transmitter and both antennas', `${AIR.tx + 2 * AIR.ga} dBm`], [`Path, ${m} m indoors`, db(logDistanceDb(m, AIR.ghz, AIR.n))], ['Walls', `${healthy ? 1 : 2}, ${db((healthy ? 1 : 2) * WALL_DB(AIR.ghz))}`], ['Arriving', dbm(b.rx)], ['Noise floor', dbm(b.noise)], ['SNR', db(b.snr)], ['SNR the top rate needs', db(top.snrDb)]] },
      { kind: 'counters', title: `The access point, over ${totalUs / 1e6} s, with this one laptop sending`, rows: [['Frames tried', String(r.frames)], ['Frames lost', String(r.lost)], ['Carried', `${r.mbps.toFixed(1)} Mb/s`], ['Carried last week', `${was.mbps.toFixed(1)} Mb/s`], ['Time with two stations sending', '0.0 %']] },
      { kind: 'series', title: 'The rate the laptop picks', xLabel: 'µs', yLabel: 'Mb/s', lines: [{ name: 'rate', xs: pts.map((p) => p.us), ys: pts.map((p) => p.mbps) }] },
    ],
    metrics: { snr: b.snr, mbps: r.mbps, lost: r.lost, frames: r.frames, was: was.mbps, shortfall: top.snrDb - b.snr },
  };
}

// ---- the set ------------------------------------------------------------------------------------------------------------------------------

export const FAULT_CASES: { id: string; family: FaultFamily; build: (seed: number, healthy?: boolean) => FaultCase }[] = [
  { id: 'tcp_loss', family: 'tcp', build: (s, h = false) => tcpLoss(s, h) },
  { id: 'tcp_reader', family: 'tcp', build: (s, h = false) => tcpReader(s, h) },
  { id: 'tcp_bloat', family: 'tcp', build: (s, h = false) => tcpBloat(s, h) },
  { id: 'tcp_tiny', family: 'tcp', build: (s, h = false) => tcpTiny(s, h) },
  { id: 'line_band', family: 'line', build: (s, h = false) => lineBand(s, h) },
  { id: 'line_noise', family: 'line', build: (s, h = false) => lineNoise(s, h) },
  { id: 'uart_clock', family: 'serial', build: (s, h = false) => uartClock(s, h) },
  { id: 'eth_collide', family: 'ethernet', build: (s, h = false) => ethCollide(s, h) },
  { id: 'eth_badframe', family: 'ethernet', build: (s, h = false) => ethBadFrames(s, h) },
  { id: 'sw_flood', family: 'ethernet', build: (s, h = false) => switchFlood(s, h) },
  { id: 'route_hijack', family: 'routing', build: (s, h = false) => routeHijack(s, h) },
  { id: 'route_down', family: 'routing', build: (s, h = false) => routeDown(s, h) },
  { id: 'wifi_hidden', family: 'radio', build: (s, h = false) => wifiHidden(s, h) },
  { id: 'link_wall', family: 'radio', build: (s, h = false) => linkWall(s, h) },
];

/** How many cases make an attempt, and how many it takes to pass. */
export const ATTEMPT_CASES = 8, PASS_MARK = 7;

/** An attempt's cases: seeded, no family more than three times, in a mixed order. */
export function attemptCases(seed: number): { id: string; seed: number }[] {
  const u = rng(seed * 7919 + 3), pool = FAULT_CASES.map((c) => c.id), out: { id: string; seed: number }[] = [], seen = new Map<string, number>();
  while (out.length < ATTEMPT_CASES && pool.length) {
    const i = Math.floor(u() * pool.length), id = pool.splice(i, 1)[0], fam = FAULT_CASES.find((c) => c.id === id)!.family;
    if ((seen.get(fam) ?? 0) >= 3) continue;
    seen.set(fam, (seen.get(fam) ?? 0) + 1);
    out.push({ id, seed: seed * 31 + out.length + 1 });
  }
  return out;
}
