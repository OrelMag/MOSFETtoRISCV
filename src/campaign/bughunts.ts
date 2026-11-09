// Bug hunts: optional levels that start from a faulty drawing of a block an earlier level built, as a colleague
// left it. The learner finds the fault (Check's failing rows, the test player, probes, Why?) and fixes it in as few
// edits as they can (editor/edits.ts: parts added, removed or swapped, pins moved to another net; moving is free).
// Each fault is planted in the netlist of the earlier level's own reference answer and drawn by docFromDef, so the
// faulty chip and the answer share their part names; Do it for me redraws the chip as the answer in place. The last
// one has no fault: its block is right and too slow, and is graded on its clock period. No DOM.

import { type BuildChallenge, type PinSpec, type SeqStep } from '../editor/challenges';
import { docFromDef } from '../editor/fromdef';
import { UserLibrary } from '../editor/library';
import { type ChipDoc, emptyWorkspace } from '../editor/model';
import { Builder } from '../lib/builder';
import { resolveComponent } from '../lib/resolve';
import { type ComponentDef, type Netlist, netlistOf } from '../sim/types';
import { breakItNodes } from './breakit';
import type { CampaignNode, ChapterLink, Par } from './types';

interface Hunt {
  id: string;
  /** The level whose block it breaks: its reference answer is the drawing, its check the test. */
  after: string;
  title: string;
  /** HTML: the colleague's report (the level's why). */
  report: string;
  tips: string[];
  fault: string;
  kind: string;
  lesson: string;
  marks: string[];
  /** Top-level instances drawn as chips of their own (a library block the fault sits inside). */
  open?: string[];
  /** Plant the fault: `nl` is a copy of the answer's top netlist, `inside(inst)` a copy of an opened instance's. */
  plant: (nl: Netlist, inside: (inst: string) => Netlist) => void;
  par: Par;
  /** Taken off the parts list besides the earlier level's unlocks. */
  withhold?: string[];
  codex?: string[];
  chapters?: ChapterLink[];
}

// ---- netlist edits ---------------------------------------------------------------------------

const copyNl = (nl: Netlist): Netlist => ({ ...nl, instances: nl.instances.map((i) => ({ ...i })), nets: nl.nets.map((n) => ({ ...n, ends: [...n.ends], via: undefined })) });

const netOf = (nl: Netlist, end: string) => {
  const n = nl.nets.find((m) => m.ends.includes(end));
  if (!n) throw new Error(`bug hunt: no net holds ${end}`);
  return n;
};

/** Move the pin `end` onto the net that holds `to`. */
function move(nl: Netlist, end: string, to: string): void {
  const from = netOf(nl, end), dest = netOf(nl, to);
  from.ends = from.ends.filter((e) => e !== end);
  dest.ends.push(end);
  if (!from.ends.length) nl.nets = nl.nets.filter((n) => n !== from);
}

/** Swap two pins between their nets. */
function swap(nl: Netlist, a: string, b: string): void {
  const na = netOf(nl, a), nb = netOf(nl, b);
  na.ends = na.ends.map((e) => (e === a ? b : e));
  nb.ends = nb.ends.map((e) => (e === b ? a : e));
}

/** Add a part and put the pin `end` on its output `out` alone (an input tied to a constant). */
function tie(nl: Netlist, end: string, name: string, def: ComponentDef, at: [number, number], out = 'y'): void {
  const from = netOf(nl, end);
  from.ends = from.ends.filter((e) => e !== end);
  nl.instances.push({ name, def, at });
  nl.nets.push({ ends: [`${name}.${out}`, end] });
}

// ---- drawing ---------------------------------------------------------------------------------

const lib = (id: string): ComponentDef => {
  const d = resolveComponent(id);
  if (!d) throw new Error(`bug hunt: no library part ${id}`);
  return d;
};

/** Chips compiled in a scratch workspace; the last one's definition. */
function compiled(docs: ChipDoc[]): ComponentDef {
  const ws = emptyWorkspace();
  for (const d of docs) ws.chips[d.id] = d;
  const c = new UserLibrary(ws).compiled(docs[docs.length - 1].id);
  if (!c) throw new Error(`bug hunt: ${docs[docs.length - 1].id} does not compile`);
  return c.def;
}

