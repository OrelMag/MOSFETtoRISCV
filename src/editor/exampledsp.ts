// Examples ▸ DSP core: the DSP core of the DSP core chapter as a sandbox chip. The core without its memories (lib/dsp24core.ts, the
// placed part dsp24_core), a 256-word program ROM in DSP24 assembly (a benchmark of dsp/programs24.ts), the X and Y memories
// as two RAM parts of 256 × 16 whose initial contents are the benchmark's images, a register that keeps the last word `out`
// sent (loaded when outv is 1) on a hex display, and a halt part. Wires first; the pointers carry the clock and the
// links that run back (pc to the ROM, the memories' read data to the core, the store data to both).

import { assemble24 } from '../dsp/asm24';
import { disasm24 } from '../dsp/isa24';
import { BENCH24, type Bench24 } from '../dsp/programs24';
import { dsp24Core } from '../lib/dsp24core';
import type { ChipDoc, PartRef } from './model';
import { Sheet } from './example6502';

export const DSP_NOTES = 'The DSP core of the "A DSP core" chapter with its memories outside, one instruction per clock. The ROM holds the benchmark in DSP24 assembly (Edit program… for the listing and the other benchmarks); '
  + 'X and Y are two RAM parts of 256 × 16 that start with the benchmark\'s samples and coefficients (their properties hold the initial contents). '
  + 'A store puts a word on wdata with xwe or ywe; `out` sends one word with outv = 1, and the register keeps the last one on the hex display; halt stops Run. '
  + 'Run, or Run to halt in the CPU drawer, which checks the PC, r0–r7, the pointers, the address generators, the hardware loop and the 40-bit accumulator against the golden model after every clock, and every store in X and Y. '
  + 'Double-click the core to open it: sequencer, registers, the two address generators, the MAC.';

/** A benchmark of the chapter as a chip: the core, its program and its two memories. */
export function dspChip(id: string, name: string, bench: Pick<Bench24, 'name' | 'about' | 'src' | 'x' | 'y'> = BENCH24[0]): ChipDoc {
  dsp24Core(); // registered (the part resolves by id)
  const s = new Sheet();
  const romRef: PartRef = { rom: { k: 8, w: 24, addr: 'word', lang: 'dsp24', src: bench.src } };
  s.pin('clk', 'in', [2, 4], 1, { kind: 'clock' });
  s.part('rom', romRef, [14, 12], { label: 'program' });
  s.part('core', { lib: 'dsp24_core' }, [30, 6], { label: 'DSP core' });
  s.part('xram', { ram: { k: 8, w: 16, init: bench.x } }, [58, 4], { label: 'X memory (samples)' });
  s.part('yram', { ram: { k: 8, w: 16, init: bench.y } }, [58, 18], { label: 'Y memory (coefficients)' });
  s.part('last', { lib: 'reg16' }, [56, 30], { label: 'last out' });
  s.part('show', { display: 'hex', width: 16 }, [68, 31], { label: 'out' });
  s.part('halt', { display: 'halt', width: 1 }, [48, 37], { label: 'halt' });

  // fetch: the ROM's word into the core; the PC runs back to the ROM through a pointer
  s.wire('rom.data', 'core.instr', [], { name: 'instr' });
  s.tap('core.pc', 'pc'); s.tap('rom.addr', 'pc');
  // the memories: address and write enable by wire, the read data back through pointers, the store data to both
  s.wire('core.xaddr', 'xram.addr', [[48, 10], [48, 6]]);
  s.wire('core.xwe', 'xram.we', [[50, 14], [50, 10]]);
  s.wire('core.yaddr', 'yram.addr', [[54, 12], [54, 20]]);
  s.wire('core.ywe', 'yram.we', [[52, 16], [52, 24]]);
  s.tap('core.wdata', 'wd'); s.tap('xram.din', 'wd'); s.tap('yram.din', 'wd');
  s.tap('xram.dout', 'xd'); s.tap('core.xdata', 'xd');
  s.tap('yram.dout', 'yd'); s.tap('core.ydata', 'yd');
  // the output: a register loaded when outv is 1, the halt part
  s.wire('core.out', 'last.d', [[50, 20], [50, 32]]);
  s.wire('core.outv', 'last.en', [[48, 22], [48, 34]]);
  s.wire('core.halt', 'halt.a', [[46, 24], [46, 38]]);
  s.wire('last.q', 'show.a');
  // the clock
  s.tap('pin:clk', 'clk'); s.tap('core.clk', 'clk'); s.tap('xram.clk', 'clk'); s.tap('yram.clk', 'clk'); s.tap('last.clk', 'clk');
  return s.doc(id, name, { hue: 270, notes: `${DSP_NOTES} ${bench.name}: ${bench.about}.` });
}

/** Program words as DSP24 assembly: a word's disassembly where it assembles back to the word, else a .word with it as a comment; trailing zeros dropped. */
export function dspSource(words: readonly number[]): string {
  let n = words.length;
  while (n > 1 && !words[n - 1]) n--;
  return words.slice(0, n).map((w, i) => {
    const t = disasm24(w);
    let back: number | undefined;
    try { back = assemble24(`.org ${i}\n${t}`).words[i]; } catch { back = undefined; }
    return back === w ? t : `.word 0x${w.toString(16).padStart(6, '0')}  ; ${t}`;
  }).join('\n') + '\n';
}
