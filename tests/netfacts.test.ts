import { describe, expect, it } from 'vitest';
import '../src/lib';
import { registry } from '../src/lib/define';
import { resolveComponent } from '../src/lib/resolve';
import { B0, B1, BX, BZ, type Bit, netlistOf } from '../src/sim/types';
import { compileChip } from '../src/editor/compile';
import { docFromDef } from '../src/editor/fromdef';
import type { ChipDoc } from '../src/editor/model';
import { chapterHref, chapterOfEntry, entryOfPart, explainPart, nodeOfChipId } from '../src/campaign/partindex';
import { firstTeacher } from '../src/campaign/codexlinks';
import { ancestors, ruleFor } from '../src/campaign/graph';
import { codexById } from '../src/campaign/codex';
import { chapters } from '../src/chapters';
import { hasUsage, truthOff } from '../src/view/truthrule';
import { handout, isLevelChipId } from '../src/editor/levelgate';
import { netMembers, netOfSelection } from '../src/editor/netsel';
import { levelChipId } from '../src/campaign/levels';
import { NODES, nodeById } from '../src/campaign/nodes';
import { elsewhereGroup, type ElsewhereHost, elsewhereRows } from '../src/view/tracemenu';
import { partDef } from '../src/editor/parts';
import { flatten } from '../src/sim/flatten';
import { readersOf } from '../src/sim/netcap';
import { crossings, factsOf, fanText, valueRows } from '../src/view/netfacts';

const bitsOf = (v: bigint, w: number): Bit[] => Array.from({ length: w }, (_, i) => ((v >> BigInt(i)) & 1n ? B1 : B0));

describe('a wire\'s value in the menu', () => {
  it('reads a word in hex, decimal and binary', () => {
    const [hex, dec, sgn, bin] = valueRows(bitsOf(0x1f40n, 16));
    expect(sgn.hidden).toBe(true);
    expect(hex.copy).toBe('0x1F40');
    expect(dec.copy).toBe('8000');
    expect(bin.text).toBe('0001 1111 0100 0000');
    expect(bin.copy).toBe('0001111101000000');
    expect(hex.unknown).toBe(false);
  });

  it('gives both readings of a word with its top bit set', () => {
    const [, dec, sgn] = valueRows(bitsOf(0xffffff0cn, 32));
    expect(dec.copy).toBe('4294967052');
    expect(sgn.copy).toBe('-244');
    expect(sgn.text).toBe('−244');
    expect(sgn.hidden).toBeUndefined();
  });

  it('is exact past 53 bits', () => {
    const v = (1n << 63n) + 1n;
    const [hex, dec, sgn] = valueRows(bitsOf(v, 64));
    expect(hex.copy).toBe('0x8000000000000001');
    expect(dec.copy).toBe('9223372036854775809');
    expect(sgn.copy).toBe('-9223372036854775807');
    expect(valueRows(bitsOf(v, 65))[1].copy).toBe('9223372036854775809');
  });

  it('folds a wide word and still copies all of it', () => {
    const v = (1n << 255n) + 5n;
    const [hex, dec, sgn, bin] = valueRows(bitsOf(v, 256));
    expect(hex.text).toContain('…');
    expect(hex.copy).toHaveLength(66);
    expect(BigInt(hex.copy)).toBe(v);
    expect(bin.text).toContain('…');
    expect(bin.copy).toHaveLength(256);
    expect(BigInt(`0b${bin.copy}`)).toBe(v);
    expect(dec.text).toContain('…');
    expect(BigInt(dec.copy)).toBe(v);
    // each reading folds by itself, whole digits at both ends
    expect(dec.text).toMatch(/^\d{16} … \d{16}$/);
    expect(sgn.text).toMatch(/^−\d{16} … \d{16}$/);
    expect(BigInt(sgn.copy)).toBe(v - (1n << 256n));
    // a word just past the fold's limit folds too
    expect(valueRows(bitsOf(v, 65))[3].text).toContain('…');
  });

  it('marks X and Z per bit, and never makes up a decimal', () => {
    const bits: Bit[] = [...bitsOf(0xf0n, 8), BX, BX, BX, BX, BX, BX, BX, BX];
    const [hex, dec, sgn, bin] = valueRows(bits);
    expect(sgn.hidden).toBe(true);
    expect(hex.text).toBe('0xxxF0');
    expect(hex.unknown).toBe(true);
    expect(dec.text).toBe('unknown (8 X of 16 bits)');
    expect(bin.text).toBe('xxxx xxxx 1111 0000');
    expect(valueRows([BZ, BZ, BZ, BZ])[1].text).toBe('Z: nothing drives it');
  });

  it('gives a bit one row', () => {
    expect(valueRows([B1]).map((r) => [r.k, r.text])).toEqual([['val', '1']]);
    expect(valueRows([BX])[0]).toMatchObject({ text: 'X', unknown: true });
    expect(valueRows([BZ])[0].text).toBe('Z');
    expect(valueRows([])).toEqual([]);
  });
});

