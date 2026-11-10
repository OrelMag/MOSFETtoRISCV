// Appendix E: the Manchester Baby (SSEM, 21 June 1948) in gates, word-wide (the 1948 machine was serial: a digit
// every 8.5 µs; widgets show that subtractor apart). One clock edge is one beat, four beats an instruction, as the
// replica manual and Lavington describe it:
//   S1 (scan 1)   CI = CI + 1 + T (T: the test flip-flop CMP set), the staticisor takes CI's digits 0–4, T clears
//   A1 (action 1) PI = the store line the staticisor names (the fetch)
//   S2 (scan 2)   the staticisor takes PI's digits 0–4 (the operand line)
//   A2 (action 2) the function in PI's digits 13–15 acts: JMP CI = S, JRP CI = CI + S, LDN A = −S, STO S = A,
//                 SUB A = A − S, CMP T = sign of A, STP the stop flip-flop H
// The store is a Williams tube (babyStore): a scan beat addresses the line the scan counter names and, with `regen` on,
// writes back what it read (regeneration); an action beat rewrites the line it reads, or A for STO. Its charge leaks:
// a line not rewritten for HOLD_BEATS beats reads its dashes (1s) as dots (0s). With regeneration every line comes round
// every 64 beats, so a running machine never sees the leak; with it off, the program goes wrong.
// The beat counter and the scan run on while H is set (the tube must be regenerated whatever the program does); every
// state change of the program is gated by ¬H.

import type { Behavior, ComponentDef, PortDef } from '../sim/types';
import { B0, B1, BX } from '../sim/types';
import { constWord } from './alu';
import { Builder } from './builder';
import { addSub, busMux2, decoder, rca } from './combinational';
import { define, splitter } from './define';
import { AND, NOT, OR } from './gates';
import { laid } from './layered';
import { ram } from './memory';
import { ramBehavior, wordsHash, type RamState } from './bigmem';
import { counter, DFF, DFFE, register } from './sequential';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const clk = (): PortDef => bit('clk', 'in', 'bottom', true);

/** The digit period and a beat: 32 digits and 4 of fly-back (Kilburn's 1947 report, §5.4: "8.5 microseconds"). */
export const DIGIT_US = 8.5;
export const BEAT_US = 36 * DIGIT_US;
/** "Short term memory of the order of 0.2 seconds" (Kilburn, report of December 1947, summary): an order of magnitude. */
export const HOLD_S = 0.2;
/** Beats a line keeps its dashes without being rewritten: HOLD_S in beats (654). */
export const HOLD_BEATS = Math.round((HOLD_S * 1e6) / BEAT_US);
/**
 * Beats between two regenerations of a line: one line per scan beat, two scan beats an instruction, so the whole store
 * every 16 instructions (Digital60, "The Williams-Kilburn Tube: Refreshing process"), 64 × 306 µs = 19.6 ms.
 */
export const REFRESH_BEATS = 64;

// ---------------------------------------------------------------- the store: a Williams tube

/** A tube's state: the RAM's words, and per line the beats since it was last written (its charge's age). */
export interface TubeState extends RamState { age: Uint32Array }

export const isTubeState = (s: unknown): s is TubeState => !!s && (s as TubeState).age instanceof Uint32Array;

/** What line i reads now: its word, its dashes lost when its charge is too old (-1: X). */
export function tubeWord(s: TubeState, i: number): number {
  if (s.x[i]) return -1;
  return s.age[i] > HOLD_BEATS ? 0 : s.mem[i];
}

/** Opened, the store's 1024 flip-flops (ram(5, 32): w<i>.ff<j>) take the words the tube reads. */
const seedTube: Behavior['inside'] = (st, seed) => {
  const s = st as TubeState;
  for (let i = 0; i < 32; i++) {
    const w = tubeWord(s, i);
    for (let j = 0; j < 32; j++) {
      const v = w < 0 ? [BX] : (w >>> j) & 1 ? [B1] : [B0], n = w < 0 ? [BX] : (w >>> j) & 1 ? [B0] : [B1];
      const f = `w${i}.ff${j}.ff`;
      seed.bits(`${f}.master.sr.q`, v); seed.bits(`${f}.master.sr.q_n`, n);
      seed.bits(`${f}.slave.sr.q`, v); seed.bits(`${f}.slave.sr.q_n`, n);
    }
  }
};

