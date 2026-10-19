// Act 10's build levels (memory in depth, roadmap Phase 16e): a DRAM column at switch level, a bank with refresh,
// a row-buffer controller, a two-master bus, a DMA engine and a flash page store, each against a device on its bench
// (memcheck.ts) or, for the bus, a sequence from a model. No DOM.

import type { BuildChallenge, PinSpec, SeqStep } from '../editor/challenges';
import { docFromDef } from '../editor/fromdef';
import type { ChipDoc } from '../editor/model';
import { BANK16, BUS16, busSlaveOf, CTRL16, DMA16, DRAM_COL2, FLASH_STORE16 } from '../lib/rv16/mem16';
import type { ComponentDef } from '../sim/types';
import { rng } from './drills';
import { BANK, bankTraces, ctrlTraces, dmaTraces, DRAM16, FLASH16, flashTraces, runBank, runCtrl, runDma, runFlash } from './memcheck';

const pinsOf = (def: ComponentDef): PinSpec[] => def.ports.map((p) => ({ name: p.name, dir: p.dir === 'out' ? 'out' : 'in', width: p.width, ...(p.clock ? { clock: true } : {}) }));

const answers = new Map<string, ChipDoc[]>();
const refOf = (id: string, def: () => ComponentDef, name: string) => (): ChipDoc[] => {
  let a = answers.get(id);
  if (a) return a;
  const top = docFromDef(def(), { id: `u_ref_cp_${id}`, name: `${name} ref` });
  if ('error' in top) throw new Error(`reference ${id}: ${top.error}`);
  answers.set(id, (a = [{ ...top, notes: `Reference answer. ${def().summary ?? ''}`.trim() }]));
  return a;
};

/**
 * The column's test: writes and reads of both cells through the protocol of chapter 34 (precharge, word line,
 * sense, then write or read, close). Each read is destructive, so reading a cell twice proves the restore.
 */
export function senseSeq(): SeqStep[] {
  const st: SeqStep[] = [];
  const idle = { pre: 0, wl0: 0, wl1: 0, sae: 0, we: 0 };
  const open = (r: number, v?: number) => {
    st.push({ set: { ...idle, pre: 1 }, expect: {} }, { set: { pre: 0 }, expect: {} }, { set: { [`wl${r}`]: 1 }, expect: {} });
    st.push({ set: { sae: 1 }, expect: v === undefined ? {} : { q: v } });
  };
  const close = (r: number) => st.push({ set: { [`wl${r}`]: 0 }, expect: {} }, { set: { sae: 0 }, expect: {} });
  const write = (r: number, v: number) => {
    open(r);
    st.push({ set: { we: 1, d: v }, expect: { q: v } }, { set: { we: 0 }, expect: { q: v } });
    close(r);
  };
  const read = (r: number, v: number) => { open(r, v); close(r); };
  write(0, 1); write(1, 0);
  read(0, 1); read(1, 0); read(0, 1); read(1, 0);
  write(0, 0); read(1, 0); read(0, 0);
  write(1, 1); read(0, 0); read(1, 1); read(1, 1);
  write(0, 1); read(0, 1); read(1, 1); read(0, 1);
  return st;
}

/** m_bus's slaves: wait states before ready (0: ready at once). */
export const BUS_WAIT = [0, 2, 1] as const;

/**
 * m_bus's test, from a model of the bench and of the bus as specified: two masters, each holding a request until
 * its ready, with stretches alone, both asking at once, and one waiting on the slow slave while the other asks; three
 * slaves (memories) that raise ready after their wait states and serve the word at sa combinationally.
 */