describe('a sandbox selection as a net', () => {
  // a real chip through the real compiler: the maps' keys are what this got wrong once
  const doc = docFromDef(resolveComponent('xor')!) as ChipDoc;
  const c = compileChip(doc, (ref) => partDef(ref, () => undefined));
  const pin = doc.pins.find((p) => p.name === 'a')!;
  const idx = c.netOfEnd.get(`pin:${pin.id}`)!;

  it('finds a pin\'s net, and its wires', () => {
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(netOfSelection(c, { pins: [pin.id] })).toBe(idx);
    const { wires } = netMembers(c, idx);
    expect(wires.length).toBeGreaterThan(0);
    expect(netOfSelection(c, { wires })).toBe(idx);
    expect(netOfSelection(c, { wires: wires.slice(0, 1) })).toBe(idx);
    expect(netOfSelection(c, { wires, pins: [pin.id] })).toBe(idx);
  });

  it('finds a pointer\'s net by its id', () => {
    const m = { netOfWire: new Map([['w1', 3]]), netOfLabel: new Map([['l1', 3], ['l2', 4], ['gone', -1]]), netOfEnd: new Map() };
    expect(netOfSelection(m, { labels: ['l1'] })).toBe(3);
    expect(netOfSelection(m, { labels: ['l1'], wires: ['w1'] })).toBe(3);
    expect(netOfSelection(m, { labels: ['l1', 'l2'] })).toBe(-1);
    expect(netOfSelection(m, { labels: ['gone'] })).toBe(-1);
    expect(netMembers(m, 3)).toEqual({ wires: ['w1'], labels: ['l1'] });
  });

  it('is no net for parts, comments, two pins or nothing', () => {
    expect(netOfSelection(c, {})).toBe(-1);
    expect(netOfSelection(c, { parts: [doc.parts[0].id] })).toBe(-1);
    expect(netOfSelection(c, { pins: doc.pins.map((p) => p.id) })).toBe(-1);
    expect(netOfSelection(c, { wires: ['no such wire'] })).toBe(-1);
  });
});

describe('what may leave a chip', () => {
  const on = (m: ReturnType<typeof handout>) => (['sandbox', 'verilog', 'image', 'link'] as const).filter((k) => m[k]);
  it('everything from an ordinary chip; a chip of the learner needs no copying', () => {
    expect(on(handout({ chipId: 'u_adder', level: false, own: false }))).toEqual(['sandbox', 'verilog', 'image', 'link']);
    expect(on(handout({ chipId: 'u_adder', level: false, own: true }))).toEqual(['verilog', 'image', 'link']);
  });
  it('from a level only the learner’s own, and never to the sandbox or a link', () => {
    for (const o of [{ chipId: 'u_ch_cp_g_or', level: true }, { chipId: 'u_ch_cp_g_or', level: false }, { chipId: 'u_my_helper', level: true }]) {
      expect(handout({ ...o, own: false }).none).toBe(true);
      expect(on(handout({ ...o, own: false }))).toEqual([]);
      expect(on(handout({ ...o, own: true }))).toEqual(['verilog', 'image']);
    }
  });
  it('nothing from a walkthrough, which is the reference answer', () => {
    for (const level of [true, false]) for (const own of [true, false]) expect(on(handout({ chipId: 'u_walk_g_or', level, own }))).toEqual([]);
  });
  it('recognizes the chips the campaign really names', () => {
    expect(isLevelChipId(levelChipId(NODES.find((n) => n.id === 'g_or')!))).toBe(true);
    expect(isLevelChipId('u_ch_nand')).toBe(false);
    expect(isLevelChipId('u_pz_sum')).toBe(false);
  });
});

describe('the rows of Take it elsewhere', () => {
  const labels = (o: Partial<ElsewhereHost> & { def: ElsewhereHost['def'] }) => elsewhereRows({ say: () => {}, ...o }).map((r) => r.label);
  const xor = resolveComponent('xor')!, nmos = resolveComponent('nmos')!;
  const run = () => {};
  it('offers only what the host gives', () => {
    expect(labels({ def: xor })).toEqual([]);
    expect(elsewhereGroup([])).toEqual([]);
    expect(labels({ def: xor, sandbox: { label: 'Open in Sandbox', run }, verilog: true, image: run, link: { label: 'Copy a link', run } }))
      .toEqual(['Open in Sandbox', 'Copy Verilog', 'Save an image as SVG', 'Save an image as PNG', 'Copy a link']);
    // a wire: the link alone
    expect(labels({ def: null, sandbox: { label: 'Open in Sandbox', run }, verilog: true, link: { label: 'Copy a link', run } })).toEqual(['Copy a link']);
  });
  it('a primitive: no copy, its Verilog off with the reason', () => {
    const rows = elsewhereRows({ def: nmos, say: () => {}, sandbox: { label: 'Open in Sandbox', run }, verilog: true, image: 'It has no inside to draw.' });
    expect(rows.map((r) => r.label)).toEqual(['Copy Verilog', 'Save an image']);
    expect(rows.every((r) => !!r.why)).toBe(true);
  });
});

