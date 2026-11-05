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
import { ethMacFd, fwdPath, swBrain } from '../src/lib/ethlevels';
import { HOST_REF, HOST_STARTER } from '../src/campaign/hostbench';
import { checkOf, FWD_LANES } from '../src/campaign/fwdcheck';
import { stats } from '../src/sim/stats';
import { DRIVER_REF, DRIVER_STARTER } from '../src/campaign/nicbench';
import { PUZZLES, runPuzzle } from '../src/campaign/puzzles';
import { macRx, macTx } from '../src/lib/ethernet';
import { tick } from './yieldtick';

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

// Each mutant runs a whole bench on gates, some 10 s apiece on CI's runner: a macrotask between them (tests/yieldtick.ts).
const MUTANTS_MS = 240_000;

describe('act 12 Ethernet benches reject wrong circuits, each with a named rule', () => {
  const mac = ethMacFd(), sw = swBrain();
  it('l_mac sending', async () => {
    const txctl = inside(mac, ['tx', 'ctl'], (d) => d);
    void txctl;
    expect(bad('l_mac', inside(mac, ['tx', 'crc'], (d) => swap(d, 'crc', crcUnit(32, 0x82f63b78, 8))))).toMatch(/FCS byte 1 is 0x[0-9a-f]{2}, expected/);
    await tick();
    expect(bad('l_mac', inside(mac, ['tx', 'ctl'], (d) => force(d, driver(d, 'nb2'), 1)))).toMatch(/pad byte [0-9]+ is 0x[0-9a-f]{2}, expected 0x00/);
    await tick();
    expect(bad('l_mac', inside(mac, ['tx', 'ctl'], (d) => force(d, driver(d, 'pc7'), 1)))).toMatch(/preamble byte 2 is 0x[0-9a-f]{2}, expected 0x55/);
    await tick();
    expect(bad('l_mac', hold(mac, 'valid', 0))).toMatch(/0 of the [0-9]+ frames came out/);
    await tick();
  }, MUTANTS_MS);
  it('l_mac receiving', async () => {
    expect(bad('l_mac', inside(mac, ['rx'], (d) => force(d, 'pipe.crc_ok', 1)))).toMatch(/damaged but rerr = 0/);
    await tick();
    expect(bad('l_mac', inside(mac, ['rx', 'pipe'], (d) => swap(d, 'crc', crcUnit(32, 0x82f63b78, 8))))).toMatch(/good frame but rerr = 1/);
    await tick();
    expect(bad('l_mac', inside(mac, ['rx'], (d) => force(d, 'pipe.crc_ok', 0)))).toMatch(/good frame but rerr = 1/);
    await tick();
    // the receiver before the shift register was cleared between frames: a frame after one whose FCS ended in 0xAA or 0xAB is read a bit off
    const stale = swap(mac, 'rx', macRx(true));
    expect(bad('l_mac', stale)).toMatch(/receiving frames after one whose FCS ends in 0xAA and 0xAB: .*good frame but rerr = 1.*start every frame clean/);
    await tick();
    void macTx;
  }, MUTANTS_MS);
  it('l_switch', async () => {
    expect(bad('l_switch', force(sw, 'look.flood', 1))).toMatch(/destination is known: send the frame out of its port alone/);
    await tick();
    expect(bad('l_switch', tie(sw, 'learn.go', 0))).toMatch(/destination is unknown|heard only|mask = /);
    await tick();
    expect(bad('l_switch', tie(tie(sw, 'mask.inport0', 0), 'mask.inport1', 0))).toMatch(/back out of port [0-9], the one it came in on/);
    await tick();
    expect(bad('l_switch', tie(sw, 'mask.bad', 0))).toMatch(/bad FCS goes nowhere/);
    await tick();
    expect(bad('l_switch', tie(sw, 'learn.bad', 0))).toMatch(/heard only in a damaged frame/);
    await tick();
    expect(bad('l_switch', force(sw, 'look.flood', 0))).toMatch(/destination is unknown/);
    await tick();
  }, MUTANTS_MS);
});

