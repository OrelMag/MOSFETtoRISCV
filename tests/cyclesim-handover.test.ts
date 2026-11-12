// The cycle engine hands a settle to GateSim when a cluster ends where its table cannot follow (CycleSim.tainted). The
// values it wrote in that settle are then GateSim's to check: before the fix, gates the cluster finder had folded into
// the cluster were left contradicting their inputs (a = b = 1, y = 1) with no event pending, so the wrong value stayed on
// the wire for settles. Release review 2026-11-12, R1.
import { describe, expect, it } from 'vitest';
import '../src/lib';
import { NAND } from '../src/lib/transistors';
import { NOT } from '../src/lib/gates';
import { DFF } from '../src/lib/sequential';
import { DFF_R } from '../src/lib/seqparts';
import type { ComponentDef, NetDef, PortDef } from '../src/sim/types';
import { lockstep, rng } from './cyclekit';
import { tick } from './yieldtick';

const pin = (name: string, dir: 'in' | 'out'): PortDef => ({ name, width: 1, dir });
const chip = (id: string, ports: PortDef[], instances: { name: string; def: ComponentDef }[], nets: NetDef[]): ComponentDef =>
  ({ id, name: id, category: 'misc', ports, symbol: { kind: 'box' }, netlist: () => ({ instances, nets }) }) as unknown as ComponentDef;

/** The smallest circuit the fuzz found (shrunk from a random one): three flip-flops and five NANDs on one clock. */
const MINIMAL = chip('handover_minimal',
  [pin('i0', 'in'), pin('i1', 'in'), pin('i2', 'in'), pin('clk', 'in'), pin('o2', 'out')],
  [...['g2', 'g3', 'g7', 'g8', 'g11'].map((name) => ({ name, def: NAND })), ...['f0', 'f2', 'f3'].map((name) => ({ name, def: DFF }))],
  [
    { ends: ['i0', 'g11.a', 'o2'] },
    { ends: ['i1', 'g11.b'] },
    { ends: ['f0.q', 'g7.a', 'g2.b'] },
    { ends: ['f2.q', 'g2.a', 'g8.b'] },
    { ends: ['f3.q', 'g3.a'] },
    { ends: ['g2.y', 'g3.b', 'g7.b'] },
    { ends: ['g3.y', 'g8.a'] },
    { ends: ['g8.y', 'f0.d', 'f3.d'] },
    { ends: ['clk', 'f0.clk', 'f2.clk', 'f3.clk'] },
    { ends: ['g11.y', 'f2.d'] },
  ]);

/** I inputs and clk, F flip-flops, G NANDs wired acyclically from the inputs, the q's and earlier gates, O outputs; a
 *  clock through clkInv inverters on every third flip-flop; async resets on every other one. */
function randomCircuit(seed: number, o: { I: number; F: number; G: number; O: number; clkInv: number; reset: boolean }): ComponentDef {
  const r = rng(seed);
  const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)];
  const ports = [
    ...Array.from({ length: o.I }, (_, i) => pin(`i${i}`, 'in')), pin('clk', 'in'),
    ...(o.reset ? [pin('rst_n', 'in')] : []), ...Array.from({ length: o.O }, (_, i) => pin(`o${i}`, 'out')),
  ];
  const sinks = new Map<string, string[]>();
  const add = (drv: string, sink: string) => { if (!sinks.has(drv)) sinks.set(drv, []); sinks.get(drv)!.push(sink); };
  const instances: { name: string; def: ComponentDef }[] = [];
  const sources = [...Array.from({ length: o.I }, (_, i) => `i${i}`), ...Array.from({ length: o.F }, (_, i) => `f${i}.q`)];
  for (let g = 0; g < o.G; g++) {
    instances.push({ name: `g${g}`, def: NAND });
    add(pick(sources), `g${g}.a`);
    add(pick(sources), `g${g}.b`);
    sources.push(`g${g}.y`);
  }
  let clk = 'clk';
  for (let k = 0; k < o.clkInv; k++) { instances.push({ name: `c${k}`, def: NOT }); add(clk, `c${k}.a`); clk = `c${k}.y`; }
  for (let f = 0; f < o.F; f++) {
    instances.push({ name: `f${f}`, def: o.reset && f % 2 ? DFF_R : DFF });
    add(pick(sources), `f${f}.d`);
    add(f % 3 === 2 && o.clkInv ? clk : 'clk', `f${f}.clk`);
    if (o.reset && f % 2) add('rst_n', `f${f}.rst_n`);
  }
  for (let k = 0; k < o.O; k++) add(pick(sources), `o${k}`);
  return chip(`handover_${seed}`, ports, instances, [...sinks].map(([d, s]) => ({ ends: [d, ...s] })));
}

describe('the cycle engine hands a tainted settle to GateSim exactly', () => {
  it('the smallest circuit found: every net equals GateSim after every settle, in every power-on mode', () => {
    lockstep(MINIMAL, 120, 7001347, ['zero', 'x', 'random']);
  });

  // A seed range with known failures before the fix (the "bigger" kind at circuit 147 failed in every power-on mode).
  const KINDS = [
    ['plain', { I: 3, F: 4, G: 14, O: 3, clkInv: 0, reset: false }],
    ['delayed', { I: 3, F: 6, G: 18, O: 3, clkInv: 2, reset: false }],
    ['reset', { I: 2, F: 5, G: 14, O: 2, clkInv: 0, reset: true }],
    ['bigger', { I: 5, F: 10, G: 50, O: 4, clkInv: 0, reset: true }],
  ] as const;
  const OFF = 7_000_000, N = 200;
  for (const [label, o] of KINDS) {
    it(`random circuits (${label}): every net equals GateSim after every settle`, async () => {
      const failed: string[] = [];
      for (let s = 1; s <= N; s++) {
        try { lockstep(randomCircuit(1000 * s + label.length + OFF, o), 120, s + OFF); } catch (e) { failed.push(`circuit ${s}: ${(e as Error).message}`); }
        if (s % 10 === 0) await tick();
      }
      expect(failed).toEqual([]);
    }, 300_000);
  }
});
