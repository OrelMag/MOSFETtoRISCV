// The benches of act 12 (Links, roadmap Phase 21 g). Each far end is a JS model that knows its rules and names the first
// one a circuit breaks: the destination's clock and the failure rate of a synchronizer (phys/metastable.ts), a UART receiver
// that samples a frame in the middle of each bit, an I²C bus wired as an AND with a rival controller on it, a CRC check on the
// frame's far end, a decoder that counts disparity, a receiver that must lock to a drifting stream. Lanes of a BitSim run one
// scenario each. No DOM.

import type { CustomRun } from '../editor/challenges';
import { BitSim } from '../sim/bitsim';
import { SwitchSim } from '../sim/switchsim';
import { B0, B1 } from '../sim/types';
import { flatten } from '../sim/flatten';
import { analyzeTiming } from '../sim/timing';
import { PS_PER_NAND } from '../sim/timing';
import type { ComponentDef } from '../sim/types';
import { margin, reachKm, REPEATER_SECTION_KM } from '../phys/telegraph';
import { fmtLog10, log10Mtbf, resolutionTime, TAU_PS, T0_PS, windowRate } from '../phys/metastable';
import { CMD_NAMES as I2C_CMD_NAMES, I2cController as I2cControllerModel, I2cTarget as I2cTargetModel, READ as I2C_READ, START as I2C_START, STOP as I2C_STOP, WRITE as I2C_WRITE } from '../comm/i2c';
import { codeText, decode8b10b, encodeStream, disparityOf, K_CODES, MAX_RUN_8B10B, nameOf, type Rd, validByte } from '../comm/linecode';
import { CRC32_INIT, CRC32_RESIDUE, fcsBytes, stepBits } from '../comm/crc';
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

// ---- l_uarttx: a frame at the divisors tried ------------------------------------------------------------------------------------

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

// ---- l_crc: CRC-32, a byte a clock -------------------------------------------------------------------------------------------

const bitsDiffer = (a: number, b: number): string => { const x = (a ^ b) >>> 0, l: number[] = []; for (let i = 0; i < 32; i++) if ((x >>> i) & 1) l.push(i); return l.length > 6 ? `${l.length} bits` : `bit${l.length > 1 ? 's' : ''} ${l.join(', ')}`; };

interface CrcStep { init: number; en: number; d: number; /** what the model's register holds after this clock */ q: number; what: string }

/**
 * Lane schedules: lane 0 is the standard check string "123456789", lane 1 an empty frame, the others seeded frames with idle clocks
 * (en = 0, junk on d) and, on some, an init in the middle (it beats en); each ends with the frame's own FCS, least significant byte first,
 * after which the register must hold the residue.
 */
export function crcSchedules(lanes: number): { name: string; steps: CrcStep[] }[] {
  return Array.from({ length: lanes }, (_, l) => {
    const r = rng(900 + l);
    const frame = l === 0 ? Array.from('123456789', (c) => c.charCodeAt(0)) : Array.from({ length: l === 1 ? 0 : 1 + Math.floor(r() * 24) }, () => Math.floor(r() * 256));
    const steps: CrcStep[] = [];
    let q = 0;
    const push = (init: number, en: number, d: number, what: string) => {
      q = init ? CRC32_INIT : en ? stepBits(q, d, 8) >>> 0 : q;
      steps.push({ init, en, d, q, what });
    };
    push(1, 0, 0, 'after init');
    if (l % 5 === 4) { push(0, 1, Math.floor(r() * 256), 'after a byte'); push(1, 1, 0xaa, 'after init with en = 1 (init beats en)'); }
    let n = 0;
    for (const b of frame) {
      if (l > 1 && r() < 0.25) { const junk = Math.floor(r() * 256); push(0, 0, junk, `with en = 0 and d = ${hex(junk)} (en = 0 holds the register)`); }
      push(0, 1, b, `after byte ${++n} (${hex(b)})`);
    }
    const fcs = fcsBytes((~q) >>> 0);
    fcs.forEach((b, i) => push(0, 1, b, `after FCS byte ${i + 1} (${hex(b)})`));
    return { name: l === 0 ? 'the check string "123456789"' : l === 1 ? 'an empty frame' : `a frame of ${frame.length} byte${frame.length === 1 ? '' : 's'} (seed ${l})`, steps };
  });
}

