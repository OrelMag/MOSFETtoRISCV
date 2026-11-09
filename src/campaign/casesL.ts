// Level cases, act 12 (Links). See cases.ts. The numbers are measured on the reference designs (sim/stats, static timing, the
// benches' own models). No DOM.

import type { LevelCase } from './cases';
import { numOf } from '../chapters/order';
import { margin, PULL_I, REPEATER_SECTION_KM as SEC, SOUNDER_R } from '../phys/telegraph';

export const CASESL: Record<string, LevelCase> = {
  l_sync: {
    problem: 'Two clocks that are not the same crystal have every phase between them. A signal from the other domain can change within a flip-flop\'s setup-and-hold window, and then the flip-flop goes metastable: neither 0 nor 1 for a time that has no upper bound, only a probability. At 1.6 GHz with data changing at 160 MHz a window of 25 ps is hit ten million times a second.',
    without: 'With one flip-flop read by 8 NAND delays of logic, the undecided level gets 275 ps to fall to a rail and the port fails about once in 1.6 days. Different gates reading it differently is how a metastable bit becomes a wrong state in a machine.',
    cost: `Two flip-flops, 22 NANDs and a cycle of latency buy about 2 million years. The asynchronous FIFO of chapter ${numOf('clocks')} is this two-flop synchronizer on each pointer.`,
    alts: [{ name: 'Two-flop synchronizer (library)', lib: 'sync2' }, { name: 'Three-flop synchronizer (library)', lib: 'sync3' }],
  },
  l_uarttx: {
    problem: 'A serial link has no clock wire. Sender and receiver agree beforehand on a bit time, and each byte travels in a frame the receiver can find: an idle line at 1, a start bit of 0 whose falling edge says "now", eight data bits least significant first, and a stop bit of 1 that gives the line time to return to idle before the next frame. The transmitter is the shift register that produces it, paced by a tick it does not make itself.',
    without: 'Without the frame there is no way to tell where a byte starts on a line that is idle for any length of time, and without the same bit length at both ends the receiver reads the wrong bit. A transmitter that restarts on a go during a frame puts a bit of one byte and a bit of the next on the line.',
    cost: '482 NANDs: a 10-bit shift register (the frame), two 4-bit counters (ticks in the bit, bits sent) and a busy flag. At 115 200 baud a frame is 87 µs, 11 520 bytes a second: 80% of the line\'s 115 200 bits are data bits.',
  },
  l_uartrx: {
    problem: 'The sender\'s clock is a different crystal, off by up to a few percent, and its start edge lands anywhere between two of the receiver\'s ticks. A receiver that samples every bit once at its own idea of the bit time drifts across the frame. Oversampling by 16 fixes both: the start edge is found to within 1/16 of a bit, the count restarts there, and every later sample sits near the middle of its bit.',
    without: 'Sampling at the edge of a bit decides the value by noise. A receiver that does not check the start bit again in its middle turns every glitch on an idle line into a byte; one that waits for a whole stop bit misses the next start edge when the sender is fast; a break read as a stream of 0x00 bytes floods the software.',
    cost: '526 NANDs against the transmitter\'s 482: a state register of five states, a tick counter, a bit counter, an 8-bit shift register and the two-flop synchronizer. With 16 ticks to a bit the receiver tolerates about 5% of clock error; at 8 ticks it would be about 10% worse.',
  },
  l_crc: {
    problem: 'A frame can cross a wire, a connector and a transceiver and arrive with a bit flipped. A parity bit catches one error in a byte; a CRC-32 appended to the frame catches every burst up to 32 bits and all but one in 4 294 967 296 of the rest. Ethernet\'s frame check sequence is exactly this: a register of 32 flip-flops and XORs, run once over the frame as it is sent and again over what arrives.',
    without: 'Without a check the receiver passes a corrupted frame up to software as if it were whole, and the damage shows as a wrong file or a wrong address much later. A software CRC on a 100 Mb/s link means one table lookup per byte, more than the processor can spare.',
    cost: '1027 NANDs for a byte a clock: 32 flip-flops with an init mux, the 32 XORs of the complement and a network of 72 shared XOR gates. The serial one-bit unit is 795 NANDs but takes eight clocks a byte; at the same clock a byte-wide unit is eight times the throughput for 29% more gates.',
    alts: [{ name: 'CRC-32, one bit a clock', lib: 'unitcrc32_EDB88320_1s' }],
  },
  l_8b10b: {
    problem: 'A serial link sends bits with no clock beside them, through transformers or capacitors that pass no DC. A long run of equal bits both starves the receiver\'s clock recovery of transitions and drifts the average level. 8b/10b sends every byte as ten bits so that the ones and zeros stay within one of each other and no run is longer than five. PCIe 1 and 2, SATA, Gigabit Ethernet, USB 3 and DisplayPort all use it; its twelve control codes include the commas that let a receiver find the symbol boundaries.',
    without: 'A byte stream of all zeros is a line held low. Without the code the receiver loses the clock; with a transformer the signal droops toward the middle and every bit after the first is misread.',
    cost: '1195 NANDs and 29 gate delays of combinational logic against a raw byte\'s zero: two tables and two XORs. The price on the wire is 25% of the bandwidth: 1.25 Gb/s of line for 1 Gb/s of data, where 64b/66b pays 3%.',
  },
  l_cdr: {
    problem: 'A serial link has no clock wire, and the sender\'s oscillator is a different crystal from the receiver\'s, tens of parts per million off and drifting with temperature. The receiver has to put its sampling instant in the middle of every bit, and keep it there. The transitions the code guarantees are the only information it has: each edge says where a bit boundary is.',
    without: 'A receiver that samples at a fixed rate from its own clock slips a bit every 1/ppm bits: at 100 ppm, one bit in ten thousand is read twice or lost, a link that would corrupt ten times a second at 1 Gb/s. A receiver that tries to follow every single edge instead jitters and samples at the boundary half the time.',
    cost: '487 NANDs: five sampling flip-flops, the early/late detector, a strobe counter and a four-vote filter. The loop follows a clock up to about 3% off, which is thousands of times what crystals give; the limit is the transition density of the code (8b/10b guarantees one in five bits).',
  },
  l_i2c: {
    problem: 'A board has a temperature sensor, an EEPROM, a clock chip and a display driver, and no pins to spare. I²C puts all of them on two wires with a pull-up resistor each. Every device pulls a line low and none pushes it high, so any number can share it and the wire is the AND of what they say. That same property gives a second controller its chance: both start together, each compares what it sent with what it reads, and the one that sent a 1 and read a 0 steps aside without a collision.',
    without: 'With push-pull outputs two controllers fighting over a line short the supply through each other. With a central arbiter a third wire is needed, and a controller that does not read back what it sends has no way to find out that it has lost.',
    cost: '659 NANDs for the controller, a few hundred more than the UART receiver\'s: a bit-cell sequencer with a stretch point, an 8-bit shift register and the compare that finds arbitration lost. The price on the wire is speed: the pull-up\'s rise time against the wire\'s capacitance caps a bus at 100 kHz to 1 MHz, a hundredth of what a push-pull link of the same wires would carry.',
  },
  l_fwd: {
    problem: 'A switch\'s table has a line per machine, learned by flooding, which no network the size of the internet could keep or survive. A router\'s has a line per network: an address has a shape, its leading bits name a network, and the longest prefix that matches says which way to send it. It decides for every packet, and it changes the packet as it goes, so that a loop in somebody\'s tables burns out in 255 hops.',
    without: 'First match instead of longest: a default route swallows everything. No TTL: one wrong table and a packet circles forever, and more follow. Summing the header again at each hop: it costs twenty bytes of adding per packet, where one addition does it, as long as it is RFC 1624\'s and not the older shortcut, which is wrong for one checksum in 65 536. A bad header answered: the address it would answer to is the part that cannot be trusted.',
    cost: `5 847 NANDs for four routes, nearly all of it 160 flip-flops and the comparisons. Matching every route at once is what a TCAM does, and it pays per route: chapter ${numOf('router')} walks a trie in RAM instead, one read per bit of the address, and its whole fast path is 4 214 NANDs of logic beside 836 585 of memory, which holds 1 024 nodes.`,
  },
  l_repeater: {
    problem: `A telegraph line weakens with its length: the current a battery drives through 4 mm iron wire and a coil falls as the wire gets longer, and below the coil's pull-in current (${(PULL_I * 1e3).toFixed(0)} mA for our ${SOUNDER_R} Ω main-line coil) the sounder stays silent. A ${SEC} km section on 24 V is fine with a margin of ${margin(24, SEC, 'iron').toFixed(2)}, ${2 * SEC} km is a margin of ${margin(24, 2 * SEC, 'iron').toFixed(2)}. A relay half way takes the weak current and closes a contact that puts a battery of its own on the next section.`,
    without: 'Without the repeater the line has to be shortened, or the voltage raised until the insulators break down, or the wire made thicker at a copper cost per kilometre. With one the line is unlimited: each station restarts the signal.',
    cost: 'One relay, one relay step (8.2 ms) of delay per station. A signal crosses n stations in n steps, and each one shortens a dot by a little: repeaters balanced their relays to make the two edges equal. A regenerator is also where a signal that was wrong gets repeated wrongly at full strength.',
  },
  l_dial: {
    problem: `An automatic exchange has to connect a caller to one of its lines when it hears a number: the dial opens the loop n times, and the exchange counts. Strowger's switch did it with a magnet, a ratchet and a contact wiper; the relay version counts the pulses in a chain of toggle stages and selects with contacts on the same relays. Chapter ${numOf('exchange')} builds it for eight lines; the real thing used ten and many ranks.`,
    without: 'Without the counter nothing remembers which pulse this is. Without the contact tree a decoder of gates, here relays, would turn the count into a selection and add a relay step.',
    cost: 'Ten relays: three toggle stages of three each and the hang-up relay. The tree is free, contacts on relays that exist anyway. The step costs a few relay steps of ripple: the fall of bit 0 clocks bit 1, whose fall clocks bit 2.',
  },
  l_mac: {
    problem: 'A wire carries bits; two machines need frames. The receiver must find where a frame starts in a stream that is idle for any length of time (a preamble of alternating bits and a delimiter), where it ends (the carrier falls) and whether it arrived whole (the CRC you built). The sender must pad a short frame, append the check and keep the line quiet between frames. The MAC is these rules in gates; software above it sees destination, source, type and payload.',
    without: 'Without the preamble the receiver has no bit clock; without the delimiter it cannot tell where the first byte is; without the check a frame with one flipped bit goes up as if it were whole; without the gap two frames run together. A receiver that does not clear its shift register between frames finds a delimiter in the tail of the last frame and reads the next one a bit off: about one frame in 128 on a clean link.',
    cost: '6 766 NANDs for both halves: 3 553 in the transmitter (1 107 of them the gap counter, backoff and LFSR a shared cable needs and this link mostly does not) and 3 213 in the receiver, each with a byte-wide CRC-32 unit of 1 027. At four clocks a bit the link carries 63 Mb/s.',
    alts: [{ name: 'CRC-32, a byte a clock (library)', lib: 'unitcrc32_EDB88320_8s' }],
  },
  l_switch: {
    problem: 'A hub repeats every frame to every port, so the network\'s capacity is one link\'s however many hosts there are. A switch sends a frame only where its destination is. It is not told: it learns, from the source address of every frame that passes, which port that host is on. A frame to a host it has not heard of is flooded once, a frame to a host on its own side is dropped, and a damaged frame goes nowhere.',
    without: 'A switch that floods a known destination is a hub. One that sends a frame back out of its own port echoes every frame to its sender. One that forwards a bad frame spreads the damage; one that learns from a bad frame can send traffic to the wrong port for as long as the entry stays.',
    cost: '1 426 NANDs for four hosts: four entries of eleven flip-flops, four 8-bit comparators for the lookup and four for the learning, a port decoder and the output flip-flops. A real switch holds thousands of 48-bit addresses in a hashed RAM; the rule it applies is this one.',
  },
};
