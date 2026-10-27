// Appendix C's breadboards (DOM-free, so tests validate them): the SAP-1 as Ben Eater built it, two columns of
// modules with the bus between them, every chip a 74xx part of lib/sap.ts at its contract path, every LED a net of the
// scene's simulation. sapLayout(def) is the whole computer; moduleLayout(def) one module on its own board with DIP
// switches on its inputs, for the chapter's steps that test a module alone (as Ben tests each board before the next).

import { SAP_COMPUTER, type SapChip, sapChips } from '../lib/sap';
import { TTL_PART, TTL_PINS } from '../lib/ttl';
import { CTRL_LABEL, SAP_CTRL } from '../sap/isa';
import { type ComponentDef, netlistOf } from '../sim/types';
import { type BbActive, type BbBoard, type BbBus, type BbChip, type BbLed, type BbPin, type BbSwitch, type BreadboardLayout, ledsOf, planBoard } from '../view/bblayout';

/** What each chip does on its board (the hover card), by its path in the computer (a module's: the part after the dot). */
export const SAP_ROLES: Record<string, string> = {
  'clock.inv': 'Inverts HLT (to gate the clock) and the clock itself (NCLK, which steps the control unit on the falling edge).',
  'clock.and': 'CLK = oscillator AND NOT HLT: a halted computer stops its own clock.',
  'mar.inv': 'Turns the active-high MI into the 173\'s active-low load enables.',
  'mar.reg': 'Holds the RAM address: takes the bus\'s low nibble at the rising edge while MI = 1.',
  'mar.sel': 'Run / program: gives the RAM the MAR, or the four address switches while PROG = 1.',
  'ram.lo': '16 × 4 bits of RAM, the low nibble of every byte. Its outputs are inverted (the 74LS189\'s Q̄).',
  'ram.hi': '16 × 4 bits of RAM, the high nibble of every byte.',
  'ram.ilo': 'Turns the low 189\'s inverted outputs back; its spare gates make WE and the 245\'s enable from active-high lines.',
  'ram.ihi': 'Turns the high 189\'s inverted outputs back.',
  'ram.dlo': 'What to write, low nibble: the bus while running, the data switches while PROG = 1.',
  'ram.dhi': 'What to write, high nibble: the bus, or the data switches.',
  'ram.w': 'RI AND CLK: the write pulse while running (Ben uses an RC pulse on the clock edge).',
  'ram.wsel': 'Which write: RI · CLK while running, the WRITE button while PROG = 1.',
  'ram.drv': 'Puts RAM[MAR] on the bus while RO = 1.',
  'ir.inv': 'Turns II and IO into the active-low enables of the 173s and the 245.',
  'ir.hi': 'The opcode (the high nibble): straight to the control unit.',
  'ir.lo': 'The operand (the low nibble): an address or a number.',
  'ir.drv': 'Puts the IR\'s low 4 bits on the bus while IO = 1 (its high four inputs are tied to 0).',
  'ctl.step': 'The step counter: counts T0–T4 on the falling clock edge; the 138\'s Y5 clears it at once (five steps).',
  'ctl.dec': 'Decodes the step for the T0–T4 LEDs, and ends the count at T5.',
  'ctl.inv': 'Turns the 138\'s active-low outputs into the step LEDs; its sixth gate makes NOT RST.',
  'ctl.clr': 'Clears the step counter at T5 (the end of an instruction) or while RESET is held: Y5 AND NOT RST into the 161\'s CLR.',
  'ctl.romhi': 'Microcode, high byte: HLT MI RI RO IO II AI AO for address [ZF CF][opcode][step].',
  'ctl.romlo': 'Microcode, low byte: ΣO SU BI OI CE CO J FI.',
  'pc.inv': 'Turns J, CO and RST into the 161\'s LOAD, the 245\'s enable and the 161\'s CLR (all active low).',
  'pc.cnt': 'The program counter: counts at the rising edge while CE = 1, loads the bus\'s low nibble while J = 1.',
  'pc.drv': 'Puts the PC on the bus while CO = 1.',
  'a.inv': 'Turns AI and AO into the active-low enables.',
  'a.hi': 'A register, high nibble: loads from the bus at the rising edge while AI = 1.',
  'a.lo': 'A register, low nibble.',
  'a.drv': 'Puts A on the bus while AO = 1.',
  'alu.inv': 'Turns ΣO into the 245\'s active-low enable.',
  'alu.x0': 'B or NOT B (low nibble): XOR with SU, for A − B = A + NOT B + 1.',
  'alu.x1': 'B or NOT B (high nibble).',
  'alu.add0': 'Adds the low nibbles, carry in = SU (the + 1 of a subtraction).',
  'alu.add1': 'Adds the high nibbles; its C4 is the carry flag\'s input.',
  'alu.drv': 'Puts the sum on the bus while ΣO = 1.',
  'flags.inv': 'Turns FI into the flags register\'s active-low enables.',
  'flags.nor': 'Zero test, first half: NOR of pairs of sum bits.',
  'flags.and': 'Zero test, second half: AND of the four NORs (the sum is 0).',
  'flags.reg': 'The flags register: CF and ZF, loaded at the rising edge while FI = 1.',
  'b.inv': 'Turns BI into the active-low load enables.',
  'b.hi': 'B register, high nibble: loads from the bus while BI = 1. B never drives the bus.',
  'b.lo': 'B register, low nibble.',
  'out.clk': 'CLK AND OI clocks the output register (the 273 has no load enable).',
  'out.reg': 'Holds the value on the display.',
  'disp.rom0': 'The ones digit: segments for every value (one of three copies of Ben\'s decoder EEPROM).',
  'disp.rom1': 'The tens digit.',
  'disp.rom2': 'The hundreds digit.',
};

