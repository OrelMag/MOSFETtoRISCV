// Check yourself for the Communication extension: carriers, codes, queues, datacentre. Two questions an entry, the right option first (the page shuffles), each wrong one saying why. No DOM.

import type { Quiz } from '../chapters/types';

export const CHECK10D: Record<string, Quiz[]> = {
  fft: [
    {
      question: 'Of the 12 butterflies in an 8-point FFT, how many need the general complex multiplier?',
      options: ['None', 'All twelve', 'Eight', 'Four'],
      answer: 0,
      explain: 'Seven have a twiddle of 1, three of −j, which are wires, and two are 45° turns made of constant multipliers. The general multiplier first appears at 16 points.',
      why: ['', 'That is what N / 2 · log₂ N suggests, but it counts wires as multiplications.', 'That is one per output, and the count goes by twiddle.', 'Only the last column has any non-trivial twiddle, and those are constant multipliers.'],
    },
    {
      question: 'Why does a streaming FFT cost less than the unrolled network of the same size?',
      options: ['A few units take turns at all the butterflies, in exchange for memory', 'It computes fewer butterflies per block, by skipping those with small twiddles', 'It works at a lower word length, since its samples arrive one at a time', 'It leaves out the bit reversal, which is most of the network\'s wiring'],
      answer: 0,
      explain: 'Every butterfly of the network still happens, one at a time. The price is N − 1 samples of memory, latency, and one sample a clock in place of N.',
      why: ['', 'The arithmetic per block is the same.', 'Both can be built at any word length, and the comparison here is at the same one.', 'Its tones still leave in bit-reversed order, and wiring costs no gates anyway.'],
    },
  ],
  waterfill: [
    {
      question: 'Two tones have gains over noise of 1 and 2, the budget is 3 and Γ = 1. What does water-filling give them?',
      options: ['1.25 and 1.75', '1 and 2', '1.5 and 1.5', '0 and 3'],
      answer: 0,
      explain: 'The floors are 1 and ½, and μ − 1 + μ − ½ = 3 gives μ = 2.25. The better tone gets more, but not in proportion, and neither stays dry.',
      why: ['', 'Power in proportion to gain overfeeds the better tone, whose curve has flattened.', 'That is the flat plan: close, as flat usually is when power is plentiful, but below.', 'The other tone\'s floor of 1 is below the level, so its first watt beats the good tone\'s last.'],
    },
    {
      question: 'Water-filling leaves a tone dry. What does that say about the tone?',
      options: ['A first watt there would earn less than on the tones in use', 'The line has failed at that frequency and the tone can carry nothing', 'It already carries as many bits as its constellation can', 'Its gain over noise has fallen below 1, the cut-off for any tone'],
      answer: 0,
      explain: 'At the optimum all tones in use have the same marginal rate, 1 / μ. A floor above the water means that even a first watt earns less, and a larger budget can raise the level over it.',
      why: ['', 'It may be a perfectly good tone that the budget does not stretch to.', 'A tone carrying many bits has a low floor, and so plenty of water.', 'The value of the gain only matters against the level.'],
    },
  ],
  ldpc: [
    {
      question: 'A bit\'s message to a check leaves out what that check told it. What goes wrong if it does not?',
      options: ['The check hears its own opinion back as independent evidence', 'The beliefs grow larger, but their signs and the decisions stay the same', 'It needs more memory for the messages, but reaches the same answer', 'The check\'s parity equation no longer holds for the decoded word'],
      answer: 0,
      explain: 'Each message is meant to be new evidence for its receiver. Echoing counts it twice, and an error then reinforces itself.',
      why: ['', 'Large beliefs that are wrong are the failure: they stop the decoder changing its mind.', 'It changes the answer, not only the storage.', 'Parity is computed over the hard decisions at the end, not over messages.'],
    },
    {
      question: 'What does a density-evolution threshold of 0.4294 promise for a (3, 6) code on the erasure channel?',
      options: ['Below it typical long codes decode nearly everything; above it length does not help', 'Every code with these degrees corrects exactly this share of erasures', 'A word of any length, even a short one, corrects erasures up to this share', 'It is the capacity of the erasure channel at this code\'s rate of one half'],
      answer: 0,
      explain: 'It belongs to the ensemble and the decoder, in the limit of long blocks. Capacity at rate ½ on this channel is 0.5, higher than this.',
      why: ['', 'A particular unlucky code may do worse: the claim is about typical ones.', 'Short words stall below it, since their graphs have short cycles.', 'Capacity at rate ½ is 0.5: the threshold falls short of it.'],
    },
  ],
  littleslaw: [
    {
      question: 'A link at 80 % load has random arrivals and exponentially distributed packet sizes. What is the mean wait, and what load would halve it?',
      options: ['4 packet times; two thirds', '4 packet times; 40 %', '0.8 packet times; 40 %', '5 packet times; 70 %'],
      answer: 0,
      explain: 'ρ / (1 − ρ) at 0.8 is 4, and solving for 2 gives ρ = 2 / 3. Halving the traffic overshoots a long way, to a wait of two thirds of a packet.',
      why: ['', 'Halving the load gives a wait of 0.67, not 2.', 'That is ρ itself, not ρ / (1 − ρ).', '1 / (1 − ρ) is 5, which counts the packet\'s own service too.'],
    },
    {
      question: 'A queue averages 12 packets at 1000 packets a second, with no assumption about arrivals. How long does a packet spend inside?',
      options: ['12 ms', '1.2 ms', '83 ms', 'It cannot be known without the arrival pattern'],
      answer: 0,
      explain: 'Little\'s law, L = λ W, holds for any queue: W = 12 / 1000 s.',
      why: ['', 'That is one tenth of what L / λ gives.', 'That is λ / L, the wrong way up.', 'Needing no such assumption is exactly what makes the law useful.'],
    },
  ],
  cubic: [
    {
      question: 'What changes between Reno and CUBIC in how the window grows?',
      options: ['A curve in real time, flat near the last maximum, in place of a packet a round trip', 'It grows on the marks a router sets and not on ACKs, so it sees a queue early', 'It never falls after a loss, and only stops growing until the queue has drained', 'It sends at a measured delivery rate and has no window left to grow at all'],
      answer: 0,
      explain: 'W(t) = C (t − K)³ + W_max is a function of time since the last cut, so a long round trip no longer slows the climb.',
      why: ['', 'Both grow on ACKs, and both can read marks.', 'It falls by 30 %, a smaller cut than Reno\'s half.', 'That is BBR. CUBIC still reads loss.'],
    },
    {
      question: 'Does CUBIC fix bufferbloat on a large tail-drop buffer?',
      options: ['No: it reads only loss, so it still fills the buffer', 'Yes: its curve flattens before the buffer fills', 'Yes: it falls by less than Reno does', 'No: it has no increase once it has lost'],
      answer: 0,
      explain: 'A loss is its only signal, and a tail-drop queue loses nothing until it is full. In the model it adds half a second on a 1000-packet buffer.',
      why: ['', 'It flattens near where it last lost, and that was when the buffer was full.', 'A smaller cut keeps the queue fuller, if anything.', 'It climbs again after every loss, and probes past the old maximum.'],
    },
  ],
  aqm: [
    {
      question: 'Why does CoDel measure how long a packet waited and not how long the queue is?',
      options: ['A wait means the same at any link rate, and a length does not', 'It needs no memory for packets when it works that way', 'It then never has to drop a packet at all', 'It makes the link itself carry more per second'],
      answer: 0,
      explain: 'A wait is what the application experiences. 50 packets is 60 ms at one rate and 6 ms at ten times it, and radio links change rate all the time.',
      why: ['', 'It still needs a buffer: it only keeps it from staying full.', 'It drops, or marks, as soon as a standing queue lasts an interval.', 'It changes the delay, and costs a little of the rate.'],
    },
    {
      question: 'Waits have stayed above CoDel\'s target for a whole interval, and it starts dropping. When does the second drop come?',
      options: ['100 ms after the first', '100 / √2 ms after the first', '5 ms after the first', 'At the next packet'],
      answer: 0,
      explain: 'The count starts at 1, so the next drop is interval / √1 later. Then 100 / √2, then 100 / √3, until the wait comes down.',
      why: ['', 'That spacing is the third drop\'s.', '5 ms is the target wait, and not a spacing.', 'That would be far too hard on a sender that has not had a round trip to react.'],
    },
  ],
  fairqueue: [
    {
      question: 'Under fair queueing one flow sends as fast as it can and ignores every drop. What happens to the others?',
      options: ['Almost nothing: it can only fill its own queue', 'They starve, since it fills the buffer', 'The link\'s rate falls for everyone', 'It is disconnected by the router'],
      answer: 0,
      explain: 'Serving flows in turn caps each at its share. When the buffer is full the drop comes from the longest queue, which is the greedy flow\'s.',
      why: ['', 'That is what happens with one shared queue.', 'The link\'s rate is the link\'s. Only the shares change.', 'Nothing in a queue discipline disconnects anybody.'],
    },
    {
      question: 'Where does a fair queue have to run to do any good?',
      options: ['At the link that really is the bottleneck', 'At every router on the path', 'At the sender only', 'At the receiver only'],
      answer: 0,
      explain: 'A queue only forms at the bottleneck, so that is the only place with anything to schedule. That is why a home router matters more than the core.',
      why: ['', 'One is enough, and the rest have no queue to manage.', 'A sender has no view of the other flows.', 'By then the delay has already happened.'],
    },
  ],
  ecn: [
    {
      question: 'A router marks a packet Congestion Experienced. Who slows down, and how do they find out?',
      options: ['The sender, from the receiver\'s echo in its ACKs', 'The router, which lowers its link rate until the queue drains', 'The receiver, which delays its ACKs and so holds the sender back', 'Nobody: a mark only counts once a packet is also lost'],
      answer: 0,
      explain: 'The window is the sender\'s, so the signal has to reach the sender, and the way back is the ACK. It takes a round trip, as a loss would, but loses no data.',
      why: ['', 'A router keeps sending as fast as it can. It only signals.', 'The receiver only reports. It does not choose the window.', 'Saving that loss is the purpose of the mark.'],
    },
    {
      question: 'What does ECN save compared with a drop at the same moment?',
      options: ['The data: nothing has to be sent again', 'The round trip the signal needs to reach the sender', 'The window cut: the sender keeps its rate', 'The buffer: the router can do without one'],
      answer: 0,
      explain: 'The cut and the delay of the signal are the same. In the model CoDel with marks loses no packets, at the same throughput.',
      why: ['', 'A mark still has to go to the receiver and back.', 'The sender cuts just as it would for a loss.', 'The queue still needs its buffer. The discipline is what changed.'],
    },
  ],
  bbr: [
    {
      question: 'Why does BBR send above its rate estimate for one round trip in eight?',
      options: ['A faster bottleneck cannot show in delivery rates otherwise', 'To make its RTT estimate smaller', 'To fill the buffer and lower the delay', 'To cause a loss and find the limit'],
      answer: 0,
      explain: 'The estimate is the largest delivery rate seen, and delivery can never exceed what was sent. The 0.75 phase after it removes any queue the probe made.',
      why: ['', 'Sending faster can only raise the RTT. That estimate is refreshed in the low-window phase.', 'A fuller buffer raises the delay.', 'This version of BBR does not read loss at all.'],
    },
    {
      question: 'On a shallow tail-drop buffer BBR can take most of the link from CUBIC. What is the mechanism?',
      options: ['Only CUBIC reacts to the drops, so BBR\'s rate grows into the room', 'The queue serves BBR\'s paced packets ahead of CUBIC\'s bursts', 'CUBIC\'s packets are larger, so it loses more bytes at each drop', 'BBR\'s probes mark CUBIC\'s packets as they pass them in the queue'],
      answer: 0,
      explain: 'The queue favours nobody. One sender treats a drop as an instruction and the other does not. A queue per flow removes the argument.',
      why: ['', 'Nothing on the link tells the two apart: a tail-drop queue has no priorities.', 'Both send the same size of packet in the model.', 'A sender cannot mark another\'s packets, and marks are for routers.'],
    },
  ],
  fattree: [
    {
      question: 'How many hosts does a fat tree of 48-port switches serve?',
      options: ['27 648', '2304', '110 592', '576'],
      answer: 0,
      explain: 'k³ / 4 at k = 48. It takes 5k² / 4 = 2880 switches, and there are (k / 2)² = 576 paths between two pods.',
      why: ['', 'That is k², with no factor for the pods.', 'That is k³, forgetting the quarter.', 'That is the number of paths between two pods.'],
    },
    {
      question: 'A circuit network needs m ≥ 2n − 1 middle switches never to block. Why can a packet fabric use m = n?',
      options: ['No path is held: packets share them, if traffic spreads evenly', 'Packets are much smaller than telephone calls', 'Ethernet links are faster than telephone lines', 'A fabric is never run above half of its load'],
      answer: 0,
      explain: 'A circuit must find one free path and keep it, which makes blocking a matter of combinatorics. Packets share every path, so a poor spread shows up as queues, not as a refused call.',
      why: ['', 'Size does not change the count of paths.', 'Faster links would help a circuit network alike.', 'Some run that light, but the argument does not depend on it.'],
    },
  ],
  ecmp: [
    {
      question: 'With 32 flows on 32 equal paths under ECMP, about what share of the fabric is used?',
      options: ['64 %', '100 %', '50 %', '3 %'],
      answer: 0,
      explain: 'A path is idle with chance (1 − 1 / 32)³². A hash does not look at load, so some paths get two or more flows while others get none.',
      why: ['', 'It would take a scheduler to give each flow its own path.', 'That is lower than balls in bins gives.', 'That would be one path in thirty-two.'],
    },
    {
      question: 'Why does ECMP send all of a flow\'s packets along one path?',
      options: ['Over different paths they would reorder, and TCP reads that as loss', 'Switches can hold only one route per flow', 'It saves bits in the packet\'s header', 'It would otherwise overload the slowest of the paths'],
      answer: 0,
      explain: 'Paths have equal capacity but not equal queues, so packets overtake each other, and three out-of-order arrivals make a sender halve for nothing.',
      why: ['', 'A hash holds no per-flow route at all: it is recomputed from the header each time.', 'It adds nothing to the header either way.', 'ECMP assumes equal cost, and in a fat tree the paths are equal.'],
    },
  ],
  incast: [
    {
      question: 'Why does a loss at the end of a burst cost so much more than one in the middle?',
      options: ['No later packet raises duplicate ACKs, so only the timer is left', 'Later packets matter more to the application than early ones', 'The switch always drops the retransmission of that packet too', 'The receiver gives up on the flow when its end goes missing'],
      answer: 0,
      explain: 'A fast retransmit needs three packets behind the gap. Without them the only clue is a timer set for a far longer path than this one.',
      why: ['', 'All the bytes matter equally: the read waits for all of them.', 'A retransmission meets an empty port by then. It is the waiting that takes the time.', 'It is still waiting, and receives it when it comes.'],
    },
    {
      question: 'Why does a stock 200 ms timer hurt here more than it hurts a web user?',
      options: ['The round trip is 100 µs, so it is thousands of round trips of idle link', 'More bytes are lost at data-centre rates, so the repair takes longer', 'The web has no such timers to wait for', 'Web pages cannot tolerate any delay at all'],
      answer: 0,
      explain: 'On the internet a 200 ms timer is a few round trips. Here it is thousands, spent idle with data waiting, and the whole read waits for it.',
      why: ['', 'The repair is one burst on a fast idle link. The time goes in the wait before it.', 'It has the same timers, on far longer round trips.', 'A web user waits far longer than this without noticing.'],
    },
  ],
  dctcp: [
    {
      question: '10 % of a DCTCP flow\'s packets are marked and α has settled at 0.1. By how much does its window fall?',
      options: ['5 %', '50 %', '10 %', 'Not until a packet is lost'],
      answer: 0,
      explain: 'W (1 − α / 2). The mark that halves a Reno flow takes off 5 % here, so the queue moves a little around K and not all the way to empty.',
      why: ['', 'That is classic ECN\'s rule, which this replaces.', 'It is α / 2, so that α = 1 gives exactly the older halving.', 'It reacts to marks: that is its purpose.'],
    },
    {
      question: 'Why does DCTCP stay inside one data centre?',
      options: ['Against Reno on a mark it is far too aggressive', 'Its α only converges at data-centre round trips', 'It cannot cross a router', 'It uses a private header'],
      answer: 0,
      explain: 'A small cut where Reno halves takes a share Reno cannot hold. One operator can move every sender and switch together. L4S tries to solve that for the internet.',
      why: ['', 'α is a running share marked, at any round trip.', 'It runs over ordinary IP routers that mark.', 'It uses the same two ECN bits.'],
    },
  ],
  rdma: [
    {
      question: 'A loss costs go-back-N a pipe\'s worth. The link goes from 100 to 400 Gb/s with the same round trip. What must the loss rate do to keep the goodput?',
      options: ['Fall by a factor of 4', 'Nothing', 'Fall by a factor of 16', 'It may rise'],
      answer: 0,
      explain: 'W is rate times delay, and for small p goodput is about 1 / (1 + W p), so the product is what counts.',
      why: ['', 'Goodput depends on the rate through the size of the pipe.', 'W p appears, not W² p. Reno\'s window goes as 1 / √p, which is a different rule.', 'Less time per packet means more of them in flight.'],
    },
    {
      question: 'What does RDMA take out of the path of a message?',
      options: ['The system call, the copy and the interrupt', 'The network\'s switches on the way', 'The retransmission of lost packets', 'The IP header, on RoCEv2'],
      answer: 0,
      explain: 'The application posts directly to the NIC, and the far NIC writes memory itself, so neither core does the transport\'s work.',
      why: ['', 'The packets still cross the same fabric.', 'It still repairs loss, in the NIC, and that repair is what makes loss so costly.', 'RoCEv2 runs over ordinary UDP and IP.'],
    },
  ],
  pfc: [
    {
      question: 'A port runs at 100 Gb/s over 100 m, about 500 ns one way. About how much headroom above XOFF does the formula ask for, in 1 KB packets?',
      options: ['About 15', 'About 1', 'About 1000', 'None'],
      answer: 0,
      explain: 'A pause takes a delay to arrive and what was sent takes a delay to land: 100 Gb/s × 1 µs = 12.5 KB, about 12.5 packets, plus those underway at each end.',
      why: ['', 'A pause has a propagation delay like everything else on the wire.', 'That would be a fabric-wide figure, and PFC acts on one link.', 'The buffer is what makes losslessness possible.'],
    },
    {
      question: 'Why can a fat tree with strict up-down routing not have a PFC deadlock?',
      options: ['Every wait goes forward in one order of links, so no loop can close', 'Fat trees have more buffer in each switch than a ring does', 'With many paths on offer, one of them is always free', 'Up-down routing drops packets whenever it has to'],
      answer: 0,
      explain: 'Order the links by height, ups before downs. A packet only climbs and then only falls, so the dependencies form no cycle, the same argument as ordering locks.',
      why: ['', 'Buffer delays a deadlock and does not remove the possibility.', 'A flow hashes to one path, and a paused class stops whatever is queued.', 'It stays lossless. It simply never makes a cycle.'],
    },
  ],
  tailscale: [
    {
      question: 'A service waits for 50 servers and wants 99 % of requests free of a slow reply. About how rare must a slow reply be on each?',
      options: ['1 in 5000', '1 in 100', '1 in 50', '1 in 2500'],
      answer: 0,
      explain: 'For small q the share slow is about 50 q, so q = 0.01 / 50 = 0.0002.',
      why: ['', 'That would make 39 % of requests slow.', 'That would make 64 % of requests slow.', 'That would make about 2 % slow, twice the target.'],
    },
    {
      question: 'Which way of re-sending a request cuts the tail for only a few percent more load?',
      options: ['To a second replica, once the first is already late', 'To two replicas, every time', 'To the same server, at once', 'To every replica, as soon as the first is late'],
      answer: 0,
      explain: 'Waiting until about the 95th percentile means only the slowest few requests are sent twice. The first answer is kept.',
      why: ['', 'That doubles the load.', 'The same server is the one being slow.', 'That is far more load than one extra copy, which does nearly as well.'],
    },
  ],
};
