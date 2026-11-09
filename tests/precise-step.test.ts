// Chapter 20's "Precise traps in a pipeline" quotes the campaign's pipelines: the NANDs and periods it types are measured here.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { rv16Pipe } from '../src/lib/rv16/pipe';
import { stats } from '../src/sim/stats';
import { NODES } from '../src/campaign/nodes';
import { chTraps } from '../src/chapters/ch-system';
import { groupDigits } from '../src/sim/numfmt';

describe('chapter 20: precise traps in a pipeline', () => {
  it('quotes Pipeline IV and V as built and graded', () => {
    const base = { fwd: true, stall: true, flush: true } as const;
    const plain = stats(rv16Pipe(base)).nands, exc = stats(rv16Pipe({ ...base, sys: 'exc' })).nands, sys = stats(rv16Pipe({ ...base, sys: true })).nands;
    const par = (id: string) => NODES.find((n) => n.id === id)!.par!;
    expect(par('pi_core3').nand).toBe(plain);
    expect(par('y_ptrap').nand).toBe(exc);
    const step = chTraps.steps.find((s) => s.title === 'Precise traps in a pipeline')!;
    const body = step.body.replace(/[ \t\n]+/g, ' ');
    expect(body).toContain(`from ${groupDigits(plain)} to ${groupDigits(exc)} NANDs`);
    expect(body).toContain(`its period from ${par('pi_core3').period} to ${par('y_ptrap').period} delays`);
    expect(body).toContain(`adds ${sys - exc} NANDs`);
    expect(chTraps.steps.indexOf(step)).toBe(10);
  }, 60000);
});
