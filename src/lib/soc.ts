// Chapter 36's computer: the RV32I system CPU on a bus (systemCpu({ bus })) with a DMA engine as a second
// master, and as slaves a RAM from address 0, a flash at 0x1000_0000 and the DMA's registers at
// 0x4000_0000 (bus/model.ts is the golden model's view of the same map). The DMA's irq is the CPU's
// external interrupt. Console, LEDs, switches and the timer stay inside the CPU at 0x8000_0000. Options add a
// DRAM, a screen, a keyboard and a card reader (cardComputer: the boot ROM reads its program from a deck).

import { MAP } from '../bus/model';
import { BOOT_SOURCE, bootSource, CARD_BOOT_SOURCE, CARD_FEED, CARD_PAYLOAD_SOURCE, PAYLOAD_SOURCE, SYSTEM_SOURCE, SYSTEM_WORDS } from '../bus/programs';
import { type Deck, deckWords, programDeck } from '../cards/card';
import { deckReader } from '../cards/reader';
import { assemble } from '../riscv/asm';
import type { ComponentDef, PortDef } from '../sim/types';
import { AXI_CARDS, AXI_DEFAULT, AXI_KEYS, AXI_IO_PORT, AXI_PIXEL, axiBus, axiDram, axiFlash, axiFlashWindow, axiRam, axiScreen, BUS_DRAM, bundled, DMA_ENGINE, KEY_QUEUE, M_IN, M_OUT } from './axi';
import { symbolGeom } from '../sim/geometry';
import { Builder } from './builder';
import { define } from './define';
import { systemCpu } from './system';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });

export interface SocOptions {
  /** Boot ROM of 2^imemK words (default 7: 512 bytes). */
  imemK?: number;
  /** RAM of 2^ramK words (default 12: 16 KB). */
  ramK?: number;
  /** Wait states of the RAM (default 0). */
  ramWait?: number;
  /** A DRAM at 0x2000_0000 (BUS_DRAM: chapter 34's controller, 16 KB). */
  dram?: boolean;
  /** A 64 × 64 screen at 0x5000_0000. */
  screen?: boolean;
  /** A keyboard at 0x6000_0000 (its queue inside the computer: KEY_QUEUE, instance 'kbd'). */
  keys?: boolean;
  /** A card reader at 0x7000_0000 (AXI_CARDS, instance 'cardport') holding this deck (cards/reader.ts, instance 'cards'). */
  cards?: Deck;
  /** Clock edges between taking a card and the next one at the station (default CARD_FEED). */
  cardFeed?: number;
}

/** The screen's side in pixels. */
export const SOC_SCREEN = 64;

/** The golden model's devices for a computer built with these options (bus/model.ts BusModel). */
export const socDevices = (o: SocOptions) => ({
  dramK: o.dram ? BUS_DRAM.k : undefined, screen: o.screen ? SOC_SCREEN : undefined, keys: !!o.keys,
  cards: o.cards ? { items: deckWords(o.cards), feed: o.cardFeed ?? CARD_FEED } : undefined,
});

const cache = new Map<string, ComponentDef>();

