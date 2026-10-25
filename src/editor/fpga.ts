// The sandbox's FPGA export (File ▸ Export Verilog for FPGA…), DOM-free so CI scripts it too
// (scripts/fpga-export.ts): the open chip through the synthesizable export (vexport.ts: flip-flops,
// a user chip ticked as one included, as clocked processes; big memories from their hdl.synth bodies),
// sandbox I/O parts (keys, switch banks, LEDs, displays, consoles) punched out as top-level ports, a
// board top for a Sipeed Tang Nano 9K (clock divider, power-on reset, buttons and LEDs, the rest on
// header pins), its Gowin .cst as a clearly labelled example, a README, and a report of whatever will
// not synthesize cleanly: a latch still drawn as a NAND loop (an FPGA tool rejects it or makes a
// combinational loop of it), a user chip marked as a flip-flop that cannot become one process,
// initial contents that do not travel, pins the example board has no room for.

import { flatten, type HierNode } from '../sim/flatten';
import { type ComponentDef, isExternal, netlistOf } from '../sim/types';
import { ffLeaf, synthVerilog, type TopPort } from '../sim/vexport';
import { displayOf } from './parts';

export interface FpgaIssue { level: 'error' | 'warn' | 'info'; text: string }
export interface FpgaFile { name: string; text: string }
export interface FpgaExport {
  /** False when the design cannot be exported at all (`issues` says why); `files` is then empty. */
  ok: boolean;
  top: string;
  board: string;
  files: FpgaFile[];
  issues: FpgaIssue[];
  modules: number;
  plan?: BoardPlan;
}

/** A latch loop left in the exported design: NANDs feeding each other with no process between them. */
export interface LatchLoop { where: string; part: string; parts: string[]; nands: number }

// ---------------------------------------------------------------------------------------------
// The example board: a Sipeed Tang Nano 9K (GW1NR-9). Pin numbers from Sipeed's examples: an
// example to check against the board's schematic, which the .cst says in so many words.

export const BOARD = {
  name: 'Sipeed Tang Nano 9K',
  device: 'GW1NR-LV9QN88PC6/I5',
  family: 'GW1N-9C',
  clockMHz: 27,
  clock: 52,
  /** S1, S2 (pressed: low). */
  buttons: [4, 3],
  /** LED 0 … 5 (lit: low). */
  leds: [10, 11, 13, 14, 15, 16],
  /** Header pins this example uses for everything else. */
  gpio: [25, 26, 27, 28, 29, 30, 33, 34, 40, 35, 41, 42, 51, 53, 54, 55, 56, 57, 68, 69],
};

export type Resource = { kind: 'button' | 'led' | 'gpio_in' | 'gpio_out'; index: number; pin: number };
export interface BitMap { port: string; bit: number; width: number; res: Resource; label: string }
export interface BoardPlan {
  clocks: string[];
  reset?: { port: string; activeLow: boolean };
  bits: BitMap[];
  /** Bits with no board pin: inputs held at 0, outputs left unconnected. */
  unplaced: { port: string; dir: 'in' | 'out' | 'inout'; bits: number }[];
  gpioIn: number;
  gpioOut: number;
}

const isClock = (p: TopPort) => p.dir === 'in' && p.width === 1 && !p.external && (p.clock || /^(clk|clock)$/i.test(p.name));
const RESET_HIGH = /^(rst|reset)$/i, RESET_LOW = /^(rst_?n|n_?rst|reset_?n|n_?reset|resetb|rstb)$/i;

/** Which board pin each bit of the top's ports goes to: clocks from the divider, a reset from S1, inputs on the
 * remaining buttons then header pins, outputs on the LEDs then header pins. */
