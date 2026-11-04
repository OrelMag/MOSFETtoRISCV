// Act 12 (Links): the benches name what a wrong circuit gets wrong. Each reference passes (tests/campaign.test.ts runs them); here are
// the circuits that nearly do.

import { describe, expect, it } from 'vitest';
import { levelChallenge } from '../src/campaign/levels';
import { nodeById } from '../src/campaign/nodes';
import { checkChallenge } from '../src/editor/challenges';
import type { Compiled } from '../src/editor/compile';
import { ENC8B10B } from '../src/lib/serdes';
import { define } from '../src/lib/define';
import { syncN } from '../src/lib/sync';
import { TELEGRAPH_RELAY } from '../src/lib/telegraph';
import { GND, TIE0 } from '../src/lib/transistors';
import { UART_TX } from '../src/lib/uart';
import type { ComponentDef } from '../src/sim/types';
import { netlistOf } from '../src/sim/types';
import { crcNext, crcUnit } from '../src/lib/crc';
import { CDR } from '../src/lib/serdes';
import { i2cController } from '../src/lib/i2c';
import { DIAL_SELECTOR } from '../src/lib/telegraph';
import { UART_RX } from '../src/lib/uart';
import { bitwise } from '../src/lib/wide';
import { force, hold, swap, tie } from './mutate';

const compiled = (def: ComponentDef, mode: 'gate' | 'switch'): Compiled =>
  ({ def, diags: [], mode, netOfWire: new Map(), netOfEnd: new Map(), netOfLabel: new Map() }) as unknown as Compiled;
const check = (id: string, def: ComponentDef, mode: 'gate' | 'switch' = 'gate') => checkChallenge(levelChallenge(nodeById(id)!)!, compiled(def, mode));

describe('act 12 benches', () => {
  it('l_sync: one flip-flop fails the port\'s failure rate, three pass with a cycle more', () => {
    const one = check('l_sync', syncN(1));
    expect(one.ok).toBe(false);
    expect(one.failures.join(' ')).toMatch(/fails about once in .* days; the port needs 100 years/);
    const three = check('l_sync', syncN(3));
    expect(three.failures).toEqual([]);
    expect(three.score.cycles).toBe(3);
  });

  it('l_repeater: a wire from line to out passes the table but not the sections', () => {
    const wire = define({
      id: 't_wire_rep', name: 'wire', category: 'sequential', summary: 'x',
      ports: [{ name: 'line', width: 1, dir: 'in' }, { name: 'out', width: 1, dir: 'out' }],
      symbol: { kind: 'box', label: 'W', w: 6, h: 4 },
      netlist: () => ({ level: 'switch', pins: { line: [0, 2], out: [10, 2] }, instances: [{ name: 'g', def: GND, at: [3, 8] }], nets: [{ name: 'w', ends: ['line', 'out'] }, { name: 'gg', ends: ['g.p'] }] }),
    });
    const r = check('l_repeater', wire, 'switch');
    expect(r.failures.join(' ')).toMatch(/joined to line.*margin of 0\.\d\d/);
    expect(check('l_repeater', TELEGRAPH_RELAY, 'switch').failures).toEqual([]);
  });

  it('l_uarttx: the reference frames a byte at every divisor', () => {
    expect(check('l_uarttx', UART_TX).failures).toEqual([]);
  });

  it('l_8b10b: an encoder deaf to the running disparity breaks the line balance, and the bench says where', () => {
    const deaf = define({
      id: 't_enc_deaf', name: 'deaf', category: 'gate', summary: 'x',
      ports: ENC8B10B.ports,
      symbol: { kind: 'box', label: 'E', w: 8, h: 14 },
      netlist: () => ({
        pins: { d: [0, 2], k: [0, 4], rd: [0, 6], code: [20, 2], rdout: [20, 4] },
        instances: [{ name: 'e', def: ENC8B10B, at: [6, 2] }, { name: 'z', def: TIE0, at: [0, 12] }],
        nets: [
          { name: 'd', ends: ['d', 'e.d'] }, { name: 'k', ends: ['k', 'e.k'] }, { name: 'z', ends: ['z.y', 'e.rd'] },
          { name: 'code', ends: ['e.code', 'code'] }, { name: 'rdout', ends: ['e.rdout', 'rdout'] }, { name: 'rdin', ends: ['rd'] },
        ],
      }),
    });
    const r = check('l_8b10b', deaf);
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toMatch(/RD\+|running disparity|disparity/);
  });
});

