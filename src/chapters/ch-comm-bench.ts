// The expert's bench: given a symptom, find the cause. Each case is a real fault switched on in one of the book's models (comm/faults.ts,
// held to a healthy control by tests/comm-faults.test.ts); the chapter is the method for reading what comes out. Capstone 4 is the same view without the help.

import { ATTEMPT_CASES, PASS_MARK } from '../comm/faults';
import { benchWidget } from '../widgets/faultbench';
import { numOf } from './order';
import type { Chapter } from './types';

/** The console quiz: a clock error that moves only the last sample, and two characters it treats differently (tests/comm-faults.test.ts). */
export const UART_ERR = 0.065, SHOWN_FAILS = 0x55, SHOWN_SURVIVES = 0x31;
/** Steps this chapter points at (tests/chapter-guide.test.ts holds a link to a real step; the titles are checked in tests/comm-faults.test.ts). */
export const RADIO_BUDGET_STEP = 2, WIFI_HIDDEN_STEP = 3;

export const chBench: Chapter = {
  id: 'bench', num: numOf('bench'), title: 'The expert\'s bench', level: 'Communication',
  blurb: 'Given a symptom, find the cause: a method, then real faults injected into the book\'s own models, read from captures, eyes, counters and traces.',
  goals: [
    'turn a user\'s complaint into a question one piece of evidence can answer',
    'tell loss, a slow reader, a bloated queue and a small queue apart from a capture and two plots',
    'read an eye for band against noise, and a garbled console for clock error',
    'use Ethernet counters and a traceroute to place a fault in one network and on one link',
    'add up a radio link and tell a weak signal from two stations that cannot hear each other',
  ],
  builds: ['tcp', 'path', 'ethernet', 'switch', 'serial', 'uart', 'noise', 'radio', 'wifi', 'cellular', 'datacentre'],
  recap: {
    keep: [
      'Start from what is known and ask what would differ between the candidate causes. Look at the piece of evidence that separates them. Change one thing at a time.',
      'A slow transfer: retransmissions with the line\'s error counter climbing are loss; with the queue\'s drop counter climbing, a queue too small; zero windows are a slow reader; a climbing round trip with nothing lost is a bloated queue.',
      'A clean, thin eye that does not reach the rails has too little band. A wide open waveform with a fuzzy spread around it has noise.',
      'On a UART, errors that fall on a character\'s last bits, and depend on the character, are clock error, not noise.',
      'Collisions need a shared segment. Bad checks on a full-duplex link are the physical path (a duplex mismatch produces them too, so rule that out first). Frames for one machine going to every port are a table that has forgotten.',
      'A trace that ends in the wrong network is a routing lie. One that stops with no route is a route withdrawn.',
      'Retries on Wi-Fi with plenty of SNR, and frames overlapping at the access point, are stations hidden from each other. Retries with an SNR well below what it was and what the rate needs, and one station sending, are a budget that no longer adds up.',
    ],
    check: [
      {
        question: 'A transfer is slow. The capture shows no retransmissions, and the round trip has grown from 2 ms to 400 ms during the transfer. What do you look at next?',
        options: ['The buffers on the path: the data is waiting in a queue, not being lost', 'The cable: bits are being corrupted', 'The receiving program: it may not be reading', 'The server\'s disk'],
        answer: 0,
        explain: 'A round trip that grows with the bytes in flight, with nothing lost, is a queue filling. Nothing else on the list changes the round trip.',
        why: ['', 'Corrupted bits would be retransmissions, and there are none.', 'A slow reader closes the window and leaves the round trip alone.', 'A slow disk at the far end shows as a closing window, which would leave the round trip flat as well.'],
      },
      {
        question: 'A link\'s eye looks like clean thin traces that never reach the rails between bits. Which change is most likely to help?',
        options: ['Equalization or more band: the bits are shaped by the ones before them', 'A stronger transmitter: the noise is winning', 'A better clock', 'A larger buffer'],
        answer: 0,
        explain: 'Thin traces mean little noise. What closes this eye is intersymbol interference, and that is answered by flattening the channel.',
        why: ['', 'Thin traces show the noise is small. More power scales the interference with the signal.', 'Clock trouble smears the eye sideways. These traces are aligned.', 'A buffer works on packets. This fault is below the bit.'],
      },
      {
        question: 'Why does the method insist on changing one thing at a time?',
        options: ['Two changes at once leave you unable to say which one mattered, and a fault that went away that way can come back', 'Equipment can only be reconfigured once at a time', 'Changing two things always makes the fault worse', 'Faults only ever have one cause'],
        answer: 0,
        explain: 'Each change is an experiment. Keeping the experiment clean is what lets you trust the conclusion and the fix.',
        why: ['', 'Equipment is not the limit: the limit is what you can conclude.', 'It may well fix it. You just cannot say why.', 'Faults can have several causes, which is one more reason to separate them.'],
      },
    ],
  },
  steps: [
    {
      title: 'A method',
      body: `
        <p>This level has built a network piece by piece, from a bit on a wire to the data centre of chapter ${numOf('datacentre')}. This last chapter meets it the way an engineer usually does: broken, with only its symptoms to go on.</p>
        <p>Almost every report starts as "the network is slow". That sentence names no cause, and a guess at one is usually wrong, because the same complaint comes from a dozen different faults. An expert does not know the answer sooner. An expert asks a better question.</p>
        <p><strong>Say what is known.</strong> What is slow, compared with what? Since when? For whom, and for whom not? "One machine" and "everybody" point to different layers before anything is measured.</p>
        <p><strong>List what could cause it, then ask what would differ between them.</strong> Loss and a slow receiver both slow a transfer, but only loss retransmits. A piece of evidence is worth looking at only if it would come out differently for the candidates.</p>
        <p><strong>Look at the one that separates them,</strong> and when you test a fix, change one thing at a time. A fault that goes away after two changes is a fault you have not understood.</p>
        <p>Every case in this chapter is real in the sense the rest of the book is: the fault is switched on in one of the models or circuits you have already met, and what you see is what came out of it. Nothing is drawn by hand. The clocks are this book's, so read the shapes and ratios, not the units.</p>
        <div class="try">Read this case in the order above before choosing. Then press <strong>Same fault, other numbers</strong>: the numbers move and the shape stays.</div>`,
      widget: benchWidget(['tcp_loss'], ['A copy that crawls']),
      challenge: {
        kind: 'quiz', question: 'Someone reports "the file server is slow". What is the most useful first question?',
        options: ['Slow for everyone or for one machine, and since when?', 'Which cable does it use?', 'How much memory does the server have?', 'Have you tried restarting it?'],
        answer: 0,
        explain: 'Who and since when divide the possible causes before you measure anything. The others test one guess each.',
        why: ['', 'That tests one guess, before you know the fault is anywhere near a cable.', 'That tests one guess too, and memory is only one of many ways a server can be slow.', 'A restart can hide the evidence, and it teaches you nothing about the cause.'],
      },
    },
    {
      title: 'Four transfers that crawl',
      body: `
        <p>Here is the separation worked out for the commonest complaint. Four faults slow a transfer, and each leaves a different mark in the capture, in two plots (bytes in flight and the round-trip time) and in the counters.</p>
        <p>The sender's <strong>bytes in flight</strong> say whether it is held back at all. The <strong>round trip</strong> says whether data is waiting anywhere. <strong>Retransmissions</strong> say whether anything went missing, and the counters say where. <strong>Win 0</strong> in an acknowledgement is a window of zero, as in <a href="#/c/tcp/4">the window</a>: the receiver has no room and is asking for time. All of this comes from <a href="#/c/tcp/0">TCP</a>'s own rules, running with the fault in place.</p>
        <div class="try">For each case, say what you expect to see in the plots, the capture and the counters before you look at the options.</div>`,
      widget: benchWidget(['tcp_reader', 'tcp_bloat', 'tcp_tiny', 'tcp_loss'], ['Case A', 'Case B', 'Case C', 'Case D']),
      challenge: {
        kind: 'quiz', question: 'A capture shows retransmissions. Which further number tells line loss from a queue that is too small?',
        options: ['The drop counter on the queue, against the error counter on the line', 'The receiver\'s window', 'The size of the file', 'The time of day'],
        answer: 0,
        explain: 'Both lose packets, and a capture at the sender cannot see where. The devices on the path count their own drops and errors.',
        why: ['', 'The window is about the receiver. Both these faults leave it open.', 'Both faults slow any file.', 'Load varies with the time of day, and that alone does not say where packets went.'],
      },
    },
    {
      title: 'Reading an eye',
      body: `
        <p>Below the packets, a link's health is in its <a href="#/c/serial/5">eye diagram</a>. The shape separates the two usual faults. If every bit were affected only by noise, each trace would follow the same clean path and the spread around it would be the noise. If the channel is too narrow, the traces divide into many clean paths, one for each recent bit pattern, and that is <em>interference</em>.</p>
        <p>The remedies are different, so the distinction pays. More power does nothing for interference, because the interference scales with the signal. Equalization does nothing for noise, and usually makes it a little worse.</p>
        <div class="try">Look at each eye before reading the counters. Is the spread many thin lines, or one fuzzy band?</div>`,
      widget: benchWidget(['line_band', 'line_noise'], ['Eye A', 'Eye B']),
      challenge: {
        kind: 'quiz', question: 'Doubling the transmit power fixes a marginal link. What does that tell you about the fault?',
        options: ['It was mostly noise: interference would have grown with the signal', 'It was mostly interference', 'The clock was wrong', 'Nothing: power helps every fault'],
        answer: 0,
        explain: 'Noise is independent of the signal, so power raises the SNR. Interference is made of the signal itself, so its ratio stays where it was.',
        why: ['', 'Interference scales with the signal, so the ratio would not move.', 'A stronger signal does not change when the receiver samples it.', 'It does not: that is what makes the test informative.'],
      },
    },
    {
      title: 'Reading a console',
      body: `
        <p>A <a href="#/c/uart/0">UART</a> gives itself away differently. Each character starts on a falling edge, which resets the receiver's timing, and it then samples on its own clock. A clock error therefore builds across the character: the first bits are right, and the samples at the end go wrong first. Whether a data bit reads wrong depends on the data, since a sample that lands in a neighbouring bit is only an error if that bit differs. So some bytes read right and some do not, usually with framing errors around them.</p>
        <p>That is why a clock error looks odd: some characters come through with the right value. Noise would hit bits at random and spare no character on principle.</p>
        <div class="try">Find which characters survive. Compare the bits of one that did with one that did not: what do the survivors have in common?</div>`,
      widget: benchWidget(['uart_clock'], ['The console']),
      challenge: {
        kind: 'quiz', question: `A receiver runs ${UART_ERR * 100} % fast. The letter U (${SHOWN_FAILS.toString(2).padStart(8, '0')}) reads as the wrong byte, and the digit 1 (${SHOWN_SURVIVES.toString(2).padStart(8, '0')}) reads as the right one. Why?`,
        options: ['The sample of the last bit lands in the bit before it, and only U\'s top two bits differ', 'U is sent more slowly than other characters', 'U has no stop bit', 'Alternating bits pick up more noise'],
        answer: 0,
        explain: 'The drift is the same for every character. What differs is whether the bit it lands in has another value. So one test pattern proves little: send several.',
        why: ['', 'Every character takes the same time.', 'Every 8N1 character has a stop bit.', 'This case has no noise in it, and noise does not depend on the data.'],
      },
    },
    {
      title: 'Ethernet\'s counters',
      body: `
        <p>An Ethernet port counts what happens to it, and each counter points somewhere. <strong>Collisions</strong> need a shared segment, so on a properly negotiated switched port they read zero; a count there means a duplex mismatch (see the question). <strong>Frames failing the check</strong> were changed on the way, so the fault is physical: cable, connector, or interference. A duplex mismatch makes some too (the half-duplex end cuts frames short when it sees a collision), so rule that out first. <strong>Flooding</strong>, unicast frames sent to every port, is the switch saying it does not know where the address is.</p>
        <p>These are the <a href="#/c/ethernet/0">MAC</a> and the <a href="#/c/switch/0">switch</a> you have built, with the fault switched on: a heavy load on a shared segment, bits flipped on the wire and checked by the real CRC, and a table too small for its hosts.</p>
        <div class="try">Say which counter you would read first for each symptom, before you see the numbers.</div>`,
      widget: benchWidget(['eth_collide', 'eth_badframe', 'sw_flood'], ['Case A', 'Case B', 'Case C']),
      challenge: {
        kind: 'quiz', question: 'A switch port on a link that ought to be full duplex reports collisions. What does that suggest?',
        options: ['A duplex mismatch: this end has fallen back to half duplex, while the far end sends whenever it likes', 'The segment is overloaded', 'A cable is damaged', 'The table is too small'],
        answer: 0,
        explain: 'Full duplex has nobody to collide with and counts no collisions, so a count means this end is running half duplex and the two ends disagree. It is a classic: the link works, slowly, and worst under load.',
        why: ['', 'Full duplex has separate paths each way, so load cannot cause collisions on it.', 'Damage shows as bad checks.', 'A small table causes flooding.'],
      },
    },
    {
      title: 'Reading a trace',
      body: `
        <p><a href="#/c/path/3">Traceroute</a> shows where packets go, and two comparisons make it useful: with last week's trace, and with what the addresses ought to be. A trace that <em>ends in the wrong network</em> means a route is lying. A trace that <em>stops, with no route</em>, means a route has gone.</p>
        <p>In Case B the failed link is not rerouted, which may surprise you. Networks carry traffic only as their business relationships allow, so a working link nearby may not be offered to you. That is the model's policy from <a href="#/c/path/1">BGP</a> at work, and it is also why real networks buy a second provider.</p>
        <div class="try">Read the two traces side by side. Whose network does each end in?</div>`,
      widget: benchWidget(['route_hijack', 'route_down'], ['Case A', 'Case B']),
      challenge: {
        kind: 'quiz', question: 'A site is reachable from most of the world. From one region its traffic goes to an unrelated network and disappears. What do you suspect?',
        options: ['A more specific prefix announced from that region: longest match wins wherever it is heard', 'The site\'s server is down', 'A failed link at the site', 'A TTL set too low'],
        answer: 0,
        explain: 'Only routing explains a fault that depends on where you stand and ends elsewhere. A server or a link at the site would affect everyone, along the usual path.',
        why: ['', 'Most of the world still reaches it.', 'That would affect everyone reaching the site.', 'TTL would not send traffic into a different network.'],
      },
    },
    {
      title: 'Reading the air',
      body: `
        <p>A radio link has one complaint and many causes, because every one of them ends in retries. Two pieces of evidence separate most of them: the <a href="#/c/radio/${RADIO_BUDGET_STEP}">link budget</a>, which says what arrives, and a sniffer beside the receiver, which says who else was talking.</p>
        <p>Do the sum first. It takes a minute and needs no equipment: if the SNR falls short of what the rate asks, nothing above the radio can make it up, and all it can do is settle for a lower rate. If the SNR is ample and frames still die, the signal is not the problem, and the question becomes what else was in the air at the receiver. That is the <a href="#/c/wifi/${WIFI_HIDDEN_STEP}">hidden terminal</a>: carrier sense asks about the air at the sender, and the collision happens at the receiver. A station notices a frame down to about −82 dBm on a 20 MHz channel, the level 802.11 asks of its preamble detection, so a wall can put two stations below that and leave both well above what the access point needs.</p>
        <p>Both cases below have the same report: a refit put up new walls in the far office. A wall can do either, depending on what it stands between.</p>
        <div class="try">Read each budget before anything else. Does it explain the retries by itself?</div>`,
      widget: benchWidget(['wifi_hidden', 'link_wall'], ['Case A', 'Case B']),
      challenge: {
        kind: 'quiz', question: 'A laptop reaches its access point at 35 dB of SNR and still retries one frame in three. Nobody else is close to it. What do you look at next?',
        options: ['Who else the access point hears: a station out of the laptop\'s range can talk over it there', 'A higher-gain antenna on the laptop', 'A lower transmit rate', 'The laptop\'s transmit power'],
        answer: 0,
        explain: 'With that much SNR the budget is not the limit. Frames are being lost for some other reason, and carrier sense cannot show the laptop what is happening at the far end. Only the receiver hears both.',
        why: ['', 'It might happen to help, if it lets the other station hear this one, but it says nothing about what is wrong. The SNR is already ample, so first find out why frames die.', 'Lower rates need less SNR, and SNR is not what is short. A longer frame would be in the air longer, and collide more.', 'As with the antenna: it might mask the fault, and it would not tell you what the fault is.'],
      },
    },
    {
      title: 'Reading a specification',
      body: `
        <p>The other half of the expert's trade is the document that says what should have happened. Standards are written to be exact, not to teach, and they reward a particular way of reading. Keep a question in hand and look it up, as you would a dictionary. Learn the convention for requirement words (RFC 2119's <em>MUST</em>, <em>SHOULD</em> and <em>MAY</em>; IEEE standards say <em>shall</em>, <em>should</em> and <em>may</em>): it separates what you can rely on from what some implementations happen to do. Read the state tables and the frame formats before the prose.</p>
        <p>A surprising share of real faults sit in the gap between <em>must</em> and <em>should</em>, where two correct implementations disagree. When a capture shows something odd, the question is rarely "what does this mean?" and usually "which side is allowed to do this?". A fault that survives every other test often ends at a sentence in a specification and a choice someone made.</p>
        <p>Below is a case where one sentence of a specification is the whole clue. The Ethernet standard says a receiver discards a frame whose check fails, which is why nothing above the port ever hears of these frames and only its counter shows them. Knowing that tells you to read the counter and not the capture.</p>`,
      widget: benchWidget(['eth_badframe'], ['The port']),
      challenge: {
        kind: 'quiz', question: 'A standard says a receiver SHOULD accept an unusual option, and your device rejects it. A capture shows the link failing with one vendor. Is your device wrong?',
        options: ['Not strictly: SHOULD permits a reasoned exception, so this is an interoperability problem, and accepting the option is usually the practical fix', 'Yes: SHOULD means the same as MUST', 'No, and the other vendor is at fault', 'The standard does not apply to options'],
        answer: 0,
        explain: 'RFC 2119 defines SHOULD as a recommendation that may be ignored for valid reasons with the implications understood. Knowing that is half the conversation with the vendor.',
        why: ['', 'They are defined differently, and that difference is the point.', 'Sending the option is allowed, so the other vendor is not at fault either.', 'Nothing here exempts options.'],
      },
    },
    {
      title: 'On your own',
      body: `
        <p>That is the method, with help beside it. The test of it is <a href="#/campaign/play/cap_fault">Find the fault</a>: ${ATTEMPT_CASES} cases drawn at random from all of the above, with new numbers each time, and nothing said about any answer until the end. ${PASS_MARK} right passes. A wrong answer shows what the evidence meant once the attempt is over. The set is small enough to learn, and learning what each fault looks like is the point: the reports are worded alike, so it is the evidence that tells them apart.</p>
        <p>The cases draw only on faults the book's models can really produce. Real networks have many more: firmware bugs, other duplex and negotiation faults, a misconfigured load balancer, hardware that fails only when warm, and the faults of the last two chapters: handover ping-pong (<a href="#/c/cellular/3">Handing over</a>), a read that collapses into <a href="#/c/datacentre/2">incast</a>, a lossless network that <a href="#/c/datacentre/6">deadlocks</a>. The method is what carries over to them.</p>
        <p>When a case surprises you, go back to the chapter it came from: <a href="#/c/tcp/0">TCP</a>, <a href="#/c/serial/0">Fast serial links</a>, <a href="#/c/uart/0">A UART</a>, <a href="#/c/ethernet/0">Ethernet</a>, <a href="#/c/switch/0">A switch</a>, <a href="#/c/path/0">The internet path</a>, <a href="#/c/radio/0">Radio</a>, <a href="#/c/wifi/0">Wi-Fi</a>.</p>
        <p>That closes the Communication level. Every number in it came from a model computed in ordinary arithmetic. The next level asks what happens when the arithmetic itself is the thing that goes wrong: a sum that does not fit in its word, a rounding that drifts, and the machines that do it in gates.</p>
        <div class="try">Try one more before the test, and explain your answer aloud before you choose.</div>`,
      widget: benchWidget(['tcp_tiny', 'line_noise', 'route_down'], ['Case A', 'Case B', 'Case C']),
      challenge: {
        kind: 'quiz', question: 'You find a fix that makes the symptom go away, and you cannot explain why it worked. What now?',
        options: ['Keep looking: until you can say what was wrong, you do not know that it is fixed', 'Ship it: the symptom is gone', 'Undo it and hope', 'Add more fixes to be safe'],
        answer: 0,
        explain: 'A fix you cannot explain may have moved the fault, hidden it, or met a coincidence. Say why the evidence changed, and test that.',
        why: ['', 'The symptom may return, under load or next month.', 'Undoing it can be a useful experiment, and hoping is not one.', 'That makes the next diagnosis harder.'],
      },
    },
  ],
};