function tubeBehavior(init: ArrayLike<number>): Behavior {
  const base = ramBehavior(5, 32, Array.from(init, (v) => v >>> 0), seedTube);
  const fresh = (s: RamState): TubeState => ({ ...s, age: new Uint32Array(32) });
  return {
    ...base,
    init: (mode) => fresh(base.init!(mode) as RamState),
    eval: (ins, st) => {
      const s = st as TubeState, p = s.clk, writes = s.writes, wa = s.a;
      const [y] = base.eval!(ins, st) as number[];
      if (p === 0 && s.clk === 1) { // a rising edge: one beat older, the written line fresh
        for (let i = 0; i < 32; i++) s.age[i]++;
        if (s.writes !== writes && wa >= 0) s.age[wa] = 0;
      }
      const a = ins[0];
      return [a < 0 || y < 0 ? -1 : s.age[a] > HOLD_BEATS ? 0 : y];
    },
    carry: (prev, known) => {
      const r = base.carry!(prev, known) as RamState;
      return { ...r, age: isTubeState(prev) ? prev.age.slice() : new Uint32Array(32) };
    },
  };
}

const storeCache = new Map<string, ComponentDef>();

/**
 * The store: 32 lines of 32 digits on one Williams tube, holding `words` at power-on. Simulated as the tube (its words
 * and each line's age); opened, it is ram(5, 32): a decoder, 32 registers and a multiplexer tree, seeded from it.
 */
export function babyStore(words: ArrayLike<number> = []): ComponentDef {
  const init = Array.from({ length: 32 }, (_, i) => (words[i] ?? 0) >>> 0);
  const key = init.map((v) => v.toString(16)).join(',');
  let d = storeCache.get(key);
  if (d) return d;
  const base = ram(5, 32);
  d = {
    ...base,
    id: init.some((v) => v) ? `baby_store_${wordsHash(init)}` : 'baby_store',
    name: 'Store (Williams tube)',
    category: 'memory',
    summary: 'The main store: 32 lines of 32 digits as charge on a cathode-ray tube, read and rewritten line by line before it leaks away. Drawn here as the flip-flop memory it behaves like.',
    behavior: tubeBehavior(init),
    preferBehavior: true,
    spec: undefined,
  };
  storeCache.set(key, d);
  return d;
}

// ---------------------------------------------------------------- timing: beats and the scan

/** The beat counter (S1 A1 S2 A2 as 0–3) and the scan counter (the line regenerated next, one step per scan beat). */
export const BABY_TIMING: ComponentDef = (() => {
  const b = new Builder(8, 12, 3);
  const one = b.op1(constWord(1, 1), [], '1', 'one');
  b.next();
  const beat = b.op1(counter(2), [one, 'clk'], 'beat', 'beat');
  b.next();
  const dec = b.op(decoder(2), [beat], undefined, 'dec');
  const sp = b.op(splitter([1, 1]), [beat], undefined, 'sb');
  b.next();
  const scanBeat = b.op1(NOT, [`${sp}.o0`], undefined, 'nact');
  b.next();
  const scan = b.op1(counter(5), [scanBeat, 'clk'], 'scan', 'scan');
  b.wire(`${dec}.y0`, 's1'); b.wire(`${dec}.y1`, 'a1'); b.wire(`${dec}.y2`, 's2'); b.wire(`${dec}.y3`, 'a2');
  b.wire(`${sp}.o0`, 'action'); b.wire(beat, 'beat'); b.wire(scan, 'scan');
  b.name(beat, 'beat'); b.name(scanBeat, 'scanBeat');
  return define({
    id: 'baby_timing', name: 'Beats and scan', category: 'sequential',
    summary: 'A 2-bit counter steps through the four beats of an instruction (S1 A1 S2 A2); a 5-bit counter names the store line the next scan beat regenerates.',
    ports: [clk(), bus('beat', 2, 'out'), bit('s1', 'out'), bit('a1', 'out'), bit('s2', 'out'), bit('a2', 'out'), bit('action', 'out'), bus('scan', 5, 'out')],
    symbol: { kind: 'box', label: 'BEATS' },
    netlist: laid(b, { keepOrder: true }),
  });
})();

