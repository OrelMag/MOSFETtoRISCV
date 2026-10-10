// Level 8b: the multicycle processor (Harris & Harris §7.4, RISC-V edition). One ALU and one memory
// port are reused across 3–5 short cycles per instruction; registers (IR, OldPC, A, B, Data, ALUOut)
// carry values between cycles. The sequencing lives in a controller, built two ways from the same
// state table: a hardwired finite-state machine and a microprogrammed one.

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { alu, constWord, isZero } from './alu';
import { busMux2, decoder, muxTree } from './combinational';
import { CLEAR_BIT0, CONTROL, IMM_GEN, NEXT_PC, OPCODE_DECODER, dataMemory, rom } from './cpu';
import { define, merger, splitter } from './define';
import { AND, OR } from './gates';
import { regfile } from './regfile';
import { register } from './sequential';
import { TIE0, TIE1 } from './transistors';
import { orN } from './wide';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width, dir, side });

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

// ---- the state table: the single source for both controllers ----------------------------------------

/** Control fields in microword order (least-significant first) with their widths. */
export const MC_FIELDS: [string, number][] = [
  ['pcUpdate', 1], ['branch', 1], ['irWrite', 1], ['regWrite', 1], ['memWrite', 1], ['adrSrc', 1],
  ['resultSrc', 2], ['aluSrcA', 2], ['aluSrcB', 2], ['aluFunct', 1], ['retire', 1],
];
export type McNext = number | 'decode' | 'mem';
export interface McState { name: string; does: string; sig: Record<string, number>; next: McNext }

// ALUSrcA: 0 PC, 1 OldPC, 2 A.  ALUSrcB: 0 B, 1 ImmExt, 2 the constant 4.
// ResultSrc: 0 ALUOut, 1 Data, 2 ALUResult, 3 ImmExt.  aluFunct: 0 add, 1 the instruction's own operation.
export const MC_STATES: McState[] = [
  { name: 'Fetch', does: 'IR ← mem[PC]; OldPC ← PC; PC ← PC + 4', sig: { adrSrc: 0, irWrite: 1, aluSrcA: 0, aluSrcB: 2, resultSrc: 2, pcUpdate: 1 }, next: 1 },
  { name: 'Decode', does: 'A, B ← rs1, rs2; ALUOut ← OldPC + imm (a branch target, just in case)', sig: { aluSrcA: 1, aluSrcB: 1 }, next: 'decode' },
  { name: 'MemAdr', does: 'ALUOut ← A + imm', sig: { aluSrcA: 2, aluSrcB: 1 }, next: 'mem' },
  { name: 'MemRead', does: 'Data ← mem[ALUOut]', sig: { resultSrc: 0, adrSrc: 1 }, next: 4 },
  { name: 'MemWB', does: 'rd ← Data', sig: { resultSrc: 1, regWrite: 1, retire: 1 }, next: 0 },
  { name: 'MemWrite', does: 'mem[ALUOut] ← B', sig: { resultSrc: 0, adrSrc: 1, memWrite: 1, retire: 1 }, next: 0 },
  { name: 'ExecuteR', does: 'ALUOut ← A op B', sig: { aluSrcA: 2, aluSrcB: 0, aluFunct: 1 }, next: 7 },
  { name: 'ALUWB', does: 'rd ← ALUOut', sig: { resultSrc: 0, regWrite: 1, retire: 1 }, next: 0 },
  { name: 'ExecuteI', does: 'ALUOut ← A op imm', sig: { aluSrcA: 2, aluSrcB: 1, aluFunct: 1 }, next: 7 },
  { name: 'JAL', does: 'PC ← ALUOut (the target); ALUOut ← OldPC + 4', sig: { aluSrcA: 1, aluSrcB: 2, resultSrc: 0, pcUpdate: 1 }, next: 7 },
  { name: 'Branch', does: 'compare A − B; if taken, PC ← ALUOut (the target)', sig: { aluSrcA: 2, aluSrcB: 0, aluFunct: 1, resultSrc: 0, branch: 1, retire: 1 }, next: 0 },
  { name: 'JALR', does: 'ALUOut ← A + imm (the target)', sig: { aluSrcA: 2, aluSrcB: 1 }, next: 9 },
  { name: 'LUI', does: 'rd ← imm', sig: { resultSrc: 3, regWrite: 1, retire: 1 }, next: 0 },
];

