import facts from '../bench/ucodefacts.json';
import { MC_FSM, MC_MICRO, MC_STATES } from '../lib';
import { bookProgram, cyclesByClass, iTypeInThree, type Microprogram } from '../lib/ucode';
import { PROGRAMS } from '../riscv/programs';
import { h } from '../ui/dom';
import type { Scene, Stage, Widget } from '../view/stage';
import { controllerPanel, cpuScene } from '../widgets/cpupanel';
import type { Chapter } from './types';

const src = (id: string) => PROGRAMS.find((p) => p.id === id)!.source;

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
  id: 'multicycle', num: 23, title: 'Multicycle & microcode', level: 'Processor',
  blurb: 'One ALU and one memory port reused over several short cycles, sequenced by a hardwired state machine or by microcode.',
  goals: [
    'split instructions into steps that share one ALU and one memory port, with registers across the step boundaries',
    'read the state table and count each instruction class\'s cycles (3, 4 or 5)',
    'build the controller as a hardwired state machine or as microcode, and price both',
    'decide from CPI × period whether the multicycle CPU beats the single-cycle one',
  ],
  builds: ['registers', 'cpu'],
  recap: {
    keep: [
      'One ALU computes PC + 4 (fetch), the branch target (decode) and the operation (execute); one memory port serves fetches and loads. IR, OldPC, A, B, Data and ALUOut carry values across steps.',
      '13 states. Branch, lui and auipc take 3 cycles; ALU operations, stores and jal 4; loads and jalr 5.',
      'Hardwired control: a 4-bit state register, a 4→16 decoder, an AND gate per opcode-dependent transition and OR gates per signal: 412 NANDs.',
      'Microcode: a µPC addresses a ROM of microwords (14 control bits, a 4-bit next address, a 2-bit sequencing mode), with dispatch ROMs indexed by the opcode: 6 124 NANDs here, because these ROMs are mux trees of constants.',
      'The microcode is a grid of cells you can paint: an I-type instruction written back in ExecuteI takes 3 cycles instead of 4, and the painter checks any edit against the golden model.',
      'Period 85 NAND delays against the single-cycle CPU\'s 103 (both with Kogge–Stone adders), but CPI 3.6 to 4.0 on the sample programs: about 300 to 340 delays per instruction.',
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
        question: 'Here microcode costs 6 124 NANDs against 412 for the hardwired FSM. When is microcode worth it?',
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
        <div class="try">Pulse the clock and follow the controller panel: an add takes Fetch, Decode, ExecuteR, ALUWB.</div>`,
      scene: () => cpuScene({ source: src('sum'), multicycle: 'fsm', highlight: ['ctrl'] }),
    },
    {
      title: 'The state table',
      body: `
        <p>Everything about sequencing is in one table: per state, which control signals are on and which state comes next. Decode branches on the
        opcode class; MemAdr on load versus store. Instructions take 3 (branch, lui, auipc), 4 (ALU ops, stores, jal) or 5 cycles (loads, jalr).</p>
        <p>Two tricks keep it short. Decode computes OldPC + imm "just in case": that is the branch target, the jal target and the auipc result, so
        auipc goes straight to write-back. And jalr reuses the JAL state once it has put its target in ALUOut.</p>`,
      widget: stateTable,
    },
    {
      title: 'Hardwired control',
      body: `
        <p>The classic implementation: a <span data-show="st">4-bit state register</span>, a <span data-show="dec">4→16 decoder</span>
        giving one wire per state, <span data-show="t1 t2 t3 t4 t5 t6 t7 t8 t9 t10 t11">an AND gate per opcode-dependent transition</span>
        and OR gates. Each control signal is the OR of the states that assert it. Each next-state bit is
        <span data-show="n0 n1 n2 n3">the OR of the transitions</span> whose target has that bit set.
        ${MC_STATES.length} states cost about 400 NANDs.</p>
        <div class="try">op = 0x03 is a load. Pulse through Fetch → Decode → MemAdr → MemRead → MemWB and back to Fetch.</div>`,
      scene: () => ({ root: MC_FSM, inputs: { op: 0x03, clk: 0 }, panels: [controllerPanel('fsm')] }),
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
        <div class="try">Same inputs as before. The panel shows the microwords: sequencing | next | control.</div>`,
      scene: () => ({ root: MC_MICRO, inputs: { op: 0x03, clk: 0 }, panels: [controllerPanel('micro')] }),
      challenge: {
        kind: 'quiz', question: 'The microcode and FSM controllers are generated from the same table. How do we know they behave identically?',
        options: [
          'We assume it',
          'Both run in lock-step for 3 000 cycles of random instructions with every output compared, and both full CPUs are co-simulated against the instruction-set simulator',
          'The microcode is faster',
          'They have the same gate count',
        ],
        answer: 1,
        why: ['An assumption is not evidence: two implementations of one table can still differ by a wiring mistake.', '', 'Speed says nothing about behaviour, and both run at the same period here.', 'Equal cost would prove nothing, and they are far apart: about 400 NANDs against 6 100.'],
        explain: 'The site\'s tests drive both controllers with the same opcode sequence, reaching all 13 states, and compare every control signal every cycle. Then each full CPU runs every sample program against the instruction-set simulator. Equivalence checking of two implementations is a daily job in industry, usually done formally.',
      },
    },
    {
      title: 'Same CPU, microprogrammed',
      body: `
        <p>Swap the <span data-show="ctrl">controller</span> and nothing else changes: same cycles, same results. The cost does change. The FSM takes about 400 NANDs. The microcode
        controller takes about 6 100, because our ROMs are multiplexer trees of constants (a real ROM is a dense transistor array). Microcode pays off when the
        table is large and irregular, as with complex instruction sets, or when it has to be changeable.</p>`,
      scene: () => cpuScene({ source: src('sum'), multicycle: 'micro', highlight: ['ctrl'] }),
    },
    {
      title: 'Was it worth it?',
      body: `
        <p>Measured with the timing panel: the clock period drops from 103 to <strong>85</strong> NAND delays. The longest step is still a full
        <span data-show="alu">ALU</span> operation followed by the <span data-show="npc">branch decision</span>. But the CPI is now <strong>3.6 to 4.0</strong> on the sample programs (this gcd: 51 instructions in 182 cycles, 3.57),
        so each instruction takes 300 to 340 delays instead of 103.
        The gate count does not even go down: <span data-show="ir oldpc ra rb data aluout">six 32-bit registers</span> (about 2 900 NANDs) cost more than the two adders they replace.</p>
        <p>Multicycle machines made sense when memory was the expensive, slow part and logic was scarce. Their lasting legacy is the controller,
        and the idea of overlapping the steps instead of serialising them: the pipeline of <a href="#/c/pipeline/0">chapter 17</a>.</p>`,
      scene: () => cpuScene({ source: src('gcd'), multicycle: 'fsm', timing: true }),
      challenge: {
        kind: 'quiz', question: 'The steps are unbalanced: the ALU step needs 85 delays, the others much less. What would make the multicycle CPU competitive?',
        options: ['A faster controller', 'Balancing the steps (e.g. splitting the ALU step) and overlapping consecutive instructions', 'More microcode', 'A bigger register file'],
        answer: 1,
        why: ['The longest step is the ALU operation and the branch decision, and CPI stays near 4 with any controller.', '', 'Microcode changes how the table is stored, not how long a step takes or how many steps there are.', 'A bigger register file sets neither the longest step nor the number of steps.'],
        explain: 'Time per instruction = CPI × period. With CPI near 4, only a much shorter period helps, which needs balanced steps. Overlapping the steps of consecutive instructions brings CPI back toward 1: that is pipelining.',
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
        numbers: `Book: CPI ${facts.bookCpi.toFixed(2)} on the four benchmarks (${facts.instructions.toLocaleString('en').replace(/,/g, ' ')} instructions). I-type instructions are ${pct(facts.iShare)} % of them, so one cycle fewer each
          lowers the CPI by ${pct(facts.iShare)} / 100 = ${(facts.bookCpi - facts.solvedCpi).toFixed(2)}, to ${facts.solvedCpi.toFixed(2)}.`,
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
          An I-type instruction is now Fetch, Decode, ExecuteI: ${facts.solvedCycles.I} cycles. All ${facts.tests} riscv-tests pass, the CPI goes from ${facts.bookCpi.toFixed(2)} to ${facts.solvedCpi.toFixed(2)}, and the controller is the same size.`,
        solve: (st) => {
          painted = iTypeInThree();
          const sc = ucodeScene();
          verified.add(sc.root.id); // tests/ucode.test.ts holds this program to the golden model
          st.load(sc);
        },
      },
    },
  ],
};
