// Chapter 12's deeper steps: a register file that forwards a write to a read of the same register in the same cycle,
// and one built from latches instead of flip-flops. Neither replaces regfile(): that one is quoted all over the site.

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { constWord } from './alu';
import { Builder } from './builder';
import { andN, busMux2, decoder, equal } from './combinational';
import { define, merger, ones, splitter } from './define';
import { AND } from './gates';
import { nonZero } from './pipeline';
import { readPort, regfile } from './regfile';
import { D_LATCH } from './sequential';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width, dir, side });

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

/**
 * regfile(k, w) with write-through: a read of the register being written this cycle returns the incoming write data
 * (when byp = 1, we = 1, the write address is not 0 and equals the read address) instead of the stale stored word.
 * One comparator, one AND and one word multiplexer per read port.
 */
export function rfBypass(k: number, w: number): ComponentDef {
  return memo(`rfbyp${k}x${w}`, () => {
    const b = new Builder(10, 10, 4);
    b.pins('wa', 'wd', 'we', 'byp', 'clk', 'ra1', 'ra2');
    const rf = b.add(regfile(k, w), 'register file', 'rf');
    for (const p of ['wa', 'wd', 'we', 'clk', 'ra1', 'ra2']) b.wire(p, `${rf}.${p}`);
    b.next();
    const nz = b.op1(nonZero(k), ['wa'], 'wa ≠ 0', 'nz');
    const hits = [1, 2].map((r) => b.op1(equal(k), ['wa', `ra${r}`], `wa = ra${r}`, `eq${r}`));
    b.next();
    const go = b.op1(andN(3), ['we', 'byp', nz], 'forward enabled', 'go');
    b.name(go, 'fwd', true);
    const sel = hits.map((h, i) => b.op1(AND, [h, go], `hit ${i + 1}`, `hit${i + 1}`));
    b.next();
    const out = [1, 2].map((r) => b.op1(busMux2(w), [`${rf}.rd${r}`, 'wd', sel[r - 1]], `rd${r} / wd`, `mx${r}`));
    out.forEach((o, i) => b.wire(o, `rd${i + 1}`));
    const R = b.right;
    return define({
      id: `rfbyp${k}x${w}`, name: `Register file with write-through (${2 ** k} × ${w})`, category: 'memory',
      summary: 'regfile() plus a comparator and a multiplexer on each read port: reading the register being written returns the incoming data, not the old word. byp = 0 switches the forwarding off.',
      ports: [bus('wa', k, 'in'), bus('wd', w, 'in'), bit('we', 'in'), bit('byp', 'in'), bus('ra1', k, 'in'), bus('ra2', k, 'in'), bit('clk', 'in', 'bottom', true), bus('rd1', w, 'out'), bus('rd2', w, 'out')],
      symbol: { kind: 'box', label: 'RF+BYP' },
      netlist: () => ({
        pins: { wa: [0, 2], wd: [0, 6], we: [0, 10], byp: [0, 14], ra1: [0, 18], ra2: [0, 22], clk: [0, 26], rd1: [R, 4], rd2: [R, 8] },
        instances: b.instances, nets: b.nets(),
      }),
    });
  });
}

/** A word of w D latches sharing one enable: transparent while e = 1. */
export function latchWord(w: number): ComponentDef {
  return memo(`latchword${w}`, () => {
    const P = 6, g = symbolGeom(D_LATCH), X = 10, Y0 = 3;
    const instances: InstanceDef[] = [
      { name: 'sd', def: splitter(ones(w), P), at: [6, Y0 + g.ports.d.pos[1] - P / 2] },
      { name: 'mq', def: merger(ones(w), P), at: [X + g.w + 3, Y0 + g.ports.q.pos[1] - P / 2] },
    ];
    const nets: NetDef[] = [{ name: 'd', ends: ['d', 'sd.in'] }, { name: 'q', ends: ['mq.out', 'q'] }];
    const e = ['e'];
    for (let i = 0; i < w; i++) {
      instances.push({ name: `l${i}`, def: D_LATCH, at: [X, Y0 + P * i] });
      nets.push({ name: `d${i}`, ends: [`sd.o${i}`, `l${i}.d`] }, { name: `q${i}`, ends: [`l${i}.q`, `mq.i${i}`] });
      e.push(`l${i}.e`);
    }
    const bottom = Y0 + P * w, mid = (P * w) / 2;
    nets.push({ name: 'e', ends: e, trunk: X + g.w + 1.5 });
    return define({
      id: `latchword${w}`, name: `${w}-bit latch word`, category: 'sequential',
      summary: `${w} D latches sharing one enable: transparent while e = 1, holding while e = 0. A register without the second latch of each flip-flop.`,
      ports: [bus('d', w, 'in'), bit('e', 'in', 'bottom'), bus('q', w, 'out')],
      symbol: { kind: 'box', label: `LATCH${w}` },
      netlist: () => ({ pins: { d: [1, Y0 + g.ports.d.pos[1] - P / 2 + mid], e: [1, bottom + 1], q: [X + g.w + 8, Y0 + g.ports.q.pos[1] - P / 2 + mid] }, instances, nets }),
    });
  });
}

/**
 * The register file of latches: word i is a row of D latches enabled while clk is high and the write decoder picks it.
 * Same ports as regfile(). The data path stays transparent for the whole high phase, so wd must be stable then, and a
 * read of the word being written sees the write data at once.
 */
export function latchFile(k: number, w: number): ComponentDef {
  return memo(`latchfile${k}x${w}`, () => {
    const N = 2 ** k, b = new Builder(10, 10, 4);
    b.pins('wa', 'wd', 'we', 'clk', 'ra1', 'ra2');
    const dec = b.op(decoder(k, true), ['wa', 'we'], 'write decoder', 'dec');
    b.next();
    const gates = Array.from({ length: N }, (_, i) => (i === 0 ? '' : b.op1(AND, [`${dec}.y${i}`, 'clk'], `e${i} = y${i} · clk`, `g${i}`)));
    b.next();
    const words = Array.from({ length: N }, (_, i) => (i === 0 ? b.op1(constWord(w, 0), [], 'x0 = 0') : b.op1(latchWord(w), ['wd', gates[i]], `x${i}`, `w${i}`)));
    b.next();
    const all = b.name(b.op1(merger(Array(N).fill(w)), words), 'all words', true);
    b.next();
    b.wire(b.op1(readPort(k, w), [all, 'ra1'], 'read port 1', 'rp1'), 'rd1');
    b.wire(b.op1(readPort(k, w), [all, 'ra2'], 'read port 2', 'rp2'), 'rd2');
    const R = b.right;
    return define({
      id: `latchfile${N}x${w}`, name: `Latch register file (${N} × ${w})`, category: 'memory',
      summary: 'Two read ports and one write port like regfile(), but each bit is one D latch: the write decoder ANDed with clk is the enable, so a word is open for the whole high phase of the clock.',
      ports: [bus('wa', k, 'in'), bus('wd', w, 'in'), bit('we', 'in'), bus('ra1', k, 'in'), bus('ra2', k, 'in'), bit('clk', 'in', 'bottom', true), bus('rd1', w, 'out'), bus('rd2', w, 'out')],
      symbol: { kind: 'box', label: 'LATCH FILE' },
      netlist: () => ({ pins: { wa: [0, 2], wd: [0, 6], we: [0, 10], ra1: [0, 14], ra2: [0, 18], clk: [0, 22], rd1: [R, 4], rd2: [R, 8] }, instances: b.instances, nets: b.nets() }),
    });
  });
}
