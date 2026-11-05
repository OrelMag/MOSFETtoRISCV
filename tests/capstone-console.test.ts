// The serial console capstone: the reference passes the bench through the real challenge, and broken variants do not.

import { describe, expect, it } from 'vitest';
import { capstoneChallenge, capstoneRule } from '../src/campaign/capstone';
import { CONSOLE_ERR, readFrames, runConsole } from '../src/campaign/capcomm';
import { checkChallenge } from '../src/editor/challenges';
import { UserLibrary } from '../src/editor/library';
import { emptyWorkspace } from '../src/editor/model';
import { Builder } from '../src/lib/builder';
import { define, merger, ones, splitter } from '../src/lib/define';
import { NOT } from '../src/lib/gates';
import { TIE0 } from '../src/lib/transistors';
import { UART_CORE } from '../src/lib/uart';
import type { ComponentDef } from '../src/sim/types';

/** The core with an output changed, as a wrong design might have it. */
function mutant(name: string, change: (b: Builder) => void): ComponentDef {
  const ports = UART_CORE.ports.filter((p) => !['div', 'ie', 'tickOut'].includes(p.name));
  const ins = ports.filter((p) => p.dir === 'in').map((p) => p.name);
  return define({
    id: `console_mut_${name}`, name, category: 'sequential', summary: '', ports, symbol: { kind: 'box', label: 'M' },
    netlist: () => {
      const b = new Builder(10, 12);
      b.pins(...ins);
      const inst = b.add(UART_CORE, 'core', 'core');
      for (const p of ins) b.wire(p, `${inst}.${p}`);
      change(b);
      return { pins: Object.fromEntries(ports.map((p, i) => [p.name, [p.dir === 'in' ? 0 : b.right, i * 2]])) as Record<string, [number, number]>, instances: b.instances, nets: b.nets() };
    },
  });
}
const straight = (b: Builder, skip: string[]) => { for (const p of ['tx', 'rxData', 'status', 'irq']) if (!skip.includes(p)) b.wire(`core.${p}`, p); };
/** status with one bit held at 0. */
const statusWithout = (bit: number) => (b: Builder) => {
  straight(b, ['status']);
  const sp = b.op(splitter(ones(8)), ['core.status'], undefined, 'sp'), zero = b.op(TIE0, [], undefined, 'zero');
  b.wire(b.op1(merger(ones(8)), Array.from({ length: 8 }, (_, i) => (i === bit ? `${zero}.y` : `${sp}.o${i}`))), 'status');
};

describe('the console capstone', () => {
  it('the reference passes, drawn as a chip and checked as a learner\'s would be, within its allowed parts', () => {
    const ch = capstoneChallenge('cap_console')!;
    expect(capstoneRule('cap_console')).toBeTruthy();
    const chips = ch.answer();
    const ws = { ...emptyWorkspace(), chips: Object.fromEntries(chips.map((d) => [d.id, d])) };
    const r = checkChallenge(ch, new UserLibrary(ws).compiled(chips[chips.length - 1].id));
    expect(r.restrictionViolations).toEqual([]);
    expect(r.failures ?? []).toEqual([]);
    expect(r.ok).toBe(true);
  }, 120_000);
  it('the library core passes the bench directly', () => {
    expect(runConsole(UART_CORE, 'gate').failures).toEqual([]);
  }, 60_000);
  it('a wrong design fails, and the bench says what was wrong', () => {
    const cases: [string, (b: Builder) => void, RegExp][] = [
      ['txinv', (b) => { straight(b, ['tx']); b.wire(b.op1(NOT, ['core.tx']), 'tx'); }, /far end|idle|stop/],
      ['noirq', (b) => { straight(b, ['irq']); const z = b.op(TIE0, [], undefined, 'zero'); b.wire(`${z}.y`, 'irq'); }, /irq is low/],
      ['nofull', statusWithout(1), /never reported full/],
      ['noover', statusWithout(4), /overrun/],
      ['noferr', statusWithout(3), /framing/],
      ['noidle', statusWithout(2), /idle/],
      ['norxne', statusWithout(0), /gave|waiting/],
    ];
    for (const [name, change, want] of cases) {
      const r = runConsole(mutant(name, change), 'gate');
      expect(r.failures.join(' | '), name).toMatch(want);
    }
  }, 120_000);
  it('the far end reads a clean recording, and notices a bad stop bit', () => {
    const frame = (b: number, stop = 1) => [0, ...Array.from({ length: 8 }, (_, i) => (b >> i) & 1), stop].flatMap((v) => new Array<number>(16).fill(v));
    expect(readFrames([1, 1, ...frame(0x5a), ...frame(0xa5), 1, 1], 16).bytes).toEqual([0x5a, 0xa5]);
    expect(readFrames([1, ...frame(0x5a, 0), 1, 1, 1], 16).bad.join()).toContain('stop');
    expect(CONSOLE_ERR).toBeGreaterThan(0);
  });
});