/** Decode dispatch: opcode class → state. AUIPC needs no execute cycle: Decode already computed OldPC + imm. */
export const MC_DISPATCH: [string, number][] = [['LOAD', 2], ['STORE', 2], ['R', 6], ['I', 8], ['JAL', 9], ['BRANCH', 10], ['JALR', 11], ['LUI', 12], ['AUIPC', 7]];
const OPCODES5: Record<string, number> = { R: 0b01100, I: 0b00100, LOAD: 0b00000, STORE: 0b01000, BRANCH: 0b11000, JAL: 0b11011, JALR: 0b11001, LUI: 0b01101, AUIPC: 0b00101 };
/** Memory dispatch: load → MemRead, store → MemWrite. */
export const MC_DISPATCH2: [string, number][] = [['LOAD', 3], ['STORE', 5]];

const SEQ = { next: 0, decode: 1, mem: 2 } as const;

/** The microword of a state: control fields, then the next-address field (4 bits) and the sequencing mode (2 bits). */
export function microword(s: McState): number {
  let w = 0, pos = 0;
  for (const [f, n] of MC_FIELDS) {
    w += (s.sig[f] ?? 0) * 2 ** pos;
    pos += n;
  }
  const nextField = typeof s.next === 'number' ? s.next : 0;
  const seq = typeof s.next === 'number' ? SEQ.next : SEQ[s.next];
  return w + nextField * 2 ** pos + seq * 2 ** (pos + 4);
}
const CTRL_BITS = MC_FIELDS.reduce((a, [, n]) => a + n, 0);

const ctrlPorts = (): PortDef[] => [
  bit('clk', 'in', 'bottom', true), bus('op', 7, 'in'),
  ...MC_FIELDS.map(([f, n]) => (n === 1 ? bit(f, 'out') : bus(f, n, 'out'))),
  bus('state', 4, 'out'),
];

// ---- hardwired controller ----------------------------------------------------------------------------

/**
 * Hardwired FSM: a 4-bit state register, a 4→16 decoder giving one wire per state, and gates.
 * Each control output is the OR of the states that assert it; each next-state bit is the OR of the
 * transitions (state AND opcode class) whose target has that bit set.
 */
