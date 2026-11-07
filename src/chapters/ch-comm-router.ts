// Chapter 51, A router: IPv4's real bytes, longest-prefix match as a trie in RAM, the fast path in gates compared with net/fastpath.ts at every
// output of every clock, the slow path it hands the rest to, and the two routing protocols on the invented network of net/routing.ts.

import { ROUTER_FAST, RT_CHECK, RT_REWRITE, RT_WALK, cam, equal, register } from '../lib';
import { bigRam } from '../lib/bigmem';
import { CAUSE_NAMES, C_FORWARD, C_LOCAL, C_NO_ROUTE, C_TTL } from '../net/fastpath';
import { BYTE_CYCLES, engineCycles, FRAME_60, portsServed, WIRE_60 } from '../widgets/router';
import { ipOf, TTL_DELTA, ttlChecksum } from '../net/ipv4';
import { CHAIN3, DistVec, floodAll, NET7 } from '../net/routing';
import { ADJ_K, buildTrie, BUF_K, TRIE_K, TRIE_NODES, walkTrie } from '../net/trie';
import { CLOCK_NS } from '../dram/timing';
import { flatten } from '../sim/flatten';
import { stats } from '../sim/stats';
import { analyzeTiming } from '../sim/timing';
import { CH_ROUTES, CH_TRIE, distVecWidget, engineWidget, fastPathScene, FP_FRAMES, ipHeaderWidget, linkStateWidget, lpmWidget, routerApi, ROUTER_SCENE_DEF } from '../widgets/router';
import type { Chapter } from './types';
import { numOf } from './order';

const n0 = (x: number) => Math.round(x).toLocaleString('en-US').replace(/,/g, ' ');
const nands = (d: Parameters<typeof stats>[0]) => stats(d).nands;

const MEM = { trie: nands(bigRam(TRIE_K, 24)), buf: nands(bigRam(BUF_K, 8)), adj: nands(bigRam(ADJ_K, 8)) };
const N = { all: nands(ROUTER_FAST), check: nands(RT_CHECK), walk: nands(RT_WALK), rew: nands(RT_REWRITE), cam: nands(cam(4, 32)) };
const LOGIC = N.all - MEM.trie - MEM.buf - MEM.adj;
const PERIOD = analyzeTiming(flatten(ROUTER_SCENE_DEF, { mode: 'gate' }))!.period;

const reads = walkTrie(CH_TRIE, ipOf('10.1.2.9')).reads;
const CY60 = engineCycles(FRAME_60, reads), CY_WORST = engineCycles(FRAME_60, 33);
const WIRE_CYCLES = WIRE_60;
const PORTS = portsServed(FRAME_60, 33);
const WIDE = { cmp: nands(equal(48)), reg: nands(register(48)), cmp8: nands(equal(8)) };
const MEM_PCT = Math.round(100 * (MEM.trie + MEM.buf + MEM.adj) / N.all);
const READS_200 = walkTrie(buildTrie(CH_ROUTES), ipOf('10.200.0.1')).reads;

const dvNet = (() => { const d = new DistVec(NET7); d.settle(); return { rounds: d.rounds, msgs: d.messages }; })();
const dvChain = (() => { const d = new DistVec(CHAIN3); d.settle(); d.fail(1, 2); const r = d.settle(); return r; })();
const dvPoison = (() => { const d = new DistVec(CHAIN3, true); d.settle(); d.fail(1, 2); return d.settle(); })();
const FLOOD = floodAll(NET7);
const HC_EXAMPLE = ttlChecksum(0xb861);

