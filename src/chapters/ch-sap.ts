// Appendix C: Ben Eater's 8-bit breadboard computer, itself SAP-1 from Malvino and Brown's Digital Computer
// Electronics, built from 74xx chips that are built from our gates (lib/ttl.ts, lib/sap.ts; docs/SAP.md). Every scene
// is the gate-level machine; the computer's scenes open on its breadboards (widgets/saplayout.ts) with the SAP panel
// following the golden model at every clock edge (widgets/sap.ts).

import { groupDigits } from '../sim/numfmt';
import { RESULTS } from '../bench/summary';
import { sapBytes } from '../sap/asm';
import { SapISS } from '../sap/iss';
import { SAP_PROGRAMS } from '../sap/programs';
import { SwitchSim } from '../sim/switchsim';
import type { Stage } from '../view/stage';
import { sapAluScene, sapAregScene, sapClockScene, sapPcScene, sapScene, tristateScene } from '../widgets/sap';
import { CTRL } from '../sap/isa';
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
const k = groupDigits;

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
/** The board reference of the RAM's low 189, as saplayout.ts numbers the chips (tests/sap-appendix.test.ts holds it to
 *  the layout: computing it here would build the computer's netlist whenever the chapters load). */
export const SAP_RAM_LO_REF = 'U10';

const halted = (st: Stage) => (hw(st)?.cw ?? 0) >> 15 === 1;

/** Fibonacci's size and clock cycles to HLT (the golden model). */
const FIB = (() => {
  const bytes = sapBytes(SAP_PROGRAMS.find((p) => p.id === 'fib')!.src), m = new SapISS(bytes);
  m.run();
  return { bytes: bytes.length, cycles: m.cycles };
})();

