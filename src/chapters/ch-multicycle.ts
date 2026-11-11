import { RESULTS } from '../bench/summary';
import { PROGRAMS_USED } from '../widgets/family360';
import { groupDigits } from '../sim/numfmt';
import facts from '../bench/ucodefacts.json';
import { MC_DISPATCH, MC_FSM, MC_MICRO, MC_STATES } from '../lib/multicycle';
import { bookProgram, cyclesByClass, iTypeInThree, type Microprogram } from '../lib/ucode';
import { stats } from '../sim/stats';
import { PROGRAMS } from '../riscv/programs';
import { h } from '../ui/dom';
import type { Scene, Stage, Widget } from '../view/stage';
import { controllerPanel, cpuScene } from '../widgets/cpupanel';
import { CHAPTER_PERIOD, familyRows, familyWidget, microStore, spread } from '../widgets/family360';
import { findIt } from '../widgets/findfault';
import type { Chapter } from './types';
import { numOf } from './order';

const src = (id: string) => PROGRAMS.find((p) => p.id === id)!.source;

/** Find it: the multicycle CPU with one wire stuck (sim/faults.ts), never drawn. */
const FIND_MC = findIt({
  source: src('sum'), multicycle: 'fsm',
  planted: [{ kind: 'stuck1', end: 'ir.en' }],
  goal: 'Find the planted fault: name the wire and the value it is stuck at.',
  hints: [
    'The very first instruction, <code>li a0, 0</code>, already writes a wrong value, 0xc, where its immediate is 0: the register file wrote what the CPU decoded.',
    'Between Fetch and Write-back the CPU decodes the instruction from one register, held across the steps. When should that register load?',
    'The instruction register should load in Fetch only. Its enable, <code>IRWrite</code>, is stuck at 1.',
  ],
  fault: 'The instruction register\'s enable, <code>IRWrite</code>, was stuck at 1: the IR loaded a word from memory at every clock edge, not only in Fetch. Measured on the gates: across the first instruction\'s steps the IR held <code>li a0, 0</code> in Decode, <code>li t0, 1</code> (the word at PC + 4) in the next step, and <code>li a0, 0</code> again in the step that wrote a0; OldPC, which shares the enable, reloaded with it. The value written, 0xc, is what the result bus carried at that edge; exactly which path through the datapath made it is not traced here, since the wrong words also steered the state machine\'s dispatch. The state machine itself was right: it was decoding the wrong words.',
});

/** Cycles an instruction takes: Fetch and Decode, then the states from its dispatch target until the table returns to Fetch
 *  (`mem`: the state a load or store goes to after MemAdr). */
function cyclesOf(target: number, mem = 0): number {
  let n = 2;
  for (let i = target; ; n++) {
    const nx = MC_STATES[i].next;
    if (nx === 0) return n + 1;
    i = typeof nx === 'number' ? nx : mem;
  }
}
const target = (cls: string) => MC_DISPATCH.find(([c]) => c === cls)![1];
/** Cycle counts by class, from the state table. */
const CYC = {
  branch: cyclesOf(target('BRANCH')), lui: cyclesOf(target('LUI')), auipc: cyclesOf(target('AUIPC')),
  alu: cyclesOf(target('R')), store: cyclesOf(target('STORE'), 5), jal: cyclesOf(target('JAL')),
  load: cyclesOf(target('LOAD'), 3), jalr: cyclesOf(target('JALR')),
};
const sp = groupDigits;
const FSM_NANDS = stats(MC_FSM).nands, MICRO_NANDS = stats(MC_MICRO).nands;
const FAM = familyRows(), SPREAD = spread(FAM), MS = microStore();
/** Annual rental in 1964 dollars, Models 30 and 65: Patterson's SOSP 2015 table (the Sources paragraph). */
const IBM_RENT = { m30: 48000, m65: 270000 };
/** The chapter-sized CPUs' static periods (64-word instruction ROM), NAND delays: the timing panel's numbers. */
const SC_P = CHAPTER_PERIOD.sc, MC_P = CHAPTER_PERIOD.mc;

/** The state table as a page widget. */
function stateTable(): Widget {
  const fields = ['pcUpdate', 'branch', 'irWrite', 'regWrite', 'memWrite', 'adrSrc', 'resultSrc', 'aluSrcA', 'aluSrcB', 'aluFunct', 'retire'];
  const nextOf = (s: (typeof MC_STATES)[number]) => (typeof s.next === 'number' ? MC_STATES[s.next].name : s.next === 'decode' ? 'by opcode' : 'load / store');
  return {
    el: h('div', { class: 'widget' }, h('div', { class: 'panel' },
      h('h3', null, 'The multicycle state table'),
      h('p', { class: 'sub' }, 'ALUSrcA: 0 PC, 1 OldPC, 2 A. ALUSrcB: 0 B, 1 imm, 2 four. ResultSrc: 0 ALUOut, 1 Data, 2 ALUResult, 3 imm. aluFunct: 0 add, 1 the instruction\'s own operation. Blank = 0. Decode dispatch: load/store → MemAdr, R → ExecuteR, I → ExecuteI, jal → JAL, branch → Branch, jalr → JALR, lui → LUI, auipc → ALUWB.'),
      h('table', { class: 'cmp mc-big' },
        h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'state'), h('th', null, 'does'), ...fields.map((f) => h('th', { class: 'vert' }, f)), h('th', null, 'next'))),
        h('tbody', null, MC_STATES.map((s, i) => h('tr', null,
          h('td', null, String(i)), h('td', null, h('strong', null, s.name)), h('td', { class: 'sub' }, s.does),
          ...fields.map((f) => h('td', { class: 'num' }, s.sig[f] ? String(s.sig[f]) : '')),
          h('td', null, nextOf(s)))))))),
  };
}

