// The benches of act 12 (Links, roadmap Phase 21 g). Each far end is a JS model that knows its rules and names the first
// one a circuit breaks: the destination's clock and the failure rate of a synchronizer (phys/metastable.ts), a UART receiver
// that samples a frame in the middle of each bit, an I²C bus wired as an AND with a rival controller on it, a CRC check on the
// frame's far end, a decoder that counts disparity, a receiver that must lock to a drifting stream. Lanes of a BitSim run one
// scenario each. No DOM.

import type { CustomRun } from '../editor/challenges';
import { BitSim } from '../sim/bitsim';
import { flatten } from '../sim/flatten';
import { analyzeTiming } from '../sim/timing';
import { PS_PER_NAND } from '../sim/timing';
import type { ComponentDef } from '../sim/types';
import { fmtLog10, log10Mtbf, resolutionTime, TAU_PS, T0_PS, windowRate } from '../phys/metastable';
import { rng } from './drills';

export const hex = (v: number, d = 2) => `0x${(v >>> 0).toString(16).padStart(d, '0')}`;

/** A BitSim for def, or why not (missing pins, cannot flatten). */
export function simOf(def: ComponentDef, pins: string[]): BitSim | string {
  const have = new Set(def.ports.map((p) => p.name));
  const missing = pins.filter((p) => !have.has(p));
  if (missing.length) return `missing pins: ${missing.join(', ')}`;
  try {
    return new BitSim(flatten(def, { mode: 'gate' }));
  } catch (e) {
    return `cannot simulate: ${(e as Error).message}`;
  }
}

export function periodOf(def: ComponentDef): number | undefined {
  try { return analyzeTiming(flatten(def, { mode: 'gate' }))?.period ?? undefined; } catch { return undefined; }
}

/** The failures (at most 6 shown) and, for a chip that passes, its period. */
export function finish(failures: string[], tested: number, def: ComponentDef, extra: Partial<CustomRun> = {}): CustomRun {
  return {
    failures: failures.slice(0, 6).concat(failures.length > 6 ? [`… and ${failures.length - 6} more fail`] : []), tested, ...extra,
    ...(failures.length ? {} : (() => { const p = periodOf(def); return p ? { period: p } : {}; })()),
  };
}

// ---- l_sync: a synchronizer for a fast port -------------------------------------------------------------------------------

/** The port the synchronizer serves: a 1.6 GHz receiver, data changing at up to 160 MHz, read by 8 NAND delays of logic, a failure at most once in 100 years. */
export const SYNC_PORT = { fclk: 1.6e9, fdata: 1.6e8, downstream: 8, years: 100 } as const;
const YEAR_S = 86400 * 365.25;

/** log10 of the MTBF (s) of `stages` flip-flops in a row with `between` NAND delays of logic inside the chain, on the port. */
export function syncLog10(stages: number, between = 0, port = SYNC_PORT): number {
  const T = 1e12 / port.fclk;
  const raw = resolutionTime(stages, T, stages <= 1 ? port.downstream * PS_PER_NAND : 0);
  const tr = Math.max(0, raw - (stages <= 1 ? 0 : between * PS_PER_NAND));
  return tr / TAU_PS / Math.LN10 - Math.log10(windowRate(port.fclk, port.fdata, T0_PS));
}
void log10Mtbf;

/** Seeded pulse trains for the lanes: runs of 3 to 8 cycles. */
function trains(lanes: number, len: number): number[][] {
  return Array.from({ length: lanes }, (_, l) => {
    const r = rng(40 + l), s: number[] = [];
    let v = 0;
    while (s.length < len) {
      const run = l === 0 ? (s.length < 6 ? 6 : 3 + Math.floor(r() * 3)) : 3 + Math.floor(r() * 6);
      for (let i = 0; i < run && s.length < len; i++) s.push(v);
      v ^= 1;
    }
    return s;
  });
}

