// Chapter 53, The internet path: an invented network of networks as a packet-level model (net/internet.ts), BGP between its networks, DNS in real
// bytes, traceroute, one frame carried through chapter 51's gates hop by hop, every delay computed, and what fetching a page adds up to.

import { CLOCK_NS } from '../dram/timing';
import { ASES, AS_BRACK, AS_FERN, AS_QUIL, asPrefix, HOSTS, hostIp, Internet, linkBetween, linksOf, LINKS, probeFrame, R, ROUTERS, traceroute } from '../net/internet';
import { keyOf } from '../net/internetbgp';
import { engineMs, fetchMs, oneWayMs, pageOver, propMs, queueMs, serMs, THINK_MS } from '../net/internetdelay';
import { Resolver, SITE, TTL_A } from '../net/internetdns';
import { bgpWidget, dnsWidget, fetchWidget, LAPTOP, networkWidget, onePacketWidget, PATH_FRAMES, pathApi, pathScene, stacksWidget, tracerouteWidget, WWW } from '../widgets/internet';
import TLS_COSTS from '../crypto/tls/costs.json';
import type { Chapter } from './types';
import { numOf } from './order';

const ms1 = (x: number) => x.toFixed(x >= 100 ? 0 : 1);
const NET = new Internet();
const DST = hostIp(WWW);
const J = NET.send(LAPTOP, probeFrame(LAPTOP, DST, 64));
const TRACE = traceroute(NET, LAPTOP, DST);
const LIGHT = linksOf(J).reduce((a, i) => a + propMs(LINKS[i]), 0);
const FRAME = probeFrame(LAPTOP, DST, 64).length;
const ONE_WAY = oneWayMs(J, FRAME);
/** A full packet, and its frame: the slider's size is the IP packet's, as an MTU is. */
const BIG = 1500, BIG_FRAME = BIG + 14;
const OCEAN = LINKS[linkBetween(R.t1, R.t2)], ACCESS = LINKS[linkBetween(R.f1, R.f2)];
const ROUTE_COUNT = NET.tableOf(R.f1).routes.length;
const NODES = Math.max(...ROUTERS.map((_, r) => NET.tableOf(r).trie.length)), F1_NODES = NET.tableOf(R.f1).trie.length;
/** Ridgeway to Tarn: through the backbone, as policy has it, against through its peer, which policy forbids. */
export const VIA_KESTREL = [[R.r2, R.k1], [R.k1, R.k2], [R.k2, R.k3], [R.k3, R.t1]].reduce((a, [x, y]) => a + LINKS[linkBetween(x, y)].km, 0);
export const VIA_ORCHARD = [[R.r2, R.o1], [R.o1, R.o2], [R.o2, R.t1]].reduce((a, [x, y]) => a + LINKS[linkBetween(x, y)].km, 0);
const DETOUR = VIA_KESTREL - VIA_ORCHARD;
const km = (x: number) => x.toLocaleString('en-US').replace(/,/g, ' ');
const DNS = new Resolver(NET).resolve(LAPTOP, SITE, 0);
const READS = J.hops[0].result.reads;
const ENGINE_NS = engineMs(FRAME, READS) * 1e6;
const FR_PATH = NET.bgp.best(AS_FERN, keyOf(asPrefix(AS_QUIL), 16))!.path.map((a) => ASES[a].name);
const FR_BRACK = NET.bgp.best(AS_FERN, keyOf(asPrefix(AS_BRACK), 16))!.path.map((a) => ASES[a].name);
const NO_POLICY = new Internet({ policy: false }).bgp.best(AS_FERN, keyOf(asPrefix(AS_QUIL), 16))!.path.map((a) => ASES[a].name);
const RTT = ONE_WAY * 2;
const PAGE = { dnsMs: DNS.ms, rttMs: RTT, pageBytes: 100_000, bottleneckMbps: ACCESS.mbps * (1 - ACCESS.load), tls: true };
const PAGE_MS = fetchMs(PAGE);
/** The client's whole share of the handshake in the chapter before, at this book's single-cycle clock. */
const TLS_CYCLES = TLS_COSTS.handshake['rfc8448 (1024-bit RSA, three cipher suites offered)'].cycles, TLS_SECONDS = (TLS_CYCLES * CLOCK_NS) / 1e9;
const MANY = { objects: 8, objectBytes: 30_000, rttMs: RTT, bottleneckMbps: PAGE.bottleneckMbps, loss: false };
const H1 = pageOver('h1', MANY), H2 = pageOver('h2', MANY), H3 = pageOver('h3', MANY), H2L = pageOver('h2', { ...MANY, loss: true }), H3L = pageOver('h3', { ...MANY, loss: true });
const SER_FULL = serMs(ACCESS, BIG_FRAME), Q50 = queueMs(ACCESS, 0.5), Q95 = queueMs(ACCESS, 0.95);

