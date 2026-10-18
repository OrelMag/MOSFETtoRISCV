// Authored walkthroughs, group 3 (see walks.ts for the conventions): the optional CMOS NOR and act P (relays,
// tubes, the card loader). No DOM.

import type { WalkScript } from './walk';

export const WALKS3: Record<string, WalkScript> = {
  t_nor: [
    {
      title: 'First PMOS',
      text: 'p1 runs from VDD to an internal node with its gate on a. It conducts while a = 0, but the node does not reach y yet: every row still floats.',
      parts: ['vdd', 'p1'], codex: ['mosfet'],
    },
    {
      title: 'Second PMOS, in series',
      text: 'p2 joins the node to y, gate on b. The pull-up conducts only when a = 0 and b = 0: ¬a·¬b = ¬(a + b) by De Morgan. The a = b = 0 row is right; the other three float.',
      parts: ['p2'], codex: ['demorgan'],
      ask: {
        question: 'p1 runs from VDD to an internal node, gate on a. y must be 1 only when a = b = 0. Where does p2, gate on b, go?',
        options: ['From the node to y: in series with p1', 'From VDD to y: in parallel with p1', 'From y to GND', 'Nowhere: p1 alone is the pull-up'],
        answer: 0,
        explain: 'Two PMOS in series conduct only when both gates are 0: ¬a·¬b = ¬(a + b). The NAND had them in parallel.',
        why: ['', 'In parallel the pull-up conducts when either input is 0: that is the NAND\'s pull-up, 1 on three rows.', 'A PMOS conducts on a 0 gate and passes only a weak 0: pulling down is the NMOS network\'s job.', 'p1 alone conducts whenever a = 0, also for a = 0, b = 1, where y must be 0.'],
      },
    },
    {
      title: 'First NMOS',
      text: 'n1 runs from y to GND, gate on a: y = 0 whenever a = 1. Three rows right; a = 0, b = 1 still floats.',
      parts: ['n1', 'gnd'], codex: ['nor'],
    },
    {
      title: 'Second NMOS, in parallel',
      text: 'n2 sits beside n1, gate on b: the pull-down conducts when a = 1 or b = 1, exactly when the series pull-up is off. Four transistors, like the NAND, but the series pair is now PMOS, 2 to 3 times weaker per width: a NOR is slower or bigger, which is why libraries build on the NAND.',
      parts: ['n2'], codex: ['duality', 'cmos'],
    },
  ],
  r_nand: [
    {
      title: 'Relay a and its break contact',
      text: 'a operates ra: the pin on the coil\'s a end, GND on its b end. VDD sits on its common, and its break contact (nc) is y: while a = 0 the relay rests released and y is on the supply. With a = 1 nothing drives y.',
      parts: ['ra'], codex: ['relay'],
    },
    {
      title: 'Relay b, in parallel',
      text: 'rb does the same for b, its break contact on y beside ra\'s. Either relay released puts y on VDD: two paths to the supply in parallel are an OR, here of ¬a and ¬b, which is ¬(a·b). With both operated, both contacts open and y is driven by nothing.',
      parts: ['rb'],
    },
    {
      title: 'The load',
      text: 'ld, a pull-down, stands for the next relay\'s coil: it pulls an open line to 0. Relay logic never drives a 0; it leaves the line open and the coil it feeds does the rest. Two relays, one relay step from a or b to y: par.',
      parts: ['ld'], codex: ['openzero'],
      ask: {
        question: 'With a = b = 1 both break contacts are open. What does y read without anything more?',
        options: ['Z: nothing drives it', '0: an open contact drives a 0', '1: the supply stays on the line', 'X: the two contacts disagree'],
        answer: 0,
        explain: 'Contacts connect a line to the supply or leave it open; they never drive a 0. In a machine the next coil pulls an open line down, so the circuit ends on a load that stands for it.',
        why: ['', 'An open contact connects nothing: it cannot drive any value, 0 included.', 'Both paths to VDD are broken: nothing carries the supply to y.', 'Open contacts drive nothing, so nothing disagrees: no driver is on y at all.'],
      },
    },
  ],
  r_xor: [
    {
      title: 'Relay a: the supply on one of two lines',
      text: 'a operates ra, with VDD on its common. Its make contact (no) carries the supply while a = 1, its break contact (nc) while a = 0: exactly one of the two lines is on VDD. A changeover contact is a 2:1 multiplexer that passes either way.',
      parts: ['ra'], codex: ['relay'],
    },
    {
      title: 'Relay b picks the other line',
      text: 'rb\'s common is y. Its break contact takes ra\'s make line and its make contact ra\'s break line, crossed: y = b ? ¬a : a, which is a ⊕ b. Both coils read pins, so no relay waits on another: one relay step, for what costs 4 NANDs and 3 delays in CMOS.',
      parts: ['rb'], codex: ['mux'],
      ask: {
        question: 'ra puts VDD on its make line when a = 1 and on its break line when a = 0. rb\'s common is y. Which of ra\'s lines does rb\'s break contact (b = 0) take?',
        options: ['ra\'s make line: y = a when b = 0', 'ra\'s break line', 'VDD directly', 'GND'],
        answer: 0,
        explain: 'For b = 0, a ⊕ b = a, so the line that carries VDD when a = 1 goes to rb\'s break contact; its make contact takes the other, giving ¬a when b = 1.',
        why: ['', 'Then y = ¬a when b = 0: that is XNOR.', 'Then y = 1 whenever b = 0 and ¬a when b = 1: ¬a + ¬b, a NAND.', 'Then y = 0 for b = 0 even when a = 1. Relay logic leaves its 0s to the load rather than wiring lines to GND.'],
      },
    },
    {
      title: 'The load',
      text: 'ld pulls y to 0 when rb connects it to the line that is open. Two relays, one relay step: par.',
      parts: ['ld'], codex: ['openzero'],
    },
  ],
  r_adder: [
    {
      title: 'Bit 0 and the carry pair',
      text: 'fa0 is a relay full adder: a[0] operates a 5-pole relay and b[0] a 4-pole one. A contact cannot invert, so the carry travels on two lines, c and ¬c, exactly one of them on the supply. Carry in is 0: the c line open, ¬c on VDD. ls0 loads s[0].',
      parts: ['fa0', 'ls0'], codex: ['contactcarry', 'relay'],
    },
    {
      title: 'Chain the carry through contacts',
      text: 'fa1 takes fa0\'s carry pair on its ci and nci. The carry is not a coil: it passes through the contacts of relays that a and b already moved, so it arrives at once. ls1 loads s[1].',
      parts: ['fa1', 'ls1'],
      ask: {
        question: 'a and b change, and every relay moves one relay step later. When is s[3], four bits up the carry chain, right?',
        options: ['In that same relay step', 'One relay step later per bit: four steps', 'Two relay steps per bit, like a NAND chain\'s 2 delays a bit', 'One more step, once the carry relays have pulled in'],
        answer: 0,
        explain: 'Only operands drive coils, and they all move together. The carry flows through closed contacts, which takes no relay step: the sum is ready one step after a and b, for 4 bits or 32.',
        why: ['', 'No coil reads the carry: it flows through contacts, which conduct at once.', 'Gates make a carry wait per bit; contacts are wires once the armatures have moved.', 'There are no carry relays: the carry lines run through the contacts of the operand relays.'],
      },
    },
    {
      title: 'Bits 2 and 3',
      text: 'fa2 and fa3 continue the chain, ls2 and ls3 load their sum lines, and the merger gathers s. Each bit is two relays, so four bits are 8.',
      parts: ['fa2', 'ls2', 'fa3', 'ls3'],
    },
    {
      title: 'Carry out',
      text: 'lc loads fa3\'s c line, which is open when there is no carry: co reads 0 there. 8 relays, one relay step: par. A CMOS ripple adder pays 2 NAND delays per bit for the same carry.',
      parts: ['lc'], codex: ['openzero'],
    },
  ],
  r_latch: [
    {
      title: 'Set',
      text: 'set operates rs, VDD on its common. Its make contact puts the supply on q while set = 1. q is the coil line of the relay that will remember.',
      parts: ['rs'], codex: ['relay'],
    },
    {
      title: 'The holding relay',
      text: 'k\'s coil hangs on q, so set pulls it in one relay step later. Its own make contact joins q to a holding line: once in, k feeds its own coil and stays in after set lets go. The relay\'s SR latch, with the loop running through a contact instead of a gate.',
      parts: ['k'], codex: ['selfhold', 'feedback'],
      ask: {
        question: 'set = 1 operates rs, which puts VDD on q, k\'s coil line. set returns to 0. What can keep k pulled in?',
        options: ['k\'s own make contact, feeding q from a line on the supply', 'Nothing: q falls with set, so relays cannot store', 'rs, which stays operated by itself', 'The charge left on q'],
        answer: 0,
        explain: 'While k is in, its make contact connects its coil line to a holding line on VDD: k keeps itself in until that line is broken.',
        why: ['', 'Relays store exactly this way: the Z3 kept 1 408 bits in self-holding relays.', 'rs follows set: its coil is on the set pin, and nothing else feeds it.', 'A coil line holds no charge here: the coil itself pulls an open line to 0.'],
      },
    },
    {
      title: 'Reset breaks the hold',
      text: 'The holding line comes from VDD through rr\'s break contact. reset = 1 opens it: q is left open, k\'s coil pulls it to 0 and k drops out. Three relays: par. q needs no load, because k\'s coil is one.',
      parts: ['rr'],
    },
  ],
  r_clock: [
    {
      title: 'The buzzer',
      text: 'en sits on the common of k\'s first pole, and its break contact is k\'s own coil line, y. Released, k feeds its coil and pulls in one relay step later; pulled in, it cuts its own current and drops out the step after. y changes at every relay step: a period of two steps, 16.4 ms at 8.2 ms a step. With en = 0, k rests and its coil holds y at 0.',
      parts: ['k'], codex: ['buzzer', 'relaystep'],
    },
    {
      title: 'A relay that toggles',
      text: 't\'s first pole has VDD on its common, so its break line carries the supply while t is released and its make line while t is operated. k\'s second pole feeds t\'s coil from the break line while k is operated and from the make line while k is released: t\' = k ? ¬t : t. Every armature moves at once, so t flips at every second step.',
      parts: ['t'], codex: ['relay'],
      ask: {
        question: 'k\'s second pole feeds t\'s coil. While k is operated t must flip; while k is released t must hold. Which of t\'s lines does k\'s make contact take?',
        options: ['t\'s break line: on the supply while t is released', 't\'s make line: on the supply while t is operated', 'VDD directly', 'y'],
        answer: 0,
        explain: 'Fed from its own break line, t pulls in if it was out and drops out if it was in: a flip. Fed from its make line while k is released, it stays as it is.',
        why: ['', 'That line keeps t as it is: it is the hold, which belongs on k\'s break contact.', 'Then t is in whenever k is: q would follow y one step late, not at half its rate.', 'y is k\'s own coil line: t would copy the buzzer, a step late.'],
      },
    },
    {
      title: 'The output q',
      text: 't\'s second pole puts VDD on q while t is operated, and lq, a load, makes q read 0 otherwise. q changes at every second relay step, half y\'s rate: a counter bit. Two relays: par.',
      parts: ['lq'], codex: ['openzero'],
    },
  ],
  v_inv: [
    {
      title: 'The first divider',
      text: 'a is a plate level, far above the grid\'s range. r1 (625 kΩ) from a and r2 (375 kΩ) to −150 V shift it down: about −46 V for a 0 and −3 V for a 1, either side of the −12.5 V cutoff.',
      parts: ['r1', 'r2'], codex: ['griddivider'],
    },
    {
      title: 'The first inverter',
      text: 'v1 runs from its plate to GND (its cathode), grid on the divider; rl (22 kΩ from B+) pulls the plate up. Grid 1: v1 conducts and pulls the plate down. Grid 0: cut off, rl pulls it up. na = ¬a, and the tube wins against its resistor: ratioed logic.',
      parts: ['v1', 'rl'], codex: ['triode'],
    },
    {
      title: 'Shift again',
      text: 's1 and s2 are a second divider from na down to the next grid. A plate is never near the grid\'s range, so every grid reads its input this way, an input pin included.',
      parts: ['s1', 's2'], codex: ['griddivider'],
      ask: {
        question: 'v2\'s grid must read na, the first plate. Why not wire na straight to it?',
        options: ['A plate is far above the −12.5 V cutoff at either level: v2 would conduct whatever na says', 'The plate cannot drive the current a grid draws', 'A triode passes signals back, from its grid to its plate', 'It would short B+ to GND through v1'],
        answer: 0,
        explain: 'A plate sits at a high positive voltage whether it reads 0 or 1, while a grid is cut off only below −12.5 V. The divider to −150 V moves the two plate levels to about −46 V and −3 V, either side of cutoff.',
        why: ['', 'Drive is not the issue: a grid at a high positive voltage would conduct hard, so v2 would never cut off.', 'A triode conducts plate to cathode only; its grid only steers. The trouble is the level, not the direction.', 'A grid is not a path to anything: v1 to GND and rl to B+ stay the only paths.'],
      },
    },
    {
      title: 'The second inverter',
      text: 'v2 and its plate resistor sl invert again: y = ¬na = a. Two triode sections, which one 6SN7 bulb holds: par.',
      parts: ['v2', 'sl'], codex: ['triode'],
    },
  ],
  v_ff: [
    {
      title: 'Tube A',
      text: 'va under its plate resistor rla is an inverter whose plate is q. Its grid has no input yet.',
      parts: ['va', 'rla'], codex: ['triode'],
    },
    {
      title: 'Tube B',
      text: 'vb under rlb is the second inverter; its plate is nq.',
      parts: ['vb', 'rlb'],
    },
    {
      title: 'B reads A',
      text: 'ra1 and ra2 divide q down to vb\'s grid: while va is cut off, q is high and vb conducts.',
      parts: ['ra1', 'ra2'], codex: ['griddivider'],
    },
    {
      title: 'A reads B',
      text: 'rb1 and rb2 close the loop from nq to va\'s grid. Whichever tube conducts holds the other cut off, which keeps it conducting: two stable states, one bit, nq = ¬q in both.',
      parts: ['rb1', 'rb2'], codex: ['ecclesjordan', 'feedback'],
    },
    {
      title: 'Steering diodes',
      text: 'ds runs from set (anode) to vb\'s grid (cathode): set = 1 turns vb on, nq falls, va cuts off and q rises. dr does the same from reset to va\'s grid. Two triodes and two diodes, four tube sections: par.',
      parts: ['ds', 'dr'], codex: ['ecclesjordan'],
      ask: {
        question: 'set turns vb on (its plate is nq, so q rises). Why does it reach vb\'s grid through a diode rather than a wire?',
        options: ['A wire would hold the grid at 0 while set = 0, so q could never keep vb on', 'The diode gives the pulse the gain to flip the pair', 'The diode delays set until the pair has settled', 'A wire would short set to reset'],
        answer: 0,
        explain: 'A diode conducts from set to the grid only: a 1 pulls the grid up, a 0 lets go and leaves the grid to its divider, so the pair holds itself between pulses.',
        why: ['', 'A diode has no gain: it only conducts one way. vb, once on, does the flipping.', 'Timing is not the point: direction is. The diode decides who may pull the grid up.', 'set and reset go to different grids: a wire from each would not join them.'],
      },
    },
  ],
  h_loader: [
    {
      title: 'Count the cards',
      text: 'With next tied to 1 the reader takes a card at every edge one waits, and ready is the write enable: the card\'s word goes into the RAM word cnt addresses, and cnt (enabled by ready) moves on at the same edge. A card arrives every four edges. The 8-bit counter is 160 NANDs, 172 relays.',
      parts: ['cnt'], codex: ['loader', 'counter'],
    },
    {
      title: 'Hand the memory over',
      text: 'amux chooses the RAM\'s address: the counter while loading, the CPU\'s pc once run = 1. 32 NANDs, 37 relays (5 of them carry fan-out).',
      parts: ['amux'], codex: ['mux'],
    },
    {
      title: 'Hold the CPU by its clock',
      text: 'gate = clk AND run: the CPU sees no edge until the memory is its own. 2 NANDs.',
      parts: ['gate'], codex: ['clockgating'],
    },
    {
      title: 'run, on the falling edge',
      text: 'runff takes the reader\'s empty on the falling edge (clk through u1), so run rises while clk is low and the gated clock starts with a whole pulse. 233 relays (206 NANDs, one coil each, and 27 more for fan-out) and 182 cycles over the two decks: par.',
      parts: ['u1', 'runff'], codex: ['dff', 'edge'],
      ask: {
        question: 'run gates the CPU\'s clock (clk AND run) and switches the RAM\'s address. empty rises at the rising edge that takes the last card. How should run follow it?',
        options: ['A flip-flop on the falling edge: clk through a NOT', 'A flip-flop on the rising edge, like the reader', 'No flip-flop: run = empty', 'A flip-flop on the CPU\'s gated clock'],
        answer: 0,
        explain: 'Taken at the falling edge, run rises while clk is low: the CPU\'s first edge is the next rising edge, a whole pulse after the mux has switched to pc.',
        why: ['', 'run would rise just after a rising edge, while clk is still high: clk AND run would rise at once, half a pulse before the first word is through the mux.', 'empty rises just after a rising edge, while clk is high: the same half pulse.', 'That clock is clk AND run, which never ticks while run = 0: run could never rise.'],
      },
    },
  ],
};
