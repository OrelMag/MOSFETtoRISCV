import { describe, expect, it } from 'vitest';
import { CPU4_BCD, CPU4_STATE } from '../src/lib/cpu4';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { pack } from '../src/sim/values';
import { BbNets, type BreadboardLayout, defAt, layoutBounds, packBits, pinName, pinSides, planBoard, stubOf, validateLayout } from '../src/view/bblayout';
import { insideOf } from '../src/view/breadboard';
import { register } from '../src/lib/sequential';
import { CPU4_BB } from './fixtures/bbcpu4';

const clone = (l: BreadboardLayout): BreadboardLayout => structuredClone(l);

describe('breadboard layout', () => {
  it('the 4-bit CPU fixture is valid', () => {
    expect(validateLayout(CPU4_BB, CPU4_BCD)).toEqual([]);
  });

  it('finds paths as the stage flattens: a ROM is a leaf', () => {
    expect(typeof defAt(CPU4_BCD, ['regs', 'r0'])).toBe('object');
    expect(defAt(CPU4_BCD, ['regs', 'nope'])).toMatch(/no instance nope/);
    expect(defAt(CPU4_BCD, ['rom', 'mux'])).toMatch(/simulated as one leaf/);
    // the ROM itself is fine: its ports are nets of the scene
    expect(typeof defAt(CPU4_BCD, ['rom'])).toBe('object');
  });

  it('reports bad paths, ports, bits, switches and pins', () => {
    const l = clone(CPU4_BB);
    const regs = l.boards.find((b) => b.title === 'Registers')!;
    regs.chips[0].path = ['regs', 'r99'];
    regs.leds![0].net.port = 'qq';
    regs.leds![1].net.bit = 4;
    regs.chips[1].pins![17] = 'GND';
    regs.chips[1].pins![3] = { port: 'nope' };
    l.boards.find((b) => b.title === 'Accumulator')!.switches![0].port = 'halt';
    l.boards.find((b) => b.title === 'Output')!.digits![0].port = 'leds';
    l.boards.find((b) => b.title === 'Output')!.digits![1].hex = false;
    const errs = validateLayout(l, CPU4_BCD);
    expect(errs.some((e) => /no instance r99/.test(e))).toBe(true);
    expect(errs.some((e) => /has no port qq/.test(e))).toBe(true);
    expect(errs.some((e) => /4 bits wide, bit 4/.test(e))).toBe(true);
    expect(errs.some((e) => /pin 17 is not one of 1–16/.test(e))).toBe(true);
    expect(errs.some((e) => /pin 3.*has no port nope/.test(e))).toBe(true);
    expect(errs.some((e) => /halt is not an input/.test(e))).toBe(true);
    // 'leds' as a hex digit is fine (4 bits); a 4-bit port as 8 segments is not
    expect(errs.some((e) => /d2 is 4 bits wide, bit 0 \+ 8/.test(e))).toBe(true);
    expect(errs.length).toBe(7);
  });

  it('reports overlapping boards, overflowing ones and a board away from its bus', () => {
    const l = clone(CPU4_BB);
    l.boards[1].at = [10, 10];
    const errs = validateLayout(l, CPU4_BCD);
    expect(errs).toContain('board Clock overlaps board PC & stack');
    const m = clone(CPU4_BB);
    m.boards[3].size = [20, 18];
    const e2 = validateLayout(m, CPU4_BCD);
    expect(e2.some((e) => /board Registers: its contents need/.test(e))).toBe(true);
    const n = clone(CPU4_BB);
    n.boards[2].bus = 'a';
    n.boards[2].at = [0, 120]; // below the strip's end
    expect(validateLayout(n, CPU4_BCD).some((e) => /Decode: does not sit beside bus a/.test(e))).toBe(true);
    n.boards[2].bus = 'b';
    expect(validateLayout(n, CPU4_BCD).some((e) => /no bus strip b/.test(e))).toBe(true);
  });

  it('plans a board: chips in a row, indicators below, wrapping when the row is full', () => {
    const p = planBoard(CPU4_BB.boards[3]);
    expect(p.chips.map((c) => c.y)).toEqual([p.chips[0].y, p.chips[0].y, p.chips[0].y, p.chips[0].y]);
    expect(p.leds[0].y).toBeGreaterThan(p.chips[0].y + p.chips[0].h);
    const narrow = { ...CPU4_BB.boards[3], size: [22, 40] as [number, number], leds: [] };
    const q = planBoard(narrow);
    expect(q.chips[2].y).toBeGreaterThan(q.chips[0].y);
    expect(q.need.w).toBeLessThanOrEqual(22);
    const b = layoutBounds(CPU4_BB);
    expect(b.w).toBe(144);
    expect(stubOf(CPU4_BB.boards[3], CPU4_BB.buses![0])!.x).toBe(64);
  });

  it('pin cards list a DIP package counter-clockwise', () => {
    expect(pinSides(16)).toEqual({ left: [1, 2, 3, 4, 5, 6, 7, 8], right: [16, 15, 14, 13, 12, 11, 10, 9] });
    expect(pinName({ port: 'q', bit: 2 }, 4)).toBe('q[2]');
    expect(pinName({ port: 'q', bit: 2, name: '3Q' }, 4)).toBe('3Q');
    expect(pinName('VCC')).toBe('VCC');
  });

  it('reads every LED from the simulation, equal to the registers it shows', () => {
    const design = flatten(CPU4_BCD, { mode: 'gate', expand: (d, n) => n.parent === null || !d.preferBehavior });
    const sim = new GateSim(design);
    sim.reset('zero');
    sim.settle();
    const nets = new BbNets(design.root);
    const acc = nets.bus({ path: ['acc'], port: 'a' }, 4);
    const pc = nets.bus({ path: ['pcs'], port: 'pc' }, 8);
    const r0 = nets.bus({ path: ['regs', 'r0'], port: 'q' }, 4);
    const missing = nets.net({ path: ['nope'], port: 'q' });
    const node = (p: string) => design.root.children!.get(p.split('.')[0])!.children!.get(p.split('.')[1])!;
    for (let c = 0; c < 40; c++) {
      sim.setInput('clk', 1);
      sim.settle();
      sim.setInput('clk', 0);
      sim.settle();
      const bits = nets.read(sim);
      expect(packBits(acc.map((i) => bits[i]))).toBe(pack(sim.getBits(node(CPU4_STATE.a).ports.q)));
      expect(packBits(pc.map((i) => bits[i]))).toBe(pack(sim.getBits(node(CPU4_STATE.pc).ports.q)));
      expect(packBits(r0.map((i) => bits[i]))).toBe(pack(sim.getBits(node('regs.r0').ports.q)));
      expect(bits[missing]).toBe(2);
    }
    expect(nets.size).toBe(17);
  });

  it('a chip card says what is inside and what it costs', () => {
    expect(insideOf(register(4))).toBe('Inside: 4 × D flip-flop with enable · 60 NANDs');
  });
});
