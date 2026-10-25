// Level cases, act P (before the transistor: relays, tubes, cards). See cases.ts. The alternatives are the CMOS / NAND
// circuits of the same function, which the level screen prices in relays, tube sections and relay steps through the
// technology setting (lib/tech.ts: one relay per NAND plus coils for fan-out; a NAND's depth in relay steps).

import type { LevelCase } from './cases';

export const CASESP: Record<string, LevelCase> = {
  r_pull: {
    problem: 'A relay is a coil, an iron armature and a spring. The coil\'s pull grows as the gap closes, so the chapter\'s relay needs 15.2 V of its 24 to start moving but holds until the supply falls below 3.6 V: a switch with hysteresis. Its contact first touches 6.6 ms after switch-on, bounces 3 times and rests at 8.2 ms; it opens 3.4 ms after switch-off, while the collapsing field kicks the coil to −117 V. Every relay level after this one counts time in steps of that 8.2 ms.',
    without: 'Without the step, a simulation of relay logic would have to follow every bounce, and a circuit read before its contacts rest reads noise. Relay machines paced themselves to it: the Z3 ran at 5 Hz.',
    cost: 'The coil burns 1.44 W while it is on. The Z3\'s 2 600 relays drew about 4 kW.',
  },
  r_nand: {
    problem: 'Every machine of the 1940s that was not built from tubes was built from relays: Zuse\'s Z3, Aiken\'s Harvard Mark I, the Bell Labs Model V. A relay NAND is the brick in that technology: two break contacts in parallel from the supply, so the output is on the supply unless both coils pull.',
    without: 'No inversion: make contacts alone give AND (in series) and OR (in parallel) but never NOT, and AND and OR alone are not complete.',
    cost: 'Two relays and one relay step, 8.2 ms to rest and 0.72 W on average each: a NAND that takes a hundredth of a second. Inside a relay machine a NAND costs one relay (the technology setting\'s price): its inputs arrive as contacts of the relays before it, in series on its own coil, whose break contact is the output. Here a and b are lines, so each needs a relay of its own.',
    alts: [{ name: 'CMOS NAND', lib: 'nand' }, { name: 'Tube NAND (diode AND + triode)', lib: 'tube_nand' }],
  },
  r_xor: {
    problem: 'A changeover contact is a 2:1 multiplexer that passes both ways. Built from those, XOR needs no gates: relay a puts the supply on one of two lines, relay b connects the output to the other one. The adder, the comparator and the parity checks of relay machines are made of this pattern.',
    without: 'Mapped from NANDs, XOR is four of them, three deep: four relays and three relay steps, 25 ms where contacts take 8.',
    cost: 'Two relays, one step. The saving comes from what relays have and transistors do not: a full-strength switch in both directions that also gives its complement (no and nc) for free.',
    alts: [{ name: 'XOR from four NANDs', lib: 'xor' }],
  },
  r_adder: {
    problem: 'A ripple-carry adder waits for its carry: in CMOS the 32-bit one is 68 NAND delays deep. In relays the operands operate the coils and the carry travels through their contacts, on two lines because a contact cannot invert. Nothing waits for a coil, so the sum is ready one relay step after the operands, for 4 bits or 32: the trick that made relay arithmetic usable at all (Stibitz, 1937).',
    without: 'Mapped from NANDs, the 4-bit ripple adder is 36 relays and 12 relay steps, about 0.1 s per addition; 32 bits would take 68 steps, over half a second.',
    cost: 'Two relays per bit (5 and 4 poles), one relay step for any width. A 32-bit relay adder is 64 relays where the NAND-mapped one is 288 plus fan-out coils.',
    alts: [{ name: '4-bit ripple-carry adder (NANDs)', lib: 'rca4' }, { name: 'Two-relay full adder (one bit)', lib: 'relay_fa' }],
  },
  r_latch: {
    problem: 'A machine has to remember: its registers, its memory, the state of its sequencer. A relay that feeds its own coil through its own make contact stays in after the pulse that pulled it in has gone; a break contact in that holding path lets it drop out. The Z3 held 64 words of 22 bits this way, one relay a bit.',
    without: 'Logic forgets as soon as its inputs change. Without a holding relay a relay machine could compute but not keep a result.',
    cost: 'Three relays here: set and reset each operate a relay because a pin always drives its line, while in a real machine they were contacts of other relays (the bit itself is one relay). The NAND-mapped SR latch is two NANDs, cross-coupled.',
    alts: [{ name: 'SR latch (two NANDs)', lib: 'sr_latch' }],
  },
  r_clock: {
    problem: 'A sequencer needs a beat. A coil fed through its own break contact cannot rest: pulled in, it cuts its own current; released, it closes it again. That buzzer is a clock of two relay steps. A second relay that toggles only while the first is operated divides it by two: one counter bit, from which a ring of steps or a binary counter grows.',
    without: 'With no clock of its own the machine needs an outside one: the Z3 took its clock from a rotating drum of contacts at about 5 Hz.',
    cost: 'Two relays. The NAND-mapped equivalent is an oscillator ring and a toggle flip-flop: the T flip-flop alone is 23 NANDs, hence 23 or more relays.',
    alts: [{ name: 'T flip-flop (NANDs)', lib: 'tff' }],
  },
  v_inv: {
    problem: 'A triode is a thousand times faster than a relay, about 1 µs a gate, but it only pulls its plate down and its levels do not line up: a plate swings between about 81 and 250 V while the next grid needs 0 V to conduct and −12.5 V to stop. Every gate of a tube machine reads its input through a divider to −150 V. This level is that one link, built twice.',
    without: 'A plate wired straight to the next grid holds it at 81 V or more: that tube conducts whatever the plate says, and logic stops after one gate.',
    cost: 'Two triode sections (one 6SN7), two plate resistors and two dividers, burning about 3.9 W in heaters, plates and dividers. The NAND-mapped price of a buffer is far higher: every NAND is a triode and two diodes.',
    alts: [{ name: 'Tube NOR (the tube\'s natural gate)', lib: 'tube_nor' }],
  },
  v_ff: {
    problem: 'Memory at tube speed: two triodes, each holding the other\'s grid down through a divider. Whichever conducts keeps the other cut off, which keeps it conducting (Eccles and Jordan, 1918). Every flip-flop of the tube machines was this pair, ENIAC\'s decade counters included: rings of ten of them.',
    without: 'Without a bistable pair the only tube memory was a delay line or a storage tube, both far slower to reach than a register.',
    cost: 'Two triodes (one 6SN7 bulb) and two steering diodes. The NAND-mapped SR latch is two NANDs: two triodes and four diodes.',
    alts: [{ name: 'SR latch (two NANDs)', lib: 'sr_latch' }],
  },
  h_card: {
    problem: 'A card is 80 columns of 12 rows. Hollerith\'s code puts a digit as one hole in rows 0–9 and a letter as a zone hole (12, 11 or 0) plus a digit, so a column reads as one character and a deck as lines of text: the source cards of a program. A machine reads the binary kind, an object card, as bits instead: a word in row 9, one bit a column, the most significant in column 1. Program on cards loads a deck of those, one instruction a card.',
    without: 'Every word typed in by hand on a front panel\'s switches, each time the machine is switched on.',
    cost: 'A card holds 80 characters; an object card\'s word takes as many columns as it has bits, so a 16-bit instruction is 16 columns of row 9 and the rest of the card is free for its source and a sequence number.',
  },
  h_loader: {
    problem: 'A stored-program machine starts with nothing in memory: something must copy the program in before the first fetch. Here the deck is in the reader, one 16-bit instruction a card, and the loader is the smallest machine that does it: a counter naming the next word, a write for each card the reader offers, and a switch that hands the memory\'s address lines to the CPU\'s pc once the hopper is empty. EDSAC\'s initial orders read its paper tape into memory this way (1949), the IBM 1401\'s Load key read a card and ran it, and a boot ROM copying firmware from flash (the bus chapter\'s computer) is the same step today.',
    without: 'The program runs straight off the medium, as the Z3 ran its punched film: once, in order; a loop meant gluing the film into a ring, and no instruction could be jumped to. Or every word goes in by hand on a front panel.',
    cost: '233 relays at par: 206 NANDs of logic, a coil each, and 27 more for fan-out; the 8-bit counter alone is 172 of them. 182 cycles over the two decks: the reader sets the pace (a card every four edges), so only the ends are yours: take the first card as soon as it is ready, raise run in the cycle the last one goes.',
  },
};