/** A chip's DIP pin map for the breadboard view, from lib/ttl.ts's TTL_PINS. */
export function pinsOf(kind: string): Record<number, BbPin> {
  const out: Record<number, BbPin> = {};
  (TTL_PINS[kind] ?? []).forEach((p, i) => {
    out[i + 1] = p.port ? { port: p.port, bit: p.bit, name: p.name } : p.name === 'VCC' || p.name === 'GND' ? p.name : 'NC';
  });
  return out;
}

/** The chips of the computer (or of a module) by path, for picking them onto boards. */
const chipsOf = (def: ComponentDef): Map<string, SapChip> => new Map(sapChips(def).map((c) => [c.path, c]));

/** A board's chip from the computer's list (role by the contract path: `roleKey`, default the path itself). */
function chip(all: Map<string, SapChip>, path: string, roleKey = path): BbChip {
  const c = all.get(path);
  if (!c) throw new Error(`no chip ${path}`);
  return { path: path.split('.'), part: TTL_PART[c.kind], dip: TTL_PINS[c.kind].length, role: SAP_ROLES[roleKey], pins: pinsOf(c.kind) };
}

const drawn = (part: string, dip: number, role: string): BbChip => ({ part, dip, role });

/** Board widths and gaps, in holes. */
const COL_W = 52, GAP = 1.6, BUS_W = 12;

/** Number the chips U1, U2 … in board order. */
function numberChips(boards: BbBoard[]): void {
  let n = 0;
  for (const b of boards) for (const c of b.chips) c.ref = `U${++n}`;
}

/** A board sized to its contents: the column's width, the height planBoard needs. */
function sized(b: Omit<BbBoard, 'at' | 'size'>, at: [number, number], w = COL_W): BbBoard {
  const board = { ...b, at, size: [w, 0] } as BbBoard;
  board.size = [w, Math.ceil(planBoard(board).need.h * 2) / 2];
  return board;
}

const line = (n: string): BbActive => ({ path: ['ctl'], port: n });
const act = (n: string, what: string): BbActive => ({ ...line(n), label: `${CTRL_LABEL[n as keyof typeof CTRL_LABEL]} · ${what}` });
const withGap = (l: BbLed[]): BbLed[] => l.map((x, i) => (i ? x : { ...x, gap: true }));
const bitSwitches = (port: string, width: number, label?: string): BbSwitch[] =>
  Array.from({ length: width }, (_, i) => ({ port, bit: width - 1 - i, ...(label && i === 0 ? { label } : {}) }));

/**
 * The whole SAP-1 on breadboards (sapComputer(bytes): every program has the same boards). Left column: clock,
 * memory address, RAM, instruction, control; right: program counter, A, ALU and flags, B, output; the bus strip between.
 */