export function busComputer(program: number[], flashImage: ArrayLike<number> = [], o: SocOptions = {}): ComponentDef {
  const imemK = o.imemK ?? 7, ramK = o.ramK ?? 12, wait = o.ramWait ?? 0;
  const CPU = systemCpu(program, { imemK, bus: true }), FL = axiFlash(flashImage);
  const RD = o.cards ? deckReader(o.cards, 'word', { feed: o.cardFeed ?? CARD_FEED }) : null;
  const id = `soc_${CPU.id}_${FL.id}_${ramK}_${wait}${o.dram ? '_dram' : ''}${o.screen ? '_scr' : ''}${o.keys ? '_kbd' : ''}${RD ? `_${RD.id}` : ''}`;
  let d = cache.get(id);
  if (d) return d;
  const b = new Builder(10, 24);
  b.pins('clk', 'switches');
  const cpu = b.op(CPU, [], 'CPU', 'cpu');
  const dma = b.op(DMA_ENGINE, [], 'DMA', 'dma');
  b.next();
  // the slaves in address order, the default slave last
  const map: [number, () => string][] = [
    [MAP.ram, () => b.op(axiRam(ramK, wait), [], 'RAM', 'ram')],
    [MAP.flash, () => b.op(FL, [], 'flash', 'flash')],
    ...(o.dram ? [[MAP.dram, () => b.op(axiDram(), [], 'DRAM', 'dram')] as [number, () => string]] : []),
    [MAP.dma, () => dma],
    ...(o.screen ? [[MAP.screen, () => b.op(axiScreen(SOC_SCREEN), [], 'screen', 'screen')] as [number, () => string]] : []),
    ...(o.keys ? [[MAP.keys, () => b.op(AXI_KEYS, [], 'keyboard port', 'keys')] as [number, () => string]] : []),
    ...(RD ? [[MAP.cards, () => b.op(AXI_CARDS, [], 'card reader port', 'cardport')] as [number, () => string]] : []),
    [0xf, () => b.op(AXI_DEFAULT, [], 'default', 'def')],
  ];
  const bx = b.op(axiBus(2, map.map(([c]) => c)), [], 'interconnect', 'bus');
  b.next();
  const slaves = map.map(([, make]) => make());
  for (const s of M_OUT) { b.wire(`${cpu}.${s}`, `${bx}.m0_${s}`); b.wire(`${dma}.m_${s}`, `${bx}.m1_${s}`); }
  for (const s of M_IN) { b.wire(`${bx}.m0_${s}`, `${cpu}.${s}`); b.wire(`${bx}.m1_${s}`, `${dma}.m_${s}`); }
  slaves.forEach((sl, i) => {
    for (const s of M_OUT) b.wire(`${bx}.s${i}_${s}`, `${sl}.${s}`);
    for (const s of M_IN) b.wire(`${sl}.${s}`, `${bx}.s${i}_${s}`);
  });
  for (const x of [cpu, bx, ...slaves]) b.wire('clk', `${x}.clk`);
  if (o.keys) {
    b.next();
    const kbd = b.op(KEY_QUEUE, ['keys.ack', 'clk'], 'keyboard', 'kbd');
    b.wire(`${kbd}.code`, 'keys.code'); b.wire(`${kbd}.ready`, 'keys.ready');
  }
  if (RD) {
    b.next();
    const rd = b.op(RD, ['cardport.next', 'clk'], 'card reader', 'cards');
    for (const p of ['data', 'ready', 'empty']) b.wire(`${rd}.${p}`, `cardport.${p}`);
  }
  b.wire('switches', `${cpu}.switches`);
  b.wire(`${dma}.irq`, `${cpu}.irq`);
  for (const p of ['pcOut', 'consoleData', 'consoleValid', 'leds', 'retire']) b.wire(`${cpu}.${p}`, p);
  b.wire(`${dma}.busy`, 'dmaBusy');
  const R = b.right, cg = symbolGeom(CPU), cpuY = b.instances.find((i) => i.name === cpu)!.at![1];
  d = define({
    id, name: `Computer on a bus (CPU, DMA, RAM, flash${o.dram ? ', DRAM' : ''}${o.screen ? ', screen' : ''}${o.keys ? ', keyboard' : ''}${RD ? ', card reader' : ''})`, category: 'cpu',
    summary: `The system CPU and a DMA engine share one bus to a ${4 * 2 ** ramK}-byte RAM at 0, a flash at 0x1000_0000 and the DMA's registers at 0x4000_0000. The boot ROM (${4 * 2 ** imemK} bytes) holds the first instructions; everything else is fetched over the bus. The DMA's done interrupt is the CPU's external interrupt.${o.dram ? ' A DRAM (chapter 34\'s controller) at 0x2000_0000.' : ''}${o.screen ? ` A ${SOC_SCREEN} × ${SOC_SCREEN} screen (a byte a pixel) at 0x5000_0000.` : ''}${o.keys ? ' A keyboard at 0x6000_0000 (+0 the oldest key, taken when read; +4 status).' : ''}${RD ? ` A card reader at 0x7000_0000 holding a deck of ${o.cards!.cards.length} cards (+0 status: bit 0 a card waits, bit 1 the hopper is empty; +4 the card's word, taken when read).` : ''}`,
    ports: [bit('clk', 'in', 'left', true), bus('switches', 8, 'in'), bus('pcOut', 32, 'out'), bus('consoleData', 8, 'out'), bit('consoleValid', 'out'), bus('leds', 8, 'out'), bit('retire', 'out'), bit('dmaBusy', 'out')],
    symbol: { kind: 'box', label: 'COMPUTER' },
    netlist: () => ({ pins: { clk: [0, cpuY + cg.ports.clk.pos[1]], switches: [0, cpuY + cg.ports.switches.pos[1]], pcOut: [R, 4], consoleData: [R, 7], consoleValid: [R, 10], leds: [R, 13], retire: [R, 16], dmaBusy: [R, 19] }, instances: b.instances, nets: b.nets() }),
  });
  cache.set(id, d);
  return d;
}

const words = (src: string) => { const a = assemble(src); if (a.errors.length) throw new Error(a.errors[0].message); return a.words; };

/** Chapter 36's computer: the boot ROM and the flash holding the program it loads (bus/programs.ts). */
export function chapterComputer(): ComponentDef {
  return busComputer(words(BOOT_SOURCE), words(PAYLOAD_SOURCE));
}

export const CHAPTER_COMPUTER = chapterComputer();

/** The slaves of chapter 36's last computer. */
export const SYSTEM_OPTIONS: SocOptions = { dram: true, screen: true, keys: true };

/** Chapter 36's last computer: every slave; the boot ROM loads SYSTEM_SOURCE (keys to console, DRAM and screen). */
export function systemComputer(): ComponentDef {
  const payload = words(SYSTEM_SOURCE);
  if (payload.length > SYSTEM_WORDS) throw new Error(`SYSTEM_SOURCE: ${payload.length} words, the boot ROM copies ${SYSTEM_WORDS}`);
  return busComputer(words(bootSource(SYSTEM_WORDS)), payload, SYSTEM_OPTIONS);
}

export const SYSTEM_COMPUTER = systemComputer();

/** A program as a deck of object cards, a word a card, each printed with its source line (cards/card.ts programDeck). */
export function asmDeck(name: string, src: string): Deck {
  const a = assemble(src);
  if (a.errors.length) throw new Error(a.errors[0].message);
  return programDeck(name, a.lines.map((l) => ({ word: l.word, source: l.text })));
}

/** The deck of chapter 36's card computer: CARD_PAYLOAD_SOURCE. */
export const CARD_DECK = asmDeck('CARDS', CARD_PAYLOAD_SOURCE);

/** Chapter 36's card computer: the card boot ROM, an empty flash, the reader holding `deck`. */
export function cardComputer(deck: Deck = CARD_DECK, feed = CARD_FEED): ComponentDef {
  return busComputer(words(CARD_BOOT_SOURCE), [], { cards: deck, cardFeed: feed });
}

export const CARD_COMPUTER = cardComputer();

// ---- the sandbox's System on a bus (editor/examples.ts): parts with their links bundled ---------------

/**
 * The system CPU on a bus with its boot ROM outside (pcOut → a ROM → romData), so that a ROM part holds
 * the boot program: systemCpu({ bus }) with the ROM taken out of its drawing.
 */
export function busCore(imemK = 7): ComponentDef {
  const id = `sysbuscore${imemK}`;
  let d = cache.get(id);
  if (d) return d;
  const base = systemCpu([], { imemK, bus: true });
  d = define({
    id, name: 'RV32I system core on a bus (boot ROM outside)', category: 'cpu',
    summary: `The system CPU of chapter 36 with its boot ROM outside: instructions below ${4 * 2 ** imemK} bytes come from a ROM on pcOut → romData, any other is fetched over the bus, and loads and stores go over the bus. Console, LEDs, switches and the timer (mtime) stay inside at 0x8000_0000; irq is the external interrupt.`,
    ports: [...base.ports.filter((p) => p.dir === 'in'), bus('romData', 32, 'in'), ...base.ports.filter((p) => p.dir === 'out')],
    symbol: { kind: 'box', label: 'RV32I BUS CORE' },
    netlist: () => {
      const nl = base.netlist!();
      const im = nl.instances.find((i) => i.name === 'imem')!, g = symbolGeom(im.def);
      const swap = (e: string) => (e === 'imem.data' ? 'romData' : e);
      return {
        ...nl,
        pins: { ...nl.pins, romData: [im.at![0] + g.ports.data.pos[0], im.at![1] + g.ports.data.pos[1]] },
        instances: nl.instances.filter((i) => i.name !== 'imem'),
        nets: nl.nets.map((n) => ({ ...n, ends: n.ends.filter((e) => e !== 'imem.addr').map(swap), tags: Array.isArray(n.tags) ? n.tags.filter((e) => e !== 'imem.addr').map(swap) : n.tags })),
      };
    },
  });
  cache.set(id, d);
  return d;
}

/** The sandbox system's map (chapter 36's): RAM, flash, DRAM, DMA, screen, I/O (keyboard and timer), then the default slave. */
export const SANDBOX_MAP = [MAP.ram, MAP.flash, MAP.dram, MAP.dma, MAP.screen, MAP.keys, 0xf];

/** The sandbox system's parts, by role (library ids the example places). */
export const SANDBOX_PARTS = (() => {
  const slave = (d: ComponentDef) => bundled(d, [['', 'slave']], `${d.id}_b`);
  const BUS = axiBus(2, SANDBOX_MAP);
  return {
    cpu: bundled(busCore(7), [['', 'master']], 'sysbuscore7_b'),
    bus: bundled(BUS, [['m0_', 'slave'], ['m1_', 'slave'], ...SANDBOX_MAP.map((_, k): [string, 'master'] => [`s${k}_`, 'master'])], `${BUS.id}_b`),
    ram: slave(axiRam(12)), flash: slave(axiFlashWindow(8)), dram: slave(axiDram()),
    dma: bundled(DMA_ENGINE, [['', 'slave'], ['m_', 'master']], 'dma_b'),
    pixel: slave(AXI_PIXEL), io: slave(AXI_IO_PORT), def: slave(AXI_DEFAULT),
  };
})();