export function busSeq(): SeqStep[] {
  const r = rng(121);
  const rnd = (n: number) => Math.floor(r() * n);
  type Tx = { a: number; w: boolean; d: number; gap: number };
  const addrIn = (j: number) => (j === 0 ? rnd(0x8000) : j === 1 ? 0x8000 + rnd(0x4000) : 0xc000 + rnd(0x4000));
  const tx = (j: number, gap: number): Tx => ({ a: addrIn(j), w: r() < 0.45, d: rnd(0x10000), gap });
  const q0: Tx[] = [], q1: Tx[] = [];
  for (let i = 0; i < 6; i++) q0.push(tx(i % 3, 0)); // m0 alone (m1 starts late)
  for (let i = 0; i < 24; i++) { q0.push(tx(rnd(3), rnd(2))); q1.push(tx(rnd(3), rnd(2))); } // both, often at once
  for (let i = 0; i < 8; i++) { q0.push(tx(1, 0)); q1.push(tx(0, 0)); } // m0 on the slow slave, m1 on the fast one
  for (let i = 0; i < 8; i++) q1.push(tx(2, rnd(3))); // m1 alone
  // m1 served last, then alone on the slow slave; m0 asks while it waits: the grant must stay with m1
  for (let i = 0; i < 6; i++) { q1.push(tx(1, 3)); q0.push(tx(0, 3)); }
  const queues = [q0, q1], at = [0, 0], wait = [0, 30];
  const mem = [new Map<number, number>(), new Map<number, number>(), new Map<number, number>()];
  const word = (j: number, a: number) => mem[j].get(a) ?? ((a * 40503 + j * 7919) & 0xffff);
  const cnt = [0, 0, 0];
  let last = 1, lock = 0, own = 0;
  const st: SeqStep[] = [];
  st.push({ set: { rst: 1, mv0: 0, mv1: 0, sr0: 0, sr1: 0, sr2: 0 }, tick: true, expect: {} });
  st.push({ set: { rst: 0 }, expect: {} });
  for (let c = 0; c < 400 && (at[0] < q0.length || at[1] < q1.length); c++) {
    const cur = [0, 1].map((i) => (wait[i] > 0 || at[i] >= queues[i].length ? undefined : queues[i][at[i]]));
    const mv = cur.map((t) => (t ? 1 : 0));
    const g = lock ? own : mv[0] && mv[1] ? 1 - last : mv[1];
    const t = cur[g], vg = mv[g];
    const j = t ? busSlaveOf(t.a) : 0;
    const sr = [0, 1, 2].map((k) => (cnt[k] >= BUS_WAIT[k] ? 1 : 0));
    const sa = t?.a ?? 0;
    const done = vg && sr[j] ? 1 : 0;
    const set: Record<string, number> = { rst: 0 };
    [0, 1].forEach((i) => { const x = cur[i]; Object.assign(set, { [`mv${i}`]: mv[i], [`ma${i}`]: x?.a ?? 0, [`md${i}`]: x?.d ?? 0, [`mw${i}`]: x?.w ? 1 : 0 }); });
    [0, 1, 2].forEach((k) => { set[`sr${k}`] = sr[k]; set[`sq${k}`] = word(k, sa); });
    const expect: Record<string, number> = { mr0: done && g === 0 ? 1 : 0, mr1: done && g === 1 ? 1 : 0 };
    [0, 1, 2].forEach((k) => { expect[`sv${k}`] = vg && j === k ? 1 : 0; });
    if (vg) { expect.sa = sa; expect.sw = t!.w ? 1 : 0; if (t!.w) expect.sd = t!.d; }
    if (done && !t!.w) expect[`mq${g}`] = word(j, sa);
    st.push({ set, expect }, { set: {}, tick: true, expect: {} });
    // the edge
    [0, 1, 2].forEach((k) => { cnt[k] = vg && j === k && !done ? cnt[k] + 1 : 0; });
    if (done && t!.w) mem[j].set(sa, t!.d);
    if (done) { last = g; at[g]++; wait[g] = t!.gap; }
    lock = vg && !done ? 1 : 0;
    own = g;
    [0, 1].forEach((i) => { if (wait[i] > 0 && !(done && i === g)) wait[i]--; });
  }
  return st;
}

