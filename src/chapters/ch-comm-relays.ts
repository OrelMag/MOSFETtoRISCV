import { ITA2_UNITS, PARIS_UNITS, ita2Encode, morseEncode } from '../comm/codes';
import { bestClos, capacityAt, clos, crossbarCrosspoints, erlangB, foldedCrosspoints, meshWires, offered, trunksFor } from '../comm/exchange';
import { MARKED, dbToRatio, levelsSupported, nyquistBitRate, ratioToDb, shannon, snrNeeded } from '../comm/limits';
import { ITA2_START_STOP, UART_8N1, frameUnits, stopIndex, toleranceClosedForm } from '../comm/startstop';
import { CROSSBAR3, CROSSBAR_EXCHANGE, DIAL_COUNTER, DIAL_SELECTOR, telegraphChain } from '../lib/telegraph';
import { PULL_I, PULL_V, bitEnergy, loopCurrent, margin, ohmsPerKm, reachKm, repeaterDelayMs } from '../phys/telegraph';
import { RELAY_STEP_MS } from '../phys/relay';
import { groupDigits } from '../sim/numfmt';
import { FF_DRIVER, FF_INPUT, FF_WIRE } from '../sim/netcap';
import { VDD, energyFj } from '../sim/power';
import { stats } from '../sim/stats';
import { PS_PER_NAND } from '../sim/timing';
import { strowger3d } from '../widgets/strowger3d';
import { telegraph3d } from '../widgets/telegraph3d';
import { withModel } from '../widgets/modelhost';
import { codesWidget, limitsWidget, telegraphLineWidget } from '../widgets/comm';
import { erlangWidget, meshWidget, networkCostWidget, startStopWidget } from '../widgets/exchange';
import type { Chapter } from './types';
import { numOf } from './order';

const thin = (n: number) => groupDigits(Math.round(n));
const f1 = (x: number) => x.toFixed(1);
const f0 = (x: number) => x.toFixed(0);
const mA = (i: number) => f1(1e3 * i);

// ---- chapter 39: numbers computed here; the ones typed in the text are pinned by tests/content-comms.test.ts

/** A NAND output toggling one NAND input over a short wire, ½ C V² (fJ): the repo's illustrative 28 nm-class numbers. */
const NAND_C = FF_INPUT + FF_WIRE + FF_DRIVER;
const NAND_FJ = energyFj(NAND_C);
/** A bit on a long telegraph line: 60 V on 100 km of iron wire at 50 baud, the key down for the whole 20 ms. */
const TG = { V: 60, km: 100, baud: 50 };
const TG_MS = 1000 / TG.baud;
const TG_I = loopCurrent(TG.V, TG.km, 'iron');
const TG_J = bitEnergy(TG.V, TG_I, TG_MS);
const TG_EXP = Math.round(Math.log10(TG_J / (NAND_FJ * 1e-15)));
const TG_SLOW = (TG_MS * 1e-3) / (PS_PER_NAND * 1e-12);
/** The quiz line: 150 km of iron wire on a 48 V battery, with and without a repeater half way. */
const QZ = { km: 150, V: 48 };
/** The relay of the previous chapters releases faster than it operates (ch-relays.ts, pinned there). */
const RELEASE_MS = 3.4;
const SHRINK_MS = RELAY_STEP_MS - RELEASE_MS;
const V34 = MARKED.find((m) => m.name === 'V.34 modem')!;
const V34_ETA = V34.rate / V34.B;
const TONE = { B: 3100, db: 30 };

const LADDER: [number, string][] = [
  [39, 'Two machines, one wire'], [40, 'The telephone exchange'], [41, 'A wire is not a wire'], [42, 'Crossing clocks'], [43, 'A UART'],
  [44, 'SPI and I²C'], [numOf('modem'), 'Modems'], [numOf('serial'), 'Fast serial links'], [numOf('errors'), 'When bits go wrong'], [numOf('ethernet'), 'Ethernet'], [numOf('switch'), 'A switch'],
  [numOf('network'), 'Computers on a network'], [numOf('router'), 'A router'], [numOf('tcp'), 'TCP'], [numOf('path'), 'The internet path'],
];
/** The five questions, with where the track answers each (chapter numbers). */
const QUESTIONS: [string, string, number[]][] = [
  ['What is a bit on the wire?', 'a voltage, a current, a tone: levels, and what the line does to them', [41, numOf('modem'), numOf('serial')]],
  ['When do I look at it?', 'sampling instants: a start edge, a recovered clock, a synchronizer', [40, 42, 43, numOf('serial')]],
  ['Where does a message start?', 'a start bit, a preamble, a frame delimiter', [40, 43, numOf('ethernet')]],
  ['How do I know it is right?', 'parity, checksums, CRC, ECC, retransmission', [numOf('errors'), numOf('tcp')]],
  ['Who may talk?', 'a circuit, an arbiter, a collision rule, an address, a route', [40, 44, numOf('ethernet'), numOf('switch'), numOf('router')]],
];

