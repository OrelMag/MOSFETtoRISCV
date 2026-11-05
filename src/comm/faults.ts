// The expert's bench (DOM-free): networks with a fault really in them, and the evidence an engineer would have. Every case runs one of the
// book's models with the fault switched on (net/tcpsim, phys/line, comm/startstop, comm/macexp, comm/ethframe, comm/ethswitch, net/internet)
// and reads what comes out; nothing here is drawn or typed. `healthy` runs the same case with the fault off, and tests/comm-faults.test.ts
// holds that the symptom comes with the fault and goes without it.

import { ACK, FIN, SYN } from '../net/tcp';
import { runTcp, type SimOptions, type SimResult } from '../net/tcpsim';
import { hostFrame, hostId, HOSTS, Internet, ROUTERS, ASES, LINKS, linkKey, linkBetween, AS_SABLE, hostIp, type Journey } from '../net/internet';
import { berOf, eye, prbs, rng } from '../phys/line';
import { frameBytes, parseFrame } from './ethframe';
import { MacTable } from './ethswitch';
import { addrOf, runLoad } from './macexp';
import { receive, UART_8N1 } from './startstop';

export type Evidence =
  | { kind: 'series'; title: string; xLabel: string; yLabel: string; lines: { name: string; xs: number[]; ys: number[] }[] }
  | { kind: 'lines'; title: string; lines: string[] }
  | { kind: 'counters'; title: string; rows: [string, string][] }
  /** A noiseless waveform folded on the bit period, with the noise the receiver sees on it. */
  | { kind: 'eye'; title: string; wave: number[]; spu: number; sigma: number };

export type FaultFamily = 'tcp' | 'line' | 'serial' | 'ethernet' | 'routing';

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

function tcpLoss(seed: number, healthy: boolean): FaultCase {
  return tcpCase('tcp_loss', { byteClocks: FAST, lossPct: healthy ? 0 : 2 + pick(seed, 1, 3), seed }, 'A copy between two machines on a fast line takes far longer than the line\'s rate says it should. Nobody else is using the line.', 0,
    'Retransmissions and timeouts with the round trip flat, and the line\'s own error counter counting. The bytes are going missing on the line, and the sender keeps backing off.',
    ['The window never closes: the receiver is keeping up.', 'A full queue would lengthen the round trip, and here it stays flat.', 'The queue drop counter reads zero. These are line errors.']);
}
function tcpReader(seed: number, healthy: boolean): FaultCase {
  return tcpCase('tcp_reader', healthy ? { byteClocks: FAST } : { byteClocks: FAST, readEvery: 30000 + 5000 * pick(seed, 2, 4), readBytes: 64 }, 'A copy to one small device crawls. The same line carries other traffic at full speed.', 1,
    'The receiver keeps advertising a window of zero, and the sender stops and waits. Nothing is lost and the round trip is steady: the network is idle, waiting on the far program.',
    ['No line errors and no retransmissions.', 'The round trip does not grow.', 'Nothing was dropped.']);
}
function tcpBloat(seed: number, healthy: boolean): FaultCase {
  return tcpCase('tcp_bloat', { byteClocks: healthy ? FAST : SLOW + 20 * pick(seed, 3, 4), queue: 64 }, 'While a large upload runs, everything else on the line becomes unusable: a ping that took a few milliseconds now takes far longer. The upload itself finishes without errors.', 2,
    'The round trip climbs as the bytes in flight fill the queue, and stays high, with nothing lost. A buffer far larger than the line can drain quickly holds everybody\'s packets behind the upload.',
    ['Nothing was lost: no retransmissions at all.', 'The window stays open: the receiver is keeping up.', 'A queue too small would drop packets, and none were dropped.']);
}
function tcpTiny(seed: number, healthy: boolean): FaultCase {
  return tcpCase('tcp_tiny', { byteClocks: SLOW + 20 * pick(seed, 4, 4), queue: healthy ? 64 : 2 }, 'A copy over a slow line runs at a fraction of the line\'s rate, and stalls every so often. The cable tests clean.', 3,
    'Bursts arrive faster than the slow line drains them, and a queue of two frames throws the rest away: the queue drop counter climbs while the line error counter stays at zero.',
    ['The line error counter reads zero: these drops happen at a queue.', 'The window stays open.', 'A large queue would hold the burst and drop nothing.']);
}

