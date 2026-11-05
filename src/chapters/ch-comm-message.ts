// The on-ramp to the Communication chapters: what it takes to send anything, for a reader who has Chapter 0 and nothing else. Bits on a
// wire, the two parts of a delay, what fits on a line, packets, layers, decibels. Every figure is comm/message.ts's, worked out here.

import { dbToRatio } from '../comm/limits';
import { bytesWithLoss, delayOf, layerCost, onTheLine, packetCount, pushTime, storeAndForward, travelTime, WIRE_OVERHEAD } from '../comm/message';
import { bitsWidget, decibelWidget, delayWidget, fmtBytes, fmtTime, layersWidget, packetWidget, pipeWidget, VAN_KMH } from '../widgets/message';
import { numOf } from './order';
import type { Chapter } from './types';

const LONDON = 5.6e6, KB = 1000;
const atOneGig = delayOf(KB, 1e9, LONDON);
const BIG = { bytes: 1e6, payload: 1e6, header: 40, rate: 1e7, hops: 4 }, CUT = { ...BIG, payload: 1000 };
const VAN_TB = 100, VAN_KM = 500, VAN_H = VAN_KM / VAN_KMH, LINK_H = (VAN_TB * 1e12 * 8) / 1e10 / 3600;
const full = layerCost(1460), tiny = layerCost(1);
const PHOTO = 5e6, HOME = 1e8, FAR = 3e6;

