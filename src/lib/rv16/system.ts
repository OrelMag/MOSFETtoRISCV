// The campaign's act 7 blocks: the illegal-instruction detector, the CSR file with the trap and
// mret updates, and the single-cycle RV16 core with exceptions (ecall, ebreak, illegal) and the
// external interrupt, taken between instructions as the golden model does. Timer interrupts and
// mcycle are left to the golden model: the tests never depend on them.

import { CAUSE, CSR16, decode16, MIP_MEIP, MSTATUS_MIE, MSTATUS_MPIE } from '../../riscv/rv16/isa16';
import type { ComponentDef, PortDef } from '../../sim/types';
import { alu, bitwise, constWord } from '../alu';
import { Builder } from '../builder';
import { andN, busMux2, decoder, muxTree } from '../combinational';
import { define, merger, splitter } from '../define';
import { AND, NOT, OR } from '../gates';
import { register } from '../sequential';
import { TIE1 } from '../transistors';
import { orN } from '../wide';
import { BRANCH16, CORE_PORTS, CTL16, IMM16, NEXTPC16 } from './cpu';
import { PC16, RF8 } from './logic';

const bit = (name: string, dir: 'in' | 'out'): PortDef => ({ name, width: 1, dir });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const pinsAt = (names: string[], x: number, step = 4, y0 = 4): Record<string, [number, number]> => Object.fromEntries(names.map((n, i) => [n, [x, y0 + step * i]]));

/** Illegal in RV16I + Zicsr (no M): what the golden model traps on. */
export const isIllegal = (w: number): number => {
  const s = decode16(w).spec;
  return !s || s.ext === 'm' ? 1 : 0;
};

/** Illegal-instruction detector: an unknown SYSTEM, OPX or SHI variant, or any MD instruction. */
export const ILL16: ComponentDef = (() => {
  const b = new Builder(8, 12, 4);
  b.pins('instr');
  // o0 = op, o1 = bits 9:4, o2…o7 = bits 10…15.
  const s = b.op(splitter([4, 6, 1, 1, 1, 1, 1, 1], 2), ['instr'], 'fields');
  const B = (k: number) => b.name(`${s}.o${k - 8}`, `b${k}`, true);
  const bits = [10, 11, 12, 13, 14, 15].map(B);
  const bk = (k: number) => bits[k - 10];
  b.next();
  const dec = b.op(decoder(4), [`${s}.o0`], 'opcode');
  const nb = [10, 11, 12, 13, 14, 15].map((k) => b.name(b.op1(NOT, [bk(k)]), `n${k}`, true));
  const n = (k: number) => nb[k - 10];
  b.next();
  const and3 = andN(3);
  const f3zero = b.op1(and3, [n(13), n(14), n(15)], 'f3 = 0');
  const rs2low = b.op1(OR, [bk(10), bk(11)], 'rs2[1:0] ≠ 0');
  const rs2is4 = b.op1(and3, [bk(12), n(11), n(10)], 'rs2 = 4');
  const f3low = b.op1(OR, [bk(13), bk(14)], 'f3[1:0] ≠ 0');
  const f5 = b.op1(and3, [bk(13), n(14), bk(15)], 'f3 = 5');
  const shiBad = b.op1(AND, [bk(14), bk(15)], 'shift type 3');
  b.next();
  const priv = b.op1(OR, [b.op1(AND, [n(12), rs2low]), rs2is4], 'rs2 ∈ 1…4');
  const csrOk = b.op1(AND, [n(15), f3low], 'f3 ∈ 1…3');
  const opxOk = b.op1(OR, [f3zero, f5], 'OPX legal');
  b.next();
  const sysOk = b.op1(OR, [b.op1(AND, [f3zero, priv]), csrOk], 'SYSTEM legal');
  const t1 = b.op1(AND, [`${dec}.y2`, b.op1(NOT, [opxOk])], 'bad OPX');
  const t2 = b.op1(AND, [`${dec}.y5`, shiBad], 'bad shift');
  b.next();
  const t0 = b.op1(AND, [`${dec}.y0`, b.op1(NOT, [sysOk])], 'bad SYSTEM');
  b.next();
  b.wire(b.op1(orN(4), [t0, t1, `${dec}.y3`, t2], 'illegal'), 'ill');
  const R = b.right;
  return define({
    id: 'rv16_ill', name: 'Illegal-instruction detector (RV16)', category: 'cpu',
    summary: 'ill = 1 for a SYSTEM word that is not ecall / ebreak / mret / wfi / csrr*, an OPX other than sub / sra, a shift of type 3, or any MD instruction (no M): the golden model traps on exactly these.',
    ports: [bus('instr', 16, 'in'), bit('ill', 'out')],
    symbol: { kind: 'box', label: 'ILLEGAL?' },
    spec: ([w]) => [isIllegal(w)],
    netlist: () => ({ pins: { instr: [0, 8], ill: [R, 8] }, instances: b.instances, nets: b.nets() }),
  });
})();

