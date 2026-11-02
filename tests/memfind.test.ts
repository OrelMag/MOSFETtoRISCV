import { describe, expect, it } from 'vitest';
import { levelChallenge } from '../src/campaign/levels';
import { nodeById } from '../src/campaign/nodes';
import { CHALLENGES } from '../src/editor/challengeset';
import { UserLibrary } from '../src/editor/library';
import { constWord } from '../src/lib/alu';
import { bigRam } from '../src/lib/bigmem';
import { Builder } from '../src/lib/builder';
import { cachedMemory } from '../src/lib/cache';
import { wbCache } from '../src/lib/cache2';
import { splitter } from '../src/lib/define';
import { bankedMemory } from '../src/lib/lsu';
import { ram } from '../src/lib/memory';
import { portMemory } from '../src/lib/portmem';
import { regfile, regfile2w } from '../src/lib/regfile';
import { DEC3, RF8, RV16_MUX8, RV16_REG16 } from '../src/lib/rv16/logic';
import { romArray } from '../src/lib/storage';
import { simulate } from '../src/sim/harness';
import type { ComponentDef } from '../src/sim/types';
import { findMemories, memMarks, noStorage, rowLabel, wordValue } from '../src/view/memfind';
import { workspace } from './editorkit';

const found = (def: ComponentDef) => {
  const sim = simulate(def);
  sim.reset('zero');
  return { sim, mems: findMemories(sim) };
};
const shape = (def: ComponentDef) => found(def).mems.map((m) => `${m.path || '(root)'} ${m.words}×${m.width} ${m.src.kind}${m.built ? ' built' : ''}`);

/** A clocked write of `v` at `a` through the memory's own pins, then the value it reads back. */
const pulse = (sim: ReturnType<typeof simulate>, inputs: Record<string, number>) => {
  for (const [k, v] of Object.entries(inputs)) sim.setInput(k, v);
  sim.settle();
  sim.setInput('clk', 1); sim.settle();
  sim.setInput('clk', 0); sim.settle();
};

/** RF8 with x7's enable taken from x6's decoder output: rd = 6 writes both, rd = 7 none. */
const MISWIRED: ComponentDef = (() => {
  const b = new Builder(8, 14, 6);
  b.pins('wa', 'we', 'wd', 'ra1', 'ra2', 'clk');
  const dec = b.op1(DEC3, ['wa', 'we']);
  const zero = b.op1(constWord(16, 0), []);
  b.next();
  const en = b.op(splitter(Array(8).fill(1), 2), [dec]);
  b.next();
  const qs = [zero];
  for (let i = 1; i < 8; i++) qs.push(`${b.op(RV16_REG16, ['wd', `${en}.o${Math.min(i, 6)}`, 'clk'], `x${i}`, `r${i}`)}.q`);
  b.next();
  b.wire(b.op1(RV16_MUX8, [...qs, 'ra1']), 'rd1');
  b.wire(b.op1(RV16_MUX8, [...qs, 'ra2']), 'rd2');
  return {
    id: 'test_rf_miswired', name: 'miswired', category: 'memory', ports: RF8.ports, symbol: { kind: 'box', label: 'RF' },
    netlist: () => ({ pins: Object.fromEntries(['wa', 'we', 'wd', 'ra1', 'ra2', 'clk', 'rd1', 'rd2'].map((n, i) => [n, [0, 4 * i]])), instances: b.instances, nets: b.nets() }),
  } as ComponentDef;
})();

const compiledAnswer = (chips: ReturnType<NonNullable<ReturnType<typeof levelChallenge>>['answer']>) => {
  const main = chips[chips.length - 1];
  return new UserLibrary(workspace(main, ...chips.slice(0, -1))).compiled(main.id)!.def;
};

