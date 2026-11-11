// Examples ▸ PDP-8 front panel: a 4096-word ROM of 12-bit words in the PDP-8's instruction table holding the classic
// Hello, world. The ROM is the PDP-8's core; its Front panel… button (memui.ts, editor/pdp8panel.ts) runs it on the
// machine's model with lamps, switches and the teletype. As a circuit it is the core image read by address: set addr,
// read the word on data, and the ROM's listing marks the line.

import { PDP8_PRESET } from '../isa/presets';
import { PDP8_CORE } from '../lib/pdp8';
import { assemblePdp8, PDP8_HELLO } from '../pdp8/programs';
import { Sheet } from './example6502';
import type { ChipDoc } from './model';

export function pdp8Chip(id: string, name: string): ChipDoc {
  return {
    id, name,
    notes: 'The ROM holds a PDP-8 program in the PDP-8\'s own instruction table: 12-bit words, octal, PAL-style operands. Select the ROM and press Front panel…: '
      + 'the PDP-8 runs it on its model (not on this circuit), with lamps for PC, MA, MB, AC and L, the switch register, LOAD ADD, DEP, EXAM, START and a teletype. '
      + 'On the canvas the ROM is the core image: set addr to an address and read the word on data. Octal, pages, the operate bits and the keys: Codex ▸ PDP-8.',
    pins: [
      { id: 'addr', name: 'addr', dir: 'in', width: 12, at: [2, 8], value: PDP8_HELLO.start },
      { id: 'data', name: 'data', dir: 'out', width: 12, at: [40, 8] },
    ],
    parts: [{ id: 'core', ref: { rom: { k: 12, w: 12, addr: 'word', lang: 'isa', isa: PDP8_PRESET, src: PDP8_HELLO.src } }, at: [16, 6], label: 'PDP-8 core' }],
    wires: [
      { id: 'a', a: { pin: 'addr' }, b: { part: 'core', port: 'addr' }, pts: [] },
      { id: 'd', a: { part: 'core', port: 'data' }, b: { pin: 'data' }, pts: [] },
    ],
    labels: [],
    comments: [{ id: 'how', at: [2, 18], text: 'Select the ROM, then Front panel…: LOAD ADD 0200, START prints HELLO, WORLD! on the teletype.' }],
  };
}

/** The panel's keys as the gate-level processor's pins, with the names on the chip's input pins. */
export const PDP8G_KEYS: [port: string, pin: string][] = [
  ['ld', 'LOAD_ADD'], ['start', 'START'], ['dep', 'DEP'], ['exam', 'EXAM'], ['cont', 'CONT'], ['stop', 'STOP'], ['sstep', 'SING_INST'],
];

/**
 * Examples ▸ PDP-8 in gates: lib/pdp8.ts's processor (one clock edge per major state) as a part, a 4096 × 12 RAM
 * standing in for the core and holding Hello, world, the console teletype (a console part prints, a keyboard part types),
 * and the front panel: the switch register and the seven keys as the chip's pins (a key acts once when it goes to 1).
 * Every connection is a pointer pair, named for the signal.
 */
export function pdp8GatesChip(id: string, name: string): ChipDoc {
  PDP8_CORE; // registered: the part resolves by id
  const s = new Sheet();
  const words = Array.from(assemblePdp8(PDP8_HELLO.src).words);
  while (words.length && !words[words.length - 1]) words.pop();
  s.part('cpu', { lib: 'pdp8_core' }, [16, 4], { label: 'PDP-8 processor' });
  // the panel: the switch register and the keys level with the ports they drive, wired straight across
  const y = (port: string) => s.port('cpu', port).pos[1];
  s.pin('SR', 'in', [4, y('sr')], 12, { value: PDP8_HELLO.start });
  for (const [port, pin] of PDP8G_KEYS) s.pin(pin, 'in', [4, y(port)], 1, { value: 0 });
  s.pin('clk', 'in', [4, y('kready') + 8], 1, { kind: 'clock' });
  s.part('core', { ram: { k: 12, w: 12, init: words } }, [50, 4], { label: 'core 4K × 12' });
  s.part('kbd', { keyboard: true }, [50, 22], { label: 'keyboard' });
  s.part('tty', { console: { cols: 24, rows: 6 } }, [50, 30], { label: 'teleprinter' });
  s.part('pcd', { display: 'value', width: 12 }, [66, 4], { label: 'PC' });
  s.part('acd', { display: 'value', width: 12 }, [66, 10], { label: 'AC' });
  s.part('rund', { display: 'led', width: 1 }, [66, 16], { label: 'RUN' });
  s.tap('pin:clk', 'clk'); s.tap('cpu.clk', 'clk'); s.tap('core.clk', 'clk'); s.tap('tty.clk', 'clk');
  s.wire('pin:SR', 'cpu.sr');
  for (const [port, pin] of PDP8G_KEYS) s.wire(`pin:${pin}`, `cpu.${port}`);
  // the core: an address, the word written, write enable; the word read back at once
  s.tap('cpu.maddr', 'maddr'); s.tap('core.addr', 'maddr');
  s.tap('cpu.din', 'mwrite'); s.tap('core.din', 'mwrite');
  s.tap('cpu.mwe', 'mwe'); s.tap('core.we', 'mwe');
  s.tap('core.dout', 'mread'); s.tap('cpu.dout', 'mread');
  // the teletype
  s.tap('kbd.code', 'kcode'); s.tap('cpu.kcode', 'kcode');
  s.tap('kbd.ready', 'kready'); s.tap('cpu.kready', 'kready');
  s.tap('cpu.kack', 'kack'); s.tap('kbd.ack', 'kack');
  s.tap('cpu.tdata', 'tdata'); s.tap('tty.data', 'tdata');
  s.tap('cpu.twe', 'twe'); s.tap('tty.we', 'twe');
  // lamps on the canvas (the CPU drawer has the whole panel)
  s.tap('cpu.pc', 'pc'); s.tap('pcd.a', 'pc');
  s.tap('cpu.ac', 'ac'); s.tap('acd.a', 'ac');
  s.tap('cpu.run', 'run'); s.tap('rund.a', 'run');
  return s.doc(id, name, {
    notes: 'The PDP-8 built from gates: double-click the processor for its control unit, MA & MB, PC, AC & link (both operate groups, the MQ) and the teletype\'s IOTs. '
      + 'One clock edge is one memory cycle (Fetch, Defer, Execute); DEC split each into four time pulses, which a RAM read at once does not need. '
      + 'The RAM stands in for the core memory (whose reads were destructive, rewritten in the same cycle) and holds Hello, world from 0200. '
      + 'SR is the switch register; a key pin acts once when it goes to 1. Run, then LOAD_ADD (PC ← SR), then START: the teleprinter prints. What the machine assumes: Codex ▸ PDP-8.',
    comments: [{ id: 'how', at: [4, 50], text: 'Run the clock, set LOAD_ADD to 1 (PC ← SR = 0200), then START: HELLO, WORLD! on the teleprinter.' }],
  });
}
