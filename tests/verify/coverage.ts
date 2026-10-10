// What the verification suites exercise. Instructions and trap causes come from the golden model's runs of the
// same programs; hardware events (forwarding paths, stalls, flushes, mispredictions, cache hits, misses and
// write-backs, arbitration conflicts, controller states) are read from the CPU's own nets, every cycle, in every
// lane still running its program. An event a CPU has but no program triggered shows as 0: a gap to fill.

import { decode } from '../../src/riscv/isa';
import type { StepInfo } from '../../src/riscv/iss';
import type { BitSim } from '../../src/sim/bitsim';
import type { FlatDesign, HierNode } from '../../src/sim/flatten';
import type { Isa } from './cpus';

/** Called after every clock cycle of a lane run; `active` has a bit set for each lane still running. */
export interface LaneProbe { cycle(sim: BitSim, active: number): void }

const popcount = (x: number) => { let n = 0; for (x >>>= 0; x; x &= x - 1) n++; return n; };

/** A field's lanes equal to v: the AND over its bits of each bit or its complement. */
function eq(v: Int32Array, nets: readonly number[], value: number): number {
  let m = -1;
  nets.forEach((n, i) => { m &= (value >> i) & 1 ? v[n] : ~v[n]; });
  return m;
}
const any = (v: Int32Array, nets: readonly number[]) => nets.reduce((m, n) => m | v[n], 0);

interface Event { name: string; mask: (v: Int32Array) => number; edge?: boolean; prev: number }

function find(node: HierNode, test: (n: HierNode) => boolean): HierNode | undefined {
  if (test(node)) return node;
  for (const c of node.children?.values() ?? []) { const f = find(c, test); if (f) return f; }
  return undefined;
}

export class HwCoverage implements LaneProbe {
  readonly counts = new Map<string, number>();
  /** Multicycle controller states visited. */
  readonly states = new Set<number>();
  private readonly events: Event[] = [];
  private readonly state?: readonly number[];

  constructor(design: FlatDesign) {
    const root = design.root, kids = root.children!;
    const ev = (name: string, mask: Event['mask'], edge = false) => { this.events.push({ name, mask, edge, prev: 0 }); this.counts.set(name, 0); };
    const port = (inst: string, p: string) => kids.get(inst)?.ports[p];
    const hz = kids.get('hz');
    if (hz) {
      const six = kids.has('MX');
      const fa = port('DE', 'fwdAE') ?? hz.ports.forwardA, fb = port('DE', 'fwdBE') ?? hz.ports.forwardB;
      const fwd = (k: number) => (v: Int32Array) => eq(v, fa, k) | eq(v, fb, k);
      ev('forward M → E', fwd(2));
      ev('forward W → E', fwd(1));
      if (six) ev('forward X → E', fwd(3));
      if (hz.ports.bypassA) ev('bypass W → D', (v) => any(v, hz.ports.bypassA) | any(v, hz.ports.bypassB));
      if (six) {
        ev('load-use stall', (v) => any(v, hz.ports.lwStall));
        const fhz = kids.get('fhz');
        if (fhz) ev('FP hazard stall', (v) => any(v, fhz.ports.stall));
        ev('flush', (v) => any(v, hz.ports.taken));
      } else {
        ev('load-use stall', (v) => ~any(v, hz.ports.enFD)); // with M, a multiply's result is late like a load's
        const g = kids.get('gFl1');
        ev('flush', (v) => any(v, g ? g.ports.y : hz.ports.flushFD));
        if (g) ev('cache-miss freeze', (v) => ~any(v, kids.get('go')!.ports.y));
      }
      const dive = kids.get('dive');
      if (dive) ev('divide stall', (v) => any(v, dive.ports.stall));
      const mis = kids.get('mis');
      if (mis) ev('misprediction', (v) => any(v, mis.ports.mispredict));
    }
    const dm = kids.get('dm');
    if (dm?.ports.hit) {
      const { re, we, hit, stall } = dm.ports;
      ev('D-cache hit', (v) => (any(v, re) | any(v, we)) & any(v, hit) & ~any(v, stall));
      ev('D-cache miss', (v) => any(v, stall), true);
      const mc = find(dm, (n) => n.def.id === 'missctrl');
      if (mc) ev('write-back', (v) => any(v, mc.ports.wb), true);
    }
    const im = kids.get('imem');
    if (im?.ports.hit) {
      ev('I-cache hit', (v) => any(v, im.ports.hit) & ~any(v, im.ports.stall));
      ev('I-cache miss', (v) => any(v, im.ports.stall), true);
    }
    const c0 = kids.get('core0'), c1 = kids.get('core1');
    if (c0 && c1) ev('memory conflict (both cores)', (v) => any(v, c0.ports.memReq) & any(v, c1.ports.memReq));
    const csr = find(root, (n) => n.def.id.startsWith('csrunit'));
    if (csr) {
      ev('trap entered', (v) => any(v, csr.ports.trap));
      ev('interrupt taken', (v) => any(v, csr.ports.irqTake), true);
    }
    this.state = root.ports.state;
  }