export const chTelegraph: Chapter = {
  id: 'telegraph', num: numOf('telegraph'), title: 'Two machines, one wire', level: 'Communication',
  blurb: 'Why moving a bit is harder than computing one: a telegraph line, the relay that repeats it, and the limits Nyquist and Shannon set.',
  goals: [
    'say why a long line needs a repeater, and compute its reach from battery, wire and coil',
    'compare Morse and ITA2 on one time axis, and say what a frame buys',
    'tell symbol rate from bit rate, and apply Nyquist and Shannon to a channel of given bandwidth and noise',
    'name the five questions every link answers, and where this track answers each',
  ],
  builds: ['relays', 'bus'],
  recap: {
    keep: [
      `A telegraph loop is a battery, a wire and a coil in series: the coil pulls in when V / (R<sub>line</sub> + R<sub>coil</sub>) reaches its pull-in current (${mA(PULL_I)} mA for our relay). On 4 mm iron wire (${f1(ohmsPerKm('iron'))} Ω/km) a 24 V battery reaches ${f0(reachKm(24, 'iron'))} km; copper (${f1(ohmsPerKm('copper'))} Ω/km) reaches ${f0(reachKm(24, 'copper'))} km.`,
      `A relay repeater regenerates: the weak line current closes a contact on a fresh battery. Reach adds section by section; each station costs a relay step (${RELAY_STEP_MS} ms) and, because the relay releases faster than it operates, shortens each pulse by about ${f1(SHRINK_MS)} ms.`,
      `Morse is a variable-length code read by its gaps (dot 1, dash 3, gaps 1 / 3 / 7 units; PARIS and a word gap are ${PARIS_UNITS} units). ITA2 is five bits in a frame of ${ITA2_UNITS} units (start 1, stop 1.5) that a motor can find alone. The frame costs ${f0(100 * (1 - 5 / ITA2_UNITS))} % of the line's time.`,
      'Baud is symbols a second; bit/s is baud × log<sub>2</sub> M. Nyquist: a channel of bandwidth B carries at most 2B symbols a second. Shannon: with noise, no more than B log<sub>2</sub>(1 + SNR) bit/s, whatever the code; M levels need SNR ≥ M² − 1.',
      'Every link answers five questions: what a bit is on the wire, when to look, where a message starts, how to know it is right, and who may talk. The next chapters take them in turn.',
    ],
    check: [
      {
        question: `A relay needs ${mA(PULL_I)} mA in its ${f0(PULL_V / PULL_I)} Ω coil. The 24 V battery drives a 40 km iron line. What happens?`,
        options: ['The sounder never moves: the current falls short', `It moves: 24 V is far above the coil's pull-in voltage`, 'It moves, slowly'],
        answer: 0,
        explain: `The wire is ${f0(ohmsPerKm('iron') * 40)} Ω, so the loop current is ${mA(loopCurrent(24, 40, 'iron'))} mA against ${mA(PULL_I)} mA. The coil needs a current, not a voltage: the line's resistance eats the battery.`,
        why: ['', `The pull-in voltage is across the coil alone. The wire takes most of the 24 V first: the coil sees ${f1(loopCurrent(24, 40, 'iron') * (PULL_V / PULL_I))} V.`, 'Below its pull-in current the armature does not move at all; a weak pull is not a slow one.'],
      },
      {
        question: 'A modem sends 16 levels at 2 400 baud. What bit rate is that, and which limit says how much bandwidth it needs?',
        options: ['9.6 kb/s; Nyquist, at least 1.2 kHz', '2.4 kb/s; Shannon', '38.4 kb/s; Nyquist, at least 4.8 kHz'],
        answer: 0,
        explain: `Four bits a symbol: 2 400 × 4 = 9 600 b/s. Nyquist bounds the symbol rate by 2B, so B ≥ 1 200 Hz. Shannon adds the SNR that 16 levels need: ${f1(ratioToDb(16 * 16 - 1))} dB.`,
        why: ['', 'Baud counts symbols, not bits. Each of 16 levels carries log<sub>2</sub> 16 = 4 bits.', 'That multiplies by 16 instead of by log<sub>2</sub> 16, and 2B ≥ 2 400 gives 1.2 kHz, not 4.8.'],
      },
      {
        question: `A line of ${groupDigits(TONE.B)} Hz and ${TONE.db} dB SNR. Shannon's limit is about:`,
        options: [`${f1(shannon(TONE.B, dbToRatio(TONE.db)) / 1e3)} kb/s, whatever the modulation`, `${f1(nyquistBitRate(TONE.B, 2) / 1e3)} kb/s, the Nyquist rate`, 'Unbounded: add levels'],
        answer: 0,
        explain: `${groupDigits(TONE.B)} × log<sub>2</sub>(1 + ${f0(dbToRatio(TONE.db))}) = ${f1(shannon(TONE.B, dbToRatio(TONE.db)) / 1e3)} kb/s. More levels run into the noise: the symbols blur together.`,
        why: ['', 'Two levels give 2B log<sub>2</sub> 2 = 2B only if the noise lets two levels through; the limit here is higher, because 30 dB supports many more.', 'Past √(1 + SNR) levels the symbols overlap in noise, and the errors cost more than the extra bits gain.'],
      },
    ],
  },
  steps: [
    {
      title: 'Moving a bit',
      body: `
        <p>Chapters 1 to 38 move a bit a few hundred micrometres, in a few gate delays. A NAND output that flips
        its fan-out charges about ${NAND_C.toFixed(1)} fF to ${VDD} V: ½ C V² = ${NAND_FJ.toFixed(2)} fJ, in ${PS_PER_NAND} ps. The same bit as one ${f0(TG_MS)} ms dot on a
        ${TG.km} km telegraph line, with the key closed for the whole dot, takes ${TG.V} V × ${mA(TG_I)} mA × ${f0(TG_MS)} ms = ${f0(TG_J * 1e3)} mJ: some
        10<sup>${TG_EXP}</sup> times the energy, and ${thin(TG_SLOW / 1e6)} million times as long. The comparison is unfair to the telegraph, which has no
        reason to be frugal, but it fixes the scale of the problem. Computing is local: the bit already is a voltage next to the gate that reads it. A
        message has to become something that survives a distance, and the other end must find it, recognize where it starts, and trust it.</p>
        <p>Every link in this track answers five questions, whatever it is made of:</p>
        <ol class="five">${QUESTIONS.map((q) => `<li><strong>${q[0]}</strong> ${q[1]}. <span class="where">Chapter ${q[2].join(', ')}.</span></li>`).join('')}</ol>
        <p>The track starts where the problem started: a key, a battery and a wire, then the relay that was devised to repeat a weak signal, then the
        two limits that cap any such line. It ends with one packet crossing a network of routers, each of which you can open down to a MOSFET. Each chapter uses only what is
        below it.</p>`,
      more: {
        derive: `<p>The NAND figure is this site's wire-load model (<code>sim/netcap.ts</code>): ${FF_INPUT} fF for the input driven, ${FF_DRIVER} fF for the driver's own drains and ${FF_WIRE} fF of wire,
          ${NAND_C.toFixed(1)} fF in all, at ${VDD} V. The telegraph figure is the loop of the next step: ${TG.V} V across ${f0(ohmsPerKm('iron') * TG.km)} Ω of wire and the relay's 400 Ω coil. Neither is a measurement; they are the same kind of
          estimate on both sides, which is what makes the ratio worth reading as an order of magnitude and no more.</p>`,
        pitfall: `<p>Reading "harder" as "slower". Time is part of it (a relay step is ${RELAY_STEP_MS} ms, a NAND delay ${PS_PER_NAND} ps), but the cost that never goes away is
          <em>agreement</em>: two machines with their own clocks, their own noise and no shared state must still decide the same bit. That is what the five questions are about.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'Which of the five questions does a parity bit or a CRC answer?',
        options: ['How do I know it is right?', 'When do I look at it?', 'Who may talk?', 'Where does a message start?'], answer: 0,
        explain: 'A check adds redundancy, so the receiver can tell a damaged message from a good one. Sampling, framing and access are the other questions, and each has its own mechanism.',
        why: ['', 'Sampling instants come from a clock or a start edge. A check says nothing about timing.', 'Access is about several senders sharing one medium: arbitration, collision rules, addresses.', 'A start bit, a preamble or a delimiter marks the start. A check comes after the message and tests what arrived.'],
      },
    },
    {
      title: 'A line that fades',
      body: `
        <p>A telegraph is the simplest link there is: a <strong>key</strong> at one end closes a circuit through a <strong>battery</strong> and a long wire to a
        <strong>sounder</strong> or relay coil at the other, and the earth returns the current. One loop, in series, so
        I = V / (R<sub>line</sub> + R<sub>coil</sub>). The coil pulls in only above its pull-in current: our relay (a coil that moves a contact, the telephone relay of <a href="#/c/relays/0">prologue P1</a>) needs
        ${PULL_V.toFixed(1)} V across its 400 Ω, ${mA(PULL_I)} mA. It is a current threshold, so the wire matters: 4 mm iron wire is ${f1(ohmsPerKm('iron'))} Ω/km, copper ${f1(ohmsPerKm('copper'))} Ω/km.</p>
        <p>At 24 V the loop reaches ${f0(reachKm(24, 'iron'))} km on iron before the current falls under ${mA(PULL_I)} mA, ${f0(reachKm(24, 'copper'))} km on copper. The reach grows linearly with the battery: ${f0(reachKm(240, 'iron'))} km on iron at
        240 V, the voltage of some two hundred cells in series. Beyond that the insulation leaks and the battery becomes the bill. The curve plots the loop current against the route length;
        the grey line is the other metal. Add a repeater and every section starts again from a fresh battery.</p>
        <div class="try">Set 150 km of iron on 48 V, and watch the current fall under the pull-in line. Add one repeater.</div>`,
      widget: () => withModel(telegraphLineWidget(), telegraph3d()),
      more: {
        derive: `<p>The coil's pull-in current is ${mA(PULL_I)} mA = ${PULL_V.toFixed(2)} V / 400 Ω (the force balance of <code>phys/relay.ts</code>). With r Ω/km of wire, the reach of one section is
          (V / I<sub>pull</sub> − R<sub>coil</sub>) / r. For iron at 24 V: (${f0(24 / PULL_I)} − 400) / ${f1(ohmsPerKm('iron'))} = ${f0(reachKm(24, 'iron'))} km. Resistance per km is ρ / A with ρ = 1.0 × 10<sup>−7</sup> Ω·m for iron
          and 1.68 × 10<sup>−8</sup> for copper over a 4 mm wire; telegraph iron was impure, so ρ is a round figure.</p>`,
        pitfall: `<p>Treating the battery voltage as the signal. The relay does not read a voltage; it needs ${mA(PULL_I)} mA, and a longer line only changes how much of the battery is left over for the coil. Real telegraph relays
          were wound for far smaller currents than our telephone relay, so the real reach was longer than the one drawn here: the curve is a model, not a museum label.</p>`,
        real: `<p>Practical lines also lost current by leakage across insulators in wet weather, a loss that grows with the length of the line and is not in this model. The line's resistance and capacitance round the
          pulses too, which limits speed as the series resistance limits reach; chapter 41 comes back to a wire's RC.</p>`,
      },
      challenge: {
        kind: 'quiz', question: `${QZ.km} km of iron wire, a ${QZ.V} V battery and one relay at the far end. The sounder:`,
        options: [`does not move: ${mA(loopCurrent(QZ.V, QZ.km, 'iron'))} mA against the ${mA(PULL_I)} mA it needs`, 'moves, but weakly', `moves: ${QZ.V} V is more than the ${PULL_V.toFixed(1)} V pull-in`],
        answer: 0,
        explain: `The wire alone is ${f0(ohmsPerKm('iron') * QZ.km)} Ω. With the 400 Ω coil that is ${mA(loopCurrent(QZ.V, QZ.km, 'iron'))} mA. One repeater half way makes two ${QZ.km / 2} km sections of ${mA(loopCurrent(QZ.V, QZ.km / 2, 'iron'))} mA each, ${margin(QZ.V, QZ.km / 2, 'iron').toFixed(2)} times the pull-in.`,
        why: ['', 'An armature either pulls in or it does not: below the pull-in current the magnet is too weak to overcome the spring at all.', `The pull-in voltage applies to the coil alone. By Ohm's law the coil only sees its share of the battery once the wire has taken its own.`],
      },
    },
    {
      title: 'The relay as a repeater',
      body: `
        <p>The relay was devised for exactly this. A weak current from the line operates <span data-show="st0">a relay</span>, and the relay's make contact closes a
        circuit of its own: a local battery onto the next line. The sounder, or the next station, sees a full-strength copy. Relays were on telegraph lines in the telegraph's early decades; Joseph Henry's electromagnets and Edward Davy's relay are the names usually attached to the idea.</p>
        <p>This is the first <strong>regenerator</strong>: the output has no memory of how weak or noisy the input was, only of whether it crossed the threshold.
        It is what a gate does to a level (<a href="#/c/inverter/0">chapter 2</a>), done with an armature. Here a chain of ${stats(telegraphChain(3)).relays} stations: <span data-show="st0 st1 st2">key to sounder</span> through
        three relays, each on a battery of its own. The cost is time: the signal crosses one relay step per station, ${RELAY_STEP_MS} ms with our relay, so the sounder follows the key 3
        steps later, the status line's <em>settled in 3 relay steps</em>.</p>
        <div class="try">Press the key and count steps to the sounder. Then release it.</div>`,
      scene: () => ({ root: telegraphChain(3), inputs: { key: 0 }, animate: true }),
      tour: {
        beats: [
          { title: 'Key up', set: { key: 0 }, show: ['st0', 'st1', 'st2'], expect: { sounder: 0 },
            say: '<p>No current in any loop: three relays released, three batteries behind open make contacts. The sounder reads {v:sounder}.</p>' },
          { title: 'Key down', set: { key: 1 }, show: ['st0'], expect: { sounder: 1 },
            say: `<p>The key closes the first loop. Its relay operates one relay step later and puts its own battery on the second line, whose relay operates one step after that, and so on: the sounder reads {v:sounder} three steps after the key, ${f1(3 * RELAY_STEP_MS)} ms later with our relay.</p>` },
          { title: 'Key up again', set: { key: 0 }, show: ['st2'], expect: { sounder: 0 },
            say: '<p>The release travels the same way. Each relay re-sends what it saw, a step late; a dot arrives as a dot of about that length, shorter by a little at every station.</p>' },
        ],
      },
      more: {
        derive: `<p>n stations in a row are n relay steps from key to sounder: ${repeaterDelayMs(3).toFixed(1)} ms for three, ${repeaterDelayMs(8).toFixed(1)} ms for eight. At 50 baud one bit is ${f0(TG_MS)} ms, so a few repeaters add a fraction of a bit
          of latency. The harder limit is distortion: our relay settles in ${RELAY_STEP_MS} ms on the way in and releases in ${RELEASE_MS} ms on the way out, so each station ends a pulse ${f1(SHRINK_MS)} ms before it would
          have been timed to, and a ${f0(TG_MS)} ms dot loses ${f1(SHRINK_MS)} ms at every station until nothing is left after ${Math.ceil(TG_MS / SHRINK_MS)}. Real repeaters biased their relays to balance the two times.</p>`,
        pitfall: `<p>Calling a relay an amplifier. It has no gain curve: the contact is open or closed, and the output is the same whatever the input current was above its threshold. A repeater therefore restores a signal
          that was merely <em>weak</em>; one that was <em>wrong</em> (a pulse stretched, shortened or inverted by noise) is repeated wrongly, at full strength.</p>`,
        real: `<p>The same part switched a telephone call a century later: <a href="#/c/exchange/0">the next chapter</a> builds an exchange from nothing but relay contacts. <a href="#/c/wire/0">Chapter 41</a> returns to repeaters on a chip's wire.</p>`,
      },
      tries: [(st) => st.value('sounder') === 1],
      challenge: {
        kind: 'quiz', question: 'Key to sounder through 3 repeater relays: how many relay steps pass between the key moving and the sounder moving?',
        options: ['3', '1', '6'], answer: 0,
        explain: 'Each relay waits for the one before it to move its contact. The line itself adds nothing in this model; the relays add one step each.',
        why: ['', 'One step is a single station. The signal has to cross all three, one after the other.', 'A relay needs one step to operate. Releasing happens in the same count: the front of a change moves one relay per step in either direction.'],
      },
    },
    {
      title: 'Morse against Baudot',
      body: `
        <p>A line carries on and off. The code is what the two ends agree an on-off pattern means. <strong>Morse</strong>'s code (the International Morse used today differs from the code Morse and Vail first used) is made of dots and dashes: a
        dot is one unit of key-down time, a dash three, with one unit of silence inside a letter, three between letters and seven between words. It is a variable-length code: E is a dot, Q is
        dash dash dot dash. The receiver finds the letter boundaries from the gaps, which is why it needs a trained ear, or at least a good clock. PARIS and the word gap after it come to ${PARIS_UNITS} units, which is how
        words a minute are defined.</p>
        <p>Émile Baudot's five-unit code, rearranged by Donald Murray, became <strong>ITA2</strong>: every character is five bits, 32 codes, with two <em>shift</em> codes (letters, figures) to double the set. Every character travels in a
        <em>frame</em>: a start unit of 0, the five bits (bit 1 first), a stop of 1.5 units of 1: ${ITA2_UNITS} units a character, and a motor with a cam can find its start. The line idles at 1 (current on), so the start of a character is
        the line falling: two of the five questions, <em>where does it start</em> and <em>when do I look</em>, answered with one extra bit. The two most common letters, E and T, and the space have a single 1
        each, and the same payoff recurs: spend the short codes on the frequent symbols. Type below.</p>
        <div class="try">Type a sentence with digits and compare the two lengths. Where does ITA2 pay for its shift codes?</div>`,
      widget: () => codesWidget(),
      more: {
        derive: `<p>Morse: a letter's time is the sum of its elements (1 or 3) and the one-unit gaps between them; the letter gap is 3 and the word gap 7. PARIS: P ${morseEncode('P').units}, A ${morseEncode('A').units}, R ${morseEncode('R').units}, I ${morseEncode('I').units}, S ${morseEncode('S').units} = ${morseEncode('PARIS').units - 12} units
          of letters, 4 letter gaps of 3 and a word gap of 7: ${PARIS_UNITS}. ITA2 sends the same six characters (five letters and the space) in ${ita2Encode('PARIS ').codes.length} × ${ITA2_UNITS} = ${ita2Encode('PARIS ').units} units at no shift. Of those ${ITA2_UNITS} units only 5 carry data:
          ${f0(100 * 5 / ITA2_UNITS)} % efficiency, the price of a frame that needs no ear.</p>`,
        pitfall: `<p>Comparing the two at the same unit and calling the shorter one faster. Morse's unit is a human's, and its gaps are part of the information; ITA2's is a machine's, and its framing is not. The
          unit time in the widget is the same for both only to make the tapes comparable.</p>`,
      },
      challenge: {
        kind: 'quiz', question: `How long do PARIS and a space take in ITA2, in units, against the ${PARIS_UNITS} of Morse?`,
        options: [`${ita2Encode('PARIS ').units}: six characters of ${ITA2_UNITS} units`, `${5 * 6}: five bits a character`, `${ita2Encode('PARIS ').units + 15}: a shift before every letter`],
        answer: 0,
        explain: `Letters, a space and no figures: no shift code is sent. Six frames of start, five bits and stop 1.5 are ${ita2Encode('PARIS ').units} units, a little under Morse's ${PARIS_UNITS}.`,
        why: ['', 'That counts the data bits only. The start and stop units are on the line too: 7.5 units a character.', 'A shift is sent only when the case changes, and PARIS is all letters.'],
      },
    },
    {
      title: 'Nyquist: symbols a second',
      body: `
        <p>How fast can a line carry the pattern? A channel of bandwidth B cannot carry more than <strong>2B</strong> independent symbols a second: faster, and the symbols run into each other (Harry Nyquist worked this out for telegraph
        channels in 1928; Ralph Hartley published a related result the same year). So the telegraph's 50 baud needs 25 Hz of bandwidth at least. <strong>Baud</strong> counts symbols; the bit rate is baud × log<sub>2</sub> M for M distinct
        levels, so 4 levels double the rate on the same wire.</p>
        <p>Framing eats some: ITA2 carries 5 data bits in ${ITA2_UNITS} units, so 50 baud is ${f1(50 * 5 / ITA2_UNITS)} bit/s of text. On a voice channel of ${groupDigits(TONE.B)} Hz Nyquist allows ${groupDigits(2 * TONE.B)} symbols a second:
        two levels give ${f1(nyquistBitRate(TONE.B, 2) / 1e3)} kb/s, 16 levels ${f1(nyquistBitRate(TONE.B, 16) / 1e3)} kb/s. With no noise there is no end to adding levels. The last column of the table, the SNR a given level count will need, is the next step.</p>`,
      widget: () => limitsWidget(false),
      more: {
        derive: `<p>2B comes from the Fourier pair: a signal limited to bandwidth B has 2B degrees of freedom a second, so 2B numbers a second can be sent and recovered with no interference between them at the sampling instants. A sinc pulse spaced 1 / 2B apart does it, the ideal case, with a
          price in how exactly the timing must be kept.</p>`,
        pitfall: `<p>"Baud" and "bit/s" used for each other. A 9 600 bit/s modem at 2 400 baud sends 16 levels (4 bits a symbol); calling it a 9 600 baud modem demands four times the bandwidth.</p>`,
      },
      challenge: {
        kind: 'quiz', question: `A ${groupDigits(TONE.B)} Hz voice channel carries 16-level symbols at the Nyquist limit. The bit rate is:`,
        options: [`${f1(nyquistBitRate(TONE.B, 16) / 1e3)} kb/s`, `${f1(nyquistBitRate(TONE.B, 2) / 1e3)} kb/s`, `${f1(TONE.B * 16 / 1e3)} kb/s`],
        answer: 0,
        explain: `2B = ${groupDigits(2 * TONE.B)} symbols a second, 4 bits each (log<sub>2</sub> 16): ${groupDigits(nyquistBitRate(TONE.B, 16))} b/s.`,
        why: ['', 'That is two levels, one bit a symbol.', 'The bit count grows as log<sub>2</sub> M, not M, and the symbol rate is 2B, not B.'],
      },
    },
    {
      title: 'Shannon: what noise leaves',
      body: `
        <p>Nyquist ignores noise. Claude Shannon's 1948 theorem puts it in: a channel of bandwidth B and signal-to-noise power ratio SNR carries at most <strong>C = B log<sub>2</sub>(1 + SNR)</strong> bit/s with
        errors as rare as you like, given a good enough code, and no more than that with any code. Setting 2B log<sub>2</sub> M equal to B log<sub>2</sub>(1 + SNR) gives <strong>M = √(1 + SNR)</strong>:
        the number of levels the noise leaves distinguishable. On ${groupDigits(TONE.B)} Hz at ${TONE.db} dB (${f0(dbToRatio(TONE.db))} ×) that is ${levelsSupported(dbToRatio(TONE.db)).toFixed(1)} levels and
        ${f1(shannon(TONE.B, dbToRatio(TONE.db)) / 1e3)} kb/s.</p>
        <p>The marked lines are systems with published rates. The V.34 voice modem, ${(V34.rate / 1e3).toFixed(1)} kb/s on about ${f1(V34.B / 1e3)} kHz of telephone channel, is ${V34_ETA.toFixed(1)} bit/s per hertz, so by Shannon's theorem that line had at least
        ${f0(ratioToDb(snrNeeded(V34_ETA)))} dB of SNR (assuming that bandwidth). The theorem says a code exists and not what it is: closing the gap to the limit took the error-correcting codes of chapter ${numOf('errors')} and
        decades of work.</p>
        <div class="try">Hold the bandwidth, raise the levels and find the SNR at which they fit. Then drop the SNR by 10 dB.</div>`,
      widget: () => limitsWidget(true),
      more: {
        derive: `<p>With signal power S and noise power N, a receiver distinguishes levels about √N apart when the signal spans √(S + N): M ≈ √(1 + S/N), which with Nyquist's 2B symbols a second gives Shannon's formula; the theorem is
          the careful version, with a coding argument behind it. Normalizing per hertz, a spectral efficiency of η bit/s/Hz needs SNR = 2<sup>η</sup> − 1, and the energy per bit then has a floor: E<sub>b</sub>/N<sub>0</sub> ≥ ln 2, −1.59 dB, however much
          bandwidth is spent.</p>`,
        pitfall: `<p>Reading the capacity as what one scheme reaches. It is the best any scheme can do; real modems stay a margin under it, and the margin costs more as SNR falls. The marked lines give each system a bandwidth equal to half its symbol rate, the
          Nyquist minimum; a real cable carries more than that, so the true spectral efficiency of the Gigabit Ethernet line (2 bits a symbol at 125 Mbaud on each of four pairs) is lower than the line drawn, and so is the SNR it needs.</p>`,
      },
      challenge: {
        kind: 'quiz', question: `${groupDigits(TONE.B)} Hz at ${TONE.db} dB: how many levels does the noise leave?`,
        options: [`about ${f0(levelsSupported(dbToRatio(TONE.db)))}: √(1 + ${f0(dbToRatio(TONE.db))})`, `about ${f0(dbToRatio(TONE.db))}: the SNR itself`, 'two: the noise allows a bit'],
        answer: 0,
        explain: `M = √(1 + SNR) = ${levelsSupported(dbToRatio(TONE.db)).toFixed(1)}: the point where Nyquist's 2B log<sub>2</sub> M meets Shannon's B log<sub>2</sub>(1 + SNR). That is ${f1(Math.log2(levelsSupported(dbToRatio(TONE.db))))} bits a symbol.`,
        why: ['', 'The SNR is a power ratio; amplitudes go as its square root, and levels are amplitudes.', 'Two levels is the lower bound for a bit, not the limit. A 30 dB channel is far cleaner than that.'],
      },
    },
    {
      title: 'The rest of the track',
      body: `
        <p>A key and a sounder answer the five questions with a human in the loop: the operator hears the pattern, finds the letters and decides who sends. The rest of the track asks what a machine needs instead, one rung at a time, each built from
        the ones below it, up to <span data-ahead="tcp">TCP, a reliable stream over packets that may not arrive</span>, and <span data-ahead="internetpath">the internet path, one packet's whole journey across networks</span>:</p>
        <table class="mini ladder"><tr><th>Chapter</th><th>Title</th></tr>${LADDER.map(([n, t]) => `<tr><td>${n}</td><td>${t}</td></tr>`).join('')}</table>
        <p>And the questions, with where each is answered:</p>
        <table class="mini ladder"><tr><th>Question</th><th>Chapters</th></tr>${QUESTIONS.map((q) => `<tr><td>${q[0]}</td><td>${q[2].join(', ')}</td></tr>`).join('')}</table>
        <p>The next chapter takes the relay from a repeater to a telephone exchange, where a question comes up that a point-to-point line never has: many senders, many receivers, and a switch that makes the path.</p>`,
      challenge: {
        kind: 'quiz', question: 'A stop unit after each character is the answer to which of the five questions?',
        options: ['Where does a message start (and when do I look)?', 'How do I know it is right?', 'Who may talk?'], answer: 0,
        explain: 'The stop unit returns the line to 1, so the next start edge is a fall and not just more 0s: it restores the idle level that frames the next character.',
        why: ['', 'A stop unit is not a check on the data; a parity bit or a CRC does that.', 'Nothing in a frame arbitrates between senders.'],
      },
    },
  ],
};

