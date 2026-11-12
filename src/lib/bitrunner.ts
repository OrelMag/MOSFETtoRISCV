// Appendix D's game in 74xx chips: no CPU, no ROM, one clock (runner/model.ts is the reference, register by register).
// Every module is a page of chips from lib/ttl.ts whose logic is mapped onto NAND packages (Sheet), the way a board gets
// its spare gates used up. Everything is clocked by clk, so the cycle engine runs it:
// no ripple clock, no monostable, every counter synchronous. CLR pins stay off and a start is a synchronous load.

import { digitPixel, segments } from '../runner/model';
import { stats } from '../sim/stats';
import { instPort } from '../sim/geometry';
import { type ComponentDef, netlistOf, type Netlist, type PortDef } from '../sim/types';
import { Builder } from './builder';
import { laid } from './layered';
import { define, merger, ones, splitter } from './define';
import { TIE0, TIE1 } from './transistors';
import { LS00, LS04, LS10, LS138, LS157, LS161, LS173, LS20, LS273, LS283, LS86, TTL_PART, ttlKind } from './ttl';

const bit = (name: string, dir: 'in' | 'out', clock?: boolean): PortDef => ({ name, width: 1, dir, ...(clock ? { clock, side: 'bottom' as const } : {}) });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const pinsAt = (names: string[], x: number, step = 4, y0 = 4): Record<string, [number, number]> =>
  Object.fromEntries(names.map((n, i) => [n, [x, y0 + step * i]]));
const inNames = (ps: PortDef[]) => ps.filter((p) => p.dir === 'in').map((p) => p.name);
const outNames = (ps: PortDef[]) => ps.filter((p) => p.dir === 'out').map((p) => p.name);

type Sig = string;
type Kind = 'nand2' | 'nand3' | 'nand4' | 'not' | 'xor';
const PACK: Record<Kind, { def: ComponentDef; size: number; ports: string[]; what: string }> = {
  nand2: { def: LS00, size: 4, ports: ['a', 'b'], what: 'NAND gates' }, nand3: { def: LS10, size: 3, ports: ['a', 'b', 'c'], what: '3-input NANDs' },
  nand4: { def: LS20, size: 2, ports: ['a', 'b', 'c', 'd'], what: '4-input NANDs' }, not: { def: LS04, size: 6, ports: ['a'], what: 'Inverters' },
  xor: { def: LS86, size: 4, ports: ['a', 'b'], what: 'XOR gates' },
};

/** What each chip does on its board, by its path ('walls.lo'); a gate package's role lists the signals it makes. */
export const RB_ROLES: Record<string, string> = {};

type Expr = { k: 'and' | 'or'; xs: Sig[]; why?: string } | { k: 'not'; x: Sig; why?: string } | { k: 'xor'; a: Sig; b: Sig; why?: string };

/**
 * A page of chips, written as logic and chips by name in any order, so a signal can be used before the chip making it is
 * placed (feedback needs that). The logic is mapped as a board designer would, at the end: an AND of ORs becomes two
 * levels of NANDs in 00s, 10s and 20s, each term made once. Columns: pins split, inputs bundled, chips, outputs split.
 */
class Sheet {
  private b = new Builder(16, 16, 4);
  private splits = new Map<Sig, { name: string; n: number }>();
  private words: { name: string; bits: Sig[] }[] = [];
  private chips: { def: ComponentDef; name: string; label: string; ins: Record<string, Sig | Sig[]> }[] = [];
  private exprs: Expr[] = [];
  private packs: Partial<Record<Kind, { name: string; ins: Sig[][]; made: string[] }[]>> = {};
  private made = new Map<string, Sig>();
  private z = false;
  private o = false;
  constructor(private id: string) {}

  get zero(): Sig { this.z = true; return 'zero.y'; }
  get one(): Sig { this.o = true; return 'one.y'; }

  /** The bits of a bus (a pin or 'chip.port'), least significant first. */
  bits(drv: Sig, n: number): Sig[] {
    let s = this.splits.get(drv);
    if (!s) { s = { name: `s_${drv.replace('.', '_')}`, n }; this.splits.set(drv, s); }
    return Array.from({ length: n }, (_, i) => `${s!.name}.o${i}`);
  }
  /** Bits bundled into a bus. */
  word(name: string, bits: Sig[]): Sig { this.words.push({ name, bits }); return `${name}.out`; }
  chip(def: ComponentDef, name: string, role: string, ins: Record<string, Sig | Sig[]>): void {
    this.chips.push({ def, name, label: TTL_PART[ttlKind(def)!], ins });
    RB_ROLES[`${this.id}.${name}`] = role;
  }

  private expr(e: Expr): Sig { this.exprs.push(e); return `@${this.exprs.length - 1}`; }
  and(xs: Sig[], why?: string): Sig { return this.expr({ k: 'and', xs, why }); }
  or(xs: Sig[], why?: string): Sig { return this.expr({ k: 'or', xs, why }); }
  xor(a: Sig, b: Sig, why?: string): Sig { return this.expr({ k: 'xor', a, b, why }); }
  not(x: Sig, why?: string): Sig { return this.expr({ k: 'not', x, why }); }

