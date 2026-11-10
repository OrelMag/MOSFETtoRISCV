// Appendix E: one line of a Williams tube at switch level ("A bit is a charge", "Regeneration").
// A spot on the screen is a charge on the phosphor that leaks away; the pick-up plate in front of the screen feels the
// charge the beam moves when it lands on the spot. We model it with the DRAM chapter's machinery (lib/dram.ts, SwitchSim's
// charge levels): a spot is a storage node of CELL_C that leaks (NetDef.leak), the beam is the access transistor (sel),
// the plate is the line the spot shares its charge with, and the plate amplifier is a comparator against a reference.
//   dash = 1 = charged spot, dot = 0 = discharged spot.
// Time is counted in beats (clock cycles), never seconds. The charge halves every SPOT_HALFLIFE = 654 beats, so a dash
// is read as a dash while it is above half the supply: for SPOT_HALFLIFE beats (HOLD_BEATS in lib/baby.ts: Kilburn,
// December 1947, "short term memory of the order of 0.2 seconds" = 654 beats of 306 µs). The plate amplifier has no
// offset (a limiter: above the reference a dash, below a dot), so a dash read later is a dot: the loss shows as a bit
// flipped, not as an unknown. The regenerator (the scanner, the hold flip-flop and the data mux of WILLIAMS_TUBE) visits a
// spot every 4 clocks: N spots, 4·N beats a round; 8 spots take 32 beats, inside REFRESH_BEATS (64: the whole store every
// 16 instructions, Digital60 "Refreshing process"). No import from baby.ts: tests/babytube.test.ts holds the figures equal.

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { WRITE_DRIVER } from './arrays';
import { Builder } from './builder';
import { NMOS_STRONG } from './cells';
import { decoder, equal } from './combinational';
import { define, merger } from './define';
import { BITLINE_C, CELL_C, DATA_C, DRAM_SA, VHALF } from './dram';
import { AND, MUX2, NOR, NOT, OR, XOR } from './gates';
import { laid } from './layered';
import { DFF } from './sequential';
import { DFF_R } from './seqparts';
import { CAP } from './switchparts';
import { INV_CMOS, NMOS } from './transistors';

/** A charged spot halves every this many beats: it is read as a dash for exactly this long (0.2 s of 306 µs beats). */
export const SPOT_HALFLIFE = 654;
/** Clocks a visit takes: precharge the plate, land the beam (share the charge), sense, rewrite. */
export const VISIT_BEATS = 4;
/** A spot's capacitance and the plate's (the plate and its lead are bigger than a patch of phosphor), in the DRAM chapter's units. */
export const SPOT_C = CELL_C, PLATE_C = BITLINE_C;

const bit = (name: string, dir: 'in' | 'out' | 'inout', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });

/** One spot: the beam (sel) lets its charge meet the plate (pl); the charge leaks. Same geometry as the DRAM cell. */
export const WILLIAMS_SPOT: ComponentDef = define({
  id: 'wspot', name: 'Tube spot', category: 'memory',
  summary: `One digit on the face of a Williams tube: a charged patch of phosphor (a dash, 1) or a discharged one (a dot, 0). The beam lands on it (sel) and its charge meets the pick-up plate's. Unvisited, the charge halves every ${SPOT_HALFLIFE} beats.`,
  ports: [bit('sel', 'in'), bit('pl', 'inout')],
  symbol: { kind: 'box', label: 'SPOT', w: 6, h: 4 },
  netlist: () => ({
    level: 'switch',
    pins: { sel: [0, 6], pl: [6, 0] },
    pinDirs: { pl: 'down' },
    instances: [{ name: 'a', def: NMOS, at: [3, 4] }, { name: 'c', def: CAP, at: [5, 10] }],
    nets: [
      { name: 'sel', ends: ['sel', 'a.g'] },
      { name: 'pl', ends: ['pl', 'a.d'] },
      { name: 'charge', cap: SPOT_C, leak: SPOT_HALFLIFE, ends: ['a.s', 'c.a'] },
    ],
  }),
  hdl: { verilog: '// a leaking capacitor: no logic' },
});

