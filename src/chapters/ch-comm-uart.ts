import { tolerance, toleranceClosedForm, UART_8N1 } from '../comm/startstop';
import { bytesPerSecond, divisorFor, FIFO_DEPTH, fifoBudget, OVERSAMPLE, SLOW_LIMIT_BACK_TO_BACK, SLOW_LIMIT_ISOLATED, UART_DIV_BITS, UART_TOLERANCE } from '../comm/uart';
import { shiftRegister } from '../lib/seqparts';
import { fifo } from '../lib/storage';
import { SYNC2 } from '../lib/sync';
import { AXI_UART, baudGen, UART_CORE, UART_RX, UART_TX } from '../lib/uart';
import { UART_COSTS, uartIrqSource, uartPollSource } from '../riscv/uartprograms';
import { stats } from '../sim/stats';
import { baudWidget, busUartApi, coreApi, coreScene, coreState, fifoWidget, frameWidget, rxScene, rxState, twoApi, twoComputersNands, twoScene, txScene, TWO_DIV, uartBusScene } from '../widgets/uart';
import type { Chapter } from './types';
import { numOf } from './order';
import { groupNum } from '../sim/numfmt';

const nands = (d: Parameters<typeof stats>[0]): number => stats(d).nands;
const n0 = (x: number) => groupNum(Math.round(x));
const pct = (x: number, d = 2) => `${(100 * x).toFixed(d)} %`;

const TOL = tolerance(UART_8N1, { ticks: 16, pos: 0.5 }, 5e-4);
const CF = toleranceClosedForm(UART_8N1);
const D50 = divisorFor(50e6, 115200), D12 = divisorFor(12e6, 115200);
const BYTE_US = 1e6 / bytesPerSecond(115200);
const SLACK = fifoBudget(115200, FIFO_DEPTH, 8);
const SLACK3M = fifoBudget(3e6, FIFO_DEPTH, 8);
const IRQ_PER_S = fifoBudget(115200, FIFO_DEPTH, 1).irqPerSecond;
const FIFO_N = nands(fifo(4, 8));
const CORE_N = nands(UART_CORE);

