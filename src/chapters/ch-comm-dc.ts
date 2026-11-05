// Inside the data centre (level Communication): how a hundred thousand machines talk. Labelled models throughout: comm/dc.ts for the fabric, ECMP, incast, go-back-N, PFC and deadlock, comm/queues.ts for DCTCP; tests/comm-dc.test.ts holds them to closed forms. The Clos network is the exchange chapter's.

import { bestClos } from '../comm/exchange';
import { ecmpExpected, ecmpNoCollision, fanoutSlow, fatTree, gbnGoodput, incast, oversubscription, pfcHeadroom, pfcRun, ringRun } from '../comm/dc';
import { bottleneck, dctcpAlpha, dctcpAmplitude } from '../comm/queues';
import { arqWidget, dctcpWidget, ecmpWidget, fabricWidget, incastWidget, pfcWidget, ringWidget, tailWidget } from '../widgets/dc';
import { numOf } from './order';
import type { Chapter, Step } from './types';

const nf = (x: number, d = 0) => x.toFixed(d);
const n0 = (x: number) => Math.round(x).toLocaleString('en');

const read = (senders: number, rtoMs = 200, bufferPkts = 32) => incast({ senders, blockBytes: 256 * 1024, bufferPkts, rtoMs });

const steps: Step[] = [
  {
    title: 'The exchange, folded',
    get body() {
      const f48 = fatTree(48), c = bestClos(1024);
      return `
      <p><a href="#/c/exchange/0">The telephone exchange</a> needed N lines to reach N lines without a switch the size of N², and the answer was three stages of small switches: for 1024 lines, ${n0(c.crosspoints)} crosspoints against ${n0(1024 * 1024)}. A data centre needs the same thing in Ethernet (and this chapter is all labelled models, since the real thing is a building). Fold the Clos network in half along its middle stage, so inputs and outputs are the same ports, and you have a <strong>leaf-spine</strong> fabric, or with a further stage a <strong>fat tree</strong> (Al-Fares et al., 2008): every switch the same cheap part, k ports, half up and half down below the core. This is why fabrics are not built from one enormous switch: that part does not exist at any price, and this one does at a commodity's.</p>
      <p>A fat tree of k-port switches has k³ / 4 hosts, 5k² / 4 switches, and (k / 2)² paths between two pods. At 48 ports: ${n0(f48.hosts)} hosts, ${n0(f48.switches)} switches, ${n0(f48.core)} paths. And with as many links up as hosts down, any host can reach any other at its full rate, if the traffic spreads evenly over the paths, and then the placement of a job no longer matters. The next step is about that "if". Real fabrics often give that up on purpose. Forty 25 Gb/s servers on eight 100 Gb/s uplinks are <strong>oversubscribed</strong> ${nf(oversubscription(40, 25, 8, 100), 2)} to 1, since most servers are not sending flat out, and every uplink not fitted is money saved.</p>
      <p>The point of each model here is a formula you could check on a real fabric.</p>
      <div class="try">Press <strong>Another path</strong> several times: each is one of the paths between the same two hosts. Then raise the port count and read the counts.</div>`;
    },
    widget: fabricWidget,
    challenge: {
      kind: 'quiz',
      question: 'The exchange had to route a circuit before a call could start, and a strict-sense Clos needs m ≥ 2n − 1 middle switches to guarantee it. Why does a packet fabric of m = n work?',
      options: ['No circuit is reserved: each packet takes a path when it is sent, and m = n has the capacity if traffic can spread evenly over the paths', 'Packets are smaller than calls', 'Ethernet links are faster than telephone lines', 'A packet fabric never carries more than half its capacity'],
      answer: 0,
      explain: 'A circuit must find one free path through and hold it for the call, which is what makes blocking a matter of combinatorics. Packets share every path. The price is that a poor spread now shows up as queues and not as a refused call: the next step.',
      why: ['', 'Size does not change the count of paths.', 'Faster links would help a circuit network alike; the difference is in holding a path.', 'Some do run that light, but the argument does not depend on it.'],
    },
  },
  {
    title: 'A hash for a route',
    get body() {
      return `
      <p>With (k / 2)² equal paths the fabric has to choose one for each packet. Switches do it by <strong>equal-cost multipath</strong>: hash the five-tuple (addresses, ports, protocol) and pick that path's uplink. It is stateless and needs no controller, and all of a flow's packets take one path, so TCP sees them in order. And it ignores load. That makes it balls in bins. With n flows that could each fill a path and m paths, a path is idle with chance (1 − 1 / m)<sup>n</sup>. With as many flows as paths, the fabric carries <strong>1 − 1 / e ≈ ${nf(100 * ecmpExpected(1000, 1000), 0)} %</strong> of what it could. Even 8 flows on 64 paths have a ${nf(100 * (1 - ecmpNoCollision(8, 64)), 0)} % chance that two collide: the birthday problem.</p>
      <p>Most flows are small and this does not matter. A few elephants, a backup or a shuffle, are what collide and sit on one link while the next is idle, and that made ECMP's waste a reason for better balance. There are three ways. A central scheduler can move the elephants (Hedera, 2010). A sender can split a flow where there is a pause long enough that its packets cannot reorder, <em>flowlets</em> (CONGA, 2014). Or the fabric can spray packets over every path and leave the reordering to whoever is at the far end, as RDMA NICs and some newer fabrics are built to tolerate.</p>
      <div class="try">Set 16 flows and 16 paths and press <strong>New hash</strong> a few times. Then find how many paths 16 flows need before collisions are rare.</div>`;
    },
    widget: ecmpWidget,
    challenge: {
      kind: 'quiz',
      question: 'Why does ECMP send all of one flow\'s packets along one path, given that it would balance better packet by packet?',
      options: ['Over different paths they would arrive out of order, and TCP reads three out-of-order arrivals as a loss and cuts its window', 'Switches can only hold one route per flow', 'It saves bits in the header', 'Different paths have different bandwidths'],
      answer: 0,
      explain: 'A fabric\'s paths have equal capacity but not equal queues, so packets overtake each other. A sender that treats reordering as loss halves for nothing, so ECMP gives up balance to keep the order.',
      why: ['', 'A hash holds no per-flow route at all: it is recomputed from the header each time.', 'It adds nothing to the header either way.', 'ECMP assumes equal cost, and in a fat tree the paths are equal.'],
    },
  },
  {
    title: 'Incast',
    get body() {
      const a = read(2), b = read(40), c = read(40, 1), d = read(40, 200, 512), e = read(40, 1, 512);
      return `
      <p>Data centre applications fan out: a search goes to a thousand machines, a storage read to a dozen disks, and the answers come back at once, because the servers were all asked at once. They all aim at one port. It is fast, its buffer is shallow (a shared-memory switch is built for throughput, not for holding), and it has a few milliseconds' worth at best. The first packets fill it, the rest are lost. <strong>Incast</strong> (Phanishayee et al., 2008) is what that does to TCP.</p>
      <p>A flow that loses packets mid-burst gets duplicate ACKs and recovers in a round trip. A flow that loses the <em>end</em> of its burst, or all of it, has no later packet to trigger them, so it waits for its retransmission timer. Those timers were set for the internet: a minimum of <strong>200 ms</strong> in stock kernels at the time, against a round trip of 100 µs, three orders of magnitude. And the read waits for the slowest flow. In the model, a read of 256 KB each from 2 servers through a 1 Gb/s port with 32 packets of buffer takes ${nf(a.ms, 1)} ms at ${nf(a.goodputGbps * 1000, 0)} Mb/s. From 40 servers it takes ${nf(b.ms, 0)} ms at ${nf(b.goodputGbps * 1000, 0)} Mb/s: the wire was idle for most of it. Adding servers made it slower.</p>
      <p>The direct fix is a timer of about a round trip: 1 ms here gives ${nf(c.goodputGbps * 1000, 0)} Mb/s (Vasudevan et al., 2009). A deeper buffer helps (${nf(d.goodputGbps * 1000, 0)} Mb/s at 512 packets), and costs money in the fastest silicon. The model's timer is a fixed value, so it shows why that alone is not enough: on the deep buffer 1 ms is shorter than the queue, it fires on packets that were only waiting, and the goodput falls back to ${nf(e.goodputGbps * 1000, 0)} Mb/s. A real TCP's minimum is only a floor under its measured round trip plus a margin, and that is why lowering the floor is safe. Applications help too, by staggering requests, or by asking for less at a time. The next step is the approach that attacks the queue itself.</p>
      <div class="try">Find where the first timeout falls at the default buffer. Then change the timer to 1 ms, then raise the buffer instead. Which rescues more?</div>`;
    },
    widget: incastWidget,
    challenge: {
      kind: 'quiz',
      question: `Reads from 40 servers take over 200 ms, on a port that could carry it all in ${nf(((40 * 256 * 1024 * 8) / 1e9) * 1000, 0)} ms. Why does a loss at the end of a burst cost so much more than one in the middle?`,
      options: ['No later packet arrives to produce duplicate ACKs, so the sender can only wait for its timer', 'Later packets are more important to the application', 'The switch drops the retransmission too', 'The receiver gives up on the flow'],
      answer: 0,
      explain: 'A fast retransmit needs three packets behind the gap. With no packets behind it, the only clue left is the timer, set for a far longer path than this one.',
      why: ['', 'All the bytes matter equally: the read waits for all of them.', 'A retransmission meets an empty port by then: it is the waiting that takes the time.', 'It is still waiting, and it receives it when it comes.'],
    },
  },
  {
    title: 'DCTCP: the queue near zero',
    get body() {
      const K = 20, bdp = 83, star = bdp + K, run = (cc: 'dctcp' | 'reno', k = K) => bottleneck({ mbps: 10000, bufferPkts: 400, aqm: 'step', markK: k }, [{ cc, rttMs: 0.1, ecn: true }], 0.6, 0.2), d = run('dctcp'), r = run('reno');
      return `
      <p>If queues are what hurt, keep them short and keep the link full. <a href="#/c/queues/6">ECN</a> means "halve", and a halved window empties a short queue and idles the link. <strong>DCTCP</strong> (Alizadeh et al., 2010) makes the mark carry a quantity. The switch marks every packet that arrives with K or more queued, a simple threshold and no averaging. The receiver echoes the marks exactly. The sender keeps α, the running share of its packets marked (α ← (1 − g) α + g F, g = 1/16), and cuts by W ← W (1 − α / 2) once a round trip (the model at its first mark, as Linux does). Lightly marked, a small cut; all marked, half: so a queue barely above K barely moves the window.</p>
      <p>The paper's analysis gives closed forms, approximate ones. With W* = C · RTT + K for one flow, the steady share marked is about √(2 / W*), ${nf(dctcpAlpha(star), 3)} here, and the queue swings by about ½ √(2 W*), ${nf(dctcpAmplitude(star), 0)} packets. The swing grows only as a square root of the pipe, where Reno's grows with it. In the model, at 10 Gb/s and a pipe of ${bdp} packets, K = ${K}: DCTCP uses ${nf(100 * d.utilization, 1)} % of the link with a mean queue of ${nf(d.meanQueue, 0)} packets, ${nf(d.meanQueue * 1.2, 0)} µs, with α = ${nf(d.dctcpAlpha ?? 0, 2)} and a swing of ${nf(d.maxQueue - (d.minQueue ?? 0), 0)} packets, the same order as those forms; a sender halving on the same marks gets ${nf(100 * r.utilization, 1)} %. The queue's free space is what incast's burst needs. The price is that it is only safe inside one administration, since it is far more aggressive than a Reno flow on a mark, which is the problem L4S tries to solve for the internet.</p>
      <div class="try">Lower K as far as it goes. The paper's safe bound is about C · RTT / 7, 12 packets here, for flows in step. This model's flow loses only a few percent at the very bottom of the slider. Then give it more flows.</div>`;
    },
    widget: dctcpWidget,
    challenge: {
      kind: 'quiz',
      question: 'In a round trip, 10 % of a DCTCP flow\'s packets are marked, and α has settled at 0.1. By how much does its window fall?',
      options: ['5 %: W (1 − α / 2)', '50 %, as for any ECN mark', '10 %, the share marked', 'None until a packet is lost'],
      answer: 0,
      explain: 'Half of α. So the same mark that halves a Reno flow here takes off 5 %, and the queue moves a little around K and not all the way to empty.',
      why: ['', 'That is classic ECN\'s rule, which is the thing this replaces.', 'It is α / 2, so that α = 1 gives exactly the halving of the older rule.', 'It reacts to marks; that is its purpose.'],
    },
  },
  {
    title: 'RDMA: past the kernel',
    get body() {
      const pipe100 = (100e9 * 10e-6) / (1024 * 8), g5 = gbnGoodput(1e-5, Math.round(pipe100)), g3 = gbnGoodput(1e-3, Math.round(pipe100));
      return `
      <p>At 100 Gb/s a 1 KB packet takes 80 ns, on a core that does perhaps a few hundred instructions in that time, and <a href="#/c/tcp/0">a TCP stack</a> runs thousands per packet, plus a copy, plus an interrupt. <strong>RDMA</strong> moves the whole transport into the NIC. An application registers memory and posts a request directly to the hardware, with no system call, and the NIC on the far side writes the data into memory, with no interrupt and no CPU on either end. That is how a storage read can take microseconds, with that core free to do the application's work. It came from InfiniBand, and <strong>RoCEv2</strong> runs it over ordinary UDP and IP.</p>
      <p>The catch is in the repair. To stay simple enough to build in a NIC, classic RDMA delivers in order and retransmits with <strong>go-back-N</strong>: a loss throws away the whole pipe behind it. Goodput is (1 − p) / (1 − p + W p), for a pipe of W packets. On 100 Gb/s across 10 µs, W is ${n0(pipe100)} 1 KB packets, so one loss in 100 000 costs ${nf(100 * (1 - g5), 1)} %, and one in 1000 leaves ${nf(100 * g3, 0)} %. TCP's selective ACKs would keep 99.9 %. A protocol like this needs a network that almost never loses, so data centres set out to build one: the next two steps are that network and what it costs. Newer NICs do selective repair and tolerate reordering, and that weakens this argument.</p>
      <div class="try">Raise the link to 400 Gb/s at the same round trip. How much rarer must a loss get to hold the same goodput?</div>`;
    },
    widget: arqWidget,
    challenge: {
      kind: 'quiz',
      question: 'A loss costs go-back-N a pipe\'s worth of retransmission. The link goes from 100 to 400 Gb/s, round trip the same. What must happen to the loss rate to keep the same goodput?',
      options: ['It must fall by a factor of 4: goodput depends on W p, and W grew fourfold', 'Nothing: goodput does not depend on rate', 'It must fall by 16: W enters squared', 'It may rise, since packets take less time'],
      answer: 0,
      explain: 'W is rate times delay. For small p, goodput is 1 / (1 + W p), so the product is what counts.',
      why: ['', 'It does, through the size of the pipe.', 'W p appears, not W² p. Reno\'s window goes as 1 / √p; this is a different rule.', 'Less time per packet means more of them in flight.'],
    },
  },
  {
    title: 'A lossless Ethernet',
    get body() {
      const oneWay = 8, h = pfcHeadroom(oneWay), loss = pfcRun({ lossless: false, r1: 0.25, buffer: 64, headroom: h, oneWay, slots: 30000 }), pf = pfcRun({ lossless: true, r1: 0.25, buffer: 64, headroom: h, oneWay, slots: 30000 });
      return `
      <p>Ethernet can be made lossless with one mechanism. <strong>Priority flow control</strong> (IEEE 802.1Qbb): when a switch's input buffer for a traffic class passes a threshold XOFF, it sends a pause frame upstream, and the upstream port stops that class until told otherwise. Nothing is ever dropped, provided the switch can still hold what is on its way. That has a clear size: a pause takes a one-way delay to arrive, the packets already sent take another to land, and there may be a packet underway at each end. So the <strong>headroom</strong> above XOFF is about 2 · delay + 2 packets, per port per class: ${h} packets for a delay of ${oneWay} here, and it grows with distance and rate. It is a safe bound, since it counts nothing draining meanwhile: tests/comm-dc.test.ts finds it enough when all traffic heads for the stopped port, with a slow port draining some, and packets lost at a third of it.</p>
      <p>The problem comes next. A pause stops a whole class on a link, whoever's packets those are. Two flows share an upstream queue. Flow 1 goes to a slow receiver, at a quarter of the link, and flow 2 to a free one. With drops, flow 1 gets ${nf(pf.f1, 2)} and ${n0(loss.drops)} losses in this run, and flow 2 passes at ${nf(loss.f2, 2)}, all it offers. With PFC nothing is lost, and flow 2 falls to ${nf(pf.f2, 2)}, because the packets for the slow port block the ones behind them, and the upstream is paused ${nf(100 * pf.pausedShare, 0)} % of the time. That is <strong>congestion spreading</strong>: from one slow receiver back through switches to flows with no connection to it, and in a real fabric it can reach many hops. It is why PFC should be a safety net and not the control loop, with DCTCP-style marking above it (DCQCN, 2015, on RoCE) to keep pauses rare.</p>
      <div class="try">Switch between lossless and lossy and watch the second bar. Then slow the receiver down further.</div>`;
    },
    widget: pfcWidget,
    challenge: {
      kind: 'quiz',
      question: 'A switch\'s port runs at 100 Gb/s, over a cable of 100 m (about 500 ns one way). About how much headroom does PFC need above XOFF, for 1 KB packets, by the formula?',
      options: ['About 15 packets: 2 × 500 ns at 100 Gb/s is 12.5 KB, and two more in progress', 'About 1 packet: a pause is immediate', 'About 1000 packets: a whole BDP of the fabric', 'None: lossless means no buffer is needed'],
      answer: 0,
      explain: 'A pause takes a delay to arrive, and what was sent before it takes a delay to land. 100 Gb/s × 1 µs = 100 kb = 12.5 KB, so about 12.5 packets, plus those underway at each end.',
      why: ['', 'It has a propagation delay like everything else on the wire.', 'That would be a fabric-wide figure; PFC acts on one link.', 'It is the buffer that makes losslessness possible.'],
    },
  },
  {
    title: 'When lossless stops',
    get body() {
      const r = ringRun(4, 2, 4, 200000), one = ringRun(4, 1, 4, 200000), low = ringRun(4, 2, 4, 100000, 0.4);
      return `
      <p>Losslessness makes a new failure possible: one that a dropping network cannot have. If each queue's head is waiting for room in the next queue, and those waits form a loop, nothing can ever move: every buffer is full, each waits for the next, and none is allowed to drop. That is a <strong>cyclic buffer dependency</strong>, the same condition as a deadlock among locks. Four switches in a ring, each flow crossing two links: in the model traffic stops for good at slot ${n0(r.stoppedAt ?? 0)}, after ${n0(r.delivered.reduce((a, b) => a + b, 0))} packets. Lighter load makes it rarer without ruling it out: at 0.4 it stops at slot ${n0(low.stoppedAt ?? 0)}, at 0.3 after about a million slots, and at 0.2 three million were not enough. With one link a flow, no queue waits on another and it runs for ever (${n0(one.delivered.reduce((a, b) => a + b, 0))} packets).</p>
      <p>A clean fat tree routed up, then down has no cycle: every packet climbs, then falls, and the dependencies form a tree. So in the design there is no deadlock. Then something sends a packet down and back up for a moment: a reroute after a link fails, or a switch flooding a packet for an address it has lost, which is how a production PFC deadlock was reported (Guo et al., 2016). The defences are to keep routing up-down strictly, to break the loop with a watchdog that detects a port paused for too long and starts dropping again, or to give each hop its own class. <strong>A drop is what makes a network forgiving</strong>: it can always free a buffer.</p>
      <div class="try">Raise the hops from 1 to 2. Then lower the load: below about 0.3 this short run does not get there, and above that, nothing ever brings it back.</div>`;
    },
    widget: ringWidget,
    challenge: {
      kind: 'quiz',
      question: 'Why can a fat tree with strict up-down routing never have a PFC deadlock?',
      options: ['A packet only climbs and then only falls, so an up link\'s queue waits on higher ones and a down link\'s on lower ones: the dependencies cannot close into a loop', 'Fat trees have more buffer', 'There are many paths, so one is always free', 'Up-down routing drops packets when it has to'],
      answer: 0,
      explain: 'Order the links by height, ups before downs. Every wait goes strictly forward in that order, so no cycle exists. The same ordering is the standard argument against deadlock among locks.',
      why: ['', 'Buffer delays a deadlock. It does not remove the possibility.', 'A flow hashes to one path, and a paused class stops whatever queue it is in.', 'It remains lossless. It simply never makes a cycle.'],
    },
  },
  {
    title: 'The tail at scale',
    get body() {
      return `
      <p>Why does anyone care about a rare 200 ms? Because a request waits for all its parts. If each of n servers is slow with chance q, the request is slow with chance <strong>1 − (1 − q)<sup>n</sup></strong> (Dean and Barroso, 2013). One server in a hundred slow, one hundred servers: ${nf(100 * fanoutSlow(100, 0.01), 0)} % of requests are slow, and the rare case has become the normal one. A fan-out of 100 is not unusual for a search, and a page may make many such requests.</p>
      <p>So at this scale tail latency, and not average latency, is what the network is judged on. That is the thread through this chapter. Hash collisions, incast, standing queues, pauses and timers are all rare on one flow. The cures run through every layer: a fabric with many paths, DCTCP's empty queues, microsecond timers, a NIC that bypasses the kernel. And the applications do their share: a request sent again to a second replica if the first has not answered by about its 95th percentile, with the first answer kept (<em>hedging</em>), removes much of the tail, for a few percent more load.</p>
      <p>This chapter was models, because the real thing is a building. What it adds to chapter ${numOf('switch')}'s switch and chapter ${numOf('tcp')}'s TCP is that the numbers change what the right design is: a timer, a buffer, a route, and even whether losing a packet is good or bad depend on a round trip of microseconds and on the fact that every piece is owned by one operator.</p>
      <div class="try">Find the slowest share per server that still leaves nine requests in ten fast at a fan-out of 100.</div>`;
    },
    widget: tailWidget,
    challenge: {
      kind: 'quiz',
      question: 'A service sends each user request to 50 servers and waits for all. It wants 99 % of requests to be free of a slow reply. About how rare must a slow reply be on each server?',
      options: ['About 1 in 5000: 1 − (1 − q)⁵⁰ = 0.01 gives q ≈ 0.0002', 'About 1 in 100, the same as the target', 'About 1 in 50, one for each server', 'About 1 in 2500, the square of 50'],
      answer: 0,
      explain: 'For small q the share slow is about 50 q, so q = 0.01 / 50 = 0.0002. Fan-out divides the budget per server.',
      why: ['', 'That would make 39 % of requests slow.', 'That would make 64 % of requests slow.', 'That would make about 2 % slow, twice the target.'],
    },
  },
];