describe('l_driver: the far end of the cable names the rule a driver breaks', () => {
  const ref = DRIVER_REF;
  const fails = (src: string): string => {
    const r = runPuzzle(PUZZLES.l_driver, src);
    expect(r.errors).toEqual([]);
    expect(r.ok, 'the mutant must not pass').toBe(false);
    return r.results.filter((t) => !t.ok).map((t) => t.why).join(' | ');
  };
  const without = (src: string, line: string): string => { expect(src).toContain(line); return src.replace(line, ''); };

  it('the reference passes with a measured par', () => {
    const r = runPuzzle(PUZZLES.l_driver, ref);
    expect(r.ok).toBe(true);
    expect(r.size).toBe(nodeById('l_driver')!.par!.size);
    expect(r.cycles).toBe(nodeById('l_driver')!.par!.cycles);
  });
  it('ignoring OWN: a reply before the frame has arrived', () => {
    expect(fails(without(ref, '        bltz t0, poll           # OWN still set: the NIC is not done with it\n'))).toMatch(/doorbell was rung for frame 1 at clock [0-9]+, before it had finished arriving/);
  });
  it('a ring that does not wrap', () => {
    expect(fails(ref.replace('bne  s2, s6, rxok', 'j    rxok'))).toMatch(/past the end of the receive ring/);
  });
  it('no doorbell', () => {
    expect(fails(without(ref, '        sw   t5, 28(s1)         # the doorbell\n'))).toMatch(/the doorbell \(KICK.*was rung 0 times/);
  });
  it('a receive buffer never handed back: the NIC runs out', () => {
    expect(fails(without(ref, '        sw   t4, 4(s2)          # the receive buffer goes back to the NIC\n'))).toMatch(/receive descriptor 0 was never handed back/);
  });
  it('the addresses are not swapped / a wrong length', () => {
    expect(fails(ref.replace('sw   t4, 4(t3)', 'sw   a1, 4(t3)'))).toMatch(/byte 5 \(destination address/);
    expect(fails(ref.replace('or   t4, t4, t2', 'addi t4, t4, 0'))).toMatch(/0 bytes|bytes, expected/);
  });
  it('the starter assembles and fails', () => {
    expect(fails(DRIVER_STARTER)).toMatch(/must serve the rings forever/);
  });
});

describe('l_fwd: the model of the table names the rule a circuit breaks', () => {
  const fwd = fwdPath();
  it('the reference passes with a measured par, and another arrangement of the same function passes', () => {
    const r = check('l_fwd', fwd);
    expect(r.failures).toEqual([]);
    expect(stats(fwd).nands).toBe(nodeById('l_fwd')!.par!.nand);
    expect(r.score?.period).toBe(nodeById('l_fwd')!.par!.period);
  });
  it('matching', () => {
    expect(bad('l_fwd', inside(fwd, ['match'], (d) => force(d, driver(d, 'long0'), 1)))).toMatch(/the longest match is 10\.1\.0\.0\/16/);
    expect(bad('l_fwd', inside(fwd, ['match'], (d) => force(d, driver(d, 'found'), 1)))).toMatch(/no route matches: it goes up/);
    expect(bad('l_fwd', tie(fwd, 'write.we', 0))).toMatch(/the longest match is/);
    expect(bad('l_fwd', inside(fwd, ['act'], (d) => force(d, driver(d, 'local'), 0)))).toMatch(/the router itself/);
  });
  it('the order of the tests', () => {
    expect(bad('l_fwd', tie(fwd, 'act.bad', 0))).toMatch(/checksum failed goes nowhere/);
    expect(bad('l_fwd', inside(fwd, ['act'], (d) => force(d, driver(d, 'expired'), 0)))).toMatch(/cannot go one lower/);
    expect(bad('l_fwd', inside(fwd, ['act'], (d) => force(d, driver(d, 'expired'), 1)))).toMatch(/act = slow path, expected forward/);
  });
  it('the header', () => {
    expect(bad('l_fwd', inside(fwd, ['update'], (d) => force(d, driver(d, 'round'), 0)))).toMatch(/check_o = 0x[0-9a-f]{4}, expected 0x[0-9a-f]{4}/);
    expect(bad('l_fwd', inside(fwd, ['update'], (d) => force(d, driver(d, 't0'), 0)))).toMatch(/ttl_o = \d+, expected \d+: every router lowers it by one/);
    expect(bad('l_fwd', hold(fwd, 'go', 0))).toMatch(/ovalid = 0 in the clock after go/);
  });
  it('the shortcut RFC 1624 corrected: adding 0x0100 to the field passes every header but one kind, and that one is on the bench', () => {
    const r = check('l_fwd', fwdPath(true));
    expect(r.failures.length).toBe(1);
    expect(r.failures[0]).toMatch(/a checksum of 0xFEFF: .*check_o = 0xffff, expected 0x0000.*the case RFC 1624 corrected/);
    const m = FWD_LANES.find((l) => /0xFEFF/.test(l.name))!;
    const hs = m.ops.flatMap((o) => (o && 'h' in o ? [o.h] : []));
    expect(hs.length).toBeGreaterThan(0);
    for (const h of hs) {
      expect(checkOf(h)).toBe(0xfeff);
      expect(checkOf(h, h.ttl - 1)).toBe(0);
      expect((checkOf(h) + 0x0100) & 0xffff).toBe(0xffff);
    }
  });
});

describe('l_host: the router and the far host name the rule a program breaks', () => {
  const ref = HOST_REF;
  const fails = (src: string): string => {
    expect(src, 'the mutant must differ').not.toBe(ref);
    const r = runPuzzle(PUZZLES.l_host, src);
    expect(r.errors).toEqual([]);
    expect(r.ok, 'the mutant must not pass').toBe(false);
    return r.results.filter((t) => !t.ok).map((t) => t.why).join(' | ');
  };
  it('the reference passes with a measured par', () => {
    const r = runPuzzle(PUZZLES.l_host, ref);
    expect(r.results.map((x) => x.why)).toEqual([undefined, undefined, undefined]);
    expect(r.ok).toBe(true);
    expect(r.size).toBe(nodeById('l_host')!.par!.size);
    expect(r.cycles).toBe(nodeById('l_host')!.par!.cycles);
  });
  it('the starter assembles and fails', () => {
    expect(fails(HOST_STARTER)).toMatch(/doorbell .*rung 0 times/);
  });
  it('asking ARP for the far host: it is on another network', () => {
    expect(fails(ref.replace('li   t0, 0x00000101\n        sw   t0, 40(a0)', 'li   t0, 0x00000202\n        sw   t0, 40(a0)').replace('li   t0, 0x000a0000\n        sw   t0, 36(a0)         # target IP', 'li   t0, 0x000a0000\n        sw   t0, 36(a0)         # target IP'))).toMatch(/ARP works only on your own network/);
  });
  it('an ARP request that is not a broadcast', () => {
    expect(fails(ref.replace('li   t0, 0xffffffff\n        sw   t0, 0(a0)', 'li   t0, 0x00000102\n        sw   t0, 0(a0)'))).toMatch(/you do not know who has the address yet/);
  });
  it('a gateway MAC assumed, not asked for: the next scenario has another card', () => {
    const fixed = ref.replace('        lbu  t5, 0(t4)\n', '        li   t5, 2\n');
    expect(fails(fixed)).toMatch(/destination MAC is .*use the MAC in the gateway's ARP answer/i);
  });
  it('taking any ARP answer: another machine answers first in one scenario', () => {
    expect(fails(ref.replace('        lw   t0, 28(a0)\n        li   t1, 0x0101000a\n        bne  t0, t1, arpno\n', ''))).toMatch(/destination MAC is/);
  });
  it('a checksum left at 0, in the header and in the message', () => {
    expect(fails(ref.replace('        sh   a4, 24(a0)         # IP header checksum\n', ''))).toMatch(/IP header checksum is wrong/);
    expect(fails(ref.replace('        sh   a4, 36(a0)         # ICMP checksum\n', ''))).toMatch(/ICMP checksum is wrong/);
  });
  it('a TTL of 1 dies at the first hop', () => {
    expect(fails(ref.replace('li   t0, 0x01400040', 'li   t0, 0x01010040'))).toMatch(/TTL .*dies at the first hop/);
  });
  it('a wrong address, type or length', () => {
    expect(fails(ref.replace('li   t0, 0x00080202', 'li   t0, 0x00080302'))).toMatch(/destination address is 10\.0\.2\.3/);
    expect(fails(ref.replace('li   t0, 0x00080202', 'li   t0, 0x00000202'))).toMatch(/ICMP type and code/);
  });
  it('a K on the first frame back: the true reply is not the first in one scenario', () => {
    const anyFrame = ref.replace('        lhu  t0, 38(a0)\n        li   t1, 0x3412\n        bne  t0, t1, no\n', '');
    expect(fails(anyFrame)).toMatch(/before the true reply had finished arriving/);
    const anySeq = ref.replace('        lhu  t0, 40(a0)\n        li   t1, 0x0100\n        bne  t0, t1, no\n', '');
    expect(fails(anySeq)).toMatch(/before the true reply/);
    const anySrc = ref.replace('        lhu  t0, 28(a0)\n        li   t1, 0x0202\n        bne  t0, t1, no\n', '');
    expect(fails(anySrc)).toMatch(/before the true reply/);
  });
  it('frames ignored but never handed back: the ring runs dry', () => {
    expect(fails(ref.replace('no:     jal  ra, back\n        j    wait', 'no:     j    done'))).toMatch(/no 'K'|STATUS\.MISS|no .K./);
  });
  it('no K at all', () => {
    expect(fails(ref.replace('        sw   t0, 0(t1)\ndone:', 'done:'))).toMatch(/no 'K' came to the console/);
  });
});
