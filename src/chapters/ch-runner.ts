// Appendix D: a video game with no program. Bit Runner is an original game built only from counters and gates in 74xx
// chips (lib/bitrunner.ts; runner/model.ts its reference, in lock step at every clock). Every scene is the gate-level
// machine on its boards with the Screen panel (widgets/runner.ts).

import { RESULTS } from '../bench/summary';
import { RB_CLOCKS, RB_FRAME, RB_LINE, RB_PLAYER_LOAD, RB_WALL_LOAD, RB_WALL_PERIOD } from '../runner/model';
import { groupDigits } from '../sim/numfmt';
import type { Stage } from '../view/stage';
import { runnerScene } from '../widgets/runner';
import { SAP_COST } from './ch-sap';
import type { Chapter } from './types';
import { numOf } from './order';

const k = groupDigits;

/** What the game costs (lib/bitrunner.ts rbCost, stats per module; tests/bitrunner.test.ts holds these to it). */
export const RB_COST = { chips: 97, nands: 2648, sync: 539, walls: 440, gaps: 482, player: 430, rules: 168, score: 279, digits: 273, video: 37 } as const;
const RV32I = RESULTS.cpus.find((c) => c.id === 'sc')!;
/** Clocks a second at the game's 30 frames a second, and what a real TV's 262 lines at 60 Hz would need with the same 72-clock line. */
const GAME_HZ = RB_CLOCKS * 30, TV_HZ = RB_LINE * 262 * 60;

function poke(st: Stage, v: Record<string, number>): void {
  const sim = st.sim;
  if (!sim) return;
  st.checkpoint();
  for (const [n, x] of Object.entries(v)) sim.setInput(n, x);
  sim.settle();
  st.refresh();
}

/** Press and release Start: one clock is enough, the rules' register takes it at the next edge. */
function startGame(st: Stage): void {
  poke(st, { start: 1 });
  st.runCycles(1);
  poke(st, { start: 0 });
}