const LINE_OPTIONS = ['The channel has too little bandwidth for this rate', 'The channel is too noisy, with bandwidth to spare', 'The sender and receiver clocks disagree', 'The sender is transmitting too slowly'];

function lineCase(id: string, band: number, sigma: number, right: number, symptom: string, why: string, against: string[]): FaultCase {
  const rate = 8, e = eye(prbs(9, 1022), { rate, bandwidth: band }), ber = e.opening > 0 ? berOf(e.opening / 2, sigma) : 0.5;
  const take = Math.min(e.wave.length, 400 * e.spu);
  return {
    id, family: 'line', symptom, why, against, options: [LINE_OPTIONS[right], ...LINE_OPTIONS.filter((_, i) => i !== right)],
    evidence: [
      { kind: 'eye', title: `The eye at ${rate} Gb/s`, wave: Array.from(e.wave.slice(0, take)), spu: e.spu, sigma },
      { kind: 'counters', title: 'Measured at the receiver', rows: [['Eye height', e.opening > 0 ? `${(e.opening * 100).toFixed(0)} % of the swing` : 'closed'], ['Noise, RMS', `${(sigma * 100).toFixed(0)} % of the swing`], ['Bit error rate', ber > 0.01 ? ber.toFixed(2) : ber.toExponential(0)]] },
    ],
    metrics: { opening: e.opening, ber },
  };
}
function lineBand(seed: number, healthy: boolean): FaultCase {
  return lineCase('line_band', healthy ? 4 : 0.5 + 0.1 * pick(seed, 5, 3), 0.02, 0, 'A new board\'s fast link never trains. It worked on the shorter prototype.',
    'The traces are clean and thin, so there is little noise, and they never reach the rails between bits: each bit is shaped by the ones before it. That is the channel\'s band falling short of the rate.',
    ['The noise is small: the eye is shut by the traces\' own shape.', 'Clock trouble would smear the eye sideways, and these bits are all aligned.', 'The bit period is the rate asked for.']);
}
function lineNoise(seed: number, healthy: boolean): FaultCase {
  return lineCase('line_noise', 4, healthy ? 0.02 : 0.3 + 0.05 * pick(seed, 6, 3), 1, 'A link trains and carries traffic, with bursts of errors that nothing in the data explains.',
    'The clean waveform has a wide open eye, so the band is plenty; the spread around it is noise, which leaves the error rate where it is.',
    ['The clean waveform reaches the rails at every bit.', 'The bits are aligned: a clock error would slide them across the eye.', 'The bit period is the rate asked for.']);
}

function uartClock(seed: number, healthy: boolean): FaultCase {
  const sign = pick(seed, 7, 2) ? 1 : -1, err = sign * (healthy ? 0.01 : 0.06 + 0.01 * pick(seed, 8, 3));
  const text = 'HELLO, BENCH';
  let wrong = 0, framing = 0;
  const lines = [...text].map((ch) => {
    const code = ch.charCodeAt(0), r = receive(UART_8N1, code, { err });
    if (r.word !== code) wrong++;
    if (!r.stopOk) framing++;
    return `sent ${code.toString(16).padStart(2, '0')} '${ch}'   read ${r.word.toString(16).padStart(2, '0')}${r.word !== code ? '  wrong' : ''}${r.stopOk ? '' : '  framing error'}`;
  });
  return {
    id: 'uart_clock', family: 'serial', symptom: 'A console prints garbled text on one board. Short bursts of some characters come through intact.',
    options: ['The two ends\' clocks are too far apart', 'Noise on the line is flipping bits', 'The line is too long for the rate', 'The data pin is wired backwards'],
    why: 'The errors fall on the last bits of a character, and depend on the character: the receiver re-times on each start edge and drifts until its later samples land in the wrong bit. Total error above about 5 % is too much for 8N1.',
    against: ['Noise would hit any bit in any character, at random.', 'A long line rounds every edge, and would not spare the first bits.', 'Inverted data would make every character wrong from its start bit.'],
    evidence: [{ kind: 'lines', title: 'What was sent and what was read', lines }, { kind: 'counters', title: 'Counters', rows: [['Characters wrong', `${wrong} of ${text.length}`], ['Framing errors', String(framing)]] }],
    metrics: { wrong, framing },
  };
}

