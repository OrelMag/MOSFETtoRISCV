// Queues and congestion (level Communication): why a fast network feels slow, and what senders and queues do about it. All of it runs on comm/queues.ts, a labelled model of one bottleneck, a packet at a time, with senders
// and disciplines by their published rules; tests/comm-queues.test.ts holds it to queueing theory, the sawtooth, Mathis, RFC 9438's average, and CoDel's and RED's own laws. Numbers here are runs of the model, or those closed forms.

import { cubicK, md1Wait, mm1Quantile, mm1Wait, renoUtilization, renoWindow, type SimResult } from '../comm/queues';
import { chiuWidget, delayWidget, duelRun, duelWidget, labRun, labWidget, lossWidget, type LabPreset } from '../widgets/queues';
import { groupDigits } from '../sim/numfmt';
import { numOf } from './order';
import type { Chapter, Step } from './types';

const nf = (x: number, d = 0) => x.toFixed(d);
const n0 = (x: number) => groupDigits(Math.round(x));
/** 4.6 × 10<sup>7</sup> from a number. */
const sci = (x: number, d = 1) => { const [m, e] = x.toExponential(d).split('e+'); return `${m} × 10<sup>${e}</sup>`; };
const FULL = 1000;

const memoRuns = new Map<string, SimResult>();
const lab = (p: LabPreset, seconds = 60): SimResult => {
  const k = JSON.stringify([p, seconds]);
  let r = memoRuns.get(k);
  if (!r) memoRuns.set(k, (r = labRun(p, seconds)));
  return r;
};
const one = (cc: 'reno' | 'cubic' | 'bbr', aqm: LabPreset['aqm'], ecn = false): LabPreset => ({ aqm, buffer: FULL, rtt: 50, flows: [{ cc, rttMs: 50, ecn }] });