function draw(def: ComponentDef, id: string, name: string, chips: Map<ComponentDef, string>): ChipDoc {
  const doc = docFromDef(def, { id, name, refOf: (d) => (chips.has(d) ? { chip: chips.get(d)! } : d.category === 'custom' ? { chip: d.id } : undefined) });
  if ('error' in doc) throw new Error(`bug hunt ${id}: ${doc.error}`);
  return doc;
}

interface Drawn { start: ChipDoc[]; answer: ChipDoc[]; baseline: ComponentDef }

/** The answer's chips and the faulty ones: the sub-chips both place, the opened blocks, the chip itself last. */
function drawHunt(h: Hunt, target: BuildChallenge): Drawn {
  const ans = target.answer();
  const good = compiled(ans);
  const top = netlistOf(good)!;
  const bad = copyNl(top);
  const opened = new Map<string, Netlist>();
  const inside = (inst: string): Netlist => {
    if (!h.open?.includes(inst)) throw new Error(`bug hunt ${h.id}: ${inst} is not opened`);
    let nl = opened.get(inst);
    if (!nl) opened.set(inst, (nl = copyNl(netlistOf(top.instances.find((i) => i.name === inst)!.def)!)));
    return nl;
  };
  h.plant(bad, inside);
  const shared = ans.slice(0, -1);
  const goodChips = new Map<ComponentDef, string>(), badChips = new Map<ComponentDef, string>();
  const goodOpen: ChipDoc[] = [], badOpen: ChipDoc[] = [];
  for (const name of h.open ?? []) {
    const i = top.instances.find((x) => x.name === name);
    if (!i) throw new Error(`bug hunt ${h.id}: no instance ${name}`);
    const id = `u_bug_${h.id}_${name}`;
    const faulty: ComponentDef = opened.has(name) ? { ...i.def, id: `${i.def.id}_bug`, netlist: () => opened.get(name)! } : i.def;
    goodChips.set(i.def, id);
    goodOpen.push(draw(i.def, id, `${i.def.name}`, new Map()));
    badOpen.push(draw(faulty, id, `${i.def.name}`, new Map()));
    const bi = bad.instances.find((x) => x.name === name)!;
    bi.def = faulty;
    badChips.set(faulty, id);
  }
  const goodMain = draw(good, `u_ref_cp_${h.id}`, `${h.title} ref`, goodChips);
  const badMain = draw({ ...good, id: `${good.id}_bug`, netlist: () => bad }, `u_bug_${h.id}`, h.title, badChips);
  const start = [...shared, ...badOpen, badMain];
  // A fault that cannot be drawn (a pin onto a net of another width) would be a broken chip, not a bug.
  const ws = emptyWorkspace();
  for (const d of start) ws.chips[d.id] = d;
  const err = new UserLibrary(ws).compiled(badMain.id)?.diags.find((x) => x.level === 'error');
  if (err) throw new Error(`bug hunt ${h.id}: the faulty drawing does not compile: ${err.msg}`);
  return { start, answer: [...shared, ...goodOpen, { ...goodMain, notes: 'Reference answer: the block as it should be.' }], baseline: compiled(start) };
}

// ---- the hunts -------------------------------------------------------------------------------

const MISWIRE = 'One net on the wrong pin: the commonest fault in hand-drawn schematics and in netlists alike, and it hides behind an output that is mostly right. The way in: take a wrong row, start at the wrong output and walk back to the first gate whose inputs are not what the design says they should be. Why? on the output does the walking; the comparison with the design is yours.';

