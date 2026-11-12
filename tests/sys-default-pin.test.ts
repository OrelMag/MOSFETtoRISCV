// The system CPU without `vm` is gate for gate what it was before the virtual-memory variant existed: chapters 19-20,
// src/bench/results.json and the layout flow quote its numbers. This pins, for the default CPUs and the units the
// variant must not touch, the NAND count, the id and a fingerprint of every netlist below (instances, positions,
// nets), so a change to a shared unit shows up here even when the count does not move.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { cam } from '../src/lib/storage';
import { CSR_UNIT, IO_UNIT, SYS_DECODE, TRAP_UNIT, sysDecode, csrUnit, systemCore, systemCpu } from '../src/lib/system';
import { stats } from '../src/sim/stats';
import type { ComponentDef } from '../src/sim/types';
import { measureCpu } from './verify/bench';

/** A hash of every distinct definition under `def`: ids, instance names, defs, positions, flips, labels, nets, pins. */
export function fingerprint(def: ComponentDef): string {
  const seen = new Map<string, string>();
  const walk = (d: ComponentDef) => {
    if (seen.has(d.id)) return;
    seen.set(d.id, '');
    const nl = d.netlist?.();
    if (!nl) { seen.set(d.id, JSON.stringify([d.id, d.prim ?? null, d.ports.map((p) => [p.name, p.width, p.dir])])); return; }
    for (const i of nl.instances) walk(i.def);
    seen.set(d.id, JSON.stringify([d.id, d.ports.map((p) => [p.name, p.width, p.dir]), nl.pins, nl.instances.map((i) => [i.name, i.def.id, i.at, i.flip, i.rot, i.label]),
      nl.nets.map((n) => [n.name, n.ends, n.tags, n.via, n.trunk, n.tagAt])]));
  };
  walk(def);
  const h = createHash('sha256');
  for (const k of [...seen.keys()].sort()) h.update(seen.get(k)!);
  return h.digest('hex').slice(0, 16);
}

const PROGRAM = [0x00100093, 0x00208133, 0x0000006f];

describe('the default system CPU is unchanged', () => {
  const cases: [string, () => ComponentDef][] = [
    ['sys', () => systemCpu(PROGRAM)],
    ['sys_m', () => systemCpu(PROGRAM, { m: true })],
    ['sys_bus', () => systemCpu(PROGRAM, { bus: true })],
    ['syscore', () => systemCore()],
    ['syscore_m', () => systemCore({ m: true })],
    ['csr', () => CSR_UNIT],
    ['csr_m', () => csrUnit(true)],
    ['trap', () => TRAP_UNIT],
    ['io', () => IO_UNIT],
    ['sysdec', () => SYS_DECODE],
    ['sysdec_m', () => sysDecode(true)],
    ['cam2x20', () => cam(2, 20)],
  ];
  it('keeps its ids, NAND counts and netlists', () => {
    const got: Record<string, [string, number, string]> = {};
    for (const [n, f] of cases) { const d = f(); got[n] = [d.id, stats(d).nands, fingerprint(d)]; }
    expect(got).toEqual(PINNED);
  });
  it('keeps the period the benchmark table quotes', () => {
    expect(measureCpu(systemCpu(PROGRAM)).period).toBe(PERIOD);
  });
});

const PINNED: Record<string, [string, number, string]> = {
  sys: ['sys_rom_42f163e1', 83387, '5714518cb019bb6c'],
  sys_m: ['sys_rom_42f163e1_m', 103965, '5373ba14dbca5f3f'],
  sys_bus: ['sys_rom_42f163e1_bus', 63790, '7de4f33c22629f41'],
  syscore: ['syscore', 46507, '9eeb3222fea0ab96'],
  syscore_m: ['syscore_m', 67085, '70e7039913fb7e6a'],
  csr: ['csrunit', 7127, '726fe05d9b321002'],
  csr_m: ['csrunit_m', 7127, 'e5324359782d8a92'],
  trap: ['trapunit', 1810, '67068621827780d6'],
  io: ['iounit', 3193, 'd7deab2bd9febcfe'],
  sysdec: ['sysdec', 1116, 'b1b4a1063bb5f94c'],
  sysdec_m: ['sysdec_m', 1168, 'a8d094ef64f14aa9'],
  cam2x20: ['cam4x20', 1851, 'c2b156522eaedfb3'],
};
const PERIOD = 126;
