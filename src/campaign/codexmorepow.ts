// The fuller codex for the Power chapter (codexpower.ts holds the summaries; numbers pinned by tests/content-codexpower.test.ts). No DOM.

import type { CodexMore } from './codexmore';

export const MOREPOW: Record<string, CodexMore> = {
  leakstate: {
    idea: `Below its threshold a transistor's current falls by a decade for every 60 to 100 mV less gate voltage (83 mV in the Power chapter's model) but never reaches zero.
      With the supply across it, that remainder flows all the time: leakage, or static power. In a NAND only the transistors that are off <i>and</i> have the supply across them leak, so
      the leak depends on the inputs. Both at 1: the two PMOS in parallel, two off currents. One at 0: the NMOS stack holds the supply, through the one off transistor. Both at 0: two off transistors in series
      share the supply between them and leak less than one; in real devices several times less, because the upper one sees less drain voltage (DIBL) and a raised source (the body effect).
      A simulator that knows every net's value knows every gate's state, so leakage can be summed from it as well as switching.`,
    example: {
      title: 'The single-cycle CPU, averaged over 60 cycles of “sum”',
      body: `<pre>process              off current      CPU leaks
high performance     100 nA/µm        161 µW    (0.64 pJ of 46.5 pJ an instruction at 0.9 V)
low standby power    10 pA/µm         46 nW     (ITRS 2013 PIDS)</pre>The threshold of each is solved from its on/off ratio: 0.17 V and 0.52 V.`,
    },
    mistakes: [
      'Taking “static” to mean free when idle. It is the power drawn while nothing switches, for as long as the supply is on.',
      'Counting leakage per transistor regardless of state. A transistor with no voltage across it (an off PMOS beside an on one) leaks nothing.',
      'Ignoring temperature. Leakage roughly doubles every ten degrees or so; a hot chip leaks more, heats more, and can run away.',
    ],
    lib: 'nand',
    chapters: [{ chapter: 'power', step: 8, label: 'Leakage' }],
  },
  powergating: {
    idea: `Clock gating stops the switching; the leakage goes on. Power gating cuts the supply itself, through a large “sleep” transistor between the block and its rail, and
      the leakage stops too. Two costs come with it. Waking up charges every node that must be 1 again, which takes energy and time, so a short sleep costs more than it saves: there is a
      break-even idle time, the wake-up energy over the leakage power. And the state is lost: registers that must survive are kept in retention flip-flops on an always-on supply, or saved to memory first.`,
    example: {
      title: 'Break-even for the single-cycle CPU',
      body: `<pre>wake-up energy (nets that are 1 recharged)   39.6 pJ
leakage, high performance                     161 µW  → break-even 247 ns  (64 cycles)
leakage, low standby power                     46 nW  → break-even 863 µs</pre>`,
    },
    mistakes: [
      'Power-gating a block that will be needed again in a few cycles: the wake-up costs more than the leakage saved.',
      'Forgetting that the outputs of a gated block float: the blocks it drives need isolation cells holding a defined value.',
      'Switching a large block on all at once: the rush of charging current dips the supply for everything else (staggered wake-up).',
    ],
    chapters: [{ chapter: 'power', step: 9, label: 'Sleep: stop the clock or cut the power' }],
  },
  dvfs: {
    idea: `Dynamic energy per toggle is ½ C V², and the time a gate takes is C V over its current, which falls as V approaches the threshold. A chip with a deadline rather than a race
      lowers V and f together: each instruction costs less energy, and takes longer. Phones and laptops keep a table of operating points (voltage and frequency pairs), a regulator that
      moves the supply and software that picks a point for the load, many times a second. A design that is faster than it needs to be can spend the surplus as a lower supply.`,
    example: {
      title: 'Four nanoseconds an instruction, each CPU at its own supply',
      body: `<pre>CPU                      supply   energy per instruction
balanced pipeline        0.62 V   23.2 pJ
single-cycle             0.89 V   45.9 pJ</pre>Faster at 0.9 V, the pipeline meets the same time at a lower supply.`,
    },
    mistakes: [
      'Lowering the clock without lowering the voltage: the energy per instruction stays the same (only power falls), and the work just takes longer.',
      'Lowering the voltage without lowering the clock: the critical path no longer fits the period, and the results are wrong.',
      'Pushing the supply below the minimum-energy point to save more: below it each instruction costs more.',
    ],
    chapters: [{ chapter: 'power', step: 12, label: 'Which CPU for the job' }, { chapter: 'power', step: 11, label: 'Race to halt, or pace yourself' }],
  },
  minenergy: {
    idea: `Energy per instruction = ½ C<sub>switched</sub> V² + I<sub>leak</sub> · V · t<sub>instruction</sub>. The first falls with V². The second falls slowly with V but grows with the
      instruction's time, which far below threshold grows exponentially as the on current fades. The sum has a minimum, usually a little above or below the threshold. Sensors, hearing aids and
      watches run near it; nothing that must be fast does.`,
    example: {
      title: 'The single-cycle CPU, high-performance process',
      body: `<pre>supply    clock      energy per instruction
0.9 V     253 MHz    46.5 pJ
0.225 V    12 MHz     6.1 pJ   ← the minimum (2.9 dynamic + 3.3 leakage)</pre>`,
    },
    mistakes: [
      'Assuming lower voltage always saves energy: below the minimum the leakage over a much longer instruction outweighs the V² saved.',
      'Confusing the minimum-energy point with the minimum-power point: power keeps falling as the clock slows; energy per instruction does not.',
    ],
    chapters: [{ chapter: 'power', step: 10, label: 'Lower the voltage, slow the clock' }],
  },
  darksilicon: {
    idea: `Dennard scaling had transistors shrink and their voltage fall together, so a chip of the same area drew the same power each generation. Around 2005 the voltage stopped
      falling: the threshold could not drop further without leaking exponentially more. Transistors kept shrinking, so the power a die would draw with all its logic running at full speed
      outgrew what its package and battery could take. Part of every large chip has to stay idle, gated or slow at any moment. Designers spend that dark area on specialised blocks (video
      codecs, GPUs, neural engines) that each do one job at a fraction of the energy and sit dark when not needed.`,
    example: {
      title: 'Our CPU\'s logic, packed',
      body: `<pre>single-cycle CPU at 0.9 V      11.8 mW on 0.024 mm² ≈ 0.5 W/mm²
a 100 mm² die of such logic    49 W, all running
within a 15 W budget           31 % of it at once</pre>`,
    },
    mistakes: [
      'Reading dark silicon as wasted silicon. It is silicon that is not all needed at once, which is the case for accelerators.',
      'Expecting a die shrink to lower power by itself: without a lower supply, more transistors per mm² means more watts per mm².',
    ],
    chapters: [{ chapter: 'power', step: 13, label: 'Power density and dark silicon' }],
  },
  glitch: {
    idea: `Every gate has a delay, so the inputs of a gate deep in a circuit do not change at the same moment. A sum bit of a ripple-carry adder sees its own
      inputs first and the carry later; in between it can flip and flip back. That passing change is a <b>glitch</b>: the settled value is right, but the wire was charged and
      discharged for nothing, and the supply paid ½ C V² for each change like any other. The deeper the logic, the more waves of changes arrive at different times, so glitches grow
      with logic depth; a register ends them, because it passes on only the settled value at its edge.`,
    example: {
      title: 'Measured on the benchmarks (the Power chapter)',
      body: `<pre>CPU               glitch share of the energy
single-cycle      48 %
pipelined         10 %</pre>The same instructions, the same kind of logic: the pipeline's registers cut every path into stages, and each wave stops at the end of its stage.`,
    },
    mistakes: [
      'Counting energy from the settled values cycle by cycle. That misses every glitch, which on a deep circuit is a large share.',
      'Thinking a glitch is harmless because the output settles. It costs energy every time, and on a clock or an asynchronous reset it is a false edge.',
    ],
    lib: 'rca4',
    chapters: [{ chapter: 'adders', step: 4, label: 'Watch the carry ripple' }, { chapter: 'power', step: 3, label: 'Glitches: toggles that change nothing' }],
  },
};
