// Chapter 53, The internet path: an invented network of networks as a packet-level model (net/internet.ts), BGP between its networks, DNS in real
// bytes, traceroute, one frame carried through chapter 51's gates hop by hop, every delay computed, and what fetching a page adds up to.

import { CLOCK_NS } from '../dram/timing';
import { ASES, AS_BRACK, AS_FERN, AS_QUIL, asPrefix, HOSTS, hostIp, Internet, linkBetween, linksOf, LINKS, probeFrame, R, ROUTERS, traceroute } from '../net/internet';
import { keyOf } from '../net/internetbgp';
import { engineMs, fetchMs, oneWayMs, propMs, queueMs, serMs, THINK_MS } from '../net/internetdelay';
import { Resolver, SITE, TTL_A } from '../net/internetdns';
import { bgpWidget, dnsWidget, fetchWidget, LAPTOP, networkWidget, onePacketWidget, PATH_FRAMES, pathApi, pathScene, tracerouteWidget, WWW } from '../widgets/internet';
import type { Chapter } from './types';

const ms1 = (x: number) => x.toFixed(x >= 100 ? 0 : 1);
const NET = new Internet();
const DST = hostIp(WWW);
const J = NET.send(LAPTOP, probeFrame(LAPTOP, DST, 64));
const TRACE = traceroute(NET, LAPTOP, DST);
const LIGHT = linksOf(J).reduce((a, i) => a + propMs(LINKS[i]), 0);
const FRAME = probeFrame(LAPTOP, DST, 64).length;
const ONE_WAY = oneWayMs(J, FRAME);
const BIG = 1500;
const OCEAN = LINKS[linkBetween(R.t1, R.t2)], ACCESS = LINKS[linkBetween(R.f1, R.f2)];
const ROUTE_COUNT = NET.tableOf(R.f1).routes.length;
const NODES = Math.max(...ROUTERS.map((_, r) => NET.tableOf(r).trie.length));
const DNS = new Resolver(NET).resolve(LAPTOP, SITE, 0);
const READS = J.hops[0].result.reads;
const ENGINE_NS = engineMs(FRAME, READS) * 1e6;
const FR_PATH = NET.bgp.best(AS_FERN, keyOf(asPrefix(AS_QUIL), 16))!.path.map((a) => ASES[a].name);
const FR_BRACK = NET.bgp.best(AS_FERN, keyOf(asPrefix(AS_BRACK), 16))!.path.map((a) => ASES[a].name);
const NO_POLICY = new Internet({ policy: false }).bgp.best(AS_FERN, keyOf(asPrefix(AS_QUIL), 16))!.path.map((a) => ASES[a].name);
const RTT = ONE_WAY * 2;
const PAGE = { dnsMs: DNS.ms, rttMs: RTT, pageBytes: 100_000, bottleneckMbps: ACCESS.mbps * (1 - ACCESS.load), tls: true };
const PAGE_MS = fetchMs(PAGE);
const SER_FULL = serMs(ACCESS, BIG), Q50 = queueMs(ACCESS, 0.5), Q95 = queueMs(ACCESS, 0.95);

