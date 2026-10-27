import { describe, expect, it } from 'vitest';
import { CPU4_BCD, CPU4_STATE } from '../src/lib/cpu4';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { pack } from '../src/sim/values';
import { BB_MARGIN, BbNets, type BreadboardLayout, busDrivers, defAt, drillCrumbs, drillOf, drillPane, driverOf, fitBoards, netIdOf, rovingMove, layoutBounds, packBits, pickArrangement, pinName, pinSides, planBoard, stubOf, validateLayout } from '../src/view/bblayout';
import { SAP_COMPUTER } from '../src/lib/sap';
import { sapLayout } from '../src/widgets/saplayout';
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

describe('breadboard view: fit and arrangement', () => {
  it('fits the boards whole, centred, at the svg\'s aspect', () => {
    const v = fitBoards({ w: 100, h: 50 }, 800, 800);
    expect(v.w / v.h).toBeCloseTo(1);
    expect(v.x).toBeCloseTo(-BB_MARGIN);
    expect(v.y + v.h / 2).toBeCloseTo(25);
  });

  it('a column taller than the canvas fits its width, from the top', () => {
    const v = fitBoards({ w: 60, h: 200 }, 390, 400, true);
    expect(v).toMatchObject({ x: -BB_MARGIN, y: -BB_MARGIN, w: 64 });
    expect(v.w / v.h).toBeCloseTo(390 / 400);
    // one that fits anyway is centred whole
    const s = fitBoards({ w: 60, h: 20 }, 390, 400, true);
    expect(s.y + s.h / 2).toBeCloseTo(10);
  });

  it('the SAP-1 reads whole on a laptop and as one column on a phone', () => {
    const l = sapLayout(SAP_COMPUTER);
    expect(l.narrow).toBeTruthy();
    expect(pickArrangement(l, 780, 580)).toBe('wide');
    expect(pickArrangement(l, 390, 420)).toBe('narrow');
    // beside an open panel on a laptop: the column, larger
    expect(pickArrangement(l, 436, 573)).toBe('narrow');
    // a layout without one keeps its own
    expect(pickArrangement(CPU4_BB, 300, 300)).toBe('wide');
    const n = layoutBounds(l.narrow!), w = layoutBounds(l);
    expect(n.w).toBeLessThan(w.w * 0.6);
  });

  it('checks the narrow arrangement too', () => {
    const l = sapLayout(SAP_COMPUTER);
    l.narrow!.boards[1].at = [0, 0];
    l.narrow!.boards.pop();
    const errs = validateLayout(l, SAP_COMPUTER);
    expect(errs.some((e) => /^narrow: board .* overlaps/.test(e))).toBe(true);
    expect(errs).toContain('narrow: not the same boards and chips');
  });
});

describe('breadboard view: the drill', () => {
  const l = sapLayout(SAP_COMPUTER);

  it('finds the board and chip a path is at or inside', () => {
    const d = drillOf(l, ['ir', 'hi'])!;
    expect(d.board.title).toBe('Instruction');
    expect(d.chip?.part).toBe('74LS173');
    // deeper: still that chip
    expect(drillOf(l, ['ir', 'hi', 'ff0', 'nand1'])!.chip).toBe(d.chip);
    // a module: its board, no chip
    expect(drillOf(l, ['a'])).toMatchObject({ board: { title: 'A register' }, chip: null });
    // the top and the bus strip are not on a board
    expect(drillOf(l, [])).toBeNull();
    expect(drillOf(l, ['bus'])).toBeNull();
    // the flags' chips sit on the ALU's board
    expect(drillOf(l, ['flags', 'reg'])!.board.title).toBe('ALU + flags');
  });

  it('names the way there: boards, board, chip, the levels below', () => {
    const d = drillOf(l, ['ir', 'hi', 'ff0'])!;
    const c = drillCrumbs(d, ['ir', 'hi', 'ff0'], (p) => (p.length === 3 ? 'DFFE_R' : ''));
    expect(c.map((x) => x.label)).toEqual(['Boards', 'Instruction', `${d.chip!.ref} · 74LS173`, 'ff0']);
    expect(c.map((x) => x.to)).toEqual(['boards', ['ir'], ['ir', 'hi'], null]);
    expect(c[3].kind).toBe('DFFE_R');
    // on the chip itself, the chip is the level on screen
    expect(drillCrumbs(d, ['ir', 'hi']).map((x) => x.to)).toEqual(['boards', ['ir'], null]);
    // a module's board is the level on screen
    expect(drillCrumbs(drillOf(l, ['a'])!, ['a']).map((x) => x.to)).toEqual(['boards', null]);
  });

  it('two columns where they fit beside the panels, else the board on top', () => {
    expect(drillPane(1100, 600)).toMatchObject({ stacked: false, w: 506, h: 600 });
    expect(drillPane(1100, 600, 360).stacked).toBe(true);
    const p = drillPane(390, 330);
    expect(p).toMatchObject({ stacked: true, w: 390 });
    expect(p.h).toBeGreaterThanOrEqual(160);
    expect(drillPane(2400, 900).w).toBe(620);
  });
});

describe('breadboard view: LEDs and keys', () => {
  const l = sapLayout(SAP_COMPUTER);
  const root = flatten(SAP_COMPUTER).root;

  it('names the chip that drives an LED, or the input', () => {
    const a = l.boards.find((b) => b.title === 'A register')!;
    const d = driverOf(l, root, netIdOf(root, a.leds![0].net)); // q[7]: the high 173
    expect(d && 'chip' in d && d.chip.path).toEqual(['a', 'hi']);
    const hlt = driverOf(l, root, netIdOf(root, { path: ['ctl'], port: 'hlt' }));
    expect(hlt && 'chip' in hlt && hlt.chip.part).toBe('28C16');
    expect(driverOf(l, root, netIdOf(root, { path: [], port: 'prog' }))).toEqual({ input: 'prog', bit: 0 });
    expect(driverOf(l, root, -1)).toBeNull();
  });

  it('finds every board\'s bus drivers: its 245s', () => {
    const m = busDrivers(l, root, l.buses![0]);
    for (const t of ['Program counter', 'A register', 'Instruction', 'RAM 16 × 8', 'ALU + flags']) {
      expect(m.get(t)?.map((c) => c.part), t).toEqual(['74LS245']);
    }
    expect(m.has('B register')).toBe(false);
  });

  it('moves the focus by rows and columns', () => {
    // two rows: three chips, then four LEDs under them
    const boxes = [0, 9, 18].map((x) => ({ x, y: 4, w: 8, h: 4 })).concat([0, 2, 4, 20].map((x) => ({ x, y: 10, w: 1.6, h: 2.7 })));
    expect(rovingMove(boxes, 0, 'ArrowRight')).toBe(1);
    expect(rovingMove(boxes, 0, 'ArrowLeft')).toBe(0);
    expect(rovingMove(boxes, 1, 'ArrowDown')).toBe(6); // under the middle chip (x = 13): the nearest LED across, x = 20.8
    expect(rovingMove(boxes, 0, 'ArrowDown')).toBe(5);
    expect(rovingMove(boxes, 4, 'ArrowUp')).toBe(0);
    expect(rovingMove(boxes, 6, 'ArrowUp')).toBe(2);
    expect(rovingMove(boxes, 6, 'ArrowDown')).toBe(6);
    expect(rovingMove(boxes, 2, 'End')).toBe(6);
    expect(rovingMove(boxes, 5, 'Home')).toBe(0);
  });
});