  private at(s: Sig): Expr | null { return s.startsWith('@') ? this.exprs[Number(s.slice(1))] : null; }

  /** One gate of a package, shared when the same gate was asked for already. */
  private gate(k: Kind, ins: Sig[], why?: string): Sig {
    const key = `${k}:${(k === 'xor' ? [...ins].sort() : [...ins].sort()).join(',')}`;
    let out = this.made.get(key);
    if (!out) {
      const list = (this.packs[k] ??= []);
      let p = list[list.length - 1];
      if (!p || p.ins.length === PACK[k].size) { p = { name: `${k === 'nand2' ? 'nd' : k === 'nand3' ? 'nt' : k === 'nand4' ? 'nq' : k}${list.length}`, ins: [], made: [] }; list.push(p); }
      p.ins.push(ins);
      out = `s_${p.name}.o${p.ins.length - 1}`;
      this.made.set(key, out);
    }
    if (why) {
      const p = (this.packs[k] ?? []).find((q) => out!.startsWith(`s_${q.name}.`));
      if (p && !p.made.includes(why)) { p.made.push(why); this.b.name(out, why, true); }
    }
    return out;
  }
  private inv(s: Sig, why?: string): Sig { return this.gate('not', [s], why); }
  /** NAND of these (positive) signals: a package's gate up to 4 inputs; more, the first four as an AND of their own. */
  private nand(list: Sig[], why?: string): Sig {
    const xs = [...new Set(list)];
    if (xs.length === 1) return this.inv(xs[0], why);
    if (xs.length > 4) return this.nand([this.inv(this.nand(xs.slice(0, 4))), ...xs.slice(4)], why);
    return this.gate(xs.length === 2 ? 'nand2' : xs.length === 3 ? 'nand3' : 'nand4', xs, why);
  }
  /** A signal's AND terms: a plain AND inside an AND opens up (a named one stays a net of its own). */
  private terms(xs: Sig[]): Sig[] {
    return xs.flatMap((x) => { const e = this.at(x); return e && e.k === 'and' && !e.why ? this.terms(e.xs) : [x]; });
  }
  private pos(s: Sig): Sig {
    const e = this.at(s);
    if (!e) return s;
    if (e.k === 'not') return this.neg(e.x, e.why);
    if (e.k === 'xor') return this.gate('xor', [this.pos(e.a), this.pos(e.b)], e.why);
    if (e.k === 'and') return this.inv(this.nand(this.terms(e.xs).map((x) => this.pos(x))), e.why);
    return this.nand(e.xs.map((x) => this.neg(x)), e.why);
  }
  private neg(s: Sig, why?: string): Sig {
    const e = this.at(s);
    if (!e) return this.inv(s, why);
    if (e.k === 'not') return this.pos(e.x);
    if (e.k === 'and') return this.nand(this.terms(e.xs).map((x) => this.pos(x)), why);
    return this.inv(this.pos(s), why);
  }

  /** The netlist: `outs` maps each output pin to its driver. Call once, after everything is on the sheet. */
  build(ports: PortDef[], outs: Record<string, Sig>): (this: ComponentDef) => Netlist {
    const b = this.b;
    b.pins(...inNames(ports));
    const placed = this.chips.map((c) => ({
      ...c,
      ins: Object.fromEntries(Object.entries(c.ins).map(([p, v]) => [p, Array.isArray(v) ? v.map((x) => this.pos(x)) : this.pos(v)])) as Record<string, Sig | Sig[]>,
    }));
    const words = this.words.map((w) => ({ ...w, bits: w.bits.map((x) => this.pos(x)) }));
    const pinOuts = Object.entries(outs).map(([pin, d]) => [pin, this.pos(d)] as const);
    for (const k of Object.keys(PACK) as Kind[]) {
      for (const p of this.packs[k] ?? []) {
        const { size, ports: gatePorts, def, what } = PACK[k];
        const ins = Object.fromEntries(gatePorts.map((port, i) => [port, Array.from({ length: size }, (_, g) => p.ins[g]?.[i] ?? this.zero)]));
        placed.push({ def, name: p.name, label: TTL_PART[ttlKind(def)!], ins });
        RB_ROLES[`${this.id}.${p.name}`] = `${what}${p.made.length ? ` for ${p.made.join(', ')}` : ', terms of the larger gates'}.`;
        this.splits.set(`${p.name}.y`, { name: `s_${p.name}`, n: size });
      }
    }
    for (const [drv, s] of this.splits) if (!drv.includes('.')) { b.wire(drv, `${s.name}.in`); b.add(splitter(ones(s.n), 2), undefined, s.name); }
    if (this.z) b.add(TIE0, '0', 'zero');
    if (this.o) b.add(TIE1, '1', 'one');
    b.next();
    for (const c of placed) {
      for (const [port, v] of Object.entries(c.ins)) {
        if (!Array.isArray(v)) continue;
        const m = `m_${c.name}_${port}`;
        b.add(merger(ones(v.length), 2), undefined, m);
        v.forEach((d, i) => b.wire(d, `${m}.i${i}`));
        b.wire(`${m}.out`, `${c.name}.${port}`);
      }
    }
    b.next();
    for (const c of placed) {
      b.add(c.def, c.label, c.name);
      for (const [port, v] of Object.entries(c.ins)) if (!Array.isArray(v)) b.wire(v, `${c.name}.${port}`);
    }
    b.next();
    for (const [drv, s] of this.splits) if (drv.includes('.')) { b.wire(drv, `${s.name}.in`); b.add(splitter(ones(s.n), 2), undefined, s.name); }
    b.next();
    for (const w of words) { b.add(merger(ones(w.bits.length), 2), undefined, w.name); w.bits.forEach((d, i) => b.wire(d, `${w.name}.i${i}`)); }
    b.next();
    for (const [pin, d] of pinOuts) b.wire(d, pin);
    // laid out by logic depth (lib/layered.ts): chips in signal order with wires between neighbours; the clock a wire, a tie wired to the chips beside it
    const ties = new Set(b.instances.filter((i) => i.def === TIE0 || i.def === TIE1).map((i) => `${i.name}.y`));
    const lay = laid(b, { room: true, gap: 14, aspect: 1.6, x0: 22, pinOrder: ports.map((p) => p.name), wires: Object.fromEntries(b.nets().filter((n) => n.name === 'clk').map((n) => [n.ends[0], true])) });
    return function (this: ComponentDef) {
      const nl = lay.call(this);
      const pos = (e: string): [number, number] => {
        const dot = e.indexOf('.');
        if (dot < 0) return nl.pins![e];
        const x = nl.instances.find((q) => q.name === e.slice(0, dot))!;
        return instPort(x.def, x.at!, x.flip, e.slice(dot + 1), x.rot).pos as [number, number];
      };
      return { ...nl, nets: nl.nets.map((n) => {
        if (!ties.has(n.ends[0])) return n;
        const d = pos(n.ends[0]);
        const far = n.ends.slice(1).filter((e) => { const q = pos(e); return Math.abs(q[0] - d[0]) + Math.abs(q[1] - d[1]) > 12; });
        const { tags: _t, ...wire } = n;
        return far.length === 0 ? wire : { ...wire, tags: [n.ends[0], ...far] };
      }) };
    };
  }
}