/** The CSR file's behaviour (the y_csr level's model). */
export class CsrModel {
  csr = new Uint16Array(8);
  read(sel: number, irq: number): number {
    if (sel === CSR16.mip) return irq ? MIP_MEIP : 0;
    if (sel === CSR16.mcycle) return 0;
    return this.csr[sel];
  }
  intr(irq: number): number {
    return this.csr[CSR16.mstatus] & MSTATUS_MIE && this.csr[CSR16.mie] & MIP_MEIP && irq ? 1 : 0;
  }
  edge(i: { sel: number; wdata: number; we: number; trap: number; cause: number; pc: number; mret: number }): void {
    const st = this.csr[CSR16.mstatus];
    if (i.trap) {
      this.csr[CSR16.mepc] = i.pc & 0xffff;
      this.csr[CSR16.mcause] = i.cause & 0xffff;
      this.csr[CSR16.mstatus] = (st & ~(MSTATUS_MIE | MSTATUS_MPIE)) | (st & MSTATUS_MIE ? MSTATUS_MPIE : 0);
    } else if (i.mret) {
      this.csr[CSR16.mstatus] = (st & ~MSTATUS_MIE) | (st & MSTATUS_MPIE ? MSTATUS_MIE : 0) | MSTATUS_MPIE;
    } else if (i.we && i.sel !== CSR16.mip && i.sel !== CSR16.mcycle) this.csr[i.sel] = i.wdata & 0xffff;
  }
}