export function runCrc(def: ComponentDef, mode: 'gate' | 'switch'): CustomRun {
  if (mode === 'switch') return { failures: ['switch level: the CRC unit is gates'], tested: 0 };
  const sim = simOf(def, ['d', 'en', 'init', 'clk', 'q', 'fcs']);
  if (typeof sim === 'string') return { failures: [sim], tested: 0 };
  const lanes = 16, sch = crcSchedules(lanes), fails: string[] = [], failed = new Set<number>();
  const nSteps = Math.max(...sch.map((s) => s.steps.length));
  for (let t = 0; t < nSteps; t++) {
    const st = sch.map((s) => s.steps[t] ?? { init: 0, en: 0, d: 0, q: 0, what: '' });
    sim.setInput('init', st.map((s) => s.init)); sim.setInput('en', st.map((s) => s.en)); sim.setInput('d', st.map((s) => s.d));
    sim.cycle();
    const q = sim.get('q', lanes), fcs = sim.get('fcs', lanes);
    for (let l = 0; l < lanes; l++) {
      const s = sch[l].steps[t];
      if (!s || failed.has(l)) continue;
      if (q[l] >>> 0 !== s.q) {
        failed.add(l);
        const hint = s.init ? 'init loads all ones, whatever en says' : s.en ? 'the first bit sent is d[0]; the register shifts right, the generator is the reflected 0xEDB88320 and a byte is eight such steps' : 'en = 0 holds the register';
        fails.push(`${sch[l].name}, ${s.what}: q = ${hex(q[l], 8)}, expected ${hex(s.q, 8)} (${bitsDiffer(q[l], s.q)} differ). ${hint}`);
      } else if (fcs[l] >>> 0 !== (~q[l]) >>> 0) {
        failed.add(l);
        fails.push(`${sch[l].name}, ${s.what}: fcs = ${hex(fcs[l], 8)} but q = ${hex(q[l], 8)}: fcs is the complement of q, the check sequence as it goes on the wire`);
      }
    }
  }
  if (!fails.length) {
    for (const s of sch) {
      const end = s.steps[s.steps.length - 1].q;
      if (end !== CRC32_RESIDUE) fails.push(`${s.name}: after the frame and its own FCS the register holds ${hex(end, 8)}, not the residue ${hex(CRC32_RESIDUE, 8)}`);
    }
  }
  return finish(fails, lanes, def);
}

// ---- l_8b10b: an encoder that keeps the line balanced ------------------------------------------------------------------------

const ones10 = (x: number) => { let n = 0; for (let i = 0; i < 10; i++) n += (x >> i) & 1; return n; };
const bitsOf10 = (x: number): number[] => Array.from({ length: 10 }, (_, i) => (x >> (9 - i)) & 1); // a first
const runOf = (bits: number[]): number => { let best = 0, run = 0, prev = -1; for (const b of bits) { run = b === prev ? run + 1 : 1; prev = b; best = Math.max(best, run); } return best; };