function ethCollide(seed: number, healthy: boolean): FaultCase {
  const load = healthy ? 0.1 : 0.85 + 0.05 * pick(seed, 9, 2), r = runLoad({ n: 8, payload: 46, load, clocks: 300000, seed: seed + 1 });
  return {
    id: 'eth_collide', family: 'ethernet', symptom: 'Eight machines share an old hub. In the morning it is fine; when everybody syncs at once, nobody gets much done.',
    options: ['The shared segment is saturated, and its stations spend the time colliding', 'A cable is damaged', 'One station is babbling without limit', 'The table in the switch is too small'],
    why: `The wire carries ${pct(r.throughput)} of its time in frames while stations ask for ${pct(r.offered)}, with ${r.collisions} collisions. On a shared segment more offered load means more collisions, and throughput flattens well short of the rate.`,
    against: ['A damaged cable shows frames arriving with bad checks, and collisions are a different counter.', 'Traffic is shared fairly among the stations.', 'A hub has no table.'],
    evidence: [{ kind: 'counters', title: 'The segment, over the period', rows: [['Offered load', pct(r.offered)], ['Time carrying frames', pct(r.throughput)], ['Collisions', String(r.collisions)], ['Frames sent, by station', r.sent.join(' ')]] }],
    metrics: { collisions: r.collisions, offered: r.offered, throughput: r.throughput },
  };
}

function ethBadFrames(seed: number, healthy: boolean): FaultCase {
  const u = rng(seed + 11), flipEvery = healthy ? Infinity : 2000 + 500 * pick(seed, 10, 3);
  let bad = 0;
  const N = 400, sample: string[] = [];
  for (let i = 0; i < N; i++) {
    const bytes = frameBytes({ dst: addrOf(1), src: addrOf(2), type: 0x88b5, payload: Array.from({ length: 200 }, (_, k) => (k * 7 + i) & 255) });
    const hit: number[] = [];
    for (let b = 0; b < bytes.length * 8; b++) if (u() < 1 / flipEvery) { bytes[b >> 3] ^= 1 << (b & 7); hit.push(b); }
    const ok = parseFrame(bytes).fcsOk;
    if (!ok) bad++;
    if (!ok && sample.length < 4) sample.push(`frame ${i}: ${bytes.length} bytes, check does not match`);
  }
  return {
    id: 'eth_badframe', family: 'ethernet', symptom: 'File copies to one machine are slow, and nothing else on the switch is affected. It is the only machine on the long cable through the workshop.',
    options: ['The cable or a connector is corrupting bits', 'The shared segment is saturated', 'The receiver program is too slow', 'The switch\'s table is too small'],
    why: `${bad} of ${N} frames failed their check, each the right length and otherwise normal, with no collisions on a switched port. Bits are being changed on the way, and the only place left is the physical path.`,
    against: ['A switched port has no one to collide with.', 'A slow program would drop nothing at the check: the frames are damaged before anything reads them.', 'A table problem floods frames, and does not corrupt them.'],
    evidence: [{ kind: 'counters', title: 'The port', rows: [['Frames received', String(N)], ['Frames failing the check', String(bad)], ['Collisions', '0']] }, { kind: 'lines', title: 'The first bad frames', lines: sample.length ? sample : ['none'] }],
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
    id: 'sw_flood', family: 'ethernet', symptom: 'Every machine on a small switch sees other people\'s traffic and the ports run hot, though no one is sending much. It began when the office grew to forty machines.',
    options: ['The switch\'s address table is too small for its hosts', 'The cable or a connector is corrupting bits', 'The shared segment is saturated', 'One machine is sending to the broadcast address'],
    why: `${pct(flooded / N)} of frames were flooded to every port, while the table overwrote ${evicted} entries: there are more hosts than its ${table.entries.length} entries hold, so they keep pushing each other out. A frame to an address it has forgotten goes everywhere.`,
    against: ['No frames fail their check here.', 'A switch has no shared segment, and there are no collisions.', 'These frames are addressed to single machines: the flooding is the switch\'s own.'],
    evidence: [{ kind: 'counters', title: 'The switch', rows: [['Hosts', String(HOSTS_N)], ['Table entries', String(table.entries.length)], ['Frames', String(N)], ['Flooded to every port', pct(flooded / N)], ['Entries overwritten', String(evicted)]] }],
    metrics: { flooded: flooded / N, evicted },
  };
}

// ---- routing ------------------------------------------------------------------------------------------------------------------------------