/** The plate amplifier: DRAM's latching comparator without its offset, so a decayed dash reads as a dot (not an X). */
export const WILLIAMS_SA: ComponentDef = define({
  ...DRAM_SA, id: 'wsense', name: 'Plate amplifier', offset: 0,
  summary: 'When en rises, compares the plate with the reference line and latches the higher side as 1, the other as 0, driving both lines to the rails: the small signal the spot gave the plate becomes a full digit, and the spot is recharged or cleared with it.',
});

const memo = new Map<string, ComponentDef>();

/**
 * N spots along a line of the screen, the plate and its reference, precharge to half the supply, a pick-up select and the
 * plate amplifier: lib/dram.ts dramColumn with the Williams spot and the plate amplifier.
 * Ports: pre, sel0 … sel(N-1) (the beam), cs, sae, dl / dlb (the plate and reference lines, two ways).
 */
export function williamsColumn(N: number): ComponentDef {
  const key = `wcol${N}`;
  let d = memo.get(key);
  if (d) return d;
  const bg = symbolGeom(WILLIAMS_SPOT), P = bg.h + 2;
  const yc = 12 + P * N, yS = yc + 8, yB = yS + 6;
  const instances: InstanceDef[] = [
    { name: 'vh0', def: VHALF, at: [9, 0] }, { name: 'vh1', def: VHALF, at: [21, 0] },
    { name: 'pa', def: NMOS, at: [7, 2] }, { name: 'pb', def: NMOS, at: [19, 2] },
    { name: 'eq', def: NMOS, at: [13, 6], label: 'equalize' },
    { name: 'ca', def: NMOS_STRONG, at: [3, yc] }, { name: 'cb', def: NMOS_STRONG, at: [24, yc] },
    { name: 'sa', def: WILLIAMS_SA, at: [9, yS] },
  ];
  const pl = ['pa.s', 'eq.d', 'sa.bl', 'ca.d'], rf = ['pb.s', 'eq.s', 'sa.blb', 'cb.d'];
  const pins: Record<string, [number, number]> = { pre: [0, 8], sae: [0, yS + 2], cs: [0, yc + 2], dl: [6, yB], dlb: [27, yB] };
  const nets: NetDef[] = [
    { ends: ['vh0.p', 'pa.d'] }, { ends: ['vh1.p', 'pb.d'] },
    { name: 'pre', ends: ['pre', 'eq.g', 'pa.g', 'pb.g'], via: { 'pa.g': [[5, 8], [5, 4]], 'pb.g': [[12, 8], [12, 4]] } },
    { name: 'sae', ends: ['sae', 'sa.en'] },
    { name: 'cs', ends: ['cs', 'ca.g', 'cb.g'], via: { 'cb.g': [[1, yc + 2], [1, yc + 6], [23, yc + 6], [23, yc + 2]] } },
    { name: 'dl', ends: ['ca.s', 'dl'] }, { name: 'dl̄', ends: ['cb.s', 'dlb'] },
  ];
  for (let r = 0; r < N; r++) {
    instances.push({ name: `s${r}`, def: WILLIAMS_SPOT, at: [12, 12 + P * r], label: `digit ${r}` });
    pins[`sel${r}`] = [0, 12 + P * r + bg.ports.sel.pos[1]];
    nets.push({ name: `sel${r}`, ends: [`sel${r}`, `s${r}.sel`] });
    pl.push(`s${r}.pl`);
  }
  nets.push({ name: 'plate', cap: PLATE_C, ends: pl, trunk: 10 }, { name: 'ref', cap: PLATE_C, ends: rf, trunk: 22 });
  const ports: PortDef[] = [bit('pre', 'in'), ...Array.from({ length: N }, (_, r) => bit(`sel${r}`, 'in')), bit('cs', 'in'), bit('sae', 'in'),
    bit('dl', 'inout', 'bottom'), bit('dlb', 'inout', 'bottom')];
  d = define({
    id: key, name: `Tube line (${N} spots)`, category: 'memory',
    summary: `${N} spots on a line of the screen, the pick-up plate and its reference, precharge to half the supply, a pick-up select and the plate amplifier.`,
    ports, symbol: { kind: 'box', label: 'TUBE LINE', w: 8, portPos: { dl: 2, dlb: 6 } },
    netlist: () => ({ level: 'switch', pins, instances, nets }),
  });
  memo.set(key, d);
  return d;
}