// ---------------------------------------------------------------- function decode

/** PI's function digits 13–15 into one line per function, each only in A2 and while the machine runs (¬H). */
export const BABY_DECODE: ComponentDef = (() => {
  const b = new Builder(8, 12, 3);
  b.pins('pi', 'a2', 'h');
  const sp = b.op(splitter([13, 3, 16]), ['pi'], undefined, 'sf');
  const nh = b.op1(NOT, ['h'], undefined, 'nh');
  b.next();
  const dec = b.op(decoder(3, true), [`${sp}.o1`, ''], undefined, 'dec');
  const go = b.op1(AND, ['a2', nh], undefined, 'go');
  b.wire(go, `${dec}.en`);
  b.name(go, 'go');
  b.next();
  const sub = b.op1(OR, [`${dec}.y4`, `${dec}.y5`], undefined, 'or45');
  const names = ['jmp', 'jrp', 'ldn', 'sto'];
  names.forEach((n, i) => b.wire(`${dec}.y${i}`, n));
  b.wire(sub, 'sub'); b.wire(`${dec}.y6`, 'cmp'); b.wire(`${dec}.y7`, 'stp');
  return define({
    id: 'baby_decode', name: 'Function decode', category: 'routing',
    summary: 'A 3-to-8 decoder on the function digits, enabled in the execute beat (A2) while the stop lamp is off. Functions 4 and 5 both subtract.',
    ports: [bus('pi', 32, 'in'), bit('a2', 'in'), bit('h', 'in'), ...['jmp', 'jrp', 'ldn', 'sto', 'sub', 'cmp', 'stp'].map((n) => bit(n, 'out'))],
    symbol: { kind: 'box', label: 'DECODE' },
    netlist: laid(b, { keepOrder: true }),
  });
})();

// ---------------------------------------------------------------- control: CI

/**
 * CI and its adder. S1: CI + 1 + T. A2: JRP CI + S, JMP S. `next` is what CI takes (its digits 0–4 go to the
 * staticisor at S1).
 */
export const BABY_CONTROL: ComponentDef = (() => {
  const b = new Builder(8, 12, 3);
  b.pins('s', 's1', 'a2', 't', 'h', 'jmp', 'jrp');
  const one = b.op1(constWord(32, 1), [], '1', 'one');
  const nh = b.op1(NOT, ['h'], undefined, 'nh');
  const na2 = b.op1(NOT, ['a2'], undefined, 'na2');
  b.next();
  const bsel = b.op1(busMux2(32), [one, 's', 'a2'], undefined, 'bsel');
  const cin = b.op1(AND, ['t', na2], undefined, 'cin');
  const inc = b.op1(AND, ['s1', nh], undefined, 'inc');
  const jump = b.op1(OR, ['jmp', 'jrp'], undefined, 'jump');
  b.next();
  const sum = b.op(rca(32), ['', bsel, cin], 'CI + 1 + T / + S', 'add');
  const en = b.op1(OR, [inc, jump], undefined, 'en');
  b.next();
  const nxt = b.op1(busMux2(32), [`${sum}.s`, 's', 'jmp'], undefined, 'nsel');
  b.next();
  const ci = b.op1(register(32), [nxt, en, 'clk'], 'CI', 'ci');
  b.wire(ci, `${sum}.a`);
  b.wire(ci, 'ci'); b.wire(nxt, 'next');
  b.name(ci, 'CI'); b.name(nxt, 'next');
  return define({
    id: 'baby_control', name: 'Control (CI)', category: 'arithmetic',
    summary: 'The control register CI and a 32-bit adder: at S1 it adds 1 (2 after a successful test), at A2 it adds the operand for JRP or takes it whole for JMP.',
    ports: [bus('s', 32, 'in'), bit('s1', 'in'), bit('a2', 'in'), bit('t', 'in'), bit('h', 'in'), bit('jmp', 'in'), bit('jrp', 'in'), clk(),
      bus('ci', 32, 'out'), bus('next', 32, 'out')],
    symbol: { kind: 'box', label: 'CONTROL' },
    netlist: laid(b, { keepOrder: true, wires: { 'ci.q': true } }),
  });
})();

