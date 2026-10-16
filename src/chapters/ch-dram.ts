import { BITLINE_C, CELL_C, CELL_HALFLIFE } from '../lib/dram';
import { accessCycles, CLOCK_NS, cyclesOf, DDR4_3200, TIMING } from '../dram/timing';
import { findNode } from '../sim/flatten';
import { SENSE_OFFSET, type SwitchSim, VDD_VOLTS } from '../sim/switchsim';
import type { Stage } from '../view/stage';
import { dramScene, dramState, SAFE_CYCLES } from '../widgets/dram';
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
const conflict3 = cyclesOf(DDR4_3200.tRP, GHZ3) + cyclesOf(DDR4_3200.tRCD, GHZ3) + cyclesOf(DDR4_3200.tCAS, GHZ3) + TIMING.burst;

export const chDram: Chapter = {
  id: 'dram', num: 32, title: 'Inside a DRAM', level: 'Memory in depth',
  blurb: 'A 1T1C array at transistor level: bit lines at VDD/2, charge sharing measured in millivolts, the sense amplifier that restores a destroyed row, leakage and refresh, the row buffer and DDR4 timings in cycles.',
  steps: [
    {
      title: 'An array of capacitors',
      body: `
        <p>An SRAM bit costs six transistors (chapter 21). A DRAM bit is one access transistor and one capacitor of about
        ${CELL_C} fF: the <strong>1T1C</strong> cell. The bit is the charge on the capacitor, so nothing holds it; it only has
        to survive until it is read or refreshed. A 16 Gbit DDR5 die holds seventeen billion of these.</p>
        <p>Each row of cells shares a <strong>word line</strong> (the access transistors' gates), each column a <strong>bit line</strong>.
        Next to every bit line runs a <strong>reference</strong> line of the same capacitance (${BITLINE_C} fF) and no cells. Three
        transistors per column precharge both to <strong>VDD/2</strong> and equalize them.</p>
        <p>Cost of this 4 × 4: the cells are 16 transistors and 16 capacitors. Each column then adds 3 precharge transistors,
        2 for the column select and an 8-transistor sense amplifier: 13 per column, more than its cells. Real arrays hang 512 to
        1 024 cells on a bit line to amortize them.</p>
        <div class="try">The cells power on unknown (X). In the panel pick a row, then Activate, Sense, choose a column and data,
        Write; Close; Precharge. Each cell shows its voltage, and the wires show theirs.</div>`,
      scene: () => dramScene(),
      challenge: {
        kind: 'reach', goal: 'Store a 1 in row 2, column 3, and leave the array closed and precharged.',
        check: (st) => cellLevel(st, 2, 3) >= 0.9 && st.getInput('act') === 0 && st.getInput('pre') === 1,
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
        <p>The cell lost its charge in the process: it now sits at the bit line's level too. Sharing destroys the bit, so a DRAM
        read must write the value back.</p>
        <div class="try">The panel shows the array's contents and the view is inside column 1. Activate row 1 and stop: read each bit
        line's distance from VDD/2 in the panel's <code>bl − bl̄</code> row, and the bit line's voltage on the drawing.</div>`,
      scene: () => dramScene({ pattern: PATTERN, path: ['col1'] }),
      challenge: {
        kind: 'reach', goal: `Activate row 1 and stop before sensing: every bit line sits ${mV(DV)} mV above or below VDD/2.`,
        check: (st) => st.getInput('act') === 1 && st.getInput('sae') === 0 && st.getInput('row') === 1 && st.getInput('pre') === 0
          && [0, 1, 2, 3].every((c) => Math.abs(Math.abs(cellLevel(st, 1, c) - 0.5) - DV) < 1e-6),
        answer: 'Precharge (it is already), select row 1, Activate. Row 1 holds 0, 1, 1, 0: columns 1 and 2 read +110 mV, columns 0 and 3 −110 mV, and the cells sit at the same levels: their charge is gone.',
        solve: (st) => { st.setInputs({ act: 0, sae: 0, pre: 1 }); st.setInputs({ pre: 0, row: 1, act: 1 }); },
      },
    },
    {
      title: 'The sense amplifier',
      body: `
        <p>The sense amplifier is two cross-coupled inverters between the bit line and its reference, powered through a head and a
        foot transistor when <code>sae</code> rises. Both lines start near VDD/2. The higher one turns the opposite pull-down on a
        little harder, which pulls that line lower, which turns this side's pull-up on harder. The feedback ends with both lines at
        the rails.</p>
        <p>The word line is still up, so the cell is recharged to a full level as the bit line swings: <strong>the read writes the row
        back</strong>. The amplifiers now hold the whole row. That is the <strong>row buffer</strong>: any column of it can be read or
        written through the column select until the row is closed.</p>
        <p>A switch model cannot amplify 110 mV, so the amplifier is a primitive here: drawn with its 8 transistors, it compares the two
        levels and latches. Real amplifiers have an offset of some millivolts (mismatched transistors); below ${Math.round(SENSE_OFFSET * VDD_VOLTS * 1000)} mV
        this one latches X.</p>
        <div class="try">The view is inside column 0. Activate a row and Sense, and watch the lines and the cell go to the rails. Open
        the SENSE box to see its transistors.</div>`,
      scene: () => dramScene({ pattern: PATTERN, path: ['col0'], highlight: ['sa'] }),
      challenge: {
        kind: 'quiz',
        question: 'You activate a row holding a 1 and close it again without sensing. What does the cell hold?',
        options: ['The 1, unchanged: nothing was read out', `The shared level, ${(share(1) * VDD_VOLTS).toFixed(2)} V: the next read sees a smaller signal`, 'A 0', 'X'],
        answer: 1,
        explain: `Charge sharing moved the cell to the bit line's level and nothing restored it. The next read shares again from ${(share(1) * VDD_VOLTS).toFixed(2)} V: the line moves ${mV(twice - 0.5)} mV, still above the ${Math.round(SENSE_OFFSET * VDD_VOLTS * 1000)} mV offset. A third read moves it ${(((thrice - 0.5) * VDD_VOLTS) * 1000).toFixed(0)} mV: X. Try it: Activate, Close, Precharge, three times, then Sense.`,
      },
    },
    {
      title: 'Leaks and refresh',
      body: `
        <p>The charge leaks away through the access transistor's channel and its junction. Here a stored 1 halves every
        ${CELL_HALFLIFE} clock cycles, and the amplifier reads it correctly while its bit line moves by more than its offset: for
        <strong>${SAFE_CYCLES} cycles</strong> after the last restore. After that it reads X, and after a few more it reads 0 and writes
        that 0 back. The bit is gone.</p>
        <p><strong>Refresh</strong> is a read with nothing out: activate a row, sense it (which restores it), close it. Every row must be
        refreshed within the retention time. In silicon that is 64 ms, and a DDR4 device refreshes in 8 192 REF commands, one every
        ${DDR4_3200.tREFI / 1000} µs, each keeping it busy for ${DDR4_3200.tRFC} ns: ${((100 * DDR4_3200.tRFC) / DDR4_3200.tREFI).toFixed(1)} % of the time
        lost. The cells leak towards 0, so a stored 0 lasts forever. A cell in an open row never leaks: its amplifier holds it.</p>
        <div class="try">Wait 200 cycles and watch row ages turn orange, then red. Refresh a row and its age returns to 0.</div>`,
      scene: () => dramScene({ pattern: PATTERN }),
      challenge: {
        kind: 'reach', goal: 'Let at least 600 cycles pass (Wait) and keep every bit: all four rows still readable.',
        check: (st) => {
          const s = dramState(st);
          return !!s && s.waited >= 600 && PATTERN.every((bits, r) => [0, 1, 2, 3].every((c) => ((bits >> c) & 1 ? cellLevel(st, r, c) >= READABLE : cellLevel(st, r, c) <= 0.5)));
        },
        answer: `Wait 200, Refresh all, three times. Each row is restored before ${SAFE_CYCLES} cycles pass. Waiting 400 at once would be too late: the 1s would have fallen below ${(READABLE * VDD_VOLTS).toFixed(3)} V.`,
      },
    },
    {
      title: 'Rows, columns, banks',
      body: `
        <p>A real device is 16 <strong>banks</strong>, each an array of 64 K rows with its own amplifiers. The address splits into
        bank, row and column. An access to a bank whose amplifiers already hold the row is a <strong>row hit</strong>: only the column
        command. A closed bank needs an activate first (a <strong>miss</strong>). Another row open in that bank needs a precharge
        before the activate (a <strong>conflict</strong>).</p>
        <p>Rows are interleaved over the banks, so consecutive lines fill a row and then move on to the next bank. Banks are
        independent: while one waits for its precharge, another can be read. Two streams that land in the same bank keep closing each
        other's rows. A memory copy whose destination sits a multiple of the bank stride away does exactly that.</p>`,
      widget: rowBufferWidget,
      challenge: {
        kind: 'quiz',
        question: 'The copy with 2 banks and the plain mapping: source at word 0, destination at word 1 024 (rows of 16 words). Why do almost all its accesses conflict?',
        options: ['1 024 words is a whole number of rows times both banks, so each source line and its destination share a bank and evict each other\'s row', 'The row buffer only holds one line', 'Writes always need a precharge', 'The burst is too short'],
        answer: 0,
        explain: '1 024 / (16 × 2) = 32 rows: the destination is the same bank, 32 rows down. The XOR hash folds the row\'s parity into the bank number, so the two streams land in different banks and both rows stay open.',
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
        Chapter 21's caches charge a fixed 8 for every miss, which is a row hit. Chapter 33 builds the controller that issues these
        commands, and lets the caches pay what the row buffer says.</p>`,
      widget: timingWidget,
      challenge: {
        kind: 'quiz',
        question: 'The same DDR4-3200 device behind a 3 GHz CPU: how many cycles does a row conflict cost for a 4-word line?',
        options: [String(accessCycles('conflict', TIMING)), '42', String(conflict3), '1 000'],
        answer: 2,
        explain: `Each of tRP, tRCD and tCAS is 13.75 ns, ${cyclesOf(DDR4_3200.tRP, GHZ3)} cycles at 0.33 ns, plus the 4-word burst: ${conflict3}. The nanoseconds stayed, the cycles multiplied by 10: the memory wall.`,
      },
    },
  ],
};