export function boardPlan(ports: TopPort[]): BoardPlan {
  const clocks = ports.filter(isClock).map((p) => p.name);
  const rp = ports.find((p) => p.dir === 'in' && p.width === 1 && !p.external && !clocks.includes(p.name) && (RESET_HIGH.test(p.name) || RESET_LOW.test(p.name)));
  const reset = rp ? { port: rp.name, activeLow: RESET_LOW.test(rp.name) } : undefined;
  const bits: BitMap[] = [];
  const unplaced: BoardPlan['unplaced'] = [];
  const buttons = (reset ? [1] : [0, 1]).map((index) => ({ kind: 'button' as const, index, pin: BOARD.buttons[index] }));
  let gpio = 0, gpioIn = 0, gpioOut = 0;
  const label = (p: TopPort, b: number) => {
    const bit = p.width > 1 ? `${p.name}[${b}]` : p.name;
    return p.external ? `${bit} (${p.external.part} ${p.external.path}, ${p.external.port})` : bit;
  };
  const place = (p: TopPort, pick: () => Resource | undefined) => {
    let missing = 0;
    for (let b = 0; b < p.width; b++) {
      const res = pick();
      if (res) bits.push({ port: p.name, bit: b, width: p.width, res, label: label(p, b) });
      else missing++;
    }
    if (missing) unplaced.push({ port: p.name, dir: p.dir, bits: missing });
  };
  const rest = ports.filter((p) => !clocks.includes(p.name) && p.name !== reset?.port);
  for (const p of rest.filter((x) => x.dir === 'in')) {
    place(p, () => buttons.shift() ?? (gpio < BOARD.gpio.length ? { kind: 'gpio_in', index: gpioIn++, pin: BOARD.gpio[gpio++] } : undefined));
  }
  let led = 0;
  // the LEDs go to the chip's own outputs first, then LED parts, displays, a halt lamp, and the rest (consoles, screens)
  const rank = (p: TopPort) => (!p.external ? 0 : /^LED/.test(p.external.part) ? 1 : /^Display/.test(p.external.part) ? 2 : /^Halt/.test(p.external.part) ? 3 : 4);
  for (const p of rest.filter((x) => x.dir === 'out').sort((a, b) => rank(a) - rank(b))) {
    place(p, () => (led < BOARD.leds.length ? { kind: 'led', index: led, pin: BOARD.leds[led++] }
      : gpio < BOARD.gpio.length ? { kind: 'gpio_out', index: gpioOut++, pin: BOARD.gpio[gpio++] } : undefined));
  }
  for (const p of rest.filter((x) => x.dir === 'inout')) unplaced.push({ port: p.name, dir: 'inout', bits: p.width });
  return { clocks, reset, bits, unplaced, gpioIn, gpioOut };
}

const bitRef = (m: { port: string; bit: number; width: number }) => `p_${m.port}${m.width > 1 ? `[${m.bit}]` : ''}`;

