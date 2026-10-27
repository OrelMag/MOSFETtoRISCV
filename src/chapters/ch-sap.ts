// Appendix C: Ben Eater's 8-bit breadboard computer, itself SAP-1 from Malvino and Brown's Digital Computer
// Electronics, built from 74xx chips that are built from our gates (lib/ttl.ts, lib/sap.ts; docs/SAP.md). Every scene
// is the gate-level machine; the computer's scenes open on its breadboards (widgets/saplayout.ts) with the SAP panel
// following the golden model at every clock edge (widgets/sap.ts).

import { RESULTS } from '../bench/summary';
import { sapBytes } from '../sap/asm';
import { SapISS } from '../sap/iss';
import { SAP_PROGRAMS } from '../sap/programs';
import { SwitchSim } from '../sim/switchsim';
import type { Stage } from '../view/stage';
import { sapAluScene, sapAregScene, sapClockScene, sapPcScene, sapScene, tristateScene } from '../widgets/sap';
import { microTable, sapHw, sapRam } from '../widgets/sapmon';
import { chAppendixDoom } from './ch-doom';
import type { Chapter } from './types';

/**
 * What the SAP-1 costs (lib/sap.ts sapCost; tests/sap-appendix.test.ts holds these to it): chips simulated (the boards
 * add seven drawn only: four 555s, the clock's 74LS32, the 76 and the 139), NANDs of logic, NANDs of one 28C16 as the ROM tree it simulates
 * as, and the five EEPROMs' bits.
 */
export const SAP_COST = {
  chips: 49, drawn: 7, logic: 3314, perEeprom: 65524, eeproms: 5, bus: 122, control: 204,
  /** NANDs of single modules (stats), as the steps quote them. */
  clock: 14, areg: 243, alu: 129, pc: 150, ram: 1546, ls173: 109, ls161: 125, ls189: 716,
} as const;
const RV32I = RESULTS.cpus.find((c) => c.id === 'sc')!;
const k = (n: number) => n.toLocaleString('en-US');

/** Set inputs without the stage's propagation animation (a solve must not race its own animation). */
function poke(st: Stage, v: Record<string, number>): void {
  const sim = st.sim;
  if (!sim) return;
  st.checkpoint();
  for (const [n, x] of Object.entries(v)) sim.setInput(n, x);
  sim.settle();
  st.refresh();
}

/** Key bytes into the RAM from address 0 by the switches (PROG, address, data, WR), then RESET, as Ben programs his. */
function program(st: Stage, bytes: readonly number[]): void {
  poke(st, { prog: 1 });
  bytes.forEach((v, i) => { poke(st, { addrSw: i, dataSw: v }); poke(st, { write: 1 }); poke(st, { write: 0 }); });
  poke(st, { prog: 0, addrSw: 0, dataSw: 0 });
  poke(st, { RESET: 1 }); // PC 0, step T0, IR NOP: the program starts from the top
  poke(st, { RESET: 0 });
}

/** The computer's state, or null on any other scene. */
const hw = (st: Stage) => {
  try {
    return st.sim && st.scene?.root.id.startsWith('sap1') ? sapHw(st.sim) : null;
  } catch {
    return null;
  }
};
const halted = (st: Stage) => (hw(st)?.cw ?? 0) >> 15 === 1;

/** Fibonacci's size and clock cycles to HLT (the golden model). */
const FIB = (() => {
  const bytes = sapBytes(SAP_PROGRAMS.find((p) => p.id === 'fib')!.src), m = new SapISS(bytes);
  m.run();
  return { bytes: bytes.length, cycles: m.cycles };
})();

const HAND = [0x57, 0xe0, 0xf0]; // LDI 7, OUT, HLT
const HUNDRED = `; LDI holds 0–15: 100 is in RAM
        LDA x
        ADD y
        OUT
        HLT
x:      .byte 64
y:      .byte 36`;

