// Examples ▸ 6502 computer: the 6502 part (lib/m6502/core.ts: the cycle-exact model, opening onto the
// transistor-level chip of Appendix A), a 4K ROM in 6502 assembly, a memory map (a user chip: the
// address decoder, 2K of RAM, the read multiplexers) and the RV32 computer's devices (console, LEDs,
// switches). A halt detector stops Run where the program jumps to itself. The CPU drawer follows it.

import { instPort, type Vec } from '../sim/geometry';
import type { ComponentDef, PortDef } from '../sim/types';
import { FIB6502 } from '../m6502/sbprograms';
import { type ChipDoc, type EndRef, type LabelDoc, type PartDoc, type PartRef, type PinDoc, type WireDoc } from './model';
import { isError, partDef } from './parts';

const NOTES_MAP = 'RAM $0000–$3FFF (2K, repeating: zero page, the stack in page 1), console $4000 (a store prints), LEDs $4001 (a store lights them), switches $4002 (a load reads them; the devices repeat every 4 bytes), ROM $8000–$FFFF (4K, repeating: the program at $F000, the vectors at $FFFA).';

export const NOTES_6502 = 'A computer of 1975: the MOS 6502 (one bus cycle per clock, every cycle as the chip makes it; double-click it for its 3 510 transistors, replaying what it did), '
  + 'a 4K program ROM in 6502 assembly (Edit program…; samples: hello, Fibonacci in decimal, a BCD count, the switches), the memory map (double-click: the decoder, 2K of RAM, the read multiplexers) and the devices. '
  + `${NOTES_MAP} The halt detector latches each opcode fetch's address (SYNC) and stops Run when the next one is the same: a JMP to itself. Run, or Run to halt in the CPU drawer.`;

/** A chip document under construction: parts, pins, wires and pointer taps. */
class Sheet {
  pins: PinDoc[] = [];
  parts: PartDoc[] = [];
  wires: WireDoc[] = [];
  labels: LabelDoc[] = [];
  private defs = new Map<string, ComponentDef>();
  private n = 0;

  pin(id: string, dir: PinDoc['dir'], at: Vec, width = 1, extra: Partial<PinDoc> = {}): void {
    this.pins.push({ id, name: id, dir, width, at, ...extra });
  }

  /** A part; `def` stands in for a user chip (its box as compile.ts makes it). */
  part(id: string, ref: PartRef, at: Vec, extra: Partial<PartDoc> = {}, def?: ComponentDef): void {
    const d = def ?? partDef(ref, () => undefined);
    if (isError(d)) throw new Error(`6502 example: ${d.error}`);
    this.defs.set(id, d);
    this.parts.push({ id, ref, at, ...extra });
  }

  /** Where a part's port is, and which way its wire leaves. */
  port(id: string, port: string) {
    const p = this.parts.find((q) => q.id === id)!;
    return instPort(this.defs.get(id)!, p.at, p.flip, port);
  }

  wire(a: string | EndRef, b: string | EndRef, pts: Vec[] = [], extra: Partial<WireDoc> = {}): string {
    const id = extra.id ?? `w${this.n++}`;
    this.wires.push({ id, a: end(a), b: end(b), pts, ...extra });
    return id;
  }

  /** A pointer named `name` two units out from a part's port (or a pin), joined to it. */
  tap(e: string, name: string): void {
    const at = this.endAt(e);
    const d = { left: [-2, 0], right: [2, 0], up: [0, -2], down: [0, 2] }[at.exit] as Vec;
    const id = `l${this.n++}`;
    this.labels.push({ id, name, at: [at.pos[0] + d[0], at.pos[1] + d[1]], face: at.exit });
    this.wire(e, `lbl:${id}`);
  }

  private endAt(e: string): { pos: Vec; exit: 'left' | 'right' | 'up' | 'down' } {
    if (e.startsWith('pin:')) {
      const p = this.pins.find((q) => q.id === e.slice(4))!;
      return { pos: p.at, exit: p.dir === 'out' ? 'left' : 'right' };
    }
    const [id, port] = e.split('.');
    return this.port(id, port);
  }

  doc(id: string, name: string, c: Partial<ChipDoc>): ChipDoc {
    return { id, name, pins: this.pins, parts: this.parts, wires: this.wires, labels: this.labels, ...c };
  }
}

