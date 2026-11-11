// Chapter multicore's cache steps: private caches in gates, MSI snooping, the spin lock measured, lr.w / sc.w. Every number in
// the prose is counted: NANDs from the netlists (lib/cohcosts.ts), cycles and bus transactions from the timing model that
// tests/coherent.test.ts holds to the gates cycle for cycle (riscv/cohrun.ts).

import { cohCosts } from '../lib/cohcosts';
import { COH_PROGRAMS } from '../riscv/cohprograms';
import { lineStates, runCoherent } from '../riscv/cohrun';
import { groupDigits } from '../sim/numfmt';
import { coherentScene } from '../widgets/coherent';
import type { Step } from './types';

const src = (id: string) => COH_PROGRAMS.find((p) => p.id === id)!.source;
const run = (id: string, coherent = true) => runCoherent(src(id), { coherent });
const pct = (a: number, b: number) => `${Math.round((100 * a) / b)} %`;
const per = (a: number, n: number) => (a / n).toFixed(1);
const halted = () => !!document.querySelector('.coh-panel .cpu-status .warn');

/** Built on first use: the counts take a moment (the netlists' statistics, a few runs of the model) and the chapters load with the app. */
function build(): Step[] {
  const C = cohCosts();
  const spin = run('spin'), ttas = run('ttas'), fs = run('falseshare'), pad = run('padded'), amo = run('atomic'), lr = run('lrsc');
  const [pa, pb] = lineStates(src('predict'), 64);
  const OPTS = ['M, I', 'S, S', 'M, S', 'S, I'];

  return [
    {
      title: 'Private caches in gates',
      body: `
        <p>Until now both cores shared one memory port, so they could never disagree. Real cores each have a cache, and a cache is a copy. Here each of
        <span data-show="cache0 cache1">two caches</span> sits between a core and the bus: 4 sets × 4-word lines, direct-mapped, write-back, write-allocate. Address bits
        [3:2] pick the word, [5:4] the set, the rest is the tag. Per set <span data-show="cache0.ctags">a small array holds {m, v, tag}</span> (valid, dirty and the tag),
        and <span data-show="cache0.data">sixteen words of data</span> sit in a register file with two read ports; the second is for the bus, next step.</p>
        <p>A hit costs nothing: <span data-show="cache0.acc">the access decode</span> matches the tag, says <em>grant</em>, and the core retires in that cycle. A miss holds the
        core (retire = 0) and asks <span data-show="bus">the bus</span>. One transaction at a time, granted by the arbiter of this chapter's third step (ARBITER2, kept quiet while the bus is busy):
        the grant cycle, then counts 0 to 3 write a Modified victim back to <span data-show="dm">memory</span>, a word a cycle, and 4 to 7 bring the new line in. A clean miss holds the bus for 5 cycles, a
        miss over a dirty line for 9; the access then hits.</p>
        <p>What this cache cannot do is hear the other core. Run <em>A stale copy</em>. Core 1 reads <code>x</code> and caches it (0). Core 0 stores 7: a write miss, its cache
        takes the line and writes 7 into it. Forty loops later core 1 reads <code>x</code> again: a hit on its own copy, which still says 0. The verdict line in the panel catches it against a plain
        one-memory replay of the same retirements: core 1's cache holds the line Shared with 0 while core 0's holds it Modified with 7, two valid copies with two values.
        Memory is no better: the 7 lives only in core 0's cache and goes to memory when that line is evicted, which this program never does.</p>
        <div class="try">Run to halt and read the verdict. Which register of core 1 holds the stale value?</div>`,
      scene: () => coherentScene(src('stale'), { coherent: false, programs: ['stale', 'race'], highlight: ['cache0', 'cache1'] }),
      tries: [halted],
      more: {
        numbers: `
          <p>The price, counted from the gates: one cache is <strong>${groupDigits(C.privateCache)} NAND</strong>, of which the data array is ${groupDigits(C.data)} (${pct(C.data, C.privateCache)}); the tag array is
          ${groupDigits(C.tags)} and the access decode ${groupDigits(C.access)}. The bus is ${groupDigits(C.bus)}. Two cores, two caches and the bus come to ${groupDigits(C.coherent)} NAND against ${groupDigits(C.dual)}
          for the shared-memory dual-core: the caches and the bus add ${pct(C.coherent - C.dual, C.dual)}, almost all of it storage.</p>`,
        derive: `<p>Hit and miss cost. A hit: one tag compare, one data read, no stall. A miss with a clean victim: the grant cycle, then 4 cycles for the 4 words: ${1 + 4} bus cycles, after which the access is a hit
          (one more cycle). With a Modified victim the 4 write-back cycles come first: ${1 + 4 + 4}. The bus is held for the whole transaction, so the other core's misses wait behind it.</p>`,
        real: `<p>A real L1 line is 64 bytes and the fill is one beat of a wide bus or a burst of a few; here it is 16 bytes at a word per cycle so every cycle of a fill can be read on the panel.
          What carries over unchanged is the structure: tags beside data, a dirty bit per line, a victim to write back, and a miss that holds the pipeline. Real cores add a victim buffer and keep running past a miss.</p>`,
        pitfall: `<p>Calling the stale read a bug in the cache. Each cache does exactly what a private write-back cache should; the program is wrong for a machine whose caches do not talk. The shared-memory
          dual-core hid the issue by having no caches at all.</p>`,
      },
      challenge: {
        kind: 'quiz', question: `The program has halted on this machine (no snooping). What does main memory hold at <code>x</code>?`,
        options: ['7, core 0 stored it', '0, the 7 is still a dirty line in core 0\'s cache', '7, written when core 1 read it', 'Unknown (X)'],
        answer: 1,
        why: ['A store only writes the cache in a write-back cache; memory is written when a Modified line is evicted.', '', 'Core 1 never read it again before the end: it read its own stale copy.', 'Memory is reset to 0 and nothing wrote it.'],
        explain: `Write-back keeps stores in the cache (a dirty line, state M) and writes memory only on eviction. The panel's last line shows core 0's line as M with 7 while memory still holds 0.`,
      },
    },
    {
      title: 'Snooping: MSI in gates',
      body: `
        <p>The fix is one rule: <strong>single writer, multiple readers</strong>. A line is <strong>I</strong> (no copy), <strong>S</strong> (a clean copy, any number of them) or <strong>M</strong> (the one copy, dirty).
        Two bits per set encode it, v and m: I = 00, S = 10, M = 11. State changes only on the bus, so there are three operations: <strong>BusRd</strong> (a read miss), <strong>BusRdX</strong> (a write miss: a read with ownership) and
        <strong>BusUpgr</strong> (a write to an S line: no data, just invalidate). A write that hits an M line touches only the data array.</p>
        <p>To hear the bus every cache looks the address up. If that used the core's own tag port, a snoop would steal the core's cycle, so each cache keeps
        <span data-show="cache0.stags">a second copy of the tag array</span> read at the bus's index, written together with <span data-show="cache0.ctags">the core's copy</span>: a snoop and a core access never meet.
        The snoop port costs <strong>${groupDigits(C.snoop)} NAND</strong> per cache (the second array, its comparator, the logic that writes it): ${pct(C.snoop, C.cache)} of the cache. The control that makes it coherent is cheap;
        the storage is what costs.</p>
        <p>A transaction is a <em>grant cycle</em>, in which the other cache's copy changes state, then four cycles that move the line a word at a time; the Derivation layer gives the timing cycle by cycle.</p>
        <p>Run <em>A stale copy</em> again: the 7 arrives. Core 0's store is a BusRdX that invalidates core 1's copy at its grant edge; core 1's second read is a BusRd that finds the line in core 0 as M, takes it as a Flush
        and leaves both copies S, with memory updated on the way.</p>
        <div class="try">Pick <em>Four accesses to x</em> and step it with the clock buttons. Before the last read, what state does each cache hold, and what does the trace say?</div>`,
      scene: () => coherentScene(src('stale'), { programs: ['stale', 'predict', 'race', 'atomic'], highlight: ['bus'] }),
      tries: [halted],
      tour: {
        label: 'Walk me through a read after a write',
        beats: [
          { title: 'Core 1 misses', reset: true, cycles: 3, show: ['core1', 'cache1', 'bus'], expect: { pc0: 12, pc1: 24, retire0: 1, retire1: 0, busy: 0 },
            say: '<p>Core 1 reached its <code>lw</code> (pc1 = {v:pc1}) and the line is not in its cache: retire1 = {v:retire1}. This is the grant cycle of a BusRd; the bus is not busy yet (busy = {v:busy}).</p>' },
          { title: 'The bus moves the line', cycles: 1, show: ['bus', 'cache1', 'dm'], expect: { pc0: 16, pc1: 24, retire0: 0, retire1: 0, busy: 1 },
            say: '<p>busy = {v:busy}: four cycles of a word each, from memory into cache 1. Core 0 has reached its <code>sw</code> and misses too; it waits behind core 1.</p>' },
          { title: 'The read completes', cycles: 4, show: ['cache1', 'bus'], expect: { pc0: 16, pc1: 24, retire0: 0, retire1: 1, grant1: 1, busy: 0 },
            say: '<p>Core 1\'s load now hits (grant1 = {v:grant1}) and retires. In the same cycle the bus is granted to core 0: a BusRdX for the line core 1 just filled.</p>' },
          { title: 'The write invalidates', cycles: 5, show: ['cache0', 'cache1', 'bus'], expect: { retire0: 1, retire1: 1, grant0: 1, busy: 0 },
            say: '<p>Core 0 holds the line Modified and stores 7 (grant0 = {v:grant0}). At the grant edge of that BusRdX core 1\'s copy went from S to I: it cannot read 0 any more.</p>' },
          { title: 'Core 1 reads again', cycles: 77, show: ['cache1', 'cache0', 'bus'], expect: { pc1: 40, retire1: 0, busy: 0 },
            say: '<p>Forty loops later core 1\'s second <code>lw</code> (pc1 = {v:pc1}) misses: its copy is I. Its BusRd is granted this cycle; at the edge core 0\'s M turns into S and its flush flip-flop is set.</p>' },
          { title: 'A Flush', cycles: 5, show: ['cache0', 'cache1', 'dm'], expect: { retire1: 1, grant1: 1, busy: 0 },
            say: '<p>Four cycles of words from <em>core 0\'s cache</em>, written to memory on the way and into core 1\'s cache at the same time. Core 1\'s load hits and gets 7.</p>' },
        ],
      },
      more: {
        derive: `<p>Timing, in the order it happens. In the <em>grant cycle</em> <span data-show="bus.arb">the arbiter</span> picks the winner, and at that edge the <em>other</em> cache's copy changes: BusRd turns its M into S, BusRdX and
          BusUpgr turn a hit into I, and a <em>flush</em> flip-flop notes that it held the line Modified. The next four cycles move the line a word at a time: after a flush the words come from the other cache's data array, through its
          second read port, and are written to memory in the same cycle they enter the requester's cache; otherwise they come from memory. The last cycle writes the requester's state (M for a write, S for a read) and tag.
          A BusUpgr is the grant cycle plus one. Changing the other copy at the grant edge, not at the end, is what makes the flush safe: from then on the other core cannot store into that line, so no write slips in behind words already sent.</p>
          <p>Transactions for the chapter's race, counted by the model and equal to the gates': ${run('race').bus} bus transactions (${run('race').rd} BusRd, ${run('race').rdx} BusRdX, ${run('race').upgr} BusUpgr) for 40 increments,
          of which ${run('race').flushes} were Flushes. In turn: one core's <code>lw</code> misses and its <code>sw</code> upgrades, invalidating the other's copy; the other core's <code>sw</code> then needs a BusRdX. Three transactions for each two increments.
          Lost updates remain: coherence keeps the caches agreeing, it does not make a load, add and store atomic.</p>`,
        real: `<p>This is MSI. MESI adds an Exclusive state and a "shared" wire so that a read nobody else holds can later be written with no transaction; MOESI and MESIF let a cache answer from its copy instead of memory.
          Intel and AMD cores use such variants, and past a few dozen cores the broadcast gives way to a directory.</p>`,
        pitfall: `<p>Believing that snooping makes shared variables safe. It makes every cache see the same <em>value</em> for a line; whether a read-modify-write is indivisible is a different question,
          answered by the atomics and the lock of the next steps.</p>`,
      },
      challenge: {
        kind: 'quiz', question: `<em>Four accesses to x</em>: core 0 reads, core 1 reads, core 0 writes, core 1 reads again. Which states does the line end in, (core 0, core 1)?`,
        options: OPTS, answer: OPTS.indexOf(`${pa}, ${pb}`),
        why: OPTS.map((o) => (o === `${pa}, ${pb}` ? '' : o === 'M, I' ? 'That is the state after the write, before core 1\'s second read. The read then asks the bus, and the M holder must supply the line and give up exclusivity.'
          : o === 'M, S' ? 'Two valid copies cannot include a Modified one: M means the only copy.' : 'A read of the line never invalidates the reader\'s own copy; core 1 ends with a valid copy.')),
        explain: `After the write: (M, I). Core 1's read is a BusRd; core 0 holds the line Modified, so it Flushes (the line goes to memory and to core 1 at once) and drops to S. Final: (${pa}, ${pb}). Step the program and compare.`,
      },
    },
    {
      title: 'The spin lock, measured',
      body: `
        <p>The spin lock of the earlier step now runs on caches, and its cost has a new shape. <code>amoswap.w</code> is a write, so every try needs the lock's line in M: with the holder and the spinner both
        doing it, <em>each try is a bus transaction</em> and the line ping-pongs. Forty acquires (20 per core) take <strong>${spin.cycles} cycles and ${spin.bus} transactions</strong>: ${per(spin.bus, 40)} per acquire, the bus busy ${pct(spin.busyShare, 1)} of the time.</p>
        <p><strong>Test-and-test-and-set</strong> spins with a plain <code>lw</code> first. The spinner's copy of the lock line is S, so every try is a hit: no bus until the holder's release invalidates it. Then the spinner re-reads
        (one BusRd), sees 0, swaps. The same forty acquires take <strong>${ttas.cycles} cycles and ${ttas.bus} transactions</strong>: ${per(ttas.bus, 40)} per acquire, the bus busy ${pct(ttas.busyShare, 1)}.
        That is ${pct(ttas.bus, spin.bus)} of the traffic and ${pct(ttas.cycles, spin.cycles)} of the time, from adding a load and its branch before the write. The table under the caches is measured by running both programs.</p>
        <p>The same machinery shows <strong>false sharing</strong> in gates. <em>False sharing</em> and <em>Padded</em> run one loop: each core adds 1 to its own word twenty times. Four bytes apart the words share a line:
        <strong>${fs.cycles} cycles, ${fs.bus} transactions, ${fs.invalidations} invalidations</strong>. Sixteen bytes apart, a line each: <strong>${pad.cycles} cycles, ${pad.bus} transactions, ${pad.invalidations} invalidations</strong>.
        Nothing about the variables is shared, only the line, and the line moves between the caches ${fs.invalidations} times.</p>
        <p>One thing the totals hide: test-and-test-and-set is not fair. The core that just released the lock still holds its line and tends to get back to it first: core 0 spent ${ttas.stalls[0]} cycles waiting on the bus and core 1 ${ttas.stalls[1]}.
        Round-robin arbitration is fair per transaction, not per lock.</p>
        <div class="try">Switch between <em>Spin lock: amoswap</em> and <em>Spin lock: test-and-test-and-set</em> and watch the trace. How many BusRdX does each print before the first acquire completes?</div>`,
      scene: () => coherentScene(src('spin'), {
        programs: ['spin', 'ttas', 'falseshare', 'padded'], measure: { ids: ['spin', 'ttas', 'falseshare', 'padded'], unit: 'acquire / add', per: 40 }, highlight: ['bus'],
      }),
      tries: [halted],
      more: {
        derive: `<p>Where ${spin.bus} comes from, roughly: ${spin.rd} BusRd, ${spin.rdx} BusRdX, ${spin.upgr} BusUpgr. The counter's line moves in the critical sections (about 2 transactions per acquire: the line is in the other cache as M or S);
          the rest is the lock line, written by every failed swap. ${ttas.bus} for test-and-test-and-set: ${ttas.rd} BusRd, ${ttas.rdx} BusRdX, ${ttas.upgr} BusUpgr.</p>`,
        real: `<p>Production locks go further: exponential back-off between tries, queueing locks (ticket, MCS) so that each waiter spins on its own line and a release invalidates exactly one cache, and
          padding every contended variable to a full 64-byte line (<code>alignas(64)</code>) or two, since adjacent-line prefetchers pair lines.</p>`,
        pitfall: `<p>Reading cycles per acquire off a single run. The numbers depend on who wins the arbitration at the start and on the loop length; the traffic ratio is what generalizes.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'Why does test-and-test-and-set put so much less on the bus than spinning with <code>amoswap.w</code>?',
        options: ['The swap is a slower instruction', 'The spinner\'s loads hit its Shared copy of the lock line, so nothing reaches the bus until the release invalidates it', 'The arbiter ignores loads', 'The lock line is never written'],
        answer: 1,
        why: ['The instruction costs the same; what differs is whether it needs the line in M.', '', 'Loads that hit never reach the bus; those that miss do arbitrate like any request.', 'Every acquire and release writes it; the saving is in the tries in between.'],
        explain: 'A failed amoswap still writes (it stores 1), so it needs the line Modified: a BusRdX or BusUpgr per try, and each one invalidates the holder\'s copy. A load that hits an S copy needs nothing; the traffic is one re-read per release.',
      },
    },
    {
      title: 'lr.w and sc.w',
      body: `
        <p>Two atomics do an add and a swap, and a lock built on the swap does the rest; a machine with caches can offer something more general: <code>lr.w</code> reads a word and <em>reserves</em> its line; <code>sc.w</code> stores only if
        the reservation still holds and writes 0 to rd, else writes 1 and stores nothing. Any update is then a retry loop: <code>lr.w</code>, compute, <code>sc.w</code>, branch back if rd is not 0.</p>
        <p>The reservation is <span data-show="cache0.res">a valid bit and a line address per cache</span>: ${groupDigits(C.reservation)} NAND. <code>lr.w</code> sets it. It is cleared by <em>any</em> <code>sc.w</code>, by <em>another cache's BusRdX or BusUpgr for
        that line</em> (the snooped invalidation: someone is about to write it, and the snoop tag lookup that detects it exists anyway), and by this cache's own fill evicting the line. A clear beats a set on the same edge, so an
        <code>lr.w</code> retiring in the very cycle its line is invalidated gets no reservation; <code>sc.w</code> tests the reservation as of the start of its cycle. With a reservation the line is S or M, so an <code>sc.w</code> needs at
        most a BusUpgr; without one it fails at once, on no bus transaction.</p>
        <p>The core is untouched: its own decoder takes <code>lr.w</code> and <code>sc.w</code> for an <code>amoswap.w</code>. The cache's <span data-show="cache0.acc">access decode</span> tells them apart from the instruction word, withholds the write
        for <code>lr.w</code> and for a failed <code>sc.w</code>, and puts the 0 or 1 on the read-data wire in place of memory's word.</p>
        <p>The atomic add as a retry loop, twenty per core: <strong>${lr.cycles} cycles</strong>, counter ${lr.mem[16]} every time, <strong>${lr.scFails} failed <code>sc.w</code></strong> (${lr.scOk} succeeded); <code>amoadd.w</code> does it in
        ${amo.cycles} cycles with ${amo.bus} bus transactions, where the retry loop used ${lr.bus}. All ${lr.scFails} failures are core 1's: core 0's twenty <code>sc.w</code> succeed by cycle ${lr.scLast[0]}, and core 1's first success is at cycle ${lr.scFirst[1]}, after core 0 has finished. The winner of a BusUpgr is back at its <code>lr.w</code>, which hits, before the loser's re-read of the line returns,
        and wins the next one too. The architecture requires a constrained loop like this to succeed eventually; real cores arrange it with a short hold-off (a snooped invalidation of a line with a live reservation waits a few cycles after the <code>lr.w</code>). This cache has none, so
        here the guarantee is only that the other core stops.</p>
        <div class="try">Run the loop and watch the <em>sc failures</em> counter and the reservation lines. Which core loses its reservation, and which transaction takes it?</div>`,
      scene: () => coherentScene(src('lrsc'), { programs: ['lrsc', 'atomic'], highlight: ['cache0', 'cache1'] }),
      tries: [halted],
      more: {
        derive: `<p>Why correct. Both cores run <code>lr.w</code> and each holds the line S with its reservation. The first <code>sc.w</code> to win the bus (a BusUpgr) invalidates the other core's line at its grant edge and clears its reservation in the same edge;
          the loser's <code>sc.w</code> then finds no reservation and fails with no transaction. Its retry misses, reads the winner's value as a Flush, and tries again from the new count: no update is lost.</p>`,
        real: `<p>Real cores keep the reservation in the L1 and clear it on any snoop invalidation, an eviction, an interrupt return, or a context switch; some also fail an <code>sc.w</code> if another memory access sits between the pair. The spec
          gives the guarantee only to "constrained" loops (at most 16 instructions, no other loads or stores).</p>`,
        pitfall: `<p>Putting a load or store between <code>lr.w</code> and <code>sc.w</code>. If it maps to the same cache set it evicts the reserved line, the reservation is cleared, and the <code>sc.w</code> fails every time: a livelock no test of the
          loop's logic reveals.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'Core 0 has executed <code>lr.w</code> on a line. Core 1 now only <em>reads</em> that line (a BusRd), then core 0 executes <code>sc.w</code>. What happens?',
        options: ['It fails: any bus transaction on the line clears the reservation', 'It succeeds: a read does not invalidate anything, so the reservation holds (the line may drop to S and the store then needs a BusUpgr)', 'It fails, because the line is no longer Modified', 'It succeeds and core 1\'s copy stays valid'],
        answer: 1,
        why: ['Only a BusRdX or BusUpgr for the line (a pending write), an eviction or another sc.w clears it.', '', 'sc.w does not need the line Modified when it starts; it upgrades S to M with a BusUpgr, which is why it can succeed from S.', 'The store needs M, so core 1\'s copy is invalidated by core 0\'s BusUpgr.'],
        explain: 'The reservation is lost when someone writes (or is about to write) the line, when it is evicted, or after any sc.w. A reader changes nothing. If the read made core 0 drop from M to S, its sc.w upgrades with BusUpgr, invalidating core 1.',
      },
    },
  ];
}

const TITLES = ['Private caches in gates', 'Snooping: MSI in gates', 'The spin lock, measured', 'lr.w and sc.w'];
let built: Step[] | undefined;
const real = (): Step[] => (built ??= build());
export const COH_STEPS: Step[] = TITLES.map((title, k): Step => ({
  title,
  get body() { return real()[k].body; },
  get scene() { return real()[k].scene; },
  get tour() { return real()[k].tour; },
  get more() { return real()[k].more; },
  get tries() { return real()[k].tries; },
  get challenge() { return real()[k].challenge; },
}));
