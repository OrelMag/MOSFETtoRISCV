// Appendix A's instruction-set reference: the 6502's opcode matrix (16 × 16, the 151 documented
// opcodes), coloured by class or addressing mode. A click opens an opcode: its aaa bbb cc fields,
// size, cycles, flags, the bus cycles it makes (run on the ISS, not typed in) and the decode PLA
// rows it lights in each cycle of our chip.

import { CLASS_TITLES, fields, MODES, type Mode, type OpClass, OPCODES, type OpInfo } from '../m6502/isa';
import { Cpu6502, Ram64 } from '../m6502/iss';
import { plaRows, type PlaRow } from '../m6502/pla';
import { UCODE } from '../m6502/ucode';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';

const hex = (v: number, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');

/** Flags each mnemonic writes. */
const FLAGS: Record<string, string> = {
  ADC: 'N V Z C', SBC: 'N V Z C', AND: 'N Z', ORA: 'N Z', EOR: 'N Z', CMP: 'N Z C', CPX: 'N Z C', CPY: 'N Z C', BIT: 'N V Z',
  LDA: 'N Z', LDX: 'N Z', LDY: 'N Z', ASL: 'N Z C', LSR: 'N Z C', ROL: 'N Z C', ROR: 'N Z C', INC: 'N Z', DEC: 'N Z',
  INX: 'N Z', INY: 'N Z', DEX: 'N Z', DEY: 'N Z', TAX: 'N Z', TXA: 'N Z', TAY: 'N Z', TYA: 'N Z', TSX: 'N Z', PLA: 'N Z',
  PLP: 'all', RTI: 'all', CLC: 'C', SEC: 'C', CLI: 'I', SEI: 'I', CLV: 'V', CLD: 'D', SED: 'D', BRK: 'I (and B on the stack)',
};
const CLASS_HUE: Record<OpClass, string> = { ldst: 's1', alu: 's2', rmw: 's3', branch: 's4', jump: 's5', stack: 's6', transfer: 's7', flag: 's8' };
const MODE_HUE: Record<Mode, string> = {
  impl: 's8', acc: 's8', imm: 's3', zp: 's1', zpx: 's7', zpy: 's7', abs: 's2', abx: 's5', aby: 's5', izx: 's6', izy: 's6', ind: 's6', rel: 's4',
};

/** The bus cycles of one instance of the opcode, run on the ISS (cross: an index that crosses a page, or a taken branch to another page). */
export function busCycles(o: OpInfo, cross: boolean): { addr: number; data: number; write: boolean; role: string }[] {
  const ram = new Ram64();
  // a branch sits near the end of a page so that a short offset can leave it
  const pc = o.mode === 'rel' ? 0x02f0 : 0x0230;
  const cpu = new Cpu6502(ram);
  // operands chosen so that an index lands on the same page, or crosses it
  // a branch is taken: its flag (bits 7:6 of the opcode pick N V C Z) set to bit 5 of the opcode
  const taken = ((o.op >> 5) & 1) === 1 ? 0xc3 : 0;
  Object.assign(cpu, { pc, s: 0xf0, a: 0x41, x: cross ? 0xf0 : 0x02, y: cross ? 0xf0 : 0x03, p: 0x20 | (o.mode === 'rel' ? taken : 0) });
  const lo = o.mode === 'rel' ? (cross ? 0x10 : 0x02) : 0x40;
  ram.mem.set([o.op, lo, 0x12], pc);
  // pointers for the indirect modes, and the vectors
  ram.mem.set([0x80, 0x34], (lo + cpu.x) & 0xff);
  ram.mem.set([0x80, 0x34], lo);
  ram.mem.set([0x00, 0x05], 0x1240);
  ram.mem.set([0x00, 0x04], 0xfffe);
  ram.mem.set([0xcd, 0x02, 0x55], 0x01f1);
  const out: { addr: number; data: number; write: boolean; role: string }[] = [];
  const n = o.mode === 'rel' ? (cross ? 4 : 3) : o.cycles + (cross && o.pageCross ? 1 : 0);
  for (let i = 0; i < n; i++) {
    cpu.tick();
    const a = cpu.busAddr;
    const role = i === 0 ? 'opcode' : i === 1 && (o.mode === 'impl' || o.mode === 'acc') ? 'next byte (dummy)'
      : o.mode === 'rel' && i === 2 ? 'dummy fetch; PCL + offset' : o.mode === 'rel' && i === 3 ? 'dummy fetch (old page); PCH fixed' : a >> 8 === 1 ? 'stack' : a >= 0xfffa ? 'vector' : (a === pc + 1 || a === pc + 2) && !cpu.busWrite ? 'operand' : cpu.busWrite ? 'write' : 'read';
    out.push({ addr: a, data: cpu.busData, write: cpu.busWrite, role });
  }
  return out;
}

let rowsCache: PlaRow[] | undefined;

export function opcodeMatrix(): Widget {
  let colourBy: 'class' | 'mode' = 'class';
  let sel = 0x7d;
  let cross = false;
  const grid = h('table', { class: 'm65-op' });
  const legend = h('div', { class: 'm65-legend' });
  const detail = h('div', { class: 'm65-detail' });
  const colourBtn = h('button', { class: 'btn sm' }, 'Colour: class');
  colourBtn.addEventListener('click', () => {
    colourBy = colourBy === 'class' ? 'mode' : 'class';
    colourBtn.textContent = colourBy === 'class' ? 'Colour: class' : 'Colour: addressing mode';
    render();
  });
  const render = () => {
    const head = h('tr', null, h('th', null, ''), ...Array.from({ length: 16 }, (_, c) => h('th', null, `-${hex(c, 1)}`)));
    const rows = Array.from({ length: 16 }, (_, r) => h('tr', null, h('th', null, `${hex(r, 1)}-`), ...Array.from({ length: 16 }, (_, c) => {
      const op = r * 16 + c, o = OPCODES[op];
      if (!o) return h('td', { class: 'x', title: `$${hex(op)}: undocumented` });
      const hue = colourBy === 'class' ? CLASS_HUE[o.cls] : MODE_HUE[o.mode];
      const cyc = `${o.cycles}${o.pageCross || o.branch ? '+' : ''}`;
      const td = h('td', { class: `${hue}${op === sel ? ' sel' : ''}`, title: `$${hex(op)} ${o.mnemonic} ${MODES[o.mode].title}` },
        h('b', null, o.mnemonic), h('span', null, `${MODES[o.mode].syntax.replace('$nnnn', 'nnnn').replace('$nn', 'nn').replace('#$', '#')}${MODES[o.mode].syntax ? ' · ' : ''}${cyc}`));
      td.addEventListener('click', () => { sel = op; cross = false; render(); });
      return td;
    })));
    grid.replaceChildren(head, ...rows);
    const n = OPCODES.filter(Boolean).length;
    legend.replaceChildren(h('b', null, `${n} opcodes`), ...(colourBy === 'class'
      ? (Object.keys(CLASS_HUE) as OpClass[]).map((k) => h('span', null, h('i', { class: CLASS_HUE[k] }), CLASS_TITLES[k]))
      : (['impl', 'imm', 'zp', 'zpx', 'abs', 'abx', 'izx', 'rel'] as Mode[]).map((k) => h('span', null, h('i', { class: MODE_HUE[k] }),
        { impl: 'implied / accumulator', imm: 'immediate', zp: 'zero page', zpx: 'zero page,X / Y', abs: 'absolute', abx: 'absolute,X / Y', izx: 'indirect', rel: 'relative' }[k as string]))));
    showDetail();
  };
  const showDetail = () => {
    const o = OPCODES[sel]!;
    const f = fields(sel);
    const bits = sel.toString(2).padStart(8, '0');
    const m = MODES[o.mode];
    const cyc = `${o.cycles}${o.pageCross ? ' (+1 if the index crosses a page)' : o.branch ? ' if not taken (+1 if taken, +1 more to another page)' : ''}`;
    const canCross = o.pageCross || o.branch || ((o.mode === 'abx' || o.mode === 'aby' || o.mode === 'izy') && o.access !== 'r');
    const cycles = busCycles(o, cross);
    rowsCache ??= plaRows();
    const lit = (UCODE[sel] ?? []).map((_, t) => rowsCache!.filter((r) => r.t === t + 1 && (sel & ~r.cube.mask) === r.cube.val).length);
    const crossBtn = canCross ? h('label', { class: 'm65-cross' }, h('input', { type: 'checkbox', checked: cross || null, onchange: (e: Event) => { cross = (e.target as HTMLInputElement).checked; showDetail(); } }),
      o.branch ? ' taken, to another page' : ' index crosses a page') : '';
    detail.replaceChildren(
      h('div', { class: 'm65-k' }, `Opcode $${hex(sel)}`),
      h('div', { class: 'm65-big' }, o.mnemonic, ' ', h('span', null, m.syntax)),
      h('div', { class: 'm65-enc' }, ...[...bits].map((b, i) => h('span', { class: i < 3 ? 'aaa' : i < 6 ? 'bbb' : 'cc' }, b))),
      h('div', { class: 'm65-enc l' }, h('span', { style: 'flex:3' }, `aaa = ${f.aaa}`), h('span', { style: 'flex:3' }, `bbb = ${f.bbb}`), h('span', { style: 'flex:2' }, `cc = ${f.cc}`)),
      h('div', { class: 'm65-kv' },
        h('span', null, 'Addressing'), h('span', null, m.title),
        h('span', null, 'Bytes'), h('span', null, String(m.bytes)),
        h('span', null, 'Cycles'), h('span', null, cyc),
        h('span', null, 'Flags'), h('span', null, FLAGS[o.mnemonic] ?? '—'),
        h('span', null, 'Decode PLA'), h('span', { title: 'Rows of our chip\'s decode PLA that match this opcode, per cycle (T1 finishes the previous instruction)' }, lit.map((n, t) => `T${t + 1}: ${n}`).join(' · '))),
      h('div', { class: 'm65-k' }, 'Bus cycles ', crossBtn),
      h('table', { class: 'm65-trace' },
        h('tr', null, ...['', 'address', 'data', 'R/W', ''].map((x) => h('th', null, x))),
        ...cycles.map((c, i) => h('tr', { class: i === 0 ? 'sync' : '' }, h('td', null, String(i + 1)), h('td', null, `$${hex(c.addr, 4)}`), h('td', null, hex(c.data)),
          h('td', { class: c.write ? 'w' : '' }, c.write ? 'W' : 'R'), h('td', { class: 'note' }, c.role)))),
      h('p', { class: 'm65-note' }, 'Every cycle is a bus access, the dummy ones included: a 6502 cannot leave the bus idle. Computed by running the reference model on this opcode.'));
  };
  // the 13 addressing modes, each with the cycles of LDA (or the instruction that has it) in that mode
  const example = (m: Mode) => ['LDA', 'LDX', 'NOP', 'ASL', 'JMP', 'BNE'].map((mn) => OPCODES.find((o) => o && o.mode === m && o.mnemonic === mn)).find(Boolean)
    ?? OPCODES.find((o) => o && o.mode === m)!;
  const modes = h('table', { class: 'm65-modes' },
    h('tr', null, ...['mode', 'syntax', 'bytes', 'example', 'cycles'].map((x) => h('th', null, x))),
    ...(Object.keys(MODES) as Mode[]).map((m) => {
      const o = example(m)!;
      return h('tr', null, h('td', null, MODES[m].title), h('td', null, MODES[m].syntax || '—'), h('td', null, String(MODES[m].bytes)),
        h('td', null, `${o.mnemonic} ${MODES[m].syntax}`.trim()), h('td', null, `${o.cycles}${o.pageCross || o.branch ? '+' : ''}`));
    }));
  const el = h('div', { class: 'm65-isa' },
    h('div', { class: 'm65-isa-main' }, h('div', { class: 'm65-isa-bar' }, colourBtn), grid, legend, h('div', { class: 'm65-k' }, 'Addressing modes'), modes),
    detail);
  render();
  return { el };
}
