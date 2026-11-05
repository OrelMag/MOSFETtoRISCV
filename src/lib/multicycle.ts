// Level 8b: the multicycle processor (Harris & Harris §7.4, RISC-V edition). One ALU and one memory
// port are reused across 3–5 short cycles per instruction; registers (IR, OldPC, A, B, Data, ALUOut)
// carry values between cycles. The sequencing lives in a controller, built two ways from the same
// state table: a hardwired finite-state machine and a microprogrammed one.

import { orientGeom, symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, Netlist, PortDef } from '../sim/types';
import { alu, constWord, isZero } from './alu';
import { busMux2, decoder, muxTree } from './combinational';
import { CLEAR_BIT0, CONTROL, IMM_GEN, NEXT_PC, OPCODE_DECODER, dataMemory, rom } from './cpu';
import { define, merger, splitter } from './define';
import type { FsmArc, FsmSpec } from './fsm';
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

/** The state table as data: what a microcode ROM and its two dispatch ROMs hold (the microcode painter edits this). */
export interface Microprogram {
  states: McState[];
  /** Decode dispatch: opcode class → word. */
  dispatch: [string, number][];
  /** Memory dispatch: LOAD, STORE → word. */
  dispatch2: [string, number][];
}

/** Decode dispatch: opcode class → state. AUIPC needs no execute cycle: Decode already computed OldPC + imm. */
export const MC_DISPATCH: [string, number][] = [['LOAD', 2], ['STORE', 2], ['R', 6], ['I', 8], ['JAL', 9], ['BRANCH', 10], ['JALR', 11], ['LUI', 12], ['AUIPC', 7]];
const OPCODES5: Record<string, number> = { R: 0b01100, I: 0b00100, LOAD: 0b00000, STORE: 0b01000, BRANCH: 0b11000, JAL: 0b11011, JALR: 0b11001, LUI: 0b01101, AUIPC: 0b00101 };
/** Memory dispatch: load → MemRead, store → MemWrite. */
export const MC_DISPATCH2: [string, number][] = [['LOAD', 3], ['STORE', 5]];

/** The book's microprogram. */
export const MC_PROGRAM: Microprogram = { states: MC_STATES, dispatch: MC_DISPATCH, dispatch2: MC_DISPATCH2 };

/** The opcode class of a 7-bit opcode (the dispatch tables' names), or null. */
export function mcOpClass(op: number): string | null {
  const o5 = (op >> 2) & 31;
  return Object.keys(OPCODES5).find((c) => OPCODES5[c] === o5) ?? null;
}

/**
 * The hardwired controller's transitions: [source, opcode class or null, target], returns to Fetch left out
 * (state 0 is the code no next-state OR drives). Transition k with a class is AND gate t<k> of MC_FSM.
 */
export function mcTransitions(): [number, string | null, number][] {
  const trans: [number, string | null, number][] = [];
  MC_STATES.forEach((s, i) => {
    if (typeof s.next === 'number') { if (s.next !== 0) trans.push([i, null, s.next]); }
    else for (const [cls, t] of s.next === 'decode' ? MC_DISPATCH : MC_DISPATCH2) trans.push([i, cls, t]);
  });
  return trans;
}

/** Diagram positions (units of the 770 × 400 drawing) and the short labels of the dispatch arcs. */
const MC_AT: Record<string, [number, number]> = {
  Fetch: [340, 30], Decode: [340, 92], MemAdr: [56, 168], ExecuteR: [150, 168], ExecuteI: [246, 168], JAL: [440, 168], JALR: [530, 168],
  Branch: [620, 168], LUI: [706, 168], MemRead: [56, 248], MemWrite: [150, 248], MemWB: [56, 328], ALUWB: [340, 328],
};
const MC_ARC: Record<string, Partial<FsmArc>> = {
  'Decode>MemAdr': { label: 'lw/sw', t: 0.62, bend: 18 }, 'Decode>ExecuteR': { label: 'R', t: 0.7, bend: 10 }, 'Decode>ExecuteI': { label: 'I', t: 0.72 },
  'Decode>JAL': { label: 'jal', t: 0.72 }, 'Decode>JALR': { label: 'jalr', t: 0.72, bend: -8 }, 'Decode>Branch': { label: 'branch', t: 0.7, bend: -14 },
  'Decode>LUI': { label: 'lui', t: 0.74, bend: -20 }, 'Decode>ALUWB': { label: 'auipc' },
  'MemAdr>MemRead': { label: 'lw', dx: -14 }, 'MemAdr>MemWrite': { label: 'sw', dx: 10, dy: -6 },
};

/**
 * The multicycle controller as a state machine, from MC_STATES and the dispatch tables: what both controllers
 * (hardwired and microcode) implement. Arc parts are MC_FSM's AND gate for the transition and the
 * next-state ORs its target's bits feed.
 */
