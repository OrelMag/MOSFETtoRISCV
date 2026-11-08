// The Enigma M4 again, in the gates the book has built: what the machine does with wires and brass, done with NANDs. A
// wheel's wiring becomes a table in a decoder and ORs, its turning two adders mod 26, each stage a block. The real machine
// spends no active device on a letter's way through; this is the price of doing without moving contacts.
// tests/secret-enigma-gates.test.ts: every press against crypto/enigma.ts, and U-264's message through the gates.

import { GREEK, REFLECTORS, ROTORS, type EnigmaSettings, idx, plugMap, UKWD_SAMPLE, ukwdWiring } from '../crypto/enigma';
import type { ComponentDef, PortDef } from '../sim/types';
import { constWord } from './alu';
import { Builder } from './builder';
import { busMux2, decoder, rca } from './combinational';
import { define, merger, ones, splitter } from './define';
import { NOT, OR } from './gates';
import { equal } from './pipeline';
import { register } from './sequential';
import { orN } from './wide';

const cache = new Map<string, ComponentDef>();
const memo = (key: string, f: () => ComponentDef): ComponentDef => { let d = cache.get(key); if (!d) { d = f(); cache.set(key, d); } return d; };
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const bit = (name: string, dir: 'in' | 'out', clock?: boolean): PortDef => ({ name, width: 1, dir, clock });
const mod = (x: number) => ((x % 26) + 26) % 26;
// What the adders do on every five-bit input, letters or not: exactly the gates' behaviour, so the specs can be checked exhaustively.
const addF = (a: number, b: number) => { const s = a + b, c = s >> 5, l = s & 31, t = l + 6; return c || t >> 5 ? t & 31 : l; };
const subF = (a: number, b: number) => { const s = a + (~b & 31) + 1, l = s & 31; return s >> 5 ? l : (l + 26) & 31; };

