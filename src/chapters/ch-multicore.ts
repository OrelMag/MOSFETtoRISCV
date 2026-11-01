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
/** Relative dynamic power of n cores at v volts and f GHz (C absorbed): n · V² · f. */
const power = (n: number, v: number, f: number) => n * v * v * f;
/** Amdahl's speed-up with parallel fraction p on n cores. */
const amdahl = (p: number, n: number) => 1 / ((1 - p) + p / n);
/** Store buffering under sequential consistency: every interleaving of (x=1; r0=y) and (y=1; r1=x) that keeps each thread's order. */
function sbSc(): { runs: number; outcomes: string[] } {
  const a = ['x=1', 'r0=y'], b = ['y=1', 'r1=x'], seen = new Set<string>();
  let runs = 0;
  const go = (i: number, j: number, m: Record<string, number>) => {
    if (i === 2 && j === 2) { runs++; seen.add('r0=' + m.r0 + ' r1=' + m.r1); return; }
    const step = (op: string) => { const [d, s2] = op.split('='); const n = { ...m }; n[d] = s2 === '1' ? 1 : (m[s2] ?? 0); return n; };
    if (i < 2) go(i + 1, j, step(a[i]));
    if (j < 2) go(i, j + 1, step(b[j]));
  };
  go(0, 0, { x: 0, y: 0, r0: -1, r1: -1 });
  return { runs, outcomes: [...seen].sort() };
}
const SB = sbSc();