/** A 74LS161 with its CLR pin off: a load is the only way back. */
function counter(s: Sheet, name: string, role: string, enp: Sig, ent: Sig, loadN: Sig, d: Sig[]): void {
  s.chip(LS161, name, role, { clr_n: s.one, clk: 'clk', d, enp, ent, load_n: loadN });
}
/** A 74LS173 always driving its outputs, loading while `load` = 1 (null: at every edge). */
function register(s: Sheet, name: string, role: string, load: Sig | null, d: Sig[]): void {
  s.chip(LS173, name, role, { m: s.zero, n: s.zero, g1_n: load ? s.not(load) : s.zero, g2_n: s.zero, clr: s.zero, clk: 'clk', d });
}
const zeros = (s: Sheet) => [s.zero, s.zero, s.zero, s.zero];

// ---- sync --------------------------------------------------------------------------------------------------------

const SYNC_PORTS: PortDef[] = [
  bit('clk', 'in', true), bus('h', 7, 'out'), bus('v', 6, 'out'), bit('hEnd', 'out'), bit('frameEnd', 'out'), bit('line50', 'out'),
  bit('active', 'out'), bit('field', 'out'), bit('hsync', 'out'), bit('vsync', 'out'),
];

/** Two counters are the beam: h 0–71 a clock, v 0–51 a line. Everything on screen is decoded from them. */
export const RB_SYNC: ComponentDef = (() => {
  const s = new Sheet('sync');
  const hl = s.bits('hlo.q', 4), hh = s.bits('hhi.q', 4), vl = s.bits('vlo.q', 4), vh = s.bits('vhi.q', 4);
  const h = [...hl, ...hh.slice(0, 3)], v = [...vl, ...vh.slice(0, 2)];
  const hEnd = s.and([h[6], h[2], h[1], h[0]], 'hEnd');
  const v48 = s.and([v[5], v[4]], 'v ≥ 48');
  const line50 = s.and([v48, v[1], s.not(v[0])], 'line50');
  const vEnd = s.and([v48, v[1], v[0]], 'vEnd');
  const frameEnd = s.and([hEnd, vEnd], 'frameEnd');
  const loadH = s.not(hEnd), loadV = s.not(frameEnd);
  counter(s, 'hlo', 'Beam x, low bits: counts every clock, back to 0 after pixel 71.', s.one, s.one, loadH, zeros(s));
  counter(s, 'hhi', 'Beam x, high bits: counts when the low four carry. Bit 6 means blanking.', s.one, 'hlo.rco', loadH, zeros(s));
  counter(s, 'vlo', 'Beam y, low bits: counts once a line, back to 0 after line 51.', hEnd, hEnd, loadV, zeros(s));
  counter(s, 'vhi', 'Beam y, high bits.', s.one, 'vlo.rco', loadV, zeros(s));
  const active = s.and([s.not(h[6]), s.not(v48)], 'active');
  const field = s.not(s.and([v[5], s.or([v[4], v[3]])]), 'field');
  const hsync = s.and([h[6], h[2]], 'hsync');
  const vsync = s.and([v48, v[1]], 'vsync');
  const netlist = s.build(SYNC_PORTS, { h: s.word('mh', h), v: s.word('mv', v), hEnd, frameEnd, line50, active, field, hsync, vsync });
  return define({
    id: 'rb_sync', name: 'Sync (Bit Runner)', category: 'sequential',
    summary: 'Two counters are the beam: h counts 72 clocks a line, v counts 52 lines a frame. Sync and blanking are decoded from their top bits.',
    ports: SYNC_PORTS, symbol: { kind: 'box', label: 'SYNC' }, netlist,
  });
})();