export function runSync(def: ComponentDef, mode: 'gate' | 'switch'): CustomRun {
  if (mode === 'switch') return { failures: ['switch level: the synchronizer is gates and flip-flops'], tested: 0 };
  const sim = simOf(def, ['d', 'clk', 'q']);
  if (typeof sim === 'string') return { failures: [sim], tested: 0 };
  const lanes = 8, len = 60, d = trains(lanes, len);
  const pre: number[][] = [], post: number[][] = [];
  for (let t = 0; t < len; t++) {
    sim.setInput('d', d.map((s) => s[t]));
    sim.settle();
    pre.push(sim.get('q', lanes));
    sim.cycle();
    post.push(sim.get('q', lanes));
  }
  // the latency: edges from the first rise of d (lane 0) to the first rise of q before the edge
  const t0 = d[0].indexOf(1), t1 = pre.findIndex((q) => q[0] === 1);
  if (t1 < 0) return { failures: [`q never rose: d rose at cycle ${t0} and was held for ${d[0].slice(t0).indexOf(0)} cycles`], tested: len };
  const L = t1 - t0;
  const fails: string[] = [];
  if (L === 0) fails.push(`q follows d in the same cycle (it rose before the edge that samples d): nothing on the receiving clock holds it. A change of d at any moment of the cycle would reach the logic behind q at any moment`);
  for (let t = 0; t < len && fails.length < 4; t++) {
    for (let l = 0; l < lanes; l++) {
      const want = t >= L ? d[l][t - L] : 0;
      if (pre[t][l] !== want) { fails.push(`cycle ${t}: q reads ${pre[t][l]}, but d was ${want} ${L} cycle${L === 1 ? '' : 's'} ago (pulse train ${l + 1}): q must be d delayed by the same ${L} cycles throughout`); break; }
    }
  }
  let between = 0;
  try { between = analyzeTiming(flatten(def, { mode: 'gate' }))?.logic ?? 0; } catch { /* no flip-flops: caught above */ }
  const need = Math.log10(SYNC_PORT.years * YEAR_S);
  if (!fails.length && L >= 1) {
    const l10 = syncLog10(L, Math.max(0, between));
    if (l10 < need) {
      fails.push(`at ${SYNC_PORT.fclk / 1e9} GHz with data changing at ${SYNC_PORT.fdata / 1e6} MHz, ${L === 1 ? 'one flip-flop read by the logic behind it' : `${L} flip-flops${between > 0 ? ` with ${between} NAND ${between === 1 ? 'delay' : 'delays'} of logic inside the chain` : ''}`} fails about once in ${fmtLog10(l10)}; the port needs ${SYNC_PORT.years} years. The first flip-flop has ${Math.round(Math.max(0, resolutionTime(L, 1e12 / SYNC_PORT.fclk, L <= 1 ? SYNC_PORT.downstream * PS_PER_NAND : 0) - (L <= 1 ? 0 : between * PS_PER_NAND)))} ps to decide, and each extra flip-flop adds a clock period.`);
    }
  }
  return finish(fails, len, def, { cycles: L });
}

// ---- l_uarttx: a frame at any divisor ------------------------------------------------------------------------------------

/** The divisors the transmitter is tried at (a bit lasts 16 · div clocks) and the two bytes of each lane's script. */
export const TX_CASES: { div: number; a: number; b: number }[] = [
  { div: 1, a: 0x55, b: 0x01 }, { div: 2, a: 0xa6, b: 0x80 }, { div: 3, a: 0x00, b: 0xff }, { div: 7, a: 0x3c, b: 0xc3 },
];
const frameBits = (byte: number): number[] => [0, ...Array.from({ length: 8 }, (_, i) => (byte >> i) & 1), 1];
const bitName = (j: number) => (j === 0 ? 'the start bit' : j === 9 ? 'the stop bit' : `data bit ${j - 1}`);

interface TxTrace { tx: number[]; busy: number[]; taken: number[]; go: number[]; accept: number[]; ignored: number }

/** Lane scripts for the transmitter: go with a, the same go with another byte in the middle of the frame (to be ignored), then b. */
function driveTx(sim: BitSim, cases: typeof TX_CASES, limit: number): TxTrace[] {
  const n = cases.length;
  const tr: TxTrace[] = cases.map(() => ({ tx: [], busy: [], taken: [], go: [], accept: [], ignored: -1 }));
  const phase = new Array<number>(n).fill(0), since = new Array<number>(n).fill(0);
  for (let c = 0; c < limit; c++) {
    const go = new Array<number>(n).fill(0), din = new Array<number>(n).fill(0);
    for (let l = 0; l < n; l++) {
      const k = cases[l];
      if (phase[l] === 0 && c >= 3) { go[l] = 1; din[l] = k.a; }
      else if (phase[l] === 1 && since[l] >= 24 * k.div) { phase[l] = 2; since[l] = 0; }
      if (phase[l] === 2) { go[l] = 1; din[l] = 0xa5; if (since[l] >= 2) { phase[l] = 3; go[l] = 0; } }
      if (phase[l] === 4) { go[l] = 1; din[l] = k.b; }
    }
    sim.setInput('go', go); sim.setInput('din', din); sim.setInput('tick', cases.map((k) => (c % k.div === 0 ? 1 : 0)));
    sim.settle();
    const tx = sim.get('tx', n), busy = sim.get('busy', n), taken = sim.get('taken', n);
    for (let l = 0; l < n; l++) {
      const t = tr[l];
      t.tx.push(tx[l]); t.busy.push(busy[l]); t.taken.push(taken[l]); t.go.push(go[l]);
      if (taken[l]) t.accept.push(c);
      if (phase[l] === 2 && t.ignored < 0) t.ignored = c;
      if (phase[l] === 0 && taken[l]) { phase[l] = 1; since[l] = 0; }
      else if (phase[l] === 4 && taken[l]) { phase[l] = 5; since[l] = 0; }
      else if (phase[l] === 3 && !busy[l]) phase[l] = 4;
      else since[l]++;
    }
    sim.cycle();
    if (phase.every((p) => p === 5) && since.every((s, l) => s > 170 * cases[l].div + 40)) break;
  }
  return tr;
}