/** Every byte and the twelve control codes at both disparities, then streams: the far end is a decoder that follows the running disparity. */
export function run8b10b(def: ComponentDef, mode: 'gate' | 'switch'): CustomRun {
  if (mode === 'switch') return { failures: ['switch level: the encoder is gates'], tested: 0 };
  const sim = simOf(def, ['d', 'k', 'rd', 'code', 'rdout']);
  if (typeof sim === 'string') return { failures: [sim], tested: 0 };
  const fails: string[] = [];
  const vecs: { v: number; k: boolean; rd: Rd }[] = [];
  for (const rd of [0, 1] as Rd[]) {
    for (let v = 0; v < 256; v++) { if (validByte(v, false)) vecs.push({ v, k: false, rd }); }
    for (const v of K_CODES) vecs.push({ v, k: true, rd });
  }
  const rdName = (rd: number) => (rd ? 'RD+' : 'RD−');
  const judge = (x: { v: number; k: boolean; rd: Rd }, code: number, rdout: number, ctx = ''): string | null => {
    const nm = nameOf(x.v, x.k), at = `${nm} at ${rdName(x.rd)}${ctx}`;
    const six = code >> 4, four = code & 15;
    const d6 = disparityOf(six, 6), d4 = disparityOf(four, 4);
    if (![-2, 0, 2].includes(d6)) return `${at}: ${codeText(code)} has ${ones10(six)} ones in its 6b block: a block may be balanced or off by two, never more`;
    if (![-2, 0, 2].includes(d4)) return `${at}: ${codeText(code)} has ${ones10(four)} ones in its 4b block: a block may be balanced or off by two, never more`;
    const after6 = (x.rd ? 1 : -1) + d6;
    if (Math.abs(after6) > 1) return `${at}: ${codeText(code)}: the 6b block takes the running disparity from ${rdName(x.rd)} to ${after6 > 0 ? '+' : ''}${after6}: with ${rdName(x.rd)} it must have ${x.rd ? 'no more ones than zeros' : 'no fewer ones than zeros'} (a disparity within ±1 on the wire)`;
    const after4 = after6 + d4;
    if (Math.abs(after4) > 1) return `${at}: ${codeText(code)}: the 4b block takes the running disparity from ${after6 > 0 ? '+1' : '−1'} to ${after4 > 0 ? '+' : ''}${after4}: it must pull back toward zero`;
    if (runOf(bitsOf10(code)) > MAX_RUN_8B10B) return `${at}: ${codeText(code)} has a run of ${runOf(bitsOf10(code))} equal bits; the receiver\'s clock recovery needs a transition at least every ${MAX_RUN_8B10B}`;
    const want = after4 > 0 ? 1 : 0;
    if (rdout !== want) return `${at}: ${codeText(code)} leaves the running disparity at ${rdName(want)}, but rdout = ${rdout}`;
    const dec = decode8b10b(code, x.rd);
    if (dec.err || dec.v !== x.v || dec.k !== x.k) return `${at}: ${codeText(code)} decodes as ${dec.err ? `an error (${dec.err})` : nameOf(dec.v, dec.k)}: the table says another code stands for ${nm}`;
    return null;
  };
  const lanes = 32;
  for (let o = 0; o < vecs.length && fails.length < 3; o += lanes) {
    const part = vecs.slice(o, o + lanes);
    sim.setInput('d', part.map((x) => x.v)); sim.setInput('k', part.map((x) => (x.k ? 1 : 0))); sim.setInput('rd', part.map((x) => x.rd));
    sim.settle();
    const code = sim.get('code', part.length), rdo = sim.get('rdout', part.length);
    part.forEach((x, i) => { if (fails.length < 3) { const m = judge(x, code[i], rdo[i]); if (m) fails.push(m); } });
  }
  if (!fails.length) {
    // streams: the learner's own rdout fed back, 32 seeded streams of 40 symbols with commas and data; the line's balance and runs across symbol boundaries
    const r = rng(77), N = 40;
    const stream = Array.from({ length: lanes }, () => Array.from({ length: N }, () => { const kk = r() < 0.15; const v = kk ? K_CODES[Math.floor(r() * K_CODES.length)] : Math.floor(r() * 256); return { v, k: kk }; }));
    const rd = new Array<number>(lanes).fill(0), bits: number[][] = Array.from({ length: lanes }, () => []), disp = new Array<number>(lanes).fill(0);
    for (let t = 0; t < N && !fails.length; t++) {
      const cur = stream.map((s, l) => ({ v: s[t].v, k: s[t].k, rd: rd[l] as Rd }));
      sim.setInput('d', cur.map((x) => x.v)); sim.setInput('k', cur.map((x) => (x.k ? 1 : 0))); sim.setInput('rd', cur.map((x) => x.rd));
      sim.settle();
      const code = sim.get('code', lanes), rdo = sim.get('rdout', lanes);
      for (let l = 0; l < lanes && !fails.length; l++) {
        const m = judge(cur[l], code[l], rdo[l], ` (stream ${l + 1}, symbol ${t + 1})`);
        if (m) { fails.push(m); break; }
        rd[l] = rdo[l]; bits[l].push(...bitsOf10(code[l])); disp[l] += ones10(code[l]) * 2 - 10;
        if (Math.abs(disp[l]) > 2) fails.push(`stream ${l + 1}, symbol ${t + 1}: the line has drifted to a disparity of ${disp[l]}: each symbol must leave the running disparity at +1 or −1`);
        if (runOf(bits[l].slice(-20)) > MAX_RUN_8B10B) fails.push(`stream ${l + 1}, symbol ${t + 1}: a run of ${runOf(bits[l].slice(-20))} equal bits across two symbols`);
      }
    }
  }
  return finish(fails, vecs.length, def);
}

