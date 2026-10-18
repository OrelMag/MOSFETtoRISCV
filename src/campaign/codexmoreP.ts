// The fuller codex, act P (before the transistor: relays, tubes, cards). See codexmore.ts. The numbers are the
// physical models' (phys/relay.ts, phys/triode.ts) and the card code's (cards/hollerith.ts).

import type { CodexMore } from './codexmore';

export const MOREP: Record<string, CodexMore> = {
  relay: {
    idea: 'An electromagnet and a spring: current through the coil pulls an iron armature in, and the armature moves the contact springs, each pole\'s common (c) leaving its break contact (nc) for its make contact (no). Released, the spring puts them back. A relay with four changeover poles switches four independent circuits at once, and each closed contact is metal on metal: it passes a signal in either direction at full strength, as a transmission gate does in CMOS and no tube ever can.<br>In the simulator the coil is a weak resistor between its ends a and b (it pulls an undriven line to 0), current flows when its ends differ, and the armature follows at the next <b>relay step</b>: every relay of a circuit moves at once, then the current through the contacts settles at once. A step is the model\'s 8.2 ms to rest. A gate whose inputs come through contacts is therefore one step deep however many contacts the current crosses.',
    example: { title: 'NOT and NAND from break contacts', body: '<pre>NOT:  VDD ─ c┤nc├─ y       y = 1 while the coil is released\nNAND: VDD ─ ra.c┤nc├─┬─ y  either relay released connects y\n      VDD ─ rb.c┤nc├─┘\n      y ── load (the next coil) ── GND</pre>' },
    mistakes: ['Leaving the output unloaded: an open line reads Z here, not 0. In a real machine it always feeds the next coil.', 'Putting the input on the contact instead of the coil: the contact then passes the input along unchanged, it does not switch on it.', 'Counting poles: a relay type has a fixed number of contact springs (here 1 to 6). Running out means a second coil in parallel, which the technology setting counts as an extra relay per four contacts.'],
    lib: 'relay_nand',
    chapters: [{ chapter: 'relays', label: 'Relays' }, { chapter: 'relays', step: 2, label: 'Contacts conduct both ways' }],
  },
  relaystep: {
    idea: 'The armature is a mass on a preloaded spring and the magnet\'s pull goes as (N·I)² / gap², so the pull grows steeply as the gap closes. A relay that has started to close finishes closing, and one that is closed holds at a fraction of the current that closed it: on a 24 V supply this one pulls in above 15.2 V and drops out only below 3.6 V. That hysteresis makes every relay a Schmitt trigger and makes relay logic immune to the slow, noisy edges of long wires.<br>Time is mechanical. The coil current builds with L / R, and L rises as the gap closes, so the current dips while the armature moves (relay testers detect pull-in by that dip). First touch comes after 6.6 ms; the blade then bounces three times and rests at 8.2 ms. Release takes 3.4 ms. At turn-off the coil\'s stored energy has to go somewhere: through a 4 kΩ quench resistor it makes −115 V, without one it arcs across the contact that opened it.',
    example: { title: 'Why bounce matters', body: 'A counter clocked straight from a bouncing contact counts each bounce: three extra counts per closing. Relay machines waited a fixed time after every operation (the Z3\'s clock drum gave each step a fixed slot), which is what the simulator\'s relay step stands for: the next step reads the contacts only after they have come to rest.' },
    mistakes: ['Taking first touch as the switching time: the contact is not reliably closed until the bounces end.', 'Assuming a relay opens at the voltage that closed it: it holds down to 3.6 V.', 'Switching an inductive load without a quench: the spike erodes the contact and radiates noise into every wire nearby.'],
    chapters: [{ chapter: 'relays', label: 'Relays' }],
  },
  openzero: {
    idea: 'Relay logic never drives a line low. A line is either connected to the supply through a path of closed contacts or not connected to anything, and an unconnected line feeds the next coil, whose resistance pulls it to 0. So "open" means 0, and contact networks can be wired together freely: two paths to the supply in parallel are an OR, two contacts in series an AND, and no combination ever shorts the supply to ground.<br>The cost of that freedom is that the load is part of the logic. Tested on its own, a gate\'s output has no next coil on it and reads Z; in the campaign\'s levels every output therefore ends on a pull-down standing for that coil.',
    example: { title: 'OR and AND with no gates', body: '<pre>OR:  VDD ─ a.c┤no├─┬─ y      AND: VDD ─ a.c┤no├─ b.c┤no├─ y\n     VDD ─ b.c┤no├─┘           y ── load ── GND\n     y ── load ── GND</pre>' },
    mistakes: ['Driving a line to GND through a contact to make a 0: it fights any other path that connects it to the supply, a short through two contacts.', 'Expecting an unloaded output to read 0.'],
    lib: 'relay_not',
    chapters: [{ chapter: 'relays', step: 2, label: 'Contacts conduct both ways' }],
  },
  contactcarry: {
    idea: 'A contact can pass a line or not pass it, but it cannot invert it. So the carry travels on <b>two lines</b>, c and ¬c, exactly one of them on the supply, and the operand relays only steer them: if a = b the carry out is a constant (both 1: the supply on c out; both 0: the supply on ¬c out), otherwise the carry in passes straight through to the carry out, on both lines. The sum is chosen the same way: b picks between c and ¬c, then a picks between that and its complement.<br>The operands operate the coils, all at the same relay step, and the carry crosses every bit\'s contacts within that step: no coil waits on another, so n bits add in one relay step. Relay A needs five poles (four for the carry pair, one for the sum), relay B four.',
    example: { title: 'One bit, as equations over lines', body: '<pre>co  = b ? (a ? VDD : ci)  : (a ? ci  : open)\nnco = b ? (a ? open : nci) : (a ? nci : VDD)\ns   = a ? (b ? ci : nci)   : (b ? nci : ci)</pre>A 32-bit adder is 64 relays and one step (8.2 ms); mapped from NANDs it would be 288 relays plus fan-out coils and 68 steps.' },
    mistakes: ['Carrying a single carry line and inverting it with a relay per bit: every bit then waits a step for the one below, and the adder ripples like CMOS.', 'Leaving carry in floating: c in open and ¬c in on VDD means 0.'],
    lib: 'relay_fa',
    chapters: [{ chapter: 'relays', step: 4, label: 'A carry that needs no time' }],
  },
  selfhold: {
    idea: 'A relay\'s own make contact can feed its own coil. Once something pulls it in, that contact keeps the coil fed after the something has gone: the relay holds itself. Put a break contact in the holding path and opening it lets the relay drop out. That is an SR latch whose feedback runs through a contact instead of a gate, and it was the memory of the relay machines: the Z3 held 64 words of 22 bits in 1 408 relays.<br>Here set and reset are pins, and a pin always drives its line, so each operates a relay of its own: set\'s make contact puts the supply on the holding relay\'s coil line, reset\'s break contact feeds the holding path. In a machine they would be contacts of other relays, and the bit itself costs one.',
    example: { title: 'The holding path', body: '<pre>VDD ─ rs.c┤no├────────────┬─ q (k\'s coil)\nVDD ─ rr.c┤nc├─ k.c┤no├──┘\nset:   rs closes, q = 1, k pulls in, k.no holds q after set lets go\nreset: rr opens the holding path, k drops out one step later</pre>' },
    mistakes: ['Feeding the holding contact straight from VDD: nothing can reset it.', 'Driving q from the set pin itself: while set is 0 the pin holds q at 0 against the holding contact.'],
    lib: 'relay_latch',
    chapters: [{ chapter: 'relays', step: 5, label: 'Memory that holds itself' }],
  },
  buzzer: {
    idea: 'Feed a coil through its own break contact and it cannot rest: pulled in, it opens its own supply; released, it closes it again. In the simulator\'s steps it alternates every relay step, a square wave of two steps (about 16 ms): the doorbell\'s buzzer and the simplest clock.<br>A second relay that changes only while the buzzer is operated halves that rate. Its coil reads one of two lines from its own changeover contact: the line that carries the supply only while it is released (so it pulls in) or the one that carries it only while it is operated (so it stays). The buzzer\'s second pole picks the first line while the buzzer is in and the second while it is out, so the divider toggles once per buzzer period: t′ = k ? ¬t : t. Every armature moves at once, so the toggle reads the old t, which is why it does not race.',
    example: { title: 'The two waveforms, step by step', body: '<pre>step  0 1 2 3 4 5 6 7 8\ny     1 0 1 0 1 0 1 0 1\nq     0 0 1 1 0 0 1 1 0</pre>' },
    mistakes: ['Feeding the divider\'s coil from a make contact of the buzzer alone: it follows the buzzer instead of halving it.', 'Expecting the circuit to settle: an oscillator never does. Check steps it a fixed number of relay steps instead.'],
    lib: 'relay_clock',
    chapters: [{ chapter: 'relays', step: 6, label: 'A relay that cannot stop' }],
  },
  triode: {
    idea: 'A heated cathode boils electrons off its surface (Richardson emission, which is why a tube takes seconds to warm up), the positive plate collects them, and a wire mesh between the two, the grid, decides how many arrive: I ≈ K·(V<sub>g</sub> + V<sub>p</sub>/μ)<sup>1.5</sup>, with μ = 20 for a 6SN7. Electrons only leave the hot cathode, so current flows plate to cathode and never back: a triode can pull its plate down but cannot pass a signal the way a contact or a MOSFET channel does.<br>So tube logic is ratioed: a plate resistor (22 kΩ from 250 V) pulls the plate up, the tube pulls it down harder when its grid lets it. Two tubes on one plate resistor make a NOR, the tube\'s natural gate; a NAND needs a diode AND in front of an inverter. A gate switches in about 1 µs (22 kΩ charging some 45 pF), ten thousand times faster than a relay, and each section burns 1.89 W in its heater whether it switches or not.',
    example: { title: 'Two levels of one plate', body: '<pre>grid  −3 V  (conducting)  plate ≈ 81 V  → logic 0\ngrid −46 V  (cut off)     plate = 250 V → logic 1\ncutoff with 250 V on the plate: −250 / 20 = −12.5 V</pre>' },
    mistakes: ['Expecting a triode to pass a 1 through: it only conducts toward its cathode.', 'Reading a plate with the next grid directly: see "Levels that do not line up".'],
    lib: 'triode_switch',
    chapters: [{ chapter: 'tubes', label: 'Vacuum tubes' }, { chapter: 'tubes', step: 1, label: 'The grid' }],
  },
  griddivider: {
    idea: 'A tube gate\'s output and input live at different voltages. Its plate sits at about 81 V when the tube conducts and 250 V when it is cut off; the next grid conducts near 0 V and is cut off below −12.5 V. Both plate levels are far above cutoff, so a plate wired straight to the next grid turns that tube on whatever it says. The fix is a resistor divider from the plate to a negative supply: 625 kΩ from the plate, 375 kΩ to −150 V puts the grid at (V<sub>p</sub>·375 − 150·625) / 1000, which is −46 V for a low plate (well below cutoff) and −3 V for a high one (conducting).<br>The divider draws current from the plate, so each one it drives lowers the high level: one plate can feed only two or three dividers before its high level stops turning the next tube on. Wider fan-out goes through a cathode follower, a tube whose cathode follows its grid and drives many loads. ENIAC\'s 17 468 tubes were joined by some 70 000 resistors, most of them in dividers like these.',
    example: { title: 'Levels with one divider on the plate', body: '<pre>high plate 250 V − loading ≈ 239 V → grid ≈ −3 V   (above cutoff: on)\nlow  plate ≈ 81 V                  → grid ≈ −46 V  (33 V below cutoff: off)</pre>' },
    mistakes: ['Using an ordinary resistor of the plate resistor\'s strength as the divider\'s top: in the simulator that also carries the losing pull-up\'s 1 and the grid reads X. The divider resistor is stronger than the plate resistor and weaker than the tube.', 'Forgetting that the input pin is a plate level too: it needs a divider like any other.'],
    lib: 'tube_inv',
    chapters: [{ chapter: 'tubes', step: 2, label: 'Levels that do not line up' }],
  },
  ecclesjordan: {
    idea: 'Two triodes, each grid reading the other\'s plate through a divider (Eccles and Jordan, 1918). If the left tube conducts, its plate is low, which cuts the right one off, whose high plate keeps the left one conducting: a stable state, and its mirror is the other one. One twin triode bulb holds one bit, and the bit stays as long as the heaters are on.<br>To set it, raise the grid of the tube that must conduct. A wire from the set pin would also hold that grid at 0 while set is 0, and the pair could never hold the other state, so the pins reach the grids through steering diodes: anode on the pin, cathode on the grid. A 1 pulls the grid up; a 0 cannot pull it down, so between pulses the cross-coupling alone decides. ENIAC\'s accumulators counted in rings of ten such pairs per digit.',
    example: { title: 'Set, then hold', body: '<pre>set = 1: D2 lifts V2\'s grid, V2 conducts, nq falls to 81 V,\n         V1\'s grid drops to −46 V, V1 cuts off, q rises to 250 V\nset = 0: D2 lets go; V1 (off) keeps V2\'s grid at −3 V: it holds</pre>' },
    mistakes: ['Wiring set straight to a grid: the pin then pins that grid at 0 too.', 'Steering set to the tube whose plate is q: a 1 on that grid makes q low, the opposite of set.'],
    lib: 'eccles_jordan',
    chapters: [{ chapter: 'tubes', step: 5, label: 'One bit in one bulb' }],
  },
  hollerith: {
    idea: 'Herman Hollerith\'s cards tallied the 1890 US census: one card per person, a hole for each answer, counted by brushes closing circuits through the holes. IBM\'s 80-column card (1928) holds one character per column as holes in up to three of its twelve rows: the zone rows 12, 11 and 0 at the top, then the digit rows 1–9. A digit is one hole. A letter is a zone and a digit: A–I are 12-1 … 12-9, J–R are 11-1 … 11-9, S–Z are 0-2 … 0-9. Signs add an 8: "." is 12-3-8, "$" is 11-3-8.<br>Binary machines did not need characters: they punched words. On an object card here the word is in row 9, one bit a column, column 1 the least significant, so a 16-bit word takes columns 1–16 of one card and a program is a deck of them.',
    example: { title: 'Three columns', body: '<pre>H  = 12-8\nE  = 12-5\n7  = 7\n.  = 12-3-8</pre>' },
    mistakes: ['Reading row 0 as a digit when it carries a zone: 0-2 is S, not "0 and 2".', 'Counting rows from the top as 0–11: the printed rows are 12, 11, 0, 1, …, 9.'],
    chapters: [{ chapter: 'cards', step: 2, label: 'Eighty columns' }, { chapter: 'cards', step: 3, label: 'A program on cards' }],
  },
  loader: {
    idea: 'A stored-program computer starts with nothing in its memory. Before ROM chips, something had to put the first program there: switches on the front panel, a punched tape, a deck of cards. The <b>loader</b> is the small fixed machine that does it: a counter that addresses memory, a write for each word the reader offers, a signal that takes the card so the next one comes, and a switch that hands memory to the processor once the hopper is empty.<br>Done in hardware it is a few counters and gates; done in software it is a boot loader, a handful of instructions in ROM that read the rest. The Z3 read its program off punched 35 mm film as it ran, the IBM 701 loaded one card into memory and ran it, and that card loaded the rest.',
    mistakes: ['Writing every clock edge instead of only when a card waits: the reader has a feed delay, and the gaps would be written too.', 'Letting the processor run while memory is still filling: it executes whatever is there.'],
    chapters: [{ chapter: 'cards', step: 4, label: 'A machine that reads them' }],
  },
};