// ---- chapter 40

const CTR = stats(DIAL_COUNTER), SEL = stats(DIAL_SELECTOR), XB = stats(CROSSBAR3);
const BEST = bestClos(1024);
const CLOS36 = clos(36, 3, 5)!;
const SS = { ita2: toleranceClosedForm(ITA2_START_STOP), uart: toleranceClosedForm(UART_8N1), uartB2B: toleranceClosedForm(UART_8N1, 0.5, true) };
/** Relay steps the counter takes to settle after a rising and a falling pulse edge over 16 pulses (tests/content-comms.test.ts measures them). */
const SETTLE = { rise: 2, fall: 6 };
const K_ITA2 = stopIndex(ITA2_START_STOP);
const E10 = erlangB(10, 10);
const ERL = { E: offered(1000, 2, 3) };

export const chExchange: Chapter = {
  id: 'exchange', num: numOf('exchange'), title: 'The telephone exchange', level: 'Communication',
  blurb: 'How many people reach each other: a dial exchange from relays, circuit switching and what it costs in contacts.',
  goals: [
    'count what a full mesh, a crossbar and a Clos network cost in wires and crosspoints',
    'follow a pulse counter and a stepping selector built from relay contacts, and count their relay steps',
    'use Erlang B to say how many trunks a given traffic needs',
    'derive how much clock error a start-stop receiver tolerates, and why only the start edge has to be found',
  ],
  builds: ['relays', 'telegraph'],
  recap: {
    keep: [
      `n telephones joined pairwise need n(n − 1) / 2 wires (${thin(meshWires(1000))} for 1 000); an exchange needs n and a switch. A <strong>circuit-switched</strong> call owns a path end to end for its whole duration, speaking or not. Chapter ${numOf('switch')} and the chapters after it return to the other way: packets, which share links.`,
      `A relay pulse counter toggles on the falling edge of each pulse however long it lasts (m' = p ? ¬s : m, s' = p ? s : m): ${CTR.relays} relays for 3 bits. A contact tree on the same relays makes it a selector, ${SEL.relays} relays, 1 of 8, with no extra step.`,
      `A crossbar crosspoint is a relay that joins a row to a column and holds itself. N lines cost N² crosspoints; a three-stage Clos network needs m ≥ 2n − 1 middle switches never to block (${thin(BEST.crosspoints)} against ${thin(crossbarCrosspoints(1024))} crosspoints at 1 024 lines).`,
      `Erlang B gives the chance a call finds every trunk busy: ${f0(100 * E10)} % at 10 Erlangs on 10 trunks, 1 % with ${trunksFor(10, 0.01)}. Big trunk groups carry more per trunk.`,
      `A start-stop receiver synchronizes on the start edge only, then samples at fixed offsets of its own clock: it tolerates ±${(100 * SS.ita2.fast).toFixed(1)} % speed error with the teleprinter's frame (5 data bits, stop 1.5) and ±${(100 * SS.uart.fast).toFixed(1)} % with 8N1 for an isolated character (back to back, a slow receiver is limited to −${(100 * SS.uartB2B.slow).toFixed(1)} %, since its stop sample must precede the next start edge).`,
    ],
    check: [
      {
        question: 'A caller dials 5. How many times does the pulse relay in the exchange operate and release, and what does the counter hold afterwards?',
        options: ['5 times; the count is 5 on the falling edge of the fifth pulse', '10 times; the count is 10', '5 times; the count is 4, one lagging'],
        answer: 0,
        explain: `The dial opens the loop five times; the pulse relay follows. Each pulse ends with a falling edge, the counter's clock: after the fifth, the counter holds 5.`,
        why: ['', 'Operate-and-release is one pulse. Counting both edges would give 10, but the counter advances only on the falling one.', 'The slave copies the master when the pulse falls, so the count is updated by then: nothing lags.'],
      },
      {
        question: `${groupDigits(1000)} subscribers, 2 calls an hour of 3 minutes each, offer ${ERL.E} Erlangs. Are 1 000 trunks to another exchange needed?`,
        options: [`No: ${trunksFor(ERL.E, 0.01)} give 1 % blocking`, 'Yes: any caller might call out', `No: ${ERL.E} trunks suffice`],
        answer: 0,
        explain: `Erlang B at ${ERL.E} E and 1 % is ${trunksFor(ERL.E, 0.01)} trunks: sharing works because most phones are idle at any moment. A trunk per phone would be ${f0(1000 / trunksFor(ERL.E, 0.01))} times more.`,
        why: ['', 'Any caller might, but not all at once. Trunks are sized for the busy hour, not for the number of subscribers.', `${ERL.E} Erlangs is the average number of calls up; calls arrive at random, so with exactly ${ERL.E} trunks about ${f0(100 * erlangB(ERL.E, ERL.E))} % of them would be blocked.`],
      },
      {
        question: 'Why can a start-stop receiver tolerate a clock a few percent off, when two clocks that must stay in step over a long stream cannot?',
        options: ['It only has to stay right for one character, since each start edge resets it', 'Its clock is more accurate', 'Start-stop codes carry the clock in the data'],
        answer: 0,
        explain: `Between two start edges it counts only ${frameUnits(ITA2_START_STOP)} units. An error of e shifts the stop sample by about ${K_ITA2} e units, and the margin is half a unit.`,
        why: ['', 'Teleprinter motors were governed, not precise: the margin comes from the frame being short.', 'The data carries no clock; only the start edge, once a character, tells the receiver where to begin.'],
      },
    ],
  },
  steps: [
    {
      title: 'Everyone to everyone',
      body: `
        <p>Telephones need a way to find each other. The direct way is a wire between every pair: n phones need n(n − 1) / 2 wires and n − 1 jacks on each. Ten phones are ${meshWires(10)} wires; a thousand are ${thin(meshWires(1000))}. The other way is one
        wire from each phone to a central place and a <strong>switch</strong> there that connects two of them for the length of a call. The wires grow as n, and the cost moves into the switch.</p>
        <p>That is <strong>circuit switching</strong>: setting up a call reserves a path from one end to the other, and it carries that conversation, silence included, until a hang-up releases it. Nothing else can use the path.
        Chapter ${numOf('switch')} and the chapters after it build the alternative, packets that share links; this chapter builds the reservation. The rest of the chapter makes a small exchange out of the relay contacts of the prologue: a counter for dialled digits, a selector, a crossbar, and the sums for sizing one.</p>
        <div class="try">Slide the number of phones up to 16 and compare the two drawings.</div>`,
      widget: () => meshWidget(),
      challenge: {
        kind: 'quiz', question: '20 telephones are joined by a full mesh. How many wires?',
        options: [String(meshWires(20)), String(20 * 19), '20'], answer: 0,
        explain: `n(n − 1) / 2 = 20 × 19 / 2 = ${meshWires(20)}: each pair once.`,
        why: ['', 'That counts every ordered pair, each wire twice.', 'That is the star: one wire to the exchange for each phone.'],
      },
    },
    {
      title: 'Counting dial pulses',
      body: `
        <p>To make a call the exchange must be told whom. A rotary dial does it by breaking the telephone's loop current: a digit n is n breaks at about ten a second, roughly 60 % of each cycle with the loop open, and in most countries 0 is ten pulses. The exchange's line relay
        follows the loop, and something must count its pulses.</p>
        <p>The counter below is <span data-show="st0 st1 st2">three toggle stages</span> of three relays each. In a stage the <em>pulse relay</em> p follows its input; a master m and a slave s hold the state, and each is fed through p's contacts:
        <code>m' = p ? ¬s : m</code> and <code>s' = p ? s : m</code>. While the pulse is up, m takes the inverse of s and s holds; when it falls, s copies m. So s toggles
        once per pulse, on the falling edge, however long the pulse lasts. (The prologue's clock divider, by contrast, would flip on every step its input stays up.) This is the master-slave pair of
        <a href="#/c/latches/0">chapter 8</a> with relay steps as the phases. Each stage's slave clocks the next, a ripple counter, and <span data-show="hr">the hang-up relay</span> opens the rail that feeds every master and slave, so a caller who hangs up releases the counter.</p>
        <p>The whole counter is ${CTR.relays} relays: three per bit and one to hang up. Measured on this circuit, a pulse that rises settles in at most ${SETTLE.rise} relay steps and one that falls in at most ${SETTLE.fall} (${f0(SETTLE.fall * RELAY_STEP_MS)} ms at ${RELAY_STEP_MS} ms a step, the ripple through all three bits). That fits the 100 ms period of a dial but not always its roughly 40 ms make interval: the worst ripple can still be moving when the next pulse begins. The count stays right because each stage is clocked by an edge and holds its state, not by the time between edges.</p>
        <div class="try">Pulse three times, then hang up.</div>`,
      scene: () => ({ root: DIAL_COUNTER, inputs: { pulse: 0, hangup: 0 }, animate: true }),
      tour: {
        beats: [
          { title: 'Idle', set: { pulse: 0 }, show: ['st0', 'st1', 'st2'], expect: { count: 0 }, say: '<p>Every relay released. The count is {v:count}.</p>' },
          { title: 'First pulse starts', set: { pulse: 1 }, show: ['st0'], expect: { count: 0 }, say: '<p>The loop opens. The pulse relay of bit 0 operates and feeds the master with the inverse of the slave. The count is still {v:count}: the slave waits for the pulse to fall.</p>' },
          { title: 'First pulse ends', set: { pulse: 0 }, show: ['st0'], expect: { count: 1 }, say: '<p>The loop closes. The pulse relay releases and the slave copies the master: the count is {v:count}.</p>' },
          { title: 'Second pulse starts', set: { pulse: 1 }, show: ['st0'], expect: { count: 1 }, say: '<p>The master now takes the inverse of a slave that is operated, and drops out. The count is still {v:count}.</p>' },
          { title: 'Second pulse ends', set: { pulse: 0 }, show: ['st0', 'st1'], expect: { count: 2 }, say: '<p>Bit 0 falls from 1 to 0: that falling edge is the clock of bit 1, whose slave copies its own master. The count is {v:count}: a ripple carry in relays.</p>' },
          { title: 'Third pulse', set: { pulse: 1 }, show: ['st0'], expect: { count: 2 }, say: '<p>Held up as long as you like, the pulse changes nothing until it falls. The count is {v:count}.</p>' },
          { title: 'Third pulse ends', set: { pulse: 0 }, show: ['st0', 'st1'], expect: { count: 3 }, say: '<p>The count is {v:count}.</p>' },
          { title: 'Hang up', set: { hangup: 1 }, show: ['hr'], expect: { count: 0 }, say: '<p>The hang-up relay opens the rail that feeds every master and slave. They drop out and the counter reads {v:count}.</p>' },
        ],
      },
      more: {
        derive: `<p>The master-slave pair makes an edge out of two levels. While p = 1: m⁺ = ¬s, s⁺ = s. While p = 0: m⁺ = m, s⁺ = m. Over one pulse m goes to ¬s and s then goes to m, so s⁺ = ¬s. In relay hardware: m's coil is fed through p's changeover from one of two lines, <i>A</i> (VDD through s's break contact: on while s is released) or
          <i>B</i> (VDD through m's own make contact: m holds itself); s's coil from <i>C</i> (s's make contact: s holds itself) or <i>D</i> (m's second make contact). Every armature moves at one relay step, so no coil sees a half-updated pair.</p>`,
        pitfall: `<p>Counting both edges of the pulse. The line relay follows the loop, which opens and closes for each digit unit; a counter that advanced on the rising edge too would count 2n for a dialled n. The master-slave pair is what makes the count depend on one edge only.</p>`,
        real: `<p>A real dial had a governor, a small centrifugal brake, to return at a steady speed, so the pulses came at the same rate whoever dialled. Exchanges relied on that rate: a pulse train too fast or slow was a wrong number.</p>`,
      },
      tries: [(st) => st.value('count') === 3],
      challenge: {
        kind: 'reach', goal: 'Dial a 5: five pulses, each one up then down, and hold the count at 5.',
        check: (st) => st.value('count') === 5 && st.getInput('pulse') === 0 && st.getInput('hangup') === 0,
        hints: ['Each pulse is two changes: up and down. The count moves on the down.', 'Let the relays settle between changes: use Step until the status line says settled.'],
        answer: 'Five times: pulse = 1, wait, pulse = 0, wait. The count after the fifth falling edge is 5 (101).',
        solve: (st) => { for (let i = 0; i < 5; i++) { st.setInputs({ pulse: 1 }); st.sim?.settle(); st.setInputs({ pulse: 0 }); st.sim?.settle(); } },
      },
    },
    {
      title: 'A stepping selector',
      body: `
        <p>The counter knows how many pulses came. A <strong>selector</strong> uses the count to connect the caller's line to one of eight outgoing lines. The same three stages carry a <em>contact tree</em> on their slave relays: bit 0's changeover sends the line to
        one of two wires, bit 1's two changeovers pass each on to one of two, bit 2's four to one of eight. The line goes through <em>three</em> contacts in series and out of exactly one of eight outputs, y<sub>n</sub> after n pulses. The tree is only extra poles on relays that exist anyway:
        the selector is ${SEL.relays} relays like the counter, and <strong>selecting costs no time of its own</strong>: no relay step is added, because the contacts the line crosses were already in place when the count settled.</p>
        <p>The real <em>Strowger</em> switch (patented 1891) worked quite differently. One magnet stepped a shaft of contacts up, one level for each pulse of the first digit; a second mechanism then turned the contacts along that level for the next digit's pulses.
        The position of the mechanism was the count: no relay held a bit. A hang-up released it. Ours counts in binary with relays and routes with contacts; the idea of letting the dialled digits drive the switch directly is the same.</p>
        <div class="try">Set <code>line</code> to 1 and dial three.</div>`,
      scene: () => ({ root: DIAL_SELECTOR, inputs: { line: 1, pulse: 0, hangup: 0 }, animate: true }),
      tour: {
        beats: [
          { title: 'Nobody dialled', set: { line: 1 }, show: ['st0', 'st1', 'st2'], expect: { y: 1 }, say: `<p>The caller's line is up. With every relay released it goes through the break contact of every level to output 0: y = {b:y}.</p>` },
          { title: 'Pulse 1 up', set: { pulse: 1 }, show: ['st0'], expect: { y: 1 }, say: '<p>The master moves; the slaves, which carry the contacts, do not. y = {b:y}.</p>' },
          { title: 'Pulse 1 down', set: { pulse: 0 }, show: ['st0'], expect: { y: 2 }, say: '<p>Bit 0\'s slave operates, and its changeover sends the line to the other wire. y = {b:y}: output 1.</p>' },
          { title: 'Pulse 2 up', set: { pulse: 1 }, show: ['st1'], expect: { y: 2 }, say: '<p>The line stays on output 1 until the second pulse falls.</p>' },
          { title: 'Pulse 2 down', set: { pulse: 0 }, show: ['st0', 'st1'], expect: { y: 4 }, say: '<p>Bit 0 falls back and bit 1 operates: the line takes the other branch at the second level and the first branch at the first. y = {b:y}: output 2.</p>' },
          { title: 'Pulse 3 up', set: { pulse: 1 }, show: ['st0'], expect: { y: 4 }, say: '<p>Waiting for the fall.</p>' },
          { title: 'Pulse 3 down', set: { pulse: 0 }, show: ['st0', 'st1'], expect: { y: 8 }, say: '<p>Dialled 3: bits 0 and 1 both operated. y = {b:y}: output 3 and no other.</p>' },
          { title: 'Hang up', set: { hangup: 1 }, show: ['hr'], expect: { y: 1 }, say: '<p>Everything releases and the line falls back to output 0, ready for the next call.</p>' },
        ],
      },
      more: {
        derive: `<p>Bit 0's changeover selects x<sub>b0</sub>; bit 1's pole j (j = b0) selects z<sub>j + 2 b1</sub>; bit 2's pole j (j = b0 + 2 b1) selects y<sub>j + 4 b2</sub>: 1 + 2 + 4 = 7 poles for 8 outputs. The last relay has 2 + 4 = 6 poles, the most this library's relay allows;
          a 1-of-16 tree would need 8 on its last relay, and a larger selector would split across several relays. Real selectors avoided the problem by not decoding a binary count at all.</p>`,
        pitfall: `<p>Dialling while the line is already connected through. The tree switches only after the count settles, and a pulse train steps the contacts through every intermediate output on its way. A real exchange kept the speech path open to the next stage until the last digit.</p>`,
      },
      challenge: {
        kind: 'reach', goal: 'Connect the line to output 6: dial six and read y.',
        check: (st) => st.value('y') === 64,
        hints: ['Six pulses, each up then down.', 'Output 6 lights bit 6 of y, the value 64.'],
        answer: 'Six pulses of pulse = 1, then 0 give count 6 (110): bit 1 and bit 2 operated, and the line leaves by output 6, y = 01000000.',
        solve: (st) => { for (let i = 0; i < 6; i++) { st.setInputs({ pulse: 1 }); st.sim?.settle(); st.setInputs({ pulse: 0 }); st.sim?.settle(); } },
      },
    },
    {
      title: 'The machine itself',
      body: `
        <p>The relay selector above is a chain of latches that decodes a count. The Strowger switch has no count to decode: its <strong>position is the state</strong>, and it moves in two directions. Each pulse of the first digit steps a shaft up one level of a bank of ten; the shaft's height is the digit. Then the shaft turns instead of rising: the rotary magnet steps the wipers along that level of ten lines by itself, without further pulses, until a line is free.</p>
        <p>That hunt is what the relay version cannot do. The same pulses reach the same level in both (a test holds the model to the ${SEL.relays}-relay selector for 0 to 7 pulses), but a busy line is skipped by the wiper, and a level busy to the end gives the busy tone. Hanging up releases the shaft and it drops to rest.</p>
        <div class="try">Dial 4, mark lines on level 4 busy, and dial again. Fill a whole level with its L button and watch the wiper run off the end.</div>`,
      widget: () => strowger3d(),
    },
    {
      title: 'A crossbar',
      body: `
        <p>A selector steps; a <strong>crossbar</strong> picks. It is a grid of crosspoints, a row for each caller and a column for each called line, and a crosspoint is a contact that joins them. <span data-show="x00 x01 x02 x10 x11 x12 x20 x21 x22">Nine relays</span>
        make the grid here. Each crosspoint relay has three poles: one joins its row to its column, with the speech passing <em>both ways</em> at full strength through the metal; one holds the relay in through its row's hold rail; one marks its column busy.</p>
        <p>To set up a call, raise a row select and a column select together. <span data-show="sel0 sel1 sel2">The row relay</span> puts a feed on its row; <span data-show="sc0 sc1 sc2">the column relay</span> passes it to the one crosspoint at the intersection, which pulls in and holds itself, so both selects
        can drop. The column select passes <span data-show="bz0 bz1 bz2">a busy relay's</span> break contact first: while any crosspoint of the column is held, selecting it does nothing, and the busy line says so, the busy tone's origin. <span data-show="hr0 hr1 hr2">A hang-up</span> cuts a row's hold rail and releases only that caller.</p>
        <p>Two calls up at once is two crosspoints held; a third call into a column already in use is refused. It needs ${XB.relays} relays: nine crosspoints and twelve to control them, which is the crossbar's price: the grid is the cheap part, the selection logic grows with the lines too.</p>
        <div class="try">Call from row 0 to column 1, then from row 2 to column 0, and try row 1 into column 1.</div>`,
      scene: () => ({ root: CROSSBAR_EXCHANGE, path: ['xb'], inputs: { rs: 0, cs: 0, hang: 0, talk: 0 }, animate: true }),
      tour: {
        beats: [
          { title: 'First call set up', set: { rs: 1, cs: 2 }, show: ['x01'], expect: { busy: 2 }, say: '<p>Row 0 and column 1 selected together: the crosspoint at their intersection pulls in and holds. busy = {b:busy}: column 1 is in use.</p>' },
          { title: 'Speech goes through', set: { rs: 0, cs: 0, talk: 1 }, show: ['x01'], expect: { heard: 2, busy: 2 }, say: '<p>The selects are back to 0 and the call stays up. What caller 0 says (talk = {b:talk}) comes out on column 1: heard = {b:heard}. The contact conducts the other way too, which is how the called party answers.</p>' },
          { title: 'Second call', set: { rs: 4, cs: 1, talk: 0 }, show: ['x20'], expect: { busy: 3 }, say: '<p>Row 2 into column 0, while the first call is up. busy = {b:busy}: columns 0 and 1.</p>' },
          { title: 'Two calls speaking', set: { rs: 0, cs: 0, talk: 5 }, show: ['x01', 'x20'], expect: { heard: 3 }, say: '<p>Callers 0 and 2 speak at once: heard = {b:heard}. Each reaches its own column; nothing in the grid joins the two calls.</p>' },
          { title: 'A third call is refused', set: { rs: 2, cs: 2, talk: 2 }, show: ['bz1', 'x11'], expect: { heard: 0, busy: 3 }, say: `<p>Row 1 wants column 1, which is held. The busy relay has opened the column select's path: the crosspoint at row 1, column 1 never operates. heard = {b:heard}; the caller would hear the busy tone.</p>` },
          { title: 'A hang-up frees a column', set: { rs: 0, cs: 0, talk: 0, hang: 1 }, show: ['hr0', 'x01'], expect: { busy: 1 }, say: `<p>Caller 0 hangs up: row 0's hold rail opens and its crosspoint falls. busy = {b:busy}: column 1 is free again, and the second call is untouched.</p>` },
        ],
      },
      more: {
        derive: `<p>Crosspoint (r, c) operates when rs<sub>r</sub> and cs<sub>c</sub> are both up and the column is not busy: the row relay feeds the row line, the column relay's pole r passes it to the crosspoint's coil, and the busy relay's break contact sits in the column relay's own coil path. It then holds through
          H<sub>r</sub>, VDD through the break contact of row r's hang-up relay. ${XB.relays} relays = 9 + 3 + 3 + 3 + 3.</p>`,
        pitfall: `<p>Selecting two callers into the same column in the same instant. Both crosspoints would get a feed before either busy relay moved. A real crossbar exchange had one marker that served one request at a time, which is what makes the busy test sound.</p>`,
        real: `<p>Crossbar exchanges replaced the stepping switches from the middle of the last century. The grid of crosspoints is the same idea as the crossbar a switch chip builds between its ports (chapter ${numOf('switch')}).</p>`,
      },
      challenge: {
        kind: 'reach', goal: 'Set up two calls at once (two columns busy), with the selects back at 0.',
        check: (st) => { const b = st.value('busy'); return (b & (b - 1)) !== 0 && st.getInput('rs') === 0 && st.getInput('cs') === 0; },
        hints: ['A call is a row select and a column select raised together, then let go.', 'Call row 0 to column 1, wait, then row 2 to column 0.'],
        answer: 'rs = 1, cs = 2, settle, rs = 0, cs = 0; then rs = 4, cs = 1, settle, rs = 0, cs = 0. busy = 011.',
        solve: (st) => {
          for (const [rs, cs] of [[1, 2], [4, 1]]) { st.setInputs({ rs, cs }); st.sim?.settle(); st.setInputs({ rs: 0, cs: 0 }); st.sim?.settle(); }
        },
      },
    },
    {
      title: 'What a switching network costs',
      body: `
        <p>The crossbar's N² crosspoints are too many at telephone scale: a thousand lines are ${thin(crossbarCrosspoints(1000))} contacts. Charles Clos's 1953 three-stage network cuts it down: r input switches
        of n × m crosspoints, m middle switches of r × r, r output switches of m × n, for N = n r lines. Crosspoints: <strong>2 N m + m r²</strong>. A call needs a free path through one middle switch; with
        <strong>m ≥ 2n − 1</strong> middle switches there is always one (the call's own input and output switches each have at most n − 1 other calls up, blocking at most 2n − 2 middle switches). With m ≥ n a free path can always be found if calls in progress
        may be re-routed.</p>
        <p>At 1 024 lines the best strictly non-blocking choice is n = ${BEST.n}, r = ${BEST.r}, m = ${BEST.m}: ${thin(BEST.crosspoints)} crosspoints against ${thin(crossbarCrosspoints(1024))}, ${(crossbarCrosspoints(1024) / BEST.crosspoints).toFixed(1)} times fewer. At 16 lines the crossbar still wins. The same construction
        appears again as the fabric inside a big switch.</p>`,
      widget: () => networkCostWidget(),
      more: {
        derive: `<p>With n inputs per input switch the blocked paths for one new call are at most (n − 1) middle switches used by the input switch's other calls and (n − 1) by the output switch's: so m = 2n − 1 leaves one free. Cost 2Nm + mr² with m = 2n − 1, r = N / n; the continuous minimum is near n = √(N / 2): ${Math.sqrt(1024 / 2).toFixed(1)} at N = 1 024, and the integer search lands on ${BEST.n}.
          36 lines as n = 3, r = 12, m = 5 are ${thin(CLOS36.crosspoints)} crosspoints against ${thin(crossbarCrosspoints(36))}.</p>`,
        pitfall: `<p>Counting crosspoints and calling it the cost. A crosspoint in the crossbar of the last step is a 3-pole relay with a share of the select logic; the Clos network also needs a controller that finds the free middle switch, which a crossbar does not.</p>`,
      },
      challenge: {
        kind: 'quiz', question: `36 lines as a Clos network with n = 3, r = 12, m = 5. Crosspoints:`,
        options: [thin(CLOS36.crosspoints), thin(crossbarCrosspoints(36)), thin(foldedCrosspoints(36))], answer: 0,
        explain: `2 N m + m r² = 2 × 36 × 5 + 5 × 144 = ${thin(CLOS36.crosspoints)}, against ${thin(crossbarCrosspoints(36))} for one 36 × 36 crossbar.`,
        why: ['', 'That is N², the single crossbar. The Clos network is built to avoid it.', 'That is N(N − 1) / 2, one switch per pair. It serves every pair of lines but is not a Clos network.'],
      },
    },
    {
      title: 'The busy tone',
      body: `
        <p>Nobody builds N trunks for N phones: most are idle. The question is how many trunks between two exchanges give an acceptable chance of finding them all busy. The traffic is measured in <strong>Erlangs</strong> (after Agner Krarup Erlang, a
        Danish engineer of the Copenhagen telephone company): one Erlang is one circuit occupied continuously. ${thin(1000)} subscribers placing 2 calls an hour of 3 minutes each offer ${ERL.E} Erlangs.</p>
        <p><strong>Erlang B</strong> gives the probability that a call finds all m trunks busy, for traffic E offered at random and blocked calls cleared:
        B(E, 0) = 1, B(E, m) = E·B(E, m − 1) / (m + E·B(E, m − 1)). ${ERL.E} Erlangs on ${trunksFor(ERL.E, 0.01)} trunks block 1 %. Size matters: 10 trunks carry ${capacityAt(10, 0.01).toFixed(2)} Erlangs at 1 %, 100 trunks ${capacityAt(100, 0.01).toFixed(1)}, so ${f0(capacityAt(10, 0.01) / 10 * 100)} % of a trunk
        is used on average in the small group and ${f0(capacityAt(100, 0.01) / 100 * 100)} % in the large one. A big pool wastes less. A blocked call hears the busy tone, the crossbar's refused crosspoint.</p>
        <div class="try">Set holding to 3 minutes and find the trunks for 1 % at 1 000 phones.</div>`,
      widget: () => erlangWidget(),
      more: {
        derive: `<p>Erlang B is the stationary probability of the state "all m trunks busy" in a birth-death chain: arrivals at rate λ (Poisson), service 1/h each, m servers, no queue. P(k busy) is proportional to E<sup>k</sup> / k!, so B = (E<sup>m</sup> / m!) / Σ<sub>k ≤ m</sub> E<sup>k</sup> / k!. The recursion is the same ratio computed without factorials.</p>`,
        pitfall: `<p>Assuming blocked callers vanish. They redial, which adds load exactly when the system is full; Erlang B understates blocking in a storm, and exchanges protected themselves by refusing calls early.</p>`,
      },
      challenge: {
        kind: 'quiz', question: '10 Erlangs offered to 10 trunks. About how many calls find every trunk busy?',
        options: [`${f0(100 * E10)} %`, '0 %: the average traffic equals the trunks', '50 %'], answer: 0,
        explain: `B(10, 10) = ${E10.toFixed(4)}. Calls arrive at random, so whenever the count of calls in progress happens to reach 10, the next one is lost, and with the load equal to the capacity that is about a fifth of the time.`,
        why: ['', 'Equal average load and capacity leaves no room for bursts: arrivals bunch up, and a bunch finds the trunks full.', 'Half would need the offered load to be far above the capacity. At 10 Erlangs on 10 trunks the loss is nearer a fifth.'],
      },
    },
    {
      title: 'Start-stop',
      body: `
        <p>The teleprinter carried the same questions to a machine. A motor turns all the time at about the right speed, and a character is five bits in a <em>frame</em> (start unit 0, five data units, stop 1.5 units of 1). The idle line is 1; the falling start
        edge releases a clutch and the receiver's shaft turns one revolution, with cams that look at the line at fixed offsets from the start: the middle of each unit. At the end of the revolution the stop unit's 1 re-latches the clutch. The two motors have to agree only
        for the length of one character, ${frameUnits(ITA2_START_STOP)} units, since every start edge re-synchronizes the receiver.</p>
        <p>How far can they differ? A receiver that is e too fast reaches its stop sample, ${K_ITA2} + ½ units after the start edge, early by about ${K_ITA2} e units, and the sample must stay at or after the stop unit's beginning. The closed form is ±½ / K for the K = ${K_ITA2} units before the stop:
        ±${(100 * SS.ita2.fast).toFixed(2)} % for the teleprinter, ±${(100 * SS.uart.fast).toFixed(2)} % for eight data bits and one stop bit (K = 9), both for an isolated character. With characters back to back the slow side of 8N1 tightens to −${(100 * SS.uartB2B.slow).toFixed(2)} %, because the stop sample at 9.5 / (1 + e) must come before the next start edge at 10; the teleprinter's 1.5 stop units leave it unaffected. The widget searches every code to find where the first one fails (a code ending in 0 goes first: a sample that
        lands in a neighbour of the same level reads right). The frame is general: chapter 43's UART reuses it with another length, and a clock that counts sixteen ticks a bit loses part of the margin.</p>
        <div class="try">Move the receiver's speed until a sample crosses a boundary. Then pick the 8-bit frame, and search every code.</div>`,
      widget: () => startStopWidget(),
      more: {
        derive: `<p>The receiver detects the start edge, then samples data bit i at (i + 1 + p) bits of its own clock, p = ½ for mid-bit. With its clock fast by e it reaches that instant after (i + 1 + p) / (1 + e) transmitter units. The bit read is the unit that instant falls in. The first failure on the fast side is the stop sample at K + p, which must stay at or after K:
          e ≤ p / K. On the slow side, the last data sample at K − 1 + p must stay before K: e ≥ −(1 − p) / K. K = 1 + data + parity: ${K_ITA2} for ITA2, 9 for 8N1.</p>`,
        pitfall: `<p>Comparing it with a clock that must hold over a long stream. A synchronous link cannot resynchronize at every character, so its clocks must agree within a fraction of a bit over the whole message, or one of them has to be recovered from the data (chapter ${numOf('serial')}). Start-stop spends a start and a stop unit to avoid that.</p>`,
      },
      challenge: {
        kind: 'quiz', question: `The teleprinter's receiver motor runs ${f1(100 * SS.ita2.fast + 3)} % fast (sampling mid-unit, a continuous clock). A character ending in a 0 bit:`,
        options: ['is received wrong: the stop sample lands in that last bit, a framing error', 'is received right: nothing goes wrong below ±15 %', 'is received right but its stop unit is lost'],
        answer: 0,
        explain: `The limit is ±${(100 * SS.ita2.fast).toFixed(2)} %. Beyond it the sample for the stop unit falls in the last data unit, reads its 0, and the receiver reports a framing error. At this speed the earlier samples cross too: the sample for the last data bit lands in the unit before it, so even a character ending in 1 can be misread (10000 arrives as 00000, with the stop unit fine).`,
        why: ['', `±${(100 * SS.ita2.fast).toFixed(2)} % is the limit for the frame: half a unit over the ${K_ITA2} units before the stop.`, 'The stop unit is sampled, not skipped: a sample in the wrong place reads the wrong unit.'],
      },
    },
  ],
};

// ---- the prologue's words, explained in place