/** The CSR file: six registers, read by number, written by csrr* or by a trap / mret. */
export const CSR16F: ComponentDef = (() => {
  const b = new Builder(18, 14, 6);
  b.pins('sel', 'wdata', 'we', 'trap', 'cause', 'pc', 'mret', 'irq', 'clk');
  const one = b.op1(TIE1, []);
  const zero = b.op1(constWord(16, 0), [], '0');
  const nt = b.name(b.op1(NOT, ['trap']), 'ntrap', true);
  const nm = b.op1(NOT, ['mret']);
  b.next();
  const plain = b.name(b.op1(andN(3), ['we', nt, nm], 'csr write'), 'plain', true);
  const sel = b.op(decoder(3), ['sel'], 'which CSR');
  b.next();
  const wr = (k: number, name: string) => b.op1(AND, [plain, `${sel}.y${k}`], `write ${name}`);
  const w0 = b.name(wr(CSR16.mstatus, 'mstatus'), 'wst', true);
  const w1 = wr(CSR16.mie, 'mie'), w3 = wr(CSR16.mtvec, 'mtvec'), w4 = wr(CSR16.mepc, 'mepc'), w5 = wr(CSR16.mcause, 'mcause'), w6 = wr(CSR16.mscratch, 'mscratch');
  b.next();
  const reg = (d: string, en: string, label: string) => b.name(`${b.op(register(16), [d, en, 'clk'], label)}.q`, label, true);
  const mie = reg('wdata', w1, 'mie');
  const tvec = reg('wdata', w3, 'mtvec');
  const scr = reg('wdata', w6, 'mscratch');
  const epc = reg(b.op1(busMux2(16), ['wdata', 'pc', 'trap'], 'mepc next'), b.op1(OR, ['trap', w4]), 'mepc');
  const cause = reg(b.op1(busMux2(16), ['wdata', 'cause', 'trap'], 'mcause next'), b.op1(OR, ['trap', w5]), 'mcause');
  const mstR = b.op(register(16), ['', one, 'clk'], 'mstatus');
  const mst = b.name(`${mstR}.q`, 'mstatus', true);
  b.next();
  // mstatus: MIE (bit 3) and MPIE (bit 7) follow trap / mret; every bit follows a plain write.
  const ms = b.op(splitter([3, 1, 3, 1, 8], 2), [mst], 'mstatus bits');
  const ws = b.op(splitter([3, 1, 3, 1, 8], 2), ['wdata'], 'written bits');
  b.next();
  const mieW = b.op1(busMux2(1), [`${ms}.o1`, `${ws}.o1`, w0]);
  const mpieW = b.op1(busMux2(1), [`${ms}.o3`, `${ws}.o3`, w0]);
  const lo = b.op1(busMux2(3), [`${ms}.o0`, `${ws}.o0`, w0]);
  const mid = b.op1(busMux2(3), [`${ms}.o2`, `${ws}.o2`, w0]);
  const hi = b.op1(busMux2(8), [`${ms}.o4`, `${ws}.o4`, w0]);
  b.next();
  // MIE' = trap ? 0 : mret ? MPIE : …   MPIE' = trap ? MIE : mret ? 1 : …
  const mieR = b.op1(busMux2(1), [mieW, `${ms}.o3`, 'mret']);
  const mpieR = b.op1(OR, [mpieW, 'mret']);
  b.next();
  const mieT = b.op1(AND, [mieR, nt], 'MIE');
  const mpieT = b.op1(busMux2(1), [mpieR, `${ms}.o1`, 'trap'], 'MPIE');
  b.next();
  b.wire(b.op1(merger([3, 1, 3, 1, 8], 2), [lo, mieT, mid, mpieT, hi], 'mstatus next'), `${mstR}.d`);
  // Read: mip shows the interrupt line at bit 11; mcycle reads 0.
  const mip = b.op1(merger([11, 1, 4], 2), [b.op1(constWord(11, 0), []), 'irq', b.op1(constWord(4, 0), [])], 'mip');
  b.next();
  b.wire(b.op1(muxTree(3, 16), [mst, mie, mip, tvec, epc, cause, scr, zero, 'sel'], 'read'), 'rdata');
  b.wire(tvec, 'mtvec');
  b.wire(epc, 'mepc');
  const mieS = b.op(splitter([11, 1, 4], 2), [mie]);
  b.next();
  b.wire(b.op1(andN(3), [`${ms}.o1`, `${mieS}.o1`, 'irq'], 'interrupt'), 'intr');
  const R = b.right;
  return define({
    id: 'rv16_csr', name: 'CSR file (RV16)', category: 'cpu',
    summary: 'mstatus, mie, mtvec, mepc, mcause, mscratch (mip shows the interrupt line, mcycle reads 0). A trap saves pc and cause and moves MIE into MPIE; mret moves it back; otherwise csrr* write the selected register. intr = MIE · MEIE · irq.',
    ports: [bus('sel', 3, 'in'), bus('wdata', 16, 'in'), bit('we', 'in'), bit('trap', 'in'), bus('cause', 16, 'in'), bus('pc', 16, 'in'), bit('mret', 'in'), bit('irq', 'in'), bit('clk', 'in'),
      bus('rdata', 16, 'out'), bus('mtvec', 16, 'out'), bus('mepc', 16, 'out'), bit('intr', 'out')],
    symbol: { kind: 'box', label: 'CSRs' },
    netlist: () => ({ pins: { ...pinsAt(['sel', 'wdata', 'we', 'trap', 'cause', 'pc', 'mret', 'irq', 'clk'], 0), ...pinsAt(['rdata', 'mtvec', 'mepc', 'intr'], R) }, instances: b.instances, nets: b.nets() }),
  });
})();

