// Authored walkthroughs, group 8: act 12, Links (references: lib/sync.ts, lib/uart.ts … through buildcomm.ts). See walks.ts
// for the conventions. No DOM.

import type { WalkScript } from './walk';

export const WALKS8: Record<string, WalkScript> = {
  l_sync: [
    {
      title: 'The flip-flop that may not decide',
      text: 'f0 samples d on the receiving clock. d changes at any moment, so some edges will find it mid-change and leave f0 balanced between 0 and 1 for a while: a metastable output. f0 is the only flip-flop that can see this.',
      parts: ['f0'], codex: ['edge'],
      why: 'Something has to sample the asynchronous signal at one instant of the receiving clock. A flip-flop is that sampler, and its output is not a clean 0 or 1 until it has decided.',
      whyNot: { text: 'Feeding d straight into the logic lets a half-decided level reach many gates at once, which read it differently.' },
    },
    {
      title: 'A whole period to decide',
      text: 'f1 samples f0 one period later. By then the undecided level has had t = T − clk-to-q − setup to fall to a rail; each extra period multiplies the odds by e^(T/τ). Nothing may sit between f0 and f1: a gate there would eat resolution time.',
      parts: ['f1'], codex: ['edge'],
      ask: {
        question: 'At this port one flip-flop read by logic fails in days. What does f1 buy?',
        options: ['A whole extra clock period for f0 to resolve: the failure interval is multiplied by about e^(T/τ)', 'A cleaner copy of d: f1 filters out the glitches', 'Twice the speed: two flip-flops in a row sample twice per period', 'Nothing for the failure rate, only an extra cycle of delay'],
        answer: 0,
        explain: 'The chance that the first flip-flop is still undecided after t falls as e^(−t/τ). A second flip-flop gives it a period more, at the price of a cycle of latency.',
        why: ['', 'f1 does not filter: it repeats f0 a period later, undecided or not. What changes is the chance that f0 is still undecided at that moment.', 'Both flip-flops sample on the same edge; the second just samples what the first held a period ago.', 'The delay is the price; the failure interval is what it buys, and the exponent makes it enormous.'],
      },
      why: 'The exponent is time. One extra period turns a failure in days into one in millions of years.',
      whyNot: { text: 'A third flip-flop is another factor e^(T/τ) for another cycle of latency: no use at this clock, where two already beat the requirement by orders of magnitude.' },
    },
  ],
  l_uarttx: [
    {
      title: 'The frame in a shift register',
      text: 'sh is a 10-bit universal shift register. u21 builds the frame {stop = 1, the eight bits of din, start = 0} for the parallel load; u0 and u1 are the constants 1 and 0. Shifting one place right puts the next bit at the bottom, least significant first.',
      parts: ['u0', 'u1', 'u21', 'sh'], codex: ['edge'],
      why: 'The frame is a fixed pattern around the data, so it is loaded whole and then shifted out. The shift register is the serializer.',
      whyNot: { text: 'A multiplexer choosing among ten bits with a counter is smaller than ten flip-flops, but the flip-flops are already in the shift register, and the shift needs no select logic.' },
    },
    {
      title: 'Ticks and bits',
      text: 'tc counts ticks in a bit (0 to 15), bc counts bits sent (0 to 9). Each is a 4-bit register reloaded with zero at load and incremented by its own incrementer when it steps: u10 and u13 add 1, u9 is the zero, u11 and u14 choose, u12 and u15 are the enables. u5 and u6 split the counters into bits.',
      parts: ['tc', 'bc', 'u5', 'u6', 'u9', 'u10', 'u11', 'u12', 'u13', 'u14', 'u15'], codex: ['edge'],
      why: 'A bit is 16 ticks, a frame 10 bits: two small counters, and no counter wider than it needs to be.',
      whyNot: { text: 'One 8-bit counter of ticks with a decoder for the bit boundaries is the same flip-flops with a harder decode.' },
    },
    {
      title: 'Accepting a byte',
      text: 'busy is a flip-flop. load = go AND NOT busy (u2, u3): the byte is accepted, and taken is load itself. step = busy AND tick (u4): the frame advances only on a tick.',
      parts: ['busy', 'u2', 'u3', 'u4'], codex: ['handshake'],
      ask: {
        question: 'The sender keeps go high while a frame is on the line. What must happen to the byte on din?',
        options: ['Nothing: load needs busy = 0, so the new byte waits until the frame is over', 'It overwrites the frame in progress at once', 'It is queued in a second register', 'The frame restarts from its start bit'],
        answer: 0,
        explain: 'load = go · ¬busy. While busy = 1 the shift register and counters are untouched, so a go during a frame is ignored and the sender sees that it was not taken.',
        why: ['', 'Overwriting would cut the frame short and put a bit of two different bytes on the line.', 'There is no second register: a UART transmitter has one frame register, and the FIFO in front of it holds the queue.', 'Restarting would need load to ignore busy, and the start bit would repeat.'],
      },
      why: 'The handshake is one AND with the busy flag: taken is 1 in exactly the cycle a byte is accepted.',
      whyNot: { text: 'Accepting while busy needs a second register. The FIFO of chapter 43 does exactly that, in front of the transmitter.' },
    },
    {
      title: 'The last tick of the last bit',
      text: 'last = step AND tc = 15 (u7, an AND of step and the four tick bits); end = last AND bc = 9 (u8: bits 3 and 0 set, and nothing counts past 9). u16 inverts end and u17 ANDs it with busy; u18 sets busy on load and keeps it until the end.',
      parts: ['u7', 'u8', 'u16', 'u17', 'u18'], codex: ['handshake'],
      why: 'busy has to fall in the tick that finishes the stop bit, not before: busy is the line\'s "frame in progress".',
      whyNot: { text: 'Clearing busy when bc reaches 9 would end the stop bit after one tick instead of sixteen.' },
    },
    {
      title: 'Shift at the end of each bit',
      text: 'The shift register loads at load and shifts at the last tick of a bit: u19 = load OR last, merged with load into the 2-bit mode (u20): 00 holds, 01 shifts, 11 loads.',
      parts: ['u19', 'u20'], codex: ['edge'],
      why: 'The mode is two bits: one says move, the other says load.',
      whyNot: { text: 'Shifting on every tick would make each bit one tick long.' },
    },
    {
      title: 'The line',
      text: 'ntx holds the inverse of the line, so that the reset state (all zeros) is idle: u22 takes the bit that has just reached the bottom of the register, u23 inverts it into ntx.d, ntx loads on a step, and u24 inverts it back to tx. The line moves only on a tick, so a bit lasts exactly 16 ticks at any divisor.',
      parts: ['u22', 'u23', 'ntx', 'u24'], codex: ['edge'],
      why: 'A flip-flop on the line keeps tx glitch-free: it changes once, at a tick edge, never in the middle of a decode.',
      whyNot: { text: 'Driving tx straight from the shift register would put the register\'s settling glitches on the line.' },
    },
  ],
  l_uartrx: [
    {
      title: 'Seeing the line',
      text: 'rx is asynchronous. u1 inverts it, so that the idle line reads 0 after reset, and sy, the two-flop synchronizer of the level before, makes it safe: lo is 1 while the line is low. u0 is the constant zero used below.',
      parts: ['u0', 'u1', 'sy'], codex: ['edge'],
      why: 'Everything after this point is a state machine on one clock; the line crosses clocks exactly once, here.',
      whyNot: { text: 'Using rx directly is a failure once in a while, as the synchronizer level showed, and the receiver\'s own tick count cannot repair it.' },
    },
    {
      title: 'State and counters',
      text: 'st (3 bits) holds idle, start, data, stop or break; dec makes it one-hot. tc counts ticks (0 to 15), bc counts data bits (0 to 7). u3 and u4 split the counters into bits.',
      parts: ['st', 'dec', 'tc', 'bc', 'u3', 'u4'], codex: ['edge'],
      why: 'Five states and two counters: the receiver is a small sequencer, not a pile of special cases.',
      whyNot: { text: 'A single counter of ticks across the whole frame needs 8 bits and a comparator per sample point; this one resets at each event.' },
    },
    {
      title: 'Where in the bit',
      text: 'tc = 7 (u6, u7: not bit 3 and bits 2, 1, 0 all 1) is the middle of the start bit; tc = 15 (u8) is a whole bit later; bc = 7 (u9) is the last data bit. u5 is the line high (not lo).',
      parts: ['u5', 'u6', 'u7', 'u8', 'u9'], codex: ['edge'],
      why: 'The count restarts at the middle of the start bit, so 15 more ticks later is the middle of the first data bit, and every 16 after it.',
      whyNot: { text: 'Sampling at the start edge\'s tick plus 16 would sample on the edge between bits, where noise and clock error decide the value.' },
    },
    {
      title: 'Events',
      text: 'detect: a tick in idle with the line low (u10). mid: tc = 7 in the start state (u11), midOk: the line still low (u12). samp: a tick in data at tc = 15 (u13), lastd: that is the last bit (u14). stp: the stop sample (u15), good: the line is high (u16), bad: it is low (u17). brkEnd: a tick in break once the line is high (u18).',
      parts: ['u10', 'u11', 'u12', 'u13', 'u14', 'u15', 'u16', 'u17', 'u18'], codex: ['edge'],
      ask: {
        question: 'A glitch holds the idle line low for 3 ticks, then it is high again. What stops the receiver from pushing a byte?',
        options: ['In the middle of the start bit, 7 ticks later, the line is high again: midOk is 0 and the receiver returns to idle', 'The stop bit check: the glitch has no stop bit, so push never fires', 'The synchronizer filters any pulse shorter than a bit', 'ferr is raised and the byte is discarded'],
        answer: 0,
        explain: 'detect starts the count, but only midOk (the line still low at tc = 7) moves the machine on to the data bits. A pulse shorter than half a bit never reaches it.',
        why: ['', 'A glitch that did pass the middle check would then be checked at the stop bit and give a framing error; the middle check is what rejects it without any error.', 'The two flip-flops only make the line safe to sample; they delay it by two cycles and filter nothing.', 'ferr is for a frame whose stop bit is 0. A false start is not a frame at all and raises nothing.'],
      },
      why: 'Every decision is a tick, a state and a line level ANDed: nine ANDs say what is happening at this tick.',
      whyNot: { text: 'Deciding all this inside the state register\'s next-state logic gives the same gates, but hides which condition each arc waits for.' },
    },
    {
      title: 'Next state',
      text: 'Any event changes the state: u19 ORs detect, mid, lastd, stp and brkEnd into the register enable. u20 and u21 build the next state\'s low bits (detect or last data bit; midOk or last data bit), bad is its top bit (break); u22 merges them.',
      parts: ['u19', 'u20', 'u21', 'u22'], codex: ['edge'],
      why: 'The state codes are chosen so that each next state is an OR of few events: no table is needed.',
      whyNot: { text: 'A ROM of next states is a bigger circuit than five ORs.' },
    },
    {
      title: 'Counting',
      text: 'tc restarts at detect and at midOk and otherwise counts ticks (u23 adds one, u24 is zero, u25 ORs the two restart events, u26 chooses). bc restarts at midOk and counts at each sample (u27, u28, u29, u30 as the enable).',
      parts: ['u23', 'u24', 'u25', 'u26', 'u27', 'u28', 'u29', 'u30'], codex: ['edge'],
      why: 'Restarting tc at the start edge re-aligns the receiver to the sender\'s clock, frame by frame. That is why 5% of error does not accumulate.',
      whyNot: { text: 'A free-running tick counter would need a sender within a fraction of a tick over the whole frame.' },
    },
    {
      title: 'The byte and busy',
      text: 'sr is an 8-bit shift register that shifts right at each sample, taking the line (as 1 when high) in at the top: after eight samples the first bit sent is at the bottom. u31 is its mode, u2 its unused parallel input. busy is not idle (u32).',
      parts: ['u2', 'sr', 'u31', 'u32'], codex: ['edge'],
      why: 'Least significant bit first means a right shift: after eight shifts the first bit has travelled to bit 0.',
      whyNot: { text: 'Writing each bit into its own flip-flop by a decoder is a register with enables and a decoder; the shift register is that without the decoder.' },
    },
  ],
};
