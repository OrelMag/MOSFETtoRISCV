// The Statistics tab's rows: each is its component's own statistics, opens where a click should go
// (the workbench by id, a chapter for a chapter's CPU), and the tab's route is no component's id.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { registry } from '../src/lib/define';
import { measure } from '../src/lib/hwstats';
import { resolveComponent } from '../src/lib/resolve';
import { referenceCpus } from '../src/lib/usage';
import { logicDepth, stats } from '../src/sim/stats';

describe('hardware statistics', () => {
  it('measure a combinational part, a clocked part and a transistor circuit', () => {
    const fa = measure(registry.get('full_adder')!);
    expect(fa).toMatchObject({ nands: 9, transistors: 36, depth: logicDepth(registry.get('full_adder')!), period: null, route: '#/workbench/full_adder' });
    const reg = measure(resolveComponent('reg8')!);
    expect(reg.depth).toBeNull();
    expect(reg.period).toBeGreaterThan(0);
    expect(reg.family?.id).toBe('reg');
    const inv = measure(registry.get('inv_cmos')!);
    expect(inv).toMatchObject({ switchLevel: true, depth: null, period: null, transistors: 2 });
  });

  it('send a chapter CPU to its chapter, with its own totals', () => {
    const c = referenceCpus()[0];
    const r = measure(c.def);
    expect(r.cpu).toBe(true);
    expect(r.route).toBe(c.route);
    expect(r.nands).toBe(stats(c.def).nands);
  });

  it('keep #/workbench/stats free for the tab', () => {
    expect(resolveComponent('stats')).toBeUndefined();
  });
});