/** 'x.a' → part port, 'pin:a' → pin, 'lbl:l1' → pointer. */
function end(s: string | EndRef): EndRef {
  if (typeof s !== 'string') return s;
  if (s.startsWith('pin:')) return { pin: s.slice(4) };
  if (s.startsWith('lbl:')) return { label: s.slice(4) };
  const i = s.indexOf('.');
  return { part: s.slice(0, i), port: s.slice(i + 1) };
}

/** A user chip's box as compile.ts builds it (pins in order: inputs, then outputs, top to bottom), for its port positions. */
function chipBox(doc: ChipDoc): ComponentDef {
  const byPos = (a: PinDoc, b: PinDoc) => a.at[1] - b.at[1] || a.at[0] - b.at[0];
  const ports: PortDef[] = (['in', 'inout', 'out'] as const).flatMap((d) => doc.pins.filter((p) => p.dir === d).sort(byPos))
    .map((p) => ({ name: p.name, width: p.width, dir: p.dir, ...(p.kind === 'clock' ? { clock: true } : {}) }));
  return { id: doc.id, name: doc.name, category: 'custom', ports, symbol: { kind: 'box', label: doc.name } };
}

/**
 * The memory map: a15 picks the ROM, else a14 the devices, else the RAM. A store (R/W low) raises the RAM's
 * write enable or, through a 2-to-4 decoder on a[1:0], the console's or the LEDs'. A load returns the RAM,
 * the switches or the ROM's byte through two multiplexers.
 */
export function memory6502Chip(id: string, name: string): ChipDoc {
  const s = new Sheet();
  s.pin('a', 'in', [0, 6], 16); s.pin('rw', 'in', [0, 17]); s.pin('dout', 'in', [0, 26], 8); s.pin('clk', 'in', [0, 34], 1, { kind: 'clock' });
  s.pin('rom', 'in', [0, 38], 8); s.pin('sw', 'in', [0, 40], 8);
  s.pin('conWe', 'out', [56, 8]); s.pin('ledWe', 'out', [56, 10]); s.pin('din', 'out', [56, 28], 8);

  s.part('sa', { split: [11, 3, 1, 1] }, [8, 2]);
  s.part('sd', { split: [2, 14] }, [8, 12]);
  s.part('ramsel', { lib: 'nor' }, [24, 3], { label: 'RAM' });
  s.part('n15', { lib: 'not' }, [16, 9]);
  s.part('iosel', { lib: 'and' }, [24, 9], { label: 'I/O' });
  s.part('nw', { lib: 'not' }, [16, 16], { label: 'write' });
  s.part('ramst', { lib: 'and' }, [32, 2], { label: 'RAM store' });
  s.part('iost', { lib: 'and' }, [32, 10], { label: 'I/O store' });
  s.part('dec', { lib: 'dec2e' }, [40, 6], { label: 'device' });
  s.part('ram', { ram: { k: 11, w: 8 } }, [14, 22], { label: 'RAM 2K × 8' });
  s.part('m1', { lib: 'mux2x8' }, [34, 24], { label: 'RAM / I/O' });
  s.part('m2', { lib: 'mux2x8' }, [44, 25], { label: 'ROM' });

  // the address: its bits to the decoder, the low 11 to the RAM, a[1:0] to the device select
  const a = s.wire('pin:a', 'sa.in', [], { name: 'a' });
  s.wire({ wire: a, at: [4, 6] }, 'sd.in', [[4, 14]]);
  s.tap('sa.o0', 'ra'); s.tap('ram.addr', 'ra');
  s.tap('sa.o2', 'a14'); s.tap('sa.o3', 'a15');
  s.tap('sd.o0', 'sel'); s.tap('dec.a', 'sel');
  s.tap('ramsel.a', 'a14'); s.tap('ramsel.b', 'a15');
  s.tap('n15.a', 'a15'); s.wire('n15.y', 'iosel.a'); s.tap('iosel.b', 'a14');
  // a store: R/W low
  s.wire('pin:rw', 'nw.a'); s.tap('nw.y', 'we');
  s.tap('ramst.a', 'we'); s.wire('ramsel.y', 'ramst.b'); s.tap('ramst.y', 'ramWe'); s.tap('ram.we', 'ramWe');
  s.wire('iosel.y', 'iost.a'); s.tap('iost.b', 'we'); s.wire('iost.y', 'dec.en');
  s.wire('dec.y0', 'pin:conWe'); s.wire('dec.y1', 'pin:ledWe');
  // the RAM, and what a load reads
  s.wire('pin:dout', 'ram.din'); s.wire('pin:clk', 'ram.clk');
  s.wire('ram.dout', 'm1.a'); s.tap('m1.b', 'sw'); s.tap('m1.s', 'a14');
  s.wire('m1.y', 'm2.a'); s.tap('m2.b', 'rom'); s.tap('m2.s', 'a15');
  s.wire('m2.y', 'pin:din');
  s.tap('pin:rom', 'rom'); s.tap('pin:sw', 'sw');
  return s.doc(id, name, { hue: 200, notes: `The 6502 computer's memory map. ${NOTES_MAP}` });
}

