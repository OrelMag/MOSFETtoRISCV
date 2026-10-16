// Appendix B's Doom computer at gate level: the system core with ports (systemCore, RV32IM) and,
// on its buses, the memory map of doom/machine.ts, which the fast interpreter implements:
//
//   addr[31:28]  0, 2–7  RAM, 2^21 words in byte banks (bankedBigRam(21)), wrapping every 8 MiB
//                1       the WAD, read only (romLevels of 2^23 words: 32 MiB), writes ignored
//                8–B     the devices (DEVICES: register = addr[4:2]); the core keeps mtime / mtimecmp
//                C–F     frame buffer + palette, 2^15 words in byte banks, wrapping every 128 KiB
//
// The program ROM (2^16 words) sits on pcOut → instr. Built per program image and per WAD (the WAD's
// words are the ROM's contents, its length the WADLEN register), memoized by both.

import { symbolGeom } from '../sim/geometry';
import type { Behavior, ComponentDef, InstanceDef, NetDef } from '../sim/types';
import { constWord } from './alu';
import { bankedBigRam, romLevels, wordsHash, type RomLeaf } from './bigmem';
import { decoder, muxTree } from './combinational';
import { merger, splitter } from './define';
import { AND, MUX2, NOT } from './gates';
import { andN } from './combinational';
import { register } from './sequential';
import { systemCore } from './system';
import { TIE0 } from './transistors';

const bit = (name: string, dir: 'in' | 'out', side?: 'bottom') => ({ name, dir, width: 1, ...(side ? { side } : {}) });
const bus = (name: string, width: number, dir: 'in' | 'out') => ({ name, dir, width });

/** Doom's key queue: the keyboard controller, a source outside the computer. A rising edge with pop = 1 takes one event. */
export interface KeyQueueState {
  /** Events not read yet: (pressed << 8) | Doom key code. */
  q: number[];
  clk: number;
  /** pop as sampled while clk was low. */
  pop: number;
}

export const KEY_QUEUE: ComponentDef = {
  id: 'doom_keys', name: 'Key queue', category: 'cpu',
  summary: 'Key events from the keyboard, oldest first: the head is on code (0: none) and a rising clock edge with pop = 1 takes it. Outside the computer, like the keyboard itself: its state is set by the page.',
  ports: [bit('pop', 'in'), { name: 'clk', width: 1, dir: 'in', side: 'bottom', clock: true }, bus('code', 32, 'out')],
  symbol: { kind: 'box', label: 'KEYS' },
  behavior: {
    init: () => ({ q: [], clk: 0, pop: 0 }) as KeyQueueState,
    seq: { clk: 'clk', comb: [] },
    eval: ([pop, clk], st) => {
      const s = st as KeyQueueState;
      const c = clk < 0 ? 2 : clk;
      if (c !== 1) s.pop = pop;
      if (s.clk === 0 && c === 1 && s.pop === 1) s.q.shift();
      s.clk = c;
      return [s.q.length ? s.q[0] : 0];
    },
  } satisfies Behavior,
};