export function sapLayout(def: ComponentDef): BreadboardLayout {
  const all = chipsOf(def);
  const c = (p: string) => chip(all, p);
  const left: Omit<BbBoard, 'at' | 'size'>[] = [
    {
      title: 'Clock', module: ['clock'],
      chips: [
        drawn('NE555', 8, 'The astable: the free-running clock. Drawn, not simulated: the stage\'s clock stands in for it.'),
        drawn('NE555', 8, 'The monostable: one clean pulse per press of the step button. Drawn only.'),
        drawn('NE555', 8, 'The bistable: debounces the run / step switch. Drawn only.'),
        c('clock.inv'), c('clock.and'),
      ],
      // Ben's reset button: clears the PC, the step counter, A, B, the IR and the flags (not the MAR, OUT or the RAM)
      switches: [{ port: 'rst', label: 'RESET' }],
      leds: [
        { net: { path: ['clock'], port: 'clk' }, color: 'blue', label: 'CLK' },
        { net: { path: ['ctl'], port: 'hlt' }, color: 'red', label: 'HLT' },
        { net: { path: ['bus'], port: 'clash' }, color: 'red', label: '2 ON', gap: true },
      ],
    },
    {
      title: 'Memory address', module: ['mar'], bus: 'bus',
      chips: [c('mar.inv'), c('mar.reg'), c('mar.sel')],
      switches: [{ port: 'prog', label: 'PROG' }, ...bitSwitches('addrSw', 4).map((s, i) => (i ? s : { ...s, gap: true }))],
      leds: ledsOf(['mar'], 'addr', 4, 'yellow'),
      loads: act('mi', 'loads at the next edge'),
    },
    {
      title: 'RAM 16 × 8', module: ['ram'], bus: 'bus',
      chips: ['ram.lo', 'ram.hi', 'ram.ilo', 'ram.ihi', 'ram.dlo', 'ram.dhi', 'ram.w', 'ram.wsel', 'ram.drv'].map(c),
      switches: [...bitSwitches('dataSw', 8), { port: 'write', label: 'WR', gap: true }],
      leds: ledsOf(['ram'], 'q', 8, 'red'),
      drives: act('ro', 'drives the bus'),
      loads: act('ri', 'writes at the edge'),
    },
    {
      title: 'Instruction', module: ['ir'], bus: 'bus',
      chips: ['ir.inv', 'ir.hi', 'ir.lo', 'ir.drv'].map(c),
      leds: [...ledsOf(['ir'], 'op', 4, 'blue'), ...withGap(ledsOf(['ir'], 'ir', 4, 'yellow'))],
      drives: act('io', 'drives the bus'),
      loads: act('ii', 'loads at the next edge'),
    },
    {
      title: 'Control', module: ['ctl'],
      chips: ['ctl.step', 'ctl.dec', 'ctl.inv', 'ctl.clr', 'ctl.romhi', 'ctl.romlo'].map(c),
      leds: [
        ...SAP_CTRL.map((n): BbLed => ({ net: { path: ['ctl'], port: n }, color: 'blue', label: CTRL_LABEL[n] })),
        ...withGap([0, 1, 2, 3, 4].map((t): BbLed => ({ net: { path: ['ctl'], port: 'ts', bit: t }, color: 'green', label: `T${t}` }))),
      ],
    },
  ];
  const right: Omit<BbBoard, 'at' | 'size'>[] = [
    {
      title: 'Program counter', module: ['pc'], bus: 'bus',
      chips: ['pc.inv', 'pc.cnt', 'pc.drv'].map(c),
      leds: ledsOf(['pc'], 'pc', 4, 'green'),
      drives: act('co', 'drives the bus'),
      loads: act('j', 'jumps at the edge'),
    },
    {
      title: 'A register', module: ['a'], bus: 'bus',
      chips: ['a.inv', 'a.hi', 'a.lo', 'a.drv'].map(c),
      leds: ledsOf(['a'], 'q', 8, 'red'),
      drives: act('ao', 'drives the bus'),
      loads: act('ai', 'loads at the next edge'),
    },
    {
      title: 'ALU + flags', module: ['alu'], bus: 'bus',
      chips: ['alu.inv', 'alu.x0', 'alu.x1', 'alu.add0', 'alu.add1', 'alu.drv', 'flags.inv', 'flags.nor', 'flags.and', 'flags.reg'].map(c),
      leds: [
        ...ledsOf(['alu'], 'sum', 8, 'red'),
        { net: { path: ['flags'], port: 'cf' }, color: 'green', label: 'CF', gap: true },
        { net: { path: ['flags'], port: 'zf' }, color: 'green', label: 'ZF' },
      ],
      drives: act('eo', 'drives the bus'),
      loads: act('fi', 'flags at the edge'),
    },
    {
      title: 'B register', module: ['b'], bus: 'bus',
      chips: ['b.inv', 'b.hi', 'b.lo'].map(c),
      leds: ledsOf(['b'], 'q', 8, 'red'),
      loads: act('bi', 'loads at the next edge'),
    },
    {
      title: 'Output', module: ['out'], bus: 'bus',
      chips: [
        c('out.clk'), c('out.reg'), c('disp.rom2'), c('disp.rom1'), c('disp.rom0'),
        drawn('NE555', 8, 'Ben\'s display clock: it multiplexes one EEPROM over the digits. Drawn only: here three EEPROMs show the digits at once.'),
        drawn('74LS76', 16, 'Ben\'s digit counter (two JK flip-flops) for the multiplexing. Drawn only.'),
        drawn('74LS139', 16, 'Ben\'s digit select: lights one digit at a time. Drawn only.'),
      ],
      digits: [2, 1, 0].map((k) => ({ path: ['disp'], port: `d${k}` })),
      loads: act('oi', 'shows at the next edge'),
    },
  ];
  const stack = (into: BbBoard[], list: Omit<BbBoard, 'at' | 'size'>[], x: number, y = 0): number => {
    for (const b of list) {
      const s = sized(b, [x, y]);
      into.push(s);
      y = Math.round((y + s.size[1] + GAP) * 10) / 10;
    }
    return y - GAP;
  };
  const boards: BbBoard[] = [];
  const hl = stack(boards, left, 0);
  const hr = stack(boards, right, COL_W + BUS_W + 2 * GAP);
  numberChips(boards);
  // a narrow canvas (a phone): the right column under the left one, the bus strip beside them both (the chips are
  // the same objects, numbered the same)
  const column: BbBoard[] = [];
  const hn = stack(column, right, 0, stack(column, left, 0) + GAP);
  const note = `${boards.reduce((n, b) => n + b.chips.length, 0)} ICs: 74LS series and 28C16 EEPROMs (pale: drawn only)`;
  const bus = (h: number): BbBus[] => [{ id: 'bus', title: 'Bus', at: [COL_W + GAP, 0], size: [BUS_W, h], path: ['bus'], port: 'bus' }];
  return { note, buses: bus(Math.max(hl, hr)), boards, narrow: { note, buses: bus(hn), boards: column } };
}