export const chDatacentre: Chapter = {
  id: 'datacentre', num: numOf('datacentre'), title: 'Inside the data centre', level: 'Communication',
  blurb: 'How a hundred thousand machines talk: the exchange\'s Clos network folded in Ethernet, ECMP, incast, DCTCP, RDMA, lossless Ethernet and its deadlock, and the tail at scale, on labelled models with closed forms.',
  goals: [
    'count a fat tree\'s hosts, switches and paths, and say what oversubscription trades',
    'work out what ECMP\'s hash leaves unused, and why it keeps a flow on one path',
    'explain incast and DCTCP from their numbers: 200 ms against 100 µs, W (1 − α / 2)',
    'say why RDMA wants a lossless network, what PFC costs in headroom and spreading, why a cycle deadlocks, and why the tail decides',
  ],
  builds: ['exchange', 'switch', 'tcp', 'queues'],
  recap: {
    keep: [
      'A fat tree is a folded Clos: k-port switches, k³ / 4 hosts, 5k² / 4 switches, (k / 2)² paths between pods. Oversubscription is hosts\' rate over uplinks\' rate.',
      'ECMP hashes the five-tuple to a path: stateless and in order, blind to load. With as many flows as paths it carries 1 − 1 / e of the fabric.',
      'Incast: many servers answer at once through one shallow port; a flow that loses its burst\'s end waits for a timer three orders of magnitude longer than the round trip, and the read waits for that flow.',
      'DCTCP marks at a threshold K and cuts W by α / 2, α the share marked: for one flow a swing of about ½ √(2 W*), a full link, a queue near K.',
      'RDMA puts the transport in the NIC; classic go-back-N has goodput (1 − p) / (1 − p + W p), so it wants a network that hardly loses.',
      'PFC pauses a class: headroom 2 × delay + 2 packets per port; a pause stops innocent flows too, and a cycle of pauses never ends. Strict up-down routing has no cycle, and a watchdog is the backstop.',
      'A request waiting on n parts is slow with chance 1 − (1 − q)^n, so tails, not averages, set the design.',
    ],
    check: [
      {
        question: 'With 32 flows on 32 equal paths under ECMP, about what share of the fabric is used?',
        options: [`About ${nf(100 * ecmpExpected(32, 32), 0)} %: a path is idle with chance (1 − 1 / 32)³²`, '100 %: there is one path for each flow', '50 %', '3 %'],
        answer: 0,
        explain: 'A hash does not look at load, so some paths get two or more flows while others get none: 1 − 1 / e in the limit.',
        why: ['', 'It would need a scheduler to place each flow on its own path.', 'That is lower than balls in bins gives.', 'That would be one path in thirty-two.'],
      },
      {
        question: 'Why does a stock 200 ms timer hurt a data centre so much more than it hurts a web user?',
        options: ['The round trip is 100 µs, so 200 ms is thousands of round trips of idle link, and the whole read waits for it', 'Data centre links are slower', 'The web has no timers', 'Web pages cannot tolerate any delay'],
        answer: 0,
        explain: 'On the internet a 200 ms timer is a few round trips. Here it is thousands, spent idle with data waiting.',
        why: ['', 'They are far faster: that is what makes the ratio so large.', 'It has the same timers, on far longer round trips.', 'A web user waits tens of times longer without noticing.'],
      },
      {
        question: 'What does losing losses cost, when Ethernet is made lossless?',
        options: ['Headroom per port and class, innocent flows held up by pauses, and the possibility of deadlock', 'Nothing: it is strictly better', 'Half the bandwidth', 'All other traffic classes must stop as well'],
        answer: 0,
        explain: 'A drop only hurts the flow it hits. A pause hurts whoever is queued behind it, and if pauses form a loop they never end.',
        why: ['', 'That is the view this chapter sets out to correct.', 'It costs no bandwidth when there is no congestion.', 'Classes are paused one by one: that is the P in PFC.'],
      },
    ],
  },
  steps,
};