const bad = (id: string, def: ComponentDef, mode: 'gate' | 'switch' = 'gate'): string => {
  const r = check(id, def, mode);
  expect(r.ok, `${id}: the mutant must not pass`).toBe(false);
  return r.failures.join(' | ');
};
const sub = (def: ComponentDef, name: string): ComponentDef => netlistOf(def)!.instances.find((i) => i.name === name)!.def;

describe('act 12 benches reject wrong circuits, each with a named rule', () => {
  it('l_uarttx', () => {
    expect(bad('l_uarttx', hold(UART_TX, 'tick', 1))).toMatch(/divisor \d: /);
    expect(bad('l_uarttx', tie(UART_TX, 'u3.b', 1))).toMatch(/accepted|taken = \d with go = 1 and busy = 1/);
    expect(bad('l_uarttx', tie(UART_TX, 'u8.i2', 1))).toMatch(/stop bit|busy fell at cycle/);
    expect(bad('l_uarttx', tie(UART_TX, 'u7.i1', 1))).toMatch(/each bit lasts 16/);
  });

  it('l_uartrx', () => {
    expect(bad('l_uartrx', tie(UART_RX, 'u12.b', 1))).toMatch(/glitches on an idle line: pushed .*middle of the start bit/);
    expect(bad('l_uartrx', tie(UART_RX, 'u17.b', 0))).toMatch(/framing error, then a break: .*ferr/);
    expect(bad('l_uartrx', tie(UART_RX, 'u25.b', 0))).toMatch(/sender|nominal/);
  });

  it('l_crc', () => {
    const unit = crcUnit(32, undefined, 8);
    expect(bad('l_crc', swap(unit, 'fc', bitwise('and', 32)))).toMatch(/fcs is the complement of q/);
    expect(bad('l_crc', swap(unit, 'step', crcNext(32, 0x82f63b78, 8, true)))).toMatch(/q = 0x[0-9a-f]{8}, expected 0x[0-9a-f]{8}/);
    expect(bad('l_crc', hold(unit, 'init', 0))).toMatch(/after init/);
    expect(bad('l_crc', tie(unit, 'ld.a', 0))).toMatch(/after byte|with en = 0/);
    // another gate-level arrangement of the same function passes: the bench checks the function, not the layout
    expect(check('l_crc', swap(unit, 'step', crcNext(32, undefined, 8, false))).failures).toEqual([]);
  });

  it('l_cdr', () => {
    const noEarly = hold(CDR, 'u3.y', 0), noTrack = hold(noEarly, 'u4.y', 0);
    expect(bad('l_cdr', noTrack)).toMatch(/drifting|fast|slow/);
  });

  it('l_i2c', () => {
    const top = i2cController();
    expect(bad('l_i2c', swap(top, 'dec', force(sub(top, 'dec'), 'g52.y', 0)))).toMatch(/arbitration lost at address bit \d.*(lost|ready) = \d, expected \d/);
    expect(bad('l_i2c', swap(top, 'smp', hold(sub(top, 'smp'), 'scl_i', 1)))).toMatch(/stretch|scl_o|sda_o|ready/);
    expect(bad('l_i2c', force(top, 'seq.ack', 0))).toMatch(/ack = 0, expected 1/);
  });

  it('l_dial', () => {
    expect(bad('l_dial', tie(DIAL_SELECTOR, 'st0.p', 0), 'switch')).toMatch(/dialling \d, pulse 1 (up|down)/);
    expect(bad('l_dial', tie(DIAL_SELECTOR, 'hr.a', 1), 'switch')).toMatch(/with nothing dialled|hang-up|dialling/);
  });
});