/** System decode: what a SYSTEM word is, and the CSR write value (csrrw / csrrs / csrrc). */
export const SYSDEC16: ComponentDef = (() => {
  const b = new Builder(18, 12, 4);
  b.pins('instr', 'rs1v', 'old');
  const s = b.op(splitter([4, 3, 3, 3, 3], 2), ['instr'], 'fields'); // op, rd, rs1, rs2, f3
  b.next();
  const isSys = b.name(`${b.op(decoder(4), [`${s}.o0`], 'opcode')}.y0`, 'sys', true);
  const f3 = b.op(decoder(3), [`${s}.o4`], 'f3');
  const r2 = b.op(decoder(3), [`${s}.o3`], 'rs2');
  const r1s = b.op(splitter([1, 1, 1], 2), [`${s}.o2`]);
  const f3s = b.op(splitter([2, 1], 2), [`${s}.o4`]);
  const rs1nz = b.op1(orN(3), [`${r1s}.o0`, `${r1s}.o1`, `${r1s}.o2`], 'rs1 ≠ x0');
  b.next();
  const priv = b.name(b.op1(AND, [isSys, `${f3}.y0`], 'privileged'), 'priv', true);
  const csrf = b.op1(orN(3), [`${f3}.y1`, `${f3}.y2`, `${f3}.y3`]);
  b.next();
  const csr = b.name(b.op1(AND, [isSys, csrf], 'csr op'), 'csrop', true);
  b.wire(b.op1(AND, [priv, `${r2}.y1`], 'ecall'), 'ecall');
  b.wire(b.op1(AND, [priv, `${r2}.y2`], 'ebreak'), 'ebreak');
  b.wire(b.op1(AND, [priv, `${r2}.y3`], 'mret'), 'mret');
  b.wire(csr, 'csr');
  // Write: csrrw always; csrrs / csrrc only with rs1 ≠ x0.
  const wAlways = b.op1(OR, [`${f3}.y1`, rs1nz]);
  b.next();
  b.wire(b.op1(AND, [csr, wAlways], 'csr write'), 'csrwe');
  const orv = b.op1(bitwise('or', 16), ['old', 'rs1v'], 'set');
  const nrs1 = b.op1(bitwise('xor', 16), ['rs1v', b.op1(constWord(16, 0xffff), [])], '¬rs1');
  b.next();
  const andn = b.op1(bitwise('and', 16), ['old', nrs1], 'clear');
  b.next();
  b.wire(b.op1(muxTree(2, 16), ['rs1v', 'rs1v', orv, andn, `${f3s}.o0`], 'new value'), 'wdata');
  const R = b.right;
  return define({
    id: 'rv16_sysdec', name: 'System decode (RV16)', category: 'cpu',
    summary: 'ecall, ebreak, mret and csr* from a SYSTEM word; the CSR write value (rs1, old | rs1, old & ¬rs1) and whether it writes (csrrs / csrrc with x0 only read).',
    ports: [bus('instr', 16, 'in'), bus('rs1v', 16, 'in'), bus('old', 16, 'in'), bit('ecall', 'out'), bit('ebreak', 'out'), bit('mret', 'out'), bit('csr', 'out'), bit('csrwe', 'out'), bus('wdata', 16, 'out')],
    symbol: { kind: 'box', label: 'SYSTEM' },
    netlist: () => ({ pins: { ...pinsAt(['instr', 'rs1v', 'old'], 0), ...pinsAt(['ecall', 'ebreak', 'mret', 'csr', 'csrwe', 'wdata'], R) }, instances: b.instances, nets: b.nets() }),
  });
})();

const sysCores = new Map<string, ComponentDef>();

/**
 * The single-cycle RV16 core with traps: an illegal instruction, ecall or ebreak (and, with irq,
 * the external interrupt, checked before the instruction at pc runs) saves pc and the cause,
 * jumps to mtvec and does not execute the instruction; mret returns to mepc; csrr* read and
 * write the CSR file. Pins: the core's, plus irq.
 */