const HUNTS: Hunt[] = [
  {
    id: 'b_fa', after: 'a_fa', title: 'The full adder',
    report: 'A colleague’s nine-NAND full adder went into a 4-bit adder and the sums came out wrong. Their note: “s is fine, I think. cout is off sometimes.” The chip opens as they left it, Check already run: find the fault and fix it in as few edits as you can.',
    tips: ['Every wrong row is wrong on cout only. Which gates can reach cout without reaching s?', 'cout is the NAND of two signals: the carry from the first half adder (¬(a·b), g1) and the one from the second (g5). Compare g9’s inputs with that.', 'g9 reads a where it should read g1.'],
    fault: 'g9’s first input was wired to <b>a</b> instead of g1’s output (¬(a·b)). cout became ¬(a · g5): wrong on five of the eight rows. <b>s</b> never reads g9, so it stayed right, which is how the fault got past a glance at the sums.',
    kind: 'miswire', lesson: MISWIRE, marks: ['g9'],
    plant: (nl) => move(nl, 'g9.a', 'a'), par: { edits: 1 }, codex: ['fulladder'],
  },
  {
    id: 'b_dec', after: 'g_dec', title: 'Two lines crossed',
    report: 'The 3 → 8 decoder drives a register file’s write enables, and writes to x5 land in x6 and the other way round. Every other register behaves.',
    tips: ['Only two outputs are wrong, and each is the other’s right answer.', 'Follow y5 and y6 back from the output merger.', 'The two AND gates are right; their outputs go to each other’s merger inputs.'],
    fault: 'y5 and y6 were connected to each other’s merger inputs: the gates decode right and the bus carries their answers in the wrong lanes.',
    kind: 'swapped pins', marks: ['y5', 'y6', 'my'],
    lesson: 'Two pins crossed: each output carries its neighbour’s answer, so a test that checks only whether some line goes high passes. It shows only when the test names which line. On a bus it is the merger or splitter lane, not the logic: look at the wiring before the gates.',
    plant: (nl) => swap(nl, 'y5.y', 'y6.y'), par: { edits: 2 }, codex: ['decoder'],
  },
  {
    id: 'b_mux', after: 'g_mux8', title: 'One column of sixteen',
    report: 'The 16-bit bus multiplexer was drawn by copying one column sixteen times. It passes every test with a = b, and fails some of the others.',
    tips: ['Wrong rows differ from right ones in one bit position. Which?', 'Bit 12’s two select NANDs: which takes s and which ¬s?', 'ta12 and tb12 take the select the wrong way round.'],
    fault: 'In bit 12 the two select NANDs take the select the wrong way round (ta12 has s, tb12 has ¬s), so y12 picks b when s = 0 and a when s = 1. A test with a = b cannot see it.',
    kind: 'one column of many', marks: ['ta12', 'tb12'],
    lesson: 'A slip in one copy of a repeated column: fifteen bits right, one wrong, and only when the two inputs differ in that bit. Random tests find it; a few hand-picked words often do not. Find the bit from the failing rows (XOR what came out with what was expected), then look at that column alone.',
    plant: (nl) => swap(nl, 'ta12.b', 'tb12.b'), par: { edits: 2 }, codex: ['mux'],
  },
  {
    id: 'b_carry', after: 'a_add4', title: 'The carry chain',
    report: 'A 4-bit ripple adder that gets some sums right. 3 + 1 = 4, but 1 + 1 comes out 6 and 6 + 2 comes out 4.',
    tips: ['Which bit is wrong when it is wrong, and what do those rows share?', 'Follow the carry from one full adder to the next.', 'Bit 2’s carry in comes from bit 0, skipping bit 1.'],
    fault: 'fa2’s carry in was taken from fa0’s carry out, not fa1’s: a carry made in bit 1 never reaches bit 2, and one made in bit 0 jumps a bit.',
    kind: 'miswire', lesson: MISWIRE, marks: ['fa2'],
    plant: (nl) => move(nl, 'fa2.cin', 'fa0.cout'), par: { edits: 1 }, codex: ['ripple'],
  },
  {
    id: 'b_sub', after: 'a_addsub16', title: 'Subtract is one off',
    report: 'The adder / subtractor adds right. Subtracting, every answer is one too small: 5 − 3 = 1.',
    tips: ['a − b = a + ¬b + 1. Which part of the drawing makes the + 1?', 'Look at fa0’s carry in.', 'The carry in is tied to 0; it should be <code>sub</code>.'],
    fault: 'fa0’s carry in was tied to 0 instead of <code>sub</code>: the XORs invert b, which gives a + ¬b, and the + 1 that makes it a two’s-complement subtraction was missing.',
    kind: 'missing connection', marks: ['fa0', 'z'],
    lesson: 'A pin tied to a constant, or left open, where it should follow a signal. The circuit is right in one mode (here adding, where the carry in is 0 anyway) and wrong in the other. Test each mode, and when one is off by a constant, look for the pin that supplies it.',
    plant: (nl) => tie(nl, 'fa0.cin', 'z', lib('tie0'), [6, 2]), par: { edits: 2 }, codex: ['subtract', 'twos'],
  },
  {
    id: 'b_slt', after: 'a_slt', title: 'Less than, mostly',
    report: '<code>ltu</code> is right. <code>lt</code> is right whenever a and b have the same sign, and wrong whenever they differ: −1 &lt; 1 says 0.',
    tips: ['When the signs differ, lt is simply a’s sign bit. Find the gate that picks that case.', 'u24 combines “signs differ” with a sign bit: whose?', 'u24 reads b’s sign; it should read a’s.'],
    fault: 'u24, the gate that answers when the signs differ, read b’s sign bit instead of a’s: it answered “b is negative” where the question was “a is negative”.',
    kind: 'corner case', marks: ['u24'],
    lesson: 'A fault in the branch that handles a special case: right on most inputs, wrong on one class (here mixed signs). Tests that sweep small positive numbers never reach it. Name the cases the design distinguishes (signs equal / differ, overflow, zero) and test each.',
    plant: (nl) => move(nl, 'u24.b', 'u21.o1'), par: { edits: 1 }, codex: ['flags', 'overflow'],
  },
  {
    id: 'b_dff', after: 's_dff', title: 'See-through flip-flop',
    report: 'The D flip-flop should change only at a rising clock edge. This one follows d whenever the clock is high, like a latch.',
    tips: ['When is each latch transparent? Look at what drives each enable.', 'A master–slave flip-flop needs the two latches open on opposite clock levels.', 'The master’s enable is clk; it should be ¬clk.'],
    fault: 'The master latch’s enable was wired to clk instead of ¬clk: both latches were open while the clock was high, so d ran straight through to q.',
    kind: 'clocking', marks: ['master', 'inv'],
    lesson: 'A clocking fault: storage that is open when it should be shut. It passes a test that changes d only while the clock is low and fails the moment d moves with the clock high. Check every storage element’s enable against the phase it should hold in.',
    plant: (nl) => move(nl, 'master.e', 'clk'), par: { edits: 1 }, codex: ['dff'],
  },
  {
    id: 'b_cnt', after: 's_cnt4', title: 'Never past seven',
    report: 'The 4-bit counter counts 0, 1, … 7 and then 0 again, and a reset with en low does not always clear bit 3. Bits 0–2 are fine.',
    tips: ['Only bit 3 misbehaves, and only from 7 on. Compare its column with bit 2’s.', 'Each bit is ¬rst AND the incremented value: g3 should take ¬rst.', 'g3 takes ¬en instead of ¬rst.'],
    fault: 'g3 read ¬en instead of ¬rst. While counting (en = 1) it forced bit 3 to 0, so 7 + 1 became 0; under reset with en = 0 it let bit 3 through.',
    kind: 'miswire', marks: ['g3'],
    lesson: `${MISWIRE} In a sequential circuit the wrong row may need many cycles to reach: here eight.`,
    plant: (nl) => move(nl, 'g3.a', 'nen.y'), par: { edits: 1 }, codex: ['counter'],
  },
  {
    id: 'b_x0', after: 'm_rf', title: 'x0 is not zero',
    report: 'Reading x0 through port 1 returns whatever is in x1. Port 2 reads 0, as it should.',
    tips: ['x0 is not a register: it is a constant on input 0 of each read multiplexer.', 'Compare input d0 of the two read multiplexers.', 'u10.d0 is wired to x1’s register, not to the constant.'],
    fault: 'Read multiplexer 1’s input 0 was wired to x1’s register instead of the constant 0: a read of x0 on port 1 returned x1.',
    kind: 'a rule of the spec', marks: ['u10'],
    lesson: 'A rule of the specification the design has to enforce (x0 reads 0), dropped on one path. Tests of the ordinary behaviour pass; only the rule’s own test fails. List the special rules (x0, reset values, wrap-around) and check each on every path that should obey it.',
    plant: (nl) => move(nl, 'u10.d0', 'u3.q'), par: { edits: 1 }, codex: ['regfile'],
  },
  {
    id: 'b_imm', after: 'c_imm', title: 'Branches land wrong',
    report: 'Forward branches go to the wrong place, and so do stores with a positive offset; backward branches and negative offsets are fine. The I, J and U immediates are right.',
    tips: ['Only the S/B immediate, and only when it is not negative: its upper bits should all be 0 there.', 'A sign extension copies the instruction’s sign bit into every bit above the field. Which of sb’s upper bits is 1 for a positive offset?', 'sb’s top bit comes from another field, not bit 15.'],
    fault: 'The branch immediate’s top bit (merger u3, input 12) was wired to an instruction field bit instead of the sign bit, so the sign extension broke at bit 15.',
    kind: 'encoding', marks: ['u3'],
    lesson: 'A field bit taken from the wrong place: the encoding is right for most words and wrong for those where the two bits differ. Draw the immediate’s bits against the instruction’s, bit by bit, as the encoding table does.',
    plant: (nl) => move(nl, 'u3.i12', 'u0.o1'), par: { edits: 1 }, codex: ['immediates', 'signext'],
  },
  {
    id: 'b_jal', after: 'c_core3', title: 'The lost return',
    report: 'Core III runs straight-line code and loops, but a program that calls a function never comes back: it calls itself over and over.',
    tips: ['Watch the failing program: which instruction is the first to write a wrong value?', 'jal writes its return address: pc + 1, the next instruction.', 'The result multiplexer’s input 2 reads pc, not pc + 1.'],
    fault: 'The result multiplexer’s link input (u9.d2) was wired to <code>pc</code> instead of the next-PC unit’s pc + 1: <code>jal</code> saved its own address, so the return jumped back to the call.',
    kind: 'datapath off by one', marks: ['u9'],
    lesson: 'A datapath value off by one step (pc instead of pc + 1, a register before or after its update). The instruction does nearly the right thing and the program fails later, somewhere else. The first wrong register write, from the golden model’s comparison, points at the instruction; its data path is short.',
    plant: (nl) => move(nl, 'u9.d2', 'u13.q'), par: { edits: 1 }, withhold: ['rv16_cpu'], codex: ['cpi'],
  },
  {
    id: 'b_fwd', after: 'pi_core1', title: 'Two back, read stale',
    report: 'Pipeline II forwards a result to the very next instruction. An instruction whose first operand (rs1) is a result from two instructions back gets the register file’s old value; the second operand is fine.',
    tips: ['Two instructions back, the result is in W. Which forwarding term covers W?', 'The forwarding unit is opened as a chip of its own: fa bit 1 is “W matches and M does not”. Follow it back.', 'u11 ANDs M’s match with its own inverse, which is never true: its first input should be W’s match (u9).'],
    fault: 'In the forwarding unit, u11 (forward from W) read M’s match and ¬(M’s match), a term that is never true, instead of W’s match and ¬(M’s match): nothing was forwarded from W to rs1 (fb’s copy of the term is right), and an rs1 result two instructions back was read stale.',
    kind: 'a term that is never true', marks: ['u23', 'u23.u11'], open: ['u23'],
    lesson: 'A condition that can never hold (or always does): the logic it guards is dead, and only the case it should have covered fails. The circuit looks complete. Lint’s unused-part warning and a probe on the term (stuck at 0 whatever the inputs) find it; so does asking, for each case the design must handle, which term handles it.',
    plant: (_nl, inside) => move(inside('u23'), 'u11.a', 'u8.y'), par: { edits: 1 }, withhold: ['rv16_fwd'], codex: ['forwarding'],
  },
];

