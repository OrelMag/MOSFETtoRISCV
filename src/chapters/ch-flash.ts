import { groupDigits } from '../sim/numfmt';
import { CLOCK_NS } from '../dram/timing';
import { FLASH_REAL_US, FLASH_TIMES } from '../flash/model';
import { bchParity, codewordFail, maxRber } from '../flash/ecc';
import { eccChannel } from '../lib/coding';
import { V_READ, vtOf } from '../lib/flash';
import { findNode } from '../sim/flatten';
import { FG_READ, FG_STEP, type SwitchSim } from '../sim/switchsim';
import type { Stage } from '../view/stage';
import { disk3d } from '../widgets/disk3d';
import { fgate3d } from '../widgets/fgate3d';
import { withModel } from '../widgets/modelhost';
import { flashActions, flashScene, ftlWidget, wearWidget } from '../widgets/flash';
import type { Chapter } from './types';
import { numOf } from './order';

/** The rows the NOR scenes start with (bit c = bit line c; a 0 is a programmed cell). */
const PATTERN = [0b0011, 0b1010, 0b1111, 0b0101];
/** Step 2's goal: row 1 rewritten to 0110, the others kept. */
const TARGET = [0b0011, 0b0110, 0b1111, 0b0101];

/** What the cells of a scene's array hold, row by row (a cell holds 1 while erased). */
function rowsOf(st: Stage, rows: number): number[] {
  const sim = st.sim as SwitchSim | null;
  if (!sim) return [];
  return Array.from({ length: rows }, (_, r) => {
    let v = 0;
    for (let c = 0; c < 4; c++) {
      const li = findNode(sim.design.root, [`c${r}_${c}`])?.leafIndex;
      if (li !== undefined && sim.fgCharge(li) < FG_READ) v |= 1 << c;
    }
    return v;
  });
}

const pulses = Math.ceil(FG_READ / FG_STEP);
const fmtN = groupDigits;
/** Chapter's ECC table: BCH on 1 KiB codewords, computed from the binomial tail. */
const ECC_ROWS = [1, 4, 8, 24, 40].map((t) => { const parity = bchParity(8192, t), n = 8192 + parity; return { t, parity, f5: codewordFail(n, t, 1e-5), f3: codewordFail(n, t, 1e-3), max: maxRber(8192, t) }; });
const sci = (x: number) => { if (x < 1e-99) return '< 10<sup>-99</sup>'; const [m, e] = x.toExponential(1).split('e'); return x > 0.1 ? x.toFixed(2) : m + ' × 10<sup>' + e.replace('+', '').replace('-', '-') + '</sup>'; };
/** A real page read at our clock, and how far the model scales the busy times down. */
const READ_REAL = Math.round((FLASH_REAL_US.read * 1000) / CLOCK_NS);
const SCALE = 10 * Math.round(READ_REAL / FLASH_TIMES.read / 10);