const steps: Step[] = [
  {
    title: 'Delay from load alone',
    get body() {
      const pkt100 = ((1500 * 8) / 100e6) * 1000;
      return `
      <p>Chapter ${numOf('tcp')} ended on the queue its sawtooth fills. This chapter is about that queue and what to do with it, and it starts before the queue is full: a queue is already a matter of probability.</p>
      <p>Packets arrive at random, and the link sends one at a time, so sometimes they meet. With arrivals at a rate that loads the link to ρ, an exponential packet time gives a mean wait of <strong>ρ / (1 − ρ)</strong> packets; a fixed one half of that. At 50 % load one packet's time of waiting, at 90 % nine, at 99 % ninety-nine: the curve has no knee to speak of until you are on it. The general form, Pollaczek-Khinchine, has (1 + c²) / 2 in front, c being the spread of packet sizes, so variation costs delay as surely as load does.</p>
      <p><strong>Little's law</strong> ties it together, for any queue at all: the mean number inside is the arrival rate times the mean time inside. And the tail is worse than the mean. At 90 %, one packet in 100 waits ${nf(mm1Quantile(0.9, 0.01), 0)} packet times, against the mean's ${nf(mm1Wait(0.9), 0)}. On 100 Mb/s a packet is ${nf(pkt100, 2)} ms, so all this is small. On a 1 Mb/s upload it would be a hundred times as much. Operators keep links well below full for this reason: idle time cannot be saved up, so a link that averages half-full can still show a ping you notice.</p>
      <div class="try">Slide the load from 0.5 to 0.95, and watch the dots follow the curve. Then find the load where the wait at 10 Mb/s first passes 10 ms.</div>`;
    },
    widget: delayWidget,
    challenge: {
      kind: 'quiz',
      question: 'A link at load 0.5 has a mean wait of one packet time. Traffic rises by 80 %, to load 0.9. What happens to the wait, for random packet sizes?',
      options: [`It rises ninefold, to ${nf(mm1Wait(0.9), 0)} packet times: ρ / (1 − ρ) is not a straight line`, 'It rises by 80 %, in step with the traffic', 'It does not change, since the link is still below capacity', 'It halves, since the link is busier'],
      answer: 0,
      explain: `Most of the rise comes from the (1 − ρ) below the line. With fixed packet sizes it would still be ${nf(md1Wait(0.9), 1)} against ${nf(md1Wait(0.5), 1)}.`,
      why: ['', 'The wait is not in proportion to the load. Its denominator is the idle share, which fell fivefold.', 'A link below capacity still queues, because arrivals are random.', 'A busier server means more packets ahead of yours.'],
    },
  },
  {
    title: 'Bufferbloat, measured',
    get body() {
      const t = lab(one('cubic', 'tail')), s = lab({ aqm: 'tail', buffer: 90, rtt: 50, flows: [{ cc: 'cubic', rttMs: 50 }] });
      return `
      <p><a href="#/c/tcp/6">The TCP chapter</a> left a queue that a window could fill, with a first look at what that does. Now a real window of megabytes. This is a labelled model: one 20 Mb/s link, 50 ms of round trip, senders by their published rules, and every 20 ms a small packet like a video call's, measuring what it waits. Reno (chapter ${numOf('tcp')}'s sawtooth) or CUBIC (step 4) keep raising the window until something is lost, and a tail-drop queue loses nothing until it is full, so the sender's only signal of a full queue is the queue being full. With a buffer of ${FULL} packets the link is busy ${nf(100 * t.utilization, 0)} % of the time, carrying ${nf(t.goodputMbps[0], 1)} Mb/s of new data, and <strong>every packet waits ${n0(t.pingMeanMs)} ms</strong>. With 90 packets, about one bandwidth-delay product, the link is busy ${nf(100 * s.utilization, 0)} % of the time, carrying ${nf(s.goodputMbps[0], 1)} Mb/s, and it waits ${n0(s.pingMeanMs)} ms. The extra buffer bought no throughput at all.</p>
      <p>Jim Gettys named this at the end of 2010, and he and Nichols wrote it up in 2011: buffers sized for the fastest link a device might see, or for benchmarks that counted only throughput, sat in front of the slowest. A queue that is always full has the worst of it: no room for a burst, and a delay on every flow sharing it. The window the sender chooses and the buffer the router chooses meet at this link, and nobody is in charge. The rest of this chapter is the ways out: change what the sender listens for, change what the queue does, or both.</p>
      <div class="try">Bring the buffer down from ${FULL} to 90 packets, watching the throughput chip. Then try 20. What did it cost?</div>`;
    },
    widget: () => labWidget(one('cubic', 'tail')),
    challenge: {
      kind: 'quiz',
      question: 'Why does a sender with a tail-drop queue end up keeping that queue full?',
      options: ['A loss is its only signal, and a tail-drop queue loses nothing until it is full, so the sender raises its window until it is', 'It wants the lowest delay, and a full queue is the steadiest', 'It sends at the link\'s rate, which fills any queue instantly', 'The queue holds packets back on purpose'],
      answer: 0,
      explain: 'Loss-based senders probe for bandwidth by raising the window until something is lost. The buffer delays that signal by its own length, and that delay is the bloat.',
      why: ['', 'It has no idea what the delay is, for this rule only reads loss.', 'At the link\'s rate exactly, a queue would stay where it was. It fills because the window keeps growing.', 'A tail-drop queue has no policy beyond its size.'],
    },
  },
  {
    title: 'Why halve',
    get body() {
      return `
      <p>Why does TCP add one and halve, and not some simpler rule? Chiu and Jain's 1989 answer, which chapter ${numOf('tcp')}'s quiz gave in a sentence, fits on a plane: put one sender's rate on each axis, and draw two lines, one where the rates add up to the link, one where they are equal. A good rule gets to where those cross and stays near it, from any start, with neither sender told about the other.</p>
      <p>Adding the same amount to both moves along a 45° line and keeps the difference. Multiplying both moves along a line through the origin and keeps the ratio. So adding and subtracting never changes the gap, and multiplying both ways never changes the ratio: each keeps whoever got there first in front. Only <strong>additive increase, multiplicative decrease</strong> combines one that holds the gap with one that shrinks it, so each cycle lands nearer the fair line. It is the reason a new flow can join a busy link with no negotiation. It needs a shared signal and a shared round trip, which real flows only roughly have: over the same bottleneck, a flow with a quarter of the round trip raises its window four times as often, and takes more than its share.</p>
      <p>Everything since has kept that shape while changing the curves. What the rule gives up is speed: one packet a round trip is slow when the pipe is large.</p>
      <div class="try">Start sender 1 at 70 and sender 2 at 5, with each rule in turn, and read the fairness chip.</div>`;
    },
    widget: chiuWidget,
    challenge: {
      kind: 'quiz',
      question: 'Two flows have a gap of 40 between their rates, and both halve at the same moment. What is the gap afterwards, and why does it not matter that they then add one each?',
      options: ['20: halving halves the gap and adding keeps it, so each cycle shrinks it', '40: both change by the same amount', '0: they are now in step', '80: the larger flow loses less'],
      answer: 0,
      explain: 'A gap x − y under x / 2 and y / 2 is half as big. Under x + 1 and y + 1 it does not change at all. So the gap can only fall, cycle by cycle.',
      why: ['', 'The larger flow gives up more in a halving, so the amounts differ.', 'Halving leaves half of the difference, not none.', 'The larger flow gives up more, not less.'],
    },
  },
  {
    title: 'A window from a formula',
    get body() {
      const p = 1e-4, pipe = (1e9 * 0.1) / (1500 * 8), bdp = (20e6 * 0.05) / (1500 * 8);
      return `
      <p>Reno's sawtooth is simple enough to solve. The window climbs from W / 2 to W at one packet a round trip, then halves. That sends 3W² / 8 packets a cycle, for one loss, so at loss rate p the window averages <strong>√(3 / 2p)</strong>, or at one loss in 10 000 about ${n0(renoWindow(p))} packets, whatever the link can do. That is Mathis's formula, throughput = 1.22 · MSS / (RTT √p), and the model reproduces it. With a queue of B behind a pipe of P, the same shape gives the link's use: all of it for B ≥ P, and ${nf(100 * renoUtilization(100, 0), 0)} % for B = 0. It is where "one BDP of buffer" comes from, and at ${nf(bdp, 0)} packets on the lab's link it is also why ${FULL} was far too many.</p>
      <p>Now run the same arithmetic on a long fat pipe, 1 Gb/s across 100 ms: ${n0(pipe)} packets. After one loss, Reno needs ${n0(pipe / 2)} round trips to climb back, ${nf((pipe / 2) * 0.1 / 60, 0)} minutes, and it can only fill the pipe if losses are rarer than one in ${sci(pipe * pipe / 1.5)} packets. Real paths lose far more than that, to congestion if not to bit errors. <strong>CUBIC</strong> (RFC 9438), the default in Linux since 2006, keeps the increase but changes its curve: W(t) = C (t − K)³ + W<sub>max</sub>, in real time and not in round trips. It falls by 30 %, climbs fast, flattens as it nears the window where it last lost, waits there, then probes beyond. K, the time to return, is the cube root of W<sub>max</sub>(1 − β) / C: ${nf(cubicK(pipe), 1)} s for that pipe, against Reno's minutes. Where a short RTT or a small window would make it slower than Reno, a Reno-friendly region takes over, so it does no harm there.</p>
      <div class="try">Read off the window each sender holds at one loss in 10⁵. Then raise the RTT and see which line moves.</div>`;
    },
    widget: lossWidget,
    challenge: {
      kind: 'quiz',
      question: 'Mathis\'s formula says a Reno flow\'s throughput falls with RTT and with √p. Two flows share a link and see the same loss rate, with RTTs of 20 ms and 80 ms. About what ratio of throughput does it predict?',
      options: ['4 to 1, in favour of the 20 ms flow', '2 to 1, since RTT enters under the root', '1 to 1, since they share a link and a loss rate', '16 to 1, in favour of the 80 ms flow'],
      answer: 0,
      explain: 'Throughput is proportional to 1 / RTT at the same p. This is why Reno is said to be RTT-unfair; in a real queue the flows\' loss rates can differ too.',
      why: ['', 'Only p is under the root. RTT is not.', 'A shared loss rate does not mean a shared throughput: the shorter loop reacts more often.', 'A longer RTT raises the window less often. It does not help.'],
    },
  },
  {
    title: 'Drop before it is full',
    get body() {
      const t = lab(one('cubic', 'tail')), r = lab(one('cubic', 'red')), c = lab(one('cubic', 'codel'));
      return `
      <p>If a loss is the signal, the queue can send it sooner. <strong>RED</strong> (Floyd and Jacobson, 1993) drops at random, with a chance that rises in a line as the averaged queue length rises between two thresholds. In the model, on the same ${FULL}-packet buffer, CUBIC's delay falls from ${n0(t.pingMeanMs)} ms to ${n0(r.pingMeanMs)} ms with the link still ${nf(100 * r.utilization, 0)} % used. But RED's numbers have to fit the link and the load, a queue length means different things at different rates, and in practice it was widely left switched off.</p>
      <p><strong>CoDel</strong> (Nichols and Jacobson, 2012; RFC 8289) measures the right thing: not how long the queue is but how long this packet waited. A short burst is good, a queue that never empties is bad, and the way to tell them apart is that a good queue touches zero. So CoDel starts dropping if every packet's wait has stayed above a <em>target</em> of 5 ms for a whole <em>interval</em> of 100 ms. Then it drops one, the next after 100 ms, then after 100 / √2, then 100 / √3: gently harder until the wait comes down. The square root comes from the same 1 / √p as Mathis's formula. There is nothing to tune: ${n0(c.pingMeanMs)} ms in the model, on the same buffer, at ${nf(100 * c.utilization, 0)} % use. It costs some throughput, since the window now falls below the pipe, and it costs a few drops: ${c.drops} in the run, against ${t.drops} in the tail-drop one.</p>
      <div class="try">Set the queue to CoDel, and raise the buffer as far as it goes: nothing changes, because the buffer is no longer the limit. Then try BBR with it.</div>`;
    },
    widget: () => labWidget(one('cubic', 'codel')),
    challenge: {
      kind: 'quiz',
      question: 'CoDel measures how long a packet waited, and not how long the queue is. What does that buy, on a link whose rate changes?',
      options: ['The same target works at any rate: 5 ms of waiting means the same to a user, where a queue of 50 packets means 60 ms at one rate and 6 ms at ten times it', 'It needs no memory for packets', 'It never drops a packet', 'It makes the link faster'],
      answer: 0,
      explain: 'A wait is what the application experiences. A length has to be divided by the rate to mean anything, and Wi-Fi\'s and cellular links change rate all the time.',
      why: ['', 'It still needs a buffer: it only keeps it from staying full.', 'It drops, or marks, as soon as the standing queue lasts an interval.', 'It changes the delay, not the rate. It costs a little of the rate, in fact.'],
    },
  },
  {
    title: 'A queue per flow',
    get body() {
      const f: LabPreset = { aqm: 'fq', buffer: FULL, rtt: 50, flows: [{ cc: 'cubic', rttMs: 50 }, { cc: 'reno', rttMs: 20 }, { cc: 'cubic', rttMs: 200 }] }, r = lab(f), t = lab({ ...f, aqm: 'tail' });
      return `
      <p>A shared FIFO has one more flaw that no discipline for one queue can mend: a sparse flow still waits behind everybody's bulk. <strong>Fair queueing</strong> gives each flow its own queue and serves them in turn. One packet of a voice call then waits for at most one packet from each other flow, whatever those flows are doing (real fq_codel does better still, serving a sparse flow first; the model's is plain round robin). And each sender's own CoDel only punishes that sender. FQ-CoDel (RFC 8290), the default on many Linux systems and in many home routers, is the two together. A router can do it because it only has to hash a flow's addresses and ports to a queue, and it keeps no per-connection state beyond that.</p>
      <p>Three senders here: CUBIC at 50 ms, Reno at 20 ms and CUBIC at 200 ms. Under tail drop they get ${r && t ? t.goodputMbps.map((g) => nf(g, 1)).join(', ') : ''} Mb/s, fairness ${nf(t.jain, 2)} (Jain's index: 1 is equal shares), and the sparse packet waits ${n0(t.pingMeanMs)} ms. Under FQ-CoDel they get ${r.goodputMbps.map((g) => nf(g, 1)).join(', ')} Mb/s, fairness ${nf(r.jain, 2)}, and it waits ${nf(r.pingMeanMs, 1)} ms. Tail drop's shares follow the rules and not the RTTs, since a bloated queue swamps every flow's RTT and leaves Reno's slower climb behind CUBIC's. Under FQ the senders' rules, RTTs and greed no longer decide shares: the queue does. That is a big shift of power, from the end points to the bottleneck, and it works only at the one router that actually is the bottleneck, which is why the home router matters more than anything in the core.</p>
      <div class="try">Pick Three Reno, then switch the queue between tail drop and FQ-CoDel. Then pick BBR and CUBIC at a small buffer with each: a later step comes back to this.</div>`;
    },
    widget: () => labWidget({ aqm: 'fq', buffer: FULL, rtt: 50, flows: [{ cc: 'reno', rttMs: 50 }, { cc: 'reno', rttMs: 50 }, { cc: 'reno', rttMs: 50 }] }),
    challenge: {
      kind: 'quiz',
      question: 'Under fair queueing, one flow sends as fast as it possibly can, and ignores every drop. What happens to the others?',
      options: ['Almost nothing: it can only fill its own queue, and the turns stay equal', 'They starve, since it fills the buffer', 'The link\'s rate falls for everyone', 'It is disconnected'],
      answer: 0,
      explain: 'Serving flows in turn caps each at its share. When the buffer is full the drop comes from the longest queue, which is the greedy flow\'s. Under tail drop the same flow would crowd out the rest.',
      why: ['', 'That is what happens with one shared queue. Here, when full, the longest queue is the one dropped from.', 'The link\'s rate is the link\'s. Only the shares change.', 'Nothing in a queue discipline disconnects anybody.'],
    },
  },
  {
    title: 'A mark in place of a drop',
    get body() {
      const a = lab(one('cubic', 'codel')), b = lab(one('cubic', 'codel', true));
      return `
      <p>A drop is an expensive way to say "slow down": the data has to be sent again, and the application waits a round trip for it. <strong>ECN</strong> (RFC 3168) uses two bits in the IP header. A sender that supports it sets them to say so, a congested router changes them to <em>Congestion Experienced</em> instead of dropping, the receiver echoes that in its ACKs, and the sender cuts its window as if a packet had been lost, once per round trip. No data is lost and there is nothing to send again.</p>
      <p>On the lab's link: CoDel with drops, ${a.drops} packets lost; with marks, ${b.drops} lost and ${b.marks} marked, for the same throughput (${nf(a.goodputMbps[0], 1)} against ${nf(b.goodputMbps[0], 1)} Mb/s). For a bulk transfer that is a small saving. For something like an interactive session, whose lost packet might be its last in a burst and take a whole timeout to discover, it is large.</p>
      <p>The chance to do better comes from saying more with the signal. Classic ECN means "halve", so routers mark rarely. In a data centre, or under L4S (RFC 9330), a router marks early and often, and the sender reduces in proportion to the share marked, so the queue stays near zero. It takes every router and both ends, one reason it has spread so slowly since its RFC of 2001, and chapter ${numOf('datacentre')} meets the data-centre case.</p>
      <div class="try">With CoDel, tick ECN and watch the count of drops become a count of marks while the rest stays the same. Then set the queue to tail drop: tail drop has nothing to mark with, since it only acts when full.</div>`;
    },
    widget: () => labWidget(one('cubic', 'codel', true)),
    challenge: {
      kind: 'quiz',
      question: 'A router marks a packet with Congestion Experienced. Who slows down, and how do they find out?',
      options: ['The sender: the receiver sees the mark and echoes it in its ACKs, a round trip\'s worth of delay later', 'The router: it lowers its own link rate', 'The receiver: it delays its ACKs', 'Nobody until a packet is lost'],
      answer: 0,
      explain: 'The window is the sender\'s, so the signal has to reach the sender, and the way back is the ACK. It still takes a round trip, as a loss would, but without losing data.',
      why: ['', 'A router keeps sending as fast as it can. It only signals.', 'The receiver only reports. It does not choose the window.', 'Saving that loss is the purpose of the mark.'],
    },
  },
  {
    title: 'BBR: measure the pipe',
    get body() {
      const b = lab(one('bbr', 'tail')), c = lab(one('cubic', 'tail')), L: LabPreset = { aqm: 'tail', buffer: 500, rtt: 100, flows: [{ cc: 'bbr', rttMs: 100 }], lossP: 0.01 }, bl = lab(L, 40), rl = lab({ ...L, flows: [{ cc: 'reno', rttMs: 100 }] }, 40), m = (renoWindow(0.01) * 1500 * 8) / 0.1 / 1e6;
      return `
      <p>Every sender so far reads a loss or a mark as "too fast". <strong>BBR</strong> (Cardwell et al., Google, 2016) stops reading that signal and models the path instead, with two numbers: the bottleneck's rate, as the largest delivery rate seen in ten round trips, and the base RTT, as the smallest seen in ten seconds. Their product is the pipe. It sends at that rate, <em>paced</em> and not in bursts, with a window capped at two pipes. Since a queue only delays things and a loss only says something about a buffer, it never needs either to fill.</p>
      <p>To keep the two numbers honest it has to look. A rate above the path's cannot be seen without sending faster, so for one round trip in eight it sends at 1.25 times its estimate, then 0.75 times, to drain what that queued. An empty pipe's RTT cannot be seen with a queue in it, so every ten seconds it drops to four packets for 200 ms. That is visible in the window plot as a regular notch. In this model of BBR's first version, on the same link and huge buffer as before, it adds ${n0(b.pingMeanMs)} ms where CUBIC adds ${n0(c.pingMeanMs)}, at ${nf(100 * b.utilization, 0)} % use.</p>
      <p>The second thing is <strong>loss</strong>. On a path that loses 1 % of its packets at random, as a poor radio link can, Mathis's formula gives Reno ${nf(m, 1)} Mb/s across 100 ms, whatever the link's rate, and the model gets ${nf(rl.goodputMbps[0], 1)}. BBR ignores it: ${nf(bl.goodputMbps[0], 1)} of 20 Mb/s. That is what made it attractive on long paths to users.</p>
      <div class="try">Read off the notch every ten seconds. Then reduce the buffer to 40 packets, about half a pipe here, and see BBR drop packets and not care.</div>`;
    },
    widget: () => labWidget(one('bbr', 'tail')),
    challenge: {
      kind: 'quiz',
      question: 'Why does BBR send above its rate estimate for one round trip in eight?',
      options: ['A faster bottleneck cannot show up in delivery rates unless it is sent faster than the estimate', 'To make its RTT estimate smaller', 'To fill the buffer, since that lowers the delay', 'To cause a loss, so that it knows it found the limit'],
      answer: 0,
      explain: 'The estimate is the largest delivery rate seen, and delivery can never exceed what was sent. So it has to probe. The 0.75 phase that follows removes any queue the probe made.',
      why: ['', 'Sending faster can only raise the RTT. That estimate is refreshed in the low-window phase.', 'A fuller buffer raises the delay.', 'BBR does not read loss at all.'],
    },
  },
  {
    title: 'CUBIC meets BBR',
    get body() {
      const s = duelRun(40), d = duelRun(320), fq = duelRun(40, 'fq');
      return `
      <p>The trouble with a sender that listens to a different signal shows up when it shares a link. On a shallow buffer, BBR sends at its rate and does not react to loss, so the drops all fall on CUBIC, which keeps backing off, and BBR's estimate grows into the room left. In this model, at 40 packets (under a pipe here) BBR takes ${nf(s.goodputMbps[0], 1)} Mb/s and CUBIC ${nf(s.goodputMbps[1], 1)}. On a deep buffer the window cap comes into play, CUBIC fills the buffer and BBR's measured base RTT grows with it: at 320 packets they are ${nf(d.goodputMbps[0], 1)} and ${nf(d.goodputMbps[1], 1)}. Published experiments on real links found the same shape (Hock et al., 2017; Ware et al., 2019): the share follows the buffer, and is not the even split AIMD promises.</p>
      <p>This is BBR's first version, in a model, one run for each buffer, so treat the numbers as the pattern and not as a result. Later versions read loss and marks too, so as to share better. And <strong>a queue per flow ends the argument</strong>: under FQ-CoDel at the same 40 packets the two get ${nf(fq.goodputMbps[0], 1)} and ${nf(fq.goodputMbps[1], 1)}, with the delay at ${nf(fq.pingMeanMs, 1)} ms, because the choice of who gets what has moved out of the senders' hands.</p>
      <div class="try">Read off the shares and delays from shallow to deep. Where would you run this link? Then switch to FQ-CoDel.</div>`;
    },
    widget: duelWidget,
    challenge: {
      kind: 'quiz',
      question: 'On a shallow tail-drop buffer, BBR takes nearly all of the link from CUBIC. What is the mechanism?',
      options: ['Drops are shared, but only CUBIC reacts to them, so its rate falls while BBR\'s stays and its measured rate grows into the space', 'BBR is sent with a higher priority', 'CUBIC\'s packets are larger', 'BBR marks CUBIC\'s packets'],
      answer: 0,
      explain: 'The queue does not favour anyone. It is that one sender treats a drop as an instruction and the other does not.',
      why: ['', 'Nothing on the link distinguishes the two: there is no priority in a tail-drop queue.', 'Both send packets of one size in this model.', 'A sender cannot mark another sender\'s packets, and marks are for routers.'],
    },
  },
  {
    title: 'Choosing for a link',
    get body() {
      const best = lab({ aqm: 'fq', buffer: FULL, rtt: 50, flows: [{ cc: 'cubic', rttMs: 50, ecn: true }, { cc: 'cubic', rttMs: 50, ecn: true, startS: 2 }] });
      return `
      <p>By now the design space has names. <strong>At the sender:</strong> what signal, and what curve. Reno or CUBIC on loss, with a Reno-friendly region; BBR on measured rate and RTT; a data-centre sender on the share of marks. <strong>At the bottleneck:</strong> how much buffer, and what it does when it starts to fill. One BDP of buffer is about right for one flow with Reno, and it is too much once there are many flows, whose sawteeth average out: many large routers run far less. <strong>In between:</strong> a mark or a drop.</p>
      <p>And there is a practical point, one this model shows at every turn: the bottleneck is usually at the edge, a home upload or a radio link, where nobody has to agree on anything and one device can fix it. With FQ-CoDel and ECN on the lab's link, two CUBIC flows get ${best.goodputMbps.map((g) => nf(g, 1)).join(' + ')} Mb/s, and a video call waits ${nf(best.pingMeanMs, 1)} ms. On the same link and buffer, the bufferbloat step's call waited ${n0(lab(one('cubic', 'tail')).pingMeanMs)} ms.</p>
      <div class="try">Find settings on this lab that give at least 18 Mb/s to one sender and under 10 ms of added delay. Then get under 50 ms with only a change at the sender, leaving the tail-drop queue and ${FULL}-packet buffer alone.</div>
      <p>Everything in this part has made bytes arrive, in order and on time. None of it asks who else can read them: any router on the path can. The next chapter is about that.</p>`;
    },
    widget: () => labWidget({ aqm: 'tail', buffer: FULL, rtt: 50, flows: [{ cc: 'cubic', rttMs: 50 }] }),
    challenge: {
      kind: 'quiz',
      question: 'You run a home router with a 20 Mb/s upload. Video calls stutter while someone uploads a large file. The uploader\'s software cannot be changed. What is the first thing to do?',
      options: ['Turn on FQ-CoDel on the upload, with its rate set just below the link, so the queue forms where it can be managed', 'Buy a router with a larger buffer', 'Ask the uploader to use BBR', 'Raise the MTU, so that fewer packets are needed'],
      answer: 0,
      explain: 'The call stutters because it waits behind the upload. A queue per flow removes that wait, and it needs only the device at the bottleneck. Setting the rate just below the link\'s keeps the queue in this device, not in the modem\'s.',
      why: ['', 'A larger buffer means more delay behind the same upload.', 'You were told the sender cannot be changed, and a sender\'s choice leaves every other flow behind it in one queue anyway.', 'A larger packet takes longer to send, and it changes nothing about who waits for whom.'],
    },
  },
];

