// Keeping it secret: how strangers share a secret in public. It opens on the Enigma M4 (crypto/enigma.ts, widgets/enigma3d.ts), a
// permutation of wired switches that was broken for reasons that are still the rules. Then AES and SHA-256 in gates (lib/aes.ts,
// lib/sha256.ts, checked against NIST vectors and node:crypto); key exchange and TLS 1.3 follow (Chapter.soon until they are built). History here is checked against the sources in the "Where this comes from" asides.

import { periodOf, involutions26, m4KeySpace, plugCount } from '../crypto/bombe';
import '../lib';
import { add26, m4Gates, sub26, wheelStage } from '../lib/enigmagates';
import COSTS from '../crypto/gatecosts.json';
import { stats } from '../sim/stats';
import { idx, ROTORS, U264 } from '../crypto/enigma';
import { enigma3d } from '../widgets/enigma3d';
import { withModel } from '../widgets/modelhost';
import { aesExplorerWidget, avalancheWidget, modesWidget, shaWidget } from '../widgets/secretaes';
import { aesCoreScene, aesRoundScene, sboxScene, shaCoreScene, shaRoundScene } from '../widgets/secretscenes';
import { bombeWidget, cribWidget, lessonsWidget, machinesWidget, permutationWidget } from '../widgets/secretenigma';
import type { Chapter } from './types';

const n0 = (x: number | bigint) => x.toLocaleString('en-US').replace(/,/g, ' ');
/** 6.26 × 10^25 from an exact count. */
const sci = (x: bigint) => { const [m, e] = Number(x).toExponential(2).split('e+'); return `${m} × 10<sup>${e}</sup>`; };
const KS = m4KeySpace();
const GATES = stats(m4Gates(U264.settings)).nands;
const WHEEL = stats(wheelStage('I_f', 'Wheel I', [...ROTORS.I.wiring].map(idx))).nands;
const P3 = periodOf(['I', 'II', 'III']), P2 = periodOf(['I', 'II', 'VI']), P8 = periodOf(['VI', 'VII', 'VIII']);

const m4Scene = () => ({
  root: m4Gates(U264.settings),
  inputs: { key: idx('N'), load: 1, set_l: idx('J'), set_m: idx('N'), set_r: idx('A') },
  autoClock: false,
  engine: 'cycle' as const,
  highlight: ['plug_in', 'w0_f', 'w1_f', 'w2_f', 'g_f', 'ukw', 'g_b', 'w2_b', 'w1_b', 'w0_b', 'plug_out'],
});