/** The 'add' program's size in bytes and clock cycles to HLT (the golden model): LDA, ADD, OUT, HLT. */
const ADD_RUN = (() => {
  const bytes = sapBytes(SAP_PROGRAMS.find((p) => p.id === 'add')!.src), m = new SapISS(bytes);
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
      `Without the EEPROMs it is ${k(SAP_COST.logic)} NANDs (${SAP_COST.chips - SAP_COST.eeproms} chips, ${SAP_COST.chips} with them); our single-cycle RV32I is ${k(RV32I.nands)}. SAP-1 buys that with 16 bytes, an 8-bit adder, no registers beyond A and B, and five clocks an instruction.`,
      'The inspector counts the EEPROMs apart, as 5 × 2 KB of ROM: simulated, each is a mux tree of 65 524 NANDs; on silicon it is a transistor per bit and two decoders.',
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
        <p>Starting in 2016 Ben Eater built an 8-bit computer on breadboards, on video, one module at a time, from
        the design Albert Malvino and Jerald Brown call SAP-1 (<em>Simple As Possible</em>) in <em>Digital Computer
        Electronics</em>. Many have built it since from his kits. Here it is again, module for module, each chip built
        from our gates: open any of them and keep going down to MOSFETs. Our boards add a 74LS04 wherever an active-high
        control line meets an active-low pin, and the RAM's write pulse comes from a 74LS08 where Ben has a NAND and an RC.</p>
        <p>Everything meets on one 8-bit <span data-show="bus">bus</span>. A board either <em>drives</em> it (a line
        ending in O: the <span data-show="pc">program counter</span>, the <span data-show="ram">RAM</span>, the
        <span data-show="ir">instruction register</span>'s operand, <span data-show="a">A</span>, the
        <span data-show="alu">ALU</span>'s sum) or <em>loads</em> from it at the next rising edge (a line ending in I:
        the <span data-show="mar">memory address register</span>, the RAM, the IR, A, <span data-show="b">B</span>,
        <span data-show="out">OUT</span>). The <span data-show="ctl">control unit</span> turns those lines on, sixteen
        of them, a new set at every step.</p>
        <p>Cost: ${SAP_COST.chips} chips simulated (and ${SAP_COST.drawn} drawn only), ${k(SAP_COST.logic)} NANDs of logic
        and five EEPROMs, 5 × 2 KB of ROM (the inspector's count). The program is "add two numbers" from RAM.</p>
        <p>Why one bus: it is the cheapest way to let any register talk to any other. N registers all connected to each other would need N × (N − 1) wires; on a bus each has one wire in and one out, and
        a control line says who talks and who listens. The price is time: only one transfer happens per step, so an instruction is several steps, and the control unit's whole job is sequencing them
        so that exactly one board drives the bus at a time.</p>
        <div class="try">Look first: before any Pulse the computer is in T0, the program counter's board drives the bus
        (amber) and the memory address register will load from it (blue) at the rising edge. Pulse once: now it is T1, the
        RAM drives and the instruction register loads.</div>`,
      tour: {
        label: 'Run the program, step by step',
        beats: [
          { title: 'T0: the address', reset: true, say: 'Power-on state: the program counter holds 0 and its board drives the bus ({v:bus}). At the next rising edge the memory address register loads it.', at: [], show: ['pc', 'bus', 'mar'], expect: { bus: 0, out: 0, halt: 0 } },
          { title: 'T1: the instruction', say: 'The RAM now drives the bus: RAM[0] = {v:bus} = 0x14, <code>LDA 4</code>. The instruction register loads it; the counter steps to 1.', cycles: 1, show: ['ram', 'ir', 'bus'], expect: { bus: 0x14 } },
          { title: 'T2: the operand', say: 'The instruction register drives the low nibble of itself onto the bus ({v:bus}), the address 4, and the memory address register loads it.', cycles: 1, show: ['ir', 'mar', 'bus'], expect: { bus: 4 } },
          { title: 'T3: the data', say: 'RAM[4] goes onto the bus: {v:bus}, the first number, and register A loads it. The bus carried an address, an instruction, an address and a value in four steps.', cycles: 1, show: ['ram', 'a', 'bus'], expect: { bus: 28 } },
          { title: 'ADD: B, then the sum', say: 'Five steps of fetch and decode later, ADD has put its operand on the bus ({v:bus}, the second number) into B. One step on, the ALU drives the bus with the sum.', cycles: 5, show: ['ram', 'b', 'bus'], expect: { bus: 14 } },
          { title: 'The sum on the bus', say: 'The ALU\'s output enable is on: {v:bus} = 28 + 14, and A loads it. Nothing else drives the bus at the same time: <code>clash</code> stays 0.', cycles: 1, show: ['alu', 'a', 'bus'], expect: { bus: 42, clash: 0 } },
          { title: 'OUT, HLT', say: `OUT puts A on the bus into the output register, then HLT stops the clock: <code>out</code> = {v:out}, <code>halt</code> = {v:halt}. ${ADD_RUN.cycles} clock cycles in all for a ${ADD_RUN.bytes}-byte program.`, cycles: 8, show: ['out', 'ctl'], expect: { out: 42, halt: 1 } },
        ],
      },
      more: {
        derive: `<p>Five steps an instruction, so the add program (LDA, ADD, OUT, HLT) takes 3 × 5 + 2 = ${ADD_RUN.cycles} cycles to reach HLT, which stops the clock after two more rising edges, at T2. Wires: N registers fully connected, N(N − 1); on one bus, 2N
          (an in and an out each), plus 2N control lines. The bus is 8 bits wide, so every transfer moves a byte, and the 4-bit operand shares the instruction byte with the 4-bit opcode: 16 opcodes, 16 addresses.</p>`,
        real: `<p>Ben Eater built this on breadboards with 74LS chips that were already decades old: the TTL families of the 1970s, which is the technology minicomputers and the first microprocessors' support logic were made of.
          A shared bus with tri-state drivers is how those machines were organized, and how a parallel bus on a modern board still works. Inside a modern CPU the wide buses are replaced by point-to-point wires and
          multiplexers, because a tri-state bus is slow to turn around and awkward to verify.</p>`,
        pitfall: `<p>Believing the wiring prevents two boards from talking at once. It does not: the 74LS245s are simply connected to the same eight wires, and only the microcode keeps them apart. A microcode error
          that turns on two O lines in one step shorts the bus (a later step of this appendix shows the short at switch level); the gate-level computer reports it on <code>clash</code>.</p>`,
        numbers: `<table class="mini"><tr><th>step</th><th>LDA: lines on</th><th>bus carries</th></tr>
          <tr><td>T0</td><td>CO MI</td><td>program counter</td></tr><tr><td>T1</td><td>RO II CE</td><td>the instruction</td></tr>
          <tr><td>T2</td><td>IO MI</td><td>the operand (address)</td></tr><tr><td>T3</td><td>RO AI</td><td>the data</td></tr>
          <tr><td>T4</td><td>(nothing)</td><td>nobody drives it</td></tr></table>`,
      },
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
        <p>Why <code>nclk</code> exists: the control unit changes its control word on the falling edge, half a period before the rising edge on which the registers load. That half period is the time the
        EEPROMs and the gates behind them have to settle, and it is why the control word is steady, never glitching, at the moment it matters. A computer that stepped its control unit on the same edge
        as its registers would have a race between the new control word and the old data. (Stepping on the same edge is fine in a synchronous design with enables, as chapter 23's is. This one gates clocks with its control lines (OI, RI), so those lines must be steady before the clock rises and stay so while it is high.)</p>
        <div class="try">Turn on <code>HLT</code> and Pulse: <code>clk</code> stays dark, so no register anywhere sees
        an edge.</div>`,
      tour: {
        beats: [
          { title: 'Running', say: 'The oscillator is high and <code>HLT</code> is off: <code>clk</code> = {v:clk}, and its inverse <code>nclk</code> = {v:nclk}. They are always opposites while running.', set: { osc: 1, hlt: 0 }, at: [], show: ['and', 'inv'], expect: { clk: 1, nclk: 0 } },
          { title: 'HLT stops the clock', say: 'With <code>HLT</code> on, the AND gate is closed: <code>clk</code> = {v:clk} even though the oscillator is still high. The inverter makes <code>nclk</code> = {v:nclk}, parked high.', set: { hlt: 1 }, show: ['and'], expect: { clk: 0, nclk: 1 } },
          { title: 'The oscillator keeps going', say: 'The oscillator falls: nothing changes. <code>clk</code> = {v:clk}. A halted computer sees no edge at all, however the oscillator moves.', set: { osc: 0 }, show: ['and'], expect: { clk: 0, nclk: 1 } },
          { title: 'Release', say: 'HLT off again and the oscillator low: <code>clk</code> = {v:clk}. The next rise of the oscillator will be the first edge the computer sees.', set: { hlt: 0 }, expect: { clk: 0, nclk: 1 } },
          { title: 'A clean edge', say: 'The oscillator rises: <code>clk</code> = {v:clk}, <code>nclk</code> = {v:nclk}. HLT changed while the clock was low, so the gate output had no runt pulse.', set: { osc: 1 }, expect: { clk: 1, nclk: 0 } },
        ],
      },
      more: {
        derive: `<p>The gating is <code>clk</code> = osc · ¬HLT. Two gates: a 74LS04 inverter and a 74LS08 AND, ${SAP_COST.clock} NANDs in all, and a second inversion for <code>nclk</code> = ¬clk. HLT is a bit of the control word, so it changes only on the falling
          edge (when <code>nclk</code> rises and the step counter advances), i.e. while <code>clk</code> is low: the AND's output is 0 either way, and no partial pulse can be made. The step counter then cannot move off the HLT word, because it needs the very edge that HLT removed.</p>`,
        real: `<p>Ben's board has three 555 timers: an astable for the free-running clock, a monostable for a single step, a bistable to debounce the mode switch. A mechanical button bounces for milliseconds, making several edges where one was meant, and a counter counts every one; a monostable replaces them with one clean pulse. Clock gating is also how modern chips save power (clock gating cells), with the same rule: change the enable only while the clock is in its inactive phase.</p>`,
        pitfall: `<p>Gating a clock with a signal that can change while the clock is high. The result is a runt pulse, or a clock that rises in the middle of a period, and every register on the net sees an extra edge. Here that cannot happen because HLT is
          launched by the falling edge. The same care applies to the output register's clock (CLK AND OI), later in this appendix.</p>`,
      },
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
        <p>The register has two independent halves. The load side (the 173s) listens to the bus and keeps a value; the drive side (the 245) puts that value back on the bus or not. They share nothing but the
        eight bits, which is why A can be loaded without being driven, driven without being loaded, or both in one step. Every board in the computer is built from that pair, and the control word is the list of which side of which board is on.</p>
        <div class="try">Set the bus switches to a value, turn AI on and Pulse: the LEDs take it. Turn AO on: <code>drv</code>
        shows it, as the bus would.</div>`,
      tour: {
        beats: [
          { title: 'Value waiting on the bus', say: 'The bus switches read 0x5A but AI is off: A (<code>q</code> = {v:q}) is not listening. Nothing happens however long the value sits there.', set: { ai: 0, ao: 0, rst: 0, bus: 0x5a }, at: [], show: ['lo', 'hi'], expect: { q: 0, drv: 0 } },
          { title: 'Load', say: 'AI on and one clock pulse: at the rising edge both 173s load. <code>q</code> = {v:q} = 0x5A.', set: { ai: 1 }, cycles: 1, show: ['lo', 'hi'], expect: { q: 0x5a } },
          { title: 'Keep', say: 'AI off, the bus changed to 0x11, another pulse: <code>q</code> is still {v:q}. A flip-flop that is not enabled holds its value through any number of edges.', set: { ai: 0, bus: 0x11 }, cycles: 1, expect: { q: 0x5a } },
          { title: 'Drive', say: 'AO on: the 245 opens and the stored value is on its output, <code>drv</code> = {v:drv}. On the real bus that would be the byte every other board sees.', set: { ao: 1 }, show: ['drv'], expect: { drv: 0x5a, q: 0x5a } },
        ],
      },
      more: {
        derive: `<p>A 74LS173 is four D flip-flops with a load multiplexer and an output gate: ${SAP_COST.ls173} NANDs here, about ${Math.round(SAP_COST.ls173 / 4)} a bit. The register is two of them (${2 * SAP_COST.ls173}), the 245 and the 04 make up the rest of ${SAP_COST.areg}.
          It loads when both active-low enables G1 and G2 are low at the rising edge; the microcode's AI is active high, so the 04 inverts it to the enable pins. Eight bits stored for ${SAP_COST.areg} NANDs is ${(SAP_COST.areg / 8).toFixed(0)} NANDs a stored bit including the bus interface.</p>`,
        real: `<p>The 74LS245 is a bus transceiver: eight bidirectional 3-state drivers with a direction input. SAP-1 uses it one way, as a buffer. 3-state outputs are what allow a dozen boards to share a bus, because a disabled output is electrically absent; the cost is the contention hazard the next step shows. FPGAs, which have no internal tri-states, use multiplexers instead.</p>`,
        pitfall: `<p>Expecting the register to follow the bus. It copies it once, at the rising edge on which AI is on, and ignores it afterwards. Turning AI off before the next edge is what keeps the value: in the scene, change the switches
          with AI still on and the next pulse overwrites A. The same happens in the real computer when a control word is wrong for one step too many.</p>`,
        numbers: `<table class="mini"><tr><th>module</th><th>NANDs</th></tr>
          <tr><td>clock gating</td><td>${SAP_COST.clock}</td></tr><tr><td>A register board (2 × 173, 245, 04)</td><td>${SAP_COST.areg}</td></tr><tr><td>ALU board (283s, 86s, 245)</td><td>${SAP_COST.alu}</td></tr>
          <tr><td>program counter board</td><td>${SAP_COST.pc}</td></tr><tr><td>RAM board</td><td>${k(SAP_COST.ram)}</td></tr></table>`,
      },
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
        <p>This is the one place where the gate-level abstraction used everywhere else is deliberately wrong. A gate-level simulation has only 0, 1 and X, and an output always drives; a bus line needs a fourth
        value, Z, "nobody is driving", and a rule for what happens when two drivers meet. Only the switch-level solver, which sees transistors, can say. Seeing it here is what makes sense of the OR stand-in in the
        computer's scene, and of the care the microcode takes.</p>
        <div class="try">Enable a second driver with a different value: the panel names the short and the path it takes.</div>`,
      tour: {
        beats: [
          { title: 'One driver', say: 'Driver 0 is enabled and drives a 1: <code>line</code> = {v:line}. Its PMOS pulls the line to VDD; the others are off.', at: [], show: ['u0'], expect: { line: 1 } },
          { title: 'No driver', say: 'All disabled: nothing sets the line, and the pull-down resistor holds it at a weak 0: <code>line</code> = {v:line}. This is the state of the computer\'s bus between transfers.', set: { en0: 0 }, show: ['pd'], expect: { line: 0 } },
          { title: 'Another driver', say: 'Driver 2 alone, driving 1: <code>line</code> = {v:line}. Any one driver wins over the pull-down.', set: { en2: 1 }, show: ['u2'], expect: { line: 1 } },
          { title: 'Two that agree', say: 'Drivers 0 and 2 both drive 1. The line is {v:line}: no conflict, since both pull the same way. It works, and it would fail the moment one changed.', set: { en0: 1 }, show: ['u0', 'u2'], expect: { line: 1 } },
          { title: 'Two that disagree', say: 'Driver 1 joins, driving 0. One PMOS pulls to VDD, one NMOS pulls to GND, both fully on: a short. The line reads {v:line}, neither value (X).', set: { en1: 1 }, show: ['u0', 'u1'], expect: { line: -1 } },
        ],
      },
      more: {
        derive: `<p>The solver resolves the line by strength: a driver (strength 4 to 2) beats the pull-down resistor (strength 1), and two drivers of different values with equal strength give X and flag a short. The rule is
          the table under Numbers; the computer's gate-level bus replaces it with an OR of the drivers and a <code>clash</code> output that is 1 whenever two drivers are enabled, even when they agree: stricter than this table, like the microcode's rule. Each tri-state buffer here is 8 transistors: two for the output stage,
          the rest to switch it off.</p>`,
        real: `<p>Real 3-state outputs do not switch instantly: a driver turns off in a little more or less time than another turns on, so for a few nanoseconds around every handover both can conduct. That is bus contention in
          miniature, and why bus designs leave a dead cycle between drivers (turnaround). SAP-1 does not avoid it: at each falling edge one 245 lets go as the next takes over. It only makes it harmless, since nothing loads until the rising edge half a period later.</p>`,
        pitfall: `<p>Calling two agreeing drivers safe. They draw no heavy current today, but the design relies on both always producing the same value, and a single data-dependent difference makes it a short. The microcode rule is stricter and simpler: never
          more than one O line at a time, whatever the data.</p>`,
        numbers: `<table class="mini"><tr><th>drivers enabled</th><th>values</th><th>line</th></tr>
          <tr><td>none</td><td>–</td><td>0 (weak, from the pull-down)</td></tr><tr><td>one</td><td>v</td><td>v</td></tr>
          <tr><td>two</td><td>both 1</td><td>1</td></tr><tr><td>two</td><td>1 and 0</td><td>X, short</td></tr></table>`,
      },
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
        on the bus while ΣO = 1 (a <span data-show="inv">74LS04</span> turns ΣO into its active-low G). ${SAP_COST.alu} NANDs; it has no clock, the sum is always there.</p>
        <p>On the computer the sum also feeds the flags register (a 74LS173 loaded by FI): CF is the carry out of bit 7,
        ZF is the sum being 0 (74LS02 NORs and 74LS08 ANDs). For a subtraction CF = 1 means <em>no</em> borrow: A ≥ B.</p>
        <p>Subtracting with the adder is the same trick as everywhere in this site (two's complement), and it costs only a row of XORs and a carry-in: no second circuit, no mode flag beyond SU. What the ALU gives up is
        speed and range: it adds 8 bits in a ripple of two chips, and it computes only add and subtract. There is no AND, no shift, no compare; a program needing them builds them out of repeated adds, as Ben's multiply does.</p>
        <div class="try">Turn SU on: the sum becomes 28 − 14 = 14 and <code>cout</code> lights (no borrow).</div>`,
      tour: {
        beats: [
          { title: 'Add', say: 'A = 28, B = 14, SU off: the two 283s give <code>sum</code> = {v:sum}, no carry out ({v:cout}). The sum is there at once; nothing is clocked.', set: { su: 0, eo: 0 }, at: [], show: ['add0', 'add1'], expect: { sum: 42, cout: 0, drv: 0 } },
          { title: 'Onto the bus', say: '<code>eo</code> (ΣO) on: the 245 opens and <code>drv</code> = {v:drv}. Until now the sum was computed and invisible; this is the only thing that makes it a bus value.', set: { eo: 1 }, show: ['drv'], expect: { drv: 42 } },
          { title: 'Subtract', say: 'SU on: the XORs invert B and the carry-in becomes 1. 28 + NOT 14 + 1 = 14, and the carry out is {v:cout}: no borrow, A ≥ B.', set: { su: 1 }, show: ['x0', 'x1', 'add0', 'add1'], expect: { sum: 14, cout: 1 } },
          { title: 'A less than B', say: '5 − 7: <code>sum</code> = {v:sum} (0xFE, −2 in two\'s complement), and the carry out is {v:cout}. A zero carry is the borrow.', set: { a: 5, b: 7 }, expect: { sum: 254, cout: 0 } },
          { title: 'Zero', say: '15 − 15: the sum is {v:sum}, and the carry out is {v:cout}. The sum being 0 is what the zero flag will record.', set: { a: 15, b: 15 }, expect: { sum: 0, cout: 1 } },
        ],
      },
      more: {
        derive: `<p>A − B = A + ¬B + 1: B passes through eight XORs with SU as the other input (identity when SU = 0, complement when SU = 1), and SU also feeds the first adder's carry-in. Two 4-bit adders in series give an
          8-bit sum, the carry out of the upper one being CF. For 5 − 7: 5 + 248 + 1 = 254 with no carry out of bit 7; for 15 − 15: 15 + 240 + 1 = 256, sum 0, carry 1. The flags register stores CF and ZF = (sum == 0); its output feeds back
          into the control unit's address, as the step on flags shows.</p>`,
        real: `<p>The 74LS283 is a 4-bit adder with internal carry lookahead, so within a chip the carry does not ripple bit by bit; between the two chips it does. Eight bits with a nibble of lookahead is the same trade the fast-adder chapter makes at a larger scale.
          Real ALUs of the era, the 74181, did 16 arithmetic and 16 logic functions in a single 4-bit slice; SAP-1 does without.</p>`,
        pitfall: `<p>Reading the carry after a subtraction as a borrow. It is inverted: carry 1 means no borrow (A ≥ B), carry 0 means borrow (A &lt; B). Programs that test CF after SUB are testing "A was at least B", and a JC after a SUB branches
          when the subtraction did <em>not</em> go negative. The same convention is why 6502 programmers set the carry before a SBC.</p>`,
        numbers: `<table class="mini"><tr><th>A</th><th>B</th><th>op</th><th>sum</th><th>CF</th></tr>
          <tr><td>28</td><td>14</td><td>add</td><td>42</td><td>0</td></tr><tr><td>28</td><td>14</td><td>sub</td><td>14</td><td>1</td></tr>
          <tr><td>5</td><td>7</td><td>sub</td><td>254</td><td>0</td></tr><tr><td>15</td><td>15</td><td>sub</td><td>0</td><td>1</td></tr></table>`,
      },
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
        bus, or the eight data switches), a 74LS08 makes the write pulse RI · CLK, a third 157 picks it or the WR button,
        and a 245 drives the bus. Nine chips and ${k(SAP_COST.ram)} NANDs for 128 bits: the 189's cells are latches,
        ${SAP_COST.ls189} NANDs a chip.</p>
        <p>Ben's 189 writes while WE is low, from an RC pulse on the clock edge. Here the write is RI AND CLK, so it happens
        while the clock is high: at the rising edge, in effect, which is when the golden model writes.</p>
        <p>This RAM starts empty. Program it as Ben does, whenever you like (running or not): PROG on, an address on the
        four switches, a byte on the eight, press WR; next address. PROG off, then RESET on the clock board: it clears the
        PC, the step counter, A, B, the IR and the flags (the chips' CLR pins), but not the RAM, so the program starts from
        address 0. The panel's model pauses while PROG is on and takes the RAM from the hardware after. The bar's
        <em>Power cycle</em> is not RESET: it switches the computer off and on, and the 189s forget what you keyed in, as
        real SRAM would.</p>
        <p>This memory is the machine's whole address space: 16 bytes, code and data together, addressed by a 4-bit register. The same bytes are program and variables, so a program that
        overwrites its own data (Fibonacci does) also changes what a rerun starts from. That is the von Neumann design in its smallest form, and the reason a programmer here counts bytes.</p>
        <div class="try">Double-click ${SAP_RAM_LO_REF}, the low 189: its Q1–Q4 read the stored nibble inverted (an empty RAM reads
        1111), and the 74LS04 beside it flips them back.</div>`,
      more: {
        derive: `<p>Capacity and cost: 16 words × 8 bits = 128 bits in two 4-bit-wide 189s. The board is ${k(SAP_COST.ram)} NANDs, ${(SAP_COST.ram / 128).toFixed(1)} per bit including all the glue; the 189 alone is ${SAP_COST.ls189} NANDs, ${(SAP_COST.ls189 / 64).toFixed(1)} a bit,
          in a library where a latch costs a handful of NANDs and each bit also pays its share of the address decoder and read multiplexer. The write enable is RI · CLK, high for the half period in which the clock is high, which has the same effect at the rising edge as Ben's RC pulse.</p>`,
        real: `<p>The 74LS189 is a 64-bit static RAM from the 1970s, 16 × 4 with inverting outputs and an active-low write enable; its inverted
          output forces the 74LS04s on every data line. A modern 8-bit board would use a 32 K × 8 SRAM chip of 256 Kbit, two thousand times larger in one 28-pin package, and the memory would not be the thing the project is about.</p>`,
        pitfall: `<p>Assuming RESET clears the RAM. It clears the PC, step counter, A, B, IR and flags, but a RAM is not cleared by a control pin: your program stays and runs again from address 0. Equally, the bar's Power cycle really does forget the
          program, as SRAM does when its supply goes. And PROG takes the RAM's address away from the memory address register: keying bytes while the program runs makes the two disagree about where the RAM is looking.</p>`,
        numbers: `<table class="mini"><tr><th>part</th><th>NANDs</th><th>stores</th></tr>
          <tr><td>74LS189 (16 × 4)</td><td>${k(SAP_COST.ls189)}</td><td>64 bits</td></tr><tr><td>RAM board (2 × 189, glue)</td><td>${k(SAP_COST.ram)}</td><td>128 bits</td></tr>
          <tr><td>one 28C16 as simulated</td><td>${k(SAP_COST.perEeprom)}</td><td>16 384 bits</td></tr></table>`,
      },
      scene: () => sapScene({ empty: true, highlight: ['mar', 'ram'], fixed: true }),
      tries: [(st) => st.path.join('.') === 'ram.lo'],
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
        <p>The program counter is the machine's only sense of sequence. Every other register holds data; this one holds position, and an instruction that changes it is a control-flow instruction. Because it is just a counter
        with a parallel load, the whole of branching in this machine is "load the operand into the counter", and the rest of the control unit's work is deciding whether to.</p>
        <div class="try">CE is on: Pulse a few times and watch the count.</div>`,
      tour: {
        beats: [
          { title: 'At zero', say: 'The counter starts at {v:pc}, enabled to count (<code>ce</code> on), not loading, not driving the bus.', set: { co: 0, j: 0, bus: 0, rst: 0, ce: 1 }, at: [], show: ['cnt'], expect: { pc: 0, drv: 0 } },
          { title: 'Counting', say: 'Three clock pulses: each rising edge adds one. <code>pc</code> = {v:pc}. Nothing reaches the bus, because CO is off.', cycles: 3, show: ['cnt'], expect: { pc: 3 } },
          { title: 'Onto the bus', say: 'CO on: the 245 opens and <code>drv</code> = {v:drv}, the count. This is how T0 gets the address into the MAR.', set: { co: 1 }, show: ['drv'], expect: { drv: 3 } },
          { title: 'A jump', say: 'The bus switches carry 9 and J is on (and the count enable off). At the pulse the 161 loads the bus\'s low nibble: <code>pc</code> = {v:pc}. A load wins over counting.', set: { co: 0, ce: 0, bus: 9, j: 1 }, cycles: 1, show: ['cnt', 'inv'], expect: { pc: 9, drv: 0 } },
          { title: 'Wrap-around', say: 'J off, counting on, seven more pulses: 9 + 7 = 16, which does not fit four bits. <code>pc</code> = {v:pc}: the program counter wrapped to the start of memory.', set: { j: 0, ce: 1 }, cycles: 7, show: ['cnt'], expect: { pc: 0 } },
        ],
      },
      more: {
        derive: `<p>A 74LS161 counts modulo 16 and loads on its parallel inputs when LOAD is low; a jump is IO (the operand on the bus) with J on (LOAD = ¬J through the 04). The count wraps because 15 + 1 carries out of bit 3 and nothing keeps it:
          addresses 0 to 15 are the whole space. ${SAP_COST.pc} NANDs for the board, ${SAP_COST.ls161} the counter, about ${Math.round(SAP_COST.ls161 / 4)} a bit, since each bit needs a flip-flop, a half adder for the increment and a load multiplexer.</p>`,
        real: `<p>A real PC is as wide as the address space and is incremented by the instruction length (4 bytes in RV32I, variable on x86), not by 1, and branches add a signed offset rather than loading an absolute value. The 161 is a synchronous
          counter: all four bits change on one clock edge, which avoids the ripple of an asynchronous counter where the high bits change a gate delay after the low ones and the count briefly shows wrong values.</p>`,
        pitfall: `<p>Running off the end. A program of more than 16 bytes does not fit; one that does but does not end with HLT or a jump executes its own data as instructions after the last real one and wraps round to the beginning. The scene's wrap-around shows
          the mechanism; ending every program with HLT, or a jump, is what keeps it from happening.</p>`,
      },
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
        <p>The program counts up by 15 until the adder carries out of bit 7.</p>
        <p>The output register is the machine's only visible result, and the decision it embodies is that output is just another bus load: an OUT instruction is a copy of A onto the bus (AO) and into the 273 (OI), no different from any register
        transfer. The display, with its table in ROM, turns that binary byte into something a person can read, and is the one part of the system whose job is entirely for human eyes.</p>`,
      tour: {
        beats: [
          { title: 'Power-on', reset: true, say: 'The program runs <code>LDI 0</code>, then <code>OUT</code>, and so on. Twenty-seven clock cycles later it has shown 0 once and is on its way round the loop: <code>out</code> = {v:out}.', cycles: 27, at: [], show: ['out', 'disp'], expect: { out: 0 } },
          { title: 'First real value', say: 'One cycle more: the second OUT has clocked A (15) into the register through CLK AND OI. <code>out</code> = {v:out}.', cycles: 1, show: ['out'], expect: { out: 15 } },
          { title: 'One loop later', say: 'Each trip round the loop takes 20 clock cycles, four instructions of five steps: <code>out</code> = {v:out}, 15 more.', cycles: 20, show: ['out'], expect: { out: 30 } },
          { title: 'And again', say: 'Another 20: <code>out</code> = {v:out}. The register changed only on the cycle where OI was on; in the 19 others it held its value, though the bus carried other things.', cycles: 20, expect: { out: 45 } },
        ],
      },
      more: {
        derive: `<p>The 273 has no enable, so Ben ANDs the clock with OI: the gated clock has a rising edge only when OI = 1 as CLK rises. It is safe because OI, part of the control word, changes only on the falling edge, so while CLK is high
          OI is steady and the AND cannot glitch. The display ROM: a 28C16 is 2 K × 8, 11 address bits: the 8 bits of the value and 2 digit-select bits (3 digits here), 10 bits used of 11. For the value 255 the table holds, one entry per digit, the segments of 2, 5 and 5. Three static copies of that table replace Ben's multiplexed one.</p>`,
        real: `<p>Multiplexing (one digit lit at a time, fast enough to look continuous) saves a ROM and driver per digit and is how many seven-segment displays work; the cost is that each digit is lit only a fraction of the time, so the segment current is higher, and
          that it needs a scanning clock. Our version drops the multiplexer and the 555 and shows three digits at once, in the simulation's three ROM copies.</p>`,
        pitfall: `<p>Gating a clock casually. A gate between the clock and a flip-flop turns any glitch on the other input into an extra edge. It works here only because of a timing relationship (OI settles on the opposite phase), so changing when the control word changes, or
          adding delay to OI, would break the output register while leaving everything else working. Clock-enable inputs on flip-flops, as the 173 has, are the safe way.</p>`,
      },
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
        2K × 8 ROM is an array of 16 384 cells (a transistor or two each) plus its decoders. Only 512 of its 2048 addresses are used.</p>
        <p>Microcode is a table: for every (flags, opcode, step), the control word that step needs. That the table is in an EEPROM and not in gates is the whole idea. The instruction set becomes data, so adding an instruction, or
        fixing one, is rewriting the table, with no change to the wiring; and the hardware that executes it is the same five boards for every instruction. The cost is a ROM and a step counter that run every instruction in the same five steps, even those that need two.</p>
        <div class="try">Press the panel's Instruction once (LDA runs to the next T0), then Pulse four times: T4 of the ADD
        (the step table follows) has ΣO, AI and FI lit, and the ALU drives the bus.</div>`,
      tour: {
        label: 'Follow one ADD',
        beats: [
          { title: 'LDA first', reset: true, say: 'The first instruction, LDA 4, loads 28 into A. Five clock cycles; we skip to its end. The step counter is back at T0 and the program counter holds 1, the next instruction\'s address.', cycles: 5, at: [], show: ['ctl', 'pc'], expect: { bus: 1 } },
          { title: 'T0: address', say: 'Step 0 of every instruction: <code>CO MI</code>. The PC drives the bus ({v:bus}) and the MAR loads it.', show: ['ctl'], expect: { bus: 1 } },
          { title: 'T1: fetch', say: 'Step 1: <code>RO II CE</code>. RAM[1] = {v:bus}: 0x25, ADD 5, to the instruction register. The two EEPROMs\' address is now [flags][2][step].', cycles: 1, show: ['ctl', 'ir'], expect: { bus: 37 } },
          { title: 'T2: the operand', say: 'Step 2: <code>IO MI</code>. The operand, {v:bus}, goes to the MAR.', cycles: 1, show: ['ctl', 'mar'], expect: { bus: 5 } },
          { title: 'T3: the second number', say: 'Step 3: <code>RO BI</code>. RAM[5] = {v:bus} goes into B.', cycles: 1, show: ['ctl', 'b'], expect: { bus: 14 } },
          { title: 'T4: the sum', say: 'Step 4: <code>ΣO AI FI</code>. The ALU drives the bus with {v:bus}, A loads it, and the flags register records CF and ZF.', cycles: 1, show: ['ctl', 'alu', 'a'], expect: { bus: 42 } },
        ],
      },
      more: {
        derive: `<p>The EEPROM address is [ZF CF][opcode: 4 bits][step: 3 bits] = 9 bits, 512 words; the control word is 16 bits wide, so the two chips hold a byte each (high byte HLT … AO, low byte ΣO … FI). Of the 512 words only the steps an instruction uses are nonzero:
          5 steps × 16 opcodes × 4 flag combinations is 320, and most of those are the same fetch repeated. Changing the ISA means rewriting those 1024 bytes: for instance <code>LDB</code> (B ← RAM[a]) is two words, <code>MI IO</code> and <code>RO BI</code>, at an unused opcode's T2 and T3.</p>`,
        real: `<p>Microprogrammed control was the standard way to build complex CPUs from the 1960s (IBM System/360, the VAX, the 8086's microcode ROM) until RISC made hardwired control small enough to win. Today's x86 chips still run most of their
          instructions as sequences of micro-operations, and their microcode can be patched at boot by a vendor update, in the same way as rewriting this table. A 5-step instruction on the SAP-1 and a 2-micro-operation instruction on a modern CPU are the same idea at different scales.</p>`,
        pitfall: `<p>Forgetting that every step of every opcode needs an entry. An unused step is not "nothing": it is a word that must be all zeros, or an address left unprogrammed that reads whatever the EEPROM holds (erased cells read 1s), which turns on
          every control line at once and drives every board onto the bus. The image that is written to the chips has to cover the whole table, including the steps an instruction does not use, with the NOP word.</p>`,
      },
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
        <p>The program counts down from 10 with SUB and leaves the loop with JZ.</p>
        <p>A conditional jump here is a table lookup and not a decision. A flag set by the ALU a few steps earlier is an address bit; the lookup returns one word or another; the word either loads the counter or does not. That
        makes a branch cost exactly as many steps as any other instruction, five, whether taken or not, so there is no branch penalty to speak of: the price was paid in the ROM's size.</p>
        <div class="try">Run (10 Hz) until ZF lights, stop, then Pulse through the JZ: its T2 now has J, and the PC
        loads the operand.</div>`,
      tour: {
        label: 'Watch the last pass round the loop',
        beats: [
          { title: 'The last SUB begins', reset: true, say: 'The loop has run nine times; <code>out</code> = {v:out}. T0 of a <code>SUB one</code>: the PC drives the bus ({v:bus}).', cycles: 190, at: [], show: ['pc', 'flags'], expect: { bus: 2, out: 1 } },
          { title: 'Fetch SUB', say: 'RAM[2] = {v:bus}: 0x37, SUB 7. The instruction register has it.', cycles: 1, show: ['ir'], expect: { bus: 55 } },
          { title: 'The subtraction leaves zero', say: 'Three steps later the ALU drives the bus: {v:bus}. 1 − 1 = 0, so ZF = 1 and CF = 1 go into the flags register (FI).', cycles: 3, show: ['alu', 'flags'], expect: { bus: 0 } },
          { title: 'JZ is fetched', say: 'The next instruction is <code>JZ 5</code>. T0: the PC drives the bus ({v:bus}), the next address after SUB.', cycles: 1, show: ['pc', 'ctl'], expect: { bus: 3 } },
          { title: 'The taken jump', say: 'At T2 the EEPROMs\' address includes ZF = 1, so the word is <code>IO J</code>: the operand {v:bus} goes on the bus and the program counter loads it instead of counting.', cycles: 2, show: ['ctl', 'flags', 'pc'], expect: { bus: 5 } },
          { title: 'It landed on done', say: 'Three cycles on, the PC drives the bus again: {v:bus}. Address 5 is <code>done</code>, not the next instruction after JZ: the jump was taken.', cycles: 3, show: ['pc'], expect: { bus: 5 } },
          { title: 'OUT 0, then HLT', say: 'The OUT at <code>done</code> shows the 0 (<code>out</code> = {v:out}) and four cycles later the HLT stops the clock: <code>halt</code> = {v:halt}.', cycles: 7, show: ['out', 'ctl'], expect: { out: 0, halt: 1 } },
        ],
      },
      more: {
        derive: `<p>JZ with ZF = 1 has T2 = <code>IO J</code>, with ZF = 0 an empty word; the EEPROM address grew from 7 bits (opcode and step) to 9 by adding ZF and CF, so the microcode is four copies of the table, one per flag combination, and only the
          conditional jumps differ between them. The flags register is a 173 loaded by FI, so only ADD and SUB set the flags; a JZ tests the result of the last arithmetic. Countdown runs 10 passes of 20 cycles, the last leaving the loop through JZ, then OUT and HLT:
          about 10 × 20 + 7 = 207 cycles.</p>`,
        real: `<p>Most CPUs of the era kept flags (zero, carry, sign, overflow) updated by nearly every ALU instruction, and made branches test them. RISC-V has no flags at all: its branches compare two registers directly, so there is no hidden state between instructions and
          nothing to save on an interrupt. This site's RV32I does it that way; SAP-1's way is the older and the cheaper in gates, but it couples every instruction to the previous arithmetic.</p>`,
        pitfall: `<p>Testing a flag that the last instruction did not set. LDA, OUT and JMP leave the flags untouched, so a JZ after an LDA tests the zero or carry of whatever arithmetic last ran, perhaps many instructions ago. The countdown loop puts SUB
          immediately before JZ for this reason.</p>`,
        numbers: `<table class="mini"><tr><th>ZF</th><th>JZ's T2 word</th><th>effect</th></tr>
          <tr><td>1</td><td><code>IO J</code></td><td>the PC loads the operand</td></tr><tr><td>0</td><td>(empty)</td><td>the PC keeps counting</td></tr></table>`,
      },
      scene: () => sapScene({ program: 'countdown', highlight: ['flags', 'ctl'] }),
      tries: [(st) => { const h = hw(st); return !!h && h.ir >> 4 === 8 && h.zf === 1 && h.step === 2 && (h.cw & CTRL.j) !== 0; }],
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
        panel's list; Edit takes your own, 16 bytes at most. Run to HLT takes the rate beside it, Ben's potentiometer:
        2 Hz to follow every step, 500 Hz, or as fast as the page runs; the golden model is checked at every edge at any
        rate. Fibonacci's 13 values take
        ${FIB.bytes} bytes and ${FIB.cycles}
        clock cycles, five an instruction. It keeps x and y in the RAM and overwrites them, so after a RESET it starts
        from the top on what it left (144 and 233): it shows 144, the sum carries at once, and it halts. Power cycle puts
        0 and 1 back.</p>
        <p>What it costs: ${SAP_COST.chips} chips, ${k(SAP_COST.logic)} NANDs of logic (${SAP_COST.bus} of them the
        bus's OR stand-in) and the five EEPROMs counted among the chips. Our single-cycle RV32I (<a href="#/c/cpu/0">chapter 14</a>) is
        ${k(RV32I.nands)} NANDs without its program ROM, about ${Math.round(RV32I.nands / SAP_COST.logic)} times as many,
        and runs one 32-bit instruction a clock where SAP-1 needs five for an 8-bit one, from a memory of 16 bytes with
        no stack, no indexing, no interrupts. Most of its cost is storage built from gates: a 64-word data memory (58 %) and the register file (34 %).</p>
        <p>What a program on this machine teaches is how much a programmer normally gets for free. There are no named registers to hold temporaries, so every variable is a byte of the 16; no immediate larger than 15, so constants live in memory;
        no multiply, so it is a loop; no stack, so no recursion. Each of these is something the later machines in this site provide, and each is a place where this machine's design chose a smaller circuit over a more capable one.</p>`,
      more: {
        derive: `<p>Instructions executed: Fibonacci takes ${FIB.cycles} cycles at five an instruction (HLT stops after two), so ${Math.round((FIB.cycles - 2) / 5)} instructions for ${FIB.bytes} bytes of program and data. The cost ratio: ${k(RV32I.nands)} / ${k(SAP_COST.logic)} = ${(RV32I.nands / SAP_COST.logic).toFixed(0)}. Time per instruction:
          5 cycles against 1, so on the same clock the RV32I does about five times the instructions with 32-bit operands, whose adder alone is four times as wide. Throughput in bits of ALU work per cycle: 8 bits / 5 cycles against 32 bits / 1: ${(32 / (8 / 5)).toFixed(0)} times.</p>`,
        real: `<p>The textbook SAP-1 is the first of a series (SAP-2, SAP-3) that add registers, a stack, more addressing modes and I/O, each in the direction of a real microprocessor. Eater's kit stops at this one. The chips in it are the same part numbers that
          built minicomputers and the 8-bit micros' glue logic; it can be replicated for a few hundred dollars, and its limits (16 bytes, 8 bits, no stack) are the reason it fits in the head.</p>`,
        pitfall: `<p>A program that needs more than 16 bytes, code and data together. Fibonacci just fits; Ben's multiply fits with its counter in memory. Anything larger either does not load or overwrites itself. Also, 100 cannot be loaded as an immediate: LDI takes only
          0 to 15, so the challenge needs two numbers in memory and an add.</p>`,
        numbers: `<table class="mini"><tr><th></th><th>SAP-1</th><th>our RV32I</th></tr>
          <tr><td>NANDs (no ROM)</td><td>${k(SAP_COST.logic)}</td><td>${k(RV32I.nands)}</td></tr><tr><td>data path</td><td>8 bits</td><td>32 bits</td></tr>
          <tr><td>memory</td><td>16 bytes</td><td>64 words (256 bytes), code apart</td></tr><tr><td>cycles per instruction</td><td>5</td><td>1</td></tr></table>`,
      },
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