const endText = (j: Journey): string => (j.end.kind === 'host' ? 'the site answered' : j.end.kind === 'noroute' ? 'destination unreachable: no route' : j.end.kind);
const hopLines = (j: Journey): string[] => {
  const rows = j.hops.map((h, i) => `${String(i + 1).padStart(2)}  ${ROUTERS[h.router].name.padEnd(4)}  ${ASES[ROUTERS[h.router].as].name}`);
  return rows;
};

function routeHijack(_seed: number, healthy: boolean): FaultCase {
  const laptop = hostId('laptop'), www = hostId('www'), ip = hostIp(www), claim = { as: AS_SABLE, prefix: (ip & 0xffffff00) >>> 0, len: 24 };
  const net = new Internet(healthy ? {} : { hijack: claim }), j = net.send(laptop, hostFrame(laptop, ip, 32, 17, new Array<number>(12).fill(0)));
  const clean = new Internet().send(laptop, hostFrame(laptop, ip, 32, 17, new Array<number>(12).fill(0)));
  const lastAs = ASES[ROUTERS[j.hops[j.hops.length - 1].router].as];
  return {
    id: 'route_hijack', family: 'routing', symptom: `People on several networks cannot reach the site at ${HOSTS[www].name}. The site's owners see nothing wrong, and its traffic has simply stopped.`,
    options: ['Another network is announcing a longer prefix for the site\'s addresses', 'A link on the usual path has failed', 'The site\'s server has crashed', 'The packets\' TTL is too small'],
    why: `The trace now ends inside ${lastAs.name}, which has no business carrying this site's addresses. Routers prefer the longest matching prefix, so a false /24 beats the real /16 wherever it is heard, and nothing in BGP checks who owns it.`,
    against: ['A failed link would reroute traffic towards the same network, not into a different one.', 'A crashed server would still be reached on the same path.', 'TTL would stop packets at a varying depth, with a time-exceeded message.'],
    evidence: [{ kind: 'lines', title: 'A week ago: the trace', lines: hopLines(clean) }, { kind: 'lines', title: 'Today: the trace', lines: hopLines(j) }],
    metrics: { sameEnd: ROUTERS[j.hops[j.hops.length - 1].router].as === ROUTERS[clean.hops[clean.hops.length - 1].router].as ? 1 : 0, sable: j.hops.some((h) => ROUTERS[h.router].as === AS_SABLE) ? 1 : 0 },
  };
}

function routeDown(seed: number, healthy: boolean): FaultCase {
  const laptop = hostId('laptop'), www = hostId('www'), ip = hostIp(www), frame = hostFrame(laptop, ip, 32, 17, new Array<number>(12).fill(0));
  const before = new Internet().send(laptop, frame);
  // a link between networks on the path: under the networks' policy nothing else will carry this traffic
  const links = before.hops.slice(1).map((h, i) => linkBetween(before.hops[i].router, h.router)).filter((l) => l >= 0 && ROUTERS[LINKS[l].a].as !== ROUTERS[LINKS[l].b].as);
  const l = links[seed % links.length];
  const now = healthy ? before : new Internet({ down: new Set([linkKey(l)]) }).send(laptop, frame);
  const last = now.hops[now.hops.length - 1];
  return {
    id: 'route_down', family: 'routing', symptom: `${HOSTS[www].name} cannot be reached from this network, and an error comes back at once. People on some other networks reach it normally.`,
    options: ['A link between networks has failed, and no route is left', 'Another network is announcing a longer prefix for the site\'s addresses', 'The site\'s server has crashed', 'The packets\' TTL is too small'],
    why: `The trace stops at ${ROUTERS[last.router].name}, which has no route at all for the site's prefix. A link between two networks failed, BGP withdrew the route, and the networks' policy lets no one else carry this traffic.`,
    against: ['A hijack would carry the packets on into another network; here they stop with nowhere to go.', 'A crashed server would be reached at its own router, on the usual path, and simply not answer.', 'TTL would give a time-exceeded message, and this is no route.'],
    evidence: [
      { kind: 'lines', title: 'A week ago: the trace', lines: hopLines(before) }, { kind: 'lines', title: 'Today: the trace', lines: hopLines(now) },
      { kind: 'counters', title: 'What came back', rows: [['A week ago', endText(before)], ['Today', endText(now)]] },
    ],
    metrics: { noroute: now.end.kind === 'noroute' ? 1 : 0, reached: now.end.kind === 'host' ? 1 : 0, hopsBefore: before.hops.length, hopsNow: now.hops.length },
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
