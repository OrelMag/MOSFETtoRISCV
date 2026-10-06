import { journeyWidget } from '../widgets/journey';
import { clockTreeWidget, fabWidget, floorplanWidget, layoutWidget, mappingWidget, pnrWidget, waferWidget } from '../widgets/silicon';
import type { Chapter } from './types';

export const chSilicon: Chapter = {
  id: 'silicon', num: 25, title: 'From netlist to silicon', level: 'Physical design',
  blurb: 'Standard cells in layout, how they are made, technology mapping, place and route, the clock tree, a floorplan of our dual-core, and wafer economics.',
  steps: [
    {
      title: 'Gates become geometry',
      body: `
        <p>Every netlist on this site ends in NANDs, and every NAND in four transistors. On the chip a transistor is simply where a strip of
        <strong>polysilicon</strong> crosses a region of <strong>diffusion</strong>. A standard cell lines them up between a VDD rail at the top and a GND rail at the bottom:
        PMOS transistors in the n-well above, NMOS below, metal connecting them.</p>
        <p>Compare NAND2 and NOR2: in the NAND the NMOS are in series (no contact between the two gates) and the PMOS in parallel; the NOR is the mirror image.
        Since holes are slower than electrons, series PMOS (the NOR) must be drawn wider to be as fast, which is one reason NAND is the preferred universal gate.</p>
        <div class="try">Toggle A and B and watch which channels conduct. Hide layers to see what is underneath.</div>`,
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
        <div class="try">Pick a circuit, Route it straight from the random placement, then Anneal and Route again: compare the wire length and the vias.</div>`,
      widget: pnrWidget,
      challenge: {
        kind: 'quiz', question: 'Why does a better placement make routing easier, not just shorter?',
        options: ['It does not', 'Shorter nets use fewer tracks, so fewer nets compete for the same routing resources and fewer fail', 'The router is faster on small grids', 'Annealing also routes the nets'],
        answer: 1,
        explain: 'Every routed segment blocks a track for all other nets. A placement with long, crossing nets congests the channels; an annealed placement leaves room. Real tools estimate congestion during placement for exactly this reason.',
      },
    },
    {
      title: 'Wires and the clock',
      body: `
        <p>On a modern chip, wires and not transistors dominate delay and power. A long wire has resistance and capacitance proportional to its length, so its delay
        grows with the square of the length unless buffers are inserted. The static timing analysis of chapter 15 counted NAND delays only. After routing, the tools
        repeat it with the real wire parasitics and fix the violations (timing closure).</p>
        <p>The most important wire is the clock: it must reach every flip-flop at the same moment. Any difference (skew) has to be subtracted from the clock period.</p>`,
      widget: clockTreeWidget,
    },
    {
      title: 'A floorplan of our dual-core',
      body: `
        <p>Put it all together: the dual-core of chapter 24, sized from its netlist. In the open SkyWater 130 nm process its logic would fill about 0.73 mm × 0.73 mm.
        At 28 nm it shrinks to about 0.2 mm on a side, and then the ring of bond pads, not the logic, sets the die size (pad-limited). Real systems-on-chip are the opposite: billions of transistors, with memories as dense SRAM macros, not flip-flops.</p>
        <p>The open-source flow is real: Yosys (synthesis) and OpenROAD (placement, clock tree, routing) take Verilog like the structural Verilog on every component's Verilog tab and produce
        a layout that SkyWater can manufacture.</p>`,
      widget: floorplanWidget,
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
        explain: 'e^(−1 cm² × 0.1) = 0.905 and e^(−4 cm² × 0.1) = 0.670. Four times the area means fewer dies per wafer and a lower fraction of them working: the big die costs about 5.4× as much, not 4×. Chiplets split a large design into smaller dies that yield better.',
      },
    },
    {
      title: 'The journey',
      body: `
        <p>That is the whole path: a voltage-controlled switch, a NAND, gates, adders, latches, memories, an ALU, a single-cycle RISC-V, a pipeline, interrupts,
        multiplication, caches, microcode, floating point, two cores, and geometry on a wafer. Every value on every wire along the way was computed, not drawn, and every box can still be opened all the way down to
        the four transistors of a NAND.</p>
        <p>Where to go next: build it for real on an FPGA from the Verilog tabs; read Harris &amp; Harris, Patterson &amp; Hennessy, or Weste &amp; Harris for CMOS VLSI; or tape out
        a design on an open-source shuttle.</p>`,
      widget: journeyWidget,
      challenge: {
        kind: 'quiz', question: 'What did every component in this course have in common?',
        options: ['Each was written in Verilog first', 'Each was built only from components of the levels below it, down to the NAND and its four transistors, and checked against a specification', 'Each was drawn by hand', 'Each was simulated in analogue'],
        answer: 1,
        explain: 'Abstraction with transparency: every level is a box you may use without opening, and every box opens. Specifications, exhaustive tests and the golden model kept each level honest.',
      },
    },
  ],
};
