import { COLUMNS, programDeck } from '../cards/card';
import { CHARSET } from '../cards/hollerith';
import { deckReader } from '../cards/reader';
import { assemble } from '../riscv/asm';
import { PROGRAMS } from '../riscv/programs';
import { cardEditorWidget, censusWidget, deckWidget, loomWidget, readerPanel, sampleDeck } from '../widgets/cards';
import { loom3d } from '../widgets/loom3d';
import { withModel } from '../widgets/modelhost';
import { press3d } from '../widgets/press3d';
import { bench, type Chapter } from './types';
import { numOf } from './order';

const SUM = assemble(PROGRAMS.find((p) => p.id === 'sum')!.source);
const SUM_DECK = programDeck('sum.s', SUM.lines.map((l) => ({ word: l.word, source: l.text })));
/** Clock edges between taking a card and the next one at the station (a real reader: 75 ms a card). */
const FEED = 2;
const READER = bench(deckReader(SUM_DECK, 'word', { feed: FEED }));
const SORT_CARDS = sampleDeck().cards.length;
/** Binomial coefficient: the hole patterns of a column with exactly k of its 12 positions punched. */
const choose = (n: number, k: number): number => (k === 0 ? 1 : (choose(n - 1, k - 1) * n) / k);
const ROWS = 12;
/** Cards a minute of the IBM 082 sorter (the step's text), and of the IBM 1402 reader. */
const SORTER_CPM = 650;
const READER_CPM = 800;
const N = SUM_DECK.cards.length;
/** Rising edges until the reader is empty with next held at 1: card k is taken at edge (FEED + 1)(k − 1) + 1. */
const EDGES_ALL = (FEED + 1) * (N - 1) + 1;
const hex = (w: number) => `0x${(w >>> 0).toString(16).padStart(8, '0')}`;
const wordOf = (k: number) => SUM.lines[k].word >>> 0;

