import { groupDigits } from '../sim/numfmt';
import { MUX2 } from '../lib/gates';
import { stats } from '../sim/stats';
import { chipLayoutWidget } from '../widgets/chiplayout';
import { journeyWidget } from '../widgets/journey';
import { cell3d } from '../widgets/cell3d';
import { masks3d } from '../widgets/masks3d';
import { withModel } from '../widgets/modelhost';
import { clockTreeWidget, fabWidget, floorplanWidget, mappingWidget, pnrWidget, waferWidget } from '../widgets/silicon';
import { cabinetCounts, hallFacts, periodIn } from '../lib/hall';
import { eniacRoom, fmtArea, fmtJoules, fmtMass, fmtRate, fmtTime, fmtWatts, RELAY_CONTACTS, RELAY_PLANT_W, TECH, TUBE_PLANT_W, tubeFailEvery } from '../lib/tech';
import { ENIAC, ENIAC_PANEL } from '../phys/triode';
import { RELAY_RACK, Z3 } from '../phys/relay';
import { machineHall } from '../widgets/hall';
import type { Chapter, Step } from './types';
import { numOf } from './order';

const num = (n: number) => groupDigits(Math.round(n));
const times = (x: number) => (x >= 10 ? num(x) : x.toFixed(1));
/** Poisson yield of a die of a mm² at d0 defects per cm². */
const yieldOf = (a: number, d0 = 0.1) => Math.exp(-(a / 100) * d0);
/** Whole 300 mm wafer's gross dies of a mm²: area over die area, less the ring of partial dies at the edge. */
const grossDies = (a: number, wafer = 300) => Math.floor((Math.PI * (wafer / 2) ** 2) / a - (Math.PI * wafer) / Math.sqrt(2 * a));
/** Relative cost per good die, area a against b. */
const costRatio = (a: number, b: number) => (a / b) * (yieldOf(b) / yieldOf(a));

/** "The same CPU in relays and tubes": every number from lib/hall.ts (pricing, layout, static timing), computed the
 *  first time the step is shown or searched (it flattens the RV32I once), not when the chapter loads. */