export const chRouter: Chapter = {
  id: 'router', num: numOf('router'), title: 'A router', level: 'Communication',
  blurb: 'Past one Ethernet: IPv4\'s bytes, longest-prefix match as a trie in RAM, a fast path in gates that rewrites four fields, a slow path for the rest, and how routers fill their tables.',
  goals: [
    'read an IPv4 header byte by byte, and say why a router touches only the TTL, the checksum and the two MAC addresses',
    'walk a longest-prefix match down a trie by hand, and count its memory reads against a TCAM\'s gates',
    'follow a frame through a fast path in gates, and compute how many ports one such engine can serve',
    'run distance vector and link state on a network that breaks, and say which fails how, and what each costs in messages',
  ],
  builds: ['ethernet', 'switch'],
  recap: {
    keep: [
      `A router forwards on one field, the destination, by the longest matching prefix. On the way through it changes four things: destination MAC, source MAC, TTL − 1, and the checksum, updated from the old one by adding 0x${TTL_DELTA.toString(16).toUpperCase()} to its complement with end-around carry (RFC 1624), without summing the header again.`,
      `A binary trie makes a lookup one memory read per bit used: at most 33 reads, whatever the table's size. The memory holds ${n0(TRIE_NODES)} nodes of 24 bits here. A CAM answers in one cycle and pays in gates: ${n0(N.cam)} NANDs for 16 entries of 32 bits, and those match exactly, without the mask a prefix needs.`,
      `The fast path is ${n0(LOGIC)} NANDs of logic beside ${n0(MEM.trie + MEM.buf + MEM.adj)} of memory. A ${FRAME_60}-byte frame takes ${CY60} cycles through it, worst case ${CY_WORST}, while the same frame takes ${n0(WIRE_CYCLES)} cycles to cross a ${BYTE_CYCLES}-cycle-a-byte link: that gap is why one engine can serve about ${PORTS} ports.`,
      'Anything the fast path cannot finish goes up unchanged to the slow path, a processor: TTL expired, no route, an address of its own, ARP, options. A bad checksum or another machine\'s MAC is dropped, with no reply.',
      `Distance vector: tell your neighbours your table, believe them. ${dvNet.rounds} rounds on this network, but bad news counts to infinity (${dvChain} rounds on a three-router chain, ${dvPoison} with poison reverse). Link state: flood every link (${FLOOD} reports here), then each router runs Dijkstra alone, so a failure is known everywhere in one flood, at the price of every router holding the whole map.`,
    ],
    check: [
      {
        question: 'The table holds 10.0.0.0/8 via hop 1, 10.1.0.0/16 via hop 2 and 10.1.2.0/24 via hop 3. Where does 10.1.3.4 go?',
        options: ['Hop 2: the /8 and the /16 match, and the /16 is longer', 'Hop 3: the /24 is the longest in the table', 'Hop 1: the first route that matches wins', 'Nowhere: no entry equals the address'],
        answer: 0,
        explain: '10.1.3.4 is not in 10.1.2.0/24, since the third byte differs. Of the two that match, the longest prefix wins.',
        why: ['', 'The /24 covers 10.1.2.x only.', 'Order means nothing: length decides, which is why a /32 can sit next to a default route.', 'A route is a prefix, not an address: that is what makes a table far smaller than the number of hosts.'],
      },
      {
        question: 'Why can a router update the checksum without reading the rest of the header again?',
        options: ['The sum is linear: one word changed by a known amount, so the old sum changes by the same amount', 'The TTL is not covered by the checksum', 'The checksum is recomputed by the next router anyway', 'It only checks the addresses'],
        answer: 0,
        explain: 'A one\'s-complement sum of words moves by exactly what one word moves by. Lowering the TTL lowers the word {TTL, protocol} by 0x0100, so the update is one constant addition, whatever the header holds.',
        why: ['', 'It covers the whole header, TTL included, which is why it changes at every hop.', 'Every router verifies it, so a wrong one would be dropped at the next hop.', 'It covers all twenty bytes.'],
      },
      {
        question: 'On A - B - C the link B - C fails. Without poison reverse, why does the cost to C climb one or two a round?',
        options: ['B hears A\'s old route to C, which ran through B, and believes it; then A believes B', 'Each router lowers its TTL', 'A floods the failure one hop a round', 'The link\'s cost rises while it is down'],
        answer: 0,
        explain: 'A\'s table only says "2 to C". It does not say the path runs through B, so B takes it, and each then raises its cost on the other\'s word until both reach infinity, here 16.',
        why: ['', 'TTL is on packets; this is about tables.', 'Nothing is flooded in distance vector, and A never learns of the failure as such.', 'The cost of a link down is simply gone: B stops using it at once.'],
      },
    ],
  },
  steps: [
    {
      title: 'An address with a shape',
      body: `
        <p>A switch knows each machine by a MAC address, and a table entry per machine, learned by flooding. That stops working somewhere past a building: a flat address says nothing about where a machine is, so every switch on Earth would need a line for every machine on Earth, and a frame to an unknown one would be sent everywhere.</p>
        <p>IP's answer is an address with a shape: its leading bits name a network, so a table can hold <em>one</em> line for millions of machines, and a router only needs to know which way that network lies. The packet carries the address in its header, inside the Ethernet frame, and the frame lasts one hop: at each router a new frame is built around the same packet.</p>
        <p>The header below is the real format (RFC 791), twenty bytes when there are no options. Click a byte for its field. <strong>Only the destination is looked up</strong>, and only the TTL and the checksum change on the way. <span class="try">Lower the TTL and see the checksum follow, still summing to all ones.</span> <span class="try">Flip a bit, and see the sum fail.</span></p>`,
      widget: ipHeaderWidget,
      more: {
        numbers: `<p>Twenty bytes on every packet: 1.3 % of a 1500-byte payload, and 20 of the 46 bytes a minimum frame carries. The checksum covers the header only, so that a router need not read the payload; the payload's own integrity is the transport's job and the frame's FCS per hop.</p>`,
        real: `<p>IPv6 removed the checksum altogether (the link and the transport check anyway, and an update at every hop was a cost) and made the header a fixed 40 bytes. Options in IPv4 are almost never seen on the open internet, because most routers send them to the slow path, which is exactly what this chapter's fast path does.</p>`,
      },
    },
    {
      title: 'Longest prefix wins',
      body: `
        <p>A route is a prefix and a next hop. <code>10.1.2.0/24</code> covers every address whose first 24 bits equal those of 10.1.2.0. Prefixes nest, so an address can match several, and the rule is that <strong>the longest match wins</strong>: a general route and its exceptions can sit in one table. <code>0.0.0.0/0</code> matches everything and is the default route.</p>
        <p>Scanning a table is too slow, and sorting does not help since the answer depends on length. A <strong>binary trie</strong> does help: a node per prefix bit, walked from the root by the address's bits, remembering the last route passed. The walk stops when there is no child. That is one memory read per bit used, at most 33 for an IPv4 address, whatever the size of the table.</p>
        <p>In RAM a node is one word: a next hop (4 bits, 0 for none) and two child addresses (${TRIE_K} bits each), ${TRIE_NODES} × 24 bits, ${n0(MEM.trie)} NANDs in this design's memory. <span class="try">Look up 10.1.2.1 and 10.1.2.9, and find the address that takes the fewest reads.</span></p>`,
      widget: lpmWidget,
      challenge: {
        kind: 'quiz',
        question: 'How many trie reads does 10.200.0.1 take in this table?',
        options: [`${READS_200}: the root and the eight levels of 10/8; the next bit is 1, and only a 0 child exists there`, 'One: the root holds the default route', 'Thirty-three: every address walks all its bits', 'Eight: the prefix length'],
        answer: 0,
        explain: `Below the /8, 10.1.x went on with a 0 bit (1 is 00000001), while 200 is 11001000 and starts with a 1. So the walk reads the root and eight more nodes, finds no child for that 1, and stops with the /8's hop.`,
        why: ['', 'A default route at the root does not stop the walk: a longer one may lie below it.', 'A walk ends at the first missing child, usually far above 32 bits.', 'The read of the root counts, and the walk tries the child after the prefix too.'],
      },
      more: {
        real: `<p>A real core router holds about a million IPv4 prefixes and has nanoseconds per packet, so one read per bit is too many. Multi-bit tries read several bits at a time; DIR-24-8 spends a 2<sup>24</sup>-entry table to find most routes in one read and the rest in two. A TCAM compares every entry at once, each cell a storage bit and a comparator with a mask bit, so it takes one cycle and much more power and area per bit. Here a CAM of 16 × 32 bits with no masks at all is ${n0(N.cam)} NANDs, ${n0(N.cam / 16)} an entry.</p>`,
      },
    },
    {
      title: 'The fast path in gates',
      body: `
        <p>Now the whole journey of a frame, a byte a cycle on the stream of chapter ${numOf('ethernet')}: data, valid, last, ready. A frame comes in and goes into the <span data-show="buf">packet buffer</span> while <span data-show="check">the header checks</span> watch it pass: is this our MAC or a broadcast, type 0x0800, version 0x45, is the sum right, what is the TTL. No byte is read twice. <span data-show="count">The byte counter</span> and a table beside it say what each byte is.</p>
        <p>After the last byte, one cycle decides. A frame going on <span data-show="walk">walks the trie</span>, a read a cycle, then reads <span data-show="adj">the next-hop table</span> for its port. It then leaves from the buffer through <span data-show="rewrite">the rewrite</span>, which passes the stored byte except in four places.</p>
        <p>Next hops are stored as bytes, eight to an entry, and entry 0 is our own MAC. So there is no 48-bit register or comparator anywhere: a MAC is compared and written a byte at a time, as it passes. A 48-bit comparator and register would be ${n0(WIDE.cmp + WIDE.reg)} NANDs; the byte comparator is ${n0(WIDE.cmp8)}. The header checks use the same idea.</p>
        <p><strong>Cost.</strong> ${n0(LOGIC)} NANDs of logic (checks ${n0(N.check)}, walk ${n0(N.walk)}, rewrite ${n0(N.rew)}), beside ${n0(MEM.buf)} for a ${2 ** BUF_K}-byte buffer, ${n0(MEM.trie)} for the trie and ${n0(MEM.adj)} for the next hops: memory is ${MEM_PCT} % of it. Longest path ${PERIOD} NAND delays. This one engine holds one frame: store and forward, no queue, and a second frame waits at the sender with ready low. Real line cards put queues on both sides, and chapter ${numOf('path')} shows what those queues do.</p>
        <p>The gates are compared with the model <code>net/fastpath.ts</code> at every output of every clock, and each forwarded frame separately against what a router must do (tests/net-fastpath). <span class="try">Send the first frame and find the four changed places on the Out row.</span> <span class="try">Send a frame the fast path does not forward.</span></p>`,
      scene: () => fastPathScene(0),
      tries: [(st) => (routerApi.get(st)?.status().forwarded ?? 0) > 0, (st) => { const x = routerApi.get(st)?.status(); return !!x && (x.punted > 0 || x.dropped > 0); }],
      challenge: {
        kind: 'reach',
        goal: 'Forward a frame through the gates and see its TTL come out one lower.',
        check: (st) => { const x = routerApi.get(st)?.status(); return !!x && x.forwarded > 0 && x.lastTtl === 63 && x.agree; },
        hints: ['Pick a frame addressed to 10.1.2.9 and press Send.', 'The Out row\'s marked bytes are the two MACs, the TTL and the checksum.'],
        answer: `Send "${FP_FRAMES[0].name}". It takes ${CY60} cycles: ${FRAME_60} bytes in, one for DECIDE, ${reads} reads, one for ADJ, ${FRAME_60} bytes out. Byte 22 comes out as 0x3F, 63.`,
        solve: (st) => routerApi.get(st)?.send(0),
      },
      more: {
        numbers: `<p>A ${FRAME_60}-byte frame (the minimum, without FCS): ${FRAME_60} cycles in, 1 to decide, ${reads} reads here, 1 for the port, ${FRAME_60} out: ${CY60} cycles, or ${n0(CY60 * CLOCK_NS)} ns at ${CLOCK_NS} ns a cycle. Worst case ${CY_WORST}, with a /32 route. That frame takes ${n0(WIRE_CYCLES)} cycles on a link of ${BYTE_CYCLES} cycles a byte (with FCS, preamble and gap), so this engine could serve about ${PORTS} such ports before it became the bottleneck.</p>`,
        real: `<p>Our simplifications: no options (they go up), no fragmentation (DF is assumed; too big is not checked here), one MAC for all ports, the total-length field not cross-checked with the frame. A real forwarding engine works on the header alone in a pipeline, with the packet in shared memory, and finishes a lookup every clock.</p>`,
      },
    },
    {
      title: 'Four changed bytes and a constant',
      body: `
        <p>The checksum looks like a reason to read the whole header again at every hop. It is not, because a one's-complement sum is linear: if one word of the header moves by some amount, the sum moves by that amount. RFC 1624 gives the update as <code>HC' = ~(~HC + ~m + m')</code>. The word that changes is {TTL, protocol}, which falls by 0x0100, so <code>~m + m'</code> is the same constant for every packet: <strong>0x${TTL_DELTA.toString(16).toUpperCase()}</strong>.</p>
        <p>So a 16-bit adder with that constant, an incrementer for the end-around carry, and two rows of XOR for the complements: nothing else, and no memory access. A header with checksum 0xB861 becomes 0x${HC_EXAMPLE.toString(16).toUpperCase()}. <strong>${n0(N.rew)} NANDs</strong> for the whole rewrite, and the update is tested equal to a full re-sum over random headers at every TTL.</p>
        <p>The check on the way in is one 16-bit adder too, with the carry kept in a flip-flop for the next byte's addition: end-around in time, not in wire. A good header ends with all ones. Twenty bytes, twenty additions, no second read.</p>
        <p><span class="try">Open <em>rewrite</em> on the circuit and find the adder with the constant.</span></p>`,
      scene: () => fastPathScene(0),
      lit: '',
      tries: [(st) => st.path.includes('rewrite')],
      more: {
        derive: `<p>The sum S of the words has checksum HC = ~S. Replacing m by m' gives S' = S − m + m', and in one's complement −m is ~m, so S' = S + ~m + m', hence HC' = ~(~HC + ~m + m'). With m' = m − 0x0100, ~m + m' = 0xFFFF − 0x0100 = 0xFEFF as a one's-complement sum. An earlier formula, HC' = HC + 0x0100, gets the corner case of a sum of zero wrong (RFC 1141, corrected by RFC 1624): 0xFFFF and 0x0000 are the two spellings of zero.</p>`,
      },
    },
    {
      title: 'What the fast path will not do',
      body: `
        <p>The fast path does one thing. Everything else goes up to the <strong>slow path</strong>, a processor on port 3 with software on it, with the frame unchanged and a reason attached: ${[C_TTL, C_NO_ROUTE, C_LOCAL].map((c) => CAUSE_NAMES[c]).join(', ')}, ARP, options. This is the split between the <em>data plane</em>, which moves every packet in hardware, and the <em>control plane</em>, which handles the exceptions and writes the tables through <span data-show="trie">the cfg port</span>.</p>
        <p>Two frames get no reply from anyone: a bad checksum, since the addresses in that header cannot be trusted, and another machine's MAC. All the others can get one. TTL expired is the important one. The router sends an ICMP "time exceeded" back to the source, from its own address, so a sender that sends TTL 1, 2, 3 … hears from each router in turn: that is <em>traceroute</em>, and chapter ${numOf('path')} runs it.</p>
        <p>The loop guard is the TTL itself: a packet in a routing loop falls by one at each router and dies within 255 hops, so a mistake in a table wastes bandwidth and does not melt the network. A frame on a switch has no such field, which is why a loop of switches is a storm. <span class="try">Send the TTL-of-1 frame and the one for no route, and compare what comes out with what went in.</span></p>`,
      scene: () => fastPathScene(3),
      tries: [(st) => { const x = routerApi.get(st)?.status(); return !!x && x.lastCause !== C_FORWARD && x.lastCause > 0; }],
      more: {
        real: `<p>Rate limits matter: a slow path is a thousand times slower than the fast one, so a flood of packets with TTL 1 aimed at a router is an attack on its processor. Routers limit how fast they answer, which is why traceroute shows stars for hops that are perfectly healthy.</p>`,
      },
    },
    {
      title: 'Distance vector: believe your neighbours',
      body: `
        <p>Tables have to come from somewhere, and no router can see the whole network. The simple scheme is <strong>distance vector</strong> (Bellman-Ford, as RIP runs it): every router knows its links' costs, tells its neighbours its table every so often, and for each destination keeps the neighbour offering the least cost + link. Nothing else is needed: on this network it settles in ${dvNet.rounds} rounds (the last one changes nothing, which is how a router would know), ${dvNet.msgs} tables sent, to the same costs Dijkstra would find.</p>
        <p>The trouble is in what a number does not say. On the chain A - B - C, fail B - C. B has lost C, but A still says "2 to C", and A's path runs through B, which A does not say and B cannot know. So B takes it, 3 via A. A then hears 3 and goes to 4, and so on: <strong>counting to infinity</strong>, ${dvChain} rounds until both reach RIP's infinity of 16. Sixteen is a compromise: small enough to stop soon, and it limits the network to 15 hops across.</p>
        <p>Poison reverse helps: tell a neighbour "infinity" for routes that go through it. The chain now settles in ${dvPoison} rounds. It cures loops of two routers; loops of three and more can still count, given the right timing. <span class="try">Choose the chain, fail B - C, and run rounds.</span> <span class="try">Do it again with poison reverse.</span></p>`,
      widget: distVecWidget,
      more: {
        real: `<p>Rounds here are synchronous, all routers at once, which is the simplest case and the kindest. BGP, which runs between the internet's networks, is a distance-vector protocol that advertises the whole path, not only the number, exactly so a router can see itself in it and refuse: that removes counting to infinity at the price of longer messages. It also chooses by policy rather than cost, because networks are companies.</p>`,
      },
    },
    {
      title: 'Link state: everyone holds the map',
      body: `
        <p><strong>Link state</strong> (OSPF, IS-IS) sends different information to different places. Each router reports only its own links, and that report is flooded to every router: each passes on a new report on all links but the one it came in on, once. Here that is ${FLOOD} reports from nothing. Now everyone holds the same map, and each runs <strong>Dijkstra</strong> alone: settle the nearest unsettled router, relax its links, repeat, and install only the first hop.</p>
        <p>A failure is now one flood away from everybody, and nobody is believing a stale number, so nothing counts. The costs are memory for the whole map on every router, CPU for a run of Dijkstra per change, and a short window while the flood is under way, when routers disagree and a transient loop can form (the TTL takes care of that). That is why link state runs inside one organization, and something else runs between them.</p>
        <p>Whichever protocol fills the table, the result reaches the fast path the same way: a word at a time through the cfg port, while packets flow, into the trie of the earlier step. <span class="try">Step Dijkstra from A one router at a time, then fail a link on its tree and see the tree change.</span></p>`,
      widget: linkStateWidget,
      more: {
        numbers: `<p>From nothing on these ${NET7.names.length} routers and ${NET7.links.length} links: flooding ${FLOOD} short reports, and distance vector ${dvNet.msgs} whole tables of ${NET7.names.length} entries. In steady state, distance vector keeps sending its tables on a timer; link state refreshes rarely (OSPF every 30 minutes), and sends a few "hello" packets to notice a dead link.</p>`,
      },
    },
    {
      title: 'What one engine can carry',
      body: `
        <p>Put the numbers side by side. A minimum frame takes ${n0(WIRE_CYCLES)} cycles to cross our ${BYTE_CYCLES}-cycles-a-byte link and ${CY60} to ${CY_WORST} cycles through the engine. So the engine is idle most of the time on one port, and it could serve about <strong>${PORTS} ports</strong> before it became the limit, provided each port had a buffer to hold what arrives while the engine is busy. Those buffers are memory, and memory is what a router is mostly made of: here ${n0(MEM.trie + MEM.buf + MEM.adj)} NANDs against ${n0(LOGIC)} of logic.</p>
        <p>The lookup is where it would hurt first. At 400 Gb/s a minimum frame arrives every 1.68 ns, a few clock cycles, so one read per address bit from an external RAM is out by two orders of magnitude. This is why real forwarding chips read several bits a step, split the table across on-chip memories, or use TCAM, and why they run the walk as a pipeline, so that one lookup finishes every cycle even though each takes many.</p>
        <p>Move the frame size and the matched prefix: the engine's cycles grow with both, the wire's with the frame alone. <span class="try">Take the frame from the minimum to 1514 bytes and see how the count of ports moves.</span></p>`,
      widget: engineWidget,
    },
  ],
};

