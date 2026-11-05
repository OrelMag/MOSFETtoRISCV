// Wi-Fi (level Communication): who talks when nobody can hear everybody. The MAC's timing is gates (lib/wifi.ts, comm/wifi.ts, at 1 clock = 1 µs); the air, the rates and MIMO are models, labelled as models, and the traces are modelled.
// Model numbers are computed; dates and rate figures of the generations are typed.

import { ACK_US, airtimeUs, bianchi, CW_MAX, CW_MIN, DIFS_US, goodputMbps, aggregateMbps, RATES, RESP_TIMEOUT, RETRY_LIMIT, RTS_US, SIFS_US, SLOT_US } from '../comm/wifi';
import { fsplDb, noiseFloorDbm } from '../phys/radio';
import { dcfStation } from '../lib/wifi';
import { stats } from '../sim/stats';
import { airtimeWidget, contentionWidget, mimoCurves, mimoWidget, rateWidget, wifiApi, wifiScene } from '../widgets/wifi';
import { numOf } from './order';
import type { Chapter } from './types';

const nf = (x: number, d = 1) => x.toFixed(d);
const R54 = RATES[7], L1500 = airtimeUs(1528, R54.ndbps);
const B2 = bianchi(2, L1500), B20 = bianchi(20, L1500);
const RX = 20 - fsplDb(0.02, 5.5), SELF = 20 - RX;
const M0 = mimoCurves(0);
let nands = 0;
const N = () => (nands ||= stats(dcfStation()).nands);

