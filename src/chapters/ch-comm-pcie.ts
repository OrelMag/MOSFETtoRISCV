// PCIe and USB (level Communication): the packet buses inside the box. PCIe in gates against a golden model (comm/pcie.ts, lib/pcie.ts): TLPs, credits, the
// data link layer's replay, link training; USB (comm/usb.ts, lib/usb.ts): packets, CRCs, enumeration. Model and gate numbers are computed or pinned by tests/comm-pcie*, comm-usb*; history and lane rates are typed. The gate-level link is a symbol a clock, one lane; the multi-gigabit figures
// are real PCIe's, and the prose says which is which.

import { ACK_LIMIT, ADV_NPH, ADV_PD, ADV_PH, creditOk, DL_UP, FC_PERIOD_BITS, LINE_DELAY, LINK_IN0, PcieLink, REPLAY_LIMIT, REPLAY_SLOTS, TS_RX, TS_TX, type LinkIn } from '../comm/pcie';
import { busWidget, creditScene, laneGBs, parallelGBs, parallelMHz, PCIE_GENS, pcieApi, pcieCosts, pcieScene, tlpWidget } from '../widgets/pcie';
import { numOf } from './order';
import { stats } from '../sim/stats';
import { AXI_PORT } from '../lib/axi';
import { CRC5_POLY, DEVICE_DESCRIPTOR, BIT_CLOCKS, MAX_PACKET, UsbBench, UsbDevice, crc16, crc5Token, tokenBytes, PID } from '../comm/usb';
import { usbCosts } from '../lib/usb';
import { usbApi, usbPacketWidget, usbScene } from '../widgets/usb';
import type { Chapter } from './types';
import { groupNum } from '../sim/numfmt';

const nf = (x: number, d = 1) => x.toFixed(d);
const n0 = (x: number) => groupNum(x);

// ---- numbers from the model ------------------------------------------------------------------------------------------------
/** Clocks to train and bring up flow control, and from a command to its Ack / its completion. */
export function linkFacts() {
  const l = new PcieLink(), train = l.bringUp();
  const until = (i: Partial<LinkIn>, done: () => boolean) => {
    let n = 1;
    l.step({ ...LINK_IN0, ...i });
    while (!done() && n < 5000) { l.step(LINK_IN0); n++; }
    return n;
  };
  const a0 = l.a.nextSeq;
  const wrAck = until({ go: 1, wr: 1, addr: 4, len: 4, seed: 1 }, () => l.a.nextSeq === a0 + 1 && l.a.ackd === a0);
  for (let k = 0; k < 200; k++) l.step(LINK_IN0);
  let got = false;
  const rd = until({ go: 1, wr: 0, addr: 4, len: 4 }, () => { const w = l.out(LINK_IN0); got = w.rd_done === 1; return got; });
  return { train, wrAck, rd };
}
const F = linkFacts();
let costs: ReturnType<typeof pcieCosts> | null = null;
const C = () => (costs ??= pcieCosts());
/** A whole enumeration on the golden model: the clocks it takes. */
const USB_CLOCKS = (() => { const b = new UsbBench(new UsbDevice()); b.run(60000); return b.clock; })();
let usbC: ReturnType<typeof usbCosts> | null = null;
const UC = () => (usbC ??= usbCosts());
const hx = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(' ');
const SK = 1000, W64 = 64;
const G5 = PCIE_GENS[4];
const N_SER = numOf('serial'), N_ERR = numOf('errors'), N_CODES = numOf('codes'), N_CLK = numOf('clocks'), N_BUS = numOf('bus'), N_SW = numOf('switch');
const serialLink = `<a href="#/c/serial/0">chapter ${N_SER}</a>`;
const AXI_N = stats(AXI_PORT).nands;

