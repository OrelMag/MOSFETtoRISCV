import { WB_MISS_CLEAN, WB_MISS_DIRTY } from '../lib/cache2';
import { BITLINE_C, CELL_C, CELL_HALFLIFE } from '../lib/dram';
import { accessCycles, CLOCK_NS, cyclesOf, DDR4_3200, TIMING } from '../dram/timing';
import { findNode } from '../sim/flatten';
import { SENSE_OFFSET, type SwitchSim, VDD_VOLTS } from '../sim/switchsim';
import type { Stage } from '../view/stage';
import { dramActions, dramScene, dramState, SAFE_CYCLES } from '../widgets/dram';
import { dram3d } from '../widgets/dram3d';
import { rowBufferWidget, timingWidget } from '../widgets/dramtiming';
import type { Chapter } from './types';

/** Level (fraction of VDD) of cell (r, c) of the scene's array. */
function cellLevel(st: Stage, r: number, c: number): number {
  const sim = st.sim as SwitchSim | null;
  const n = sim && findNode(sim.design.root, [`col${c}`, `c${r}`]);
  if (!sim || !n?.nets) return NaN;
  return sim.level(n.nets[n.def.netlist!().nets.findIndex((x) => x.name === 'storage')][0]);
}

/** The words the scenes start with (bit c = column c). */
const PATTERN = [0b1010, 0b0110, 0b1111, 0b0001];
/** A stored 1 still reads as 1: the amplifier sees at least its offset. */
const READABLE = 0.5 + SENSE_OFFSET * (CELL_C + BITLINE_C) / CELL_C;
const DV = 0.5 * CELL_C / (CELL_C + BITLINE_C);
const mV = (l: number) => Math.round(l * VDD_VOLTS * 1000);

/** The panel's protocol, from a challenge's solve (inputs as the panel drives them). */
function openRow(st: Stage, row: number): void {
  st.setInputs({ cs: 0, we: 0, act: 0, sae: 0, pre: 1 });
  st.setInputs({ pre: 0, row, act: 1 });
  st.setInputs({ sae: 1 });
}
function closeRow(st: Stage): void {
  st.setInputs({ act: 0 });
  st.setInputs({ sae: 0, pre: 1 });
}

const share = (v: number) => (CELL_C * v + BITLINE_C * 0.5) / (CELL_C + BITLINE_C);
const twice = share(share(1)), thrice = share(twice);
const GHZ3 = 1 / 3;
/** DDR4-3200's pins: 3 200 MT/s on a 1 600 MHz clock (tCK, ns); CL in clocks; a BL8 burst in ns. */
const MTS = 3200, TCK = 2000 / MTS, CL_TCK = Math.round(DDR4_3200.tCAS / TCK), BL8_NS = 8 * 1000 / MTS;
const burst3 = cyclesOf(BL8_NS, GHZ3);
const conflict3 = cyclesOf(DDR4_3200.tRP, GHZ3) + cyclesOf(DDR4_3200.tRCD, GHZ3) + cyclesOf(DDR4_3200.tCAS, GHZ3) + burst3;
/** The swing with twice the bit line (the recap's question). */
const DV2 = 0.5 * CELL_C / (CELL_C + 2 * BITLINE_C);
const OFFSET_MV = Math.round(SENSE_OFFSET * VDD_VOLTS * 1000);

