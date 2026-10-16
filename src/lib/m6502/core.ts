// The 6502 as a part (the sandbox's processor of 1975): our transistor-level chip (chip.ts) behind
// pins a synchronous circuit can use, simulated by the cycle-exact ISS (src/m6502/iss.ts), which the
// chip matches bus cycle for bus cycle.
//
// One clock cycle is one bus cycle, from rising edge to rising edge. After an edge the part puts the
// cycle's address, R/W and SYNC out (and, on a write, the byte); at the next rising edge it takes din
// (a read) and IRQ / NMI / RES as they were just before it, the way the RAM parts take their inputs.
// So a ROM or RAM read combinationally from `a` feeds `din`, and a RAM written at the rising edge with
// we = NOT rw stores `dout`. dout is the byte of the last write cycle, held through reads (no output
// follows din: the memory map that makes din from `a` is no loop through the part, and the cycle
// engine levelizes it). Inside, clk high is φ1 (φ0 = NOT clk) and clk low φ2, as on the die.
//
// Opened, the part is the transistor-level chip on NmosSim, showing what the ISS is doing: the
// behaviour keeps a checkpoint (the registers at the last instruction boundary, or at a reset) and
// the bus inputs of every cycle since; the inside sets the chip up at the checkpoint with a loader
// program (as the SingleStepTests bench does) and replays those cycles, then follows edge by edge.

import { Cpu6502, type Cpu6502State } from '../../m6502/iss';
import type { Sim, SimState } from '../../sim/sim';
import { symbolGeom } from '../../sim/geometry';
import type { Behavior, ComponentDef, InstanceDef, NetDef, PortDef } from '../../sim/types';
import { define } from '../define';
import { m6502 } from './chip';
import { Logic } from './logic';

const bit = (name: string, dir: PortDef['dir'] = 'in', doc?: string): PortDef => ({ name, width: 1, dir, doc });
const R8 = [0, 1, 2, 3, 4, 5, 6, 7];

// ---- the behaviour ------------------------------------------------------------------------------

/** Where the inside's replay starts: the CPU at an instruction boundary, or at a reset. */
export interface Checkpoint6502 {
  /** A reset: the next cycles are the reset sequence (else: the next cycle is an opcode fetch). */
  reset: boolean;
  a: number; x: number; y: number; s: number; p: number; pc: number;
  /** IRQ was asserted in the cycle before (the chip's sampled IRQ). */
  irqSig: boolean;
  /** Edges since power-on, and the hash of every cycle's inputs up to here. */
  n: number; h: number;
}

/** The part's private state (plain data: simulations copy it for Back and edits). */
export interface Core6502State {
  cpu: Cpu6502State;
  /** Unknown: the CPU read an X or its clock went X; a reset (resb low at an edge) ends it. */
  x: boolean;
  /** The last clk seen: 0, 1, 2 = X, -1 none yet. */
  clk: number;
  /** The inputs as they were while clk was low (taken at the rising edge). */
  din: number; res: boolean; irq: boolean; nmi: boolean;
  /** This cycle's bus, as the CPU puts it out; dout: the byte of the last write cycle (this one's on a write). */
  addr: number; write: boolean; wdata: number; sync: number; dout: number;
  /** Rising edges since power-on, the hash of the history. */
  n: number; h: number;
  chk: Checkpoint6502 | null;
  /** Every cycle since chk: din (0 on a write) | IRQ asserted << 8 | NMI asserted << 9. */
  log: number[];
}

/** A replay longer than this (an NMI held, an undocumented opcode) gives up until the next checkpoint. */
const LOG_MAX = 512;
const RESET_MARK = 1 << 12;
const mix = (h: number, e: number) => (Math.imul(h ^ e, 0x9e3779b1) + 0x7f4a7c15) >>> 0;
const fold = (h: number, log: readonly number[], k: number) => {
  for (let i = 0; i < k; i++) h = mix(h, log[i]);
  return h;
};

const bus = { v: 0, read: () => bus.v, write: () => {} };
const cpu = new Cpu6502(bus);

/** The bus cycle the CPU makes next (its address does not depend on the byte it reads). */
function probe(s: Core6502State): void {
  cpu.restore(s.cpu);
  bus.v = 0;
  const c = cpu.cycle();
  s.addr = c.addr; s.write = c.rw === 'w'; s.wdata = c.rw === 'w' ? c.data : 0; s.sync = c.sync;
  if (s.write) s.dout = c.data;
}