export const chAppendixSap: Chapter = {
  // after Appendix B, whatever the journey's length
  id: 'appendix-sap', num: chAppendixDoom.num + 1, appendix: 'C', title: 'The breadboard computer (SAP-1)', level: '74xx TTL',
  blurb: 'Ben Eater\'s 8-bit computer on breadboards: 16 bytes, one bus, microcode in two EEPROMs, every chip opened down to its NANDs.',
  goals: [
    'trace an instruction through five clock steps: which board drives the bus and which loads it at each',
    'read a 74LS173, a 74LS245 and a 74LS161 from their pins, and say why a bus needs exactly one driver',
    'program the computer by its switches and run it, in step with a golden model',
    'say what SAP-1 costs in chips and gates, and what it gives up against our RV32I',
  ],
  builds: ['registers', 'alu', 'cpu', 'multicycle'],
  recap: {
    keep: [
      'SAP-1 is one 8-bit bus and boards that either drive it (…O) or load from it (…I). The microcode keeps it to one driver at a time; nothing in the wiring does.',
      'Every instruction takes five steps: T0 <code>MI CO</code> and T1 <code>RO II CE</code> fetch, T2–T4 execute. The control word changes on the falling edge, registers load on the rising one.',
      'The control unit is a 74LS161 step counter and two 28C16 EEPROMs addressed by [ZF CF][opcode][step]: changing the ISA is reprogramming two chips, not rewiring.',
      `Without the EEPROMs it is ${k(SAP_COST.logic)} NANDs (${SAP_COST.chips} chips); our single-cycle RV32I is ${k(RV32I.nands)}. SAP-1 buys that with 16 bytes, an 8-bit adder, no registers beyond A and B, and five clocks an instruction.`,
      'The inspector counts the EEPROMs apart, as 5 × 2 KB of ROM: simulated, each is a mux tree of 65 524 NANDs; on silicon it is a transistor per bit and two decoders.',
    ],
    practise: ['s_reg4', 's_cnt4', 'a_addsub16', 'c_ctl', 'o_mc'],
    check: [
      {
        question: 'During T1 of every instruction the lines <code>RO II CE</code> are on. What happens at the rising edge?',
        options: ['The IR takes RAM[MAR] and the PC counts', 'The MAR takes the PC', 'RAM[MAR] takes the bus', 'The PC loads the bus'],
        answer: 0,
        explain: 'RO puts RAM[MAR] on the bus, II loads it into the instruction register, CE lets the 161 count. MAR still holds the address T0 put there.',
        why: ['', 'That is T0: MI CO. In T1 the PC does not drive the bus.', 'That would need RI; RO reads the RAM onto the bus.', 'Loading the PC from the bus is J (a jump). CE counts without touching the bus.'],
      },
      {
        question: 'A programmer adds an instruction <code>LDB a</code> (B ← RAM[a]). What must change in the hardware?',
        options: ['Only the two microcode EEPROMs: T2 MI IO, T3 RO BI', 'A new decoder for the opcode', 'A wire from the RAM to B', 'A sixth step in the counter'],
        answer: 0,
        explain: 'Every data path it needs exists: the operand onto the bus (IO) into the MAR (MI), then RAM onto the bus (RO) into B (BI). A free opcode (9–D) gets those words at its addresses in the EEPROMs.',
        why: ['', 'The EEPROMs are the decoder: the opcode is part of their address.', 'B already loads from the bus, and the RAM already drives it.', 'Two execute steps are enough; the counter already runs to T4.'],
      },
      {
        question: 'What does SAP-1\'s bus do if the microcode turns on <code>AO</code> and <code>RO</code> in the same step?',
        options: ['Two 74LS245s drive the same wires: where they disagree, an output stage shorts the supply to ground', 'The bus takes the OR of the two values, harmlessly', 'The second driver waits for the first', 'The bus floats'],
        answer: 0,
        explain: 'A 3-state output that is enabled drives hard. Two of them disagreeing on a wire is a short through both output stages: the value is neither, and the chips heat up. Our gate-level bus ORs them as a stand-in and raises <code>clash</code>.',
        why: ['', 'That is this site\'s gate-level stand-in, not the real bus: the real one has no OR gate, only wires.', 'There is no arbitration: whatever is enabled drives at once.', 'A floating bus is the case with no driver at all; then the pull-downs hold it at 0.'],
      },
    ],
  },
  steps: [
    {
      title: 'The machine and its bus',
      body: `
        <p>In 2016–17 Ben Eater built an 8-bit computer on breadboards, on video, one module at a time, from
        the design Albert Malvino and Jerald Brown call SAP-1 (<em>Simple As Possible</em>) in <em>Digital Computer
        Electronics</em>. Many have built it since from his kits. Here it is again, module for module, each chip built
        from our gates: open any of them and keep going down to MOSFETs. Our boards add a 74LS04 wherever an active-high
        control line meets an active-low pin, and the RAM board a 74LS08 and a third 74LS157 for its write.</p>
        <p>Everything meets on one 8-bit <span data-show="bus">bus</span>. A board either <em>drives</em> it (a line
        ending in O: the <span data-show="pc">program counter</span>, the <span data-show="ram">RAM</span>, the
        <span data-show="ir">instruction register</span>'s operand, <span data-show="a">A</span>, the
        <span data-show="alu">ALU</span>'s sum) or <em>loads</em> from it at the next rising edge (a line ending in I:
        the <span data-show="mar">memory address register</span>, the RAM, the IR, A, <span data-show="b">B</span>,
        <span data-show="out">OUT</span>). The <span data-show="ctl">control unit</span> turns those lines on, sixteen
        of them, a new set at every step.</p>
        <p>Cost: ${SAP_COST.chips} chips simulated (and ${SAP_COST.drawn} drawn only), ${k(SAP_COST.logic)} NANDs of logic
        and five EEPROMs, 5 × 2 KB of ROM (the inspector's count). The program is "add two numbers" from RAM.</p>
        <div class="try">Look first: before any Pulse the computer is in T0, the program counter's board drives the bus
        (amber) and the memory address register will load from it (blue) at the rising edge. Pulse once: now it is T1, the
        RAM drives and the instruction register loads.</div>`,
      scene: () => sapScene({ program: 'add', highlight: ['bus'] }),
      tries: [(st) => (hw(st)?.step ?? 0) >= 1 || st.cycles >= 1],
      challenge: {
        kind: 'quiz',
        question: 'The second clock step of every instruction (T1) has <code>RO II CE</code> on. Which board drives the bus?',
        options: ['The RAM', 'The program counter', 'The instruction register', 'Nobody'],
        answer: 0,
        explain: 'RO (RAM out) enables the RAM board\'s 74LS245: RAM[MAR] goes onto the bus, and II loads it into the instruction register at the edge.',
        why: ['', 'The PC drove it in T0 (CO). CE only lets it count; counting does not use the bus.', 'II loads the IR; IO would make it drive.', 'RO is on: the RAM drives.'],
      },
    },
    {
      title: 'The clock',
      body: `
        <p>Ben's clock board has three 555 timers: an astable (the free-running clock, its rate on a potentiometer), a
        monostable (one clean pulse per press of the step button) and a bistable (debouncing the run / step switch), and a
        74LS32 that chooses between them: (astable AND run) OR (monostable AND step), its ANDs and inverter in spare gates of
        the 08 and 04. The 555s and the select are <strong>drawn, not simulated</strong> (the 555s are analog parts); the
        stage's clock, <code>osc</code>, stands in for whichever is chosen.</p>
        <p>What is simulated is the gating: <code>clk</code> = osc AND NOT HLT, a <span data-show="inv">74LS04</span>
        and a <span data-show="and">74LS08</span>, ${SAP_COST.clock} NANDs. A halted computer stops its own clock. The second
        inverter makes <code>nclk</code>, which steps the control unit on the falling edge (see Microcode).</p>
        <div class="try">Turn on <code>HLT</code> and Pulse: <code>clk</code> stays dark, so no register anywhere sees
        an edge.</div>`,
      scene: sapClockScene,
      tries: [(st) => st.getInput('hlt') === 1 && st.cycles > 0],
      challenge: {
        kind: 'quiz',
        question: 'The program reaches <code>HLT</code>. Why does the computer then stay exactly as it is?',
        options: [
          'HLT gates the clock: no edge reaches the step counter, so the control word, with HLT on, never changes',
          'HLT clears every register',
          'HLT makes the PC load its own value forever',
          'The EEPROMs stop driving their outputs',
        ],
        answer: 0,
        explain: 'HLT\'s control word (T2 of opcode F) holds HLT = 1, which turns clk off; without clk and nclk the step counter cannot move off T2, so HLT stays on. The only way out is RESET: it clears the IR, so the control word is a fetch again.',
        why: ['', 'Nothing clears: the registers keep their values, which is how OUT stays on the display.', 'The PC needs an edge to load anything, and there is none.', 'They keep driving the HLT word; that is what holds the clock off.'],
      },
    },
    {
      title: 'Registers and the bus',
      body: `
        <p>The A register, alone on a board as Ben tests each one. Two <span data-show="lo hi">74LS173s</span> each hold 4
        bits: D flip-flops that load at the rising edge while both enables G1 and G2 are low. A
        <span data-show="drv">74LS245</span> puts the value on the bus while its G is low. The microcode's lines are active
        high, so the board has a <span data-show="inv">74LS04</span> for AI and AO. ${SAP_COST.areg} NANDs: each 173 is ${SAP_COST.ls173}, four
        flip-flops with load muxes and output gating.</p>
        <p>The real 74LS chips are bipolar TTL (low-power Schottky): open one here and you find our CMOS NANDs, the same
        logic, not the same electrical behaviour (input current, output drive, 5 V thresholds).</p>
        <p>The 245 has <em>3-state</em> outputs: disabled, it lets go of the wire. A gate-level simulation has 0, 1 and X
        but no "let go", so here a disabled 245 reads 0 and the computer's bus is the OR of its drivers. That is a
        stand-in. The next step shows the real thing.</p>
        <div class="try">Set the bus switches to a value, turn AI on and Pulse: the LEDs take it. Turn AO on: <code>drv</code>
        shows it, as the bus would.</div>`,
      scene: sapAregScene,
      tries: [(st) => st.cycles > 0 && st.value('q') === st.getInput('bus')],
      challenge: {
        kind: 'reach',
        goal: 'Load 0x5A (0101 1010) into the A register, then change the bus switches to something else.',
        check: (st) => st.value('q') === 0x5a && st.getInput('bus') !== 0x5a,
        hints: ['A 173 loads only at a rising clock edge, and only while its enables are on.', 'bus = 0x5A, AI = 1, Pulse; then AI = 0 before you touch the bus again.'],
        answer: 'Set the bus switches to 0x5A, turn AI on, Pulse, turn AI off, change the switches: A keeps 0x5A.',
        solve: (st) => { poke(st, { bus: 0x5a, ai: 1 }); st.pulse(); poke(st, { ai: 0, bus: 0 }); },
      },
    },
    {
      title: 'What a bus really is',
      body: `
        <p>Three <span data-show="u0 u1 u2">tri-state buffers</span> (8 transistors each) on one wire, with a
        <span data-show="pd">pull-down</span> resistor, at switch level: the bus as the 245s make it. A disabled buffer
        has both its output transistors off, so it neither pulls up nor down. One enabled buffer sets the line; none leaves
        it to the pull-down, a weak 0 (the computer's bus has a pull-down on every bit for this).</p>
        <p>Enable two that disagree and one pulls the line to VDD while the other pulls it to GND: a short, current
        straight through both output stages, the line at neither value. On the board it costs heat and a sagging supply;
        in a chip, burnt metal. Nothing in SAP-1's wiring prevents it: the microcode does, by never turning on two O
        lines at once. The computer's gate-level bus reports the same mistake on its <code>clash</code> output.</p>
        <div class="try">Enable a second driver with a different value: the panel names the short and the path it takes.</div>`,
      scene: tristateScene,
      tries: [(st) => st.sim instanceof SwitchSim && st.sim.hasShort],
      challenge: {
        kind: 'reach',
        goal: 'Make the line short: two drivers enabled with different values.',
        check: (st) => st.sim instanceof SwitchSim && st.sim.hasShort,
        hints: ['Driver 0 is enabled with d0 = 1.', 'Turn on en1 with d1 = 0.'],
        answer: 'en1 = 1 with d1 = 0 (driver 0 is already on with d0 = 1): VDD through driver 0\'s PMOS, GND through driver 1\'s NMOS.',
        solve: (st) => poke(st, { en1: 1, d1: 0 }),
      },
    },
    {
      title: 'The ALU',
      body: `
        <p>Two <span data-show="add0 add1">74LS283</span> 4-bit adders, the first one's carry into the second (a ripple
        between the chips; inside each the 283 looks ahead), add A and B. For SUB, <span data-show="x0 x1">74LS86</span>
        XORs invert B and SU is the carry in: A − B = A + NOT B + 1. A <span data-show="drv">74LS245</span> puts the sum
        on the bus while ΣO = 1. ${SAP_COST.alu} NANDs; it has no clock, the sum is always there.</p>
        <p>On the computer the sum also feeds the flags register (a 74LS173 loaded by FI): CF is the carry out of bit 7,
        ZF is the sum being 0 (74LS02 NORs and 74LS08 ANDs). For a subtraction CF = 1 means <em>no</em> borrow: A ≥ B.</p>
        <div class="try">Turn SU on: the sum becomes 28 − 14 = 14 and <code>cout</code> lights (no borrow).</div>`,
      scene: sapAluScene,
      tries: [(st) => st.getInput('su') === 1 && st.value('cout') === 1],
      challenge: {
        kind: 'quiz',
        question: 'A = 5, B = 7, SU = 1. What do the sum and the carry show?',
        options: ['sum = 254 (0xFE), carry = 0', 'sum = 2, carry = 1', 'sum = 254, carry = 1', 'sum = 12, carry = 0'],
        answer: 0,
        explain: '5 + NOT 7 + 1 = 5 + 248 + 1 = 254: −2 in two\'s complement, and nothing carries out of bit 7. Carry 0 is the borrow: A < B.',
        why: ['', 'That is 7 − 5. The order is A − B.', 'The carry is 1 only when A ≥ B; 5 < 7.', 'That is A + B: SU = 1 subtracts.'],
      },
    },
    {
      title: 'RAM and the memory address register',
      body: `
        <p>The <span data-show="mar">memory address register</span> is one 74LS173: the RAM's address. A 74LS157 hands
        the RAM the four address switches instead while PROG is on. The <span data-show="ram">RAM</span> is two 74LS189s,
        16 × 4 bits each; their outputs are inverted, so two 74LS04s turn them back, two 157s choose what to write (the
        bus, or the eight data switches), and a 245 drives the bus. Nine chips and ${k(SAP_COST.ram)} NANDs for 128 bits: the 189's
        cells are latches, ${SAP_COST.ls189} NANDs a chip.</p>
        <p>Ben's 189 writes while WE is low, from an RC pulse on the clock edge. Here the write is RI AND CLK, so it happens
        while the clock is high: at the rising edge, in effect, which is when the golden model writes.</p>
        <p>This RAM starts empty. Program it as Ben does, whenever you like (running or not): PROG on, an address on the
        four switches, a byte on the eight, press WR; next address. PROG off, then RESET on the clock board: it clears the
        PC, the step counter, A, B, the IR and the flags (the chips' CLR pins), but not the RAM, so the program starts from
        address 0. The panel's model pauses while PROG is on and takes the RAM from the hardware after. The bar's
        <em>Power cycle</em> is not RESET: it switches the computer off and on, and the 189s forget what you keyed in, as
        real SRAM would.</p>`,
      scene: () => sapScene({ empty: true, highlight: ['mar', 'ram'], fixed: true }),
      challenge: {
        kind: 'reach',
        goal: 'By the switches, put LDI 7 (0x57) at address 0, OUT (0xE0) at 1, HLT (0xF0) at 2; PROG off, RESET, run until it shows 7.',
        check: (st) => {
          const sim = st.sim, h = hw(st);
          if (!sim || !h) return false;
          const ram = sapRam(sim);
          return HAND.every((v, i) => ram[i] === v) && h.out === 7;
        },
        hints: [
          'PROG on first: the RAM then takes its address from the four switches and its data from the eight.',
          'Each byte: address switches, data switches, then WR on and off. 0x57 is 0101 0111.',
          'PROG off, RESET on and off (the PC back to 0, the step to T0), then Run (or Run to HLT in the panel).',
        ],
        answer: 'PROG = 1; address 0000, data 0101 0111, WR on/off; address 0001, data 1110 0000, WR; address 0010, data 1111 0000, WR; PROG = 0; RESET on and off; Run to HLT. OUT shows 7.',
        solve: (st) => { program(st, HAND); st.runCycles(40, () => halted(st)); },
      },
    },
    {
      title: 'The program counter',
      body: `
        <p>One <span data-show="cnt">74LS161</span>, a 4-bit synchronous counter: at the rising edge it counts while CE is
        on (both its enables, ENP and ENT, are CE), or loads the bus's low nibble while LOAD is low (J, through the
        <span data-show="inv">74LS04</span>; a load wins over counting). A <span data-show="drv">74LS245</span> puts the
        count on the bus while CO = 1. ${SAP_COST.pc} NANDs, ${SAP_COST.ls161} of them the 161.</p>
        <p>Four bits address all 16 bytes, so the count wraps from 15 to 0. A jump is nothing but J: the operand goes on
        the bus (IO) and the 161 loads it.</p>
        <div class="try">CE is on: Pulse a few times and watch the count.</div>`,
      scene: sapPcScene,
      tries: [(st) => st.cycles > 0 && st.value('pc') > 0],
      challenge: {
        kind: 'reach',
        goal: 'Make the program counter jump to 9.',
        check: (st) => st.value('pc') === 9,
        hints: ['A jump loads the counter from the bus.', 'bus = 9, J = 1, Pulse.'],
        answer: 'Set the bus switches to 9 (0000 1001), J on, Pulse: the 161 loads 9 instead of counting.',
        solve: (st) => { poke(st, { bus: 9, j: 1 }); st.pulse(); poke(st, { j: 0 }); },
      },
    },
    {
      title: 'Output',
      body: `
        <p>The <span data-show="out">output register</span> is a 74LS273, eight flip-flops with no load enable, so Ben
        clocks it with CLK AND OI. Gating a clock is usually a mistake (a glitch on the enable becomes an edge); here it is
        safe because OI changes only on the falling edge, while CLK is low, so the AND's output moves only with CLK.</p>
        <p>The <span data-show="disp">display</span> turns the byte into decimal with a 28C16 EEPROM holding, for every
        value and digit, that digit's segments. Ben uses one EEPROM for all four digits: a 555 clocks a 74LS76 counter, a
        74LS139 lights one digit at a time, faster than the eye follows. We draw those chips but simulate three static
        copies of the EEPROM instead (no second clock to step), which is why the board shows three 28C16s. Ben's fourth
        digit is the sign, for his two's-complement mode; we show OUT unsigned (0–255), where it is always blank, so it is
        left out.</p>
        <p>The program counts up by 15 until the adder carries out of bit 7.</p>`,
      scene: () => sapScene({ program: 'countup', highlight: ['out', 'disp'], autoClock: true }),
      challenge: {
        kind: 'quiz',
        question: 'Why does a decimal display need a ROM (or a lot of logic) when a hex display needs four bits per digit?',
        options: [
          'Each decimal digit depends on all 8 bits (a value / 10<sup>d</sup> mod 10), not on a nibble of them',
          'Decimal digits need more segments',
          'The 273 stores values in decimal',
          'A hex display needs a ROM too, of the same size',
        ],
        answer: 0,
        explain: 'Hex digit d is bits 4d…4d + 3 alone. A decimal digit is a function of the whole byte, so the simplest circuit is a table with the byte (and the digit number) as its address.',
        why: ['', 'Both use the same seven segments.', 'The 273 holds a binary byte; the display decodes it.', 'A hex digit\'s segments depend on four bits: a 16-entry table, or a few gates per segment.'],
      },
    },
    {
      title: 'Microcode',
      body: `
        <p>The <span data-show="ctl">control unit</span>: a 74LS161 counts the steps on <code>nclk</code>, the falling
        edge, so the control word changes while the clock is low and is steady by the next rising edge; a 74LS138 decodes
        the count, and its Y5 clears the 161 at once (five steps, T0–T4). Two 28C16 EEPROMs, addressed by
        [ZF CF][opcode][step], hold the control word: high byte HLT … AO, low byte ΣO … FI (Ben programs both with one
        image and ties A7 differently on each chip to pick its byte, 10 address bits; ours hold one byte each, 9 bits).
        Every instruction starts with
        the same fetch, T0 <code>MI CO</code> and T1 <code>RO II CE</code>. ADD:</p>
        ${microTable(2)}
        <p>Our microcode is active high throughout: a line is 1 when it acts. Where a chip's pin wants a low (the 173's G1
        and G2, the 245's G, the 161's LOAD, the 189's WE), the module's own board has a 74LS04 to invert it.</p>
        <p>Cost: without the EEPROMs the control unit is ${SAP_COST.control} NANDs. The EEPROMs are counted as ROM, 2 KB each; the
        simulation runs each as a mux tree of ${k(SAP_COST.perEeprom)} NANDs, which says more about a mux than about a ROM: on silicon a
        2K × 8 ROM is an array of 16 384 cells (a transistor or two each) plus its decoders. Only 512 of its 2 048 addresses are used.</p>
        <div class="try">Pulse to T4 of the ADD (the panel's step table follows): ΣO, AI and FI are lit, and the ALU drives the bus.</div>`,
      scene: () => sapScene({ program: 'add', highlight: ['ctl'] }),
      tries: [(st) => { const h = hw(st); return !!h && h.ir >> 4 === 2 && h.step === 4; }],
      challenge: {
        kind: 'quiz',
        question: 'Which control word does the EEPROM pair hold at address [ZF 0][CF 0][opcode 0011][step 011]?',
        options: ['<code>RO BI</code>: SUB\'s T3', '<code>MI IO</code>', '<code>AI ΣO SU FI</code>', '<code>RO II CE</code>'],
        answer: 0,
        explain: 'Opcode 3 is SUB; step 3 is its second execute step: B ← RAM[MAR]. The subtraction itself (AI ΣO SU FI) is T4.',
        why: ['', 'That is T2, the operand into the MAR.', 'That is step 4, 100.', 'That is T1, the same for every opcode.'],
      },
    },
    {
      title: 'Flags and conditional jumps',
      body: `
        <p>JC and JZ are ordinary JMPs whose microcode depends on the flags: the <span data-show="flags">flags
        register</span>'s CF and ZF are two more address lines of the <span data-show="ctl">EEPROMs</span>. JZ with ZF = 1:</p>
        ${microTable(8, 0, 1)}
        <p>and with ZF = 0 its T2 is empty: the instruction passes without jumping. No comparator, no branch unit: the
        condition is evaluated by looking up a different word. That is why the address grew from 7 bits to 9, and why the
        flags are loaded only by FI (ADD and SUB): a jump tests the result of the last arithmetic.</p>
        <p>The program counts down from 10 with SUB and leaves the loop with JZ.</p>`,
      scene: () => sapScene({ program: 'countdown', highlight: ['flags', 'ctl'] }),
      challenge: {
        kind: 'quiz',
        question: 'A = 15 and <code>SUB</code> subtracts 15. What are CF and ZF after its T4?',
        options: ['CF = 1, ZF = 1', 'CF = 0, ZF = 1', 'CF = 0, ZF = 0', 'CF = 1, ZF = 0'],
        answer: 0,
        explain: '15 + NOT 15 + 1 = 15 + 240 + 1 = 256: the sum is 0 (ZF = 1) and a carry leaves bit 7 (CF = 1: no borrow).',
        why: ['', 'CF = 0 would mean a borrow, A < B; 15 is not below 15.', 'The sum is zero.', 'The sum is zero.'],
      },
    },
    {
      title: 'Programs',
      body: `
        <p>Fibonacci until a sum passes 255, and Ben's multiply (a loop of additions, with JC as its counter) are in the
        panel's list; Edit takes your own, 16 bytes at most. Fibonacci's 13 values take
        ${FIB.bytes} bytes and ${FIB.cycles}
        clock cycles, five an instruction.</p>
        <p>What it costs: ${SAP_COST.chips} chips, ${k(SAP_COST.logic)} NANDs of logic (${SAP_COST.bus} of them the
        bus's OR stand-in) and five EEPROMs. Our single-cycle RV32I (<a href="#/c/cpu/0">chapter 14</a>) is
        ${k(RV32I.nands)} NANDs without its program ROM, about ${Math.round(RV32I.nands / SAP_COST.logic)} times as many,
        and runs one 32-bit instruction a clock where SAP-1 needs five for an 8-bit one, from a memory of 16 bytes with
        no stack, no indexing, no interrupts. Most of its cost is the register file and the 32-bit data path SAP-1
        does without.</p>`,
      scene: () => sapScene({ program: 'fib', highlight: [] }),
      challenge: {
        kind: 'reach',
        goal: 'Write a program that leaves 100 on the display and halts.',
        check: (st) => halted(st) && hw(st)?.out === 100,
        hints: ['LDI takes only 0–15: put the numbers in RAM with <code>.byte</code>.', 'LDA x, ADD y, OUT, HLT, with x + y = 100.'],
        answer: `<pre>${HUNDRED}</pre>Edit, paste, Assemble &amp; load, Run to HLT. (Do it for me keys the bytes in by the switches over the program in RAM.)`,
        // keyed in by the switches, as on the boards (the panel's model takes the RAM when PROG goes off)
        solve: (st) => { program(st, sapBytes(HUNDRED)); st.runCycles(60, () => halted(st)); },
      },
    },
  ],
};