export const chUart: Chapter = {
  id: 'uart', num: numOf('uart'), title: 'A UART', level: 'Communication',
  blurb: 'How two clocks agree for one byte: a baud divider, shift registers, 16× oversampling, framing errors, FIFOs, and two computers chatting over a wire.',
  goals: [
    'frame a byte for a wire with no clock, and say what the start and stop bits each buy the receiver',
    'pick a divisor for a bit rate and a clock, and compute the rate error it leaves',
    'trace the receiver\'s sampling, find how far a clock may be off before it fails, and say where the limit comes from',
    'read framing, break, false-start and overrun conditions off the status bits, and size a FIFO against an interrupt latency',
    'write a polled and an interrupt-driven driver for the bus UART and say what each costs in cycles',
  ],
  builds: ['telegraph', 'exchange', 'clocks', 'bus', 'wire'],
  recap: {
    keep: [
      `A byte is a frame of ten bits on a wire that idles at 1: a start bit (0), eight data bits least significant first, a stop bit (1). The start edge is the only synchronization. Efficiency is 80 %.`,
      `The baud generator divides the clock by a programmable divisor (${nands(baudGen())} NANDs for a ${UART_DIV_BITS}-bit one). A tick every <code>div</code> cycles, ${OVERSAMPLE} ticks to a bit: rate = clock / (${OVERSAMPLE} · div). An integer divisor leaves a rate error: 50 MHz gives divisor ${D50.div} for 115 200 baud and ${pct(D50.error)} off.`,
      `The transmitter is a 10-bit shift register (${nands(shiftRegister(10))} of its ${nands(UART_TX)} NANDs) with a tick counter and a bit counter; the line changes only on a tick. The receiver synchronizes rx (${nands(SYNC2)} NANDs), takes the falling edge at a tick, confirms it 8 ticks later in the middle of the start bit, and samples every ${OVERSAMPLE} ticks (${nands(UART_RX)} NANDs).`,
      `A sample taken k + ½ bits after the start edge moves by about e·(k + ½) bits when the clock is off by e, and must stay inside its cell, whose edge is k bits in: a fast receiver reaches the stop sample (k = 9) at 9½ / (1 + e) and needs that at or after 9, so e ≤ ½ / 9, the margin over the cell's edge (not over the sample) divided by its distance. The stop bit is the last sample, so the limit is about ±${pct(CF.fast, 1)} for a continuous clock and ${pct(TOL.slow, 1)} (receiver slow) or ${pct(TOL.fast, 1)} (receiver fast) with the 16-tick grid. Both ends share it: about ${pct(TOL.slow / 2, 1)} each, and ${pct(SLOW_LIMIT_BACK_TO_BACK / 2, 1)} each for back-to-back bytes (the slow side then stops at ${pct(SLOW_LIMIT_BACK_TO_BACK, 1)}).`,
      `Errors are flags: a stop bit of 0 is a framing error (the byte is dropped); a low shorter than half a bit is a false start and is ignored; a break is one framing error, after which the receiver waits for the line to rise; a byte arriving to a full FIFO sets overrun. The flags stay until a 1 is written to them.`,
      `Two ${FIFO_DEPTH}-byte FIFOs are ${n0(2 * FIFO_N)} of the core's ${n0(CORE_N)} NANDs. They turn a deadline of one byte time (${BYTE_US.toFixed(1)} µs at 115 200 baud) into the time to fill the rest of the FIFO. RTS/CTS stops a sender with extra wires; XON/XOFF does it with two characters on the data path.`,
      `On the bus the UART is four registers (data, status, divisor, enables) and a slave of ${n0(nands(AXI_UART))} NANDs. Polling holds the CPU for the whole wait; the interrupt version spends ${UART_COSTS.handlerPerByte} cycles a byte and leaves ${(UART_COSTS.freePermille / 10).toFixed(1)} % of the cycles to the main loop in the measured run.`,
    ],
    check: [
      {
        question: 'A receiver samples the middle of each bit, counting from the start edge. Its clock is 3 % slow. Is the stop bit read correctly, and why?',
        options: ['Yes: the stop sample is 9½ bits after the start edge, 3 % of that is 0.29 bit, inside the half-bit margin', 'No: any error corrupts the last bit', 'Only if the divisor is odd', 'Yes, because the start bit resynchronizes the receiver at every bit'],
        answer: 0,
        explain: `The error grows with the distance from the start edge. At the stop sample, 9.5 bit times in, 3 % is 0.285 bit, less than the 0.5 bit between the sample and the edge of its cell. The limits are ${pct(TOL.slow, 1)} (slow) and ${pct(TOL.fast, 1)} (fast).`,
        why: ['', 'The sample moves by a fraction of a bit that grows with k; it corrupts the bit only when it crosses a cell edge.', 'The divisor sets the rate, not where the samples fall inside a bit.', 'Only the start edge synchronizes the receiver; the later edges in the data are ignored.'],
      },
      {
        question: 'rx is held low for 30 bit times. What does the receiver report?',
        options: ['One frame of 0x00 with a framing error, then nothing until the line rises', 'Three frames of 0x00', 'Nothing: a long low is ignored', 'An overrun'],
        answer: 0,
        explain: 'The first start bit is confirmed, eight zero data bits are shifted in, and the stop sample reads 0: a framing error. Instead of seeing another start at once, the receiver waits for the line to go high, so a break is one event.',
        why: ['', 'A receiver that returned to idle after the error would see the still-low line as a new start every frame. This one waits for a 1.', 'The first low is a valid start bit: it is still low in the middle of the bit.', 'Overrun needs a good byte arriving while the receive FIFO is full; here no byte is stored at all.'],
      },
      {
        question: `At ${n0(115200)} baud a 16-byte receive FIFO raises its interrupt at 8 bytes. How long does the CPU have before the next byte is lost?`,
        options: [`About ${SLACK.slackUs.toFixed(0)} µs, eight byte times`, `${BYTE_US.toFixed(0)} µs, one byte time`, `${SLACK.fillUs.toFixed(0)} µs, the whole FIFO`, 'It depends on the CPU clock'],
        answer: 0,
        explain: `Eight bytes are in the FIFO when the interrupt starts, eight places are free, and a byte takes ${BYTE_US.toFixed(1)} µs on the wire: ${SLACK.slackUs.toFixed(0)} µs. The CPU clock only decides how many instructions fit in that time.`,
        why: ['', 'That would be the deadline without a FIFO, which is the reason to have one.', 'The FIFO is already half full when the interrupt starts, so only the free half counts.', 'The deadline is in time on the wire, which the baud rate fixes; the clock converts it to cycles.'],
      },
    ],
  },
  steps: [
    {
      title: 'One byte, no clock',
      body: `
        <p>Two machines, one wire, and (chapter 42) two clocks with no relation between them. A byte can still cross if the sender wraps it in a <strong>frame</strong> that gives the receiver one thing to align to.
        The line idles at 1. A <strong>start bit</strong> of 0 begins the frame, the eight data bits follow <strong>least significant first</strong>, and a <strong>stop bit</strong> of 1 ends it. The line is then idle again, and the
        next start bit can come at once or any time later. Ten bit times carry eight bits of payload: 80 %. Chapter 39's five-unit ITA2 code was framed the same way, with a start unit and a stop of one and a half units
        (<code>ITA2_START_STOP</code> in <code>comm/startstop.ts</code>), a motor with a cam finding the start where this chapter uses a counter; chapter 40 worked out how far such a receiver's clock may be off.</p>
        <p>The start bit is the synchronizer. Because the idle level is 1, the falling edge is unambiguous, and from that edge on the receiver's own clock decides when to look at the line, once per bit, for nine more bits.
        Whatever the two clocks do, they only have to agree for ten bit times, which is why the tolerance is a few percent where a clocked link needs parts per million. The stop bit has two jobs. It guarantees that the
        line returns to 1 so that the next start is a falling edge, and it is the receiver's check: a 0 where the stop should be means the sampling went wrong, a <em>framing error</em>.</p>
        <p>LSB first suits a shift register: the receiver shifts right, the first bit ends up at the bottom after eight shifts, and the byte is in place without reordering. This chapter builds both ends from
        the library's parts (a shift register, counters, a synchronizer, FIFOs), connects the UART to the bus of chapter 38 and puts two computers at opposite ends of a wire.</p>`,
      widget: frameWidget,
      challenge: {
        kind: 'quiz',
        question: 'Which statement about the start bit is true?',
        options: ['Its falling edge is the only event the receiver synchronizes to; everything after it is timed by the receiver\'s own clock', 'It carries the sender\'s clock frequency', 'It is there so that the data never starts with a 1', 'It lets the receiver correct its clock at every later bit'],
        answer: 0,
        explain: 'From the start edge the receiver counts its own clock to find the middle of each bit. Nothing else on the line is used for timing, so the two clocks have to agree to a few percent for ten bits.',
        why: ['', 'The frame carries no frequency; the receiver is told the bit rate by configuration.', 'Data may start with a 1 or a 0; the start bit makes the first data bit unambiguous, it does not constrain it.', 'The data edges are not used; resynchronization happens once per frame, at the start edge.'],
      },
    },
    {
      title: 'The transmitter',
      body: `
        <p>A transmitter is a shift register that is read one bit at a time. The 10-bit universal shift register of the library holds the frame: on a load it takes <code>{1, data, 0}</code> (stop at the top, start at the bottom),
        and at the end of every bit it shifts right with a 1 entering at the top, so after ten shifts it holds all ones, the idle line. Two counters give the timing: a 4-bit <span data-show="xmit.tc">tick counter</span> that counts
        the 16 ticks of a bit and a 4-bit <span data-show="xmit.bc">bit counter</span> that counts the ten bits. A <span data-show="xmit.busy">busy</span> flip-flop is set by the load and cleared by the last tick of the stop bit.</p>
        <p>The line itself is one more flip-flop, <span data-show="xmit.ntx">ntx</span>, loaded from the shift register's bit 0 on every tick while busy. Two consequences. The output is registered, so it cannot glitch, and
        it changes only on a tick, so each bit lasts exactly 16 ticks wherever inside a tick the load arrived: the start edge is aligned to the baud generator, not to the load. And the flip-flop stores the <em>inverse</em> of the line,
        so the all-zeros power-on state is an idle line; the first thing the other end sees after a reset is not a start bit.</p>
        <p>The transmitter is ${nands(UART_TX)} NANDs, ${nands(shiftRegister(10))} of them the shift register (each of its ten bits has a 4:1 multiplexer for hold, shift right, shift left and load; a UART uses two of
        those). Set <code>div</code> on the bar, press <em>Send byte</em> and watch a frame leave: 16·div cycles per cell, the cells labelled start, d0 to d7, stop.</p>`,
      scene: txScene,
      more: {
        pitfall: `<p>Driving the line straight from the shift register's bit 0 looks cheaper and works at one frequency. The start edge then falls whenever the load happens, up to a whole tick before the baud generator's next tick, so the first
        bit is up to one tick short and the receiver's error budget is spent before the frame has begun. Registering the line on the tick costs one flip-flop.</p>`,
      },
      challenge: {
        kind: 'quiz',
        question: `At divisor 3, how many clock cycles does a byte occupy the line, from the start edge to the end of the stop bit?`,
        options: ['480 (10 bits · 16 ticks · 3 cycles)', '160 (10 bits · 16 cycles)', '30 (10 bits · 3 cycles)', '240 (8 bits · 10 · 3)'],
        answer: 0,
        explain: 'A bit is 16 ticks and a tick is div cycles, so a bit is 48 cycles and the frame is 10 of them. The transmitter stays busy for the whole of it.',
        why: ['', 'That forgets that a tick is div cycles long: with divisor 3 the tick comes every third cycle.', 'That forgets the 16 ticks per bit, which are the oversampling the receiver needs.', 'The frame has ten bits, start and stop included; the payload is eight but the line time is ten.'],
      },
    },
    {
      title: 'The baud generator',
      body: `
        <p>Both ends count their own clock, so the bit rate is set by a divider. The baud generator is a ${UART_DIV_BITS}-bit down counter that reloads from the divisor register when it reaches 1
        (or 0), and its tick is high for the cycle in which it reloads: one cycle in every <code>div</code>. A bit is ${OVERSAMPLE} ticks, so
        <strong>baud = clock / (${OVERSAMPLE} · div)</strong>. At power-on the counter and the divisor are 0 and the tick is high every cycle, which is harmless: nothing is being sent. Divisors 0 and 1 are the same. The counter and its
        reload multiplexer cost ${nands(baudGen())} NANDs.</p>
        <p>An integer divisor cannot hit every rate. The table computes the divisor nearest to each rate for the clock chosen, and what it gives. At 1.8432 MHz, the classic crystal, the clock is exactly ${OVERSAMPLE} × 115 200, so divisor 1
        is exact and every standard rate below it is an integer divisor. At 50 MHz divisor ${D50.div} gives ${D50.actual.toFixed(0)} baud, ${pct(D50.error)} high. At 12 MHz the nearest divisor is ${D12.div} and the error is ${pct(D12.error, 1)}: more than the
        receiver tolerates even when the other end is exact (step 4). The rule of thumb is to keep each end under 2 %.</p>
        <p>Dividing by ${OVERSAMPLE} first also sets the fastest rate: divisor 1 gives clock / ${OVERSAMPLE}. A 100 MHz clock cannot make more than ${(100 / OVERSAMPLE).toFixed(2)} Mbaud from this divider.</p>`,
      widget: baudWidget,
      more: {
        real: `<p>The original PC's serial port used the 8250; its successor the 16550A (1987) added 16-byte FIFOs, and its register set is the one most UARTs since copy. Both sample at 16 times the bit rate from a divisor latch. A microcontroller with a fractional baud register adds a second
        counter that sometimes divides by <code>div</code> and sometimes by <code>div + 1</code>, which brings the average error well below a tenth of a percent at the price of a tick with jitter.</p>`,
      },
      challenge: {
        kind: 'quiz',
        question: `A 50 MHz clock drives the baud generator with divisor 27. What bit rate does the line carry?`,
        options: [`${D50.actual.toFixed(0)} baud, ${pct(D50.error)} above 115 200`, '1 851 852 baud (clock / 27)', '115 200 baud exactly', `${(50e6 / 27 / 8).toFixed(0)} baud`],
        answer: 0,
        explain: `The tick comes every 27 cycles, a bit is 16 ticks: 50 000 000 / (16 · 27) = ${D50.actual.toFixed(1)}. The error is ${pct(D50.error)}, well inside the 2 % rule of thumb.`,
        why: ['', 'That is the tick rate. A bit is 16 ticks, so the bit rate is a sixteenth of it.', 'The ideal divisor is 27.13; the integer 27 leaves a small error rather than hitting the rate.', 'There is no factor of 8 in the generator: the oversampling is 16.'],
      },
    },
    {
      title: 'Sampling in the middle',
      body: `
        <p>The receiver gets no clock, only a line that changes at the sender's times. Its rx input crosses into its own clock through a ${nands(SYNC2)}-NAND two-flop synchronizer (chapter 42) and enters the state machine as
        the inverse of the line, so that reset is idle. The machine runs on the baud generator's ticks. <strong>Idle</strong> waits for a tick with the line low. <strong>Start</strong> counts 8 more ticks, to the middle of the start bit,
        and looks again: still low, a real start bit; high, a glitch, back to idle. <strong>Data</strong> samples every 16 ticks into an 8-bit shift register. <strong>Stop</strong> samples once more and reports the byte if the line is 1
        or a framing error if it is 0. The machine returns to idle at that sample, in the <em>middle</em> of the stop bit and not at its end: a sender whose clock is a little fast starts its next frame before the receiver's idea of the stop bit has
        finished, and a receiver still busy would miss the start edge. The receiver is ${nands(UART_RX)} NANDs.</p>
        <p>What can go wrong is how far a sample drifts from the middle of its bit. The start edge is seen up to one tick late (the line changes anywhere inside a tick) and two cycles later still through the synchronizer; after
        that the sample instants are on the receiver's grid, the k-th at 8 + 16k ticks. A receiver clock off by <em>e</em> moves it by about <em>e</em>·(k + ½) bits. The last sample, the stop bit's, is at 9½ bits, and a fast receiver keeps it in its cell while
        9½ / (1 + e) is at least 9, the cell's start: the half-bit margin is spent against 9 bits, not 9½, so first-order e·9½ &lt; ½ (${pct(0.5 / 9.5, 2)}) is not the limit. For a continuous clock that is ±${pct(CF.fast, 2)}. With the tick grid, the late detection costs up to 1/16 bit on one side:
        a receiver that is slow can be off by ${pct(TOL.slow, 2)} (closed form ${pct(SLOW_LIMIT_ISOLATED, 2)}) where one that is fast can be off by ${pct(TOL.fast, 2)} (${pct(CF.fast, 2)}). The gates, searched over all 256 bytes at eight start phases at divisors 1 and 4 (on the golden model, which equals the gates cycle for cycle), accept a sender up to ${pct(UART_TOLERANCE.measured[0].senderSlow, 2)} slower and
        ${pct(UART_TOLERANCE.measured[0].senderFast, 1)} faster than the receiver, at both divisors: the synchronizer delays the detection and every later sample equally, so it moves only where the start edge falls against the tick grid.
        <strong>Back to back the slow side is tighter.</strong> The next start edge comes 10 bits after this one, and a receiver slow by more than 1 − 9.5 / (10 − 1/16) = ${pct(SLOW_LIMIT_BACK_TO_BACK, 2)} has put its stop sample into it (measured ${pct(UART_TOLERANCE.measured[0].backToBackFast, 2)}). A UART that sends bursts needs both ends within about ${pct(SLOW_LIMIT_BACK_TO_BACK / 2, 1)} each; one that leaves gaps has ${pct(TOL.slow / 2, 1)}.</p>
        <div class="try">Set the receiver clock error and press <em>Send to the gates</em>: the real receiver reads the frame. Press <em>Find the limit</em> to search every byte at three start phases for the largest error that is received (the figures above searched eight, offline, so the widget's limit can sit a little wider).</div>`,
      scene: rxScene,
      more: {
        derive: `<p>With the start edge at time 0 and the receiver's ticks on its own grid, the sample for unit u (the start is unit 0, data bit i unit i + 1, the stop unit 9) falls at (u + ½)/(1 + e) + δ bit times of the sender, where δ ∈ [0, 1/16) is how late the edge was detected.
        It must land in [u, u + 1). For the stop bit, a receiver fast by e (the worst δ is 0) needs 9.5/(1 + e) ≥ 9, so e ≤ 0.5/9 = ${pct(CF.fast, 2)}. For a receiver slow by |e| the binding unit is the last data bit, whose sample must stay below 9 with δ up to 1/16: 8.5/(1 − |e|) ≤ 9 − 1/16,
        so |e| ≤ ${pct(1 - 8.5 / (9 - 1 / 16), 2)}. That is the asymmetry the search finds (<code>comm/startstop.ts</code>, <code>tolerance</code> and its closed form). This is for a frame that is followed by idle. In a back-to-back stream the receiver is in idle from the stop sample on, and the next start edge is at 10 bits: the stop sample of a slow receiver, 9.5/(1 − |e|) + 1/16 at worst, must stay below 10, so |e| ≤ ${pct(SLOW_LIMIT_BACK_TO_BACK, 2)}, which is smaller. The fast side is the same in both cases. <code>comm/uart.ts</code> computes this case; <code>comm/startstop.ts</code> has no back-to-back option yet.</p>`,
        pitfall: `<p>Treating the tolerance as the clock accuracy of one end. The errors of sender and receiver add, so each may use about half: ${pct(TOL.slow / 2, 1)} each. A 2 % divisor error at one end leaves under 3 % for the other's crystal, voltage and temperature drift together.</p>`,
      },
      challenge: {
        kind: 'reach',
        goal: `Make the real receiver get a byte wrong: set the receiver clock error past 6 % in either direction and press Send to the gates.`,
        check: (stage) => { const st = rxState(stage); return !!st && !!st.last && !st.last.ok && Math.abs(st.last.err) > TOL.fast && Math.abs(st.last.err) < 0.1; },
        answer: `Past ${pct(TOL.slow, 1)} (receiver slow) or ${pct(TOL.fast, 1)} (receiver fast) the stop sample or the last data sample leaves its cell, and the receiver reports a framing error or a wrong byte, depending on the code.`,
        solve: (stage) => { rxState(stage)?.set(0.065); rxState(stage)?.send(); },
        hints: ['Move the slider with the arrow keys; the markers on the frame turn red when a sample leaves its cell.', 'The stop bit is the one that goes first on the fast side.'],
      },
    },
    {
      title: 'Errors: framing, false start, break, overrun',
      body: `
        <p>Four things go wrong on a real wire, and the receiver turns each into a definite event. The scene is the UART core with its FIFOs and status register on a bench; the panel plays the sender at divisor 1.</p>
        <p><strong>Framing error.</strong> The stop sample reads 0. The byte is discarded, the <code>framing error</code> flag (status bit 3) is set, and the receiver waits for the line to be 1 before it will accept a start bit.
        That is the usual reading of a wrong baud rate or a noisy wire, and it is cheap: the sample that would have been the stop bit does the check. <strong>False start.</strong> A low pulse shorter than about half a bit is
        gone by the time the receiver looks again in the middle, so it returns to idle with no event: the 8-tick confirmation is a glitch filter. <strong>Break.</strong> A line held low for longer than a frame is a deliberate signal.
        The receiver reads one frame of zeros with a stop of 0, reports one framing error, and then <em>stays</em> out of idle until the line rises, so a break is one event and not
        a stream of 0x00 bytes. <strong>Overrun.</strong> A good frame arrives while the receive FIFO is full: the byte is dropped and <code>overrun</code> (bit 4) is set.</p>
        <p>The flags are sticky: they stay set until software writes a 1 to them, so a driver that polls only now and then still learns that something happened since it last looked. The two diagnose different faults:
        overrun says the software was too slow, framing that the wire or the divisor was wrong.</p>`,
      scene: coreScene,
      challenge: {
        kind: 'reach',
        goal: 'Set both error flags: send a frame with a bad stop bit, then send 20 frames without reading any.',
        check: (stage) => { const c = coreState(stage); return !!c && (c.status() & 24) === 24; },
        answer: 'A bad stop bit sets the framing error. Twenty good frames into a 16-byte FIFO that nobody reads set the overrun when the seventeenth arrives. Write 1s to clear them.',
        solve: (stage) => { const a = coreApi(stage); a?.frame(0x42, false); a?.flood(20); },
        hints: ['Both buttons are on the panel; the second takes a few seconds to play.'],
      },
    },
    {
      title: 'FIFOs and flow control',
      body: `
        <p>A UART with one receive register gives the CPU one byte time to take each byte: ${BYTE_US.toFixed(1)} µs at 115 200 baud, every byte, with no other interrupt allowed to run longer. A
        <strong>FIFO</strong> turns that into an average. The core has a ${FIFO_DEPTH}-byte FIFO each way (<code>fifo(4, 8)</code>, ${n0(FIFO_N)} NANDs each, ${pct(2 * FIFO_N / CORE_N, 0)} of the core's ${n0(CORE_N)}): the receiver pushes, the CPU pops, and the interrupt
        can be raised when the FIFO is not empty (this chapter's driver) or, in a UART with a trigger level, when it holds a chosen number of bytes. A trigger of 8 has a price: a lone byte is not reported until
        more arrive, so real parts add a timeout.</p>
        <p>The widget does the arithmetic. At 115 200 baud and a trigger of 8 the CPU has ${SLACK.slackUs.toFixed(0)} µs between the interrupt and the first lost byte (${(SLACK.slackUs - BYTE_US).toFixed(0)} µs to be safe: a byte already in the shift register lands too), and takes ${n0(IRQ_PER_S)} interrupts a second at a level of 1 against ${n0(IRQ_PER_S / 8)} at a level of 8, for the
        same handler work per byte. At 3 Mbaud the same FIFO leaves ${SLACK3M.slackUs.toFixed(0)} µs, and that is where a DMA engine (chapter 38) takes over.</p>
        <p>When the receiver cannot keep up, the sender has to be told. <strong>RTS/CTS</strong> uses two extra wires: the receiver drops its RTS (the sender's CTS) when its FIFO is nearly full, and a sender checks CTS before it starts each frame. A frame already started still arrives, so the threshold leaves
        room for one more byte. <strong>XON/XOFF</strong> uses no wires: the receiver sends the characters 0x13 (XOFF) and 0x11 (XON) on its own tx. It has to leave room for every byte in flight plus the time the character takes to reach the other end and be acted on, and the data stream cannot contain those two values. A
        transmit FIFO has the mirror problem, and there the CPU is the sender: the status bit <code>tx full</code> is its flow control.</p>`,
      widget: fifoWidget,
      challenge: {
        kind: 'quiz',
        question: 'A receive FIFO of 16 bytes interrupts at 8. At 921 600 baud, compared with 115 200, the CPU has:',
        options: ['One eighth of the time (about 87 µs for eight bytes instead of 694 µs)', 'The same time: the FIFO size fixes it', 'Eight times as long', 'No time at all: the FIFO fills instantly'],
        answer: 0,
        explain: `The slack is the free places times the byte time. A byte takes ${(1e7 / 921600).toFixed(1)} µs at 921 600 baud, eight of them ${(8 * 1e7 / 921600).toFixed(0)} µs, against ${SLACK.slackUs.toFixed(0)} µs at 115 200.`,
        why: ['', 'The size sets how many bytes fit, the rate sets how long each takes on the wire. The time is their product.', 'A faster line gives less time between bytes, not more.', 'Eight byte times is short, but it is not zero: that is the number to design the interrupt latency against.'],
      },
    },
    {
      title: 'A UART on the bus',
      get body() {
        return `
        <p>The core becomes a slave on chapter 38's bus (<code>AXI_UART</code>, ${n0(nands(AXI_UART))} NANDs with the core) at 0x3000_0000: <strong>+0 data</strong> (store: queue a byte; load: the oldest received byte), <strong>+4 status</strong>
        (bit 0 receive not empty, 1 transmit full, 2 transmit idle, 3 framing error, 4 overrun; storing a 1 to bit 3 or 4 clears it), <strong>+8 divisor</strong>, <strong>+12 interrupt enables</strong> (bit 0: receive not empty, bit 1: transmit FIFO empty).
        The slave only decodes: write strobes into the core, and a read-data register latched at the handshake. A load from +0 pops the FIFO <em>one cycle after</em> the handshake, from a flip-flop (the pattern of the keyboard and card-reader slaves),
        so that the address handshake has no combinational path to the FIFO that supplies the data. The UART's <code>irq</code> is ORed with the DMA's into the CPU's external interrupt.</p>
        <p>The golden model that checks the computer in lock-step with the gates is the core's own edge-by-edge model (<code>comm/uart.ts</code>); <code>bus/model.ts</code> advances it to the access's handshake edge, the way the card reader's model does, so even the status a polling
        loop reads agrees every cycle. The two drivers are in the box below; the scene runs the second.</p>
        <details class="deeper"><summary>Polled driver, then interrupt driver (RV32 assembly)</summary><pre>${uartPollSource(2).replace(/</g, '&lt;')}</pre><pre>${uartIrqSource(2).replace(/</g, '&lt;')}</pre></details>
        <p><strong>Measured on the gates</strong> (8 bytes at divisor 1, <code>UART_COSTS</code>): the polled loop takes a byte ${UART_COSTS.pollLatency[0]} to ${UART_COSTS.pollLatency[1]} cycles after it reaches the FIFO, depending on where the loop is; the interrupt takes it ${UART_COSTS.irqLatency} cycles after, every time.
        The handler runs ${UART_COSTS.handlerPerByte} cycles a byte (it checks the status once more before it returns) and the main loop keeps ${(UART_COSTS.freePermille / 10).toFixed(1)} % of the cycles. Polling reacts as fast and keeps the CPU busy. The interrupt costs a few instructions of setup once and
        gives the time back when the line is mostly idle, which at 115 200 baud it is.</p>`;
      },
      scene: uartBusScene,
      challenge: {
        kind: 'reach',
        goal: 'Send "Hello" into the rx pin and watch the interrupt handler echo it to the console.',
        check: (stage) => (busUartApi(stage)?.console() ?? '').includes('Hello'),
        answer: 'Press Send to rx. Each byte reaches the receive FIFO, the status bit sets the interrupt, and the handler loads the byte and stores it to the console.',
        solve: (stage) => { busUartApi(stage)?.send('Hello'); },
        hints: ['Send to rx also starts the clock; the program needs a few hundred cycles to set up before the first byte matters.'],
      },
    },
    {
      title: 'Two computers chat',
      get body() {
        return `
        <p>Two copies of chapter 38's computer, each with a UART, a keyboard and a console, on <strong>unrelated clocks</strong>. A's tx goes through a line part to B's rx and B's tx back to A's rx. The line is the one box in the chapter that does not end in transistors:
        it stands for the cable (it delays the level by two sender cycles and has an input that flips it, for noise) and chapter 41's model is what is inside. Each computer runs the chat program: keys typed go out on the UART, bytes received go to the console. A polls;
        B takes its bytes by interrupt. Everything else, both CPUs, both UARTs and their FIFOs, runs as gates on the cycle engine, each computer on its own clock pin, the edges merged in time order.</p>
        <p>Type on A and the text appears on B's console, and the other way. The slider gives clock B an error against clock A. Typed text goes out in bursts, back to back, so the slow side of clock B is the tight one: ${pct(SLOW_LIMIT_BACK_TO_BACK, 1)}. Within ±4 % the chat works in both directions (tested); between 4.4 % and 5 % a direction already garbles, and by ±9 % neither works. The consoles
        show wrong characters or lose them. The glitch button flips the wire from A to B for six cycles, under the ${8 * TWO_DIV} cycles of confirmation (half a bit), so a receiver in idle treats it as a false start; inside a frame it would corrupt a bit instead.</p>
        <p>The two computers are ${n0(twoComputersNands())} NANDs in one scene. They run at a few thousand cycles a second, so the divisor in the program is ${TWO_DIV}: a bit is ${16 * TWO_DIV} cycles and a character crosses in a fraction of a second.
        The same machine gets a modem, a faster serial link and finally a network interface in the chapters that follow.</p>`;
      },
      scene: twoScene,
      challenge: {
        kind: 'reach',
        goal: 'Type "hi" on computer A and see it on computer B\'s console.',
        check: (stage) => (twoApi(stage)?.consoleOf('B') ?? '').includes('hi'),
        answer: 'Type hi in the A field and press Send from A (or Enter), then Run. A\'s program takes the key, waits for room in the transmit FIFO and stores it to the UART; B\'s receiver and interrupt handler print it.',
        solve: (stage) => { const a = twoApi(stage); a?.type('A', 'hi'); a?.run(); },
        hints: ['The text goes into a keyboard queue; the computer reads it only while it runs.'],
      },
    },
  ],
};
