import { CLOCK_NS } from '../dram/timing';
import { FLASH_REAL_US, FLASH_TIMES } from '../flash/model';
import { V_READ, vtOf } from '../lib/flash';
import { findNode } from '../sim/flatten';
import { FG_READ, FG_STEP, type SwitchSim } from '../sim/switchsim';
import type { Stage } from '../view/stage';
import { flashActions, flashScene, ftlWidget, wearWidget } from '../widgets/flash';
import type { Chapter } from './types';

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
const fmtN = (n: number) => n.toLocaleString('en-US').replace(/,/g, ' ');
/** A real page read at our clock, and how far the model scales the busy times down. */
const READ_REAL = Math.round((FLASH_REAL_US.read * 1000) / CLOCK_NS);
const SCALE = 10 * Math.round(READ_REAL / FLASH_TIMES.read / 10);

export const chFlash: Chapter = {
  id: 'flash', num: 35, title: 'Flash', level: 'Memory in depth',
  blurb: 'The floating-gate transistor at switch level, programmed pulse by pulse and erased by the block; NOR against NAND arrays; and the translation layer that never overwrites: mapping, garbage collection, wear levelling, bad blocks.',
  goals: [
    'say how charge on a floating gate shifts a cell\'s threshold, and so what it reads',
    'explain why flash programs only from 1 to 0, a row at a time, and erases only whole blocks',
    'compare NOR and NAND arrays in area, read path and use',
    'follow a flash translation layer through rewrites and garbage collection, and compute its write amplification',
  ],
  builds: ['mosfet', 'memory'],
  recap: {
    keep: [
      `Charge on the floating gate raises the threshold. Erased, Vt = ${vtOf(0)} V: the cell conducts at the ${V_READ} V read voltage and reads 1. Programmed, Vt ≥ ${V_READ} V: it reads 0. Here a pulse adds ${(5 * FG_STEP).toFixed(1)} V, so a program takes ${pulses} pulses, each followed by a verify.`,
      'Programming only clears bits (1 → 0); here a row at a time, each bit line programming or inhibiting its cell (NAND programs a page at once by tunnelling; real NOR a few bytes at a time by hot electrons). Only a block erase sets bits back to 1: <strong>flash cannot overwrite</strong>.',
      `Real SLC: a page read ${FLASH_REAL_US.read} µs, a program ${FLASH_REAL_US.program} µs, a block erase ${FLASH_REAL_US.erase / 1000} ms. The model scales them down about ${SCALE}× (ratios kept): ${FLASH_TIMES.read}, ${FLASH_TIMES.program} and ${FLASH_TIMES.erase} cycles. Unscaled, a read alone is ${fmtN(READ_REAL)} of our cycles.`,
      'Several bits a cell (MLC 2, TLC 3, QLC 4: 4 to 16 threshold levels) trade margin for density: slower programs, fewer erases, stronger ECC (BCH, then LDPC). 3D NAND stands the strings up, hundreds of layers high.',
      'NOR: every cell on its bit line, about 10 F², random reads in tens of nanoseconds (boot code, execute in place). NAND: cells in series, about 4 F², a pass voltage on the other rows, pages in tens of microseconds (files, SSDs).',
      'The translation layer writes each version to a fresh page and maps logical to physical pages. Stale pages wait for garbage collection. Write amplification = page programs / host writes; spare space lowers it, wear levelling spreads the erases.',
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
          'Its cells sit in series and share one contact at each end of the string; a NOR cell needs its own bit-line contact',
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
        <div class="try">Pick a cell of <span data-show="c0_0 c0_1 c0_2 c0_3">row 0</span>, program the row with data 1110, and watch its threshold climb pulse by pulse.</div>`,
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
        <div class="try"><span data-show="c1_0 c1_1 c1_2 c1_3">Row 1</span> holds 1010. Make it 0110 and keep rows 0, 2 and 3 as they are.</div>`,
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
        directly and fast: tens of nanoseconds, fast enough to run code from (execute in place). Each cell needs its own bit-line
        contact, about 10 F² of silicon (F: the feature size).</p>
        <p>A <strong>NAND</strong> string puts its <span data-show="c0_0 c1_0 c2_0 c3_0 c4_0 c5_0 c6_0 c7_0">cells in series</span>, eight here (128 or more in real chips), with
        <span data-show="ss0 gs0">one contact at each end</span>.
        A read puts the selected row at the read voltage and every other row at the <span data-show="p0 p1 p2 p3 p4 p5 p6 p7"><strong>pass voltage</strong></span>, high enough to turn on
        any cell whatever it holds; the string conducts only if the selected cell is erased. About 4 F² a cell and no random access:
        a page is sensed in tens of microseconds and then streamed out. NAND holds files and SSDs, NOR holds boot code.</p>
        <details class="deeper"><summary>Deeper: several bits a cell, and the third dimension</summary>
        <p>The threshold is analog, so a cell can hold more than one bit: <strong>MLC</strong> places it at one of 4 levels (2 bits),
        <strong>TLC</strong> 8 (3 bits), <strong>QLC</strong> 16 (4 bits). A read then compares against 3, 7 or 15 read voltages, a
        program steps in finer pulses with more verifies, and the margins between levels shrink: QLC programs several times slower
        than SLC and survives on the order of a thousand erases against SLC's 100 000. The same cell, the same array; only the
        sensing and the controller change.</p>
        <p>Planar cells stopped shrinking near 15 nm: a few dozen electrons per level, and neighbours coupling through the gap.
        <strong>3D NAND</strong> (Samsung's V-NAND, 2013, 24 layers) stands each string up as a vertical channel through a stack of
        word-line layers, most with a charge-trap layer in place of the floating gate; current parts stack over 200 layers. Density
        now comes from layers, not from a smaller F.</p></details>
        <div class="try">Read a row: every other row's cells sit at the pass voltage. Program a row, then erase the block.</div>`,
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
        records its logical number).</p>`,
      widget: ftlWidget,
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
        <p>The oxide wears with every erase: an SLC block lasts about 100 000 erase cycles, TLC some 3 000. Garbage collection on its
        own erases the same few blocks over and over (those holding hot data), and they wear out first. <strong>Wear levelling</strong>
        opens the least-erased free block next, so the erases spread. That is dynamic wear levelling: a block full of cold data never comes free, so controllers also move cold data now and then (static wear levelling), which this model leaves out. Some blocks are bad from the factory, and others fail in
        service: the controller keeps a list and never uses them again.</p>
        <p><strong>Spare space</strong> (over-provisioning) is the controller's room to work. With little spare, the blocks it collects are
        still mostly valid, so every free page costs many copies. With more, write amplification drops toward 1. SSDs keep 7 to 28 %
        of their flash out of sight for this.</p>
        <details class="deeper"><summary>Deeper: errors, ECC and read disturb</summary>
        <p>Here every cell reads exactly what was programmed. Real cells do not: charge leaks over months (faster in worn
        blocks), neighbours couple, and each level is a spread of thresholds that grows with wear. Every page carries spare bytes of
        <strong>ECC</strong>: BCH codes correcting tens of bits per kilobyte in SLC and early MLC, then LDPC codes in TLC and QLC,
        which use soft reads (the same page sensed at several read voltages) to decide the doubtful bits. When the corrected-bit count
        climbs, the controller moves the data and retires the block.</p>
        <p><strong>Read disturb</strong>: a NAND read puts the pass voltage on every other row of the block, a weak program pulse for
        their cells. After many thousands of reads a block's unselected pages drift toward 0, so the controller counts reads per
        block and rewrites a block before it reaches the limit: a read can cost a write.</p></details>`,
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
  ],
};