// ---- timing closure --------------------------------------------------------------------------

const TIMING_ID = 'b_timing';

/** The optional act every debugging level sits in (bug hunts, timing closure, break-it levels): labelled "Debugging". */
export const DEBUG_ACT = 14;

/** acc ← rst ? 0 : (acc << sh) + x, with the ripple adder or Kogge–Stone. */
function shiftAcc(fast: boolean): ComponentDef {
  const b = new Builder(8, 10, 4);
  b.pins('x', 'sh', 'rst', 'clk');
  const one = b.add(lib('tie1'), undefined, 'one'), zero = b.add(lib('tie0'), undefined, 'zero');
  b.next();
  const shl = b.add(lib('rv16_shift16'), 'shift', 'shl');
  b.next();
  const add = b.add(lib(fast ? 'ks16' : 'rv16_add16'), 'add', 'add');
  b.next();
  const clr = b.add(lib('const16_0'), undefined, 'clr');
  const mux = b.add(lib('rv16_mux16'), 'reset', 'mux');
  b.next();
  const acc = b.add(lib('rv16_dreg16'), 'acc', 'acc');
  b.wire(`${acc}.q`, `${shl}.a`); b.wire('sh', `${shl}.sh`); b.wire(`${one}.y`, `${shl}.left`); b.wire(`${zero}.y`, `${shl}.arith`);
  b.wire(`${shl}.y`, `${add}.a`); b.wire('x', `${add}.b`); b.wire(`${zero}.y`, `${add}.cin`);
  b.wire(`${add}.s`, `${mux}.a`); b.wire(`${clr}.y`, `${mux}.b`); b.wire('rst', `${mux}.s`);
  b.wire(`${mux}.y`, `${acc}.d`); b.wire('clk', `${acc}.clk`); b.wire(`${acc}.q`, 'acc');
  const nets = b.nets();
  return {
    id: `bug_shift_acc_${fast ? 'ks' : 'rca'}`, name: 'Shift and accumulate', category: 'sequential',
    ports: [{ name: 'x', dir: 'in', width: 16 }, { name: 'sh', dir: 'in', width: 4 }, { name: 'rst', dir: 'in', width: 1 }, { name: 'clk', dir: 'in', width: 1, clock: true }, { name: 'acc', dir: 'out', width: 16 }],
    symbol: { kind: 'box', label: 'acc' },
    netlist: () => ({ instances: b.instances, nets }),
  } as ComponentDef;
}