export const chPcie: Chapter = {
  id: 'pcie', num: numOf('pcie'), title: 'PCIe and USB', level: 'Communication',
  blurb: 'The packet buses inside the box: PCIe\'s TLPs, credits, Ack, Nak and a replay buffer, and link training in gates; USB\'s tokens, CRCs and enumeration.',
  goals: [
    'say why a shared parallel bus stopped scaling and what a point-to-point lane spends to replace it',
    'read a memory write and a completion byte by byte, and say which layer owns which field',
    'explain credit flow control, including why the test is a modular subtraction, and why completions cost nothing',
    'follow a damaged TLP through Nak, replay and delivery in gates, a lost Ack through the replay timer, and a dead lane through Recovery',
    'walk a device from attach to configured over USB\'s control transfers, and name the trap in SET_ADDRESS',
  ],
  builds: ['serial', 'clocks', 'errors', 'codes', 'bus', 'uart'],
  recap: {
    keep: [
      'A lane is a differential pair each way with no shared clock: skew between wires stops mattering, because each lane recovers its own clock and lanes are deskewed in the receiver. What it costs is a packet protocol: framing, flow control and retransmission, all in hardware.',
      `Three layers. The transaction layer owns the request (Fmt, Type, length, tag, address). The data link layer adds a 12-bit sequence number and a 32-bit LCRC around it, keeps every TLP until it is acknowledged, and is the only part that sees a retry. The physical layer frames it (STP, END), scrambles, encodes and serializes.`,
      `Credit flow control: nothing leaves unless the far side has said it fits. The test is (LIMIT − (CONSUMED + want)) mod 2<sup>w</sup> ≤ 2<sup>w−1</sup>, so both counters are free to wrap. Reads are split transactions, and an endpoint advertises infinite completion credits so that an answer it asked for can always come home.`,
      `A TLP with a bad LCRC is dropped and Nak'd; a lost Ack is cured by the replay timer; a duplicate is dropped and Ack'd again. Four replays with no progress (REPLAY_NUM wraps) send the link through Recovery, where it retrains without losing what is in the replay buffer.`,
    ],
    check: [
      {
        question: 'A TLP arrives with a good LCRC but a sequence number one below what the receiver expects. What does the receiver do?',
        options: ['Drops it and sends an Ack: the sender evidently missed the earlier Ack', 'Delivers it again, since its LCRC is good', 'Sends a Nak, since the number is wrong', 'Retrains the link'],
        answer: 0,
        explain: 'An old sequence number with a good LCRC means the sender is replaying something already delivered, which only happens if the Ack was lost. Delivering it would duplicate a memory write. Acknowledging it stops the replay.',
        why: ['', 'That duplicates a write: the replay exists for the sender, and the receiver filters it.', 'A Nak asks for a replay of what it already has. A Nak is for a number ahead of the expected one, or a bad LCRC.', 'Nothing is wrong with the link.'],
      },
      {
        question: 'Why do credit counters compare with a modular subtraction rather than LIMIT ≥ CONSUMED + want?',
        options: ['Both counters are free-running and wrap, so only their difference means anything', 'The subtraction takes fewer gates than a comparator', 'It lets the sender borrow credits it has not been given', 'The receiver sends credits as differences'],
        answer: 0,
        explain: 'An 8-bit header counter wraps after 256 TLPs. Right after CONSUMED wraps and before LIMIT does, or the other way round, a plain comparison gives the wrong answer. The difference modulo the field is right as long as the two are never more than half the range apart, which the receiver\'s buffer size guarantees.',
        why: ['', 'A comparator and a subtractor cost about the same. The reason is the wrap.', 'The test refuses exactly what was not given.', 'UpdateFC carries the absolute running total, not a difference, so that a lost update is repaired by the next one.'],
      },
      {
        question: 'A SET_ADDRESS request is acknowledged in its setup stage. When may the device start answering to the new address?',
        options: ['After the status stage completes, which is still addressed to the old one', 'At once, as soon as the setup packet is acknowledged', 'After the next bus reset', 'When the host sends the first token with the new address, whatever the state of the transfer'],
        answer: 0,
        explain: 'The whole control transfer happens at the old address, status stage included. A device that moves early never hears the IN token of its own status stage, and the host gives up on it.',
        why: ['', 'That is the classic bug: the status stage is still addressed to 0.', 'A bus reset takes it back to address 0.', 'The device has to have moved by then, and it moves at the end of the status stage.'],
      },
    ],
    practise: [],
  },
  steps: [
    {
      title: 'From a bus to a lane',
      body: `
        <p>Chapters ${N_SER} to ${N_CODES} made one link work: a clock recovered from the data, a line code, checks that catch damaged bits and codes that repair them. Those are parts; this chapter is the first place they are assembled into the packet buses inside a computer, PCIe and USB. It starts from chapter ${N_BUS}'s bus, which put a memory behind wires: an address, data, a handshake, one transaction at a time. PCI did this between chips for two decades: 32 data and address lines, one shared clock at 33 MHz, 133 MB/s for everybody on the bus. PCI-X reached 64 bits at 533 MT/s, by then with source-synchronous strobes to get round the common clock, and that was the end of the road. The common-clock limit is one you can compute; strobes only postpone it, since the lines in a group must still agree to within a bit.</p>
        <p>Every line of a parallel bus has to be valid at the same clock edge. Lines are not the same length, nor are their loads, so they arrive spread over some <strong>skew</strong>, and the receiver can only sample where all of them have settled. With a nanosecond of skew and half a period kept for setting up and sampling, the clock stops at ${nf(parallelMHz(SK), 0)} MHz: at ${W64} bits that is ${nf(parallelGBs(SK, W64), 1)} GB/s, in one direction at a time, for every device on the bus, on ${W64} signal pins plus controls. More width makes the skew worse, not better.</p>
        <p><strong>PCI Express</strong> (specified in 2002) kept PCI's software model (configuration space, memory reads and writes, base address registers) and threw away the wires. A <strong>lane</strong> is one differential pair each way, point to point, with the clock recovered from the data as in the serial links of ${serialLink}. One lane has no skew to speak of, and a ×16 link has 16 lanes which the receiver deskews on its own, each with its own recovered clock. The cost moves from pins to logic: the receiver now needs a clock recovery, a line code, and a protocol that frames, checks and retransmits.</p>
        <p>The table shows real PCIe, a transfer rate per lane and the line code it spends bandwidth on. PCIe ${G5.name} at ×16 carries ${nf(laneGBs(G5, 16), 0)} GB/s each way on ${16 * 4} signal pins. Our gates below run one lane at a symbol a clock; that is a teaching rate, and they say so.</p>`,
      widget: busWidget,
      challenge: {
        kind: 'quiz',
        question: 'Doubling a parallel bus from 32 to 64 bits, with its skew unchanged, doubles the bandwidth. Why did this stop being the way forward?',
        options: ['Wider buses have more skew, needing a slower clock, and they cost pins on every chip; a serial lane has no such limit', 'Software could not use more than 32 bits at a time', 'A 64-bit address space was not needed', 'Serial links use less power at any rate'],
        answer: 0,
        explain: 'Wider means more traces to match over a bigger package and board, so the skew grows and the clock falls; and every pin costs package, routing and power. A lane sidesteps skew by carrying its clock in its data.',
        why: ['', 'Software copies whatever the hardware moves.', 'Address width and data width are separate things.', 'A fast SerDes is not cheap in power. The reason is timing and pins.'],
      },
      more: {
        real: '<p>PCI\'s other problem was that the bus was shared: one slow card held everybody up, so reads turned into retries and then into split transactions on PCI-X. PCIe makes every link point to point and puts a switch where there would have been a shared bus.</p>',
        numbers: `<p>The model behind the slider: a common clock with period T must leave at least half of T after the skew, so f<sub>max</sub> = 1 / (2 × skew). Lane rates and line codes are PCI-SIG's; 6.0's figure takes off the flit's CRC and forward error correction, 14 bytes of each 256 (the 6 bytes of data link header count as payload here), and no other protocol overhead, like the rest of the table.</p>`,
      },
    },
    {
      title: 'A packet, byte by byte',
      body: `
        <p>A memory write across a link is a <strong>TLP</strong>, a transaction layer packet, and this one is real: these are PCIe's bytes. Choose a kind and read the fields. The transaction layer makes the three-dword header: <code>Fmt</code> and <code>Type</code> say what it is (<code>0x40</code> a memory write, <code>0x00</code> a read, <code>0x4A</code> a completion with data), <code>Length</code> counts dwords, the <code>Tag</code> names one of the requester's reads so that the answer can find its way back, the byte enables say which bytes of the end dwords count, and the address goes last.</p>
        <p>The data link layer wraps it: 4 reserved bits and a 12-bit <strong>sequence number</strong> in front, a 32-bit <strong>LCRC</strong> behind. The LCRC is the polynomial of Ethernet's FCS, computed over the sequence number and the TLP: the CRC unit of chapter ${N_ERR} does it, a byte a clock. At 2.5 and 5 GT/s the physical layer then frames it between two control symbols, <code>STP</code> (K27.7) and <code>END</code> (K29.7), which cannot appear in data: the line code's K symbols are why framing costs no escaping and no length search. (From 8 GT/s the 128b/130b code has no K symbols, and a framing token carrying the packet's length takes their place.)</p>
        <p>Link management goes in smaller packets the transaction layer never sees: a <strong>DLLP</strong> is 6 bytes (type, 3 bytes, a CRC-16) between <code>SDP</code> and <code>END</code>. Ack, Nak and flow-control updates are all DLLPs.</p>
        <p>The cost: ${2 + 12 + 4 + 2} bytes of framing and headers around every write and every read. A 4-byte write is ${nf((100 * 4) / 24, 0)} % efficient, a 256-byte one ${nf((100 * 256) / 276, 0)} %, and that is before the line code. The maximum payload size a system negotiates is a trade between this and how long one TLP may hold up the lane.</p>
        <p>Click a byte to flip one of its bits. The receiver cannot tell where the hit landed, and it does not try: a wrong LCRC condemns the whole packet.</p>`,
      widget: tlpWidget,
      challenge: {
        kind: 'quiz',
        question: 'The sequence number is inside what the LCRC covers, and the transaction layer never sees it. Which layer could change it without the requester knowing?',
        options: ['The data link layer: it adds the number and the LCRC, and strips them at the far end', 'The transaction layer at the completer', 'The physical layer: it frames the packet', 'None: the requester chooses it with the tag'],
        answer: 0,
        explain: 'Sequence and LCRC are per link: a switch strips them on the way in and makes new ones on the way out, while the TLP inside travels end to end unchanged.',
        why: ['', 'The transaction layer only ever sees the TLP between them.', 'The physical layer wraps STP and END around it, and does not look inside.', 'The tag is end to end, for the requester\'s own reads. The sequence number is one link\'s.'],
      },
      more: {
        pitfall: '<p>Data link integrity is per hop, so a switch that corrupts a TLP in its own memory passes a fresh, correct LCRC along. That is what the optional end-to-end <strong>ECRC</strong> is for. Our link has no switch and leaves ECRC out.</p>',
        numbers: '<p>Field positions and the DLLP\'s CRC-16 follow another open model\'s code (cocotbext-pcie\'s tlp.py and dllp.py, copied into the tests). The LCRC is computed as Ethernet\'s register, as described in open sources, and checked against zlib\'s CRC-32; its wire order has not been held to a real trace. The PCI-SIG base specification itself sits behind a membership: we did not read it for these tests. The header of comm/pcie.ts names what we left out.</p>',
      },
    },
    {
      title: 'Credits: never send what will not fit',
      body: `
        <p>An <span data-ahead="learnsw">Ethernet switch (chapter ${N_SW}: a box that forwards frames between its ports by address)</span> that runs out of room drops the frame and leaves recovery to software further up. A memory write cannot be dropped: nothing above PCIe would notice. So the sender is not allowed to send a TLP until the receiver has promised room for it.</p>
        <p>The receiver tells the sender its buffer sizes when the link comes up (<code>InitFC</code> DLLPs), in <strong>credits</strong>: one header credit is one TLP header, one data credit is 4 dwords of payload. There are three classes, kept apart: <strong>posted</strong> (memory writes, no answer expected), <strong>non-posted</strong> (reads: an answer owed) and <strong>completions</strong>. As it frees buffers it sends the running total as an <code>UpdateFC</code> DLLP.</p>
        <p>The sender keeps two counters per kind: <code>CREDIT_LIMIT</code> (what the receiver has allowed since the start) and <code>CREDITS_CONSUMED</code> (what it has used). Both only go up, and wrap: 8 bits for headers, 12 for data. So a comparison of the two would be wrong just after one of them wraps. The standard's test is a subtraction:</p>
        <p><code>(LIMIT − (CONSUMED + want)) mod 2<sup>w</sup> ≤ 2<sup>w−1</sup></code></p>
        <p>That is this circuit: an adder and a subtractor, ${n0(C().gate8)} NANDs at 8 bits and ${n0(C().gate12)} at 12. Each TLP needs a yes from its header gate and its data gate. Open it. With limit 4 and consumed 2 there is room for 2. Now set consumed to 254 and limit to 2, as after a wrap: 4 credits are left, and the gate knows it although 2 is less than 254.</p>
        <p>Because UpdateFC carries the running total and not a difference, a lost update is repaired by the next. Our port also resends both totals every ${2 ** FC_PERIOD_BITS} clocks; real ports have a timer for this too.</p>
        <p>Why infinite completions? An endpoint must advertise infinite completion credits, because it only asks for what it has room to take. If completions could wait for credits, then a read waiting for room behind a completion waiting for a read could deadlock the fabric. For the same reason the ordering rules let a posted write pass a read that is stuck.</p>`,
      scene: creditScene,
      lit: '',
      challenge: {
        kind: 'reach',
        goal: 'Set limit 2 and consumed 254, then find the smallest want the gate refuses.',
        check: (st) => {
          const s = st.sim; if (!s) return false;
          return s.getInput('limit') === 2 && s.getInput('consumed') === 254 && s.getInput('want') === 5 && st.value('ok') === 0;
        },
        hints: ['2 − 254 modulo 256 is 4: four credits left.', 'One more than what is left.'],
        answer: `want = 5. (2 − (254 + 5)) mod 256 = 255, above 128, so the answer is no; at want = 4 it is 0, and the answer is ${creditOk(2, 254, 4, 8) ? 'yes' : 'no'}.`,
        solve: (st) => st.setInputs({ limit: 2, consumed: 254, want: 5 }),
      },
      more: {
        derive: '<p>The sender can never be more than the receiver\'s buffer ahead of what the receiver has seen, and the buffer must be under half the counter\'s range: that is why half the range is a safe dividing line. A result above it can only mean "behind": the limit lies in the past of the count.</p>',
        pitfall: `<p>Credits cover the receiver's buffer, not the link's speed. Too few credits and a fast link idles waiting for UpdateFC: with a round trip of r symbols and a TLP of b, you need about r / b headers' worth of credits to fill the lane. Our endpoint advertises ${ADV_PH} posted headers, ${ADV_PD} data credits and ${ADV_NPH} non-posted headers.</p>`,
      },
    },
    {
      title: 'Ack, Nak and the replay buffer',
      body: `
        <p>Here is the whole link in gates: on the left a <span data-show="root">requester</span> and <span data-show="a">port A</span>, on the right <span data-show="b">port B</span> and a <span data-show="ep">completer</span> with a kilobyte of memory, and between them <span data-show="ab">one lane</span> <span data-show="ba">each way</span>. The port is ${n0(C().port - C().buffers)} NANDs of logic and ${n0(C().buffers)} more for its two 1024-entry buffers, drawn as flip-flops, and the whole link ${n0(C().link)}; a golden model runs beside the gates and the panel says whether the two still agree. The panel's packet list reads what arrives on the lanes and recomputes each CRC, as a bus analyser would.</p>
        <p>Press <em>Write</em>. The TLP goes out with sequence 0 and the receiver answers with an Ack about ${F.wrAck} clocks later: the lane's ${LINE_DELAY} clocks each way, the ${ACK_LIMIT} clocks a receiver may gather Acks before sending one, and the time on the wire.</p>
        <p>The transmitter writes every TLP to the <span data-show="a">replay buffer</span> as it goes out, and keeps it. An Ack carrying sequence s means "everything up to s has arrived": it frees those and moves <code>ACKD_SEQ</code>. One Ack covers many TLPs, which is why a receiver batches them.</p>
        <p><strong>Flip next TLP byte</strong>, then <em>Write</em>. The receiver's LCRC check fails, it throws away what it had stored (the buffer's write pointer goes back to the last committed TLP) and sends a Nak with the last good sequence number. The transmitter reads the rest out of its replay buffer, in order, and the write lands once. It costs the time of the packet and a round trip, and nobody above the data link layer ever knew. That is why PCIe can be treated as a reliable memory bus.</p>
        <p>Sequence numbers are compared modulo 4096 and only half the space is valid, so a receiver can tell old from new. It keeps at most ${REPLAY_SLOTS} TLPs unacknowledged here; the standard allows 2048 and a real port sizes the buffer by the round trip and the payload.</p>`,
      scene: () => pcieScene('link'),
      challenge: {
        kind: 'reach',
        goal: 'Damage a TLP, and get it through anyway: at least one Nak, at least one replay, and the sender with nothing left to be acknowledged.',
        check: (st) => { const s = pcieApi.get(st)?.status(); return !!s && s.naks >= 1 && s.replays >= 1 && s.nrcv >= 1 && ((s.ackd + 1) & 0xfff) === s.nextSeq; },
        hints: ['Arm "Flip next TLP byte" first, then press Write.', 'Then press ×40 or Run until the packet list shows the Ack after the replay.'],
        answer: 'Arm the flip, Write, run about 200 clocks: the list shows the TLP with its LCRC wrong, a Nak, the same sequence number again, and an Ack. Read the address back to see the data is exact.',
        solve: (st) => { const a = pcieApi.get(st); a?.flipTlp(); a?.write(8, 4, 0x30); a?.run(400); },
      },
      more: {
        numbers: `<p>Port ${n0(C().port - C().buffers)} NANDs of logic and ${n0(C().buffers)} of buffers, requester ${n0(C().root)}, completer ${n0(C().ep)} (with its memory as gates). From a command to its Ack: ${F.wrAck} clocks here; from a read to the last byte of its completion: ${F.rd}. Training and flow-control setup take ${F.train}.</p>`,
        real: '<p>Real ports stream TLPs back to back and Ack every few of them. A 128-bit datapath at 1 GHz takes 16 bytes a clock, so a real LCRC unit is 128 bits wide and a replay buffer is a large dual-ported RAM. The logic is the same as here.</p>',
      },
    },
    {
      title: 'When the Ack is lost, or nothing gets through',
      body: `
        <p>A Nak needs a receiver that noticed. What if the Ack itself is hit? The sender's <strong>replay timer</strong> runs while anything is unacknowledged, restarting on progress. When it runs out (${REPLAY_LIMIT} clocks here; in the standard about three times the longest Ack delay for the payload and width) the sender replays everything unacknowledged.</p>
        <p>Press <strong>Lose next Ack</strong>, then <em>Write</em>, and run. The Ack's CRC fails and is dropped. The replay timer counts in the status row, reaches its limit, and the same TLP goes out again. The receiver sees a good LCRC but an <em>old</em> sequence number: it drops the packet, because delivering it would write twice, and sends an Ack at once. "B expects" moved by one, not two: one delivery.</p>
        <p>Every replay, by Nak or by timer, increments a 2-bit counter, <code>REPLAY_NUM</code>; any forward progress clears it. If it wraps, four replays have achieved nothing and the link itself is suspect: the data link layer asks for <strong>Recovery</strong>. Press <strong>Block A→B</strong>, then <em>Write</em>, and run. Every symbol is hit, so nothing arrives, timers run out, REPLAY_NUM climbs and port A stops at the next packet boundary and sends TS1s. Port B cannot see them while the lane is blocked, and stays in L0. Unblock the lane: B sees the TS1s, follows into Recovery, and both return to L0.</p>
        <p>Nothing was lost. The replay buffer has kept the TLP throughout, and the first thing after L0 is the replay. This layered recovery is what lets a real link retrain on the fly (a marginal lane drops to a lower speed) with software seeing a pause rather than an error.</p>`,
      scene: () => pcieScene('link'),
      challenge: {
        kind: 'reach',
        goal: 'Block the lane with a write in flight, watch the port go through Recovery, unblock it, and see the write acknowledged.',
        check: (st) => { const s = pcieApi.get(st)?.status(); return !!s && s.recoveries >= 1 && s.up && s.ltA === 4 && s.ltB === 4 && s.nrcv >= 1 && ((s.ackd + 1) & 0xfff) === s.nextSeq; },
        hints: ['Block A→B first, then Write, then Run for a few thousand clocks.', 'After REPLAY_NUM wraps the state ladder in the panel shows Rec.Lock. Then unblock and Run.'],
        answer: `Block, Write, Run a little over ${REPLAY_LIMIT * 4} clocks: four timer expiries, then Recovery. Unblock and Run: TS1, TS2, idle, L0, then the replay and its Ack.`,
        solve: (st) => { const a = pcieApi.get(st); a?.block(true); a?.write(4, 2, 0x55); a?.run(REPLAY_LIMIT * 6); a?.block(false); a?.run(3000); },
      },
      more: {
        pitfall: '<p>The replay timer must not be shorter than the longest legitimate round trip with Acks at their latest, or a healthy link replays all the time. It stops while a replay is under way, or a long packet would trigger another replay of itself.</p>',
        real: '<p>A real port counts these events in Advanced Error Reporting registers as correctable errors (Bad TLP, Bad DLLP, Replay Timer Timeout, REPLAY_NUM Rollover). Software that looks there can see a link degrading long before anything fails.</p>',
      },
    },
    {
      title: 'Link training',
      body: `
        <p>Plug a card in. Neither end knows if the other is there, where its symbol boundaries are, or how fast it can go. The physical layer's <strong>LTSSM</strong> (link training and status state machine) finds out. Ours is a subset: <span data-show="a">Detect → Polling → Configuration → L0</span>, with Recovery beside it.</p>
        <p><strong>Plug in</strong> and run. <strong>Detect</strong>: a real transmitter senses a far-end termination by the time constant of a voltage step. Then <strong>Polling.Active</strong>: the port sends <strong>TS1</strong> ordered sets, 16 symbols, starting with the comma <code>COM</code> (K28.5) that lets the receiver find symbol and word boundaries, as in the SerDes of chapter ${N_SER}. When it has sent at least ${TS_TX} and seen ${TS_RX} in a row from the other side, it moves to <strong>Polling.Configuration</strong> and sends <strong>TS2</strong>: "I can hear you." ${TS_RX} TS2s seen means the other end hears this one too. Eight in a row guards against a noise burst that looks like one.</p>
        <p><strong>Configuration</strong> agrees lane order, link width and numbers (ours skips these), and ends with idle symbols: ${TS_RX} received and ${TS_TX} sent. Then <strong>L0</strong>: the link is up. Only now does the data link layer begin: <strong>InitFC1</strong> and <strong>InitFC2</strong> DLLPs give each side the other's buffer sizes (the state ladder in the panel: Detect … L0, then DL_Up). The first TLP may go. All of that takes ${F.train} clocks here; the standard's Polling alone asks for 1024 TS1s.</p>
        <p>Recovery uses the same three moves, TS1 then TS2 then idle. Speed changes and equalization go through it too on real parts: at 8 GT/s and up, the two ends tune each other's FFE taps by exchanging TS1s, which is the equalization of chapter ${N_SER} run as a protocol.</p>
        <p>Pull the cable with <em>Unplug</em>: both ports reset, and the transaction layer's state goes too (a hot unplug is a real error for software to catch).</p>`,
      scene: () => pcieScene('train'),
      challenge: {
        kind: 'reach',
        goal: 'Plug the cable in and run until both ports are in L0 with flow control up (DL_Up).',
        check: (st) => { const s = pcieApi.get(st)?.status(); return !!s && s.dlA === DL_UP && s.dlB === DL_UP && s.ltA === 4 && s.ltB === 4; },
        hints: ['Plug in, then Run.', `It takes ${F.train} clocks or so.`],
        answer: `Plug in and Run: TS1, TS2, idle, then InitFC1 and InitFC2 in both directions; about ${F.train} clocks.`,
        solve: (st) => { const a = pcieApi.get(st); a?.plug(true); a?.run(F.train + 20); },
      },
      more: {
        numbers: `<p>${TS_TX} TS1s in place of 1024, no link or lane numbers, a training timeout that returns to the first TS1 of the sequence in place of Detect, no speed change and no power states. These are named in the header of comm/pcie.ts; the test that held us to a timeout is a noisy lane in tests/comm-pcie-oracle.test.ts, where a port otherwise waits forever for a TS2 the other end has finished sending.</p>`,
      },
    },
    {
      title: 'What is below, and what it costs',
      body: `
        <p>Our link stops where a real MAC hands off to its PHY, the industry's <strong>PIPE</strong> interface: bytes with a K flag at a symbol clock. Everything below is the subject of chapter ${N_SER}. At 2.5 and 5 GT/s each byte goes through a scrambler (so that a repeating pattern does not concentrate its energy in one tone) and 8b/10b. From 8 GT/s the line code is 128b/130b: scrambling carries the transitions, and a 2-bit sync header says whether a 16-byte block is data or ordered sets.</p>
        <p>What we left out, then. <strong>SKP ordered sets</strong>: each end's clock is allowed ±300 ppm, so at the 8b/10b rates every 1180 to 1538 symbols the sender inserts a marker and a receiver's elastic buffer adds or drops a SKP symbol: a clock-crossing FIFO (chapter ${N_CLK}) with a rule to keep it from under- or overflowing. <strong>Lane striping</strong>: a ×16 link deals its bytes out across lanes, and the receiver lines the lanes up again using a COM on each. <strong>Switches</strong>: a port per link and a crossbar, like the <span data-ahead="learnsw">Ethernet switch of chapter ${N_SW} (a table, a crossbar and an arbiter between ports)</span>, routing by address.</p>
        <p>The cost, in our gates: ${n0(C().port - C().buffers)} NANDs of logic for a port plus ${n0(C().buffers)} for its two buffers as flip-flops (a real one is a compiled SRAM), and ${n0(C().link)} for the link with the completer's kilobyte. The requester is ${n0(C().root)}. That is one lane's protocol. Chapter ${N_BUS}'s AXI port is ${n0(AXI_N)} NANDs against this port's ${n0(C().port - C().buffers)}, and that is why short on-chip buses are still parallel wires: they have no skew to fight and no errors to retry.</p>`,
      widget: busWidget,
      challenge: {
        kind: 'quiz',
        question: `A port spends ${n0(C().port - C().buffers)} NANDs of logic and a retry protocol where AXI spends a handshake. Why is a chip's internal interconnect still parallel?`,
        options: ['On one die the skew is small and bit errors are negligible, so none of what a lane pays for is needed', 'AXI is faster than any SerDes', 'A serial link cannot carry addresses', 'Serial links only work over cables'],
        answer: 0,
        explain: 'A lane exists to cross a board or a cable, where matching a wide bus is impossible and errors are a fact of life. Inside a chip neither applies, and hundreds of short wires are cheap.',
        why: ['', 'Per wire a SerDes is far faster; a bus just has many short wires.', 'A TLP carries an address well enough.', 'PCIe runs over board traces, and chiplets use short serial links too.'],
      },
    },
    {
      title: 'USB: one master, and nobody else speaks',
      body: `
        <p>USB answers the same question for a different customer. A keyboard must be cheap, needs few wires, and has to work when plugged into a running machine by someone who knows nothing about it. So all the intelligence goes in the host: the bus has one master, and a device speaks only when spoken to. No arbitration, no interrupts: a "USB interrupt" is the host asking, on a schedule.</p>
        <p>The wires are one differential pair, half duplex. Idle is <strong>J</strong> (at full speed, D+ high), its opposite is <strong>K</strong>, and both low is <strong>SE0</strong>, which marks the end of a packet. The bits go <strong>NRZI</strong>: a 0 is a change of level, a 1 is none. A long run of 0s has edges to recover a clock from; a long run of 1s doesn't, so after six 1s the sender <strong>stuffs</strong> a 0, whatever comes next, and the receiver removes it. Every packet starts with a SYNC pattern, KJKJKJKK, and the receiver has no clock of its own to speak of: it oversamples and resynchronizes on each transition, as the UART does on a start bit, but all along.</p>
        <p>A <strong>transaction</strong> is up to three packets. A token from the host says who and which way: <code>SETUP</code>, <code>IN</code> or <code>OUT</code>, a 7-bit address, a 4-bit endpoint and a CRC5. For address 0, endpoint 0 that is <code>${hx(tokenBytes(PID.SETUP, 0, 0))}</code> (CRC5 ${crc5Token(0, 0).toString(2).padStart(5, '0')}). Then a data packet, <code>DATA0</code> or <code>DATA1</code>, with a CRC16. Then a one-byte handshake: <code>ACK</code>, <code>NAK</code> ("not now, ask again") or <code>STALL</code> ("no"). The PID byte carries its own check: the high nibble is the complement of the low.</p>
        <p>The DATA0 / DATA1 alternation is the whole retry protocol: <strong>stop and wait with a one-bit sequence number</strong>, the errors chapter's ARQ. If an ACK is lost, the sender repeats, and the receiver recognizes the toggle and takes nothing twice. Compare a PCIe port's window of sequence numbers: one packet outstanding needs no more.</p>
        <p>The explorer builds a real packet from field to line. The CRCs are the catalogue's CRC-5 and CRC-16/USB; the tests hold them to a published list, and a tshark check reads the packets our gates send. Flip a bit and the CRC fails.</p>`,
      widget: usbPacketWidget,
      challenge: {
        kind: 'quiz',
        question: 'Why does USB stuff a 0 after six 1s, when SYNC already lets the receiver find the clock?',
        options: ['In NRZI a 1 makes no transition, so a long run of 1s leaves the receiver with nothing to resynchronize on', 'To balance the voltage on the line', 'To mark the end of a byte', 'To make room for the CRC'],
        answer: 0,
        explain: 'SYNC gets the phase once; the two ends\' clocks then drift. Six 1s and the stuffed 0 make seven bit times at most between edges, so that a 0.25 % clock tolerance can never slip a bit.',
        why: ['', 'That is what 8b/10b\'s disparity does. USB\'s stuffing does not balance anything.', 'A byte has no marker on the wire: position is counted from SYNC.', 'The CRC is ordinary data.'],
      },
      more: {
        numbers: `<p>Oracles: the CRC-16/USB check value (${crc16(Array.from('123456789', (c) => c.charCodeAt(0))).toString(16).toUpperCase()}), published CRC5 and NRZI examples (valentyusb's documentation), and Wireshark's USB link-layer dissector, which reads the captures of our gates' packets in CI and checks every CRC. The generator polynomials are x⁵ + x² + 1 (reflected 0x${CRC5_POLY.toString(16)}) and x¹⁶ + x¹⁵ + x² + 1.</p>`,
      },
    },
    {
      title: 'Enumeration: a stranger introduces itself',
      body: `
        <p>Here is a USB device in gates: ${n0(UC().total)} NANDs. <span data-show="rx">Bit recovery, NRZI and stuffing</span>, <span data-show="pkt">packet fields</span>, <span data-show="crc">the two CRCs</span>, <span data-show="tx">a transmitter with its descriptor ROM</span> and <span data-show="ctl">the control endpoint</span>. A host model drives its wires, and a device model runs beside the gates, compared at every clock.</p>
        <p>A device plugged in knows nothing and has address 0. The host resets the bus (SE0 held long) and walks it through a dialogue on endpoint 0, here in the textbook order (real hosts differ in the details), the <strong>control pipe</strong>. Each request is an 8-byte SETUP packet, then a data stage, then a status stage in the opposite direction:</p>
        <ol>
          <li><code>GET_DESCRIPTOR(device, 8)</code> at address 0: the first 8 bytes, to learn the packet size (${DEVICE_DESCRIPTOR[7]} here). Another reset.</li>
          <li><code>SET_ADDRESS(5)</code>: from now on this device, not "whoever just arrived".</li>
          <li><code>GET_DESCRIPTOR(device, 18)</code>: vendor, product, class. In ${MAX_PACKET}-byte packets, each DATA1, DATA0, DATA1 in turn.</li>
          <li><code>GET_DESCRIPTOR(configuration)</code>: first 9 bytes for the total length, then all of it: interfaces, endpoints, power. This is how the host picks a driver.</li>
          <li><code>SET_CONFIGURATION(1)</code>: the device is live.</li>
        </ol>
        <p><strong>The trap.</strong> SET_ADDRESS is a control transfer, so it ends with a status stage, and the status stage is addressed to the <em>old</em> address, 0. A device that moves on acknowledging the SETUP never hears the IN token of its own status stage. Ours moves when the host acknowledges the status packet. <em>Step transaction</em> through it and watch the log: the token before says addr 0, the token after says addr 5.</p>
        <p>Press <em>Corrupt next packet</em> first: the device ignores what fails its CRC, and the host times out and repeats (if it was the host's own ACK that was hit, the device sends its data again and the host drops the repeat, by the toggle). After three errors in a row a real host gives up on the transaction. The whole dialogue takes ${n0(USB_CLOCKS)} clocks here (${BIT_CLOCKS} clocks a bit, a gate-level rate near 63 Mb/s; real full speed is 12 Mb/s, and a real host waits milliseconds between steps).</p>`,
      scene: usbScene,
      challenge: {
        kind: 'reach',
        goal: 'Take the device from reset to Configured, at the new address, through a corrupted packet: the host must see the error and retry, with gates and model agreeing.',
        check: (st) => { const a = usbApi.get(st)?.status(); return !!a && a.configured && a.stateName === 'Configured' && a.mismatches === 0 && a.corrupted > 0 && a.errors > 0; },
        hints: ['Corrupt next packet flips a bit in the host\'s next packet; the device ignores it and the host times out and sends it again.', 'Arm it before or during enumeration (Replug starts over), then Run enumeration or Step transaction. Watch the address change only after the status stage of SET_ADDRESS.'],
        answer: `Press Corrupt next packet, then Run enumeration: about ${n0(USB_CLOCKS)} clocks and one retry. The log shows the two resets, the error and its retry, the address change and the descriptors.`,
        solve: (st) => { const a = usbApi.get(st); if (!a) return; if (a.status().done) a.replug(); a.corrupt(); a.run(); },
      },
      more: {
        numbers: `<p>Device ${n0(UC().total)} NANDs: ${Object.entries(UC().blocks).filter(([k]) => !k.includes('.')).map(([k, v]) => `${k} ${n0(v)}`).join(', ')}. The vendor and product ids are pid.codes' test id, 0x1209 and 0x0001.</p>`,
        pitfall: '<p>Left out, and named in comm/usb.ts: start-of-frame timing, suspend, low and high speed, hubs, attach detection. If the host\'s last ACK of SET_ADDRESS is lost, the host believes the address changed and our device has not: the next transaction goes unanswered, and the host has to recover, a reset being the sure way. Real controllers differ in the moment they move, some on sending the status packet.</p>',
      },
    },
    {
      title: 'Two answers to one question',
      body: `
        <table class="mini"><tr><th></th><th>PCIe</th><th>USB 2.0</th></tr>
        <tr><td>Who may send</td><td>Either end, any time it has credit</td><td>Host only; a device answers</td></tr>
        <tr><td>Overrun</td><td>Prevented: credits before sending</td><td>Refused: a device says NAK and is asked again</td></tr>
        <tr><td>Retry</td><td>Sequence numbers, replay buffer, a window</td><td>A one-bit toggle, one packet at a time</td></tr>
        <tr><td>Check</td><td>LCRC per link, CRC-16 on DLLPs</td><td>CRC5 on tokens, CRC16 on data</td></tr>
        <tr><td>Clock and code</td><td>Recovered, 8b/10b or 128b/130b, scrambled</td><td>Recovered, NRZI with stuffing</td></tr>
        <tr><td>Finding each other</td><td>Link training in hardware; software walks configuration space</td><td>Reset and descriptors on a control pipe</td></tr>
        <tr><td>Cost here</td><td>${n0(C().port - C().buffers)} NANDs of port logic, each end, plus buffers</td><td>${n0(UC().total)} NANDs a device</td></tr></table>
        <p>Both use the same pieces, picked by who pays. PCIe's customer wants throughput and low latency between peers with silicon to spare: credits, windows, full duplex. USB's wants a device that costs less than its cable: the host does the scheduling, retries and thinking, and a device is a small state machine and a ROM. A mouse's chip could not afford a replay buffer and has no need of one.</p>
        <p>The speeds have since converged, and the differences with them. USB 3 (5 Gb/s, 2008) added separate full-duplex differential pairs and uses 8b/10b, link training and credit-like flow control: a PCIe-like physical layer under USB's model. USB4 (40 Gb/s and up), based on Thunderbolt, is a tunnel: PCIe TLPs, DisplayPort and USB packets all travel on one link as frames. PCIe's packets in USB's connector, which is the kind of layering every chapter of this part has been building up to.</p>
        <p>Next, the same questions on a shared medium: who may talk, how a frame is framed and checked, and what to do with a frame that has nowhere to go. There, unlike here, dropping is allowed.</p>`,
      challenge: {
        kind: 'quiz',
        question: 'A USB device is out of buffer. What happens, compared with a PCIe receiver out of buffer?',
        options: ['USB tries and is refused; PCIe never sends', 'Both drop the packet', 'USB stalls the whole bus; PCIe drops the packet', 'Both raise an interrupt'],
        answer: 0,
        explain: 'USB finds out by trying: a NAK burns a token and possibly a data packet. Credits move the knowledge to the sender before the bytes go out, at the cost of counters at both ends and DLLPs to carry updates.',
        why: ['', 'Neither drops: USB refuses and retries, PCIe waits.', 'STALL means an unsupported request; a NAK delays one endpoint and the others carry on.', 'A USB device cannot interrupt anything: it speaks only when asked.'],
      },
    },
  ],
};