export function runUartTx(def: ComponentDef, mode: 'gate' | 'switch'): CustomRun {
  if (mode === 'switch') return { failures: ['switch level: the transmitter is gates'], tested: 0 };
  const sim = simOf(def, ['tick', 'go', 'din', 'clk', 'tx', 'busy', 'taken']);
  if (typeof sim === 'string') return { failures: [sim], tested: 0 };
  const limit = 3 + 2 * (170 * 7 + 60) + 24 * 7 + 120 * 7;
  const trs = driveTx(sim, TX_CASES, limit);
  const fails: string[] = [];
  TX_CASES.forEach((k, l) => {
    const t = trs[l], D = 16 * k.div, who = `divisor ${k.div}`;
    const bad = (m: string) => { if (!fails.some((f) => f.startsWith(who))) fails.push(`${who}: ${m}`); };
    // taken is exactly the cycle a byte is accepted
    for (let c = 0; c < t.tx.length; c++) {
      const want = t.go[c] && !t.busy[c] ? 1 : 0;
      if (t.taken[c] !== want) { bad(`cycle ${c}: taken = ${t.taken[c]} with go = ${t.go[c]} and busy = ${t.busy[c]}: taken is 1 exactly in the cycle a byte is accepted (go = 1 while busy = 0)`); break; }
    }
    if (t.accept.length !== 2) { bad(t.accept.length < 2 ? `only ${t.accept.length} of the 2 bytes offered were accepted (go with busy = 0 must be taken, also right after a frame ends)` : `${t.accept.length} bytes accepted for 2 offered: a go while busy = 1 must be ignored`); return; }
    if (t.tx[0] !== 1 && !fails.some((f) => f.startsWith(who))) bad('tx must idle at 1');
    let from = 0;
    [k.a, k.b].forEach((byte, i) => {
      const acc = t.accept[i];
      const s = t.tx.findIndex((v, c) => c >= acc && v === 0);
      if (s < 0 || s > acc + D + 2) { bad(`byte ${i + 1} (${hex(byte)}) was accepted at cycle ${acc} but tx did not fall within a bit time (${s < 0 ? 'never' : `at cycle ${s}`})`); return; }
      const bits = frameBits(byte);
      for (let c = s; c < s + 10 * D && !fails.some((f) => f.startsWith(who)); c++) {
        const j = Math.floor((c - s) / D), want = bits[j];
        if (t.tx[c] !== want) {
          const off = (c - s) % D;
          bad(off === 0 ? `byte ${i + 1} (${hex(byte)}): ${bitName(j)} should be ${want} and start at cycle ${c}, but tx reads ${t.tx[c]}${j > 0 && t.tx[c - 1] !== t.tx[c] ? ' (it moved early)' : ''}: each bit lasts 16 · ${k.div} = ${D} cycles` : `byte ${i + 1} (${hex(byte)}): ${bitName(j)} should be ${want} for all ${D} cycles but tx changes to ${t.tx[c]} ${off} cycles in${off < D / 2 ? '' : ` (${D - off} short)`}: each bit lasts 16 · ${k.div} = ${D} cycles`);
        }
      }
      for (let c = acc + 1; c < s + 9 * D + 14 * k.div && !fails.some((f) => f.startsWith(who)); c++) if (!t.busy[c]) { bad(`byte ${i + 1}: busy fell at cycle ${c}, in the middle of the frame (the stop bit starts at cycle ${s + 9 * D}): it is 1 while the frame is on the line`); }
      if (i === 1 && !fails.some((f) => f.startsWith(who)) && s < from - D + 15 * k.div) bad(`the second start bit came ${s - (from - D)} cycles after the first frame's stop bit began: the stop bit must last its 16 ticks (${D} cycles) before the next frame, within a tick`);
      for (let c = s + 10 * D + 1; c < Math.min(t.tx.length, s + 10 * D + 1 + 3 * D) && i === 1 && !fails.some((f) => f.startsWith(who)); c++) if (t.busy[c]) { bad(`busy is still 1 at cycle ${c}, after the last byte's stop bit: a new byte must be accepted`); }
      from = s + 10 * D;
    });
    if (!fails.some((f) => f.startsWith(who)) && t.tx.slice(from).some((v) => !v)) bad('tx fell again after the second frame: a go while busy was ignored, but something started a third frame');
  });
  return finish(fails, TX_CASES.length, def);
}