const TIMING_PORTS: PinSpec[] = [
  { name: 'x', dir: 'in', width: 16 }, { name: 'sh', dir: 'in', width: 4 }, { name: 'rst', dir: 'in', width: 1 }, { name: 'clk', dir: 'in', width: 1, clock: true },
  { name: 'acc', dir: 'out', width: 16 },
];

function timingSeq(): SeqStep[] {
  let s = 0x2545f491;
  const r = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 8) / 0x1000000;
  let acc = 0;
  const st: SeqStep[] = [{ set: { rst: 1, x: 0, sh: 0 }, tick: true, expect: { acc: (acc = 0) } }];
  for (let i = 0; i < 60; i++) {
    const rst = i % 23 === 22 ? 1 : 0, x = Math.floor(r() * 0x10000), sh = Math.floor(r() * 4);
    acc = rst ? 0 : ((acc << sh) + x) & 0xffff;
    st.push({ set: { rst, x, sh }, tick: true, expect: { acc } });
  }
  return st;
}

function timingDocs(fast: boolean): ChipDoc[] {
  const doc = docFromDef(shiftAcc(fast), { id: fast ? `u_ref_cp_${TIMING_ID}` : `u_bug_${TIMING_ID}`, name: fast ? 'Shift and accumulate ref' : 'Shift and accumulate' });
  if ('error' in doc) throw new Error(`timing closure: ${doc.error}`);
  return [doc];
}

