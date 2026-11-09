// Act 12's build levels (Links, roadmap Phase 21 g): relays as repeaters and selectors, the synchronizer, a UART's two halves,
// an I²C controller, CRC-32, the 8b/10b encoder and clock recovery, each against the far end of its link on a bench
// (commcheck.ts). The reference answers are chapters telegraph–modem's library circuits drawn as chips. No DOM.

import type { BuildChallenge, PinSpec } from '../editor/challenges';
import { docFromDef } from '../editor/fromdef';
import type { ChipDoc, PartRef } from '../editor/model';
import { syncN } from '../lib/sync';
import { crcNext, crcUnit } from '../lib/crc';
import { countStage, DIAL_SELECTOR, TELEGRAPH_RELAY } from '../lib/telegraph';
import { RELAY_RULE } from './buildr';
import { i2cController } from '../lib/i2c';
import { CDR, CDR_CTL, ENC34, ENC56, ENC8B10B } from '../lib/serdes';
import { UART_RX, UART_TX } from '../lib/uart';
import { ethMacFd, fwdPath, swBrain } from '../lib/ethlevels';
import { FWD_LANES, PORT_UP, runFwd } from './fwdcheck';
import { netlistOf } from '../sim/types';
import type { ComponentDef } from '../sim/types';
import { MAC_BIT, MAC_GAP, MAC_RX_LANES, MAC_TX_LANES, runMac, runSwitch, SWITCH_LANES } from './ethcheck';
import { DIALLED, runDial, LINE_KM, LINE_SECTION_KM, LINE_VOLTS, repeaterProblems, I2C_SCENARIOS, run8b10b, runI2c, runCdr, CDR_SCENARIOS, runCrc, runSync, runUartRx, runUartTx, RX_SCENARIOS, SYNC_PORT, TX_CASES } from './commcheck';
import { numOf } from '../chapters/order';

export const pinsOf = (def: ComponentDef): PinSpec[] => def.ports.map((p) => ({ name: p.name, dir: p.dir === 'out' ? 'out' : 'in', width: p.width, ...(p.clock ? { clock: true } : {}) }));

/** The controller's Rtl blocks (decode, sequencer, shifter …): sub-chips of its drawing. */
export const i2cBlocks = (): ComponentDef[] => (netlistOf(i2cController())?.instances ?? []).map((i) => i.def).filter((d) => d.id.startsWith('i2c_controller_'));

const answers = new Map<string, ChipDoc[]>();
/** A reference answer: the top def drawn as a chip, and `subs` (def → chip) drawn as chips it places. */
export const refOf = (id: string, def: () => ComponentDef, name: string, subs: () => [ComponentDef, string][] = () => []) => (): ChipDoc[] => {
  let a = answers.get(id);
  if (a) return a;
  const chips = new Map(subs().map(([d, n], i) => [d, { id: `u_ref_cp_${id}_${i}`, name: `${n} ref` }]));
  const refOfDef = (d: ComponentDef): PartRef | undefined => (chips.has(d) ? { chip: chips.get(d)!.id } : undefined);
  const docs: ChipDoc[] = [];
  for (const [d, c] of chips) {
    const doc = docFromDef(d, { ...c, refOf: refOfDef });
    if ('error' in doc) throw new Error(`reference ${id} (${d.id}): ${doc.error}`);
    docs.push({ ...doc, notes: `Part of the reference answer. ${d.summary ?? ''}`.trim() });
  }
  const top = docFromDef(def(), { id: `u_ref_cp_${id}`, name: `${name} ref`, refOf: refOfDef });
  if ('error' in top) throw new Error(`reference ${id}: ${top.error}`);
  answers.set(id, (a = [...docs, { ...top, notes: `Reference answer. ${def().summary ?? ''}`.trim() }]));
  return a;
};

export const CRC_UNIT = (): ComponentDef => crcUnit(32, undefined, 8);
export const CRC_NEXT = (): ComponentDef => crcNext(32, undefined, 8);
/** The library ids the CRC reference is drawn from, its XOR network's gates included (the network itself is what the level builds). */
export const crcGives = (): string[] => [...new Set([...(netlistOf(CRC_UNIT())?.instances ?? []), ...(netlistOf(CRC_NEXT())?.instances ?? [])].map((i) => i.def.id).filter((id) => id !== CRC_NEXT().id))];

