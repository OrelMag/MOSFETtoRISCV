// Chapter 52, TCP: a reliable stream over datagrams that may not arrive. The rules are net/tcp.ts, the same rules compiled from the Python subset (comm/stack/tcp.ts) run on
// the model-speed bench, and a gate window puts one computer of a running transfer into its gates. The figures come from src/net/tcpcosts.json (scripts/tcp-costs.ts).

import { CLOCK_NS, LINK_MBPS } from '../comm/mac';
import '../lib';
import COSTS from '../net/tcpcosts.json';
import { TCP_K } from '../net/tcp';
import { ladderWidget, mbps, realStackWidget, rtoWidget, sawWidget, tcpWindowScene, windowApi, windowWidget } from '../widgets/tcp';
import type { Chapter } from './types';
import { numOf } from './order';

const n0 = (x: number) => Math.round(x).toLocaleString('en-US').replace(/,/g, ' ');
const K = TCP_K, MSS = K.MSS;
const FRAME = MSS + 54, ON_WIRE = FRAME + 4 + 8 + 12;
/** The most data the link can carry in segments this small: preamble, headers, FCS and gap are all wire time. */
export const WIRE_DATA_MBPS = mbps(MSS, ON_WIRE * 32);
export const MEASURED_MBPS = mbps(COSTS.fast.bytes, COSTS.fast.clocks);
const CYCLES_PER_BYTE = COSTS.fast.clocks / COSTS.fast.bytes;
const WINDOW_SEGS = K.RCV / MSS;
const us = (c: number) => (c * CLOCK_NS) / 1000;