// ---- walls -------------------------------------------------------------------------------------------------------

const WALLS_PORTS: PortDef[] = [
  bit('clk', 'in', true), bus('h', 7, 'in'), bit('hEnd', 'in'), bit('frameEnd', 'in'), bit('line50', 'in'), bit('fast', 'in'),
  bus('wc', 6, 'out'), bit('wv', 'out'), bit('edge', 'out'), bit('w', 'out'), bit('f', 'out'), bit('tick', 'out'), bit('load', 'out'),
];

/**
 * The walls are one counter of period 36, half a line: it stands still against the beam, two walls a line. Once in a
 * slip frame it loads 29 instead of 28, one count short, and from then on every wall is a pixel further left.
 */
export const RB_WALLS: ComponentDef = (() => {
  const s = new Sheet('walls');
  const lo = s.bits('lo.q', 4), hi = s.bits('hi.q', 4), st = s.bits('st.q', 4), h = s.bits('h', 7);
  const [w, armed, f] = st;
  const wrap = s.and(['lo.rco', hi[0], hi[1]], 'wrap');
  const loadN = s.not(wrap);
  counter(s, 'lo', 'The wall counter, low bits. Loads 28 at the wrap, or 29 when armed: one count short, which is the whole of the wall\'s movement.', s.one, s.one, loadN, [armed, s.zero, s.one, s.one]);
  counter(s, 'hi', 'The wall counter, high bits: 28…63 is a period of 36, half a line.', s.one, 'lo.rco', loadN, [s.one, s.zero, s.zero, s.zero]);
  const wv = s.and([hi[1], hi[0], lo[3], lo[2]], 'wall video');
  const edge = s.not(s.xor(lo[1], lo[0]), 'door edge');
  const slip = s.or(['fast', f], 'slip frame');
  const armSet = s.and(['line50', 'hEnd', slip], 'arm');
  const armedNext = s.or([armSet, s.and([armed, loadN])], 'armed next');
  const late = s.and([h[2], s.or([h[1], h[0]])]);
  const load = s.and(['line50', wv, s.not(lo[1]), s.not(lo[0]), h[6], s.not(late)], 'load gate');
  const tick = s.and([wrap, 'line50', slip, s.not(h[6]), s.not(h[5]), s.not(h[4]), h[3], s.not(h[2]), h[1], h[0]], 'wall passed');
  register(s, 'st', 'Which wall the beam is on (w), the slip armed for one wrap, and the frame\'s parity (f).', null, [s.xor(w, wrap, 'w next'), armedNext, s.xor(f, 'frameEnd', 'f next'), s.zero]);
  const netlist = s.build(WALLS_PORTS, { wc: s.word('mwc', [...lo, hi[0], hi[1]]), wv, edge, w, f, tick, load });
  return define({
    id: 'rb_walls', name: 'Walls (Bit Runner)', category: 'sequential',
    summary: 'A counter of half a line\'s period makes two walls that stand still; loading one count short once a slip frame moves them a pixel left. No position register.',
    ports: WALLS_PORTS, symbol: { kind: 'box', label: 'WALLS' }, netlist,
  });
})();

// ---- gates in the walls ------------------------------------------------------------------------------------------

const GAPS_PORTS: PortDef[] = [
  bit('clk', 'in', true), bit('w', 'in'), bit('load', 'in'), bus('v', 6, 'in'), bit('narrow3', 'in'), bit('narrow2', 'in'), bit('inGap', 'out'), bit('colour', 'out'),
];

/** A free-running LFSR picks each wall's gate as it comes round; one subtractor tells whether this line is in the gate. */
export const RB_GAPS: ComponentDef = (() => {
  const s = new Sheet('gaps');
  const q = s.bits('lfsr.q', 8), v = s.bits('v', 6), sel = s.bits('sel.y', 4), d = s.bits('diff.s', 4);
  const fb = s.not(s.xor(s.xor(q[7], q[5]), s.xor(q[4], q[3])), 'lfsr in');
  s.chip(LS273, 'lfsr', 'Eight flip-flops and XNOR feedback: 255 states, a new one every clock. The game has no other randomness.', { clr_n: s.one, clk: 'clk', d: [fb, ...q.slice(0, 7)] });
  const nw = s.not('w');
  register(s, 'a', 'Wall A\'s gate: where it starts (three bits) and its colour.', s.and(['load', nw], 'load A'), q.slice(0, 4));
  register(s, 'b', 'Wall B\'s gate.', s.and(['load', 'w'], 'load B'), q.slice(0, 4));
  s.chip(LS157, 'sel', 'Gives the comparison the gate of whichever wall the beam is on.', { a: 'a.q', b: 'b.q', s: 'w', g_n: s.zero });
  s.chip(LS283, 'diff', 'Line ÷ 4 minus the gate\'s start: under 4 means this line is inside the gate.', { a: v.slice(2), b: [s.not(sel[0]), s.not(sel[1]), s.not(sel[2]), s.one], c0: s.one });
  const inGap = s.and([s.not(d[3]), s.not(d[2]), s.not(s.and(['narrow3', d[1], d[0]])), s.not(s.and(['narrow2', d[1]]))], 'in gate');
  const netlist = s.build(GAPS_PORTS, { inGap, colour: sel[3] });
  return define({
    id: 'rb_gaps', name: 'Gates (Bit Runner)', category: 'sequential',
    summary: 'An LFSR gives each wall a gate while it is off screen; a subtractor shared by both walls decides, line by line, whether the beam is in the gate.',
    ports: GAPS_PORTS, symbol: { kind: 'box', label: 'GATES' }, netlist,
  });
})();