export const chMessage: Chapter = {
  id: 'message', num: numOf('message'), label: 'C0', title: 'Sending a message', level: 'Communication',
  blurb: 'What it takes to send anything: bits on a wire, the two parts of a delay, what fits on a line, why messages are cut into packets and wrapped in layers, and decibels.',
  goals: [
    'turn a message into bits and work out how long they take to send',
    'split a delay into pushing and travelling, and say which one a faster link can shorten',
    'say why a network cuts messages into packets and wraps them in layers, and what each costs',
    'add a chain of gains and losses in decibels',
  ],
  builds: ['basics'],
  recap: {
    keep: [
      'A message is bits, and a bit on a wire is a level held for a time. Rate is bits a second; size ÷ rate is the time to send.',
      `A delay has two parts: pushing the bits onto the line (size ÷ rate) and travelling the distance (about ${(travelTime(1e6) * 1e3).toFixed(0)} ms per 1000 km in cable or fibre). A faster link shortens only the first.`,
      `Rate × travel time is how much is on the line at once. A fast long line holds megabytes, which the sender must keep until it hears they arrived.`,
      'Packets let many talkers share a line, and mean a wrong bit costs one packet, not the whole message. Each costs a header, and each is held whole at every link.',
      `Layers wrap each other, each with its own header and job. A full packet on Ethernet is ${(100 * full.share).toFixed(1)} % data; a one-byte message costs ${tiny.total} bytes.`,
      'A decibel is 10 log₁₀ of a power ratio: chains add instead of multiplying. 3 dB is about twice, 10 dB ten times. dBm is decibels above a milliwatt.',
    ],
    check: [
      {
        question: `A 1 KB message goes ${LONDON / 1e6 * 1000} km at 1 Gb/s. You buy a link a thousand times faster. Roughly how much sooner does it arrive?`,
        options: [`Hardly at all: about ${fmtTime(atOneGig)} either way, because nearly all of it was travelling`, 'A thousand times sooner', 'About twice as soon', 'It arrives later, because a faster link is more sensitive'],
        answer: 0,
        explain: `Pushing was ${fmtTime(pushTime(KB, 1e9))} and travelling ${fmtTime(travelTime(LONDON))}. The rate only touches the first.`,
        why: ['', 'That would be true only if all of the delay were pushing.', 'Nothing in the sum halves: one part shrinks to almost nothing, and it was almost nothing already.', 'A faster link does not slow anything down.'],
      },
      {
        question: 'Why is a message cut into packets rather than sent whole?',
        options: ['A line can be shared packet by packet, and a wrong bit costs one packet instead of the whole message', 'Packets travel faster along the wire than a long message', 'A long message would be too heavy for the wire', 'Headers make the data smaller'],
        answer: 0,
        explain: `With one bit in a million wrong, a 1 MB message sent whole almost never arrives clean; cut into 1000-byte packets it costs ${(bytesWithLoss(CUT, 1e-6) / 1e6).toFixed(2)} MB in all.`,
        why: ['', 'Every bit travels at the same speed, in a packet or not.', 'A wire has no limit of that kind; what it has is other users and errors.', 'Headers add bytes.'],
      },
      {
        question: 'An amplifier of +20 dB, a cable of −60 dB and an amplifier of +30 dB, in a row. What does the chain do to the power?',
        options: ['Divides it by 10: the sum is −10 dB', 'Multiplies it by 36 000: 20 × 60 × 30', 'Nothing: the amplifiers make up for the cable', 'Divides it by 60'],
        answer: 0,
        explain: `Decibels add: 20 − 60 + 30 = −10 dB, a ratio of ${dbToRatio(-10)}.`,
        why: ['', 'Decibels are already logarithms, so they add. Multiplying them has no meaning.', 'The amplifiers add 50 dB and the cable takes 60.', 'That treats −60 dB as a ratio of 60. It is a ratio of a million.'],
      },
    ],
  },
  steps: [
    {
      title: 'Bits on a wire',
      body: `
        <p>Sending a message needs three things: something that can change at one end and be seen at the other, an agreement about what each change means, and time. A lamp across a valley would do. So would a voltage on a wire, which is what most of these chapters use.</p>
        <p>The agreement starts with <strong>bits</strong>. Text becomes bytes by a table everybody shares, and each byte is eight bits, as in Chapter 0. To send a bit, hold the wire at a high voltage for 1 or a low one for 0, for an agreed time. The number of bits sent each second is the <strong>bit rate</strong>, written b/s; the time to send a message is its bits divided by the rate.</p>
        <p>Rates are written with the same prefixes as everywhere, in thousands: 1 kb/s, 1 Mb/s, 1 Gb/s. Bytes are usually counted with a capital B, so 1 MB is eight million bits. Mixing up b and B is an eightfold error, and an easy one.</p>
        <div class="try">Type your name. Then move the rate from 1 b/s up. At 1 b/s you could read it off a lamp; at a million you could not.</div>`,
      widget: bitsWidget,
      challenge: {
        kind: 'quiz', question: 'A photo is 2 MB. How long does it take to send at 8 Mb/s?',
        options: ['2 seconds: 16 million bits at 8 million a second', 'A quarter of a second: 2 ÷ 8', '8 seconds', '16 seconds'],
        answer: 0,
        explain: '2 MB is 2 million bytes, 16 million bits. At 8 million bits a second that is 2 seconds.',
        why: ['', 'That divides bytes by bits a second. Turn the bytes into bits first.', 'That reads the rate as the answer. Size ÷ rate is the sum to do, and the size is 16 million bits.', 'That is how many million bits there are, not how many seconds they take.'],
      },
    },
    {
      title: 'How long does it take?',
      body: `
        <p>A message waits for two separate things. Its bits must be <strong>pushed onto the line</strong>, one after another; that depends on the size and the rate. Then each bit must <strong>travel the distance</strong>, at about two thirds of the speed of light in a cable or a fibre: ${(travelTime(1e6) * 1e3).toFixed(0)} ms for every 1000 km.</p>
        <p>The two have nothing to do with each other. A faster link pushes faster and travels no faster at all, because the signal's speed is set by the material of the cable.</p>
        <div class="try">Send 1 KB from New York to London, about 5600 km. Raise the rate as far as it goes: the whole delay stops falling long before you reach the end of the slider. Then make the message 10 GB and watch the other part take over.</div>`,
      widget: delayWidget,
      challenge: {
        kind: 'quiz', question: `A game sends small messages to a server ${FAR / 1e6 * 1000} km away. Its players want the shortest delay. What helps most?`,
        options: [`A server nearer to them: at that distance each message spends ${fmtTime(travelTime(FAR))} travelling, whatever the link's rate`, 'A link ten times faster', 'Larger messages', 'Compressing the messages'],
        answer: 0,
        explain: `A 100-byte message takes ${fmtTime(pushTime(100, 1e8))} to push at 100 Mb/s and ${fmtTime(travelTime(FAR))} to travel. Only distance moves the larger number.`,
        why: ['', 'That shortens the part that was already tiny.', 'That lengthens the pushing, and the travelling stays.', 'That shortens the pushing, which is already small next to the travelling.'],
      },
    },
    {
      title: 'What fits on the line',
      body: `
        <p>Delay answers "how soon". <strong>Throughput</strong> answers "how much a second", and the two are different questions. Rate × travel time is how much is on the line at once: at 10 Gb/s to London, ${fmtBytes(onTheLine(1e10, LONDON))} is in the fibre, on its way, before the first byte arrives.</p>
        <p>That matters because a sender cannot forget what it sent until it hears that it arrived. A fast, long line needs a memory that large at the sender, however little data the program thinks it is sending. The chapter on <a href="#/c/tcp/0">TCP</a> is largely about this number.</p>
        <p>An old joke makes the point: never underestimate the bandwidth of a van full of disks. ${VAN_TB} TB driven ${VAN_KM} km takes ${VAN_H.toFixed(1)} hours; the same over a 10 Gb/s link takes ${LINK_H.toFixed(0)}. The van has enormous throughput and a terrible delay, and for a one-byte message it would still take ${VAN_H.toFixed(1)} hours.</p>
        <div class="try">Drive further until the link wins. Then take a rate and a distance you know, your home connection and a city far away, and read how much is on the line.</div>`,
      widget: pipeWidget,
      challenge: {
        kind: 'quiz', question: 'A link is upgraded from 1 Gb/s to 10 Gb/s, the same length. What happens to the amount of data on the line at once?',
        options: ['It is ten times as much: rate × travel time', 'It stays the same: the length has not changed', 'It is a tenth: the data leaves sooner', 'It depends only on the message size'],
        answer: 0,
        explain: 'Bits leave ten times as closely spaced and travel at the same speed, so ten times as many are in flight.',
        why: ['', 'The time on the line is unchanged, but ten times as many bits enter it in that time.', 'Each bit stays on the line just as long.', 'A long enough message fills the line, whatever its size beyond that.'],
      },
    },
    {
      title: 'Why messages are cut up',
      body: `
        <p>A network shares its lines among everybody using them, and the fair way to share is to take turns in small pieces. So a message is cut into <strong>packets</strong>, each with a <strong>header</strong> saying where it is going. A <em>switch</em>, a box that joins lines, receives a packet whole, checks it, and sends it on.</p>
        <p>Cutting costs headers, and it also saves time. One 1 MB message over ${BIG.hops} links at 10 Mb/s waits whole at every one: ${fmtTime(storeAndForward(BIG))}. In ${packetCount(CUT)} packets, each link is busy with the next packet while the first has moved on: ${fmtTime(storeAndForward(CUT))}.</p>
        <p>It also limits what an error costs. If one bit in a million flips, a 1 MB message almost never arrives clean, and sending it whole again and again costs thousands of times its size. Sent as 1000-byte packets, only the few that were hit go again: ${(bytesWithLoss(CUT, 1e-6) / 1e6).toFixed(2)} MB in all.</p>
        <div class="try">Slide the packet from small to large: the time falls, then climbs. Add links and the best size moves down. Raise the wrong bits and watch the bytes sent.</div>`,
      widget: packetWidget,
      challenge: {
        kind: 'quiz', question: 'Why does making packets very small eventually make the transfer slower?',
        options: ['Every packet carries a header, so more of what is sent is headers', 'Small packets travel more slowly', 'Links can only send so many packets', 'Small packets are more likely to be hit by an error'],
        answer: 0,
        explain: `With 40-byte headers, a packet of 20 data bytes is two thirds header: the link spends two thirds of its time on them.`,
        why: ['', 'Their bits move at the same speed as any others.', 'That is not what the sum here shows: the rate in bits a second is fixed, and the headers use it up.', 'A small packet is less likely to be hit, not more.'],
      },
    },
    {
      title: 'Layers',
      body: `
        <p>Nobody writes one program that knows about voltages, routes across the world and which browser tab wants the data. The job is split into <strong>layers</strong>, each using the one below as a service and adding a header of its own: an envelope inside an envelope.</p>
        <p><span data-ahead="tcp">TCP, in the program's computer, numbers the bytes so nothing is lost or out of order.</span> IP names the machine anywhere in the world. Ethernet names the next machine along this one cable and checks that its packet, which it calls a <em>frame</em>, came through. At each <em>hop</em>, each machine along the way, the outer envelope is opened and replaced, and the inner ones travel untouched.</p>
        <p>The layers can change independently, which is the whole point: the same web page crosses Wi-Fi, then fibre, then copper. The price is ${WIRE_OVERHEAD + 40} bytes on every packet, and a frame too short is padded to Ethernet's minimum. On a full frame that is ${(100 * (1 - full.share)).toFixed(1)} %; on a one-byte message it is nearly all of it.</p>
        <div class="try">Slide the data down to 1 byte and read what share of the wire is your data.</div>`,
      widget: layersWidget,
      challenge: {
        kind: 'quiz', question: 'A packet goes from a laptop through a router, the box that joins one network to the next, to a server. Which envelope does the router open and replace?',
        options: ['The outermost, Ethernet: it belongs to one cable and ends at the router', 'The innermost, the data', 'The innermost header, to check the bytes', 'None: routers only copy bits'],
        answer: 0,
        explain: 'Ethernet names the next machine on this cable, so each hop needs a new one. IP stays, because it names the far end. A router has no reason to read the header inside that.',
        why: ['', 'The data is for the program at the far end.', 'That one is between the two end machines; the router in the middle leaves it alone.', 'A router has to read IP to choose the next hop, and writes a new Ethernet header to reach it.'],
      },
    },
    {
      title: 'Decibels',
      body: `
        <p>Signals lose power along a line and gain it in amplifiers, and each stage multiplies. A long cable may leave one part in a million. Numbers like that are awkward, so engineers use their logarithm, the <strong>decibel</strong>: ratio in dB = 10 log₁₀(P₂ / P₁), where log₁₀ asks what power of ten a number is: log₁₀ 1000 = 3, so a ratio of 1000 is 30 dB.</p>
        <p>Then a chain adds up. Three facts carry most of the arithmetic: 10 dB is ten times, 3 dB is about twice (${dbToRatio(3).toFixed(2)}), and a negative number is a loss. <strong>dBm</strong> is a level, not a ratio: decibels above one milliwatt, so 0 dBm is 1 mW and 30 dBm is 1 W.</p>
        <p>Every later chapter that talks about noise or radio uses these. Think of it as doing the multiplications with the exponents.</p>
        <div class="try">Set the cable to −100 dB and read the power that arrives. Then add 10 dB anywhere in the chain: the order does not change the sum.</div>`,
      widget: decibelWidget,
      challenge: {
        kind: 'quiz', question: 'A transmitter puts out 20 dBm into a path that loses 90 dB. What arrives?',
        options: ['−70 dBm: 20 − 90, a ten-millionth of a milliwatt', '−1800 dBm: 20 × −90', '110 dBm: 20 + 90', '70 dBm: the sign of a loss does not matter'],
        answer: 0,
        explain: 'A level in dBm plus a gain in dB is a level in dBm. Add them.',
        why: ['', 'Multiplying logarithms has no meaning here.', 'A loss subtracts.', 'It does: 70 dBm would be ten kilowatts.'],
      },
    },
    {
      title: 'An estimate on one page',
      body: `
        <p>Put them together for a real case: a ${PHOTO / 1e6} MB photo to a server ${FAR / 1e6 * 1000} km away on a 100 Mb/s line. Pushing: ${fmtTime(pushTime(PHOTO, HOME))}. Travelling: ${fmtTime(travelTime(FAR))}. The whole: ${fmtTime(delayOf(PHOTO, HOME, FAR))}, nearly all of it pushing, so a faster line would help this one.</p>
        <p>Layers add ${(100 * (1 - full.share)).toFixed(0)} %. On the line at once: ${fmtBytes(onTheLine(HOME, FAR))}. Real transfers are slower than the sum: the reply must come back before the sender may send more, and other people are using the same links. Those are the subjects of the chapters on <a href="#/c/tcp/0">TCP</a> and <a href="#/c/path/0">the internet path</a>.</p>
        <p>From here, the chapters are denser and written for engineers. They start with a telegraph line (chapter ${numOf('telegraph')}) and climb: what a wire really does, clocks that disagree, a UART, the spectrum, modems, codes, Ethernet, a router, <span data-ahead="tcp">TCP, a reliable stream over packets</span>.</p>
        <div class="try">Set 5 MB at 100 Mb/s and 3000 km, then at 10 Gb/s. Which part did the upgrade remove?</div>`,
      widget: delayWidget,
      challenge: {
        kind: 'quiz', question: 'Which of these is limited by distance and not by the link\'s rate?',
        options: ['The time for a one-byte message and its reply', 'The time to send a 10 GB file on a slow line', 'The number of bytes a second a line can carry', 'The size of the header'],
        answer: 0,
        explain: 'A small message has almost nothing to push, so what remains is the trip there and back.',
        why: ['', 'That one is nearly all pushing, so the rate sets it.', 'That is the rate itself.', 'That is set by the layers\' formats.'],
      },
    },
  ],
};