/** The library ids a reference is drawn from, its sub-chips' parts included (the sub-chips themselves are what the level builds). */
export const leafGives = (def: () => ComponentDef, subs: () => ComponentDef[]) => (): string[] => {
  const skip = new Set(subs().map((d) => d.id));
  return [...new Set([def(), ...subs()].flatMap((d) => netlistOf(d)?.instances ?? []).map((i) => i.def.id).filter((id) => !skip.has(id)))];
};

/** Every box of an Rtl-built reference below its top (the scopes), as (def, name) for refOf: they are drawn as chips of their own. */
export const rtlBoxes = (top: ComponentDef, prefix: string): [ComponentDef, string][] => {
  const seen = new Map<string, ComponentDef>();
  const walk = (d: ComponentDef) => { for (const i of netlistOf(d)?.instances ?? []) if (i.def.id.startsWith(prefix) && !seen.has(i.def.id)) { seen.set(i.def.id, i.def); walk(i.def); } };
  walk(top);
  return [...seen.values()].map((d) => [d, d.name ?? d.id] as [ComponentDef, string]);
};

export const SYNC_REF = (): ComponentDef => syncN(2);

export const BUILDCOMM: Record<string, () => BuildChallenge> = {
  l_sync: () => ({
    id: 'l_sync', title: 'Synchronizer', level: 'sequential', allowed: 'nand',
    brief: `<b>d</b> comes from another clock domain and changes whenever it likes; <b>clk</b> is this domain's. Deliver it as <b>q</b>, the same signal some whole number of cycles later, for pulses of 3 cycles and up. The port is a ${SYNC_PORT.fclk / 1e9} GHz receiver; d changes up to ${SYNC_PORT.fdata / 1e6} million times a second, and ${SYNC_PORT.downstream} NAND delays of logic read q. `
      + `The bench does not race the gates (a gate-level simulation has no metastability): it counts the flip-flops from the latency and the logic you put between them, and computes the failure rate from the resolution time the first one gets (e<sup>t<sub>r</sub>/τ</sup> / (T0 · f<sub>clk</sub> · f<sub>data</sub>)). It must fail less than once in ${SYNC_PORT.years} years. Graded on latency (cycles).`,
    ports: pinsOf(SYNC_REF()),
    check: { kind: 'custom', describe: 'Eight pulse trains on d (runs of 3 to 8 cycles): q must be d delayed by one fixed whole number of cycles, never the same cycle; then the failure rate of that many flip-flops with the logic inside the chain, at the port\'s clock and data rates, against 100 years.', run: runSync },
    answer: refOf('l_sync', SYNC_REF, 'Synchronizer'),
  }),
  l_uarttx: () => ({
    id: 'l_uarttx', title: 'UART transmitter', level: 'sequential', allowed: 'nand',
    brief: 'A byte in, a frame out. The baud generator is not part of this level: the bench supplies <b>tick</b>, high one clock in every <i>div</i>, and tries only div = ' + TX_CASES.map((k) => k.div).join(', ') + ' (your transmitter has no divisor input of its own), and a bit lasts 16 ticks. '
      + 'With <b>go</b> = 1 while <b>busy</b> = 0 the byte on <b>din</b> is accepted, and <b>taken</b> is 1 in that very cycle. Then tx carries a frame: the start bit (0), the eight data bits least significant first, the stop bit (1), each exactly 16 ticks long, the line changing only on a tick; it idles at 1. <b>busy</b> is 1 while the frame is on the line, and a go while it is 1 must be ignored. '
      + 'The far end counts clocks: it names the first bit that is the wrong level or the wrong length, at each of those divisors.',
    ports: pinsOf(UART_TX),
    check: { kind: 'custom', describe: `Two bytes at each of ${TX_CASES.length} divisors, with a go in the middle of the first frame that must be ignored and the second byte offered as soon as busy falls: taken, every bit's level and length, busy.`, run: runUartTx },
    answer: refOf('l_uarttx', () => UART_TX, 'UART transmitter'),
  }),
  l_uartrx: () => ({
    id: 'l_uartrx', title: 'UART receiver', level: 'sequential', allowed: 'nand',
    brief: '<b>rx</b> carries frames from a sender whose clock is not yours, and <b>tick</b>, supplied by the bench (there is no baud generator in this level), is high one clock in every <i>div</i>, tried at div = 1 and 3 only; 16 ticks make a nominal bit. A low on rx at a tick may be the start of a frame. Confirm it in the middle of the start bit (a glitch is not a frame), then sample a bit every 16 ticks: eight data bits, least significant first, into <b>data</b>, and a ninth sample for the stop bit. '
      + 'A stop of 1 gives <b>push</b> for one clock with the byte on data; a stop of 0 gives <b>ferr</b> for one clock and no push, and the receiver waits for the line to go high (a break is one error, not a stream of zero bytes). <b>busy</b> is 0 when it is idle. rx is asynchronous. '
      + 'Be back to idle in the middle of the stop bit: the next start edge may come early. The far end is a sender up to 4% fast or slow, with its start edge anywhere between two ticks.',
    ports: pinsOf(UART_RX).filter((p) => p.name !== 'state'),
    check: { kind: 'custom', describe: `${RX_SCENARIOS.length} lines: back-to-back frames, gaps, senders 2 to 4% fast and slow, glitches of a few ticks on an idle line, a framing error and a break: every byte pushed once and in order, ferr counted, busy.`, run: runUartRx },
    answer: refOf('l_uartrx', () => UART_RX, 'UART receiver'),
  }),
  l_crc: () => ({
    id: 'l_crc', title: 'CRC-32', level: 'sequential', allowed: 'nand',
    brief: 'The check at the end of an Ethernet frame. A register of 32 flip-flops holds the running remainder, <b>q</b>. <b>init</b> = 1 loads all ones at the next clock, whatever <b>en</b> says; with <b>en</b> = 1 each clock takes one byte on <b>d</b>, the first bit sent in d[0], through the generator 0xEDB88320 (the reflected form of 0x04C11DB7: each bit is a right shift, and a 1 shifted out XORs the generator in); with en = 0 it holds. '
      + '<b>fcs</b> is the complement of q: the check sequence as it goes on the wire, least significant byte first. After a frame and its own FCS, q is the constant 0xDEBB20E3. The far end is a sender: it checks q after every clock against a model, then appends the FCS of each frame and checks the residue. A byte is eight bit steps in one clock: build one bit step as a chip, or find which inputs each output bit is the XOR of.',
    ports: pinsOf(CRC_UNIT()),
    check: { kind: 'custom', describe: '16 frames (the check string "123456789", an empty frame, seeded frames of 1 to 24 bytes) with idle clocks that must be ignored and an init beating en: q after every clock, fcs = ~q, and the residue after each frame and its FCS.', run: runCrc },
    answer: refOf('l_crc', CRC_UNIT, 'CRC-32 byte unit', () => [[CRC_NEXT(), 'CRC-32 next state']]),
  }),
  l_8b10b: () => ({
    id: 'l_8b10b', title: '8b/10b encoder', level: 'sequential', allowed: 'nand',
    brief: 'A byte <b>d</b> (or, with <b>k</b> = 1, one of the twelve control codes) and the running disparity <b>rd</b> (0: more zeros sent so far, 1: more ones) become ten bits <b>code</b>, a first (bit 9), and <b>rdout</b>, the disparity after. The line must stay balanced: after every symbol the ones sent exceed the zeros by at most one, or the zeros the ones, with a 6-bit block and a 4-bit block each balanced or off by two in the direction that pulls back; and no more than five equal bits in a row, so the receiver can find the clock. '
      + 'The far end is a decoder that follows the running disparity: it checks every one of the 256 data bytes and 12 control codes at both disparities, then 32 streams of 40 symbols with rdout fed back.',
    ports: pinsOf(ENC8B10B),
    check: { kind: 'custom', describe: '268 symbols at both disparities (the sub-blocks stay within ±1, no run over five, rdout right, the symbol decodes to its byte), then 32 seeded streams with rdout fed back (the line\'s disparity and runs across symbols).', run: run8b10b },
    answer: refOf('l_8b10b', () => ENC8B10B, '8b/10b encoder', () => [[ENC56, '5b/6b encoder'], [ENC34, '3b/4b encoder']]),
  }),
  l_cdr: () => ({
    id: 'l_cdr', title: 'Clock recovery', level: 'sequential', allowed: 'nand',
    brief: 'The line <b>rxd</b> carries an 8b/10b stream at four clock cycles a bit, from a sender whose clock is not yours: up to 2.5% fast or slow, and drifting while it runs. Nothing else arrives with it. Take a sample of the line every cycle, and raise <b>strobe</b> once a bit, at the moment <b>bit</b> (the newest sample) is the middle of a bit cell. '
      + 'The transitions in the data are the clock: compare the samples around an edge (an early or late vote, the Alexander detector), filter the votes (four the same way) and only then move the strobe by one sample. The far end sends ' + CDR_SCENARIOS.length + ' streams and checks that, after 100 bits of lock-in, the bits taken at the strobe are the bits sent, none twice and none lost.',
    ports: pinsOf(CDR).filter((p) => ['rxd', 'clk', 'bit', 'strobe'].includes(p.name)),
    check: { kind: 'custom', describe: CDR_SCENARIOS.length + ' streams of about 1700 bits (a comma every eighth word): nominal, 1.5% fast, 1.5% slow, drifting to 2.5% either way, and a drift that changes sign: strobes about every 4 cycles, then every bit equal to the one sent.', run: runCdr },
    answer: refOf('l_cdr', () => CDR, 'Clock recovery', () => [[CDR_CTL, 'Strobe counter and vote filter']]),
  }),
  l_i2c: () => ({
    id: 'l_i2c', title: 'I²C controller', level: 'sequential', allowed: 'nand',
    brief: `Two wires, any number of devices, each pulling a line low and never driving it high: a line is 1 only if nobody pulls it. <b>sda_o</b> = 1 pulls SDA to ground (an open-drain pad: the NMOS of chapter ${numOf('spi')}), 0 lets go; <b>sda_i</b> and <b>scl_i</b> are the wires read back. The pad is not part of this level: the bench is the wire (a JavaScript model of the wired AND, not a switch-level circuit), a target (a four-register device model) and, in some tests, a rival controller model; your controller is gates and sees the wire only through sda_i and scl_i. `
      + 'One command at a time: <b>go</b> with <b>cmd</b> (0 START, 1 WRITE a byte and read the ACK, 2 READ a byte, 3 STOP) and <b>din</b> (the byte; for a READ, din[0] = 1 sends NACK instead of ACK). <b>ready</b> is 1 when idle and 0 from the clock after go until the command is over. A command is bit cells of four phases of two clocks each: 0 SCL pulled low and SDA set, 1 SCL released (and the cell waits here until SCL really reads high: the target or another controller may stretch it), 2 SCL high, SDA sampled at its end, 3 SCL pulled low again. START and STOP are one cell; a byte is eight cells and a ninth for the acknowledge, most significant bit first. '
      + '<b>ack</b> = 1 if the target answered a WRITE; <b>dout</b> is the byte read; <b>lost</b> = 1 when you let go of SDA (sent a 1) and read a 0 in the same cell: arbitration is lost, and both lines must be released at once, so that the winner\'s frame goes on unharmed. The bench runs the golden controller beside yours, clock by clock, and names the first line that differs.',
    ports: pinsOf(i2cController()),
    check: { kind: 'custom', describe: I2C_SCENARIOS.length + ' sessions against a target and a wired-AND bus: write and read back with a repeated START, an address nobody has, a target that stretches SCL, and a rival controller started together with you, which you lose at four address bits and win at two. Every output after every clock.', run: runI2c },
    answer: refOf('l_i2c', i2cController, 'I²C controller', () => i2cBlocks().map((d) => [d, d.name] as [ComponentDef, string])),
  }),
  l_mac: () => ({
    id: 'l_mac', title: 'Ethernet MAC', level: 'sequential', allowed: 'nand',
    brief: 'The sending and receiving halves of a full-duplex Ethernet link. <b>Sending</b>: a frame arrives as a byte stream (<b>data</b>, <b>valid</b>, <b>last</b>; a byte moves at a clock where valid and <b>ready</b> are both 1; the frame runs from the destination address to its last payload byte). It goes out on <b>txd</b> with <b>txen</b> high for exactly the frame: seven bytes of 0x55, the start-of-frame delimiter 0xD5, the stream\'s bytes, zero padding up to 60 bytes, then the four bytes of FCS (the complement of the CRC-32 you built, least significant byte first). Each byte goes least significant bit first, each bit lasts ' + MAC_BIT + ' clocks, and the line stays quiet for 96 bit times (' + MAC_GAP + ' clocks) between frames. '
      + '<b>Receiving</b>: <b>rxd</b> carries the same, with <b>crs</b> high while a frame is on the wire; find the SFD in the stream of bits whatever the length of the preamble, and give the frame\'s bytes without preamble, SFD and FCS on <b>rdata</b> / <b>rvalid</b>, <b>rlast</b> on its last byte, and <b>rerr</b> = 1 with it if the frame is to be thrown away (the bytes cannot be taken back once they have gone out: err comes with the last). A frame is good when the CRC-32 register over destination to FCS holds 0xDEBB20E3 and it is at least 64 bytes with the FCS. '
      + 'The bench does not model a cable: the far end is a JavaScript receiver that decodes your txd a bit at a time and names the first field that is wrong, and a sender of good, damaged and awkward frames (short preambles, payloads of 0xD5, a frame after one whose FCS ends in 0xAA or 0xAB). Carrier sense and collisions are not part of this level (a full-duplex link has neither).',
    ports: pinsOf(ethMacFd()),
    check: { kind: 'custom', describe: MAC_TX_LANES.length + ' sending scenarios (frames from 14 to 160 bytes before the pad, back to back: preamble, SFD, bytes, pad, FCS, bit lengths, the gap) and ' + MAC_RX_LANES.length + ' receiving ones (good frames, a flipped data bit, a flipped FCS bit, a runt, short preambles, a frame after FCS bytes of 0xAA and 0xAB, payloads that look like the SFD): bytes, last and err.', run: runMac },
    answer: refOf('l_mac', ethMacFd, 'Ethernet MAC', () => rtlBoxes(ethMacFd(), 'eth_mac_')),
  }),
  l_switch: () => ({
    id: 'l_switch', title: 'Learning switch', level: 'sequential', allowed: 'nand',
    brief: 'The brain of a four-port switch: frames arrive on <b>inport</b> (0 to 3) with a source and a destination station number (8 bits each; 0xFF means everyone) and <b>bad</b> = 1 if the MAC found their FCS wrong. For one clock <b>go</b> is 1 with the frame\'s header; in that same clock edge <b>mask</b> (a bit per output port) and <b>ovalid</b> = 1 must show where the frame goes, and with go = 0 both read 0. '
      + 'The rules: a frame goes to the port its destination was last heard from, and only there; to every port but the input if the destination is a broadcast or has never been heard (<i>flooding</i>); to none if the destination is on the port it came in on (the segment behind that port already has it) and to none if bad = 1. A good frame teaches the table where its source is (a host that moves is found at its new port; a bad frame teaches nothing; 0xFF is never learned), and the lookup uses the table as it was before this frame. The table holds four hosts; a fifth overwrites the oldest entry. '
      + `The bench is a JavaScript model of the same table and of who is on which port; a real switch has 48-bit addresses in a hashed RAM (chapter ${numOf('switch')}), here station numbers keep the table small enough to draw as gates. The far end names the first frame whose output set is wrong and the rule it breaks.`,
    ports: pinsOf(swBrain()),
    check: { kind: 'custom', describe: SWITCH_LANES.length + ' traffic scripts of up to 60 frames: hosts announcing themselves, every pair talking, a host nobody has heard, two hosts behind one port, a host that moves, damaged frames, the broadcast address as a source, a fifth host, a frame to its own sender, frames on consecutive clocks and random traffic: the output set after every go, against the model.', run: runSwitch },
    answer: refOf('l_switch', swBrain, 'Learning switch', () => rtlBoxes(swBrain(), 'sw_brain_')),
  }),
  l_fwd: () => ({
    id: 'l_fwd', title: 'Forwarding path', level: 'sequential', allowed: 'nand',
    brief: 'The decision at the heart of a router. <b>Routes</b>: four slots, each written with <b>we</b> and <b>slot</b>: <b>prefix</b> (32 bits), <b>bytes</b> (how many of its leading bytes count, 0 to 4: /0, /8, /16, /24, /32) and <b>port_in</b>. The table starts empty. '
      + '<b>A header</b>: with <b>go</b> for one clock come its <b>dst</b>, <b>ttl</b> and <b>check</b> (the checksum field), and <b>bad</b> = 1 if the checksum failed. In the next clock <b>ovalid</b> = 1 and <b>act</b> says what to do: 0 drop, 1 forward, 2 up to the slow path. The order is the order a frame can fail: a bad header is dropped (<b>port</b> 0); a TTL of 0 or 1 goes up; then the <i>longest</i> prefix that matches gives the port, and no match, or port ' + PORT_UP + ' (the router itself), goes up (port ' + PORT_UP + '). '
      + 'Forwarded, <b>ttl_o</b> is one lower and <b>check_o</b> the new checksum, without summing the header again (RFC 1624): complement the old one, add 0xFEFF, bring the carry out of the top round to the bottom, complement again. Lowering the TTL lowers one word by 0x0100, and that addition is what it comes to. '
      + `Two routes alike (the same leading bytes and length) are never in the table. The bench is a model of the table, and it sums each whole header again for the checksum it expects. A real router holds a million routes, in a trie or a TCAM (chapter ${numOf('router')}); four keep this one small enough to draw.`,
    ports: pinsOf(fwdPath()),
    check: { kind: 'custom', describe: FWD_LANES.length + ' scripts of routes and headers: an empty table, nested prefixes in either order, a default route, a slot rewritten, the router\'s own address, TTLs of 0, 1, 2 and 255, checksums that carry round and the one RFC 1624 corrects, bad headers, a header every clock, and random traffic.', run: runFwd },
    answer: refOf('l_fwd', fwdPath, 'Forwarding decision', () => rtlBoxes(fwdPath(), 'fwd_path_')),
  }),
  l_repeater: () => ({
    id: 'l_repeater', title: 'Relay repeater', level: 'transistors', allowed: RELAY_RULE,
    brief: 'A telegraph line ' + LINE_KM + ' km long, a ' + LINE_VOLTS + ' V battery at the key and a relay coil at the far end. One battery drives ' + LINE_SECTION_KM + ' km of iron wire to a coil with margin to spare and ' + LINE_KM + ' km with none: the current is below the relay\'s pull-in and the sounder stays silent. You build the station half way: <b>line</b> is the end of the first section (a coil\'s worth of current at best), <b>out</b> the start of the second. '
      + 'out must follow line one relay step later, at full strength: from a battery of your own (VDD), through a contact. The bench is the line on both sides and the sounder; it checks the sections as well as the logic: out may share no wire or contact with line, or the weak signal travels on and the second section is ' + LINE_KM + ' km. An open output reads 0 here: end out on a load. Graded in relays and relay steps.',
    ports: pinsOf(TELEGRAPH_RELAY), check: { kind: 'table', spec: ([a]) => [a] }, rules: repeaterProblems,
    answer: refOf('l_repeater', () => TELEGRAPH_RELAY, 'Relay repeater'),
  }),
  l_dial: () => ({
    id: 'l_dial', title: 'Dial selector', level: 'transistors', allowed: RELAY_RULE,
    brief: 'A caller dials by opening the loop: <b>pulse</b> is that loop contact, 1 for the length of each pulse and 0 between them. After n pulses the caller\'s <b>line</b> must be connected to output n of eight: <b>y</b> is the eight output lines, and y bit n carries the line while the selector stands on n (the others end on loads and read 0). <b>count</b> is the number of pulses so far. '
      + 'The step is taken when a pulse <i>falls</i>, however long it lasted, and nothing may move while it is up. <b>hangup</b> = 1 releases everything: the count is back at 0 and the line on output 0. The bench dials ' + DIALLED.join(', ') + ' in turn, a hang-up after each, and names the first pulse after which the selector is not where it should be. Relays and loads only; graded in relays and relay steps.',
    ports: pinsOf(DIAL_SELECTOR), check: { kind: 'custom', describe: 'Dials ' + DIALLED.join(', ') + ', each pulse checked up and down (count and y), the line dropped and raised, a hang-up after each number.', run: runDial },
    answer: refOf('l_dial', () => DIAL_SELECTOR, 'Dial selector', () => [[countStage(1), 'Toggle stage, 1 tree pole'], [countStage(2), 'Toggle stage, 2 tree poles'], [countStage(4), 'Toggle stage, 4 tree poles']]),
  }),
};