function checkpoint(s: Core6502State, reset: boolean): void {
  const c = s.cpu;
  s.chk = { reset, a: c.a, x: c.x, y: c.y, s: c.s, p: c.p, pc: c.pc, irqSig: c.irqSig, n: s.n, h: s.h };
  s.log = [];
}

function freshState(mode?: 'x' | 'zero' | 'random'): Core6502State {
  const c = new Cpu6502(bus);
  if (mode === 'random') for (const r of ['a', 'x', 'y', 's'] as const) c[r] = Math.floor(Math.random() * 256);
  c.reset();
  const s: Core6502State = {
    cpu: c.save(), x: false, clk: -1, din: 0, res: false, irq: false, nmi: false,
    addr: 0, write: false, wdata: 0, sync: 0, dout: 0, n: 0, h: 0, chk: null, log: [],
  };
  checkpoint(s, true);
  probe(s);
  return s;
}

/** A rising edge: the cycle ends (a read takes din), the next one begins. */
function edge(s: Core6502State): void {
  s.n++;
  if (s.res) {
    // RES low at the edge: the reset sequence starts once it is released (A, X, Y, S, P kept)
    cpu.restore(s.cpu);
    cpu.reset();
    s.cpu = cpu.save();
    s.x = false;
    s.h = mix(s.h, RESET_MARK);
    checkpoint(s, true);
    probe(s);
    return;
  }
  if (s.x) return;
  if (!s.write && s.din < 0) { s.x = true; return; }
  cpu.restore(s.cpu);
  cpu.irq = s.irq; cpu.nmi = s.nmi;
  bus.v = s.write ? 0 : s.din;
  cpu.tick();
  const c = (s.cpu = cpu.save());
  const e = (s.write ? 0 : s.din) | (s.irq ? 256 : 0) | (s.nmi ? 512 : 0);
  s.h = mix(s.h, e);
  if (s.chk) {
    s.log.push(e);
    if (s.log.length > LOG_MAX) { s.chk = null; s.log = []; }
  }
  // a boundary the loader can set the chip up at: nothing pending, no NMI line history
  if (c.t === 0 && !c.intPending && c.illegal === null && !c.nmiSig && !c.nmiPrev) checkpoint(s, false);
  probe(s);
}

const isCore = (s: unknown): s is Core6502State => !!s && typeof s === 'object' && 'cpu' in s && 'log' in s;

export const core6502Behavior: Behavior = {
  delay: 4,
  init: freshState,
  // din is sampled, never passed through: no comb inputs
  seq: { clk: 'clk', comb: [] },
  eval: ([clk, resb, irqb, nmib, din], st) => {
    const s = st as Core6502State;
    const c = clk < 0 ? 2 : clk;
    if (c !== 1) {
      // open (X) control lines read as inactive, as if pulled up
      s.res = resb === 0; s.irq = irqb === 0; s.nmi = nmib === 0;
      s.din = din;
    }
    const p = s.clk;
    s.clk = c;
    if (p === 0 && c === 1) edge(s);
    else if (p >= 0 && p !== 1 && c !== 0 && p !== c) s.x = true; // an X clock: an edge or not
    if (s.x) return [-1, -1, -1, -1];
    return [s.addr, s.dout, s.write ? 0 : 1, s.sync];
  },
  inside: (st, seed) => {
    if (isCore(st) && seed.sim) replayInside(st, seed.sim);
  },
};

/** The architectural registers of a placed 6502 (its leaf state), for readers (the CPU drawer). */
export function core6502Regs(s: unknown): (Cpu6502State & { x6502: boolean; bus: { addr: number; write: boolean; data: number; sync: number } }) | null {
  if (!isCore(s)) return null;
  return { ...s.cpu, x6502: s.x, bus: { addr: s.addr, write: s.write, data: s.write ? s.wdata : s.din, sync: s.sync } };
}
export const isCore6502State = isCore;

// ---- the inside: the chip, replayed ---------------------------------------------------------------

