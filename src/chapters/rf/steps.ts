// Chapter 12's deeper steps, after "The real thing: 32 x 32": a read of the register being written, the file built from
// latches, and the file of a dual-issue core. Numbers come from the generators (tests/deepseq.test.ts pins them).

import { D_LATCH, DFFE, latchFile, latchWord, regfile, regfile2w, rfBypass } from '../../lib';
import { groupDigits } from '../../sim/numfmt';
import { stats } from '../../sim/stats';
import { pack } from '../../sim/values';
import type { Stage } from '../../view/stage';
import type { Step } from '../types';

const g = groupDigits;
const nands = (d: Parameters<typeof stats>[0]) => stats(d).nands;
const pct = (a: number, b: number) => ((100 * a) / b).toFixed(1);

function word(st: Stage, i: number): number {
  const n = st.rootCtx?.node.children?.get(`w${i}`);
  return n ? pack(st.rootCtx!.sim.getBits(n.ports.q ?? n.ports.q0)) : -1;
}

export const RF_NUMBERS = () => {
  const rf = nands(regfile(5, 32)), by = nands(rfBypass(5, 32)), lf = nands(latchFile(5, 32)), r2 = nands(regfile2w(5, 32)), r3 = nands(regfile(5, 32, true, 3));
  return { rf, by, lf, r2, r3, port: r3 - rf, x0: nands(regfile(5, 32, false)) - rf, dff: nands(DFFE), latch: nands(D_LATCH), word: nands(latchWord(32)) };
};