// ---- nodes -----------------------------------------------------------------------------------

const drawn = new Map<string, Drawn>();

function huntChallenge(h: Hunt, target: () => BuildChallenge): () => BuildChallenge {
  return () => {
    const t = target();
    const d = () => {
      let x = drawn.get(h.id);
      if (!x) drawn.set(h.id, (x = drawHunt(h, t)));
      return x;
    };
    return {
      ...t, id: h.id, title: h.title,
      brief: `Fix the block in as few edits as you can: a part added, removed or swapped, or a pin moved to another net, is one; moving parts and redrawing wires are free. The test is the one “${t.title}” passed. ${t.brief}`,
      answer: () => d().answer, start: () => d().start, baseline: () => d().baseline,
    };
  };
}

const timingNode = (after: CampaignNode): CampaignNode => {
  let base: ComponentDef | undefined;
  return {
    id: TIMING_ID, act: DEBUG_ACT, title: 'Timing closure', kind: 'build', optional: true, requires: [after.id],
    why: 'This block is right: every test passes with a slow clock. It goes into a system clocked at a period of 40 NAND delays, and static timing says it needs more. Bring the register-to-register path to 40 or under, keeping the results right, for as few NANDs as you can.',
    tips: ['Open the Timing panel: which part holds most of the critical path?', 'The shifter and the adder are both on the path from acc back to acc. Which one is the long one?', 'The ripple adder is 36 delays; a Kogge–Stone adder (unlocked by Fast adders) does the same sum in far fewer.'],
    codex: ['criticalpath'], par: { period: 40, nand: 858 },
    bug: {
      after: after.id, kind: 'timing closure', marks: ['add'],
      fault: 'No wrong wire: the ripple adder’s 36-delay carry chain sat on the path from the accumulator back to itself. A Kogge–Stone adder does the same sum in a few levels of prefix cells.',
      lesson: 'Timing closure: the design is right and the clock is too fast for it. Static timing names the path; the fix is on that path and nowhere else (a faster unit, less work per cycle, a register moved). A gate simulation at a fixed clock shows it breaking: the edge does not wait for the carry, and a late bit is captured stale.',
    },
    base: () => ({
      id: TIMING_ID, title: 'Timing closure', level: 'sequential',
      brief: 'At each rising edge: <b>acc ← 0</b> if <code>rst</code>, else <b>acc ← (acc &lt;&lt; sh) + x</b> (16 bits, wrapping). The block is right; make its clock period 40 NAND delays or less.',
      ports: TIMING_PORTS, check: { kind: 'sequence', steps: timingSeq() }, allowed: 'any',
      answer: () => timingDocs(true), start: () => timingDocs(false), baseline: () => (base ??= compiled(timingDocs(false))),
    }),
  };
};