export const chWifi: Chapter = {
  id: 'wifi', num: numOf('wifi'), title: 'Wi-Fi', level: 'Communication',
  blurb: 'Who talks when nobody can hear everybody? CSMA/CA with its timing in gates, the contention window and Bianchi\'s formula, the hidden terminal and RTS / CTS, rate adaptation, airtime, MIMO.',
  goals: [
    'say why a radio cannot detect a collision as Ethernet does, and what DCF does instead',
    'read SIFS, DIFS, slots and the contention window off a timeline, and say what each is for',
    'estimate how a shared channel degrades with stations, from Bianchi\'s model',
    'show the hidden terminal on gates, and say what RTS / CTS costs and buys',
    'work out where the airtime of a 54 Mb/s link goes, and what aggregation and MIMO change',
  ],
  builds: ['radio', 'ethernet'],
  recap: {
    keep: [
      'A transmitter is too loud to hear anyone else, so a collision cannot be detected: it is inferred, from a missing ACK. Everything else follows: listen, wait a random time, send, wait for an ACK, double the window if none comes.',
      `Priorities are made of time. SIFS (${SIFS_US} µs) is shorter than DIFS (${DIFS_US} µs), so a response always goes before anyone else's new frame. No field in any frame says so; the waiting does.`,
      `Contention scales badly but not terribly: at ${nf(B2.throughput * 100, 0)} % of the air for 2 stations and ${nf(B20.throughput * 100, 0)} % for 20, by Bianchi's closed form. Doubling the window spreads the load as it grows.`,
      'Carrier sense is at the sender, and the collision is at the receiver. Two stations that cannot hear each other collide at the access point; RTS / CTS has the receiver announce the reservation to everyone who can hear it.',
      `The rate is not the throughput. At 54 Mb/s, one 1500-byte frame an exchange gives ${nf(goodputMbps(1500, R54), 0)} Mb/s because of the time around the frame; aggregating many frames behind one preamble gets most of it back.`,
    ],
    check: [
      {
        question: 'A station has sent a frame and hears no ACK. What does it know?',
        options: ['Only that no ACK came: the frame was lost, or the ACK was', 'That the frame collided with another', 'That the receiver is out of range', 'That the frame arrived, since a radio delivers what it sends'],
        answer: 0,
        explain: 'A radio cannot detect the collision. The missing ACK has many causes, including noise and a weak signal, and DCF treats them all alike as collisions, doubling the window. That is why low SNR can look like congestion.',
        why: ['', 'Could be: or noise, or the ACK itself was lost.', 'Could be, but a missing ACK does not say so.', 'Nothing confirms delivery but the ACK.'],
      },
      {
        question: 'Why is SIFS shorter than DIFS?',
        options: ['So that a response to a frame always goes ahead of any new frame: the exchange stays whole', 'To make frames faster', 'Because ACKs are short', 'To save power'],
        answer: 0,
        explain: 'A station with a new frame must see the medium idle for a whole DIFS. An ACK begins after SIFS, so nobody following the rules can get in between.',
        why: ['', 'It does not change a frame\'s speed.', 'An ACK\'s length has nothing to do with the gap before it.', 'Waiting is receiving, and uses about the same power.'],
      },
      {
        question: 'Two laptops are each in range of an access point but not of each other. What does RTS / CTS change?',
        options: ['The access point\'s CTS is heard by both, so the other holds off for the announced time; a collision costs only a short RTS', 'They can now hear each other', 'The access point schedules them in turn', 'The access point transmits both frames'],
        answer: 0,
        explain: 'They still can\'t hear each other. A lost RTS costs tens of microseconds, not a whole frame; and once a CTS goes out, it sets the NAV of everyone in range of the receiver.',
        why: ['', 'Their radios are as far apart as before.', 'Nothing here is scheduled: the RTS still contends.', 'Each station sends its own data.'],
      },
    ],
    practise: [],
  },
  steps: [
    {
      title: 'A channel you cannot listen to',
      body: `
        <p>Ethernet stations listen while they send. A collision shows on the cable at once, and both stop. A radio can't do that: its own transmitter, at 20 dBm, drowns the receiver sharing its antenna. A neighbour 20 m away at 5.5 GHz arrives at about ${nf(RX, 0)} dBm in free space, ${nf(SELF, 0)} dB under what you are sending, and the noise floor of a 20 MHz channel is ${nf(noiseFloorDbm(20, 6), 0)} dBm. So a Wi-Fi transmitter finds out about a collision only afterwards: the receiver sends back an <strong>ACK</strong>, and no ACK means try again.</p>
        <p>The other half of Ethernet's method, listening before you talk, still works. The scheme is <strong>CSMA/CA</strong>, carrier sense with collision <em>avoidance</em>: since a collision costs a whole frame, each station goes to some trouble not to have one. The rule set is called the <strong>distributed coordination function</strong>, DCF.</p>
        <p>On the stage are three stations in gates, ${N()} NANDs each: A and B always have frames for the access point in the middle. A clock is one microsecond, so what you see in the timeline is 802.11a's real timing. Between them is a model of the air: who hears whom, and what arrives whole. A model station runs beside each one, and the panel says whether they agree.</p>
        <p>Press Run. Blue frames, a green ACK after each. Sometimes both blue bars start together: that is a collision, and neither gets an ACK.</p>`,
      scene: () => wifiScene('open'),
      challenge: {
        kind: 'quiz',
        question: 'Why not fit a Wi-Fi radio with a separate receive antenna, and detect collisions as Ethernet does?',
        options: ['The two antennas are centimetres apart, so its own signal still arrives far stronger than any other, and what matters is a collision at the receiver anyway', 'It would be illegal', 'Antennas cannot receive and transmit at the same frequency', 'Collisions cannot be detected at all'],
        answer: 0,
        explain: 'Separating them by centimetres gets you little of the 60 to 100 dB you need. And the sender hearing a clear channel says nothing about what the receiver heard, as the hidden terminal step shows.',
        why: ['', 'Nothing forbids it. Full-duplex radio is researched, and hard.', 'They can: the trouble is that one swamps the other.', 'Ethernet detects them; the difficulty is in the radio power.'],
      },
      more: {
        numbers: `<p>Station ${N()} NANDs. A frame here lasts 300 µs. Own-signal figure: 20 dBm against free-space loss over 20 m at 5.5 GHz with no antenna gains, from the radio chapter's formula (chapter ${numOf('radio')}).</p>`,
      },
    },
    {
      title: 'The rules, in microseconds',
      body: `
        <p>A station with a frame:</p>
        <ol>
          <li>Picks a random <strong>backoff</strong> between 0 and the contention window CW, in slots of ${SLOT_US} µs.</li>
          <li>Waits until the medium has been idle for <strong>DIFS</strong> (${DIFS_US} µs).</li>
          <li>Counts down one per idle slot. If the medium goes busy it freezes the count, and starts again after the next DIFS with what is left.</li>
          <li>At zero, sends.</li>
          <li>The receiver waits <strong>SIFS</strong> (${SIFS_US} µs) and answers with an ACK (${ACK_US} µs here).</li>
          <li>The sender waits a little longer than that, ${RESP_TIMEOUT} µs in all. No ACK: CW doubles (from ${CW_MIN} up to ${CW_MAX}) and it tries again, ${RETRY_LIMIT} tries in all, and then the frame is dropped. An ACK resets CW.</li>
        </ol>
        <p>Notice that there are no priorities in any frame. <strong>Priority is time</strong>: SIFS is shorter than DIFS, so an ACK always gets the air before anyone can start something new. DIFS = SIFS + 2 slots.</p>
        <p>The slot itself is physics: long enough that a station starting in one slot is heard by everyone by the next, which covers receive-to-transmit turnaround, carrier sense and propagation. A random count is enough to spread stations out in time without any of them knowing how many others there are.</p>
        <p>Step in 1 µs and 100 µs clicks. Read each station's state, backoff and CW under the timeline. To see the window double, run until both start in the same slot: the line under the timeline shows CW 31, then 63 if it happens again. Drilling into a station shows the <span data-show="s0">timer, backoff, and state</span> as gates.</p>`,
      scene: () => wifiScene('open'),
      challenge: {
        kind: 'reach',
        goal: 'Run until 20 frames have been delivered between A and B, with the gates agreeing with the model.',
        check: (st) => { const a = wifiApi.get(st)?.status(); return !!a && a.delivered[0] + a.delivered[2] >= 20 && a.agreed; },
        hints: ['Run: each exchange takes about half a millisecond.', 'Compare the two delivered counts as they rise: over time they stay close.'],
        answer: 'Run for about 12 ms. Both stations get a fair share, and any collision shows as two blue bars starting together and no green.',
        solve: (st) => wifiApi.get(st)?.run(14000),
      },
    },
    {
      title: 'How many can share',
      body: `
        <p>Every extra station means more chance that two pick the same slot. How bad does that get? Giuseppe Bianchi's 2000 paper gives a closed form. Treat each station as attempting in a slot with probability τ, independently, and a try as colliding with probability p. Then:</p>
        <p><code>p = 1 − (1 − τ)<sup>n−1</sup></code>, and <code>τ = 2(1 − 2p) / ((1 − 2p)(W + 1) + pW(1 − (2p)<sup>m</sup>))</code></p>
        <p>Solve the two together, and the throughput is the payload's share of an average slot, whichever kind it turned out to be: idle, success or collision. With 1500-byte frames at 54 Mb/s (${L1500} µs each), 2 stations get ${nf(B2.throughput * 100, 0)} % of the air and 20 get ${nf(B20.throughput * 100, 0)} %, with ${nf(B20.p * 100, 0)} % of tries colliding.</p>
        <p>The line in the plot is that formula, and the dots are this chapter's station model, run live at each size. They are two different things that should agree, and tests hold them within 10 %. That is a strong check: a mistake in slot counting moves the dots, not the line.</p>
        <p>The shape is the lesson. Doubling CW on a collision is how a station learns about load with no information: a crowded channel pushes everyone's window up. The share falls slowly with stations, not as a cliff. For short frames the cost of idle slots dominates, and throughput is small however few stations there are; that is the next step.</p>
        <p>Tick RTS / CTS. With long frames and many stations it gains, because a collision costs ${RTS_US} µs rather than a whole frame. With few stations or short frames it only loses.</p>`,
      widget: contentionWidget,
      challenge: {
        kind: 'quiz',
        question: 'Why does doubling the window help at high load and hurt at low load?',
        options: ['Larger windows mean fewer collisions but more idle slots; the balance depends on how many are contending', 'It always hurts', 'It changes the frame\'s data rate', 'It only matters with RTS / CTS'],
        answer: 0,
        explain: 'A window too small for the load wastes the air on collisions; a window too large for the load wastes it on idle slots. Exponential backoff finds the balance with no count of the stations.',
        why: ['', 'Without it, collisions would dominate under load.', 'The rate is a separate choice.', 'It matters in basic access too, and most in it.'],
      },
    },
    {
      title: 'The station you cannot hear',
      body: `
        <p>Carrier sense asks "is anyone talking <em>near me</em>?" The collision happens <em>near the receiver</em>. If A and B are on opposite sides of an access point, in range of it but not of each other, then each hears silence and sends. The access point hears both at once and gets neither. That is the <strong>hidden terminal</strong>.</p>
        <p>This scene has A and B out of each other's range. Run: the frames in rows A and B overlap all the time, CW climbs, tries are wasted, and frames are dropped after ${RETRY_LIMIT} tries. Carrier sense helps nothing, as it says "clear".</p>
        <p><strong>RTS / CTS</strong> uses the receiver's own voice. Before a long frame the sender sends a short <em>Request To Send</em> (${RTS_US} µs). The receiver answers, after SIFS, with <em>Clear To Send</em>. Both carry the duration of the rest of the exchange. Every station that hears either sets its <strong>NAV</strong> (network allocation vector), a timer of virtual carrier sense: it treats the medium as busy until that runs out, whether or not it hears anything. B can't hear A's RTS but can hear the access point's CTS.</p>
        <p>Tick RTS / CTS and run. Two RTSs can still collide, but that wastes only ${RTS_US} µs, not ${nf(300, 0)}. Delivered frames jump. Compare a real network, which sets a threshold: only frames above some length get RTS / CTS, since a short frame costs little more than the RTS.</p>
        <p>The opposite problem is the <strong>exposed terminal</strong>: a station which hears a sender nearby and holds off, though its own receiver could have heard it fine. Carrier sense has no way to tell. Neither problem has a complete cure in a scheme with no coordinator, and that is what the next generations' scheduling goes after.</p>`,
      scene: () => wifiScene('hidden'),
      challenge: {
        kind: 'reach',
        goal: 'With A and B hidden from each other, turn on RTS / CTS and deliver 40 frames with no drop.',
        check: (st) => { const a = wifiApi.get(st)?.status(); return !!a && a.hidden && a.rts && a.agreed && a.delivered[0] + a.delivered[2] >= 40 && a.dropped[0] + a.dropped[2] === 0; },
        hints: ['Tick RTS / CTS, which restarts the cell, then Run.', 'About 40 ms of air.'],
        answer: 'Tick RTS / CTS and Run. A CTS from the access point sets the NAV of the station that cannot hear the sender.',
        solve: (st) => { const a = wifiApi.get(st); a?.setRts(true); a?.run(42000); },
      },
      more: {
        pitfall: '<p>The NAV works only for stations that decode the CTS, and a CTS at a low rate reaches further than the data. Stations nearly out of range can still step on a frame. Ordinary Wi-Fi in a home has hidden stations quite often, and in practice many networks leave RTS / CTS off below 2 000 bytes or so, which accepts this.</p>',
      },
    },
    {
      title: 'How fast to send',
      body: `
        <p>802.11a's eight rates range from BPSK ½ at 6 Mb/s to 64-QAM ¾ at 54 Mb/s, by the modem chapter's reasoning: more points need more SNR. There is no way to ask the channel what its SNR is; it changes by 30 dB in seconds, per the radio chapter. The transmitter has to guess, and its only signal is whether an ACK comes.</p>
        <p><strong>ARF</strong>, Auto Rate Fallback (1997), is the simplest possible: after 10 good frames go up a rate; after 2 lost in a row come down. It's a tiny state machine. It also has a known fault, since it can't tell collisions from fading: on a busy channel it falls to low rates, and low rates take longer, raising the collisions further. Modern drivers (Minstrel in Linux) keep statistics per rate and probe the others, and newer standards have the receiver send back measured SNR and steering.</p>
        <p>The plot is a modelled trace, not a captured radio: fading from the radio chapter's model, each frame's fate drawn from a steep curve around its rate's SNR requirement. The thick line is the rate ARF chose, the thin one the SNR. Walk faster and its 10-frame rule falls behind the channel. Compare it with the best single fixed rate and with a transmitter told the SNR each frame. Lower the mean SNR and watch a fixed 54 Mb/s lose nearly everything.</p>`,
      widget: rateWidget,
      challenge: {
        kind: 'quiz',
        question: 'A busy network has many collisions. What does a simple rate-adaptation rule do, and what is wrong with that?',
        options: ['It reads lost frames as a weak channel and lowers the rate; frames then take longer, which makes things worse', 'It raises the rate to clear the queue', 'Nothing: rate adaptation sees only SNR', 'It stops transmitting'],
        answer: 0,
        explain: 'A missing ACK looks the same whatever caused it. At a lower rate each frame holds the air longer, every station\'s turn gets longer, and throughput falls. This "rate anomaly" is why slow stations hurt fast ones on the same channel.',
        why: ['', 'It has no reason to raise it on lost frames.', 'Simple schemes have no SNR at all, just ACKs.', 'It keeps trying until the retries run out.'],
      },
    },
    {
      title: 'Where the airtime goes',
      body: `
        <p>Everything around the data costs a fixed time, and a faster data rate shrinks only the data. A 1500-byte frame at 54 Mb/s lasts ${L1500} µs. Around it come DIFS (${DIFS_US}), the average backoff (${nf((CW_MIN / 2) * SLOT_US, 0)}), SIFS (${SIFS_US}) and an ACK (${ACK_US}). The goodput is ${nf(goodputMbps(1500, R54), 0)} Mb/s of 54. The table computes this for each rate, by the standard's formula: preamble 20 µs, then 4 µs a symbol.</p>
        <p>Shrink the payload to 100 bytes, as for voice or a TCP ACK, and it's a disaster: efficiency in single figures. Faster rates can't fix it, because the time isn't data at all. <strong>Aggregation</strong> does: 802.11n (2009) sends many MPDUs behind one preamble with one block ACK, and if one is hit only it is resent. At 32 frames, ${nf(aggregateMbps(1500, 32, R54), 0)} Mb/s from the same 54. It's the same trick as PCIe's Ack coalescing, and TCP's: one acknowledgement can cover a lot.</p>
        <p>Later generations mostly widened the pipe. Typed figures, from public sources: 802.11n (2009), 40 MHz, 4 streams, 600 Mb/s. 802.11ac (2013), 160 MHz, 256-QAM, multi-user downlink, up to 6.9 Gb/s. 802.11ax (Wi-Fi 6, 2021), 1024-QAM and OFDMA, which splits a channel's subcarriers among users so that short frames don't each need a whole channel: a scheduled step away from pure contention. 802.11be (Wi-Fi 7, 2024), 320 MHz, 4096-QAM, multi-link.</p>`,
      widget: airtimeWidget,
      challenge: {
        kind: 'quiz',
        question: 'A link upgrades from 54 Mb/s to 540 Mb/s of raw rate with no other change, for 100-byte frames. What happens?',
        options: ['Little: the frame shrinks, but DIFS, backoff, SIFS, preamble and ACK dominate, and do not', 'Ten times the throughput', 'Less throughput, because of more errors', 'Twice the throughput'],
        answer: 0,
        explain: 'At 54 Mb/s a 100-byte frame is about 15 symbols of data: already a small part of about 200 µs of overhead. A ten-fold rate saves only part of that. This is why aggregation matters more than rate, for small frames.',
        why: ['', 'Only for payload-dominated exchanges.', 'Error rates are not part of this question.', 'It is less than that.'],
      },
    },
    {
      title: 'More antennas, more streams',
      body: `
        <p>The radio chapter used a second antenna for reliability. Used differently it also carries more data. Send two streams from two antennas into a rich scattering channel, and each receive antenna hears a different mix. The channel is a matrix, H, and if its rows differ enough, the receiver can untangle them, as simultaneous equations. The capacity (Foschini and Telatar, in the 1990s) is</p>
        <p><code>C = Σ log₂(1 + (SNR / 2) λ<sub>i</sub>)</code></p>
        <p>over the eigenvalues λ of H Hᴴ. The channel becomes several independent pipes. At high SNR, each 3 dB buys <em>2</em> b/s/Hz rather than 1: capacity rises in proportion to the number of streams, for the same power and spectrum. At 30 dB, on average over random channels, ${nf(M0.mean(30), 1)} b/s/Hz against ${nf(M0.siso(30), 1)}, and that is why 802.11n onward has several antennas.</p>
        <p>Raise the correlation, for antennas too close together or a clean line of sight with nothing to scatter off. The matrix loses a useful dimension and the gain falls away to a single stream's. Multipath, the enemy of the last chapter, is what makes this possible.</p>
        <p>With knowledge of H, a transmitter can also <strong>beamform</strong>: weigh its antennas so that the signal arrives in phase at one receiver. <strong>Multi-user MIMO</strong> (802.11ac on) does this for several receivers at once, steering nulls toward the others. This is the same array as the radio chapter, used by arithmetic per subcarrier. It costs channel measurements, which cost airtime. Next, the same set of ideas where one mast has thousands of users.</p>`,
      widget: mimoWidget,
      challenge: {
        kind: 'quiz',
        question: 'Why does a line-of-sight link in open space get little from 2 × 2 MIMO?',
        options: ['Each receive antenna hears nearly the same combination: H has one large eigenvalue, so there is one stream', 'Line of sight has too much SNR', 'The antennas interfere with each other', 'MIMO only works indoors'],
        answer: 0,
        explain: 'With no scatterers the paths are near copies of each other, and H is nearly rank 1. It can still use both antennas for 3 dB more gain, but not for a second stream. (Widely spaced antennas can restore rank, which long-range links occasionally do.)',
        why: ['', 'Plenty of SNR is the case where streams would help most.', 'Not the mechanism: the receiver separates streams if the matrix permits.', 'It works anywhere the channel matrix has rank.'],
      },
    },
  ],
};
