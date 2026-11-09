// Lock step of the virtual-memory system CPU (systemCpu(program, { vm: true })) against the golden model
// (ISS with system and vm): the hardware runs, and each time it retires (retire = 1: an instruction, a trap or an interrupt
// is taken at the next edge) the model steps once; then the architectural state is compared: the registers, the PC, the
// privilege level, mstatus, the machine and supervisor CSRs, satp, mtime. A walk is a few cycles with retire low.

import { dmemWords } from '../../src/riscv/cosim';
import { CSRS } from '../../src/riscv/isa';
import { ISS, type StepInfo } from '../../src/riscv/iss';
import { DualSim } from '../../src/sim/dualsim';
import { flatten, type FlatDesign, type HierNode } from '../../src/sim/flatten';
import { GateSim } from '../../src/sim/gatesim';
import type { Sim } from '../../src/sim/sim';
import { inPorts } from '../../src/sim/types';
import { pack } from '../../src/sim/values';
import { systemCpu } from '../../src/lib/system';

export interface VmLockOptions {
  imemK?: number;
  dmemK?: number;
  /** Hardware clock cycles to run at most. */
  maxCycles?: number;
  /** The external interrupt pin and the model's meip, as a function of the model's step count. */
  irq?: (steps: number) => boolean;
  engine?: 'cycle' | 'gate';
  /** Stop when the model has halted (jump to itself) and this many more steps ran. */
  drain?: number;
  /** Called every `every` cycles: the test gives the event loop back. */
  pause?: () => Promise<void>;
}

export interface VmLockResult {
  ok: boolean;
  /** The first difference ('' when none). */
  why: string;
  cycles: number;
  steps: number;
  stalls: number;
  /** Instructions per privilege level they ran in (index 0 U, 1 S, 3 M). */
  byPriv: number[];
  /** Page faults and access faults seen by the model, by cause. */
  causes: Record<number, number>;
  walks: number;
  iss: ISS;
  hw: Sim;
  design: FlatDesign;
  halted: boolean;
}

const hex = (v: number) => `0x${(v >>> 0).toString(16).padStart(8, '0')}`;

/** The architectural state read from the hardware: name → value. */
export function hwArch(sim: Sim, root: HierNode): Record<string, number> {
  const kids = root.children!;
  const rf = kids.get('rf')!;
  const csr = kids.get('csr')!.children!;
  const q = (n: HierNode, port = 'q') => pack(sim.getBits(n.ports[port])) >>> 0;
  const r = (name: string) => q(csr.get(name)!);
  const out: Record<string, number> = {};
  for (let i = 1; i < 32; i++) out[`x${i}`] = q(rf.children!.get(`w${i}`)!);
  out.pc = pack(sim.getBits(root.ports.pcOut)) >>> 0;
  out.priv = (~r('privN')) & 3;
  const fs = r('fs');
  out.mstatus = ((r('sie') << 1) | (r('mie') << 3) | (r('spie') << 5) | (r('mpie') << 7) | (r('spp') << 8) | (r('mpp') << 11) | (fs << 13) | (r('sum') << 18) | (r('mxr') << 19) | (fs === 3 ? 0x80000000 : 0)) >>> 0;
  out.mie = r('mieR') << 7 | 0; // MTIE is bit 7, MEIE bit 11 (re-read below)
  const mieR = r('mieR');
  out.mie = (((mieR & 1) << 7) | ((mieR >> 1) << 11)) >>> 0;
  out.mtvec = (r('mtvec') << 2) >>> 0;
  out.mscratch = r('mscratch');
  out.mepc = (r('mepc') << 2) >>> 0;
  out.mcause = r('mcause');
  out.mtval = r('mtval');
  out.satp = r('satp');
  out.stvec = (((r('stvec') << 2) | r('stvec0')) >>> 0);
  out.sscratch = r('sscratch');
  out.sepc = (r('sepc') << 2) >>> 0;
  out.scause = r('scause');
  out.stval = r('stval');
  const io = kids.get('io')!.children!;
  out.mtime = q(io.get('mtime')!);
  out.mtimecmp = q(io.get('rCmp')!);
  return out;
}