// ---- "Paint the microcode": the painter on the chapter's CPU --------------------------------------------------

/** What the step's CPU runs; a fresh visit starts from the book's. */
let painted: Microprogram = bookProgram();
/** Scenes (by the CPU's id) whose microprogram passed the check and is faster for I-type: what the challenge asks. */
const verified = new Set<string>();
const bookCycles = cyclesByClass(bookProgram());
const pct = (v: number) => Math.round(v * 100);

function ucodeScene(): Scene {
  return cpuScene({ source: src('sum'), multicycle: 'micro', microcode: painted, highlight: ['ctrl'], onMicrocode: openPainter });
}

function openPainter(stage: Stage): void {
  void import('../widgets/ucodepainter').then((m) => m.openMicrocode({
    program: painted, host: document.body, mode: 'sheet', applyLabel: 'Apply to the CPU',
    onHighlight: (units) => stage.highlight(units ?? ['ctrl'], !!units),
    onApply: (p, report) => {
      painted = p;
      const sc = ucodeScene();
      if (report?.allPass && (report.cycles.I ?? 99) < (bookCycles.I ?? 0)) verified.add(sc.root.id);
      stage.load(sc);
    },
  }));
}

export const chMulticycle: Chapter = {
  id: 'multicycle', num: numOf('multicycle'), title: 'Multicycle & microcode', level: 'Processor',
  blurb: 'One ALU and one memory port reused over several short cycles, sequenced by a hardwired state machine or by microcode.',
  goals: [
    'split instructions into steps that share one ALU and one memory port, with registers across the step boundaries',
    'read the state table and count each instruction class\'s cycles (3, 4 or 5)',
    'build the controller as a hardwired state machine or as microcode, and price both',
    'decide from <span data-ahead="cpi">CPI (cycles per instruction)</span> × period whether the multicycle CPU beats the single-cycle one',
  ],
  builds: ['registers', 'cpu'],
  recap: {
    keep: [
      'One ALU computes PC + 4 (fetch), the branch target (decode) and the operation (execute); one memory port serves fetches and loads. IR, OldPC, A, B, Data and ALUOut carry values across steps.',
      '13 states. Branch, lui and auipc take 3 cycles; ALU operations, stores and jal 4; loads and jalr 5.',
      'Hardwired control: a 4-bit state register, a 4→16 decoder, an AND gate per opcode-dependent transition and OR gates per signal: 412 NANDs.',
      'Microcode: a µPC addresses a ROM of microwords (14 control bits, a 4-bit next address, a 2-bit sequencing mode), with dispatch ROMs indexed by the opcode: 6124 NANDs here, because these ROMs are mux trees of constants.',
      'The microcode is a grid of cells you can paint: an I-type instruction written back in ExecuteI takes 3 cycles instead of 4, and the painter checks any edit against the golden model.',
      `Period ${MC_P} NAND delays against the single-cycle CPU's ${SC_P} (both with <span data-ahead="prefix">Kogge–Stone adders, the fast adders of chapter ${numOf('fastadd')}</span>), but more cycles for each instruction (<span data-ahead="cpi">its CPI, cycles per instruction</span>): CPI 3.6 to 4.0 on the sample programs: about 300 to 340 delays per instruction.`,
    ],
    practise: ['s_fsm', 'o_mc'],
    check: [
      {
        question: 'How many cycles does <code>jalr</code> take on the multicycle CPU?',
        options: ['5: Fetch, Decode, JALR, JAL, ALUWB', '3, like a branch', '4, like jal', '1'],
        answer: 0,
        explain: 'JALR puts rs1 + imm in ALUOut; then it reuses the JAL state (PC ← target, ALUOut ← OldPC + 4) and ALUWB writes the return address.',
        why: ['', 'A branch writes no register. jalr must compute its target from rs1 and also save the return address.', 'jal\'s target is ready after decode (OldPC + imm); jalr needs one more step for rs1 + imm before reusing JAL.', 'Only the single-cycle CPU finishes an instruction in one clock.'],
      },
      {
        question: 'Why does the multicycle datapath need registers such as A, B and ALUOut that the single-cycle one does without?',
        options: ['A value computed in one step must survive the clock edge into the next', 'They hold the microcode', 'They forward results between instructions', 'They replace the register file'],
        answer: 0,
        explain: 'Each step ends at a clock edge. Whatever the next step needs (the operands, the ALU result, the loaded word) must be captured in a register at that edge.',
        why: ['', 'The microcode lives in the controller\'s ROM; these are datapath registers.', 'Only one instruction is in flight at a time: there is nothing to forward between.', 'The register file is still there; A and B hold the two values read from it for the next step.'],
      },
      {
        question: 'Here microcode costs 6124 NANDs against 412 for the hardwired FSM. When is microcode worth it?',
        options: ['When the control table is large and irregular, or must be changeable after manufacture', 'When the clock must be faster', 'Never: it only adds gates', 'When the instruction set is small and regular'],
        answer: 0,
        explain: 'A dense ROM stores a big table more cheaply than random logic, and can be rewritten. That is how System/360 spanned a family of machines and how x86 cores still patch bugs.',
        why: ['', 'Both controllers give the same period here: microcode buys flexibility, not speed.', 'Our ROMs are mux trees; a real ROM is a dense transistor array. And System/360 and x86 used it for good reasons.', 'A small, regular table is where hardwired logic is cheapest, as RV32I shows here.'],
      },
    ],
  },
  steps: [
    {
      title: 'Several short cycles',
      body: `
        <p>The single-cycle CPU gives every instruction the time of the slowest one, and needs three adders (ALU, PC + 4, branch target)
        plus separate instruction and data ports. The <strong>multicycle</strong> CPU splits each instruction into steps of one clock each:
        fetch, decode, execute, memory, write-back. Now <em>one</em> <span data-show="alu">ALU</span> computes PC + 4 in the fetch step, the branch target in decode and the
        operation in execute, and <span data-show="memsel">one memory port</span> serves both fetches and loads.</p>
        <p>Values that cross a step boundary need <span data-show="ir oldpc ra rb data aluout">registers</span>: <strong>IR</strong> (the instruction), <strong>OldPC</strong>, <strong>A</strong> and
        <strong>B</strong> (the source registers), <strong>Data</strong> (a loaded word) and <strong>ALUOut</strong>. The datapath now does whatever the
        <span data-show="ctrl">controller</span> says, one step at a time.</p>
        <p>(The memory port selects the program ROM or the data RAM by phase, so the sample programs keep their data at address 0.)</p>
        <p>The aim of sharing is area: one ALU instead of three adders, one memory port instead of two (the step <em>Was it worth it?</em> counts whether it paid here: the registers that carry values across steps cost more than the adders saved). Registers hold what crosses a clock edge, and the controller must now remember which step it is in, so it becomes a state machine. What this costs is time. An
        instruction takes ${CYC.branch} to ${CYC.load} cycles instead of one, and the clock period only shrinks to the longest single step.</p>
        <div class="try">Pulse the clock and follow the controller panel: the first instruction, <code>li a0, 0</code>, takes Fetch, Decode, ExecuteI, ALUWB (four cycles).</div>`,
      scene: () => cpuScene({ source: src('sum'), multicycle: 'fsm', highlight: ['ctrl'] }),
      tour: {
        beats: [
          { title: 'Fetch', reset: true, show: ['ctrl'], expect: { state: 0, fetch: 1, pcOut: 0 },
            say: '<p>State {v:state}, Fetch. The ALU computes PC + 4 while the instruction at 0 (<code>li a0, 0</code>) is read into IR.</p>' },
          { title: 'Decode', cycles: 1, show: ['ir', 'ra', 'rb'], expect: { state: 1, fetch: 0, pcOut: 4 },
            say: '<p>The PC is now {v:pcOut}. Decode reads the two source registers into A and B, and the same ALU computes OldPC + imm, a branch target nobody may need.</p>' },
          { title: 'Execute', cycles: 1, show: ['aluout'], expect: { state: 8 },
            say: '<p>State {v:state}, ExecuteI: the ALU computes A + imm into ALUOut. The register file is not written yet.</p>' },
          { title: 'Write back', cycles: 1, show: ['aluout'], expect: { state: 7, retire: 1 },
            say: '<p>ALUWB (state {v:state}) writes ALUOut into rd, and retire = {v:retire}: the instruction is done after four cycles.</p>' },
          { title: 'The next instruction', cycles: 1, show: ['ctrl'], expect: { state: 0, fetch: 1, pcOut: 4 },
            say: '<p>Back to Fetch, with the PC at {v:pcOut}. Every instruction starts the same way.</p>' },
          { title: 'A branch takes three', cycles: 18, show: ['ctrl'], expect: { state: 10, retire: 1, pcOut: 24 },
            say: '<p>Eighteen cycles later, the loop\'s <code>bne</code> is in the Branch state (state {v:state}): Fetch, Decode, Branch is all it needs, and retire = {v:retire} in the third.</p>' },
          { title: 'Taken', cycles: 1, show: ['ctrl'], expect: { state: 0, pcOut: 12 },
            say: '<p>The branch was taken: the PC is back at {v:pcOut}, the top of the loop, after only three cycles for the branch.</p>' },
        ],
      },
      more: {
        derive: `<p>Cycles per class come straight from the state table: branch, lui and auipc ${CYC.branch}; ALU operations, stores and jal ${CYC.alu}; loads and jalr ${CYC.load}. Time per instruction is CPI × period. A program whose mix is half ALU operations (4 cycles), a
          fifth loads (5), a fifth branches (3) and the rest stores (4) averages ${(0.5 * CYC.alu + 0.2 * CYC.load + 0.2 * CYC.branch + 0.1 * CYC.store).toFixed(1)} cycles per instruction.</p>`,
        pitfall: `<p>Leaving out IR. It is tempting to read the instruction from memory in every step, but the memory port is shared: after Fetch the same port serves a load or store, and the address changes. IR is the copy that survives. The same goes for A, B and ALUOut: any value
          needed after the next edge must sit in a register, or the shared unit overwrites it.</p>`,
        real: `<p>Multicycle designs were the norm while logic was dear: the 6502 spends 2 to 7 cycles per instruction on one ALU and one bus. Their control was often microcode, the subject of the later steps.</p>`,
      },
    },
    {
      title: 'The state table',
      body: `
        <p>Everything about sequencing is in one table: per state, which control signals are on and which state comes next. Decode branches on the
        opcode class; MemAdr on load versus store. Instructions take 3 (branch, lui, auipc), 4 (ALU ops, stores, jal) or 5 cycles (loads, jalr).</p>
        <p>Two tricks keep it short. Decode computes OldPC + imm "just in case": that is the branch target, the jal target and the auipc result, so
        auipc goes straight to write-back. And jalr reuses the JAL state once it has put its target in ALUOut.</p>
        <p>To read the table, follow an instruction by its class: the Decode row's dispatch names the first execute state, and each row's <em>next</em> column gives the one after, until Fetch comes back. A load is Fetch, Decode, MemAdr, MemRead, MemWB: ${CYC.load} cycles. The control
        signals in a row are exactly what that cycle does on the datapath, so the table is both the specification and, in the next two steps, the circuit.</p>`,
      widget: stateTable,
      more: {
        derive: `<p>Counting cycles by walking the table: Fetch and Decode are common (2). Then ${MC_DISPATCH.map(([c, t]) => `${c} → ${MC_STATES[t].name}`).join(', ')}. Following the next column from each: branch, lui and auipc end after one more state (${CYC.branch}); R, I, store and jal after two (${CYC.alu}); load and jalr after three (${CYC.load}).</p>`,
        pitfall: `<p>Reading Decode as idle. It computes the branch target before it knows the instruction is a branch. If the instruction turns out to be a load, that value goes unused; spending the ALU in a cycle that would otherwise wait is what saves a cycle on branches.</p>`,
        real: `<p><strong>A machine built on its memory's cycle.</strong> DEC's PDP-8 (1965) ran every instruction as one to three <strong>major
          states</strong>, each one cycle of its core memory, 1.5 µs: Fetch reads the instruction; Defer, only when the instruction names a word
          that holds the real address (an indirect reference), reads that word; Execute reads or writes the operand. A jump needs no Execute, and
          an operate instruction (clear, complement, rotate, or skip on a test of the accumulator) is Fetch alone. Its 12-bit words and handful of
          registers (PC, the accumulator and its link bit, the memory's address and data registers) make the cycle count the whole timing
          model: the memory, not the logic, sets the pace. The sandbox has it twice, Examples ▸ PDP-8 front panel (a model behind lamps and
          switches) and Examples ▸ PDP-8 in gates (one clock edge per major state); the codex's <a href="#/campaign/codex/pdp8">PDP-8</a> entry
          has what they assume: octal, pages, auto-index, the operate bits and the front panel's keys.</p>`,
      },
    },
    {
      title: 'Hardwired control',
      body: `
        <p>The classic implementation: a <span data-show="st">4-bit state register</span>, a <span data-show="dec">4→16 decoder</span>
        giving one wire per state, <span data-show="t1 t2 t3 t4 t5 t6 t7 t8 t9 t10 t11">an AND gate per opcode-dependent transition</span>
        and OR gates. Each control signal is the OR of the states that assert it. Each next-state bit is
        <span data-show="n0 n1 n2 n3">the OR of the transitions</span> whose target has that bit set.
        ${MC_STATES.length} states cost ${sp(FSM_NANDS)} NANDs.</p>
        <p>The structure is a direct transcription of the table: a state is a wire, a transition is an AND of a state wire and, for the two dispatch points, an opcode test, and each signal is the OR of the states that assert it. Nothing is stored except the 4-bit state, which is why
        it is so small. Its price is that every change of the table is a change of the logic.</p>
        <div class="try">op = 0x03 is a load. Pulse through Fetch → Decode → MemAdr → MemRead → MemWB and back to Fetch.</div>`,
      scene: () => ({ root: MC_FSM, inputs: { op: 0x03, clk: 0 }, panels: [controllerPanel('fsm')] }),
      tour: {
        beats: [
          { title: 'Fetch', reset: true, show: ['st', 'dec'], expect: { state: 0, irWrite: 1, pcUpdate: 1 },
            say: '<p>State {v:state}: the decoder raises its Fetch wire, and the OR gates assert irWrite = {v:irWrite} and pcUpdate = {v:pcUpdate}. The opcode (a load, 0x03) is ignored for now.</p>' },
          { title: 'Decode', cycles: 1, expect: { state: 1, irWrite: 0 },
            say: '<p>One edge: state {v:state}, Decode. The signals for Fetch are off.</p>' },
          { title: 'MemAdr: the opcode matters', cycles: 1, show: ['t1', 't2'], expect: { state: 2, aluSrcB: 1 },
            say: '<p>Decode\'s next state depends on the opcode. The AND gate for "Decode and a load or a store" fires: state {v:state}, MemAdr, computing the address with the immediate (aluSrcB = {v:aluSrcB}).</p>' },
          { title: 'MemRead, then MemWB', cycles: 2, show: ['dec'], expect: { state: 4, regWrite: 1, retire: 1 },
            say: '<p>For a load the next state is MemRead and then MemWB (state {v:state}): regWrite and retire are {v:regWrite}.</p>' },
          { title: 'A store takes another path', set: { op: 0x23 }, cycles: 4, expect: { state: 5, memWrite: 1, retire: 1 },
            say: '<p>With op = 0x23 (a store) the same Decode and MemAdr states lead to MemWrite instead (state {v:state}): memWrite = {v:memWrite}. The dispatch is the only place where the opcode changes the path.</p>' },
        ],
      },
      more: {
        derive: `<p>Signal s = OR over the states i with s asserted, of the decoded state wire. Next-state bit k = OR over the transitions t with bit k set in the target. The ${MC_STATES.length} states need ${Math.ceil(Math.log2(MC_STATES.length))} state bits. Both are sums of products over at most ${MC_STATES.length} wires, so the whole controller is ${sp(FSM_NANDS)} NANDs, and
          its delay is a decoder plus two levels of OR: short next to the datapath.</p>`,
        pitfall: `<p>Adding a state without the transition into it. An unreachable state asserts nothing and nothing complains: the decoder has a wire for it and the logic is complete, but no AND gate leads there. The tests read the controller back and compare every state and arc against the table for that reason.</p>`,
      },
      tries: [(st) => st.value('state') === 4],
      challenge: {
        kind: 'reach', goal: 'Drive the controller into the MemWrite state.',
        check: (st) => st.value('state') === 5,
        hints: [
          'MemWrite only follows MemAdr, and MemAdr only follows Decode for a load or a store.',
          'The opcode input decides the path at Decode and at MemAdr: which opcode is a store?',
        ],
        answer: 'MemWrite follows MemAdr for a store: set op = 0x23 (sw) and pulse from Fetch three times: Fetch → Decode → MemAdr → MemWrite.',
        solve: (st) => {
          st.setInputs({ op: 0x23 });
          for (let i = 0; i < 12 && st.value('state') !== 5; i++) st.runCycles(1);
        },
      },
    },
    {
      title: 'Microcode',
      body: `
        <p>Maurice Wilkes (1951): store the table instead of wiring it. A <strong><span data-show="upc">micro-PC</span></strong> addresses a
        <span data-show="urom">ROM</span> of <strong>microwords</strong>.
        Each word holds this cycle's control signals (14 bits), a next-address field (4) and a sequencing mode (2): take the next-address field,
        or <em>dispatch</em> through <span data-show="d1 d2">a small ROM</span> indexed by the opcode. The
        <span data-show="mx">sequencer</span> picks which.</p>
        <p>IBM's System/360 (1964) used microcode to run one instruction set on machines of very different cost. x86 processors still execute
        their rarest, most complex instructions from a microcode ROM, and patch hardware bugs with microcode updates loaded at boot.</p>
        <p>The consequence is flexibility. Changing the instruction set's sequencing means changing the ROM contents, not the logic; adding an instruction is a few more words. The ROM here costs ${sp(MICRO_NANDS)} NANDs against ${sp(FSM_NANDS)} for the hardwired controller, because our ROMs are
        trees of multiplexers over constants.</p>
        <div class="try">Same inputs as before. The panel shows the microwords: sequencing | next | control.</div>`,
      scene: () => ({ root: MC_MICRO, inputs: { op: 0x03, clk: 0 }, panels: [controllerPanel('micro')] }),
      tour: {
        beats: [
          { title: 'The same sequence', reset: true, show: ['upc', 'urom'], expect: { state: 0, irWrite: 1 },
            say: '<p>The micro-PC is {v:state}: the ROM word at address 0 asserts irWrite = {v:irWrite}, as the hardwired Fetch did.</p>' },
          { title: 'Dispatch through the opcode', cycles: 2, show: ['d1', 'd2', 'mx'], expect: { state: 2, aluSrcA: 2 },
            say: '<p>After Decode the sequencer takes the dispatch ROM, indexed by the opcode (a load): the next micro-address is {v:state}, MemAdr, with aluSrcA = {v:aluSrcA}.</p>' },
          { title: 'Write back', cycles: 2, show: ['urom'], expect: { state: 4, regWrite: 1, retire: 1 },
            say: '<p>Two words later, MemWB: regWrite = {v:regWrite}, retire = {v:retire}. Every control signal is the same, cycle for cycle, as in the hardwired controller.</p>' },
        ],
      },
      more: {
        derive: `<p>A microword is a row of the state table plus its sequencing: ${MC_STATES.length} words of 14 control bits, a 4-bit next address and a 2-bit mode (next, dispatch through the opcode, or the second dispatch for load versus store), and two small dispatch ROMs. The same table feeds both controllers (the tests check them cycle by cycle), so
          there is no second source of truth to drift.</p>`,
        real: `<p>Wilkes' point was exactly this: the control table becomes data. A shipped CPU can then fix a bug by patching a microword, which x86 cores still do, and a family of machines can share a datapath style with different microprograms.</p>`,
        pitfall: `<p>Treating microcode as free. The ROM is state that must be read every cycle: its address register and the ROM's own delay are on the controller's critical path, and a ROM written as logic costs far more than a state machine for a table this small.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'The microcode and FSM controllers are generated from the same table. How do we know they behave identically?',
        options: [
          'We assume it',
          'Both run in lock-step for 3000 cycles of random instructions with every output compared, and both full CPUs are co-simulated against the instruction-set simulator',
          'The microcode is faster',
          'They have the same gate count',
        ],
        answer: 1,
        why: ['An assumption is not evidence: two implementations of one table can still differ by a wiring mistake.', '', 'Speed says nothing about behaviour, and both run at the same period here.', 'Equal cost would prove nothing, and they are far apart: about 400 NANDs against 6100.'],
        explain: 'The site\'s tests drive both controllers with the same opcode sequence, reaching all 13 states, and compare every control signal every cycle. Then each full CPU runs every sample program against the instruction-set simulator. Equivalence checking of two implementations is a daily job in industry, usually done formally.',
      },
    },
    {
      title: 'Same CPU, microprogrammed',
      body: `
        <p>Swap the <span data-show="ctrl">controller</span> and nothing else changes: same cycles, same results. The cost does change. The FSM takes ${sp(FSM_NANDS)} NANDs. The microcode
        controller takes ${sp(MICRO_NANDS)}, because our ROMs are multiplexer trees of constants (a real ROM is a dense transistor array). Microcode pays off when the
        table is large and irregular, as with complex instruction sets, or when it has to be changeable.</p>
        <p>The comparison to keep in mind is the ratio: ${(MICRO_NANDS / FSM_NANDS).toFixed(0)} to 1 for a table this small and regular. RV32I has few instructions and each is a handful of states, which is the case hardwired logic handles best; a CISC instruction set with hundreds of
        multi-step instructions is the case microcode was invented for.</p>`,
      scene: () => cpuScene({ source: src('sum'), multicycle: 'micro', highlight: ['ctrl'] }),
      tour: {
        beats: [
          { title: 'Same program, same states', reset: true, cycles: 3, show: ['ctrl'], expect: { state: 7, retire: 1, pcOut: 4 },
            say: '<p>After three edges the first <code>li</code> is in ALUWB (state {v:state}) with retire = {v:retire}: the identical trace as the hardwired version.</p>' },
          { title: 'And the branch', cycles: 19, show: ['ctrl'], expect: { state: 10, retire: 1, pcOut: 24 },
            say: '<p>Nineteen cycles on, the loop\'s branch is in state {v:state}, three cycles after its fetch, exactly as before. The controller\'s construction is invisible from outside.</p>' },
        ],
      },
      more: {
        derive: `<p>Both controllers implement the same function from (state, opcode) to (control signals, next state), so for equal tables they are equivalent; the difference is only cost: ${sp(FSM_NANDS)} NANDs wired, ${sp(MICRO_NANDS)} as a ROM, a factor of ${(MICRO_NANDS / FSM_NANDS).toFixed(0)}.</p>`,
        pitfall: `<p>Concluding that microcode is inherently wasteful from this number. The ROM here is a tree of multiplexers on constants, about the worst way to store a table; a ROM array of transistors stores a bit in one device. The ratio says more about this site's ROM than about microcode.</p>`,
      },
    },
    {
      title: 'Was it worth it?',
      body: `
        <p>Measured with the timing panel: the clock period drops from ${SC_P} to <strong>${MC_P}</strong> NAND delays. The longest step is still a full
        <span data-show="alu">ALU</span> operation followed by the <span data-show="npc">branch decision</span>. But the <span data-ahead="cpi">CPI (cycles per instruction)</span> is now <strong>3.6 to 4.0</strong> on the sample programs (this gcd: 51 instructions in 182 cycles, 3.57),
        so each instruction takes 300 to 340 delays instead of ${SC_P}.
        The gate count does not even go down: <span data-show="ir oldpc ra rb data aluout">six 32-bit registers</span> (about 2900 NANDs) cost more than the two adders they replace.</p>
        <p>Multicycle machines made sense when memory was the expensive, slow part and logic was scarce. Their lasting legacy is the controller,
        and the idea of overlapping the steps instead of serializing them, which <span data-ahead="pipeline">the pipeline (instructions overlapped, one per stage)</span> of <a href="#/c/pipeline/0">chapter ${numOf('pipeline')}</a> takes up.</p>
        <p>The accounting is time per instruction = CPI × period. A step is shorter than the whole single-cycle path, but an instruction needs several of them; the product is what matters, and here it is far above the single-cycle machine's one period of ${SC_P}. The cheap controller
        (${sp(FSM_NANDS)} NANDs) is not the problem; the serial use of one ALU is.</p>`,
      scene: () => cpuScene({ source: src('gcd'), multicycle: 'fsm', timing: true }),
      more: {
        derive: `<p>Single-cycle: CPI 1 at a period of ${SC_P}, so ${SC_P} delays per instruction. Multicycle: this gcd takes 182 cycles for 51 instructions, CPI ${(182 / 51).toFixed(2)}, at a period of ${MC_P}: ${Math.round((182 / 51) * MC_P)} delays per instruction, ${((182 / 51) * MC_P / SC_P).toFixed(1)} times slower. The period fell by ${Math.round((1 - MC_P / SC_P) * 100)} %
          while the cycle count per instruction rose by a factor of ${(182 / 51).toFixed(1)}.</p>`,
        pitfall: `<p>Expecting a shorter clock to pay. The longest step is still an ALU operation followed by the branch decision, so the period cannot fall far below the single-cycle machine's; to make multicycle competitive the steps must be balanced and overlapped, which is a pipeline.</p>`,
        real: `<p>Multicycle sequencing survives where logic is scarce or memory is slow relative to logic: small microcontrollers, and the microcoded parts of larger cores. Performance cores overlap instead.</p>`,
      },
      challenge: {
        kind: 'quiz', question: `The steps are unbalanced: the ALU step needs ${MC_P} delays, the others much less. What would make the multicycle CPU competitive?`,
        options: ['A faster controller', 'Balancing the steps (e.g. splitting the ALU step) and overlapping consecutive instructions', 'More microcode', 'A bigger register file'],
        answer: 1,
        why: ['The longest step is the ALU operation and the branch decision, and <span data-ahead="cpi">CPI (cycles per instruction)</span> stays near 4 with any controller.', '', 'Microcode changes how the table is stored, not how long a step takes or how many steps there are.', 'A bigger register file sets neither the longest step nor the number of steps.'],
        explain: 'Time per instruction = <span data-ahead="cpi">CPI (cycles per instruction)</span> × period. With CPI near 4, only a much shorter period helps, which needs balanced steps. Overlapping the steps of consecutive instructions brings CPI back toward 1: that is <span data-ahead="pipeline">pipelining (one instruction in each step at once)</span>.',
      },
    },
    {
      title: 'Paint the microcode',
      body: `
        <p>Microcode is data, so changing the machine means changing cells. The controller panel's <strong>Microcode…</strong> opens the ROM as a grid:
        a row per microword, a column per control signal, a cell painted or cycled with a click, Space or Enter. The words are what
        <span data-show="ctrl">the controller</span> sends to the datapath; the sequencing columns say what comes next.</p>
        <p>An I-type instruction (<code>addi</code>, <code>slli</code>, <code>andi</code> …, ${pct(facts.iShare)} % of everything the benchmarks execute) takes
        ${facts.bookCycles.I} cycles: Fetch, Decode, ExecuteI, ALUWB. ExecuteI computes into ALUOut; ALUWB only copies it into <code>rd</code>. A cycle spent copying.</p>
        <p>The painter refuses edits that cannot work (a word that never reaches Fetch, an instruction that never retires or retires twice) and
        checks the rest on the edited CPU: the ${facts.tests} riscv-tests rv32ui images it can run and the ${facts.benches} benchmark programs, every result compared
        with the golden model; a wrong word is named by the first instruction after which the CPU and the model differ. The ROM's contents are constants, so
        the controller costs the same NANDs whatever you paint.</p>
        <div class="try">Open the microcode, select word 8 (ExecuteI) and look at what lights in the datapath sketch and on the circuit.</div>`,
      more: {
        numbers: `<p>Book: CPI ${facts.bookCpi.toFixed(2)} on the four benchmarks (${groupDigits(facts.instructions)} instructions). I-type instructions are ${pct(facts.iShare)} % of them, so one cycle fewer each
          lowers the CPI by ${pct(facts.iShare)} / 100 = ${(facts.bookCpi - facts.solvedCpi).toFixed(2)}, to ${facts.solvedCpi.toFixed(2)}.</p>`,
      },
      scene: () => { painted = bookProgram(); return ucodeScene(); },
      challenge: {
        kind: 'reach', goal: 'Make I-type instructions take 3 cycles, and pass the check.',
        check: (st) => !!st.scene && verified.has(st.scene.root.id),
        hints: [
          'Look at the two words an I-type instruction visits after Decode: ExecuteI computes, ALUWB only copies ALUOut into rd. Could ExecuteI write rd itself?',
          'The register file takes whatever Result carries when RegWrite is 1. During ExecuteI the ALU output is already on the Result multiplexer, at its ALUResult input.',
          'Paint word 8 (ExecuteI): rg wr, ret, result = ALUResult, and point its next at word 0 (Fetch). Run the check, then Apply.',
        ],
        answer: `In ExecuteI (word 8) set <code>rg wr</code> and <code>ret</code>, set <code>result</code> to ALUResult (the ALU output before the ALUOut register) and point <code>next</code> at word 0, Fetch.
          An I-type instruction is now Fetch, Decode, ExecuteI: ${facts.solvedCycles.I} cycles. All ${facts.tests} riscv-tests pass, the <span data-ahead="cpi">CPI (cycles per instruction)</span> goes from ${facts.bookCpi.toFixed(2)} to ${facts.solvedCpi.toFixed(2)}, and the controller is the same size.`,
        solve: (st) => {
          painted = iTypeInThree();
          const sc = ucodeScene();
          verified.add(sc.root.id); // tests/ucode.test.ts holds this program to the golden model
          st.load(sc);
        },
      },
    },
    {
      title: 'One instruction set, many machines: System/360',
      body: `
        <p>On 7 April 1964 IBM announced System/360: six models behind one instruction set, with a performance range of a factor of 50 from the smallest to the largest.
        A program written for one ran on the others, so a customer who outgrew a machine bought the next model and kept the software. The models were not
        scaled copies of one design. They differed in <strong>data-path width</strong>: 8, 16, 32 and 64 bits on the Models 30, 40, 50 and 65 (the 65 came a year later, in place of two of the six announced), as David Patterson's history of the family tabulates them, and in price: a year's Model 65 rental was ${(IBM_RENT.m65 / IBM_RENT.m30).toFixed(1)} times as much as a Model 30's. The instruction set was a contract, and microcode was the translation from it to each machine.
        The In real silicon layer has the Model 30's 8-bit ALU, its control store and the rentals in dollars.</p>
        <p>The table runs the same experiment with our own hardware: RV32I built four ways, the same programs on each, every result checked against the golden model. All four
        have fast adders, so the periods compare. (The single-cycle period here differs from the earlier steps'; the Numbers layer says why.)
        <strong>Cost</strong> is NANDs without the program ROM; <strong>time</strong> is <span data-ahead="cpi">CPI (cycles per instruction)</span> × period.</p>
        <p>Read it for what it says about microcode. Making the controller microcoded adds ${sp(MICRO_NANDS - FSM_NANDS)} NANDs (the ROMs here are mux trees, as the previous steps said) and changes
        neither CPI nor period: ${sp(FAM[2].nands)} NANDs against ${sp(FAM[1].nands)} for the same speed. The whole family spans only ${SPREAD.cost.toFixed(2)}× in cost, but ${SPREAD.time.toFixed(1)}× in time per instruction, and
        the cheapest, the single-cycle CPU, is also the fastest. That is the opposite of System/360's trade, for two reasons. All four of ours keep the 32-bit register file, ALU and memory,
        which are most of the gates, so the controller cannot move the price much; System/360 varied the data path itself and let microcode hide the difference. And here memory answers in the cycle it is asked, so nothing makes
        the single-cycle machine wait; on a machine whose core memory takes microseconds, serial steps cost little extra.</p>
        <p>What a microcoded design buys is not speed or area at this scale but a table you can change: more instructions on the same data path, or a new instruction set on an old one.</p>`,
      widget: familyWidget,
      more: {
        derive: `<p>The control store is small too: ${MS.words} words of ${MS.bits} bits, ${MS.total} bits in all, against more than 200 000 bits in a Model 30.</p>
        <p>Per instruction, in NAND delays: ${FAM.map((r) => `${r.label.toLowerCase()} ${r.cpi.toFixed(2)} × ${r.period} = ${Math.round(r.delaysPerInstr)}`).join('; ')}. At ${RESULTS.psPerNand} ps a delay that is ${FAM.map((r) => r.nsPerInstr.toFixed(1)).join(', ')} ns. Means are geometric over ${PROGRAMS_USED}. Microcode store: ${MS.words} microwords × (14 control + 4 next + 2 mode) bits = ${MS.total} bits, plus two small dispatch ROMs indexed by the opcode.</p>`,
        numbers: `<p>The single-cycle period is ${FAM[0].period} in the table, not the ${SC_P} of the earlier steps: the benchmarks run with a ${RESULTS.imemWords}-word program ROM, one multiplexer level deeper than the chapter's.</p>`,
        pitfall: `<p>Reading this table as "microcode is slow". Both multicycle rows are slow because they take ${FAM[1].cpi.toFixed(1)} cycles an instruction on one shared ALU; the microcoded and hardwired controllers are identical in cycles. System/360 got its range from the data path; microcode only made one instruction set fit all of it.</p>`,
        real: `<p>A year's rental was ${groupDigits(IBM_RENT.m30)} for a Model 30 and ${groupDigits(IBM_RENT.m65)} for a Model 65 (1964 dollars). On the Model 30 an 8-bit
        ALU did a 32-bit addition in byte-sized steps, and the instruction set was what its microcode made of that small machine. The control store held about
        4 000 words of 50 to 60 bits (the sources differ; see below).</p>
        <p><strong>Sources for the IBM figures.</strong> Announcement 7 April 1964, six models, performance range factor 50: G. M. Amdahl, G. A. Blaauw, F. P. Brooks Jr., "Architecture of the IBM System/360", IBM Journal of Research and Development 8(2), 1964, p. 87 (abstract). Data-path widths 8 / 16 / 32 / 64 bits, control stores of 4K × 50 and 4K × 52 bits (Models 30, 40) and 2.75K × 85 and 2.75K × 87 (Models 50, 65), ROM cycles of 750, 625, 500 and 200 ns, and annual rentals of $48 000, $54 000, $115 000 and $270 000 in 1964 dollars: the table "Microprogramming in IBM 360" in D. Patterson's slides for the SOSP 2015 history session (sigops.org/sosp/sosp15/history/07-patterson-slides.pdf), a secondary source, read from the PDF. The Model 30's 8-bit data path: IBM Field Engineering Theory of Operation, via the Wikipedia article on the Model 30. That article, citing Weber's chapter, gives 4 032 words of 60 bits; the Model 40 article gives up to 8 192 words of 56 bits, half for the 1401 / 1410 compatibility feature. The sources disagree on word width and count, so the text says "about 4 000 words of 50 to 60 bits" and quotes no cycle times in the prose. Microprogram design for the family: S. G. Tucker, "Microprogram control for System/360", IBM Systems Journal 6(4), 1967, pp. 222-241.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'In our four RV32I machines, what does making the controller microcoded change?',
        options: ['Its cost in NANDs and nothing about <span data-ahead="cpi">CPI (cycles per instruction)</span> or period', 'The clock period, since a ROM is faster than logic', 'The CPI, since microcode can skip states', 'Nothing: the NAND count is the same'],
        answer: 0,
        why: ['', 'Both multicycle rows have the same period: the longest step is an ALU operation, whichever way the controller is built.', 'The book microprogram has exactly the state table\'s states, so every class takes the same cycles; only an edit such as the painter\'s changes that.', 'The microcoded CPU is larger by the difference in the two controllers\' gates, as the table shows.'],
        explain: 'The microcoded and hardwired machines run the same states in the same cycles at the same period. Only the NAND count differs. The benefit of microcode is that the table is data, so one data path can serve a different instruction set or an extended one, which is what System/360 relied on.',
      },
    },
    {
      title: 'Find it: a register that never holds',
      deep: true,
      body: `
        <p><em>Optional: a deep dive. Nothing later relies on it.</em></p>
        <p>The multicycle CPU with its hardwired state machine, running the sum loop, with one wire stuck at 0 or 1 somewhere. In this
        CPU values live in registers between the steps of an instruction, and every one of those registers loads only when the state
        machine says so: that is the place to look.</p>
        <p>Press <strong>Run to halt</strong> (or <strong>Step</strong>) in the CPU panel. After every cycle it compares the registers with the
        golden model, so it stops at the first instruction the hardware got wrong, and names the register, both values and the instruction.
        Read that line as a clue: which instruction, which register, which value instead of which. Then right-click the wire you suspect (on a touch screen, press and hold it) and
        choose <strong>It is stuck at 0 here</strong> or <strong>… at 1</strong> (a bus asks for the bit). A wrong guess costs nothing: the
        panel runs the same program with the fault you named instead and says where that one would first show, which is a clue too.</p>`,
      scene: FIND_MC.scene,
      challenge: FIND_MC.challenge,
    },
  ],
};