/** The board top: the board's clock divided down, a power-on reset, the design's pins on buttons, LEDs and headers. */
export function boardTop(top: string, ports: TopPort[], plan: BoardPlan): string {
  const board = `${top}_board`;
  const L: string[] = [];
  L.push(`// Board top for ${top} on a ${BOARD.name} (${BOARD.device}). Generated by MOSFET → RISC-V.`,
    `// An example: the pins are in tangnano9k.cst, which you must check against your own board.`,
    `// DIV_LOG2: the design's clock is the board's ${BOARD.clockMHz} MHz divided by 2^DIV_LOG2 (22: about 6 Hz, slow`,
    `// enough to watch the LEDs; 0: the full ${BOARD.clockMHz} MHz, if your design meets that timing).`,
    `module ${board} #(parameter DIV_LOG2 = 22) (`);
  const io = [`  input clk_27m`, `  input [1:0] btn_n`, `  output [5:0] led_n`];
  if (plan.gpioIn) io.push(`  input [${plan.gpioIn - 1}:0] gpio_in`);
  if (plan.gpioOut) io.push(`  output [${plan.gpioOut - 1}:0] gpio_out`);
  L.push(io.join(',\n'), ');');
  L.push('', '  // the design\'s clock',
    '  wire clk;',
    '  generate',
    '    if (DIV_LOG2 == 0) begin : full_speed',
    '      assign clk = clk_27m;',
    '    end else begin : divided',
    '      reg [DIV_LOG2 - 1:0] div = 0;',
    '      always @(posedge clk_27m) div <= div + 1\'b1;',
    '      assign clk = div[DIV_LOG2 - 1];',
    '    end',
    '  endgenerate',
    '',
    `  // reset: for the first 8 clock cycles after configuration${plan.reset ? ', and while S1 is held' : ''}`,
    '  reg [3:0] por = 0;',
    '  always @(posedge clk) if (!por[3]) por <= por + 1\'b1;',
    `  wire rst = !por[3]${plan.reset ? ' || !btn_n[0]' : ''};`,
    '', '  // the design\'s pins');
  for (const p of ports) L.push(`  wire ${p.width > 1 ? `[${p.width - 1}:0] ` : ''}p_${p.name};`);
  for (const c of plan.clocks) L.push(`  assign p_${c} = clk;`);
  if (plan.reset) L.push(`  assign p_${plan.reset.port} = ${plan.reset.activeLow ? '!rst' : 'rst'};`);
  const used = { led: new Set<number>() };
  for (const m of plan.bits) {
    const r = m.res;
    if (r.kind === 'button') L.push(`  assign ${bitRef(m)} = !btn_n[${r.index}];  // S${r.index + 1} held: 1`);
    else if (r.kind === 'gpio_in') L.push(`  assign ${bitRef(m)} = gpio_in[${r.index}];`);
    else if (r.kind === 'led') { used.led.add(r.index); L.push(`  assign led_n[${r.index}] = !${bitRef(m)};  // LED ${r.index} lit: 1`); }
    else L.push(`  assign gpio_out[${r.index}] = ${bitRef(m)};`);
  }
  for (let i = 0; i < BOARD.leds.length; i++) if (!used.led.has(i)) L.push(`  assign led_n[${i}] = 1'b1;  // LED ${i}: unused, off`);
  const placed = new Set(plan.bits.map((m) => `${m.port}:${m.bit}`));
  for (const p of ports) {
    if (p.dir !== 'in' || plan.clocks.includes(p.name) || p.name === plan.reset?.port) continue;
    for (let b = 0; b < p.width; b++) if (!placed.has(`${p.name}:${b}`)) L.push(`  assign ${bitRef({ port: p.name, bit: b, width: p.width })} = 1'b0;  // no board pin`);
  }
  L.push('', `  ${top} dut (`, ports.map((p) => `    .${p.name}(p_${p.name})`).join(',\n'), '  );', 'endmodule', '');
  return L.join('\n');
}

/** The pin constraints (Gowin .cst, read by Gowin EDA and nextpnr-himbaechi), every bit with the design's name for it. */
export function boardCst(top: string, plan: BoardPlan): string {
  const L: string[] = [
    `// Pin constraints for ${top}_board on a ${BOARD.name} (${BOARD.device}). Generated by MOSFET → RISC-V.`,
    '//',
    '// AN EXAMPLE, NOT A GUARANTEE: the pin numbers follow Sipeed\'s Tang Nano 9K examples. Check every one',
    '// against your board\'s schematic before you program it: a wrong pin can drive an output into another.',
    '// Header pins (gpio_in / gpio_out) are 3.3 V; LEDs and buttons are active low (the board top inverts them).',
    '',
    `IO_LOC "clk_27m" ${BOARD.clock};  // ${BOARD.clockMHz} MHz oscillator`,
    'IO_PORT "clk_27m" PULL_MODE=UP;',
    `IO_LOC "btn_n[0]" ${BOARD.buttons[0]};  // S1: ${plan.reset ? `reset (${plan.reset.port})` : plan.bits.find((m) => m.res.kind === 'button' && m.res.index === 0)?.label ?? 'unused'}`,
    'IO_PORT "btn_n[0]" PULL_MODE=UP;',
    `IO_LOC "btn_n[1]" ${BOARD.buttons[1]};  // S2: ${plan.bits.find((m) => m.res.kind === 'button' && m.res.index === 1)?.label ?? 'unused'}`,
    'IO_PORT "btn_n[1]" PULL_MODE=UP;',
  ];
  for (let i = 0; i < BOARD.leds.length; i++) {
    const m = plan.bits.find((x) => x.res.kind === 'led' && x.res.index === i);
    L.push(`IO_LOC "led_n[${i}]" ${BOARD.leds[i]};  // LED ${i}: ${m?.label ?? 'unused'}`, `IO_PORT "led_n[${i}]" PULL_MODE=UP DRIVE=8;`);
  }
  for (const m of plan.bits) {
    if (m.res.kind !== 'gpio_in' && m.res.kind !== 'gpio_out') continue;
    const n = `${m.res.kind}[${m.res.index}]`;
    L.push(`IO_LOC "${n}" ${m.res.pin};  // ${m.label}`, `IO_PORT "${n}" ${m.res.kind === 'gpio_in' ? 'PULL_MODE=DOWN' : 'DRIVE=8'};`);
  }
  if (plan.clocks.length) L.push('', `// the design's clock (${plan.clocks.join(', ')}) comes from the divider in ${top}_board, not from a pin`);
  for (const u of plan.unplaced) L.push(`// ${u.port}: ${u.bits} bit${u.bits === 1 ? '' : 's'} with no pin in this example (${u.dir === 'in' ? 'held at 0' : u.dir === 'out' ? 'left unconnected' : 'not wired'})`);
  return L.join('\n') + '\n';
}