// ---- l_cdr: clock recovery on a drifting stream ------------------------------------------------------------------------------

interface CdrScenario { name: string; /** accumulator step per cycle at cycle t (4096 per bit; 1024 is 4 cycles a bit) */ inc: (t: number) => number; acc0: number; seed: number; hint: string }
export const CDR_CYCLES = 7000;
export const CDR_SCENARIOS: CdrScenario[] = [
  { name: 'a sender on the nominal rate', inc: () => 1024, acc0: 0, seed: 1, hint: 'four cycles a bit exactly, the start edge anywhere' },
  { name: 'a sender 1.5% fast', inc: () => 1039, acc0: 1500, seed: 2, hint: 'the sender is 1.5% fast: its edges walk toward the early side and the strobe must follow them, one sample at a time' },
  { name: 'a sender 1.5% slow', inc: () => 1009, acc0: 3000, seed: 3, hint: 'the sender is 1.5% slow: its edges walk toward the late side' },
  { name: 'a sender drifting from nominal to 2.5% fast', inc: (t) => Math.round(1024 * (1 + (0.025 * t) / CDR_CYCLES)), acc0: 700, seed: 4, hint: 'the sender\'s clock changes while the stream runs (a warming crystal): the loop must keep following' },
  { name: 'a sender drifting from nominal to 2.5% slow', inc: (t) => Math.round(1024 * (1 - (0.025 * t) / CDR_CYCLES)), acc0: 2300, seed: 5, hint: 'the same in the other direction' },
  { name: 'a sender 2% slow then 2% fast', inc: (t) => (t < CDR_CYCLES / 2 ? 1004 : 1044), acc0: 100, seed: 6, hint: 'the drift changes sign halfway: the loop must unwind what it has accumulated' },
];

/** A scenario's line, a level per cycle, and the bits behind it. */
export function cdrLine(s: CdrScenario): { line: number[]; bits: number[] } {
  const r = rng(300 + s.seed);
  const words: { v: number; k?: boolean }[] = [];
  for (let i = 0; i < 400; i++) words.push(i % 8 === 0 ? { v: (5 << 5) | 28, k: true } : { v: Math.floor(r() * 256) });
  const bits = encodeStream(words).bits;
  const line: number[] = [];
  let acc = s.acc0, i = 0;
  for (let t = 0; t < CDR_CYCLES; t++) {
    line.push(bits[i % bits.length]);
    acc += s.inc(t);
    while (acc >= 4096) { acc -= 4096; i++; }
  }
  return { line, bits };
}