export const chAppendixRunner: Chapter = {
  // after Appendix C, whatever the journey's length
  id: 'appendix-runner', num: numOf('appendix-runner'), appendix: 'D', title: 'A game with no program', level: '74xx TTL',
  blurb: 'Bit Runner: a video game of counters and gates, with no CPU and no ROM. You steer one bit through walls of gates that pass only their own colour.',
  goals: [
    'derive a raster from two counters, and any shape on screen as a comparison against them',
    'move an object with no position register, by a counter whose period is one count short',
    'write a collision as an AND of video signals, and say why no geometry is needed',
    'say what hardwiring a game costs against a CPU and a program, in chips, NANDs and the price of changing a rule',
  ],
  builds: ['registers', 'routing', 'adders'],
  recap: {
    keep: [
      `A raster is two counters: h ${RB_LINE} clocks a line, v ${RB_FRAME} lines a frame, ${k(RB_CLOCKS)} clocks a frame. A shape is logic on those counters, so nothing is stored as a picture.`,
      `A moving object needs no position register. A counter whose period divides the line's stands still against the beam; load it one count short and everything it draws is one pixel to the left from then on.`,
      'Collision is an AND of two video signals at one clock: if you and a wall light the same pixel, you hit it. The shapes\' geometry never enters the logic.',
      `The cost is rigid hardware: ${RB_COST.chips} chips and ${k(RB_COST.nands)} NANDs, every rule in gates. A CPU costs more silicon once and then each rule is a line of a program.`,
    ],
    practise: ['s_cnt4', 's_reg4'],
    check: [
      {
        question: `The wall counter loads ${RB_WALL_LOAD} and counts to 63, a period of ${RB_WALL_PERIOD}. Why must the period divide the ${RB_LINE}-clock line?`,
        options: ['So the counter is at the same value at the same column on every line, and the wall stands straight', 'So the counter never overflows', 'So the wall is four pixels wide', 'So hsync can reset it'],
        answer: 0,
        explain: `${RB_LINE} = 2 × ${RB_WALL_PERIOD}: after each line the counter is where it was, so each line draws the wall at the same column. Any other period would draw it sheared across the lines.`,
        why: ['', 'It wraps by design: the wrap is what reloads it.', 'The width is the decode: count ≥ 60 is four values.', 'Nothing resets it at a line: it only slips, once a slip frame.'],
      },
      {
        question: 'You stand in a gate of your colour. Then the score reaches a value where the gate is narrower, and a pixel of you overlaps the wall above the gate. What decides whether you crash?',
        options: ['One clock with YOU, WALL and FIELD high and NOT (IN GATE AND colours match)', 'A comparison of your row against the gate\'s top and bottom', 'A count of how many of your pixels overlap', 'The next frame\'s position, checked in vertical blanking'],
        answer: 0,
        explain: 'On the line where the beam reaches your overlapping pixel, IN GATE is 0 while YOU and WALL are 1, so crash goes high for that clock. The comparison with the gate is about the line the beam is on, and not about where you are.',
        why: ['', 'There is no register holding your row to compare with: your position exists only as a phase.', 'One pixel is enough: the first clock of overlap sets ghost, and ghost blocks any second crash.', 'Nothing waits: the crash happens as the beam draws it.'],
      },
      {
        question: 'A designer wants a third colour of gate. What is the smallest change in this hardware?',
        options: ['A wider gate register, a second colour bit in the player, a wider comparison and another video line: new wires on several boards', 'A new byte in the ROM', 'A change to the LFSR alone', 'A new microinstruction'],
        answer: 0,
        explain: 'A colour is stored in the gate registers, in the player, compared in Rules, and drawn in Video. On a CPU the same rule is a few instructions; here it is a change to the boards.',
        why: ['', 'There is no ROM in this machine.', 'The LFSR would supply the bit, but nothing could hold, compare or show it.', 'There is no microcode: nothing is sequenced.'],
      },
    ],
  },
  steps: [
    {
      title: 'Play it',
      body: `
        <p>Everything on this page is one machine with no program in it: no CPU, no instruction, no ROM, no RAM. Its
        ${RB_COST.chips} chips are counters, a few registers and gates, built from our NANDs. Bit Runner is a new game
        made for this appendix. You are one bit. Walls of gates scroll towards you, and a gate passes only a bit of its
        own colour.</p>
        <p>Cost: ${RB_COST.chips} chips, ${k(RB_COST.nands)} NANDs. For scale: the SAP-1 of Appendix C has ${k(SAP_COST.logic)}
        NANDs of logic and our single-cycle RV32I ${k(RV32I.nands)}. Video games were first built this way because in the
        early 1970s a machine could afford chips like these and not a processor. Arcade cabinets of those years were
        boards of 74-series logic, until games such as Midway's <em>Gun Fight</em> (1975) moved to a microprocessor. This
        appendix uses the same technique, with rules and a circuit of its own.</p>
        <div class="try">Click <strong>Start</strong> on the Screen panel. Steer with ▲ ▼ (or click the screen and use ↑ ↓) and
        press <strong>Flip bit</strong> (Space) so your colour matches the next gate.</div>`,
      scene: () => runnerScene(),
      tries: [(st) => st.value('run') === 1],
      challenge: {
        kind: 'quiz',
        question: 'Your bit is amber and the next gate is cyan. You fly through the middle of the gate. What happens?',
        options: ['You crash, and lose a life', 'You pass, because you hit no wall', 'You pass, and your bit turns cyan', 'The wall stops until you flip'],
        answer: 0,
        explain: 'A gate of the wrong colour counts as wall. The rule is XNOR: the two bits must be equal.',
        why: ['', 'Passing needs both the gap and the colour.', 'Only Flip changes your bit.', 'Nothing in the game waits for you: the walls are a counter that never stops.'],
      },
    },
    {
      title: 'The beam is two counters',
      body: `
        <p><span data-show="sync">Sync</span> is two pairs of 74LS161s. h counts every clock, 0 to ${RB_LINE - 1}; v counts
        once a line, 0 to ${RB_FRAME - 1}: ${RB_LINE} × ${RB_FRAME} = ${k(RB_CLOCKS)} clocks a frame. h is the beam's column
        and v its line. Both reload 0 synchronously, from an AND of the top count (71 = 1000111, 51 = 110011).</p>
        <p>Blanking and sync cost almost nothing, because the counters' top bits already say it. h6 is 1 for columns 64–71, so
        <code>active</code> is NOT h6 AND NOT (v5 AND v4). hsync is h6 AND h2, vsync is v5 AND v4 AND v1. The monitor on the panel
        knows only these pins: it moves a pixel a clock, starts a line at hsync's falling edge and a frame at vsync's.</p>
        <p>Cost: ${k(RB_COST.sync)} NANDs, of which four 161s are 500. The screen is 64 × 48 at ${k(GAME_HZ)} clocks a second for 30
        frames. That is our own monitor: a real TV wants 262 lines at 60 Hz, ${k(TV_HZ)} clocks a second with the same line,
        more than this simulation can do in real time. The counters would need three more bits and nothing else would change.</p>
        <div class="try">Set the rate to <strong>40 pixels / s</strong> and watch the red dot trace a line, then
        <strong>Line</strong> and <strong>Frame</strong> to jump. The H LEDs on the Sync board count with it.</div>`,
      scene: () => runnerScene({ highlight: ['sync'], rate: 40, paused: true }),
      challenge: {
        kind: 'quiz',
        question: `Why do both counters reload with a synchronous LOAD, and not by the 161's own CLR pin?`,
        options: ['CLR acts at once, so the decode of "71" would clear the counter as soon as it appears: a glitchy, one-gate-delay state', 'CLR does not work on a 161', 'LOAD is faster', 'CLR would also clear the other counter'],
        answer: 0,
        explain: 'A synchronous load holds count 71 for its whole clock and returns to 0 at the next edge, so the line is exactly 72 clocks. Every flip-flop in this machine sees the one clock, which is also what lets the cycle engine run it.',
        why: ['', 'CLR works: SAP-1 uses it on its step counter, and pays with a glitch it has to ignore.', 'They take effect at different times, which is the point; neither is faster logic.', 'Each chip has its own CLR pin.'],
      },
    },
    {
      title: 'A thing on screen is a comparison',
      body: `
        <p>Nothing here stores a picture. The screen is what the beam's position means to some gates at each clock. Your
        column is <span data-show="player">a window on h</span>: 12 to 15 is h3 AND h2 with h6, h5 and h4 at 0, a single AND. A wall is
        the top of a counter: count ≥ 60 is four values, AND of its top four bits. A pixel is white when the window is true while the
        beam passes, for one clock, then it is gone until the next frame.</p>
        <p><span data-show="video">Video</span> ORs what the beam is on, per colour, and gates it off during blanking. It is the
        cheapest board: ${RB_COST.video} NANDs. Its work is in the other boards, each already holding one signal that says "the beam
        is on me now".</p>
        <p>The price is that nothing is free to look like anything. A sprite in memory can be any shape and costs a memory; a shape here
        is a Boolean function of counters, so rectangles are cheap and a curve is a lot of gates.</p>`,
      scene: () => runnerScene({ highlight: ['video', 'player'] }),
      challenge: {
        kind: 'quiz',
        question: 'Your column window is columns 12–15. What would it cost to make it columns 8–15, twice as wide?',
        options: ['One input fewer on its AND', 'A second player counter', 'An adder on h', 'A bigger register'],
        answer: 0,
        explain: 'Drop h2: h3 with h6, h5 and h4 at 0 means columns 8–15. A power-of-two window aligned to its size is an AND of the top bits, and a wider one has fewer inputs. A window not aligned to its width, such as 12–19, needs an OR of two such terms.',
        why: ['', 'Your column does not move: only your line needs a counter.', 'Nothing here adds to h; windows only compare.', 'A window is logic: no state at all.'],
      },
    },
    {
      title: 'Moving is slipping',
      body: `
        <p><span data-show="walls">The walls</span> are one counter with no position anywhere. It counts every clock from
        ${RB_WALL_LOAD} to 63: a period of ${RB_WALL_PERIOD}, exactly half a line, so against the beam it stands still and you see two straight walls
        ${RB_WALL_PERIOD} pixels apart.</p>
        <p>Now load ${RB_WALL_LOAD + 1} instead of ${RB_WALL_LOAD}, once. That one period is ${RB_WALL_PERIOD - 1} clocks, so the top of the count comes one clock early, on
        every line from then on: both walls are a pixel further left. Nothing holds where they are. The position is a phase, the difference between
        two counters, and to change it you make one of them lose a count.</p>
        <p>One flip-flop, <code>armed</code>, makes that happen once: it is set on line 50 of a slip frame and cleared by the next wrap, and it is bit 0 of the
        load value. The slip frame is every other frame (15 pixels a second at 30 frames, a wall every 2.4 s); at a score of 10 it is every frame. That is the speed half of the
        difficulty curve, one OR gate; the gates narrow later.</p>
        <p>Cost: ${k(RB_COST.walls)} NANDs for the board, which also reads the score to pick the slip rate. A CPU would hold a wall's x in a register and add to it. Here it takes
        a counter that was needed anyway to draw the wall.</p>
        <div class="try">Press <strong>Frame</strong> a few times and read the WC LEDs: at the same beam position, the count differs once per slip.</div>`,
      scene: () => runnerScene({ highlight: ['walls'], paused: true }),
      challenge: {
        kind: 'quiz',
        question: `What happens to the walls if the slip loads ${RB_WALL_LOAD - 1} instead of ${RB_WALL_LOAD + 1}?`,
        options: ['They move right: the period is one clock longer, so the top of the count comes a clock later', 'They move left twice as fast', 'They disappear', 'They shear'],
        answer: 0,
        explain: `A load of ${RB_WALL_LOAD - 1} gives one period of ${RB_WALL_PERIOD + 1} clocks: every later wall is a column to the right. The load value alone sets the direction of the whole game: above ${RB_WALL_LOAD} left, below ${RB_WALL_LOAD} right.`,
        why: ['', 'A longer period makes the count late, and late is further along the line: right.', 'The counter still wraps and still decodes count ≥ 60.', 'Every line after the slip is shifted equally; only the one line where it happens is odd, and that line is in blanking.'],
      },
    },
    {
      title: 'Where the gates come from',
      body: `
        <p>Each wall needs a gate: where it starts and what colour. <span data-show="gaps">The Gates board</span> gets both from a 74LS273 wired as an 8-bit LFSR with
        XNOR feedback, 255 states, stepping every clock whether anyone needs it or not. Its 4 low bits are copied into a wall's register while that wall is off screen (first column
        at 64–68, on line 50). The last copy before it comes on wins. ${k(RB_CLOCKS)} clocks a frame is 174 more than a whole number of LFSR periods, and your Start press lands at a clock you chose: that is all the randomness there is.</p>
        <p>The test is a subtraction: <code>v ÷ 4 − start</code> on one 74LS283. Under 4 means this line is in the gate, so a gate is 16 lines tall; at a score of 20 it is 12, at 40 it is 8, each by masking values of the difference.
        The two walls share one comparator through a 74LS157, because the beam is only on one wall at a time. That sharing is free here: it costs a mux and saves a subtractor.</p>
        <p>Cost: ${k(RB_COST.gaps)} NANDs, most of them flip-flops.</p>`,
      scene: () => runnerScene({ highlight: ['gaps'] }),
      challenge: {
        kind: 'quiz',
        question: 'Why does the comparison use only v5–v2, a resolution of four lines?',
        options: ['It needs a 4-bit subtractor and not 6-bit, and you are four lines tall anyway, so finer steps change little', 'The counter v only has 4 bits', 'Lines 0–3 would otherwise be blank', 'A 74LS283 can only subtract multiples of 4'],
        answer: 0,
        explain: 'Dropping two bits saves about a third of the comparison and the register bits behind it, for gate positions you could barely tell apart. It is the same trade as every window on this board: coarser means fewer gates.',
        why: ['', 'v has 6 bits; the top four are what the comparison reads.', 'Nothing blanks those lines: the gate just starts on a multiple of 4.', 'It adds any 4-bit numbers.'],
      },
    },
    {
      title: 'You are a bit',
      body: `
        <p><span data-show="player">The Player board</span> uses the walls' trick on the other axis. Its counter counts once a line, from ${RB_PLAYER_LOAD} to 63: a period of ${RB_FRAME} lines, one frame, so you stand still. Its top four counts are the four lines you are on.</p>
        <p>Hold ▲ and each wrap loads ${RB_PLAYER_LOAD + 1}: ${RB_FRAME - 1} lines, so you arrive one line earlier on the next frame. ▼ loads ${RB_PLAYER_LOAD - 1}. The buttons are read only at the wrap, so a button is 1 line a frame whatever you do between: 30 lines a second, with no debouncing. Two gates stop you leaving the field: the wrap comes at your last line, so "v is not in the first four lines" allows up and "v is below 36" allows down.</p>
        <p>Your colour is one flip-flop toggled by Flip's rising edge: <code>bit' = bit XOR (flip AND NOT flip-a-clock-ago)</code>. Cost: ${k(RB_COST.player)} NANDs. Its two 161s give eight bits, two more than a count to 63 needs, because the counter comes four bits to a package.</p>
        <div class="try">Flip your bit to cyan: use <strong>Flip bit</strong> on the panel or the FLIP switch on the Player board. Press it twice and it is amber again.</div>`,
      scene: () => runnerScene({ highlight: ['player'] }),
      challenge: {
        kind: 'reach',
        goal: 'Make your bit cyan (BIT = 1).',
        check: (st) => st.value('bit') === 1,
        hints: ['The flip-flop toggles on Flip\'s rising edge, and needs a clock to see it.', 'Press Flip while the clock runs, or set flip = 1 and Pulse.'],
        answer: 'Press Flip bit once with the clock running, or set the flip switch and Pulse once.',
        solve: (st) => {
          poke(st, { flip: 0 });
          st.runCycles(1);
          if (st.value('bit') !== 1) { poke(st, { flip: 1 }); st.runCycles(1); poke(st, { flip: 0 }); }
        },
      },
    },
    {
      title: 'Collision is an AND',
      body: `
        <p>There is no hit test. While the beam draws, the machine already holds a signal that says "this pixel is you" and one that says "this pixel is wall". <span data-show="rules">The Rules board</span> ANDs them:</p>
        <p><code>crash = RUN · NOT GHOST · YOU · WALL · FIELD · NOT (IN GATE · (BIT XNOR COLOUR))</code></p>
        <p>That is one wide AND, high for a clock, on the first pixel of overlap. Neither shape's coordinates enter it, and neither does their size: make the wall wider and collisions are still exact, at no cost.
        The XNOR is the game's one rule. It is also why a gate of the wrong colour behaves as wall, down to the pixel.</p>
        <p>The first overlapping pixel sets <code>ghost</code>, which blocks further crashes and blinks you until that wall has passed (the same tick that scores). So one wall costs one life, however many pixels overlap. Four flip-flop bits (run, ghost, two of lives lost), the rest gates: ${k(RB_COST.rules)} NANDs.</p>
        <p>The timing is why this is so cheap. A program would have to compute this per object per frame. Here the beam visits every pixel anyway, and asks one question at each.</p>
        <div class="try">Crash once: watch the HIT LED blink for one clock at slow rates, and the lives go down.</div>`,
      scene: () => runnerScene({ highlight: ['rules'] }),
      tries: [(st) => st.value('lives') >= 1],
      challenge: {
        kind: 'reach',
        goal: 'Start a game and lose a life.',
        check: (st) => st.value('lives') >= 1,
        hints: ['Press Start, then let a wall reach you.', 'Stay out of the gate, or sit in one of the other colour.'],
        answer: 'Press Start and leave the buttons alone: within a few walls your row is outside a gate, or the gate is the other colour.',
        solve: (st) => {
          startGame(st);
          for (let f = 0; f < 400 && st.value('lives') < 1; f++) st.runCycles(RB_CLOCKS, undefined, 0, true);
          st.refresh();
        },
      },
    },
    {
      title: 'Score: from digit to pixels',
      body: `
        <p>Score counts walls passed in two 74LS161s, each loaded back to 0 after 9 (a decade counter is a binary counter with an early load). The tens digit also sets the difficulty through three ORs, the only feedback from score to play. <span data-show="score">${k(RB_COST.score)} NANDs</span>.</p>
        <p><span data-show="digits">The digits</span> are not bitmaps. A 74LS157 chooses tens or units by the beam's column, seven OR-of-AND terms make the seven segments, a 74LS138 decodes the band's line, and the beam's low bits choose the left, middle or right column. Each pixel of a digit is a sum of products of the digit's bits and the beam's bits, recomputed each time the beam passes.</p>
        <p>Cost: ${k(RB_COST.digits)} NANDs and 28 chips, the most packages of any board for what looks like the least. One font glyph in a ROM would be 15 bits. The gates pay with chips what a ROM would pay with a part this machine does not have.</p>`,
      scene: () => runnerScene({ highlight: ['digits', 'score'] }),
      challenge: {
        kind: 'quiz',
        question: 'Both digits go through one font. What makes that safe?',
        options: ['The beam is on at most one digit at any clock, so a mux by h3 can share the font', 'The two digits are always equal', 'The font has a memory for each digit', 'The tens digit is only drawn on odd frames'],
        answer: 0,
        explain: 'Time-sharing a block costs one mux when its users never need it at once. A raster guarantees that for anything in different columns, the same reason the two walls share one subtractor.',
        why: ['', 'They differ most of the time.', 'There is no font memory: it is combinational.', 'Both are drawn on every frame, in different columns.'],
      },
    },
    {
      title: 'What a CPU buys',
      body: `
        <p>Against a program, this machine has one real advantage and several costs. The advantage: it is exactly as fast as the screen needs, because its logic runs in step with the beam. It never misses a deadline, since it has none: every signal is decided within a clock.</p>
        <p>The costs: ${RB_COST.chips} chips for a game, and every rule welded in. Slowing the walls at a score of 30 means a new gate and a new wire. A third colour touches four boards. Our single-cycle RV32I costs ${k(RV32I.nands)} NANDs (${(RV32I.nands / RB_COST.nands).toFixed(0)} × this machine), and you would still need a frame buffer or a sprite unit. After that one purchase, though, each of those changes is a line of a program, and so is the next game.</p>
        <p>The arithmetic favoured gates only while a processor was dear and games were simple. When a processor and a ROM cost less than the 100-odd chips of a more complicated game, cabinets changed over, and the hardware was reused from game to game: a change the chapters on CPUs already explain.</p>
        <details class="deeper"><summary>What is checked</summary>
          <p><code>runner/model.ts</code> is a TypeScript model of every register. A test runs it beside the gates on random buttons and restarts, comparing all registers and video pins at every clock; the panel keeps comparing the pins while you play, and its title says so if they ever differ. Simulation is on the cycle engine, which is why every flip-flop shares one clock.</p>
        </details>`,
      scene: () => runnerScene(),
      challenge: {
        kind: 'quiz',
        question: 'You want a second game on the same board. Which hardware would need to change?',
        options: ['Nearly every board: the rules are the wiring', 'Only the Rules board', 'Only the score digits', 'None: reload the ROM'],
        answer: 0,
        explain: 'Only Sync and the digit logic would survive unchanged. Everything else is this game. That is the difference a program makes: on a CPU the game is data.',
        why: ['', 'What a wall is, how the player moves and what counts as a hit are spread over Walls, Gates, Player and Video too.', 'The digits are the most reusable part, and the only part that would not be enough.', 'There is no ROM.'],
      },
    },
  ],
};