export const BUILDM: Record<string, () => BuildChallenge> = {
  m_sense: () => ({
    id: 'm_sense', title: 'A DRAM column', level: 'memory', allowed: 'nand',
    brief: 'Two 1T1C cells on a bit line, read and written through a sense amplifier, at switch level. The bench drives chapter 34\'s protocol: <b>pre</b> = 1 then 0 (both bit lines to VDD/2, then floating), a word line <b>wl0</b> or <b>wl1</b> (the cell shares its charge with its line), <b>sae</b> (the amplifier drives the higher line to VDD and the other to GND, and the open cell is restored), then either a read or a write (<b>we</b> = 1 with <b>d</b>: the write driver flips the lines), then the word line and sae fall. <b>q</b> must be the cell\'s bit once sensed. '
      + 'Given: the cells, a bit line capacitance part (100 fF), the amplifier, VDD/2 and the write driver. The amplifier compares two lines, so the second one needs the same capacitance and the same precharge, and nothing else on it.',
    ports: pinsOf(DRAM_COL2),
    check: { kind: 'sequence', steps: senseSeq() },
    answer: refOf('m_sense', () => DRAM_COL2, 'DRAM column'),
  }),
  m_bank: () => ({
    id: 'm_bank', title: 'A bank with refresh', level: 'memory', allowed: 'nand',
    brief: `Requests on one side, a ${BANK.rows} × ${BANK.cols} array of 16-bit words on the other (it is on the bench). A request (<code>re</code> or <code>we</code>, <code>addr</code> = row · column, <code>wd</code>) is held until a cycle with <b>busy</b> = 0: that cycle it must be done, a read's word on <b>rd</b>. `
      + 'The array takes one command a cycle on <b>cmd</b>: 1 <b>ACT</b> opens row <b>ra</b> (its words move into the sense amplifiers: the row buffer); 3 <b>RW</b> reads word <b>ca</b> of the open row onto <code>aq</code> in the same cycle, or writes <b>ad</b> into it when <b>aw</b> = 1; 2 <b>PRE</b> closes the row; 0 nothing. ACT needs the bank closed, RW a row open. '
      + `The cells leak: every row must be opened at least every <b>${BANK.RET} cycles</b> (opening restores it, and an open row holds), or the bench reports it lost. ${bankTraces().length} request traces; graded on cycles too: keep the row open while requests hit it.`,
    ports: pinsOf(BANK16),
    check: { kind: 'custom', describe: `${bankTraces().length} request traces against the cell array (runs along a row, random words, two rows taking turns, long pauses, no pause at all): every read's word, every command legal, no row older than ${BANK.RET} cycles.`, run: runBank },
    answer: refOf('m_bank', () => BANK16, 'Bank with refresh'),
  }),
  m_ctrl: () => ({
    id: 'm_ctrl', title: 'Row-buffer controller', level: 'memory', allowed: 'nand',
    brief: `A DRAM chip on the bench: ${DRAM16.banks} banks of ${DRAM16.rows} rows of ${DRAM16.cols} words, each bank with its own row buffer. A request (<code>req</code>, <code>addr</code> = row (6 bits) · bank · column (4 bits), <code>we</code>, <code>wd</code>) is held until <b>ready</b>: a write is ready in the cycle of its WR, a read in the cycle its word is on <code>dq</code> (<b>rd</b>). `
      + `Commands on <b>cmd</b> with <b>ba</b>, <b>ra</b>, <b>ca</b>, <b>dd</b>: 1 ACT (open row ra of bank ba), 2 RD (word ca of its open row: on dq <b>tCAS = ${DRAM16.tCAS}</b> cycles later), 3 WR (dd into word ca now), 4 PRE (close bank ba), 5 PREA (close both), 6 REF (needs both closed). `
      + `The chip's rules, in cycles: ACT → RD / WR ≥ <b>tRCD = ${DRAM16.tRCD}</b>; ACT → PRE ≥ <b>tRAS = ${DRAM16.tRAS}</b>; PRE → ACT or REF ≥ <b>tRP = ${DRAM16.tRP}</b>; REF → anything ≥ <b>tRFC = ${DRAM16.tRFC}</b>; a REF at least every <b>${DRAM16.tREFI}</b> cycles. Graded on cycles over the traces.`,
    ports: pinsOf(CTRL16),
    check: { kind: 'custom', describe: `${ctrlTraces().length} request traces against the DRAM chip (runs along a row, a stream per bank, row conflicts, random, long pauses, no pause at all): every word, every timing rule, refresh.`, run: runCtrl },
    answer: refOf('m_ctrl', () => CTRL16, 'Row-buffer controller'),
  }),
  m_bus: () => ({
    id: 'm_bus', title: 'Two masters, one bus', level: 'memory', allowed: 'nand',
    brief: 'Two masters share three slaves. A master raises <code>mv<i>i</i></code> with <code>ma<i>i</i></code>, <code>md<i>i</i></code> (written when <code>mw<i>i</i></code> = 1) and holds them until <b>mr<i>i</i></b> = 1: that cycle the transfer is done, a read\'s word on <b>mq<i>i</i></b>. '
      + 'The address picks the slave: 0 below 0x8000, 1 from 0x8000, 2 from 0xC000. Drive the granted master\'s address, data and write on <b>sa</b>, <b>sd</b>, <b>sw</b> and raise that slave\'s <b>sv<i>j</i></b>; it answers with <code>sr<i>j</i></code> (ready: done this cycle) and <code>sq<i>j</i></code> (its word at sa). '
      + `Slave 0 is ready at once, slave 1 after ${BUS_WAIT[1]} wait states, slave 2 after ${BUS_WAIT[2]}. `
      + '<b>Arbitration</b>: grant the only master asking; when both ask, the one not served last (master 0 first after <code>rst</code>); a transfer that has started keeps its master until it is done: a slave never sees its request change while it waits.',
    ports: pinsOf(BUS16),
    check: { kind: 'sequence', steps: busSeq() },
    answer: refOf('m_bus', () => BUS16, 'Two-master bus'),
  }),
  m_dma: () => ({
    id: 'm_dma', title: 'DMA engine', level: 'memory', allowed: 'nand',
    brief: 'A bus master that copies memory while the processor does something else. The processor configures it with writes (<code>cw</code> = 1, register <code>ca</code>, value <code>cd</code>): 0 <b>src</b>, 1 <b>dst</b>, 2 <b>len</b>, which also starts the copy in the next cycle; 3 clears <b>irq</b>. It never writes the others while a copy runs. '
      + 'For each word, read src + k and then write it to dst + k over the bus: raise <b>mv</b> with <b>ma</b> (and <b>md</b>, <b>mw</b> = 1 for a write) and hold all of them until <code>mr</code> = 1; a read\'s word is on <code>mq</code> in that cycle. The memory takes 0 to 6 wait states. '
      + '<b>busy</b> = 1 while copying; when the last word is written, busy falls and <b>irq</b> rises and stays up until cleared (len = 0: at once). Graded on cycles, from the len write to irq.',
    ports: pinsOf(DMA16),
    check: { kind: 'custom', describe: `${dmaTraces().length} memories (no wait states to six), each given five copies (1, 16, 37, 0 and 12 words, one across the end of memory): every word copied, nothing else written, a request held until ready, irq and busy.`, run: runDma },
    answer: refOf('m_dma', () => DMA16, 'DMA engine'),
  }),
  m_flash: () => ({
    id: 'm_flash', title: 'Flash page store', level: 'memory', allowed: 'nand',
    brief: `Eight logical pages (<code>lpage</code>, one 16-bit word each) over a flash chip on the bench: ${FLASH16.blocks} blocks of ${FLASH16.pages} pages, each page a word plus a 4-bit spare area. A request (<code>re</code>, or <code>we</code> with <code>wd</code>) is held until <b>ready</b>; a read's word on <b>rd</b>. `
      + `The chip's commands on <b>fcmd</b>, page <b>fa</b> (block · page): 1 READ (after it, while <code>fbusy</code> = 0, the page's word is on <code>fq</code> and its spare area on <code>fqt</code>), 2 PROG (writes <b>fd</b>, and <b>ft</b> into the spare area as 0·ft), 3 ERASE (the whole block of fa: every page back to all ones). It is busy for ${FLASH16.tR}, ${FLASH16.tP} and ${FLASH16.tE} cycles; no command while busy. `
      + '<b>A page can only be programmed when erased</b>, and only a whole block can be erased. So a rewrite goes to a fresh page, a table remembers where each logical page is, and before the erased pages run out, a block\'s still-wanted pages are copied elsewhere and the block erased. The spare area can say whose page it is. Graded on cycles too.',
    ports: pinsOf(FLASH_STORE16),
    check: { kind: 'custom', describe: `${flashTraces().length} request traces (every page written first and read back at the end; random, one hot page, all pages in turn, reads only, hot and cold): every read, every chip rule.`, run: runFlash },
    answer: refOf('m_flash', () => FLASH_STORE16, 'Flash page store'),
  }),
};

