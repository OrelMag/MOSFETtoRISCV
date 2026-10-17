// Examples ▸ Boot from cards: what the IBM 1401's Load key did, on the sandbox's RV32I core. At power-on the
// core runs a boot ROM that reads the deck in a card reader part, a word a card, into RAM and jumps there. The
// RAM has two ports, one for the data side and one for instruction fetch, so the words the loader stores as data
// come back as instructions. The deck is a program punched a word a card, each card printed with its source line.

import { programCards } from '../cards/program';
import type { Deck } from '../cards/card';
import { assemble } from '../riscv/asm';
import { disasm } from '../riscv/isa';
import { deckRef } from './cardparts';
import type { ChipDoc, PartRef } from './model';
import { Sheet } from './example6502';

/** Where the loader puts the deck and jumps (pc bit 12 picks the RAM for instruction fetch). */
export const CARDS_LOAD_AT = 0x1000;
/** The card reader on the data side: STATUS at +0, DATA at +4. */
export const CARDS_READER_AT = 0xc0000000;
/** Clock edges between taking a card and the next one at the read station. */
export const CARDS_FEED = 4;
/** The RAM: 2^6 words (gates, both ports), at 0x1000 for fetch and anywhere below 0x8000_0000 for data. */
export const CARDS_RAM_K = 6;

const hex = (v: number) => `0x${v.toString(16)}`;

/** The boot ROM: read the deck into RAM until the hopper is empty, then run it (chapter 35's CARD_BOOT_SOURCE on this map). */
export const CARDS_LOADER_SOURCE = `# boot ROM: read the deck word by word into RAM at ${hex(CARDS_LOAD_AT)}, then jump there
boot:   li   s0, ${hex(CARDS_READER_AT)}     # card reader: STATUS +0, DATA +4
        li   s1, ${hex(CARDS_LOAD_AT)}          # RAM address
next:   lw   t0, 0(s0)          # bit 0 card ready, bit 1 hopper empty
        andi t1, t0, 2
        bnez t1, run
        andi t0, t0, 1
        beqz t0, next           # the reader is still feeding
        lw   t0, 4(s0)          # the word; taking it feeds the next card
        sw   t0, 0(s1)
        addi s1, s1, 4
        j    next
run:    li   t0, ${hex(CARDS_LOAD_AT)}
        jr   t0                 # the loaded program`;

/** What the deck's program prints. */
export const CARDS_TEXT = 'CARDS 0123456789\n';

/** The program on the cards: runs from RAM, prints CARDS_TEXT on the console, then stops on `j .`. */
export const CARDS_PAYLOAD_SOURCE = `# punched on cards, a word a card; the boot ROM loads it at ${hex(CARDS_LOAD_AT)}
        li   t0, 0x80000000     # console
        li   t1, 67             # C
        sw   t1, 0(t0)
        li   t1, 65             # A
        sw   t1, 0(t0)
        li   t1, 82             # R
        sw   t1, 0(t0)
        li   t1, 68             # D
        sw   t1, 0(t0)
        li   t1, 83             # S
        sw   t1, 0(t0)
        li   t1, 32             # space
        sw   t1, 0(t0)
        li   a0, 48             # '0'
        li   a1, 58             # past '9'
digit:  sw   a0, 0(t0)
        addi a0, a0, 1
        bne  a0, a1, digit
        li   t1, 10             # new line
        sw   t1, 0(t0)
halt:   j    halt`;

/** A program as a deck of object cards, each printed with its source line (a pseudo-instruction's later words: their disassembly). */
export function asmCards(name: string, src: string, base = 0): Deck {
  const a = assemble(src);
  if (a.errors.length) throw new Error(`${name}: line ${a.errors[0].line}: ${a.errors[0].message}`);
  return programCards(name, src, a.lines.map((l) => ({ word: l.word, srcLine: l.srcLine, dis: disasm(l.word, base + l.addr) })));
}

/** The example's deck. */
export const cardsDeck = (): Deck => asmCards('CARDS', CARDS_PAYLOAD_SOURCE, CARDS_LOAD_AT);