// ---- the player --------------------------------------------------------------------------------------------------

const PLAYER_PORTS: PortDef[] = [
  bit('clk', 'in', true), bit('up', 'in'), bit('down', 'in'), bit('flip', 'in'), bit('run', 'in'), bit('hEnd', 'in'), bus('v', 6, 'in'), bus('h', 7, 'in'), bit('pv', 'out'), bit('bit', 'out'),
];

/** The bit you steer is a counter too: one line a count, a frame's period; up shortens that period by a line, down lengthens it. */
export const RB_PLAYER: ComponentDef = (() => {
  const s = new Sheet('player');
  const lo = s.bits('lo.q', 4), hi = s.bits('hi.q', 4), v = s.bits('v', 6), h = s.bits('h', 7), st = s.bits('st.q', 4);
  const wrap = s.and(['lo.rco', hi[0], hi[1]], 'wrap');
  const loadN = s.not(wrap);
  const canUp = s.or([v[5], v[4], v[3], v[2]], 'can go up');
  const canDown = s.not(s.and([v[5], s.or([v[4], v[3], v[2]])]), 'can go down');
  const U = s.and(['run', 'up', canUp], 'U');
  const D = s.and(['run', 'down', canDown, s.not(U)], 'D');
  counter(s, 'lo', 'The player\'s counter, low bits: counts once a line. Loads 12 at the wrap (a frame\'s period), 13 going up, 11 going down.', 'hEnd', 'hEnd', loadN, [s.or([U, D], 'up or down'), D, s.not(D), s.one]);
  counter(s, 'hi', 'The player\'s counter, high bits: the last four counts of each period are the four lines you are on.', s.one, 'lo.rco', loadN, zeros(s));
  const pyWin = s.and([hi[1], hi[0], lo[3], lo[2]], 'your lines');
  const pxWin = s.and([s.not(h[6]), s.not(h[5]), s.not(h[4]), h[3], h[2]], 'your columns');
  const pv = s.and([pxWin, pyWin], 'you');
  const [b, prev] = st;
  register(s, 'st', 'Your colour, toggled on each press of Flip; beside it the button as it was a clock ago.', null, [s.xor(b, s.and(['flip', s.not(prev)]), 'bit next'), 'flip', s.zero, s.zero]);
  const netlist = s.build(PLAYER_PORTS, { pv, bit: b });
  return define({
    id: 'rb_player', name: 'Player (Bit Runner)', category: 'sequential',
    summary: 'A counter of one frame\'s period in lines: it is where you are, with no position register. Up loads one count further on, down one count back. Beside it one flip-flop, your colour.',
    ports: PLAYER_PORTS, symbol: { kind: 'box', label: 'PLAYER' }, netlist,
  });
})();

// ---- the rules ---------------------------------------------------------------------------------------------------

const RULES_PORTS: PortDef[] = [
  bit('clk', 'in', true), bit('start', 'in'), bit('pv', 'in'), bit('wv', 'in'), bit('field', 'in'), bit('inGap', 'in'), bit('colour', 'in'), bit('bit', 'in'), bit('tick', 'in'),
  bit('crash', 'out'), bit('inc', 'out'), bit('ghost', 'out'), bit('run', 'out'), bus('lives', 2, 'out'),
];

/** Collision is one AND of what the beam is drawing at this clock. No geometry: if you and a wall light the same pixel, you hit it. */
export const RB_RULES: ComponentDef = (() => {
  const s = new Sheet('rules');
  const [run, ghost, l0, l1] = s.bits('st.q', 4);
  const safe = s.and(['inGap', s.not(s.xor('bit', 'colour'), 'colours match')], 'safe');
  const nghost = s.not(ghost), nstart = s.not('start');
  const crash = s.and([run, nghost, 'pv', 'wv', 'field', s.not(safe)], 'crash');
  const inc = s.and(['tick', run, nghost], 'score +1');
  const ghostNext = s.and([nstart, s.or([crash, s.and([ghost, s.not('tick')])])], 'ghost next');
  const l0Next = s.and([nstart, s.xor(l0, crash)], 'lost 0 next');
  const l1Next = s.and([nstart, s.xor(l1, s.and([l0, crash]))], 'lost 1 next');
  const runNext = s.or(['start', s.and([run, s.not(s.and([l1, l0], 'out of lives'))])], 'run next');
  register(s, 'st', 'The game\'s state: running, ghost (a wall you hit cannot hit you again until it has passed), and lives lost.', null, [runNext, ghostNext, l0Next, l1Next]);
  const netlist = s.build(RULES_PORTS, { crash, inc, ghost, run, lives: s.word('ml', [l0, l1]) });
  return define({
    id: 'rb_rules', name: 'Rules (Bit Runner)', category: 'sequential',
    summary: 'crash = you AND wall AND NOT (in the gate AND colours match): one clock of two video signals high together. It costs a life and makes you a ghost until that wall has passed.',
    ports: RULES_PORTS, symbol: { kind: 'box', label: 'RULES' }, netlist,
  });
})();