export const chFlash: Chapter = {
  id: 'flash', num: numOf('flash'), title: 'Flash', level: 'Memory in depth',
  blurb: 'The floating-gate transistor at switch level, programmed pulse by pulse and erased by the block; NOR against NAND arrays; and the translation layer that never overwrites: mapping, garbage collection, wear levelling, bad blocks.',
  goals: [
    'say how charge on a floating gate shifts a cell\'s threshold, and so what it reads',
    'explain why flash programs only from 1 to 0, a row at a time, and erases only whole blocks',
    'compare NOR and NAND arrays in area, read path and use',
    'follow a flash translation layer through rewrites and garbage collection, and compute its write amplification',
    'say what ECC buys: BCH parity and the raw bit error rate it absorbs, from the binomial tail',
  ],
  builds: ['mosfet', 'memory'],
  recap: {
    keep: [
      `Charge on the floating gate raises the threshold. Erased, Vt = ${vtOf(0)} V: the cell conducts at the ${V_READ} V read voltage and reads 1. Programmed, Vt ≥ ${V_READ} V: it reads 0. Here a pulse adds ${(5 * FG_STEP).toFixed(1)} V, so a program takes ${pulses} pulses, each followed by a verify.`,
      'Programming only clears bits (1 → 0); here a row at a time, each bit line programming or inhibiting its cell (NAND programs a page at once by tunnelling; real NOR a few bytes at a time by hot electrons). Only a block erase sets bits back to 1: <strong>flash cannot overwrite</strong>.',
      `Real SLC: a page read ${FLASH_REAL_US.read} µs, a program ${FLASH_REAL_US.program} µs, a block erase ${FLASH_REAL_US.erase / 1000} ms. The model scales them down about ${SCALE}× (ratios kept): ${FLASH_TIMES.read}, ${FLASH_TIMES.program} and ${FLASH_TIMES.erase} cycles. Unscaled, a read alone is ${fmtN(READ_REAL)} of our cycles.`,
      'Several bits a cell (MLC 2, TLC 3, QLC 4: 4 to 16 threshold levels) trade margin for density: slower programs, fewer erases, and a stronger ECC with each generation. 3D NAND stands the strings up, hundreds of layers high.',
      'NOR: every cell on its bit line, about 10 F², random reads in tens of nanoseconds (boot code, execute in place). NAND: cells in series, about 4 F², a pass voltage on the other rows, pages in tens of microseconds (files, SSDs).',
      'The translation layer writes each version to a fresh page and maps logical to physical pages. Stale pages wait for garbage collection. Write amplification = page programs / host writes; spare space lowers it, wear levelling spreads the erases.',
      `Raw bit errors (RBER 10<sup>-6</sup> fresh, 10<sup>-3</sup> worn TLC) are corrected by a BCH code per 1 KiB codeword: t errors cost 14 · t parity bits, and t = ${ECC_ROWS[2].t} keeps UBER below 10<sup>-15</sup> only up to RBER ${sci(ECC_ROWS[2].max)}.`,
    ],
    practise: ['m_flash'],
    check: [
      {
        question: 'A row holds 1100. You program it with data 1010 and do not erase. What does it hold?',
        options: ['1000', '1010', '1110', '0110'],
        answer: 0,
        explain: 'A program can only clear bits, so the result is the AND of the two: 1100 AND 1010 = 1000. Writing 1010 for real needs an erase of the block first.',
        why: ['', 'Bit 1 is 0 in the row and 1 in the data. A program cannot raise a bit: only an erase can.', 'That is the OR. A program adds charge, which can only turn 1s into 0s.', 'That is the XOR. Flash has no toggle: a programmed bit stays 0 until its block is erased.'],
      },
      {
        question: 'Why does a NAND cell take about 4 F² where a NOR cell takes about 10?',
        options: [
          'Its cells sit in series and share one contact at each end of the string; a NOR cell needs a bit-line contact of its own or shared with one neighbour',
          'A NAND cell is a smaller transistor',
          'A NAND cell stores two bits',
          'NAND needs no sense amplifiers',
        ],
        answer: 0,
        explain: 'The contacts, not the transistors, set the pitch. A string of eight here (128 or more in real chips) pays for two contacts in all.',
        why: ['', 'The cell is the same floating-gate transistor in both arrays. The difference is the wiring.', 'Both arrays here store one bit a cell (SLC). Several bits a cell is a separate trick, open to either.', 'Every bit line still needs a sense circuit. What NAND saves is a contact per cell.'],
      },
      {
        question: 'Garbage collection takes a block of 8 pages, 6 of them still valid. Counting the host writes that then fill the freed pages, what is the write amplification?',
        options: ['4', '3', '1.33', '0.75'],
        answer: 0,
        explain: 'The block frees 8 − 6 = 2 pages for 6 copies. Two host writes then cost 2 + 6 = 8 page programs: 8 / 2 = 4.',
        why: ['', 'That is copies per freed page. The host\'s own write into each freed page is a program too.', 'That is 8 / 6, pages per valid page: no measure of extra programs.', 'That is the fraction of the block still valid. Write amplification is programs divided by host writes.'],
      },
    ],
  },
  steps: [
    {
      title: 'A gate that remembers',
      body: `
        <p>A <span data-show="c0_0">flash cell</span> is an NMOS transistor with a second gate buried in the oxide under the first, connected to nothing. Electrons
        put on this <strong>floating gate</strong> stay there for years, and their charge raises the transistor's threshold. Erased,
        the cell has Vt = ${vtOf(0)} V and conducts at the read voltage of ${V_READ} V: it reads 1. Programmed, Vt ≥ ${V_READ} V and it stays
        off: it reads 0. One transistor a bit, no capacitor to refresh, and nothing lost without power.</p>
        <p>Its ancestor is <a href="#/c/memory/0">chapter 10</a>'s ROM, where a bit is a connection that is there or not: in a mask ROM, a
        transistor at the crossing of word and bit line, placed or left out at manufacture. EPROM (Intel, 1971) made that transistor a
        floating gate, programmed electrically and erased by ultraviolet light through a quartz window; EEPROM erased electrically, a byte
        at a time, at the price of a second transistor per cell. Masuoka's flash (Toshiba, 1984) went back to one transistor and erased a
        whole block at once, "in a flash".</p>
        <p>The simulator gives each floating gate a charge. A program pulse adds ${FG_STEP} (${(5 * FG_STEP).toFixed(1)} V of threshold), an erase pulse removes
        it all. The panel's curve is the selected cell's drain current against its gate voltage, the dashed one an erased cell's.</p>
        <p>Why it works: the floating gate is insulated on every side, so charge put there has nowhere to go. The control gate sees the cell through the
        series of two capacitors, and the electrons on the floating gate screen it: a higher control-gate voltage is needed before the channel inverts,
        which is the shifted threshold. A read barely touches the charge; it applies one voltage between the two thresholds and asks whether the cell conducts.
        The cost is the insulation itself: forcing charge through it wears it, and that, not any speed limit, is what makes flash programmable only a limited number of times.</p>
        <div class="try">Pick a cell of <span data-show="c0_0 c0_1 c0_2 c0_3">row 0</span>, program the row with data 1110, and watch its threshold climb pulse by pulse.</div>`,
      tour: {
        beats: [
          { title: 'Erased cells read 1', say: `Row 0, read voltage on. Every cell is erased, Vt = ${vtOf(0)} V, below the ${V_READ} V read voltage: all four conduct and pull their bit lines low, and the output inverters give 1. <code>dout0</code> = {v:dout0}.`, set: { row: 0, rd: 1 }, at: [], show: ['c0_0', 'c0_1', 'c0_2', 'c0_3'], expect: { dout0: 1, dout1: 1 } },
          { title: 'First pulse', say: `Read off, bit line 0 pulled low (<code>din0</code> = 0), <code>pgm</code> rises: electrons tunnel onto cell 0's floating gate. One pulse adds ${FG_STEP} of charge. Cells 1 to 3 have <code>din</code> = 1 and are inhibited.`, set: { rd: 0, din0: 0, pgm: 1 }, show: ['c0_0'] },
          { title: 'Verify: not yet', say: `The program line falls and the data lines go back high; a read gives <code>dout0</code> = {v:dout0}. Charge ${FG_STEP} gives Vt = ${vtOf(FG_STEP).toFixed(1)} V, still below the ${V_READ} V read voltage: the cell conducts and reads as erased.`, set: { pgm: 0, din0: 1, rd: 1 }, show: ['c0_0'], expect: { dout0: 1 } },
          { title: 'Second pulse', say: 'The same pulse again: the verify said the bit was not yet 0.', set: { rd: 0, din0: 0, pgm: 1 }, show: ['c0_0'] },
          { title: 'Verify: programmed', say: `Vt = ${vtOf(2 * FG_STEP).toFixed(1)} V is above ${V_READ} V: cell 0 stays off and <code>dout0</code> reads {v:dout0}. The other three cells, inhibited, still read {v:dout1}.`, set: { pgm: 0, din0: 1, rd: 1 }, show: ['c0_0', 'c0_1'], expect: { dout0: 0, dout1: 1 } },
        ],
      },
      more: {
        derive: `<p>The threshold shifts by the stored charge over the coupling capacitance to the control gate, ΔVt = −Q / C<sub>cg</sub>. In this model a pulse adds ${FG_STEP} units of charge and the read passes
          below ${FG_READ}, so a cell is programmed after ⌈${FG_READ} / ${FG_STEP}⌉ = ${pulses} pulses. Erased, Vt = ${vtOf(0)} V; after each pulse:
          ${[0, 1, 2, 3].map((n) => `${n}: ${vtOf(n * FG_STEP).toFixed(1)} V`).join(', ')}. Stopping at the first pulse that passes the read voltage keeps the oxide stress and the
          threshold spread small, which is what the verify after each pulse is for.</p>`,
        real: `<p>NAND programs by Fowler–Nordheim tunnelling through an oxide of the order of 8 nm, at about 20 V on the control gate, in incremental steps (ISPP: each pulse a little higher)
          with a verify after each. Erase puts the high voltage on the substrate instead. Each cycle traps a few electrons in the oxide, so the window between erased and programmed narrows with
          use; data retention is specified as years at a given wear, not as forever.</p>`,
        pitfall: `<p>Reading a half-programmed cell as programmed, or the reverse. A cell with Vt just under the read voltage reads 1 today and 0 after a little drift, so programming overshoots on purpose and
          each pulse is followed by a verify at a stricter voltage than the normal read. In the panel, one pulse changes the threshold curve but not the bit.</p>`,
      },
      scene: () => flashScene({ kind: 'nor' }),
      tries: [(st) => rowsOf(st, 1)[0] === 0b1110],
      challenge: {
        kind: 'quiz',
        question: `A cell's threshold is ${vtOf(FG_STEP).toFixed(1)} V after one program pulse. What does it read?`,
        options: ['1: at the read voltage it still conducts', '0: it has been programmed', 'X: it is between the two', 'It depends on the bit line'],
        answer: 0,
        why: [
          '',
          `One pulse is not enough: the cell reads 0 only once its threshold passes the ${V_READ} V read voltage. That is why programming verifies and pulses again.`,
          'A read applies one gate voltage: a cell whose threshold is below it conducts (1), one whose threshold is above it stays off (0). There is no third reading.',
          'The bit line only senses whether the cell conducts. The floating gate\'s charge, through the threshold, decides that.',
        ],
        explain: `${vtOf(FG_STEP).toFixed(1)} V is below the ${V_READ} V read voltage, so the cell still turns on: 1. That is why programming verifies after each pulse and repeats: here ${pulses} pulses. Too many pulses push the threshold needlessly high and wear the oxide.`,
      },
    },
    {
      title: 'The floating gate, up close',
      body: `
        <p>The same cell, drawn as a stack: p substrate, a thin tunnel oxide, the <strong>floating gate</strong>, a second oxide, the <strong>control gate</strong>.
        The control gate has a wire to its word line. The floating gate has none: it is sealed in oxide on every side, which is why charge put there stays.
        Four cells share one strip, as in a NAND string, with the n+ regions between them as shared source and drain.</p>
        <p>A program pulse tunnels electrons from the channel through the tunnel oxide into the floating gate: ${FG_STEP} of charge a pulse,
        Vt = 1 + 5q, so ${pulses} pulses carry Vt past the read voltage of ${V_READ} V. Erase empties every cell of the block at once. A read of one cell puts ${V_READ} V on its control gate and a
        pass voltage on the others, high enough that they conduct whatever they hold. The string carries current only if the chosen cell does, so its
        bit is read through the other cells, which are all on.</p>
        <p>The voltages are illustrative. In a real NAND string the erased cells have a threshold below 0 V and the chosen word line is read at about 0 V, with the others passed at 4.5 to 6 V, and a program step (ISPP) moves Vt by 0.2 to 0.5 V rather than the model's 1 V; the model keeps the NOR-style window above so that one rule serves the whole chapter. The 5 in Vt = 1 + 5q is the floating gate's coupling to the control gate: the charge needed for a volt of threshold is Q / C<sub>ONO</sub>, and the same ratio, GCR = C<sub>ONO</sub> / (C<sub>ONO</sub> + C<sub>tox</sub>) of about 0.6, sets how much of the programming voltage lands across the thin tunnel oxide.</p>
        <div class="try">Choose cell 3, pulse until the string goes from conducting to blocked, then erase the block.</div>`,
      widget: () => fgate3d(),
    },
    {
      title: 'Program and erase',
      body: `
        <p>Programming forces electrons through the oxide, so it only ever moves bits from 1 to 0, and slowly: a pulse at a time, a
        verify read after each. Here all the cells of a row are programmed together, each bit line choosing: <span data-show="wd0 wd1 wd2 wd3">pulled low</span>, its cell is
        programmed; left high, it is inhibited. That is NAND's way, Fowler–Nordheim tunnelling at nanoamps a cell, so a whole page
        at once. A real NOR chip programs by channel hot-electron injection instead (volts on the drain, a fraction of a milliamp a
        cell), so only a few bytes or words at a time. Both erase by tunnelling the electrons back out, and the array does it for a
        whole <strong>block</strong> at once.</p>
        <p>So flash cannot overwrite. To turn one 0 back into a 1, the controller must read every row of the block, erase the
        block and program the rows again. The times show what that costs: on a real SLC device a page read is
        ${FLASH_REAL_US.read} µs, a page program ${FLASH_REAL_US.program} µs, a block erase ${FLASH_REAL_US.erase / 1000} ms. At our
        ${CLOCK_NS.toFixed(2)} ns clock a read alone would be ${fmtN(READ_REAL)} cycles, so the model scales all three down about ${SCALE}×,
        keeping their ratios: ${FLASH_TIMES.read}, ${FLASH_TIMES.program} and ${FLASH_TIMES.erase} cycles.</p>
        <p>Why a block and not a row: the erase is done through the well, which a whole plane shares; word-line bias then decides which cells it reaches, grounded in the block being erased and floating elsewhere, and that selection is done for a block's word lines together. So one row cannot be erased alone without disturbing its neighbours, and the controller's problem becomes what to do with
        the rest of a block when one row of it changes. The answer, two steps on, is not to change it in place.</p>
        <div class="try"><span data-show="c1_0 c1_1 c1_2 c1_3">Row 1</span> holds 1010. Make it 0110 and keep rows 0, 2 and 3 as they are.</div>`,
      more: {
        derive: `<p>A program can only clear bits, so it ANDs the data into the stored word: new = old AND data. Row 1 holds 1010 and 0110 is wanted: 1010 AND 0110 = 0010, not 0110,
          because bit 2 would have to rise. Rewriting costs, in the model's cycles, a read of each of the 3 other rows (${3 * FLASH_TIMES.read}), the erase (${FLASH_TIMES.erase}) and a program of each row
          that needs a 0 (3 × ${FLASH_TIMES.program} = ${3 * FLASH_TIMES.program}): ${3 * FLASH_TIMES.read + FLASH_TIMES.erase + 3 * FLASH_TIMES.program} cycles to change two bits, against ${FLASH_TIMES.program} for a program alone.</p>`,
        real: `<p>NAND erases blocks of a few hundred kilobytes to several megabytes, and programs pages of 4 to 16 KB in order inside a block. NOR erases sectors of 64 to 256 KB and programs bytes or words,
          which is why code can be updated in place there with a sector buffer. The asymmetry (read, then program, then erase, each about ten times slower than the last) is a property of the physics,
          not the interface.</p>`,
        pitfall: `<p>Erasing to change one bit. The erase takes the whole block, so the other rows' data must be held somewhere else first; if power fails between the erase and the
          reprogramming they are gone. This is the real hazard of in-place updates on raw flash, and the reason the next steps never do it.</p>`,
        numbers: `<table class="mini"><tr><th>operation</th><th>real SLC</th><th>model cycles</th></tr>
          <tr><td>page read</td><td>${FLASH_REAL_US.read} µs</td><td>${FLASH_TIMES.read}</td></tr>
          <tr><td>page program</td><td>${FLASH_REAL_US.program} µs</td><td>${FLASH_TIMES.program}</td></tr>
          <tr><td>block erase</td><td>${FLASH_REAL_US.erase / 1000} ms</td><td>${FLASH_TIMES.erase}</td></tr></table>`,
      },
      scene: () => flashScene({ kind: 'nor', pattern: PATTERN }),
      challenge: {
        kind: 'reach', goal: 'Rewrite row 1 from 1010 to 0110, and keep the other rows (0011, 1111, 0101).',
        check: (st) => rowsOf(st, 4).every((v, r) => v === TARGET[r]),
        hints: [
          'A program can only clear bits (1 → 0). Which bit of 1010 → 0110 has to go the other way?',
          'Only an erase sets bits back to 1, and it takes the whole block: note what the other rows hold before you erase.',
        ],
        answer: 'Programming 0110 over 1010 only clears bits: 1010 AND 0110 = 0010. Bit 2 must go from 0 to 1, which only an erase can do. Read rows 0, 2 and 3, Erase block, then program all four rows: 0011, 0110, 1111 (nothing to program), 0101.',
        solve: (st) => { const a = flashActions(st); a?.erase(); TARGET.forEach((d, r) => { if (d !== 0b1111) a?.program(r, d); }); st.refresh(); },
      },
    },
    {
      title: 'NOR and NAND',
      body: `
        <p>In the <strong>NOR</strong> array every cell sits between its bit line and the source line, so any one cell can be read
        directly and fast: tens of nanoseconds, fast enough to run code from (execute in place). Each cell needs a bit-line
        contact, its own or shared with one neighbour, about 10 F² of silicon (F: the feature size).</p>
        <p>A <strong>NAND</strong> string puts its <span data-show="c0_0 c1_0 c2_0 c3_0 c4_0 c5_0 c6_0 c7_0">cells in series</span>, eight here (128 or more in real chips), with
        <span data-show="ss0 gs0">one contact at each end</span>.
        A read puts the selected row at the read voltage and every other row at the <span data-show="p0 p1 p2 p3 p4 p5 p6 p7"><strong>pass voltage</strong></span>, high enough to turn on
        any cell whatever it holds; the string conducts only if the selected cell is erased. About 4 F² a cell and no random access:
        a page is sensed in tens of microseconds and then streamed out. NAND holds files and SSDs, NOR holds boot code.</p>
        <p>The two arrays are one cell wired two ways, and the wiring decides everything else. Parallel cells give random access and cost a contact each;
        series cells give density and force every access to go through the whole string. The cost of the series path shows in two places: reads are slow
        (a small current through many transistors), and every read applies the pass voltage to the other rows, a mild stress that the last step comes back to.</p>
        <div class="try">Read a row: every other row's cells sit at the pass voltage. Program a row, then erase the block.</div>`,
      more: {
        derive: `<p>Transistors and contacts per bit. NOR: 1 cell and 1 bit-line contact (here one a cell; real arrays often share one between two). A NAND string of N cells has N + 2 transistors (the string and ground selects) and a single
          bit-line contact shared by all N bits, so (N + 2) / N transistors and 1 / N contacts per bit. The contact, not the transistor, sets the pitch, which is why the string length is the lever.</p>`,
        real: `<p>The threshold is analog, so a cell can hold more than one bit: <strong>MLC</strong> places it at one of 4 levels (2 bits),
          <strong>TLC</strong> 8 (3 bits), <strong>QLC</strong> 16 (4 bits). A read then compares against 3, 7 or 15 read voltages, a
          program steps in finer pulses with more verifies, and the margins between levels shrink: QLC programs several times slower
          than SLC and survives on the order of a thousand erases against SLC's 100 000. The same cell, the same array; only the
          sensing and the controller change.</p>
          <p>Planar cells stopped shrinking near 15 nm: a few dozen electrons per level, and neighbours coupling through the gap.
          <strong>3D NAND</strong> (Samsung's V-NAND, 2013, 24 layers) stands each string up as a vertical channel through a stack of
          word-line layers, most with a charge-trap layer in place of the floating gate; current parts stack over 200 layers. Density
          now comes from layers, not from a smaller F.</p>`,
        pitfall: `<p>Reading a NAND row as if the other cells were not there. In the scene, a string conducts only when every cell above and below the selected one is on, so a programmed cell
          that is not at the pass voltage would block the read. The pass voltage must exceed the highest threshold of any level, which is also what limits how many levels fit.</p>`,
        numbers: `<table class="mini"><tr><th>string length N</th><th>transistors per bit</th><th>bit-line contacts per bit</th></tr>
          <tr><td>NOR (no string)</td><td>1.00</td><td>1.00</td></tr>
          ${[8, 32, 64, 128].map((n) => `<tr><td>${n}</td><td>${((n + 2) / n).toFixed(2)}</td><td>${(1 / n).toFixed(3)}</td></tr>`).join('')}</table>`,
      },
      scene: () => flashScene({ kind: 'nand', pattern: [0b1010, 0b1111, 0b0110, 0b1111, 0b0001, 0b1111, 0b1111, 0b1100] }),
      challenge: {
        kind: 'quiz',
        question: 'Why can a NAND string not be read faster by selecting one cell directly?',
        options: ['Its cells are in series: the current of the selected one must pass through all the others', 'NAND cells hold more charge', 'The pass voltage is too slow to set up', 'NAND has no sense amplifier'],
        answer: 0,
        why: [
          '',
          'The cell is the same floating-gate transistor in both arrays. The difference is the wiring.',
          'The pass voltage is set once per read. What makes the read slow is the small current through a long series chain.',
          'It has a sense circuit on every bit line, as NOR does. What it senses is a weak current through every cell of the string.',
        ],
        explain: 'The string is one path. The others are turned fully on (the pass voltage) so that only the selected cell decides, but the current is the small current of a long series chain: sensing it takes microseconds, so NAND reads a whole page at a time.',
      },
    },
    {
      title: 'Never overwrite',
      body: `
        <p>A host writes the same block address again and again. The flash cannot overwrite, so the controller's
        <strong>flash translation layer</strong> writes each new version to a fresh page and keeps a <strong>logical-to-physical
        table</strong>: logical page 3 now lives in block 1, page 2. The old copy is <strong>stale</strong>: still programmed, no longer
        wanted, and only an erase of its whole block frees it.</p>
        <p>When free blocks run low, <strong>garbage collection</strong> picks the block with the fewest valid pages, copies those to the
        active block and erases it. Every copy is a program the host did not ask for: <strong>write amplification</strong> is page programs
        divided by host writes. The table itself lives in the controller's RAM and is rebuilt from the pages at power-up (each page
        records its logical number).</p>
        <p>An SSD replaces the spinning disk modelled below, and a disk rewrites a sector where it is: seek to the track, wait for the sector to come round, write (press <em>Rewrite this sector</em> in the model). Flash cannot, so the layer is what makes flash look like a disk: the host sees a flat array of overwritable sectors, and the controller turns every overwrite into a program of a
        free page, a table update and, later, an erase. The host's speed then depends on how much work is waiting in the background, which is why an SSD slows down as it fills.</p>`,
      more: {
        derive: `<p>A block of n pages with v valid ones frees n − v pages at the price of v copies. To fill the freed pages the host writes n − v pages, so the device programs v + (n − v) = n pages for n − v host writes:
          write amplification = n / (n − v). For n = 8: ${[0, 2, 4, 6, 7].map((v) => `v = ${v} gives ${(8 / (8 - v)).toFixed(2)}`).join('; ')}. The cheaper the victim (fewer valid pages), the nearer WA is to 1,
          which is what picking the block with the fewest valid pages does.</p>`,
        real: `<p>The table is the controller's largest data structure: a 4-byte entry per 4 KiB page is 1 MiB of RAM per GiB of flash, ${2 ** 40 / 2 ** 12 * 4 / 2 ** 30} GiB for a 1 TiB drive, which is why
          the cheapest SSDs map in larger units or keep part of the table on the flash. TRIM (or discard) lets the host say which logical pages are dead, so they need not be copied. Sequential
          writes invalidate whole blocks together and cost almost nothing to collect; random small writes are the worst case.</p>`,
        pitfall: `<p>Thinking a delete frees a page. Until the block holding it is collected the stale copy still sits there, readable with the right tools, and a drive that has not been told
          (TRIM) treats it as live data and copies it during garbage collection. In the widget, watch the stale count rise on a rewrite and fall only when a block is erased.</p>`,
      },
      widget: () => withModel(ftlWidget(), disk3d()),
      challenge: {
        kind: 'quiz',
        question: 'The host has written logical page 2 five times. How many valid copies of it are on the flash?',
        options: ['One: the table points to the newest, the other four are stale', 'Five', 'None until garbage collection', 'Two: the newest and a backup'],
        answer: 0,
        why: [
          '',
          'Five copies were programmed, but only the one the table points to is valid. The other four are stale.',
          'The newest copy is valid from the moment it is programmed. Garbage collection only reclaims stale pages.',
          'The translation layer keeps no backup. The older versions are stale, not reserves.',
        ],
        explain: 'Each write programs a fresh page and marks the old one stale. Until their blocks are collected the four old copies still hold their data, which is why deleting a file on an SSD does not erase it at once (and why TRIM tells the controller which pages it may forget).',
      },
    },
    {
      title: 'Garbage, wear and bad blocks',
      body: `
        <p>The oxide wears with every erase: an SLC block lasts about 100 000 erase cycles, TLC some 3000. Garbage collection on its
        own erases the same few blocks over and over (those holding hot data), and they wear out first. <strong>Wear levelling</strong>
        opens the least-erased free block next, so the erases spread. That is dynamic wear levelling: a block full of cold data never comes free, so controllers also move cold data now and then (static wear levelling), which this model leaves out. Some blocks are bad from the factory, and others fail in
        service: the controller keeps a list and never uses them again.</p>
        <p><strong>Spare space</strong> (over-provisioning) is the controller's room to work. With little spare, the blocks it collects are
        still mostly valid, so every free page costs many copies. With more, write amplification drops toward 1. SSDs keep 7 to 28 %
        of their flash out of sight for this.</p>
        <p>Three limits meet here and each has its own remedy: the oxide wears (spread the erases), blocks fail (skip them) and the drive fills (keep room to move data).
        The controller's firmware is largely an accountant of these budgets, and the drive's rated lifetime is the point where the first one runs out.</p>`,
      more: {
        derive: `<p>Total host data a drive can take before wear-out = capacity × erase endurance / write amplification, assuming perfect levelling. For 1 TB of TLC (${fmtN(3000)} erases) and WA 1, 2, 4:
          ${[1, 2, 4].map((wa) => `${(1e12 * 3000 / wa / 1e15).toFixed(2)} PB`).join(', ')}. Halving WA doubles the life, which is why over-provisioning, TRIM and sequential-friendly layouts are worth real money.</p>`,
        real: `<p>Here every cell reads exactly what was programmed. Real cells do not: charge leaks over months (faster in worn
          blocks), neighbours couple, and each level is a spread of thresholds that grows with wear. Every page carries spare bytes of
          <strong>ECC</strong>: BCH codes correcting tens of bits per kilobyte in SLC and early MLC, then <span data-ahead="ldpc">LDPC codes (parity checks so sparse that a decoder can pass soft beliefs along them; a later chapter decodes one)</span> in TLC and QLC,
          which use soft reads (the same page sensed at several read voltages) to decide the doubtful bits. When the corrected-bit count
          climbs, the controller moves the data and retires the block.</p>
          <p><strong>Read disturb</strong>: a NAND read puts the pass voltage on every other row of the block, a weak program pulse for
          their cells. After many thousands of reads a block's unselected pages drift toward 0, so the controller counts reads per
          block and rewrites a block before it reaches the limit: a read can cost a write.</p>`,
        pitfall: `<p>Reading the endurance figure as a promise per block. It is a statistical rating: some blocks die early, and a drive's life ends when the spare pool for replacing them runs out, not when the average
          block reaches the limit. Static data is the other trap: blocks holding it are barely worn while the free pool is worn out, unless the controller moves cold data to spread the wear.</p>`,
        numbers: `<table class="mini"><tr><th>cell</th><th>bits</th><th>levels</th><th>erases (typical)</th></tr>
          <tr><td>SLC</td><td>1</td><td>2</td><td>${fmtN(100000)}</td></tr><tr><td>MLC</td><td>2</td><td>4</td><td>${fmtN(10000)}</td></tr>
          <tr><td>TLC</td><td>3</td><td>8</td><td>${fmtN(3000)}</td></tr><tr><td>QLC</td><td>4</td><td>16</td><td>${fmtN(1000)}</td></tr></table>`,
      },
      widget: wearWidget,
      challenge: {
        kind: 'quiz',
        question: 'Why does more spare space lower write amplification?',
        options: ['Collected blocks hold fewer valid pages, so fewer copies are needed per page freed', 'Spare blocks are faster', 'Wear levelling is switched off', 'The host writes less'],
        answer: 0,
        why: [
          '',
          'Every block is the same flash. Spare space helps by leaving fewer valid pages to copy, not by speed.',
          'Wear levelling picks which free block opens next. The copies a collection needs depend on how full the collected block is.',
          'Write amplification is a ratio, programs per host write. The host writes the same; the copies per write fall.',
        ],
        explain: 'With logical space L on physical space P, the average block is L / P valid. Collecting a block with v valid pages out of n frees n − v pages for v copies; as L / P falls, v falls, and so do the copies per freed page.',
      },
    },
    {
      title: 'Bit errors and ECC',
      body: `
        <p>Everything so far read back exactly what was programmed. Real cells do not: the threshold is analog, it drifts with retention, read disturb, neighbours and wear, and some bits read wrong. The measure is the
        <strong>raw bit error rate</strong> (RBER), the fraction of bits that read wrong before correction: around 10<sup>-6</sup> for fresh SLC, 10<sup>-4</sup> to 10<sup>-3</sup> for worn TLC. The drive must
        still show an <strong>uncorrectable bit error rate</strong> (UBER) below about 10<sup>-15</sup>, so every page carries a code. <a href="#/c/cache/0">Chapter 22</a>'s SEC-DED word is the idea, on a
        small word: the <span data-show="enc">encoder</span> adds check bits on write, flips between write and read corrupt the stored word, the <span data-show="dec">decoder</span> finds one flipped bit and fixes it, or flags two it cannot fix.</p>
        <p>A page needs a stronger code over a longer word. A <strong>BCH</strong> code on a 1 KiB codeword (${fmtN(8192)} data bits) that corrects <em>t</em> bit errors costs m · <em>t</em> parity bits with m = 14: ${bchParity(8192, 1)} for t = 1, ${bchParity(8192, 8)} for t = 8, ${bchParity(8192, 40)} for t = 40. A 4 KiB page is four codewords, so t = 40 needs ${4 * bchParity(8192, 40) / 8} bytes of the page's spare area. Take raw errors as independent (real ones cluster by block, word line and age, so this is the optimistic case):
        the codeword fails when more than <em>t</em> of its ${fmtN(8192)}-plus bits flip, a binomial tail, computed here exactly:</p>
        <table class="mini"><tr><th>code</th><th>parity bits</th><th>fails at RBER 10<sup>-5</sup></th><th>fails at 10<sup>-3</sup></th><th>keeps UBER &lt; 10<sup>-15</sup> up to RBER</th></tr>
          ${ECC_ROWS.map((r) => `<tr><td>t = ${r.t}</td><td>${r.parity}</td><td>${sci(r.f5)}</td><td>${sci(r.f3)}</td><td>${sci(r.max)}</td></tr>`).join('')}</table>
        <p>The strength is a wear budget. Fresh flash at RBER 10<sup>-5</sup> needs t = 6 (t = 8 leaves a margin) for a 10<sup>-15</sup> UBER; worn TLC at 10<sup>-3</sup> needs t ≈ 40, five times the parity, and past that the controller
        retires the block. When the corrected-bit count of a read approaches t, the controller rewrites the data elsewhere before the next read can exceed it. TLC and QLC replace BCH with <span data-ahead="ldpc">LDPC (parity checks so sparse that a decoder can pass soft beliefs along them; a later chapter decodes one)</span> and soft reads:
        the same page sensed at several read voltages gives each bit a confidence, which corrects well beyond the hard-decision limit at the cost of several reads.</p>
        <div class="try">Set the data, then flip one stored bit (flip = 1), then two (flip = 3): single, then double.</div>`,
      scene: () => ({ root: eccChannel(8), inputs: { d: 0x5a, flip: 0 }, highlight: ['enc', 'dec'] }),
      more: {
        derive: `<p>P(codeword fails) = Σ<sub>i &gt; t</sub> C(n, i) p<sup>i</sup> (1 − p)<sup>n − i</sup> with n = ${fmtN(8192)} + m · t; UBER is that over the ${fmtN(8192)} data bits. The tail falls by roughly <em>np</em>/(<em>t</em> + 1) per extra correctable bit, so each added bit of <em>t</em> buys a growing factor while costing a constant m = 14 parity bits: each extra bit of strength is a better buy than the last, so t is set by the RBER to survive and the spare area there is.</p>`,
        pitfall: `<p>Correction hides wear until it cannot. A drive whose corrected-bit counters have been rising for months looks perfect to the host and then loses a page at once, when one more bit than t flips. SMART's "available spare" and the controller's own scan of corrected bits per page are the early warnings.</p>`,
      },
      challenge: {
        kind: 'reach', goal: 'Flip two stored bits so the decoder reports a double error it cannot correct.',
        check: (st) => st.value('double') === 1,
        hints: ['flip is a bit mask over the stored word.', 'Set flip to 3: bits 0 and 1.'],
        answer: 'flip = 0011 (any two bits): double = 1 and single = 0; the decoder detects the error but cannot say which bits to fix. One flipped bit is corrected and reported as single.',
        solve: (st) => st.setInputs({ d: 0x5a, flip: 3 }),
      },
    },
  ],
};