export const MC_FSM_SPEC: FsmSpec = (() => {
  const trans = mcTransitions();
  const ors = [0, 1, 2, 3].filter((b) => trans.filter((t) => (t[2] >> b) & 1).length > 1);
  const arcs: FsmArc[] = [];
  const add = (from: number, to: number, classes: string[] | null) => {
    const name = `${MC_STATES[from].name}>${MC_STATES[to].name}`;
    const ks = trans.flatMap(([s, c, t], k) => (s === from && t === to && c ? [k] : []));
    arcs.push({
      from, to, ...MC_ARC[name],
      when: classes ? (inp) => classes.includes(mcOpClass(inp.op) ?? '') : undefined,
      parts: [...ks.map((k) => `t${k}`), ...ors.filter((b) => (to >> b) & 1).map((b) => `n${b}`)],
      rail: to === 0 || undefined,
    });
  };
  MC_STATES.forEach((s, i) => {
    if (typeof s.next === 'number') return add(i, s.next, null);
    const table = s.next === 'decode' ? MC_DISPATCH : MC_DISPATCH2;
    for (const t of [...new Set(table.map(([, t]) => t))]) add(i, t, table.filter(([, x]) => x === t).map(([c]) => c));
  });
  const fields = MC_FIELDS.map(([f]) => f);
  return {
    title: 'Multicycle controller', shape: 'pill', size: [770, 400],
    states: MC_STATES.map((s, i) => ({
      name: s.name, code: i, does: s.does, at: MC_AT[s.name],
      out: { ...Object.fromEntries(fields.map((f) => [f, s.sig[f] ?? 0])), state: i },
    })),
    arcs, reset: 0, inputs: ['op'], domain: { op: Object.values(OPCODES5).map((o) => (o << 2) | 3) },
    outputs: [...fields, 'state'], stateBits: ['state'], codeBits: 4,
    rail: { to: 0, x: 752, y: 372, label: 'retire → Fetch', labelX: 600 },
  };
})();

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
  const stateTag = longest(MC_STATES.map((s) => s.name));
  // The opcode decoder sits below the state decoder: both feed the AND column, whose rows start level with Decode's wire.
  const xR = 8, xD = 26, xO = xD, yO = 2 + dg.h + 3;
  instances.push(
    { name: 'st', def: REG, at: [xR, 2], label: 'state' },
    { name: 'one', def: TIE1, at: [xR - 8, 2 + rg.ports.en.pos[1] - 1] },
    { name: 'dec', def: DEC, at: [xD, 2], label: 'one wire per state' },
    { name: 'opd', def: OPD, at: [xO, yO] },
  );
  nets.push({ ends: ['one.y', 'st.en'] }, { name: 'state', ends: ['st.q', 'dec.a', 'state'], tags: ['state'] }, { name: 'op', ends: ['op', 'opd.op'] }, { name: 'clk', ends: ['clk', 'st.clk'] });
  const S = (i: number) => `dec.y${i}`;
  const trans = mcTransitions().map(([s, cls, t]): [number, string | null, number] => [s, cls && `opd.${cls}`, t]);
  const xT = xD + dg.w + 16;
  let yT = 6, nT = 0;
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
  const xN = xT + 4 + 22;
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
  // ---- drawn with wires: the state register's loop over the top, the opcode classes into the AND column, the AND column
  // into the next-state ORs, the output ORs to their pins. Only the state wires that fan out to the next-state and output
  // ORs stay pointers (their AND-column ends are wired: one trunk per state).
  const inst = (n: string) => instances.find((i) => i.name === n)!;
  const pos = (n: string, port: string): [number, number] => {
    const i = inst(n), p = symbolGeom(i.def).ports[port].pos;
    return [i.at![0] + p[0], i.at![1] + p[1]];
  };
  const byName = (n: string) => nets.find((x) => x.name === n)!;
  const via = (n: string, end: string, pts: [number, number][]) => { const x = byName(n); x.via = { ...x.via, [end]: pts }; };
  const wired = (n: string) => { delete byName(n).tags; };
  const [qx, qy] = pos('st', 'q'), day = pos('dec', 'a')[1];
  wired('state');
  via('state', 'dec.a', [[qx + 3, qy], [qx + 3, day]]);
  via('state', 'state', [[qx + 3, qy]]);
  pins.state = [qx + 3, -3];
  via('clk', 'st.clk', [[pos('st', 'clk')[0], pins.clk[1]]]);
  const [nox, noy] = pos('nx', 'out');
  wired('next');
  via('next', 'st.d', [[nox + 3, noy], [nox + 3, -6], [xR - 4, -6], [xR - 4, pos('st', 'd')[1]]]);
  for (let b = 1; b < 4; b++) wired(`next${b}`);
  // opcode classes: a lane each, nested, between the opcode decoder and the AND trunks
  const lane0 = xD + dg.w + 1;
  MC_DISPATCH.forEach(([c], i) => {
    const name = `is${c}`;
    wired(name);
    const n = byName(name), [sx, sy] = pos('opd', c);
    const order = ['R', 'I', 'LOAD', 'STORE', 'BRANCH', 'JAL', 'JALR', 'LUI', 'AUIPC'].indexOf(c);
    for (const e of n.ends.slice(1)) {
      const [ex, ey] = pos(e.split('.')[0], e.split('.')[1]);
      void ex;
      n.via = { ...n.via, [e]: [[lane0 + order * 0.5, sy], [lane0 + order * 0.5, ey]] };
    }
    void sx; void i;
  });
  // state wires into the AND column: Decode's trunk, then MemAdr's to the two rows at the bottom
  const trunk = (name: string, x: number) => {
    const n = byName(name), [, sy] = pos('dec', 'y' + MC_STATES.findIndex((s) => s.name === name));
    const ands = n.ends.filter((e) => /^t\d+\.a$/.test(e));
    n.tags = n.ends.filter((e) => !/^t\d+\.a$/.test(e));
    ands.forEach((e, k) => { const [, ey] = pos(e.split('.')[0], 'a'); if (k > 0 || ey !== sy) n.via = { ...n.via, [e]: [[x, sy], [x, ey]] }; });
  };
  trunk('Decode', xD + dg.w + 8);
  trunk('MemAdr', xD + dg.w + 6);
  // the AND terms into the next-state ORs: one lane each between the columns, ordered by a small search for the fewest crossings
  const terms = nets.filter((n) => /^t[0-9]+$/.test(n.name ?? ''));
  for (const n of terms) delete n.tags;
  const tpath = (n: NetDef, x: number) => {
    const [x0, y0] = pos(n.ends[0].split('.')[0], 'y');
    return n.ends.slice(1).map((e) => { const [ex, ey] = pos(e.split('.')[0], e.split('.')[1]); return [[x0, y0], [x, y0], [x, ey], [ex, ey]] as [number, number][]; });
  };
  const crossings = (lanes: number[]) => {
    const segs = terms.flatMap((n, i) => tpath(n, lanes[i]).flatMap((p) => p.slice(1).map((b, j) => ({ n: i, a: p[j], b }))));
    let c = 0;
    for (const u of segs) for (const v of segs) {
      if (u.n === v.n || u.a[1] !== u.b[1] || v.a[0] !== v.b[0]) continue;
      const lo = Math.min(u.a[0], u.b[0]), hi = Math.max(u.a[0], u.b[0]), vlo = Math.min(v.a[1], v.b[1]), vhi = Math.max(v.a[1], v.b[1]);
      if (v.a[0] > lo && v.a[0] < hi && u.a[1] > vlo && u.a[1] < vhi) c++;
    }
    // two nets on one line is never allowed: priced far above a crossing
    for (const u of segs) for (const v of segs) {
      if (u.n >= v.n || u.a[1] !== u.b[1] || v.a[1] !== v.b[1] || u.a[1] !== v.a[1]) continue;
      if (Math.min(Math.max(u.a[0], u.b[0]), Math.max(v.a[0], v.b[0])) > Math.max(Math.min(u.a[0], u.b[0]), Math.min(v.a[0], v.b[0]))) c += 100;
    }
    return c;
  };
  const laneBase = pos('t1', 'y')[0] + 3, order = terms.map((_, i) => i);
  const xs = () => { const l = terms.map(() => 0); order.forEach((t, k) => { l[t] = laneBase + k; }); return l; };
  for (let improved = true; improved;) {
    improved = false;
    for (let i = 0; i < order.length; i++) for (let j = i + 1; j < order.length; j++) {
      const before = crossings(xs());
      [order[i], order[j]] = [order[j], order[i]];
      if (crossings(xs()) < before) improved = true; else [order[i], order[j]] = [order[j], order[i]];
    }
  }
  const laneOf = xs();
  terms.forEach((n, i) => tpath(n, laneOf[i]).forEach((p, k) => { n.via = { ...n.via, [n.ends[k + 1]]: [[laneOf[i], p[1][1]], [laneOf[i], p[2][1]]] }; }));
  const pinDirs: Netlist['pinDirs'] = { state: 'down' };
  return define({
    id: 'mc_fsm', name: 'Hardwired multicycle controller', category: 'cpu',
    summary: `A finite-state machine: ${MC_STATES.length} states in a 4-bit register, a decoder giving one wire per state, AND gates for the opcode-dependent transitions, and OR gates for the next state and for every control signal.`,
    ports: ctrlPorts(),
    symbol: { kind: 'box', label: 'FSM CONTROL' },
    netlist: () => ({ pins, pinDirs, instances, nets }),
    hdl: { verilog: fsmVerilog() },
  });
})();