/** One bus cycle of the part's structure through its own pins (φ1 with clk high, φ2 with it low). */
function phase1(sim: Sim, lines: { res: boolean; irq: boolean; nmi: boolean }, read: (a: number) => number): void {
  sim.setInput('clk', 1);
  sim.settle();
  // the lines change inside φ1, never on a clock edge (the chip samples them in φ2)
  sim.setInput('resb', lines.res ? 0 : 1);
  sim.setInput('irqb', lines.irq ? 0 : 1);
  sim.setInput('nmib', lines.nmi ? 0 : 1);
  sim.settle();
  const P = sim.design.root.ports;
  let a = 0;
  for (let i = 0; i < 16; i++) a |= (sim.get(P.a[i]) & 1) << i;
  sim.setInput('din', sim.get(P.rw[0]) === 1 ? read(a) & 0xff : 0);
  sim.settle();
}
function phase2(sim: Sim): void {
  sim.setInput('clk', 0);
  sim.settle();
}

/** The loader (verify.ts's): S, then P (pushed, pulled), A, X, Y, and a jump to pc. */
const LOADER_AT = 0xf000;
const LOADER_CYCLES = 2 + 2 + 2 + 3 + 2 + 2 + 2 + 4 + 3;
const loaderFor = (c: Checkpoint6502) => {
  // before a reset, one less: the first cycle of RES low still fetches there and steps the PC
  const pc = c.reset ? (c.pc - 1) & 0xffff : c.pc;
  return [0xa2, c.s, 0x9a, 0xa9, c.p, 0x48, 0xa9, c.a, 0xa2, c.x, 0xa0, c.y, 0x28, 0x4c, pc & 0xff, pc >> 8];
};

/** The chip from power-on to the checkpoint: its own reset, the loader, and for a reset two cycles of RES. */
export function seedChip(sim: Sim, c: Checkpoint6502): void {
  sim.reset('zero');
  const mem = new Uint8Array(0x10000);
  mem.set(loaderFor(c), LOADER_AT);
  mem[0xfffc] = LOADER_AT & 0xff; mem[0xfffd] = LOADER_AT >> 8;
  const read = (a: number) => mem[a];
  const cycle = (res: boolean, irq = false) => { phase1(sim, { res, irq, nmi: false }, read); phase2(sim); };
  cycle(true); cycle(true);
  for (let i = 0; i < 7 + LOADER_CYCLES; i++) cycle(false, !c.reset && c.irqSig && i === 7 + LOADER_CYCLES - 1);
  if (c.reset) { cycle(true); cycle(true); }
}

/** Per opened inside: the edges it has replayed to, their hash, and the chip between cycles there. */
const replayed = new WeakMap<Sim, { n: number; h: number; snap: SimState }>();

function replayInside(s: Core6502State, sim: Sim): void {
  // the cycle in progress: the clock and din as the view set them, the lines as the behaviour read
  // them (the view drives an open input as 0, the part reads it as inactive)
  const clk = sim.getInput('clk'), din = sim.getInput('din');
  const now = { res: s.res, irq: s.irq, nmi: s.nmi };
  const c = s.chk;
  if (s.x || !c) return;
  const rec = replayed.get(sim);
  let k = rec ? rec.n - c.n : -1;
  if (rec && k >= 0 && k <= s.log.length && fold(c.h, s.log, k) === rec.h) sim.restoreState(rec.snap);
  else { seedChip(sim, c); k = 0; }
  for (let i = k; i < s.log.length; i++) {
    const e = s.log[i];
    phase1(sim, { res: false, irq: !!(e & 256), nmi: !!(e & 512) }, () => e & 0xff);
    phase2(sim);
  }
  replayed.set(sim, { n: c.n + s.log.length, h: s.h, snap: sim.saveState() });
  phase1(sim, now, () => (din < 0 ? 0 : din));
  if (clk !== 1) phase2(sim);
}

// ---- the structure ------------------------------------------------------------------------------

let pins: ComponentDef | null = null;
/** The pins a synchronous circuit uses, onto the chip's: φ0 = NOT clk, the data bus split in two. */
export function pinsBlock(): ComponentDef {
  if (pins) return pins;
  const L = new Logic();
  L.inv('clk', 'phi0');
  L.nor(['clk', 'rw'], 'wr2'); // φ2 of a write cycle
  for (const i of R8) {
    // a read: din onto the pins (the memory drives the bus while R/W is high); a write: the pins
    // into a dynamic latch in φ2 (the chip drives them then), held through the reads after it
    L.pass('rw', `din[${i}]`, `d[${i}]`);
    L.inv(L.dlat(`d[${i}]`, 'wr2').nq, `dout[${i}]`);
  }
  pins = L.build({
    id: 'm65_pins', name: '6502 bus interface',
    summary: "clk → φ0 (inverted: clk high is φ1), din onto the data pins while R/W is high (a read), dout = the data pins as the last write cycle's φ2 left them (a dynamic latch).",
    ports: [bit('clk'), bit('rw'), { name: 'din', width: 8, dir: 'in' }, { name: 'd', width: 8, dir: 'inout' }, bit('phi0', 'out'), { name: 'dout', width: 8, dir: 'out' }],
    symbol: { kind: 'box', label: 'PINS' }, rows: 9,
  });
  return pins;
}

