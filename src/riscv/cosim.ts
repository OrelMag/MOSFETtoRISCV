// Run the gate-level CPU and the golden model side by side and compare architectural state
// after every instruction (the primer's co-simulation, in the browser).

import type { HierNode } from '../sim/flatten';
import type { Sim } from '../sim/sim';
import { pack } from '../sim/values';

/** Read the CPU's architectural state from a simulation of singleCycleCpu(). */
export function cpuState(sim: Pick<Sim, 'getBits' | 'design'>, root: HierNode = sim.design.root): { pc: number; x: number[]; dmem: number[]; f?: number[]; fcsr?: number } {
  const rf = root.children!.get('rf')!;
  const x = [0];
  for (let i = 1; i < 32; i++) x.push(pack(sim.getBits(rf.children!.get(`w${i}`)!.ports.q)) >>> 0);
  const frf = root.children!.get('frf');
  const f = frf ? Array.from({ length: 32 }, (_, i) => pack(sim.getBits(frf.children!.get(`w${i}`)!.ports.q)) >>> 0) : undefined;
  const fc = root.children!.get('fcsr');
  const fcsr = fc ? pack(sim.getBits(fc.ports.fcsr)) : undefined;
  const dm = root.children!.get('dm');
  const dmem: number[] = [];
  const ram = dm?.children!.get('ram');
  if (ram) {
    for (const [name, n] of ram.children!) if (/^w\d+$/.test(name)) dmem[Number(name.slice(1))] = pack(sim.getBits(n.ports.q)) >>> 0;
  } else if (dm) {
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
  // A write-back cache holds the newest copy of its dirty lines: overlay them on main memory.
  if (dm) for (const l of cacheLines(sim, dm)) if (l.valid && l.dirty) l.words.forEach((v, i) => (dmem[l.base + i] = v));
  const pcPort = root.ports.pcOut ?? root.ports.pcF;
  const pc = pcPort ? pack(sim.getBits(pcPort)) >>> 0 : 0;
  return { pc, x, dmem, f, fcsr };
}

/** One clock cycle: rising edge, settle, falling edge, settle. */
export function clockCycle(sim: Pick<Sim, 'setInput' | 'settle'>): void {
  sim.setInput('clk', 1);
  sim.settle();
  sim.setInput('clk', 0);
  sim.settle();
}

/**
 * Does an instruction retire at the next edge? Pipelines: a valid instruction is in write-back.
 * CPUs with multi-cycle instructions: their retire output. Otherwise: every cycle.
 */
export function retiring(sim: Pick<Sim, 'getBits' | 'design'>, root: HierNode = sim.design.root): boolean {
  const port = root.ports.validW ?? root.ports.retire;
  return port ? sim.getBits(port)[0] === 1 : true;
}

export interface CacheLine { way: number; set: number; valid: boolean; dirty: boolean; tag: number; base: number; words: number[] }

/**
 * The lines of a data cache, write-through (tags / data arrays) or write-back (way0, way1, each with
 * tags holding {dirty, valid, tag} and data). base = main-memory word index of the line's first word.
 */
export function cacheLines(sim: Pick<Sim, 'getBits'>, dm: HierNode): CacheLine[] {
  const word = (arr: HierNode, i: number) => pack(sim.getBits(arr.children!.get(`w${i}`)!.ports.q)) >>> 0;
  const ways = dm.children!.has('way0') ? [...dm.children!.entries()].filter(([n]) => /^way\d$/.test(n)).map(([, n]) => n)
    : dm.children!.has('tags') ? [dm] : [];
  const out: CacheLine[] = [];
  ways.forEach((w, way) => {
    const tags = w.children!.get('tags')!, data = w.children!.get('data')!;
    const sets = [...tags.children!.keys()].filter((n) => /^w\d+$/.test(n)).length;
    const tb = tags.def.ports.find((p) => p.name === 'din')!.width - (w === dm ? 1 : 2);
    const ib = Math.round(Math.log2(sets));
    for (let set = 0; set < sets; set++) {
      const tv = word(tags, set), tag = tv & ((1 << tb) - 1);
      out.push({
        way, set, tag, valid: !!((tv >> tb) & 1), dirty: w !== dm && !!((tv >> (tb + 1)) & 1),
        base: (tag << (ib + 2)) | (set << 2), words: [0, 1, 2, 3].map((i) => word(data, set * 4 + i)),
      });
    }
  });
  return out;
}

/** One cycle of a pipelined CPU: which instruction (PC) each stage holds, and what the hazard logic did. */
export interface PipeSnap {
  cycle: number;
  /** F D E M (X) W. */
  stages: string[];
  slots: { pc: number; valid: boolean }[];
  stall: boolean;
  flush: boolean;
  /** Forwarding selects of the E stage (0: register file, 1: from W, 2: from M, 3: from X). */
  fwdA: number;
  fwdB: number;
  /** A W → D bypass into the register-file read. */
  byp: boolean;
}

/**
 * Where every instruction of the site's pipelined CPUs is (pipeline registers FD, DE, EM, MW, or
 * MX + XW for the six-stage FPU pipeline, with pc<stage> / valid<stage>), read from `root` (the
 * CPU's node). Null for anything else.
 */
export function pipeSnap(sim: Pick<Sim, 'getBits'>, root: HierNode, cycle: number): PipeSnap | null {
  const kids = root.children;
  if (!kids || !['pc', 'FD', 'DE', 'EM', 'hz'].every((n) => kids.has(n)) || !(kids.has('MW') || kids.has('XW'))) return null;
  const v = (inst: string, port: string) => {
    const nets = kids.get(inst)?.ports[port];
    if (!nets) return -1;
    const bits = sim.getBits(nets);
    let x = 0;
    for (let i = bits.length - 1; i >= 0; i--) x = x * 2 + (bits[i] === 1 ? 1 : 0);
    return x;
  };
  // the pipelined FPU CPU has a sixth stage, X, between M and W
  const six = kids.has('MX');
  const frozenPipe = !six && kids.has('gFl1');
  const slots = [
    { pc: v('pc', 'q'), valid: true },
    { pc: v('FD', 'pcD'), valid: v('FD', 'validD') === 1 },
    { pc: v('DE', 'pcE'), valid: v('DE', 'validE') === 1 },
    { pc: v('EM', 'pcM'), valid: v('EM', 'validM') === 1 },
    ...(six ? [{ pc: v('MX', 'pcX'), valid: v('MX', 'validX') === 1 }, { pc: v('XW', 'pcW'), valid: v('XW', 'validW') === 1 }]
      : [{ pc: v('MW', 'pcW'), valid: v('MW', 'validW') === 1 }]),
  ];
  return {
    cycle, slots, stages: six ? ['F', 'D', 'E', 'M', 'X', 'W'] : ['F', 'D', 'E', 'M', 'W'],
    // with a data cache, a miss freezes every stage (go = 0) and the flushes are gated (gFl1)
    stall: six ? v('go', 'y') === 0 : v('hz', 'enFD') === 0 || (frozenPipe && v('go', 'y') === 0) || (kids.has('dive') && v('dive', 'stall') === 1),
    flush: six ? v('hz', 'taken') === 1 : frozenPipe ? v('gFl1', 'y') === 1 : v('hz', 'flushFD') === 1,
    // Balanced design: the E-stage selects travel in ID/EX (the hazard unit's outputs are for D).
    fwdA: kids.get('DE')!.ports.fwdAE ? v('DE', 'fwdAE') : v('hz', 'forwardA'),
    fwdB: kids.get('DE')!.ports.fwdBE ? v('DE', 'fwdBE') : v('hz', 'forwardB'),
    byp: v('hz', 'bypassA') === 1 || v('hz', 'bypassB') === 1,
  };
}
