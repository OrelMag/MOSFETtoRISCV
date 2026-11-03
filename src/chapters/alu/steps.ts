// Chapter 11's deeper steps, after "The complete ALU": the six branch conditions read off one subtraction, the ALU control
// decode as the control unit builds it, and what each operation actually waits for. Numbers come from the circuits (tests/deepseq.test.ts).

import { control, NEXT_PC, XOR } from '../../lib';
import { aluSpec } from '../../lib/alu';
import { evalOnce, simulate } from '../../sim/harness';
import { groupDigits } from '../../sim/numfmt';
import { stats } from '../../sim/stats';
import { netlistOf } from '../../sim/types';
import { opDelays, opDelayWidget } from '../../widgets/opdelay';
import type { Step } from '../types';

const g = groupDigits;

/** The six conditions: funct3, mnemonic, flag expression, and the model that decides them from the subtraction's flags. */
export const BRANCHES: { f3: number; name: string; expr: string; test: (z: number, n: number, v: number, c: number) => number }[] = [
  { f3: 0, name: 'beq', expr: 'Z', test: (z) => z },
  { f3: 1, name: 'bne', expr: '¬Z', test: (z) => 1 - z },
  { f3: 4, name: 'blt', expr: 'N ⊕ V', test: (_z, n, v) => n ^ v },
  { f3: 5, name: 'bge', expr: '¬(N ⊕ V)', test: (_z, n, v) => 1 - (n ^ v) },
  { f3: 6, name: 'bltu', expr: '¬C', test: (_z, _n, _v, c) => 1 - c },
  { f3: 7, name: 'bgeu', expr: 'C', test: (_z, _n, _v, c) => c },
];

/** Flags of a − b at 8 bits, from the ALU's own specification (the circuit equals it: tests/deepseq.test.ts). */
const sub8 = aluSpec(8);
export const flags8 = (a: number, b: number) => { const [, z, n, v, c] = sub8([a, b, 8]); return { z, n, v, c }; };

/** Pairs (of 65 536) where each wrong shortcut disagrees with the true signed / unsigned order. */
const WRONG = (() => {
  let nAlone = 0, cSigned = 0;
  for (let a = 0; a < 256; a++) for (let b = 0; b < 256; b++) {
    const { n, v, c } = flags8(a, b);
    const sa = a > 127 ? a - 256 : a, sb = b > 127 ? b - 256 : b;
    if (n !== (sa < sb ? 1 : 0)) nAlone++;
    if (1 - c !== (sa < sb ? 1 : 0)) cSigned++;
    if ((n ^ v) !== (sa < sb ? 1 : 0)) throw new Error('N xor V is the signed order');
  }
  return { nAlone, cSigned };
})();
export { WRONG as BRANCH_WRONG };

const NPC_COND = (() => {
  const inst = netlistOf(NEXT_PC)!.instances;
  const pick = (names: string[]) => inst.filter((i) => names.includes(i.name)).reduce((a, i) => a + stats(i.def).nands, 0);
  return { flags: pick(['nz', 'lt', 'ge', 'nc']), mux: pick(['cond']), all: stats(NEXT_PC).nands };
})();