/** a + b mod 26, both below 26: add, then add 6 more; the second sum is the answer when either carried past 32. */
export function add26(): ComponentDef {
  return memo('add26', () => {
    const b = new Builder(8, 10, 3), A = rca(5);
    b.pins('a', 'b');
    const zero = b.op1(constWord(1, 0), []), six = b.op1(constWord(5, 6), []);
    b.next();
    const s = b.op(A, ['a', 'b', zero], 'a + b');
    b.next();
    const t = b.op(A, [`${s}.s`, six, zero], '+ 6');
    b.next();
    const w = b.op1(OR, [`${s}.cout`, `${t}.cout`], 'past 26');
    b.next();
    const y = b.op1(busMux2(5), [`${s}.s`, `${t}.s`, w]);
    b.wire(y, 'y');
    return define({
      id: 'add26', name: 'Add mod 26', category: 'arithmetic',
      summary: 'Two letters as numbers, added round the alphabet. Binary adders count to 32, so a sum past 25 is corrected by adding 6 more: that carries out of five bits at exactly the right place.',
      ports: [bus('a', 5, 'in'), bus('b', 5, 'in'), bus('y', 5, 'out')], symbol: { kind: 'box', label: '+ mod 26' },
      spec: ([x, c]) => [addF(x, c)],
      netlist: () => ({ pins: { a: [0, 3], b: [0, 9], y: [b.right, 7] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** a − b mod 26: a + ¬b + 1; no carry out means it went below zero, so 26 goes back on. */
export function sub26(): ComponentDef {
  return memo('sub26', () => {
    const b = new Builder(8, 10, 3), A = rca(5);
    b.pins('a', 'b');
    const one = b.op1(constWord(1, 1), []), zero = b.op1(constWord(1, 0), []), k = b.op1(constWord(5, 26), []);
    const sb = b.op(splitter(ones(5)), ['b']);
    b.next();
    const ns = [0, 1, 2, 3, 4].map((i) => b.op1(NOT, [`${sb}.o${i}`]));
    b.next();
    const nb = b.op1(merger(ones(5)), ns);
    b.next();
    const s = b.op(A, ['a', nb, one], 'a − b');
    b.next();
    const t = b.op(A, [`${s}.s`, k, zero], '+ 26');
    b.next();
    const y = b.op1(busMux2(5), [`${t}.s`, `${s}.s`, `${s}.cout`]);
    b.wire(y, 'y');
    return define({
      id: 'sub26', name: 'Subtract mod 26', category: 'arithmetic',
      summary: 'a − b round the alphabet. Two\'s complement subtraction; no carry out means the result went below zero, and 26 is added back.',
      ports: [bus('a', 5, 'in'), bus('b', 5, 'in'), bus('y', 5, 'out')], symbol: { kind: 'box', label: '− mod 26' },
      spec: ([x, c]) => [subF(x, c)],
      netlist: () => ({ pins: { a: [0, 3], b: [0, 9], y: [b.right, 7] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** A fixed permutation of 26 letters: what a wheel's wires are, as a decoder and an OR per output bit. */
export function wiringTable(id: string, name: string, table: readonly number[]): ComponentDef {
  return memo(`wt_${id}`, () => {
    const b = new Builder(8, 14, 2);
    b.pins('a');
    const d = b.op(decoder(5), ['a']);
    b.next();
    const bits = [0, 1, 2, 3, 4].map((k) => {
      const lines = table.flatMap((v, i) => (v >> k & 1 ? [`${d}.y${i}`] : []));
      const g = orN(lines.length);
      const u = b.add(g, undefined, `or${k}`);
      lines.forEach((l, j) => b.wire(l, `${u}.i${j}`));
      return `${u}.y`;
    });
    b.next();
    b.wire(b.op1(merger(ones(5)), bits), 'y');
    return define({
      id: `wt_${id}`, name, category: 'routing',
      summary: `${name}. On the real machine this table is 26 soldered wires and costs nothing; here each output bit is the OR of the letters that have it set.`,
      ports: [bus('a', 5, 'in'), bus('y', 5, 'out')], symbol: { kind: 'box', label: id.split('_')[0] },
      spec: ([x]) => [x < 26 ? table[x] : 0],
      netlist: () => ({ pins: { a: [0, 8], y: [b.right, 8] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** A wheel passed once: add its offset, look up, take the offset off. */
export function wheelStage(id: string, name: string, table: readonly number[]): ComponentDef {
  return memo(`ws_${id}`, () => {
    const b = new Builder(8, 12, 3);
    b.pins('a', 'off');
    const s = b.op1(add26(), ['a', 'off'], 'turn in');
    b.next();
    const t = b.op1(wiringTable(id, name, table), [s]);
    b.next();
    b.wire(b.op1(sub26(), [t, 'off'], 'turn out'), 'y');
    return define({
      id: `ws_${id}`, name: `${name}, turned`, category: 'routing',
      summary: 'One pass through a wheel standing `off` letters on from the frame: the wires do not move, the letters do, so the offset goes on before the table and comes off after it.',
      ports: [bus('a', 5, 'in'), bus('off', 5, 'in'), bus('y', 5, 'out')], symbol: { kind: 'box', label: ((n) => (id.endsWith('_b') ? `← ${n}` : `${n} →`))(/^[IVX]+_/.test(id) ? `wheel ${id.split('_')[0]}` : id.split('_')[0]) },
      spec: ([x, o]) => { const i = addF(x, o); return [subF(i < 26 ? table[i] : 0, o)]; },
      netlist: () => ({ pins: { a: [0, 3], off: [0, 9], y: [b.right, 7] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

const tableOf = (w: string): number[] => [...w].map(idx);
const inverseOf = (t: readonly number[]): number[] => { const g = new Array<number>(26); t.forEach((v, i) => { g[v] = i; }); return g; };

/** The whole machine for one key: the wheels' choice, rings, Greek wheel and plugs are built in; the windows are loaded at `load`. */
export function m4Gates(s: EnigmaSettings): ComponentDef {
  const key = `${s.reflector}${s.reflector === 'D' ? s.dPairs ?? UKWD_SAMPLE : ''}.${s.greek}.${s.rotors.join('-')}.${s.rings}.${s.start[0]}.${s.plugs.replace(/\s/g, '')}`;
  const id = `m4g_${key.replace(/[^A-Za-z0-9]/g, '_')}`;
  return memo(id, () => {
    const b = new Builder(8, 14, 4), rings = [...s.rings.toUpperCase()].map(idx), d = s.reflector === 'D';
    const refl = tableOf(s.reflector === 'D' ? ukwdWiring(s.dPairs ?? UKWD_SAMPLE) : REFLECTORS[s.reflector]), plug = plugMap(s.plugs);
    const wheels = [s.rotors[2], s.rotors[1], s.rotors[0]].map((n) => ({ n, t: tableOf(ROTORS[n].wiring), turn: ROTORS[n].turnover }));
    b.pins('key', 'load', 'set_l', 'set_m', 'set_r', 'clk');
    // The three moving windows; set = the operator's thumbwheels at `load`.
    const NAMES = ['r', 'm', 'l'] as const;
    const regs = NAMES.map((n) => b.add(register(5), `${n === 'r' ? 'right' : n === 'm' ? 'middle' : 'left'} window`, `pos_${n}`));
    regs.forEach((r) => b.wire('clk', `${r}.clk`));
    const pos = regs.map((r) => `${r}.q`);
    b.next();
    // Each pawl's condition, as the cipher has it: the middle wheel's notch moves left and middle; the right's, the middle.
    const notchOf = (i: number) => {
      const eqs = [...wheels[i].turn].map((c, k) => b.op1(equal(5), [pos[i], b.op1(constWord(5, idx(c)), [])], `${wheels[i].n} at ${c}`, `nt${i}_${k}`));
      return eqs.length === 1 ? eqs[0] : b.op1(OR, eqs);
    };
    const rightAt = notchOf(0), midAt = notchOf(1);
    const midMoves = b.op1(OR, [midAt, rightAt], 'middle moves', 'mv_m');
    b.next();
    const inc = regs.map((_, i) => b.op1(add26(), [pos[i], b.op1(constWord(5, 1), [])], undefined, `inc${i}`));
    b.next();
    const sels = [['set_r', 'nr'], ['set_m', 'nm'], ['set_l', 'nl']] as const;
    sels.forEach(([set], i) => {
      const moved = i === 0 ? inc[0] : b.op1(busMux2(5), [pos[i], inc[i], i === 1 ? midMoves : midAt], undefined, `st${i}`);
      b.wire(b.op1(busMux2(5), [moved, set, 'load'], undefined, `ld${i}`), `${regs[i]}.d`);
    });
    const one = b.op1(constWord(1, 1), []);
    regs.forEach((r) => b.wire(one, `${r}.en`));
    b.next();
    const offs = regs.map((_, i) => b.op1(sub26(), [pos[i], b.op1(constWord(5, rings[3 - i]), [])], `offset ${wheels[i].n}`, `off${i}`));
    b.next();
    // The letter's way: plugs, right, middle, left, Greek, reflector, and back.
    const P = wiringTable(`plugs_${id}`, 'The plugboard', plug);
    let c = b.op1(P, ['key'], 'plugs in', 'plug_in');
    b.next();
    wheels.forEach((w, i) => { c = b.op1(wheelStage(`${w.n}_f`, `Wheel ${w.n}`, w.t), [c, offs[i]], `${w.n} →`, `w${i}_f`); });
    b.next();
    const gr = d ? null : tableOf(GREEK[s.greek]), go = d ? 0 : mod(idx(s.start[0]) - rings[0]);
    if (gr) {
      const k = b.op1(constWord(5, go), []);
      c = b.op1(wheelStage(`${s.greek}_f`, `Greek wheel ${s.greek}`, gr), [c, k], `${s.greek} →`, 'g_f');
      c = b.op1(wiringTable(`ukw_${s.reflector}`, `Thin reflector ${s.reflector}`, refl), [c], 'reflector', 'ukw');
      c = b.op1(wheelStage(`${s.greek}_b`, `Greek wheel ${s.greek} backwards`, inverseOf(gr)), [c, k], `← ${s.greek}`, 'g_b');
    } else c = b.op1(wiringTable(`ukwd_${id}`, 'UKW-D', refl), [c], 'UKW-D', 'ukw');
    b.next();
    for (const i of [2, 1, 0]) c = b.op1(wheelStage(`${wheels[i].n}_b`, `Wheel ${wheels[i].n} backwards`, inverseOf(wheels[i].t)), [c, offs[i]], `← ${wheels[i].n}`, `w${i}_b`);
    b.next();
    b.wire(b.op1(P, [c], 'plugs out', 'plug_out'), 'lamp');
    pos.forEach((p, i) => b.wire(p, `win_${NAMES[i]}`));
    return define({
      id, name: 'Enigma M4 in gates', category: 'routing',
      summary: `The M4 for one day's key (${s.rotors.join(' ')}, rings ${s.rings}): three registers for the moving windows, the pawl conditions as comparators, and the letter's way through plugs, wheels and reflector as a chain of tables and adders.`,
      ports: [bus('key', 5, 'in'), bit('load', 'in'), bus('set_l', 5, 'in'), bus('set_m', 5, 'in'), bus('set_r', 5, 'in'), bit('clk', 'in', true), bus('lamp', 5, 'out'), bus('win_l', 5, 'out'), bus('win_m', 5, 'out'), bus('win_r', 5, 'out')],
      symbol: { kind: 'box', label: 'M4' },
      netlist: () => ({ pins: { key: [0, 6], load: [0, 12], set_l: [0, 18], set_m: [0, 24], set_r: [0, 30], clk: [0, 36], lamp: [b.right, 6], win_l: [b.right, 14], win_m: [b.right, 20], win_r: [b.right, 26] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