export function runCdr(def: ComponentDef, mode: 'gate' | 'switch'): CustomRun {
  if (mode === 'switch') return { failures: ['switch level: the receiver is gates'], tested: 0 };
  const sim = simOf(def, ['rxd', 'clk', 'bit', 'strobe']);
  if (typeof sim === 'string') return { failures: [sim], tested: 0 };
  const sc = CDR_SCENARIOS, n = sc.length, ls = sc.map(cdrLine);
  const got: number[][] = sc.map(() => []), at: number[][] = sc.map(() => []);
  for (let t = 0; t < CDR_CYCLES; t++) {
    sim.setInput('rxd', ls.map((l) => l.line[t]));
    sim.settle();
    const st = sim.get('strobe', n), bit = sim.get('bit', n);
    for (let l = 0; l < n; l++) if (st[l]) { got[l].push(bit[l]); at[l].push(t); }
    sim.cycle();
  }
  const fails: string[] = [];
  const SKIP = 100;
  sc.forEach((s, l) => {
    const rec = got[l], sent = ls[l].bits;
    const per = (CDR_CYCLES / Math.max(1, rec.length)).toFixed(2);
    if (rec.length < 0.9 * CDR_CYCLES / 4.3) { fails.push(`${s.name}: ${rec.length} strobes in ${CDR_CYCLES} cycles (one every ${per}): the bit strobe must come once a bit, about every 4 cycles. ${s.hint}`); return; }
    const win = rec.slice(SKIP, SKIP + 40).join('');
    let off = -999;
    for (let o = -60; o < 200 && off === -999; o++) if (sent.slice(o + SKIP, o + SKIP + 40).join('') === win) off = o;
    if (off === -999) { fails.push(`${s.name}: no lock. The bits taken at the strobe, from bit ${SKIP + 1} on, never match the stream that was sent. ${s.hint}`); return; }
    for (let i = SKIP; i < rec.length; i++) {
      if (rec[i] !== sent[(off + i) % sent.length]) {
        const dup = rec[i] === sent[(off + i - 1 + sent.length) % sent.length] && rec[i + 1] === sent[(off + i) % sent.length];
        fails.push(`${s.name}: locked, then at bit ${i + 1} (cycle ${at[l][i]}) it read ${rec[i]}, the stream had ${sent[(off + i) % sent.length]}${dup ? ': a bit was sampled twice' : ''}. The sample point slipped by a whole bit. ${s.hint}`);
        return;
      }
    }
  });
  return finish(fails, n, def);
}

// ---- l_i2c: a controller on a wired-AND bus ----------------------------------------------------------------------------------

type I2cCmd = [number, number];
const addrW = (a: number): I2cCmd => [I2C_WRITE, a << 1], addrR = (a: number): I2cCmd => [I2C_WRITE, (a << 1) | 1];
interface I2cScenario { name: string; script: I2cCmd[]; target?: { adr: number; stretch?: number }; /** a rival controller's script, started together */ rival?: I2cCmd[]; lostExpected?: boolean }
const frame = (a: number): I2cCmd[] => [[I2C_START, 0], addrW(a), [I2C_WRITE, 0], [I2C_WRITE, 0x3c], [I2C_STOP, 0]];
export const I2C_SCENARIOS: I2cScenario[] = [
  { name: 'write a register, then read it back after a repeated START', script: [[I2C_START, 0], addrW(0x50), [I2C_WRITE, 1], [I2C_WRITE, 0xa7], [I2C_STOP, 0], [I2C_START, 0], addrW(0x50), [I2C_WRITE, 1], [I2C_START, 0], addrR(0x50), [I2C_READ, 0], [I2C_READ, 1], [I2C_STOP, 0]], target: { adr: 0x50 } },
  { name: 'an address nobody has', script: [[I2C_START, 0], addrW(0x2a), [I2C_WRITE, 3], [I2C_WRITE, 0x11], [I2C_STOP, 0]], target: { adr: 0x50 } },
  { name: 'a target that stretches SCL', script: [[I2C_START, 0], addrW(0x51), [I2C_WRITE, 2], [I2C_WRITE, 0x5c], [I2C_START, 0], addrW(0x51), [I2C_WRITE, 2], [I2C_START, 0], addrR(0x51), [I2C_READ, 1], [I2C_STOP, 0]], target: { adr: 0x51, stretch: 5 } },
  ...[0, 2, 4, 6].map((bit): I2cScenario => {
    const win = 0x50, lose = win ^ (1 << (6 - bit)) | 0;
    const a = Math.max(win, lose), b = Math.min(win, lose);
    return { name: `arbitration lost at address bit ${bit} (yours ${a.toString(16)}, theirs ${b.toString(16)})`, script: frame(a), rival: frame(b), target: { adr: b }, lostExpected: true };
  }),
  ...[1, 5].map((bit): I2cScenario => {
    const win = 0x50, other = win ^ (1 << (6 - bit));
    const mine = Math.min(win, other), theirs = Math.max(win, other);
    return { name: `arbitration won at address bit ${bit} (yours ${mine.toString(16)}, theirs ${theirs.toString(16)})`, script: frame(mine), rival: frame(theirs), target: { adr: mine } };
  }),
];

