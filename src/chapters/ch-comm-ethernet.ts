import { CRC32_REFLECTED, CRC32_RESIDUE } from '../comm/crc';
import { FCS_BYTES, HEADER_BYTES, MAX_FRAME, MIN_FRAME, MIN_PAYLOAD, PREAMBLE, SFD } from '../comm/ethframe';
import {
  ATTEMPT_LIMIT, BACKOFF_LIMIT, BIT_CLOCKS, BYTE_CLOCKS, frameBitTimes, GAP_BITS, GAP_CLOCKS, JAM_BYTES, LINK_MBPS, maxCableMetres, SLOT_BITS, SLOT_CLOCKS,
} from '../comm/mac';
import { crcUnit, macRx, macTx } from '../lib';
import { stats } from '../sim/stats';
import { collisionWidget, minFrameWidget, segState, segmentScene, throughputWidget } from '../widgets/ethernet2';
import { csmaScene, frameWidget, rxScene, txScene } from '../widgets/ethernet';
import type { Chapter } from './types';

const nands = (d: Parameters<typeof stats>[0]): number => stats(d).nands;
const n0 = (x: number) => Math.round(x).toLocaleString('en').replace(/,/g, ' ');

const BITS_MIN = frameBitTimes(MIN_FRAME);
const US_BIT = 1 / LINK_MBPS;
const MIN_US = BITS_MIN * US_BIT, SLOT_US = SLOT_BITS * US_BIT, GAP_US = GAP_BITS * US_BIT;
const V = 0.66;
const KM10 = maxCableMetres(SLOT_BITS, V, 10), M100 = maxCableMetres(SLOT_BITS, V, 100), M1000 = maxCableMetres(SLOT_BITS, V, 1000);
const OURS_M = maxCableMetres(SLOT_BITS, V, LINK_MBPS);
const TX_N = nands(macTx()), RX_N = nands(macRx()), CRC_N = nands(crcUnit(32, CRC32_REFLECTED, 8));
const EFF_MIN = (8 * MIN_PAYLOAD) / (BITS_MIN + GAP_BITS);
const EFF_MAX = (8 * 1500) / (frameBitTimes(MAX_FRAME) + GAP_BITS);
const hex32 = (v: number) => `0x${(v >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;

export const chEthernet: Chapter = {
  id: 'ethernet', num: 48, title: 'Ethernet', level: 'Communication',
  blurb: 'Who talks now, and to whom: addresses and the FCS, a MAC in gates, collisions, binary exponential backoff, and why a minimum frame exists.',
  goals: [
    'lay out an Ethernet frame byte by byte, with its preamble, addresses, pad and FCS, and say what each field buys',
    'follow a MAC transmitter and receiver through a frame: bit order, the SFD, the CRC check, the address filter, and what the receiver does with a frame it has already passed on',
    'explain carrier sense, the inter-frame gap, collision detection, the jam and the backoff draw, and compute the largest cable a minimum frame can cover at a given rate',
    'read a throughput curve for a shared wire and say where the capture effect comes from',
  ],
  builds: ['uart', 'errors'],
  recap: {
    keep: [
      `A frame on the stream is destination (6), source (6), type or length (2), payload, pad to ${MIN_FRAME - FCS_BYTES} bytes, then the FCS (${FCS_BYTES}); the wire adds ${PREAMBLE.length} bytes of 0x55 and the SFD 0x${SFD.toString(16).toUpperCase()}, every byte least significant bit first. The FCS is chapter 47's CRC-32 over destination to pad, and a good frame leaves the register at ${hex32(CRC32_RESIDUE)}.`,
      `The transmitter (${n0(TX_N)} NANDs, ${n0(CRC_N)} of them the byte-wide CRC) shifts one bit every ${BIT_CLOCKS} clocks. The receiver (${n0(RX_N)} NANDs) aligns to the preamble's edges, samples the third clock of each bit, finds the SFD as the last eight bits equal to 0xD5, strips the FCS by delaying the stream four bytes, and reports at <code>last</code> with <code>err</code> and a reason.`,
      `A receiver cannot know a frame is good until the last byte, so the frame is handed over first and judged afterwards: the buffer writes every byte, and on err the write pointer goes back to the commit pointer. The alternative, holding the frame in the MAC until the FCS is known, costs a frame of memory in the MAC.`,
      `CSMA/CD, half duplex: wait ${GAP_BITS} bit times (${GAP_CLOCKS} clocks) of silence, send, listen while sending; a carrier heard while sending is a collision. Send a ${JAM_BYTES * 8}-bit jam, wait r slots of ${SLOT_BITS} bit times with r drawn from 0 to 2^min(n, ${BACKOFF_LIMIT}) − 1 after the n-th collision, try again, give up after ${ATTEMPT_LIMIT} attempts.`,
      `A sender must still be sending when the collision's news returns: 2d/v is no more than the frame's time. The ${SLOT_BITS}-bit slot is ${(SLOT_BITS / 10).toFixed(1)} µs at 10 Mb/s, about ${n0(KM10)} m of cable at ${V} c by propagation alone, ${n0(M100)} m at 100 Mb/s and ${n0(M1000)} m at 1 Gb/s; a shorter frame lets a collision go unseen.`,
      `Throughput on a shared wire climbs with load to a plateau below the limit of frame / (frame + gap) (${(100 * EFF_MIN).toFixed(0)} % of the time as payload for minimum frames, ${(100 * EFF_MAX).toFixed(0)} % for maximum ones) and is lowest for short frames, where the slot time is as long as the frame. A station that wins a collision starts its next frame with a short backoff range while the loser's range has doubled: the capture effect.`,
      `Full duplex and switches (chapter 49) removed the shared wire: each link has one sender per direction, so there is no carrier to sense and no collision to detect, and the minimum frame survives only as a convention.`,
    ],
    check: [
      {
        question: 'A frame carries 20 bytes of payload. What does the transmitter put on the wire after the 14-byte header and the payload?',
        options: ['26 zero bytes of pad, then 4 bytes of FCS', 'Nothing: the receiver pads short frames', 'The FCS only, 4 bytes', '26 bytes of pad, and the FCS in the preamble'],
        answer: 0,
        explain: `The frame must be at least ${MIN_FRAME} bytes with its FCS, so 60 before it: 14 + 20 + 26 = 60. The pad is not covered by any length field in Ethernet II, so the layer above has to know the real length (IP's header carries it).`,
        why: ['', 'The receiver cannot add bytes that the FCS covers: the FCS is computed by the sender over the padded frame.', `That frame would be ${HEADER_BYTES + 20 + FCS_BYTES} bytes, a runt that receivers drop.`, 'The preamble comes before the frame and is not covered by the FCS; the FCS follows the pad.'],
      },
      {
        question: 'Two stations 30 µs of cable apart both start a 64-byte frame at 10 Mb/s, B 10 µs after A. Who detects the collision first?',
        options: ['B, when A\'s signal reaches it 30 µs after A started, B being already sending', 'A, 10 µs after it started', 'Neither: a frame shorter than the round trip hides it', 'Both at the same moment'],
        answer: 0,
        explain: 'A\'s first bit reaches B at 30 µs; B started at 10 µs, so B has been sending for 20 µs and hears another carrier: it detects first. B\'s first bit reaches A at 40 µs, and A, still sending (a minimum frame plus preamble lasts 57.6 µs), detects then.',
        why: ['', 'A cannot hear B before B\'s signal has crossed the cable: 10 + 30 = 40 µs after A started.', `A's frame lasts ${(BITS_MIN / 10).toFixed(1)} µs and B's signal reaches A at 40 µs, inside the frame, so A does see it.`, 'Each hears the other after the cable delay from that other\'s start, and the starts differ by 10 µs.'],
      },
      {
        question: 'A station has collided three times with the same frame. How many slot times can its next backoff be?',
        options: ['0 to 7', '0 to 3', '0 to 15', 'Exactly 8'],
        answer: 0,
        explain: 'After the n-th collision r is drawn from 0 to 2^min(n, 10) − 1; after the third that is 0 to 7, so on average a wait of 3.5 slots. The range doubles with each collision, which is how a crowd of contenders is thinned out without anyone counting them.',
        why: ['', 'That is the range after the second collision.', 'That is the range after the fourth collision.', 'The draw is random; two stations with the same fixed count would collide again forever.'],
      },
    ],
  },
  steps: [
    {
      title: 'Many machines, one wire',
      body: `
        <p>Chapter 43's wire joined two machines, so nothing on it needed an address. Put a third on and every byte is heard by all of them; the first thing to say in a frame is who it is for. An Ethernet frame starts with a 6-byte <strong>destination</strong> and a 6-byte <strong>source</strong>, then a 2-byte type, then the payload.
        An address has two flag bits in its first byte, and the first byte is the first on the wire: bit 0 set means a <em>group</em> address (the all-ones address is the broadcast: every station takes it), and bit 1 set means <em>locally administered</em>, assigned by the owner and not by the manufacturer. The stations of this chapter are <code>02:00:00:00:00:0n</code>: unicast, locally administered.</p>
        <p>A value of 1536 (0x0600) or more in the 2-byte field is an <strong>EtherType</strong> (0x0800 IPv4, 0x0806 ARP); a smaller value is the length of the payload, which is how 802.3 frames announce theirs. Ethernet II, the format here, carries a type and no length: a frame short of ${MIN_PAYLOAD} payload bytes is padded with zeros up to the minimum, and the layer above has to know where its own data ends.</p>
        <p>Behind the frame comes the <strong>FCS</strong>, the CRC-32 of chapter 47 over everything from the destination to the pad, sent least significant byte first. In front of it the wire has ${PREAMBLE.length} bytes of 0x55 and the start-of-frame delimiter 0x${SFD.toString(16).toUpperCase()}: with each byte sent least significant bit first, that is 1 0 1 0 1 0 1 0 … 1 0 1 0 1 0 1 1, a square wave for the receiver to align to and then two ones in a row to say that the next bit is the first of the frame. A minimum frame is ${MIN_FRAME} bytes with its FCS and ${BITS_MIN} bit times with preamble and SFD, followed by a gap of ${GAP_BITS}.
        At this book's ${BIT_CLOCKS} clocks a bit that is ${n0(BITS_MIN * BIT_CLOCKS)} clocks, ${MIN_US.toFixed(1)} µs at ${LINK_MBPS.toFixed(0)} Mb/s; payload is ${(100 * EFF_MIN).toFixed(0)} % of the time for minimum frames and ${(100 * EFF_MAX).toFixed(0)} % for maximum ones. Type a message below and see the real bytes.</p>`,
      widget: frameWidget,
      challenge: {
        kind: 'quiz',
        question: 'The first byte of a destination address is 0x01 (binary 00000001). What kind of address is it?',
        options: ['A group (multicast) address', 'A broadcast address', 'A locally administered unicast address', 'A unicast address of a manufacturer'],
        answer: 0,
        explain: 'Bit 0 of the first byte is the group bit, and it goes first on the wire. Broadcast is the one group address with all 48 bits set. Bit 1 (0x02) would make an address locally administered.',
        why: ['', 'Broadcast needs every bit set, ff:ff:ff:ff:ff:ff; 0x01 is one of the multicast addresses.', 'Locally administered is bit 1, 0x02; this address has only bit 0 set, and bit 0 means group.', 'Bit 0 of a unicast address is 0.'],
      },
    },
    {
      title: 'The transmitter',
      body: `
        <p>The MAC speaks to the layer above in bytes and to the wire in bits. Above it the interface is a <strong>byte stream</strong>: <code>data[7:0]</code>, <code>valid</code>, <code>last</code>, and <code>ready</code> from the MAC. A byte moves at a clock edge where both valid and ready are 1; the sender holds its byte until it moves. The frame is the bytes from the destination to the last payload byte, with no preamble and no FCS: the MAC adds those. Chapter 49's switch speaks the same stream, which is why it is specified here and not per design.</p>
        <p>Inside, the <span data-show="tx">transmitter</span> is a shift register and a few counters (${n0(TX_N)} NANDs in all, opened below). At each byte boundary, every ${BYTE_CLOCKS} clocks, a state decides the next byte: seven of 0x55 and then 0xD5 from constants; the stream's bytes, <code>ready</code> being 1 for exactly the clock in which one is taken; zeros as pad until 60 bytes have gone out; then the four FCS bytes, picked from the CRC unit's complement. The CRC unit is chapter 47's byte-wide generator (${n0(CRC_N)} NANDs), initialised to all ones when the frame starts and fed each data byte as it loads, so the FCS is ready the moment the last byte is out. The line moves one bit per ${BIT_CLOCKS} clocks, least significant bit first, and <code>txen</code> is the carrier.</p>
        <p>A <span data-show="src">frame source</span> in front of it holds the frame in a RAM and feeds the stream. Two rules at the edges of the contract. A byte that is not valid when the MAC needs it is an underrun, and the MAC ends the frame there, pads it and checks it like any short frame; the source avoids it by starting only a frame that is wholly in its buffer. And the MAC always waits out the gap (${GAP_BITS} bit times = ${GAP_CLOCKS} clocks) of silence before it starts, so the first frame after a reset goes out ${GAP_CLOCKS + 1} clocks in at the earliest. Send a frame below; the bytes come out of the gates and are compared with the frame builder's.</p>`,
      scene: txScene,
      more: {
        real: `<p>A real MAC talks to a PHY across the MII: four bits at a time on separate pins for 100 Mb/s, with a clock from the PHY. The pair used here, (<code>txd</code>, <code>txen</code>) and (<code>rxd</code>, <code>crs</code>) at one bit per ${BIT_CLOCKS} clocks, is that interface cut down to a bit, and <code>col</code> is its collision pin. What the PHY adds is the subject of the last step.</p>`,
        pitfall: `<p>The FCS is computed over the bytes after the pad, so a frame padded by the layer above and a frame padded by the MAC have the same FCS only if the pad is the same zeros. Pad in one place. Here that place is the MAC, and the source never sends a short frame's pad.</p>`,
      },
      challenge: {
        kind: 'quiz',
        question: `How many clocks does a ${MIN_FRAME}-byte frame take on the wire at ${BIT_CLOCKS} clocks a bit, preamble and SFD included, not counting the gap?`,
        options: [`${n0(BITS_MIN * BIT_CLOCKS)}`, `${n0(MIN_FRAME * BYTE_CLOCKS)}`, `${n0(BITS_MIN)}`, `${n0((BITS_MIN + GAP_BITS) * BIT_CLOCKS)}`],
        answer: 0,
        explain: `${MIN_FRAME + 8} bytes (the frame and 8 of preamble and SFD) are ${BITS_MIN} bit times, and a bit time is ${BIT_CLOCKS} clocks. The gap of ${GAP_BITS} bit times (${GAP_CLOCKS} clocks) follows.`,
        why: ['', 'That forgets the 8 bytes of preamble and SFD.', 'That is bit times, not clocks.', 'That includes the gap after the frame.'],
      },
    },
    {
      title: 'The receiver',
      body: `
        <p>The <span data-show="rx">receiver</span> has to do three things with a stream of bits and no clock of its own: find the bits, find the frame, and decide whether to believe it. The carrier (<code>crs</code>) says a frame may be coming. The preamble is the receiver's chance to align: while it is hunting, every edge of <code>rxd</code> restarts a counter of ${BIT_CLOCKS} clocks, and the bit is read at the third. Once the SFD has passed, the counter free-runs; both ends count the same clock here, and a real receiver recovers the transmitter's clock from the transitions instead, which is why the preamble exists at all.</p>
        <p>The SFD is found by shifting each sampled bit into an 8-bit register and comparing it with 0xD5. The preamble's own windows are 0x55 and 0xAA, never 0xD5, so there is no false match; the first bit after the match is bit 0 of the first byte. From then on the receiver counts bytes, feeds each to the CRC unit, and compares the first six with the station's address (or takes any group address, or everything with <code>promisc</code>). When the carrier falls it looks at the register: after a frame and its own FCS it holds the constant ${hex32(CRC32_RESIDUE)} whatever the frame was.</p>
        <p>The FCS must not reach the consumer, but the receiver does not know where the frame ends until the carrier falls. So it keeps the last four bytes in a delay line and hands over each byte when four more have arrived; the last data byte comes out when the carrier falls, with <code>last</code>, and <code>err</code> is valid then. <code>why</code> names the reasons: FCS, runt (under ${MIN_FRAME} bytes), too long (over ${MAX_FRAME}), not for this address, overrun. There is no stalling a wire, so <code>ready</code> is a promise: a byte offered while it is 0 is lost and the frame is marked.</p>
        <p><strong>What the buffer does with a bad frame.</strong> The consumer has been handed up to ${MAX_FRAME} bytes before it hears err. This design takes the second of the two ways to cope: it writes each byte into the receive buffer as it comes, and at <code>last</code> either moves the <em>commit pointer</em> up to the write pointer (the frame is kept) or moves the write pointer back to the commit pointer (the frame never was). The alternative, holding the frame inside the MAC until the FCS is known, would need ${MAX_FRAME} bytes of RAM in every MAC and adds a frame time of latency to every frame, good or bad. The cost of this choice is on the consumer: nothing downstream of the buffer may act on bytes before the commit. The receiver is ${n0(RX_N)} NANDs. Send it frames below, whole or damaged.</p>`,
      scene: rxScene,
      more: {
        real: `<p>A switch that forwards a frame as soon as it has the destination address (cut-through) takes the opposite side of this trade: it has already sent the first bytes of a frame whose FCS fails, and can only mark the tail of it bad. Store-and-forward switches buffer the whole frame first, as the pointer scheme here does for the host.</p>`,
      },
      challenge: {
        kind: 'quiz',
        question: 'The receiver has passed 600 bytes of a frame to the buffer when the FCS turns out to be wrong. What happens to those bytes?',
        options: ['The write pointer moves back to the commit pointer, so the buffer never holds the frame', 'They are overwritten with zeros by the MAC', 'The MAC retransmits the frame', 'The consumer reads them and ignores the err flag at last'],
        answer: 0,
        explain: 'The bytes were written, but the frame becomes visible only when the commit pointer moves. On err the write pointer is set back, so the next frame overwrites the damaged one and nothing downstream ever sees it.',
        why: ['', 'The MAC has no write access to the buffer and no way to take back what it handed over; the buffer\'s pointers do the taking back.', 'A receiver cannot retransmit; recovery of lost frames is a job for the layers above (chapters 50 to 52).', 'A consumer that read uncommitted bytes would act on damaged data: the point of the commit pointer is that it cannot.'],
      },
    },
    {
      title: 'Listen before talking',
      body: `
        <p>With one wire for all stations, the first rule is old and human: do not talk over someone. <strong>Carrier sense</strong> is the MAC's ear: <code>crs</code> is 1 while any station is sending, including this one. A station with a frame ready does not start until the cable has been silent for the <strong>inter-frame gap</strong>, ${GAP_BITS} bit times, ${GAP_US.toFixed(2)} µs here. A 9-bit counter does the counting: it is cleared by any carrier, counts clocks while the wire is quiet, and stops at ${GAP_CLOCKS}; the MAC starts when it has stopped and <code>valid</code> is 1 and <code>crs</code> is 0.</p>
        <p>That rule gives each station the same chance: they all wait for the end of the frame on the wire and all start counting at about the same moment (give or take the cable delay, which is the whole subject of the next step). The gap also gives the receivers time to finish with the frame, empty the pipeline of the one before and be ready for a new preamble.
        Ethernet's CSMA/CD is <em>1-persistent</em>: a station that finds the wire busy waits for the end of the carrier and then sends as soon as the gap has passed, instead of choosing a random moment. It is the efficient choice at low load, and it is why two stations that waited for the same frame to end send at the same instant.</p>
        <p>The scene fixes the ear and lets you choose what it hears: the sliders put another station's carrier on the wire for a while after the frame is queued. The station defers until the carrier has been quiet for ${GAP_CLOCKS} clocks. Start the carrier during the gap itself and the count starts over. Counting costs 9 flip-flops and an incrementer; the comparison is two gates, since 384 is the first count with bits 8 and 7 both set.</p>`,
      scene: csmaScene,
      challenge: {
        kind: 'quiz',
        question: 'A frame is queued while another station\'s frame is on the wire. When does this station start?',
        options: [`${GAP_BITS} bit times after the other carrier ends`, 'At once, when the carrier ends', 'After a random delay, as after a collision', 'When the other station\'s frame has been acknowledged'],
        answer: 0,
        explain: 'Ethernet is 1-persistent: it waits for the end of the carrier, then for the gap, then sends. The random delay belongs to the backoff after a collision; there is no acknowledgement at this layer.',
        why: ['', 'Receivers need the gap to recover, and the rule makes every station wait the same time; starting at once would shorten it.', 'A random delay before the first attempt would waste time at low load; the randomness is spent only after a collision.', 'Ethernet frames are not acknowledged by the MAC; the sender never learns whether a frame arrived.'],
      },
    },
    {
      title: 'Collisions',
      body: `
        <p>Two stations that both wait for the end of a frame send at the same instant, and the cable carries both. Even a station that listened carefully can collide: the wire has length, and a signal takes time to cross it. Until A's first bit reaches B, B sees a free cable and is allowed to start. The two frames overlap in the middle of the cable, and neither station knows until the other's signal arrives.</p>
        <p>The wire in the scenes is the <strong>shared wire</strong>, one box (<code>eth_wire</code>) with a drive input per station and a pair of outputs per station: what it hears is the OR of the others' signals, each delayed by the distance, and a carrier while any other is sending. A station's own signal is not in it; the station adds its own end. It is the same sort of box as chapter 43's line: a transmission line is chapter 41's model, not a circuit, so this one part does not open down to transistors, and the book says so on every scene that uses it. Two drivers at once superpose into garbage that the receivers' FCS rejects, and the box's <code>clash</code> output tells the scene when it happened.</p>
        <p>The transmitter's rule is the whole of collision detection: <strong>a carrier heard while sending is a collision</strong>. In gates it is one AND, <code>txen</code> with the carrier from the others. On a collision the MAC stops its frame, sends a <strong>jam</strong> of ${JAM_BYTES * 8} bits so that stations farther away, which may have heard only a fragment, also see a carrier long enough to count it as a collision, and goes to backoff. What the receivers see is a runt or a bad FCS and is dropped; nobody delivers half a frame. Move the sliders: a short cable, and both stations notice within a few bit times of each other; a longer one, and the first to start is the last to know.</p>`,
      widget: collisionWidget,
      more: {
        pitfall: `<p>A collision is the access method working as designed when two stations ask at once, and it is detected and cleaned up in about a slot time. A station that sees one repeats the same frame; no higher layer is told, and the cost is time on the wire. Only ${ATTEMPT_LIMIT} failures in a row (see step 7) are reported upward.</p>`,
      },
      challenge: {
        kind: 'quiz',
        question: 'Station A sends and station B, 3 µs of cable away, starts 1 µs after A. What does B see?',
        options: ['A free cable for 2 µs more, then a collision when A\'s first bit arrives', 'A collision at once', 'A busy cable: it never starts', 'Nothing: a collision is only visible to A'],
        answer: 0,
        explain: 'B starts at 1 µs because A\'s first bit has not yet arrived (it gets there at 3 µs). At 3 µs B is already sending and hears a carrier: it detects the collision, jams and backs off.',
        why: ['', 'B hears A only after the propagation delay.', 'Carrier sense reports what has arrived, and nothing has arrived at 1 µs.', 'Both stations see it, each when the other\'s signal reaches it.'],
      },
    },
    {
      title: 'Why a minimum frame exists',
      body: `
        <p>A sender can only detect a collision if it is <em>still sending</em> when the other station's signal arrives. In the worst case B starts the instant before A's first bit reaches it, at time d, and B's signal then needs d more to get back: 2d after A started. If A's frame is over before that, A has finished, believes the frame went out, and never learns that B's collision destroyed it. So the frame has to last at least the <strong>round trip</strong>, and since the round trip depends on the cable and the frame's time on the bit rate, the standard fixes one number for the worst-case round trip and sets the minimum frame to cover it: ${SLOT_BITS} bit times, the <strong>slot time</strong>, which is why a frame is at least ${MIN_FRAME} bytes (${MIN_FRAME * 8} bits, and the preamble's ${8 * 8} more make the ${BITS_MIN} bit times it occupies).</p>
        <p>The condition is d ≤ v·T/2, with v the speed of the signal in the cable and T the time the frame takes. At 10 Mb/s a slot is ${(SLOT_BITS / 10).toFixed(1)} µs and at ${V} c the propagation alone allows ${n0(KM10)} m one way; the standard's network diameter, about 2 500 m through repeaters, spends the rest on the repeaters and electronics. At 100 Mb/s the same minimum frame lasts a tenth as long, so the same arithmetic gives ${n0(M100)} m, and the standard's Fast Ethernet networks were roughly a tenth the diameter. At 1 Gb/s it would be ${n0(M1000)} m, too short to be useful, so half-duplex gigabit extends short frames to 4 096 bit times with a carrier-extension symbol instead of lengthening the frame. In this book's ${LINK_MBPS.toFixed(0)} Mb/s the slot is ${SLOT_US.toFixed(2)} µs, ${n0(SLOT_CLOCKS)} clocks, and ${n0(OURS_M)} m of cable at ${V} c.</p>
        <p>Move the cable's delay in the widget. The model runs the worst case with the real MAC machine: B starts one clock before A's signal would reach it. Up to a delay of ${n0((BITS_MIN * BIT_CLOCKS) / 2)} clocks A is still sending when the news comes back and the collision is handled. Beyond it, the model's A finishes first: <code>sent</code> fires and nothing is repeated. Real Ethernet counts such a collision as a <em>late collision</em>, an error of the cabling, not something to retry.</p>`,
      widget: minFrameWidget,
      challenge: {
        kind: 'quiz',
        question: 'The slot time is 512 bit times at 10 Mb/s and at 100 Mb/s. What follows for the longest network?',
        options: ['Ten times shorter at 100 Mb/s', 'Ten times longer at 100 Mb/s', 'The same: the slot time is the same number', 'It cannot be computed without the frame size'],
        answer: 0,
        explain: 'The slot time is a count of bit times, and at ten times the bit rate each is ten times shorter, so the same round trip allowance of 512 bits covers a tenth of the time and, at the same signal speed, a tenth of the distance.',
        why: ['', 'Faster bits make the allowance shorter in time, not longer.', 'The count is the same; the time it stands for is not.', 'The frame size is fixed by the slot time: 64 bytes is the 512 bits.'],
      },
    },
    {
      title: 'Binary exponential backoff',
      body: `
        <p>After a collision both stations hold the same frame and the same rules, so any deterministic retry collides again. The way out is randomness, and the standard's answer is <strong>truncated binary exponential backoff</strong>: after the n-th collision for a frame the station waits r slot times, ${SLOT_BITS} bit times each, with r drawn uniformly from 0 to 2<sup>k</sup> − 1 and k = min(n, ${BACKOFF_LIMIT}). The range doubles with every collision, so a crowd of stations thins itself out without counting anybody: two stations collide with probability 1/2 on the second try, and a hundred need the range to reach about a hundred. Past ten the range stops growing (1 023 slots at most), and after ${ATTEMPT_LIMIT} attempts the MAC gives up on the frame and reports an excessive-collision error.</p>
        <p>In gates the draw is a free-running 10-bit LFSR (an XNOR feedback shift register like the library's random source, taps 10 and 7, period 1 023) sampled when the jam ends and masked to the low k bits by a handful of comparisons on the attempt counter. Each station loads its own <em>seed</em> when it is reset. Two stations with equal seeds would draw equal numbers forever, since they sample at the same moment, and the network would hang on the first collision: the seed has to differ, and real MACs take it from the station address. The wait itself is an 11-bit slot counter and a 10-bit down counter.</p>
        <p>Run the model below. The curve is delivered load against offered load for n stations: it climbs along the diagonal while collisions are rare, bends, and settles below the limit of frame / (frame + gap); short frames do worst, because a slot is as long as a minimum frame. The table is the same wire driven past saturation, every station always with a frame. One station often takes the wire for long stretches. A station that wins a collision and sends its next frame faces a loser whose backoff range has just doubled, so the winner's next collision, if there is one, is again resolved in its favour, and the loser waits with a range of up to 2<sup>k</sup> slots. This is the <strong>capture effect</strong>: backoff is fair to frames and unfair to stations, and it lasts until the loser's wait runs out.</p>`,
      widget: throughputWidget,
      more: {
        real: `<p>Capture is real: it was measured on 10 Mb/s Ethernets, and it is one of the reasons switches replaced shared wires. In this model it is stronger than on a real cable because the stations are a few clocks apart, so a loser has no window in which to start: the winner's next frame is on the wire before the loser's gap counter has finished.</p>`,
      },
      challenge: {
        kind: 'quiz',
        question: 'Why does the backoff range double with each collision instead of staying at, say, 0 to 15?',
        options: ['A fixed range is too small for a crowd and too wasteful for two stations; doubling adapts to the number of contenders', 'It makes the wait shorter on average', 'Because the LFSR can only produce powers of two', 'To guarantee that the second try succeeds'],
        answer: 0,
        explain: 'With 0 to 15, two stations waste a few slots on average after every collision, and thirty stations still collide nearly every time. Doubling starts small and grows with the evidence of contention, a count of collisions standing in for a count of stations.',
        why: ['', 'It makes the wait longer; that is the cost of thinning the crowd.', 'The LFSR gives any bits; the mask picks how many.', 'Nothing guarantees success; the second try collides again with probability 1/2 for two stations.'],
      },
    },
    {
      title: 'A segment',
      body: `
        <p>Everything so far, together. The scene is four <span data-show="st0 st1 st2 st3">stations</span>, each the MAC pair with its frame RAM and receive buffer, on one <span data-show="wire">cable</span> where the stations sit 0, 6, 14 and 26 clocks along it. The addresses are 02:00:00:00:00:01 to 04, each station has its own LFSR seed, and station 4 is promiscuous: it keeps every good frame it hears, which makes it the one to put a capture on. ${n0(TX_N + RX_N)} NANDs of MAC in each, and ${n0(2048 * 8)} bits of RAM for each direction behind it.</p>
        <p>The gates run on the cycle engine; the golden model of comm/mac.ts steps beside them in the tests, and every output of the stations and of the wire is compared on every clock through sends, collisions, jams, backoffs and drops. Queue a frame from one station to another and watch it go: the gap, the preamble, the frame, the receiver's verdict. Queue two at once and see the collision, the jam, the two draws and the one that goes first. The strip shows which stations are sending over the last ${n0(880 * 8)} clocks; the cards count the frames each kept and threw away and the collisions each saw.</p>
        <p><strong>Save capture</strong> writes the frames station 4 kept as a libpcap file. The bytes are the ones that came out of the gates' receiver, without preamble and FCS (a capture normally has neither), with the time of their first byte at the receiver. Wireshark and tcpdump open the file; the destination and source addresses are the stations', the type is IPv4's 0x0800 although the payload is a text message, so a dissector will complain about the packet, not about the frame. A test in this repository reads such a file back and checks the fields.</p>`,
      scene: segmentScene,
      challenge: {
        kind: 'reach',
        goal: 'Make stations 1 and 2 send at once and have a frame get through anyway: at least one collision and two frames sent.',
        check: (stage) => { const s = segState(stage); return !!s && s.collisions >= 1 && s.sent >= 2; },
        answer: 'Press “1 ↔ 2 together”, then Run. The two stations start in the same clock, collide, jam and draw backoffs; the one with the smaller draw goes first and the other defers to its carrier and goes after the gap.',
        solve: (stage) => { const s = segState(stage); if (s) { s.queue(0, 1, 'one'); s.queue(1, 0, 'two'); s.run(); } },
        hints: ['The “together” button queues a frame in each station within the same few clocks.', 'Press Run and wait a few thousand clocks: a minimum frame takes 2 304.'],
      },
    },
    {
      title: 'Where this went',
      body: `
        <p>The shared wire is gone. Ethernet started as a bus (Metcalfe's experimental network at Xerox PARC in the 1970s, the 10 Mb/s DIX specification of 1980, IEEE 802.3 in 1983) and became a star: twisted pairs from every station to a hub, and then to a <strong>switch</strong> (chapter 49), which gives each station its own link. A link with one sender in each direction has nothing to listen for and nothing to collide with: <strong>full duplex</strong> turns CSMA/CD off. The gap stays at ${GAP_BITS} bit times, the frame stays as it is, and the minimum of ${MIN_FRAME} bytes stays too, although nothing needs it any more. What replaced the collision as the way to say <em>slow down</em> is a PAUSE frame, which stops the sender for a number of quanta.</p>
        <p>This chapter left out what a real PHY adds. At 10 Mb/s the bits go out Manchester-coded, a transition in every bit; at 100 Mb/s 100BASE-TX sends 4B5B groups, scrambled and put on the pair as MLT-3, 125 megabaud for a bit rate of 100 Mb/s; 1000BASE-T uses all four pairs of a cable in both directions at once, with five-level symbols and echo cancellation. Autonegotiation tells the two ends what each can do by sending bursts of pulses before any frame; and the clock for the receiver is recovered from the signal, where this book has the transmitter's clock in common. Chapter 46's links are the closest the book comes to those codes. The MAC itself, the part this chapter built, kept its frame, its CRC, its stream and its few thousand gates; what changed from 10 Mb/s to 1 Gb/s is how fast the clock round it goes.</p>
        <p>Next, chapter 49 puts several of these MACs behind a table that says which port a destination lives on. The stream you met in step 2 is the interface between them.</p>`,
    },
  ],
};
