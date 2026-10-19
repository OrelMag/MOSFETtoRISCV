import { ARBITER2 } from '../lib';
import { MC_PROGRAMS } from '../riscv/mcprograms';
import { pack } from '../sim/values';
import type { Stage } from '../view/stage';
import { coherenceWidget, dualCoreScene } from '../widgets/multicore';
import type { Chapter } from './types';

const mc = (id: string) => MC_PROGRAMS.find((p) => p.id === id)!.source;

/** The shared counter (word 16 of the shared memory). */
function counter(st: Stage): number {
  const sim = st.sim;
  const dm = sim?.design.root.children?.get('dm')?.children?.get('ram');
  const w = dm?.children?.get('w16');
  return sim && w ? pack(sim.getBits(w.ports.q)) >>> 0 : -1;
}
const runToHalt = () => { [...document.querySelectorAll<HTMLButtonElement>('.cpu-panel button')].find((b) => b.textContent === 'Run to halt')?.click(); };
const halted = () => !!document.querySelector('.cpu-panel .cpu-status .warn');

export const chMulticore: Chapter = {
  id: 'multicore', num: 24, title: 'Many cores', level: 'Systems',
  blurb: 'Two cores sharing one memory: arbitration, a race, atomic operations, a spin lock, and cache coherence.',
  goals: [
    'say why the end of Dennard scaling turned extra transistors into extra cores, from dynamic power C·V²·f',
    'explain how a round-robin arbiter shares one memory port, and why fixed priority can starve a core',
    'find the lost update in a load–add–store race and fix it with <code>amoadd.w</code> or an <code>amoswap.w</code> spin lock',
    'follow a write-invalidate protocol (MSI, MESI) and spot false sharing',
  ],
  builds: ['cpu', 'cache'],
  recap: {
    keep: [
      'Dynamic power is C·V²·f. Since about 2005 the supply voltage no longer falls with each generation, so clocks stay near 3 to 5 GHz and the extra transistors become extra cores. Amdahl: with a fraction p parallel, n cores give 1 / ((1 − p) + p / n), never more than 1 / (1 − p).',
      'Two copies of the single-cycle core share one single-port memory. A round-robin arbiter grants it to one core per cycle; the loser holds its PC and register write and tries again.',
      'Every access is atomic; a load–add–store sequence is not: two cores adding 1 twenty times each end at 20, not 40. <code>amoadd.w</code> reads, adds and writes in one arbitrated access: 40, every time.',
      'An <code>amoswap.w</code> spin lock makes any critical section safe, at a price: over four times the run time of the atomic add, the cores fighting for the port while they spin.',
      'Private caches stay coherent by write-invalidate snooping, per line. MESI\'s Exclusive state makes private data free; two variables on one line ping-pong between caches (false sharing).',
      'Real cores reorder (RVWMO): with store buffers both cores of the store-buffering test can read 0. A lock is taken with acquire (<code>amoswap.w.aq</code>) and freed with release (<code>.rl</code> or <code>fence rw,w</code>). LR/SC builds any other atomic as a retry loop; this site\'s cores have the two AMOs only.',
    ],
    practise: ['m_bus'],
    check: [
      {
        question: 'Both cores request the memory port in every cycle. How many grants does core 1 get in 10 cycles?',
        options: ['5', '0: core 0 has priority', '10'],
        answer: 0,
        explain: 'Round robin: whoever holds the priority bit wins a contested cycle, and the bit flips, so the grants alternate.',
        why: ['', 'That is fixed priority, which can starve a core. Round robin flips the priority bit after every contested grant.', 'One port means one grant per cycle, shared by the two cores.'],
      },
      {
        question: 'In the race, every <code>lw</code> and <code>sw</code> is atomic, yet half the increments are lost. Why?',
        options: [
          'Core 1 loads the counter before core 0 has stored its increment, so both store the same value',
          'The arbiter drops one of two simultaneous stores',
          'Core 1 reads a stale copy from its cache',
        ],
        answer: 0,
        explain: 'Core 1 runs one cycle behind: its load comes between core 0\'s load and store. Both add 1 to the same old value, and two increments make +1.',
        why: ['', 'Losing arbitration delays an access by a cycle; it never discards one.', 'This dual-core has no caches: both cores read the one shared memory, and the value is stale only because the other core\'s store comes later.'],
      },
      {
        question: 'A core reads a block no other cache holds, then writes it. How many bus transactions under MSI, and under MESI?',
        options: ['2 and 1', '1 and 1', '2 and 2', '1 and 0'],
        answer: 0,
        explain: 'Both protocols fetch the block on the read miss. MSI leaves it Shared, so the write must broadcast an upgrade; MESI leaves it Exclusive, and the write moves it to Modified silently.',
        why: ['', 'Under MSI the read leaves the block Shared, so the write must broadcast an invalidation first.', 'MESI\'s Exclusive state exists for exactly this case: E to M needs no bus.', 'The read miss still fetches the block over the bus, in either protocol.'],
      },
      {
        question: 'A program spends 90 % of its time in work that parallelizes perfectly. What speed-up do 8 cores give, and what is the most any number of cores can give?',
        options: ['About 4.7×, at most 10×', '7.2×, at most 9×', '8×, with no limit', 'About 4.7×, with no limit'],
        answer: 0,
        explain: 'Amdahl: 1 / ((1 − p) + p / n) = 1 / (0.1 + 0.9 / 8) = 1 / 0.2125 ≈ 4.7. As n grows, p / n vanishes and the serial 10 % remains: 1 / 0.1 = 10×.',
        why: ['', '7.2 is 0.9 × 8: it drops the serial tenth, which runs at one core\'s speed whatever n is. And the ceiling is 1 / 0.1 = 10, not 9.', 'Only the parallel 90 % shrinks with more cores; the serial 10 % takes as long as ever.', 'The serial 10 % never shrinks: even with infinitely many cores the run takes a tenth of the original time, so 10× is the ceiling.'],
      },
    ],
  },
  steps: [
    {
      title: 'Why more cores?',
      body: `
        <p>For thirty years each process generation made transistors smaller, faster and lower-voltage at constant power density (Dennard scaling).
        Clock rates climbed. Around 2005 the voltage stopped falling, because leakage current grows as the threshold voltage drops. Dynamic power is
        C·V²·f, so faster clocks now meant hotter chips. Frequencies have stayed near 3 to 5 GHz ever since.</p>
        <p>Moore's law kept delivering transistors, though, and the way to use them without raising the clock is <strong>more cores</strong>. Software
        then has to be parallel, and correct in parallel, which is what this chapter is about.</p>
        <p>Cores speed up only the part of the work that runs in parallel. With a fraction p of it parallel, n cores give a speed-up of
        1 / ((1 − p) + p / n) (<strong>Amdahl's law</strong>): at p = 90 %, 8 cores give 1 / (0.1 + 0.1125) = 4.7×, and no number of cores beats
        1 / (1 − p) = 10×. The serial tenth, plus the time the cores spend waiting for each other (the lock below), sets the ceiling. What saves
        many-core machines is that bigger problems usually grow the parallel part, not the serial one (Gustafson).</p>`,
      challenge: {
        kind: 'quiz', question: 'A core runs at 4 GHz and 1.0 V. Two cores at 2.8 GHz and 0.8 V split the same work between them. Relative dynamic power?',
        options: ['Twice as much', 'About the same', 'About 0.9×', 'About half'], answer: 2,
        why: ['That counts the cores and forgets that V² and f both fell: each core runs at 0.64 × 0.7 of the power.', 'Close, but 3.58 against 4 is a real saving: the voltage pays quadratically.', '', 'Each slower core uses 0.64 × 0.7 ≈ 0.45 of the power, and there are two of them: 0.9×, not 0.5×.'],
        explain: 'P ∝ cores × V² × f: 2 × 0.64 × 2.8 = 3.58 versus 1 × 1 × 4 = 4, so about 0.9× the power for 1.4× the throughput (if the work parallelizes). The energy per task falls further, to 0.64× (V²: the same switching at 0.8 V): lower voltage pays quadratically.',
      },
    },
    {
      title: 'Two cores, one memory',
      body: `
        <p>Here are <span data-show="core0 core1">two copies of the single-cycle core</span>: the same component, instantiated twice. Open one: it has a memory <em>port</em> instead of a memory,
        <span data-show="core0.mpd">a decoder for atomics</span>, and <span data-show="h0 h1">an input carrying its hart id</span>, which <code>csrr a0, mhartid</code> reads. Both run the same program and use the id to divide the work.</p>
        <p><span data-show="dm">The shared memory</span> has one port, so an <span data-show="arb"><strong>arbiter</strong></span> grants it to one core per cycle. A core that loses holds its PC and register write for a cycle and
        tries again. A multi-hart instruction-set simulator (the reference model of the ISA) applies the same arbitration and checks both cores after every cycle.</p>
        <div class="try">Run "Who am I?": each core fills and sums its own half of an array; both store 36.</div>`,
      scene: () => dualCoreScene(mc('harts')),
    },
    {
      title: 'The arbiter',
      body: `
        <p>A two-way round-robin arbiter: one request is simply <span data-show="g0 g1">granted</span>. If both cores ask, the one holding
        <span data-show="ff">the priority bit</span> wins and the bit flips, so the loser wins next time. Fixed priority would let one busy core starve the other forever.</p>
        <div class="try">Raise both requests and pulse the clock: the grants alternate.</div>`,
      scene: () => ({ root: ARBITER2, inputs: { r0: 1, r1: 1, clk: 0 } }),
    },
    {
      title: 'A race',
      body: `
        <p>Both cores add 1 to <span data-show="dm">a shared counter</span> twenty times with <code>lw</code>, <code>addi</code>, <code>sw</code>. Expect 40. Both reach the first <code>lw</code> in the same
        cycle; core 1 loses <span data-show="arb">arbitration</span> and runs one cycle behind from then on. So core 1 always loads the counter <em>before</em> core 0 has stored its increment.
        Each pair of increments produces +1, and half the updates are lost.</p>
        <p>Nothing is broken in the hardware: every access is atomic on its own. The <em>sequence</em> load–add–store is not.</p>`,
      scene: () => dualCoreScene(mc('race')),
      challenge: {
        kind: 'reach', goal: 'Run both cores to the end and read the counter.',
        check: (st) => counter(st) === 20 && halted(),
        hints: [
          'The CPU panel can run both cores until they halt.',
          'The counter is the shared memory word at byte address 0x40. Compare it with the forty increments the two loops make.',
        ],
        answer: 'Run to halt: the counter (word 0x40) ends at 20, not 40. Change the timing (another instruction before the loop on one core) and the result changes: the bug depends on the interleaving.',
        solve: runToHalt,
      },
    },
    {
      title: 'Atomic read-modify-write',
      body: `
        <p>The fix belongs in the instruction set: <code>amoadd.w rd, rs2, (rs1)</code> reads the word, adds, and writes it back in a <em>single</em> memory access.
        Nothing can come in between, because <span data-show="arb">the arbiter</span> grants the port for that one access. In the core, the atomic looks like a load to the control unit (it writes rd),
        <span data-show="core0.amux">its address is rs1 itself</span>, and <span data-show="core0.amoadd">a dedicated adder</span> computes old + rs2 for the write.</p>
        <p>Doing the read, the add and the write in one cycle, serialized by the one port's arbiter, is a deliberate simplification. In a real system with caches,
        the core gets the cache line exclusively and holds it for the duration of the operation: the same idea, with coherence doing the arbitration.</p>
        <details class="deeper"><summary>Deeper: LR/SC, the other half of the A extension</summary>
        <p><code>lr.w rd, (rs1)</code> loads a word and places a <em>reservation</em> on it (in practice on its cache line). <code>sc.w rd, rs2, (rs1)</code>
        stores rs2 only if the reservation still holds, and writes rd = 0 on success, non-zero on failure. Another hart's store to the reserved bytes breaks
        the reservation, and an implementation may fail an sc for other reasons too, so software always loops. Any read-modify-write that no AMO
        provides becomes atomic, compare-and-swap for instance:</p>
        <pre class="code">cas: lr.w  t0, (a0)       # a0: address, a1: expected, a2: new
     bne   t0, a1, fail   # someone else's value: give up
     sc.w  t1, a2, (a0)
     bnez  t1, cas        # reservation lost: try again</pre>
        <p>Retry loops can livelock, two harts breaking each other's reservations forever. RISC-V promises eventual success only to a
        <em>constrained</em> loop: at most 16 instructions, and between lr and sc only base integer instructions, with no loads, stores, backward
        jumps or taken backward branches, fences or system instructions. An AMO needs no loop: the memory (or the cache that owns the line) does the
        whole operation as one request, so it always completes and stays cheap under contention, where LR/SC retries pile up. LR/SC covers the
        rest. The cores on this site implement two AMOs, <code>amoadd.w</code> and <code>amoswap.w</code>, and no LR/SC: one arbitrated access is
        easy to make atomic; a reservation needs a monitor watching every other core's stores.</p></details>`,
      scene: () => dualCoreScene(mc('atomic')),
      challenge: {
        kind: 'reach', goal: 'Run to the end: the counter must be 40.',
        check: (st) => counter(st) === 40 && halted(),
        hints: [
          'Run both cores to the end, as for the race, and read the same word.',
          'Each amoadd.w is one arbitrated access: a core that loses the port retries the whole operation, so no increment can fall between another core\'s read and write.',
        ],
        answer: 'Run to halt: 40, every time. 40 atomic operations, each a single arbitrated access.',
        solve: runToHalt,
      },
    },
    {
      title: 'A spin lock',
      body: `
        <p>Most critical sections are longer than one add. <code>amoswap.w</code> builds a lock: swap 1 into the lock word, and if the old value was 0 you own it.
        Otherwise spin and try again. Release by storing 0. Between acquire and release, the ordinary <code>lw</code>/<code>addi</code>/<code>sw</code> is safe.</p>
        <p>Correct, but count the cost: the run takes over four times longer than the atomic add, and the stall counters show the cores fighting for <span data-show="arb dm">the memory port</span> while they spin.
        Real locks back off, or spin on a cached copy (test-and-test-and-set) to keep the bus quiet.</p>`,
      scene: () => dualCoreScene(mc('lock')),
    },
    {
      title: 'Caches and coherence',
      body: `
        <p>Our cores share one memory, so they can never see different values. Real cores each have private caches, and the moment two caches hold the same block,
        a write in one must reach the other. The standard answer is a <strong>write-invalidate snooping protocol</strong>. Before writing, a core broadcasts on the bus and every other
        copy is invalidated. A read of a block that someone holds Modified gets the data from that cache.</p>
        <p>MESI adds an <em>Exclusive</em> state: a block read by only one core can later be written without any bus traffic. That covers the common case of private data.</p>
        <p>Snooping needs every cache to see every request, a broadcast that stops scaling past a few dozen cores. Large machines keep a
        <strong>directory</strong> instead: per memory block, a record of which caches hold it, so invalidations go point to point to the sharers alone.</p>
        <div class="try">Compare "Private read-then-write" under MSI and MESI. Then compare "False sharing" with "Padded".</div>`,
      widget: coherenceWidget,
      challenge: {
        kind: 'quiz', question: 'Two threads update two different variables, x and y, which happen to sit in the same 64-byte cache line. What happens?',
        options: ['Nothing: they are different variables', 'The line ping-pongs between the caches: every write invalidates the other copy (false sharing)', 'The hardware detects it and splits the line', 'The writes are lost'],
        answer: 1,
        why: ['Coherence tracks whole lines, not variables: a write to x needs ownership of the line that also holds y.', '', 'The hardware has no notion of variables inside a line; only software (padding, alignment) can separate them.', 'Coherence keeps both writes; false sharing costs traffic, not correctness.'],
        explain: 'Coherence works on whole lines. Each write needs exclusive ownership of the line, so the two cores take turns invalidating each other, although they never touch the same byte. Padding the variables onto separate lines removes the traffic entirely.',
      },
    },
    {
      title: 'Memory ordering',
      body: `
        <p>Our dual-core is <strong>sequentially consistent</strong>: there is one memory port, so all accesses happen in one global order consistent with each program.
        Real cores reorder: a store waits in a store buffer while later loads go ahead, and that is invisible to one thread but not to another. RISC-V specifies a
        weak model (RVWMO) and gives the programmer <code>fence</code> instructions, plus <em>acquire</em> and <em>release</em> bits on atomics (the aq and rl bits this
        implementation ignores), to restore order exactly where it matters.</p>
        <p>The classic litmus test is <em>store buffering</em>. From x = y = 0, core 0 stores x = 1 and then loads y, core 1 stores y = 1 and
        then loads x. Sequentially consistent, some store comes first in the one global order, so at least one load sees a 1. With store buffers each
        store waits in its own core while the load behind it goes ahead, and <strong>both cores read 0</strong>.
        RVWMO allows that outcome (so does x86); a <code>fence w,r</code> between each store and its load forbids it.</p>
        <p>A lock needs order at both ends. Taking it is an <em>acquire</em>: the critical section's loads and stores must not be performed before the
        lock is held, or they could read the counter while another core still owns it: <code>amoswap.w.aq</code> (or the swap, then <code>fence r,rw</code>).
        Freeing it is a <em>release</em>: everything before must be visible before the lock reads free: <code>amoswap.w.rl x0, x0, (lock)</code>
        (or <code>fence rw,w</code>, then the store). Accesses may move into the critical section, never out of it.</p>`,
      challenge: {
        kind: 'quiz', question: 'In the spin lock, why should the release (sw zero, lock) have release semantics on a real RISC-V core?',
        options: ['To make it faster', 'So that the stores of the critical section become visible to other cores before the lock appears free', 'Because sw cannot write zero', 'It does not matter'],
        answer: 1,
        why: ['If anything a release costs time: the store must wait until the earlier accesses are visible.', '', 'sw zero, lock stores x0, which always reads 0; the value is not the problem.', 'It does not matter on this sequentially consistent dual-core, which is why the bug hides; on a weakly ordered core the lock store can overtake the counter store.'],
        explain: 'Without ordering, the lock store could become visible before the counter store, and another core could enter the critical section and read the old counter. A fence rw,w before the release store (or amoswap.w.rl) prevents that. On our sequentially consistent machine the bug cannot happen, which is exactly why such bugs hide in testing.',
      },
    },
  ],
};