export const MC_FSM: ComponentDef = (() => {
  const REG = register(4), DEC = decoder(4), OPD = OPCODE_DECODER;
  const rg = symbolGeom(REG), dg = symbolGeom(DEC), og = symbolGeom(OPD);
  const instances: InstanceDef[] = [];
  const nets: NetDef[] = [];
  const ends = new Map<string, string[]>();
  const sink = (drv: string, s: string) => { if (!ends.has(drv)) ends.set(drv, []); ends.get(drv)!.push(s); };
  // Columns: state register and opcode decoder | state decoder | AND terms | next-state ORs | output ORs.
  // Each gap leaves room for a tag pointing right out of one column and one pointing left into the next.
  const tagLen = (s: string) => 2.8 + 0.5 * s.length;
  const longest = (xs: string[]) => Math.max(...xs.map(tagLen));
  const stateTag = longest(MC_STATES.map((s) => s.name)), condTag = longest(MC_DISPATCH.map(([c]) => `is${c}`));
  const xR = 8, xO = 8, xD = Math.ceil(xO + og.w + condTag + 1), yO = rg.h + 14;
  instances.push(
    { name: 'st', def: REG, at: [xR, 2], label: 'state' },
    { name: 'one', def: TIE1, at: [xR - 8, 2 + rg.ports.en.pos[1] - 1] },
    { name: 'dec', def: DEC, at: [xD, 2], label: 'one wire per state' },
    { name: 'opd', def: OPD, at: [xO, yO] },
  );
  nets.push({ ends: ['one.y', 'st.en'] }, { name: 'state', ends: ['st.q', 'dec.a', 'state'], tags: ['state'] }, { name: 'op', ends: ['op', 'opd.op'] }, { name: 'clk', ends: ['clk', 'st.clk'] });
  const S = (i: number) => `dec.y${i}`;
  // transitions: [source state, condition (class output) or null, target]
  const trans: [number, string | null, number][] = [];
  MC_STATES.forEach((s, i) => {
    if (typeof s.next === 'number') { if (s.next !== 0) trans.push([i, null, s.next]); }
    else for (const [cls, t] of s.next === 'decode' ? MC_DISPATCH : MC_DISPATCH2) trans.push([i, `opd.${cls}`, t]);
  });
  const xT = Math.ceil(xD + dg.w + stateTag + Math.max(stateTag, condTag) + 1);
  let yT = 2, nT = 0;
  const termOf = trans.map(([s, cond], k) => {
    if (!cond) return S(s);
    const nm = `t${k}`;
    instances.push({ name: nm, def: AND, at: [xT, yT] });
    yT += 5;
    nT = Math.max(nT, nm.length);
    sink(S(s), `${nm}.a`);
    sink(cond, `${nm}.b`);
    return `${nm}.y`;
  });
  const xN = Math.ceil(xT + 4 + tagLen('t'.repeat(nT)) + stateTag + 1);
  // The next-state ORs stacked; n0 wired straight into the merger, the others by tag.
  let yN = 2, yNx = 0;
  for (let b = 0; b < 4; b++) {
    const terms = trans.map((t, k) => ((t[2] >> b) & 1 ? termOf[k] : null)).filter((x): x is string => !!x);
    const nm = `n${b}`;
    if (terms.length === 1) sink(terms[0], `nx.i${b}`);
    else {
      const d = orN(terms.length), h = symbolGeom(d).h;
      instances.push({ name: nm, def: d, at: [xN, yN] });
      if (b === 0) yNx = yN + h / 2 - 1;
      yN += h + 2;
      terms.forEach((t, i) => sink(t, `${nm}.i${i}`));
      nets.push({ name: `next${b}`, ends: [`${nm}.y`, `nx.i${b}`], tags: b === 0 ? undefined : true });
    }
  }
  instances.push({ name: 'nx', def: merger([1, 1, 1, 1]), at: [xN + 10, yNx] });
  nets.push({ name: 'next', ends: ['nx.out', 'st.d'], tags: true });
  // outputs: per field bit, the OR of the states asserting it. Each output's pin sits on its
  // driver's row so the wire is straight; a field's bits are spaced to match its merger's pitch.
  const xC = Math.ceil(xN + 11 + tagLen('next') + stateTag + 1), xP = xC + 20;
  // floor: bottom of the last field's merger. A tall merger (wide pitch) reaches below its
  // field's gates, so the next field starts below it: neither its merger nor its pin wire may cross it.
  let yC = 2, ties = 0, floor = -Infinity;
  const pins: Record<string, [number, number]> = { clk: [0, rg.h + 4], op: [0, yO + og.ports.op.pos[1]] };
  MC_FIELDS.forEach(([f, n]) => {
    const bits = Array.from({ length: n }, (_, b) => MC_STATES.map((s, i) => (((s.sig[f] ?? 0) >> b) & 1 ? i : -1)).filter((i) => i >= 0));
    const defOf = (states: number[]) => (states.length < 2 ? null : states.length === 2 ? OR : orN(states.length));
    const hOf = (states: number[]) => { const d = defOf(states); return d ? symbolGeom(d).h : 2; };
    const hs = bits.map(hOf);
    let pitch = 2;
    for (let b = 1; b < n; b++) pitch = Math.max(pitch, 2 * Math.ceil((hs[b - 1] / 2 + hs[b] / 2 + 2) / 2));
    const y0 = Math.max(yC + hs[0] / 2, floor + 2 + (n > 1 ? pitch / 2 : 0));
    const bitsDrv = bits.map((states, b) => {
      const yo = y0 + pitch * b, d = defOf(states);
      yC = yo + hs[b] / 2 + 2;
      if (states.length === 0) {
        instances.push({ name: `z${ties}`, def: TIE0, at: [xC, yo - 1] });
        return `z${ties++}.y`;
      }
      if (!d) return S(states[0]);
      const nm = `o_${f}${b}`;
      instances.push({ name: nm, def: d, at: [xC, yo - hs[b] / 2], label: n > 1 ? `${f}[${b}]` : f });
      const ins = d.ports.filter((p) => p.dir === 'in').map((p) => p.name);
      states.forEach((s, i) => sink(S(s), `${nm}.${ins[i]}`));
      return `${nm}.y`;
    });
    if (n === 1) { sink(bitsDrv[0], f); pins[f] = [xP, y0]; }
    else {
      instances.push({ name: `m_${f}`, def: merger(Array(n).fill(1), pitch), at: [xC + 12, y0 - pitch / 2] });
      bitsDrv.forEach((d, b) => sink(d, `m_${f}.i${b}`));
      nets.push({ name: f, ends: [`m_${f}.out`, f] });
      pins[f] = [xP, y0 + (pitch * (n - 1)) / 2];
      floor = y0 - pitch / 2 + pitch * n;
    }
  });
  pins.state = [xP, yC + 1];
  const cls = new Map(MC_DISPATCH.map(([c]) => [`opd.${c}`, `is${c}`]));
  for (const [drv, ss] of ends) {
    const si = /^dec\.y(\d+)$/.exec(drv), gate = /^(o_\w+|t\d+|z\d+)\.y$/.exec(drv);
    const name = si ? MC_STATES[Number(si[1])]?.name ?? `S${si[1]}` : cls.get(drv) ?? (gate ? instances.find((i) => i.name === gate[1])?.label ?? gate[1] : undefined);
    // State and condition wires fan out across the sheet by tag; an output OR is wired to its pin.
    nets.push({ name, ends: [drv, ...ss], tags: /^(o_|z)/.test(drv) ? undefined : true });
  }
  return define({
    id: 'mc_fsm', name: 'Hardwired multicycle controller', category: 'cpu',
    summary: `A finite-state machine: ${MC_STATES.length} states in a 4-bit register, a decoder giving one wire per state, AND gates for the opcode-dependent transitions, and OR gates for the next state and for every control signal.`,
    ports: ctrlPorts(),
    symbol: { kind: 'box', label: 'FSM CONTROL' },
    netlist: () => ({ pins, instances, nets }),
    hdl: { verilog: fsmVerilog() },
  });
})();

