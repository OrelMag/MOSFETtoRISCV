// The gate window: the fast interpreter's state at an instruction boundary put into the gate-level
// Doom computer (lib/doompc.ts), which then runs clock cycle by clock cycle while the interpreter
// steps beside it, every retired instruction compared (PC and the 31 registers).
//
// Loading: power-on, then every architectural bit forced into its flip-flop (master and slave
// latch of each, as bigmem.ts seeds a RAM bank): the registers, PC, the CSRs, the timer; the RAM,
// the frame buffer and the key queue are leaves, poked with their state. What has no
// architectural state (the multiply/divide unit between instructions) is as power-on leaves it.

import type { BankedRamState } from '../lib/bigmem';
import type { KeyQueueState } from '../lib/doompc';
import { doomComputer } from '../lib/doompc';
import { cpuState } from '../riscv/cosim';
import { findNode, flatten, hintBits, type FlatDesign, type HierNode } from '../sim/flatten';
import type { Sim } from '../sim/sim';

import { B0, B1 } from '../sim/types';
import { DualSim } from '../sim/dualsim';
import { GateSim } from '../sim/gatesim';
import { FB_BASE, type FastDoom } from './machine';

/** The Doom computer for this interpreter's program and WAD, flattened (memoized per interpreter). */
const designs = new WeakMap<FastDoom, FlatDesign>();
export function doomDesign(cpu: FastDoom): FlatDesign {
  let d = designs.get(cpu);
  if (!d) designs.set(cpu, (d = flatten(doomComputer(cpu.image.text, cpu.dev.wadWords, cpu.dev.wadLength))));
  return d;
}

/** Force an n-bit register (register(n): ff<j>.ff.{master,slave}.sr.{q,q_n}) under `node` to v. */
function forceReg(sim: GateSim, node: HierNode, path: string, n: number, v: number): void {
  for (let j = 0; j < n; j++) {
    const b = Math.floor((v >>> 0) / 2 ** j) % 2 ? B1 : B0, nb = b === B1 ? B0 : B1;
    for (const latch of ['master', 'slave']) {
      const q = hintBits(node, `${path}.ff${j}.ff.${latch}.sr.q`), qn = hintBits(node, `${path}.ff${j}.ff.${latch}.sr.q_n`);
      if (!q || !qn) throw new Error(`gate window: no flip-flop at ${path}.ff${j}`);
      sim.forceNets(q, [b]);
      sim.forceNets(qn, [nb]);
    }
  }
}

function leaf(design: FlatDesign, path: string): number {
  const n = findNode(design.root, path.split('.'));
  if (n?.leafIndex === undefined) throw new Error(`gate window: ${path} is not a leaf`);
  return n.leafIndex;
}

/**
 * Put the interpreter's state into the gate-level computer (a simulation of doomDesign(cpu), clk
 * low): after this, the next rising edge executes the interpreter's next instruction. A DualSim is
 * loaded through its GateSim, then handed to the cycle engine (many times faster) if it can take it.
 */
