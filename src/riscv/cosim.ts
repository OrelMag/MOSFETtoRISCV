// Run the gate-level CPU and the golden model side by side and compare architectural state
// after every instruction (the primer's co-simulation, in the browser).

import type { HierNode } from '../sim/flatten';
import type { Sim } from '../sim/sim';
import { pack } from '../sim/values';

/** Read the CPU's architectural state from a simulation of singleCycleCpu(). */
export function cpuState(sim: Sim, root: HierNode = sim.design.root): { pc: number; x: number[]; dmem: number[] } {
  const rf = root.children!.get('rf')!;
  const x = [0];
  for (let i = 1; i < 32; i++) x.push(pack(sim.getBits(rf.children!.get(`w${i}`)!.ports.q)) >>> 0);
  const dm = root.children!.get('dm')!;
  const dmem: number[] = [];
  const ram = dm.children!.get('ram');
  if (ram) {
    for (const [name, n] of ram.children!) if (/^w\d+$/.test(name)) dmem[Number(name.slice(1))] = pack(sim.getBits(n.ports.q)) >>> 0;
  } else {
    // byte-banked memory: word i = {b3[i], b2[i], b1[i], b0[i]}
    for (let lane = 0; lane < 4; lane++) {
      const bank = dm.children!.get(`b${lane}`)!;
      for (const [name, n] of bank.children!) {
        if (!/^w\d+$/.test(name)) continue;
        const i = Number(name.slice(1));
        dmem[i] = ((dmem[i] ?? 0) + pack(sim.getBits(n.ports.q)) * 2 ** (8 * lane)) >>> 0;
      }
    }
  }
  const pcPort = root.ports.pcOut ?? root.ports.pcF;
  const pc = pcPort ? pack(sim.getBits(pcPort)) >>> 0 : 0;
  return { pc, x, dmem };
}

/** One clock cycle: rising edge, settle, falling edge, settle. */
export function clockCycle(sim: Sim): void {
  sim.setInput('clk', 1);
  sim.settle();
  sim.setInput('clk', 0);
  sim.settle();
}

/**
 * Does an instruction retire at the next edge? Pipelines: a valid instruction is in write-back.
 * CPUs with multi-cycle instructions: their retire output. Otherwise: every cycle.
 */
export function retiring(sim: Sim, root: HierNode = sim.design.root): boolean {
  const port = root.ports.validW ?? root.ports.retire;
  return port ? sim.getBits(port)[0] === 1 : true;
}
