import { MC_FSM, MC_MICRO, MC_STATES } from '../lib';
import { PROGRAMS } from '../riscv/programs';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';
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

export const chMulticycle: Chapter = {
  id: 'multicycle', num: 22, title: 'Multicycle & microcode', level: 'Processor',
  blurb: 'One ALU and one memory port reused over several short cycles, sequenced by a hardwired state machine or by microcode.',
  steps: [
    {
      title: 'Several short cycles',
      body: `
        <p>The single-cycle CPU gives every instruction the time of the slowest one, and needs three adders (ALU, PC + 4, branch target)
        plus separate instruction and data ports. The <strong>multicycle</strong> CPU splits each instruction into steps of one clock each:
        fetch, decode, execute, memory, write-back. Now <em>one</em> ALU computes PC + 4 in the fetch step, the branch target in decode and the
        operation in execute, and one memory port serves both fetches and loads.</p>
        <p>Values that cross a step boundary need registers: <strong>IR</strong> (the instruction), <strong>OldPC</strong>, <strong>A</strong> and
        <strong>B</strong> (the source registers), <strong>Data</strong> (a loaded word) and <strong>ALUOut</strong>. The datapath now does whatever the
        controller says, one step at a time.</p>
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
        <p>The classic implementation: a 4-bit state register, a 4→16 decoder giving one wire per state, an AND gate per opcode-dependent transition
        and OR gates. Each control signal is the OR of the states that assert it. Each next-state bit is the OR of the transitions whose target has that bit set.
        ${MC_STATES.length} states cost about 400 NANDs.</p>
        <div class="try">op = 0x03 is a load. Pulse through Fetch → Decode → MemAdr → MemRead → MemWB and back to Fetch.</div>`,
      scene: () => ({ root: MC_FSM, inputs: { op: 0x03, clk: 0 }, panels: [controllerPanel('fsm')] }),
      challenge: {
        kind: 'reach', goal: 'Drive the controller into the MemWrite state.',
        check: (st) => st.value('state') === 5,
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
        <p>Maurice Wilkes (1951): store the table instead of wiring it. A <strong>micro-PC</strong> addresses a ROM of <strong>microwords</strong>.
        Each word holds this cycle's control signals (14 bits), a next-address field (4) and a sequencing mode (2): take the next-address field,
        or <em>dispatch</em> through a small ROM indexed by the opcode.</p>
        <p>IBM's System/360 (1964) used microcode to run one instruction set on machines of very different cost. x86 processors still execute
        their rarest, most complex instructions from a microcode ROM, and patch hardware bugs with microcode updates loaded at boot.</p>
        <div class="try">Same inputs as before. The panel shows the microwords: sequencing | next | control.</div>`,
      scene: () => ({ root: MC_MICRO, inputs: { op: 0x03, clk: 0 }, panels: [controllerPanel('micro')] }),
      challenge: {
        kind: 'quiz', question: 'The microcode and FSM controllers are generated from the same table. How do we know they behave identically?',
        options: [
          'We assume it',
          'Both run in lock-step for 3 000 cycles of random instructions with every output compared, and both full CPUs are co-simulated against the golden model',
          'The microcode is faster',
          'They have the same gate count',
        ],
        answer: 1,
        explain: 'tests/multicycle.test.ts drives both controllers with the same opcode sequence, reaching all 13 states, and compares every control signal every cycle. Then each full CPU runs every sample program against the ISS. Equivalence checking of two implementations is a daily job in industry, usually done formally.',
      },
    },
    {
      title: 'Same CPU, microprogrammed',
      body: `
        <p>Swap the controller and nothing else changes: same cycles, same results. The cost does change. The FSM takes about 400 NANDs. The microcode
        controller takes about 6 100, because our ROMs are multiplexer trees of constants (a real ROM is a dense transistor array). Microcode pays off when the
        table is large and irregular, as with complex instruction sets, or when it has to be changeable.</p>`,
      scene: () => cpuScene({ source: src('sum'), multicycle: 'micro', highlight: ['ctrl'] }),
    },
    {
      title: 'Was it worth it?',
      body: `
        <p>Measured with the timing panel: the clock period drops from 103 to <strong>85</strong> NAND delays. The longest step is still a full ALU
        operation followed by the branch decision. But the CPI is now about <strong>3.8</strong>, so each instruction takes ~320 delays instead of 103.
        The gate count does not even go down: six 32-bit registers (about 2 900 NANDs) cost more than the two adders they replace.</p>
        <p>Multicycle machines made sense when memory was the expensive, slow part and logic was scarce. Their lasting legacy is the controller,
        and the idea of overlapping the steps instead of serialising them: the pipeline of chapter 16.</p>`,
      scene: () => cpuScene({ source: src('gcd'), multicycle: 'fsm', timing: true }),
      challenge: {
        kind: 'quiz', question: 'The steps are unbalanced: the ALU step needs 85 delays, the others much less. What would make the multicycle CPU competitive?',
        options: ['A faster controller', 'Balancing the steps (e.g. splitting the ALU step) and overlapping consecutive instructions', 'More microcode', 'A bigger register file'],
        answer: 1,
        explain: 'Time per instruction = CPI × period. With CPI near 4, only a much shorter period helps, which needs balanced steps. Overlapping the steps of consecutive instructions brings CPI back toward 1: that is pipelining.',
      },
    },
  ],
};
