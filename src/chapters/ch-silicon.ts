import { chipLayoutWidget } from '../widgets/chiplayout';
import { journeyWidget } from '../widgets/journey';
import { clockTreeWidget, fabWidget, floorplanWidget, layoutWidget, mappingWidget, pnrWidget, waferWidget } from '../widgets/silicon';
import { cabinetCounts, hallFacts, periodIn } from '../lib/hall';
import { fmtArea, fmtJoules, fmtMass, fmtRate, fmtTime, fmtWatts, RELAY_CONTACTS, TECH } from '../lib/tech';
import { ENIAC, ENIAC_PANEL } from '../phys/triode';
import { RELAY_RACK, Z3 } from '../phys/relay';
import { machineHall } from '../widgets/hall';
import type { Chapter, Step } from './types';

const num = (n: number) => Math.round(n).toLocaleString('en-US');
const times = (x: number) => (x >= 10 ? num(x) : x.toFixed(1));

/** "The same CPU in relays and tubes": every number from lib/hall.ts (pricing, layout, static timing), computed the
 *  first time the step is shown or searched (it flattens the RV32I once), not when the chapter loads. */
function hallStep(): Step {
  let text: string | null = null, explain: string | null = null;
  const facts = () => {
    const f = hallFacts('rv32i'), c4 = hallFacts('cpu4'), r = f.relay, t = f.tube;
    const rc = cabinetCounts(r), tc = cabinetCounts(t);
    const pr = periodIn(f.steps, 'relay'), pt = periodIn(f.steps, 'tube'), pc = periodIn(f.steps, 'cmos');
    const dm = r.blocks.find((b) => b.name === 'dm')!, rf = r.blocks.find((b) => b.name === 'rf')!;
    const perBit = dm.nands / (32 * 32);
    text = `
      <p>Nothing in this course needed silicon: every circuit is NANDs, and a NAND can be a relay (P1) or a triode with two
      diodes (P2). Here is the single-cycle RV32I of <a href="#/c/cpu/0">chapter 14</a> priced that way, block by block, and stood on a floor at
      physical scale. Its ${num(f.nands)} NANDs (the program ROM left out: relay machines read their programs from film or
      cards) become <strong>${num(r.total.devices)} relays</strong>, ${num(r.total.fanout)} of them extra coils, because a
      relay has ${RELAY_CONTACTS} contacts and many nets feed more inputs than that. At ${RELAY_RACK.relays} to a rack that is
      ${rc.used} racks (${rc.packed} if blocks shared them), ${fmtMass(r.total.mass!)} and ${fmtWatts(r.total.power!)}:
      ${times(r.total.devices / Z3.relays)} times the Z3's ${num(Z3.relays)} relays. In tubes it is <strong>${num(t.total.devices)}
      tubes</strong> in ${tc.used} ENIAC-sized panels of ${ENIAC_PANEL.tubes}, ${fmtMass(t.total.mass!)} and ${fmtWatts(t.total.power!)}:
      ${times(t.total.devices / ENIAC.tubes)} ENIACs. The 4-bit CPU fits in ${num(c4.relay.total.devices)} relays
      (${cabinetCounts(c4.relay).used} racks).</p>
      <p>The clock period is the same ${f.steps} gate delays as in CMOS, each now a ${TECH.relay.stepName} of ${fmtTime(TECH.relay.step)}
      or a ${TECH.tube.stepName} of ${fmtTime(TECH.tube.step)}: one instruction takes <strong>${fmtTime(pr)}</strong> in relays
      (${(1 / pr).toFixed(2)} instructions a second) and ${fmtTime(pt)} in tubes (${fmtRate(pt)}), against ${fmtTime(pc)} (${fmtRate(pc)}) for the same netlist on
      ${fmtArea(f.cmos.area!)} of silicon, the speck on the table by the person. An instruction costs ${fmtJoules(r.total.power! * pr)}
      in relays and ${fmtJoules(t.total.power! * pt)} in tubes.</p>
      <details class="deeper"><summary>Deeper: where the racks go</summary>
      <p>Two blocks fill most of the floor: the register file (${rf.cabinets} racks) and the data memory (${dm.cabinets}), both
      flip-flops of NANDs, ${perBit.toFixed(1)} NANDs per bit of data memory. Racks are not shared between blocks, so every small
      block gets one of its own.</p></details>
      <div class="try">Run the program and watch the relays switch (or the plates glow): each cycle's settled values from the
      gate-level simulation, one relay or tube per NAND output of its block (a real relay machine would ripple through
      ${f.steps} steps to get there). Click a rack to open its block.</div>`;
    explain = `A flip-flop of NANDs is a master–slave pair of latches: ${perBit.toFixed(1)} NANDs per bit here with the write
      and read logic, each NAND a relay. A relay is already a latch: one of its own contacts in series with its coil holds it
      until the circuit is broken. One relay per bit is how the Z3 kept 64 words in ${num(Z3.memory)} relays, while this data
      memory of 32 words takes ${num(dm.devices)}.`;
  };
  return {
    title: 'The same CPU in relays and tubes',
    get body() { if (text === null) facts(); return text!; },
    widget: machineHall,
    challenge: {
      kind: 'quiz',
      question: `The RV32I's 32-word data memory alone fills dozens of relay racks, yet the Z3 kept 64 words in ${num(Z3.memory)} relays. Why?`,
      options: [
        'The Z3\'s words were shorter',
        'Here every bit is a flip-flop of NANDs, each NAND a relay; a relay holding itself through its own contact is a one-relay latch',
        'Relays cannot hold a value without power, so the Z3 used film',
        'The Z3 had no data memory, only registers',
      ],
      answer: 1,
      why: [
        'Shorter words would save a fraction, not a factor of dozens: the difference is in how each bit is stored.',
        '',
        'A relay holds a value while powered, latched through its own contact. The Z3 read its program from punched film; its data sat in relays.',
        'The Z3 had a memory of 64 words, the very words in the question.',
      ],
      get explain() { if (explain === null) facts(); return explain!; },
    },
  };
}