export const chQueues: Chapter = {
  id: 'queues', num: numOf('queues'), title: 'Queues and congestion', level: 'Communication',
  blurb: 'Why a fast network feels slow: delay from load alone, bufferbloat, why TCP halves, CUBIC and its curve, RED, CoDel and fair queueing, ECN, and BBR against CUBIC on one link, on a labelled model of a bottleneck.',
  goals: [
    'work out a queue\'s delay from its load, and say why running a link near full always costs delay',
    'explain bufferbloat, and size a buffer from the bandwidth-delay product and the sawtooth',
    'say why additive increase and multiplicative decrease converge, derive Mathis\'s formula, and why long fat pipes led to CUBIC',
    'compare RED, CoDel, fair queueing, ECN and BBR by what signal they use and where they act, and choose for a given link',
  ],
  builds: ['tcp', 'switch', 'router'],
  recap: {
    keep: [
      'M/M/1 waits ρ / (1 − ρ) packet times, a fixed size half of that, and variation adds (1 + c²) / 2. Little: the mean inside is the rate times the mean time inside. The tail is several times the mean.',
      'A loss-based sender fills a tail-drop buffer, since that is the only way it gets a signal. One BDP of buffer is enough for one Reno; the rest is only delay, for every flow.',
      'AIMD: adding keeps the gap between two flows and halving halves it, so they converge. AIAD and MIMD do not.',
      'Reno averages √(3 / 2p) packets. On a long fat pipe that means minutes to recover and impossibly rare losses, hence CUBIC: C (t − K)³ + Wmax, in real time.',
      'RED drops by average length. CoDel drops when a packet\'s wait has stayed above 5 ms for 100 ms, next after 100 / √count ms. FQ gives each flow its own queue and an equal turn, so the disciplines, not the senders, set the shares.',
      'ECN sets a bit where a drop would have been, echoed in the ACKs: same cut, no data lost.',
      'BBR models the path by its largest delivery rate and smallest RTT, sends paced at their product, and ignores loss. On shallow buffers it takes the link from CUBIC; on a queue per flow neither can.',
    ],
    check: [
      {
        question: 'A link is 80 % loaded with random packet sizes. What is the mean wait, and what would it take to halve it?',
        options: ['4 packet times; reduce the load to two thirds (ρ / (1 − ρ) = 2)', '4 packet times; halve the load', '0.8 packet times; it is already small', '20 packet times; only a faster link helps'],
        answer: 0,
        explain: 'ρ / (1 − ρ) at 0.8 is 4, and solving for 2 gives ρ = 2 / 3. Halving the traffic overshoots a long way, to a wait of 2 / 3 of a packet.',
        why: ['', 'Halving the load gives ρ = 0.4 and a wait of 0.67, not 2.', 'That is ρ, not ρ / (1 − ρ).', '1 / (1 − ρ) is 5, not 20, and lower load helps as well.'],
      },
      {
        question: 'A flow\'s window is W at the top of its sawtooth, and its RTT is 100 ms. With no queue at all and W the pipe, what share of the link does Reno average?',
        options: ['¾: the window runs evenly from half of the pipe to all of it', 'All of it: the window never falls under the pipe', '½: it spends all its time halved', 'It depends on the RTT'],
        answer: 0,
        explain: 'The average of W / 2 to W is ¾ W. With a queue, the window can stay above the pipe for some of the cycle, and at B = P the link never idles.',
        why: ['', 'It falls under the pipe at once, with no queue to drain.', 'It rises steadily from there, so the mean is above half.', 'The RTT sets how long a cycle is, and not the shape of it.'],
      },
      {
        question: 'Why does a queue per flow end the argument between BBR and CUBIC?',
        options: ['Each sender has its own queue and an equal turn, so its rule only affects itself', 'It makes them both BBR', 'It makes the buffer larger', 'It stops all losses'],
        answer: 0,
        explain: 'The share is decided by the scheduler. A sender that ignores drops only overflows its own queue.',
        why: ['', 'The senders do not change.', 'It does not need to be larger: it is used differently.', 'A sender that overruns its queue still loses packets, its own.'],
      },
    ],
  },
  steps,
};