// ---------------------------------------------------------------- the accumulator and the test

/** A and the subtractor: LDN A = 0 − S, SUB A = A − S (the Baby had no adder for A). Also the test and stop flip-flops. */
export const BABY_ACC: ComponentDef = (() => {
  const b = new Builder(8, 12, 3);
  b.pins('s', 'ldn', 'sub', 'cmp', 'stp', 's1', 'h');
  const zero = b.op1(constWord(32, 0), [], '0', 'zero');
  const one = b.op1(constWord(1, 1), [], '1', 'one');
  b.next();
  const asel = b.op1(busMux2(32), ['', zero, 'ldn'], undefined, 'asel');
  const en = b.op1(OR, ['ldn', 'sub'], undefined, 'en');
  b.next();
  const diff = b.op(addSub(32), [asel, 's', one], 'A − S', 'subtr');
  b.next();
  const a = b.op1(register(32), [`${diff}.s`, en, 'clk'], 'A', 'a');
  b.wire(a, `${asel.split('.')[0]}.a`);
  const sg = b.op(splitter([31, 1]), [a], undefined, 'sg');
  b.next();
  const tset = b.op1(AND, ['cmp', `${sg}.o1`], undefined, 'tset');
  const nh = b.op1(NOT, ['h'], undefined, 'nh');
  b.next();
  const ts1 = b.op1(AND, ['s1', nh], undefined, 'ts1');
  const ten = b.op1(OR, [ts1, 'cmp'], undefined, 'ten');
  b.next();
  const t = b.op1(DFFE, [tset, ten, 'clk'], 'T', 't');
  const hn = b.op1(OR, ['', 'stp'], undefined, 'hn');
  b.next();
  const hq = b.op1(DFF, [hn, 'clk'], 'H', 'hff');
  b.wire(hq, `${hn.split('.')[0]}.a`);
  b.wire(a, 'a'); b.wire(t, 't'); b.wire(hq, 'stop');
  b.name(a, 'a', true); b.name(hq, 'stop', true); b.name(t, 't');
  return define({
    id: 'baby_acc', name: 'Accumulator, test and stop', category: 'arithmetic',
    summary: 'The accumulator A and its subtractor (LDN loads 0 − S, SUB takes A − S), the test flip-flop T (A negative at CMP) and the stop flip-flop H.',
    ports: [bus('s', 32, 'in'), bit('ldn', 'in'), bit('sub', 'in'), bit('cmp', 'in'), bit('stp', 'in'), bit('s1', 'in'), bit('h', 'in'), clk(),
      bus('a', 32, 'out'), bit('t', 'out'), bit('stop', 'out')],
    symbol: { kind: 'box', label: 'ACC' },
    netlist: laid(b, { keepOrder: true }),
  });
})();

// ---------------------------------------------------------------- the machine

export const BABY_PORTS: PortDef[] = [
  clk(), bit('regen', 'in'),
  bus('ci', 32, 'out'), bus('pi', 32, 'out'), bus('a', 32, 'out'), bus('beat', 2, 'out'), bit('t', 'out'), bit('stop', 'out'),
  bit('retire', 'out'), bus('line', 5, 'out'),
];

const babyCache = new Map<string, ComponentDef>();

/**
 * The Baby with `words` in its store at power-on. Pins: clk, regen (1: the tube is regenerated on scan beats) →
 * ci, pi, a, beat, t, stop (H), retire (A2 while running: this beat's edge finishes an instruction), line (the store
 * line addressed this beat).
 */