/** The devices beside the core's timer (doom/machine.ts REG): console, LEDs, switches (0), WADLEN, KEY, FLIP. */
export function doomDevices(wadLength: number): ComponentDef {
  const ins: InstanceDef[] = [], nets: NetDef[] = [];
  const add = (name: string, def: ComponentDef, at: [number, number], label?: string) => ins.push({ name, def, at, label });
  const D = decoder(3, true), M = muxTree(3, 32), R8 = register(8);
  add('sa', splitter([2, 3, 27]), [4, 0]);
  add('wdec', D, [16, 0], 'write');
  add('rdec', D, [16, symbolGeom(D).h + 6], 'read');
  add('sw', splitter([8, 24]), [4, 2 * symbolGeom(D).h + 14]);
  add('rLed', R8, [30, 2 * symbolGeom(D).h + 14], 'LEDs');
  add('keys', KEY_QUEUE, [30, 0]);
  add('kLen', constWord(32, wadLength), [30, 12], 'WADLEN');
  add('zLed', merger([8, 24]), [44, 2 * symbolGeom(D).h + 14]);
  add('z24', constWord(24, 0), [44, 2 * symbolGeom(D).h + 24]);
  add('z32', constWord(32, 0), [44, 12]);
  add('rsel', M, [58, 0]);
  const net = (name: string | undefined, ...ends: string[]) => nets.push({ name, ends, tags: true });
  net('addr', 'addr', 'sa.in');
  net('reg', 'sa.o1', 'wdec.a', 'rdec.a', 'rsel.s');
  net('we', 'we', 'wdec.en');
  net('re', 're', 'rdec.en');
  net('wdata', 'wdata', 'sw.in');
  net('wbyte', 'sw.o0', 'consoleData', 'rLed.d');
  net('consoleValid', 'wdec.y0', 'consoleValid');
  net('weLed', 'wdec.y1', 'rLed.en');
  net('flip', 'wdec.y7', 'flip');
  net('pop', 'rdec.y6', 'keys.pop');
  net('leds', 'rLed.q', 'leds', 'zLed.i0');
  net(undefined, 'z24.y', 'zLed.i1');
  net(undefined, 'zLed.out', 'rsel.d1');
  net('WADLEN', 'kLen.y', 'rsel.d3');
  net('key', 'keys.code', 'rsel.d6');
  net(undefined, 'z32.y', 'rsel.d0', 'rsel.d2', 'rsel.d4', 'rsel.d5', 'rsel.d7');
  nets.push({ name: 'rdata', ends: ['rsel.y', 'rdata'] });
  net('clk', 'clk', 'rLed.clk', 'keys.clk');
  const right = 58 + symbolGeom(M).w + 6;
  return {
    id: `doomdev_${wadLength}`, name: 'Doom devices', category: 'cpu',
    summary: 'The I/O registers beside the core\'s timer (register = addr[4:2]): 0 console (a store prints its byte), 1 LEDs, 2 switches (0), 3 WADLEN, 6 KEY (a load takes one key event: the read strobe pops the queue at the edge), 7 FLIP (a store says the frame is done).',
    ports: [bus('addr', 32, 'in'), bus('wdata', 32, 'in'), bit('we', 'in'), bit('re', 'in'), { name: 'clk', width: 1, dir: 'in', side: 'bottom', clock: true },
      bus('rdata', 32, 'out'), bus('consoleData', 8, 'out'), bit('consoleValid', 'out'), bus('leds', 8, 'out'), bit('flip', 'out')],
    symbol: { kind: 'box', label: 'DEVICES' },
    netlist: () => ({
      pins: { addr: [0, 2], wdata: [0, 2 * symbolGeom(D).h + 16], we: [0, 6], re: [0, symbolGeom(D).h + 8], clk: [0, 2 * symbolGeom(D).h + 28],
        rdata: [right, 4], consoleData: [right, 12], consoleValid: [right, 16], leds: [right, 20], flip: [right, 24] },
      instances: ins, nets,
    }),
  };
}

/** A word-addressed ROM of 2^k ≤ 2^8 words: a multiplexer tree of constants (the bottom of a big ROM). */
const leafCache = new Map<string, ComponentDef>();
export const romLeaf: RomLeaf = (k, w, content) => {
  const key = `${k}_${w}_${wordsHash(content)}`;
  const hit = leafCache.get(key);
  if (hit) return hit;
  const words = Uint32Array.from(content);
  const M = muxTree(k, w, 4), mg = symbolGeom(M);
  const d: ComponentDef = {
    id: `drom${key}`, name: `ROM ${2 ** k}×${w}`, category: 'memory',
    summary: `${2 ** k} words, read-only: a multiplexer tree whose inputs are tied to the words' bits.`,
    ports: [{ name: 'addr', width: k, dir: 'in' }, { name: 'data', width: w, dir: 'out' }],
    symbol: { kind: 'box', label: 'ROM' },
    behavior: { eval: ([a]) => [a < 0 ? -1 : words[a % words.length]], delay: 3 * k },
    preferBehavior: true,
    netlist: () => {
      const instances: InstanceDef[] = [{ name: 'mux', def: M, at: [16, 0] }];
      const nets: NetDef[] = [{ name: 'addr', ends: ['addr', 'mux.s'] }, { name: 'data', ends: ['mux.y', 'data'] }];
      words.forEach((v, i) => {
        instances.push({ name: `c${i}`, def: constWord(w, v), at: [6, mg.ports[`d${i}`].pos[1] - 1], label: `[${i}]` });
        nets.push({ ends: [`c${i}.y`, `mux.d${i}`] });
      });
      return { pins: { addr: [0, mg.h + 4], data: [16 + mg.w + 6, mg.ports.y.pos[1]] }, instances, nets };
    },
  };
  leafCache.set(key, d);
  return d;
};