// ---- microprogrammed controller ------------------------------------------------------------------------

/**
 * Microprogrammed controller: the same state table stored as data. A micro-PC addresses a ROM of
 * microwords; each word holds the control signals for this cycle plus how to find the next word:
 * a next-address field, or a dispatch through a table indexed by the opcode.
 */
function buildMicro(P: Microprogram, id: string, shared: boolean): ComponentDef {
  const UROM = rom(P.states.map(microword), 4, 'Microcode ROM');
  const D1 = rom(Array.from({ length: 32 }, (_, op) => P.dispatch.find(([c]) => OPCODES5[c] === op)?.[1] ?? 0), 5, 'Dispatch ROM 1');
  const D2 = rom([P.dispatch2.find(([c]) => c === 'LOAD')![1], P.dispatch2.find(([c]) => c === 'STORE')![1]], 1, 'Dispatch ROM 2');
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
    { name: 'z25', def: constWord(25, 0), at: [6, 53] }, { name: 'z29', def: constWord(29, 0), at: [6, 76] },
    { name: 'z4', def: constWord(4, 0), at: [-6, 30] },
  ];
  void mg;
  const nets: NetDef[] = [
    { name: 'clk', ends: ['clk', 'upc.clk'] }, { ends: ['one.y', 'upc.en'] },
    { name: 'µPC', ends: ['upc.q', 'ua.i1', 'state'], via: { state: [[20, 21], [20, 10]] } },
    { ends: ['z2.y', 'ua.i0', 'd1a.i0', 'd2a.i0'], tags: ['d1a.i0', 'd2a.i0'] }, { ends: ['z26.y', 'ua.i2'] },
    { name: 'µaddr', ends: ['ua.out', 'urom.addr'] },
    { name: 'microword', ends: ['urom.data', 'sw.in'] },
    { name: 'op', ends: ['op', 'op.in'] },
    { name: 'op[4:2]', ends: ['op.o1', 'opx.i0'] }, { name: 'op[5]', ends: ['op.o2', 'opx.i1', 'd2a.i1'], tags: ['d2a.i1'] }, { name: 'op[6]', ends: ['op.o3', 'opx.i2'] },
    { name: 'op[6:2]', ends: ['opx.out', 'd1a.i1'] },
    { ends: ['z25.y', 'd1a.i2'] }, { ends: ['z29.y', 'd2a.i2'] },
    { name: 'd1addr', ends: ['d1a.out', 'd1.addr'] }, { name: 'd2addr', ends: ['d2a.out', 'd2.addr'] },
    { name: 'd1word', ends: ['d1.data', 'd1s.in'] }, { name: 'd2word', ends: ['d2.data', 'd2s.in'] },
    // the returns to the sequencer: out of the splitters, down to rows above the dispatch ROMs, left past the sequencer, up into its pins;
    // the leftmost lane takes the lowest row, so on the left nothing crosses
    { name: 'dispatch1', ends: ['d1s.o0', 'mx.d1'], via: { 'mx.d1': [[63, 57], [63, 49], [-10, 49], [-10, 24]] } },
    { name: 'dispatch2', ends: ['d2s.o0', 'mx.d2'], via: { 'mx.d2': [[62, 79], [62, 48], [-8, 48], [-8, 26]] } },
    { ends: ['z4.y', 'mx.d3'] },
    { name: 'µnext', ends: ['mx.y', 'upc.d'], via: { 'upc.d': [[9, 25], [9, 20]] } },
  ];
  const nf = MC_FIELDS.length;
  MC_FIELDS.forEach(([f], i) => nets.push({ name: f, ends: [`sw.o${i}`, f] }));
  nets.push({ name: 'nextAddr', ends: [`sw.o${nf}`, 'mx.d0'], via: { 'mx.d0': [[64, 37.5], [64, 50], [-12, 50], [-12, 22]] } }, { name: 'seq', ends: [`sw.o${nf + 1}`, 'mx.s'], via: { 'mx.s': [[61, 40.5], [61, 47], [4, 47]] } });
  const pins: Record<string, [number, number]> = { clk: [0, 40], op: [0, 60] };
  MC_FIELDS.forEach(([f], i) => (pins[f] = [xS + 24, 2 + 4 * i]));
  pins.state = [22, 10];
  const def: ComponentDef = {
    id, name: P === MC_PROGRAM ? 'Microprogrammed multicycle controller' : 'Microprogrammed multicycle controller (edited)', category: 'cpu',
    summary: `The same ${P.states.length}-state machine stored as data: a micro-PC, a ROM of ${CTRL_BITS + 6}-bit microwords (control signals, next address, sequencing mode) and two dispatch ROMs indexed by the opcode. Changing the instruction set means changing the ROM contents, not the wiring.`,
    ports: ctrlPorts(),
    symbol: { kind: 'box', label: 'µCODE CONTROL' },
    netlist: () => ({ pins, pinDirs: { state: 'left' }, instances, nets }),
  };
  return shared ? define(def) : def;
}