/** One module on its own board, its root inputs on DIP switches (the clock left to the stage), its outputs on LEDs. */
export interface ModuleLayoutOpts {
  title: string;
  /** Extra chips drawn first (the clock's 555s). */
  before?: BbChip[];
  /** Outputs on LEDs (default: every output), and their colour. */
  leds?: { port: string; color?: BbLed['color']; label?: string }[];
  /** Inputs left off the switches (default: the clock). */
  skip?: string[];
  /** A board ring: driving while this root input is 1, loading while that one is. */
  drives?: string;
  loads?: string;
  /** Switch labels for 1-bit inputs (default: the port's name in capitals). */
  labels?: Record<string, string>;
}

export function moduleLayout(def: ComponentDef, o: ModuleLayoutOpts): BreadboardLayout {
  // the roles are written for the computer: the module's instance name there
  const inst = netlistOf(SAP_COMPUTER)?.instances.find((i) => i.def === def)?.name;
  const all = chipsOf(def);
  const chips = [...all.keys()].map((p) => chip(all, p, inst ? `${inst}.${p}` : p));
  const ins = def.ports.filter((p) => p.dir === 'in' && !p.clock && !(o.skip ?? []).includes(p.name));
  const switches: BbSwitch[] = ins.flatMap((p, i) => {
    const g = (p.width === 1 ? [{ port: p.name, label: o.labels?.[p.name] ?? p.name.toUpperCase() }] : bitSwitches(p.name, p.width, p.name)) as BbSwitch[];
    return i ? g.map((s, j) => (j ? s : { ...s, gap: true })) : g;
  });
  const outs: NonNullable<ModuleLayoutOpts['leds']> = o.leds ?? def.ports.filter((p) => p.dir === 'out').map((p) => ({ port: p.name }));
  const leds: BbLed[] = outs.flatMap((l, i) => {
    const p = def.ports.find((q) => q.name === l.port)!;
    const ls = p.width === 1 ? [{ net: { path: [], port: p.name }, color: l.color ?? 'red', label: l.label ?? p.name.toUpperCase() } as BbLed]
      : ledsOf([], p.name, p.width, l.color ?? 'red', (b) => (b === p.width - 1 ? p.name : ''));
    return i ? withGap(ls) : ls;
  });
  const W = 64;
  const top = sized({ title: o.title, chips: [...(o.before ?? []), ...chips], leds, ...(o.drives ? { drives: { path: [], port: o.drives, label: `${o.drives.toUpperCase()} · drives the bus` } } : {}), ...(o.loads ? { loads: { path: [], port: o.loads, label: `${o.loads.toUpperCase()} · loads at the next edge` } } : {}) }, [0, 0], W);
  const boards = [top];
  if (switches.length) boards.push(sized({ title: 'Test switches', chips: [], switches }, [0, top.size[1] + GAP], W));
  numberChips(boards);
  return { note: `${top.chips.length} ICs on one board, its inputs on DIP switches`, boards };
}