const OUT_RULES: Record<string, string> = {
  ready: 'ready is 0 from the clock after go until the command\'s last phase is over; a command is four phases of two clocks per bit cell (START and STOP are one cell, a byte is nine)',
  dout: 'dout is the byte read, shifted in at the end of each SCL-high phase, most significant bit first',
  ack: 'ack is 1 when the target pulled SDA low in the ninth cell of a WRITE (sampled at the end of its SCL-high phase)',
  lost: 'a controller that let go of SDA (sent a 1) and reads 0 at the end of the SCL-high phase has lost: lost = 1 and both lines are released at once',
  sda_o: 'sda_o = 1 pulls SDA low; it changes only as a cell\'s phase 0 begins (START and STOP: at the phases the standard puts the edge)',
  scl_o: 'scl_o = 1 pulls SCL low: low in phases 0 and 3, released in 1 and 2, and phase 1 waits until SCL really reads high (clock stretching, other controllers)',
};

export function runI2c(def: ComponentDef, mode: 'gate' | 'switch'): CustomRun {
  if (mode === 'switch') return { failures: ['gate level: the controller\'s pads are the bench\'s wired AND'], tested: 0 };
  const sim = simOf(def, ['clk', 'rst', 'go', 'cmd', 'din', 'sda_i', 'scl_i', 'ready', 'dout', 'ack', 'lost', 'sda_o', 'scl_o']);
  if (typeof sim === 'string') return { failures: [sim], tested: 0 };
  const sc = I2C_SCENARIOS, n = sc.length;
  const gold = sc.map(() => new I2cControllerModel()), riv = sc.map(() => new I2cControllerModel()), tgt = sc.map((s) => (s.target ? new I2cTargetModel() : undefined));
  const idx = sc.map(() => 0), ridx = sc.map(() => 0), last = sc.map(() => -1);
  const sda = new Array<number>(n).fill(1), scl = new Array<number>(n).fill(1);
  const why = new Array<string>(n).fill('');
  const names = ['ready', 'dout', 'ack', 'lost', 'sda_o', 'scl_o'] as const;
  const finished = (l: number, c: number) => c > 8 && gold[l].out.ready && (idx[l] >= sc[l].script.length || gold[l].lost) && (!sc[l].rival || (riv[l].out.ready && (ridx[l] >= sc[l].rival!.length || riv[l].lost)));
  for (let c = 0; c < 2600 && why.some((w, l) => !w && !finished(l, c)); c++) {
    const rst = c === 0 ? 1 : 0;
    const ins = sc.map((s, l) => {
      let go = 0, cmd = 0, din = 0;
      const g = gold[l];
      if (!rst && g.out.ready && idx[l] < s.script.length && !(g.lost && s.script[idx[l]][0] !== I2C_START)) { go = 1; [cmd, din] = s.script[idx[l]++]; last[l] = cmd; }
      return { rst, go, cmd, din, sda_i: sda[l], scl_i: scl[l] };
    });
    for (const k of ['rst', 'go', 'cmd', 'din', 'sda_i', 'scl_i'] as const) sim.setInput(k, ins.map((i) => i[k]));
    sim.cycle();
    const got: Record<string, number[]> = {};
    for (const nm of names) got[nm] = sim.get(nm, n);
    sc.forEach((s, l) => {
      const i = ins[l], g = gold[l];
      const ph = g.ph, bc = g.bc, cmd = g.cmd;
      g.step(i);
      if (!why[l]) {
        for (const nm of names) {
          if (got[nm][l] !== g.out[nm]) {
            why[l] = `${s.name}, clock ${c}: ${nm} = ${got[nm][l]}, expected ${g.out[nm]} (${I2C_CMD_NAMES[g.cmd]}${g.act ? `, bit cell ${g.bc}, phase ${g.ph}` : ''}; before this clock: ${I2C_CMD_NAMES[cmd]}, cell ${bc}, phase ${ph}). ${OUT_RULES[nm]}`;
            break;
          }
        }
      }
      const outs = [g.out];
      if (s.rival) {
        const r = riv[l];
        let go = 0, cmd2 = 0, din = 0;
        if (!rst && r.out.ready && ridx[l] < s.rival.length && !(r.lost && s.rival[ridx[l]][0] !== I2C_START)) { go = 1; [cmd2, din] = s.rival[ridx[l]++]; }
        r.step({ rst, go, cmd: cmd2, din, sda_i: sda[l], scl_i: scl[l] });
        outs.push(r.out);
      }
      const t = tgt[l];
      let to = { sda_o: 0, scl_o: 0 };
      if (t) { t.step({ rst, sda_i: sda[l], scl_i: scl[l], adr: s.target!.adr, stretch: s.target!.stretch ?? 0 }); to = t.out; }
      sda[l] = outs.some((o) => o.sda_o) || to.sda_o ? 0 : 1;
      scl[l] = outs.some((o) => o.scl_o) || to.scl_o ? 0 : 1;
    });
  }
  const fails = sc.flatMap((s, l) => {
    if (why[l]) return [why[l]];
    if (s.lostExpected && !gold[l].lost) return [`${s.name}: the bench\'s own model did not lose; the scenario is wrong`];
    return [];
  });
  return finish(fails, n, def);
}