  cycle(sim: BitSim, active: number): void {
    const v = sim.v;
    for (const e of this.events) {
      let m = e.mask(v);
      if (e.edge) { const now = m; m &= ~e.prev; e.prev = now; }
      this.counts.set(e.name, this.counts.get(e.name)! + popcount(m & active));
    }
    if (this.state) for (let s = 0; s < 2 ** this.state.length; s++) if (eq(v, this.state, s) & active) this.states.add(s);
  }
}

/** Instructions retired and trap causes, from the golden model's steps. */
export class IsaCoverage {
  readonly instrs = new Map<string, number>();
  readonly traps = new Map<number, number>();
  step(s: StepInfo): void {
    if (s.trap) this.traps.set(s.trap.cause >>> 0, (this.traps.get(s.trap.cause >>> 0) ?? 0) + 1);
    if (s.trap?.interrupt) return;
    // an instruction that traps was still executed (ecall, a misaligned load); an illegal word is not one
    const n = decode(s.word).name;
    if (n !== 'unknown') this.instrs.set(n, (this.instrs.get(n) ?? 0) + 1);
  }
}

const RV32I = ['lui', 'auipc', 'jal', 'jalr', 'beq', 'bne', 'blt', 'bge', 'bltu', 'bgeu', 'lw', 'sw', 'addi', 'slti', 'sltiu', 'xori', 'ori',
  'andi', 'slli', 'srli', 'srai', 'add', 'sub', 'sll', 'slt', 'sltu', 'xor', 'srl', 'sra', 'or', 'and'];
const SUB = ['lb', 'lh', 'lbu', 'lhu', 'sb', 'sh'];
const M = ['mul', 'mulh', 'mulhsu', 'mulhu', 'div', 'divu', 'rem', 'remu'];
const F = ['flw', 'fsw', 'fadd.s', 'fsub.s', 'fmul.s', 'fdiv.s', 'fsqrt.s', 'fmadd.s', 'fmsub.s', 'fnmsub.s', 'fnmadd.s', 'fsgnj.s', 'fsgnjn.s',
  'fsgnjx.s', 'fmin.s', 'fmax.s', 'feq.s', 'flt.s', 'fle.s', 'fcvt.w.s', 'fcvt.wu.s', 'fcvt.s.w', 'fcvt.s.wu', 'fmv.x.w', 'fmv.w.x', 'fclass.s'];
const SYS = ['csrrw', 'csrrs', 'csrrc', 'csrrwi', 'csrrsi', 'csrrci', 'ecall', 'ebreak', 'mret'];

/** The instructions a CPU claims (fence and wfi left out: no-ops here). */
export function isaInstrs(isa: Isa): string[] {
  return [...RV32I, ...(isa.sub ? SUB : []), ...(isa.m ? M : []), ...(isa.f ? F : []), ...(isa.system ? SYS : []), ...(isa.mp ? ['amoswap.w', 'amoadd.w'] : [])];
}

export const CAUSE_NAMES: Record<number, string> = {
  0: 'misaligned fetch', 2: 'illegal instruction', 3: 'breakpoint', 4: 'misaligned load', 6: 'misaligned store', 11: 'ecall',
  0x80000007: 'timer interrupt', 0x8000000b: 'external interrupt',
};
