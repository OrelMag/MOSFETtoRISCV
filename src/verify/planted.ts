// The faults the chapter "How do you know it works?" plants in its CPUs, through Rock's plantedDef (sim/faults.ts): the
// drawing is the healthy CPU, the simulation has the fault. Each is one stuck-at net, named by instance path and port.

import { pipelinedCpu } from '../lib/pipeline';
import { pipelinedFpCpu } from '../lib/fppipe';
import { plantedDef, type FlatFault } from '../sim/faults';
import { findNode, type HierNode } from '../sim/flatten';
import type { ComponentDef } from '../sim/types';
import type { FuzzCpu } from './fuzz';

/** A stuck-at fault on one bit of an instance's port (path from the planted component), as plantedDef wants it. */
export const stuckAt = (path: string[], port: string, bit: number, v: 0 | 1) => (node: HierNode): FlatFault[] => {
  const net = findNode(node, path)?.ports[port]?.[bit];
  return net === undefined ? [] : [{ kind: v ? 'stuck1' : 'stuck0', nets: [net] }];
};

const memo = new Map<string, ComponentDef>();
const once = (key: string, f: () => ComponentDef) => {
  let d = memo.get(key);
  if (!d) memo.set(key, (d = f()));
  return d;
};

/**
 * The pipeline with forwarding from M lost: the high bit of the hazard unit's forwardA (10 = take the result in M) stuck at
 * 0, so an instruction that reads the register written by the one just ahead takes the stale register-file value into the
 * ALU's A input (forwarding from W, 01, still works).
 */
export const FWD_FAULT = { path: ['hz'], port: 'forwardA', bit: 1, v: 0 as const };
export const pipeWithFwdFault = (words: number[], key: string): ComponentDef =>
  once(`fwd:${key}`, () => plantedDef(pipelinedCpu(words), stuckAt(FWD_FAULT.path, FWD_FAULT.port, FWD_FAULT.bit, FWD_FAULT.v), `fwdfault_${key}`));

/**
 * A bug random programs found in the six-stage RV32IF pipeline (docs/VERIFICATION.md, "What this found"): a taken branch
 * in E while D waited on an FP interlock lost its target, because the stall held the PC the branch had to load. The fix
 * was pc.en = not stalled OR taken (the OR gate pcEn). The bug is exactly that OR's taken input reading 0: its inverter
 * (pcEn.g2, private to the gate) stuck at 1.
 */
export const PC_BUG = { path: ['pcEn', 'g2'], port: 'y', bit: 0, v: 1 as const };

/** The FP pipeline with the old bug back in, for the fuzzing step: verdicts like any CPU's. */
export const FP_PIPE_WITH_BUG: FuzzCpu = {
  f: true, cpi: 30,
  build: (w, imemK, dmemK) => plantedDef(pipelinedFpCpu(w, { imemK, dmemK }), stuckAt(PC_BUG.path, PC_BUG.port, PC_BUG.bit, PC_BUG.v), 'pcbug'),
};

/** The FP pipeline as it is. */
export const FP_PIPE: FuzzCpu = { f: true, cpi: 30, build: (w, imemK, dmemK) => pipelinedFpCpu(w, { imemK, dmemK }) };

const wrapped = new WeakMap<ComponentDef, Map<string, ComponentDef>>();
/** `def` with one stuck-at fault planted (memoized per def and fault: a scene rebuilt keeps its caches). */
export function withFault(def: ComponentDef, f: { path: string[]; port: string; bit: number; v: 0 | 1 }): ComponentDef {
  const key = `${f.path.join('.')}.${f.port}[${f.bit}]=${f.v}`;
  let m = wrapped.get(def);
  if (!m) wrapped.set(def, (m = new Map()));
  let d = m.get(key);
  if (!d) m.set(key, (d = plantedDef(def, stuckAt(f.path, f.port, f.bit, f.v), `fault_${key.replace(/[^a-z0-9]+/gi, '_')}`)));
  return d;
}

/** The program of the lock-step step: x6 needs x5 from the instruction just ahead (forwarding from M). */
export const LOCKSTEP_SOURCE = `        addi x5, x0, 7      # x5 = 7
        add  x6, x5, x5     # needs x5 from M: 14
        addi x7, x6, 1      # 15
        sw   x7, 0(x0)
halt:   j    halt`;

/** The ALU's set-less-than bit stuck at 0: slt and slti read 0 where they should read 1, every other instruction is right. */
export const SLT_FAULT = { path: ['alu', 'slt'], port: 'y', bit: 0, v: 0 as const };
