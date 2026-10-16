import { RESULTS } from '../bench/summary';
import type { DramConfig } from '../dram/controller';
import { accessCycles, DDR4_3200, TIMING } from '../dram/timing';
import { BENCHMARKS } from '../riscv/benchprograms';
import { dramCtrl } from '../lib/dramctrl';
import { stats } from '../sim/stats';
import { cpuScene } from '../widgets/cpupanel';
import { memCtrlRequest, memCtrlScene, memCtrlState } from '../widgets/dramctrl';
import { ctrlExplorer, reorderWidget } from '../widgets/dramwork';
import type { Chapter } from './types';

/** The CPUs' DRAM: their 64 words in 2 banks of 2 rows of 16 words (tests/verify/cpus.ts DRAM_OPEN). */
const CFG: DramConfig = { k: 6, banks: 2, rowWords: 16, policy: 'open' };
/** The same with refresh every 120 cycles instead of 1 974, so a few requests meet one. */
const FAST_REF: DramConfig = { ...CFG, t: { ...TIMING, tREFI: 120 } };

/** The copy's row hits on 2 banks, open page, plain and hashed, and how much faster the hash is (tests/dramctrl.test.ts checks them). */
export const COPY = { plain: 33, hash: 54, faster: 8 };

const run = (id: string, bench: string) => RESULTS.cpus.find((c) => c.id === id)?.runs.find((r) => r.bench === bench)?.cycles ?? NaN;
const nands = (id: string) => RESULTS.cpus.find((c) => c.id === id)?.nands ?? NaN;
const fmt = (n: number) => n.toLocaleString('en-US').replace(/,/g, ' ');
const slower = (a: string, b: string, bench: string) => `${(((run(a, bench) / run(b, bench)) - 1) * 100).toFixed(1)} %`;