export function loadGates(target: GateSim | DualSim, cpu: FastDoom): void {
  const dual = target instanceof DualSim ? target : null;
  if (dual) dual.preferFast = false;
  const sim = dual ? dual.gate : (target as GateSim);
  const d = sim.design, core = findNode(d.root, ['cpu'])!;
  sim.reset('zero');
  sim.setInput('clk', 0);
  sim.settle();
  for (let i = 1; i < 32; i++) forceReg(sim, core, `rf.w${i}`, 32, cpu.x[i]);
  forceReg(sim, core, 'pc', 32, cpu.pc);
  forceReg(sim, core, 'csr.rMIE', 1, cpu.mie ? 1 : 0);
  forceReg(sim, core, 'csr.rMPIE', 1, cpu.mpie ? 1 : 0);
  forceReg(sim, core, 'csr.rMIEN', 2, (cpu.mtie ? 1 : 0) | (cpu.meie ? 2 : 0));
  forceReg(sim, core, 'csr.rTvec', 30, cpu.mtvec >>> 2);
  forceReg(sim, core, 'csr.rScratch', 32, cpu.mscratch);
  forceReg(sim, core, 'csr.rEpc', 30, cpu.mepc >>> 2);
  forceReg(sim, core, 'csr.rCause', 32, cpu.mcause);
  forceReg(sim, core, 'csr.rTval', 32, cpu.mtval);
  forceReg(sim, core, 'io.mtime.r', 32, cpu.mtime);
  forceReg(sim, core, 'io.rCmp', 32, cpu.mtimecmp);
  forceReg(sim, d.root, 'dev.rLed', 8, cpu.leds);
  const ram: BankedRamState = { mem: cpu.dmem.slice(), x: new Uint8Array(cpu.dmem.length), clk: 0, we: 0, a: 0, d: 0, be: 0, writes: 0 };
  sim.poke(leaf(d, 'ram'), ram);
  const fbWords = new Uint32Array(cpu.dev.fb.buffer.slice(0));
  sim.poke(leaf(d, 'fb'), { mem: fbWords, x: new Uint8Array(fbWords.length), clk: 0, we: 0, a: 0, d: 0, be: 0, writes: 0 } satisfies BankedRamState);
  sim.poke(leaf(d, 'dev.keys'), { q: cpu.dev.keys.slice(), clk: 0, pop: 0 } satisfies KeyQueueState);
  sim.settle();
  if (dual) {
    dual.preferFast = true;
    dual.prepare();
    dual.settle();
  }
}

/** The gate-level computer's frame buffer and palette (128 KiB), as bytes. */
export function gateFrameBuffer(sim: Sim): Uint8Array {
  const st = sim.leafState(leaf(sim.design, 'fb')) as BankedRamState;
  return new Uint8Array(st.mem.buffer.slice(0));
}

/** The gate-level computer's RAM words. */
export function gateRam(sim: Sim): Uint32Array {
  return (sim.leafState(leaf(sim.design, 'ram')) as BankedRamState).mem;
}

export interface WindowStep {
  cycles: number;
  retired: number;
  /** The first difference, if any: the gates and the interpreter disagree from here. */
  mismatch?: string;
}

/**
 * Run up to `n` clock cycles on the gates (loaded by loadGates, clk low), stepping the interpreter
 * at each retirement and comparing PC and registers after it. Stops at the first mismatch.
 */
export function runWindow(sim: Sim, cpu: FastDoom, n: number, onCycle?: (cycle: number) => void): WindowStep {
  const root = sim.design.root, core = findNode(root, ['cpu'])!;
  let retired = 0;
  for (let c = 0; c < n; c++) {
    const retire = sim.getBits(root.ports.retire)[0] === 1;
    const pc = cpu.pc;
    sim.setInput('clk', 1);
    sim.settle();
    sim.setInput('clk', 0);
    sim.settle();
    if (retire) {
      cpu.step();
      retired++;
      const st = cpuState(sim, core);
      if (st.pc !== cpu.pc) return { cycles: c + 1, retired, mismatch: `after the instruction at 0x${pc.toString(16)}: PC 0x${st.pc.toString(16)} on the gates, 0x${cpu.pc.toString(16)} in the interpreter` };
      for (let r = 1; r < 32; r++) {
        if (st.x[r] !== cpu.x[r]) return { cycles: c + 1, retired, mismatch: `after the instruction at 0x${pc.toString(16)}: x${r} = 0x${st.x[r].toString(16)} on the gates, 0x${cpu.x[r].toString(16)} in the interpreter` };
      }
    }
    onCycle?.(c);
  }
  return { cycles: n, retired };
}

/** Memory and frame buffer equal between the gates and the interpreter (after a window): the first differing word, or null. */
export function memoryDiff(sim: Sim, cpu: FastDoom): string | null {
  const ram = gateRam(sim);
  for (let i = 0; i < ram.length; i++) if (ram[i] !== cpu.dmem[i]) return `RAM word 0x${(4 * i).toString(16)}: 0x${ram[i].toString(16)} on the gates, 0x${cpu.dmem[i].toString(16)} in the interpreter`;
  const fb = gateFrameBuffer(sim);
  for (let i = 0; i < fb.length; i++) if (fb[i] !== cpu.dev.fb[i]) return `frame buffer byte 0x${(FB_BASE + i).toString(16)}: ${fb[i]} on the gates, ${cpu.dev.fb[i]} in the interpreter`;
  return null;
}