export const NOTES_CARDS = 'Boot from cards, as the IBM 1401\'s Load key did. At power-on the RV32I core runs the boot ROM (the ROM part at the top left), '
  + `which reads the deck in the card reader a word a card into RAM at 0x0000_1000 and jumps there once the hopper is empty. `
  + 'Instruction fetch: pc bit 12 clear, the boot ROM (32 words, repeating); set, the RAM (pc[7:2]). '
  + 'Data: addr[31] = 0 the RAM (64 words, addr[7:2], repeating); 0x8000_0000 the console (a store prints the low byte); '
  + `0xC000_0000 the card reader: STATUS at +0 (bit 0 a card waits at the station, bit 1 the hopper is empty) and DATA at +4 (the word punched in row 9 of the card at the station; a load from it raises take, so the reader takes the card at that clock edge and the next arrives ${CARDS_FEED} edges later). `
  + 'The RAM has two ports: port 0 for the data side\'s loads and stores, port 1 only reads, for instruction fetch, so the words the loader stores come back as instructions. '
  + `The deck is a program that prints ${CARDS_TEXT.trim()}, a word a card, each card printed with its source line and numbered in columns 73–80 (select the reader to see the cards). `
  + 'Try it: Run; the halt part stops it at the program\'s j . Then select the card reader, Drop the deck (shuffled, as a deck dropped on the floor), Reset and Run: the loader loads the words in the wrong order and the jump lands in garbage. Sort puts the cards back by their numbers; Reset and Run again. '
  + 'The CPU drawer shows the registers, but its golden model sits out: it has no card reader, so it cannot follow a program loaded from cards.';

