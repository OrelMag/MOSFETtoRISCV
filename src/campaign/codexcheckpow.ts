// Check yourself for the Power chapter's codex entries: two questions an entry, the right option first (the page shuffles), each wrong one saying why.

import type { Quiz } from '../chapters/types';

export const CHECKPOW: Record<string, Quiz[]> = {
  leakstate: [
    {
      question: 'Which input state of a NAND leaks least?',
      options: ['Both inputs 0: two off NMOS in series share the supply', 'Both inputs 1: every NMOS is on', 'One input 0, one 1', 'All states leak the same'],
      answer: 0,
      explain: 'With both at 0 the two off NMOS are in series, so each has less than the full supply across it; with both at 1 the two parallel PMOS each have all of it.',
      why: ['', 'With both at 1 the output is 0 and the two PMOS are off side by side, each with the supply across it: the most leakage.', 'One NMOS off holds the whole supply: more than two in series.', 'Which transistors are off, and with what across them, depends on the inputs.'],
    },
    {
      question: 'An off PMOS sits in parallel with an on PMOS. How much does it leak?',
      options: ['Nothing: the on transistor leaves no voltage across it', 'One off current', 'Half an off current', 'Twice an off current'],
      answer: 0,
      explain: 'Leakage needs a voltage across the off transistor. The on PMOS beside it ties both its ends to the supply.',
      why: ['', 'An off current flows only with the supply across the transistor.', 'Halving comes from two off transistors in series, not from a parallel on one.', 'It is shorted by its neighbour: no voltage, no current.'],
    },
  ],
  powergating: [
    {
      question: 'Why does power gating not pay for a sleep of a few clock cycles?',
      options: ['Waking up charges every node that must be 1 again, which costs more than the leakage a short sleep saves', 'The sleep transistor takes many cycles to switch', 'Power gating does not stop the leakage', 'A gated block keeps switching'],
      answer: 0,
      explain: 'The break-even time is the wake-up energy over the leakage power; shorter sleeps lose energy.',
      why: ['', 'The switch is quick; the cost is energy, the charge put back into the block.', 'Cutting the supply is exactly what stops it.', 'With its supply cut nothing in it switches.'],
    },
    {
      question: 'A register must survive a power-gated sleep. What keeps it?',
      options: ['A retention flip-flop on a supply that stays on, or a copy saved to memory first', 'Its own charge, as long as the sleep is short', 'Clock gating it as well', 'Nothing: power gating keeps state'],
      answer: 0,
      explain: 'Without a supply every node drains; whatever must survive needs a supply of its own or a copy elsewhere.',
      why: ['', 'A flip-flop is a loop of gates, and with no supply the loop no longer holds its value.', 'A stopped clock keeps state only while the supply is on.', 'Cutting the supply loses the state; that is the price of power gating.'],
    },
  ],
  dvfs: [
    {
      question: 'A chip halves its clock but keeps its supply. What happens to the energy per instruction?',
      options: ['About the same: each toggle still costs ½ C V², the work only takes longer', 'It halves', 'It quarters', 'It doubles'],
      answer: 0,
      explain: 'Power halves because the toggles come half as often; the energy of each is set by C and V. Only lowering V lowers it, and a slower clock is what lets V fall.',
      why: ['', 'That is the power, energy per second, not the energy per instruction.', 'A quarter needs half the supply voltage.', 'Nothing about a slower clock costs more per toggle; leakage over the longer time adds a little.'],
    },
    {
      question: 'Why can a fast design spend less energy than a slow one at the same speed?',
      options: ['It can run at a lower supply and still meet the time, and energy goes with V²', 'Fast designs have fewer gates', 'Fast designs never glitch', 'A faster clock costs less per toggle'],
      answer: 0,
      explain: 'Asked for the same time per instruction, the faster design reaches it at a lower voltage.',
      why: ['', 'Fast designs usually have more gates: wider adders, pipeline registers.', 'They glitch too; a pipeline glitches less only because its stages are shorter.', 'The energy per toggle depends on C and V, not on the clock.'],
    },
  ],
  minenergy: [
    {
      question: 'Below the minimum-energy point, what makes an instruction cost more?',
      options: ['Its time grows exponentially, and leakage flows for all of it', 'The dynamic energy rises again', 'Glitches multiply', 'The capacitance grows'],
      answer: 0,
      explain: 'Dynamic energy keeps falling with V²; leakage power times the instruction\'s time is what grows.',
      why: ['', 'The dynamic part only falls as V falls.', 'The circuit and its glitches are unchanged.', 'C belongs to the gates and wires, not to the supply.'],
    },
    {
      question: 'A process leaks much less. Where does its minimum-energy point go, compared with a leaky process with the same capacitance?',
      options: ['To a lower energy, because less leakage is paid while each instruction runs', 'To a higher energy', 'It disappears', 'To exactly the same point'],
      answer: 0,
      explain: 'Less leakage per second makes long, slow instructions cheaper, so the sum can fall lower before the leakage term catches up.',
      why: ['', 'Less leakage cannot make the cheapest point dearer.', 'Some leakage remains, and below threshold the clock still falls exponentially: there is still a minimum.', 'The leakage term is part of the sum, so the minimum moves with it.'],
    },
  ],
  darksilicon: [
    {
      question: 'Why did dark silicon appear only after about 2005?',
      options: ['The supply stopped falling with each process, so power per mm² rose as transistors shrank', 'Chips got larger', 'Clock gating was invented', 'Transistors stopped shrinking'],
      answer: 0,
      explain: 'While voltage scaled down with size (Dennard scaling), power per area stayed flat; when it stopped, density gains turned into watts per mm².',
      why: ['', 'Larger dies draw more in total but not more per mm².', 'Clock gating is a cure, not a cause.', 'They kept shrinking; that is why the power density rose.'],
    },
    {
      question: 'How do designers use silicon that cannot all run at once?',
      options: ['Specialised blocks that each do one job efficiently and sit dark when not needed', 'They leave it empty', 'They run every block at the highest clock', 'They raise the supply'],
      answer: 0,
      explain: 'Accelerators trade area, which is cheap, for energy per operation, which is what the budget limits.',
      why: ['', 'Empty silicon would waste the area; dark blocks are used, only not all together.', 'That is exactly what the power budget forbids.', 'A higher supply makes every toggle dearer.'],
    },
  ],
};
