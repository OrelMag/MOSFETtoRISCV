// Wide pins: a sandbox pin may be up to MAX_WIDTH bits, and its value stays exact end to end
// (document, store, share link, simulator, labels, VCD). JS numbers are exact to 53 bits only,
// so every check here uses a bit past that (bit 96 of a pipeline-register-sized word).

import { describe, expect, it } from 'vitest';
import { nextDrive } from '../src/editor/chips';
import { docFromDef } from '../src/editor/fromdef';
import { allOnes, type ChipDoc, pinBig, pinValue } from '../src/editor/model';
import { MAX_WIDTH } from '../src/editor/parts';
import { EditorSim, pinBits } from '../src/editor/runtime';
import { decodeShare, encodeShare } from '../src/editor/share';
import { type KV, loadWorkspace, saveWorkspace, sanitizeChip } from '../src/editor/store';
import { register } from '../src/lib/sequential';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { SwitchSim } from '../src/sim/switchsim';
import { B0, B1, BX, BZ } from '../src/sim/types';
import { describeBits, formatBits, formatNumber, packBig, parseBig, unpackBig } from '../src/sim/values';
import { toVcd } from '../src/sim/vcd';
import { chip, compileLib, part, pin, wire, workspace } from './editorkit';

const W = 97;
/** Bit 96 and bit 0: a float cannot hold it (2^96 + 1 rounds to 2^96). */
const BIG = (1n << 96n) | 1n;
const BIG_V = pinValue(BIG);

/** A chip around the library's 97-bit register: d, en (set to 1), clk in; q out. */
function regChip(d?: ChipDoc['pins'][number]['value']): ChipDoc {
  return chip('u_reg', 'wide register', {
    pins: [
      { ...pin('d', 'in', [0, 2], W), ...(d === undefined ? {} : { value: d }) }, { ...pin('en', 'in', [0, 6]), value: 1 },
      { ...pin('clk', 'in', [0, 8]), kind: 'clock' }, pin('q', 'out', [40, 2], W),
    ],
    parts: [part('r', { lib: `reg${W}` }, [8, 0])],
    wires: [wire('w1', 'pin:d', 'r.d'), wire('w2', 'pin:en', 'r.en'), wire('w3', 'pin:clk', 'r.clk'), wire('w4', 'r.q', 'pin:q')],
  });
}

/** One rising and one falling clock edge, by hand. */
const clock = (es: EditorSim) => { es.toggleClocks(); es.toggleClocks(); };

const memKV = (): KV & { m: Map<string, string> } => {
  const m = new Map<string, string>();
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
};