export const chPath: Chapter = {
  id: 'path', num: 53, title: 'The internet path', level: 'Communication',
  blurb: 'What really happens when you fetch a page: BGP between networks that pay each other, DNS, traceroute, every delay computed, and one frame carried through the gates, router by router, on an invented network.',
  goals: [
    'say why a packet takes the path it takes: link state inside a network, BGP between networks, and policy before distance',
    'follow a name to an address through DNS\'s real bytes, and say what the cache saves',
    'read a traceroute, and say what each line proves and what it does not',
    'add up one packet\'s delay from light, bits, queues and the engine, and say which one matters where',
  ],
  builds: ['router', 'network', 'ethernet'],
  recap: {
    keep: [
      `A network of networks: link state inside each, BGP between them. A router here holds ${ROUTE_COUNT} or so routes and at most ${NODES} trie nodes, because a /16 stands for a whole network.`,
      `BGP advertises the whole path, so a network that finds its own number in a path refuses it, and counting to infinity cannot start. It chooses by money before length: customer, then peer, then provider. So the shortest wire is often not used: here the laptop's path is ${FR_PATH.join(' → ')}.`,
      `BGP believes what it hears. A false /24 beats the true /16 everywhere it reaches, by chapter 51's longest-prefix rule.`,
      `A name takes ${DNS.lookups} questions and ${DNS.steps.length} messages when nothing is cached, ${ms1(DNS.ms)} ms in sequence, and two short messages when the resolver remembers.`,
      `Traceroute is the TTL from chapter 51 used on purpose: each router in turn reports the packet it had to kill. Each line is a separate packet, and its time includes a way back that may be a different path.`,
      `One way here takes ${ms1(ONE_WAY)} ms and ${ms1(LIGHT)} of it is light: no engineering shortens that but a shorter route or a nearer copy. At the edge bits and queues matter: ${(SER_FULL * 1000).toFixed(0)} µs for a full frame on the ${ACCESS.mbps} Mb/s line, and a queue that goes from ${(Q50 * 1000).toFixed(0)} µs at half load to ${ms1(Q95)} ms at 95 %.`,
      `A page of 100 kB takes about ${ms1(PAGE_MS)} ms from cold, and most of it is round trips, so faster links stop helping long before a nearer server does.`,
    ],
    check: [
      {
        question: 'Why does the laptop\'s traffic to Quillon cross two backbones, when Ridgeway has a direct peering link to Orchard, a customer of Quillon\'s provider?',
        options: ['Orchard learned that route from its provider, and sends a provider\'s routes only to its customers', 'The backbones are physically shorter', 'BGP measures delay, and the peering link is slower', 'Ridgeway has not heard of Orchard'],
        answer: 0,
        explain: 'Carrying Ridgeway\'s traffic up to Tarn would make Orchard pay its provider for traffic that earns it nothing. So Orchard never offers the route, and Ridgeway never sees it.',
        why: ['', 'They are thousands of kilometres longer here: distance is exactly what this choice does not use.', 'BGP carries no delay at all, only the path and policy.', 'It has: its routes to Brackwater go over that link.'],
      },
      {
        question: 'A traceroute shows hop 7 at 12 ms and hop 8 at 9 ms. What does that show?',
        options: ['Nothing wrong: each line is a separate packet with its own queues, and each reply has its own way back', 'The packet travelled back in time on a cheaper link', 'Hop 7 is overloaded and hop 8 is not on the path', 'The TTL was counted wrongly'],
        answer: 0,
        explain: 'The probes are different packets at different times. A router may also answer slowly because a reply goes through its slow path, without slowing the packets it forwards.',
        why: ['', 'The later line is a different packet, so the two times are not two points on one journey.', 'Both are on the path: hop 8 answered a probe that crossed hop 7.', 'Each probe\'s TTL is one more than the last, and the answers name who killed each.'],
      },
      {
        question: 'Which change shortens this path\'s round trip the most, for a small packet?',
        options: ['A copy of the site nearer the laptop', 'Backbone links ten times faster', 'Routers with a faster fast path', 'A larger TCP window'],
        answer: 0,
        explain: `Light is ${ms1(LIGHT)} of the ${ms1(ONE_WAY)} ms one way. Only moving the far end changes that.`,
        why: ['', `A small frame already takes well under a microsecond on a 100 Gb/s link.`, `Each engine takes about ${ENGINE_NS.toFixed(0)} ns; even all of them together are a small part.`, 'A window affects how much data flows per round trip, not how long the round trip is.'],
      },
    ],
  },
  steps: [
    {
      title: 'A network of networks',
      body: `
        <p>A router's table has to say something about every address on Earth, and no one organization runs the whole thing. So the internet has two levels. Inside one <strong>autonomous system</strong>, an organization runs a protocol from <a href="#/c/router">chapter 51</a>, link state, over links whose costs it sets itself. Between autonomous systems the links are contracts, and a different protocol decides what crosses them.</p>
        <p>The map below is a model. A static web page cannot run a real traceroute, and this one never touches your network: everything here runs inside the page on an invented network of ${ASES.length} networks, ${ROUTERS.length} routers and ${HOSTS.length} hosts. The AS numbers come from the range reserved for documentation, the addresses are private, and the names are under <code>.example</code>, so none can belong to anyone.</p>
        <p>Each network announces one /16, and each router owns a /24 of it. That is why a table stays small: f1 holds ${ROUTE_COUNT} routes, its trie at most ${NODES} nodes on this map, against the 1024 of chapter 51's memory. Its next hop comes from one of two sources, marked in the table: link state for addresses in its own network, BGP for the others. When a network has two exits, a router takes the nearer one, called hot-potato routing: hand the packet on as soon as you may, so that it costs someone else.</p>
        <p>Every router here has at most three ports, because chapter 51's fast path has only a 2-bit port field beside the slow path's. The map obeys that limit so that any hop can be opened on gates. <span class="try">Fail the k1 - k2 link and see what the laptop can still reach.</span> <span class="try">Click r2 and find which of its routes came from BGP.</span></p>`,
      widget: networkWidget,
      more: {
        real: `<p>About 75 000 networks announce about a million IPv4 prefixes. Most are small customers of one or two providers; a small number of large networks reach nearly everything through peering, without paying anyone for transit. Inside a real network, BGP also runs between its own routers (iBGP), and a label or tunnel often carries the packet across, so its core routers need not hold the full table. Our routers each hold the whole small table, and BGP here does not hear of a failure inside a network, so a broken link in a backbone leaves a black hole until that network's own routing is told; a real network's iBGP sessions would withdraw the route.</p>`,
      },
    },
    {
      title: 'BGP: the whole path, and who pays',
      body: `
        <p>Distance vector's problem was that a number does not say how it was reached. <strong>BGP</strong> advertises the whole list of networks a route crosses. A network that sees its own number in a path refuses it, so counting to infinity cannot begin. <span class="try">Run rounds from the start, and watch a route to Quillon spread one network a round.</span></p>
        <p>The list is also the only metric it has. BGP does not know about bandwidth or delay. It chooses by <strong>policy</strong>, and the policy follows the money: a customer pays you, so its routes come first; a peer costs nothing; a provider bills you, so its routes come last. Only then does the shorter path count. Export follows the same logic: you tell your peers and providers only your own and your customers' routes, because carrying anything else for them would cost you and earn nothing.</p>
        <p>So paths go up, cross at most one peering link, and come down. Here Fernbank reaches Quillon by ${FR_PATH.join(' → ')}, thousands of kilometres out of the way, although Ridgeway peers directly with Orchard, a customer of Quillon's own provider. Orchard learned that route from its provider, and does not offer it to a peer. Without policy the path would be ${NO_POLICY.join(' → ')}. Fernbank reaches Brackwater over the peering link, ${FR_BRACK.join(' → ')}, since Brackwater is Orchard's customer. <span class="try">Turn policy off and compare the path from Fernbank to Quillon.</span></p>
        <p>BGP also believes what it hears. Turn on Sable's claim below: Sable announces a /24 inside Quillon's /16, and every router on the path applies chapter 51's rule, so the longer prefix wins wherever it reaches. Nothing in the protocol asks whether Sable owns it. <span class="try">Turn on the false claim, and see where the laptop's packets end.</span></p>`,
      widget: bgpWidget,
      challenge: {
        kind: 'quiz',
        question: 'Why does a false /24 work when the true /16 is still being announced?',
        options: ['Forwarding takes the longest match, so the /24 wins at every router that hears it, whatever BGP prefers for the /16', 'BGP prefers the most recent announcement', 'Sable\'s path is shorter than Quillon\'s', 'The /16 is withdrawn by the claim'],
        answer: 0,
        explain: 'The two are different prefixes, so BGP does not compare them at all: both go in the table, and the longest-prefix rule of the data plane settles it. That is why filters on what a customer may announce matter, and why RPKI signs who may originate what.',
        why: ['', 'Age is not what decides between the two, since they are separate prefixes.', 'Path length compares routes to the same prefix only.', 'The true announcement stays, and packets for the rest of the /16 still reach Quillon.'],
      },
      more: {
        real: `<p>Real BGP runs over TCP between configured neighbours and sends only changes, with timers that can make it take minutes to settle after a failure. Its full decision has more steps (local preference is the policy above, then path length, origin, MED, and others). Gao and Rexford (2001) showed that this customer-peer-provider rule guarantees convergence if every network follows it; arbitrary policies can oscillate forever. Real hijacks and leaks are rare but regular: filters at providers and RPKI's signed origins reduce them, and neither is universal.</p>`,
      },
    },
    {
      title: 'A name, then an address',
      body: `
        <p>Packets carry addresses, and people type names. <strong>DNS</strong> is a distributed table from one to the other, split by the dots: the root knows who runs <code>.example</code>, that server knows who runs <code>quillon.example</code>, and only that one knows <code>${SITE}</code>. Nobody holds the whole table, and each zone is run by whoever owns it.</p>
        <p>The laptop asks a <strong>resolver</strong>, here on its provider's network, and the resolver does the walking. The messages are RFC 1035's real bytes in UDP on port 53: 12 bytes of header, the question, then records. A name is written as length-prefixed labels, and a repeat of a name is a two-byte pointer back to where it first appeared. <span class="try">Look up the site, and read the three answers the resolver gets.</span></p>
        <p>From cold that takes ${DNS.lookups} questions and ${DNS.steps.length} messages, ${ms1(DNS.ms)} ms one after another, nearly all of it the trip to the far zones. The cache is the whole trick. Every record comes with a TTL set by its owner, and the resolver may keep it that long: two days for the delegations here, ${TTL_A} s for the address. Since the delegations change rarely, they stay; since the owner may move the address, it expires soon. <span class="try">Look up twice.</span> <span class="try">Wait past the address's TTL, and count the questions.</span></p>`,
      widget: dnsWidget,
      challenge: {
        kind: 'quiz',
        question: `The address record has a TTL of ${TTL_A} s, the delegations two days. After ${TTL_A + 1} s, what does the next lookup ask?`,
        options: ['Only quillon.example\'s server: the resolver still knows who runs that zone', 'The root, then .example, then quillon.example', 'Nothing: the resolver may still use the address', 'The laptop asks the root itself'],
        answer: 0,
        explain: 'Each record ages on its own. The address has expired, but the NS record and its glue have not, so the walk starts at the deepest zone it still knows.',
        why: ['', 'That is the cold case: the delegations are still good.', `The TTL is a limit: ${TTL_A + 1} s is past it.`, 'A stub asks its resolver, and only the resolver walks.'],
      },
      more: {
        real: `<p>The real root is 13 names served by well over a thousand machines through anycast: one address announced from many places, so BGP takes each query to the nearest. A TTL of a few minutes is also how a site moves or fails over. Queries are visible on the path, which is why DNS over TLS and HTTPS exist, and answers are unsigned unless DNSSEC is used. Our model has no retries, no IPv6 and no truncation to TCP.</p>`,
      },
    },
    {
      title: 'Traceroute: asking each router to speak',
      body: `
        <p><a href="#/c/router">Chapter 51</a> promised this. A router that would have to forward a packet with a TTL of 0 sends it up to its slow path, which sends an ICMP "time exceeded" back to the source, from its own address. <strong>Traceroute</strong> uses that on purpose: send a probe with TTL 1, then 2, then 3, and each router on the path identifies itself in turn. The probe is UDP to an unlikely port, so that the far host answers too, with "port unreachable", and traceroute knows it has arrived.</p>
        <p>An ICMP error carries the IP header and the first eight bytes of the packet it complains about, which include the UDP ports. That is how the sender matches a reply to a probe. It is all real here: each frame below went through every router's table byte by byte, TTL and checksum changing at each, and "Save capture" writes them for Wireshark. Here the path takes ${TRACE.length} lines to reach www.</p>
        <p>Read the times with care. Each line is a <em>separate packet</em>, with its own queues on the way out and back, and the way back may differ from the way out: routing is per direction. So a later line can be quicker than an earlier one. Real routers also answer through a rate-limited slow path, so a slow or silent line may mean nothing about the packets they forward. A jump that persists on all later lines does mean something: here it is the ocean. <span class="try">Run it to the end, find the jump, and name the link.</span> <span class="try">Fail the t1 - t2 link, and see where the trace stops.</span></p>`,
      widget: tracerouteWidget,
      more: {
        real: `<p>Windows' tracert sends ICMP echo rather than UDP. Routers with several equal paths may send each probe a different way (Paris traceroute fixes the flow fields so that they all go one way). Many networks hide routers behind tunnels, so a line may stand for several hops; the IP in a line is the interface that sent the reply, often not the one the probe came in on.</p>`,
      },
    },
    {
      title: 'The same bytes, on gates',
      body: `
        <p>Everything so far is a model: tables and bytes in TypeScript. Now put the actual frame through the gates of <a href="#/c/router">chapter 51</a>. There is one fast path on the stage, standing for each router in turn: for each hop, the slow path writes that router's table into <span data-show="trie">the trie</span> and <span data-show="adj">the next-hop memory</span> through the cfg port, a word a cycle, exactly as it would when routing changes. Then the frame enters, a byte a cycle.</p>
        <p>What leaves is the frame the next hop takes: new MACs, TTL one lower, checksum updated by <span data-show="rewrite">the rewrite</span>. It is compared against two things at once: the fast path's model, at every output of every clock, and the network model's frame, byte for byte. Both must hold at every router on the path, and the test suite runs each of these frames all the way.</p>
        <p>One real difference is hidden between the hops. The stream ends at a fast path's output; in a real router the frame then goes through chapter 48's MAC, chapter 46's serializer, a line of chapter 41 and the same again in reverse, in ${(serMs(OCEAN, FRAME) * 1e6).toFixed(0)} ns of serialization on the ocean link and ${ms1(propMs(OCEAN))} ms in the fibre. We take that from the model and keep the bytes. Open <span data-show="walk">the trie walk</span> and keep going: a register, a flip-flop, a NAND, four transistors. <span class="try">Carry the request all the way to www.</span> <span class="try">Carry the probe of TTL 3, and see where it goes up.</span></p>`,
      scene: () => pathScene(0),
      tries: [(st) => { const x = pathApi.get(st)?.status(); return !!x && x.arrived && x.total > 3 && x.agree && x.same; }, (st) => { const x = pathApi.get(st)?.status(); return !!x && x.arrived && x.total === 3; }],
      challenge: {
        kind: 'reach',
        goal: 'Carry the frame through every router on the path, on gates, with every byte equal to the model\'s.',
        check: (st) => { const x = pathApi.get(st)?.status(); return !!x && x.arrived && x.total > 3 && x.agree && x.same; },
        hints: ['Press Next router and read the Out row: its changed bytes are the MACs, the TTL and the checksum.', 'All the way runs every remaining router.'],
        answer: `Choose "${PATH_FRAMES[0].name}" and press All the way. ${J.hops.length} routers, and each writes its table and takes the frame.`,
        solve: (st) => pathApi.get(st)?.all(),
      },
      more: {
        numbers: `<p>At f1, a ${FRAME}-byte frame takes ${READS} trie reads and ${(ENGINE_NS / CLOCK_NS).toFixed(0)} cycles, ${ENGINE_NS.toFixed(0)} ns at ${CLOCK_NS} ns a cycle. That is a byte a cycle, about 2 Gb/s. It serves this model's access links and falls far short of its 100 Gb/s backbones: a real backbone router's engine is wider and pipelined, with a shorter path through it, so this column is an upper bound on what its engine adds.</p>`,
      },
    },
    {
      title: 'One packet, all the way',
      body: `
        <p>Four delays make up the time at each hop. <strong>Light</strong>: length over speed, an assumed 200 000 km/s in fibre, 5 µs a kilometre, which no money can change. <strong>Bits</strong>: frame size over the link's rate, with 24 bytes of wire overhead. <strong>Queue</strong>: what is already waiting ahead of you, here M/M/1's mean, ρ / (1 − ρ) service times, for cross traffic of an assumed size. <strong>Engine</strong>: chapter 51's cycles.</p>
        <p>The table shows which one matters where, and it is not the same one. In the backbone, a ${BIG}-byte frame takes ${(serMs(OCEAN, BIG) * 1000).toFixed(2)} µs of bits and ${ms1(propMs(OCEAN))} ms of light on the ocean: light is everything. On the access line, the same frame is ${(SER_FULL * 1000).toFixed(0)} µs of bits, while light for those ${ACCESS.km} km takes ${(propMs(ACCESS) * 1000).toFixed(0)} µs. One way is ${ms1(ONE_WAY)} ms for a small frame, ${ms1(LIGHT)} ms of that light.</p>
        <p>The queue behaves differently from the others: it is not proportional to load. At half load it is ${(Q50 * 1000).toFixed(0)} µs on this line, one service time. At 95 % it is ${ms1(Q95)} ms, nineteen. Past 100 % it has no mean: it grows until a buffer overflows, and that loss is what <a href="#/c/router">a router</a> without room does and what TCP reads as the signal to slow down. <span class="try">Take the access load from 50 to 95 %, and see which column moves.</span> <span class="try">Take the packet from 1500 to 64 bytes, and see which rows change at all.</span></p>`,
      widget: onePacketWidget,
      challenge: {
        kind: 'quiz',
        question: 'On which link does a smaller packet save the most time?',
        options: ['The access line: at its low rate, bits are a large part of the delay', 'The ocean: it is the longest', 'The backbone: it carries the most traffic', 'They all save the same, since the packet is the same'],
        answer: 0,
        explain: `Bits scale with the packet and inversely with the rate. ${ACCESS.mbps} Mb/s is five thousand times slower than the backbone, while light does not care about size at all.`,
        why: ['', 'Length sets the light, which is the same for any packet.', 'Load matters to the queue; a 100 Gb/s link takes nanoseconds per byte anyway.', 'The saved bits take rate-dependent time, so the slow link gains most.'],
      },
      more: {
        derive: `<p>M/M/1: Poisson arrivals at rate λ, exponential service of mean S, ρ = λS. The mean wait in the queue is ρS / (1 − ρ). Traceroute's times come instead from a queue simulated packet by packet (Lindley's recursion, W<sub>n+1</sub> = max(0, W<sub>n</sub> + S<sub>n</sub> − A<sub>n</sub>)); a test holds its mean to the formula. Real traffic is burstier than Poisson, so a real queue at a given load is usually worse.</p>`,
        real: `<p>Our links are symmetric, and the lengths and rates are invented but typical. An oversized buffer on an access line is the source of bufferbloat: a queue that stays full adds hundreds of milliseconds without losing anything, so TCP has no reason to slow down. Active queue management drops or marks packets early to prevent it.</p>`,
      },
    },
    {
      title: 'A page',
      body: `
        <p>So type <code>${SITE}</code> and press Enter. First the name: ${ms1(DNS.ms)} ms from cold. Then TCP's handshake, one round trip before any data can flow, and with TLS a second for keys. Then the request, the frame you carried through the gates, one round trip and the server's ${THINK_MS} ms (assumed). Then the response, in slow start: ten segments, then twenty, then forty, each window a round trip after the last. That is chapter 52's protocol with no loss.</p>
        <p>From cold, 100 kB takes about <strong>${ms1(PAGE_MS)} ms</strong>, and the round trip of ${ms1(RTT)} ms sets nearly all of it. Move the size and see how little the page itself matters until it gets large. A link ten times faster changes only the serialization. What helps is fewer round trips or shorter ones: a cached name, and a copy of the site nearby, which is what a content delivery network sells. <span class="try">Put a copy of the site at the access provider.</span> <span class="try">Make the page 2000 kB, and see when bandwidth begins to matter.</span></p>
        <p>Open any of it and you can keep going down. The page is bytes in <a href="#/c/ethernet">an Ethernet frame</a>, the frame a stream through <a href="#/c/router">a router's</a> gates, the gates are NANDs from <a href="#/c/nand">chapter 3</a>, and a NAND is four of <a href="#/c/mosfet">chapter 1's</a> transistors. Except for the model of the line, and the invented map, it has all been built here.</p>`,
      widget: fetchWidget,
      more: {
        real: `<p>A real page is many objects from several hosts, and modern browsers reuse connections, resolve names ahead of time, and use QUIC to fold transport and TLS into one round trip. TLS itself, HTTP's meaning, routers' own failures, carrier NAT, Wi-Fi and the radio network are all outside this book. Loss changes the transfer too: chapter 52 follows it.</p>`,
      },
    },
  ],
};