// ---- l_uartrx: a receiver that survives a clock that is off and glitches ------------------------------------------------

/** A piece of what the far end puts on the line: a frame (a stop bit of 0 is a framing error), idle bit times, a break (low bit times), a glitch (low ticks). */
type Piece = { byte: number; stop?: 0 | 1 } | { idle: number } | { low: number } | { glitch: number };
interface RxScenario { name: string; div: number; /** clocks per bit of the sender (not a whole number: its clock is off) */ bit: number; pieces: Piece[]; bytes: number[]; ferr: number; hint: string }

/** The line level at every clock edge for a sequence of pieces (each starting where the last ended, possibly between two edges). */
export function lineOf(pieces: Piece[], bit: number, div: number, lead = 2.37): number[] {
  const segs: [number, number, number][] = []; // [from, to, level] in clocks
  let t = lead * bit;
  segs.push([0, t, 1]);
  const seg = (len: number, lv: number) => { segs.push([t, t + len, lv]); t += len; };
  for (const p of pieces) {
    if ('byte' in p) {
      seg(bit, 0);
      for (let i = 0; i < 8; i++) seg(bit, (p.byte >> i) & 1);
      seg(bit, p.stop ?? 1);
    } else if ('idle' in p) seg(p.idle * bit, 1);
    else if ('low' in p) seg(p.low * bit, 0);
    else seg(p.glitch * div, 0);
  }
  seg(4 * bit, 1);
  const n = Math.ceil(t);
  return Array.from({ length: n }, (_, k) => segs.find((s) => k >= s[0] && k < s[1])?.[2] ?? 1);
}

const RX_BYTES = [0xa5, 0x3c, 0xff, 0x00, 0x81];
const frames = (bytes: number[]): Piece[] => bytes.map((byte) => ({ byte }));
export const RX_SCENARIOS: RxScenario[] = [
  { name: 'nominal, div 1', div: 1, bit: 16, pieces: [...frames(RX_BYTES)], bytes: RX_BYTES, ferr: 0, hint: 'a frame with every bit 16 ticks long, one frame right after another' },
  { name: 'nominal, div 3, gaps', div: 3, bit: 48, pieces: [{ byte: 0x5a }, { idle: 3 }, { byte: 0xc3 }, { idle: 1 }, { byte: 0x01 }], bytes: [0x5a, 0xc3, 0x01], ferr: 0, hint: 'frames with idle time between them' },
  { name: 'sender 4% fast, div 1', div: 1, bit: 16 * 0.96, pieces: frames(RX_BYTES), bytes: RX_BYTES, ferr: 0, hint: 'the sender\'s clock is 4% fast: its bits are 15.4 ticks, so a sample 16 ticks after the last one drifts toward the next bit; every start edge must restart the count, and the first sample must be in the middle of the start bit' },
  { name: 'sender 4% slow, div 3', div: 3, bit: 48 * 1.04, pieces: frames(RX_BYTES), bytes: RX_BYTES, ferr: 0, hint: 'the sender\'s clock is 4% slow: sampling must stay near the middle of each bit all the way to the stop bit' },
  { name: 'sender 3% fast, div 3, no gaps', div: 3, bit: 48 * 0.97, pieces: frames([0x00, 0xff, 0xaa, 0x55, 0x12, 0xf0]), bytes: [0x00, 0xff, 0xaa, 0x55, 0x12, 0xf0], ferr: 0, hint: 'the next start edge arrives before a receiver that counts a whole stop bit would be ready for it: it must be back to idle in the middle of the stop bit' },
  { name: 'glitches on an idle line', div: 1, bit: 16, pieces: [{ idle: 2 }, { glitch: 5 }, { idle: 2 }, { glitch: 1 }, { idle: 1 }, { byte: 0x7e }, { idle: 2 }, { glitch: 6 }, { idle: 3 }, { byte: 0x81 }], bytes: [0x7e, 0x81], ferr: 0, hint: 'a low pulse of a few ticks on an idle line is not a start bit: the middle of the start bit must still be low' },
  { name: 'framing error, then a break', div: 3, bit: 48, pieces: [{ byte: 0x42 }, { byte: 0x99, stop: 0 }, { idle: 2 }, { byte: 0x18 }, { low: 25 }, { idle: 2 }, { byte: 0xe7 }], bytes: [0x42, 0x18, 0xe7], ferr: 2, hint: 'a stop bit of 0 is a framing error (ferr, no push), and a line held low is one error, not a stream of 0x00 bytes: the receiver waits for the line to go high' },
  { name: 'sender 2% slow with glitches, div 1', div: 1, bit: 16 * 1.02, pieces: [{ glitch: 4 }, { idle: 1 }, { byte: 0x6b }, { byte: 0xd4 }, { glitch: 3 }, { idle: 2 }, { byte: 0x0f }], bytes: [0x6b, 0xd4, 0x0f], ferr: 0, hint: 'a slow sender and noise together' },
];