const PORTS: PortDef[] = [
  bit('clk', 'in', 'one rising edge per bus cycle; high = φ1, low = φ2'),
  bit('resb', 'in', 'RES, active low: low at an edge restarts the CPU (open: high)'),
  bit('irqb', 'in', 'IRQ, active low, a level (open: high)'),
  bit('nmib', 'in', 'NMI, active low, a falling edge (open: high)'),
  { name: 'din', width: 8, dir: 'in', doc: 'the byte read, taken at the rising edge that ends a read cycle' },
  { name: 'a', width: 16, dir: 'out', doc: 'the address of this cycle' },
  { name: 'dout', width: 8, dir: 'out', doc: 'the byte written: this cycle’s on a write, held through the reads after it' },
  bit('rw', 'out', 'R/W: 1 read, 0 write (a RAM\'s we = NOT rw)'),
  bit('sync', 'out', '1 on an opcode fetch'),
];

let core: ComponentDef | null = null;
/** The sandbox's 6502: the cycle-exact ISS as its behaviour, the transistor-level chip as its structure. */
export function core6502(): ComponentDef {
  if (core) return core;
  core = define({
    id: 'm6502_core', name: '6502', category: 'cpu',
    summary: 'The MOS 6502 of 1975 (Appendix A): one bus cycle per clock, every cycle as the chip makes it. Simulated by the cycle-exact model; open it for the transistors.',
    ports: PORTS,
    symbol: { kind: 'box', label: '6502' },
    behavior: core6502Behavior,
    preferBehavior: true,
    notes: `Simulated by the cycle-exact instruction-set model: every bus cycle (dummy reads, read-modify-write's
      double write, stack reads) as the transistor-level chip makes it; open it and the chip replays what the model
      did. A cycle runs from one rising clk edge to the next: a, rw, sync and dout change just after the edge, din,
      irqb, nmib and resb are taken just before the next one. It powers on into its reset sequence (vector at $FFFC),
      so a part with resb left open runs from power-on. Undocumented opcodes stop it: it reads the same address forever.`,
    netlist: () => {
      const chip = m6502(), glue = pinsBlock();
      const cg = symbolGeom(chip).ports, gg = symbolGeom(glue);
      const XG = 10, XC = XG + gg.w + 24, Y = 2;
      const gp = (p: string) => gg.ports[p].pos;
      const instances: InstanceDef[] = [{ name: 'pins', def: glue, at: [XG, Y] }, { name: 'chip', def: chip, at: [XC, Y] }];
      const left = (y: number): [number, number] => [0, y];
      const right = (y: number): [number, number] => [XC + 24, y];
      const nets: NetDef[] = [
        { name: 'clk', ends: ['clk', 'pins.clk'] },
        { name: 'din', ends: ['din', 'pins.din'] },
        { name: 'phi0', ends: ['pins.phi0', 'chip.phi0'], tags: true },
        { name: 'd', ends: ['pins.d', 'chip.d'], tags: true },
        { name: 'rw', ends: ['chip.rw', 'pins.rw', 'rw'], tags: true },
        { name: 'dout', ends: ['pins.dout', 'dout'], tags: true },
        ...['resb', 'irqb', 'nmib'].map((p): NetDef => ({ name: p, ends: [p, `chip.${p}`], tags: true })),
        { name: 'a', ends: ['chip.a', 'a'] },
        { name: 'sync', ends: ['chip.sync', 'sync'] },
      ];
      return {
        level: 'switch',
        pins: {
          clk: left(Y + gp('clk')[1]), din: left(Y + gp('din')[1]),
          resb: left(Y + gg.h + 4), irqb: left(Y + gg.h + 6), nmib: left(Y + gg.h + 8),
          a: right(Y + cg.a.pos[1]), rw: right(Y + cg.rw.pos[1]), sync: right(Y + cg.sync.pos[1]), dout: right(Y + gg.h + 4),
        },
        instances, nets,
      };
    },
  });
  return core;
}
core6502();