// ---- microprogrammed controller ------------------------------------------------------------------------

/**
 * Microprogrammed controller: the same state table stored as data. A micro-PC addresses a ROM of
 * microwords; each word holds the control signals for this cycle plus how to find the next word:
 * a next-address field, or a dispatch through a table indexed by the opcode.
 */
export const MC_MICRO: ComponentDef = (() => {
  const UROM = rom(MC_STATES.map(microword), 4, 'Microcode ROM');
  const D1 = rom(Array.from({ length: 32 }, (_, op) => MC_DISPATCH.find(([c]) => OPCODES5[c] === op)?.[1] ?? 0), 5, 'Dispatch ROM 1');
  const D2 = rom([MC_DISPATCH2[0][1], MC_DISPATCH2[1][1]], 1, 'Dispatch ROM 2');
  const REG = register(4), MX = muxTree(2, 4);
  const ug = symbolGeom(UROM), rg = symbolGeom(REG), mg = symbolGeom(MX);
  const widths = [...MC_FIELDS.map(([, n]) => n), 4, 2, 32 - CTRL_BITS - 6];
  const SW = splitter(widths, 3);
  const xU = 32, xS = xU + ug.w + 8;
  const instances: InstanceDef[] = [
    { name: 'mx', def: MX, at: [2, 20], label: 'sequencer' },
    { name: 'upc', def: REG, at: [10, 18], label: 'µPC' },
    { name: 'one', def: TIE1, at: [6, 18 + rg.ports.en.pos[1] - 1] },
    { name: 'ua', def: merger([2, 4, 26]), at: [24, 20] },
    { name: 'urom', def: UROM, at: [xU, 14], label: 'microcode ROM' },
    { name: 'sw', def: SW, at: [xS, 4] },
    { name: 'op', def: splitter([2, 3, 1, 1]), at: [4, 60] },
    { name: 'opx', def: merger([3, 1, 1]), at: [10, 60] },
    { name: 'd1a', def: merger([2, 5, 25]), at: [14, 58] },
    { name: 'd2a', def: merger([2, 1, 29]), at: [14, 70] },
    { name: 'd1', def: D1, at: [xU, 52], label: 'decode dispatch' },
    { name: 'd2', def: D2, at: [xU, 74], label: 'memory dispatch' },
    { name: 'd1s', def: splitter([4, 28]), at: [xS, 56] },
    { name: 'd2s', def: splitter([4, 28]), at: [xS, 78] },
    { name: 'z2', def: constWord(2, 0), at: [18, 28] }, { name: 'z26', def: constWord(26, 0), at: [18, 32] },
    { name: 'z25', def: constWord(25, 0), at: [6, 66] }, { name: 'z29', def: constWord(29, 0), at: [6, 76] },
    { name: 'z4', def: constWord(4, 0), at: [-6, 30] },
  ];
  void mg;
  const nets: NetDef[] = [
    { name: 'clk', ends: ['clk', 'upc.clk'] }, { ends: ['one.y', 'upc.en'] },
    { name: 'µPC', ends: ['upc.q', 'ua.i1', 'state'], tags: ['state'] },
    { ends: ['z2.y', 'ua.i0', 'd1a.i0', 'd2a.i0'], tags: true }, { ends: ['z26.y', 'ua.i2'] },
    { name: 'µaddr', ends: ['ua.out', 'urom.addr'] },
    { name: 'microword', ends: ['urom.data', 'sw.in'] },
    { name: 'op', ends: ['op', 'op.in'] },
    { name: 'op[4:2]', ends: ['op.o1', 'opx.i0'] }, { name: 'op[5]', ends: ['op.o2', 'opx.i1', 'd2a.i1'], tags: ['d2a.i1'] }, { name: 'op[6]', ends: ['op.o3', 'opx.i2'] },
    { name: 'op[6:2]', ends: ['opx.out', 'd1a.i1'] },
    { ends: ['z25.y', 'd1a.i2'] }, { ends: ['z29.y', 'd2a.i2'] },
    { name: 'd1addr', ends: ['d1a.out', 'd1.addr'] }, { name: 'd2addr', ends: ['d2a.out', 'd2.addr'] },
    { name: 'd1word', ends: ['d1.data', 'd1s.in'] }, { name: 'd2word', ends: ['d2.data', 'd2s.in'] },
    { name: 'dispatch1', ends: ['d1s.o0', 'mx.d1'], tags: true }, { name: 'dispatch2', ends: ['d2s.o0', 'mx.d2'], tags: true },
    { ends: ['z4.y', 'mx.d3'] },
    { name: 'µnext', ends: ['mx.y', 'upc.d'] },
  ];
  const nf = MC_FIELDS.length;
  MC_FIELDS.forEach(([f], i) => nets.push({ name: f, ends: [`sw.o${i}`, f], tags: true }));
  nets.push({ name: 'nextAddr', ends: [`sw.o${nf}`, 'mx.d0'], tags: true }, { name: 'seq', ends: [`sw.o${nf + 1}`, 'mx.s'], tags: true });
  const pins: Record<string, [number, number]> = { clk: [0, 40], op: [0, 60] };
  MC_FIELDS.forEach(([f], i) => (pins[f] = [xS + 24, 2 + 4 * i]));
  pins.state = [xS + 24, 2 + 4 * nf];
  return define({
    id: 'mc_micro', name: 'Microprogrammed multicycle controller', category: 'cpu',
    summary: `The same ${MC_STATES.length}-state machine stored as data: a micro-PC, a ROM of ${CTRL_BITS + 6}-bit microwords (control signals, next address, sequencing mode) and two dispatch ROMs indexed by the opcode. Changing the instruction set means changing the ROM contents, not the wiring.`,
    ports: ctrlPorts(),
    symbol: { kind: 'box', label: 'µCODE CONTROL' },
    netlist: () => ({ pins, instances, nets }),
  });
})();