export const chMulticore: Chapter = {
  id: 'multicore', num: 27, title: 'Many cores', level: 'Systems',
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
        many-core machines is that bigger problems usually grow the parallel part, not the serial one (Gustafson).</p>
        <p>The rest of the chapter is about the price of sharing. Two cores that never touch the same data need nothing but a second copy of the core. The moment they share a
        memory they need a rule for who goes first (an arbiter), a way to make a read-modify-write indivisible (atomic instructions), a way to keep each core's copies of shared data
        agreeing (coherence), and a statement of the order in which one core's writes are seen by another (the memory model).</p>`,
      more: {
        derive: `<p>Dynamic power P = α · C · V² · f per core, so n cores at (V, f) draw n · V² · f in relative terms. One core at 1.0 V and 4 GHz: ${power(1, 1, 4)}. Two at 0.8 V and 2.8 GHz:
          ${power(2, 0.8, 2.8).toFixed(2)}, with ${(2 * 2.8 / 4).toFixed(1)}× the peak throughput. The saving is the V²: slowing a core lets its voltage fall, and power falls with the square. Amdahl bounds the gain:
          1 / ((1 − p) + p / n) is ${amdahl(0.9, 2).toFixed(2)} for n = 2 and ${amdahl(0.9, 8).toFixed(2)} for n = 8 at p = 0.9, and tends to ${(1 / (1 - 0.9)).toFixed(0)}.</p>`,
        real: `<p>Dennard scaling stopped around 2005: voltage could no longer fall with feature size because leakage grew as the threshold fell, and Intel cancelled its
          next single-core Pentium 4 line in 2004 for power. Mainstream clocks have stayed at 3 to 5 GHz since, and the extra transistors became cores, wider vectors and bigger caches.</p>`,
        pitfall: `<p>Reading the speed-up as the core count. With 10 % serial, 64 cores give ${amdahl(0.9, 64).toFixed(1)}×, not 64: the serial tenth and the synchronization between cores (the lock step below)
          set the ceiling, not the number of cores.</p>`,
        numbers: `<table class="mini"><thead><tr><th>Cores</th>${[1, 2, 4, 8, 16, 64].map((n) => `<th>${n}</th>`).join('')}</tr></thead><tbody>${[0.5, 0.9, 0.99].map((p) => `<tr><td>p = ${p}</td>${[1, 2, 4, 8, 16, 64].map((n) => `<td>${amdahl(p, n).toFixed(1)}×</td>`).join('')}</tr>`).join('')}</tbody></table>`,
      },
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
        <p>Each core keeps its own program ROM, so instruction fetch never competes: only loads and stores reach the shared port. That is why two cores running the same code stay
        in step until the first memory access, and why the arbiter decides the order of everything that follows.</p>
        <div class="try">Run "Who am I?": each core fills and sums its own half of an array; both store 36.</div>`,
      scene: () => dualCoreScene(mc('harts')),
      tour: {
        beats: [
          { title: 'In step', reset: true, cycles: 4, show: ['core0', 'core1'], expect: { pc0: 16, pc1: 16, retire0: 1, retire1: 1 },
            say: '<p>Both cores run the same program from address 0 and have retired the same instructions: pc0 = {v:pc0}, pc1 = {v:pc1}. The instructions so far touched no memory, so nothing divided them.</p>' },
          { title: 'First contention', cycles: 1, show: ['arb', 'dm'], expect: { pc0: 20, pc1: 20, grant0: 1, retire1: 0 },
            say: '<p>Both are now at {v:pc0} with a memory access. The arbiter grants the port to core 0 (grant0 = {v:grant0}); core 1 does not retire this cycle (retire1 = {v:retire1}) and keeps its PC and register write for a retry.</p>' },
        ],
      },
      more: {
        derive: `<p>The port serves one access a cycle. If a fraction m of instructions access data, two cores at one instruction a cycle demand 2m accesses a cycle: below m = 1/2 conflicts only delay a
          core by a cycle now and then, above it the port saturates and the cores run at the port's pace. The time one core loses is its wait for the other's access: at most one cycle per
          access with two cores.</p>`,
        real: `<p>Real shared memory is many ports: banks, several channels, and between the cores and DRAM a hierarchy of caches that serves most accesses privately. The single arbitrated
          port is the minimum that shows every problem: ordering, atomicity and a bus others can see.</p>`,
        pitfall: `<p>Assuming the cores keep step. They did for four cycles; a contended access holds one core for a cycle and offsets them from then on, and every later
          interleaving follows from that. The race step shows it.</p>`,
      },
    },
    {
      title: 'The arbiter',
      body: `
        <p>A two-way round-robin arbiter: one request is simply <span data-show="g0 g1">granted</span>. If both cores ask, the one holding
        <span data-show="ff">the priority bit</span> wins and the bit flips, so the loser wins next time. Fixed priority would let one busy core starve the other forever.</p>
        <p>The state is one flip-flop. It flips only in a cycle where both request, because the priority bit has meaning only when there is a conflict: a lone request is granted
        whatever the bit says, and leaves the bit alone. That makes the policy fair and cheap: a loser waits one cycle, and a core that does not ask never loses its turn.</p>
        <div class="try">Raise both requests and pulse the clock: the grants alternate.</div>`,
      scene: () => ({ root: ARBITER2, inputs: { r0: 1, r1: 1, clk: 0 } }),
      tour: {
        beats: [
          { title: 'Both ask', show: ['g0', 'g1', 'ff'], expect: { g0: 1, g1: 0, p: 0 },
            say: '<p>Both requests are high. The priority bit is {v:p}, so core 0 is granted: g0 = {v:g0}, g1 = {v:g1}.</p>' },
          { title: 'Turns alternate', cycles: 1, show: ['ff', 'x'], expect: { g0: 0, g1: 1, p: 1 },
            say: '<p>The conflict flipped the bit at the edge: p = {v:p}, and now core 1 wins: g0 = {v:g0}, g1 = {v:g1}.</p>' },
          { title: 'A lone request', set: { r1: 0 }, show: ['b1', 'g0'], expect: { g0: 1, g1: 0, p: 1 },
            say: '<p>Core 1 stops asking. Core 0 is granted even though the bit favours core 1: nobody else wants the port.</p>' },
          { title: 'The bit holds', cycles: 1, expect: { g0: 1, g1: 0, p: 1 },
            say: '<p>With no conflict the bit does not flip: p stays {v:p}.</p>' },
          { title: 'Core 1 asks again', set: { r1: 1 }, show: ['g1', 'ff'], expect: { g0: 0, g1: 1, p: 1 },
            say: '<p>Now both ask, p = {v:p}, and core 1 is granted: the turn it was owed is still its own.</p>' },
        ],
      },
      more: {
        derive: `<p>With p the priority bit: g0 = r0 · ¬(r1 · p), g1 = r1 · ¬(r0 · ¬p), and p′ = p XOR (r0 · r1). If only one request is high, its grant is 1 whatever p is. If both are high, exactly
          one grant is: g0 when p = 0, g1 when p = 1, and p flips. So over any run of conflicts the grants alternate, and a core waits at most one cycle for any grant it asks while the other is served.
          For n requesters the same idea needs a pointer and a mask: a loser waits at most n − 1 grants.</p>`,
        real: `<p>Round robin is the default in bus interconnects (chapter 38's bus uses it for its masters); fixed priority is used where one requester must never wait, such as an
          interrupt controller, with a limit on how much of the bandwidth the high-priority side may take.</p>`,
        pitfall: `<p>Fixed priority "because it is simpler". A busy core 0 would then win every conflict and core 1 would starve for as long as it lasted: the system is correct and one of its cores never runs.
          The single flip-flop is the cost of avoiding that.</p>`,
      },
    },
    {
      title: 'A race',
      body: `
        <p>Both cores add 1 to <span data-show="dm">a shared counter</span> twenty times with <code>lw</code>, <code>addi</code>, <code>sw</code>. Expect 40. Both reach the first <code>lw</code> in the same
        cycle; core 1 loses <span data-show="arb">arbitration</span> and runs one cycle behind from then on. So core 1 always loads the counter <em>before</em> core 0 has stored its increment.
        Each pair of increments produces +1, and half the updates are lost.</p>
        <p>Nothing is broken in the hardware: every access is atomic on its own. The <em>sequence</em> load–add–store is not.</p>
        <p>The result also depends on timing nobody wrote down. Add an instruction before the loop on one core and the offset between them changes, and so does the final count: a bug
        that depends on the interleaving is the hard kind to find, because the program is deterministic on this machine and wrong on the next.</p>`,
      scene: () => dualCoreScene(mc('race')),
      tour: {
        beats: [
          { title: 'Same cycle, one loses', reset: true, cycles: 2, show: ['arb', 'dm'], expect: { pc0: 8, pc1: 8, grant0: 1, retire1: 0 },
            say: '<p>Both cores reach the first <code>lw</code>, at {v:pc0}, in the same cycle. The arbiter grants core 0; core 1 does not retire (retire1 = {v:retire1}) and tries again next cycle.</p>' },
          { title: 'Core 1 loads the old value', cycles: 1, show: ['core0', 'core1', 'dm'], expect: { pc0: 12, pc1: 8, grant1: 1, retire1: 1 },
            say: '<p>Core 0 has its value and is at the <code>addi</code> (pc0 = {v:pc0}); core 1\'s <code>lw</code> is granted now (grant1 = {v:grant1}) and reads the <em>same</em> counter, before core 0 has stored.</p>' },
          { title: 'Core 0 stores first', cycles: 1, show: ['core0', 'dm'], expect: { pc0: 16, pc1: 12, grant0: 1 },
            say: '<p>Core 0\'s <code>sw</code> at {v:pc0} writes old + 1. Core 1 is one instruction behind (pc1 = {v:pc1}) and holds the same old value.</p>' },
          { title: 'Core 1 stores the same', cycles: 1, show: ['core1', 'dm'], expect: { pc0: 20, pc1: 16, grant1: 1 },
            say: '<p>Core 1\'s <code>sw</code> at {v:pc1} writes old + 1 over core 0\'s identical value. Two increments, one new value: an update was lost.</p>' },
        ],
      },
      more: {
        derive: `<p>Let c be the counter and the two cores load at t and t + 1 (the one-cycle offset the arbiter imposes). Both read c, both store c + 1; the second store overwrites the
          first with the same value. Per pair of loop passes the counter gains 1 instead of 2, so after 20 passes each the count is 20 and not 40, as the challenge shows. A read-modify-write
          is atomic only if no other store to c can fall between its load and its store.</p>`,
        real: `<p>On real hardware the same bug appears with caches and store buffers instead of a single port, and on a language's memory model it is a data race: in C and C++ undefined behaviour,
          and the reason thread sanitizers exist. The fix is the same: an atomic instruction or a lock.</p>`,
        pitfall: `<p>Believing that "every access is atomic" makes a program safe. Each <code>lw</code> and <code>sw</code> is indivisible, and the program is still wrong, because correctness needs the whole
          read-modify-write to be indivisible. Check by counting: the result is 20, which is exactly the number of passes of one core.</p>`,
      },
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
        the core gets the cache line exclusively and holds it for the duration of the operation: the same idea, with coherence doing the arbitration.</p>`,
      scene: () => dualCoreScene(mc('atomic')),
      tour: {
        beats: [
          { title: 'Both reach the atomic', reset: true, cycles: 3, show: ['arb', 'core0', 'core1'], expect: { pc0: 12, pc1: 12, grant0: 1, retire1: 0 },
            say: '<p>Both cores are at the <code>amoadd.w</code> (pc = {v:pc0}). Core 0 is granted the port; core 1 waits (retire1 = {v:retire1}).</p>' },
          { title: 'One access each', cycles: 1, show: ['arb', 'dm'], expect: { pc0: 16, pc1: 12, grant1: 1, retire1: 1 },
            say: '<p>The read, add and write of core 0 took that one grant. Now the <code>amoadd.w</code> of core 1 is granted: it reads the value core 0 left, not the old one. There is no cycle between a core read and its write for the other to slip into.</p>' },
          { title: 'Another round', cycles: 2, show: ['arb'], expect: { pc0: 12, pc1: 20, grant0: 1 },
            say: '<p>Core 0 is back at the <code>amoadd.w</code> (pc0 = {v:pc0}) for its next increment while core 1 finishes its loop body (pc1 = {v:pc1}). Each increment is one grant.</p>' },
        ],
      },
      more: {
        derive: `<p>The race needed two accesses, a read and a write, with a gap another core could use. The atomic is one access that the arbiter grants whole: its read, the add
          (a dedicated adder fed from the loaded word and rs2) and its write happen in that one grant. In a pair of cores that makes the increments totally ordered by the
          grants: 40 increments are 40 grants, and the counter is 40 whatever the interleaving.</p>`,
        real: `<p>Shipping cores offer LR/SC besides the AMOs, the other half of the A extension. <code>lr.w rd, (rs1)</code> loads a word and places a <em>reservation</em> on it (in practice on its cache line). <code>sc.w rd, rs2, (rs1)</code>
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
        easy to make atomic; a reservation needs a monitor watching every other core's stores.</p>`,
        pitfall: `<p>Using an atomic for part of a sequence. <code>amoadd.w</code> makes the add indivisible; a program that loads the counter with <code>lw</code>, tests it and then
          does an <code>amoadd.w</code> has a gap between the test and the add. A decision that depends on the old value must be made inside the atomic, or under a lock.</p>`,
      },
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
        Real locks back off, or spin on a cached copy (test-and-test-and-set) to keep the bus quiet.</p>
        <p>The lock serializes the critical section by design, so Amdahl applies to it: the time spent holding the lock is serial time. Keep it short, and keep the work that
        needs no lock outside it. The waiting core is not idle either: every spin is a memory access that takes a turn from the core doing the work.</p>`,
      scene: () => dualCoreScene(mc('lock')),
      tour: {
        beats: [
          { title: 'Both try the lock', reset: true, cycles: 4, show: ['arb', 'dm'], expect: { pc0: 16, pc1: 16, grant0: 1, retire1: 0 },
            say: '<p>Both cores reach the <code>amoswap.w</code> at {v:pc0}. Core 0 is granted and swaps 1 into the lock word: its old value is 0, the lock was free.</p>' },
          { title: 'Core 1 finds it held', cycles: 1, show: ['arb', 'core1'], expect: { pc0: 20, pc1: 16, grant1: 1, retire1: 1 },
            say: '<p>Core 1\'s swap is granted next, and returns 1: core 0 already holds the lock. Core 1 owns nothing.</p>' },
          { title: 'It spins', cycles: 2, show: ['core1'], expect: { pc0: 28, pc1: 16 },
            say: '<p>Core 1 branches back and swaps again: pc1 went 16 → 20 → 16. Meanwhile core 0 works in its critical section (pc0 = {v:pc0}).</p>' },
          { title: 'The spinner takes a turn', cycles: 2, show: ['arb', 'dm'], expect: { pc0: 36, pc1: 16, retire0: 0, grant1: 1 },
            say: '<p>Core 0 is at {v:pc0}, a memory access it needs, but the port is granted to core 1\'s swap (grant1 = {v:grant1}): core 0 does not retire (retire0 = {v:retire0}). The waiting core slows the working one.</p>' },
        ],
      },
      more: {
        derive: `<p>The swap in the loop: <code>amoswap.w t0, t1, (lock)</code> with t1 = 1 returns the old lock value in t0 and leaves 1 behind. Old value 0: the caller now owns the
          lock. Old value 1: someone else does, and the 1 written changes nothing. One atomic access decides who owns it, so there is never more than one owner. Release is a plain store of 0.
          With one waiting core, spinning adds one port access per iteration of its loop, and each is a grant the working core does not get.</p>`,
        real: `<p>Operating systems and runtimes layer on top: spin a short while, then sleep and be woken (futexes); queue the waiters so the lock passes in order (ticket and MCS locks);
          spin on a cached copy and swap only when it reads 0 (test-and-test-and-set), so waiting costs no bus traffic until the release.</p>`,
        pitfall: `<p>A lock with no ordering on a weakly ordered core. The swap that takes the lock needs acquire semantics and the store that frees it needs release (the last step), or the
          critical section's accesses can be seen outside it. This sequentially consistent machine never shows that bug, which is exactly why it hides in testing.</p>`,
      },
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
        <p>The unit of coherence is the line, not the variable. That is what makes the protocol affordable (one state per line, not per byte) and what makes false sharing possible. Every write to a
        line another cache holds costs a round trip on the interconnect; a program that scales is one whose cores mostly write lines nobody else reads.</p>
        <div class="try">Compare "Private read-then-write" under MSI and MESI. Then compare "False sharing" with "Padded".</div>`,
      widget: coherenceWidget,
      more: {
        derive: `<p>Count the transactions for a core that reads a block nobody else holds and then writes it. MSI: the read miss fetches the block into Shared (1 transaction), the write must
          broadcast an upgrade to invalidate possible sharers (2). MESI: the read fetches into Exclusive, since no one else has it, and the write moves E to M with no bus traffic (1). Private data is
          most data, so the saving is on most writes. A 64-byte line holds ${64 / 4} words: two threads' variables within the same ${64 / 4} words share a line.</p>`,
        real: `<p>Snooping works while every cache can hear every request, roughly up to a few dozen cores. Beyond that a directory records, per block, which caches hold it, and invalidations go to those
          alone. Intel and AMD cores use MESIF and MOESI variants (an Owned or Forwarding state to answer from a cache instead of memory).</p>`,
        pitfall: `<p>Two counters in adjacent words, one per thread, on the assumption that "no sharing" means no cost. Each write invalidates the other thread's copy of the line and the line travels
          back and forth on every update. The fix is layout: pad each counter to its own line, as the Padded scenario does.</p>`,
      },
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
        (or <code>fence rw,w</code>, then the store). Accesses may move into the critical section, never out of it.</p>
      <p>The model matters because the instructions that enforce order cost cycles: a fence waits until earlier accesses are visible. Software pays for ordering only where it asks for it, and the hardware is free to reorder everywhere else.</p>`,
      more: {
        derive: `<p>Store buffering enumerated. Two threads: T0 runs <code>x = 1; r0 = y</code>, T1 runs <code>y = 1; r1 = x</code>, x = y = 0 at the start. Under sequential consistency every execution is one of the
          ${SB.runs} interleavings that keep each thread's order, and the outcomes they produce are ${SB.outcomes.map((o) => `(${o})`).join(', ')}: never r0 = 0 and r1 = 0, because whichever store comes first is seen by the other
          thread's load. With a store buffer each store waits in its own core while the load behind it reads memory, and (0, 0) appears.</p>`,
        real: `<p>x86's model (TSO) allows exactly this reordering and no more: loads pass earlier stores to other addresses. RISC-V's RVWMO and ARM allow more, so more fences. C11 and C++11 atomics map
          onto these instructions: a release store and an acquire load compile to the fences or the <code>.aq</code> / <code>.rl</code> bits the target needs.</p>`,
        pitfall: `<p>Testing a lock on a sequentially consistent machine and calling it correct. This dual-core cannot reorder, so a missing acquire or release never shows here; the same code on a
          core with a store buffer can read a stale counter inside its critical section. A concurrency bug that does not reproduce is not absent.</p>`,
      },
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
