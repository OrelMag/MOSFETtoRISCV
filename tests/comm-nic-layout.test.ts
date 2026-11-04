// The NIC and the scene's circuits as drawings: no overlapping labels or symbols, no backward wires, nothing dead, and Open in Sandbox works.
// (They are built here, not registered at import: the registry-wide route and layout tests never see them.)

import { describe, expect, it } from 'vitest';
import { DEFAULT_STACK } from '../src/comm/stack/all';
import { stackProgram } from '../src/comm/stack';
import { hostApp } from '../src/comm/stack/apps';
import { emptyWorkspace } from '../src/editor/model';
import { remixDef } from '../src/editor/remix';
import { lanComputers, lanSoc, nicLoopback } from '../src/lib/lan';
import { nic } from '../src/lib/nic';
import { busComputer } from '../src/lib/soc';
import { deadInstances } from '../src/sim/dead';
import { netlistOf, type ComponentDef } from '../src/sim/types';
import { backwardEnds, labelOverlaps, routeNetlist, symbolOverlaps, wireOverlaps } from '../src/view/route';

const prog = stackProgram(DEFAULT_STACK, hostApp()).compiled.words;
const subs = (d: ComponentDef, seen = new Map<string, ComponentDef>()): ComponentDef[] => {
  if (seen.has(d.id)) return [];
  seen.set(d.id, d);
  for (const i of netlistOf(d)?.instances ?? []) subs(i.def, seen);
  return [...seen.values()];
};

describe('the NIC, block by block', () => {
  const parts = subs(nic()).filter((d) => d.id === 'nic' || d.id.startsWith('nic_'));
  it('is made of boxes named for what they do', () => {
    expect(parts.map((d) => d.id).sort()).toEqual(['nic', 'nic_dma', 'nic_regs', 'nic_rx', 'nic_tx']);
  });
  it.each(parts.map((d) => [d.id, d] as const))('%s: labels, symbols, wires', (_, d) => {
    const nl = netlistOf(d)!;
    expect(labelOverlaps(d, nl)).toEqual([]);
    expect(symbolOverlaps(nl)).toEqual([]);
    expect(wireOverlaps(routeNetlist(d, nl).nets)).toEqual([]);
    expect(deadInstances(nl, d.ports)).toEqual([]);
  }, 120000);
});

describe('the scene circuits', () => {
  const tops = [lanComputers(prog, prog), nicLoopback(prog), busComputer(prog, [0], lanSoc(12)), nic()];
  it.each(tops.map((d) => [d.id, d] as const))('%s: no overlapping labels or symbols, nothing dead, and Open in Sandbox works', (_, d) => {
    const nl = netlistOf(d)!;
    expect(labelOverlaps(d, nl)).toEqual([]);
    expect(symbolOverlaps(nl)).toEqual([]);
    expect(backwardEnds(d, nl)).toEqual([]);
    expect(deadInstances(nl, d.ports)).toEqual([]);
    const r = remixDef(emptyWorkspace(), d);
    expect('error' in r ? r.error : '').toBe('');
  }, 300000);
});