/** The sandbox's Boot from cards: the RV32I core, a boot ROM, a two-port RAM, a card reader holding `deck`, a console. */
export function cardsBootChip(id: string, name: string, deck: Deck = cardsDeck()): ChipDoc {
  const s = new Sheet();
  const ram: PartRef = { ram: { k: CARDS_RAM_K, w: 32, ports: 2 } };
  s.pin('clk', 'in', [2, 2], 1, { kind: 'clock' });
  s.tap('pin:clk', 'clk');

  // the fetch side: the boot ROM below 0x1000, the RAM's read-only port above (pc bit 12 picks)
  s.part('imem', { rom: { k: 5, w: 32, addr: 'rv32', lang: 'asm', src: CARDS_LOADER_SOURCE } }, [6, 5], { label: 'boot ROM' });
  s.part('ifm', { lib: 'mux2x32' }, [24, 5], { label: 'ROM / RAM' });
  s.tap('imem.addr', 'pc');
  s.wire('imem.data', 'ifm.a');
  s.tap('ifm.b', 'fetch'); s.tap('ifm.s', 'p12'); s.tap('ifm.y', 'instr');
  s.part('ps', { split: [2, 6, 4, 1, 19] }, [8, 14]);
  s.tap('ps.in', 'pc'); s.tap('ps.o1', 'pcw'); s.tap('ps.o3', 'p12');
  // the halt detector: `j .` (jal x0, 0) fetched
  s.part('hj', { const: { width: 32, value: 0x6f } }, [2, 28], { label: 'j .' });
  s.part('eq', { lib: 'eq32' }, [10, 25]);
  s.part('halt', { display: 'halt', width: 1 }, [16, 27]);
  s.tap('eq.a', 'instr'); s.wire('hj.y', 'eq.b'); s.wire('eq.eq', 'halt.a');

  // the core (hart 0, the memory port always granted)
  s.part('cpu', { lib: 'rv32i_core' }, [36, 6], { label: 'RV32I core' });
  s.part('hart', { const: { width: 32, value: 0 } }, [30, 14]);
  s.part('grant', { const: { width: 1, value: 1 } }, [34, 18]);
  s.tap('cpu.clk', 'clk'); s.tap('cpu.instr', 'instr'); s.tap('cpu.memRData', 'rdata');
  s.wire('hart.y', 'cpu.hartid'); s.wire('grant.y', 'cpu.grant');
  s.tap('cpu.pcOut', 'pc'); s.tap('cpu.memAddr', 'addr'); s.tap('cpu.memWData', 'wdata'); s.tap('cpu.memWE', 'we'); s.tap('cpu.memReq', 'req');

  // the address decoder: a31 the devices (a30: the reader, else the console), a2 the reader's register
  s.part('as', { split: [2, 1, 27, 1, 1] }, [66, 4]);
  s.tap('as.in', 'addr'); s.tap('as.o1', 'a2'); s.tap('as.o3', 'a30'); s.tap('as.o4', 'a31');
  s.part('ra', { split: [2, 6, 24] }, [66, 16]);
  s.tap('ra.in', 'addr'); s.tap('ra.o1', 'aw');
  s.part('bs', { split: [8, 24] }, [66, 23]);
  s.tap('bs.in', 'wdata'); s.tap('bs.o0', 'byte');
  s.part('n31', { lib: 'not' }, [79, 4]);
  s.part('ramst', { lib: 'and' }, [82, 4], { label: 'RAM store' });
  s.tap('n31.a', 'a31'); s.wire('n31.y', 'ramst.a'); s.tap('ramst.b', 'we'); s.tap('ramst.y', 'ramWe');
  s.part('n30', { lib: 'not' }, [79, 10]);
  s.part('cwe', { lib: 'and3' }, [82, 10], { label: 'console store' });
  s.tap('n30.a', 'a30'); s.wire('n30.y', 'cwe.i0'); s.tap('cwe.i1', 'a31'); s.tap('cwe.i2', 'we'); s.tap('cwe.y', 'conWe');
  s.part('nwe', { lib: 'not' }, [79, 18]);
  s.part('take', { lib: 'and5' }, [82, 18], { label: 'DATA load' });
  s.tap('nwe.a', 'we'); s.wire('nwe.y', 'take.i0');
  s.tap('take.i1', 'req'); s.tap('take.i2', 'a31'); s.tap('take.i3', 'a30'); s.tap('take.i4', 'a2'); s.tap('take.y', 'take');

  // what a load reads: the RAM, or the reader's STATUS (a2 = 0) / DATA (a2 = 1)
  s.part('z30', { const: { width: 30, value: 0 } }, [66, 35]);
  s.part('st', { merge: [1, 1, 30] }, [72, 31], { label: 'STATUS' });
  s.tap('st.i0', 'ready'); s.tap('st.i1', 'empty'); s.wire('z30.y', 'st.i2');
  s.part('rsel', { lib: 'mux2x32' }, [80, 32], { label: 'STATUS / DATA' });
  s.wire('st.out', 'rsel.a'); s.tap('rsel.b', 'card'); s.tap('rsel.s', 'a2');
  s.part('rm', { lib: 'mux2x32' }, [92, 31], { label: 'RAM / I/O' });
  s.tap('rm.a', 'rd0'); s.wire('rsel.y', 'rm.b'); s.tap('rm.s', 'a31'); s.tap('rm.y', 'rdata');

  // the RAM: port 0 the data side, port 1 instruction fetch (it never writes)
  s.part('ram', ram, [106, 2], { label: `RAM ${2 ** CARDS_RAM_K} × 32, 2 ports` });
  s.part('wem', { merge: [1, 1] }, [96, 10]);
  s.part('ro', { const: { width: 1, value: 0 } }, [94, 12]);
  s.tap('ram.addr0', 'aw'); s.tap('ram.addr1', 'pcw'); s.tap('ram.wd0', 'wdata'); s.tap('ram.wd1', 'wdata');
  s.tap('wem.i0', 'ramWe'); s.wire('ro.y', 'wem.i1'); s.wire('wem.out', 'ram.we');
  s.tap('ram.rd0', 'rd0'); s.tap('ram.rd1', 'fetch'); s.tap('ram.clk', 'clk');
  // the card reader and the console
  s.part('rdr', { reader: deckRef(deck, { feed: CARDS_FEED }) }, [106, 20], { label: 'card reader' });
  s.tap('rdr.next', 'take'); s.tap('rdr.data', 'card'); s.tap('rdr.ready', 'ready'); s.tap('rdr.empty', 'empty'); s.tap('rdr.clk', 'clk');
  s.part('con', { console: { cols: 32, rows: 8 } }, [106, 34], { label: 'console' });
  s.tap('con.data', 'byte'); s.tap('con.we', 'conWe'); s.tap('con.clk', 'clk');
  return s.doc(id, name, { notes: NOTES_CARDS });
}