/** NOP-padded program ROM of 2^16 words, byte addressed (pcOut). */
export function doomProgramRom(text: ArrayLike<number>): ComponentDef {
  const content = new Uint32Array(1 << 16).fill(0x00000013);
  content.set(Array.prototype.slice.call(text, 0, 1 << 16) as number[]);
  return romLevels(16, 32, true, content, `doomrom_${wordsHash(content)}`, romLeaf);
}

/** The WAD as a ROM of 2^23 words (32 MiB), byte addressed: word = addr[24:2]. */
export function wadRom(words: Uint32Array, length: number): ComponentDef {
  if (words.length !== 1 << 23) throw new Error('wadRom: the WAD words must span 2^23 (32 MiB)');
  const base = romLevels(23, 32, true, words, `wad_${length}`, romLeaf);
  // 23 levels of 2:1 multiplexers would be 69 NAND delays; the event wheel holds 63 (one cycle is
  // settled to the end anyway: the delay only shapes the timeline inside it)
  return { ...base, name: 'WAD (game data)', symbol: { kind: 'box', label: 'WAD ROM' }, behavior: { ...base.behavior!, delay: 63 } };
}

const pcCache = new WeakMap<Uint32Array, Map<string, ComponentDef>>();

/**
 * The Doom computer: `text` the program's instruction words, `wad` the WAD's words over the whole
 * 32 MiB span (zeros after the file), `wadLength` its length in bytes.
 */
export function doomComputer(text: Uint32Array, wad: Uint32Array, wadLength: number): ComponentDef {
  let byText = pcCache.get(wad);
  if (!byText) pcCache.set(wad, (byText = new Map()));
  const key = wordsHash(text);
  const hit = byText.get(key);
  if (hit) return hit;
  const def = build(doomProgramRom(text), wadRom(wad, wadLength), doomDevices(wadLength));
  byText.set(key, def);
  return def;
}