/** Control-unit rows: instruction → op, funct3, funct7 (bit 5 is what the ALU decode reads). */
export const CTL_ROWS: { name: string; op: number; f3: number; f7: number }[] = [
  { name: 'add', op: 0x33, f3: 0, f7: 0 }, { name: 'sub', op: 0x33, f3: 0, f7: 0x20 }, { name: 'sll', op: 0x33, f3: 1, f7: 0 },
  { name: 'slt', op: 0x33, f3: 2, f7: 0 }, { name: 'sltu', op: 0x33, f3: 3, f7: 0 }, { name: 'xor', op: 0x33, f3: 4, f7: 0 },
  { name: 'srl', op: 0x33, f3: 5, f7: 0 }, { name: 'sra', op: 0x33, f3: 5, f7: 0x20 }, { name: 'or', op: 0x33, f3: 6, f7: 0 }, { name: 'and', op: 0x33, f3: 7, f7: 0 },
  { name: 'addi', op: 0x13, f3: 0, f7: 0 }, { name: 'addi (imm bit 30 = 1)', op: 0x13, f3: 0, f7: 0x20 }, { name: 'srli', op: 0x13, f3: 5, f7: 0 }, { name: 'srai', op: 0x13, f3: 5, f7: 0x20 },
  { name: 'lw / sw (address add)', op: 0x03, f3: 2, f7: 0x20 }, { name: 'beq … bgeu (compare)', op: 0x63, f3: 0, f7: 0 }, { name: 'lui / auipc / jal / jalr', op: 0x17, f3: 5, f7: 0x20 },
];
let ctlSim: ReturnType<typeof simulate> | null = null;
/** ALU control code the control unit produces for a row (the circuit, evaluated). */
export const ctlOf = (r: { op: number; f3: number; f7: number }): number => {
  ctlSim ??= simulate(control());
  const out = evalOnce(ctlSim, [r.op, r.f3, r.f7]);
  return out[out.length - 1];
};
const CTL_PARTS = (() => {
  const inst = netlistOf(control())!.instances;
  const names = ['sf3', 'sf7', 'a0', 'a1', 'a2', 'nf1', 'is101', 'shR', 'alt1', 'alt'];
  return inst.filter((i) => names.includes(i.name)).reduce((a, i) => a + stats(i.def).nands, 0);
})();
export { CTL_PARTS };