function fsmVerilog(): string {
  const lines = MC_STATES.map((s, i) => {
    const sig = Object.entries(s.sig).filter(([, v]) => v).map(([k, v]) => `${k} = ${v};`).join(' ');
    const nx = typeof s.next === 'number' ? `next = ${MC_STATES[s.next].name.toUpperCase()};`
      : s.next === 'decode' ? 'case (op[6:2]) /* dispatch */ … endcase'
        : 'next = op[5] ? MEMWRITE : MEMREAD;';
    return `    ${String(i).padStart(2)}: begin ${sig} ${nx} end   // ${s.name}`;
  });
  return `module mc_control (input logic clk, input logic [6:0] op, output logic pcUpdate, branch, irWrite, regWrite,
                   memWrite, adrSrc, aluFunct, retire, output logic [1:0] resultSrc, aluSrcA, aluSrcB);
  logic [3:0] state, next;
  always_ff @(posedge clk) state <= next;
  always_comb begin
    {pcUpdate, branch, irWrite, regWrite, memWrite, adrSrc, resultSrc, aluSrcA, aluSrcB, aluFunct, retire} = '0;
    next = 4'd0;
    case (state)
${lines.join('\n')}
    endcase
  end
endmodule`;
}

// ---- the multicycle processor ---------------------------------------------------------------------------