function hallStep(): Step {
  let text: string | null = null, explain: string | null = null, racks: string | null = null, counts: string | null = null;
  const facts = () => {
    const f = hallFacts('rv32i'), c4 = hallFacts('cpu4'), r = f.relay, t = f.tube;
    const rc = cabinetCounts(r), tc = cabinetCounts(t);
    const pr = periodIn(f.steps, 'relay'), pt = periodIn(f.steps, 'tube'), pc = periodIn(f.steps, 'cmos');
    const dm = r.blocks.find((b) => b.name === 'dm')!, rf = r.blocks.find((b) => b.name === 'rf')!;
    const perBit = dm.nands / (32 * 32);
    text = `
      <p>Nothing in this course needed silicon: every circuit is NANDs, and a NAND can be <span data-ahead="relay">a relay (an electromagnetic switch; prologue P1)</span> or <span data-ahead="triode">a triode (a vacuum tube whose grid voltage switches its current) with two
      diodes (prologue P2)</span>. Here is the single-cycle RV32I of <a href="#/c/cpu/0">chapter ${numOf('cpu')}</a> priced that way, block by block, and stood on a floor at
      physical scale. Its ${num(f.nands)} NANDs (the program ROM left out: relay machines read their programs from film or
      cards) become <strong>${num(r.total.devices)} relays</strong>, ${num(r.total.fanout)} of them extra coils, because a
      relay has ${RELAY_CONTACTS} contacts and many nets feed more inputs than that. At ${RELAY_RACK.relays} to a rack that is
      ${rc.used} racks (${rc.packed} if blocks shared them) and ${fmtMass(r.total.mass!)}:
      ${times(r.total.devices / Z3.relays)} times the Z3's ${num(Z3.relays)} relays. Its coils draw ${fmtWatts(r.total.power!)}; at the Z3's
      ${RELAY_PLANT_W.toFixed(1)} W a relay at the wall (about ${fmtWatts(Z3.power)} for ${num(Z3.relays)}) the machine would draw about ${fmtWatts(r.total.plant!)}.
      In tubes it is <strong>${num(t.total.devices)} tubes</strong> in ${tc.used} panels the size of ENIAC's (${ENIAC_PANEL.tubes} tubes is its average
      panel) and ${fmtMass(t.total.mass!)}: ${times(t.total.devices / ENIAC.tubes)} ENIACs. Their heaters and plates draw ${fmtWatts(t.total.power!)};
      ENIAC drew ${fmtWatts(ENIAC.power)} for ${num(ENIAC.tubes)} tubes, ${TUBE_PLANT_W.toFixed(1)} W a tube with its power supplies and blowers,
      which puts this machine near ${fmtWatts(t.total.plant!)}. At ENIAC's failure rate (one of its tubes every two days) a tube here would
      fail every ${num(tubeFailEvery(t.total.devices))} hours. The 4-bit CPU fits in ${num(c4.relay.total.devices)} relays
      (${cabinetCounts(c4.relay).used} racks).</p>
      <p>The clock period is the same ${f.steps} gate delays as in CMOS, each now a <span data-ahead="relay relaystep">${TECH.relay.stepName} (the time for every relay to settle after an input changes)</span> of ${fmtTime(TECH.relay.step)}
      or a ${TECH.tube.stepName} of ${fmtTime(TECH.tube.step)}: one instruction takes <strong>${fmtTime(pr)}</strong> in relays
      (${(1 / pr).toFixed(2)} instructions a second) and ${fmtTime(pt)} in tubes (${fmtRate(pt)}), against ${fmtTime(pc)} (${fmtRate(pc)}) for the same netlist on
      ${fmtArea(f.cmos.area!)} of silicon (28 nm-class NANDs, ${Math.round(TECH.cmos.step * 1e12)} ps each, faster than the sky130 cells measured earlier),
      the speck on the table by the person. An instruction costs ${fmtJoules(r.total.power! * pr)}
      in relays and ${fmtJoules(t.total.power! * pt)} in tubes, counting the devices alone.</p>
      <p>A relay machine of this size is a building. The cost is not in the logic's cleverness but in counting: every NAND is a device, every bit of
      storage is several, and a relay cannot drive many inputs, so the fan-out adds coils.</p>
      <div class="try">Run the program and watch the relays switch (or the plates glow): each cycle's settled values from the
      gate-level simulation, one relay or tube per NAND output of its block (a real relay machine would ripple through
      ${f.steps} steps to get there). Click a rack to open its block.</div>`;
    racks = `<p>Two blocks fill most of the floor: the register file (${rf.cabinets} racks) and the data memory (${dm.cabinets}), both
      flip-flops of NANDs, ${perBit.toFixed(1)} NANDs per bit of data memory. Racks are not shared between blocks, so every small
      block gets one of its own, and the packed count (${rc.packed} racks) is what a floor plan that shared racks would need.
      In devices: ${num(f.nands)} NAND outputs became ${num(r.total.devices)} relays, ${num(r.total.fanout)} of them extra coils for fan-out beyond ${RELAY_CONTACTS} contacts.</p>`;
    counts = `<p>Tubes and relays are slow and large, not different in kind: the same ${num(f.nands)}-NAND netlist, the same ${f.steps}-step period, priced per device. A relay step is ${fmtTime(TECH.relay.step)},
      a tube step ${fmtTime(TECH.tube.step)}, a CMOS gate delay far below either; the ratio of the three is the ratio of the three eras' clocks.</p>
      <p>The comparisons are rough. The tube step is an R·C estimate: ENIAC itself pulsed at ${ENIAC.pulseHz / 1e3} kHz and added in 200 µs, so this
      clock is faster than ENIAC's own. Our tube count includes a 6AL5 diode tube per NAND where ENIAC used ${num(ENIAC.diodes)} crystal diodes
      and ${num(ENIAC.relays)} relays besides its tubes, so "ENIACs" compares glass envelopes, not machines. The floor counts cabinets and
      aisles: ENIAC's room was ${ENIAC.room} m² (1 800 sq ft) for ${ENIAC_PANEL.count} panels, with its card equipment and plant, so these
      ${tc.used} panels would want about ${num(eniacRoom(tc.used))} m² laid out as it was.</p>`;
    explain = `A flip-flop of NANDs is a master–slave pair of latches: ${perBit.toFixed(1)} NANDs per bit here with the write
      and read logic, each NAND a relay. A relay is already a latch: one of its own contacts in series with its coil holds it
      until the circuit is broken. One relay per bit is how the Z3 kept 64 words in ${num(Z3.memory)} relays, while this data
      memory of 32 words takes ${num(dm.devices)}.`;
  };
  return {
    title: 'The same CPU in relays and tubes',
    get body() { if (text === null) facts(); return text!; },
    widget: machineHall,
    get more() {
      if (racks === null) facts();
      return {
        derive: racks!,
        real: counts!,
        pitfall: `<p>Treating the relay count as a design choice. It follows from the NAND count and the fan-out; a cleverer relay circuit exists (the Z3 stored a bit in one relay) but it is a different design, with a
          different netlist. The price here is the price of this netlist, built brick by brick from NANDs.</p>`,
      };
    },
    challenge: {
      kind: 'quiz',
      question: `The RV32I's 32-word data memory alone fills dozens of racks of <span data-ahead="relay">relays (switches closed by an electromagnet)</span>, yet the Z3 kept 64 words in ${num(Z3.memory)} relays. Why?`,
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
  id: 'silicon', num: numOf('silicon'), title: 'From netlist to silicon', level: 'Physical design',
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
      'Synthesis ends in technology mapping onto a library of hundreds of cells; placement minimizes wire length (annealing in our teaching model, analytic in OpenROAD); routing connects every net (Lee\'s maze router on two layers here, global then detailed routing on five in the real flow). A good placement also leaves room to route.',
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
        <p>The cell is a rectangle of fixed height so that cells abut in rows: the rails line up and the tools can place any cell next to any other. Width is what varies, set by
        how many polysilicon strips the cell needs. Area is therefore counted in tracks: a NAND2 is a few polysilicon pitches wide, the inverter drawn here one pitch fewer, a flip-flop a dozen or more.</p>
        <div class="try">Toggle A and B and watch which channels conduct. Press Section, drag the plane through a gate and read the stack off the cut face: n+, gate oxide, polysilicon, n+. Orbit the cell, hide layers, pull them apart; the Top view is the flat layout.</div>`,
      widget: () => cell3d(),
      more: {
        derive: `<p>Why series transistors are drawn wider. A transistor's drive current is proportional to W / L; two in series have twice the resistance, so to match an inverter's pull-down a NAND2 draws
          each NMOS twice as wide (W = 2). In NOR2 the series pair is PMOS, whose holes are slower (mobility two to three times lower than the electrons'), so they are drawn about four times the inverter's NMOS, and
          the cell is larger for the same speed. The cells drawn above give every device one width, so they show the structure, not the speed matching; a real library widens a device by folding it into several fingers side by side, which is why a speed-matched NOR2, or a higher drive strength, comes out wider, not taller. In transistor count they are equal (four each); our multiplexer, four NANDs, is ${stats(MUX2).transistors} transistors.</p>`,
        real: `<p>A library such as sky130's high-density cells fixes the row height (2.72 µm) and offers each function in several widths, one per drive strength. A drive-strength variant is
          the same logic with transistors in parallel: twice the width for twice the current.</p>`,
        pitfall: `<p>Counting each transistor as a unit of area. A NAND2 and a NOR2 have four each and, sized for the same speed, are not the same size: the width of each device is set by the series stack it sits in, and the cell
          by the larger of its two rows. The viewer draws every device at one width, so compare the two cells' wiring there (series NMOS against series PMOS), not their sizes.</p>`,
      },
    },
    {
      title: 'How chips are made',
      body: `
        <p>The layout is cut into masks, and the wafer goes through the fab mask by mask: deposit, pattern with light, etch or implant, repeat. The masks are not the layout layers one to one. For this cell, in SkyWater's names: <strong>diff</strong> (the active area, whose complement is etched into oxide-filled trenches), <strong>nwell</strong>, <strong>poly</strong>, the implant windows <strong>nsdm</strong> and <strong>psdm</strong> (wider than the diffusion), contacts <strong>licon1</strong> and <strong>mcon</strong>, local interconnect <strong>li1</strong> and <strong>met1</strong>: about nine.
        Lithography sets the smallest feature. Today's leading processes print with 13.5 nm extreme-ultraviolet light.</p>
        <div class="try">Step to the n+ implant, then shift the poly mask: the source and drain follow the gate. Tick <em>implant before the gate</em> and the same shift leaves a channel uncovered on one side and the gate over the drain on the other.</div>
        <p>Most of the cost of a chip is in these repetitions. A whole modern process has dozens of masks, each one a pass through coat, expose, develop, etch or implant and clean; a wafer spends weeks to months in
        the fab, and a single defect on any layer can kill the die it lands on. That is what the yield step prices.</p>`,
      widget: () => withModel(fabWidget(), masks3d()),
      more: {
        derive: `<p>The smallest printable half-pitch is R = k<sub>1</sub> · λ / NA. With EUV light at λ = 13.5 nm, a numerical aperture of 0.33 and a process factor k<sub>1</sub> of about 0.3 that is
          ${(0.3 * 13.5 / 0.33).toFixed(0)} nm. Argon fluoride light (193 nm) with immersion (NA about 1.35) and the same k<sub>1</sub> gives ${(0.3 * 193 / 1.35).toFixed(0)} nm in one exposure, which is why finer features there need
          several exposures per layer.</p>`,
        real: `<p>One company makes EUV scanners, and each is among the most complex machines built. A node's name (7 nm, 5 nm, 3 nm) no longer measures a feature; it is a label for a generation, and
          its transistors are three-dimensional fins or stacked ribbons, not the planar one drawn here.</p>`,
        pitfall: `<p>Reading the node name as the gate length. Of the dimensions that matter, the contacted gate pitch and the metal pitch set the density, and they are several times the node name.
          The self-aligned gate in the question below is what keeps a transistor's source and drain matched to its gate through all of this.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'Why is the gate "self-aligned" to the source and drain?',
        options: ['A robot aligns each transistor', 'The gate is patterned first and itself masks the source/drain implant, so they line up with it automatically', 'Masks are aligned to within one atom', 'Source and drain are drawn on the same mask as the gate'],
        answer: 1,
        why: ['Billions of transistors are patterned at once through masks; nothing places them one by one.', '', 'Mask-to-mask alignment has a real tolerance, and that error is exactly what self-alignment avoids.', 'Diffusion and polysilicon are separate masks. The trick is that the etched gate itself shields the channel during the implant.'],
        explain: 'Implanting after the gate is etched means the channel under the gate is shielded from the source/drain implant while the regions on both sides receive it: the edges match the gate exactly, with no mask-to-mask misalignment. It was one of the inventions that made MOS scaling possible.',
      },
    },
    {
      title: 'A real cell library',
      body: `
        <p>We built everything from one cell. A foundry library has hundreds: inverters, NAND and NOR with 2 to 4 inputs, AND-OR-INVERT, multiplexers, flip-flops,
        each in several drive strengths. <strong>Synthesis</strong> turns Verilog into a netlist of library cells, and its last step, technology mapping, chooses the cheapest
        cells for each piece of logic. Here is the simplest possible mapping, applied to this site's own designs.</p>
        <p>A bigger library means a better cover: a complex gate such as AND-OR-INVERT does in one cell and one stage what takes several NANDs and several delays. The cost is a larger library to
        characterize and a harder covering problem, which synthesis solves with heuristics, not exactly.</p>`,
      widget: mappingWidget,
      more: {
        derive: `<p>Mapping is covering: tile the netlist's gates with library cells so that every gate is inside a cell and the total cost (area, or delay under a constraint) is least. A concrete case: the
          2:1 multiplexer here is four NANDs, ${stats(MUX2).transistors} transistors. A library with an AND-OR-INVERT cell (AOI22, eight transistors) covers the select-and-merge in one stage, and with
          the inverter on the select that is ten for an inverting mux, twelve with an output inverter.</p>`,
        real: `<p>A foundry library has hundreds of cells and each is characterized for delay and power over input slew and output load, tables the tools interpolate. Mapping happens with timing
          in mind: the same function maps to a bigger, faster cell on a critical path and the smallest one elsewhere.</p>`,
        pitfall: `<p>Choosing cells by gate count. A NAND-only netlist counts every function in the same unit, which is the point of this course, but a mapped design is judged in area and picoseconds, and the
          cheapest cell by transistor count is not always the fastest or the smallest in layout.</p>`,
      },
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
        <p>Annealing accepts a worse move with a probability that shrinks as the temperature falls, so early on it wanders (escaping a bad arrangement) and late it only descends. Routing
        cares about two things placement cannot see exactly: how many nets cross each region (congestion) and how many layer changes a path needs, since every via is resistance and a yield risk.</p>
        <div class="try">Pick a circuit, Route it straight from the random placement, then Anneal and Route again: compare the wire length and the vias.</div>`,
      widget: pnrWidget,
      more: {
        derive: `<p>The placer's cost is the sum over nets of the half-perimeter of the box around the net's pins (HPWL). A move that changes the cost by Δ is accepted with probability 1 if Δ ≤ 0 and
          e<sup>−Δ/T</sup> otherwise; T falls geometrically. Lee's router floods outward from the source over free grid cells, one ring a step, until it touches the target, then backtracks the shortest path:
          O(grid cells) a net, always finding a path if one exists and the shortest one.</p>`,
        real: `<p>Production placers solve a smooth approximation over the whole chip at once (analytic placement, as in OpenROAD's global placer), then legalize onto rows. Routers split the job into a coarse global route
          that assigns nets to regions and a detailed route that fixes tracks under design rules. Annealing is where the field started and still serves for small blocks.</p>`,
        pitfall: `<p>Minimizing wire length alone. A placement with the shortest total wire can pile the nets through one channel, and routing then fails or detours. Compare the vias and the unrouted count of the
          two routes, not only the length.</p>`,
      },
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
        grows with the square of the length unless buffers are inserted. The static timing analysis of <a href="#/c/fastadd/0">chapter ${numOf('fastadd')}</a> counted NAND delays only. After routing, the tools
        repeat it with the real wire parasitics and fix the violations (timing closure).</p>
        <p>The most important wire is the clock: it should reach every flip-flop at the same moment. A flip-flop needs its input steady from a
        <strong>setup</strong> time before the capturing edge to a <strong>hold</strong> time after it, and the difference in clock arrival (skew) shifts
        both checks. Setup bounds the slowest path: clock-to-q + logic + setup ≤ period + skew, skew being how much later the capturing flip-flop's clock
        arrives than the launching one's. A capture clock that arrives early costs setup margin, and a slower clock pays it back. Hold bounds the fastest
        path: clock-to-q + the shortest logic ≥ hold + skew. A capture clock that arrives <em>late</em> gives the slow paths time but lets new data race
        down a short path and overwrite the old value before the late edge samples it: a <strong>hold violation</strong>, and no slower clock fixes it,
        since the period is not in the inequality. The tools build the clock tree to keep skew small, then pad the short paths with buffers (hold
        fixing). Our own static timing assumes an ideal clock and checks the setup side only; the flow in "The real thing" repairs and checks both
        on its routed clock tree.</p>`,
      widget: clockTreeWidget,
      more: {
        derive: `<p>Wire delay, to first order (Elmore): a wire of length L has resistance r·L and capacitance c·L, and the delay is about ½ · r · c · L². Doubling the length is ${2 ** 2}× the delay, not 2×.
          Splitting the wire into k segments with a buffer between them gives k · ½ · r · c · (L / k)² = ½ r c L² / k plus k buffer delays: more buffers cut the quadratic term and add a linear one, so
          there is a best k, and the tools find it. The skew inequalities, written out: setup t<sub>cq</sub> + t<sub>logic</sub> + t<sub>setup</sub> ≤ T + skew; hold t<sub>cq</sub> + t<sub>min logic</sub> ≥ t<sub>hold</sub> + skew.</p>`,
        real: `<p>Power is the other thing the clock sets. Every net that switches charges or discharges its capacitance: ½ C V² per toggle, glitches included. That is what the inspector's Power
          section measures, with C estimated from each net's fan-out. Summed, dynamic power is α C V² f, α the fraction of nets rising (0 → 1, so two toggles for a full charge and discharge) per cycle; a clock has α = 1. Wires
          carry much of C, and the clock toggles twice every cycle into every flip-flop, so the clock tree alone often takes a third of a chip's dynamic
          power. <strong>Clock gating</strong> is the cheapest cure: an enable, latched so that it cannot glitch, stops the clock of a register that is
          not being written; synthesis inserts it from enables such as the register file's write enables.</p>
          <p><strong>Leakage</strong> is the other part: an off transistor still conducts a little, a current that grows about tenfold for every 60 to
          100 mV less threshold voltage. It flows whether the logic switches or not (the reason Dennard scaling ended, <a href="#/c/multicore/0">chapter ${numOf('multicore')}</a>),
          and is fought with high-threshold cells off the critical path and power gating, switching an idle block's supply off. The current arrives through a
          <strong>power grid</strong>: wide straps on the top metal layers down to each cell row's VDD and GND rails. Its resistance drops the supply (IR drop)
          and slows the cells far from the pads, so the grid is sized and checked like the timing.</p>`,
        pitfall: `<p>Fixing a failing hold check by slowing the clock. The period T appears only in the setup inequality; a hold violation is a race between the same edge and the new data, and stays however slow the
          clock runs. The cure is delay on the short path (buffers) or less skew. Setup failures are the ones a lower clock rate repairs.</p>`,
      },
    },
    {
      title: 'A floorplan of our dual-core',
      body: `
        <p>Put it all together: the dual-core of <a href="#/c/multicore/0">chapter ${numOf('multicore')}</a>, sized from its netlist. In the open SkyWater 130 nm process its logic would fill about 0.73 mm × 0.73 mm.
        At 28 nm it shrinks to about 0.2 mm on a side, and then the ring of bond pads, not the logic, sets the die size (pad-limited). Real systems-on-chip are the opposite: billions of transistors, with memories as dense SRAM macros, not flip-flops.</p>
        <p>The open-source flow is real: Yosys (synthesis) and OpenROAD (placement, clock tree, routing) take Verilog like the structural Verilog on every component's Verilog tab and produce
        a layout in SkyWater's process. The next step does it, and its table puts this estimate (each NAND equivalent priced as one NAND2 cell)
        beside the area the cells really took.</p>
        <p>A floorplan is the first step of physical design: the shape of the die, where the blocks go and where the pins come out. Blocks that talk a lot are put side by side, and wide buses
        decide the aspect ratio. The estimate is rough both ways: every NAND priced as one NAND2 cell overstates what a real library needs (complex cells do several NANDs' work), and leaving 30 % of the floor to the router is an assumption. The next step measures both.</p>`,
      widget: floorplanWidget,
      more: {
        derive: `<p>Scaling the logic between processes: linear dimensions scale with the feature size F, area with F². From 130 nm to 28 nm that is (28 / 130)² = ${((28 / 130) ** 2).toFixed(3)} of the area, a side of
          ${(28 / 130).toFixed(2)} of the original. Bond pads do not scale with it: they are sized by the wire that is bonded to them and the probe that touches them, tens of micrometres, so below some logic size
          the pad ring is the die. Ideal scaling would give 0.16 mm; the widget takes about 0.3 µm² a NAND2 at 28 nm, less than F² scaling, hence about 0.2 mm.</p>`,
        real: `<p>A system-on-chip is mostly memory: SRAM macros, caches, register files, generated by a compiler for the process, and the logic around them. Our estimate counts flip-flops built from NANDs,
          which is far from a dense SRAM cell, and that is why a real core's area is dominated by what this model leaves out.</p>`,
        pitfall: `<p>Reading the estimate as a floor-plan prediction. It is the sum of NAND2-priced cell areas at an assumed 70 % utilization, leaving 30 % for routing and buffers. Compare the next step's
          table: the cells are smaller than priced, and that flow is set to 35 % core utilization.</p>`,
      },
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
        <p>The second design is the system CPU of <a href="#/c/traps/0">chapter ${numOf('traps')}</a> with the M extension: RV32IM, the CSRs, traps and interrupts, its two memories
        outside its ports as SRAM macros would be (checked the same way, on a bench with its ROM and data memory). Under each layout, our own estimates of the same design
        stand beside the flow's: the area if every NAND equivalent were a NAND2 cell, against what the cells took, block by block; our critical path in NAND delays, against
        OpenSTA's in nanoseconds after routing. Their ratio says what one of our unit delays is worth in a real 130 nm layout.</p>
        <div class="try">Switch to the system core: find the block sky130 builds far smaller than our NAND count, and the one it builds larger. Then compare where the two critical paths run.</div>
        <p>What the table checks is the model. Our NAND count, our unit delay and our hierarchy came from a course that never mentioned a layout; here the same design is measured on silicon rules. The agreement is
        approximate, and the gaps are the finding: they say which of our simplifications (a NAND as the only cell, a gate delay as the only delay, wires as free) cost the most.</p>`,
      widget: chipLayoutWidget,
      more: {
        derive: `<p>The conversion between the two timing scales: if the real critical path takes t ns after routing and ours is d unit delays, one of our delays is worth t / d in that process. Applied to every
          path of the design it predicts how fast the design would run if the unit-delay model held; the difference from the measured path is the cost of wires and load, which a unit-delay model does not carry.</p>`,
        real: `<p>This is the open-source flow, used for research and shuttle tape-outs; large commercial chips go through commercial tools (Synopsys, Cadence, Siemens) doing the same steps: synthesis, floorplan, placement, clock tree, routing, timing signoff. Its pieces: Yosys for synthesis, OpenROAD for floorplan, placement, clock tree and routing, OpenSTA for timing, KLayout for the layout. The
          sky130 process is a real 130 nm technology that a foundry runs for shuttle programs, so a design like this, inside a padded harness such as the open shuttles' Caravel, could go to fabrication; this GDS is the core block alone, with no pad ring and its memories outside its ports.</p>`,
        pitfall: `<p>Reading the area ratio as an error. Where sky130 is smaller than our count, a complex cell replaced several NANDs; where larger, Yosys spent big cells on adders (half-adder cells) and buffered heavily loaded nets, which our count has no price for.
          Neither is a mistake in either; they are two different questions, how many NANDs and how large the cells, and the table shows how far apart they are.</p>`,
      },
    },
    {
      title: 'Wafers, yield and cost',
      body: `
        <p>The finished design is stepped across a 300 mm wafer hundreds of times. After fabrication every die is tested; random defects kill some. The expected fraction
        of good dies falls exponentially with die area, so cost per good die rises faster than area.</p>
        <p>Two effects stack. A bigger die yields fewer to the wafer, because the circle's edge wastes more of it, and a smaller share of those work. Designers answer both ways: smaller dies where
        possible, redundancy (spare rows and columns in memories, disabled cores sold as a cheaper part), and splitting a design into chiplets that are tested before they are joined.</p>`,
      widget: waferWidget,
      more: {
        derive: `<p>With defects falling at random at D<sub>0</sub> per cm², a die of area A catches on average A · D<sub>0</sub> of them, and the probability of none is Y = e<sup>−A·D<sub>0</sub></sup> (Poisson).
          At D<sub>0</sub> = 0.1: Y(100 mm²) = ${(100 * yieldOf(100)).toFixed(0)} %, Y(400 mm²) = ${(100 * yieldOf(400)).toFixed(0)} %. A 300 mm wafer holds about ${grossDies(100)} dies of 100 mm² and ${grossDies(400)} of 400 mm² (area ratio
          less the edge). Cost per good die ∝ A / Y: the 400 mm² die costs ${costRatio(400, 100).toFixed(1)} times the 100 mm² one by the yield alone, more with the edge loss.</p>`,
        real: `<p>Mature processes run at defect densities well below 0.1 per cm², and fabs quote Murphy or negative-binomial models, which clump defects and yield better than Poisson for large dies. The
          shape of the argument is unchanged: cost rises faster than area, and big dies are expensive.</p>`,
        pitfall: `<p>A unit slip. 100 mm² is 1 cm², not 0.1: with the defect density per cm² the expected defects are A / 100 · D<sub>0</sub>. Using 0.1 cm² for 100 mm² gives a yield near 100 % and a cost ratio of 4, the answer people give before they apply the
          exponential; using the mm² number directly gives e<sup>−10</sup>, near 0 %.</p>`,
      },
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
        <p>First, <a href="#/c/power/0">chapter ${numOf('power')}</a> measures what all of this costs in energy, toggle by toggle, and how a chip spends less.
        The journey then goes on with the same bricks arranged for throughput: <a href="#/c/lanes/0">chapters ${numOf('lanes')}</a>–${numOf('graphics')} build a GPU, from lanes sharing
        one instruction stream to a rasterizer drawing into a frame buffer. <a href="#/c/dram/0">Chapters ${numOf('dram')}</a>–${numOf('bus')} go below the caches: a DRAM
        cell by cell, its controller, flash, and a bus with <span data-ahead="dma">DMA (a device that copies memory blocks without the CPU)</span> that boots a computer from flash. Chapters <a href="#/c/telegraph/0">${numOf('telegraph')}</a>–<a href="#/c/datacentre/0">${numOf('datacentre')}</a> take the machine out of the box (wires and clocks, UARTs, modems, error codes, Ethernet, networks, radio) and chapters <a href="#/c/fixed/0">${numOf('fixed')}</a>–<a href="#/c/sdr/0">${numOf('sdr')}</a> process the signals in fixed-point arithmetic, down to a DSP core. The appendices rebuild a real chip, the
        <a href="#/c/appendix-6502/0">6502</a>, in NMOS transistors, and run <a href="#/c/appendix-doom/0">Doom</a> on the RV32IM system, a window of it
        on the gates.</p>
        <p>Or go further on your own: build it for real on an FPGA from the Verilog tabs; read Harris &amp; Harris, Patterson &amp; Hennessy, or Weste &amp; Harris for CMOS VLSI; or tape out
        a design on an open-source shuttle.</p>
        <p>What carried through was one discipline: a block is described by its ports and its behaviour, built from smaller blocks, and checked against that description at every level. The abstraction
        was never opaque, which is why the same page that shows a CPU also shows the four transistors of a NAND, and why the numbers at the bottom (transistors, delays, energy) add up at the top.</p>`,
      widget: journeyWidget,
      more: {
        pitfall: `<p>Taking the model for the chip. Everything here is digital: 0, 1 and unknown, a delay per gate, a toggle energy. A real chip adds analogue behaviour (noise, variation, leakage, thermal
          limits) and the physical design the last steps sketched. The model is exact for what it says and silent on the rest.</p>`,
        real: `<p>The same course of abstraction is how real teams work: a specification, a model (a simulator in C++ or Python), RTL, verification against the model, synthesis, physical design, signoff. The
          tools differ; the layers and the checking at each are the ones traversed here.</p>`,
      },
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