export function runUartRx(def: ComponentDef, mode: 'gate' | 'switch'): CustomRun {
  if (mode === 'switch') return { failures: ['switch level: the receiver is gates'], tested: 0 };
  const sim = simOf(def, ['rx', 'tick', 'clk', 'data', 'push', 'ferr', 'busy']);
  if (typeof sim === 'string') return { failures: [sim], tested: 0 };
  const sc = RX_SCENARIOS, n = sc.length;
  const lines = sc.map((s) => lineOf(s.pieces, s.bit, s.div));
  const len = Math.max(...lines.map((l) => l.length));
  const got: { c: number; data: number }[][] = sc.map(() => []), ferrs: number[][] = sc.map(() => []), busyAt: number[][] = sc.map(() => []);
  for (let c = 0; c < len + 8; c++) {
    sim.setInput('rx', lines.map((l) => l[c] ?? 1));
    sim.setInput('tick', sc.map((s) => (c % s.div === 0 ? 1 : 0)));
    sim.settle();
    const push = sim.get('push', n), ferr = sim.get('ferr', n), data = sim.get('data', n), busy = sim.get('busy', n);
    for (let l = 0; l < n; l++) {
      if (push[l]) got[l].push({ c, data: data[l] });
      if (ferr[l]) ferrs[l].push(c);
      busyAt[l].push(busy[l]);
    }
    sim.cycle();
  }
  const fails: string[] = [];
  sc.forEach((s, l) => {
    const bytes = got[l].map((g) => g.data), want = s.bytes;
    const w = `${s.name}`;
    const sameBytes = bytes.length === want.length && bytes.every((b, i) => b === want[i]);
    if (!sameBytes) {
      const i = bytes.findIndex((b, k) => b !== want[k]);
      const k = i < 0 ? Math.min(bytes.length, want.length) : i;
      fails.push(`${w}: pushed ${bytes.length ? bytes.map((b) => hex(b)).join(' ') : 'nothing'}, expected ${want.map((b) => hex(b)).join(' ')}${k < want.length && k < bytes.length ? ` (byte ${k + 1} read ${hex(bytes[k])}, not ${hex(want[k])})` : k < want.length ? ` (byte ${k + 1}, ${hex(want[k])}, never came)` : ` (an extra ${hex(bytes[k])} at cycle ${got[l][k].c})`}. ${s.hint}`);
    } else if (ferrs[l].length !== s.ferr) fails.push(`${w}: ferr pulsed ${ferrs[l].length} time${ferrs[l].length === 1 ? '' : 's'}, expected ${s.ferr}. ${s.hint}`);
    else if (busyAt[l][0] !== 0 || busyAt[l][busyAt[l].length - 1] !== 0) fails.push(`${w}: busy must be 0 while the line is idle (it was ${busyAt[l][0]} at the start and ${busyAt[l][busyAt[l].length - 1]} at the end)`);
    else if (!busyAt[l].some((b) => b === 1)) fails.push(`${w}: busy never rose: it is 1 from a start edge until the receiver is back to idle`);
  });
  return finish(fails, n, def);
}