export const chSecret: Chapter = {
  id: 'secret', num: 52.5, title: 'Keeping it secret', level: 'Communication',
  blurb: 'The Enigma M4 in brass and in gates, why it broke, and what that taught modern ciphers. Then AES and SHA-256 in gates. Coming to this chapter: key exchange and a TLS 1.3 handshake on our CPU.',
  goals: [
    'describe the Enigma as a permutation that changes with every key press, and say what its wiring forces it to do',
    'use a crib and the machine\'s flaw to rule out settings, and explain how the Bombe discards the plugboard from the search',
    'state the design rules that Enigma\'s failures gave modern ciphers, and see them in AES and SHA-256 built from gates',
    'say what a mode of operation adds to a block cipher, and what goes wrong without one',
    'say what separates a stored-program computer from the machines built to break these ciphers',
  ],
  builds: ['tcp'],
  parts: [['The Enigma', 7], ['AES', 6], ['SHA-256', 3]],
  recap: {
    keep: [
      'A key press steps the wheels, then the current runs from the key through plugs, entry wheel, four wheels, the reflector and back. Each position is one fixed permutation of 26 letters, made of 13 swaps: the same setting deciphers what it enciphered, and no letter ever lights itself.',
      `The M4's key has ${sci(KS.total)} settings, about 2<sup>${KS.bits.toFixed(1)}</sup>, of which the plugboard is ${sci(KS.plugs)}. Without the plugs there are only ${sci(KS.withoutPlugs)}, and an attack that gets round the plugboard has only those to try.`,
      'A crib is plaintext you can guess. Because no letter enciphers to itself, a crib can only stand where no letter falls on itself. From a crib the Bombe follows a guess about one plug through the scrambler, whose wiring is known; a contradiction rules out that wheel position whatever the other plugs are.',
      'The lessons became rules: the design is public and only the key is secret (Kerckhoffs); a cipher must not have a structural tell; key bits must not be separable into parts attacked one at a time; and a key must not be reused or sent twice.',
      `AES-128 is ten rounds of SubBytes, ShiftRows, MixColumns and AddRoundKey over a 16-byte state. In gates here: an S-box of ${n0(COSTS.parts.aes_sbox.nands)} NANDs, a round of ${n0(COSTS.parts.aes_round.nands)}, a core of ${n0(COSTS.cores.aes_core.nands)} taking ${COSTS.cores.aes_core.cycles} clocks a block, with the key in a register.`,
      'A block cipher alone only enciphers 16 bytes. ECB shows repeats; CTR hides them but dies if a counter is reused and does not notice changes; GCM adds a tag, so a changed message is refused.',
      `SHA-256 turns any message into 256 bits so that changing one bit changes about half of them: a core of ${n0(COSTS.cores.sha_core.nands)} NANDs and ${COSTS.cores.sha_core.cycles} clocks per 64-byte block. It has no key: anyone can compute it.`,
    ],
    check: [
      {
        question: 'Why can\'t an Enigma encipher a letter to itself?',
        options: ['The reflector sends the current back by a different path, and the pressed key has cut off its own lamp', 'The rotors skip the input letter on purpose', 'The plugboard swaps every letter', 'The operators were told not to send such letters'],
        answer: 0,
        explain: 'A reflector pairs every contact with a different one, so the current returns on another wire. And electrically, the pressed key\'s changeover switch has disconnected that letter\'s lamp.',
        why: ['', 'Nothing selects against a letter: the wiring has no fixed path back to the same contact.', 'Plugged or not, the reflector\'s pairing is what rules it out; six letters are usually unplugged.', 'It is the machine that cannot do it, whatever the operator wants.'],
      },
      {
        question: `The plugboard gives ${sci(plugCount(10))} settings of ten cables. Why did the Bombe not need to try them?`,
        options: ['A guess at one plug follows through the known scrambler, so a contradiction rejects the wheel position for every plugging at once', 'It tried them all, very fast', 'Bletchley Park had the daily plug settings from captured sheets', 'The plugboard made no difference to the cipher'],
        answer: 0,
        explain: 'The reasoning needs only that a plug is a swap. It discards a wheel position without enumerating pluggings: the huge factor in the key space never enters the search.',
        why: ['', 'At a million plug settings a second, that alone takes about five years for each wheel position, and there are 17 576 positions per wheel order. No machine tried them.', 'Captured material helped at times, but the Bombe\'s method needed no plug settings.', 'It multiplied the key space enormously. The point is that the method goes round it, not that it is absent.'],
      },
      {
        question: 'A picture is enciphered with AES in ECB mode, and its outline is still visible. Why?',
        options: ['Equal 16-byte blocks of input give equal blocks of output', 'AES is too weak to hide images', 'The key was too short', 'ECB leaves the first round out'],
        answer: 0,
        explain: 'Each block is enciphered alone with the same key, so a flat area of the picture turns into one repeated block. The cipher is doing its job on each block; the mode gives the pattern away.',
        why: ['', 'AES is fine: the same cipher in CTR mode hides the picture completely.', 'A longer key changes which block each block turns into, not that equal blocks stay equal.', 'ECB runs all the rounds. The problem is what happens between blocks: nothing.'],
      },
      {
        question: 'Which of these machines stored its program in the memory it worked on?',
        options: ['The Manchester Baby, 1948', 'The Bombe', 'Colossus', 'The M4'],
        answer: 0,
        explain: 'Colossus was electronic and set up by switches and plugs, but its program was not in memory. The Baby first ran a program from read-write electronic memory on 21 June 1948.',
        why: ['', 'A Bombe was built for one job and wired by a menu.', 'Colossus was programmable by switches and plug panels and had no stored program.', 'An Enigma has no program at all: the wiring is the function.'],
      },
    ],
    practise: [],
  },
  steps: [
    {
      title: 'A secret kept in wires',
      body: `
        <p>Everything so far in this part of the book has been about getting bits across faithfully. Anyone on the path reads them. The oldest answer is a shared secret: both ends hold a key, and the message is scrambled by it. This is the M4, the German navy's machine from 1941. Its key was a printed sheet, the same for everyone on a network, changed daily.</p>
        <p>The machine's whole logic is in wires and contacts. Press a key and three things happen: the wheels step, a switch closes, and one lamp lights. Set the same key at the far end, type what you received, and the lamps spell the original: the machine undoes itself. That is not a mode. It follows from how it is wired, and the next steps show why, and what it cost.</p>
        <p class="try"><b>Try:</b> press <em>Set up U-264's message</em> and press <em>Next letter</em> a few times. This is a report Kapitänleutnant Hartwig Looks sent from U-264 in 1942, broken only in 2006 by the M4 Project's distributed search. It reads VONVON, then JLOOKS: "from, from J. Looks". Open <em>Wheels</em> and <em>Inside</em> while you type.</p>
        <details class="deeper"><summary>Where this comes from</summary><p>The wirings, notches and photographs the model is measured from: <a href="https://www.cryptomuseum.com/crypto/enigma/m4/index.htm" target="_blank" rel="noopener">Crypto Museum, Enigma M4</a>. The message, its settings and its war-diary record: <a href="https://www.equn.com/m4/m4-project-first-break.html" target="_blank" rel="noopener">M4 Project, first break</a>. The test suite deciphers it letter for letter. Overall size: the Computer History Museum's Enigma I record, as no source gives the M4's; the parts inside are scaled from photographs.</p></details>`,
      widget: () => enigma3d(),
    },
    {
      title: 'A permutation you can read',
      body: `
        <p>Stop the wheels and the machine is a function from 26 letters to 26 letters. Follow one letter: plugboard, entry wheel, four wheels, reflector, the same four wheels backwards, entry wheel, plugboard. Each wheel is a permutation <em>W</em> and the plugboard <em>P</em> a set of swaps, so one position is <em>P⁻¹ W⁻¹ U W P</em>, with the reflector <em>U</em> in the middle. <em>U</em> is 13 swaps, and a swap seen through anything is still a swap. Hence the two properties below, at every position, for every key: it is its own inverse, and nothing maps to itself.</p>
        <p>The reflector forces that second property, and the wiring shows it a second way. Each key is a changeover switch: at rest its common contact goes to its own lamp, pressed it goes to the battery. <b>The pressed key has cut off its own lamp</b>, so that lamp could not light whatever the wheels did. In <em>The current</em> below, 78 wires join the keys, sockets, entry wheel and lamps, and a test walks them as a circuit to the lamp the cipher names. The wheels change only which of those paths is joined.</p>
        <p>So there are at most ${n0(involutions26())} permutations it could be at one position, and the wheels walk through them, one per key press. Compare this with what you have built: a gate computes its output from levels; here the logic is a single closed path, and the "computation" is which contacts are touching.</p>
        <p class="try"><b>Try:</b> click letters and press the step button. Whatever you do, the count of letters that light themselves stays 0 and every partner lights its letter back.</p>`,
      widget: () => withModel(permutationWidget(), enigma3d({ view: 'path' })),
    },
    {
      title: 'The same machine in gates',
      body: `
        <p>You could build this from what you already have. A wheel's 26 wires become a table: a decoder and an OR per output bit. Its turning becomes two adders mod 26, one on the way in and one on the way out, because the wires stay put while the letters shift. Stepping is registers and comparators: each pawl's condition is a test for a turnover letter.</p>
        <p>That is what is below, for U-264's key, and the costs are computed from it. One wheel, one pass: ${n0(WHEEL)} NANDs, built from <span data-show="w0_f">an add-26 and a subtract-26</span> of ${n0(stats(add26()).nands)} and ${n0(stats(sub26()).nands)}. The whole machine: <b>${n0(GATES)} NANDs</b>. The real one spends no active device at all on a letter's way through: a battery, a bulb and brass. It pays instead in moving parts and in only doing this one thing.</p>
        <p>It really is the machine: the test suite compares it with the cipher on every press and deciphers U-264's message through these gates. Note what it would take to change a wheel here. On the brass machine you lift a wheel out. Here the wiring is built into the gates, so a different key means a different circuit. That is why a modern cipher keeps its key in a register, apart from its logic.</p>
        <p class="try"><b>Try:</b> with <em>load</em> at 1, pulse once: the windows take J, N, A. Set <em>load</em> to 0, keep <em>key</em> at 13 (0x0D, an N) and pulse. <em>lamp</em> reads 21 (0x15 in hex), a V, the message's first letter. Open any block to see what it is made of.</p>`,
      scene: m4Scene,
    },
    {
      title: 'Why it broke: the flaw in the wiring',
      body: `
        <p>The key is enormous: ${n0(KS.orders)} wheel orders, 2 Greek wheels, 2 reflectors, ${n0(KS.windows)} window positions, ${n0(KS.rings)} ring settings that matter and ${n0(KS.plugs)} ways to plug ten cables. That multiplies to ${sci(KS.total)}, about 2<sup>${KS.bits.toFixed(1)}</sup>. Counted that way it looks safe even today. It was not safe, because attackers do not have to count that way.</p>
        <p>Military messages are predictable: a weather report opens with <em>WETTER</em>, and a call sign recurs. A guess of plaintext is a <b>crib</b>. Normally a crib says little, since a guessed word could stand anywhere. But "no letter enciphers to itself" means a crib cannot stand where any of its letters falls on the same ciphertext letter. A property that looked like a feature of the design hands the attacker a test that needs no key.</p>
        <p>The other weaknesses were in how it was used. Army and Air Force procedure until 1940 enciphered each message key twice, which is what Marian Rejewski's group in Poland exploited from 1932; the navy's indicators were different and stronger. Operators chose keys such as AAA, and reused settings. And the naval double-notched wheels shorten the stepping: ${n0(P3)} presses before the wheels repeat with single notches, ${n0(P2)} with one double-notched wheel on the right, ${n0(P8)} with all three, all computed here. Real messages were far shorter than that, so this was not how it broke, but a keystream that repeats is a property no modern design would accept.</p>
        <p class="try"><b>Try:</b> drag the crib along U-264's message. About three places in ten fail at once: a ten-letter crib prunes, and a longer one prunes more. Then go to where it really was.</p>
        <details class="deeper"><summary>Where this comes from</summary><p><a href="https://en.wikipedia.org/wiki/Cryptanalysis_of_the_Enigma" target="_blank" rel="noopener">Cryptanalysis of the Enigma</a> (Wikipedia, with its citations to Rejewski, Welchman and Hinsley): the Poles' work from 1 September 1932, the repeated indicator, operators' "cillies". The key-space product agrees with <a href="https://www.cryptomuseum.com/crypto/enigma/working.htm" target="_blank" rel="noopener">Crypto Museum</a>. That page gives the three-wheel period as 16,926; computing it gives ${n0(P3)}, and the test suite checks the computation.</p></details>`,
      widget: cribWidget,
    },
    {
      title: 'The Bombe: going round the plugboard',
      body: `
        <p>Most of those 2<sup>${KS.bits.toFixed(1)}</sup> are the plugboard, and the Bombe's reasoning makes that factor disappear. Take a crib and draw it as a <b>menu</b>: letters as nodes, and an edge wherever the crib and cipher pair them, labelled with the place. Guess that the test letter is plugged to some letter. At a chosen wheel position the scrambler's wiring is known, so each edge turns that guess into another: if <em>a</em> is plugged to <em>u</em> and the scrambler at this place sends <em>u</em> to <em>v</em>, then <em>b</em> is plugged to <em>v</em>. Follow every edge. If the consequences say a letter is plugged to everything, the guess was wrong. If every guess fails, the position is wrong, and it fell <em>whichever way the other cables were plugged</em>.</p>
        <p>That is all a Bombe does: Enigma scramblers wired together by the menu, electric current doing the following, and a stop when something survives. Turing designed it in 1939, after the Polish bomba of 1938. Gordon Welchman's <b>diagonal board</b> added one fact, that a plug is a swap: if <em>a</em> goes to <em>u</em>, then <em>u</em> goes to <em>a</em>. The first British machine, Victory, was installed at Bletchley Park on 18 March 1940, and about 200 followed. A run over one wheel order took early machines about 20 minutes, and later ones less.</p>
        <p>Below, software plays the relays: the same logic over all ${n0(26 ** 3)} positions. Without knowing a single plug it finds the setting the message was really enciphered with. It is told the wheel order, the rings, the reflector and the Greek wheel's place. On a real M4 each of those was more runs, or more reasoning: the ${n0(KS.orders)} wheel orders, and for the Greek wheel 26 positions, which is why four-wheel bombes were needed.</p>
        <p>The M4 was the navy's answer. From 1 February 1942 U-boat traffic used the fourth wheel, and Bletchley's regular reading stopped. It resumed in December 1942, after a weather code book taken from U-559 in late October gave cribs. With thin reflector b, and Beta at A with its ring at A, the machine is exactly the three-wheel one (a test here checks it), which helped. The US Navy's four-wheel bombes, tested from May 1943, finished the job.</p>
        <p class="try"><b>Try:</b> run the whole crib, with and without the board. A long crib with many loops is generous, so now shorten it and run again: false stops appear, and real cribs were often short. Each stop was a person checking it by hand.</p>
        <details class="deeper"><summary>Where this comes from</summary><p><a href="https://en.wikipedia.org/wiki/Bombe" target="_blank" rel="noopener">Bombe</a> (Wikipedia, citing Hinsley, Welchman and Wenger: its counts of machines vary with the source, so "about 200" is theirs) and <a href="https://en.wikipedia.org/wiki/Cryptanalysis_of_the_Enigma" target="_blank" rel="noopener">Cryptanalysis of the Enigma</a>. The stop counts on this page are for this crib and key: they vary widely with the menu's loops, and this model steps the wheels exactly, where the real machine's short cribs ignored the middle wheel's turnover.</p></details>`,
      widget: bombeWidget,
    },
    {
      title: 'What the breaking taught',
      body: `
        <p>Modern cipher design reads like a list of what went wrong here. Each row here is a rule still in force, and AES, built later in this chapter, follows all of them.</p>
        <p>Key sizes are worth a sum. If a machine could try one key per clock at 1 GHz, the M4's ${sci(KS.withoutPlugs)} wheel-and-ring settings take under ${n0(Math.ceil(Number(KS.withoutPlugs) / 1e9 / 60))} minutes: that part alone is nothing today. AES-128 has 2<sup>128</sup> keys. Nothing you can build gets near that, and the design's job is to make sure nothing cleverer does either.</p>`,
      widget: lessonsWidget,
    },
    {
      title: 'From the Bombe to the stored program',
      body: `
        <p>It is often said that breaking Enigma gave us the computer. The real line is more interesting, and you have already walked its end of it.</p>
        <p><b>1936.</b> Before any of this, Turing's paper <em>On Computable Numbers</em> describes a universal machine: one fixed machine that takes another machine's description as input. Program and data share one memory, the idea behind the CPU you built.</p>
        <p><b>1940: the Bombe</b> is electromechanical and built for one job. Its "program" is a menu wired up on the back. It decides nothing beyond stop or carry on. Turing designed it, but it does not embody his universal machine.</p>
        <p><b>1943–44: Colossus</b>, Tommy Flowers's machine at Bletchley, is electronic, with 1 600 and later 2 400 valves. It did not attack Enigma: it attacked the Lorenz teleprinter cipher, and Turing did not design it, though both are often said. It was programmable by switches and plugs, and is regarded as the first programmable electronic digital computer. It was not a stored-program machine, and its secrecy limited its influence: EDVAC's design was the one that spread.</p>
        <p><b>1948: the Manchester Baby.</b> Max Newman, who had worked on Colossus at Bletchley, championed the Manchester project: he recruited F. C. Williams and arranged the funding and surplus parts, Colossus material among them. Williams, Tom Kilburn and Geoff Tootill built it. On 21 June 1948 the Baby ran a program held in read-write electronic memory. Turing wrote the third program it ran. Compare the three on this site's terms: the Bombe's function is its wiring, as with a chapter's gates; Colossus's is set by switches; the Baby's is words in memory, as in the CPU you built with its instruction memory and fetch.</p>
        <details class="deeper"><summary>Where this comes from</summary><p><a href="https://en.wikipedia.org/wiki/Colossus_computer" target="_blank" rel="noopener">Colossus computer</a> (the Lorenz target, valve counts, not stored-program, little direct influence), <a href="https://en.wikipedia.org/wiki/Manchester_Baby" target="_blank" rel="noopener">Manchester Baby</a> (the date, Newman, the surplus parts, Turing's program), <a href="https://en.wikipedia.org/wiki/Universal_Turing_machine" target="_blank" rel="noopener">Universal Turing machine</a> (Davis on the action table in the same memory as the data), <a href="https://en.wikipedia.org/wiki/Bombe" target="_blank" rel="noopener">Bombe</a>, and <a href="https://en.wikipedia.org/wiki/Kerckhoffs%27s_principle" target="_blank" rel="noopener">Kerckhoffs's principle</a> for the previous step. All Wikipedia, read for their citations: treat "first" with care, as those articles do. The Zuse Z3 of 1941 is the first programmable electromechanical one, and which machine counts as first depends on the definition.</p></details>`,
      widget: machinesWidget,
    },
    {
      title: 'AES: four steps and a key',
      body: `
        <p>Now the design that followed those rules. AES-128 works on 16 bytes, written as four columns of four, and repeats a round ten times. A round is four steps, and each has one job: <b>SubBytes</b> breaks linearity, a byte at a time; <b>ShiftRows</b> and <b>MixColumns</b> spread each byte across the block; <b>AddRoundKey</b> brings in the key. Before round 1 the key is XORed in once, because without that an attacker could undo the first round's steps with no key at all.</p>
        <p>The round keys come from the 128-bit key by a small schedule, one new key a round, using the S-box and a constant. Compare the wheel: there the "key" is which wires and where they stand, and it is a fixed part of a machine. Here it is sixteen bytes in a register, and the structure never changes.</p>
        <p class="try"><b>Try:</b> step through round 1 with the buttons. In orange: what that step changed. Then take the round slider to 10 and find the MixColumns that is not there.</p>
        <details class="deeper"><summary>Where this comes from</summary><p>The values are <a href="https://csrc.nist.gov/pubs/fips/197/final" target="_blank" rel="noopener">FIPS 197</a>'s Appendix B, which the test suite compares with every state of every round, then with SP 800-38A's vectors and 300 random blocks against Node's own crypto.</p></details>`,
      widget: aesExplorerWidget,
    },
    {
      title: 'The S-box, in gates',
      body: `
        <p>Most descriptions show the S-box as a table of 256 numbers, and in software it often is one. It is not arbitrary: it is the inverse in GF(2⁸), then an affine map. The inverse has very low correlation between input and output, which is what the known attacks on such a table need, and the affine map removes its fixed points at 0 and 1. So here there is no ROM at all.</p>
        <p>Inverting directly in GF(2⁸) would be large, so this splits the field into a tower, GF(4) inside GF(16) inside GF(256): a byte becomes two half-sized numbers, and the inverse needs a few multiplications and one inverse in the smaller field, and so on down. The whole S-box is <b>${n0(COSTS.parts.aes_sbox.nands)} NANDs</b>, of which the inverse is ${n0(COSTS.parts.aes_gf256_inverse.nands)}, with a depth of ${COSTS.parts.aes_sbox.depth} gate delays. In software the same table lives in memory, and its access time depends on what was recently read, which is how table-based AES has leaked keys through caches. Gates like these take the same time for every input.</p>
        <p class="try"><b>Try:</b> set <em>x</em> to 0x53. FIPS 197's example gives 0xED. Open the blocks and keep going: every level is a smaller field, down to NANDs.</p>`,
      scene: sboxScene,
    },
    {
      title: 'A round, and the core',
      body: `
        <p>Open the box and a round is what the explorer showed: sixteen S-boxes side by side, then ShiftRows, which is <b>no gates at all</b>, only wires going elsewhere, then four MixColumn blocks of ${n0(COSTS.parts.aes_mixcolumn.nands)} NANDs each, built from XORs, then an XOR with the key. The total is ${n0(COSTS.parts.aes_round.nands)} NANDs, and ${n0(COSTS.parts.aes_subbytes.nands)} of them are the S-boxes: the non-linear step is where the cost goes. Set <em>last</em> to 1 and the round bypasses MixColumns.</p>
        <p>The whole core uses that one round again and again: a state register, a round-key register, a key-schedule step of ${n0(COSTS.parts.aes_key_step.nands)} NANDs and a counter. That is <b>${n0(COSTS.cores.aes_core.nands)} NANDs</b> and ${COSTS.cores.aes_core.cycles} clocks a block, at a period of ${COSTS.cores.aes_core.period} gate delays. The Enigma in gates took ${n0(GATES)}. For under three times the gates you get a key you can change by writing a register, and a key space no search will finish.</p>
        <p class="try"><b>Try:</b> toggle <em>last</em> and watch the round's output <em>y</em> change. The next step runs the whole core.</p>`,
      scene: () => ({ ...aesRoundScene(), path: ['round'] }),
    },
    {
      title: 'The core runs the standard',
      body: `
        <p>This is the core on FIPS 197's example, with the key and block wired in, as a stage input holds only 53 exact bits. It takes ${COSTS.cores.aes_core.cycles} clocks: one to load and one per round. The test suite compares its state and round key with the standard's table after every clock, and with Node's crypto on other blocks.</p>
        <p class="try"><b>Try:</b> set <em>start</em> to 1 and press Pulse once. Set <em>start</em> to 0 and press Pulse ten times. <em>done</em> rises and <em>out</em> reads the standard's ciphertext, 3925841d 02dc09fb dc118597 196a0b32. Its bytes run from the top of the word down, so read the hex as the bench prints it.</p>`,
      scene: () => ({ ...aesCoreScene(), engine: 'cycle' as const }),
    },
    {
      title: 'One bit changes everything',
      body: `
        <p>Here is the Enigma's other weakness, measured. Flip one bit of input and follow the difference through the rounds. MixColumns spreads each changed byte to four, ShiftRows sends those to four columns, and the S-box makes the change unpredictable: within two or three rounds about half the state differs, which is what two unrelated random blocks would show.</p>
        <p>This is <b>diffusion</b>, and it is what a crib cannot get a grip on: a guess about part of a block tells you nothing about the rest. An Enigma never mixes one letter with another. Each letter meets the machine alone, which is why the Bombe could reason along a crib one place at a time.</p>
        <p class="try"><b>Try:</b> move the slider to flip other bits. The first bars depend on which bit. The last ones hardly do, and they sit around 64.</p>`,
      widget: avalancheWidget,
    },
    {
      title: 'Modes: blocks are not enough',
      body: `
        <p>A block cipher turns 16 bytes into 16 bytes. Messages are longer, and how you chain the blocks matters as much as the cipher. Enciphering each block alone, <b>ECB</b>, leaks every repeat. <b>CTR</b> enciphers a counter and XORs the result in, which turns AES into a stream and hides repeats. It needs only the encrypt direction, so these gates do both jobs.</p>
        <p>CTR has one absolute rule. Use a counter value twice under one key and the keystream cancels, with no key needed. That is the Enigma operators' reused settings again, and exactly what real systems still get wrong. It also has no idea whether anyone changed the message: flip a ciphertext bit, and that plaintext bit flips, and nothing notices.</p>
        <p><b>GCM</b> adds a tag: a keyed polynomial over the ciphertext, computed in GF(2¹²⁸). A changed bit anywhere makes the tag fail, and the message is refused. TLS 1.3 only allows modes of this kind. Enigma had nothing like it: anyone could inject a message that looked right if they had the machine and the key sheet.</p>
        <p class="try"><b>Try:</b> look at ECB, then CTR, then what the same nonce twice gives. No key was used in that last picture.</p>
        <details class="deeper"><summary>Where this comes from</summary><p><a href="https://csrc.nist.gov/pubs/sp/800/38/a/final" target="_blank" rel="noopener">SP 800-38A</a> for ECB and CTR, <a href="https://csrc.nist.gov/pubs/sp/800/38/d/final" target="_blank" rel="noopener">SP 800-38D</a> for GCM. CTR and GCM here are checked against Node's crypto and GCM's published test cases.</p></details>`,
      widget: modesWidget,
    },
    {
      title: 'A fingerprint: SHA-256',
      body: `
        <p>A hash has no key. It turns any message into 256 bits so that nobody can find a message for a given digest, or two messages with one digest. So it is a fingerprint: publish the digest, and anyone can check the file. Everything later in this chapter leans on it, because keys are derived with it and handshakes are bound together by it.</p>
        <p>A message is padded and cut into 64-byte blocks. Each block is expanded to 64 words and stirred through 64 rounds into eight 32-bit registers, whose starting values and round constants are the fractional bits of square and cube roots of primes. That is deliberately nothing-up-my-sleeve: anyone can recompute them, and here the code does.</p>
        <p class="try"><b>Try:</b> change one letter. About half the digest's bits move, as with AES, and for the same reason.</p>
        <details class="deeper"><summary>Where this comes from</summary><p><a href="https://csrc.nist.gov/pubs/fips/180-4/upd1/final" target="_blank" rel="noopener">FIPS 180-4</a>. The test suite compares the constants with the standard, every round of NIST's worked examples, and random messages with Node's crypto.</p></details>`,
      widget: shaWidget,
    },
    {
      title: 'SHA-256 in gates',
      body: `
        <p>A round is below: two of the Σ functions, Ch, Maj and five 32-bit adders. Rotations are wires, so Σ costs only its XORs. This is all adders and logic, with no S-box, and a different kind of mixing: addition carries across bits, which XOR does not, and the two together are hard to invert. One round costs ${n0(COSTS.parts.sha_round.nands)} NANDs, about a quarter of an AES round.</p>
        <p>The core adds a message schedule of ${n0(COSTS.parts.sha_schedule.nands)} NANDs, because it stores 16 words, and a table of constants of ${n0(COSTS.parts.sha_k_rom.nands)}. In all <b>${n0(COSTS.cores.sha_core.nands)} NANDs</b> and ${COSTS.cores.sha_core.cycles} clocks per 64 bytes, against AES's ${COSTS.cores.aes_core.cycles} clocks per 16. Per byte that is ${(COSTS.cores.sha_core.cycles / 64).toFixed(2)} clocks against AES's ${(COSTS.cores.aes_core.cycles / 16).toFixed(2)}, at a period of ${COSTS.cores.sha_core.period} gate delays against ${COSTS.cores.aes_core.period}.</p>
        <p class="try"><b>Try:</b> open the block to see the round on the first round of "abc", as NIST's worked example has it. Open Σ0 and find that its rotations cost nothing.</p>`,
      scene: shaRoundScene,
    },
    {
      title: 'The SHA-256 core runs "abc"',
      body: `
        <p>The whole compression, on the block that holds "abc" and its padding. The test suite compares a to h after every clock with NIST's table of 64 rounds, then the digest of longer messages with Node's crypto.</p>
        <p class="try"><b>Try:</b> set <em>start</em> to 1, Pulse once, set <em>start</em> to 0, then Run until <em>done</em> lights. <em>out</em> is ba7816bf 8f01cfea 414140de 5dae2223 b00361a3 96177a9c b410ff61 f20015ad.</p>`,
      scene: () => ({ ...shaCoreScene(), engine: 'cycle' as const }),
    },
  ],
  soon: ['Sharing a secret in public', 'X25519 on our CPU', 'Who is at the other end', 'A TLS 1.3 handshake', 'What it all costs'],
};