/** The computer around its memory map and devices chips (placed by id; their pins give the boxes' ports). */
export function computer6502Chip(id: string, name: string, sub: { mem: ChipDoc; dev: ChipDoc }, src = FIB6502): ChipDoc {
  const s = new Sheet();
  s.pin('clk', 'in', [2, 8], 1, { kind: 'clock' });
  s.part('hi', { const: { width: 1, value: 1 } }, [10, 9]);
  s.part('cpu', { lib: 'm6502_core' }, [16, 6], { label: '6502' });
  s.part('ra', { split: [12, 4] }, [30, 1]);
  s.part('rom', { rom: { k: 12, w: 8, addr: 'word', lang: '6502', src } }, [34, 0], { label: 'program 4K' });
  s.part('mem', { chip: sub.mem.id }, [52, 8], {}, chipBox(sub.mem));
  s.part('dev', { chip: sub.dev.id }, [52, 30], {}, chipBox(sub.dev));
  s.part('last', { lib: 'reg16' }, [16, 24], { label: 'last fetch' });
  s.part('same', { lib: 'eq16' }, [28, 25]);
  s.part('stop', { lib: 'and' }, [38, 26]);
  s.part('halt', { display: 'halt', width: 1 }, [46, 27]);

  s.wire('pin:clk', 'cpu.clk');
  // RES, IRQ and NMI held inactive (high)
  const hi = s.wire('hi.y', 'cpu.resb');
  const irq = s.wire({ wire: hi, at: [14, 10] }, 'cpu.irqb', [[14, 12]]);
  s.wire({ wire: irq, at: [14, 12] }, 'cpu.nmib', [[14, 14]]);
  // the bus: the address to the ROM (its low 12 bits) and the memory map, the data both ways
  s.wire('cpu.a', 'ra.in', [[28, 9], [28, 3]], { name: 'a' });
  s.wire('ra.o0', 'rom.addr');
  s.tap('rom.data', 'romData');
  s.tap('cpu.a', 'a'); s.tap('cpu.dout', 'dout'); s.tap('cpu.rw', 'rw'); s.tap('cpu.sync', 'sync'); s.tap('cpu.din', 'din');
  s.tap('mem.a', 'a'); s.tap('mem.rw', 'rw'); s.tap('mem.dout', 'dout'); s.tap('mem.clk', 'clk'); s.tap('mem.rom', 'romData'); s.tap('mem.sw', 'sw');
  s.tap('mem.din', 'din'); s.tap('mem.conWe', 'conWe'); s.tap('mem.ledWe', 'ledWe');
  s.tap('dev.byte', 'dout'); s.tap('dev.conWe', 'conWe'); s.tap('dev.ledWe', 'ledWe'); s.tap('dev.clk', 'clk'); s.tap('dev.sw', 'sw');
  s.tap('pin:clk', 'clk');
  // the halt detector: the last opcode fetch's address against this one's
  s.tap('last.d', 'a'); s.tap('last.en', 'sync'); s.tap('last.clk', 'clk');
  s.wire('last.q', 'same.a'); s.tap('same.b', 'a');
  s.wire('same.eq', 'stop.a'); s.tap('stop.b', 'sync');
  s.wire('stop.y', 'halt.a');
  return s.doc(id, name, { notes: NOTES_6502 });
}