export const rfSteps: Step[] = [
  {
    title: 'Reading what is being written',
    get body() {
      const N = RF_NUMBERS();
      return `
      <p>The file of the previous step writes at the clock edge, so a read of the register being written returns the <em>old</em> word until the edge. A <span data-ahead="pipeline">pipeline (instructions overlapped in stages)</span> hits this when one instruction writes a register that a later one reads in the same cycle; chapter 17 repairs it outside the file, in its <span data-ahead="hazards">hazard logic (the circuit that detects such conflicts)</span>. The other repair is inside: a <strong>bypass</strong>. A comparator per read port (<span data-show="eq1 eq2">wa = ra</span>) gates a word multiplexer that hands <code>wd</code> to the port instead of the stored word. The select is
      <code>we ∧ byp ∧ wa ≠ 0 ∧ wa = ra</code>: the third term, wa ≠ 0, is what x0 costs here, a 5-input OR so that a write to x0 is never forwarded (x0 must keep reading 0).</p>
      <p>At 32 × 32 the two comparators, the two selects and the two 32-bit word multiplexers add <strong>${N.by - N.rf} NANDs</strong> to ${g(N.rf)}: ${pct(N.by - N.rf, N.rf)} %. Cheap, but it puts a gate path <code>wd → mux → rd</code> in front of the ALU: a value that was only needed
      at the end of the cycle (to be stored) is now also an input to the next stage's start. And x0 itself: dropping its 32 flip-flops saves ${g(N.x0)} NANDs (one register with enable) against a file that treated register 0 like any other.</p>
      <div class="try">Set <code>wa</code> = 5, <code>wd</code> = 0x42, <code>we</code> = 1, <code>ra1</code> = 5 with <code>byp</code> = 0: rd1 = 0. Switch <code>byp</code> on: rd1 = 0x42 before any clock edge. Pulse: the register now holds it and byp no longer matters.</div>`;
    },
    scene: () => ({ root: rfBypass(3, 8), inputs: { wa: 5, wd: 0x42, we: 1, byp: 0, ra1: 5, ra2: 0, clk: 0 }, autoClock: false }),
    tour: {
      beats: [
        { title: 'Stale read', reset: true, show: ['rf'], expect: { rd1: 0 },
          say: '<p>Register 5 is being written with 0x42 this cycle and port 1 reads it. Without bypass the stored word is still 0: rd1 = {v:rd1}.</p>' },
        { title: 'Bypass', set: { byp: 1 }, show: ['eq1', 'nz'], expect: { rd1: 0x42 },
          say: '<p>wa = ra1, we = 1, wa ≠ 0: the multiplexer passes wd. rd1 = {v:rd1} before the edge. Port 2 reads register 0 and is unaffected: rd2 = {v:rd2}.</p>' },
        { title: 'x0 is never forwarded', set: { wa: 0, ra1: 0 }, show: ['nz'], expect: { rd1: 0 },
          say: '<p>Writing x0 matches ra1 = 0, but wa ≠ 0 is false: rd1 stays {v:rd1}.</p>' },
        { title: 'The edge stores it', set: { wa: 5, ra1: 5, byp: 0 }, cycles: 1, show: ['rf'], expect: { rd1: 0x42 },
          say: '<p>With byp off again the edge writes register 5 and the ordinary read path now returns {v:rd1}.</p>' },
      ],
    },
    more: {
      derive: `<p>Per read port: <code>equal(k)</code> on the two addresses, one AND with the shared enable <code>we ∧ byp ∧ nz</code>, and a <em>w</em>-bit 2:1 multiplexer. The shared part (nz and the three-input AND) is paid once. At 32 × 32, ${g(RF_NUMBERS().by - RF_NUMBERS().rf)} NANDs for two ports.</p>`,
      pitfall: `<p>Forwarding the write data into an instruction that reads x0. <code>addi x0, x1, 5</code> in W and <code>add x2, x0, x3</code> in D: x0 must still be 0. Every bypass in this site's pipelines tests rd ≠ 0 for this reason, and this one does too.</p>`,
      real: `<p>Some register files are written in the first half of a cycle and read in the second, or built with the read port's address comparison inside the array; either way the same-cycle read sees the new value without a gate-level mux. Which side of the clock holds the boundary decides who needs the bypass.</p>`,
    },
    challenge: {
      kind: 'reach',
      goal: 'Read register 5 on port 1 while 0x42 is still being written to it (rd1 = 0x42, before any clock edge).',
      check: (st) => st.cycles === 0 && st.getInput('byp') === 1 && st.getInput('we') === 1 && st.getInput('ra1') === 5 && st.value('rd1') === 0x42,
      hints: ['The register has not been written yet: the stored word is still 0.', 'There is an input that turns the bypass path on.'],
      answer: 'wa = 5, wd = 0x42, we = 1, ra1 = 5 and byp = 1; do not pulse.',
      solve: (st) => { st.setInputs({ wa: 5, wd: 0x42, we: 1, ra1: 5, byp: 1 }); },
    },
  },
  {
    title: 'Latches instead of flip-flops',
    get body() {
      const N = RF_NUMBERS();
      return `
      <p>A flip-flop with enable costs ${N.dff} NANDs a bit: two latches, an inverter and the feedback multiplexer. A register file does not need the second latch in every bit. Make each bit one <span data-show="w5">D latch</span> (${N.latch} NANDs) whose enable is the
      write decoder's output ANDed with the clock (<span data-show="g5">e5 = y5 · clk</span>): a word is transparent while clk is high and its address is selected, and holds when clk falls. At 32 × 32 the file drops from ${g(N.rf)} to <strong>${g(N.lf)} NANDs</strong>
      (${pct(N.lf, N.rf)} %): the 31 words go from ${N.dff} to ${N.latch} NANDs a bit, the read ports are unchanged. The read of the word being written even sees <code>wd</code> through the open latch, with no bypass.</p>
      <p>That last property is the catch. While clk is high the whole data path from <code>wd</code> to the output is transparent, so <code>wd</code> must be <em>stable for the whole high phase</em>; and if wd is computed from a read of the same register (<code>addi x1, x1, 1</code>: rd → ALU → wd → x1) the latch closes a combinational
      loop and the value races. Real latch-based files put the missing half back once for the whole file: a <em>write-data latch</em>, transparent while clk is low, holds wd through the high phase (${N.word} NANDs for 32 bits, against the ${g(N.rf - N.lf)} saved). The shared latch is the master; each word is a slave. Same master–slave
      principle as the flip-flop, with the master factored out.</p>
      <div class="try">Set <code>we</code> = 1, <code>wa</code> = 5, <code>wd</code> = 0x42, <code>ra1</code> = 5 and watch rd1 stay 0 while clk is low. Raise clk: rd1 = 0x42. Change wd with clk still high: rd1 follows. Lower clk and change wd again: it holds.</div>`;
    },
    scene: () => ({ root: latchFile(3, 8), inputs: { wa: 5, wd: 0x42, we: 1, ra1: 5, ra2: 0, clk: 0 }, autoClock: false }),
    tour: {
      beats: [
        { title: 'Clock low: closed', reset: true, show: ['g5', 'w5'], expect: { rd1: 0 },
          say: '<p>we = 1 and the decoder selects register 5, but e5 = y5 · clk = 0: the latches are closed. rd1 = {v:rd1}.</p>' },
        { title: 'Clock high: transparent', set: { clk: 1 }, show: ['g5', 'w5', 'rp1'], expect: { rd1: 0x42 },
          say: '<p>e5 = 1: the word follows wd, and read port 1 sees {v:rd1} at once, without a clock edge.</p>' },
        { title: 'Data moves while open', set: { wd: 0x99 }, show: ['w5'], expect: { rd1: 0x99 },
          say: '<p>wd changes with clk still high: the open latches follow it, rd1 = {v:rd1}. The write data must be stable for the whole high phase.</p>' },
        { title: 'Clock falls: held', set: { clk: 0 }, show: ['w5'], expect: { rd1: 0x99 },
          say: '<p>clk falls: e5 closes, the word keeps the last value. rd1 = {v:rd1}.</p>' },
        { title: 'Closed latches ignore wd', set: { wd: 0x11 }, show: ['w5'], expect: { rd1: 0x99 },
          say: '<p>wd moves again with clk low: nothing happens. rd1 = {v:rd1}. (Change wd only after clk has fallen and settled: moving it together with the clock edge is a hold violation.)</p>' },
      ],
    },
    more: {
      derive: `<p>Storage per bit: ${RF_NUMBERS().latch} NANDs (a D latch, chapter 8) against ${RF_NUMBERS().dff} (flip-flop with enable). 31 words × 32 bits × ${RF_NUMBERS().dff - RF_NUMBERS().latch} = ${g(31 * 32 * (RF_NUMBERS().dff - RF_NUMBERS().latch))}, less the 31 AND gates that merge the clock into each enable.
        The file saves ${g(RF_NUMBERS().rf - RF_NUMBERS().lf)} NANDs, ${pct(RF_NUMBERS().rf - RF_NUMBERS().lf, RF_NUMBERS().rf)} %.</p>`,
      real: `<p>Latch-based register files exist in fast cores for exactly this: half the storage devices and the write happens in a defined phase. The cost moves to timing: time borrowing across the phase, a clock gated per word, and verification of the loop through the transparent phase. The SRAM cell of chapter 10 goes further, six transistors holding a bit with no clock at all.</p>`,
      pitfall: `<p>Using the latch file in the single-cycle CPU of chapter 14 unchanged. <code>addi x1, x1, 1</code> then reads x1, adds, and writes it back while the word is open: a combinational loop through a transparent latch. Whatever stops that (a write-data latch, a pulse shorter than the loop) is part of the design, and the saving above does not include it.</p>`,
    },
    challenge: {
      kind: 'reach',
      goal: 'Store 0x42 in register 5 so that it is still there with clk low and wd changed to 0x11.',
      check: (st) => word(st, 5) === 0x42 && st.getInput('clk') === 0 && st.getInput('wd') === 0x11,
      hints: ['A word is open only while clk is high and its address is selected.', 'Lower the clock before you change wd.'],
      answer: 'wa = 5, wd = 0x42, we = 1, clk = 1; then clk = 0; then wd = 0x11.',
      solve: (st) => { st.setInputs({ wa: 5, wd: 0x42, we: 1, clk: 1 }); st.setInputs({ clk: 0 }); st.setInputs({ wd: 0x11 }); },
    },
  },
  {
    title: 'Two writes, four reads',
    get body() {
      const N = RF_NUMBERS();
      return `
      <p>The dual-issue core of chapter 26 retires two instructions a cycle, so its file has <strong>four read ports and two write ports</strong>. Reads scale by repetition: each port is another 32:1 tree over all the words, ${g(N.port)} NANDs at 32 × 32 (the third port of the 3-read file, ${g(N.r3)} NANDs in all). Writes are harder, because the two ports can name the same
      register. <span data-show="ws5">Each register's write select</span> takes either decoder's output (OR) and picks port 1's data when port 1 is selected: <strong>port 1, the younger instruction, wins</strong>. That is exactly the program-order result of writing the older one first, and the lost write needs no cancelling.</p>
      <p>Complete file: ${g(N.r2)} NANDs, ${(N.r2 / N.rf).toFixed(2)}× the 2R1W file. Four read trees are ${g(4 * N.port)} of them (${pct(4 * N.port, N.r2)} %): for twice the instruction rate the cost of the file grows by about half, because the storage (${g(31 * 32 * N.dff)} NANDs) is paid once. In
      custom cells a port costs two transistors a bit and the file stays small; in gates, as here, the read trees take over.</p>
      <div class="try">Write 0x11 to register 3 on port 0 and 0x22 to register 3 on port 1 in the same cycle, Pulse, and read register 3: 0x22. Make port 1's write target x0 instead: port 0's write stands.</div>`;
    },
    scene: () => ({ root: regfile2w(3, 8), inputs: { wa0: 3, we0: 1, wd0: 0x11, wa1: 3, we1: 1, wd1: 0x22, ra1: 3, ra2: 0, ra3: 3, ra4: 0, clk: 0 }, autoClock: false }),
    tour: {
      beats: [
        { title: 'Both ports, one register', reset: true, show: ['dec0', 'dec1', 'ws3'], expect: { rd1: 0 },
          say: '<p>Both write ports name register 3 (0x11 on port 0, 0x22 on port 1). Nothing is stored yet: rd1 = {v:rd1}.</p>' },
        { title: 'The edge', cycles: 1, show: ['ws3', 'w3'], expect: { rd1: 0x22, rd3: 0x22 },
          say: '<p>Register 3 holds {v:rd1}: port 1 won. Read ports 1 and 3 both point at it, and port 2 reads x0 = {v:rd2}.</p>' },
        { title: 'Two different registers', set: { wa0: 4, wd0: 0x55, wa1: 5, wd1: 0x66, ra1: 4, ra3: 5 }, cycles: 1, show: ['ws4', 'ws5'], expect: { rd1: 0x55, rd3: 0x66 },
          say: '<p>Different registers: both writes land in one edge. rd1 = {v:rd1}, rd3 = {v:rd3}.</p>' },
        { title: 'Port 1 writes x0', set: { wa0: 6, wd0: 0x77, wa1: 0, wd1: 0x88, ra1: 6, ra2: 0 }, cycles: 1, show: ['x0', 'ws6'], expect: { rd1: 0x77, rd2: 0 },
          say: '<p>Port 1\'s write to x0 goes nowhere; port 0\'s write to register 6 stands: rd1 = {v:rd1}, x0 still {v:rd2}.</p>' },
      ],
    },
    more: {
      numbers: `<table class="mini"><tr><th>file (32 × 32)</th><th>NANDs</th><th>vs 2R1W</th></tr>
        <tr><td>2 read, 1 write (RISC-V)</td><td>${g(RF_NUMBERS().rf)}</td><td>1.00×</td></tr>
        <tr><td>3 read, 1 write</td><td>${g(RF_NUMBERS().r3)}</td><td>${(RF_NUMBERS().r3 / RF_NUMBERS().rf).toFixed(2)}×</td></tr>
        <tr><td>4 read, 2 write (dual issue)</td><td>${g(RF_NUMBERS().r2)}</td><td>${(RF_NUMBERS().r2 / RF_NUMBERS().rf).toFixed(2)}×</td></tr></table>`,
      pitfall: `<p>Giving both ports a priority by decoding the older one last. If the older instruction wins, a program like <code>addi x5, x0, 1</code> then <code>addi x5, x0, 2</code> issued together would leave x5 = 1 and the architectural state would differ from the sequential machine. The rule is the program order, not arrival order.</p>`,
    },
    challenge: {
      kind: 'reach',
      goal: 'Write 0x11 to register 3 on port 0 and 0x22 on port 1 in one cycle, and show that 0x22 is stored.',
      check: (st) => word(st, 3) === 0x22 && st.cycles >= 1,
      hints: ['Both write ports need the same address and their own data and enable.', 'Pulse once, then look at register 3.'],
      answer: 'wa0 = wa1 = 3, wd0 = 0x11, wd1 = 0x22, we0 = we1 = 1, Pulse: port 1 wins.',
      solve: (st) => { st.setInputs({ wa0: 3, wd0: 0x11, we0: 1, wa1: 3, wd1: 0x22, we1: 1 }); st.pulse(); },
    },
  },
];