export interface MulticycleOptions {
  control?: 'fsm' | 'micro';
  adder?: 'rca' | 'ks';
  /** Instruction ROM of 2^imemK words (default 6), data memory of 2^dmemK (default 5). */
  imemK?: number;
  dmemK?: number;
}

export function multicycleCpu(program: number[], opts: MulticycleOptions = {}): ComponentDef {
  const IM = rom(program, opts.imemK ?? 6);
  const control = opts.control ?? 'fsm', adder = opts.adder ?? 'ks', dmemK = opts.dmemK ?? 5;
  return memo(`mc_${IM.id}_${control}_${adder}_${dmemK}`, () => buildMulticycle(IM, control, adder, dmemK));
}

function buildMulticycle(IM: ComponentDef, control: 'fsm' | 'micro', adder: 'rca' | 'ks', dmemK: number): ComponentDef {
  const R32 = register(32), RF = regfile(5, 32), ALU = alu(32, adder), DM = dataMemory(dmemK);
  const M2 = busMux2(32), M4 = muxTree(2, 32), CTRL = control === 'fsm' ? MC_FSM : MC_MICRO;
  const SI = splitter([7, 5, 3, 5, 5, 7]);
  const g = (d: ComponentDef) => symbolGeom(d);
  const at = new Map<string, [number, number]>();
  const defs = new Map<string, ComponentDef>();
  const place = (name: string, def: ComponentDef, xy: [number, number]) => { at.set(name, xy); defs.set(name, def); };
  const P = (inst: string, port: string): [number, number] => {
    const a = at.get(inst)!, p = g(defs.get(inst)!).ports[port].pos;
    return [a[0] + p[0], a[1] + p[1]];
  };
  const alignY = (inst: string, def: ComponentDef, x: number, port: string, y: number) => place(inst, def, [x, y - g(def).ports[port].pos[1]]);
  const right = (inst: string) => at.get(inst)![0] + g(defs.get(inst)!).w;

  const Y = 60;
  alignY('pc', R32, 12, 'q', Y);
  alignY('adr', M2, right('pc') + 8, 'a', Y);
  alignY('imem', IM, right('adr') + 10, 'addr', P('adr', 'y')[1]);
  alignY('dm', DM, right('adr') + 10, 'addr', P('adr', 'y')[1] + 26);
  alignY('memsel', M2, right('imem') + 10, 'a', P('imem', 'data')[1]);
  alignY('ir', R32, right('memsel') + 10, 'd', P('memsel', 'y')[1] - 24);
  alignY('data', R32, right('memsel') + 10, 'd', P('memsel', 'y')[1] + 24);
  alignY('oldpc', R32, right('memsel') + 10, 'd', P('ir', 'd')[1] - 26);
  alignY('si', SI, right('ir') + 8, 'in', P('ir', 'q')[1]);
  alignY('rf', RF, right('si') + 16, 'wa', P('si', 'o1')[1]);
  alignY('imm', IMM_GEN, right('si') + 10, 'instr', P('rf', 'rd2')[1] + 22);
  alignY('ra', R32, right('rf') + 8, 'd', P('rf', 'rd1')[1]);
  alignY('rb', R32, right('rf') + 8, 'd', P('rf', 'rd2')[1] + 8);
  // 16 units after A / B: the constant inputs of the source multiplexers sit in between
  alignY('srcA', M4, right('ra') + 16, 'd2', P('ra', 'q')[1]);
  alignY('srcB', M4, right('ra') + 16, 'd0', P('rb', 'q')[1] + 6);
  alignY('alu', ALU, right('srcA') + 10, 'a', P('srcA', 'y')[1]);
  alignY('aluout', R32, right('alu') + 10, 'd', P('alu', 'y')[1]);
  alignY('res', M4, right('aluout') + 10, 'd0', P('aluout', 'q')[1]);
  alignY('clr0', CLEAR_BIT0, 2, 'out', P('pc', 'd')[1]);
  place('gndJ', TIE0, [P('clr0', 'zero')[0] - 6, P('clr0', 'zero')[1] + 1]);
  place('c4', constWord(32, 4), [P('srcB', 'd2')[0] - 14, P('srcB', 'd2')[1] - 1]);
  place('z32', constWord(32, 0), [P('srcA', 'd3')[0] - 14, P('srcA', 'd3')[1] - 1]);
  place('z32b', constWord(32, 0), [P('srcB', 'd3')[0] - 14, P('srcB', 'd3')[1] + 2]);
  place('actl', busMux2(4), [P('alu', 'ctl')[0] - 10, at.get('alu')![1] + g(ALU).h + 20]);
  place('z4', constWord(4, 0), [P('actl', 'a')[0] - 14, P('actl', 'a')[1] - 1]);
  place('ctl', CONTROL, [right('si') + 10, 2]);
  place('npc', NEXT_PC, [right('alu') + 6, 2]);
  place('ctrl', CTRL, [12, 2]);
  place('one', TIE1, [right('ra') + 2, P('ra', 'en')[1] + 6]);
  place('gnd', TIE0, [P('npc', 'jump')[0] - 6, P('npc', 'jump')[1] + 4]);
  place('ps', splitter([1, 1]), [right('npc') + 4, P('npc', 'pcSrc')[1] - 2]);
  place('pcw', OR, [4, P('pc', 'en')[1] + 4]);
  place('fz', isZero(4), [right('ctrl') + 14, 2 + g(CTRL).h - 8]);

  const labels: Record<string, string> = {
    pc: 'PC', adr: 'Adr', memsel: 'one memory port', ir: 'IR', data: 'Data', oldpc: 'OldPC', ra: 'A', rb: 'B', srcA: 'SrcA', srcB: 'SrcB',
    aluout: 'ALUOut', res: 'Result', ctrl: control === 'fsm' ? 'hardwired FSM' : 'microcode', ctl: 'decoder (immSrc, ALU op)', actl: 'add / funct',
  };
  const instances: InstanceDef[] = [...at.keys()].map((name) => ({ name, def: defs.get(name)!, at: at.get(name), label: labels[name] }));
  const cf = (f: string) => `ctrl.${f}`;
  const nets: NetDef[] = [
    { name: 'PCNext', ends: ['clr0.out', 'pc.d'] },
    { name: 'gndJ', ends: ['gndJ.y', 'clr0.zero'] },
    { name: 'PC', ends: ['pc.q', 'adr.a', 'oldpc.d', 'srcA.d0', 'pcOut'], tags: ['oldpc.d', 'srcA.d0', 'pcOut'] },
    { name: 'Adr', ends: ['adr.y', 'imem.addr', 'dm.addr'] },
    { name: 'Instr', ends: ['imem.data', 'memsel.a'] },
    { name: 'MemData', ends: ['dm.rd', 'memsel.b'] },
    { name: 'ReadData', ends: ['memsel.y', 'ir.d', 'data.d'] },
    { name: 'IR', ends: ['ir.q', 'si.in', 'imm.instr'] },
    { name: 'OldPC', ends: ['oldpc.q', 'srcA.d1'], tags: true },
    { name: 'Data', ends: ['data.q', 'res.d1'], tags: true },
    { name: 'op', ends: ['si.o0', 'ctl.op', 'ctrl.op'], tags: true },
    { name: 'rd', ends: ['si.o1', 'rf.wa'] },
    { name: 'funct3', ends: ['si.o2', 'ctl.funct3', 'npc.funct3'], tags: true },
    { name: 'rs1', ends: ['si.o3', 'rf.ra1'] },
    { name: 'rs2', ends: ['si.o4', 'rf.ra2'] },
    { name: 'funct7', ends: ['si.o5', 'ctl.funct7'], tags: true },
    { name: 'rd1', ends: ['rf.rd1', 'ra.d'] },
    { name: 'rd2', ends: ['rf.rd2', 'rb.d'] },
    { name: 'A', ends: ['ra.q', 'srcA.d2'] },
    { name: 'B', ends: ['rb.q', 'srcB.d0', 'dm.wd'], tags: ['dm.wd'] },
    { name: 'ImmExt', ends: ['imm.imm', 'srcB.d1', 'res.d3'], tags: true },
    { name: 'four', ends: ['c4.y', 'srcB.d2'] },
    { name: 'zeroA', ends: ['z32.y', 'srcA.d3'] }, { name: 'zeroB', ends: ['z32b.y', 'srcB.d3'] },
    { name: 'SrcA', ends: ['srcA.y', 'alu.a'] }, { name: 'SrcB', ends: ['srcB.y', 'alu.b'] },
    { name: 'ALUResult', ends: ['alu.y', 'aluout.d', 'res.d2'], tags: ['res.d2'] },
    { name: 'ALUOut', ends: ['aluout.q', 'res.d0', 'adr.b'], tags: ['adr.b'] },
    { name: 'Result', ends: ['res.y', 'clr0.in', 'rf.wd'], tags: true },
    { name: 'en', ends: ['one.y', 'ra.en', 'rb.en', 'aluout.en', 'data.en'], tags: true },
    { name: 'clk', ends: ['clk', 'pc.clk', 'oldpc.clk', 'ir.clk', 'data.clk', 'dm.clk', 'rf.clk', 'ra.clk', 'rb.clk', 'aluout.clk', 'ctrl.clk'], tags: true },
    // control
    { name: 'ImmSrc', ends: ['ctl.immSrc', 'imm.src'], tags: true },
    { name: 'instrOp', ends: ['ctl.aluCtl', 'actl.b'], tags: true },
    { name: 'add', ends: ['z4.y', 'actl.a'] },
    { name: 'ALUControl', ends: ['actl.y', 'alu.ctl'], tags: true },
    { name: 'ALUFunct', ends: [cf('aluFunct'), 'actl.s'], tags: true },
    { name: 'ALUSrcA', ends: [cf('aluSrcA'), 'srcA.s'], tags: true },
    { name: 'ALUSrcB', ends: [cf('aluSrcB'), 'srcB.s'], tags: true },
    { name: 'ResultSrc', ends: [cf('resultSrc'), 'res.s'], tags: true },
    { name: 'AdrSrc', ends: [cf('adrSrc'), 'adr.s', 'memsel.s'], tags: true },
    { name: 'IRWrite', ends: [cf('irWrite'), 'ir.en', 'oldpc.en'], tags: true },
    { name: 'RegWrite', ends: [cf('regWrite'), 'rf.we'], tags: true },
    { name: 'MemWrite', ends: [cf('memWrite'), 'dm.we'], tags: true },
    { name: 'Branch', ends: [cf('branch'), 'npc.branch'], tags: true },
    { name: 'PCUpdate', ends: [cf('pcUpdate'), 'pcw.a'], tags: true },
    { name: 'gnd', ends: ['gnd.y', 'npc.jump', 'npc.jalr'], tags: true },
    { name: 'Zero', ends: ['alu.zero', 'npc.zero'], tags: true }, { name: 'Neg', ends: ['alu.neg', 'npc.neg'], tags: true },
    { name: 'Ovf', ends: ['alu.ovf', 'npc.ovf'], tags: true }, { name: 'Carry', ends: ['alu.carry', 'npc.carry'], tags: true },
    { name: 'PCSrc', ends: ['npc.pcSrc', 'ps.in'] },
    { name: 'taken', ends: ['ps.o0', 'pcw.b'], tags: true },
    { name: 'PCWrite', ends: ['pcw.y', 'pc.en'], tags: true },
    { name: 'retire', ends: [cf('retire'), 'retire'], tags: true },
    { name: 'state', ends: [cf('state'), 'fz.a', 'state'], tags: true },
    { name: 'fetch', ends: ['fz.z', 'fetch'], tags: true },
  ];
  const resY = P('res', 'y');
  return {
    id: `mc_${IM.id.replace(/^rom_/, '')}_${control}${adder === 'ks' ? '' : '_rca'}${dmemK === 5 ? '' : `_d${dmemK}`}`,
    name: `Multicycle RV32I CPU (${control === 'fsm' ? 'hardwired' : 'microprogrammed'} control)`, category: 'cpu',
    summary: 'One ALU and one memory port, reused over 3 to 5 short cycles per instruction. IR, OldPC, A, B, Data and ALUOut hold values from one cycle to the next; the controller steps through the state table.',
    ports: [bit('clk', 'in', 'left', true), bus('pcOut', 32, 'out'), bit('retire', 'out'), bit('fetch', 'out'), bus('state', 4, 'out')],
    symbol: { kind: 'box', label: 'RV32I MULTICYCLE' },
    netlist: () => ({
      pins: { clk: [0, Y + 40], pcOut: [resY[0] + 16, resY[1] + 10], retire: [resY[0] + 16, resY[1] + 14], fetch: [resY[0] + 16, resY[1] + 18], state: [resY[0] + 16, resY[1] + 22] },
      instances, nets,
    }),
  };
}