describe('what teaches a part', () => {
  it('finds what is about a part, a generated size too, and nothing for a chip of the learner', () => {
    const want: Record<string, string> = {
      nand: 'nand', xor: 'xor', not: 'not', nmos: 'mosfet', pmos: 'mosfet', inv_cmos: 'inverter', nor_cmos: 'nor', full_adder: 'fulladder', half_adder: 'halfadder',
      mux2: 'mux', mux2x4: 'mux', mux2x3: 'mux', dff: 'dff', dffe: 'dff', sr_latch: 'latch', d_latch: 'dlatch', alu8: 'alu', rv16_alu16: 'alu', rca8: 'ripple', relay_not: 'relay', tube_inv: 'triode',
      ram16x4l: 'ram', ram1024x8: 'ram', register8: 'register',
    };
    for (const [part, entry] of Object.entries(want)) expect(entryOfPart(part)?.id, part).toBe(entry);
    expect(entryOfPart('u_my_chip')).toBeUndefined();
    expect(entryOfPart('u_nand')).toBeUndefined();
  });

  it('gives no answer rather than an entry that only draws the part', () => {
    // each of these once led to the entry named here, by a prefix or the level that unlocks it
    const wrong: Record<string, string> = { dec8b10b: 'decoder', dec56: 'decoder', ks16: 'cla', zeroN: 'fanin' };
    for (const [part, entry] of Object.entries(wrong)) expect(entryOfPart(part)?.id, part).not.toBe(entry);
  });

  it('every entry and chapter it names exists, and most of the library is covered', () => {
    const known = new Set(chapters.map((c) => c.id));
    let parts = 0, found = 0, taught = 0;
    for (const def of registry.values()) {
      parts++;
      const e = entryOfPart(def.id);
      if (!e) continue;
      found++;
      expect(codexById(e.id)).toBe(e);
      const ch = chapterOfEntry(e.id);
      if (!ch) continue;
      taught++;
      expect(known.has(ch.chapter), ch.chapter).toBe(true);
      expect(chapterHref(ch)).toMatch(/^#\/c\/[\w-]+(\/\d+)?$/);
      expect(ch.label).toBeTruthy();
    }
    console.log(`part index: ${found} of ${parts} registered parts have a codex entry, ${taught} a chapter`);
    expect(found).toBeGreaterThan(100);
    expect(taught).toBeGreaterThan(100);
  });

  const some = entryOfPart('nand')!;

  it('says everything with no level', () => {
    const x = explainPart('nand', null);
    expect(x.codex).toMatchObject({ id: some.id, locked: false });
    expect(x.used).toBe(true);
    expect(explainPart('u_my_chip', null)).toEqual({ used: true });
  });

  it('on an open level: a locked entry says so, no chapter, nothing on where it is used', () => {
    const x = explainPart('nand', { unlocked: new Set(), done: false });
    expect(x.codex).toMatchObject({ id: some.id, locked: true });
    expect(x.codex!.unlock).toBeTruthy();
    expect(x.chapter).toBeUndefined();
    expect(x.used).toBe(false);
  });

  it('an unlocked entry opens, with its chapter; where it is used waits for the level', () => {
    const x = explainPart('nand', { unlocked: new Set([some.id]), done: false });
    expect(x.codex!.locked).toBe(false);
    expect(x.codex!.unlock).toBeUndefined();
    expect(x.used).toBe(false);
    expect(explainPart('nand', { unlocked: new Set([some.id]), done: true }).used).toBe(true);
  });

  it('on every level, as far as the learner really got: what it teaches stays locked, with no chapter', () => {
    let levels = 0, heldBack = 0;
    for (const n of NODES) {
      // everything before this level passed, this level not: what progress gives on reaching it
      const unlocked = new Set([...ancestors(n.id)].flatMap((id) => nodeById(id)?.codex ?? []));
      const gate = { unlocked, done: false };
      levels++;
      // whatever it may place, and its own unlocks, the parts its answer is built from
      for (const part of [...n.unlocks ?? [], ...(ruleFor(n.id).lib ?? [])].filter((x) => !x.endsWith('*'))) {
        const x = explainPart(part, gate);
        expect(x.used, `${n.id}: ${part}`).toBe(false);
        if (!x.codex) continue;
        expect(x.codex.locked, `${n.id}: ${part}`).toBe(!unlocked.has(x.codex.id));
        if (x.codex.locked) {
          heldBack++;
          expect(x.chapter, `${n.id}: ${part}`).toBeUndefined();
          expect(x.codex.unlock, `${n.id}: ${part}`).toBe(firstTeacher(x.codex.id)?.title);
        }
      }
    }
    expect(levels).toBeGreaterThan(50);
    // it would pass emptily if the gate never held anything back
    expect(heldBack).toBeGreaterThan(10);
  });

  it('a chip knows its level, whichever way it was opened', () => {
    const n = NODES.find((x) => x.id === 'g_or')!;
    expect(nodeOfChipId(levelChipId(n))).toBe(n);
    expect(nodeOfChipId(`u_walk_${n.id}`)).toBe(n);
    expect(nodeOfChipId('u_my_chip')).toBeUndefined();
  });
});

describe('why a part has no truth table', () => {
  it('matches the Inspector’s limits', () => {
    expect(truthOff(resolveComponent('xor')!)).toBeNull();
    expect(truthOff(resolveComponent('nand')!)).toBeNull();
    expect(truthOff(resolveComponent('nmos')!)).toMatch(/device/);
    expect(truthOff(resolveComponent('sr_latch') ?? resolveComponent('dff')!)).toMatch(/feedback/);
    expect(truthOff(resolveComponent('alu8')!)).toMatch(/input bits/);
  });

  it('knows who has a usage section', () => {
    expect(hasUsage(resolveComponent('xor')!)).toBe(true);
    expect(hasUsage({ ...resolveComponent('xor')!, category: 'custom' })).toBe(false);
    expect(hasUsage(resolveComponent('vdd')!)).toBe(false);
  });
});

describe('fan-out', () => {
  it('counts every input reading a net: NAND inputs at gate level, gates at switch level', () => {
    const gates = flatten(resolveComponent('xor')!, { mode: 'gate' });
    expect(readersOf(gates)[gates.root.ports.a[0]]).toBe(2);
    const inv = flatten(resolveComponent('inv_cmos')!, { mode: 'switch' });
    expect(readersOf(inv)[inv.root.ports.a[0]]).toBe(2);
    // a source or drain is not an input
    expect(readersOf(inv)[inv.root.ports.y[0]]).toBe(0);
  });
});

describe('who drives a net and who reads it', () => {
  it('reads XOR\'s nets by direction', () => {
    const xor = resolveComponent('xor')!;
    const nl = netlistOf(xor)!;
    const a = factsOf(xor, nl.nets.findIndex((n) => n.ends.includes('a')))!;
    expect(a.drivers.map((e) => e.label)).toEqual(['a']);
    expect(a.sinks.length).toBeGreaterThan(0);
    expect(a.sinks.every((e) => e.inst !== null)).toBe(true);
    expect(crossings(a)).toEqual(a.sinks.map((e) => e.label));
    const y = factsOf(xor, nl.nets.findIndex((n) => n.ends.includes('y')))!;
    expect(y.sinks.map((e) => e.label)).toEqual(['y']);
    expect(y.drivers[0].inst).not.toBeNull();
  });

  it('lists a transistor\'s source and drain as two-way', () => {
    const inv = resolveComponent('inv_cmos')!;
    const nl = netlistOf(inv)!;
    const y = factsOf(inv, nl.nets.findIndex((n) => n.ends.includes('y')))!;
    expect(y.both.length).toBeGreaterThan(0);
    expect(y.drivers).toEqual([]);
  });

  it('accounts for every end of every registered netlist', () => {
    let nets = 0;
    for (const def of registry.values()) {
      const nl = netlistOf(def);
      if (!nl) continue;
      nl.nets.forEach((n, i) => {
        const f = factsOf(def, i)!;
        nets++;
        expect(f.name).toBeTruthy();
        expect(f.drivers.length + f.sinks.length + f.both.length).toBe(n.ends.length);
      });
    }
    expect(nets).toBeGreaterThan(1000);
    expect(factsOf(resolveComponent('xor')!, 9999)).toBeNull();
  });

  it('says what a wire has to drive', () => {
    const f = { name: 'a', drivers: [], sinks: [{ inst: 'u', port: 'a', label: 'u.a' }], both: [] };
    expect(fanText(f, 1, false)).toBe('1 here, 1 NAND input flat');
    expect(fanText(f, 2, true)).toBe('1 here, 2 gate inputs flat');
  });
});
