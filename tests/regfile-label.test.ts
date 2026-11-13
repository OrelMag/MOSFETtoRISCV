// "FP REGISTERS" is the f register file's label only: a register file without a hard-wired zero also serves as the
// out-of-order core's data memory and as a vector lane's register slice, which hold integers (eyes pass, release 2.0).
import { describe, expect, it } from 'vitest';
import '../src/lib';
import { registry } from '../src/lib/define';
import { regfile } from '../src/lib/regfile';
import { dataMemory2 } from '../src/lib/ooo';
import { VEC_LANE } from '../src/lib/vector';
import { netlistOf, type ComponentDef } from '../src/sim/types';

const label = (d: ComponentDef) => d.symbol.label ?? d.name;
const child = (d: ComponentDef, name: string) => netlistOf(d)!.instances.find((i) => i.name === name)!.def;

describe('register file labels', () => {
  it('the f register files (three read ports, no x0) say FP', () => {
    expect(label(regfile(5, 32, false, 3))).toBe('FP REGISTERS');
    expect(regfile(5, 32, false, 3).name).toMatch(/^Floating-point/);
  });

  it('the integer files and the memories built on them do not', () => {
    for (const d of [regfile(5, 32), regfile(5, 32, true, 3), regfile(5, 32, false), child(dataMemory2(5), 'ram'), child(VEC_LANE, 'vrf')]) {
      expect(label(d)).toBe('REGISTERS');
      expect(d.name).not.toMatch(/Floating-point/);
    }
  });

  it('nothing registered says FP REGISTERS without a third read port', () => {
    const fp = [...registry.values()].filter((d) => d.symbol.label === 'FP REGISTERS');
    for (const d of fp) expect(d.ports.some((p) => p.name === 'ra3'), d.id).toBe(true);
  });
});