export const chCards: Chapter = {
  id: 'cards', num: numOf('cards'), prologue: 'P3', title: 'Punch cards', level: 'Input',
  blurb: 'Holes in cards: a loom\'s pattern, a nation counted, a program a card at a time, and the reader that feeds it in.',
  goals: [
    'count combinations on a tabulator: relay contacts in series for AND, in parallel for OR',
    'punch and read a character in the 029\'s Hollerith code, zone and digit rows',
    'explain why a card sorter sorts on the least significant column first, and how many passes it needs',
    'read a deck into a circuit through a card reader\'s ready, data, empty and next',
  ],
  builds: ['relays'],
  recap: {
    keep: [
      'Jacquard (1804): a card per pick, a hole lets its hook lift its warp threads. The loom is fixed and the pattern lives in the deck: a program.',
      'Hollerith (1890): a pin through a hole closes a circuit through mercury and steps a dial. Combinations go through relay contacts, in series for AND, in parallel for OR.',
      `IBM's card: ${COLUMNS} columns of 12 rows. A digit is one hole, a letter a zone (12, 11 or 0) and a digit, most signs add an 8; only ${CHARSET.length} of a column's 4096 patterns are characters.`,
      'A card sorter drops each card into the pocket of its digit in one column. Rightmost column first, each pass stable, a pass per digit: the radix sort.',
      `To a circuit a card reader is <code>ready</code>, <code>data</code>, <code>empty</code>, and <code>next</code> taken at a rising edge. Here the next card arrives ${FEED} edges after each one; the IBM 1402 read 800 cards a minute.`,
    ],
    practise: ['h_card', 'h_loader'],
    check: [
      {
        question: 'Which holes does the 029 punch for the letter T?',
        options: ['0 and 3', '11 and 3', '12 and 3', '0 and 2'],
        answer: 0,
        explain: 'The 0-zone letters start at 2: S is 0-2, so T is 0-3.',
        why: ['', '11-3 is L: zone 11 holds J to R.', '12-3 is C: zone 12 holds A to I.', '0-2 is S. The 0 zone starts at digit 2, so T is one further.'],
      },
      {
        question: 'A dropped deck carries sequence numbers from 1 to 999. How many passes through the sorter put it back in order?',
        options: ['3', '1', '10'],
        answer: 0,
        explain: 'One pass per digit of the key, rightmost first: units, tens, hundreds.',
        why: ['', 'One pass sorts on one column only: cards with the same last digit stay mixed on the others.', 'Ten is the number of digit pockets, not of passes. The passes follow the number of digits in the key.'],
      },
      {
        question: `The reader holds next at 1 and needs ${FEED} edges to feed each card. How many rising edges take a 10-card deck?`,
        options: [`${10 + 9 * FEED}`, '10', `${10 * (FEED + 1)}`],
        answer: 0,
        explain: `A card is taken at an edge, then the reader needs ${FEED} edges to bring the next: 10 + 9 × ${FEED} = ${10 + 9 * FEED}.`,
        why: ['', `A card is taken only at an edge where one is ready. After each one the reader needs ${FEED} more edges to feed the next.`, 'No feed time follows the last card: after it the hopper is empty.'],
      },
    ],
  },
  steps: [
    {
      title: 'A chain of cards',
      body: `
        <p>In 1804 Joseph-Marie Jacquard put a loom under the control of a chain of punched cards. Each card is one pass of
        the weft (a <strong>pick</strong>). Over the warp sit hooks, one per card position: where the card has a hole, the hook
        passes through and lifts its warp threads, so the weft runs under them; where it has none, the hook is stopped and
        the threads stay down. A harness ties each hook to every eighth thread here, so the pattern repeats across the cloth,
        and the chain is laced into a loop, so it repeats down its length.</p>
        <p>The cards are a <strong>program</strong> in every sense that matters: the loom is fixed, the pattern lives in the
        holes, and a new pattern is a new deck, not a new machine. A portrait of Jacquard woven in silk around 1839 took
        some 24 000 cards. Babbage meant his Analytical Engine to take its program the same way; Ada Lovelace wrote that it
        "weaves algebraical patterns just as the Jacquard loom weaves flowers and leaves".</p>
        <p>What makes it a program and not just a pattern: the information is in the cards and the machine reads it one pick at a time, in order, and loops. A
        stored program that selects among actions by position in a sequence is the same architecture as a <span data-ahead="rom">ROM (a fixed table of words, read-only memory)</span> read by a counter (a chain is a ROM, the
        reader is the <span data-ahead="pc">program counter, the register that names the next instruction</span>). It has no branch: the chain runs on, and a conditional is a cut or a different chain.</p>
        <div class="try">Weave the diamond, then punch or clear a hole in one card and weave again: the change repeats
        everywhere that card and that hook meet.</div>`,
      more: {
        derive: `<p>A chain of n cards on a loom with h hooks stores n × h bits, one per position: hole or no hole. The weave is the function (pick k, thread j) → whether hook (j mod h) is lifted on card k mod n.
          That is periodic in two directions with periods n down the length and h across, so one deck and one harness tie decide the pattern's repeat, with no other memory. Changing one hole changes
          every thread that card and hook meet, which is what the loom does when a card is punched.</p>`,
        pitfall: `<p>Mixing the two repeats. The number of cards sets the repeat down the cloth; the number of hooks sets it across. A bigger design needs more cards and more hooks (and a
          harness that ties every thread to its own hook), so the cost grows with the picture's area, not with its detail alone.</p>`,
        real: `<p>Babbage planned the Analytical Engine with two decks in the Jacquard style: operation cards to say what to do, and variable cards to say where the numbers were.
          That is a program and an address field on cards, a century before either word had its meaning. Jacquard looms stayed in use well into the twentieth century.</p>`,
      },
      widget: () => withModel(loomWidget(), loom3d()),
      challenge: {
        kind: 'quiz', question: 'A loom has 8 hooks and a chain of 6 cards. After how many picks does the cloth repeat down its length?',
        options: ['6', '8', '48', '14'], answer: 0,
        explain: 'The chain loops after its last card, so pick 7 reads card 1 again. The 8 hooks set the repeat across the cloth, not along it.',
        why: ['', 'The 8 hooks set the repeat across the cloth (the harness ties each hook to every eighth thread), not down its length.', 'Cards and hooks do not have to come round together: down the length only the chain matters.', 'Cards and hooks do not add: one card is one pick, and the chain loops after 6.'],
      },
    },
    {
      title: 'Counting a nation',
      body: `
        <p>The 1880 US census took eight years to tabulate by hand. For 1890 Herman Hollerith punched each person onto a card:
        sex, age group, marital status, birthplace, each a hole in a field. A clerk put a card in the <strong>pin press</strong>
        and closed it. A grid of spring pins came down; a pin that met a hole dipped into a cup of mercury beneath and closed
        a circuit, and each circuit stepped a counting dial on by one. The count of nearly 63 million people was out in months.</p>
        <p>Counting a <em>combination</em> (married women) needs AND: the circuits of both holes energize relays, and the dial
        is driven through their contacts in series, as in <a href="#/c/relays/0">prologue P1</a>. The data had become electrical. Hollerith's company
        merged into what was named IBM in 1924, and the card stayed the computer's input for half a century.</p>
        <p>What was new was not the card but the <em>reading</em>: a hole becomes an electrical event, and from then on counting is wiring. A dial counts any signal that
        steps its magnet, and which holes step it is a matter of how the relays between the pins and the dial are connected. Changing the question changes the wiring, not the
        deck, so one deck answers many questions, and the same card can be fed through again for each.</p>
        <div class="try">Press a few cards one by one and watch which dials move, then run the stack.</div>`,
      more: {
        derive: `<p>With each hole closing a circuit, a relay per hole turns the circuits into Boolean variables, and the contacts of
          <a href="#/c/relays/0">prologue P1</a> compute on them: two contacts in series are AND, in parallel OR, and a break contact is NOT. "Married and born abroad" is two make contacts in series
          in front of one dial; "married or born abroad" is two in parallel; "married and not born abroad" is a make contact and a break contact in series. Every count is a sum of products of the holes.</p>`,
        pitfall: `<p>Counting an OR by adding two dials. A person who is both married and born abroad steps both dials, so their sum counts them twice; the parallel contacts step one dial once.
          The same mistake appears in a database query that adds two group counts instead of counting the union.</p>`,
        real: `<p>Later tabulators moved the wiring to a removable plugboard, so a machine was reprogrammed by plugging wires: a program held in wires, between the fixed
          machine and the deck of data. Hollerith's firm, merged into C-T-R in 1911, was renamed IBM in 1924, and the card stayed the computer's input for half a century.</p>`,
      },
      widget: () => withModel(censusWidget(), press3d()),
      challenge: {
        kind: 'quiz', question: 'How would the tabulator count people who are married OR born abroad, with one dial?',
        options: ['Drive the dial through the two holes\' relay contacts in parallel', 'In series', 'Add the two dials afterwards', 'It cannot'],
        answer: 0,
        explain: 'Contacts in parallel conduct when either closes: OR. Adding the two dials afterwards would count a married immigrant twice.',
        why: ['', 'Contacts in series conduct only when both close: that counts people who are married and born abroad, an AND.', 'A person who is both steps each dial once, so the sum counts them twice.', 'Contacts in parallel give OR as directly as contacts in series give AND.'],
      },
    },
    {
      title: 'Eighty columns',
      body: `
        <p>IBM's card of 1928 has ${COLUMNS} columns of 12 rectangular hole positions on 7⅜ × 3¼ inches of card stock. A column holds one
        character in the <strong>Hollerith code</strong> as punched by the IBM 029 keypunch (1964): the digit rows 0–9, and above
        them two unprinted <em>zone</em> rows, 12 and 11 (0 doubles as the third zone). A digit is one hole; a letter is a zone
        and a digit (A = 12-1, J = 11-1, S = 0-2); most signs add an 8 to a digit. A column is 12 bits, but only ${CHARSET.length}
        of its 4096 patterns are characters (the blank included): at most three holes, so the card stays stiff enough to feed.</p>
        <p>There is no lower case and no curly brace. The keypunch printed each character along the top edge so that
        people could read the card; machines read the holes. Readers took cards face down, the 9 edge first.</p>
        <p>The code is built around what a counting machine needs: a digit is one hole in the digit rows, one pin per digit. The alphabet was added
        with zone rows above them, so a letter is a zone and a digit, and the odd corners of the code (the 0-zone letters starting at 2, the signs that add an 8) come
        from fitting 26 letters, signs and digits into 12 rows without ever punching more than three holes.</p>
        <div class="try">Type a line and watch it punch. Then click positions on the card: a pattern that is not in the
        code reads as no character at all.</div>`,
      more: {
        derive: `<p>A column has ${ROWS} positions, so ${2 ** ROWS} patterns, and a card ${COLUMNS} × ${ROWS} = ${COLUMNS * ROWS} positions. The code uses ${CHARSET.length} of the ${2 ** ROWS} patterns for a column,
          with at most three holes: ${[0, 1, 2, 3].map((k) => choose(ROWS, k)).join(' + ')} = ${[0, 1, 2, 3].reduce((n, k) => n + choose(ROWS, k), 0)} patterns have three holes or fewer,
          of which ${CHARSET.length} are characters. Information-wise the card holds ${COLUMNS} characters, about ${Math.floor(COLUMNS * Math.log2(CHARSET.length) / 8)} bytes, in ${COLUMNS * ROWS} positions: the code spends bits for
          stiffness and for rows that fit the digit-counting machines.</p>`,
        numbers: `<table class="mini"><tr><th>holes in a column</th>${[0, 1, 2, 3, 4].map((k) => `<td>${k}</td>`).join('')}</tr>
          <tr><th>patterns</th>${[0, 1, 2, 3, 4].map((k) => `<td>${choose(ROWS, k)}</td>`).join('')}</tr></table>`,
        pitfall: `<p>Treating a column as a byte. A column is 12 bits of which only ${CHARSET.length} patterns mean anything, and an unnamed pattern is a punch error that the machine rejects or reads as no character.
          Two columns do not make a 16-bit value either: binary cards (like this chapter's object cards) use all 12 rows of a column as bits, outside the Hollerith code.</p>`,
        real: `<p>IBM's EBCDIC, the character code of the System/360, grew out of the card code: its letters sit in the same zone-and-digit groups with gaps (A to I, J to R, S to Z), which is why
          the alphabet is not contiguous there. The 80-column card shaped terminals too: 80 characters a line.</p>`,
      },
      widget: () => cardEditorWidget(),
      challenge: {
        kind: 'quiz', question: 'Which holes does the 029 punch for the letter K?',
        options: ['11 and 2', '12 and 11', '11 and 1', '0 and 2'], answer: 0,
        explain: 'J, K, L … R are zone 11 with the digits 1 to 9, so K is 11-2. A is 12-1 and S is 0-2: the 0-zone letters start at 2.',
        why: ['', 'A letter is one zone and one digit, and 12 and 11 are both zones.', '11-1 is J, the first letter of zone 11. K is the next one.', '0-2 is S: zone 0 holds S to Z.'],
      },
    },
    {
      title: 'A program on cards',
      body: `
        <p>A program was punched one statement a card (a <em>source deck</em>), and an <span data-ahead="assembly">assembler (a program that turns mnemonics into machine words)</span> or compiler punched out the
        result as an <strong>object deck</strong> of machine words in binary. Here each object card holds one RISC-V
        instruction: the 32-bit word along row 9 from column 1, most significant bit first, its source line and the word in
        hex printed along the top. Real machines packed more: the IBM 704 read each of a card's 12 rows as two 36-bit words.
        One word a card wastes 928 of 960 positions, and is readable at a glance.</p>
        <p>Columns 73–80 hold a <strong>sequence number</strong>, counted in tens so a card can be slipped in later (the IBM 704's card reader read only 72 columns, so FORTRAN never saw these eight, which left them free for this). A dropped deck goes back on a <strong>card sorter</strong>: an IBM 082 drops
        each card into the pocket of the digit in one column, 650 cards a minute. Stack the pockets 0 to 9 and sort on the
        next column to the left: after the last pass the deck is in order. That is the radix sort, least significant digit
        first, a pass per digit, each pass stable.</p>
        <p>Why the sorter needs no comparison: it never asks which of two cards is larger. It looks at one column of one card and drops the card in a pocket, and
        <em>stability</em> does the rest. Because each pass keeps the order of cards that fall in the same pocket, a later pass on a more significant digit cannot disturb the order
        the earlier passes made among equal digits. The deck is guaranteed sorted only after the pass on the most significant column, which also tells the operator when to stop.</p>
        <div class="try">The deck is the bubble-sort sample, ${SORT_CARDS} cards. Drop it, then sort it on the sorter and count the passes.</div>`,
      more: {
        derive: `<p>Claim: after the pass on digit k (counting from the right), the deck is sorted on its last k digits. For k = 1 it is true by construction. Suppose it holds for k − 1 and the pass on digit k
          drops each card in the pocket of that digit. Two cards in different pockets are in the order of digit k, whatever the lower digits. Two cards in the same pocket keep the order they had, which is the order on the lower k − 1
          digits. So the deck is sorted on k digits. A key of d digits takes d passes, independent of the number of cards: the deck of N cards takes d × N / ${SORTER_CPM} minutes at the 082's ${SORTER_CPM} cards a minute.</p>`,
        numbers: `<table class="mini"><tr><th>key digits</th><th>passes</th><th>1000 cards</th><th>10 000 cards</th></tr>${[1, 2, 3, 4, 6].map((d) => `<tr><td>${d}</td><td>${d}</td><td>${(d * 1000 / SORTER_CPM).toFixed(1)} min</td><td>${(d * 10000 / SORTER_CPM / 60).toFixed(1)} h</td></tr>`).join('')}</table>`,
        pitfall: `<p>Sorting from the most significant column "to save passes". The first pass gives ten pockets; each pocket would then need sorting alone on the next column, ten sub-piles of ten sub-piles, and the operator
          has to keep track of all of them by hand. Least significant first needs only the one stack and one rule.</p>`,
        real: `<p>This is the least-significant-digit radix sort, the same algorithm as in a modern library, with the card sorter's pockets as the buckets. Knuth's sorting-by-distribution section describes this card method.
          Merging two sorted decks was the job of another machine, the collator.</p>`,
      },
      widget: () => deckWidget(),
      challenge: {
        kind: 'quiz', question: 'Why does the operator sort on the rightmost column first?',
        options: [
          'Each pass keeps the order of cards with the same digit, so the last pass (the most significant digit) decides, and ties stay in the order of the digits below',
          'The sorter can only read column 80', 'It is faster', 'Either order works'],
        answer: 0,
        explain: 'Sorting most significant first would scramble the order within a pocket on the next pass. Least significant first, every pass is stable, so after the pass on digit k the deck is sorted on the last k digits.',
        why: ['', 'The 082 reads whichever column the operator sets for the pass.', 'Both orders take a pass per digit. The order decides whether the result is sorted, not how fast.', 'Most significant first, the next pass regroups the cards by a lower digit and undoes the higher one.'],
      },
    },
    {
      title: 'A machine that reads them',
      body: `
        <p>A <span data-show="u"><strong>card reader</strong></span> moves cards from a hopper past brushes or photocells. To a circuit it is three
        signals and a request: <span data-show="pin:ready"><code>ready</code></span> while a card waits at the read station, <span data-show="pin:data"><code>data</code></span> the word punched
        in its row 9, <span data-show="pin:empty"><code>empty</code></span> once the last card is gone, and <span data-show="pin:next"><code>next</code></span> = 1 at a rising clock edge takes the
        card. The next one arrives ${FEED} edges later: a reader is mechanical, and the IBM 1402 read 800 cards a minute, 75 ms
        a card. Like a keyboard it stands for the world outside, so it costs no gates.</p>
        <p>This deck is the sum program, ${SUM_DECK.cards.length} cards. Feeding it into a computer's memory is a job for a little program
        of its own: the IBM 1401's <strong>Load</strong> key read the first card into memory and ran it, and that card read the
        rest. <a href="#/c/bus/5">Chapter 38</a> builds that boot loader on a bus computer, and the sandbox has the card reader as a part, with
        decks made from any stored program.</p>
        <p>The interface is a <span data-ahead="handshake">handshake (a ready signal answered by a take signal)</span> of the oldest kind. The reader says <code>ready</code>; the computer says <code>next</code>; the transfer happens at a
        clock edge where both are 1. Neither side can force the other: a slow program leaves the card waiting at the station, a slow reader leaves the program polling <code>ready</code>, and a program that
        never raises <code>next</code> reads nothing. The same ready and take protocol returns on the bus in chapter 38 and in every streaming interface since.</p>
        <div class="try">Set <code>next</code> to 1 and Pulse: each card's word appears on <code>data</code>, with ${FEED} empty
        cycles between cards while the reader feeds.</div>`,
      scene: () => ({ root: READER, inputs: { next: 0 }, clock: 'clk', autoClock: false, panels: [readerPanel] }),
      tries: [(st) => st.getInput('next') === 1 && st.cycles > 0],
      tour: {
        label: 'Walk me through the handshake',
        beats: [
          { title: 'A card waits', reset: true, set: { next: 0 }, cycles: 2, show: ['u'], expect: { ready: 1, empty: 0, data: wordOf(0) },
            say: `<p>Two edges with next = 0: nothing is taken. ready = {v:ready}, empty = {v:empty}, and data holds card 1's word, ${hex(wordOf(0))}. The reader waits for the computer.</p>` },
          { title: 'Take a card', set: { next: 1 }, cycles: 1, show: ['u'], expect: { ready: 0, empty: 0, data: 0 },
            say: `<p>next = 1 and one rising edge: card 1 is taken. The reader starts feeding the next one: ready = {v:ready}, and data reads {v:data} (no card at the station).</p>` },
          { title: 'Feeding', set: {}, cycles: FEED, show: ['u'], expect: { ready: 1, data: wordOf(1) },
            say: `<p>${FEED} more edges: the next card has arrived. ready = {v:ready} and data is card 2's word, ${hex(wordOf(1))}. A card costs ${FEED + 1} edges with next held at 1: one to take it, ${FEED} to feed the next.</p>` },
          { title: 'Another', set: {}, cycles: FEED + 1, show: ['u'], expect: { ready: 1, data: wordOf(2) },
            say: `<p>The same again: card 3's word, ${hex(wordOf(2))}, is at the station after ${FEED + 1} edges. Nothing is lost in between because the reader holds each card until it is taken.</p>` },
          { title: 'The last card', set: {}, cycles: EDGES_ALL - (FEED + 1) * 2, show: ['u'], expect: { ready: 0, empty: 1 },
            say: `<p>Edge ${EDGES_ALL}: card ${N} is taken and the hopper is empty. empty = {v:empty}, ready = {v:ready}. ${N} cards took ${EDGES_ALL} edges, ${N} + ${N - 1} × ${FEED}.</p>` },
        ],
      },
      more: {
        derive: `<p>With next held at 1, a card is taken at every edge where ready is 1, and then ready stays 0 for ${FEED} edges. Card k is taken at edge ${FEED + 1}·(k − 1) + 1, so the n-card deck is empty after ${FEED + 1}·(n − 1) + 1 = n + (n − 1) × ${FEED} edges:
          ${N} cards take ${EDGES_ALL}. Throughput is 1 / ${FEED + 1} cards per edge. A real reader's 75 ms a card (${READER_CPM} cards a minute) would be ${FEED + 1} edges of a clock of ${Math.round((FEED + 1) / 0.075)} Hz.</p>`,
        numbers: `<table class="mini"><tr><th>cards</th><th>edges, next held at 1</th></tr>${[1, 2, 10, N, 100].filter((k, i, a) => a.indexOf(k) === i).map((k) => `<tr><td>${k}</td><td>${(FEED + 1) * (k - 1) + 1}</td></tr>`).join('')}</table>`,
        pitfall: `<p>Reading data when ready is 0. Between cards data is 0, which is a valid word: a program that takes it as a card gets a stream of zeros and loses the card it should have waited for. Take a card only at an edge where
          ready was 1, and use empty, not a zero word, to know the deck has ended.</p>`,
        real: `<p>The IBM 1402 read ${READER_CPM} cards a minute, a card every 75 ms. A machine this fast needed a buffer: the reader fed a memory area by itself and the CPU was told when a card was in, the beginning of channels
          and direct memory access (chapter 38 has the DMA engine).</p>`,
      },
      challenge: {
        kind: 'reach', goal: 'Read the whole deck, until the reader says empty.',
        check: (st) => st.value('empty') === 1,
        hints: [
          'The reader gives up a card only at a rising edge with next at 1.',
          `After each card it needs ${FEED} more edges to feed the next, and ready is 0 meanwhile: those Pulses take nothing, but they are needed.`,
        ],
        answer: `Hold next at 1 and Pulse: one card is taken at every edge where one is ready, and the reader then needs ${FEED} edges to feed the next. ${SUM_DECK.cards.length} cards take ${SUM_DECK.cards.length + (SUM_DECK.cards.length - 1) * FEED} edges.`,
        solve: (st) => {
          st.setInput('next', 1);
          for (let k = 0; k < SUM_DECK.cards.length * (FEED + 1) && st.value('empty') !== 1; k++) st.pulse();
          st.refresh();
        },
      },
    },
  ],
};
