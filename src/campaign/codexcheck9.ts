// Check yourself questions for the entries of codexmore7.ts (see codexcheck.ts), group 9: Communication, chapters 51-53. Answers first: the quiz shuffles the options
// (ui/quiz.ts shuffleOrder). Numbers pinned by tests/content-codexcomm.test.ts. No DOM.

import type { Quiz } from '../chapters/types';

export const CHECK9: Record<string, Quiz[]> = {
  lpm: [
    {
      question: 'A table holds 0.0.0.0/0, 10.0.0.0/8 and 10.1.0.0/16. Which route does 10.2.3.4 take?',
      options: ['10.0.0.0/8: it matches the /0 and the /8, and the /8 is longer', '10.1.0.0/16: the longest in the table', '0.0.0.0/0: the first in the table', 'None: no entry equals the address'],
      answer: 0,
      explain: 'The second byte is 2, so the /16 does not match. Of the two that do, the longer one is the more specific, and a default route loses to everything.',
      why: ['', 'It has to match first: the length of a route that does not match means nothing.', 'Order means nothing in a table of prefixes.', 'A route is a prefix, not an address.'],
    },
    {
      question: 'Why does a binary trie take at most 33 reads, however many routes it holds?',
      options: ['A walk reads one node per address bit used, and an address has 32 bits, plus the root', 'It holds at most 33 routes', 'Each read halves the number of routes left', 'It stops at the first route it passes'],
      answer: 0,
      explain: 'The depth depends on the address, not the table. It cannot stop at the first route, since a longer one may lie below: it remembers the last one and goes on until a child is missing.',
      why: ['', 'Here it holds 1024 nodes, and tables run to a million routes.', 'That is binary search over a sorted list, which does not work for prefixes of different lengths.', 'Stopping there would give the shortest match, not the longest.'],
    },
  ],
  fastpath: [
    {
      question: 'Why can a router update the checksum without reading the rest of the header again?',
      options: ['The sum is linear: one word changed by a known amount, so the sum changes by the same amount', 'The TTL is not covered by the checksum', 'The next router recomputes it anyway', 'It covers only the addresses'],
      answer: 0,
      explain: 'A ones\' complement sum moves by what one word moves by. Lowering the TTL lowers the word {TTL, protocol} by 0x0100, which RFC 1624 writes as HC\' = ~(~HC + 0xFEFF), the carry brought round.',
      why: ['', 'It covers the whole header, which is why it changes at every hop.', 'Every router verifies it, so a wrong one would be dropped at the next hop.', 'It covers all twenty bytes.'],
    },
    {
      question: 'A frame arrives whose header checksum fails. What does the fast path do?',
      options: ['Drop it, with no reply: the addresses in that header cannot be trusted', 'Send it to the slow path, which answers with an ICMP error', 'Forward it: the far host will notice', 'Correct it from the checksum'],
      answer: 0,
      explain: 'An error message would go to the source address, which may be the very bit that was damaged. A TTL that ran out is different: that header is good, so the slow path answers it.',
      why: ['', 'That is for a TTL that ran out or no route, whose headers are good.', 'Every router checks the header, since a wrong address could misroute it.', 'A checksum of this kind detects; it holds nothing to correct with.'],
    },
  ],
  routing: [
    {
      question: 'On A - B - C the link B - C fails. Without poison reverse, why does the cost to C climb a little each round?',
      options: ['B hears A\'s old route to C, which ran through B, and believes it; then A believes B', 'Each router lowers a TTL', 'A floods the failure one hop a round', 'The link\'s cost rises while it is down'],
      answer: 0,
      explain: 'A\'s table only says "2 to C". It does not say the path runs through B, so B takes it, and each raises its cost on the other\'s word until both reach infinity, here 16.',
      why: ['', 'TTL is on packets; this is about tables.', 'Nothing is flooded in distance vector, and A never learns of the failure as such.', 'B stops using a link that is down at once.'],
    },
    {
      question: 'What does link state pay, to be free of counting to infinity?',
      options: ['Memory for the whole map on every router, and a run of Dijkstra per change', 'A longer TTL on every packet', 'A central computer that all routers ask', 'A slower fast path'],
      answer: 0,
      explain: 'Each router floods only its own links, so every router ends up with the same map and computes its own routes from it. Nobody believes a stale number, because nobody is passing numbers on.',
      why: ['', 'The TTL plays no part in either protocol.', 'No central computer: each router computes alone, which is the point.', 'The fast path reads a table, whichever protocol filled it.'],
    },
  ],
  tcp: [
    {
      question: 'A sends bytes 0 to 63, 64 to 127 and 128 to 191, and the middle segment is lost. What does the receiver\'s ACK say after the third arrives?',
      options: ['64: everything before it has arrived, and 64 has not', '192: the highest byte seen, plus one', '128: the start of the last segment', 'Nothing: it waits for the gap to fill'],
      answer: 0,
      explain: 'A cumulative ACK can only name the first gap. Repeating 64 is what tells the sender that something is wrong, so holding it back would hide the signal.',
      why: ['', 'That would tell the sender the lost segment arrived, and it would never be sent again.', 'An ACK names the next byte expected.', 'Silence would waste the one signal the sender has before its timer.'],
    },
    {
      question: 'Why does a sender facing a zero window need a timer, when the receiver will say when it has room?',
      options: ['That update is a segment with no data: nothing would resend it if it were lost', 'The receiver forgets the sender after a while', 'To measure the round trip', 'To keep the routers\' tables alive'],
      answer: 0,
      explain: 'Only what holds a sequence number is retransmitted. A pure ACK does not, so a lost one is simply gone, and both ends would wait for each other forever. So the sender probes with one byte.',
      why: ['', 'A connection keeps its state as long as it is open.', 'Probes give no useful sample.', 'Routers keep no per-connection state.'],
    },
  ],
  aimd: [
    {
      question: 'cwnd is 16 segments and the receiver announces 8 segments. How much may be unacknowledged?',
      options: ['8 segments: the smaller of the two', '16 segments: cwnd is the sender\'s own', '24 segments: they add', '4 segments: half the smaller'],
      answer: 0,
      explain: 'They are two limits on one quantity, min(cwnd, rwnd). In the wire-speed run on the bench, cwnd climbs to 16 while the receive window keeps what is in flight to 8.',
      why: ['', 'Sending past the receive window fills a buffer that is not there.', 'They are limits, not allowances.', 'Halving is what a loss does to cwnd, and only then.'],
    },
    {
      question: 'Why multiply on the way down but add on the way up?',
      options: ['Adding the same to two flows keeps their difference, and halving both halves it, so they converge on equal shares', 'Halving is cheaper to compute than subtracting', 'It keeps the window a power of two', 'It makes slow start exponential'],
      answer: 0,
      explain: 'Chiu and Jain showed this in 1989. Repeat the cycle and the gap between two flows shrinks to nothing while their total keeps finding the limit.',
      why: ['', 'Cost was not the reason: a subtraction is as cheap.', 'Adding one MSS a round trip leaves powers of two at once.', 'Slow start is a separate phase, and has no decrease in it.'],
    },
  ],
  bufferbloat: [
    {
      question: 'A queue holds 2 frames and the window is rarely above 4 segments. A frame is dropped. Why does this usually end in a timeout?',
      options: ['Too few segments follow the lost one to produce three duplicate ACKs', 'Duplicate ACKs are not sent when the queue is short', 'The round trip is too short to measure', 'The router tells the sender to wait'],
      answer: 0,
      explain: 'Each duplicate ACK needs a later segment to arrive. With two or three in flight there are not three later ones, so only the timer can notice, after a whole RTO, and then the window falls to one segment.',
      why: ['', 'The receiver sends one for every out-of-order arrival, whatever the queue.', 'A short round trip is measured just as well.', 'Routers here say nothing: a drop is the only signal.'],
    },
    {
      question: 'A router\'s queue holds 1 MB on a 10 Mb/s uplink, and someone uploads a large file. What delay does it add to every other packet going out?',
      options: ['About 0.8 s: 8 Mb at 10 Mb/s', 'About 8 ms: 1 MB at 1 Gb/s', 'Nothing: other flows go first', 'About 80 s: 800 Mb at 10 Mb/s'],
      answer: 0,
      explain: 'TCP fills the queue, since nothing is lost until it is full, and each packet then waits behind all of it. A plain first-in, first-out queue makes every flow pay.',
      why: ['', 'The bottleneck is the uplink, not the faster network behind it.', 'Not in a first-in, first-out queue. Fair queueing would give this, and is part of the cure.', '1 MB is 8 Mb, not 800.'],
    },
  ],
  bgp: [
    {
      question: 'Why can BGP not count to infinity, as distance vector does?',
      options: ['A route carries the whole list of networks it crosses, and a network that finds its own number in it refuses it', 'It runs Dijkstra on a full map', 'Its routes expire after one round', 'A central registry checks every route'],
      answer: 0,
      explain: 'Counting to infinity comes from a number that does not say how it was reached. The path says exactly that, so a loop is visible to the network that would close it.',
      why: ['', 'That is link state, inside one network; no network shows another its whole map.', 'Routes stay until withdrawn.', 'BGP believes what it hears, which is its other weakness.'],
    },
    {
      question: 'A network has two routes to a destination: through a customer, 5 networks long, and through a provider, 2 long. Which does BGP policy usually take?',
      options: ['The customer: a customer pays you, and a provider bills you, whatever the length', 'The provider: the shorter path wins', 'Both, sharing the load equally', 'Neither: it asks the destination'],
      answer: 0,
      explain: 'Policy comes before length: customer, then peer, then provider. Path length only separates routes the policy ranks alike, which is why the shortest wire is often not used.',
      why: ['', 'Length only breaks ties among routes of the same rank.', 'BGP picks one best route per prefix.', 'Nobody asks the destination; routes are advertised towards you.'],
    },
  ],
  internetpath: [
    {
      question: 'One way takes 47.7 ms on a path where 47.5 ms is light. What would make it markedly faster?',
      options: ['A shorter route or a nearer copy of the content', 'Links ten times faster', 'A faster router engine', 'A larger TCP window'],
      answer: 0,
      explain: 'Light in fibre takes 5 µs a kilometre whatever anyone pays. The rest of the delay here is 0.2 ms, so nothing that acts on bits, queues or engines has anything left to save.',
      why: ['', 'Bits are already a tiny share of this path.', 'The engine is the smallest part of all.', 'A window changes how much is in flight, not how long a packet takes.'],
    },
    {
      question: 'How does traceroute find the routers on a path?',
      options: ['It sends probes with TTL 1, 2, 3, and each router in turn reports the one it had to kill', 'Each router adds its address to the packet', 'It asks BGP for the path', 'It reads the routers\' tables'],
      answer: 0,
      explain: 'A packet arriving with a TTL of 1 cannot go on, so the router sends an ICMP "time exceeded" from its own address. Each line is a separate packet, and its time includes a way back that may differ.',
      why: ['', 'IP has an option like that, and it is almost never honoured.', 'BGP paths are lists of networks, between routers, and not open to a host.', 'A host has no way to read another\'s tables.'],
    },
  ],
};