export const MC_MICRO: ComponentDef = buildMicro(MC_PROGRAM, 'mc_micro', true);

/** What the three ROMs hold, as text: two microprograms with the same key build the same circuit. */
export function microKey(P: Microprogram): string {
  return `${P.states.map(microword).join(',')}|${[...P.dispatch].sort().join(';')}|${[...P.dispatch2].sort().join(';')}`;
}
const DEFAULT_KEY = microKey(MC_PROGRAM);
const microCache = new Map<string, ComponentDef>();
/** Edited controllers by definition: the sandbox turns one back into its microprogram (a part {ucode}). */
const programOf = new WeakMap<ComponentDef, Microprogram>();

/** The microprogrammed controller for a microprogram (the book's: MC_MICRO itself); memoized by content. */
export function microController(P: Microprogram): ComponentDef {
  const key = microKey(P);
  if (key === DEFAULT_KEY) return MC_MICRO;
  let d = microCache.get(key);
  if (!d) {
    let h = 5381;
    for (let i = 0; i < key.length; i++) h = (h * 33 + key.charCodeAt(i)) >>> 0;
    microCache.set(key, (d = buildMicro(P, `mc_micro_${h.toString(16)}`, false)));
    programOf.set(d, structuredClone(P));
  }
  return d;
}