// ---- the score ---------------------------------------------------------------------------------------------------

const SCORE_PORTS: PortDef[] = [
  bit('clk', 'in', true), bit('start', 'in'), bit('inc', 'in'), bus('ones', 4, 'out'), bus('tens', 4, 'out'), bit('fast', 'out'), bit('narrow3', 'out'), bit('narrow2', 'out'),
];

/** Two decade counters; the tens digit also sets the difficulty, with three ORs. */
export const RB_SCORE: ComponentDef = (() => {
  const s = new Sheet('score');
  const o = s.bits('lo.q', 4), t = s.bits('hi.q', 4);
  const carry = s.and(['inc', o[3], o[0]], 'carry');
  counter(s, 'lo', 'Units: counts walls passed, back to 0 after 9 (a 161 with its load, as a decade counter).', 'inc', 'inc', s.not(s.or(['start', carry])), zeros(s));
  counter(s, 'hi', 'Tens: counts each carry.', carry, carry, s.not(s.or(['start', s.and([carry, t[3], t[0]])])), zeros(s));
  const narrow2 = s.or([t[2], t[3]], '≥ 40');
  const narrow3 = s.or([narrow2, t[1]], '≥ 20');
  const fast = s.or([narrow3, t[0]], '≥ 10');
  const netlist = s.build(SCORE_PORTS, { ones: 'lo.q', tens: 'hi.q', fast, narrow3, narrow2 });
  return define({
    id: 'rb_score', name: 'Score (Bit Runner)', category: 'sequential',
    summary: 'Two decade counters. At 10 the walls slip every frame instead of every other; at 20 and 40 the gates narrow.',
    ports: SCORE_PORTS, symbol: { kind: 'box', label: 'SCORE' }, netlist,
  });
})();

// ---- digits to pixels --------------------------------------------------------------------------------------------

const DIGITS_PORTS: PortDef[] = [bus('h', 7, 'in'), bus('v', 6, 'in'), bus('ones', 4, 'in'), bus('tens', 4, 'in'), bus('lives', 2, 'in'), bit('px', 'out')];

/** The status band, as gates: a font of seven segments, a row decoder, and the beam's low bits choosing the column. */
export const RB_DIGITS: ComponentDef = (() => {
  const s = new Sheet('digits');
  const h = s.bits('h', 7), v = s.bits('v', 6), y = s.bits('row.y_n', 8), dig = s.bits('sel.y', 4), l = s.bits('lives', 2);
  s.chip(LS138, 'row', 'Decodes the beam\'s line inside the status band (lines 40 to 47).', { a: v.slice(0, 3), g1: s.and([v[5], v[3]], 'band'), g2a_n: v[4], g2b_n: s.zero });
  s.chip(LS157, 'sel', 'Tens or units, by the beam\'s column: one font serves both digits.', { a: 'tens', b: 'ones', s: h[3], g_n: s.zero });
  const [d0, d1, d2, d3] = dig;
  const n0 = s.not(d0), n1 = s.not(d1), n2 = s.not(d2);
  const n2n0 = s.and([n2, n0]), d1n0 = s.and([d1, n0]), d2n1 = s.and([d2, n1]), n2d1 = s.and([n2, d1]);
  const a = s.or([d3, d1, s.and([d2, d0]), n2n0], 'a');
  const b = s.or([n2, s.not(s.xor(d1, d0))], 'b');
  const c = s.or([d2, n1, d0], 'c');
  const dd = s.or([d3, n2n0, d1n0, n2d1, s.and([d2n1, d0])], 'd');
  const e = s.or([n2n0, d1n0], 'e');
  const f = s.or([d3, s.and([n1, n0]), d2n1, s.and([d2, n0])], 'f');
  const g = s.or([d3, d2n1, n2d1, d1n0], 'g');
  const r = [2, 3, 4, 5, 6].map((i) => s.not(y[i]));
  const left = s.or([s.and([r[0], s.or([a, f])]), s.and([r[1], f]), s.and([r[2], s.or([g, e, f])]), s.and([r[3], e]), s.and([r[4], s.or([dd, e])])], 'left');
  const mid = s.or([s.and([r[0], a]), s.and([r[2], g]), s.and([r[4], dd])], 'middle');
  const right = s.or([s.and([r[0], s.or([a, b])]), s.and([r[1], b]), s.and([r[2], s.or([g, b, c])]), s.and([r[3], c]), s.and([r[4], s.or([dd, c])])], 'right');
  const nh1 = s.not(h[1]), nh0 = s.not(h[0]), nh6 = s.not(h[6]);
  const column = s.or([s.and([nh1, nh0, left]), s.and([nh1, h[0], mid]), s.and([h[1], nh0, right])], 'font pixel');
  const dg = s.and([nh6, s.not(h[5]), s.not(h[4]), s.xor(h[3], h[2]), column], 'digit');
  const nh3 = s.not(h[3]), nh2 = s.not(h[2]), nl1 = s.not(l[1]);
  const pips = s.or([s.and([nh3, h[2], s.not(s.and([l[1], l[0]]))]), s.and([h[3], nh2, nl1]), s.and([h[3], h[2], nl1, s.not(l[0])])], 'lives left');
  const pip = s.and([nh6, h[5], h[4], nh1, s.or([r[0], r[1]]), pips], 'pip');
  const netlist = s.build(DIGITS_PORTS, { px: s.or([s.not(y[0], 'rule'), dg, pip], 'status') });
  return define({
    id: 'rb_digits', name: 'Digits to pixels (Bit Runner)', category: 'sequential',
    summary: 'Turns the score and the beam\'s position into one video bit: a font of seven segments, a row decoder, the column from h. A digit is never stored as a picture.',
    ports: DIGITS_PORTS, symbol: { kind: 'box', label: 'DIGITS' }, netlist,
    spec: ([h, v, o, t, lives]) => {
      let px = v === 40 ? 1 : 0;
      if (v >= 42 && v <= 46 && h < 16) {
        const d = h >= 4 && h <= 6 ? t : h >= 8 && h <= 10 ? o : -1;
        if (d >= 0) px |= digitPixel(segments(d), v - 42, h & 3);
      }
      if ((v === 42 || v === 43) && h >= 52 && h < 64 && (h & 2) === 0 && lives <= 2 - (((h >> 2) & 3) - 1)) px = 1;
      return [px];
    },
  });
})();