/** The same names from the model. */
export function issArch(iss: ISS): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 1; i < 32; i++) out[`x${i}`] = iss.x[i] >>> 0;
  out.pc = iss.pc >>> 0;
  out.priv = iss.priv;
  out.mstatus = iss.csrRead(CSRS.mstatus)! >>> 0;
  out.mie = iss.csrRead(CSRS.mie)! >>> 0;
  out.mtvec = iss.mtvec >>> 0;
  out.mscratch = iss.mscratch >>> 0;
  out.mepc = iss.mepc >>> 0;
  out.mcause = iss.mcause >>> 0;
  out.mtval = iss.mtval >>> 0;
  out.satp = iss.satp >>> 0;
  out.stvec = iss.stvec >>> 0;
  out.sscratch = iss.sscratch >>> 0;
  out.sepc = iss.sepc >>> 0;
  out.scause = iss.scause >>> 0;
  out.stval = iss.stval >>> 0;
  out.mtime = iss.mtime >>> 0;
  out.mtimecmp = iss.mtimecmp >>> 0;
  return out;
}

/** The hardware's data memory words (a big RAM leaf's, or the register banks'). */
export function hwDmem(sim: Sim, root: HierNode): number[] {
  const dm = root.children!.get('dm')!;
  if (dm.leafIndex !== undefined) {
    const st = sim.leafState(dm.leafIndex) as { mem: ArrayLike<number> } | undefined;
    return st ? Array.from(st.mem, (v) => v >>> 0) : [];
  }
  return dmemWords(sim, dm);
}

export function diffArch(want: Record<string, number>, got: Record<string, number>): string {
  const out: string[] = [];
  for (const k of Object.keys(want)) if ((got[k] ?? 0) >>> 0 !== want[k] >>> 0) out.push(`${k} = ${hex(got[k] ?? 0)}, model ${hex(want[k])}`);
  return out.slice(0, 6).join('; ') + (out.length > 6 ? `; … (${out.length} differences)` : '');
}

export function buildVm(words: number[], imemK: number, dmemK: number, engine: 'cycle' | 'gate' = 'cycle') {
  const design = flatten(systemCpu(words, { vm: true, imemK, dmemK }));
  const sim: Sim = engine === 'gate' ? new GateSim(design) : new DualSim(design);
  for (const p of inPorts(design.root.def)) sim.setInput(p.name, 0);
  sim.reset('zero');
  sim.settle();
  if (sim instanceof DualSim) { sim.preferFast = true; sim.prepare(); }
  return { design, sim };
}

export async function lockstep(words: number[], o: VmLockOptions = {}): Promise<VmLockResult> {
  const imemK = o.imemK ?? 8, dmemK = o.dmemK ?? 12, max = o.maxCycles ?? 2000, drain = o.drain ?? 6;
  const { design, sim } = buildVm(words, imemK, dmemK, o.engine ?? 'cycle');
  const iss = new ISS(words, { system: true, vm: true, dmemWords: 2 ** dmemK, imemWords: 2 ** imemK });
  const root = design.root;
  const retirePort = root.ports.retire;
  const res: VmLockResult = { ok: true, why: '', cycles: 0, steps: 0, stalls: 0, byPriv: [0, 0, 0, 0], causes: {}, walks: 0, iss, hw: sim, design, halted: false };
  let after = 0;
  for (let c = 0; c < max; c++) {
    if (o.pause && (c & 63) === 63) await o.pause();
    const irq = o.irq ? o.irq(iss.steps) : false;
    sim.setInput('irq', irq ? 1 : 0);
    iss.irq = irq;
    sim.settle();
    const ret = pack(sim.getBits(retirePort)) === 1;
    const pcHw = pack(sim.getBits(root.ports.pcOut)) >>> 0;
    if (ret && pcHw !== iss.pc >>> 0) { res.ok = false; res.why = `cycle ${c}: retiring at ${hex(pcHw)}, model at ${hex(iss.pc)}`; break; }
    sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle();
    res.cycles++;
    if (!ret) { res.stalls++; continue; }
    const info: StepInfo = iss.step();
    res.steps++;
    if (info.priv !== undefined) res.byPriv[info.priv]++;
    if (info.trap && !info.trap.interrupt) res.causes[info.trap.cause] = (res.causes[info.trap.cause] ?? 0) + 1;
    res.walks += info.walks?.filter((w) => w.ptes.length).length ?? 0;
    const why = diffArch(issArch(iss), hwArch(sim, root));
    if (why) { res.ok = false; res.why = `cycle ${c}, after ${hex(info.pc)} ${info.text}${info.trap ? ` (trap ${info.trap.cause.toString(16)})` : ''}: ${why}`; break; }
    if (iss.halted) { if (++after > drain) { res.halted = true; break; } } else after = 0;
  }
  if (res.ok) {
    const want = Array.from(iss.dmem), got = hwDmem(sim, root);
    for (let i = 0; i < want.length; i++) if ((got[i] ?? 0) >>> 0 !== want[i] >>> 0) { res.ok = false; res.why = `data memory word ${i}: ${hex(got[i] ?? 0)}, model ${hex(want[i])}`; break; }
  }
  return res;
}