export const aluSteps: Step[] = [
  {
    title: 'Six branches from one subtraction',
    get body() {
      return `
      <p>Chapter 5 gave the flags and the previous steps used two of them for <code>slt</code> and <code>sltu</code>. A branch needs no result at all, only a verdict, and the same subtraction serves all six: the branch unit (<span data-show="nz lt ge nc">three inverters and one XOR</span>) turns
      Z, N, V and C into one bit per <code>funct3</code>, and an <span data-show="cond">8:1 multiplexer</span> selects it.</p>
      <table class="mini"><tr><th>funct3</th><th>branch</th><th>taken when</th></tr>${BRANCHES.map((b) => `<tr><td>${b.f3.toString(2).padStart(3, '0')}</td><td><code>${b.name}</code></td><td>${b.expr}</td></tr>`).join('')}</table>
      <p>The condition logic costs ${NPC_COND.flags} NANDs plus ${NPC_COND.mux} for the select; with the jump and jalr muxing the whole next-PC decision is ${NPC_COND.all}. Which shortcut is tempting and wrong? Over all 65 536 pairs of 8-bit operands, N alone gives the wrong signed order for ${g(WRONG.nAlone)} of them (every
      overflowing subtraction), and ¬C used for a signed compare for ${g(WRONG.cSigned)}: exactly the pairs of opposite sign. N ⊕ V is right for every pair (checked here by the same loop). Signed and unsigned are two readings of one set of flags, which is why there is a <code>blt</code> and a <code>bltu</code> and no flags register.</p>
      <div class="try">Set the flags of 0x80 − 0x01 (Z = 0, N = 0, V = 1, C = 1) and funct3 = 100 (blt) with branch = 1: pcSrc = 1, taken. Change funct3 to 110 (bltu): not taken, 128 is not below 1.</div>`;
    },
    scene: () => ({ root: NEXT_PC, inputs: { zero: 0, neg: 0, ovf: 1, carry: 1, funct3: 4, branch: 1, jump: 0, jalr: 0 } }),
    tour: {
      beats: [
        { title: '0x80 − 0x01, blt', show: ['lt', 'cond'], expect: { pcSrc: 1 },
          say: '<p>−128 &lt; 1. N = 0 (the difference 0x7F looks positive) but V = 1: N ⊕ V = 1, so <code>blt</code> is taken: pcSrc = {v:pcSrc} (1 = the branch target).</p>' },
        { title: 'The same flags, bltu', set: { funct3: 6 }, show: ['nc', 'cond'], expect: { pcSrc: 0 },
          say: '<p>As unsigned, 128 ≥ 1: the subtraction carried out, C = 1, ¬C = 0: not taken, pcSrc = {v:pcSrc} (PC + 4).</p>' },
        { title: 'beq and bne', set: { funct3: 0, zero: 1, ovf: 0, carry: 1 }, show: ['nz', 'cond'], expect: { pcSrc: 1 },
          say: '<p>Equal operands: Z = 1, <code>beq</code> taken (pcSrc = {v:pcSrc}); <code>bne</code> reads ¬Z through <code>nz</code>.</p>' },
      ],
    },
    more: {
      derive: `<p>With d = a − b computed as a + ¬b + 1: Z = (d = 0); C = 1 iff a ≥ b unsigned; the true sign of the difference is N ⊕ V. So for the six conditions, in the order of the table: Z, ¬Z, N ⊕ V, ¬(N ⊕ V), ¬C, C. bge is one inverter after the XOR
        that blt already has, as the netlist draws it (<code>ge</code>), and bgeu needs none: C itself.</p>`,
      pitfall: `<p>Branching on <code>a - b &lt; 0</code> in software instead of <code>blt</code>. The subtraction wraps: for values of opposite sign it can have the wrong sign, which is exactly the V flag you did not read. Compilers use <code>blt</code> and the hardware reads N ⊕ V.</p>`,
      real: `<p>Fast cores do not wait for the ALU: chapter 18's branch comparator is an equality tree and its own fast subtractor beside the ALU, so the decision comes earlier in the cycle, without the ALU's result mux and zero detector. The conditions above are unchanged.</p>`,
      numbers: `<p>Cost of the condition logic: the XOR is ${stats(XOR).nands} NANDs, each of the three inverters 1, and the 8:1 select ${NPC_COND.mux}; ${NPC_COND.all} NANDs for the whole next-PC decision.</p>`,
    },
    challenge: {
      kind: 'quiz',
      question: 'a = 0x7F, b = 0x80 (8 bit). Which signed branch is taken?',
      options: ['bge: 127 ≥ −128; N = 1 but V = 1, so N ⊕ V = 0', 'blt: N = 1 says a < b', 'Both: they read different flags', 'Neither: the subtraction overflows, so the compare is invalid'],
      answer: 0,
      explain: `0x7F − 0x80 = 0xFF with V = 1 and N = 1, so N ⊕ V = 0: not less, <code>bge</code> taken. N alone (1) would say "less". Read as unsigned, 127 &lt; 128 and <code>bltu</code> is taken (¬C = 1): the same flags answer both questions, differently.`,
      why: ['', 'N is 1 only because the subtraction overflowed; V = 1 inverts it, which is what N ⊕ V does.', 'blt and bge are complements: exactly one is taken, both read N ⊕ V.', 'Every subtraction has a valid answer in N ⊕ V: that is the purpose of V.'],
    },
  },
  {
    title: 'The ALU control decode',
    get body() {
      return `
      <p>The ALU's four control bits come from the instruction's own fields. The <span data-ahead="control">control unit (the block that turns an instruction's fields into switch settings for the rest of the CPU)</span> has an ALU decoder (<span data-show="a0 a1 a2">three ANDs</span>, <span data-show="is101 shR alt1 alt">a small subtract / arithmetic detector</span>, ${g(CTL_PARTS)} NANDs with the field splitters) implements
      two rules, and no table:</p>
      <ul><li><strong>ctl[2:0] = aluOp ? funct3 : 000.</strong> An R-type or OP-IMM arithmetic instruction passes funct3 straight through (which is why the ALU's operation numbers are funct3). Loads, stores, branches, <code>lui</code>, <code>auipc</code> and jumps force 000: they only add (or, for a branch, subtract).</li>
      <li><strong>ctl[3] = aluOp · f7[5] · (R-type ∨ funct3 = 101) ∨ BRANCH.</strong> The bit that picks <code>sub</code> over <code>add</code> and <code>sra</code> over <code>srl</code> is funct7 bit 5, but only where it means that: an <code>addi</code> whose constant happens to set bit 30 of the word must not subtract, and
      only the shifts <code>srli</code> / <code>srai</code> use that bit in their encoding. Branches force 1 to subtract.</li></ul>
      <table class="mini"><tr><th>instruction</th><th>opcode</th><th>f3</th><th>f7[5]</th><th>ctl</th></tr>${CTL_ROWS.map((r) => `<tr><td>${r.name}</td><td>${r.op.toString(2).padStart(7, '0')}</td><td>${r.f3.toString(2).padStart(3, '0')}</td><td>${(r.f7 >> 5) & 1}</td><td><code>${ctlOf(r).toString(2).padStart(4, '0')}</code></td></tr>`).join('')}</table>
      <p>Each row is the control unit evaluated on those fields. The last rows show the don't-cares: a load with funct7 bit 5 set still gives 0000.</p>
      <div class="try">Set opcode 0010011 (OP-IMM), funct3 = 000, funct7 = 0100000: ctl stays 0000 (add). Change funct3 to 101: ctl = 1101 (<code>srai</code>).</div>`;
    },
    scene: () => ({ root: control(), inputs: { op: 0x13, funct3: 0, funct7: 0x20 } }),
    tour: {
      beats: [
        { title: 'addi with bit 30 set', show: ['alt1', 'is101'], expect: { aluCtl: 0 },
          say: '<p>OP-IMM, funct3 = 000, funct7[5] = 1 (bit 30 of the word, part of the constant): the subtract detector wants an R-type or funct3 = 101, so ctl = {b:aluCtl}, <code>add</code>.</p>' },
        { title: 'srai', set: { funct3: 5 }, show: ['is101', 'shR', 'alt1', 'alt'], expect: { aluCtl: 13 },
          say: '<p>funct3 = 101: <code>is101</code> and <code>alt1</code> fire, ctl = {b:aluCtl} = 1101, <code>sra</code>.</p>' },
        { title: 'sub', set: { op: 0x33, funct3: 0 }, show: ['shR', 'alt1', 'alt'], expect: { aluCtl: 8 },
          say: '<p>R-type: funct7[5] counts for any funct3. ctl = {b:aluCtl}: <code>sub</code>.</p>' },
        { title: 'A load', set: { op: 0x03, funct3: 2, funct7: 0 }, show: ['a0', 'a1', 'a2'], expect: { aluCtl: 0 },
          say: '<p>aluOp = 0: the three ANDs force ctl[2:0] to 000 whatever funct3 (010 = <code>lw</code>) says, and the address add runs: ctl = {b:aluCtl}.</p>' },
      ],
    },
    more: {
      derive: `<p>The R-type column of chapter 11's recap is "ctl = {funct7[5], funct3}" and that is exactly what <code>a0 a1 a2</code> and <code>alt1</code> produce for OP: aluOp = 1, funct3 = 101 or R-type. The extra gates exist for the other instruction groups. The cost
        is small beside the datapath: ${g(CTL_PARTS)} NANDs against the ALU's thousands.</p>`,
      pitfall: `<p>Decoding on funct7 alone. <code>addi x1, x1, 1024</code> has imm[10] = 1, which is bit 30 of the instruction word, and an ALU that read that bit unconditionally would subtract. Only R-type and the shift-immediates define that bit.</p>`,
    },
    challenge: {
      kind: 'quiz',
      question: 'For which instruction is the ALU control code 1000 (subtract)?',
      options: ['sub, and every branch', 'sub only', 'sub and srai', 'sub, slt and sltu'],
      answer: 0,
      explain: `ctl[3] is set for an R-type with funct7[5] = 1 with funct3 = 000 (sub) and for BRANCH, which forces it so the flags describe a − b. slt and sltu subtract inside the ALU (the code 0010, 0011 forces the subtraction); srai is 1101.`,
      why: ['', 'Branches subtract too: the control forces ctl[3] for them.', 'srai carries ctl = 1101: arithmetic shift right, a different operation of the same ctl[3] bit.', 'slt (0010) and sltu (0011) have ctl[3] = 0: they force the subtraction in the ALU, not through this bit.'],
    },
  },
  {
    title: 'What each operation waits for',
    get body() {
      const R = opDelays('rca'), K = opDelays('ks');
      return `
      <p>"The complete ALU" counted depth: the longest path from any input to any output, ${R.depth} delays for the ripple ALU (87 to the result y, the rest to the zero flag behind it). But the control code is fixed for a whole instruction, and a path only matters if a change can travel it. <strong>Measured</strong> with the code held and the operands moving
      (the widget below runs the 32-bit ALU on a set of carry-chain, shifter and alternating-bit transitions), the result y settles in <strong>${R.ops.and}</strong> delays for <code>and</code> / <code>or</code> and ${R.ops.xor} for <code>xor</code>, ${R.ops.sll} / ${R.ops.srl} / ${R.ops.sra} for the shifts,
      and ${R.ops.add} for <code>add</code>, ${R.ops.sub} for <code>sub</code>, ${R.ops.sltu} for <code>sltu</code>, <strong>${R.ops.slt}</strong> for <code>slt</code>. The ripple carry decides everything the adder touches; the logic operations never see it, although it is in the same circuit.</p>
      <p>That is also the case against a <em>fixed</em> clock period for all instructions: the slowest op sets it (${R.ops.slt} here against ${R.ops.and} for <code>and</code>), unless the slow ones get more cycles. With <span data-ahead="prefix">a Kogge–Stone adder (a parallel-prefix carry network, chapter 16)</span> the same measurement gives <code>add</code> ${K.ops.add}, <code>slt</code> ${K.ops.slt}: the gap to the shifter (${K.ops.sll}) closes from ${R.ops.add - R.ops.sll} delays to ${K.ops.add - K.ops.sll}, and <code>slt</code> (${K.ops.slt}), which still pays the flag logic after the adder, becomes the slowest. The flags (zero, neg, ovf, carry) follow the adder, ${R.flags} delays here and ${K.flags} with Kogge–Stone: that is what a branch waits for, which is why a <span data-ahead="pipeline">pipelined core (instructions overlapped in stages)</span> gives branches their own comparator.</p>`;
    },
    widget: opDelayWidget,
    more: {
      derive: `<p>The ripple ALU's static depth (${opDelays('rca').depth}, 11 of it the zero detector, which an output y does not include) is higher than every measured op delay (the worst is ${Math.max(...Object.values(opDelays('rca').ops))}): the rest is paths from the control input and paths no vector sensitizes (a change of ctl itself is not one of the transitions: that is the control unit's timing, a later chapter's business). Sensitized delay is a lower bound from the vectors tried; static depth an upper bound.</p>`,
      pitfall: `<p>Reading a timing report by the number of gates in the unit you changed. Replacing the ripple adder by Kogge–Stone cuts <code>add</code> from ${opDelays('rca').ops.add} to ${opDelays('ks').ops.add} but <code>sll</code> not at all (${opDelays('ks').ops.sll}): the adder's lead over the shifter shrinks to a few delays, so the next speed-up has to touch the shifter as well.</p>`,
    },
    challenge: {
      kind: 'quiz',
      question: 'With a log-depth adder instead of the ripple adder, which operation of the 32-bit ALU gets no faster?',
      options: ['sll / srl / sra: the shifter does not use the adder', 'add', 'sub', 'slt'],
      answer: 0,
      explain: `Measured: add ${opDelays('rca').ops.add} → ${opDelays('ks').ops.add}, sub ${opDelays('rca').ops.sub} → ${opDelays('ks').ops.sub}, slt ${opDelays('rca').ops.slt} → ${opDelays('ks').ops.slt}; sll ${opDelays('rca').ops.sll} → ${opDelays('ks').ops.sll}, srl ${opDelays('rca').ops.srl} → ${opDelays('ks').ops.srl}.`,
      why: ['', 'add is the adder: it drops sharply.', 'sub goes through the same adder with b inverted.', 'slt uses the subtraction and the flag logic: it follows the adder.'],
    },
  },
];
