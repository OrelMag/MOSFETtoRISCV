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
  const ram = root.children!.get('dm')!.children!.get('ram')!;
  const dmem: number[] = [];
  for (const [name, n] of ram.children!) if (/^w\d+$/.test(name)) dmem[Number(name.slice(1))] = pack(sim.getBits(n.ports.q)) >>> 0;
  const pc = pack(sim.getBits(root.ports.pcOut)) >>> 0;
  return { pc, x, dmem };
}

/** One clock cycle: rising edge, settle, falling edge, settle. */
export function clockCycle(sim: Sim): void {
  sim.setInput('clk', 1);
  sim.settle();
  sim.setInput('clk', 0);
  sim.settle();
}
