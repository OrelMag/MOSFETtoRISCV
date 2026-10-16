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

export const chFlash: Chapter = {
  id: 'flash', num: 34, title: 'Flash', level: 'Memory in depth',
  blurb: 'The floating-gate transistor at switch level, programmed pulse by pulse and erased by the block; NOR against NAND arrays; and the translation layer that never overwrites: mapping, garbage collection, wear levelling, bad blocks.',
  steps: [
    {
      title: 'A gate that remembers',
      body: `
        <p>A flash cell is an NMOS transistor with a second gate buried in the oxide under the first, connected to nothing. Electrons
        put on this <strong>floating gate</strong> stay there for years, and their charge raises the transistor's threshold. Erased,
        the cell has Vt = ${vtOf(0)} V and conducts at the read voltage of ${V_READ} V: it reads 1. Programmed, Vt ≥ ${V_READ} V and it stays
        off: it reads 0. One transistor a bit, no capacitor to refresh, and nothing lost without power.</p>
        <p>Its ancestor is chapter 10's mask ROM, where a bit is a transistor that is there or not, fixed at manufacture. Flash makes
        that choice electrically, and can undo it.</p>
        <p>The simulator gives each floating gate a charge. A program pulse adds ${FG_STEP} (${(5 * FG_STEP).toFixed(1)} V of threshold), an erase pulse removes
        it all. The panel's curve is the selected cell's drain current against its gate voltage, the dashed one an erased cell's.</p>
        <div class="try">Pick a cell of row 0, program the row with data 1110, and watch its threshold climb pulse by pulse.</div>`,
      scene: () => flashScene({ kind: 'nor' }),
      challenge: {
        kind: 'quiz',
        question: `A cell's threshold is ${vtOf(FG_STEP).toFixed(1)} V after one program pulse. What does it read?`,
        options: ['1: at the read voltage it still conducts', '0: it has been programmed', 'X: it is between the two', 'It depends on the bit line'],
        answer: 0,
        explain: `${vtOf(FG_STEP).toFixed(1)} V is below the ${V_READ} V read voltage, so the cell still turns on: 1. That is why programming verifies after each pulse and repeats: here ${pulses} pulses. Too many pulses push the threshold needlessly high and wear the oxide.`,
      },
    },
    {
      title: 'Program and erase',
      body: `
        <p>Programming forces electrons through the oxide, so it only ever moves bits from 1 to 0, and slowly: a pulse at a time, a
        verify read after each. All the cells of a row are programmed together, each bit line choosing: pulled low, its cell is
        programmed; left high, it is inhibited. Erasing pulls the electrons back out, and the array does it for a whole
        <strong>block</strong> at once.</p>
        <p>So flash cannot overwrite. To turn one 0 back into a 1, the controller must read every row of the block, erase the
        block and program the rows again. The times show what that costs: on a real SLC device a page read is
        ${FLASH_REAL_US.read} µs, a page program ${FLASH_REAL_US.program} µs, a block erase ${FLASH_REAL_US.erase / 1000} ms. Scaled to our
        clock: ${FLASH_TIMES.read}, ${FLASH_TIMES.program} and ${FLASH_TIMES.erase} cycles.</p>
        <div class="try">Row 1 holds 1010. Make it 0110 and keep rows 0, 2 and 3 as they are.</div>`,
      scene: () => flashScene({ kind: 'nor', pattern: PATTERN }),
      challenge: {
        kind: 'reach', goal: 'Rewrite row 1 from 1010 to 0110, and keep the other rows (0011, 1111, 0101).',
        check: (st) => rowsOf(st, 4).every((v, r) => v === TARGET[r]),
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
        <p>A <strong>NAND</strong> string puts its cells in series, eight here (128 or more in real chips), with one contact at each end.
        A read puts the selected row at the read voltage and every other row at the <strong>pass voltage</strong>, high enough to turn on
        any cell whatever it holds; the string conducts only if the selected cell is erased. About 4 F² a cell and no random access:
        a page is sensed in tens of microseconds and then streamed out. NAND holds files and SSDs, NOR holds boot code.</p>
        <div class="try">Read a row: every other row's cells sit at the pass voltage. Program a row, then erase the block.</div>`,
      scene: () => flashScene({ kind: 'nand', pattern: [0b1010, 0b1111, 0b0110, 0b1111, 0b0001, 0b1111, 0b1111, 0b1100] }),
      challenge: {
        kind: 'quiz',
        question: 'Why can a NAND string not be read faster by selecting one cell directly?',
        options: ['Its cells are in series: the current of the selected one must pass through all the others', 'NAND cells hold more charge', 'The pass voltage is too slow to set up', 'NAND has no sense amplifier'],
        answer: 0,
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
        of their flash out of sight for this.</p>`,
      widget: wearWidget,
      challenge: {
        kind: 'quiz',
        question: 'Why does more spare space lower write amplification?',
        options: ['Collected blocks hold fewer valid pages, so fewer copies are needed per page freed', 'Spare blocks are faster', 'Wear levelling is switched off', 'The host writes less'],
        answer: 0,
        explain: 'With logical space L on physical space P, the average block is L / P valid. Collecting a block with v valid pages out of n frees n − v pages for v copies; as L / P falls, v falls, and so do the copies per freed page.',
      },
    },
  ],
};

