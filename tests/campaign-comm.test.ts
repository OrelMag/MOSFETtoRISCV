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
import { ethMacFd, swBrain } from '../src/lib/ethlevels';
import { macRx, macTx } from '../src/lib/ethernet';

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

/** A definition rebuilt with the instance at `path` (names, outermost first) edited. */
const inside = (def: ComponentDef, path: string[], edit: (d: ComponentDef) => ComponentDef): ComponentDef =>
  path.length ? swap(def, path[0], inside(sub(def, path[0]), path.slice(1), edit)) : edit(def);
/** The end that drives the net `name` of a definition (a builder's nets list the driver first). */
const driver = (def: ComponentDef, name: string): string => netlistOf(def)!.nets.find((n) => n.name === name)!.ends[0];

describe('act 12 Ethernet benches reject wrong circuits, each with a named rule', () => {
  const mac = ethMacFd(), sw = swBrain();
  it('l_mac sending', () => {
    const txctl = inside(mac, ['tx', 'ctl'], (d) => d);
    void txctl;
    expect(bad('l_mac', inside(mac, ['tx', 'crc'], (d) => swap(d, 'crc', crcUnit(32, 0x82f63b78, 8))))).toMatch(/FCS byte 1 is 0x[0-9a-f]{2}, expected/);
    expect(bad('l_mac', inside(mac, ['tx', 'ctl'], (d) => force(d, driver(d, 'nb2'), 1)))).toMatch(/pad byte [0-9]+ is 0x[0-9a-f]{2}, expected 0x00/);
    expect(bad('l_mac', inside(mac, ['tx', 'ctl'], (d) => force(d, driver(d, 'pc7'), 1)))).toMatch(/preamble byte 2 is 0x[0-9a-f]{2}, expected 0x55/);
    expect(bad('l_mac', hold(mac, 'valid', 0))).toMatch(/0 of the [0-9]+ frames came out/);
  });
  it('l_mac receiving', () => {
    expect(bad('l_mac', inside(mac, ['rx'], (d) => force(d, 'pipe.crc_ok', 1)))).toMatch(/damaged but rerr = 0/);
    expect(bad('l_mac', inside(mac, ['rx', 'pipe'], (d) => swap(d, 'crc', crcUnit(32, 0x82f63b78, 8))))).toMatch(/good frame but rerr = 1/);
    expect(bad('l_mac', inside(mac, ['rx'], (d) => force(d, 'pipe.crc_ok', 0)))).toMatch(/good frame but rerr = 1/);
    // the receiver before the shift register was cleared between frames: a frame after one whose FCS ended in 0xAA or 0xAB is read a bit off
    const stale = swap(mac, 'rx', macRx(true));
    expect(bad('l_mac', stale)).toMatch(/receiving frames after one whose FCS ends in 0xAA and 0xAB: .*good frame but rerr = 1.*start every frame clean/);
    void macTx;
  });
  it('l_switch', () => {
    expect(bad('l_switch', force(sw, 'look.flood', 1))).toMatch(/destination is known: send the frame out of its port alone/);
    expect(bad('l_switch', tie(sw, 'learn.go', 0))).toMatch(/destination is unknown|heard only|mask = /);
    expect(bad('l_switch', tie(tie(sw, 'mask.inport0', 0), 'mask.inport1', 0))).toMatch(/back out of port [0-9], the one it came in on/);
    expect(bad('l_switch', tie(sw, 'mask.bad', 0))).toMatch(/bad FCS goes nowhere/);
    expect(bad('l_switch', tie(sw, 'learn.bad', 0))).toMatch(/heard only in a damaged frame/);
    expect(bad('l_switch', force(sw, 'look.flood', 0))).toMatch(/destination is unknown/);
  });
});