export function babyComputer(words: ArrayLike<number> = []): ComponentDef {
  const store = babyStore(words);
  let d = babyCache.get(store.id);
  if (d) return d;
  const b = new Builder(8, 14, 4);
  b.pins('clk', 'regen');
  const tm = b.op(BABY_TIMING, ['clk'], 'beats', 'timing');
  b.next();
  const stat5 = b.op1(busMux2(5), ['', '', `${tm}.s1`], 'staticisor in', 'smux');
  const sen = b.op1(OR, [`${tm}.s1`, `${tm}.s2`], undefined, 'sen');
  b.next();
  const stat = b.op1(register(5), [stat5, sen, 'clk'], 'staticisor', 'stat');
  const we = b.op1(OR, [`${tm}.action`, 'regen'], undefined, 'we');
  b.next();
  const addr = b.op1(busMux2(5), [`${tm}.scan`, stat, `${tm}.action`], 'scan / action', 'amux');
  b.next();
  const st = b.op(store, [addr, '', we, 'clk'], 'store', 'store');
  b.next();
  const pi = b.op1(register(32), [`${st}.dout`, `${tm}.a1`, 'clk'], 'PI', 'pi');
  const piLo = b.op(splitter([5, 27]), [pi], undefined, 'pis');
  b.next();
  const dc = b.op(BABY_DECODE, [pi, `${tm}.a2`, ''], 'decode', 'dec');
  b.next();
  const ctl = b.op(BABY_CONTROL, [`${st}.dout`, `${tm}.s1`, `${tm}.a2`, '', '', `${dc}.jmp`, `${dc}.jrp`, 'clk'], 'CI', 'ctl');
  const acc = b.op(BABY_ACC, [`${st}.dout`, `${dc}.ldn`, `${dc}.sub`, `${dc}.cmp`, `${dc}.stp`, `${tm}.s1`, '', 'clk'], 'A', 'acc');
  const ciLo = b.op(splitter([5, 27]), [`${ctl}.next`], undefined, 'cis');
  b.next();
  const din = b.op1(busMux2(32), [`${st}.dout`, `${acc}.a`, `${dc}.sto`], 'rewrite / STO', 'wmux');
  const nh = b.op1(NOT, [`${acc}.stop`], undefined, 'nh');
  b.next();
  const ret = b.op1(AND, [`${tm}.a2`, nh], undefined, 'ret');
  // wiring left open above
  b.wire(`${ciLo}.o0`, `${stat5.split('.')[0]}.b`);
  b.wire(`${piLo}.o0`, `${stat5.split('.')[0]}.a`);
  b.wire(din, `${st}.din`);
  for (const sink of [`${dc}.h`, `${ctl}.h`, `${acc}.h`]) b.wire(`${acc}.stop`, sink);
  b.wire(`${acc}.t`, `${ctl}.t`);
  b.wire(`${ctl}.ci`, 'ci'); b.wire(pi, 'pi'); b.wire(`${acc}.a`, 'a'); b.wire(`${tm}.beat`, 'beat');
  b.wire(`${acc}.t`, 't'); b.wire(`${acc}.stop`, 'stop'); b.wire(ret, 'retire'); b.wire(addr, 'line');
  b.name(`${st}.dout`, 'S', true); b.name(`${acc}.stop`, 'H', true); b.name(addr, 'line');
  d = {
    id: store.id === 'baby_store' ? 'baby' : `baby_${store.id.slice('baby_store_'.length)}`,
    name: 'Manchester Baby (SSEM)', category: 'cpu',
    summary: 'The Small-Scale Experimental Machine of 21 June 1948: a 32 × 32 store on a Williams tube, the control CI, the present instruction PI, the accumulator A, seven instructions, four beats each.',
    ports: BABY_PORTS,
    symbol: { kind: 'box', label: 'BABY' },
    netlist: laid(b, {}),
  };
  if (d.id === 'baby') define(d);
  babyCache.set(store.id, d);
  return d;
}

/** Instance paths of the state the panels and tests read. */
export const BABY_STATE = { store: 'store', ci: 'ctl.ci', pi: 'pi', a: 'acc.a', t: 'acc.t', h: 'acc.hff' } as const;