export const chSilicon: Chapter = {
  id: 'silicon', num: 27, title: 'From netlist to silicon', level: 'Physical design',
  blurb: 'Standard cells in layout, how they are made, technology mapping, place and route, the clock tree, a floorplan of our dual-core, the real flow on two of our CPUs against our own estimates, and wafer economics.',
  goals: [
    'read a standard cell\'s layout: transistors where polysilicon crosses diffusion, PMOS in the n-well, NMOS below',
    'say what technology mapping, annealing placement and maze routing each decide',
    'explain why wire delay and clock skew, not gates alone, set a routed chip\'s clock period',
    'estimate a die\'s yield and cost per good die from its area and the defect density',
  ],
  builds: ['nand', 'fastadd', 'multicore'],
  recap: {
    keep: [
      'A transistor is where a strip of polysilicon crosses diffusion. A standard cell sits between a VDD rail on top and a GND rail below, PMOS in the n-well above, NMOS beneath. NAND2 puts its NMOS in series and its PMOS in parallel, NOR2 the mirror image.',
      'Synthesis ends in technology mapping onto a library of hundreds of cells; placement (simulated annealing) minimizes wire length; routing (Lee\'s maze router, two metal layers and vias) connects every net. A good placement also leaves room to route.',
      'Unbuffered wire delay grows with the square of the length. After routing, static timing is redone with the real parasitics. Skew shifts both checks: a late capture clock helps setup but can break hold, which no slower clock fixes; the tools add buffers to the short paths.',
      'Power: ½ C V² per toggle (the clock tree a large share, cut by clock gating), plus leakage through transistors that are off, delivered through a power grid whose IR drop is checked like timing.',
      'Our dual-core\'s logic is about 0.73 mm on a side in SkyWater 130 nm and 0.2 mm at 28 nm, where the bond pads set the die size. Its exported Verilog, and the RV32IM system core\'s, go through Yosys, OpenROAD and KLayout to a GDS, each synthesized netlist checked cycle by cycle against this site\'s simulation; beside our NAND counts and unit delays, the flow shows how far those estimates are from real cells.',
      'Yield falls as e<sup>−A·D₀</sup>: at 0.1 defects/cm², 90 % for 100 mm² and 67 % for 400 mm², so the big die costs about 5.4 times as much per good die.',
    ],
    practise: [],
    check: [
      {
        question: 'An unbuffered wire is made twice as long. Its delay grows about:',
        options: ['4×', '2×', 'Not at all: only gates have delay'],
        answer: 0,
        explain: 'Resistance and capacitance both grow with the length, and the delay goes with their product. That is why long wires get buffers.',
        why: ['', 'Resistance and capacitance both double, and the delay goes with their product, not with either alone.', 'On a modern chip wires dominate delay. Counting NAND delays leaves them out, which is why timing is redone after routing.'],
      },
      {
        question: 'What does technology mapping decide?',
        options: ['Which library cells implement each piece of logic, cheapest first', 'Where each cell sits on the die', 'Which metal tracks each net uses', 'Which mask layers the fab needs'],
        answer: 0,
        explain: 'Mapping is the last step of synthesis: it covers the logic netlist with library cells. Placement, routing and masks come after.',
        why: ['', 'That is placement, which comes after synthesis.', 'That is routing, after placement.', 'The masks follow from the finished layout; mapping works on the logic netlist.'],
      },
      {
        question: 'At D₀ = 0.1 defects/cm², a die grows from 100 mm² to 200 mm². Its cost per good die rises by about:',
        options: ['2.2×', '2×', '4×'],
        answer: 0,
        explain: 'Twice the area per die, and the yield falls from e<sup>−0.1</sup> = 90 % to e<sup>−0.2</sup> = 82 %: 2 × 0.905 / 0.819 ≈ 2.2.',
        why: ['', 'That counts the area only. The bigger die also yields less, 82 % instead of 90 %, so each good one costs more.', 'Cost grows faster than area, but not as its square at this defect density: 2 × 0.905 / 0.819 ≈ 2.2.'],
      },
    ],
  },
  steps: [
    {
      title: 'Gates become geometry',
      body: `
        <p>Every netlist on this site ends in NANDs, and every NAND in four transistors. On the chip a transistor is simply where a strip of
        <strong>polysilicon</strong> crosses a region of <strong>diffusion</strong>. A standard cell lines them up between a VDD rail at the top and a GND rail at the bottom:
        PMOS transistors in the n-well above, NMOS below, metal connecting them.</p>
        <p>Compare NAND2 and NOR2: in the NAND the NMOS are in series (no contact between the two gates) and the PMOS in parallel; the NOR is the mirror image.
        Since holes are slower than electrons, series PMOS (the NOR) must be drawn wider to be as fast, which is one reason NAND is the preferred universal gate.</p>
        <div class="try">Toggle A and B and watch which channels conduct. Hide layers to see what is underneath, or switch to 3D, turn the cell and spread its layers apart.</div>`,
      widget: layoutWidget,
    },
    {
      title: 'How chips are made',
      body: `
        <p>The layout is cut into layers, one mask per layer, and the wafer goes through the fab layer by layer: deposit, pattern with light, etch or implant, repeat.
        Lithography sets the smallest feature. Today's leading processes print with 13.5 nm extreme-ultraviolet light.</p>`,
      widget: fabWidget,
      challenge: {
        kind: 'quiz', question: 'Why is the gate "self-aligned" to the source and drain?',
        options: ['A robot aligns each transistor', 'The gate is patterned first and itself masks the source/drain implant, so they line up with it automatically', 'Masks are aligned to within one atom', 'Source and drain are drawn on the same mask as the gate'],
        answer: 1,
        why: ['Billions of transistors are patterned at once through masks; nothing places them one by one.', '', 'Mask-to-mask alignment has a real tolerance, and that error is exactly what self-alignment avoids.', 'Diffusion and polysilicon are separate masks. The trick is that the etched gate itself shields the channel during the implant.'],
        explain: 'Implanting after the gate is etched means the channel under the gate stays undoped while the regions on both sides are doped: the edges match the gate exactly, with no mask-to-mask misalignment. It was one of the inventions that made MOS scaling possible.',
      },
    },
    {
      title: 'A real cell library',
      body: `
        <p>We built everything from one cell. A foundry library has hundreds: inverters, NAND and NOR with 2 to 4 inputs, AND-OR-INVERT, multiplexers, flip-flops,
        each in several drive strengths. <strong>Synthesis</strong> turns Verilog into a netlist of library cells, and its last step, technology mapping, chooses the cheapest
        cells for each piece of logic. Here is the simplest possible mapping, applied to this site's own designs.</p>`,
      widget: mappingWidget,
    },
    {
      title: 'Place and route',
      body: `
        <p>Next the cells get positions and the nets get wires. Placement tries to minimize total wire length; the classic method is <strong>simulated annealing</strong>.
        Routing then finds a path for every connection on a grid of metal tracks, avoiding all other wires. Two layers with preferred directions (horizontal on one,
        vertical on the other) and vias between them make it a shortest-path problem: Lee's maze router, 1961.</p>
        <p>What runs here is a teaching model: one cost (wire length), a grid of a few dozen cells, two metal layers and no design rules. The flow in
        "The real thing" below is a different program altogether: OpenROAD places analytically (a smooth wire-length model solved over the whole chip, then legalized onto the
        rows), repairs timing with buffers and resized cells, builds the clock tree, and routes on five metal layers under sky130's design rules.</p>
        <div class="try">Pick a circuit, Route it straight from the random placement, then Anneal and Route again: compare the wire length and the vias.</div>`,
      widget: pnrWidget,
      challenge: {
        kind: 'quiz', question: 'Why does a better placement make routing easier, not just shorter?',
        options: ['It does not', 'Shorter nets use fewer tracks, so fewer nets compete for the same routing resources and fewer fail', 'The router is faster on small grids', 'Annealing also routes the nets'],
        answer: 1,
        why: ['Routing resources are finite: long, crossing nets congest the channels until some nets cannot be routed at all.', '', 'The grid is the same size either way; what changes is how many nets compete for each track.', 'Annealing only moves cells to shorten the estimated wire length; the router still has to find every path.'],
        explain: 'Every routed segment blocks a track for all other nets. A placement with long, crossing nets congests the channels; an annealed placement leaves room. Real tools estimate congestion during placement for exactly this reason.',
      },
    },
    {
      title: 'Wires and the clock',
      body: `
        <p>On a modern chip, wires and not transistors dominate delay and power. A long wire has resistance and capacitance proportional to its length, so its delay
        grows with the square of the length unless buffers are inserted. The static timing analysis of <a href="#/c/fastadd/0">chapter 16</a> counted NAND delays only. After routing, the tools
        repeat it with the real wire parasitics and fix the violations (timing closure).</p>
        <p>The most important wire is the clock: it should reach every flip-flop at the same moment. A flip-flop needs its input steady from a
        <strong>setup</strong> time before the capturing edge to a <strong>hold</strong> time after it, and the difference in clock arrival (skew) shifts
        both checks. Setup bounds the slowest path: clock-to-q + logic + setup ≤ period + skew, skew being how much later the capturing flip-flop's clock
        arrives than the launching one's. A capture clock that arrives early costs setup margin, and a slower clock pays it back. Hold bounds the fastest
        path: clock-to-q + the shortest logic ≥ hold + skew. A capture clock that arrives <em>late</em> gives the slow paths time but lets new data race
        down a short path and overwrite the old value before the late edge samples it: a <strong>hold violation</strong>, and no slower clock fixes it,
        since the period is not in the inequality. The tools build the clock tree to keep skew small, then pad the short paths with buffers (hold
        fixing). Our own static timing assumes an ideal clock and checks the setup side only; the flow in "The real thing" repairs and checks both
        on its routed clock tree.</p>
        <details class="deeper"><summary>Deeper: power</summary>
        <p>Every net that switches charges or discharges its capacitance: ½ C V² per toggle, glitches included. That is what the inspector's Power
        section measures, with C estimated from each net's fan-out. Summed, dynamic power is α C V² f, α the fraction of nets toggling per cycle. Wires
        carry much of C, and the clock toggles twice every cycle into every flip-flop, so the clock tree alone often takes a third of a chip's dynamic
        power. <strong>Clock gating</strong> is the cheapest cure: an enable, latched so that it cannot glitch, stops the clock of a register that is
        not being written; synthesis inserts it from enables such as the register file's write enables.</p>
        <p><strong>Leakage</strong> is the other part: an off transistor still conducts a little, a current that grows about tenfold for every 60 to
        100 mV less threshold voltage. It flows whether the logic switches or not (the reason Dennard scaling ended, <a href="#/c/multicore/0">chapter 26</a>),
        and is fought with high-threshold cells off the critical path and power gating, switching an idle block's supply off. The current arrives through a
        <strong>power grid</strong>: wide straps on the top metal layers down to each cell row's VDD and GND rails. Its resistance drops the supply (IR drop)
        and slows the cells far from the pads, so the grid is sized and checked like the timing.</p></details>`,
      widget: clockTreeWidget,
    },
    {
      title: 'A floorplan of our dual-core',
      body: `
        <p>Put it all together: the dual-core of <a href="#/c/multicore/0">chapter 26</a>, sized from its netlist. In the open SkyWater 130 nm process its logic would fill about 0.73 mm × 0.73 mm.
        At 28 nm it shrinks to about 0.2 mm on a side, and then the ring of bond pads, not the logic, sets the die size (pad-limited). Real systems-on-chip are the opposite: billions of transistors, with memories as dense SRAM macros, not flip-flops.</p>
        <p>The open-source flow is real: Yosys (synthesis) and OpenROAD (placement, clock tree, routing) take Verilog like the structural Verilog on every component's Verilog tab and produce
        a layout that SkyWater can manufacture. The next step does it, and its table puts this estimate (each NAND equivalent priced as one NAND2 cell)
        beside the area the cells really took.</p>`,
      widget: floorplanWidget,
    },
    {
      title: 'The real thing',
      body: `
        <p>The same dual-core, exported as Verilog by this site (each core's program ROM becomes an instruction port, as a memory macro would be), and pushed
        through the real open-source flow for SkyWater's 130 nm process: <strong>Yosys</strong> synthesizes it to the sky130 standard-cell library, and
        <strong>OpenROAD</strong> floorplans, places, builds the clock tree, routes and checks it, and <strong>KLayout</strong> merges the cells' layouts
        into the final GDS file, the format a foundry manufactures from (the steps run by OpenROAD-flow-scripts).</p>
        <p>Before the flow ran, the exported Verilog was checked: Yosys's synthesized gate netlist, simulated cycle by cycle, matches this site's own gate-level
        simulation on all four multi-core programs. Colour the cells by block to find the two cores, the shared memory and the arbiter; zoom in until the routing shows.</p>
        <p>The second design is the system CPU of <a href="#/c/traps/0">chapter 20</a> with the M extension: RV32IM, the CSRs, traps and interrupts, its two memories
        outside its ports as SRAM macros would be (checked the same way, on a bench with its ROM and data memory). Under each layout, our own estimates of the same design
        stand beside the flow's: the area if every NAND equivalent were a NAND2 cell, against what the cells took, block by block; our critical path in NAND delays, against
        OpenSTA's in nanoseconds after routing. Their ratio says what one of our unit delays is worth in a real 130 nm layout.</p>
        <div class="try">Switch to the system core: find the block sky130 builds far smaller than our NAND count, and the one it builds larger. Then compare where the two critical paths run.</div>`,
      widget: chipLayoutWidget,
    },
    {
      title: 'Wafers, yield and cost',
      body: `
        <p>The finished design is stepped across a 300 mm wafer hundreds of times. After fabrication every die is tested; random defects kill some. The expected fraction
        of good dies falls exponentially with die area, so cost per good die rises faster than area.</p>`,
      widget: waferWidget,
      challenge: {
        kind: 'quiz', question: 'With D₀ = 0.1 defects/cm², how does the yield of a 100 mm² die compare with a 400 mm² die?',
        options: ['Same yield', '90 % versus 67 %', '90 % versus 23 %', '99 % versus 96 %'], answer: 1,
        why: ['Defects land at random across the wafer, so a bigger die is more likely to catch one.', '', 'Far too steep for 0.1 defects/cm²: a 4 cm² die expects 0.4 defects, and e<sup>−0.4</sup> = 0.67.', 'That takes 100 mm² as 0.1 cm². It is 1 cm², so the expected defect counts are 0.1 and 0.4.'],
        explain: 'e^(−1 cm² × 0.1) = 0.905 and e^(−4 cm² × 0.1) = 0.670. Four times the area means fewer dies per wafer and a lower fraction of them working: the big die costs about 5.4× as much, not 4×. Chiplets split a large design into smaller dies that yield better.',
      },
    },
    hallStep(),
    {
      title: 'The journey',
      body: `
        <p>That is the whole path: a voltage-controlled switch, a NAND, gates, adders, latches, memories, an ALU, a single-cycle RISC-V, a pipeline, interrupts,
        multiplication, caches, microcode, floating point, several instructions a cycle out of order, two cores, and geometry on a wafer. Every value on every wire along the way was computed, not drawn, and every box can still be opened all the way down to
        the four transistors of a NAND.</p>
        <p>The journey goes on with the same bricks arranged for throughput: <a href="#/c/lanes/0">chapters 28–33</a> build a GPU, from lanes sharing
        one instruction stream to a rasterizer drawing into a frame buffer. <a href="#/c/dram/0">Chapters 34–37</a> go below the caches: a DRAM
        cell by cell, its controller, flash, and a bus with DMA that boots a computer from flash. The appendices rebuild a real chip, the
        <a href="#/c/appendix-6502/0">6502</a>, in NMOS transistors, and run <a href="#/c/appendix-doom/0">Doom</a> on the RV32IM system, a window of it
        on the gates.</p>
        <p>Or go further on your own: build it for real on an FPGA from the Verilog tabs; read Harris &amp; Harris, Patterson &amp; Hennessy, or Weste &amp; Harris for CMOS VLSI; or tape out
        a design on an open-source shuttle.</p>`,
      widget: journeyWidget,
      challenge: {
        kind: 'quiz', question: 'What did every component in this course have in common?',
        options: ['Each was written in Verilog first', 'Each was built only from components of the levels below it, down to the NAND and its four transistors, and checked against a specification', 'Each was drawn by hand', 'Each was simulated in analogue'],
        answer: 1,
        why: ['The Verilog on each component\'s tab is generated from its netlist, after the fact.', '', 'The drawings come from the netlists (their layout hints and the router); the netlist is the source.', 'The simulation is digital: 0, 1 and X at gate level, a switch-level solver for transistors.'],
        explain: 'Abstraction with transparency: every level is a box you may use without opening, and every box opens. Specifications, exhaustive tests and the instruction-set simulator kept each level honest.',
      },
    },
  ],
};