describe('wide values', () => {
  it('BigInt packing, parsing and formatting are exact at any width', () => {
    const bits = unpackBig(BIG, W);
    expect(bits[0]).toBe(B1);
    expect(bits[96]).toBe(B1);
    expect(bits.filter((b) => b === B1).length).toBe(2);
    expect(packBig(bits)).toBe(BIG);
    expect(packBig([B1, BX])).toBeNull();
    expect(unpackBig(-1n, 70).every((b) => b === B1)).toBe(true);

    expect(formatBits(bits, 'hex')).toBe('0x1_00000000_00000000_00000001');
    expect(formatBits(bits, 'dec')).toBe('79228162514264337593543950337');
    // bit 96 is the sign bit of a 97-bit word: 2^96 + 1 − 2^97
    expect(formatBits(bits, 'sdec')).toBe(String(BIG - (1n << 97n)));
    expect(formatBits(bits, 'bin')).toBe(`0b1_${'0000_'.repeat(23)}0001`);
    expect(formatNumber(BIG, W, 'hex')).toBe('0x1_00000000_00000000_00000001');
    expect(formatNumber(-1n, 4, 'hex')).toBe('0xx');
    // X stays per nibble (hex) / per bit (otherwise), at any width
    const x = bits.slice();
    x[50] = BX;
    expect(formatBits(x, 'hex')).toBe('0x1_00000000_000x0000_00000001');
    expect(formatBits(x, 'dec')).toMatch(/^1_0000_.*x.*0001$/);
    // tooltips: no binary past 64 bits
    expect(describeBits(bits)).toBe(`0x1_00000000_00000000_00000001 · ${BIG}`);
    expect(describeBits([B1, B0, B1])).toBe('0x5 · 0b101 · 5');
    // narrow values format as before
    expect(formatBits(unpackBig(0xdeadbeefn, 32), 'hex')).toBe('0xDEADBEEF');
    expect(formatBits(unpackBig(2n ** 64n - 1n, 64), 'dec')).toBe('18446744073709551615');

    for (const s of ['0x1_0000_0000_0000_0000_0000_0001', '79228162514264337593543950337', `0b1${'0'.repeat(95)}1`]) expect(parseBig(s)).toBe(BIG);
    for (const s of ['', '0x', '-1', '1.5', '0b2', 'abc']) expect(parseBig(s)).toBeNull();
  });

  it('a pin value is a number while exact, else hex text, one spelling per value', () => {
    expect(pinValue(5n)).toBe(5);
    expect(pinValue(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    expect(pinValue(2n ** 53n)).toBe('0x20000000000000');
    expect(BIG_V).toBe('0x1000000000000000000000001');
    expect(pinBig(BIG_V)).toBe(BIG);
    expect(pinBig(undefined)).toBe(0n);
    expect(allOnes(4)).toBe(15);
    expect(allOnes(W)).toBe(`0x1${'f'.repeat(24)}`);
    expect(nextDrive({ ...pin('io', 'inout', [0, 0], W), value: 0 })).toBe(allOnes(W));
    // the low `w` bits of the value drive the pin
    expect(pinBits(BIG_V, W)).toEqual(unpackBig(BIG, W));
    expect(pinBits(BIG_V, 8)).toEqual([B1, B0, B0, B0, B0, B0, B0, B0]);
  });

  it('the store keeps wide values exact and canonical', () => {
    const doc = regChip(BIG_V);
    expect(sanitizeChip(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
    const withValue = (value: unknown) => sanitizeChip({ ...doc, pins: [{ ...doc.pins[0], value }] })!.pins[0].value;
    expect(withValue('0X1000000000000000000000001')).toBe(BIG_V); // case
    expect(withValue('0x00ff')).toBe(255); // a small value is a number
    expect(withValue(2 ** 60)).toBe('0x1000000000000000'); // an older document's float, taken as written
    expect(withValue(7)).toBe(7);
    for (const bad of ['12', '0x', '0xg', -1, 1.5, null, {}]) expect(withValue(bad)).toBeUndefined();

    const kv = memKV();
    const ws = workspace(doc);
    expect(saveWorkspace(ws, kv)).toEqual({ ok: true });
    expect(loadWorkspace(kv).chips.u_reg.pins[0].value).toBe(BIG_V);
  });

  it('share links carry wide values', async () => {
    const doc = regChip(BIG_V);
    const back = await decodeShare(await encodeShare([doc]));
    expect(back).toEqual([doc]);
  });
});

describe('wide pins in the simulator', () => {
  it('MAX_WIDTH holds every library port', () => {
    expect(MAX_WIDTH).toBeGreaterThanOrEqual(229); // the widest pipeline register
  });

  it('sims drive inputs bit by bit, exactly, and carry them across a rebuild', () => {
    const d = flatten(register(W), { mode: 'gate' });
    const g = new GateSim(d);
    g.setInputBits('d', unpackBig(BIG, W));
    g.setInput('en', 1);
    expect(packBig(g.getInputBits('d'))).toBe(BIG);
    g.settle();
    g.setInput('clk', 1);
    g.settle();
    g.setInput('clk', 0);
    g.settle();
    expect(packBig(g.getBits(d.root.ports.q))).toBe(BIG);
    const g2 = new GateSim(d);
    g2.carry(g);
    expect(packBig(g2.getInputBits('d'))).toBe(BIG);
    expect(g2.getInput('en')).toBe(1);
    // gate level has no Z: an undriven bit reads as X
    g2.setInputBits('d', unpackBig(BIG, W).map((b, i) => (i === 3 ? BZ : b)));
    expect(g2.getInputBits('d')[3]).toBe(BX);
    expect(g2.getInput('d')).toBe(-1);

    // switch level keeps Z per bit; a number still drives as before
    const s = new SwitchSim(flatten(twoBitChip(), { mode: 'switch' }));
    s.setInputBits('a', [B1, BZ]);
    expect(s.getInputBits('a')).toEqual([B1, BZ]);
    expect(s.getInput('a')).toBe(-1);
    s.setInputBits('a', [BZ, BZ]);
    expect(s.getInput('a')).toBe(-BZ);
    s.setInput('a', 2);
    expect(s.getInputBits('a')).toEqual([B0, B1]);
  });

  it('a 97-bit register chip stores a 97-bit value exactly', () => {
    const doc = regChip();
    const c = compileLib(doc);
    expect(c.diags.filter((x) => x.level === 'error')).toEqual([]);
    expect(c.def.ports.find((p) => p.name === 'd')!.width).toBe(W);
    const es = new EditorSim({ debounceMs: 0 });
    es.update(c, doc.pins);
    es.setInput(doc.pins[0], BIG_V);
    clock(es);
    const q = es.pinBits('q')!;
    expect(packBig(q)).toBe(BIG);
    expect(formatBits(q, 'hex')).toBe('0x1_00000000_00000000_00000001');
    // the value on the wire into the register too
    expect(packBig(es.wireBits('w1')!)).toBe(BIG);

    // A saved value is applied when the simulator is built (a reload).
    const doc2 = regChip(BIG_V);
    const es2 = new EditorSim({ debounceMs: 0 });
    es2.update(compileLib(doc2), doc2.pins);
    clock(es2);
    expect(packBig(es2.pinBits('q')!)).toBe(BIG);
    // all ones: 97 bits set
    es2.setInput(doc2.pins[0], allOnes(W));
    clock(es2);
    expect(es2.pinBits('q')!.every((b) => b === B1)).toBe(true);
  });

  it('a library part with ports past 64 bits opens as a chip whose pins drive it', () => {
    const doc = docFromDef(register(W));
    if ('error' in doc) throw new Error(doc.error);
    const pins = doc.pins.map((p) => (p.name === 'd' ? { ...p, value: BIG_V } : p.name === 'en' ? { ...p, value: 1 } : p));
    const es = new EditorSim({ debounceMs: 0 });
    es.update(compileLib({ ...doc, pins }), pins);
    clock(es);
    expect(packBig(es.pinBits('q')!)).toBe(BIG);
  });

  it('VCD writes wide values exactly', () => {
    const vcd = toVcd([{ name: 'q', width: W, t: [0, 5], v: [-1, BIG] }]);
    expect(vcd).toContain('$var wire 97 ! q [96:0] $end');
    expect(vcd).toContain('bx !');
    expect(vcd).toContain(`b1${'0'.repeat(95)}1 !`);
  });
});

/** A chip with a 2-bit input (a NAND: its transistors at switch level). */
function twoBitChip() {
  const d = chip('u_t', 't', {
    pins: [pin('a', 'in', [0, 0], 2), pin('y', 'out', [20, 0])],
    parts: [part('s', { split: [1, 1] }, [4, 0]), part('n', { lib: 'nand' }, [10, 0])],
    wires: [wire('w1', 'pin:a', 's.in'), wire('w2', 's.o0', 'n.a'), wire('w3', 's.o1', 'n.b'), wire('w4', 'n.y', 'pin:y')],
  });
  const c = compileLib(d);
  expect(c.diags.filter((x) => x.level === 'error')).toEqual([]);
  return c.def;
}