// ---- video -------------------------------------------------------------------------------------------------------

const VIDEO_PORTS: PortDef[] = [
  bit('active', 'in'), bit('field', 'in'), bit('wv', 'in'), bit('inGap', 'in'), bit('edge', 'in'), bit('colour', 'in'), bit('pv', 'in'), bit('bit', 'in'), bit('ghost', 'in'), bit('f', 'in'), bit('px', 'in'),
  bit('white', 'out'), bit('amber', 'out'), bit('cyan', 'out'),
];

/** The three video lines: one OR per colour of whatever the beam is on, gated off during blanking. */
export const RB_VIDEO: ComponentDef = (() => {
  const s = new Sheet('video');
  const wf = s.and(['wv', 'field'], 'wall here');
  const solid = s.and([wf, s.not('inGap')], 'solid');
  const door = s.and([wf, 'inGap', 'edge'], 'door');
  const you = s.and(['pv', 'field', s.not(s.and(['ghost', 'f']))], 'you shown');
  const ncolour = s.not('colour'), nbit = s.not('bit');
  const white = s.and(['active', s.or([solid, 'px'])], 'white');
  const amber = s.and(['active', s.or([s.and([door, ncolour]), s.and([you, nbit])])], 'amber');
  const cyan = s.and(['active', s.or([s.and([door, 'colour']), s.and([you, 'bit'])])], 'cyan');
  const netlist = s.build(VIDEO_PORTS, { white, amber, cyan });
  return define({
    id: 'rb_video', name: 'Video (Bit Runner)', category: 'sequential',
    summary: 'White, amber and cyan lines: the walls, the doors and you, ORed per colour and gated off during blanking.',
    ports: VIDEO_PORTS, symbol: { kind: 'box', label: 'VIDEO' }, netlist,
    spec: ([active, field, wv, inGap, edge, colour, pv, b, ghost, f, px]) => {
      const wf = wv & field, door = wf & inGap & edge, you = pv & field & (1 - (ghost & f));
      return [active & ((wf & (1 - inGap)) | px), active & ((door & (1 - colour)) | (you & (1 - b))), active & ((door & colour) | (you & b))];
    },
  });
})();

// ---- the machine -------------------------------------------------------------------------------------------------

export const RB_PORTS: PortDef[] = [
  bit('clk', 'in', true), bit('up', 'in'), bit('down', 'in'), bit('flip', 'in'), bit('start', 'in'),
  bit('white', 'out'), bit('amber', 'out'), bit('cyan', 'out'), bit('hsync', 'out'), bit('vsync', 'out'),
  bus('ones', 4, 'out'), bus('tens', 4, 'out'), bus('lives', 2, 'out'), bit('run', 'out'), bit('crash', 'out'), bit('bit', 'out'),
];