/** The bug hunts, each placed after the level it hangs off. */
export function withBugHunts(nodes: CampaignNode[]): CampaignNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const extra = new Map<string, CampaignNode[]>();
  const put = (after: string, n: CampaignNode) => extra.set(after, [...(extra.get(after) ?? []), n]);
  for (const h of HUNTS) {
    const a = byId.get(h.after);
    if (!a?.base) throw new Error(`bug hunt ${h.id}: no build level ${h.after}`);
    put(h.after, {
      id: h.id, act: DEBUG_ACT, title: h.title, kind: a.kind === 'core' ? 'core' : 'build', optional: true, requires: [h.after],
      why: h.report, tips: h.tips, codex: h.codex ?? [], par: h.par, ...(h.chapters ? { chapters: h.chapters } : {}),
      withhold: [...(a.unlocks ?? []), ...(h.withhold ?? [])],
      bug: { after: h.after, fault: h.fault, kind: h.kind, lesson: h.lesson, marks: h.marks },
      base: huntChallenge(h, a.base),
    });
  }
  for (const [after, n] of breakItNodes(byId, DEBUG_ACT)) put(after, n);
  const fast = byId.get('c_fast');
  if (fast) put('c_fast', timingNode(fast));
  return nodes.flatMap((n) => [n, ...(extra.get(n.id) ?? [])]);
}

export const BUG_HUNT_IDS = [...HUNTS.map((h) => h.id), TIMING_ID];
