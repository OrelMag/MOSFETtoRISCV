import { groupDigits } from '../sim/numfmt';
import { LUT4, SLICE } from '../lib/fpga';
import { FULL_ADDER } from '../lib/combinational';
import { BOARD } from '../editor/fpga';
import { bsramFor, COMPUTER, COSTS, COUNTER, coverOf, COVER_IDS, block, fabricBits, kSweep, lutConfigBits, lutCost, nandsPerLut, pathShares, pct, ramAsFlipFlops, RAM_BITS, RAM_WORDS, ROM_WORDS } from '../fpga/facts';
import { flowWidget, lutCoverPanel, lutProgramWidget, pathWidget, reportWidget, switchBoxWidget } from '../widgets/fpga';
import type { Chapter } from './types';
import { numOf } from './order';

const num = (n: number) => groupDigits(Math.round(n));
const C = COMPUTER, D = C.device, ST = C.lut4Stages;
const rf = block('cpu.rf'), ram = block('mem.ram');
const divHz = BOARD.clockMHz * 1e6 / 2 ** BOARD.divLog2;

export const chFpga: Chapter = {
  id: 'fpga', num: numOf('fpga'), title: 'From netlist to FPGA', level: 'Physical design',
  blurb: 'Look-up tables, covering a netlist with them, the logic cell and its carry chain, routing switches, block RAM, and our RISC-V computer placed and routed on a Tang Nano 9K, measured against our own estimates.',
  goals: [
    'explain why a look-up table can compute any function of its inputs, and what it costs in multiplexers and configuration bits',
    'cover a gate netlist with 4-input LUTs and say what sets the number of LUTs and of levels',
    'read a place-and-route report: device use, where the LUTs went, the critical path split into logic and routing',
    'say when an FPGA beats a custom chip and when it does not',
  ],
  builds: ['routing', 'memory', 'adders', 'silicon'],
  recap: {
    keep: [
      `A k-input look-up table is a 2<sup>k</sup>-bit memory read by its inputs: any function of k inputs, at the cost of a 2<sup>k</sup>:1 multiplexer (${lutCost(4).nands} NANDs for k = 4) and 2<sup>k</sup> configuration bits.`,
      'Mapping covers the netlist with cones of at most k inputs; the depth in LUT levels sets the delay, so mappers find the least depth first and then save LUTs off the critical path. A gate may be copied into several LUTs.',
      'A logic cell puts a flip-flop and a carry chain beside the LUT: arithmetic and registers cost no extra LUTs, if the tools see an adder. A netlist of gates is mapped to LUTs instead.',
      `Routing is pass switches held by configuration bits. On our computer's slowest path routing took ${pathShares().routingPct} % of the time, logic ${pathShares().logicPct} %: on an FPGA the wires set the clock.`,
      `Large memories go to block RAM (${D.bsram.used} blocks for our ${RAM_WORDS * RAM_BITS / 1024} Kbit of RAM and ${ROM_WORDS * 32 / 1024} Kbit of ROM); a memory read from many ports at once, like the register file, stays in flip-flops and LUTs.`,
    ],
    practise: [],
    check: [
      {
        question: 'A 4-input LUT is configured as 0x8000. What does it compute?',
        options: ['a AND b AND c AND d', 'a OR b OR c OR d', 'NOT a', 'Nothing: the configuration is invalid'],
        answer: 0,
        explain: 'Bit 15 is the only 1, and address 15 is a = b = c = d = 1.',
        why: ['', 'OR would be 1 everywhere but address 0: 0xFFFE.', 'NOT a is 1 at every even address: 0x5555.', 'Every 16-bit pattern is some function of four inputs; this one is the AND.'],
      },
      {
        question: 'Why can one gate end up inside two LUTs after mapping?',
        options: ['Copying it lets each LUT take its whole cone in one level, and a copy costs nothing inside a LUT', 'The mapper made a mistake', 'Every gate is always copied twice for safety'],
        answer: 0,
        explain: 'A LUT\'s cost does not depend on what is inside it. When two outputs both need a gate, copying it can save a LUT level, so a depth-first mapper duplicates it.',
        why: ['', 'It is deliberate: the mapped circuit is checked against the gates.', 'Only gates on shared cones are copied, and only when it helps the depth or the count.'],
      },
      {
        question: 'On an FPGA, what usually takes most of a critical path\'s delay?',
        options: ['The routing between LUTs', 'The LUTs themselves', 'The flip-flops\' clock-to-q'],
        answer: 0,
        explain: 'A signal crosses several programmable switches and long tracks between LUTs. On our computer\'s slowest path that was more than half the time.',
        why: ['', 'The LUTs are fast and few on a path; the wires between them pass switch after switch.', 'Clock-to-q is paid once per path, under half a nanosecond here.'],
      },
    ],
  },
  steps: [
    {
      title: 'Hardware you can rewrite',
      body: `
        <p>The last chapter took a netlist to masks: months in a fab, and the circuit is fixed forever. A <strong>field-programmable gate array</strong> (FPGA) turns that around. It is a chip
        made once, in large numbers, holding thousands of small configurable blocks and a grid of wires with switches at the crossings. What circuit it is depends on about ${(fabricBits() / 1e6).toFixed(1)} million
        <strong>configuration bits</strong> loaded at power-on, the <strong>bitstream</strong>. Load another and it is another circuit.</p>
        <p>The sandbox already makes the input: File ▸ Export Verilog for FPGA writes the design and a board top for a ${COSTS.board}, a small board with a Gowin ${BOARD.family} chip.
        This chapter follows that file through the open tools, Yosys and nextpnr, and puts every number they report beside our own estimates from the NAND netlist.</p>
        <p>The price of the flexibility is size and speed: a configurable block does what a few gates do, with far more transistors, and every wire passes switches. The steps below build the
        block, count what it costs, and then measure the whole computer.</p>`,
      widget: flowWidget,
      more: {
        real: `<p>An FPGA of the ${BOARD.family}'s class holds about ${num(D.lut4.available / 1000)} thousand logic blocks; the largest parts hold millions, plus multipliers, memories and fast serial links.
          Most products that ship in thousands rather than millions use FPGAs: the mask set for a modern process costs more than all the FPGAs they would ever buy.</p>`,
        pitfall: `<p>Calling Verilog a program the FPGA runs. Nothing is executed: the bitstream sets switches and table entries once, and from then on it is a circuit, every part working at once, like the
          ones drawn in this course.</p>`,
      },
    },
    {
      title: 'A look-up table is a memory',
      body: `
        <p>Here is the FPGA's logic block, a <strong>look-up table</strong> (LUT): 16 configuration bits on <code>cfg</code> and a 16:1 multiplexer whose select is the four inputs <code>i</code>. The inputs do
        not go through any logic: they form an address, and the bit stored at that address is the output. Store a function's truth table and the LUT computes that function, whatever it is.</p>
        <p>Open the multiplexer: fifteen 2:1 multiplexers in four levels, the multiplexer tree of <a href="#/c/routing/0">chapter ${numOf('routing')}</a>. It costs ${lutCost(4).nands} NANDs whatever function it holds,
        and in a real FPGA each configuration bit is a small memory cell besides. A 2-input AND drawn from NANDs is two of them.</p>
        <div class="try">Set <code>cfg</code> so that y = i[0] XOR i[1], whatever i[2] and i[3] are. Then change <code>i</code> and watch the selected bit travel through the tree.</div>`,
      scene: () => ({ root: LUT4, inputs: { i: 0b0001, cfg: 0x8000 } }),
      lit: '',
      challenge: {
        kind: 'reach', goal: 'Configure the LUT as a 2-input XOR of i[0] and i[1], ignoring i[2] and i[3].',
        check: (st) => st.getInput('cfg') === 0x6666,
        hints: [
          'Write the 4-row truth table of XOR first: addresses 0, 1, 2, 3 hold 0, 1, 1, 0.',
          'i[2] and i[3] must not matter, so the same four bits repeat in each group of four: 0110 0110 0110 0110, read with bit 0 on the right.',
        ],
        answer: 'cfg = 0x6666: bits 1, 2, 5, 6, 9, 10, 13, 14 set. Each group of four addresses holds XOR\'s table 0, 1, 1, 0.',
        solve: (st) => st.setInputs({ cfg: 0x6666 }),
      },
    },
    {
      get body() {
        const sweep = kSweep();
        return `
        <p>Every function of four inputs is one of 2<sup>16</sup> = ${num(2 ** 16)} truth tables, and the LUT holds any of them for the same cost. Type a function below, or click the stored bits, and see that the
        circuit never changes: only the bits do.</p>
        <p>Why four inputs? Each input more doubles the table and the multiplexer, while a LUT covers more of the circuit. Mapping our 16-bit ALU (${num(coverOf('alu16').nands)} NANDs) at each size:</p>
        <table class="cmp"><thead><tr><th>k</th><th>LUTs</th><th>levels</th><th>NANDs a LUT</th><th>bits a LUT</th></tr></thead><tbody>
        ${sweep.map((r) => `<tr><td>${r.k}</td><td class="num">${num(r.luts)}</td><td class="num">${r.levels}</td><td class="num">${r.muxNands}</td><td class="num">${r.bits}</td></tr>`).join('')}
        </tbody></table>
        <p>From two inputs to four the LUT count falls by ${pct(sweep[0].luts - sweep[2].luts, sweep[0].luts)} % and the levels by ${pct(sweep[0].levels - sweep[2].levels, sweep[0].levels)} %; from four to six only by
        ${pct(sweep[2].luts - sweep[4].luts, sweep[2].luts)} % and ${pct(sweep[2].levels - sweep[4].levels, sweep[2].levels)} %, while each LUT costs ${(sweep[4].muxNands / sweep[2].muxNands).toFixed(1)} times as much. Four inputs is the classic
        balance (the ${BOARD.family} uses it); the largest FPGAs today use six, with an output split into two smaller functions so a small one does not waste the whole table.</p>`;
      },
      title: 'Any function of four inputs',
      widget: lutProgramWidget,
      challenge: {
        kind: 'quiz', question: 'A function of five inputs must run on 4-input LUTs. What is the least it can need?',
        options: ['Two LUTs and a 2:1 multiplexer, or three LUTs', 'One LUT', 'Sixteen LUTs'],
        answer: 0,
        explain: 'Split on the fifth input: one LUT for each half of the table, and the fifth input picks between them. The Gowin cell has that multiplexer built in (MUX2_LUT5); without it a third LUT does the picking.',
        why: ['', 'Five inputs make 32 table entries; a LUT4 holds 16.', 'Each LUT halves what is left; two halves of 16 entries are enough.'],
      },
    },
    {
      get body() {
        const fa = coverOf('full_adder'), r4 = coverOf('rca4');
        return `
        <p>A synthesis tool turns the design into LUTs by <strong>covering</strong>: every gate must sit inside some LUT, and each LUT may take at most four signals from outside. A LUT's cost does not
        depend on what it holds, so the aim is few LUTs and, above all, few levels of them, since every level is a LUT delay and a trip through the routing.</p>
        <p>The full adder of <a href="#/c/adders/0">chapter ${numOf('adders')}</a> is ${fa.nands} NANDs, ${fa.depth} gate delays deep. Its outputs depend on three inputs each, so it needs ${fa.luts} LUTs and ${fa.levels} level.
        Click a LUT in the panel to light the gates it replaces: some gates sit in both, copied, because a copy inside a LUT is free.</p>
        <table class="cmp"><thead><tr><th>circuit</th><th>NANDs</th><th>gate delays</th><th>LUT4s</th><th>LUT levels</th></tr></thead><tbody>
        ${COVER_IDS.map((id) => { const c = coverOf(id); return `<tr><td>${c.name}</td><td class="num">${num(c.nands)}</td><td class="num">${c.depth}</td><td class="num">${num(c.luts)}</td><td class="num">${c.levels}</td></tr>`; }).join('')}
        </tbody></table>
        <p>The 4-bit ripple adder shows the trade. One carry LUT per bit would ripple through four levels in ${2 * 4} LUTs; the mapper finds the least depth first, ${r4.levels} levels, and
        pays ${r4.luts - 8} more LUTs for it, by computing some carries straight from the inputs. Our mapper is this site's own (sim/lutmap.ts, priority cuts with area recovery); its result is checked against
        the gates for every input.</p>`;
      },
      title: 'Covering a netlist with LUTs',
      scene: () => ({ root: FULL_ADDER, inputs: { a: 1, b: 0, cin: 1 }, panels: [lutCoverPanel()] }),
      lit: '',
      more: {
        derive: `<p>The mapper enumerates <em>cuts</em>: for each net, sets of at most k nets that decide it. A gate's cuts are the merged cuts of its inputs, kept if they have no more than k leaves, so a net
          has few enough to keep the best dozen. Each net's best cut is the one whose leaves arrive earliest (depth), and then, off the critical path, the one with the least area flow: LUTs shared out
          among the nets that use them. The LUTs are read back from the outputs, taking each net's chosen cut.</p>`,
        pitfall: `<p>Counting NANDs to estimate LUTs. A LUT holds anything of four inputs: a ${num(coverOf('mux16x1').nands)}-NAND multiplexer and a single XOR both fill whole LUTs. What counts is how many
          signals each output depends on.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'Why does the full adder need two LUTs although it has only three inputs?',
        options: ['A LUT has one output, and the adder has two', 'Nine NANDs are too many for one LUT', 'The carry depends on more than four inputs'],
        answer: 0,
        explain: 'Each output is a function of a, b and cin, which fits in one LUT, but each LUT makes one output: sum and carry take one each.',
        why: ['', 'A LUT\'s size limit is its inputs, not the gates inside.', 'The carry depends on a, b and cin only.'],
      },
    },
    {
      title: 'The logic cell',
      body: `
        <p>An FPGA's cell is more than a LUT. Here is one in the shape of the ${BOARD.family}'s: the LUT4, a <strong>flip-flop</strong> on its output, and a <strong>carry chain</strong>: two gates that pass
        a carry straight to the next cell. With <code>arith</code> = 1 the LUT computes the propagate p = a XOR b, the output is p XOR cin, and the carry out is cin when p = 1 and a otherwise (when a = b,
        the carry is a). One cell per bit, and the carry crosses each cell through one multiplexer, not a LUT and the routing.</p>
        <p>With <code>reg</code> = 1 the output comes from the flip-flop: a register costs no extra cell. Registers and adders are almost free beside the LUTs, but only if the tools can see them.
        Our exported adders are NAND netlists, and Yosys maps those gate by gate to LUTs: the ${D.alu.used} carry-chain cells our computer uses are the board top's own <code>+ 1</code> counter, which divides
        the clock. Written as <code>a + b</code> in Verilog, the CPU's adders would ride the chain.</p>
        <div class="try">With cin = 1, make both the sum (y) and the carry out 1.</div>`,
      scene: () => ({ root: SLICE, inputs: { i: 0b0010, cfg: 0x6666, cin: 0, arith: 1, reg: 0 }, autoClock: false }),
      challenge: {
        kind: 'reach', goal: 'With cin = 1 and the cell in adder mode (cfg = 0x6666, arith = 1), make y = 1 and cout = 1.',
        check: (st) => st.getInput('cin') === 1 && st.getInput('arith') === 1 && st.getInput('reg') === 0 && st.getInput('cfg') === 0x6666 && st.value('y') === 1 && st.value('cout') === 1,
        hints: ['The sum is a XOR b XOR cin: with cin = 1 it is 1 when a = b.', 'The carry is 1 when at least two of a, b, cin are 1.'],
        answer: 'a = b = 1 (i = 0011) with cin = 1: 1 + 1 + 1 = 11 in binary, sum 1 and carry 1.',
        solve: (st) => st.setInputs({ i: 0b0011, cin: 1, arith: 1, reg: 0, cfg: 0x6666 }),
      },
    },
    {
      title: 'The wires are switches',
      body: `
        <p>Between the cells run tracks of metal, and where tracks meet sits a <strong>switch box</strong>: a pass switch between each pair, each one a transmission gate (an NMOS and a PMOS side by side,
        on together or off together) held by one configuration bit. A connection across the chip is a path of tracks joined by switches the bitstream closed.</p>
        <p>Each closed switch adds resistance, and every open one still loads the track with its capacitance. That is the FPGA's real cost. On our computer's slowest path the signal spent
        ${pathShares().routing.toFixed(1)} ns in routing against ${pathShares().logic.toFixed(1)} ns in the cells. The tools also add LUTs that do no logic: a Gowin flip-flop takes its input only from the LUT
        beside it, so a flip-flop fed from elsewhere gets a pass-through LUT. Our computer has ${num(ST.passthrough)} of them, ${pct(ST.passthrough, ST.routed)} % of its LUTs.</p>
        <div class="try">Close switches so the west track reaches north and east but not south. How many bits did it take?</div>`,
      widget: switchBoxWidget,
      more: {
        real: `<p>Real routing is hierarchical: short tracks to the neighbours, longer ones that skip several cells, and a few chip-wide ones for clocks and resets. A connection uses the fewest switches
          the router can find, and the router trades the timing of the critical nets against congestion everywhere else, as on a custom chip.</p>`,
        pitfall: `<p>Reading the logic levels as the delay. On an FPGA a LUT level is quick; the trip to the next LUT is not, and a long net or a crowded region can cost more than several LUTs.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'Why are the routing\'s switches transmission gates rather than a single NMOS?',
        options: ['An NMOS passes a weak 1, a threshold below VDD; the PMOS beside it passes the 1 fully', 'A single NMOS cannot be turned off', 'Transmission gates need no configuration bit'],
        answer: 0,
        explain: 'An NMOS stops conducting as its source rises to within a threshold of its gate, so a 1 arrives weak. The PMOS conducts best exactly there; together they pass both levels.',
        why: ['', 'Its gate at 0 turns it off like any NMOS.', 'Each switch is still held on or off by one bit; the inverter makes the PMOS\'s gate from it.'],
      },
    },
    {
      get body() {
        const rff = ramAsFlipFlops();
        return `
        <p>Here is the result for the sandbox's computer (Examples ▸ Computer: the single-cycle RV32I with a 1K-word program ROM, ${RAM_WORDS / 1024}K words of RAM, a screen and devices).
        Our NAND netlist has ${num(C.ours.nands)} NANDs; Yosys made ${num(ST.synth)} LUTs, ${nandsPerLut().toFixed(1)} NANDs a LUT, and after placement and routing it fills ${pct(D.lut4.used, D.lut4.available)} % of the
        chip's ${num(D.lut4.available)} LUTs. Our own mapping of the same netlist gives ${num(C.ours.lutMapLuts)}.</p>
        <p><strong>Memories</strong>: the RAM is ${num(RAM_WORDS * RAM_BITS)} bits. As flip-flops that would be ${rff.times.toFixed(0)} times all the chip has. The ${BOARD.family} holds ${D.bsram.available} <strong>block RAMs</strong>
        of 16 Kbit each, real memory arrays beside the logic: the RAM takes ${bsramFor(RAM_WORDS, RAM_BITS)} and the ROM ${bsramFor(ROM_WORDS, 32)}, the ${D.bsram.used} the report shows. A block RAM reads through a register
        on a clock edge, which is why the export adds the memory clock (the board's ${BOARD.clockMHz} MHz) beside the design's.</p>
        <p>The register file did not go into block RAM: it is read on two ports and written on a third in the same cycle, and its register x0 is a constant. It stays as ${num(rf.ffs)} flip-flops
        (31 × 32) and ${num(rf.luts)} LUTs of read multiplexers and write decoding, the largest block by name. Read the other names with care: Yosys names a LUT after the net it drives, and ${num(ram.luts)} LUTs
        under <code>mem.ram</code> are the logic that feeds the RAM's sampled address and data: mostly the register file's read port for the store data, named after the register where its result ends.</p>
        <p>The <strong>configuration</strong>: Apycula's packer writes the bitstream as frames of ${num(COUNTER.bitstream.frameBits)} bits. The counter's, with no memory contents, is ${num(COUNTER.bitstream.frames)} frames,
        ${num(fabricBits())} bits for the fabric; the LUTs' tables are ${num(lutConfigBits())} of them (${num(D.lut4.available)} × 16), ${pct(lutConfigBits(), fabricBits())} %. The rest
        sets the routing switches, the cells' modes and the clocks. The computer's bitstream adds ${num(C.bitstream.frames - COUNTER.bitstream.frames)} frames for its block RAMs' contents, the program among them.</p>`;
      },
      title: 'Our computer on a Tang Nano 9K',
      widget: reportWidget,
      more: {
        numbers: `<p>The steps from our netlist to the routed design: ${num(C.ours.nands)} NANDs → ${num(ST.synth)} LUTs from Yosys → ${num(ST.packed)} after packing (the ${D.alu.used} carry cells take LUT slots) →
          ${num(ST.routed)} after routing, ${num(ST.passthrough)} of them pass-through LUTs in front of flip-flops. ${num(D.dff.used)} flip-flops of ${num(D.dff.available)}. The small example, Examples ▸ Counter
          (${num(COUNTER.ours.nands)} NANDs), takes ${COUNTER.device.lut4.used} LUTs and runs its clock at up to ${COUNTER.fmax.clk.toFixed(0)} MHz.</p>`,
        pitfall: `<p>Reading a block's LUT count from the names in a report. After synthesis flattens and optimizes the design, a name only says which net a cell drives, and logic is often named after the
          register it feeds. Here the RAM's name carries a third of the CPU's logic.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'Why does the 4K × 32 RAM take eight block RAMs?',
        options: [`${num(RAM_WORDS * RAM_BITS)} bits over 16 Kbit per block is 8`, 'One block per 512 words is a fixed rule', 'Each block holds four bits of every word'],
        answer: 0,
        explain: `4096 × 32 = ${num(RAM_WORDS * RAM_BITS)} bits, and each block holds 16 384 data bits: 8 blocks. How they are arranged (eight blocks of 4K × 4, or another shape) is the tool's choice.`,
        why: ['', 'A block can be shaped as 16K × 1 up to 512 × 32; the count follows from the bits.', 'That is one possible arrangement, not the reason for the count.'],
      },
    },
    {
      title: 'Timing: the estimate against the tool',
      body: `
        <p>After routing, nextpnr times every path with the delays of the cells and wires it actually used. The design clock's slowest path, register to register, takes
        ${pathShares().ns.toFixed(1)} ns, ${C.fmax.clk.toFixed(1)} MHz at most. It runs from a register-file flip-flop through the read multiplexers and the ALU to the program counter: ${pathShares().lut4} LUT4s
        and ${pathShares().wideMux} of the multiplexers that join two LUTs into a 5- to 8-input function. Our mapping finds at most ${C.ours.lutLevels} LUT levels between any two storage elements, close to the tool's
        ${pathShares().lut4}; our static timing gives ${C.ours.period} NAND delays for the period. The two do not time the same stretch: our period covers a whole instruction in one cycle, the
        program ROM's read and the RAM's included, while the export puts both memories behind registers on the memory clock, so the tool's path is only the logic between them.</p>
        <p>Where the time goes: routing ${pathShares().routingPct} %, logic ${pathShares().logicPct} %, clock skew ${pathShares().skewPct} %. The skew is large because the design clock is the board's
        ${BOARD.clockMHz} MHz divided by 2<sup>${BOARD.divLog2}</sup> in a counter, so it reaches the flip-flops over ordinary routing, not the chip's clock network. On a custom chip the clock tree is built for the
        design; on an FPGA, a clock made in logic pays for it.</p>
        <p>The report also gives the memory clock ${C.fmax.mem_clk.toFixed(1)} MHz, below its ${BOARD.clockMHz} MHz, and calls that a failure. It is not one. Those paths start at the program ROM's output
        register and end at the RAM's sampling register, both on the memory clock, but the CPU state they pass through changes once per design clock, ${num(2 ** BOARD.divLog2)} memory-clock cycles. The data has
        all that time to settle; the tool, told nothing, checks it against one cycle. A designer declares such a path a <em>multicycle path</em> and the check passes. Neither number is the computer's speed:
        a design cycle also needs several memory-clock edges for the reads and the write, and as exported it runs at ${divHz.toFixed(1)} Hz, slow enough to watch on the LEDs.</p>`,
      widget: pathWidget,
      more: {
        real: `<p>Production flows constrain every clock and every exception (multicycle and false paths) in a constraints file, and the timing report is read after each run. Clocks come from the chip's
          PLLs onto dedicated clock networks with skew held to tens of picoseconds; a divided clock is made with a clock enable instead, so the flip-flops keep the fast, clean clock.</p>`,
        pitfall: `<p>Trusting a failing timing report without reading the path. Here the "failure" is a check against the wrong number of cycles. The opposite also happens: an unconstrained path is reported as
          passing and is broken on the board.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'How should the design clock be divided so that the skew goes away?',
        options: ['Keep one fast clock on the clock network and let the flip-flops load only when a counter says so (a clock enable)', 'Divide it with more flip-flops', 'Route the divided clock on shorter wires by hand'],
        answer: 0,
        explain: 'Every flip-flop then sees the same clock from the dedicated network; the counter only enables them once every 2^22 cycles. The design is the same, the clock is clean.',
        why: ['', 'Any clock made in logic leaves the clock network; more stages only add delay.', 'The router already tries; general routing cannot match a network built for low skew.'],
      },
    },
    {
      get body() {
        const sky = 'silicon';
        return `
        <p>The same Verilog, three ways to run it. As software on a processor, it is one instruction at a time; as a custom chip (<a href="#/c/${sky}/0">chapter ${numOf(sky)}</a>), the fastest and smallest
        per unit, after months and a mask set; as an FPGA, real parallel hardware the same day, at a cost in area and speed.</p>
        <p>Measured here: each LUT stands for ${nandsPerLut().toFixed(1)} of our NANDs on average but is itself ${lutCost(4).nands} NANDs of multiplexer and 16 configuration bits, so the configurable fabric spends
        about ${(lutCost(4).nands / nandsPerLut()).toFixed(0)} NAND-equivalents of logic for each one it implements, before the routing switches. Published comparisons put FPGAs at tens of times the area and a few times the
        delay of a standard-cell chip in the same process.</p>
        <p>That decides their place: prototypes of chips (a CPU is tested on FPGAs before its masks are made), products made in thousands, hardware that must change after it ships, and computation where
        thousands of small units in parallel beat a processor's one instruction at a time.</p>`;
      },
      title: 'FPGA, custom chip or processor?',
      widget: flowWidget,
      challenge: {
        kind: 'quiz', question: 'A design will ship 10 000 units and may need fixes after shipping. What fits best?',
        options: ['An FPGA', 'A custom chip', 'It cannot be built'],
        answer: 0,
        explain: 'A mask set costs more than 10 000 FPGAs, and a fix to a custom chip means new masks; an FPGA takes a new bitstream.',
        why: ['', 'Masks pay off only over very large volumes, and they cannot be fixed after shipping.', 'Both would work; the question is cost and change.'],
      },
    },
  ],
};