/** Where a test or the panel reads a register: [instance path, output port]. */
export const RB_STATE = {
  hLo: ['sync.hlo', 'q'], hHi: ['sync.hhi', 'q'], vLo: ['sync.vlo', 'q'], vHi: ['sync.vhi', 'q'], wLo: ['walls.lo', 'q'], wHi: ['walls.hi', 'q'], wSt: ['walls.st', 'q'],
  lfsr: ['gaps.lfsr', 'q'], gapA: ['gaps.a', 'q'], gapB: ['gaps.b', 'q'], pLo: ['player.lo', 'q'], pHi: ['player.hi', 'q'], pSt: ['player.st', 'q'], rules: ['rules.st', 'q'],
  ones: ['score.lo', 'q'], tens: ['score.hi', 'q'],
} as const;

/** The whole game: eight boards, every connection between them a named label. */
export const BIT_RUNNER: ComponentDef = (() => {
  const b = new Builder(16, 18, 6);
  const ins = inNames(RB_PORTS);
  b.pins(...ins);
  const sync = b.op(RB_SYNC, ['clk'], 'sync', 'sync');
  const n = (d: string, name: string) => b.name(d, name, true);
  const hBus = n(`${sync}.h`, 'H'), vBus = n(`${sync}.v`, 'V'), hEnd = n(`${sync}.hEnd`, 'H END'), line50 = n(`${sync}.line50`, 'LINE 50');
  const field = n(`${sync}.field`, 'FIELD');
  const walls = b.op(RB_WALLS, ['clk', hBus, hEnd, `${sync}.frameEnd`, line50, ''], 'walls', 'walls');
  b.next();
  const wv = n(`${walls}.wv`, 'WALL'), w = n(`${walls}.w`, 'W'), f = n(`${walls}.f`, 'F'), tick = n(`${walls}.tick`, 'TICK');
  const gaps = b.op(RB_GAPS, ['clk', w, `${walls}.load`, vBus, '', ''], 'gates', 'gaps');
  const inGap = n(`${gaps}.inGap`, 'IN GATE'), colour = n(`${gaps}.colour`, 'COLOUR');
  const player = b.op(RB_PLAYER, ['clk', 'up', 'down', 'flip', '', hEnd, vBus, hBus], 'player', 'player');
  const pv = n(`${player}.pv`, 'YOU'), bitS = n(`${player}.bit`, 'BIT');
  b.next();
  const rules = b.op(RB_RULES, ['clk', 'start', pv, wv, field, inGap, colour, bitS, tick], 'rules', 'rules');
  const run = n(`${rules}.run`, 'RUN');
  b.wire(run, `${player}.run`);
  const score = b.op(RB_SCORE, ['clk', 'start', `${rules}.inc`], 'score', 'score');
  const onesB = n(`${score}.ones`, 'UNITS'), tensB = n(`${score}.tens`, 'TENS'), lives = n(`${rules}.lives`, 'LIVES');
  b.wire(`${score}.fast`, `${walls}.fast`);
  b.wire(`${score}.narrow3`, `${gaps}.narrow3`);
  b.wire(`${score}.narrow2`, `${gaps}.narrow2`);
  b.next();
  const digits = b.op(RB_DIGITS, [hBus, vBus, onesB, tensB, lives], 'digits', 'digits');
  const video = b.op(RB_VIDEO, [`${sync}.active`, field, wv, inGap, `${walls}.edge`, colour, pv, bitS, n(`${rules}.ghost`, 'GHOST'), f, `${digits}.px`], 'video', 'video');
  b.next();
  for (const o of ['white', 'amber', 'cyan']) b.wire(`${video}.${o}`, o);
  b.wire(`${sync}.hsync`, 'hsync');
  b.wire(`${sync}.vsync`, 'vsync');
  b.wire(onesB, 'ones');
  b.wire(tensB, 'tens');
  b.wire(lives, 'lives');
  b.wire(run, 'run');
  b.wire(`${rules}.crash`, 'crash');
  b.wire(bitS, 'bit');
  const R = b.right;
  return define({
    id: 'bit_runner', name: 'Bit Runner', category: 'sequential',
    summary: 'A video game with no program: counters, gates and flip-flops, one clock. You are one bit; walls of gates scroll towards you, and a gate passes only a bit of its own colour.',
    ports: RB_PORTS, symbol: { kind: 'box', label: 'BIT RUNNER' },
    // every connection between boards a label, as the summary above says: the same wires would lie along each other
    netlist: () => ({ pins: { ...pinsAt(ins, 0, 6), ...pinsAt(outNames(RB_PORTS), R, 6) }, instances: b.instances, nets: b.nets().map((n) => ({ ...n, tags: true as const })) }),
  });
})();

/** One 74xx chip of the game: its instance path, its TTL_PINS key, its definition. */
export interface RbChip { path: string; kind: string; def: ComponentDef }

/** Every 74xx chip in the game or a module, board by board. */
export function rbChips(def: ComponentDef, prefix = ''): RbChip[] {
  const out: RbChip[] = [];
  for (const i of netlistOf(def)?.instances ?? []) {
    const path = prefix ? `${prefix}.${i.name}` : i.name;
    const kind = ttlKind(i.def);
    if (kind) out.push({ path, kind, def: i.def });
    else if (i.def.id.startsWith('rb_')) out.push(...rbChips(i.def, path));
  }
  return out;
}

/** What the game costs: chips and NANDs. */
export const rbCost = (def: ComponentDef = BIT_RUNNER) => ({ chips: rbChips(def).length, nands: stats(def).nands });