export const chDram: Chapter = {
  id: 'dram', num: 35, title: 'Inside a DRAM', level: 'Memory in depth',
  blurb: 'A 1T1C array at transistor level: bit lines at VDD/2, charge sharing measured in millivolts, the sense amplifier that restores a destroyed row, leakage and refresh, the row buffer and DDR4 timings in cycles.',
  goals: [
    'compute the bit-line swing of a 1T1C read from the cell and bit-line capacitances',
    'say why a DRAM read destroys the row, and how the sense amplifier writes it back',
    'work out how long a row survives without refresh, and what refresh costs a DDR4 device',
    'price a row hit, a miss and a conflict in cycles from tRCD, tCAS, tRP and the burst',
  ],
  builds: ['latches', 'memory', 'cache'],
  recap: {
    keep: [
      `A 1T1C cell is one transistor and a ${CELL_C} fF capacitor. On a ${BITLINE_C} fF bit line precharged to VDD/2, a full 1 or 0 moves the line by only ±${mV(DV)} mV: ΔV = (V<sub>cell</sub> − VDD/2) · Cs / (Cs + Cb).`,
      'Charge sharing leaves the cell at the bit line\'s level: <strong>a read destroys the row</strong>. The sense amplifier (two cross-coupled inverters) drives both lines to the rails and, with the word line still up, writes the row back.',
      'The amplifiers of a bank hold its open row: the <strong>row buffer</strong>. A hit needs only the column command, a miss an activate first, a conflict a precharge and then an activate.',
      `Here cells leak towards 0, and a 1 stays readable for ${SAFE_CYCLES} cycles after its last restore. DDR4 refreshes every row within 64 ms, a REF every ${DDR4_3200.tREFI / 1000} µs that blocks the device for ${DDR4_3200.tRFC} ns: ${((100 * DDR4_3200.tRFC) / DDR4_3200.tREFI).toFixed(1)} % of the time.`,
      `DDR4-3200: tRCD = tCAS = tRP = ${DDR4_3200.tRCD} ns, ${TIMING.tRCD} cycles each at our ${CLOCK_NS.toFixed(2)} ns clock. With a 4-word burst: hit ${accessCycles('hit', TIMING)}, miss ${accessCycles('miss', TIMING)}, conflict ${accessCycles('conflict', TIMING)} cycles.`,
      `The name reads: ${MTS} MT/s, data on both edges of a ${MTS / 2} MHz clock (tCK = ${TCK} ns); ${CL_TCK}-${CL_TCK}-${CL_TCK} = CL-tRCD-tRP in clocks, ${DDR4_3200.tCAS} ns each. An 8n prefetch lets a slow array feed fast pins: a burst of 8 transfers, ${BL8_NS} ns, a 64-byte line on a 64-bit channel. Banks work in parallel: one can activate while another bursts.`,
    ],
    practise: ['m_sense', 'm_bank'],
    check: [
      {
        question: `Hang twice as many cells on each bit line, so it is ${2 * BITLINE_C} fF instead of ${BITLINE_C}. How far does a stored 1 now move it?`,
        options: [`${mV(DV2)} mV`, `${mV(DV)} mV`, `${mV(DV / 2)} mV`, `${mV(2 * DV)} mV`],
        answer: 0,
        explain: `ΔV = 0.55 V · ${CELL_C} / (${CELL_C} + ${2 * BITLINE_C}) = ${mV(DV2)} mV. Still above the ${OFFSET_MV} mV offset, but the margin shrinks: that is the limit on how many cells a bit line can amortize its amplifier over.`,
        why: ['', 'The cell\'s charge is now shared with twice the capacitance, so the line moves less.', 'Halving would hold if ΔV went as 1 / Cb. It goes as Cs / (Cs + Cb), and the cell\'s own 25 fF stays in the sum.', 'More capacitance on the line takes more charge to move it: the swing falls, it cannot grow.'],
      },
      {
        question: 'After an activate, why must the whole row be written back, and what does it?',
        options: [
          'Every cell of the row shared its charge with its bit line; the sense amplifiers restore them all while the word line is still up',
          'The column select drained the one cell it read; the controller rewrites that word',
          'The read heated the cells and they leak faster; the next refresh restores them',
          'Only cells holding 1 lost charge; the write driver puts it back',
        ],
        answer: 0,
        explain: 'The word line joins every cell of the row to its bit line at once, so every cell is left near VDD/2. Each column\'s amplifier swings its bit line to a rail, and the cell, still connected, follows: the read is its own write-back.',
        why: ['', 'The damage is done before any column is selected: raising the word line shares the charge of every cell in the row.', 'Leakage has nothing to do with it. Charge sharing moved the cells to the bit lines\' level, and waiting for refresh would lose them.', 'A stored 0 is pulled up towards VDD/2 just as a 1 is pulled down. The amplifiers restore both, and the write driver only acts on a write.'],
      },
      {
        question: `Here a row hit costs ${accessCycles('hit', TIMING)} cycles and a miss ${accessCycles('miss', TIMING)}. What does the miss pay for that the hit does not?`,
        options: ['tRCD: the activate, word line and sensing before the column command', 'tRP: the precharge', 'tCAS: the column path', 'tRFC: a refresh'],
        answer: 0,
        explain: `A closed bank must first open the row: ACT, then tRCD = ${TIMING.tRCD} cycles before the column command. ${accessCycles('miss', TIMING)} − ${accessCycles('hit', TIMING)} = ${TIMING.tRCD}. A conflict adds tRP on top: ${accessCycles('conflict', TIMING)}.`,
        why: ['', 'A precharge is needed only when another row is open in the bank: that is the conflict.', 'Every access pays tCAS, the hit included.', 'A refresh delays a request only when one falls in its way; it is not part of a miss.'],
      },
    ],
  },
  steps: [
    {
      title: 'An array of capacitors',
      body: `
        <p>An SRAM bit costs six transistors (<a href="#/c/cache/0">chapter 22</a>). A DRAM bit is one access transistor and one capacitor of about
        ${CELL_C} fF: the <strong>1T1C</strong> cell. The bit is the charge on the capacitor, so nothing holds it; it only has
        to survive until it is read or refreshed. A 16 Gbit DDR5 die holds seventeen billion of these.</p>
        <p>Each row of cells shares a <strong>word line</strong> (the access transistors' gates, raised by the
        <span data-show="rdec">row decoder</span>), each <span data-show="col0 col1 col2 col3">column</span> a <strong>bit line</strong>.
        Next to every bit line runs a <strong>reference</strong> line of the same capacitance (${BITLINE_C} fF): here a line with no cells;
        in a real array it is another bit line, its folded twin in the same mat (whose cells hang on other word lines) or, in an
        open-bit-line array, a bit line of the neighbouring mat. Three transistors per column precharge both to <strong>VDD/2</strong>
        and equalize them.</p>
        <p>Cost of this 4 × 4: the cells are 16 transistors and 16 capacitors. Each column then adds 3 precharge transistors,
        2 for the column select and an 8-transistor <span data-show="col0.sa">sense amplifier</span>: 13 per column, more than its cells. Real arrays hang 512 to
        1024 cells on a bit line to amortize them.</p>
        <p>Why one transistor is enough: a bit is a charge, and a charge needs only a switch to reach it and a capacitor to keep it. The
        feedback that makes an SRAM cell static costs five more transistors per bit, and DRAM pays for its absence in time instead:
        every access is a small analog event (<a href="#/c/dram/1">next step</a>), and the stored value must be restored after a read
        and renewed while idle. What the capacitor buys is density: among memories that can rewrite a single bit, the cell is the smallest storage element there is, and the cost per
        bit of the whole array is set by how many cells share each column's periphery.</p>
        <div class="try">The cells power on unknown (X). In the panel pick a row, then Activate, Sense, choose a column and data,
        Write; Close; Precharge. Each cell shows its voltage, and the wires show theirs.</div>`,
      tour: {
        beats: [
          { title: 'Open a row', say: 'Precharge off, row 2 selected, <code>act</code> up: the row decoder raises row 2\'s word line and its four cells join their bit lines. They power on unknown, so the output is {v:dout} (X).', set: { row: 2, pre: 0, act: 1 }, at: [], show: ['rdec'], expect: { dout: -1 } },
          { title: 'Sense', say: 'The amplifiers fire (<code>sae</code>). Every column of the row now sits at a rail, but the row held nothing known, so the output is still X: sensing restores what was there, it cannot invent it.', set: { sae: 1 }, show: ['col0', 'col1', 'col2', 'col3'], expect: { dout: -1 } },
          { title: 'Write a 1', say: 'Column 3 selected, data 1, write: the driver forces column 3\'s amplifier and the open cell follows its bit line. The output reads {v:dout}.', set: { col: 3, din: 1, cs: 1, we: 1 }, show: ['wd', 'cdec', 'col3'], expect: { dout: 1 } },
          { title: 'Close the row', say: 'Writing stops and the word line falls first: the cell is disconnected while its bit line is still at the rail, so the 1 stays in the capacitor.', set: { we: 0, cs: 0, act: 0 }, show: ['rdec'], expect: { dout: 1 } },
          { title: 'Precharge', say: 'Sense off, precharge on: the bit lines return to VDD/2. The array is idle, and the only copy of the 1 is the charge in one 25 fF capacitor.', set: { sae: 0, pre: 1 }, show: ['col3'] },
          { title: 'Open the row again', say: 'The same row is activated once more, so the cell shares its charge with the bit line (the next step puts numbers on that swing).', set: { pre: 0, act: 1 }, show: ['rdec', 'col3'] },
          { title: 'Sense again', say: 'The amplifier resolves the small swing to a rail, and the row buffer holds the row again.', set: { sae: 1 }, show: ['col3'] },
          { title: 'Read', say: 'Column 3 is selected with the data input at 0 and no write: the output is {v:dout}, the 1 written five beats ago, now read from a charge.', set: { cs: 1, din: 0 }, show: ['cdec', 'col3', 'out'], expect: { dout: 1 } },
        ],
      },
      more: {
        derive: `<p>Cost per bit, counting transistors: a cell is 1 and each column adds ${3 + 2 + 8} for precharge (3), column select (2) and the sense
          amplifier (8). With R cells on a bit line the column costs 1 + ${3 + 2 + 8}/R per bit, against 6 for SRAM. The periphery
          falls away as R grows, but a longer bit line has more capacitance, which shrinks the read signal (the next step); that
          trade-off sets how many cells a real bit line carries.</p>`,
        real: `<p>A shipping DRAM cell does not use a planar capacitor: it is a deep trench or a tall stacked cylinder, tens of fF in a footprint of a few
          F², where F is the minimum feature size. An SRAM cell is of the order of a hundred F². The access transistor is built with a
          buried or recessed gate so that its leakage stays low. That is why DRAM and logic need different processes, and why a CPU's last
          cache is SRAM, or embedded DRAM on a DRAM-like flow, not ordinary DRAM.</p>`,
        pitfall: `<p>Reading a cell is not "looking at a wire". The cell's capacitor (${CELL_C} fF) is a quarter of the bit line it must move (${BITLINE_C} fF) and has
          no gain, so there is no digital value on the bit line until an amplifier makes one. In the panel, the line shows a voltage
          before Sense and a logic level only after; reading the output before the row is sensed gives X.</p>`,
        numbers: `<table class="mini"><tr><th>cells per bit line</th><th>transistors per bit</th><th>SRAM (6T)</th></tr>
          ${[4, 64, 512, 1024].map((r) => `<tr><td>${r}</td><td>${(1 + 13 / r).toFixed(2)}</td><td>6</td></tr>`).join('')}</table>`,
      },
      scene: () => dramScene(),
      challenge: {
        kind: 'reach', goal: 'Store a 1 in row 2, column 3, and leave the array closed and precharged.',
        check: (st) => cellLevel(st, 2, 3) >= 0.9 && st.getInput('act') === 0 && st.getInput('pre') === 1,
        hints: [
          'A write goes through the row buffer: the row has to be open and sensed before the data lines can change one of its cells.',
          'Close the row before you precharge: while its word line is up the cell is joined to its bit line, and the precharge pulls that line to VDD/2.',
        ],
        answer: 'Row 2, Activate, Sense; column 3, data 1, Write; Close; Precharge. A write needs the row open: the data lines flip that column\'s sense amplifier, and the open cell follows its bit line.',
        solve: (st) => { openRow(st, 2); st.setInputs({ col: 3, din: 1, cs: 1, we: 1 }); st.setInputs({ we: 0, cs: 0 }); closeRow(st); },
      },
    },
    {
      title: 'The read, in slow motion',
      body: `
        <p>Raise a word line and each cell of that row joins its bit line. They share their charge, so both end at the
        capacitance-weighted average: ΔV = (V<sub>cell</sub> − VDD/2) · Cs / (Cs + Cb). With ${CELL_C} and ${BITLINE_C} fF at 1.1 V,
        a full 1 lifts the bit line by <strong>${mV(DV)} mV</strong> and a 0 lowers it by as much. Nothing digital can use that:
        read as a logic level, the line is X.</p>
        <p>The simulator now keeps a <em>level</em> on every capacitive net. Floating nets joined by a conducting transistor share
        their charge, Σ C·V / Σ C, and the wires show their voltage. Everywhere else the circuit is still 0, 1, X and Z.</p>
        <p><span data-show="c1">The cell</span> lost its charge in the process: it now sits at the bit line's level too. Sharing destroys the bit, so a DRAM
        read must write the value back.</p>
        <p>Two consequences follow from one formula. The swing scales with Cs / (Cs + Cb), so it shrinks as more cells hang on a bit line,
        and the amplifier's offset sets a floor under it. And because the cell ends at the shared level, a cell left unrestored after an
        activate holds ${(share(1) * VDD_VOLTS).toFixed(2)} V instead of ${VDD_VOLTS} V: each uncorrected read cuts the next one's signal to a fifth, as the next step's quiz works out.</p>
        <div class="try">The panel shows the array's contents and the view is inside column 1. Activate <span data-show="c1">row 1</span> and stop: read each bit
        line's distance from <span data-show="vh0 vh1">VDD/2</span> in the panel's <code>bl − bl̄</code> row (bit line minus reference line), and the bit line's voltage on the drawing.</div>`,
      more: {
        derive: `<p>Charge conservation on the joined nodes: Cs·V<sub>cell</sub> + Cb·VDD/2 = (Cs + Cb)·V. Subtract (Cs + Cb)·VDD/2 from both sides:
          V − VDD/2 = (V<sub>cell</sub> − VDD/2) · Cs / (Cs + Cb). With Cs = ${CELL_C} fF, Cb = ${BITLINE_C} fF the fraction is ${CELL_C}/${CELL_C + BITLINE_C} = ${(CELL_C / (CELL_C + BITLINE_C)).toFixed(2)},
          a cell at ±VDD/2 = ±${mV(0.5)} mV moves the line by ±${mV(DV)} mV. The cell ends at the same level, so after the read it holds
          VDD/2 ± ${mV(DV)} mV: one fifth of its original margin.</p>`,
        real: `<p>Sense amplifiers resolve tens of millivolts, which is why real arrays keep bit lines short (512 to 1024 cells, as above), twist or shield them against coupling between neighbours, and keep a dummy or twin line precisely matched to the one being
          read. Everything on the line is a noise source: the amplifier's offset, the neighbour's switching, the supply.</p>`,
        pitfall: `<p>Reading the bit line's level on the drawing as "the bit". At ${mV(DV)} mV from VDD/2 the line is neither a 0 nor a 1 for any logic
          gate: the panel shows <code>bl − bl̄</code> (the bit line against its reference) because only the difference carries information.
          If the reference is not at the same level, a stored 0 can look like a 1.</p>`,
        numbers: `<table class="mini"><tr><th>Cb / Cs</th><th>bit-line swing</th><th>margin over the ${OFFSET_MV} mV offset</th></tr>
          ${[2, 4, 8, 16, 32].map((m) => { const d = 0.5 / (1 + m); return `<tr><td>${m}</td><td>${mV(d)} mV</td><td>${(mV(d) / OFFSET_MV).toFixed(1)}×</td></tr>`; }).join('')}</table>
          <p>Here Cb / Cs = ${BITLINE_C / CELL_C}. The margin falls roughly as 1 / (1 + Cb / Cs) and runs out where the line carries ${Math.floor(0.5 * VDD_VOLTS * 1000 / OFFSET_MV - 1)} times the cell's capacitance.</p>`,
      },
      scene: () => dramScene({ pattern: PATTERN, path: ['col1'] }),
      challenge: {
        kind: 'reach', goal: `Activate row 1 and stop before sensing: every bit line sits ${mV(DV)} mV above or below VDD/2.`,
        check: (st) => st.getInput('act') === 1 && st.getInput('sae') === 0 && st.getInput('row') === 1 && st.getInput('pre') === 0
          && [0, 1, 2, 3].every((c) => Math.abs(Math.abs(cellLevel(st, 1, c) - 0.5) - DV) < 1e-6),
        hints: [
          'Charge sharing happens the moment the word line rises. The sense amplifier does nothing until it is enabled.',
          `The row selector picks whose word line Activate raises. Sense would amplify the ${mV(DV)} mV and end the experiment.`,
        ],
        answer: 'Precharge (it is already), select row 1, Activate. Row 1 holds 0, 1, 1, 0: columns 1 and 2 read +110 mV, columns 0 and 3 −110 mV, and the cells sit at the same levels: their charge is gone.',
        solve: (st) => { st.setInputs({ act: 0, sae: 0, pre: 1 }); st.setInputs({ pre: 0, row: 1, act: 1 }); },
      },
    },
    {
      title: 'The sense amplifier',
      body: `
        <p><span data-show="sa">The sense amplifier</span> is two cross-coupled inverters between the bit line and its reference, powered through a head and a
        foot transistor when <code>sae</code> (sense-amplifier enable) rises. Both lines start near VDD/2. The higher one turns the opposite pull-down on a
        little harder, which pulls that line lower, which turns this side's pull-up on harder. The feedback ends with both lines at
        the rails.</p>
        <p>The word line is still up, so the cell is recharged to a full level as the bit line swings: <strong>the read writes the row
        back</strong>. The amplifiers now hold the whole row. That is the <strong>row buffer</strong>: any column of it can be read or
        written through the <span data-show="ca cb">column select</span> until the row is closed.</p>
        <p>A switch model cannot amplify 110 mV, so the amplifier is a primitive here: drawn with its 8 transistors, it compares the two
        levels and latches. Real amplifiers have an offset of some millivolts (mismatched transistors); below ${Math.round(SENSE_OFFSET * VDD_VOLTS * 1000)} mV
        this one latches X.</p>
        <p>Why this is the right circuit: the signal is a difference of ${mV(DV)} mV on two lines that are otherwise identical, and a
        cross-coupled pair amplifies exactly a difference while rejecting what is common to both lines (supply noise, coupling). Its gain is
        positive feedback, so it is also its own memory: when it has finished, the pair <em>is</em> a latch holding the bit, which is
        what the row buffer is. The cost is that it must be enabled only after the charge has been shared, and disabled only after the
        cell has been restored.</p>
        <div class="try">The view is inside column 0. Activate a row and Sense, and watch the lines and the cell go to the rails. Open
        the SENSE box to see its transistors.</div>`,
      more: {
        derive: `<p>Near the metastable point the pair is a linear amplifier with a positive pole: the difference grows as δ(t) = δ₀·e<sup>t/τ</sup>, where τ = C/g<sub>m</sub>
          (the line's capacitance over the transistors' transconductance). Resolving to a rail from δ₀ takes t = τ·ln(V<sub>swing</sub>/δ₀). A large
          signal resolves fast; a signal at the offset takes a few times longer, and a signal of exactly zero never does, which is the
          analog form of the metastability met with latches. Here the primitive latches when |δ₀| clears the ${OFFSET_MV} mV offset and gives X below it.</p>`,
        real: `<p>Real sense amplifiers are shared: in a folded array one amplifier sits between a bit line and its twin; in an open array it sits between
          two mats and each mat borrows its twin's line. Either way the amplifier must fit in the pitch of two bit lines, which is why it is
          the most carefully drawn circuit on a DRAM die, and why its offset is a matter of layout symmetry as much as of design.</p>`,
        pitfall: `<p>Closing in the wrong order. Precharge pulls the bit lines to VDD/2; if the word line is still up, the cell is pulled to VDD/2 with them and
          the row is lost. Close first (<code>act</code> down), then precharge. The same trap in the other direction: enabling the amplifier
          before the word line has joined the cell to the line senses nothing and latches a coin toss.</p>`,
      },
      scene: () => dramScene({ pattern: PATTERN, path: ['col0'], highlight: ['sa'] }),
      tries: [(st) => st.getInput('act') === 1 && st.getInput('sae') === 1],
      challenge: {
        kind: 'quiz',
        question: 'You activate a row holding a 1 and close it again without sensing. What does the cell hold?',
        options: ['The 1, unchanged: nothing was read out', `The shared level, ${(share(1) * VDD_VOLTS).toFixed(2)} V: the next read sees a smaller signal`, 'A 0', 'X'],
        answer: 1,
        why: [
          'Activating is the damage: the word line joins the cell to its bit line and they share charge, whether or not the amplifier fires.',
          '',
          'The charge spread over the bit line; it did not drain to ground. The shared level sits above VDD/2.',
          `The cell holds a definite voltage, ${(share(1) * VDD_VOLTS).toFixed(2)} V. X is only what a logic gate would make of it; the amplifier can still sense it.`,
        ],
        explain: `Charge sharing moved the cell to the bit line's level and nothing restored it. The next read shares again from ${(share(1) * VDD_VOLTS).toFixed(2)} V: the line moves ${mV(twice - 0.5)} mV, still above the ${Math.round(SENSE_OFFSET * VDD_VOLTS * 1000)} mV offset. A third read moves it ${(((thrice - 0.5) * VDD_VOLTS) * 1000).toFixed(0)} mV: X. Try it: Activate, Close, Precharge, twice; then Activate and Sense.`,
      },
    },
    {
      title: 'Leaks and refresh',
      body: `
        <p>The charge leaks away through the access transistor's channel and its junction. Here a stored 1 halves every
        ${CELL_HALFLIFE} clock cycles, and the amplifier reads it correctly while its bit line moves by more than its offset: for
        <strong>${SAFE_CYCLES} cycles</strong> after the last restore. After that it reads X, and after a few more it reads 0 and writes
        that 0 back. The bit is gone. Retention is a distribution, not a number: the leakiest cell among billions sets the refresh interval, so the
        interval is chosen to keep that cell alive with margin, and it is the same for every row.</p>
        <p><strong>Refresh</strong> is a read with nothing out: <span data-show="rdec">activate a row</span>, sense it (which restores it), close it. Every row must be
        refreshed within the retention time. In silicon that is 64 ms, and a DDR4 device refreshes in 8192 REF commands, one every
        ${DDR4_3200.tREFI / 1000} µs, each keeping it busy for ${DDR4_3200.tRFC} ns: ${((100 * DDR4_3200.tRFC) / DDR4_3200.tREFI).toFixed(1)} % of the time
        lost. Here cells leak only towards 0, so a stored 0 never fades; in silicon many arrays store half their bits inverted
        (true and anti-cells), so lost charge reads as 1 in some cells and 0 in others, and refresh must cover every bit. A cell in
        an open row does not decay: its <span data-show="col0.sa">amplifier</span> holds it.</p>
        <div class="try">Wait 200 cycles and watch row ages turn orange, then red. Refresh a row and its age returns to 0.</div>`,
      more: {
        derive: `<p>A stored 1 decays as L(t) = 2<sup>−t/${CELL_HALFLIFE}</sup> of VDD. It stays readable while the bit-line swing clears the amplifier's offset,
          that is while L ≥ ${READABLE.toFixed(3)} (½ plus the offset's share of the cell: ${OFFSET_MV} mV · (Cs + Cb) / Cs). Solving: t = ${CELL_HALFLIFE} · log₂(1 / ${READABLE.toFixed(3)})
          = ${SAFE_CYCLES} cycles. Refresh cost, DDR4: ${DDR4_3200.retentionMs} ms retention over 8192 REF commands is one every ${DDR4_3200.tREFI / 1000} µs; a bank has 65 536 rows,
          so each REF restores 8 rows per bank. During it the device is busy for tRFC = ${DDR4_3200.tRFC} ns, so the lost fraction is ${DDR4_3200.tRFC}/${DDR4_3200.tREFI} = ${((100 * DDR4_3200.tRFC) / DDR4_3200.tREFI).toFixed(1)} %.</p>`,
        real: `<p>Refresh assumes a cell loses charge only by leaking. Activating one row over and over (the <em>aggressor</em>) disturbs
          the cells of its neighbours and drains them faster: Kim et al. (2014) flipped bits in 110 of 129 DDR3 modules with as few as
          139 000 activations inside one 64 ms window, and denser parts since have flipped with under 5000. A program that hammers the
          rows around a victim flips bits it may not write; Project Zero turned that into a privilege escalation in 2015. Defences count
          activations and refresh the neighbours (DDR4's target row refresh, DDR5's refresh management), refresh more often, or add ECC.
          Here cells do not couple: each leaks alone.</p>`,
        pitfall: `<p>Thinking an idle row is safe because nothing touches it: it is the idle rows that leak. And the opposite error: assuming a refresh costs an
          activate and a read. It does cost a row cycle (tRAS + tRP), but it moves no data over the pins; the controller only has to leave the device
          alone for tRFC. In the panel, a row's age resets on Refresh and keeps climbing under Wait, whatever else you do to the other rows.</p>`,
      },
      scene: () => dramScene({ pattern: PATTERN }),
      challenge: {
        kind: 'reach', goal: 'Let at least 600 cycles pass (Wait) and keep every bit: all four rows still readable.',
        check: (st) => {
          const s = dramState(st);
          return !!s && s.waited >= 600 && PATTERN.every((bits, r) => [0, 1, 2, 3].every((c) => ((bits >> c) & 1 ? cellLevel(st, r, c) >= READABLE : cellLevel(st, r, c) <= 0.5)));
        },
        hints: [
          `A row stays readable for ${SAFE_CYCLES} cycles after its last restore. What has to happen to every row before that runs out?`,
          `One Wait of 600 is far too long. Cut the waiting into pieces shorter than ${SAFE_CYCLES} cycles, and restore every row between them.`,
        ],
        answer: `Wait 200, Refresh all, three times. Each row is restored before ${SAFE_CYCLES} cycles pass. Waiting 400 at once would be too late: the 1s would have fallen below ${(READABLE * VDD_VOLTS).toFixed(3)} V.`,
        solve: (st) => { const a = dramActions(st); for (let i = 0; i < 3; i++) { a?.wait(200); a?.refreshAll(); } },
      },
    },
    {
      title: 'The array, live',
      body: `
        <p>The model below runs this chapter's 4 × 4 array on its own switch-level simulator. Each column stands as high as the voltage on its node, and
        its footprint is proportional to its capacitance, so a column's volume is its charge. The bit line is four times the cell
        (${BITLINE_C} fF against ${CELL_C} fF): when a word line rises the cell's volume spreads over both, and the shared level is
        (Cs·V<sub>cell</sub> + Cb·VDD/2) / (Cs + Cb), a swing of ${mV(DV)} mV for a full 1. That read destroyed the cell. <strong>Sense</strong>
        pulls the pair to a rail and the cell refills; <strong>Close</strong> and <strong>Precharge</strong> return it to idle.</p>
        <p>Then <strong>Wait</strong>: every cell with a 1 sinks, and after ${SAFE_CYCLES} cycles the swing is below the amplifier's
        ${OFFSET_MV} mV offset and the next read cannot tell it from a 0. <strong>Refresh</strong> a row before that. The numbers on the right
        are the simulator's, read after each step.</p>
        <div class="try">Activate row 0, then Sense. Close, Precharge, then Wait 200 and Wait 200 again: activate and sense once more and a 1 that was there has gone.</div>`,
      widget: () => dram3d(),
    },
    {
      title: 'Rows, columns, banks',
      body: `
        <p>A real device is 16 <strong>banks</strong>, each an array of 64 K rows with its own amplifiers. The address splits into
        bank, row and column. An access to a bank whose amplifiers already hold the row is a <strong>row hit</strong>: only the column
        command. A closed bank needs an activate first (a <strong>miss</strong>). Another row open in that bank needs a precharge
        before the activate (a <strong>conflict</strong>).</p>
        <p>Rows are interleaved over the banks, so consecutive lines fill a row and then move on to the next bank. Banks are
        independent: while one waits for its precharge or activate, another can be read, and a controller with several requests
        overlaps them (bank-level parallelism; DDR4 groups its 16 banks in 4 bank groups, <a href="#/c/memctrl/0">chapter 36</a>). Two streams that land in the same bank keep closing each
        other's rows. A memory copy whose destination sits a multiple of the bank stride away does exactly that.</p>
        <p>The row buffer is why access order matters more than access count. Sequential addresses cost one activate per row and a stream of
        cheap column commands; a stride that hops rows costs an activate and a precharge for every word. The same program can therefore run
        at a few cycles a line or at a conflict's ${accessCycles('conflict', TIMING)} cycles a line, with nothing changed but the addresses.</p>`,
      more: {
        derive: `<p>Average cost per line with hit rate h and conflict share k of the misses: ${accessCycles('hit', TIMING)}·h + ${accessCycles('miss', TIMING)}·(1 − h)(1 − k) + ${accessCycles('conflict', TIMING)}·(1 − h)k.
          A streaming read with 16-word rows and 4-word lines hits 3 times in 4 (h = 0.75, k = 0): ${(0.75 * accessCycles('hit', TIMING) + 0.25 * accessCycles('miss', TIMING)).toFixed(1)} cycles a line. The same lines
          visited so that each one finds another row open (h = 0, k = 1) cost ${accessCycles('conflict', TIMING)}: ${(accessCycles('conflict', TIMING) / (0.75 * accessCycles('hit', TIMING) + 0.25 * accessCycles('miss', TIMING))).toFixed(1)} times as much.</p>`,
        real: `<p>The address mapping is the controller's main lever. Real controllers put the column bits lowest (consecutive lines share a row), then bank-group and
          bank bits (so streams spread over independent banks), then the row bits, and some XOR bank bits with row bits to break the power-of-two strides
          that make arrays of structures collide. Servers interleave channels the same way.</p>`,
        pitfall: `<p>Reading "16 banks" as 16 times the bandwidth. Banks overlap latency (one activates while another bursts) but they share the data pins and
          the command bus; a program whose accesses all fall in one bank gets none of the overlap. The widget's copy example is that case: the
          mapping, not the device, is what changes.</p>`,
      },
      widget: rowBufferWidget,
      challenge: {
        kind: 'quiz',
        question: 'The copy with 2 banks and the plain mapping: source at word 0, destination at word 1024 (rows of 16 words). Why do almost all its accesses conflict?',
        options: ['1024 words is a whole number of rows times both banks, so each source line and its destination share a bank and evict each other\'s row', 'The row buffer only holds one line', 'Writes always need a precharge', 'The burst is too short'],
        answer: 0,
        why: [
          '',
          'The row buffer holds a whole row, 16 words here: four lines. The trouble is two rows wanting the same bank.',
          'A write to the open row is a row hit like a read. It needs a precharge only when another row is open in its bank.',
          'The burst sets how long an access takes once the row is open, not whether it hits.',
        ],
        explain: '1024 / (16 × 2) = 32 rows: the destination is the same bank, 32 rows down. The XOR hash folds the row\'s parity into the bank number, so the two streams land in different banks and both rows stay open.',
      },
    },
    {
      title: 'Bursts and timings',
      body: `
        <p>Every command waits for the array. <strong>tRCD</strong> covers the word line and sensing, <strong>tCAS</strong> the column path,
        <strong>tRP</strong> the precharge, <strong>tRAS</strong> the restore. A DDR4-3200 device is ${DDR4_3200.tRCD} ns for each of the first three.
        At our single-cycle CPU's ${CLOCK_NS.toFixed(2)} ns clock that is ${TIMING.tRCD} cycles each. After the column command the data comes as a
        <strong>burst</strong>: here a 4-word cache line, one word a cycle.</p>
        <p>A row hit is then ${accessCycles('hit', TIMING)} cycles, a miss ${accessCycles('miss', TIMING)}, a conflict ${accessCycles('conflict', TIMING)}.
        <a href="#/c/cache/0">Chapter 22</a>'s caches charge a fixed ${WB_MISS_CLEAN} for a miss (${WB_MISS_DIRTY} with a dirty victim to write back first);
        ${WB_MISS_CLEAN} is a row hit. <a href="#/c/memctrl/0">Chapter 36</a> builds the controller that issues these
        commands, and lets the caches pay what the row buffer says.</p>`,
      more: {
        derive: `<p>${MTS} MT/s (million transfers a second per data pin): data moves on both edges of a ${MTS / 2} MHz clock, so tCK = ${TCK} ns.
          The three numbers are CL (tCAS), tRCD and tRP in clocks: ${CL_TCK} × ${TCK} = ${DDR4_3200.tCAS} ns each. The array cannot keep up
          with the pins, so each column access fetches 8 bits per data pin at once (<strong>8n prefetch</strong>) and shifts them out as a
          <strong>burst of 8</strong> (BL8) over 4 clocks, ${BL8_NS} ns: on a 64-bit channel, a 64-byte cache line. From DDR to DDR5 the
          transfer rate rose from 200–400 to 4800 MT/s and more, the prefetch from 2n to 16n; CL in nanoseconds stayed at about 13–17. The latency is the array's, and the
          array has not got faster.</p>`,
        real: `<p>The pins run at ${MTS} MT/s, the array at a small fraction of that; the prefetch and the burst hide the difference. DDR5 splits the
          module into two independent 32-bit channels and doubles the bank groups so that more commands overlap; HBM goes the other way, thousands of slower pins on an interposer
          beside the CPU. All of them still pay tRCD, tCAS and tRP in nanoseconds, because the array's physics did not change.</p>`,
        pitfall: `<p>Comparing latencies in clocks across generations. DDR4-3200 CL22 and DDR5-6400 CL46 have the same CAS latency in time, ${DDR4_3200.tCAS} ns against about 14 ns:
          the bigger count is a faster clock, not a slower memory. Convert to nanoseconds first, then to your CPU's cycles.</p>`,
        numbers: `<table class="mini"><tr><th>CPU clock</th><th>ns / cycle</th><th>hit</th><th>miss</th><th>conflict</th></tr>
          ${[0.1, 1, 2, 3, 5].map((g) => { const c = (k: number) => cyclesOf(k, 1 / g), b = cyclesOf(BL8_NS, 1 / g); return `<tr><td>${g} GHz</td><td>${(1 / g).toFixed(2)}</td><td>${c(DDR4_3200.tCAS) + b}</td><td>${c(DDR4_3200.tRCD) + c(DDR4_3200.tCAS) + b}</td><td>${c(DDR4_3200.tRP) + c(DDR4_3200.tRCD) + c(DDR4_3200.tCAS) + b}</td></tr>`; }).join('')}</table>`,
      },
      widget: timingWidget,
      challenge: {
        kind: 'quiz',
        question: `The same DDR4-3200 device behind a 3 GHz CPU: how many cycles does a row conflict cost, the line coming as one BL8 burst (${BL8_NS} ns)?`,
        options: [String(accessCycles('conflict', TIMING)), String(cyclesOf(DDR4_3200.tRP, GHZ3)), String(conflict3), '1000'],
        answer: 2,
        why: [
          `That is the count at our ${CLOCK_NS.toFixed(2)} ns clock. The device's intervals are fixed in nanoseconds, so a faster clock waits more cycles.`,
          `That is one interval, ${DDR4_3200.tRP} ns at 0.33 ns a cycle. A conflict waits for tRP, tRCD and tCAS in turn, then the burst.`,
          '',
          `Too many: 1000 cycles at 3 GHz are 333 ns. Three intervals of ${DDR4_3200.tRP} ns plus the ${BL8_NS} ns burst come to ${conflict3} cycles.`,
        ],
        explain: `Each of tRP, tRCD and tCAS is ${DDR4_3200.tRP} ns, ${cyclesOf(DDR4_3200.tRP, GHZ3)} cycles at 0.33 ns; the burst, 8 transfers at ${MTS} MT/s, is ${BL8_NS} ns, ${burst3} cycles: ${conflict3}. The nanoseconds stayed; each interval went from ${TIMING.tRP} cycles to ${cyclesOf(DDR4_3200.tRP, GHZ3)}: the memory wall.`,
      },
    },
  ],
};