function readme(top: string, base: string, issues: FpgaIssue[], plan: BoardPlan): string {
  const board = `${top}_board`;
  const lines = [
    `${top}: Verilog for an FPGA, exported from the MOSFET → RISC-V sandbox`,
    '',
    'Files',
    `  ${base}.v         the design: one module per chip, flip-flops as clocked processes, NAND gates as`,
    '                    assignments, memories as arrays; sandbox I/O parts (switches, keys, LEDs, displays,',
    '                    consoles) are ports of the top module named x_<part>_<pin>',
    `  ${base}_board.v   the board top: the 27 MHz clock divided down (parameter DIV_LOG2), a power-on reset,`,
    '                    the design\'s pins on the buttons, the LEDs and header pins',
    '  tangnano9k.cst    pin constraints for a Sipeed Tang Nano 9K: AN EXAMPLE, check every pin against your',
    '                    board\'s schematic before programming it',
    '',
    'With Gowin EDA (the vendor\'s tools)',
    `  New project for ${BOARD.device} (Tang Nano 9K), add ${base}.v, ${base}_board.v and tangnano9k.cst,`,
    `  set ${board} as the top module, then Run All, and program the .fs file with the Programmer.`,
    '',
    'With the open-source flow (Yosys, nextpnr-himbaechi, Apicula, openFPGALoader)',
    `  yosys -p "read_verilog ${base}.v ${base}_board.v; synth_gowin -top ${board} -json ${base}.json"`,
    `  nextpnr-himbaechi --json ${base}.json --write ${base}_pnr.json --device ${BOARD.device} --vopt family=${BOARD.family} --vopt cst=tangnano9k.cst`,
    `  gowin_pack -d ${BOARD.family} -o ${base}.fs ${base}_pnr.json`,
    `  openFPGALoader -b tangnano9k ${base}.fs`,
    '  (nextpnr-gowin, the older tool, takes --device GW1NR-LV9QN88PC6/I5 --family GW1N-9C --cst tangnano9k.cst.)',
    '',
    'Pins',
    `  clock  ${plan.clocks.length ? `${plan.clocks.join(', ')} from the divider` : 'none: the design has no clock pin'}`,
    `  reset  ${plan.reset ? `${plan.reset.port} from S1 and the power-on reset` : 'none (S1 is an input if the design has one)'}`,
    ...plan.bits.map((m) => `  ${m.res.kind === 'led' ? `LED ${m.res.index}` : m.res.kind === 'button' ? `S${m.res.index + 1}` : `pin ${m.res.pin}`}  ${m.label}`),
    ...plan.unplaced.map((u) => `  (no pin) ${u.port}: ${u.bits} bit${u.bits === 1 ? '' : 's'}`),
    '',
    'Flip-flops start at 0 when the FPGA is configured, as the sandbox\'s power-on does.',
  ];
  if (issues.length) lines.push('', 'Report', ...issues.map((i) => `  ${i.level === 'error' ? 'ERROR' : i.level === 'warn' ? 'warning' : 'note'}: ${i.text}`));
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------
// The report

/** Defs the export writes as one body (a flip-flop process, a memory array): whatever is inside them is not exported. */
const isProcess = (d: ComponentDef) => !!ffLeaf(d) || !!d.hdl?.synth;

/**
 * NAND loops left in what the export writes as gates: a strongly connected group of NANDs (Tarjan) with no flip-flop
 * process or memory between them. Named by the smallest instance holding the whole loop and the parts of it involved.
 */
export function latchLoops(def: ComponentDef): LatchLoop[] {
  const d = flatten(def);
  const inside = new Map<HierNode, boolean>();
  const cut = (n: HierNode | null): boolean => {
    if (!n) return false;
    let v = inside.get(n);
    if (v === undefined) inside.set(n, v = isProcess(n.def) || cut(n.parent));
    return v;
  };
  const nands = d.leaves.map((l) => ({ l })).filter(({ l }) => l.kind === 'nand' && !cut(l.node.parent));
  const readers = new Map<number, number[]>();
  nands.forEach(({ l }, k) => {
    for (const inp of l.inputs) for (const n of inp) {
      const r = readers.get(n);
      if (r) r.push(k); else readers.set(n, [k]);
    }
  });
  const next = (k: number) => readers.get(nands[k].l.outputs[0][0]) ?? [];
  // Tarjan, iterative (a CPU has tens of thousands of NANDs)
  const index = new Int32Array(nands.length).fill(-1), low = new Int32Array(nands.length), onStack = new Uint8Array(nands.length);
  const stack: number[] = [], groups: number[][] = [];
  let counter = 0;
  for (let s = 0; s < nands.length; s++) {
    if (index[s] >= 0) continue;
    const work: [number, number][] = [[s, 0]];
    index[s] = low[s] = counter++;
    stack.push(s); onStack[s] = 1;
    while (work.length) {
      const top = work[work.length - 1];
      const [v, i] = top;
      const succ = next(v);
      if (i < succ.length) {
        top[1]++;
        const w = succ[i];
        if (index[w] < 0) {
          index[w] = low[w] = counter++;
          stack.push(w); onStack[w] = 1;
          work.push([w, 0]);
        } else if (onStack[w]) low[v] = Math.min(low[v], index[w]);
        continue;
      }
      work.pop();
      if (work.length) { const u = work[work.length - 1][0]; low[u] = Math.min(low[u], low[v]); }
      if (low[v] === index[v]) {
        const g: number[] = [];
        let w: number;
        do { w = stack.pop()!; onStack[w] = 0; g.push(w); } while (w !== v);
        if (g.length > 1 || next(v).includes(v)) groups.push(g);
      }
    }
  }
  return groups.map((g) => {
    const paths = g.map((k) => nands[k].l.node.path);
    let common = paths[0].slice(0, -1);
    for (const p of paths) {
      let n = 0;
      while (n < common.length && n < p.length - 1 && common[n] === p[n]) n++;
      common = common.slice(0, n);
    }
    let node: HierNode = d.root;
    for (const s of common) node = node.children!.get(s)!;
    const parts = [...new Set(paths.map((p) => p[common.length]))].sort();
    return { where: common.join('.'), part: node.def.name, parts, nands: g.length };
  }).sort((a, b) => a.where.localeCompare(b.where));
}

/** The memories exported from their hdl.synth bodies (each definition once). */
function memories(root: ComponentDef): ComponentDef[] {
  const out: ComponentDef[] = [], seen = new Set<ComponentDef>();
  const walk = (d: ComponentDef) => {
    if (seen.has(d)) return;
    seen.add(d);
    if (d.hdl?.synth) { out.push(d); return; }
    if (d.id === 'nand' || ffLeaf(d) || d.prim) return;
    for (const i of netlistOf(d)?.instances ?? []) if (!isExternal(i.def)) walk(i.def);
  };
  walk(root);
  return out;
}

/** What the export cannot write cleanly, found by walking the definitions (each once). */
function structureIssues(root: ComponentDef): FpgaIssue[] {
  const out: FpgaIssue[] = [];
  const seen = new Set<ComponentDef>();
  const walk = (d: ComponentDef) => {
    if (seen.has(d)) return;
    seen.add(d);
    if (d.id === 'nand' || isProcess(d) || d.prim) return;
    if (d.ff) out.push({ level: 'warn', text: `${d.name} is marked as a flip-flop but has pins besides d, q, clk and en, so it is exported as its gates (its loop is reported below if one is left)` });
    if (d.powerOn && Object.keys(d.powerOn).some((k) => k.includes('.'))) out.push({ level: 'warn', text: `${d.name}: its initial contents (power-on values) are not exported: its flip-flops start at 0` });
    for (const i of netlistOf(d)?.instances ?? []) if (!isExternal(i.def)) walk(i.def);
  };
  walk(root);
  return out;
}

// ---------------------------------------------------------------------------------------------

/** The whole export of one compiled chip: files named after `base`, and the report. */
export function fpgaExport(def: ComponentDef, base: string): FpgaExport {
  const issues: FpgaIssue[] = [];
  let res;
  try {
    res = synthVerilog(def, undefined, { powerOnZero: true, externalPorts: true, ioPart: (d) => displayOf(d) !== null });
  } catch (e) {
    return { ok: false, top: '', board: '', files: [], modules: 0, issues: [{ level: 'error', text: `cannot be synthesized: ${(e as Error).message}` }] };
  }
  issues.push(...structureIssues(def));
  try {
    const loops = latchLoops(def);
    for (const l of loops.slice(0, 8)) {
      issues.push({ level: 'warn', text: `a latch drawn as a NAND loop is left in ${l.where ? `${l.where} (${l.part})` : 'the chip itself'}: ${l.parts.join(', ')} (${l.nands} NANDs). An FPGA tool rejects it or keeps a combinational loop: use a flip-flop part, or tick "this chip is a flip-flop" on the chip that holds it` });
    }
    if (loops.length > 8) issues.push({ level: 'warn', text: `and ${loops.length - 8} more latch loops` });
  } catch (e) {
    issues.push({ level: 'info', text: `latch loops not checked: ${(e as Error).message}` });
  }
  const ext = res.ports.filter((p) => p.external);
  if (ext.length) {
    const parts = [...new Set(ext.map((p) => `${p.external!.path} (${p.external!.part})`))];
    issues.push({ level: 'info', text: `sandbox I/O parts become ports of the top module (x_…): ${parts.slice(0, 10).join(', ')}${parts.length > 10 ? ` and ${parts.length - 10} more` : ''}` });
  }
  const plan = boardPlan(res.ports);
  if (!plan.clocks.length && res.verilog.includes('always @(posedge')) issues.push({ level: 'warn', text: 'no input pin is a clock (kind clock, or named clk): the board top cannot drive the flip-flops\' clock' });
  const unplaced = (dir: 'in' | 'out' | 'inout', what: string) => {
    const u = plan.unplaced.filter((x) => x.dir === dir);
    if (!u.length) return;
    const list = u.slice(0, 6).map((x) => (x.bits > 1 ? `${x.port} (${x.bits} bits)` : x.port)).join(', ');
    issues.push({ level: dir === 'inout' ? 'warn' : 'info', text: `no pin on the example board for ${list}${u.length > 6 ? ` and ${u.length - 6} more` : ''}: ${what}` });
  };
  unplaced('in', 'held at 0 in the board top');
  unplaced('out', 'left unconnected (synthesis removes what only they used)');
  unplaced('inout', 'bidirectional pins are not wired by the board top');
  for (const d of memories(def)) {
    issues.push({ level: 'info', text: `${d.name} is read in the same cycle it is addressed (asynchronous read), which FPGA block RAM cannot do: synthesis builds it from LUT RAM, so a large one may not fit a small FPGA (a Tang Nano 9K has 8,640 LUTs)` });
  }
  const top = res.top, board = `${top}_board`;
  return {
    ok: true, top, board, modules: res.modules, issues, plan,
    files: [
      { name: `${base}.v`, text: res.verilog },
      { name: `${base}_board.v`, text: boardTop(top, res.ports, plan) },
      { name: 'tangnano9k.cst', text: boardCst(top, plan) },
      { name: 'README.txt', text: readme(top, base, issues, plan) },
    ],
  };
}