/**
 * The scanner: one synchronous counter of 2 + k bits on DFF_R. The low two bits are the phase of a visit (00 precharge the
 * plate, 01 beam on the spot: its charge meets the plate's, 10 sense: the amplifier decides and the pick-up reads, 11
 * rewrite), the rest is the spot the beam is on: every spot is visited every 4 · 2^k clocks, in order.
 * Outputs: pre, act (beam on), sae, cs (the plate amplifier on, pick-up joined), we (rewrite), a (the spot).
 */
export function williamsScan(k: number): ComponentDef {
  const key = `wscan${k}`;
  let d = memo.get(key);
  if (d) return d;
  const m = 2 + k, b = new Builder(8, 12, 3);
  b.pins('clk', 'rst_n');
  for (let i = 0; i < m; i++) b.add(DFF_R, i < 2 ? `phase ${i}` : `spot bit ${i - 2}`, `ff${i}`);
  b.next();
  const q = (i: number) => `ff${i}.q`;
  // bit i toggles when every lower bit is 1
  const nq0 = b.op1(NOT, [q(0)], undefined, 'n0');
  b.wire(nq0, 'ff0.d');
  let t = q(0);
  for (let i = 1; i < m; i++) {
    const x = b.op1(XOR, [q(i), t], undefined, `x${i}`);
    b.wire(x, `ff${i}.d`);
    if (i < m - 1) t = b.op1(AND, [t, q(i)], undefined, `t${i + 1}`);
  }
  b.next();
  const pre = b.op1(NOR, [q(1), q(0)], undefined, 'gpre');
  const act = b.op1(OR, [q(1), q(0)], undefined, 'gact');
  const we = b.op1(AND, [q(1), q(0)], undefined, 'gwe');
  const mg = b.op(merger(Array(k).fill(1)), Array.from({ length: k }, (_, i) => q(2 + i)), undefined, 'ma');
  b.wire(pre, 'pre'); b.wire(act, 'act'); b.wire(we, 'we'); b.wire(`${mg}.out`, 'a');
  b.wire(q(1), 'sae'); b.wire(q(1), 'cs');
  for (let i = 0; i < m; i++) { b.wire('clk', `ff${i}.clk`); b.wire('rst_n', `ff${i}.rst_n`); }
  d = define({
    id: key, name: `Tube scanner (${2 ** k} spots)`, category: 'sequential',
    summary: `A ${m}-bit counter: the low two bits step through the phases of a visit (precharge, beam on, sense, rewrite), the other ${k} name the spot the beam is on.`,
    ports: [bit('clk', 'in', 'bottom', true), bit('rst_n', 'in'), bit('pre', 'out'), bit('act', 'out'), bit('sae', 'out'), bit('cs', 'out'), bit('we', 'out'),
      { name: 'a', width: k, dir: 'out' }],
    symbol: { kind: 'box', label: 'SCAN' },
    netlist: laid(b, { keepOrder: true, wires: Object.fromEntries(Array.from({ length: m }, (_, i) => [`ff${i}.q`, true])) }),
  });
  memo.set(key, d);
  return d;
}

