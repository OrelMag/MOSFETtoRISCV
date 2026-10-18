import { COLUMNS, programDeck } from '../cards/card';
import { CHARSET } from '../cards/hollerith';
import { deckReader } from '../cards/reader';
import { assemble } from '../riscv/asm';
import { PROGRAMS } from '../riscv/programs';
import { cardEditorWidget, censusWidget, deckWidget, loomWidget, readerPanel, sampleDeck } from '../widgets/cards';
import { bench, type Chapter } from './types';

const SUM = assemble(PROGRAMS.find((p) => p.id === 'sum')!.source);
const SUM_DECK = programDeck('sum.s', SUM.lines.map((l) => ({ word: l.word, source: l.text })));
/** Clock edges between taking a card and the next one at the station (a real reader: 75 ms a card). */
const FEED = 2;
const READER = bench(deckReader(SUM_DECK, 'word', { feed: FEED }));
const SORT_CARDS = sampleDeck().cards.length;

export const chCards: Chapter = {
  id: 'cards', num: 0, prologue: 'P3', title: 'Punch cards', level: 'Input',
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
      `IBM's card: ${COLUMNS} columns of 12 rows. A digit is one hole, a letter a zone (12, 11 or 0) and a digit, most signs add an 8; only ${CHARSET.length} of a column's 4 096 patterns are characters.`,
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
        some 24 000 cards. Babbage meant his Analytical Engine to take its program the same way; Ada Lovelace wrote that it
        "weaves algebraical patterns just as the Jacquard loom weaves flowers and leaves".</p>
        <div class="try">Weave the diamond, then punch or clear a hole in one card and weave again: the change repeats
        everywhere that card and that hook meet.</div>`,
      widget: () => loomWidget(),
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
        <div class="try">Press a few cards one by one and watch which dials move, then run the stack.</div>`,
      widget: () => censusWidget(),
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
        of its 4 096 patterns are characters (the blank included): at most three holes, so the card stays stiff enough to feed.</p>
        <p>There is no lower case and no curly brace. The keypunch printed each character along the top edge so that
        people could read the card; machines read the holes. Readers took cards face down, the 9 edge first.</p>
        <div class="try">Type a line and watch it punch. Then click positions on the card: a pattern that is not in the
        code reads as no character at all.</div>`,
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
        <p>A program was punched one statement a card (a <em>source deck</em>), and an assembler or compiler punched out the
        result as an <strong>object deck</strong> of machine words in binary. Here each object card holds one RISC-V
        instruction: the 32-bit word along row 9 from column 1, most significant bit first, its source line and the word in
        hex printed along the top. Real machines packed more: the IBM 704 read each of a card's 12 rows as two 36-bit words.
        One word a card wastes 928 of 960 positions, and is readable at a glance.</p>
        <p>Columns 73–80 hold a <strong>sequence number</strong>, counted in tens so a card can be slipped in later (FORTRAN
        ignored those columns for this reason). A dropped deck goes back on a <strong>card sorter</strong>: an IBM 082 drops
        each card into the pocket of the digit in one column, 650 cards a minute. Stack the pockets 0 to 9 and sort on the
        next column to the left: after the last pass the deck is in order. That is the radix sort, least significant digit
        first, a pass per digit, each pass stable.</p>
        <div class="try">The deck is the bubble-sort sample, ${SORT_CARDS} cards. Drop it, then sort it on the sorter and count the passes.</div>`,
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
        rest. <a href="#/c/bus/5">Chapter 35</a> builds that boot loader on a bus computer, and the sandbox has the card reader as a part, with
        decks made from any ROM program.</p>
        <div class="try">Set <code>next</code> to 1 and Pulse: each card's word appears on <code>data</code>, with ${FEED} empty
        cycles between cards while the reader feeds.</div>`,
      scene: () => ({ root: READER, inputs: { next: 0 }, clock: 'clk', autoClock: false, panels: [readerPanel] }),
      tries: [(st) => st.getInput('next') === 1 && st.cycles > 0],
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