function build(IM: ComponentDef, WAD: ComponentDef, DEV: ComponentDef): ComponentDef {
  const CORE = systemCore({ m: true }), RAM = bankedBigRam(21), FB = bankedBigRam(15), RS = muxTree(2, 32);
  const g = (d: ComponentDef) => symbolGeom(d);
  const ins: InstanceDef[] = [];
  const add = (name: string, def: ComponentDef, at: [number, number], label?: string) => ins.push({ name, def, at, label });
  const cg = g(CORE);
  add('imem', IM, [0, 6], 'program');
  add('cpu', CORE, [g(IM).w + 16, 0], 'core');
  const xM = g(IM).w + 16 + cg.w + 24;
  let y = 0;
  for (const [name, def, label] of [['ram', RAM, 'RAM 8 MiB'], ['wad', WAD, 'WAD'], ['fb', FB, 'frame buffer'], ['dev', DEV, 'devices']] as [string, ComponentDef, string][]) {
    add(name, def, [xM, y], label);
    y += g(def).h + 8;
  }
  add('rsel', RS, [xM + Math.max(g(RAM).w, g(WAD).w, g(FB).w, g(DEV).w) + 16, 2], 'read');
  // region decode under the core: addr[31:28] → RAM / WAD / devices / frame buffer
  const yG = cg.h + 10, x0 = g(IM).w + 16;
  const gate = (name: string, def: ComponentDef, i: number) => add(name, def, [x0 + 14 * (i % 6), yG + 12 * Math.floor(i / 6)]);
  [['ra', splitter([28, 1, 1, 1, 1])], ['n31', NOT], ['n30', NOT], ['n29', NOT], ['isWad', andN(4)], ['nwad', NOT],
    ['isRam', AND], ['isDev', AND], ['isFb', AND], ['ramWe', AND], ['fbWe', AND], ['devWe', AND],
    ['devRe', AND], ['s0', MUX2], ['sel', merger([1, 1])], ['irq0', TIE0]]
    .forEach(([n, d], i) => gate(n as string, d as ComponentDef, i));
  const nets: NetDef[] = [];
  const net = (name: string | undefined, ...ends: string[]) => nets.push({ name, ends, tags: true });
  net('clk', 'clk', 'cpu.clk', 'ram.clk', 'fb.clk', 'dev.clk');
  net('irq', 'irq0.y', 'cpu.irq');
  nets.push({ name: 'PC', ends: ['cpu.pcOut', 'imem.addr', 'pcOut'], tags: ['pcOut'] });
  nets.push({ name: 'Instr', ends: ['imem.data', 'cpu.instr'] });
  net('addr', 'cpu.memAddr', 'ram.addr', 'wad.addr', 'fb.addr', 'dev.addr', 'ra.in');
  net('wdata', 'cpu.memWData', 'ram.wdata', 'fb.wdata', 'dev.wdata');
  net('be', 'cpu.memBE', 'ram.be', 'fb.be');
  net('memWE', 'cpu.memWE', 'ramWe.a', 'fbWe.a', 'devWe.a');
  net('memRE', 'cpu.memRE', 'devRe.a');
  net('a28', 'ra.o1', 'isWad.i3');
  net('a29', 'ra.o2', 'n29.a');
  net('a30', 'ra.o3', 'n30.a', 'isFb.b', 's0.b');
  net('a31', 'ra.o4', 'n31.a', 'isDev.a', 'isFb.a', 'sel.i1', 's0.s');
  net('¬a31', 'n31.y', 'isWad.i0', 'isRam.a');
  net('¬a30', 'n30.y', 'isWad.i1', 'isDev.b');
  net('¬a29', 'n29.y', 'isWad.i2');
  net('isWad', 'isWad.y', 'nwad.a', 's0.a');
  net('¬isWad', 'nwad.y', 'isRam.b');
  net('isRam', 'isRam.y', 'ramWe.b');
  net('isDev', 'isDev.y', 'devWe.b', 'devRe.b');
  net('isFb', 'isFb.y', 'fbWe.b');
  net('ramWe', 'ramWe.y', 'ram.we');
  net('fbWe', 'fbWe.y', 'fb.we');
  net('devWe', 'devWe.y', 'dev.we');
  net('devRe', 'devRe.y', 'dev.re');
  // read select: a31 = 0 → RAM (00) or WAD (01); 1 → devices (10) or frame buffer (11)
  net('s0', 's0.y', 'sel.i0');
  net('region', 'sel.out', 'rsel.s');
  net('ramR', 'ram.rdata', 'rsel.d0');
  net('wadR', 'wad.data', 'rsel.d1');
  net('devR', 'dev.rdata', 'rsel.d2');
  net('fbR', 'fb.rdata', 'rsel.d3');
  net('rdata', 'rsel.y', 'cpu.memRData');
  net('retire', 'cpu.retire', 'retire');
  net('consoleData', 'dev.consoleData', 'consoleData');
  net('consoleValid', 'dev.consoleValid', 'consoleValid');
  net('leds', 'dev.leds', 'leds');
  net('flip', 'dev.flip', 'flip');
  const right = xM + Math.max(g(RAM).w, g(WAD).w, g(FB).w, g(DEV).w) + 16 + g(RS).w + 10;
  const pins: Record<string, [number, number]> = { clk: [0, 2] };
  ['pcOut', 'retire', 'consoleData', 'consoleValid', 'leds', 'flip'].forEach((n, i) => (pins[n] = [right, 4 + 4 * i]));
  return {
    id: `doompc_${IM.id}_${WAD.id}`, name: 'Doom computer', category: 'cpu',
    summary: 'Appendix B\'s computer at gate level: the RV32IM system core, its program ROM, 8 MiB of RAM, the WAD as a ROM, a 320 × 200 frame buffer with its palette, and the devices (console, KEY, FLIP, WADLEN). The same memory map as the fast interpreter, cycle for cycle.',
    ports: [{ name: 'clk', width: 1, dir: 'in', clock: true }, bus('pcOut', 32, 'out'), bit('retire', 'out'), bus('consoleData', 8, 'out'), bit('consoleValid', 'out'), bus('leds', 8, 'out'), bit('flip', 'out')],
    symbol: { kind: 'box', label: 'DOOM PC' },
    netlist: () => ({ pins, instances: ins, nets }),
  };
}

