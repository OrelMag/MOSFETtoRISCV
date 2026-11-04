// The fuller texts of the Communication entries of chapters 48-50 (codexcomm.ts): Ethernet, the switch, computers on a network.
// Every number is the chapter's own, computed from comm/ and the library (tests/content-codexcomm.test.ts pins them to the
// models, to the gate counts and to the chapter steps that print them). No DOM.

import type { CodexMore } from './codexmore';

export const MORE6: Record<string, CodexMore> = {
  ethframe: {
    idea: `A wire shared by many machines delivers every byte to all of them, so the first thing a frame says is who it is for. An Ethernet frame is a <b>6-byte destination</b>, a <b>6-byte source</b>, a <b>2-byte type</b>, the payload and a <b>4-byte FCS</b>. The first byte of an address carries two flags: bit 0 set is a <i>group</i> address (the all-ones address is the broadcast, which every station takes) and bit 1 set is <i>locally administered</i>, assigned by the owner rather than the manufacturer. The first byte is the first on the wire, and so is its bit 0. A value of 1536 (0x0600) or more in the type field is an <b>EtherType</b> (0x0800 IPv4, 0x0806 ARP); 1500 or less is a length, which is how 802.3 frames announce theirs. Ethernet II, the format this book uses, has a type and no length, so a payload under 46 bytes is padded with zeros up to the minimum and the layer above has to know where its own data ends.<br><br>The FCS is the CRC-32 of chapter 47 over everything from the destination to the pad, sent least significant byte first; a receiver that runs the same register over the frame and its FCS always ends at the constant 0xDEBB20E3 when nothing is wrong. In front of the frame the wire carries seven bytes of 0x55 and the start-of-frame delimiter 0xD5. Each byte goes least significant bit first, so the preamble is 1 0 1 0 1 0 1 0 repeated, a square wave for the receiver to align to, and the delimiter ends 1 0 1 0 1 0 1 1: two ones in a row say the next bit is the first of the frame. After the frame the sender leaves 96 bit times of silence.`,
    example: {
      title: 'A 20-byte message, and what the wire carries',
      body: `<pre>destination 6 + source 6 + type 2        14 bytes
payload 20 + pad of zeros 26            46 bytes (the minimum)
FCS over the 60 bytes so far             4 bytes     = 64, the minimum frame
preamble 7 + delimiter 1                 8 bytes     = 72 bytes = 576 bit times
+ gap 96 bit times                                    = 672 bit times
payload share: 8 · 46 / 672 = 55 %     (a maximum frame: 8 · 1500 / 12 304 = 98 %)
address 02:00:00:00:00:01: first byte 0x02, bit 0 = 0 unicast, bit 1 = 1 local
address 01:00:…: group;   ff:ff:ff:ff:ff:ff: broadcast</pre>The minimum frame is 576 bit times, 2,304 clocks at this book's 4 clocks a bit, 9.1 µs at 63 Mb/s. The pad is part of what the FCS covers, so pad in one place only.`,
    },
    mistakes: [
      'Reading the 2-byte field as a length in an Ethernet II frame: 1536 or more is a type, and the layer above (IP\'s total length) must say where its data ends, because the pad is not described anywhere in the frame.',
      'Padding at two layers: the FCS covers the pad, so a frame padded by the layer above and one padded by the MAC match only if both pad with the same zeros. Pad in one place.',
      'Summing the pad into an upper-layer checksum: a 20-byte message in a 60-byte frame has 26 bytes that are not part of it.',
      'Treating the preamble as part of the frame: it and the delimiter are not covered by the FCS and a capture normally has neither.',
    ],
    chapters: [
      { chapter: 'ethernet', step: 0, label: 'Many machines, one wire' },
      { chapter: 'ethernet', step: 1, label: 'The transmitter' },
      { chapter: 'ethernet', step: 5, label: 'Why a minimum frame exists' },
    ],
  },
  csmacd: {
    idea: `With one wire for all stations the first rule is the human one: do not talk over someone. <b>Carrier sense</b> (the MAC's <code>crs</code>) is 1 while any station is sending, this one included. A station with a frame ready waits for the wire to be silent for the <b>inter-frame gap</b>, 96 bit times, and then sends. Ethernet is <i>1-persistent</i>: a station that finds the wire busy waits for the carrier to end and sends as soon as the gap has passed, which is efficient at low load and is why two stations that waited for the same frame send at the same instant.<br><br>Even a careful station collides, because the wire has length: until the first bit of the other frame arrives, the cable looks free. The transmitter's rule is the whole of collision detection: <b>a carrier heard while sending is a collision</b>, one AND of <code>txen</code> with the carrier from the others. It stops, sends a <b>jam</b> of 32 bits so that stations farther away also see a carrier long enough to count, and goes to <b>truncated binary exponential backoff</b>: after the n-th collision wait r slots of 512 bit times, r uniform in 0 … 2<sup>min(n, 10)</sup> − 1, and give up after 16 attempts. The draw is a free-running 10-bit LFSR sampled when the jam ends, and the seeds must differ or two stations draw equal numbers forever.<br><br>Detection needs the sender still to be sending when the news returns: with signal speed v and cable length d, 2d / v must not exceed the frame's time. That fixes the minimum frame: 512 bit times, which is 64 bytes. At 0.66 c the slot allows 5,065 m of cable by propagation alone at 10 Mb/s and 507 m at 100 Mb/s (the same count of bit times in a tenth of the time), 51 m at 1 Gb/s. A frame shorter than the round trip lets a collision go unseen: the sender finishes, believes the frame went out, and nothing is repeated.`,
    example: {
      title: 'The backoff range, and the cost of a wait',
      body: `<pre>collision n    r drawn from        mean wait (slots)
     1           0 … 1              0.5
     2           0 … 3              1.5
     3           0 … 7              3.5   = 1 792 bit times = 179.2 µs at 10 Mb/s
    10+          0 … 1023           (the range stops growing; 16 attempts, then give up)
two stations: they collide again with probability 2^-min(n,10): ½, ¼, ⅛ …
this book's link: 63 Mb/s, slot 512 · 4 = 2 048 clocks, 800 m of cable at 0.66 c
news returns in time while the cable delay is under 576 · 4 / 2 = 1 152 clocks</pre>Run hard, one station often wins the wire for long stretches: the winner of a collision starts its next frame with a short range while the loser's has doubled, so the winner's next collision is again decided in its favour (<i>capture</i>). Backoff is fair to frames and unfair to stations.`,
    },
    mistakes: [
      'Believing a collision is an error: it is the access method working when two stations ask at once. It is detected and cleaned up in about a slot time, and no higher layer is told until 16 attempts have failed.',
      'Giving two MACs the same backoff seed: both sample the LFSR at the same moment, draw the same number every time, and collide on every retry.',
      'Keeping the 64-byte minimum at a higher bit rate without shortening the cable: the same 512 bit times cover a tenth of the distance at 100 Mb/s.',
      'Expecting CSMA/CD on a switched full-duplex link: each wire has one sender, there is no carrier to sense and nothing to collide with; the minimum frame stays only as a convention.',
    ],
    chapters: [
      { chapter: 'ethernet', step: 3, label: 'Listen before talking' },
      { chapter: 'ethernet', step: 4, label: 'Collisions' },
      { chapter: 'ethernet', step: 5, label: 'Why a minimum frame exists' },
      { chapter: 'ethernet', step: 6, label: 'Binary exponential backoff' },
    ],
  },
  ethmac: {
    idea: `The MAC speaks to the layer above in bytes and to the wire in bits. Above it the interface is a <b>byte stream</b>: <code>data[7:0]</code>, <code>valid</code>, <code>last</code>, and <code>ready</code> from the MAC; a byte moves at a clock edge where both valid and ready are 1. The frame is the bytes from the destination to the last payload byte, with no preamble and no FCS: the MAC adds those. Below it is a bit pair, <code>txd</code> with <code>txen</code> out, <code>rxd</code> with <code>crs</code> in, one bit per 4 clocks (a byte every 32), which is the MII cut down to a bit. The same stream is the interface of chapter 49's switch.<br><br>The <b>transmitter</b> is a shift register and a few counters. At each byte boundary a state picks the next byte: seven of 0x55 and 0xD5, then the stream's bytes, then zeros until 60 bytes have gone out, then the four FCS bytes from the complemented CRC register, which a byte-wide CRC unit (1,027 NANDs) keeps current as the bytes load. It waits 96 bit times (384 clocks) of silence first. A byte that is not valid when the wire needs it is an <i>underrun</i>: the MAC ends the frame, pads it and complements the FCS on purpose, so that every receiver rejects it. The <b>receiver</b> hunts the preamble by restarting a bit counter at every edge, shifts bits into an 8-bit register until it reads 0xD5, then counts bytes, feeds the CRC and compares the first six with the station's address (or a group address, or anything with <code>promisc</code>). It cannot know where the frame ends until the carrier falls, so it holds the last four bytes plus one in a delay line: byte k leaves when byte k + 5 has arrived, and the final data byte leaves at the fall, with <code>last</code> and a valid <code>err</code>. The register then holds 0xDEBB20E3 if the frame was good; <code>why</code> names the reason otherwise.`,
    example: {
      title: 'Cost and timing of the pair',
      body: `<pre>transmitter 3 553 NANDs (of which the byte-wide CRC unit 1 027)
receiver    3 213 NANDs
one bit 4 clocks, one byte 32 clocks
minimum frame: 576 bit times = 2 304 clocks   (+ gap 384 clocks)
first frame after reset: 385 clocks in at the earliest
receive: write each byte as it arrives; at last, either
  commit pointer := write pointer (kept) or write pointer := commit pointer (never was)</pre>The alternative to commit-or-rewind, holding the whole frame in the MAC until the FCS is known, costs 1,518 bytes of RAM in every MAC and a frame time of latency on every frame.`,
    },
    lib: 'eth_mac_rx',
    compare: ['eth_mac_tx'],
    mistakes: [
      'Letting a consumer act on bytes before the commit: the receiver hands the frame over first and judges it after the last byte, so anything downstream of the buffer must wait for last and a clear err.',
      'Dropping valid in the middle of a frame: the wire cannot wait, so the transmitter ends the frame with a wrong FCS. Start a frame only when it is wholly in the buffer.',
      'Offering a byte while ready is 0: ready is a promise, not flow control; a byte offered while it is low is lost and the frame is marked.',
      'Looking for the preamble\'s pattern 0xD5 in the preamble itself: its windows are 0x55 and 0xAA, never 0xD5, which is why the delimiter is unambiguous.',
    ],
    chapters: [
      { chapter: 'ethernet', step: 1, label: 'The transmitter' },
      { chapter: 'ethernet', step: 2, label: 'The receiver' },
      { chapter: 'ethernet', step: 7, label: 'A segment' },
    ],
  },
  learnsw: {
    idea: `A circuit switch reserves a path per call and spends most of its life carrying silence; data comes in bursts. A <b>packet</b> carries its destination and the sources share the capacity, a queue absorbing the excess. With 20 sources each active 10 % of the time the demand is binomial: keeping the overflow below one in a million takes 10 units on a shared link against 20 reserved. The price is queues and loss, and each packet's address has to be read and looked up at wire speed.<br><br>A <b>learning switch</b> starts knowing nothing about the hosts behind its ports and learns it from the frames, which carry both addresses. A frame from source S arriving on port p says S is behind p: the pair goes into the table. To forward, the switch looks up the destination D. A <b>hit</b> gives one port. A <b>miss</b>, or a group address (never learned), is <b>flooded</b> to every port except the arrival one. A frame whose destination is on the port it came from is <b>filtered</b>. Entries <b>age</b>: a stamp is refreshed when the host speaks and an entry is live while the tick is less than 64 ahead of its stamp; a host that moves is relearned from its first frame.<br><br>The table here is hashed in RAM. The 48-bit address is XOR-folded to t bits (bit i of the hash is the XOR of address bits i, i + t, i + 2t …, 48 − t two-input XORs), the slot is read and its key compared. Addresses differing only in the low t bits always land in different slots; others can collide. A slot holds 59 bits (key 48, valid 1, port 2, stamp 8) in two RAM blocks because a RAM word here is at most 32 bits; the destination's slot is read on one port, the source's on the other and written back at the end of the same cycle.`,
    example: {
      title: 'A collision, and what a table costs',
      body: `<pre>t = 4:  0x7F → 7 ⊕ F = 8     0x80 → 8 ⊕ 0 = 8     same slot
  both hosts live: each frame one sends evicts the other, whose next frame is a miss
  → flooded to 3 ports, the eviction counter ticks; connectivity survives, bandwidth does not
16-entry table as built      28 876 NANDs  (the two RAM blocks alone 26 008)
library CAM 16 × 59 bits     21 229        48-bit key store alone 17 357
128 entries: table 213 699,  48-bit CAM 139 748
empty table, A → B: flooded to the other three ports, A learned; then B → A: one port</pre>In this accounting neither is clearly cheaper. In silicon an SRAM cell is smaller than a binary CAM cell and a search charges every match line, which is why large tables are hashed RAM.`,
    },
    mistakes: [
      'Learning from the destination address: it says nothing about where that host is. Only the source of a frame arriving on a port reveals what sits behind it.',
      'Sending a flooded frame back out of its arrival port: the sender is on that wire and would see its own frame.',
      'Learning a group address as a source (the broadcast address is never a source), and forgetting that a broadcast must reach every host, so one switched network is bounded by the broadcast its hosts can stand.',
      'Sizing a hashed table to the number of hosts: a table too small does not fail loudly, every colliding pair floods its traffic to three ports and the evictions counter is the only sign.',
    ],
    chapters: [
      { chapter: 'switch', step: 0, label: 'Everyone at once' },
      { chapter: 'switch', step: 1, label: 'Learning' },
      { chapter: 'switch', step: 2, label: 'The table\'s price' },
    ],
  },
  crossbar: {
    idea: `Once the table has said which output a frame needs, the bytes must get there. The <b>crossbar</b> is the direct fabric: every input can reach every output, with a multiplexer in front of each output choosing the input that drives it. Four ports are four 4:1 multiplexers of ten bits (the byte, <code>last</code>, <code>valid</code>), 724 NANDs including the return path of ready. Any set of inputs addressed to different outputs moves at once; N inputs and N outputs cost N² crosspoints, chapter 40's crossbar again, carrying bytes through gates where it carried calls through contacts.<br><br>What it cannot decide is two inputs for one output, so each <b>output port</b> owns the decision: a round-robin arbiter (125 NANDs), a busy flag that holds the output for the length of a frame and a register naming the input that drives it. Each cycle every idle input with a frame waiting offers itself to the lowest-numbered idle output it has a frame for, and each idle output grants one asker in rotating priority, so nobody starves. One round of request and grant a cycle, no iteration, keeps the arbiter small. A granted frame is read from the input's buffer one byte a cycle for as long as the output's <code>ready</code> is 1.<br><br>When may an output start a frame that is still arriving? <b>Store-and-forward</b> waits for the last byte, so the length is known and the MAC has checked the FCS (a bad frame is never queued), at the cost of a frame time per hop. <b>Cut-through</b> starts once the destination is known. It has sent most of a frame before its FCS can be checked, so it can only count the error and pass the bad FCS on or stamp one; it cannot filter runts, and it cannot cross a speed change.`,
    example: {
      title: 'Latency and cost of a four-port switch',
      body: `<pre>64-byte frame, a byte a cycle:  store-and-forward out at cycle 65 (last byte in at 63)
                                 cut-through out at cycle 14 (table answered)
1518-byte frame, 100 Mb/s:       (1518 + 8) · 8 = 12 208 bits = 122.1 µs per hop
  cut-through waits for preamble + 6 address bytes: 112 bits = 1.1 µs
crossbar 724 NANDs · arbiter 125 · output port 516 · table port 1 292
one input buffer 142 221 NANDs with 128-byte cells, 2 219 295 with 2048-byte cells
whole bench switch 1 195 167 NANDs (128-byte cells); 17 810 671 with 2048-byte cells</pre>The buffers dominate, almost all of it RAM, which a real switch builds as SRAM.`,
    },
    lib: 'eth_xbar',
    compare: ['eth_out', 'eth_tport'],
    mistakes: [
      'Calling the crossbar the bottleneck: it is non-blocking, so any loss is in the queues and the arbitration, not the fabric.',
      'Granting without holding: the grant must last the frame, or a transfer would change source in the middle of a frame.',
      'Taking cut-through for free: the check moves to the next receiver, the switch may forward a runt or a corrupted frame, and the output can start no sooner than the lookup.',
      'Comparing the arbiter\'s 125 NANDs with the switch: the cost of a switch is its buffers, not its logic.',
    ],
    chapters: [
      { chapter: 'switch', step: 3, label: 'The crossbar and its arbiter' },
      { chapter: 'switch', step: 4, label: 'Store-and-forward and cut-through' },
      { chapter: 'switch', step: 6, label: 'A switch on a bench' },
    ],
  },
  hol: {
    idea: `When two inputs want the same output, one waits. The question is where, and in what order. With <b>one FIFO per input</b> a frame waits at the head of its queue and everything behind it waits too, including frames bound for idle outputs: <b>head-of-line blocking</b>. Karol, Hluchyj and Morgan analysed a saturated N × N switch with uniform destinations in 1987: the throughput is 0.6553 for N = 4 and approaches 2 − √2 = 0.5858 as N grows. About a third of the fabric is idle with every input busy.<br><br>The cure is <b>virtual output queues</b>: one queue per output in every input, so a frame for an idle output is never behind a frame for a busy one. In this design it is a queue of cell numbers per output instead of one. The cost is small against an input's buffer and not even monotonic; the gain depends on how many frames the input can look past. With four cells and a saturated source the buffer is mostly full of frames for the same busy output. A single round of request and grant leaves the rest; iterative schemes such as iSLIP approach 100 %.`,
    example: {
      title: 'The measured switch against the analysis',
      body: `<pre>abstract cell model, 4 ports, uniform         0.655   (published 0.6553)
abstract model, 64 ports                       0.590   (limit 2 − √2 = 0.5858)
no host sends to its own port (3 choices)      0.691
a frame takes 65 cycles to move 64 bytes: × 64/65 = 0.680   the gate-level switch measures 0.68
one queue per output:  4 cells ≈ 0.80, 8 ≈ 0.88, 16 ≈ 0.92
cost over one FIFO per input:  +945 NANDs (4 cells), +2 059 (8), +4 621 (16)</pre>Under a hot spot (half the traffic for one host) no discipline can deliver more than that output's line rate.`,
    },
    mistakes: [
      'Blaming the crossbar: the fabric could carry the younger frame, but a single queue never offers it.',
      'Expecting virtual output queues to help an input that holds one frame: they matter when there is a backlog to look past, and a buffer of four cells gives little.',
      'Reading the limit 0.5858 as a loss of 41 % in every switch: it is a saturated switch with uniform destinations, and a permutation pattern (no contested output) runs nearly at the full rate.',
    ],
    chapters: [
      { chapter: 'switch', step: 5, label: 'Queues and head-of-line blocking' },
      { chapter: 'switch', step: 6, label: 'A switch on a bench' },
    ],
  },
  nicring: {
    idea: `Why not hand the NIC a pointer and a length and wait? Because the CPU would wait with it, and because frames arrive when the wire says, not when the program asks. A <b>descriptor ring</b> is a small array in RAM, each entry naming a buffer and saying who may use it. The NIC walks the ring in order; so does the software; the two chase each other round the circle. A descriptor here is two words. <b>Word 0</b> is the buffer's address. <b>Word 1</b> has <code>OWN</code> in bit 31 (1: the NIC holds it) and the frame length in bits 10:0; on the transmit ring the NIC also sets bit 30 when the MAC gave up. The receive ring starts with every descriptor owned by the NIC; the transmit ring starts owned by the software, which fills a buffer, writes word 0, then word 1 with OWN and the length <i>last</i>, and writes the doorbell. No locks are needed because each descriptor has exactly one owner at a time and the owner is told by one bit in one word.<br><br>On receive, the NIC reads word 1 at the first byte (is it mine?) and word 0 (where?), gathers bytes in a 32-bit register and writes a word when four are in or the frame ends. The MAC reports the FCS verdict only with the last byte, so the frame is already in RAM when it is judged. A good frame ends with word 1 written, OWN clear, the length and the head advanced: the <i>commit</i>. A bad frame ends with nothing: the descriptor still says "NIC", the buffer holds garbage nobody was told about and the next frame overwrites it. That is the MAC's write-then-commit at the level of a descriptor, and it needs no undo. The NIC is a bus slave for its registers (CTRL, STATUS, IE, ring bases, the address, KICK, at 0x7000_0000) and a bus master for the frames, serving the receive engine first, because a wire cannot be stopped.`,
    example: {
      title: 'A 74-byte ping frame through the NIC',
      body: `<pre>send:    3 + ⌈74 / 4⌉ = 22 reads (two descriptor words, 19 frame words, a look at the next)  + 1 write
receive:  2 reads + ⌈74 / 4⌉ + 1 = 20 writes (the commit is the last)
NIC 15 425 NANDs, of which the two MACs 3 553 + 3 213 = 6 766
8 descriptors a ring, 1 536-byte buffers (the longest frame is 1 514)
driver (polled): 63 lines; a 64-byte frame, doorbell to wire 279 clocks, 2 432 clocks on the cable
  polled:      4 clocks a pass, frame seen 2 726 clocks after the doorbell, CPU busy all the time
  by interrupt: handler 11 clocks, frame seen at 2 718, the main loop keeps 99.6 %</pre>An interrupt wins on a quiet link and polling on a busy one; real drivers switch between them.`,
    },
    mistakes: [
      'Writing OWN before the address and length are in place: the NIC rescans as soon as it finishes a frame and can take a half-written descriptor. The bit that gives the descriptor away goes last.',
      'Reading a receive buffer whose descriptor still has OWN set: the bytes may be there, but nothing has said the frame is good.',
      'Letting the NIC write word 1 before the data: then software could read a half-written frame. Data first, length and OWN last.',
      'Polling on a busy link or interrupting on every frame of a fast one: an interrupt costs its entry and handler per frame, and a polling pass is a bus transaction the NIC\'s DMA shares the bus with.',
    ],
    chapters: [
      { chapter: 'network', step: 1, label: 'Registers and rings' },
      { chapter: 'network', step: 2, label: 'The NIC in gates' },
      { chapter: 'network', step: 3, label: 'A driver in assembly' },
    ],
  },
  inetcksum: {
    idea: `RFC 1071: add the data as 16-bit words, unsigned; wherever a sum passes bit 15, fold the carry back into bit 0; invert the result. That is the checksum field. In ones' complement arithmetic the end-around carry makes the sum independent of the order of the words and of the byte order the machine uses, so any machine may add in any word size and fold afterwards. A receiver adds the whole block, field included, and gets 0xFFFF when it is consistent: the field is the complement of the sum of the rest. An odd last byte is padded with a zero. There is no multiplier and no table; the loop adds two bytes a pass.<br><br>It is a fingerprint, not a code with a design distance. A single flipped bit changes the sum and is caught; two flips that cancel, words that swap places and bytes of zeros that move are not. Against random corruption it passes about once in 2<sup>16</sup>, against the CRC-32 of the Ethernet FCS at 2<sup>−32</sup>, which is why the Internet runs both: the CRC protects each link, the checksum protects the datagram across the routers and memories that sit between the links. IPv4 covers its header only; ICMP its whole message; UDP the datagram and a <b>pseudo-header</b> (the two addresses, a zero byte, the protocol, the UDP length) that is not sent, so a datagram that reaches the wrong address fails. In ones' complement 0x0000 and 0xFFFF are both zero, which is why UDP sends a computed zero as 0xFFFF and reads a zero field as no checksum.`,
    example: {
      title: 'RFC 1071\'s words, and a header',
      body: `<pre>words  0001 f203 f4f5 f6f7
sum     0001 + f203 + f4f5 + f6f7 = 0x2DDF0   fold: 0xDDF0 + 2 = 0xDDF2
field   ~0xDDF2 = 0x220D        block with the field: sums to 0xFFFF

IPv4 header  4500 0073 0000 4000 4011 [----] c0a8 0001 c0a8 00c7
field zero → checksum 0xB861; with 0xB861 in place the sum is 0xFFFF</pre>On the gates the byte helpers (get16, put16, get32, put32, ones_sum) are 48 % of the clocks of an echo request received and answered: every byte is a separate bus transaction and the checksum touches each one. A NIC that sums as it moves the bytes would remove most of it.`,
    },
    mistakes: [
      'Summing the pad: Ethernet pads a short frame to 60 bytes, and the ICMP or UDP checksum covers the datagram\'s own length (from IP\'s total length), not the frame\'s.',
      'Computing with the field not zeroed: the sender sums the message with the checksum field as zero, then stores the complement.',
      'Dropping the end-around carry (a plain 32-bit sum truncated to 16 bits): the carries above bit 15 must be added back, and may produce a carry of their own.',
      'Trusting a pass as proof: swapped words, compensating flips and moved zero bytes leave the sum unchanged.',
    ],
    chapters: [
      { chapter: 'network', step: 4, label: 'Bytes in the subset' },
      { chapter: 'network', step: 6, label: 'IPv4 and UDP' },
      { chapter: 'network', step: 7, label: 'ICMP: echo' },
    ],
  },
  arp: {
    idea: `The MAC of chapter 48 delivers to 48-bit addresses; programs name machines by 32-bit IP addresses. Something has to map one to the other, and on a shared cable the cheapest way is to ask. <b>ARP</b> (RFC 826) broadcasts a 28-byte packet: "who has 10.0.0.2? tell 10.0.0.1". The machine that owns the address answers, directly to the asker, with its MAC address. Both learn: the asker puts the answer in a table, and the answerer notes the asker, since it is about to be sent something.<br><br>The packet has a fixed shape: hardware type 1 (Ethernet), protocol type 0x0800 (IPv4), address lengths 6 and 4, an operation (1 request, 2 reply), then the sender's MAC and IP and the target's MAC and IP, the target MAC zero in a request. The frame is the broadcast address and EtherType 0x0806. The stack here has a four-entry table replaced round robin, no timeout, no retry timer and no gratuitous ARP. When <code>ip_send</code> finds no entry it sends the request, drops the frame it was about to send, and returns 0: the application tries again later. That is the behaviour of a stack with no queue for packets awaiting resolution, and it is why the first ping of a session is slow. Nothing above ARP learns from a packet's source address; ARP alone fills the table.`,
    example: {
      title: 'An ARP request, byte by byte',
      body: `<pre>Ethernet   ff:ff:ff:ff:ff:ff  02:00:00:00:00:01  0806        14 bytes
ARP        0001 0800 06 04 0001                               8 bytes
           sender 02:00:00:00:00:01  10.0.0.1                 10 bytes
           target 00:00:00:00:00:00  10.0.0.2                 10 bytes  = 42 bytes
the MAC pads it to 60; on the wire 8 + 60 + 4 = 72 bytes, with the gap 84 bytes = 2 688 clocks
on the gates: sending the request 410 instructions, 510 clocks;
              answering it (and learning) 719 instructions, 912 clocks</pre>The cable holds the frame for 2,688 clocks (10.6 µs at 3.95 ns a clock) each way, about five times the software\'s time to send the request.`,
    },
    mistakes: [
      'Learning from every packet\'s source address: here only ARP fills the table, so a request from a host not in it has its reply dropped and an ARP request sent in its place.',
      'Expecting the first packet to wait for the answer: without a queue of pending packets the frame is dropped and the application must try again.',
      'Giving entries no lifetime: a replaced NIC changes the mapping, and a stack with no timeout learns it again only from the next ARP packet addressed to it.',
    ],
    chapters: [
      { chapter: 'network', step: 5, label: 'ARP: IP address to MAC address' },
      { chapter: 'network', step: 8, label: 'Ping across the wire' },
    ],
  },
  ipv4: {
    idea: `An <b>IPv4 datagram</b> (RFC 791) carries an upper-layer message from one address to another across any number of links. The header is 20 bytes: version 4 and a header length of 5 words in the first byte (0x45); a type of service; the <i>total length</i>; an identification; flags and a fragment offset; a time to live; the protocol of the payload (1 ICMP, 6 TCP, 17 UDP); the header checksum; the two addresses. The checksum covers the header only; each upper layer protects its own data. <b>IP does not promise</b> delivery, order or once-only: a datagram may be dropped (full queue, failed checksum, expired TTL), reordered or duplicated, and the address says where, not who. This stack has no options, no fragmentation (the DF bit is set and a fragment is dropped), no reassembly and no routing but one gateway address. The receiver finds the end of the datagram by the total length, because Ethernet pads a short frame and the pad must not be summed into the ICMP or UDP checksum.<br><br><b>UDP</b> (RFC 768) is the thinnest transport: source port, destination port, length, checksum (over the datagram and a pseudo-header), then the data. No connection, retransmission or flow control; chapter 52 adds those in TCP. <b>ICMP</b> (RFC 792) rides in IP datagrams (protocol 1) and carries what IP cannot say. Type 8 is an echo request, type 0 the echo reply: the reply is the request with the type changed to 0, the checksum recomputed and the addresses swapped. That is <code>ping</code>.`,
    example: {
      title: 'A ping, layer by layer, on the gates',
      body: `<pre>data 32 + ICMP 8 = 40;  + IPv4 20 = 60 (total length 0x003C);  + Ethernet 14 = 74 bytes
+ FCS 4 + preamble and delimiter 8 = 86 bytes on the cable = 2 752 clocks (3 136 with the gap)
round trip, request to reply: 14 689 clocks = 58.0 µs at 3.95 ns
  cable 11 008 (four serializations of 2 752: two links each way, switch store-and-forward)
  software 3 673;  the switch's turnaround 8
receive and answer one echo request: 1 491 instructions, 1 882 clocks = 60 % of a frame time
  48 % of those clocks are the byte helpers</pre>Two computers, each the system CPU with a NIC, behind the four-port switch: 12,471,821 NANDs, the compiled stack 1,711 instructions in A and 1,322 in B.`,
    },
    mistakes: [
      'Using the frame\'s length as the datagram\'s: a 20-byte message is padded to 60 bytes of frame, and only the total length says where it ends.',
      'Expecting IP to tell the sender when something was lost: it does not, and nothing says the source address is who it claims. Anything reliable is built on top (chapter 52).',
      'Forgetting the byte order: the Internet is big-endian and the CPU little-endian; every multi-byte field goes through get16 / put16 and their 32-bit pairs, never through a word load.',
      'Reading the round trip as software time: three quarters of it is the cable, since each 74-byte frame is serialized on two links in each direction.',
    ],
    chapters: [
      { chapter: 'network', step: 6, label: 'IPv4 and UDP' },
      { chapter: 'network', step: 7, label: 'ICMP: echo' },
      { chapter: 'network', step: 8, label: 'Ping across the wire' },
      { chapter: 'network', step: 9, label: 'The cost of a packet' },
    ],
  },
};