export function rv16SysCore(irq: boolean): ComponentDef {
  const key = irq ? 'irq' : 'trap';
  let d = sysCores.get(key);
  if (d) return d;
  const b = new Builder(10, 16, 6);
  b.pins('clk', 'rst', 'instr', 'drdata', 'irq');
  const f = b.op(splitter([2, 2, 3, 3, 3, 3], 4), ['instr'], 'fields');
  const cond = b.name(`${f}.o0`, 'cond', true), rd = b.name(`${f}.o2`, 'rd', true);
  const rs1 = b.name(`${f}.o3`, 'rs1f', true), rs2 = b.name(`${f}.o4`, 'rs2f', true);
  b.next();
  const ctl = b.op(CTL16, ['instr'], 'control');
  const imm = b.op(IMM16, ['instr'], 'immediates');
  const ill = b.name(b.op1(ILL16, ['instr'], 'illegal?'), 'ill', true);
  b.next();
  const immv = b.name(b.op1(muxTree(2, 16), [`${imm}.i`, `${imm}.sb`, `${imm}.j`, `${imm}.u`, `${ctl}.isel`], 'imm'), 'imm', true);
  const rf = b.op(RF8, [rd, '', '', rs1, rs2, 'clk'], 'registers');
  const r1 = b.name(`${rf}.rd1`, 'r1', true), r2 = b.name(`${rf}.rd2`, 'r2', true);
  b.next();
  const sys = b.op(SYSDEC16, ['instr', r1, ''], 'system decode');
  const csrf = b.op(CSR16F, [rs2, `${sys}.wdata`, `${sys}.csrwe`, '', '', '', `${sys}.mret`, irq ? 'irq' : b.op1(constWord(1, 0), []), 'clk'], 'CSRs');
  b.wire(`${csrf}.rdata`, `${sys}.old`);
  b.next();
  // Trap: interrupt first (as the golden model checks it before running the instruction), then
  // illegal, ecall, ebreak. cause = 0x800b, 2, 11 or 3.
  const exc = b.op1(orN(3), [ill, `${sys}.ecall`, `${sys}.ebreak`], 'exception');
  const trap = b.name(b.op1(OR, [exc, `${csrf}.intr`], 'trap'), 'trap', true);
  const c1 = b.op1(busMux2(16), [b.op1(constWord(16, CAUSE.breakpoint), []), b.op1(constWord(16, CAUSE.ecall), []), `${sys}.ecall`]);
  b.next();
  const c2 = b.op1(busMux2(16), [c1, b.op1(constWord(16, CAUSE.illegal), []), ill]);
  b.next();
  const cause = b.op1(busMux2(16), [c2, b.op1(constWord(16, CAUSE.external), []), `${csrf}.intr`], 'cause');
  b.wire(trap, `${csrf}.trap`);
  b.wire(cause, `${csrf}.cause`);
  const ntrap = b.name(b.op1(NOT, [trap]), 'ntrap', true);
  b.next();
  const bsrc = b.op1(busMux2(16), [r2, immv, `${ctl}.bimm`], 'ALU b');
  const y = b.name(`${b.op(alu(16), [r1, bsrc, `${ctl}.alu`], 'ALU')}.y`, 'aluy', true);
  const take = b.op1(BRANCH16, [r1, r2, cond], 'branch?');
  b.next();
  const np = b.op(NEXTPC16, ['', immv, r1, `${ctl}.br`, take, `${ctl}.jal`, `${ctl}.jalr`], 'next PC');
  // Writes happen only when the instruction runs (no trap); a CSR instruction writes rd too.
  const rweAny = b.op1(OR, [`${ctl}.rwe`, `${sys}.csr`]);
  b.next();
  const rwe = b.name(b.op1(AND, [rweAny, ntrap], 'rwe'), 'rwe', true);
  const mwe = b.op1(AND, [`${ctl}.mwe`, ntrap], 'mwe');
  b.wire(rwe, `${rf}.we`);
  const res = b.op1(muxTree(2, 16), [y, 'drdata', `${np}.pc1`, immv, `${ctl}.wb`], 'result');
  b.next();
  const wbv = b.name(b.op1(busMux2(16), [res, `${csrf}.rdata`, `${sys}.csr`], 'or a CSR'), 'wbv', true);
  b.wire(wbv, `${rf}.wd`);
  // Next PC: trap → mtvec, mret → mepc, else the usual.
  const t1 = b.op1(busMux2(16), [`${np}.target`, `${csrf}.mepc`, `${sys}.mret`]);
  const ldN = b.op1(AND, [`${np}.ld`, ntrap]);
  b.next();
  const target = b.op1(busMux2(16), [t1, `${csrf}.mtvec`, trap], 'target');
  const ld = b.op1(orN(3), [ldN, trap, `${sys}.mret`], 'jump');
  b.next();
  const pc = b.op(PC16, ['rst', ld, target, 'clk'], 'PC');
  const pcq = b.name(`${pc}.pc`, 'pc', true);
  b.wire(pcq, `${np}.pc`);
  b.wire(pcq, `${csrf}.pc`);
  b.wire(pcq, 'pc');
  b.wire(y, 'daddr');
  b.wire(r2, 'dwdata');
  b.wire(mwe, 'dwe');
  b.wire(rwe, 'rwe');
  b.wire(rd, 'rwa');
  b.wire(wbv, 'rwd');
  const R = b.right;
  d = define({
    id: irq ? 'rv16_cpu_irq' : 'rv16_cpu_trap', name: irq ? 'RV16 core with traps and interrupts' : 'RV16 core with traps', category: 'cpu',
    summary: 'The single-cycle core plus a CSR file, an illegal-instruction detector and system decode. A trap (illegal, ecall, ebreak' + (irq ? ', or the external interrupt' : '') + ') replaces the instruction: mepc ← pc, mcause ← cause, pc ← mtvec. mret returns.',
    ports: [...CORE_PORTS.slice(0, 4), bit('irq', 'in'), ...CORE_PORTS.slice(4)],
    symbol: { kind: 'box', label: irq ? 'RV16 + IRQ' : 'RV16 + traps' },
    netlist: () => ({
      pins: { ...pinsAt(['clk', 'rst', 'instr', 'drdata', 'irq'], 0, 4), ...pinsAt(['pc', 'daddr', 'dwdata', 'dwe', 'rwe', 'rwa', 'rwd'], R, 4) },
      instances: b.instances, nets: b.nets(),
    }),
  });
  sysCores.set(key, d);
  return d;
}

export const RV16_CPU_TRAP = rv16SysCore(false);
export const RV16_CPU_IRQ = rv16SysCore(true);
