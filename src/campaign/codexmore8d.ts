// The fuller codex for the Communication extension: carriers, codes, queues, datacentre (codexcomm2d.ts holds the summaries). No DOM.

import type { CodexMore } from './codexmore';

export const MORE8D: Record<string, CodexMore> = {
  fft: {
    idea: `Correlating a block with every tone is the discrete Fourier transform, N² complex multiplications by its definition. The FFT splits a transform of N into two of N / 2, on the even and on the odd samples, and joins them with X[k] = E[k] + W<sup>k</sup> O[k] and X[k + N / 2] = E[k] − W<sup>k</sup> O[k]. That pair is the butterfly, and recursion leaves N / 2 · log<sub>2</sub> N of them. Everything else is which samples meet, which is why the inputs arrive in bit-reversed order.<br><br>Hardware cares which multiplications are real. A twiddle of 1 is nothing, −j swaps the parts, 45° is two constant multipliers, and each adder halves so the transform cannot outgrow its word. Unrolled, a network does a whole transform per settling time; a streaming pipeline gives each butterfly its own clock cycle, with a delay line in place of most of the arithmetic.`,
    example: {
      title: 'What 16 points cost, two ways',
      body: `<pre>at 10 bits a part, in NANDs
one butterfly's four adders     416
a 45° turn                    1752
a general complex multiplier  6884
8 points, unrolled            8496   (7 W⁰, 3 −j, 2 turns: no general multiplier)
16 points, unrolled          51 360
16 points, streaming         22 591   (one sample a clock, 19 edges of latency)
64 points, streaming         54 598</pre>The word sets the noise: each bit gains about 6 dB, and each doubling of N costs about 3 dB on a noise-like block.`,
    },
    mistakes: [
      'Counting N / 2 · log<sub>2</sub> N "multiplications" as the cost: 10 of the 12 butterflies in an 8-point FFT are wires, and none of them needs the general multiplier.',
      'Reading a streaming FFT\'s output in natural order: the tones leave bit-reversed, so tone 5 of 16 is the eleventh out.',
      'Sizing the word for a pure tone: a real block looks like noise, its tones are each about 1 / √N of the samples, and the rounding stays one unit a butterfly.',
    ],
    lib: 'fftnet8_10',
    chapters: [
      { chapter: 'carriers', step: 0, label: 'Many tones, one FFT' },
      { chapter: 'carriers', step: 1, label: 'The butterfly' },
      { chapter: 'carriers', step: 2, label: 'Eight points, in gates' },
      { chapter: 'carriers', step: 3, label: 'A sample every clock' },
      { chapter: 'carriers', step: 4, label: 'How many bits a sample' },
      { chapter: 'spectrum', step: 3, label: 'More points are not more resolution' },
      { chapter: 'spectrum', step: 5, label: 'Filtering by blocks' },
      { chapter: 'spectrum', step: 6, label: 'One bin, cheaply: Goertzel' },
    ],
  },
  waterfill: {
    idea: `Each tone is a small channel with its own gain over noise g<sub>k</sub>, and the bits it carries are log<sub>2</sub>(1 + g p / Γ), a curve that flattens: the first watt on a good tone buys far more than the hundredth. Maximizing the sum with the total power fixed gives every tone in use the same marginal rate, so p = μ − Γ / g. Draw a floor of height Γ / g over each tone and pour in the budget, and the water finds one level μ. A tone whose floor stands above the water gets nothing.<br><br>Real modems need whole bits, and greedy loading gets them: add one bit at a time to the tone where it costs least, Γ 2<sup>b</sup> / g. Since the costs on each tone rise, greedy is optimal for whole bits.`,
    example: {
      title: 'By hand, then on a loop',
      body: `<pre>gains 1 and 2, budget 3, Γ = 1: floors 1 and ½
μ − 1 + μ − ½ = 3, so μ = 2.25; powers 1.25 and 1.75
3.34 bits, against 3.32 for an even split

the illustrative loop, gap 10 dB, 223 tones
3 km: water-filling 1796 bits, flat 1795, whole bits 1788
5 km: flat on all 429, flat on the best 89: 522, water-filling 524</pre>At 5 km the gain is nearly all in dropping the tones not worth using.`,
    },
    mistakes: [
      'Giving power in proportion to gain: that overfeeds the good tones, whose curve has flattened. Water-filling gives the better tone more, but not in proportion.',
      'Saying ADSL water-fills: a spectral mask caps each tone to protect neighbouring pairs, so its power stays nearly flat and its bits follow the SNR.',
      'Treating a dry tone as a broken one: it may be perfectly good, and a larger budget can raise the level over it.',
    ],
    chapters: [
      { chapter: 'carriers', step: 6, label: 'Water-filling' },
      { chapter: 'carriers', step: 5, label: 'ADSL: many carriers' },
    ],
  },
  ldpc: {
    idea: `A code defined by checks that each touch only a few bits, and a decoder that only passes messages along those checks. Every bit starts with what the channel said, as a log-likelihood ratio. In each round a bit tells each of its checks what it believes, leaving out what that check last told it, and a check tells each bit what the others imply: their parity for the sign, and for the size about the least sure of them. The leaving-out is essential: a message must carry only new information, or a bit hears its own opinion back as confirmation.<br><br>On a graph with no cycles this is exact. A real code has cycles, and it still works while they are long compared with the number of rounds. Replacing the tanh rule by a minimum gives min-sum, which needs only comparators, and is what hardware usually builds.`,
    example: {
      title: 'A threshold you can compute',
      body: `<pre>(3, 6) on the erasure channel: x′ = ε (1 − (1 − x)⁵)²
the recursion falls to zero up to ε* = 0.4294; capacity at rate ½ is 0.5
on the Gaussian channel: threshold between 1.01 and 1.16 dB, limit 0.19 dB

operations at 2 dB on a 2016-bit word
12 messages a round per data bit × 10.8 rounds ≈ 130 updates
K = 7 Viterbi: 128 branch additions (64 add-compare-selects) a data bit</pre>A word of 504 bits at 2.4 dB already makes about 6 errors in 10 000, where K = 7 soft's bound is about 6 in 1000.`,
    },
    mistakes: [
      'Echoing a check\'s own message back to it: the beliefs then grow with no new information, and a wrong one stops the decoder changing its mind.',
      'Reading a threshold as a guarantee for your code: it belongs to the ensemble in the limit of long blocks, and a short or unlucky code stalls below it.',
      'Choosing a very long word because the plot falls steeply: a word can only be decoded once it has all arrived, so its length is delay, plus memory for a message on every edge.',
    ],
    chapters: [
      { chapter: 'codes', step: 8, label: 'Decoding by gossip' },
      { chapter: 'codes', step: 9, label: 'A threshold you can compute' },
      { chapter: 'codes', step: 10, label: 'The waterfall' },
      { chapter: 'codes', step: 11, label: 'What near the limit costs' },
    ],
  },
  littleslaw: {
    idea: `Before any buffer fills, a queue is already a matter of probability: packets arrive at random and the link sends one at a time, so sometimes they meet. For random arrivals the mean wait is ρ (1 + c²) / (2 (1 − ρ)) packet times, where c is the spread of packet sizes (Pollaczek-Khinchine). Fixed sizes give half of what exponential ones do, and most of the rise comes from the idle share below the line.<br><br>Little's law holds for any queue at all, with no assumption about arrivals: the mean number inside is the rate times the mean time inside. It lets you turn a measured queue length into a delay without timing a single packet.`,
    example: {
      title: 'The wait against load, random packet sizes',
      body: `<pre>ρ = 0.5   1 packet time
ρ = 0.8   4
ρ = 0.9   9      one packet in 100 waits 45
ρ = 0.99  99

at 100 Mb/s a 1500-byte packet is 0.12 ms; at 1 Mb/s, 12 ms</pre>To halve the wait at 80 % load, bring the load to two thirds, not to 40 %.`,
    },
    mistakes: [
      'Expecting delay to rise in step with traffic: going from 50 % to 90 % load is 80 % more traffic and nine times the wait.',
      'Calling a link safe because it averages half-full: the wait is about variation too, and the tail is several times the mean.',
      'Reading ρ / (1 − ρ) as a law of nature: it is for random arrivals, and fixed packet sizes alone halve it.',
    ],
    chapters: [{ chapter: 'queues', step: 0, label: 'Delay from load alone' }],
  },
  cubic: {
    idea: `Reno's sawtooth is simple enough to solve: the window climbs from W / 2 to W at one packet a round trip, so at loss rate p it averages √(3 / 2p). Across a long fat pipe that is hopeless: after one loss Reno needs half a pipe's worth of round trips to climb back, and it fills the pipe only if losses are rarer than real paths allow.<br><br>CUBIC (RFC 9438) keeps the increase but changes its curve, in real time and not in round trips. It falls by 30 %, climbs fast, flattens as it nears W<sub>max</sub>, the window where it last lost, waits there, then probes beyond. K, the time to return, is the cube root of W<sub>max</sub> (1 − β) / C. Where a short RTT or a small window would make it slower than Reno, a Reno-friendly region takes over.`,
    example: {
      title: 'One loss on 1 Gb/s across 100 ms',
      body: `<pre>the pipe: 8333 packets of 1500 bytes
Reno:  4167 round trips to climb back, about 7 minutes
       and it needs under one loss in 4.6 × 10⁷ packets
CUBIC: K = ∛(8333 × 0.3 / 0.4) ≈ 18.4 s

at one loss in 10 000, 100 ms: Reno 122 packets, CUBIC 187</pre>CUBIC's average is (C (3 + β) / (4 (1 − β)))^¼ (RTT / p)^¾, 1.054 (RTT / p)^¾ at C = 0.4, β = 0.7.`,
    },
    mistakes: [
      'Reading t as round trips: it is time since the last cut, so two flows with different round trips climb alike in seconds, which is what ends Reno\'s penalty on long paths.',
      'Calling it unfair to Reno everywhere: on small windows and short round trips its Reno-friendly region holds it at about Reno\'s rate.',
      'Thinking it fixes bufferbloat: it still reads only loss, so it still fills a tail-drop buffer, and on a bloated one it adds half a second of delay like Reno.',
    ],
    chapters: [
      { chapter: 'queues', step: 3, label: 'A window from a formula' },
      { chapter: 'queues', step: 1, label: 'Bufferbloat, measured' },
    ],
  },
  aqm: {
    idea: `If a loss is the signal, the queue can send it sooner. RED (Floyd and Jacobson, 1993) drops at random, with a chance rising in a line as the averaged queue length rises between two thresholds. Its numbers have to fit the link and the load, since a queue length means different things at different rates.<br><br>CoDel (Nichols and Jacobson, 2012; RFC 8289) measures the right thing: how long this packet waited. A short burst is good, a queue that never empties is bad, and a good queue touches zero. So it starts dropping only if every packet's wait has stayed above a target of 5 ms for a whole interval of 100 ms, then drops gently harder, with the next drop interval / √count later, until the wait comes down.`,
    example: {
      title: 'The same link, the same 1000-packet buffer',
      body: `<pre>CUBIC, 20 Mb/s, 50 ms round trip; a model of one bottleneck
tail drop   504 ms added   100 % of the link
RED         101 ms         100 %
CoDel         3 ms          96 %, with 17 packets dropped in 45 s</pre>Under CoDel the buffer's size no longer matters: the wait, not the space, decides.`,
    },
    mistakes: [
      'Tuning RED\'s thresholds to a link whose rate changes: 50 packets is 60 ms at one rate and 6 ms at ten times it, which is why CoDel measures time.',
      'Getting CoDel\'s spacing wrong by one: the second drop comes a full interval after the first, then interval / √2, then interval / √3.',
      'Expecting no cost: a window that falls below the pipe gives up a little throughput, and the drops still have to be sent again.',
    ],
    chapters: [{ chapter: 'queues', step: 4, label: 'Drop before it is full' }],
  },
  fairqueue: {
    idea: `A shared first-in, first-out queue has a flaw no discipline for one queue can mend: a sparse flow still waits behind everybody's bulk. Fair queueing gives each flow its own queue and serves them in turn. One packet of a voice call waits for at most one packet from each other flow, and each sender's own policing only punishes that sender.<br><br>FQ-CoDel (RFC 8290) is the two together. A router can do it because it only hashes a flow's addresses and ports to a queue, keeping no per-connection state beyond that. It moves power from the end points to the bottleneck, and it only works at the router that actually is the bottleneck, which is why a home router matters more than anything in the core.`,
    example: {
      title: 'Three senders, one link of 20 Mb/s',
      body: `<pre>CUBIC at 50 ms, Reno at 20 ms, CUBIC at 200 ms; a labelled model
tail drop   13.8, 0.6, 5.0 Mb/s   fairness 0.58   a sparse packet waits 539 ms
FQ-CoDel     6.4, 6.9, 5.6 Mb/s   fairness 0.99   it waits 1.1 ms</pre>The model is plain round robin; real fq_codel also serves a sparse flow first, and hashes where the model gives each flow its own queue.`,
    },
    mistakes: [
      'Expecting a greedy sender to crowd the others out: when full, the queue drops from the longest queue, which is its own.',
      'Fitting it to a router upstream of the bottleneck: no queue forms there, so it has nothing to schedule. Set the rate just below the link so the queue forms where it can be managed.',
      'Thinking it needs a table of connections: a hash to a queue is all it keeps.',
    ],
    chapters: [{ chapter: 'queues', step: 5, label: 'A queue per flow' }],
  },
  ecn: {
    idea: `A drop is an expensive way to say "slow down": the data has to be sent again, and the application waits a round trip for it. ECN (RFC 3168) uses two bits in the IP header. A sender that supports it says so in those bits, a congested router changes them to Congestion Experienced instead of dropping, the receiver echoes that in its ACKs, and the sender cuts its window as if a packet had been lost, once a round trip.<br><br>For a bulk transfer that is a small saving. For an interactive session, whose lost packet might be the last in a burst and take a whole timeout to discover, it is large. Saying more with the same bits is the next step: a router that marks early and often, with a sender reducing in proportion, keeps the queue near zero. That is DCTCP in a data centre and L4S on the internet.`,
    example: {
      title: 'CoDel with drops, and with marks',
      body: `<pre>CUBIC, 20 Mb/s, 50 ms; a labelled model, 45 s counted
drops: 17 packets lost              18.5 Mb/s
marks: 0 lost, 17 marked            18.6 Mb/s</pre>The same signal at the same moments, with nothing to send again.`,
    },
    mistakes: [
      'Expecting the router to slow down: it only signals. The window is the sender\'s, so the mark has to go by way of the receiver and back in an ACK.',
      'Turning it on with a tail-drop queue and expecting less loss: tail drop has nothing to mark with, since it only acts when full.',
      'Thinking a mark arrives sooner than a loss: it still takes a round trip to reach the sender. What it saves is the data.',
    ],
    chapters: [{ chapter: 'queues', step: 6, label: 'A mark in place of a drop' }],
  },
  bbr: {
    idea: `Every loss-based sender reads a loss or a mark as "too fast". BBR (Cardwell et al., 2016) models the path instead, with two numbers: the bottleneck's rate, as the largest delivery rate seen in ten round trips, and the base RTT, as the smallest seen in ten seconds. Their product is the pipe. It sends paced at that rate, with a window capped at two pipes, so it never needs a buffer to fill.<br><br>To keep the numbers honest it has to look. A faster bottleneck cannot show up unless it sends faster, so one round trip in eight runs at 1.25 times its estimate, then 0.75 times to drain what that queued. An empty pipe's RTT cannot be seen with a queue in it, so every ten seconds it drops to four packets for 200 ms. This is the first version: later ones read loss and marks too, so as to share better.`,
    example: {
      title: 'A labelled model of BBR\'s first version',
      body: `<pre>20 Mb/s, 50 ms, a 1000-packet buffer: adds 35 ms where CUBIC adds 504 ms
1 % random loss, 100 ms: BBR 18.8 of 20 Mb/s; Reno 1.5 (Mathis: 1.47)

BBR and CUBIC on one link, tail drop
40 packets    19.0 and 0.3 Mb/s
320 packets   12.0 and 7.5 Mb/s
FQ-CoDel, 40   9.7 and 9.7 Mb/s</pre>One run each, so take the pattern and not the digits.`,
    },
    mistakes: [
      'Expecting it to share evenly with CUBIC: drops fall on both but only CUBIC reacts, so on a shallow buffer its rate collapses. The share follows the buffer.',
      'Reading its 1.25 phase as trying to cause a loss: it is the only way a faster bottleneck can appear in the delivery rate.',
      'Taking "ignores loss" as "never loses": on a shallow buffer it drops packets freely and does not slow down, and those still have to be sent again.',
    ],
    chapters: [
      { chapter: 'queues', step: 7, label: 'BBR: measure the pipe' },
      { chapter: 'queues', step: 8, label: 'CUBIC meets BBR' },
    ],
  },
  fattree: {
    idea: `The telephone exchange needed N lines to reach N lines without a switch the size of N², and the answer was three stages of small switches. A data centre needs the same in Ethernet. Fold the Clos network in half along its middle stage, so inputs and outputs are the same ports, and you have a leaf-spine fabric, or with a further stage a fat tree (Al-Fares et al., 2008): every switch the same cheap part, with half its ports up and half down below the core.<br><br>Real fabrics often give up full bisection on purpose: most servers are not sending flat out, and every uplink not fitted is money saved. Oversubscription is hosts' rate over uplinks' rate.`,
    example: {
      title: 'Counting one',
      body: `<pre>k-port switches: k³ / 4 hosts, 5k² / 4 switches, (k / 2)² paths between pods
k = 4    16 hosts      20 switches      4 paths
k = 48   27 648 hosts  2880 switches   576 paths

40 × 25 Gb/s servers on 8 × 100 Gb/s uplinks: oversubscribed 1.25 to 1</pre>`,
    },
    mistakes: [
      'Claiming full rate between any two hosts as a property of the wiring alone: it holds only if traffic spreads evenly over the paths, and a hash does not spread it evenly.',
      'Applying the exchange\'s m ≥ 2n − 1 here: that keeps a circuit from blocking. No circuit is reserved in a packet fabric, so a poor spread shows up as queues and not as a refused call.',
      'Saying every switch has half its ports up: core switches have none going up.',
    ],
    chapters: [{ chapter: 'datacentre', step: 0, label: 'The exchange, folded' }],
  },
  ecmp: {
    idea: `With many equal paths the fabric has to choose one for each packet. Switches do it by hashing the five-tuple (addresses, ports, protocol) to an uplink. It is stateless and needs no controller, and all of a flow's packets take one path, so TCP sees them in order. It also ignores load, so it is balls in bins.<br><br>Most flows are small and this does not matter. A few elephants collide and sit on one link while the next is idle. There are three ways round it: a central scheduler moves the elephants (Hedera, 2010), a leaf switch splits a flow where a pause is long enough that its packets cannot reorder (flowlets, CONGA, 2014), or the fabric sprays packets over every path and leaves the reordering to the far end.`,
    example: {
      title: 'Balls in bins',
      body: `<pre>n flows, m paths: a path is idle with chance (1 − 1 / m)ⁿ
n = m = 32     64 % of the fabric carried
n = m → large  1 − 1 / e ≈ 63 %

8 flows on 64 paths: a 37 % chance that two share a path</pre>`,
    },
    mistakes: [
      'Sending a flow\'s packets over all the paths for better balance: they then overtake each other, and TCP reads three out-of-order arrivals as a loss and halves for nothing.',
      'Measuring balance by the number of flows on each path: one elephant can outweigh a thousand mice.',
      'Expecting a free path to be chosen: the hash cannot see load.',
    ],
    chapters: [{ chapter: 'datacentre', step: 1, label: 'A hash for a route' }],
  },
  incast: {
    idea: `Data centre applications fan out: a storage read goes to a dozen disks, and the answers come back at once because the servers were all asked at once. They all aim at one port with a shallow buffer. The first packets fill it and the rest are lost (Phanishayee et al., 2008).<br><br>A flow that loses packets mid-burst gets duplicate ACKs and recovers in a round trip. A flow that loses the end of its burst, or all of it, has no later packet to trigger them, so it waits for its retransmission timer, a minimum set for the internet. And the read waits for the slowest flow. The fixes are a timer floor near a round trip (Vasudevan et al., 2009), a deeper buffer, staggered requests, and keeping the queue empty in the first place.`,
    example: {
      title: 'A model of a synchronized read, 256 KB from each server',
      body: `<pre>1 Gb/s port, 32 packets of buffer, a fixed 200 ms timer
2 servers    no timeout
40 servers   timeouts, and the wire idle for most of the read

40 servers: a 1 ms timer brings most of the rate back; so do 512 packets of buffer
on those 512 packets a fixed 1 ms timer fires on packets that were only waiting</pre>A real TCP's minimum is a floor under its measured round trip plus a margin, which is what makes lowering it safe.`,
    },
    mistakes: [
      'Looking for the bottleneck in the wire: it is idle during the timeout. The time goes to waiting with data unsent.',
      'Adding servers to go faster: past the buffer, more servers make the same read slower.',
      'Blaming loss in general: only a loss with too few packets behind it waits for the timer.',
    ],
    chapters: [{ chapter: 'datacentre', step: 2, label: 'Incast' }],
  },
  dctcp: {
    idea: `If queues are what hurt, keep them short and keep the link full. ECN means "halve", and a halved window empties a short queue and idles the link. DCTCP (Alizadeh et al., 2010) makes the mark carry a quantity. The switch marks by a simple threshold, with no averaging; the receiver echoes the marks exactly; the sender keeps α, the running share marked (α ← (1 − g) α + g F, g = 1 / 16), and cuts W ← W (1 − α / 2) once a round trip.<br><br>The paper's analysis gives approximate closed forms: for one flow with W* = C · RTT + K, a steady share marked of about √(2 / W*) and a queue swing of about ½ √(2 W*). The swing grows only as a square root of the pipe, where Reno's grows with it. The queue's free space is what incast's burst needs.`,
    example: {
      title: '10 Gb/s, 100 µs, a pipe of 83 packets, K = 20',
      body: `<pre>closed forms   α ≈ 0.139, swing ≈ 7 packets
the model      α = 0.10, 100 % of the link, a mean queue of 17 packets (21 µs)
halving on the same marks: 76 % of the link</pre>The paper's safe bound on K is about C · RTT / 7, 12 packets here, for flows in step.`,
    },
    mistakes: [
      'Running it alongside Reno on the internet: it is far more aggressive on a mark, which is the problem L4S tries to solve.',
      'Adding a marking average in the switch: a threshold on the instantaneous queue is what lets it react within a round trip.',
      'Reading a 10 % mark rate as a 10 % cut: the cut is α / 2, so that α = 1 gives exactly the older halving.',
    ],
    chapters: [
      { chapter: 'datacentre', step: 3, label: 'DCTCP: the queue near zero' },
    ],
  },
  rdma: {
    idea: `At 100 Gb/s a 1 KB packet takes about 80 ns, far less than a TCP stack's thousands of instructions per packet plus a copy and an interrupt. RDMA moves the whole transport into the NIC: an application registers memory and posts a request directly to the hardware, with no system call, and the NIC on the far side writes the data into memory with no interrupt and no CPU on either end. It came from InfiniBand, and RoCEv2 runs it over ordinary UDP and IP.<br><br>The catch is in the repair. To stay simple enough to build in a NIC, classic RDMA delivers in order and retransmits with go-back-N, so a loss throws away the whole pipe behind it. That is why data centres set out to build a network that almost never loses. Newer NICs do selective repair and tolerate reordering, which weakens the argument.`,
    example: {
      title: 'What a loss costs, 100 Gb/s across 10 µs',
      body: `<pre>the pipe: W = 122 packets of 1 KB
goodput = (1 − p) / (1 − p + W p)
one loss in 100 000   99.88 %
one loss in 1000      89 %    (selective repeat: 99.9 %)</pre>For small p goodput depends on W p, so four times the rate wants a quarter of the loss.`,
    },
    mistakes: [
      'Assuming RDMA needs no network care because the host is out of the way: the transport still repairs loss, and this repair is expensive.',
      'Comparing it with TCP by bandwidth alone: what it frees is the CPU and the latency.',
      'Quoting a safe loss rate without the rate and the round trip: the pipe sets the cost.',
    ],
    chapters: [{ chapter: 'datacentre', step: 4, label: 'RDMA: past the kernel' }],
  },
  pfc: {
    idea: `Ethernet can be made lossless with one mechanism. When a switch's input buffer for a traffic class passes XOFF, it sends a pause frame upstream, and that port stops the class until told otherwise. Nothing is dropped, provided the switch can hold what is on its way: a pause takes a one-way delay to arrive and the packets already sent take another to land.<br><br>A pause stops a whole class on a link, whoever's packets those are, so one slow receiver holds up flows with no connection to it, and that can reach back many hops. Worse, if each queue's head waits for room in the next and those waits form a loop, nothing can ever move: a cyclic buffer dependency. A fat tree routed strictly up then down has no cycle, but a reroute or a flooded packet can make one. It should be a safety net under DCTCP-style marking (DCQCN, 2015), not the control loop.`,
    example: {
      title: 'Two flows, one upstream queue, a receiver at a quarter of the link',
      body: `<pre>each flow offers 0.5 of the link; a labelled model
lossy     slow flow 0.25, fast flow 0.50, 7434 packets dropped
lossless  slow flow 0.25, fast flow 0.25, none dropped, paused half the time

headroom ≈ 2 · delay + 2 packets: 18 for a delay of 8
at 100 Gb/s over 100 m (500 ns), about 15 packets of 1 KB</pre>The headroom is a safe bound: it counts nothing draining meanwhile.`,
    },
    mistakes: [
      'Treating lossless as free: it costs headroom per port and class, innocent flows held up, and the possibility of deadlock.',
      'Expecting a deadlock to clear when load falls: it can only be broken from outside, by a watchdog that starts dropping again.',
      'Pausing all traffic: the P is for priority, and classes are paused one by one.',
    ],
    chapters: [
      { chapter: 'datacentre', step: 5, label: 'A lossless Ethernet' },
      { chapter: 'datacentre', step: 6, label: 'When lossless stops' },
    ],
  },
  tailscale: {
    idea: `A request waits for all its parts. If each of n servers is slow with chance q, the request is slow with chance 1 − (1 − q)<sup>n</sup> (Dean and Barroso, 2013). So what is rare on one server is the normal case for a service with a large fan-out, and a page may make many such requests.<br><br>That is the thread through a data centre's network. Hash collisions, incast, standing queues, pauses and timers are all rare on one flow. The cures run through every layer: many paths, empty queues, microsecond timers, a NIC that bypasses the kernel. Applications do their share: re-sending a request to a second replica if the first has not answered by about its 95th percentile removes much of the tail, for a few percent more load.`,
    example: {
      title: 'Fan-out divides the budget',
      body: `<pre>q = 1 %, n = 100          63 % of requests slow
q = 1 %, n = 50           39 %
want 1 % slow at n = 50:  q ≈ 0.0002, about 1 in 5000</pre>For small q the share slow is about n q.`,
    },
    mistakes: [
      'Judging a service by its servers\' mean latency: a fan-out reads the tail of each.',
      'Sending every request to two replicas at once: that doubles the load. Hedging waits until a reply is already late.',
      'Setting a per-server target equal to the service\'s: fan-out divides it.',
    ],
    chapters: [{ chapter: 'datacentre', step: 7, label: 'The tail at scale' }],
  },
};
