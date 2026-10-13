// Running our transistor-level 6502: NmosSim on the flattened chip, a memory on its pins, one clock
// cycle at a time (φ1: φ0 low; φ2: φ0 high). The bus cycle each cycle makes (address, data, R/W,
// SYNC) is what the tests compare with the ISS; internal registers are read by name for debugging.

import { CTL_LINES, m6502 } from '../lib/m6502/chip';
import { findNode, flatten, type FlatDesign, type HierNode } from '../sim/flatten';
import { NmosSim } from '../sim/nmossim';
import { netlistOf } from '../sim/types';
import type { Bus6502 } from './iss';

export class Chip6502 {
  readonly design: FlatDesign;
  readonly sim: NmosSim;
  private aNets: number[]; private dNets: number[];
  private rwNet: number; private syncNet: number;
  /** This cycle's bus (valid after cycle()). */
  addr = 0; data = 0; write = false; sync = 0;
  cycles = 0;
  irq = false; nmi = false;

  /** On a fresh simulation of the chip, or on `sim` (a stage's, already built for it). */
  constructor(readonly bus: Bus6502, sim?: NmosSim) {
    this.design = sim?.design ?? flatten(m6502(), { mode: 'switch' });
    this.sim = sim ?? new NmosSim(this.design);
    const P = this.design.root.ports;
    this.aNets = P.a; this.dNets = P.d; this.rwNet = P.rw[0]; this.syncNet = P.sync[0];
    this.sim.setInput('irqb', 1);
    this.sim.setInput('nmib', 1);
    this.sim.setInput('resb', 1);
    this.sim.setInput('phi0', 1);
    this.sim.settle();
  }

  /** RES as the next cycle() drives it (true = held low). */
  res = false;

  /** Hold RES low for `n` cycles, then release it: the next cycle begins the reset sequence. */
  reset(n = 2): void {
    this.res = true;
    for (let i = 0; i < n; i++) this.cycle();
    this.res = false;
  }

  /** Which phase the chip stands in: 2 between cycles, 1 after phase1(). */
  phase: 1 | 2 = 2;

  /** One clock cycle: φ1 (address out), then φ2 (memory read into the chip, or the chip's write). After phase1(), its φ2. */
  cycle(): void {
    if (this.phase === 1) return this.phase2();
    this.phase1();
    this.phase2();
  }

  /** φ1: the address and R/W go out, buses carry their transfers; the memory puts a read's byte on the pins. */
  phase1(): void {
    const s = this.sim;
    s.setInput('phi0', 0);
    s.settle();
    // the lines change inside φ1, never on a clock edge (the chip samples them in φ2)
    s.setInput('irqb', this.irq ? 0 : 1);
    s.setInput('nmib', this.nmi ? 0 : 1);
    s.setInput('resb', this.res ? 0 : 1);
    s.settle();
    let a = 0;
    for (let i = 0; i < 16; i++) a |= s.get(this.aNets[i]) << i;
    this.addr = a;
    this.write = s.get(this.rwNet) === 0;
    this.sync = s.get(this.syncNet);
    // the memory drives the data pins on a read (from φ1 on: the address is stable), lets go on a write
    if (this.write) for (const n of this.dNets) s.drive(n, 255);
    else {
      const v = this.bus.read(a) & 0xff;
      this.data = v;
      this.dNets.forEach((n, i) => s.drive(n, (v >> i) & 1));
    }
    this.phase = 1;
  }

  /** φ2: DL and IR latch a read (or the chip drives a write onto the pins), the T state advances. */
  phase2(): void {
    const s = this.sim, a = this.addr;
    s.setInput('phi0', 1);
    s.settle();
    if (this.write) {
      let v = 0;
      for (let i = 0; i < 8; i++) v |= s.get(this.dNets[i]) << i;
      this.data = v;
      this.bus.write(a, v);
    }
    this.phase = 2;
    this.cycles++;
  }

  private lineNets?: [string, number][];
  /** The φ1-qualified control lines that are on now (in φ1: this cycle's bus transfers and loads). */
  activeLines(): string[] {
    const node = findNode(this.design.root, ['ctrl'])!;
    this.lineNets ??= CTL_LINES.filter((n) => n.startsWith('c_')).map((n) => [n.slice(2), netNamed(node, n)!] as [string, number]);
    return this.lineNets.filter(([, net]) => this.sim.get(net) === 1).map(([n]) => n);
  }

  /** An 8- or 16-bit value from nets named `<prefix><i>` (or `<prefix>[i]`) inside a block. */
  read(path: string[], prefix: string, width = 8): number {
    const node = findNode(this.design.root, path);
    if (!node) throw new Error(`no block ${path.join('.')}`);
    let v = 0;
    for (let i = 0; i < width; i++) v |= this.sim.get(netNamed(node, `${prefix}${i}`) ?? netNamed(node, `${prefix}[${i}]`)!) << i;
    return v;
  }
  bit(path: string[], name: string): number {
    const node = findNode(this.design.root, path)!;
    return this.sim.get(netNamed(node, name)!);
  }

  private tNets?: number[];
  /** The T state of the cycle about to run (1 … 7; 0 if none: power-on). */
  tstate(): number {
    const node = findNode(this.design.root, ['ctrl', 'timing'])!;
    this.tNets ??= Array.from({ length: 7 }, (_, k) => netNamed(node, `nt[${k}]`)!);
    const k = this.tNets.findIndex((n) => this.sim.get(n) === 0);
    return k + 1;
  }

  /** The registers, read from the storage nodes (for comparing with the RTL model). */
  regs(): { a: number; x: number; y: number; s: number; p: number; pc: number; ir: number } {
    const reg = (blk: string) => {
      let v = 0;
      for (let i = 0; i < 8; i++) v |= this.bit(['dp', blk, `b${i}`], 'q') << i;
      return v;
    };
    const f = (n: string) => this.bit(['dp', 'flags'], `f${n}`);
    return {
      a: reg('rega'), x: reg('regx'), y: reg('regy'), s: reg('regs'),
      p: (f('n') << 7) | (f('v') << 6) | 0x20 | (f('d') << 3) | (f('i') << 2) | (f('z') << 1) | f('c'),
      pc: this.read(['dp', 'pc'], 'pc', 16), ir: this.read(['ctrl', 'ir'], 'ir'),
    };
  }
}

function netNamed(node: HierNode, name: string): number | undefined {
  const nl = netlistOf(node.def);
  if (!nl || !node.nets) return node.ports[name]?.[0];
  const k = nl.nets.findIndex((n) => n.name === name);
  return k >= 0 ? node.nets[k][0] : node.ports[name]?.[0];
}