/** The microprogram an edited controller was built from (undefined for the book's and for other parts). */
export const microprogramOf = (d: ComponentDef): Microprogram | undefined => programOf.get(d);

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
  /** With control 'micro': an edited microprogram (default: the book's, the same circuit as without). */
  microcode?: Microprogram;
}

export function multicycleCpu(program: number[], opts: MulticycleOptions = {}): ComponentDef {
  const IM = rom(program, opts.imemK ?? 6);
  const control = opts.control ?? 'fsm', adder = opts.adder ?? 'ks', dmemK = opts.dmemK ?? 5;
  const CT = control === 'micro' && opts.microcode ? microController(opts.microcode) : control === 'micro' ? MC_MICRO : MC_FSM;
  return memo(`mc_${IM.id}_${control}_${adder}_${dmemK}${CT.id === 'mc_micro' ? '' : `_${CT.id}`}`, () => buildMulticycle(IM, control, adder, dmemK, CT));
}

function buildMulticycle(IM: ComponentDef, control: 'fsm' | 'micro', adder: 'rca' | 'ks', dmemK: number, CT: ComponentDef): ComponentDef {
  const R32 = register(32), RF = regfile(5, 32), ALU = alu(32, adder), DM = dataMemory(dmemK);
  const M2 = busMux2(32), M4 = muxTree(2, 32), CTRL = CT;
  const SI = splitter([7, 5, 3, 5, 5, 7]);
  const g = (d: ComponentDef) => symbolGeom(d);
  const at = new Map<string, [number, number]>();
  const defs = new Map<string, ComponentDef>();
  const turn = new Map<string, 1 | 2 | 3>();
  const place = (name: string, def: ComponentDef, xy: [number, number], rot?: 1 | 2 | 3) => { at.set(name, xy); defs.set(name, def); if (rot) turn.set(name, rot); };
  const P = (inst: string, port: string): [number, number] => {
    const a = at.get(inst)!, p = orientGeom(defs.get(inst)!, undefined, turn.get(inst)).ports[port].pos;
    return [a[0] + p[0], a[1] + p[1]];
  };
  const alignY = (inst: string, def: ComponentDef, x: number, port: string, y: number) => place(inst, def, [x, y - g(def).ports[port].pos[1]]);
  const right = (inst: string) => at.get(inst)![0] + g(defs.get(inst)!).w;

  const Y = 60;
  alignY('pc', R32, 12, 'q', Y);
  alignY('adr', M2, right('pc') + 8, 'a', Y);
  alignY('imem', IM, right('adr') + 10, 'addr', P('adr', 'y')[1]);
  alignY('dm', DM, right('adr') + 10, 'addr', P('adr', 'y')[1] - 26); // above the instruction ROM: the memory's wires stay clear of the control below
  alignY('memsel', M2, right('imem') + 10, 'a', P('imem', 'data')[1]);
  alignY('ir', R32, right('memsel') + 10, 'd', P('memsel', 'y')[1] - 24);
  alignY('data', R32, right('memsel') + 10, 'd', P('memsel', 'y')[1] + 12);
  alignY('oldpc', R32, right('memsel') + 10, 'd', P('ir', 'd')[1] - 26);
  alignY('si', SI, right('ir') + 8, 'in', P('ir', 'q')[1]);
  alignY('rf', RF, right('si') + 16, 'wa', P('si', 'o1')[1]);
  alignY('imm', IMM_GEN, right('si') + 17, 'instr', P('rf', 'rd2')[1] + 22);
  alignY('ra', R32, right('rf') + 14, 'd', P('rf', 'rd1')[1]);
  alignY('rb', R32, right('rf') + 14, 'd', P('rf', 'rd2')[1] + 8);
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
  place('npc', NEXT_PC, [right('alu') + 17, 2]);
  // The controller is turned so its outputs face up, and sits below the datapath: muxes and registers take their control
  // from below. Rows of the channel between them, one per signal, leftmost port highest, so no two rows cross.
  const rowD = at.get('data')![1] + g(R32).h + 3, rowR = rowD + 1.5, ch0 = rowR + 3, cy = Math.ceil(ch0 + MC_FIELDS.length + 3);
  place('ctrl', CTRL, [-30, cy], 3);
  place('one', TIE1, [right('rf') + 7, P('ra', 'en')[1] + 2]);
  place('gnd', TIE0, [P('npc', 'jump')[0] - 6, P('npc', 'jump')[1] - 1]);
  place('ps', splitter([1, 1]), [right('npc') + 4, P('npc', 'pcSrc')[1] - 2]);
  place('pcw', OR, [4, P('pc', 'en')[1] + 4]);
  place('fz', isZero(4), [right('res') + 12, ch0 - 6]);

  const labels: Record<string, string> = {
    pc: 'PC', adr: 'Adr', memsel: 'one memory port', ir: 'IR', data: 'Data', oldpc: 'OldPC', ra: 'A', rb: 'B', srcA: 'SrcA', srcB: 'SrcB',
    aluout: 'ALUOut', res: 'Result', ctrl: control === 'fsm' ? 'hardwired FSM' : 'microcode', ctl: 'decoder (immSrc, ALU op)', actl: 'add / funct',
  };
  const instances: InstanceDef[] = [...at.keys()].map((name) => ({ name, def: defs.get(name)!, at: at.get(name), rot: turn.get(name), label: labels[name] }));
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
  // ---- drawn with wires (every net but the clock, the constant 1 and the controller's opcode) ----
  const net = (name: string) => nets.find((n) => n.name === name)!;
  const wire = (name: string, via: Record<string, [number, number][]>, tags?: string[]) => {
    const n = net(name);
    n.via = { ...n.via, ...via };
    delete n.trunk;
    if (tags) n.tags = tags; else delete n.tags;
  };
  const pt = P;
  const [pqx] = pt('pc', 'q'), lx = pqx + 4;
  const yPC = -2, yTaken = -8, yRes = -10, yAluOut = -4, yF3 = 0.5;
  const sx = at.get('srcA')![0], rx = at.get('res')![0], rr = right('res'), nx = at.get('npc')![0];
  // the PC: up along its own lane, over the top to OldPC and to SrcA, out to its pin
  wire('PC', {
    'oldpc.d': [[lx, yPC], [pt('oldpc', 'd')[0] - 4, yPC], [pt('oldpc', 'd')[0] - 4, pt('oldpc', 'd')[1]]],
    'srcA.d0': [[lx, yPC], [sx - 4, yPC], [sx - 4, pt('srcA', 'd0')[1]]],
    pcOut: [[lx, 2]],
  });
  wire('OldPC', { 'srcA.d1': [[pt('oldpc', 'q')[0] + 2, pt('oldpc', 'q')[1]], [pt('oldpc', 'q')[0] + 2, 27], [sx - 6, 27], [sx - 6, pt('srcA', 'd1')[1]]] });
  wire('Data', { 'res.d1': [[pt('data', 'q')[0] + 2, rowD], [rx - 8, rowD], [rx - 8, pt('res', 'd1')[1]]] });
  wire('ALUResult', { 'res.d2': [[pt('alu', 'y')[0] + 8, pt('alu', 'y')[1]], [pt('alu', 'y')[0] + 8, 48], [rx - 6, 48], [rx - 6, pt('res', 'd2')[1]]] });
  wire('ALUOut', { 'adr.b': [[pt('aluout', 'q')[0] + 1, pt('aluout', 'q')[1]], [pt('aluout', 'q')[0] + 1, 31], [rr + 1.5, 31], [rr + 1.5, yAluOut], [pt('adr', 'b')[0] - 2, yAluOut], [pt('adr', 'b')[0] - 2, pt('adr', 'b')[1]]] });
  wire('Adr', { 'dm.addr': [[pt('adr', 'y')[0] + 5, pt('adr', 'y')[1]], [pt('adr', 'y')[0] + 5, pt('dm', 'addr')[1]]] });
  wire('MemData', { 'memsel.b': [[pt('dm', 'rd')[0] + 4, pt('dm', 'rd')[1]], [pt('dm', 'rd')[0] + 4, pt('memsel', 'b')[1]]] });
  const rdx = pt('memsel', 'y')[0] + 5;
  wire('ReadData', { 'ir.d': [[rdx, pt('memsel', 'y')[1]], [rdx, pt('ir', 'd')[1]]], 'data.d': [[rdx, pt('memsel', 'y')[1]], [rdx, pt('data', 'd')[1]]] });
  const irx = pt('ir', 'q')[0] + 4;
  wire('IR', { 'imm.instr': [[irx, pt('ir', 'q')[1]], [irx, pt('imm', 'instr')[1]]] });
  const sox = right('si') + 2;
  wire('op', { 'ctl.op': [[sox, pt('si', 'o0')[1]], [sox, pt('ctl', 'op')[1]]] }, ['ctrl.op']);
  wire('funct3', {
    'ctl.funct3': [[sox + 1, pt('si', 'o2')[1]], [sox + 1, pt('ctl', 'funct3')[1]]],
    'npc.funct3': [[sox + 1, pt('si', 'o2')[1]], [sox + 1, yF3], [nx - 10, yF3], [nx - 10, pt('npc', 'funct3')[1]]],
  });
  wire('funct7', { 'ctl.funct7': [[sox + 2, pt('si', 'o5')[1]], [sox + 2, pt('ctl', 'funct7')[1]]] });
  const rfx = at.get('rf')![0];
  wire('rs1', { 'rf.ra1': [[rfx - 8, pt('si', 'o3')[1]], [rfx - 8, pt('rf', 'ra1')[1]]] });
  wire('rs2', { 'rf.ra2': [[rfx - 6, pt('si', 'o4')[1]], [rfx - 6, pt('rf', 'ra2')[1]]] });
  wire('rd2', { 'rb.d': [[right('rf') + 4, pt('rf', 'rd2')[1]], [right('rf') + 4, pt('rb', 'd')[1]]] });
  wire('B', {
    'srcB.d0': [[sx - 2, pt('rb', 'q')[1]], [sx - 2, pt('srcB', 'd0')[1]]],
    'dm.wd': [[pt('rb', 'q')[0] + 2, pt('rb', 'q')[1]], [pt('rb', 'q')[0] + 2, 31], [pt('dm', 'wd')[0] - 2, 31], [pt('dm', 'wd')[0] - 2, pt('dm', 'wd')[1]]],
  });
  wire('ImmExt', {
    'srcB.d1': [[sx - 4, pt('imm', 'imm')[1]], [sx - 4, pt('srcB', 'd1')[1]]],
    'res.d3': [[sx - 4, pt('imm', 'imm')[1]], [sx - 4, 65], [rx - 4, 65], [rx - 4, pt('res', 'd3')[1]]],
  });
  wire('zeroB', { 'srcB.d3': [[sx - 6, pt('z32b', 'y')[1]], [sx - 6, pt('srcB', 'd3')[1]]] });
  wire('SrcB', { 'alu.b': [[pt('srcB', 'y')[0] + 5, pt('srcB', 'y')[1]], [pt('srcB', 'y')[0] + 5, pt('alu', 'b')[1]]] });
  wire('ALUControl', { 'alu.ctl': [[pt('alu', 'ctl')[0], pt('actl', 'y')[1]], [pt('alu', 'ctl')[0], pt('alu', 'ctl')[1] + 2]] });
  // the decoder's two outputs, down past the register file's right edge
  const lanes = right('rf') + 1;
  wire('ImmSrc', { 'imm.src': [[lanes, pt('ctl', 'immSrc')[1]], [lanes, pt('imm', 'src')[1] + 2], [pt('imm', 'src')[0], pt('imm', 'src')[1] + 2]] });
  wire('instrOp', { 'actl.b': [[lanes + 1.5, pt('ctl', 'aluCtl')[1]], [lanes + 1.5, pt('actl', 'b')[1]]] });
  // the ALU's flags, nested into the next-PC unit; branch / funct3 / jump / jalr arrive from the left
  ([['Zero', 'zero'], ['Neg', 'neg'], ['Ovf', 'ovf'], ['Carry', 'carry']] as const).forEach(([name, port], k) =>
    wire(name, { [`npc.${port}`]: [[right('alu') + 1.5 + k, pt('alu', port)[1]], [right('alu') + 1.5 + k, pt('npc', port)[1]]] }));
  wire('gnd', { 'npc.jalr': [[pt('npc', 'jump')[0] - 2, pt('gnd', 'y')[1]], [pt('npc', 'jump')[0] - 2, pt('npc', 'jalr')[1]]] });
  // taken and the result over the top, to the PC's write enable and the PC's input
  const psx = right('ps') + 2;
  wire('taken', { 'pcw.b': [[psx, pt('ps', 'o0')[1]], [psx, yTaken], [-6, yTaken], [-6, pt('pcw', 'b')[1]]] });
  wire('Result', {
    'clr0.in': [[rr + 7, pt('res', 'y')[1]], [rr + 7, yRes], [-8, yRes], [-8, pt('clr0', 'in')[1]]],
    'rf.wd': [[rr + 7, pt('res', 'y')[1]], [rr + 7, rowR], [pt('rf', 'wd')[0] - 5, rowR], [pt('rf', 'wd')[0] - 5, pt('rf', 'wd')[1]]],
  });
  wire('PCWrite', {});
  // the constant 1 enabling A, B (wired) and ALUOut, Data (pointers); the clock down a rail above the control channel
  const [ox, oy] = pt('one', 'y'), ot = ox + 2;
  wire('en', { 'ra.en': [[ot, oy], [ot, pt('ra', 'en')[1]]], 'rb.en': [[ot, oy], [ot, pt('rb', 'en')[1]]] }, ['aluout.en', 'data.en']);
  const rail = rowR + 1.5;
  const ck = (inst: string, ...rest: [number, number][]) => ({ [inst + '.clk']: rest });
  const [pcx] = pt('pc', 'clk'), [dmx, dmy] = pt('dm', 'clk'), [dax] = pt('data', 'clk'), [irx2, iry] = pt('ir', 'clk'), [opx, opy] = pt('oldpc', 'clk');
  const [rfcx, rfcy] = pt('rf', 'clk'), [rax, ray] = pt('ra', 'clk'), [rbx] = pt('rb', 'clk'), [aox] = pt('aluout', 'clk');
  const lx2 = pt('si', 'in')[0] - 5;
  wire('clk', {
    ...ck('pc', [pcx, rail]),
    ...ck('dm', [dmx - 14, rail], [dmx - 14, dmy + 2], [dmx, dmy + 2]),
    ...ck('data', [dax, rail]),
    ...ck('ir', [lx2 + 0, rail], [lx2, iry + 2], [irx2, iry + 2]),
    ...ck('oldpc', [lx2, rail], [lx2, opy + 2], [opx, opy + 2]),
    ...ck('rf', [rfcx + 6, rail], [rfcx + 6, rfcy + 2], [rfcx, rfcy + 2]),
    ...ck('ra', [right('rb') + 1, rail], [right('rb') + 1, ray + 2], [rax, ray + 2]),
    ...ck('rb', [rbx, rail]),
    ...ck('aluout', [aox, rail]),
  }, ['ctrl.clk']);
  // control: out of the controller's top edge, one row per signal in the channel, then up its own lane
  const rowOf = (f: string) => ch0 + (f === 'state' ? MC_FIELDS.length : MC_FIELDS.findIndex(([n]) => n === f));
  const ctlTo = (f: string, name: string, end: string, ...rest: [number, number][]) => {
    const [px] = pt('ctrl', f), row = rowOf(f);
    wire(name, { [end]: [[px, row], ...rest] });
    net(name).quiet = true;
  };
  const top = (f: string, name: string, end: string, x: number, y?: number) => ctlTo(f, name, end, [x, rowOf(f)], ...(y === undefined ? [] : [[x, y] as [number, number]]));
  top('pcUpdate', 'PCUpdate', 'pcw.a', 2, pt('pcw', 'a')[1]);
  top('branch', 'Branch', 'npc.branch', nx - 8, pt('npc', 'branch')[1]);
  top('irWrite', 'IRWrite', 'ir.en', pt('ir', 'en')[0] - 2, pt('ir', 'en')[1]);
  top('irWrite', 'IRWrite', 'oldpc.en', pt('oldpc', 'en')[0] - 2, pt('oldpc', 'en')[1]);
  top('regWrite', 'RegWrite', 'rf.we', pt('rf', 'we')[0] - 3, pt('rf', 'we')[1]);
  top('memWrite', 'MemWrite', 'dm.we', pt('dm', 'we')[0] - 3, pt('dm', 'we')[1]);
  top('adrSrc', 'AdrSrc', 'adr.s', pt('adr', 's')[0]);
  top('adrSrc', 'AdrSrc', 'memsel.s', pt('memsel', 's')[0]);
  top('resultSrc', 'ResultSrc', 'res.s', pt('res', 's')[0]);
  ctlTo('aluSrcA', 'ALUSrcA', 'srcA.s', [sx + 6, rowOf('aluSrcA')], [sx + 6, pt('srcA', 's')[1] + 2], [pt('srcA', 's')[0], pt('srcA', 's')[1] + 2]);
  top('aluSrcB', 'ALUSrcB', 'srcB.s', pt('srcB', 's')[0]);
  top('aluFunct', 'ALUFunct', 'actl.s', pt('actl', 's')[0]);
  for (const n of ['ImmSrc', 'instrOp', 'ALUControl', 'Zero', 'Neg', 'Ovf', 'Carry', 'PCSrc', 'op', 'funct3', 'funct7', 'gnd', 'taken', 'PCWrite', 'en', 'clk']) net(n).quiet = true;
  const pinX = rr + 24, pinRetire = rowOf('retire') - 3, pinState = rowOf('state');
  ctlTo('retire', 'retire', 'retire', [pinX - 6, rowOf('retire')], [pinX - 6, pinRetire]);
  ctlTo('state', 'state', 'fz.a', [pt('fz', 'a')[0] - 3, rowOf('state')], [pt('fz', 'a')[0] - 3, pt('fz', 'a')[1]]);
  ctlTo('state', 'state', 'state', [pinX - 2, rowOf('state')]);
  net('retire').quiet = net('state').quiet = false;
  delete net('fetch').tags;
  const pins: Record<string, [number, number]> = { clk: [6, rail], pcOut: [lx, 1], retire: [pinX, pinRetire], fetch: [pinX, pt('fz', 'z')[1]], state: [pinX, pinState] };
  const pinDirs: Netlist['pinDirs'] = { pcOut: 'down' };
  return {
    id: `mc_${IM.id.replace(/^rom_/, '')}_${control}${CT.id === 'mc_micro' || CT.id === 'mc_fsm' ? '' : CT.id.replace(/^mc_micro/, '')}${adder === 'ks' ? '' : '_rca'}${dmemK === 5 ? '' : `_d${dmemK}`}`,
    name: `Multicycle RV32I CPU (${control === 'fsm' ? 'hardwired' : 'microprogrammed'} control)`, category: 'cpu',
    summary: 'One ALU and one memory port, reused over 3 to 5 short cycles per instruction. IR, OldPC, A, B, Data and ALUOut hold values from one cycle to the next; the controller steps through the state table.',
    ports: [bit('clk', 'in', 'left', true), bus('pcOut', 32, 'out'), bit('retire', 'out'), bit('fetch', 'out'), bus('state', 4, 'out')],
    symbol: { kind: 'box', label: 'RV32I MULTICYCLE' },
    netlist: () => ({
      pins, pinDirs,
      instances, nets,
    }),
  };
}