export const chMemCtrl: Chapter = {
  id: 'memctrl', num: 33, title: 'A memory controller', level: 'Memory in depth',
  blurb: 'Commands and their timing rules in gates: a controller that opens and closes rows, refreshes on time and serves the cache; open against closed page, address mapping and FR-FCFS, measured on the benchmarks.',
  steps: [
    {
      title: 'Commands',
      body: `
        <p>A DRAM device understands six commands. <strong>ACT</strong> opens a row in a bank, <strong>RD</strong> / <strong>WR</strong>
        move a burst from or to the open row, <strong>PRE</strong> closes it (<strong>PREA</strong>: every bank), <strong>REF</strong>
        refreshes. Each has a rule about when it may come (chapter 32): tRCD after an ACT before a column command, tRP after a PRE
        before the next ACT, tRAS before a row may close, tRFC of silence after a REF. The device here checks every one, and a
        command that breaks one turns its data into X.</p>
        <p>The controller turns "read line 5" into the right commands at the right cycles. In gates it is small: seven state
        flip-flops (idle when none is set), one wait counter that every command loads with its delay, an open-row table (a valid bit and
        a row register per bank) and a refresh counter. ${fmt(stats(dramCtrl(CFG)).nands)} NANDs. It serves one request at a time,
        as the cache asks: the cache holds <code>req</code> until <code>done</code>.</p>
        <div class="try">Read line 0, then line 1, then line 8, and compare the three timelines. Lines 0–3 share row 0 of bank 0;
        lines 4–7 are row 0 of bank 1; line 8 is row 1 of bank 0.</div>`,
      scene: () => memCtrlScene({ cfg: CFG }),
      challenge: {
        kind: 'reach', goal: 'Make the controller meet all three cases: a row hit, a row miss and a row conflict.',
        check: (st) => { const r = memCtrlState(st)?.reqs.map((q) => q.outcome) ?? []; return ['row hit', 'row miss', 'row conflict'].every((o) => r.includes(o)); },
        answer: `Read line 0 (bank 0 closed: a miss, ${accessCycles('miss', TIMING)} cycles), line 1 (row 0 still open: a hit, ${accessCycles('hit', TIMING)}), line 8 (bank 0 holds row 0, line 8 is row 1: PRE, ACT, RD, ${accessCycles('conflict', TIMING)}).`,
        solve: (st) => { const r = memCtrlRequest(st); r?.(0, false); r?.(1, false); r?.(8, false); },
      },
    },
    {
      title: 'Open page or closed page',
      body: `
        <p>After a burst the controller can leave the row open, betting that the next request hits it (<strong>open page</strong>), or
        close it at once (<strong>closed page</strong>). Open page wins on locality: a hit costs ${accessCycles('hit', TIMING)} cycles
        where a closed bank costs ${accessCycles('miss', TIMING)}. It loses on a conflict: ${accessCycles('conflict', TIMING)}, because
        the precharge it postponed now stands in the way. Closed page pays ${accessCycles('miss', TIMING)} every time, plus a precharge
        when two requests come close together. A dirty victim's write-back followed at once by its fill is such a pair.</p>
        <p>Measured on the gate-level CPUs: fib takes ${fmt(run('sc-wb2', 'fib'))} cycles with the old fixed miss cost,
        ${fmt(run('sc-wb2-dram', 'fib'))} over DRAM with open page and ${fmt(run('sc-wb2-dramc', 'fib'))} with closed page. The benchmarks'
        data is 256 bytes, four rows, so open page hits most of the time. The copy, on 4 K words, is the other kind of program.</p>`,
      widget: ctrlExplorer,
      challenge: {
        kind: 'quiz',
        question: 'Why does closed page lose even on the copy, a program with little reuse?',
        options: ['Its reads and writes still hit rows: four lines of a row in a row, and the write-backs follow their fills', 'Closed page cannot refresh', 'Closed page needs more banks', 'The cache is write-through'],
        answer: 0,
        explain: 'Each stream walks its row four lines in a row, so an open row still serves three of four lines of each stream when the streams do not evict each other. Closed page throws that away and pays an activate for every line.',
      },
    },
    {
      title: 'Refresh',
      body: `
        <p>Every ${DDR4_3200.tREFI / 1000} µs the device needs a REF: ${TIMING.tREFI} of our cycles. The controller counts them, and when the
        count wraps a refresh is due. It goes first at the next idle cycle: precharge every open bank (tRP), REF, then
        ${TIMING.tRFC} cycles in which the device takes no command. A request that arrives meanwhile waits, so its cost is no longer
        ${accessCycles('hit', TIMING)}, ${accessCycles('miss', TIMING)} or ${accessCycles('conflict', TIMING)}, but up to
        ${TIMING.tRP + TIMING.tRFC + accessCycles('miss', TIMING)}. Afterwards every bank is closed, so the next request misses.</p>
        <p>DDR4 lets a controller postpone up to 8 refreshes while it is busy and catch up later; the device here loses its data if it
        goes 9 intervals without one. This controller never postpones: with one request at a time there is always an idle cycle soon.
        The scene refreshes every 120 cycles instead of ${TIMING.tREFI}, so you meet one within a few requests.</p>
        <div class="try">Read a few lines and watch "refresh in" count down. Idle 50 past zero: PA (precharge all), REF, then nothing.</div>`,
      scene: () => memCtrlScene({ cfg: FAST_REF }),
      challenge: {
        kind: 'quiz',
        question: `With tREFI = ${DDR4_3200.tREFI / 1000} µs and tRFC = ${DDR4_3200.tRFC} ns, what share of the time is a DDR4 device busy refreshing?`,
        options: ['0.45 %', '4.5 %', '22 %', '45 %'],
        answer: 1,
        explain: `${DDR4_3200.tRFC} / ${DDR4_3200.tREFI} = 4.5 %. It grows with density: an 8 Gb device has tRFC 350 ns, a 16 Gb one 550 ns. That is why controllers schedule refreshes into idle time, and why newer standards refresh one bank at a time.`,
      },
    },
    {
      title: 'The CPU behind it',
      body: `
        <p>The write-back cache of chapter 21 had a miss controller counting to a fixed 8 or 12. Here it asks instead. On a miss it
        raises <code>req</code> with the line address; if the victim is dirty it first asks for a write (<code>wr</code>) with the victim's
        address, and the controller says which word it wants each cycle; then it asks for the fill and writes each word as
        <code>dv</code> says. The tag is written with the last word. The stall lasts exactly as long as the DRAM takes.</p>
        <p>Main memory is no longer 64 words of flip-flops in the CPU (${fmt(nands('sc-wb2') - nands('sc-wb2-dram'))} NANDs) but a
        DRAM device on another chip, so the CPU with its cache and controller is ${fmt(nands('sc-wb2-dram'))} NANDs. Sort over open page
        takes ${fmt(run('sc-wb2-dram', 'sort'))} cycles against ${fmt(run('sc-wb2', 'sort'))} with the fixed cost
        (${slower('sc-wb2-dram', 'sc-wb2', 'sort')} slower). The pipelined CPU loses ${slower('pipe-wb2-dram', 'pipe-wb2', 'matmul')} on matmul.
        Every run is checked against the golden model, the official riscv-tests pass on all three DRAM CPUs, and the device saw
        no broken rule.</p>
        <div class="try">Run to halt and compare the cycles with the instructions: every stall is a miss priced by the row buffer.</div>`,
      scene: () => cpuScene({ source: BENCHMARKS.find((b) => b.id === 'sort')!.source, dcache: 'wb2', dram: CFG, adder: 'ks', highlight: ['dm'] }),
      challenge: {
        kind: 'quiz',
        question: 'A load misses, the victim line is dirty, and both the victim\'s row and the new line\'s row are closed. How long does the CPU stall (no refresh)?',
        options: [String(accessCycles('miss', TIMING)), String(2 * accessCycles('miss', TIMING)), String(accessCycles('miss', TIMING) + accessCycles('conflict', TIMING)), '12'],
        answer: 1,
        explain: `Two requests, one after the other: the write-back (ACT, WR, four words: ${accessCycles('miss', TIMING)}) and the fill. If the two lines are in different banks the fill finds its bank closed: another ${accessCycles('miss', TIMING)}. In the same bank, a different row, it would be a conflict: ${accessCycles('miss', TIMING) + accessCycles('conflict', TIMING)}.`,
      },
    },
    {
      title: 'Banks and address mapping',
      body: `
        <p>Which address bits pick the bank decides which requests fight. Here a line's address is {row, bank, column}: four lines fill
        a row, the next four go to the next bank. The copy reads word i and writes word i + 1 024, and with 2 banks of 16-word rows
        1 024 words is 32 rows of both banks. Source and destination always land in the same bank, a different row, so they close
        each other's row at every line.</p>
        <p>A controller can fold row bits into the bank number. With an XOR of the row's parity, rows 32 apart land in different banks:
        on the copy, row hits go from ${COPY.plain} % to ${COPY.hash} % of the requests and the program takes ${COPY.faster} % fewer cycles.
        The cost is a parity tree and an XOR gate in the controller; the program and the cache do not change. Real controllers hash
        more bits and choose the mapping to suit the workload.</p>`,
      widget: ctrlExplorer,
      challenge: {
        kind: 'quiz',
        question: 'Why do the four benchmarks barely change with 4 banks or the hash, while the copy does?',
        options: ['Their data is 256 bytes: a few rows, already mostly hits', 'They have no stores', 'They fit in the cache, so there are no requests', 'The hash only works on 4 K words'],
        answer: 0,
        explain: 'With 64 words, 16 words a row, the whole data set is 4 rows in 2 banks: most requests hit whatever the mapping. Address mapping matters for programs whose streams are far apart in memory.',
      },
    },
    {
      title: 'Reordering: FR-FCFS',
      body: `
        <p>A controller with several requests waiting can choose. <strong>FCFS</strong> serves them in order of arrival.
        <strong>FR-FCFS</strong> (first ready, first come first served) serves the oldest request that hits an open row first, and the
        oldest of all only when nothing hits. With a CPU and a write buffer working on two rows of one bank, FCFS turns every request
        into a conflict; FR-FCFS batches each row's requests, as deep as the queue lets it.</p>
        <p>It needs requests to choose from. This chapter's controller has one: the cache asks for a line and waits. A queue comes with a
        write buffer, several cores (chapter 24) or a DMA engine (chapter 35). Its cost is the queue itself, address and data
        registers per entry, and a row-hit comparator per entry feeding a priority encoder. FR-FCFS is also unfair: a stream of hits can
        hold an old request back, so real controllers cap how long a request may wait.</p>`,
      widget: reorderWidget,
      challenge: {
        kind: 'quiz',
        question: 'With a queue of 1, why are FCFS and FR-FCFS the same?',
        options: ['There is only ever one request to choose', 'Both serve hits first', 'The queue is always full', 'Refresh is off'],
        answer: 0,
        explain: 'Reordering needs a choice. With one entry the controller serves what it has. The deeper the queue, the longer the batches of row hits, and the longer the other stream may wait.',
      },
    },
  ],
};

