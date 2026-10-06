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
  steps: [
    {
      title: 'Why more cores?',
      body: `
        <p>For thirty years each process generation made transistors smaller, faster and lower-voltage at constant power density (Dennard scaling).
        Clock rates climbed. Around 2005 the voltage stopped falling, because leakage current grows as the threshold voltage drops. Dynamic power is
        C·V²·f, so faster clocks now meant hotter chips. Frequencies have stayed near 3 to 5 GHz ever since.</p>
        <p>Moore's law kept delivering transistors, though, and the way to use them without raising the clock is <strong>more cores</strong>. Software
        then has to be parallel, and correct in parallel, which is what this chapter is about.</p>`,
      challenge: {
        kind: 'quiz', question: 'A core runs at 4 GHz and 1.0 V. Two cores at 2.8 GHz and 0.8 V do the same work in parallel. Relative dynamic power?',
        options: ['Twice as much', 'About the same', 'About 0.9×', 'About half'], answer: 2,
        explain: 'P ∝ cores × V² × f: 2 × 0.64 × 2.8 = 3.58 versus 1 × 1 × 4 = 4, so about 0.9× the power for 1.4× the throughput (if the work parallelizes). Lower voltage pays quadratically.',
      },
    },
    {
      title: 'Two cores, one memory',
      body: `
        <p>Here are two copies of the single-cycle core: the same component, instantiated twice. Open one: it has a memory <em>port</em> instead of a memory,
        a decoder for atomics, and an input carrying its hart id, which <code>csrr a0, mhartid</code> reads. Both run the same program and use the id to divide the work.</p>
        <p>The shared memory has one port, so an <strong>arbiter</strong> grants it to one core per cycle. A core that loses holds its PC and register write for a cycle and
        tries again. A multi-hart golden model applies the same arbitration and checks both cores after every cycle.</p>
        <div class="try">Run "Who am I?": each core fills and sums its own half of an array; both store 36.</div>`,
      scene: () => dualCoreScene(mc('harts')),
    },
    {
      title: 'The arbiter',
      body: `
        <p>A two-way round-robin arbiter: one request is simply granted. If both cores ask, the one holding the priority bit wins and the bit flips, so the
        loser wins next time. Fixed priority would let one busy core starve the other forever.</p>
        <div class="try">Raise both requests and pulse the clock: the grants alternate.</div>`,
      scene: () => ({ root: ARBITER2, inputs: { r0: 1, r1: 1, clk: 0 } }),
    },
    {
      title: 'A race',
      body: `
        <p>Both cores add 1 to a shared counter twenty times with <code>lw</code>, <code>addi</code>, <code>sw</code>. Expect 40. Both reach the first <code>lw</code> in the same
        cycle; core 1 loses arbitration and runs one cycle behind from then on. So core 1 always loads the counter <em>before</em> core 0 has stored its increment.
        Each pair of increments produces +1, and half the updates are lost.</p>
        <p>Nothing is broken in the hardware: every access is atomic on its own. The <em>sequence</em> load–add–store is not.</p>`,
      scene: () => dualCoreScene(mc('race')),
      challenge: {
        kind: 'reach', goal: 'Run both cores to the end and read the counter.',
        check: (st) => counter(st) === 20 && halted(),
        answer: 'Run to halt: the counter (word 0x40) ends at 20, not 40. Change the timing (another instruction before the loop on one core) and the result changes: the bug depends on the interleaving.',
        solve: runToHalt,
      },
    },
    {
      title: 'Atomic read-modify-write',
      body: `
        <p>The fix belongs in the instruction set: <code>amoadd.w rd, rs2, (rs1)</code> reads the word, adds, and writes it back in a <em>single</em> memory access.
        Nothing can come in between, because the arbiter grants the port for that one access. In the core, the atomic looks like a load to the control unit (it writes rd),
        its address is rs1 itself, and a dedicated adder computes old + rs2 for the write.</p>
        <p>In a real system with caches, the core gets the cache line exclusively and holds it for the duration of the operation; the same idea, with coherence doing the arbitration.</p>`,
      scene: () => dualCoreScene(mc('atomic')),
      challenge: {
        kind: 'reach', goal: 'Run to the end: the counter must be 40.',
        check: (st) => counter(st) === 40 && halted(),
        answer: 'Run to halt: 40, every time. 40 atomic operations, each a single arbitrated access.',
        solve: runToHalt,
      },
    },
    {
      title: 'A spin lock',
      body: `
        <p>Most critical sections are longer than one add. <code>amoswap.w</code> builds a lock: swap 1 into the lock word, and if the old value was 0 you own it.
        Otherwise spin and try again. Release by storing 0. Between acquire and release, the ordinary <code>lw</code>/<code>addi</code>/<code>sw</code> is safe.</p>
        <p>Correct, but count the cost: the run takes over four times longer than the atomic add, and the stall counters show the cores fighting for the memory port while they spin.
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
        <div class="try">Compare "Private read-then-write" under MSI and MESI. Then compare "False sharing" with "Padded".</div>`,
      widget: coherenceWidget,
      challenge: {
        kind: 'quiz', question: 'Two threads update two different variables, x and y, which happen to sit in the same 64-byte cache line. What happens?',
        options: ['Nothing: they are different variables', 'The line ping-pongs between the caches: every write invalidates the other copy (false sharing)', 'The hardware detects it and splits the line', 'The writes are lost'],
        answer: 1,
        explain: 'Coherence works on whole lines. Each write needs exclusive ownership of the line, so the two cores take turns invalidating each other, although they never touch the same byte. Padding the variables onto separate lines removes the traffic entirely.',
      },
    },
    {
      title: 'Memory ordering',
      body: `
        <p>Our dual-core is <strong>sequentially consistent</strong>: there is one memory port, so all accesses happen in one global order consistent with each program.
        Real cores reorder: a store waits in a store buffer while later loads go ahead, and that is invisible to one thread but not to another. RISC-V specifies a
        weak model (RVWMO) and gives the programmer <code>fence</code> instructions, plus <em>acquire</em> and <em>release</em> bits on atomics (the aq and rl bits this
        implementation ignores), to restore order exactly where it matters.</p>`,
      challenge: {
        kind: 'quiz', question: 'In the spin lock, why should the release (sw zero, lock) have release semantics on a real RISC-V core?',
        options: ['To make it faster', 'So that the stores of the critical section become visible to other cores before the lock appears free', 'Because sw cannot write zero', 'It does not matter'],
        answer: 1,
        explain: 'Without ordering, the lock store could become visible before the counter store, and another core could enter the critical section and read the old counter. A fence rw,w before the release store (or amoswap.w.rl) prevents that. On our sequentially consistent machine the bug cannot happen, which is exactly why such bugs hide in testing.',
      },
    },
  ],
};