export const chTcp: Chapter = {
  id: 'tcp', num: numOf('tcp'), title: 'TCP', level: 'Communication',
  blurb: 'A reliable stream over a network that loses, repeats and reorders: the handshake, sequence numbers, the window, a timer that learns, AIMD\'s sawtooth, and queues that fill, in Python compiled for our CPU.',
  goals: [
    'read a TCP header and follow sequence and acknowledgment numbers through a handshake, a transfer and a loss',
    'say what the receive window and the congestion window each limit, and how the sender learns each one',
    'compute a retransmission timer from round-trip samples, and say why a fixed one fails',
    'explain the sawtooth, why a short queue costs more than a long one, and what a long queue costs instead',
  ],
  builds: ['errors', 'network', 'router'],
  recap: {
    keep: [
      'TCP gives two applications a stream of bytes over IP, which promises nothing. Every byte has a sequence number; an ACK says "everything before this has arrived". A connection opens with three segments because each side must learn the other\'s first number and know that its own arrived.',
      `A sender may have min(cwnd, rwnd) bytes unacknowledged. The receive window protects the receiver and is announced in every segment. The congestion window protects the network and is announced by nobody: the sender infers it from losses.`,
      'The retransmission timer follows the round trip: SRTT + 4 · RTTVAR (RFC 6298). A retransmitted segment gives no sample (Karn), and each timeout doubles the timer. Three duplicate ACKs signal a loss a round trip sooner than the timer, while data is still flowing.',
      `Additive increase, multiplicative decrease: one segment more per round trip, halve on a loss. The queue at the bottleneck fills until a frame is dropped, so the sawtooth is what finding the limit looks like. Too short a queue leaves too little in flight for three duplicate ACKs, and the timer takes over. A longer queue than the window needs only adds delay.`,
      `Our TCP is ${n0(COSTS.lines)} lines of Python, about ${n0(COSTS.words.a)} words of RV32I with the rest of the stack, and it spends ${n0(CYCLES_PER_BYTE)} clock cycles a byte, which gives ${MEASURED_MBPS.toFixed(1)} Mb/s on a link that could carry ${WIRE_DATA_MBPS.toFixed(1)} Mb/s of data in segments this small.`,
    ],
    check: [
      {
        question: 'A sends a SYN with sequence number 1000. B answers with SYN, sequence number 5000. What does its acknowledgment field say?',
        options: ['1001: the SYN holds a sequence number of its own, and 1001 is what B expects next', '1000: the last byte received', '5001: B\'s own next number', '0: no data has arrived yet'],
        answer: 0,
        explain: 'An ACK names the next byte expected, not the last one seen, and SYN and FIN each use up one sequence number so that they can be acknowledged and retransmitted like data.',
        why: ['', 'That would say the SYN itself has not arrived: an ACK names what comes next.', '5001 is what A will acknowledge, in the third segment.', 'A SYN holds a sequence number precisely so that it can be acknowledged.'],
      },
      {
        question: 'cwnd is 16 segments and the receiver announces a window of 8 segments. How much may be unacknowledged?',
        options: ['8 segments: the smaller of the two', '16 segments: cwnd is the sender\'s own', '24 segments: they add', '4 segments: half the smaller'],
        answer: 0,
        explain: 'The sender obeys both limits: min(cwnd, rwnd). In the wire-speed run of this chapter cwnd climbs to 16 segments, while the receive window keeps what is in flight to 8.',
        why: ['', 'Sending past the receive window fills a buffer that is not there.', 'They are two limits on one quantity, not two allowances.', 'Halving is what a loss does to cwnd, and only then.'],
      },
      {
        question: `The router's queue holds 2 frames and the window is rarely above 4 segments. A frame is dropped. Why does this usually end in a timeout?`,
        options: ['Too few segments follow the lost one to produce three duplicate ACKs', 'Duplicate ACKs are not sent when the queue is short', 'A short queue makes the round trip too short to measure', 'The router tells the sender to wait'],
        answer: 0,
        explain: 'Each duplicate ACK needs a later segment to arrive. With two or three in flight there are not three later ones, so only the timer can notice, and it waits a whole RTO and then falls to one segment.',
        why: ['', 'The receiver sends one for every out-of-order arrival, whatever the queue.', 'A shorter round trip is measured just as well, and is what a short queue gives.', 'Routers here say nothing; a drop is the only signal.'],
      },
    ],
  },
  steps: [
    {
      title: 'A stream over datagrams',
      body: `\n        <p>IP delivers packets, sometimes. Chapter ${numOf('router')}'s router drops them when a queue is full, TTL or checksum fail, and two packets may swap places on two paths or arrive twice after a link retry. Applications want something else: bytes, all of them, in order, as if down a wire. <strong>TCP</strong> (RFC 9293) builds that at the two ends alone, and asks the network for nothing.</p>\n        <p>This is the ARQ of <a href="#/c/errors">chapter ${numOf('errors')}</a> with four problems added. The channel has no fixed delay, so the timeout must be measured. Segments can overtake each other, so numbers must not wrap within a segment's life. The receiver can run out of room, so it must be able to say stop. And the channel is shared with strangers, so the sender must find its own fair rate without being told. The next steps take these in turn.</p>\n        <p>Each segment carries the twenty bytes below after the IP header, with ports to name the two applications. Sequence numbers count <em>bytes</em>, not segments, and the checksum covers a pseudo-header of the two addresses as well, so a segment delivered to the wrong machine fails it. <span class="try">Pick each of the three segments and find its flags and its two numbers.</span></p>`,
      widget: () => ladderWidget({ bytes: 0, lose: false }),
      more: {
        numbers: `<p>Forty bytes of headers on every segment, TCP's twenty and IP's twenty, plus Ethernet's fourteen, FCS, preamble and gap. Our segments carry ${MSS} bytes of data in ${ON_WIRE} bytes of wire time, which is why ${WIRE_DATA_MBPS.toFixed(1)} of the link's ${LINK_MBPS.toFixed(1)} Mb/s is the most data they can carry. A real MSS of 1460 keeps 95 % of the wire.</p>`,
        real: `<p>Options lengthen the header up to 60 bytes: window scaling and timestamps (RFC 7323) and SACK (RFC 2018) are on almost every connection. Ours carries only the MSS, in the handshake. QUIC (RFC 9000) does this whole job inside UDP, encrypted, since middleboxes on the path have come to depend on what TCP's headers look like, which makes TCP itself hard to change.</p>`,
      },
    },
    {
      title: 'Three segments to begin',
      body: `
        <p>Neither end can use the other's numbers until it has them, and each must know its own were heard. So: A sends a <strong>SYN</strong> with its first sequence number; B answers <strong>SYN, ACK</strong> with its own and "next from you"; A answers <strong>ACK</strong>. Two segments would leave B unsure that A heard it, and that A is even still there: an old SYN wandering the network would make B open a connection for nobody.</p>
        <p>A SYN and a FIN each take one sequence number, so they can be acknowledged and sent again exactly like a byte of data, with no extra machinery. Each side moves through states on what it has seen: A goes CLOSED, SYN_SENT, ESTABLISHED; B goes LISTEN, SYN_RCVD, ESTABLISHED.</p>
        <p>The first sequence number is not 0: a late segment from an earlier connection on the same ports must not fall inside the new one's numbers, and an attacker must not be able to guess it. <span class="try">Lose the SYN, then lose the SYN-ACK instead, and see who sends what again.</span></p>`,
      widget: () => ladderWidget({ bytes: 0 }),
      challenge: {
        kind: 'quiz',
        question: 'The SYN-ACK is lost. Who sends again?',
        options: ['Both: A has not heard an answer, and B has not heard its SYN acknowledged', 'B alone: only it knows the segment went', 'A alone: the side that opened is responsible', 'Neither: the third segment recovers it'],
        answer: 0,
        explain: 'Each end runs its own timer on what it sent. A sends its SYN again and B its SYN-ACK. The second copy that arrives is simply answered again, which is why a retransmission must be harmless.',
        why: ['', 'B cannot know it was lost; it only knows no ACK came. So can A, for its own SYN.', 'B has a timer on its SYN too, since it holds a sequence number.', 'The third segment cannot be sent: A has nothing to acknowledge.'],
      },
      more: {
        real: `<p>Our initial numbers come from a counter. RFC 6528 asks for a clock plus a keyed hash of the addresses and ports, because predictable numbers once let an attacker forge a whole connection from the outside. A listening server that keeps state for every SYN can be exhausted by a flood of them; SYN cookies encode that state in the sequence number instead.</p>`,
        numbers: `<p>The handshake costs one round trip before the first byte of data. That is the price QUIC and TCP Fast Open go after, and it is why a fetch over a long path feels slow at the start, however fast the link is. Chapter ${numOf('path')} adds up what this costs on a real path.</p>`,
      },
    },
    {
      title: 'Numbers that count bytes',
      body: `
        <p>Data goes out in segments of at most an <strong>MSS</strong>, ${MSS} bytes here, each stamped with the number of its first byte. An <strong>ACK</strong> is cumulative: it names the next byte expected, so one ACK covers everything before it, and a lost ACK costs nothing if a later one arrives.</p>
        <p>A segment that arrives out of order cannot be acknowledged, so the receiver repeats its last ACK. Three such <strong>duplicate ACKs</strong> tell the sender that a segment is gone while later ones are still arriving, a round trip or more before any timer would. Our receiver throws away what arrives ahead of the gap, to keep it small, so both fast retransmit and the timer send everything again from the first unacknowledged byte.</p>
        <p>The numbers are 32 bits and wrap. Our code compares only differences, as a signed number: <code>(a - b) &lt; 0</code>, so it works across the wrap as long as the two are within 2 GB. <span class="try">Find the arrow "ACK seq 193" and lose it: the segments behind it bring duplicate ACKs, and the sender goes back. Most other losses here end in a timeout instead, since too few segments follow them.</span></p>`,
      widget: () => ladderWidget({ bytes: 512 }),
      challenge: {
        kind: 'quiz',
        question: 'A sent bytes 0–63, 64–127 and 128–191, and the middle segment was lost. What does the receiver\'s ACK say after the third arrives?',
        options: ['64: everything before it has arrived, and 64 has not', '192: the highest byte seen, plus one', '128: the start of the last segment', 'Nothing: it waits for the gap to fill'],
        answer: 0,
        explain: 'A cumulative ACK can only name the first gap. Repeating 64 is what tells the sender something is wrong, so holding the ACK back would hide it.',
        why: ['', 'That would tell the sender the lost segment arrived, and it would never be sent again.', 'An ACK names the next byte expected, and that is 64.', 'Saying nothing would waste the one signal the sender can act on before its timer.'],
      },
      more: {
        real: `<p>Real receivers keep what arrives out of order, and SACK (RFC 2018) tells the sender exactly which ranges they hold, so that only the holes go again. They also delay ACKs, typically one for every two segments, which halves the traffic back. Ours acknowledges every segment. At 10 Gb/s a 32-bit number wraps in 3.4 s, within a delayed packet's possible life, so timestamps (PAWS, RFC 7323) tell the old from the new.</p>`,
        pitfall: `<p>A duplicate ACK does not prove a loss: reordering makes them too, which is why it takes three, and why a path that reorders a lot performs badly under TCP even when it drops nothing.</p>`,
      },
    },
    {
      title: 'The window: room at the far end',
      body: `
        <p>The receiver's application may be slower than the network, and bytes must wait somewhere. So every segment announces a <strong>window</strong>: how many more bytes this end can take. The sender keeps its unacknowledged bytes within it, and the buffer can never overflow, whatever the speeds. Ours has ${K.RCV} bytes, ${WINDOW_SEGS} segments.</p>
        <p>This is flow control, the same idea as <code>ready</code> on chapter ${numOf('ethernet')}'s byte stream, stretched over a round trip. When the window reaches zero the sender stops, and now there is a trap: the update that reopens it is an ACK with no data, and if that is lost, no one will ever send anything again. So a stopped sender sends a one-byte <strong>probe</strong> on a timer, doubling each time. A refused probe is no loss, so nothing is cut and it never gives up.</p>
        <p><span class="try">Slow the reader until the window shuts, and find where the probes begin.</span> Getting this right is harder than it looks: an early version of this chapter's code treated the second probe as a loss and cut the window, and carried on one byte past a refused probe. Holding the window shut for longer than the retry limit in a test is what found both.</p>`,
      widget: windowWidget,
      challenge: {
        kind: 'quiz',
        question: 'Why does a sender with a zero window need a timer at all? The receiver will say when it has room.',
        options: ['That window update is a segment with no data, so nothing would resend it if it were lost', 'Because the receiver forgets the sender after a while', 'To measure the round trip', 'To keep the routers\' tables alive'],
        answer: 0,
        explain: 'Only sequence-numbered things are retransmitted. A pure ACK has no number of its own, so a lost one is simply gone, and both ends would wait for each other forever.',
        why: ['', 'A connection holds its state as long as it is open.', 'There is nothing to measure while nothing is sent, and probes do not supply useful samples.', 'Routers keep no per-connection state here.'],
      },
    },
    {
      title: 'How long to wait',
      body: `
        <p>A timer that is too long wastes time after a loss. One that is too short sends data that was only late, adding load just when the network is busiest. The right value depends on a path you cannot see, and it moves. So the sender measures: for one segment at a time it notes when it left and when its ACK came, and keeps a smoothed mean and a smoothed deviation (RFC 6298):</p>
        <p><code>RTTVAR ← 3/4 RTTVAR + 1/4 |SRTT − R| &nbsp; SRTT ← 7/8 SRTT + 1/8 R &nbsp; RTO = SRTT + 4 · RTTVAR</code></p>
        <p>The shifts make that cheap, which matters on our RV32I with no multiply. Two rules finish it. <strong>Karn's</strong>: never sample a segment that was sent twice, since its ACK could belong to either copy. And each timeout <strong>doubles</strong> the timer, until the next valid sample resets it. <span class="try">Widen the spread: the fixed timer starts firing early even before the step, while the adaptive one stays out of the way by waiting longer. Watch "RTO now": that wait is what it pays after a real loss.</span></p>`,
      widget: rtoWidget,
      challenge: {
        kind: 'quiz',
        question: 'Why does RTO add four times the deviation, and not simply use the mean round trip?',
        options: ['About half of all round trips are above their mean: a timer at the mean would fire on good data all the time', 'It makes the arithmetic simpler', 'A timer must exceed two round trips by the standard', 'To leave time for the receiver\'s application'],
        answer: 0,
        explain: 'A timer fires on the slowest samples, not the average one. The margin scales with how noisy the path actually is, so a steady path gets a tight timer and a jittery one a loose timer.',
        why: ['', 'The deviation is extra state: using the mean alone would be simpler.', 'There is no such rule; the RFC gives a minimum in seconds, and the rest is measured.', 'The application plays no part: the ACK is sent when the data arrives.'],
      },
      more: {
        numbers: `<p>Our timer starts at ${n0(K.RTO_INIT)} clocks (${n0(us(K.RTO_INIT))} µs), never goes below ${n0(K.RTO_MIN)} or above ${n0(K.RTO_MAX)}, and gives up after ${K.RETRIES} retransmissions in a row. RFC 6298 starts at one second with a one-second floor, which is far above a modern data centre's round trip of microseconds, so real stacks use lower floors.</p>`,
      },
    },
    {
      title: 'How fast: the sawtooth',
      body: `
        <p>In October 1986 data throughput between Lawrence Berkeley Lab and UC Berkeley, 400 yards apart, fell from 32 kb/s to 40 b/s: everyone's timers fired, everyone sent again, and the routers carried almost nothing but copies. Van Jacobson's answer in 1988 asks nothing of the routers. Each sender keeps a <strong>congestion window</strong>, a guess at what the network can hold, and treats a loss as the signal to back off.</p>
        <p><strong>Slow start</strong> begins at two segments here (RFC 5681 allows up to four at this size, RFC 6928 ten) and adds one per ACK, so it doubles every round trip until a loss or until <code>ssthresh</code>. <strong>Congestion avoidance</strong> then adds one segment per round trip. On three duplicate ACKs the window halves; on a timeout it falls to one segment and starts again, since a timeout means nothing has been arriving. Halving fast and growing slowly is what makes competing flows converge on equal shares.</p>
        <p>The result is a sawtooth, and it is not a fault: a sender with no information finds the limit by exceeding it and backing off. <span class="try">Try "Sawtooth", then move the queue down one frame at a time and watch the time for the same data.</span></p>`,
      widget: sawWidget,
      challenge: {
        kind: 'quiz',
        question: 'Why multiply on the way down but add on the way up?',
        options: ['Two flows sharing a link converge on equal shares only this way: a halving takes more from the larger, and an addition gives both the same', 'Halving is cheaper to compute than subtracting', 'It keeps the window a power of two', 'It is what makes slow start exponential'],
        answer: 0,
        explain: 'Chiu and Jain showed this in 1989. Adding the same to both keeps their difference; halving both halves it. Repeat, and the gap between them shrinks to nothing while the total keeps finding the limit.',
        why: ['', 'Cost was not the reason; a subtraction is as cheap.', 'Congestion avoidance adds one MSS a round trip, which leaves powers of two at once.', 'Slow start is the separate phase before this, and does not use a decrease at all.'],
      },
      more: {
        real: `<p>Reno, our model, ties its rate to the loss rate: about (MSS / RTT) · 1.22 / √p, so a long path at high speed needs an impossibly low loss rate. CUBIC (RFC 9438), Linux's default, grows as a cubic function of the time since the last loss. BBR estimates the path's rate and round trip directly instead of waiting for loss. Routers can also mark packets instead of dropping them (ECN, RFC 3168). Our byte counting is RFC 3465's, chosen here because it needs no division.</p>`,
        numbers: `<p>The compiled stack shows the same shape: ${COSTS.saw.fast} fast retransmits, ${COSTS.saw.timeouts} timeout and ${COSTS.saw.drops} drops for ${n0(COSTS.saw.bytes)} bytes at ${COSTS.saw.o.byteClocks} clocks a byte with a queue of ${COSTS.saw.o.queue}. Shorten the queue to ${COSTS.small.o.queue} on a link at ${COSTS.small.o.byteClocks} clocks a byte, and it is ${COSTS.small.fast} fast retransmits and ${COSTS.small.timeouts} timeouts.</p>`,
      },
    },
    {
      title: 'Queues that fill',
      body: `
        <p>The sawtooth's teeth are the bottleneck's queue filling. So the queue's size sets what happens, in two opposite ways, and the table under the plots shows both.</p>
        <p><strong>Too short</strong>, and a loss leaves too few segments in flight behind it to produce three duplicate ACKs. Only the timer can recover, after a whole RTO, and from one segment. The rule of thumb is one bandwidth-delay product of buffer: enough that the halved window still fills the link. <strong>Too long</strong>, and it never drops at all until the window reaches it, so it just sits full, and every packet of every flow waits behind it. Throughput gains nothing while the round trip grows by a queue's worth: at ${K.MSS + 54} bytes a frame and 200 clocks a byte, each queued frame adds ${n0((K.MSS + 54) * 200)} clocks.</p>
        <p>That second failure has a name, <strong>bufferbloat</strong>: memory got cheap, home routers shipped with seconds of buffer, and a single upload could make a web page crawl on the same link. Our window of ${WINDOW_SEGS} segments caps the effect here. A real window of megabytes does not, and <a href="#/c/queues/1">Queues and congestion</a> measures it. <span class="try">Pick "Room for the window", then shorten the queue a frame at a time and find where drops begin. Above that, a longer queue changes nothing here: the window of ${WINDOW_SEGS} segments cannot fill it.</span></p>`,
      widget: sawWidget,
      challenge: {
        kind: 'quiz',
        question: 'A home router\'s upload queue holds 1 MB, on a 10 Mb/s uplink. While someone uploads a large file, how much delay does the queue add to every other packet going out?',
        options: ['About 0.8 s: 8 Mb at 10 Mb/s', 'About 8 ms: 1 MB at 1 Gb/s', 'Nothing: packets of other flows go first', 'About 80 s: 800 Mb at 10 Mb/s'],
        answer: 0,
        explain: 'TCP fills the queue, since nothing is lost until it is full, and each packet then waits behind the whole of it. 8 Mb at 10 Mb/s is 0.8 s, added to every round trip, including your video call\'s.',
        why: ['', 'The bottleneck is the uplink, not the home network\'s faster side.', 'Not in a plain first-in, first-out queue. A queue for each flow is what would give this, and is the cure.', '1 MB is 8 Mb, not 800.'],
      },
      more: {
        real: `<p>The cure is in the router, since the sender cannot tell a full queue from a long path. Active queue management such as CoDel (RFC 8289) drops or marks packets when they have waited too long, keeping the queue short before TCP would fill it. Fair queueing gives each flow its own, so one upload cannot delay another's packets. Chapter ${numOf('switch')}'s head-of-line blocking is another way for one flow to delay another.</p>`,
      },
    },
    {
      title: 'The same rules, on our CPU',
      body: `
        <p>Everything so far ran on the reference rules. This is the stack itself: chapter ${numOf('network')}'s layers with <code>tcp.ts</code> added, ${n0(COSTS.lines)} lines of Python, compiled to ${n0(COSTS.words.a)} words of RV32I on each computer with its application. It runs on the golden model, with the NIC and the MACs modelled clock by clock, and a router as a queue between them. A test holds this Python to the reference after every pass of its main loop: every frame it sends, byte for byte, against a builder written separately, and every state variable.</p>
        <p>Run one. The console lines come from the program, and the plot is read straight out of A's RAM. The receiver checks each byte against a known pattern, and says so at the end. Save the capture, and any tool that reads a .pcap will follow the stream.</p>
        <p>The wire-speed run shows where the time goes: ${n0(COSTS.fast.bytes)} bytes in ${n0(COSTS.fast.clocks)} cycles, ${n0(CYCLES_PER_BYTE)} cycles a byte, ${MEASURED_MBPS.toFixed(1)} Mb/s. Segments this small could carry ${WIRE_DATA_MBPS.toFixed(1)} Mb/s of data, so here the CPU is the limit, not the network. <span class="try">Run "A slow link" and find the moments the window falls.</span></p>`,
      widget: realStackWidget,
      more: {
        numbers: `<p>This bench is the golden model, not gates: a load or store costs one clock more, and the bus contention between the CPU and the NIC's DMA is not modelled. Against chapter ${numOf('network')}'s gate-level ping that leaves it 5 clocks in ${n0(14689)} off. It runs about a hundred times faster than the gates, which is what makes a transfer of thousands of bytes possible here at all.</p>`,
        real: `<p>A real stack avoids most of this work in hardware: the NIC computes checksums, splits large sends into segments and coalesces received ones (TSO, GRO), and DMA goes straight to the application's memory, so that a modern server reaches hundreds of gigabits on a few cores.</p>`,
        pitfall: `<p>Writing this TCP turned up a fault in chapter ${numOf('ethernet')}'s receiver: its shift register kept the last frame's final byte, and if that byte was 0xAA or 0xAB the next preamble looked like a start-of-frame, so about one frame in 128 was lost on a clean link. The model and the gates agreed with each other all along, so lock step could not see it. The cue was duplicate ACKs with no drop anywhere. A test that checks against the frame as built now catches it.</p>`,
      },
    },
    {
      title: 'A window into the gates',
      body: `
        <p>At several thousand clock cycles a second on the gates, a whole transfer would take minutes. So it runs on the models, and you can put a computer into its gates at any quiet moment. The registers, PC, CSRs and timer go into their flip-flops, the RAM into its leaves, and the NIC's configuration into its registers, as Appendix B does for Doom. The far computer and the router stay models, on the wire at this computer's pins.</p>
        <p>While the window is open, the golden model and the NIC model step beside the gates: every register after every instruction, every NIC output every clock. The panel names the Python line that the PC is on, so you can watch <code>tcp_input</code> run through the circuit. Open the CPU in the schematic while it runs. Then hand it back, and the models carry on from the state the gates reached; the receiver still finds every byte right.</p>
        <p>Quiet means no frame at this computer's pins and nothing in the NIC's bus engine, so that nothing mid-frame needs loading. What the window does not load, the bus fields left over from the last transaction, means nothing until its valid is next raised, and it is compared only then.</p>`,
      scene: tcpWindowScene,
      challenge: {
        kind: 'reach',
        goal: 'Open a gate window and run two thousand instructions on the gates, with no disagreement.',
        check: (st) => { const x = windowApi.get(st)?.state(); return !!x && x.retired >= 2000 && !x.mismatch; },
        hints: ['Press "Open a gate window": it runs the transfer to the data phase, then to a quiet moment, and starts the gates.', 'The panel counts the instructions compared. Two thousand take about a second.'],
        answer: 'Open a gate window and let it run. Every register after every instruction and every NIC output every clock is compared, and the panel reports the first difference if one ever appears.',
        solve: (st) => windowApi.get(st)?.open(),
      },
      more: {
        numbers: `<p>One computer is about 6 million NANDs, nearly all of them RAM, in a flat design of some seventy thousand simulated leaves, since the large memories stay as behavioural leaves. It flattens in under a second.</p>`,
      },
    },
  ],
};
