// The custom-instruction row's controls, shared by the sandbox's dialog (editor/owninstr.ts) and chapter 14's challenge
// (a panel beside the single-cycle CPU): the signal lines, the data path a row lights, the golden model's code for it.

import '../styles/owninstr.css';
import { slotOpcode, uses, type CustomRow } from '../riscv/custom';
import { s } from '../ui/dom';

/** The control signals a row asserts, as the dialog lists them. */
export const LINES: { key: keyof CustomRow; label: string; opts: [unknown, string][] }[] = [
  { key: 'regWrite', label: 'write rd', opts: [[true, 'yes'], [false, 'no']] },
  { key: 'srcA', label: 'ALU A', opts: [['rs1', 'rs1'], ['pc', 'PC']] },
  { key: 'srcB', label: 'ALU B', opts: [['rs2', 'rs2'], ['imm', 'imm']] },
  { key: 'alu', label: 'ALU op', opts: [['add', 'add'], ['sub', 'subtract'], ['funct3', 'funct3 picks']] },
  { key: 'memWrite', label: 'write memory', opts: [[false, 'no'], [true, 'yes (data: rs2)']] },
  { key: 'result', label: 'result', opts: [['alu', 'ALU'], ['mem', 'memory'], ['pc4', 'PC + 4'], ['imm', 'imm']] },
  { key: 'next', label: 'next PC', opts: [['pc4', 'PC + 4'], ['branch', 'branch on funct3'], ['jump', 'PC + imm'], ['jalr', 'ALU result']] },
];

/** The single-cycle data path sketch: blocks and which the row lights. */
const BLOCKS: Record<string, [number, number, number, number, string]> = {
  pc: [8, 104, 34, 30, 'PC'], im: [52, 98, 42, 42, 'IMEM'], rf: [118, 24, 56, 66, 'Regs'], ig: [118, 150, 56, 30, 'ImmGen'],
  ma: [196, 30, 22, 30, 'A'], mb: [196, 78, 22, 30, 'B'], alu: [236, 40, 42, 60, 'ALU'], dm: [296, 40, 46, 52, 'DMEM'],
  rm: [362, 46, 26, 74, 'Res'], np: [236, 170, 70, 32, 'Next PC'],
};

export function dataPath(r: CustomRow): SVGSVGElement {
  const u = uses(r);
  const lit = new Set(['pc', 'im']);
  if (u.rs1 || u.rs2 || r.regWrite) lit.add('rf');
  if (u.imm) lit.add('ig');
  if (u.alu) ['ma', 'mb', 'alu'].forEach((k) => lit.add(k));
  if (u.mem) lit.add('dm');
  if (r.regWrite) lit.add('rm');
  if (r.next !== 'pc4') lit.add('np');
  const P = (k: string, side: 'l' | 'r' | 't' | 'b', dy = 0): [number, number] => {
    const [x, y, w, hh] = BLOCKS[k];
    return side === 'r' ? [x + w, y + hh / 2 + dy] : side === 'l' ? [x, y + hh / 2 + dy] : side === 'b' ? [x + w / 2, y + hh] : [x + w / 2, y];
  };
  const parts: SVGElement[] = [];
  const link = (a: [number, number], b: [number, number], on: boolean, label?: string) => {
    const mx = (a[0] + b[0]) / 2;
    parts.push(s('path', { class: on ? 'lit' : '', d: `M${a[0]} ${a[1]}H${mx}V${b[1]}H${b[0]}` }));
    if (label) parts.push(s('text', { class: 'lbl', x: mx + 3, y: Math.min(a[1], b[1]) - 4 }, label));
  };
  const res = r.regWrite ? r.result : null;
  link(P('pc', 'r'), P('im', 'l'), true);
  link(P('im', 'r', -10), P('rf', 'l', -10), u.rs1 || u.rs2 || r.regWrite);
  link(P('im', 'r', 10), P('ig', 'l'), u.imm);
  link(P('rf', 'r', -12), P('ma', 'l'), u.alu && r.srcA === 'rs1', 'rs1');
  link(P('pc', 'b'), [207, 60], u.alu && r.srcA === 'pc');
  link(P('rf', 'r', 12), P('mb', 'l'), u.alu && r.srcB === 'rs2', 'rs2');
  link(P('ig', 'r'), [207, 108], u.alu && r.srcB === 'imm');
  link(P('ma', 'r'), P('alu', 'l', -14), u.alu);
  link(P('mb', 'r'), P('alu', 'l', 14), u.alu);
  link(P('alu', 'r', -6), P('dm', 'l', -6), u.mem, 'addr');
  link([174, 66], P('dm', 'l', 14), r.memWrite, 'data');
  link(P('alu', 'r', 16), P('rm', 'l', 22), res === 'alu');
  link(P('dm', 'r'), P('rm', 'l', -12), res === 'mem');
  link(P('ig', 'r', 8), P('rm', 'l', 34), res === 'imm');
  link(P('rm', 'b'), [148, 98], r.regWrite);
  link(P('ig', 'b'), P('np', 'l'), r.next === 'jump' || r.next === 'branch');
  link(P('alu', 'b'), P('np', 't'), r.next === 'jalr' || r.next === 'branch');
  for (const [k, [x, y, w, hh, n]] of Object.entries(BLOCKS)) {
    parts.push(s('g', { class: lit.has(k) ? 'lit' : '' }, s('rect', { x, y, width: w, height: hh, rx: 5 }), s('text', { x: x + w / 2, y: y + hh / 2 }, n)));
  }
  return s('svg', { class: 'oi-dp', viewBox: '0 0 400 210', role: 'img', 'aria-label': `Data path: ${[...lit].map((k) => BLOCKS[k][4]).join(', ')}` }, parts);
}

/** The golden model's code for a row, as generated (shown, not run: iss.ts runs the row itself). */
export function issCode(r: CustomRow): string {
  const A = r.srcA === 'pc' ? 'pc' : 'x[rs1]', B = r.srcB === 'imm' ? 'imm' : 'x[rs2]';
  const alu = r.alu === 'add' ? `${A} + ${B}` : r.alu === 'sub' ? `${A} - ${B}` : `alu(funct3, ${A}, ${B})`;
  const out = [`// ${r.name}: ${r.fmt}-type, opcode ${slotOpcode(r.slot).toString(2).padStart(7, '0')}`];
  const u = uses(r);
  if (u.alu) out.push(`const y = ${alu};`);
  if (r.memWrite) out.push('store32(y, x[rs2]);');
  if (r.regWrite) out.push(`if (rd) x[rd] = ${{ alu: 'y', mem: 'load32(y)', pc4: 'pc + 4', imm: 'imm' }[r.result]};`);
  out.push({ pc4: 'pc += 4;', branch: 'pc = cond(funct3, x[rs1], x[rs2]) ? pc + imm : pc + 4;', jump: 'pc += imm;', jalr: 'pc = y & ~1;' }[r.next]);
  return out.join('\n');
}