// ---- l_repeater: a line twice as long as one battery drives ---------------------------------------------------------------------

/** A section a battery can drive to a relay's coil with margin, and the line the station serves: twice that. */
export const LINE_SECTION_KM = REPEATER_SECTION_KM, LINE_KM = 2 * LINE_SECTION_KM, LINE_VOLTS = 24;

/**
 * The line between the far stations is two sections long. A relay at the end of a section sees only what the line lets through, so
 * the station must send the signal on from a battery of its own: the output must share no conductor with the line. A contact that
 * joins them passes the weak signal on (and the next section is then twice as long, beyond one battery's reach).
 */
export function repeaterProblems(def: ComponentDef): string[] {
  let d;
  try { d = flatten(def, { mode: 'switch' }); } catch { return []; }
  const parent = new Map<number, number>();
  const find = (x: number): number => { let r = x; while ((parent.get(r) ?? r) !== r) r = parent.get(r)!; parent.set(x, r); return r; };
  const supply = new Set<number>();
  for (const l of d.leaves) if ((l.kind === 'vdd' || l.kind === 'gnd') && l.terminals) supply.add(l.terminals[0]);
  const join = (a: number, b: number) => { if (!supply.has(a) && !supply.has(b)) parent.set(find(a), find(b)); };
  for (const l of d.leaves) {
    if (l.kind !== 'relay' || !l.terminals) continue;
    for (let p = 2; p + 2 < l.terminals.length; p += 3) { join(l.terminals[p], l.terminals[p + 1]); join(l.terminals[p], l.terminals[p + 2]); }
  }
  const line = d.root.ports.line ?? [], out = d.root.ports.out ?? [];
  const reach = reachKm(LINE_VOLTS, 'iron');
  if (line.length && out.length && find(line[0]) === find(out[0])) {
    const m1 = margin(LINE_VOLTS, LINE_KM, 'iron');
    return [`out is joined to line by wire or by contacts: the signal is passed on as it came. The line behind this station is ${LINE_SECTION_KM} km long and a ${LINE_VOLTS} V battery drives ${LINE_SECTION_KM} km of iron wire to a relay coil with a margin of ${margin(LINE_VOLTS, LINE_SECTION_KM, 'iron').toFixed(2)}; passed on, it is ${LINE_KM} km to the far relay, a margin of ${m1.toFixed(2)} (pull-in is 1.00, one battery reaches ${reach.toFixed(0)} km). The station must re-send the signal from a battery of its own: out may share no conductor with line.`];
  }
  return [];
}

// ---- l_dial: a stepping selector ------------------------------------------------------------------------------------------------

