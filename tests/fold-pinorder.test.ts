// A folded drawing keeps its pin order. Pins are bound to nets by name, so a fold can never attach one to a wrong net; but a level
// drawn as a chip (docFromDef) compiles its ports in pin order (editor/chips.ts pinOrder), and a bench may bind them by position:
// layered's aspect fold placing pins by height alone wired a pipeline bench's clk to instr.
import { describe, expect, it } from 'vitest';
import '../src/lib/index';
import '../src/campaign/nodes';
import { Builder } from '../src/lib/builder';
import { define } from '../src/lib/define';
import { NOT, XOR } from '../src/lib/gates';
import { layered } from '../src/lib/layered';
import { registry } from '../src/lib/define';
import type { PortDef } from '../src/sim/types';
import { netlistOf } from '../src/sim/types';

const side = (pins: Record<string, [number, number]>, names: string[]) => names.filter((n) => pins[n]).sort((a, b) => pins[a][1] - pins[b][1]);

describe('a folded drawing keeps its pin order', () => {
  it('layered: the aspect fold places pins in pinOrder, not by the height of what they feed', () => {
    // a long chain (folds at aspect 1.6) whose inputs feed it in the reverse of their port order
    const ins = ['a', 'b', 'c', 'd'];
    const ports: PortDef[] = [...ins.map((n) => ({ name: n, width: 1, dir: 'in' as const })), { name: 'y', width: 1, dir: 'out' }];
    const b = new Builder(8, 6);
    b.pins(...ins);
    let x = 'd';
    for (let i = 0; i < 24; i++) { x = b.op1(i % 2 ? NOT : XOR, i % 2 ? [x] : [x, ins[(i / 2) % 4 | 0]]); b.next(); }
    b.wire(x, 'y');
    const nl = layered(ports, b, { aspect: 1.6, pinOrder: ['d', 'c', 'b', 'a', 'y'] });
    const xs = nl.instances.map((i) => i.at![1]);
    expect(Math.max(...xs) - Math.min(...xs), 'folded into bands').toBeGreaterThan(10);
    expect(side(nl.pins!, ins)).toEqual(['d', 'c', 'b', 'a']);
    void define;
  });

  it('the RV16 cores laid out by logic depth keep the order their fold drew (the campaign benches wire to it)', () => {
    const left = ['clk', 'rst', 'instr', 'drdata', 'irq'], right = ['pc', 'daddr', 'dwdata', 'dwe', 'rwe', 'rwa', 'rwd'];
    const ids = [...registry.keys()].filter((k) => /^rv16_(cpu|pipe_)/.test(k));
    expect(ids.length).toBeGreaterThan(8);
    for (const id of ids) {
      const pins = netlistOf(registry.get(id)!)!.pins!;
      expect(side(pins, left), id).toEqual(left.filter((n) => pins[n]));
      expect(side(pins, right), id).toEqual(right.filter((n) => pins[n]));
    }
  });
});
