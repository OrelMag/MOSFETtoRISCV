// Examples ▸ PDP-8 front panel: a 4096-word ROM of 12-bit words in the PDP-8's instruction table holding the classic
// Hello, world. The ROM is the PDP-8's core; its Front panel… button (memui.ts, editor/pdp8panel.ts) runs it on the
// machine's model with lamps, switches and the teletype. As a circuit it is the core image read by address: set addr,
// read the word on data, and the ROM's listing marks the line.

import { PDP8_PRESET } from '../isa/presets';
import { PDP8_HELLO } from '../pdp8/programs';
import type { ChipDoc } from './model';

export function pdp8Chip(id: string, name: string): ChipDoc {
  return {
    id, name,
    notes: 'The ROM holds a PDP-8 program in the PDP-8\'s own instruction table: 12-bit words, octal, PAL-style operands. Select the ROM and press Front panel…: '
      + 'the PDP-8 runs it on its model (not on this circuit), with lamps for PC, MA, MB, AC and L, the switch register, LOAD ADD, DEP, EXAM, START and a teletype. '
      + 'On the canvas the ROM is the core image: set addr to an address and read the word on data.',
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