/** The numbers dialled, one after another, each after a hang-up. */
export const DIALLED = [3, 0, 7, 1, 5, 2, 6, 4];

export function runDial(def: ComponentDef, mode: 'gate' | 'switch'): CustomRun {
  if (mode !== 'switch') return { failures: ['no relays: build the selector from relays'], tested: 0 };
  const have = new Set(def.ports.map((p) => p.name));
  const miss = ['line', 'pulse', 'hangup', 'count', 'y'].filter((p) => !have.has(p));
  if (miss.length) return { failures: [`missing pins: ${miss.join(', ')}`], tested: 0 };
  const sim = new SwitchSim(flatten(def, { mode: 'switch' }));
  if (!sim.hasRelays) return { failures: ['no relays: build the selector from relays'], tested: 0 };
  const val = (p: string): number => { const b = sim.getBits(sim.design.root.ports[p]); return b.some((x) => x !== B0 && x !== B1) ? -1 : b.reduce<number>((s, x, i) => s + (x === B1 ? 2 ** i : 0), 0); };
  const show = (p: string, v: number) => (v < 0 ? `${p} = X or Z` : p === 'y' ? `y = ${v} (the line is on output ${v === 0 ? 'none' : Math.log2(v)})` : `${p} = ${v}`);
  let steps = 0, tested = 0;
  const fails: string[] = [];
  const settle = (): boolean => { const t0 = sim.time; sim.settle(); steps = Math.max(steps, sim.time - t0); return !sim.unstable; };
  sim.setInput('line', 1); sim.setInput('pulse', 0); sim.setInput('hangup', 0);
  sim.reset('zero');
  if (!settle()) return { failures: ['at rest with nothing dialled it does not come to rest'], tested: 1 };
  const expectState = (what: string, n: number, hint: string): boolean => {
    tested++;
    const y = val('y'), c = val('count');
    if (y !== 1 << n || c !== n) { fails.push(`${what}: ${show('y', y)}, ${show('count', c)}; expected y = ${1 << n} (output ${n}) and count = ${n}. ${hint}`); return false; }
    return true;
  };
  if (!expectState('with nothing dialled', 0, 'with every relay released the caller\'s line is on output 0')) return finishRelay(fails, tested, steps);
  for (const num of DIALLED) {
    for (let k = 1; k <= num; k++) {
      sim.setInput('pulse', 1);
      if (!settle()) { fails.push(`dialling ${num}, pulse ${k} rising: it does not come to rest`); return finishRelay(fails, tested, steps); }
      if (!expectState(`dialling ${num}, pulse ${k} up`, k - 1, 'nothing may move until the pulse falls: the stage copies on the falling edge, so that a pulse of any length counts once')) return finishRelay(fails, tested, steps);
      sim.setInput('pulse', 0);
      if (!settle()) { fails.push(`dialling ${num}, pulse ${k} falling: it does not come to rest`); return finishRelay(fails, tested, steps); }
      if (!expectState(`dialling ${num}, pulse ${k} down`, k, 'each falling edge advances the selector by one output; bit 0 toggles, and its fall clocks bit 1, as in a ripple counter')) return finishRelay(fails, tested, steps);
    }
    sim.setInput('line', 0);
    settle(); tested++;
    if (val('y') !== 0) { fails.push(`dialled ${num}, caller\'s line low: ${show('y', val('y'))}; expected y = 0: only the dialled output follows the line`); return finishRelay(fails, tested, steps); }
    sim.setInput('line', 1);
    sim.setInput('hangup', 1); settle(); sim.setInput('hangup', 0);
    if (!settle()) { fails.push('after the hang-up it does not come to rest'); return finishRelay(fails, tested, steps); }
    if (!expectState(`after dialling ${num} and hanging up`, 0, 'the hang-up opens the hold rail of every stage: all released, the count back at 0')) return finishRelay(fails, tested, steps);
  }
  return finishRelay(fails, tested, steps);
}

function finishRelay(fails: string[], tested: number, steps: number): CustomRun {
  return { failures: fails.slice(0, 4), tested, steps };
}
