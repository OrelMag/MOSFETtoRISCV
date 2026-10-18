// Authored walkthroughs, group 7: act 10, memory in depth (references: lib/rv16/mem16.ts through buildm.ts). See
// walks.ts for the conventions. No DOM.

import type { WalkScript } from './walk';

export const WALKS7: Record<string, WalkScript> = {
  m_sense: [
    {
      title: 'Precharge to the middle',
      text: 'pa connects the bit line to VDD/2 while pre = 1. From the middle, a stored 1 moves the line up and a stored 0 moves it down by the same amount, so the amplifier only has to tell which way. One NMOS is enough: VDD/2 is well below what its gate at VDD lets through.',
      parts: ['vh', 'pa'], codex: ['mosfet'],
    },
    {
      title: 'The bit line',
      text: 'cb is the line\'s 100 fF, four cells\' worth here (hundreds hang on a real line). It keeps the precharged level once pre falls and nothing drives the line.',
      parts: ['cb'],
    },
    {
      title: 'Two cells',
      text: 'Each cell is one access transistor and 25 fF. Its word line up, the cell shares its charge with the line: (25 · VDD + 100 · VDD/2) / 125 = 0.6 VDD for a stored 1, 0.4 VDD for a 0. The line moves by a tenth of the supply, and the cell is left at that same weak level: the read has destroyed it.',
      parts: ['c0', 'c1'], codex: ['ram'],
    },
    {
      title: 'The reference line',
      text: 'cr gives the second line the same 100 fF and no cells. eq joins the two lines while pre = 1, so the reference reaches VDD/2 through the bit line\'s precharge, without a second transistor to the rail. After pre falls it holds VDD/2: the level a read is compared against.',
      parts: ['eq', 'cr'], codex: ['senseamp'],
      ask: {
        question: 'A cell holding 1 has just moved the bit line to 0.6 VDD. What must the amplifier\'s other input be?',
        options: [
          'A second line of the same capacitance, precharged with the bit line and then left floating',
          'GND, the lowest level',
          'The VDD/2 rail itself',
          'Nothing: the amplifier compares the bit line with its own switching threshold',
        ],
        answer: 0,
        explain: 'The amplifier drives the higher of its two lines to VDD and the other to GND, so the other line must start exactly at VDD/2 and be free to move. The same capacitance and the same precharge give both.',
        why: [
          '',
          'The bit line would always be the higher one: every read would come out 1.',
          'The amplifier must pull its other line to the opposite rail; a line tied to a supply cannot move, so the latch never settles and the cell is not restored.',
          'It is two cross-coupled inverters: it decides only on the difference between its two lines, which is why it can sense a tenth of the supply.',
        ],
      },
    },
    {
      title: 'The sense amplifier',
      text: 'sa is two cross-coupled inverters powered through a head and a foot transistor when sae rises: 8 transistors. Positive feedback drives the higher line to VDD and the other to GND. The word line is still up, so the open cell is recharged to a full level: every DRAM read is a read and a rewrite.',
      parts: ['sa'], codex: ['senseamp', 'feedback'],
    },
    {
      title: 'The write driver',
      text: 'wd is two strong pull-downs, one per line, chosen by d while we = 1 (5 NANDs decide which): 22 transistors. It overpowers the amplifier and flips both lines, and the open cell follows. q is the bit line itself, valid once the amplifier has fired. 34 transistors in all.',
      parts: ['wd'],
    },
  ],

  m_bank: [
    {
      title: 'The row buffer\'s state',
      text: 'open says whether a row sits in the sense amplifiers, orow which one. A 9-NAND flip-flop and a 52-NAND 4-bit register.',
      parts: ['open', 'orow'], codex: ['rowbuffer', 'register'],
    },
    {
      title: 'Hit or miss',
      text: 'request = re + we. hit = open · (orow = row): the address\'s top four bits against the open row, a 26-NAND comparator. A hit is served this cycle; a miss costs a close, an open, then the access.',
      parts: ['u1', 'u5', 'u6', 'u7'], codex: ['comparator'],
    },
    {
      title: 'The refresh state',
      text: 'rcnt is the next row to refresh, timer the cycles since the last refresh, held at 15. due = all four timer bits. Two more 52-NAND registers: the four registers are 165 of the bank\'s 319 NANDs.',
      parts: ['rcnt', 'timer', 'u4'], codex: ['refresh', 'counter'],
    },
    {
      title: 'When to refresh',
      text: 'refresh = due + (timer ≥ 8) · no request; bit 3 of the timer is the ≥ 8 test. An idle cycle past 8 refreshes early, so most refreshes cost the requests nothing; at 15 one goes ahead of any request.',
      parts: ['u8', 'u9', 'u10', 'u11'],
    },
    {
      title: 'ACT and PRE',
      text: 'ACT = closed · (refresh + request), its row the refresh row or the request\'s (a 4-bit mux on refresh). PRE = open · (refresh + request · miss). A refresh is only an ACT of the refresh row, left open: the next request may want it, and the PRE is paid when another row is needed.',
      parts: ['u12', 'u13', 'u14', 'u15', 'u16', 'u17', 'u21', 'u22'], codex: ['rowbuffer'],
      ask: {
        question: 'The array knows only ACT, RW and PRE. How does the bank refresh a row?',
        options: [
          'ACT the refresh row (after a PRE if another row is open) and leave it open',
          'Send a dedicated refresh command',
          'RW every word of the row in turn',
          'ACT the refresh row and PRE it in the next cycle',
        ],
        answer: 0,
        explain: 'Opening a row puts every cell of it through the sense amplifiers, which rewrite it at full level. Leaving it open costs nothing: a request for that row then hits.',
        why: [
          '',
          'This array has none: opening a row is what restores it (a real chip\'s REF opens and closes rows for you).',
          'The ACT has already restored the whole row; 16 RWs would only waste 16 cycles.',
          'Legal, but the PRE can wait until a request needs another row: a request for this one would hit.',
        ],
      },
    },
    {
      title: 'RW, busy and the command',
      text: 'RW = request · hit · ¬refresh. busy = request · ¬(hit · ¬refresh): a request waits through a miss and through a refresh. cmd is two bits (ACT 1, PRE 2, RW 3), so bit 0 = ACT + RW and bit 1 = PRE + RW.',
      parts: ['u18', 'u19', 'u20', 'u23', 'u24'],
    },
    {
      title: 'Next state of the row',
      text: 'open ← ¬rst · (ACT + open · ¬PRE); orow loads the chosen row at an ACT. A refresh ACT steps rcnt through the 16 rows with a 20-NAND incrementer.',
      parts: ['u2', 'u27', 'u28', 'u29', 'u30', 'u31'], codex: ['incrementer'],
    },
    {
      title: 'The refresh timer',
      text: 'The timer restarts on reset and on a refresh ACT, counts otherwise, and stops at 15 (enable = restart + ¬due). Refresh ACTs are then at most 17 cycles apart (16 of counting, plus a PRE if a row is open), inside the 288 / 16 = 18 that the cells allow.',
      parts: ['u26', 'u32', 'u33', 'u34', 'u35', 'u36', 'u37'], codex: ['refresh'],
    },
  ],

  m_ctrl: [
    {
      title: 'Two row buffers',
      text: 'Per bank, an open flag and the 6-bit open row (a 4-bit register and two enable flip-flops). With a row buffer per bank, a stream in each bank keeps both rows open. 174 NANDs of state.',
      parts: ['open0', 'open1', 'u3', 'u4', 'u5', 'u7', 'u8', 'u9'], codex: ['rowbuffer', 'register'],
    },
    {
      title: 'Hit',
      text: 'The request\'s bank bit picks its flag and its row; a 40-NAND comparator checks the row. hit = bank open · same row. anyOpen = either bank open, for refresh.',
      parts: ['u22', 'u23', 'u24', 'u25', 'u26'], codex: ['comparator'],
    },
    {
      title: 'Timing rules as bit tests',
      text: 'Two counters hold the cycles since the last ACT and since the last PRE or REF, stopping at 15, one pair for both banks (enough with one request in flight). Each rule is then a few gates: ≥ 4 is bit 2 + bit 3 (tRCD, tRP), ≥ 9 is bit 3 · (any of bits 0–2) (tRAS), ≥ 12 is bit 2 · bit 3. lastref says the last close was a REF, which turns tRP into tRFC = 12.',
      parts: ['u11', 'u12', 'u16', 'u17', 'u18', 'u19', 'u20', 'u21', 'lastref'], codex: ['dramtiming', 'counter'],
    },
    {
      title: 'A read in flight',
      text: 'tCAS = 4: a 4-stage shift register carries "RD issued" to the cycle its word is on dq. While any stage is 1 the controller issues nothing, so a refresh cannot close a row under a pending read.',
      parts: ['rd0', 'rd1', 'rd2', 'rd3', 'u27', 'u28'], codex: ['dramtiming'],
    },
    {
      title: 'Refresh first',
      text: 'An 8-bit count of the cycles since the last REF, in two 4-bit halves; its bit 7 makes a refresh pending at 128, half of tREFI = 256, leaving room for a read and tRAS. Pending, it goes ahead of any request; otherwise a request may go.',
      parts: ['reflo', 'refhi', 'u29', 'u30', 'u31'], codex: ['refresh'],
    },
    {
      title: 'The commands',
      text: 'Each command is an AND of its condition and its rule: RD / WR = request · hit · tRCD; PRE = request · open · miss · tRAS; ACT = request · closed · tRP; PREA = refresh · anyOpen · tRAS; REF = refresh · none open · tRP. A miss is a PRE now and an ACT once tRP has passed.',
      parts: ['u32', 'u33', 'u34', 'u35', 'u36', 'u37', 'u38', 'u39', 'u40', 'u41', 'u42'], codex: ['pagepolicy'],
      ask: {
        question: 'Bank 1 has row 5 open; a request wants row 9 of bank 1. tRAS and tRP have both passed and nothing is in flight. What does the controller send?',
        options: ['PRE for bank 1', 'ACT row 9 of bank 1', 'PREA', 'RD of row 9'],
        answer: 0,
        explain: 'ACT needs the bank closed, so a row conflict costs a PRE now, an ACT once tRP has passed and the access once tRCD has. Bank 0 keeps its open row.',
        why: [
          '',
          'ACT needs the bank closed: row 5 must be precharged first.',
          'That also closes bank 0, throwing away its open row for nothing. PREA is for a refresh, which needs both banks closed.',
          'RD reads the open row, row 5: the wrong word.',
        ],
      },
    },
    {
      title: 'Encoding and ready',
      text: 'cmd is 3 bits (ACT 1, RD 2, WR 3, PRE 4, PREA 5, REF 6): bit 0 = ACT + WR + PREA, bit 1 = RD + WR + REF, bit 2 = PRE + PREA + REF. ready = a WR now, or the shift register\'s last stage: the word is on dq.',
      parts: ['u43', 'u44', 'u45', 'u47'],
    },
    {
      title: 'Opening and closing',
      text: 'An ACT loads its bank\'s row register and sets its flag; a PRE clears its bank\'s flag, PREA both. Each flag: ¬rst · (ACT here + open · ¬close here).',
      parts: ['u1', 'u2', 'u48', 'u49', 'u52', 'u76', 'u77', 'u78', 'u79', 'u80', 'u81', 'u82', 'u83', 'u84', 'u85', 'u86', 'u87'],
    },
    {
      title: 'Counting',
      text: 'Each since counter: +1 (20 NANDs), forced to 0 by its clear (ACT; PRE, PREA or REF; reset), held at 15 by its own incrementer\'s carry. The refresh count\'s low half always counts; the high half counts on the low half\'s carry. REF clears both halves.',
      parts: ['u53', 'u54', 'u55', 'u56', 'u57', 'u58', 'u59', 'u60', 'u61', 'u62', 'u63', 'u64', 'u65', 'u66', 'u67', 'u68', 'u69', 'u70', 'u71', 'u72', 'u73', 'u74', 'u75'], codex: ['incrementer'],
    },
    {
      title: 'After REF, and the read pipe',
      text: 'lastref is set by REF and kept until the next PRE or PREA. The shift register loads RD at its first stage and moves one stage a cycle. 777 NANDs; the six 4-bit registers are 312 of them.',
      parts: ['u88', 'u89', 'u90', 'u91', 'u92', 'u93', 'u94', 'u95'],
    },
  ],

  m_bus: [
    {
      title: 'Three bits of state',
      text: 'last: who was served last. lock: a transfer has started and is waiting. own: whose it is. Three flip-flops, 27 of the bus\'s 282 NANDs.',
      parts: ['last', 'lock', 'own'], codex: ['arbitration', 'dff'],
    },
    {
      title: 'The grant',
      text: 'Round robin: with both masters asking, the one not served last; otherwise master 1 if it asks, else master 0. While a transfer waits, lock overrides it all with own, so a slave never sees its request change mid-transfer.',
      parts: ['u0', 'u1', 'u2', 'u3'], codex: ['arbitration'],
      ask: {
        question: 'Master 1 is waiting on slave 1, which has not raised ready yet. Master 0, served last, raises its valid. Who is granted next cycle?',
        options: ['Master 1, until its slave is ready', 'Master 0: it asks, and a new request deserves a turn', 'Master 0: it has priority after reset', 'Each in turn, one cycle each'],
        answer: 0,
        explain: 'Round robin decides between transfers, never inside one. The lock flip-flop holds the grant on its owner until the slave raises ready.',
        why: [
          '',
          'Switching mid-transfer would change sa under a slave that is still working on master 1\'s request; and master 0, served last, would lose a tie anyway.',
          'Reset only decides who wins the first tie; a transfer in progress keeps its master.',
          'There is one set of wires: alternating would hand each slave a request that changes every cycle.',
        ],
      },
    },
    {
      title: 'One set of wires',
      text: 'The grant steers the granted master\'s valid, address, data and write onto the bus: two 49-NAND 16-bit muxes and two 1-bit ones.',
      parts: ['u4', 'u5', 'u6', 'u7'], codex: ['mux', 'bus'],
    },
    {
      title: 'Decode the slave',
      text: 'a15 a14: 0x selects slave 0, 10 slave 1, 11 slave 2. Only the chosen slave sees valid, each through an AND of valid and the address bits.',
      parts: ['u9', 'u10', 'u11', 'u12', 'u13'], codex: ['decoder'],
    },
    {
      title: 'The answer comes back',
      text: 'The same two bits pick the chosen slave\'s ready and its word: two levels of mux, one more pair of 16-bit muxes. mq goes to both masters; only the granted one will see ready.',
      parts: ['u14', 'u15', 'u16', 'u17'], codex: ['handshake'],
    },
    {
      title: 'Done, and the next cycle',
      text: 'done = valid · ready: mr goes to the granted master only. last ← the grant when done (1 on reset, so master 0 wins the first tie); lock ← valid · ¬done; own ← the grant. The four 16-bit muxes are 196 of the 282 NANDs: moving words is the cost.',
      parts: ['u18', 'u19', 'u20', 'u21', 'u22', 'u23', 'u24', 'u25', 'u26'], codex: ['handshake'],
    },
  ],

  m_dma: [
    {
      title: 'Configuration writes',
      text: 'The processor writes the engine\'s registers like a device: a 2→4 decoder on ca, each output ANDed with cw, gives four strobes: src, dst, len (which starts the copy), clear irq.',
      parts: ['u0', 'u1', 'u2', 'u3', 'u4'], codex: ['decoder', 'mmio'],
    },
    {
      title: 'The registers',
      text: 'src and dst, the count, and the word in flight between its read and its write: four 16-bit registers, 832 of the engine\'s 1366 NANDs.',
      parts: ['src', 'dst', 'cnt', 'data'], codex: ['register', 'dma'],
    },
    {
      title: 'Counting to the end',
      text: 'The count is loaded with NOT len (16 inverters) and incremented after each word. After k words it holds NOT len + k, all ones exactly when k = len, and that is when the 76-NAND incrementer\'s carry out is 1.',
      parts: ['u6', 'u7', 'u8', 'u9', 'u10', 'u11', 'u12', 'u13', 'u14', 'u15', 'u16', 'u17', 'u18', 'u19', 'u20', 'u21', 'u24'], codex: ['incrementer'],
      ask: {
        question: 'The count starts at NOT len and goes up by one per word copied. What says the copy is over?',
        options: [
          'The incrementer\'s carry out: the count is all ones',
          'The count reaching 0',
          'A comparator between the count and len',
          'Nothing this cheap: load len instead, count down and test for 0',
        ],
        answer: 0,
        explain: 'NOT len + len = all ones, so the carry out of the incrementer that is already there is the end test. It costs nothing, and len = 0 starts at all ones: nothing to copy.',
        why: [
          '',
          'From NOT len it reaches 0 one word after all ones: len + 1 words.',
          'It works, but needs len kept in a register and a 16-bit comparator; the carry is free.',
          'It works, but needs a decrementer and a 16-input zero test; counting up from NOT len gets the zero test for free.',
        ],
      },
    },
    {
      title: 'The request',
      text: 'mv = running · ¬carry. The address is src in the read phase, dst in the write phase; md is the latched word, mw the phase. Every request comes straight from registers that change only when mr = 1, so it holds until ready by construction. step = mv · mr ends a read or a write.',
      parts: ['run', 'phase', 'u25', 'u26', 'u27', 'u28', 'u29', 'u30', 'u31', 'u32'], codex: ['handshake'],
    },
    {
      title: 'Stepping the pointers',
      text: 'A finished read latches mq into the word register. A finished write steps src, dst and the count, each +1 on its own 76-NAND incrementer; a configuration write loads src or dst from cd instead, and start loads NOT len.',
      parts: ['u33', 'u34', 'u35', 'u36', 'u37', 'u38', 'u39', 'u40'], codex: ['incrementer'],
    },
    {
      title: 'Running and phase',
      text: 'run ← ¬rst · (start + run · ¬done). phase ← ¬rst · ¬start · (phase ⊕ step): it flips at every finished transfer, and a start resets it to reading.',
      parts: ['u23', 'u41', 'u42', 'u43', 'u44', 'u45', 'u46', 'u47'],
    },
    {
      title: 'The interrupt',
      text: 'irq ← ¬rst · ¬start · ¬clear · (irq + done): set by the last write, held until the processor clears it. With len = 0 the count is all ones in the cycle after the start: no request goes out, and irq rises at the next edge.',
      parts: ['irqff', 'u48', 'u49', 'u50'], codex: ['interrupts'],
    },
  ],

  m_flash: [
    {
      title: 'The mapping table',
      text: 'Eight 4-bit registers: for each logical page, the flash page (block · page) that holds its current copy. 416 of the store\'s 1049 NANDs.',
      parts: ['l2p0', 'l2p1', 'l2p2', 'l2p3', 'l2p4', 'l2p5', 'l2p6', 'l2p7'], codex: ['ftl', 'register'],
    },
    {
      title: 'The head',
      text: 'The next erased page, where every program goes: a 4-bit register, +1 at each program, 0 on reset. Writes go round the 16 pages as a log, so every block is erased as often as the others.',
      parts: ['hp', 'u57', 'u59', 'u60', 'u61'], codex: ['wearlevel', 'counter'],
    },
    {
      title: 'The states',
      text: 'One flip-flop per state: waiting on a read, waiting on a program, and five for the collector (issue its read, wait for it, wait for a copy, issue the erase, wait for it). None set is idle.',
      parts: ['s_rw', 's_pw', 's_gr', 's_grw', 's_gpw', 's_ge', 's_gew', 'u3', 'u4', 'u5', 'u6'], codex: ['fsm'],
    },
    {
      title: 'Where a page lives',
      text: 'whose page: the request\'s lpage, or, while the collector checks a page, the tag it read from the spare area. A 112-NAND 8:1 mux of 4-bit entries looks it up in the table.',
      parts: ['u7', 'u8'], codex: ['mux'],
    },
    {
      title: 'Who goes next',
      text: 'When idle, a pending collection goes first; otherwise a read, then a write. collect next is set when the head enters a new block.',
      parts: ['gcp', 'u14', 'u15', 'u16', 'u17', 'u18', 'u19'],
    },
    {
      title: 'Is this page still wanted?',
      text: 'The collector walks the victim block page by page (a 2-bit page counter and the block). A page it reads is live when it is programmed (spare bit 3 is 0) and the table still points at it; live pages are copied to the head, the others skipped. After the fourth page comes the erase.',
      parts: ['gi0', 'gi1', 'vb0', 'vb1', 'u1', 'u11', 'u12', 'u13', 'u20', 'u21', 'u24', 'u25', 'u26', 'u27', 'u28'], codex: ['ftl'],
      ask: {
        question: 'The collector has read page p of the victim block, and its spare area says it was written for logical page 5. When must it be copied?',
        options: [
          'When entry 5 of the table still points at p',
          'Whenever p is not erased',
          'When it is the most recently programmed page of the block',
          'Never: the block is about to be erased, so its data is old',
        ],
        answer: 0,
        explain: 'A rewrite leaves the old copy behind, still programmed. Only the table knows which copy is current, and the tag says which entry to ask.',
        why: [
          '',
          'A rewritten page leaves a stale copy behind; copying it would also repoint entry 5 at old data.',
          'The current copy of a logical page can sit in any block; the newest page here may be another page\'s stale copy.',
          'The head goes round every block: a page written once and never again lives here, and erasing it would lose it.',
        ],
      },
    },
    {
      title: 'Commands to the chip',
      text: 'PROG = a write or a copy, READ = a request read or the collector\'s read; fcmd bit 0 = READ + ERASE, bit 1 = PROG + ERASE. The page is the head for a program, the table\'s entry for a read, otherwise the victim page. fd is wd, or fq for a copy; ft is whose page. ready = a read or program waiting · chip free.',
      parts: ['u22', 'u23', 'u29', 'u30', 'u32', 'u33', 'u34', 'u35', 'u36'],
    },
    {
      title: 'Updating the table at issue',
      text: 'A 3→8 decoder enabled by PROG writes the head into the entry of whose page in the cycle the program is issued. Waiting for the program to finish would be too late: fq shows the tag only until the next command.',
      parts: ['u75'], codex: ['decoder'],
    },
    {
      title: 'Holding while busy',
      text: 'Each waiting state is entered by its command and held while fbusy = 1: ¬rst · (enter + state · fbusy). The collector\'s read follows the start or a page done, the erase the last page.',
      parts: ['u0', 'u37', 'u38', 'u39', 'u40', 'u41', 'u42', 'u43', 'u44', 'u45', 'u46', 'u47', 'u48', 'u49', 'u50', 'u51', 'u52', 'u53', 'u54', 'u55', 'u56'],
    },
    {
      title: 'Choosing the victim',
      text: 'A program into the last page of a block (both head page bits 1) moves the head into the next block and sets collect next. The victim is the block after the head\'s (+1 on two bits), so one block is always erased ahead of the head; its page counter starts at 0 and steps after each page.',
      parts: ['u62', 'u63', 'u64', 'u65', 'u66', 'u67', 'u68', 'u69', 'u70', 'u71', 'u73', 'u74'], codex: ['wearlevel'],
    },
  ],
};
