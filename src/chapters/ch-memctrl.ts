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
  id: 'memctrl', num: 35, title: 'A memory controller', level: 'Memory in depth',
  blurb: 'Commands and their timing rules in gates: a controller that opens and closes rows, refreshes on time and serves the cache; open against closed page, address mapping and FR-FCFS, measured on the benchmarks.',
  goals: [
    'list the DRAM commands and the timing rule that guards each',
    'trace the commands a controller issues for a row hit, a miss and a conflict, and their cost in cycles',
    'say what open and closed page bet on, and what a refresh adds to a request',
    'show how address mapping and FR-FCFS reordering turn conflicts into row hits',
  ],
  builds: ['cache', 'dram'],
  recap: {
    keep: [
      'Commands: ACT, RD, WR, PRE (PREA: every bank), REF (DDR4 adds MRS, ZQ, self-refresh, power-down). Each waits for a rule: tRCD after an ACT, tRP after a PRE, tRAS before a row may close, tRFC after a REF. The device here turns a broken rule into X.',
      'Overlapping requests across banks adds rules between them: tRRD between ACTs, tFAW (four ACTs a window), tCCD_S / _L between column commands (bank groups: alternate them), tWR before a written row closes, tWTR for the bus to turn from write to read.',
      `The controller is seven state flip-flops, one wait counter that every command loads, an open-row table and a refresh counter: ${fmt(stats(dramCtrl(CFG)).nands)} NANDs, serving one request at a time.`,
      `Open page: a hit ${accessCycles('hit', TIMING)} cycles, a conflict ${accessCycles('conflict', TIMING)}. Closed page: ${accessCycles('miss', TIMING)} every time. The benchmarks' 256 bytes are four rows, so open page wins there.`,
      `A refresh every ${TIMING.tREFI} cycles: precharge all, REF, ${TIMING.tRFC} silent cycles. A request behind it waits up to ${TIMING.tRP + TIMING.tRFC + accessCycles('miss', TIMING)} cycles, and every bank is closed afterwards.`,
      `The mapping {row, bank, column} puts the copy's two streams in one bank; folding the row's parity into the bank raises row hits from ${COPY.plain} % to ${COPY.hash} %, ${COPY.faster} % fewer cycles. FR-FCFS batches row hits, given a queue to choose from.`,
    ],
    practise: ['m_ctrl'],
    check: [
      {
        question: 'Open page. Bank 0 has row 3 open, and the cache asks for a line in row 5 of bank 0. Which commands does the controller issue?',
        options: ['PRE, ACT, RD', 'ACT, RD', 'RD', 'PREA, REF, ACT, RD'],
        answer: 0,
        explain: `A conflict: close row 3 (PRE, then tRP), open row 5 (ACT, then tRCD), read (RD, tCAS, then the burst): ${accessCycles('conflict', TIMING)} cycles.`,
        why: ['', 'An ACT on a bank whose row is still open breaks the rules: the amplifiers hold row 3 and must be precharged first.', 'RD alone serves the open row, row 3. That is a hit, and this request wants row 5.', 'PREA and REF are the refresh sequence. A conflict closes only its own bank and refreshes nothing.'],
      },
      {
        question: 'A request arrives just after the controller has started a refresh. Its row was open before. What does it pay?',
        options: [
          'The rest of the refresh, then a miss: PREA closed every bank',
          'The rest of the refresh, then a hit: its row is still open',
          'A hit at once: the refresh is postponed while a request waits',
          'Nothing extra, but its data is X: the device was busy',
        ],
        answer: 0,
        explain: `The refresh precharged every bank, then the device takes no command for tRFC. Then the request opens its row again: a miss. In all up to ${TIMING.tRP + TIMING.tRFC + accessCycles('miss', TIMING)} cycles.`,
        why: ['', 'A REF needs every bank precharged first: no row survives it.', 'DDR4 allows postponing up to 8 refreshes, but this controller never does: once due, a refresh goes first at the next idle cycle.', 'The controller holds the request until the device may take commands again. X marks a broken timing rule, and the controller breaks none.'],
      },
      {
        question: 'The copy (source word i, destination word i + 1 024, rows of 16 words) on 4 banks with the plain mapping. Do its streams still fight?',
        options: [
          'Yes: 1 024 words is a whole number of 4 × 16-word stripes, so each destination line still lands in its source line\'s bank',
          'No: with four banks two streams never share one',
          'No: the destination now lands in the next bank',
          'Only for its writes',
        ],
        answer: 0,
        explain: '1 024 / (4 × 16) = 16: the destination is the same bank, 16 rows down. More banks only help when the bank bits differ; the explorer shows the copy\'s row hits barely move. The XOR hash is what separates them.',
        why: ['', 'Which bank a line uses depends on its address bits. Two addresses that agree in the bank bits share a bank however many banks there are.', 'The bank bits of i and i + 1 024 are the same: 1 024 changes only row bits.', 'Reads and writes are both line requests to the same banks: the fill of a source line and the write-back of a destination line conflict alike.'],
      },
    ],
  },
  steps: [
    {
      title: 'Commands',
      body: `
        <p>Six commands do the work. <strong>ACT</strong> opens a row in a bank, <strong>RD</strong> / <strong>WR</strong>
        move a burst from or to the open row, <strong>PRE</strong> closes it (<strong>PREA</strong>: every bank), <strong>REF</strong>
        refreshes. A DDR4 device also takes MRS (set the mode registers: CL, burst length), ZQ (calibrate the output drivers),
        self-refresh entry / exit and power-down, which this model leaves out. Each working command has a rule about when it may come (<a href="#/c/dram/0">chapter 34</a>): tRCD after an ACT before a column command, tRP after a PRE
        before the next ACT, tRAS before a row may close, tRFC of silence after a REF. <span data-show="dev">The device</span> here checks every one, and a
        command that breaks one turns its data into X.</p>
        <p><span data-show="ctrl">The controller</span> turns "read line 5" into the right commands at the right cycles. In gates it is small: <span data-show="ctrl.st">seven state
        flip-flops</span> (idle when none is set), <span data-show="ctrl.cnt">one wait counter</span> that every command loads with its delay, an open-row table (a valid bit and
        a row register per bank) and a refresh counter. ${fmt(stats(dramCtrl(CFG)).nands)} NANDs. It serves one request at a time,
        as the cache asks: the cache holds <span data-show="pin:req"><code>req</code></span> until <code>done</code>.</p>
        <details class="deeper"><summary>Deeper: the rules a real controller also obeys</summary>
        <p>One request at a time needs only the four rules above. A controller that overlaps requests across banks (bank-level
        parallelism: activate bank 1 while bank 0 bursts) meets the rules between banks too. DDR4-3200, an 8 Gb ×8 device, roughly:
        <strong>tRRD</strong> between two ACTs to different banks (2.5 ns, 4.9 ns within one bank group); <strong>tFAW</strong>, at most
        four ACTs in any 21 ns window (the activate current the supply can deliver); <strong>tCCD_S / tCCD_L</strong> between column
        commands, 4 clocks to another bank group, 5 ns within one: DDR4's 16 banks sit in 4 <strong>bank groups</strong> that share
        their data path, so a controller alternates groups to keep the bus full; <strong>tWR</strong>, 15 ns of write recovery before a
        written row may precharge; <strong>tWTR</strong>, 2.5–7.5 ns from a write's data to the next read, as the bus turns around; tRTP
        from a read to the precharge. A scheduler tracks each rule per bank, group and rank; this one has no second request to overlap,
        so none of them binds.</p></details>
        <div class="try">Read line 0, then line 1, then line 8, and compare the three timelines. Lines 0–3 share row 0 of bank 0;
        lines 4–7 are row 0 of bank 1; line 8 is row 1 of bank 0.</div>`,
      scene: () => memCtrlScene({ cfg: CFG }),
      challenge: {
        kind: 'reach', goal: 'Make the controller meet all three cases: a row hit, a row miss and a row conflict.',
        check: (st) => { const r = memCtrlState(st)?.reqs.map((q) => q.outcome) ?? []; return ['row hit', 'row miss', 'row conflict'].every((o) => r.includes(o)); },
        hints: [
          'Every bank starts closed, so the first read misses whatever line it asks for. What must the next read share with it to hit?',
          'Lines 0–3 are row 0 of bank 0 and line 8 is row 1 of the same bank: reading it while row 0 is open forces a close first.',
        ],
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
        why: [
          '',
          'Refresh works the same under both policies: precharge every bank, then REF.',
          'Both policies run on the same two banks. The policy decides only whether a row stays open after its burst.',
          'The cache here is write-back: dirty lines go out as whole-line write-backs, right before their fills.',
        ],
        explain: 'Each stream walks its row four lines in a row, so an open row still serves three of four lines of each stream when the streams do not evict each other. Closed page throws that away and pays an activate for every line.',
      },
    },
    {
      title: 'Refresh',
      body: `
        <p>Every ${DDR4_3200.tREFI / 1000} µs the device needs a REF: ${TIMING.tREFI} of our cycles. <span data-show="ctrl.rc">The controller counts them</span>, and when the
        count wraps <span data-show="ctrl.pend">a refresh is due</span>. It goes first at the next idle cycle: precharge every open bank (tRP), REF, then
        ${TIMING.tRFC} cycles in which <span data-show="dev">the device</span> takes no command. A request that arrives meanwhile waits, so its cost is no longer
        ${accessCycles('hit', TIMING)}, ${accessCycles('miss', TIMING)} or ${accessCycles('conflict', TIMING)}, but up to
        ${TIMING.tRP + TIMING.tRFC + accessCycles('miss', TIMING)}. Afterwards every bank is closed, so the next request misses.</p>
        <p>DDR4 lets a controller postpone up to 8 refreshes while it is busy and catch up later; the device here loses its data if it
        goes 9 intervals without one. This controller never postpones: with one request at a time there is always an idle cycle soon.
        The scene refreshes every 120 cycles instead of ${TIMING.tREFI}, so you meet one within a few requests.</p>
        <div class="try">Read a few lines and watch "refresh in" count down. Idle 50 past zero: PA (precharge all), REF, then nothing.</div>`,
      scene: () => memCtrlScene({ cfg: FAST_REF }),
      tries: [(st) => (memCtrlState(st)?.refreshes ?? 0) > 0],
      challenge: {
        kind: 'quiz',
        question: `With tREFI = ${DDR4_3200.tREFI / 1000} µs and tRFC = ${DDR4_3200.tRFC} ns, what share of the time is a DDR4 device busy refreshing?`,
        options: ['0.45 %', '4.5 %', '22 %', '45 %'],
        answer: 1,
        why: [
          `A decimal slip: ${DDR4_3200.tRFC} / ${DDR4_3200.tREFI} = 0.045, which is 4.5 %.`,
          '',
          `That would take a REF every 1.6 µs. DDR4 gets one every ${DDR4_3200.tREFI / 1000} µs.`,
          `That divides ${DDR4_3200.tRFC} ns by 780 ns: the interval is ${DDR4_3200.tREFI / 1000} µs, ${DDR4_3200.tREFI} ns.`,
        ],
        explain: `${DDR4_3200.tRFC} / ${DDR4_3200.tREFI} = 4.5 %. It grows with density: an 8 Gb device has tRFC 350 ns, a 16 Gb one 550 ns. That is why controllers schedule refreshes into idle time, and why newer standards refresh one bank at a time.`,
      },
    },
    {
      title: 'The CPU behind it',
      body: `
        <p>The <span data-show="dm">write-back cache</span> of <a href="#/c/cache/0">chapter 22</a> had a miss controller counting to a fixed 8 or 12. Here it asks instead. On a miss it
        raises <code>req</code> with the line address; if the victim is dirty it first asks for a write (<code>wr</code>) with the victim's
        address, and the controller says which word it wants each cycle; then it asks for the fill and writes each word as
        <code>dv</code> (data valid: the device is delivering a read word) says. The tag is written with the last word. The stall lasts exactly as long as the DRAM takes.</p>
        <p>Main memory is no longer 64 words of flip-flops in the CPU (${fmt(nands('sc-wb2') - nands('sc-wb2-dram'))} NANDs) but a
        DRAM device on another chip, so the CPU with its cache and controller is ${fmt(nands('sc-wb2-dram'))} NANDs. Sort over open page
        takes ${fmt(run('sc-wb2-dram', 'sort'))} cycles against ${fmt(run('sc-wb2', 'sort'))} with the fixed cost
        (${slower('sc-wb2-dram', 'sc-wb2', 'sort')} slower). The pipelined CPU loses ${slower('pipe-wb2-dram', 'pipe-wb2', 'matmul')} on matmul.
        Every run is checked against the instruction-set simulator, the official riscv-tests pass on all three DRAM CPUs, and the device saw
        no broken rule.</p>
        <div class="try">Run to halt and compare the cycles with the instructions: every stall is a miss priced by the row buffer.</div>`,
      scene: () => cpuScene({ source: BENCHMARKS.find((b) => b.id === 'sort')!.source, dcache: 'wb2', dram: CFG, adder: 'ks', highlight: ['dm'] }),
      challenge: {
        kind: 'quiz',
        question: 'A load misses, the victim line is dirty, and the victim and the new line sit in different banks, both closed. How long does the CPU stall (no refresh)?',
        options: [String(accessCycles('miss', TIMING)), String(2 * accessCycles('miss', TIMING)), String(accessCycles('miss', TIMING) + accessCycles('conflict', TIMING)), String(accessCycles('conflict', TIMING))],
        answer: 1,
        why: [
          'That is one request. The dirty victim is written back first, and the controller serves one request at a time.',
          '',
          'That is the case where both lines sit in one bank: the write-back leaves its row open and the fill meets a conflict. Lines in different banks find the fill\'s bank closed.',
          'A conflict is one request finding another row open. Here there are two requests, each opening a closed row.',
        ],
        explain: `Two requests, one after the other: the write-back (ACT, WR, four words: ${accessCycles('miss', TIMING)}) and the fill. If the two lines are in different banks the fill finds its bank closed: another ${accessCycles('miss', TIMING)}. In the same bank, a different row, it would be a conflict: ${accessCycles('miss', TIMING) + accessCycles('conflict', TIMING)}.`,
      },
    },
    {
      title: 'Banks and address mapping',
      body: `
        <p>Which address bits pick the bank decides which requests fight. Here a line's address is {row, bank, column}: four lines fill
        a row, the next four go to the next bank. The copy reads word i and writes word i + 1 024, and with 2 banks of 16-word rows
        1 024 words is 32 rows of both banks. Source and destination always land in the same bank, a different row, so each
        stream keeps closing the other's row.</p>
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
        why: [
          '',
          'They do store, and stores reach the DRAM as dirty lines written back: the mapping places those exactly like fills.',
          'Every line still comes from DRAM at least once, so there are requests. What keeps them hitting is that the data is only four rows.',
          'The hash is a parity tree and an XOR on the row bits, the same for any size. It helps only where two streams share a bank.',
        ],
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
        write buffer, several cores (<a href="#/c/multicore/0">chapter 26</a>) or a DMA engine (<a href="#/c/bus/0">chapter 37</a>). Its cost is the queue itself, address and data
        registers per entry, and a row-hit comparator per entry feeding a priority encoder. FR-FCFS is also unfair: a stream of hits can
        hold an old request back, so real controllers cap how long a request may wait.</p>`,
      widget: reorderWidget,
      challenge: {
        kind: 'quiz',
        question: 'With a queue of 1, why are FCFS and FR-FCFS the same?',
        options: ['There is only ever one request to choose', 'Both serve hits first', 'The queue is always full', 'Refresh is off'],
        answer: 0,
        why: [
          '',
          'FCFS serves strictly in order of arrival. Only FR-FCFS looks for hits.',
          'A full queue of one still holds a single request: there is nothing to reorder.',
          'Refresh changes when a request is served, not which. With one request there is no choice either way.',
        ],
        explain: 'Reordering needs a choice. With one entry the controller serves what it has. The deeper the queue, the longer the batches of row hits, and the longer the other stream may wait.',
      },
    },
  ],
};

