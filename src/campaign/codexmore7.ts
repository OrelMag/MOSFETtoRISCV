// The fuller texts of the Communication entries of chapters 51-52 (codexcomm.ts): the router and TCP. Every number is the chapter's own, computed from net/ and the library
// (tests/content-codexcomm.test.ts pins them to the models, to the gate counts and to the chapter steps that print them). No DOM.

import type { CodexMore } from './codexmore';

export const MORE7: Record<string, CodexMore> = {
  lpm: {
    idea: `A switch needs a table line per machine. A router needs one per <i>network</i>, because an IP address has a shape: its leading bits name a network. A route is a prefix and a next hop, and <code>10.1.2.0/24</code> covers every address whose first 24 bits equal those of 10.1.2.0. Prefixes nest, so an address can match several, and the rule is that <b>the longest match wins</b>: the most specific statement anyone made about it. A default route, <code>0.0.0.0/0</code>, matches everything and loses to everything.<br><br>Scanning a table is too slow, and sorting does not help, because the answer depends on length. A <b>binary trie</b> makes it a walk: a node per prefix bit, followed by the address's bits, remembering the last route passed. That is at most 33 memory reads, however big the table is. A <b>TCAM</b> answers in one clock by comparing every entry at once, and pays for it per entry, in gates and power.`,
    example: {
      title: 'One address, three routes',
      body: `<pre>10.0.0.0/8 → hop 1    10.1.0.0/16 → hop 2    10.1.2.0/24 → hop 3
10.1.2.9   matches all three: the /24, hop 3
10.1.3.4   the third byte differs: the /16, hop 2
10.200.0.1 the /8, hop 1

trie here: 1,024 nodes of 24 bits (a hop, two child addresses), at most 33 reads
CAM of 16 × 32 bits: 11,725 NANDs, exact match only, with no mask for a prefix
level l_fwd: 4 routes matched at once, 5,847 NANDs</pre>`,
    },
    mistakes: [
      'Taking the first route that matches: that makes the order of arrival the policy, and a default route listed first would swallow everything.',
      'Reading a /24 as 24 addresses: it fixes 24 bits and leaves 8 free, 256 addresses.',
      'Expecting a lookup to stop at a default route at the root: a longer one may lie below it, so the walk goes on until a child is missing, and remembers the last route it passed.',
      'Counting a trie\'s reads per route: the depth depends on the address\'s bits, at most one a level, not on how many routes the table holds.',
    ],
    chapters: [
      { chapter: 'router', step: 0, label: 'An address with a shape' },
      { chapter: 'router', step: 1, label: 'Longest prefix wins' },
    ],
  },
  fastpath: {
    idea: `A router has two parts at two speeds. The <b>fast path</b> is gates: for each frame, check the header, walk the trie, and send it out with four things changed: two MAC addresses, the TTL one lower and the checksum. It has no time to think, and it does not. Everything else goes up, unchanged, to the <b>slow path</b>, a processor on another port: a TTL that ran out, no route, an address of the router's own, ARP, options. Two frames get no reply at all: a bad checksum, whose addresses cannot be trusted, and another machine's MAC.<br><br>The checksum is the neat part. It is a ones' complement sum, so it moves by exactly what one word moves by: lowering the TTL lowers the word {TTL, protocol} by 0x0100, and RFC 1624 turns that into HC' = ~(~HC + 0xFEFF), the carry brought round. One addition stands for summing twenty bytes again. The TTL itself is why a mistake in a routing table wastes bandwidth and does not melt the network: a packet in a loop dies within 255 hops.`,
    example: {
      title: 'What it costs, on the gates',
      body: `<pre>the fast path: 4,214 NANDs of logic beside 836,585 of memory
a 60-byte frame: 60 in + 1 + up to 33 reads + 1 + 60 out = at most 155 cycles
the same frame on our link: 2,688 cycles of wire time
so one engine could serve 17 ports of that link</pre>The memory is 99.5 % of it: the buffer, the trie and the next-hop table. Forwarding is a memory problem with a little logic around it.`,
    },
    mistakes: [
      'Recomputing the checksum at every hop: the sum is linear, so one constant addition does it; the router must still verify the old one.',
      'Adding 0x0100 to the checksum field itself: it looks the same, and it is what RFC 1141 did. For a checksum of 0xFEFF it gives 0xFFFF where the sum says 0, since a sum of non-zero words is never 0. RFC 1624 is the correction: work on the complement. The next router would drop that one packet in 65 536.',
      'Answering a bad header with an ICMP error: the source address may be the very bit that was damaged, so a corrupted packet is dropped in silence.',
      'Thinking the slow path is an edge case: it is how the table is filled and how a traceroute works, and a flood of TTL-1 packets is an attack on it, so routers limit how fast it answers.',
    ],
    chapters: [
      { chapter: 'router', step: 2, label: 'The fast path in gates' },
      { chapter: 'router', step: 3, label: 'Four changed bytes and a constant' },
      { chapter: 'router', step: 4, label: 'What the fast path will not do' },
      { chapter: 'router', step: 7, label: 'What one engine can carry' },
    ],
  },
  routing: {
    idea: `Forwarding reads a table; a routing protocol writes it, and no router can see the whole network. <b>Distance vector</b> (Bellman-Ford, as RIP runs it) tells its neighbours its table and believes them: my cost to X is the smallest of a link's cost plus that neighbour's. It is simple, and bad news travels badly, because a number does not say which way it runs: on a chain A - B - C with B - C down, B believes A's old "2 to C", which ran through B, and the two count up together. <b>Poison reverse</b> tells a neighbour "infinity" for routes through it, which cures loops of two.<br><br><b>Link state</b> (OSPF, IS-IS) floods what each router knows about its own links to every router, so everyone holds the same map and runs Dijkstra alone. A failure is one flood away and nothing counts, at the price of memory for the map and a run of Dijkstra per change.`,
    example: {
      title: 'The same network, both ways',
      body: `<pre>7 routers, 10 links (invented)
distance vector, from nothing: 6 rounds, 120 whole tables of 7 entries
link state, from nothing:      98 short reports flooded, then Dijkstra at each router
chain A - B - C, link B - C fails:
  distance vector  15 rounds, counting to an "infinity" of 16
  poison reverse    2 rounds</pre>`,
    },
    mistakes: [
      'Calling a routing protocol part of forwarding: it runs on the slow path, on a processor, and reaches the fast path only as writes to the table.',
      'Believing poison reverse ends counting to infinity: it cures loops of two routers; loops of three and more can still count, given the right timing.',
      'Assuming a shortest path by hops: costs are set by operators, and between networks BGP chooses by policy and who pays whom, not by distance.',
      'Reading the rounds here as a real protocol\'s time: rounds here are synchronous, all routers at once, the simplest case and the kindest.',
    ],
    chapters: [
      { chapter: 'router', step: 5, label: 'Distance vector: believe your neighbours' },
      { chapter: 'router', step: 6, label: 'Link state: everyone holds the map' },
    ],
  },
  tcp: {
    idea: `IP delivers packets, sometimes, and <b>TCP</b> (RFC 9293) builds a stream of bytes out of that at the two ends alone. Every byte has a sequence number, and an <b>ACK</b> names the next byte expected, so one ACK covers everything before it and a lost ACK costs nothing if a later one arrives. A connection opens with three segments, since each side must learn the other's first number and know that its own arrived; a SYN and a FIN each take a number, so they are acknowledged and resent like data.<br><br>The <b>receive window</b>, in every segment, says how many more bytes this end can take, so a buffer can never overflow. A stopped sender sends one-byte probes on a timer, since the update that reopens the window has no number of its own, and if lost it would never be resent. The <b>retransmission timer</b> follows the path: RTO = SRTT + 4 · RTTVAR (RFC 6298), with no sample from a segment sent twice (Karn), and it doubles on each timeout. Three <b>duplicate ACKs</b> say a segment is gone while later ones still arrive, a round trip or more before the timer would.`,
    example: {
      title: 'Our TCP, compiled for our CPU',
      body: `<pre>SYN        seq x
SYN, ACK   seq y, ack x + 1
ACK        seq x + 1, ack y + 1        3 segments before any data

570 lines of Python, 3,241 words of RV32I with the rest of the stack
MSS 64 bytes: 142 bytes of wire time a segment, at most 28.5 of the link's 63.3 Mb/s
measured: 8,000 bytes in 1,027,057 cycles, 128 a byte, 15.8 Mb/s: here the CPU is the limit</pre>`,
    },
    mistakes: [
      'Reading an ACK as "I got that one": it says everything before this number has arrived, so after a gap the receiver keeps repeating the same number. Holding it back would hide the one signal the sender can act on before its timer.',
      'Treating one duplicate ACK as a loss: reordering makes them too, which is why it takes three.',
      'Sampling the round trip on a segment that was sent twice: the ACK could belong to either copy, which is Karn\'s rule.',
      'Setting the timer to the mean round trip: about half of all round trips are above their mean, so it would fire on good data all the time.',
      'Comparing sequence numbers directly: they are 32 bits and wrap, so compare the difference as a signed number. At 10 Gb/s they wrap in 3.4 s.',
    ],
    chapters: [
      { chapter: 'tcp', step: 0, label: 'A stream over datagrams' },
      { chapter: 'tcp', step: 1, label: 'Three segments to begin' },
      { chapter: 'tcp', step: 2, label: 'Numbers that count bytes' },
      { chapter: 'tcp', step: 3, label: 'The window: room at the far end' },
      { chapter: 'tcp', step: 4, label: 'How long to wait' },
      { chapter: 'tcp', step: 7, label: 'The same rules, on our CPU' },
    ],
  },
  aimd: {
    idea: `The receive window protects the receiver. Nothing announces what the network can hold, so each sender keeps a <b>congestion window</b>, a guess, and treats a loss as the signal: it may have min(cwnd, rwnd) bytes unacknowledged. <b>Slow start</b> adds a segment per ACK, doubling every round trip until a loss or <code>ssthresh</code>. <b>Congestion avoidance</b> then adds one segment per round trip. Three duplicate ACKs halve the window; a timeout drops it to one segment, since a timeout means nothing has been arriving.<br><br><b>Additive increase, multiplicative decrease</b> is not arbitrary (Chiu and Jain, 1989). Adding the same to two flows keeps the difference between them; halving both halves it. Repeat, and they converge on equal shares while the total keeps finding the limit. The sawtooth is what finding a limit looks like when nobody tells you where it is. Jacobson's 1988 scheme came after data throughput between two sites 400 yards apart fell from 32 kb/s to 40 b/s, because everyone's timers fired and everyone sent again.`,
    example: {
      title: 'The Python TCP on the bench, the window in segments',
      body: `<pre>wire speed, 8,000 bytes:  2 3 4 … 16, no drops, no retransmission
200 clocks a byte, queue 4, 6,000 bytes:
  … 11 4 5 6 3 4 5 6 3 4 5 6 …   7 drops, 5 fast retransmits, 1 timeout
400 clocks a byte, queue 3, 3,000 bytes:
  … 7 1 2 3 4 1 2 3 4 …          8 drops, 0 fast retransmits, 5 timeouts</pre>`,
    },
    mistakes: [
      'Calling slow start slow: it doubles every round trip. It is slow only beside the older habit of sending a whole window at once.',
      'Reading the sawtooth as a fault: with no signal but loss, a sender finds the limit by passing it.',
      'Treating every loss as congestion: a noisy radio link loses packets with no queue anywhere, and a sender that halves for them gets far less than the link can carry. This is what BBR and link-layer retries go after.',
      'Confusing the two windows: cwnd is the sender\'s guess and is announced by nobody; the receive window is in every segment. The sender obeys the smaller.',
    ],
    chapters: [
      { chapter: 'tcp', step: 5, label: 'How fast: the sawtooth' },
      { chapter: 'tcp', step: 7, label: 'The same rules, on our CPU' },
    ],
  },
  bufferbloat: {
    idea: `The sawtooth's teeth are the bottleneck's queue filling, so its size matters in two opposite ways. <b>Too short</b>, and a loss leaves too few segments in flight behind it for three duplicate ACKs: only the timer can recover, after a whole RTO, from one segment. The rule of thumb is one bandwidth-delay product, enough that a halved window still fills the link.<br><br><b>Too long</b>, and nothing is dropped until the window reaches it, so it sits full, and every packet of every flow waits behind it. Throughput gains nothing while the round trip grows by a queue's worth. That is <b>bufferbloat</b>: memory got cheap, home routers shipped with seconds of buffer, and one upload could make a web page crawl on the same link. The cure has to be in the router, since a sender cannot tell a full queue from a long path: <b>active queue management</b> such as CoDel (RFC 8289) drops or marks packets that have waited too long, and fair queueing gives each flow its own.`,
    example: {
      title: 'The same link, whatever the queue',
      body: `<pre>8,000 bytes at 200 clocks a byte, 20,000 clocks each way (the model):
queue 2:  5,834,908 clocks, 14 drops, 14 timeouts, SRTT  67,669
queue 4:  4,280,132 clocks,  9 drops,  1 timeout,  SRTT  98,928
queue 8:  3,054,241 clocks,  0 drops,              SRTT 153,072
each queued frame adds 118 × 200 = 23,600 clocks to the round trip

a home router: 1 MB of queue on a 10 Mb/s uplink = 0.8 s on every packet going out</pre>Our receive window of 8 segments caps the queue here. A real window of megabytes does not.`,
    },
    mistakes: [
      'Buying more buffer to reduce loss: past what the path needs, it adds delay and no throughput.',
      'Measuring on an idle link: bufferbloat appears only when something fills the queue, so a speed test can look fine while a video call on the same link suffers.',
      'Blaming the far end: the queue that matters is at the bottleneck, usually the first slow link out of the house, not somewhere on the internet.',
      'Tuning the sender: nothing there can see the queue, so the cure belongs where the queue is.',
    ],
    chapters: [
      { chapter: 'tcp', step: 5, label: 'How fast: the sawtooth' },
      { chapter: 'tcp', step: 6, label: 'Queues that fill' },
    ],
  },
};