/**
 * A Williams tube's line with its regenerator, N = 2^k spots. Each visit of the scanner is: precharge the plate, land the beam
 * on the spot (the charge is shared), sense (the plate amplifier decides; q is the digit the pick-up read), rewrite
 * (the held q goes back through the write driver; or, when wr = 1 and the beam is on spot `wa`, the digit d goes in its place).
 * The regenerator is that loop: the hold flip-flop keeps what the pick-up read, the mux chooses it or d, the write driver
 * charges or clears the spot. rst_n = 0 puts the scanner at spot 0, precharge (the spots power on unknown).
 */
export function williamsTube(k: number): ComponentDef {
  const key = `wtube${k}`;
  let d = memo.get(key);
  if (d) return d;
  const N = 2 ** k, b = new Builder(8, 12, 3);
  b.pins('clk', 'rst_n', 'wr', 'wa', 'd');
  const scan = b.add(williamsScan(k), 'scanner', 'scan');
  const dec = b.add(decoder(k, true), 'beam', 'beam');
  b.next();
  const col = b.add(williamsColumn(N), undefined, 'col');
  const wd = b.add(WRITE_DRIVER, undefined, 'wd');
  const out = b.add(INV_CMOS, 'pick-up', 'pick');
  const hold = b.add(DFF, 'hold', 'hold');
  const eq = b.add(equal(k), undefined, 'at');
  const wsel = b.add(AND, undefined, 'wsel');
  const mux = b.add(MUX2, 'regenerate | write', 'mux');
  b.wire('clk', `${scan}.clk`); b.wire('rst_n', `${scan}.rst_n`);
  b.wire(`${scan}.a`, `${dec}.a`); b.wire(`${scan}.act`, `${dec}.en`);
  for (let i = 0; i < N; i++) b.wire(`${dec}.y${i}`, `${col}.sel${i}`);
  b.wire(`${scan}.pre`, `${col}.pre`); b.wire(`${scan}.cs`, `${col}.cs`); b.wire(`${scan}.sae`, `${col}.sae`);
  b.wire(`${col}.dl`, `${wd}.bl`); b.wire(`${col}.dlb`, `${wd}.blb`); b.wire(`${col}.dlb`, `${out}.a`);
  b.wire(`${out}.y`, `${hold}.d`); b.wire(`${out}.y`, 'q'); b.wire('clk', `${hold}.clk`);
  b.wire(`${scan}.a`, `${eq}.a`); b.wire('wa', `${eq}.b`);
  b.wire(`${eq}.eq`, `${wsel}.a`); b.wire('wr', `${wsel}.b`);
  b.wire(`${hold}.q`, `${mux}.a`); b.wire('d', `${mux}.b`); b.wire(`${wsel}.y`, `${mux}.s`);
  b.wire(`${mux}.y`, `${wd}.d`); b.wire(`${scan}.we`, `${wd}.we`);
  b.wire(`${scan}.a`, 'a'); b.wire(`${scan}.we`, 'rewrite');
  const netlist = laid(b, { keepOrder: true, wires: { "pick.y": true } });
  d = define({
    id: key, name: `Williams tube line (${N} spots)`, category: 'memory',
    summary: `${N} spots of leaking charge on a tube face with its pick-up plate, and the regenerator that visits each spot every ${VISIT_BEATS} clocks, reads it and writes it back. Without it a dash is lost after ${SPOT_HALFLIFE} beats.`,
    ports: [bit('clk', 'in', 'bottom', true), bit('rst_n', 'in'), bit('wr', 'in'), { name: 'wa', width: k, dir: 'in' }, bit('d', 'in'),
      bit('q', 'out'), { name: 'a', width: k, dir: 'out' }, bit('rewrite', 'out')],
    symbol: { kind: 'box', label: 'TUBE' },
    // switch level, with the data lines carrying their own capacitance, as in the DRAM array
    netlist: function (this: ComponentDef) {
      const nl = netlist.call(this);
      return { ...nl, level: 'switch', nets: nl.nets.map((n) => (n.ends.includes(`${col}.dl`) || n.ends.includes(`${col}.dlb`) ? { ...n, cap: DATA_C } : n)) };
    },
  });
  memo.set(key, d);
  return d;
}
