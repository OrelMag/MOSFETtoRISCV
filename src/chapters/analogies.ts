// Analogies (DOM-free): a familiar picture for an abstract idea, shown folded under the step it belongs to and in the
// codex entries it explains. Every one says where it stops being true (`breaks`), because the reader is an engineer and
// a picture that misleads costs more than it saves. Steps are named by title (tests/analogies.test.ts checks each one
// exists), so reordering a chapter cannot move an analogy onto the wrong step.

export interface Analogy {
  /** Chapter id and the step's title. */
  chapter: string;
  step: string;
  /** The picture, in a few words: "Water in a closed loop of pipes". */
  title: string;
  /** HTML: one or two paragraphs. */
  body: string;
  /** What stands for what, read as a two-column list. */
  map?: [string, string][];
  /** HTML: where the picture stops being true (a sentence or two, no heading). */
  breaks: string;
  /** A figure drawn in the aside (ui/analogyfigs.ts FIGURES key), loaded when the aside opens. */
  figure?: string;
  /** Codex entries that show it too. */
  codex?: string[];
}

export const ANALOGIES: Analogy[] = [
  {
    chapter: 'basics', step: 'A loop of wire', title: 'Water in a closed loop of pipes',
    body: `<p>A pump lifts water into a tank; it runs down a pipe, turns a water wheel and comes back to the pump. Shut a valve
      anywhere and the wheel stops, because the whole loop stops at once.</p>`,
    map: [['Voltage', 'how high the tank sits above the return pipe (pressure)'], ['Current', 'how much water passes a point each second'],
      ['Resistance', 'a narrow stretch of pipe; the lamp is the water wheel in it'], ['Battery', 'the pump that keeps lifting the water back up'],
      ['Switch', 'a valve, anywhere on the loop'], ['Ground', 'the return pipe: the level every height is measured from']],
    breaks: `The water carries the energy to the wheel; the electrons do not carry it to the lamp. They drift at well under a
      millimetre a second, while the energy travels in the field around the wire at close to the speed of light. And a pipe can
      be half empty; a wire cannot run short of charge.`,
  },
  {
    chapter: 'mosfet', step: 'Three regions', title: 'A faucet whose handle is a voltage',
    body: `<p>The gate turns the handle. Below the threshold (0.45 V here) the faucet is shut however hard the tank behind it
      pushes. Past it, the flow grows with the pressure difference across the faucet, until the outlet <em>chokes</em>: from
      then on a lower basin adds almost nothing, because the opening sets the flow, not the drop across it. That is
      saturation.</p>`,
    map: [['Gate voltage', 'how far the handle is turned'], ['Drain, source', 'the tank upstream and the basin downstream'],
      ['V<sub>DS</sub>', 'the difference in level between them'], ['Drain current', 'the flow through the faucet']],
    breaks: `A handle takes force to hold open; a gate draws no steady current at all. It is a capacitor, so only changing the
      gate voltage costs charge. And no faucet opens as its handle is pushed <em>down</em>, which is what a PMOS does.`,
    codex: ['mosfet'],
  },
  {
    chapter: 'mosfet', step: 'What one switch costs', title: 'Buckets filled through one hose', figure: 'buckets',
    body: `<p>An output is a hose: the transistor's channel is its resistance. Every input it feeds is a bucket at the far end
      (a gate's capacitance), and the wire adds a small one of its own. The next gate switches when the buckets are half full,
      so twice the buckets take about twice as long.</p>
      <p>Energy works the same way. Filling the buckets to V takes C·V from the supply at a pressure of V: C·V² in all. Half
      ends up in the buckets, half is lost as heat in the hose; on the way back down the stored half is lost too. So every
      0 → 1 → 0 swing costs C·V², however wide the hose is: a wider transistor fills faster, it does not fill cheaper.</p>`,
    breaks: `A bucket's level rises in proportion to the water in it; a gate's capacitance changes with the voltage across it.
      The picture gets ratios right (twice the load, about twice the delay and twice the energy), not picoseconds.`,
    codex: ['fanin'],
  },
  {
    chapter: 'inverter', step: 'Pull up, pull down', title: 'Two faucets on one column',
    body: `<p>The output is the water level in a glass column. A faucet above it fills it from a full tank (the PMOS, open when
      the input is 0); a faucet below empties it into a drain (the NMOS, open when the input is 1). One handle works both, in
      opposite directions, so once the input settles water only moves while the column changes level. Hold the handle halfway
      and both are partly open: water runs straight from the tank to the drain, the current a real inverter draws while its
      input passes through the middle.</p>`,
    breaks: `A good faucet seals when it is shut; an off transistor always leaks. That leak grows about ten times for every
      60–100 mV taken off the threshold, which is why chips stopped lowering their supply voltage.`,
    codex: ['cmos', 'inverter'],
  },
  {
    chapter: 'inverter', step: 'The wrong way round: weak levels', title: 'A faucet that shuts itself',
    body: `<p>Put the NMOS above the column and let it fill it. Its handle is held by the difference between its gate and the
      water level in the column, so as the column rises the faucet closes itself, and it is shut before the column is full: it
      stops a threshold short of its gate, 0.80 V of 1.1 V here. A PMOS draining the column stops the same distance above
      ground.</p>`,
    breaks: `In silicon it is worse than the picture: as the source rises, the body effect raises the threshold too, so a real
      passed 1 sits lower still.`,
  },
  {
    chapter: 'latches', step: 'Two NANDs holding hands', title: 'Two people who always disagree',
    body: `<p>Each of two people says the opposite of what the other is saying. If A says "yes", B says "no", which keeps A on
      "yes": the pair holds that answer for as long as you leave them alone. Set and reset are a shout in one ear that makes
      that person change their answer; the other follows, and the new answer then holds by itself.</p>`,
    breaks: `People get tired. The latch holds for as long as it has power and draws almost nothing while it does: the
      holding is free, only changing costs energy.`,
    codex: ['latch', 'feedback'],
  },
  {
    chapter: 'latches', step: 'The forbidden input, and races', title: 'A ball balanced on a hilltop',
    body: `<p>The two settled states are the two valleys either side of a hill. Release both inputs at the same instant and the
      latch is a ball pushed up exactly to the top: it stays there for a while and then rolls into one valley or the other,
      and nothing about the push says which.</p>`,
    breaks: `A real ball needs an impossibly even push to stop on top. A latch only needs its release to land inside a window a
      few picoseconds wide, which happens every day where a signal from one clock is sampled by another. How long it stays has
      no upper bound, only odds that fall by a fixed factor every gate delay.`,
  },
  {
    chapter: 'latches', step: 'The flip-flop: act only on the edge', title: 'An airlock', figure: 'airlock',
    body: `<p>The master and slave latches are the two doors of an airlock. While the clock is low the outer door is open and
      D walks into the chamber; the inner door is shut, so Q keeps its old value. When the clock rises the outer door shuts
      first, then the inner one opens and Q takes what is in the chamber. The two doors are never open together, so D can never
      run straight through to Q: Q changes once a cycle, at the edge.</p>`,
    breaks: `A person leaves the chamber; a value is copied, and the master keeps it. And a value that arrives just as the
      outer door shuts can stick halfway for a while (the setup and hold window); people do not.`,
    codex: ['dff', 'edge'],
  },
  {
    chapter: 'registers', step: 'A register is a row of flip-flops', title: 'An orchestra on one beat',
    body: `<p>The clock is the conductor's beat. Every flip-flop in the machine takes its new value on the same beat; between
      beats the logic works out the next values, and they must all be ready before the next beat falls. The tempo is therefore
      set by the slowest player: the longest path from one flip-flop to the next.</p>`,
    breaks: `A beat costs a conductor nothing. The clock is a wire like any other: it takes time to reach the far corners of the
      chip (skew), and charging it on every edge is often the largest single use of power on the chip.`,
    codex: ['register'],
  },
  {
    chapter: 'gates', step: 'The multiplexer: a digital switch', title: 'Railway points',
    body: `<p>The select input sets the points; of the tracks coming in, one continues to the output. Change the points and a
      different track goes through.</p>`,
    breaks: `Points move a train; nothing moves through a multiplexer. Every input is computed all the time and the gates pass
      one: an unselected input can change and nothing happens at the output, but its gates still switch and still cost power.`,
    codex: ['mux'],
  },
  {
    chapter: 'memory', step: 'Four words, one address', title: 'A hotel switchboard',
    body: `<p>The address is a room number; the decoder rings exactly one room, and only that room's word can be read or
      written. Every other line stays quiet.</p>`,
    breaks: `A switchboard connects calls when they come; a decoder answers every address on every cycle, and it doubles in size
      with each address bit.`,
    codex: ['decoder'],
  },
  {
    chapter: 'appendix-sap', step: 'What a bus really is', title: 'One microphone, many speakers',
    body: `<p>Everyone on the bus shares one microphone. The control lines hand it to one speaker at a time; everybody may
      listen, and whoever is told to takes down what is said.</p>`,
    breaks: `Two people at one microphone make noise you can still pick apart. Two outputs driving one wire to different values
      are a short from the supply to ground: the wire reads as neither, and current flows that should not.`,
    codex: ['bus'],
  },
  {
    chapter: 'pipeline', step: 'Overlap the work', title: 'Laundry: wash, dry, fold', figure: 'laundry',
    body: `<p>Doing one load at a time, a load takes three slots and the next waits for it to be folded. Overlapped, the washer
      starts the second load while the first is in the dryer: each load still takes three slots, but once the line is full one
      load comes out every slot.</p>`,
    breaks: `In a laundromat each machine runs at its own pace. A pipeline moves every stage on the same clock, so the slowest
      stage sets the beat for all of them, and each pipeline register adds its own delay to every stage.`,
    codex: ['pipeline', 'throughput'],
  },
  {
    chapter: 'pipeline', step: 'Data hazards and forwarding', title: 'Handing the dish across',
    body: `<p>One cook finishes a sauce that the next cook needs. Putting it on the shelf (writing the register file) and letting
      the next cook fetch it from there takes too long; handing the pan straight across (forwarding) costs nothing extra in
      time.</p>`,
    breaks: `Handing across is not free in hardware: every result that can be forwarded needs a wire and a multiplexer input in
      front of the ALU, and those sit on the path that sets the clock.`,
    codex: ['forwarding', 'hazards'],
  },
  {
    chapter: 'pipeline', step: 'The load-use stall', title: 'An empty plate down the line',
    body: `<p>The sauce is still in the oven when the next cook needs it: a load's data arrives a stage later than an ALU
      result. The next cook waits one beat, and an empty plate (a bubble) travels down the line in that slot.</p>`,
    breaks: `A real cook would start another dish meanwhile. An in-order pipeline cannot reorder its work, so it sends the empty
      plate; the chapter "Out of order" builds the kitchen that does.`,
    codex: ['loaduse', 'stall'],
  },
  {
    chapter: 'pipeline', step: 'Control hazards', title: 'Guessing at a fork in the road',
    body: `<p>The pipeline reaches a branch before it knows which way it goes, so it guesses and keeps driving. A right guess
      costs nothing; a wrong one means turning back to the fork.</p>`,
    breaks: `A driver who turns back has lost only time. The pipeline also has to cancel every instruction it started on the
      wrong road before any of them changes a register or memory.`,
    codex: ['bpred', 'controlhazard', 'flush'],
  },
  {
    chapter: 'cache', step: 'The memory hierarchy', title: 'Desk, shelf, library, warehouse',
    body: `<p>What you use now is on your desk, the rest of this week's work on a shelf, the department's in the library, and
      everything else in a warehouse across town. Each place holds far more than the one before and takes far longer to reach,
      and you keep the desk stocked with what you are about to need.</p>`,
    breaks: `You fetch one book; a cache fetches a whole line, the neighbours included, betting you will want them next. And a
      write-back cache may change a copy many times before the warehouse sees it.`,
    codex: ['cache', 'memwall'],
  },
  {
    chapter: 'dram', step: 'The sense amplifier', title: 'A seesaw tipped by a feather',
    body: `<p>Both bit lines start balanced at half the supply, like a level seesaw. The cell's charge is a feather on one end;
      the sense amplifier then slams that end all the way down and the other all the way up, which turns about a
      hundred millivolts into a full 0 and 1, and writes the cell back as it does.</p>`,
    breaks: `A seesaw tips for any feather. The amplifier needs the difference to beat its own mismatch, 15 mV here; below that
      the outcome is a coin toss, which is why the bit lines must be precharged to exactly the middle first.`,
    codex: ['senseamp'],
  },
  {
    chapter: 'dram', step: 'Leaks and refresh', title: 'A row of leaky buckets', figure: 'leaky',
    body: `<p>Each cell is a bucket with a pinhole. Reading tips it into the bit line, which is precharged to half and holds four
      times as much, so the line moves by a fifth of the bucket's distance from half. Refresh reads every row and fills its
      buckets back up before a 1 sinks too close to half to tell apart.</p>`,
    breaks: `An empty bucket cannot leak lower, but a real 0 cell slowly charges up through other leakage paths. Leak rates also
      differ from cell to cell and double for about every 10 °C, so the refresh interval is set by the worst cell at the
      hottest temperature allowed.`,
    codex: ['refresh'],
  },
  {
    chapter: 'flash', step: 'A gate that remembers', title: 'Charge stranded on an island',
    body: `<p>The floating gate is an island with no bridge: charge put on it has no way back, so it stays for years without
      power, and its charge decides whether the transistor above conducts at the read voltage.</p>`,
    breaks: `There is no bridge, but a strong enough field pushes charge across the water anyway (tunnelling): that is how the
      cell is programmed and erased. Each crossing damages the oxide a little, which is why a flash block wears out.`,
  },
  {
    chapter: 'ooo', step: 'Rename, wait, commit in order', title: 'A kitchen with a pass',
    body: `<p>Tickets come in order, but the cooks start any dish whose ingredients are ready, so a quick salad does not wait for
      a slow roast. The dishes then queue at the pass and go out strictly in ticket order: the diner (the program) never sees
      anything out of turn.</p>`,
    breaks: `A kitchen can hire more cooks; the core's window is a fixed number of entries. When the oldest dish is slow, the pass
      fills up behind it and the whole kitchen stops taking tickets.`,
    codex: ['precise'],
  },
  {
    chapter: 'simt', step: 'When lanes disagree', title: 'A drill squad',
    body: `<p>The lanes are a squad that moves on one sergeant's orders. When the order depends on each soldier ("those whose
      number is even, step forward"), the sergeant calls one group while the other stands still, then the other group, then
      the squad marches together again.</p>`,
    breaks: `Soldiers standing still are resting; idle lanes are not saved. Every order still takes its full slot, so a squad split
      in two takes as long as both groups together.`,
    codex: ['divergence', 'activemask'],
  },
  {
    chapter: 'bus', step: 'DMA', title: 'A moving company',
    body: `<p>The CPU writes the order (from, to, how much) and gets back to its own work; the movers copy the data and ring the
      doorbell (an interrupt) when they are done.</p>`,
    breaks: `The movers use the same road as everyone else: while the DMA engine holds the bus, the CPU's own loads and stores
      wait for it.`,
    codex: ['dma'],
  },
  {
    chapter: 'traps', step: 'The timer interrupt', title: 'A doorbell, not checking the door',
    body: `<p>Polling is walking to the door every minute to see whether anyone is there. An interrupt is a doorbell: work
      carries on, and the bell takes you to the door only when someone is there.</p>`,
    breaks: `Answering the bell is not free: the trap saves the PC and the cause, jumps to the handler, and the handler saves any
      register it uses. If the bell rings very often, checking the door can be cheaper.`,
    codex: ['interrupts'],
  },
  {
    chapter: 'multicore', step: 'The arbiter', title: 'A four-way stop',
    body: `<p>Several cores reach the one memory port in the same cycle, like cars at a junction: one goes, the others wait, and
      nobody may wait forever.</p>`,
    breaks: `At a four-way stop the first to arrive goes. A round-robin arbiter ignores who came first and serves the next core in
      turn after the last one served, so none can be starved.`,
    codex: ['arbitration'],
  },
];

/** The analogies shown under a step, in table order. */
export const analogiesOf = (chapter: string, step: string): Analogy[] => ANALOGIES.filter((a) => a.chapter === chapter && a.step === step);

/** The analogies a codex entry shows. */
export const analogiesForCodex = (id: string): Analogy[] => ANALOGIES.filter((a) => a.codex?.includes(id));