describe('findMemories', () => {
  it('finds each library memory once, at its own node', () => {
    expect(shape(ram(2, 4))).toEqual(['(root) 4×4 regs']);
    expect(shape(regfile(3, 8))).toEqual(['(root) 8×8 regs']);
    expect(shape(regfile2w(3, 8))).toEqual(['(root) 8×8 regs']);
    expect(shape(RF8)).toEqual(['(root) 8×16 regs built']);
    expect(shape(bigRam(8, 8))).toEqual(['(root) 256×8 big']);
    expect(shape(portMemory(4, 8, 2))).toEqual(['(root) 16×8 regs']);
    expect(shape(bankedMemory(4))).toEqual(['(root) 16×32 banked']);
    expect(shape(cachedMemory())).toEqual(['tags 4×3 regs', 'data 16×32 regs', 'ram 64×32 regs']);
    expect(shape(wbCache(6, 2, 2))).toEqual(['way0.tags 4×4 regs', 'way0.data 16×32 regs', 'way1.tags 4×4 regs', 'way1.data 16×32 regs', 'ram 64×32 regs']);
  });

  it('a ROM is no memory', () => {
    expect(shape(romArray('squares'))).toEqual([]);
  });

  it('labels a register file x<i> with x0 storage-less, a RAM [i], a large one in hex', () => {
    const rf = found(regfile(3, 8)).mems[0];
    expect([rowLabel(rf, 0), rowLabel(rf, 5), noStorage(rf, 0), noStorage(rf, 5)]).toEqual(['x0', 'x5', true, false]);
    const r = found(ram(2, 4)).mems[0];
    expect([rowLabel(r, 3), noStorage(r, 0)]).toEqual(['[3]', false]);
    expect(rowLabel(found(bigRam(8, 8)).mems[0], 0xf5)).toBe('[F5]');
  });

  it('reads words live and marks the read and the next write from the memory\'s own ports', () => {
    const { sim, mems: [m] } = found(regfile(3, 8));
    pulse(sim, { wa: 5, wd: 0x42, we: 1 });
    expect(wordValue(sim, m, 5)).toBe(0x42);
    sim.setInput('ra1', 5); sim.setInput('ra2', 2); sim.setInput('wa', 3); sim.settle();
    expect(memMarks(sim, m)).toEqual({ read: [5, 2], write: [3] });
    sim.setInput('wa', 0); sim.settle();
    expect(memMarks(sim, m).write).toEqual([]); // x0 is never written
    sim.setInput('we', 0); sim.setInput('wa', 3); sim.settle();
    expect(memMarks(sim, m).write).toEqual([]);
  });

  it('a large RAM\'s words come from its leaf state', () => {
    const { sim, mems: [m] } = found(bigRam(8, 8));
    pulse(sim, { addr: 0xf5, din: 0x5a, we: 1 });
    expect(wordValue(sim, m, 0xf5)).toBe(0x5a);
  });

  it('finds rv16_rf by probing: x1 … x7 at their addresses, x0 without storage', () => {
    const { sim, mems: [m] } = found(RF8);
    expect(m.prefix).toBe('x');
    expect(m.built!.problems).toEqual([]);
    expect([...m.built!.names.keys()]).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(noStorage(m, 0)).toBe(true);
    pulse(sim, { wa: 6, wd: 0x1337, we: 1 });
    expect(Array.from({ length: 8 }, (_, i) => wordValue(sim, m, i))).toEqual([-1, 0, 0, 0, 0, 0, 0x1337, 0]);
    sim.setInput('wa', 4); sim.setInput('ra1', 6); sim.settle();
    expect(memMarks(sim, m)).toEqual({ read: [6, 0], write: [4] });
  });

  it('names a decoder wired to the wrong register', () => {
    const [m] = found(MISWIRED).mems;
    expect(m.built!.problems).toEqual(['wa = 6 writes 2 words (x6, x7)']);
    expect(noStorage(m, 6)).toBe(true);
    expect(noStorage(m, 5)).toBe(false);
  });

  it.each(['m_rf'])('finds the campaign level %s\'s reference answer as a memory', (id) => {
    const def = compiledAnswer(levelChallenge(nodeById(id)!)!.answer());
    const { mems } = found(def);
    expect(mems.map((m) => [m.path, m.words, m.width, m.built?.problems])).toEqual([['', 8, 16, []]]);
  });

  it('finds the sandbox challenge m_ram\'s reference answer as a memory', () => {
    const def = compiledAnswer(CHALLENGES.find((c) => c.id === 'm_ram')!.answer());
    const { sim, mems } = found(def);
    expect(mems.map((m) => [m.path, m.words, m.width])).toEqual([['', 4, 4]]);
    pulse(sim, { addr: 2, d: 0x9, we: 1 });
    expect(Array.from({ length: 4 }, (_, i) => wordValue(sim, mems[0], i))).toEqual([0, 0, 9, 0]);
  });
});