export const chPath: Chapter = {
  id: 'path', num: numOf('path'), title: 'The internet path', level: 'Communication',
  blurb: 'What really happens when you fetch a page: BGP between networks that pay each other, DNS, traceroute, every delay computed, and one frame carried through the gates, router by router, on an invented network.',
  goals: [
    'say why a packet takes the path it takes: link state inside a network, BGP between networks, and policy before distance',
    'follow a name to an address through DNS\'s real bytes, and say what the cache saves',
    'read a traceroute, and say what each line proves and what it does not',
    'add up one packet\'s delay from light, bits, queues and the engine, and say which one matters where',
  ],
  builds: ['tcp', 'secret', 'router', 'network', 'ethernet'],
  recap: {
    keep: [
      `A network of networks: link state inside each, BGP between them. A router here holds ${ROUTE_COUNT} or so routes and at most ${NODES} trie nodes, because a /16 stands for a whole network.`,
      `BGP advertises the whole path, so a network that finds its own number in a path refuses it, and counting to infinity cannot start. It chooses by money before length: customer, then peer, then provider. So the shortest wire is often not used: here the laptop's path is ${FR_PATH.join(' → ')}.`,
      `BGP believes what it hears. A false /24 beats the true /16 everywhere it reaches, by chapter ${numOf('router')}'s longest-prefix rule.`,
      `A name takes ${DNS.lookups} questions and ${DNS.steps.length} messages when nothing is cached, ${ms1(DNS.ms)} ms in sequence, and two short messages when the resolver remembers.`,
      `Traceroute is the TTL from chapter ${numOf('router')} used on purpose: each router in turn reports the packet it had to kill. Each line is a separate packet, and its time includes a way back that may be a different path.`,
      `One way here takes ${ms1(ONE_WAY)} ms and ${ms1(LIGHT)} of it is light: no engineering shortens that but a shorter route or a nearer copy. At the edge bits and queues matter: ${(SER_FULL * 1000).toFixed(0)} µs for a full frame on the ${ACCESS.mbps} Mb/s line, and a queue that goes from ${(Q50 * 1000).toFixed(0)} µs at half load to ${ms1(Q95)} ms at 95 %.`,
      `A page of 100 kB takes about ${ms1(PAGE_MS)} ms from cold, and most of it is round trips, so faster links stop helping long before a nearer server does.`,
      `Many objects: HTTP/2 puts them on one connection, but TCP's in-order delivery holds them all up behind one lost packet. QUIC has streams of its own over UDP, so a loss holds up one stream, and one combined handshake saves a round trip. Here ${MANY.objects} objects take ${ms1(H1.totalMs)}, ${ms1(H2.totalMs)} and ${ms1(H3.totalMs)} ms.`,
    ],
    check: [
      {
        question: 'Why does the laptop\'s traffic to Quillon cross two backbones, when Ridgeway has a direct peering link to Orchard, a customer of Quillon\'s provider?',
        options: ['Orchard learned that route from its provider, and sends a provider\'s routes only to its customers', 'The backbones are physically shorter', 'BGP measures delay, and the peering link is slower', 'Ridgeway has not heard of Orchard'],
        answer: 0,
        explain: 'Carrying Ridgeway\'s traffic up to Tarn would make Orchard pay its provider for traffic that earns it nothing. So Orchard never offers the route, and Ridgeway never sees it.',
        why: ['', `They are ${km(DETOUR)} km longer here: distance is exactly what this choice does not use.`, 'BGP carries no delay at all, only the path and policy.', 'It has: its routes to Brackwater go over that link.'],
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
      {
        question: 'A page comes over HTTP/2 and one TCP segment is lost. What waits for the retransmission?',
        options: ['Everything later on that connection, whichever object it belongs to', 'Only the object that segment belonged to', 'Nothing: HTTP/2 retransmits frames itself', 'The whole page is requested again'],
        answer: 0,
        explain: 'TCP delivers one ordered stream of bytes and knows nothing of HTTP/2\'s streams, so bytes past the gap stay in its buffer. RFC 9113 says this blocking is not addressed. QUIC moves streams into the transport, which is what limits a loss to one.',
        why: ['', 'That is QUIC. HTTP/2\'s streams exist only above TCP.', 'Frames have no retransmission of their own: HTTP/2 relies on TCP for that.', 'Only the lost segment is sent again.'],
      },
    ],
  },
  steps: [
    {
      title: 'A network of networks',
      body: `
        <p>A router's table has to say something about every address on Earth, and no one organization runs the whole thing. So the internet has two levels. Inside one <strong>autonomous system</strong>, an organization runs a protocol from <a href="#/c/router">chapter ${numOf('router')}</a>, link state, over links whose costs it sets itself. Between autonomous systems the links are contracts, and a different protocol decides what crosses them.</p>
        <p>The map below is a model. A static web page cannot run a real traceroute, and this one never touches your network: everything here runs inside the page on an invented network of ${ASES.length} networks, ${ROUTERS.length} routers and ${HOSTS.length} hosts. The AS numbers come from the range reserved for documentation, the addresses are private, and the names are under <code>.example</code>, so none can belong to anyone.</p>
        <p>Each network announces one /16, and each router owns a /24 of it. That is why a table stays small: f1 holds ${ROUTE_COUNT} routes in ${F1_NODES} trie nodes (${NODES} at most on this map), against the 1024 of chapter ${numOf('router')}'s memory. Its next hop comes from one of two sources, marked in the table: link state for addresses in its own network, BGP for the others.</p>
        <p>Every router here has at most three ports, because chapter ${numOf('router')}'s fast path has only a 2-bit port field beside the slow path's. The map obeys that limit so that any hop can be opened on gates.</p><div class="try">Fail the k1 - k2 link and see what the laptop can still reach.</div><div class="try">Click r2 and find which of its routes came from BGP.</div>`,
      widget: networkWidget,
      more: {
        real: `<p>When a network has two exits to the same place, a router takes the nearer, called hot-potato routing: hand the packet on as soon as you may, so that it costs someone else. Here no network has two, so the rule is in the model and never decides. About 75 000 networks announce about a million IPv4 prefixes. Most are small customers of one or two providers; a small number of large networks reach nearly everything through peering, without paying anyone for transit. Inside a real network, BGP also runs between its own routers (iBGP), and a label or tunnel often carries the packet across, so its core routers need not hold the full table. Our routers each hold the whole small table, and BGP here does not hear of a failure inside a network, so a broken link in a backbone leaves a black hole until that network's own routing is told; a real network's iBGP sessions would withdraw the route.</p>`,
      },
    },
    {
      title: 'BGP: the whole path, and who pays',
      body: `
        <p>Distance vector's problem was that a number does not say how it was reached. <strong>BGP</strong> advertises the whole list of networks a route crosses. A network that sees its own number in a path refuses it, so counting to infinity cannot begin.</p><div class="try">Run rounds from the start, and watch a route to Quillon spread one network a round.</div>
        <p>The list is also the only metric it has. BGP does not know about bandwidth or delay. It chooses by <strong>policy</strong>, and the policy follows the money: a customer pays you, so its routes come first; a peer costs nothing; a provider bills you, so its routes come last. Only then does the shorter path count. Export follows the same logic: you tell your peers and providers only your own and your customers' routes, because carrying anything else for them would cost you and earn nothing.</p>
        <p>So paths go up, cross at most one peering link, and come down. Here Fernbank reaches Quillon by ${FR_PATH.join(' → ')}, ${km(DETOUR)} km of fibre further than it need be, although Ridgeway peers directly with Orchard, a customer of Quillon's own provider. Orchard learned that route from its provider, and does not offer it to a peer. Without policy the path would be ${NO_POLICY.join(' → ')}. Fernbank reaches Brackwater over the peering link, ${FR_BRACK.join(' → ')}, since Brackwater is Orchard's customer.</p><div class="try">Turn policy off and compare the path from Fernbank to Quillon.</div>
        <p>BGP also believes what it hears. Turn on Sable's claim below: Sable announces a /24 inside Quillon's /16, and every router on the path applies chapter ${numOf('router')}'s rule, so the longer prefix wins wherever it reaches. Nothing in the protocol asks whether Sable owns it.</p><div class="try">Turn on the false claim, and see where the laptop's packets end.</div>`,
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
        real: `<p>Real BGP runs over TCP between configured neighbours and sends only changes, with timers that can make it take minutes to settle after a failure. Its full decision has more steps (local preference is the policy above, then path length, origin, MED, and others). Gao and Rexford (2001) showed that this customer-peer-provider rule guarantees convergence if every network follows it and no network is, through its providers, its own provider; arbitrary policies can oscillate forever. The false /24 here even beats Quillon's own inside route, since q1 holds both and takes BGP's, as a real router ranks an outside BGP route above its interior protocol: ns1's packets to www end at Sable too. Real hijacks and leaks are rare but regular: filters at providers and RPKI's signed origins reduce them, and neither is universal.</p>`,
      },
    },
    {
      title: 'A name, then an address',
      body: `
        <p>Packets carry addresses, and people type names. <strong>DNS</strong> is a distributed table from one to the other, split by the dots: the root knows who runs <code>.example</code>, that server knows who runs <code>quillon.example</code>, and only that one knows <code>${SITE}</code>. Nobody holds the whole table, and each zone is run by whoever owns it.</p>
        <p>The laptop asks a <strong>resolver</strong>, here on its provider's network, and the resolver does the walking. The messages are RFC 1035's real bytes in UDP on port 53: 12 bytes of header, the question, then records. A name is written as length-prefixed labels, and a repeat of a name is a two-byte pointer back to where it first appeared.</p><div class="try">Look up the site, and read the three answers the resolver gets.</div>
        <p>From cold that takes ${DNS.lookups} questions and ${DNS.steps.length} messages, ${ms1(DNS.ms)} ms one after another, nearly all of it the trip to the far zones. The cache is the whole trick. Every record comes with a TTL set by its owner, and the resolver may keep it that long: two days for the delegations here, ${TTL_A} s for the address. Since the delegations change rarely, they stay; since the owner may move the address, it expires soon.</p><div class="try">Look up twice.</div><div class="try">Wait past the address's TTL, and count the questions.</div>`,
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
        <p><a href="#/c/router">Chapter ${numOf('router')}</a> promised this. A packet that arrives with a TTL of 1 would leave with 0, so the router does not forward it: it sends it up to its slow path, which sends an ICMP "time exceeded" back to the source, from its own address. <strong>Traceroute</strong> uses that on purpose: send a probe with TTL 1, then 2, then 3, and each router on the path identifies itself in turn. The probe is UDP to an unlikely port, so that the far host answers too, with "port unreachable", and traceroute knows it has arrived.</p>
        <p>An ICMP error carries the IP header and the first eight bytes of the packet it complains about, which include the UDP ports. That is how the sender matches a reply to a probe. It is all real here: each frame below went through every router's table byte by byte, TTL and checksum changing at each, and "Save capture" writes them for Wireshark. Here the path takes ${TRACE.length} lines to reach www.</p>
        <p>Read the times with care. Each line is a <em>separate packet</em>, with its own queues on the way out and back, and the way back may differ from the way out: routing is per direction. So a later line can be quicker than an earlier one. Real routers also answer through a rate-limited slow path, so a slow or silent line may mean nothing about the packets they forward. A jump that persists on all later lines does mean something: here each long link makes one, and the largest is the ocean.</p><div class="try">Run it to the end, find the largest jump, and name the link.</div><div class="try">Fail the t1 - t2 link, and see where the trace stops.</div>`,
      widget: tracerouteWidget,
      more: {
        real: `<p>Windows' tracert sends ICMP echo rather than UDP. Routers with several equal paths may send each probe a different way (Paris traceroute fixes the flow fields so that they all go one way). Many networks hide routers behind tunnels, so a line may stand for several hops; the IP in a line is the interface that sent the reply, often not the one the probe came in on.</p>`,
      },
    },
    {
      title: 'The same bytes, on gates',
      body: `
        <p>Everything so far is a model: tables and bytes in TypeScript. Now put the actual frame through the gates of <a href="#/c/router">chapter ${numOf('router')}</a>. There is one fast path on the stage, standing for each router in turn: for each hop, the slow path writes that router's table into <span data-show="trie">the trie</span> and <span data-show="adj">the next-hop memory</span> through the cfg port, a word a cycle, exactly as it would when routing changes. Then the frame enters, a byte a cycle.</p>
        <p>What leaves is the frame the next hop takes: new MACs, TTL one lower, checksum updated by <span data-show="rewrite">the rewrite</span>. It is compared against two things at once: the fast path's model, at every output of every clock, and the network model's frame, byte for byte. Both must hold at every router on the path, and the test suite runs each of these frames all the way.</p>
        <p>One real difference is hidden between the hops. The stream ends at a fast path's output; in a real router the frame then goes through chapter ${numOf('ethernet')}'s MAC, chapter ${numOf('serial')}'s serializer, a line of chapter 41 and the same again in reverse, in ${(serMs(OCEAN, FRAME) * 1e6).toFixed(0)} ns of serialization on the ocean link and ${ms1(propMs(OCEAN))} ms in the fibre. We take that from the model and keep the bytes. Open <span data-show="walk">the trie walk</span> and keep going: a register, a flip-flop, a NAND, four transistors.</p><div class="try">Carry the request all the way to www.</div><div class="try">Carry the probe of TTL 3, and see where it goes up.</div>`,
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
        numbers: `<p>At f1, a ${FRAME}-byte frame, the probe, takes ${READS} trie reads and ${(ENGINE_NS / CLOCK_NS).toFixed(0)} cycles, ${ENGINE_NS.toFixed(0)} ns at ${CLOCK_NS} ns a cycle. That is a byte a cycle, about 2 Gb/s. It serves this model's access links and falls short of its 10 and 100 Gb/s links: a real backbone router's engine is wider and pipelined, with a shorter path through it, so this column is an upper bound on what its engine adds. The panel starts on the ${PATH_FRAMES[0].frame().length}-byte request, so its cycles are more than these.</p>`,
      },
    },
    {
      title: 'One packet, all the way',
      body: `
        <p>Four delays make up the time at each hop. <strong>Light</strong>: length over speed, an assumed 200 000 km/s in fibre, 5 µs a kilometre, which no money can change. <strong>Bits</strong>: frame size over the link's rate, with 24 bytes of wire overhead. <strong>Queue</strong>: what is already waiting ahead of you, here M/M/1's mean, ρ / (1 − ρ) service times, for cross traffic of an assumed size. <strong>Engine</strong>: chapter ${numOf('router')}'s cycles.</p>
        <p>The table shows which one matters where, and it is not the same one. In the backbone, a ${BIG}-byte packet, a ${BIG_FRAME}-byte frame, takes ${(serMs(OCEAN, BIG_FRAME) * 1000).toFixed(2)} µs of bits and ${ms1(propMs(OCEAN))} ms of light on the ocean: light is everything. On the access line, the same frame takes ${(SER_FULL * 1000).toFixed(0)} µs of bits, while light for those ${ACCESS.km} km takes ${(propMs(ACCESS) * 1000).toFixed(0)} µs. One way is ${ms1(ONE_WAY)} ms for a small frame, ${ms1(LIGHT)} ms of that light.</p>
        <p>The queue behaves differently from the others: it is not proportional to load. At half load it is ${(Q50 * 1000).toFixed(0)} µs on this line, one service time. At 95 % it is ${ms1(Q95)} ms, nineteen. Past 100 % it has no mean: it grows until a buffer overflows, and that loss is what <a href="#/c/router">a router</a> without room does and what TCP reads as the signal to slow down.</p><div class="try">Take the access load from 50 to 95 %, and see which column moves.</div><div class="try">Take the packet from 1500 to 64 bytes, and see which rows change at all.</div>`,
      widget: onePacketWidget,
      challenge: {
        kind: 'quiz',
        question: 'On which link does a smaller packet save the most time?',
        options: ['The access line: at its low rate, bits are a large part of the delay', 'The ocean: it is the longest', 'The backbone: it carries the most traffic', 'They all save the same, since the packet is the same'],
        answer: 0,
        explain: `Bits scale with the packet and inversely with the rate. ${ACCESS.mbps} Mb/s is five thousand times slower than the backbone, while light does not care about size at all.`,
        why: ['', 'Length sets the light, which is the same for any packet.', 'Load matters to the queue; a 100 Gb/s link takes 0.08 ns per byte anyway.', 'The saved bits take rate-dependent time, so the slow link gains most.'],
      },
      more: {
        derive: `<p>M/M/1: Poisson arrivals at rate λ, exponential service of mean S, ρ = λS. The mean wait in the queue is ρS / (1 − ρ). Traceroute's times come instead from a queue simulated packet by packet (Lindley's recursion, W<sub>n+1</sub> = max(0, W<sub>n</sub> + S<sub>n</sub> − A<sub>n</sub>)); a test holds its mean to the formula. Real traffic is burstier than Poisson, so a real queue at a given load is usually worse.</p>`,
        real: `<p>Our links are symmetric, and the lengths and rates are invented but typical. An oversized buffer on an access line is the source of bufferbloat: a queue that stays full adds hundreds of milliseconds without losing anything, so TCP has no reason to slow down. Active queue management drops or marks packets early to prevent it.</p>`,
      },
    },
    {
      title: 'A page',
      body: `
        <p>So type <code>${SITE}</code> and press Enter. First the name: ${ms1(DNS.ms)} ms from cold. Then TCP's handshake, one round trip before any data can flow, and a second for keys: the TLS 1.3 handshake of <a href="#/c/secret">Keeping it secret</a>. Then the request, the frame you carried through the gates, one round trip and the server's ${THINK_MS} ms (assumed). Then the response, in slow start: ten segments, then twenty, then forty, each window a round trip after the last. That is <a href="#/c/tcp">chapter ${numOf('tcp')}</a>'s slow start with no loss, from RFC 6928's ten segments of 1460 bytes (an Experimental RFC); chapter ${numOf('tcp')}'s small TCP starts from two of 64.</p>
        <p>From cold, 100 kB takes about <strong>${ms1(PAGE_MS)} ms</strong>, and the round trip of ${ms1(RTT)} ms sets nearly all of it. Move the size and see how little the page itself matters until it gets large: once a window holds more than a round trip of the narrowest link, here ${((RTT * PAGE.bottleneckMbps) / 8).toFixed(0)} kB, the link sets the time and not the round trips. Below that, a link ten times faster changes only the serialization. What helps is fewer round trips or shorter ones: a cached name, and a copy of the site nearby, which is what a content delivery network sells.</p>
        <p>Those keys cost computing as well as a round trip, and this sum leaves it out. The client you ran spends ${km(TLS_CYCLES)} cycles on its handshake. At this book's single-cycle clock of ${CLOCK_NS.toFixed(2)} ns, a rough figure as a one-cycle multiplier would stretch it, that is ${TLS_SECONDS.toFixed(1)} s, as long as ${((TLS_SECONDS * 1000) / RTT).toFixed(1)} round trips of this path. A real client has a faster clock, native code and instructions for the job, which is why the round trips are what you notice.</p><div class="try">Put a copy of the site at the access provider.</div><div class="try">Make the page 2000 kB, and see when bandwidth begins to matter.</div>`,
      widget: fetchWidget,
      more: {
        real: `<p>A real page is many objects from several hosts, and modern browsers reuse connections and resolve names ahead of time. The next step takes the objects. HTTP's meaning, routers' own failures, carrier NAT, Wi-Fi and the radio network are all outside this book. The doubling assumes an ACK for every segment: with delayed ACKs, one for two, and RFC 5681's growth of at most one segment per ACK, a window grows about 1.5 times a round trip. Loss changes the transfer too: <a href="#/c/tcp">chapter ${numOf('tcp')}</a> follows it.</p>`,
      },
    },
    {
      title: 'Many objects: HTTP/2 and QUIC',
      body: `
        <p>That page was one object. A real one is dozens, and what carries them decides how many round trips they cost. HTTP/1.1 on one connection asks for one object at a time, a round trip each. <b>HTTP/2</b> keeps TCP and TLS and splits the connection into streams: every object's frames interleaved, all the requests in one round trip. Which of them to speak is agreed inside the TLS handshake, in its ALPN extension, as <code>h2</code>. Here ${MANY.objects} objects of ${MANY.objectBytes / 1000} kB fall from ${ms1(H1.totalMs)} ms to ${ms1(H2.totalMs)} ms.</p>
        <p>The trouble is underneath. TCP delivers one ordered stream of bytes and has never heard of HTTP/2's streams, so bytes past a lost segment wait in its buffer, whichever object they belong to. The standard says so outright: "TCP head-of-line blocking is not addressed by this protocol". Lose one packet here and ${H2L.heldPackets} packets that did arrive sit waiting for it, from ${H2L.stalled} of the ${MANY.objects} objects.</p>
        <p><b>QUIC</b> moves the streams down into the transport. It runs in UDP datagrams and delivers each stream in order on its own, so the same loss holds back ${H3L.heldPackets} packets, from ${H3L.stalled} object. And it folds the transport's handshake and TLS 1.3's into one, so the first request goes a round trip sooner: ${ms1(H3.totalMs)} ms. HTTP/3 is HTTP's meaning carried on it. The keys, the signature and the checks are the ones you ran; only where they travel has changed.</p>
        <div class="try">Set one object: HTTP/1.1 and HTTP/2 come out equal, as nothing is left to interleave.</div><div class="try">Lose a packet and compare how many objects each one holds up.</div>
        <p>Open any of it and you can keep going down. The page is bytes in <a href="#/c/ethernet">an Ethernet frame</a>, the frame a stream through <a href="#/c/router">a router's</a> gates, the gates are NANDs from <a href="#/c/nand">chapter 3</a>, and a NAND is four of <a href="#/c/mosfet">chapter 1's</a> transistors. Except for the model of the line, and the invented map, it has all been built here.</p>
        <details class="deeper"><summary>Where this comes from</summary><p><a href="https://www.rfc-editor.org/rfc/rfc9113" target="_blank" rel="noopener">RFC 9113</a> (HTTP/2: streams, ALPN's h2, the sentence quoted), <a href="https://www.rfc-editor.org/rfc/rfc9000" target="_blank" rel="noopener">RFC 9000</a> (QUIC: UDP datagrams, the combined handshake, streams) and <a href="https://www.rfc-editor.org/rfc/rfc9114" target="_blank" rel="noopener">RFC 9114</a> (HTTP/3, and a lost packet stalling every transaction on HTTP/2 over TCP). The times are this chapter's model, not a measurement of any browser.</p></details>`,
      widget: stacksWidget,
      more: {
        real: `<p>Browsers open several HTTP/1.1 connections to a host, which narrows its gap; its pipelining only partly helped, and this leaves it out. A real page also finds its objects as it reads the HTML, rather than asking for them all at once. A site can advertise HTTP/3 in an Alt-Svc header on an earlier answer, and a browser that has not seen one gets no round trip back. A returning QUIC client can send data at once (0-RTT), and connection identifiers let a connection move to a new network path. In the model every packet is the same size on all three, the lost one comes again one round trip later, which is the best case (with little left to send, a sender must wait for a timeout), and the window is not cut after the loss: it compares what waits, not congestion control, which is the subject of the chapter on TCP.</p>`,
      },
    },
  ],
};
