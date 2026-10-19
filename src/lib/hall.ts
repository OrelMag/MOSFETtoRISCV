// The machine hall (Phase 14c, chapter 27): a CPU priced in relays or vacuum tubes and laid out on a floor at
// physical scale. Its top-level blocks are priced one by one (lib/tech.ts price), each fills whole racks or ENIAC
// panels of its own, and the racks stand in rows with aisles between them. DOM-free: the 3D view
// (widgets/hallview.ts), its 2D fallback, the chapter's prose and tests/hall.test.ts all read the same layout.
//
// The program ROM is left out: in relays a program came off punched film or cards (the Z3 read 8-bit film), not
// from a multiplexer tree of relays. The simulation keeps it (a lookup leaf, as everywhere on the site).

import { ENIAC_PANEL } from '../phys/triode';
import { RELAY_RACK } from '../phys/relay';
import { flatten, type FlatDesign } from '../sim/flatten';
import { stats } from '../sim/stats';
import { analyzeTiming } from '../sim/timing';
import { type ComponentDef, netlistOf } from '../sim/types';
import { assemble } from '../riscv/asm';
import { PROGRAMS } from '../riscv/programs';
import { assemble4 } from '../isa4/asm4';
import { COUNTER4 } from '../isa4/programs4';
import { cpu4 } from './cpu4';
import { singleCycleCpu } from './cpu';
import { TECH, cabinets, price, type Priced, withoutParts } from './tech';

export type HallTech = 'relay' | 'tube';
export type HallDesign = 'cpu4' | 'rv32i';

/** A cabinet type: its outside size (m) and how many devices it holds. */
export interface CabinetSpec { w: number; d: number; h: number; per: number; word: string; one: string; devices: string }

export const CABINET: Record<HallTech, CabinetSpec> = {
  relay: { w: RELAY_RACK.w, d: RELAY_RACK.d, h: RELAY_RACK.h, per: RELAY_RACK.relays, word: 'racks', one: 'rack', devices: 'relays' },
  tube: { w: ENIAC_PANEL.w, d: ENIAC_PANEL.d, h: ENIAC_PANEL.h, per: ENIAC_PANEL.tubes, word: 'panels', one: 'panel', devices: 'tubes' },
};

/** Floor plan constants (m): the aisle in front of each row, the gap between neighbouring cabinets. */
export const AISLE = 1.3;
export const GAP: Record<HallTech, number> = { relay: 0.04, tube: 0 };
/** Distinct block colours (hall.css --hl-1 … --hl-HUES). */
export const HUES = 10;

/** Instance names a CPU's program ROM goes by. */
const PROGRAM_NAMES = ['imem', 'rom'];

export interface HallBlock {
  /** Instance name in the CPU, its label (or the part's name) and its definition. */
  name: string;
  label: string;
  def: ComponentDef;
  nands: number;
  /** The block priced alone. */
  priced: Priced;
  /** Devices it gets in the hall: priced alone, plus its share of the devices between blocks (Hall.between). */
  devices: number;
  /** Cabinets it fills: ceil(devices / per cabinet). */
  cabinets: number;
  /** 1 … HUES. */
  hue: number;
}

export interface HallCabinet {
  block: number;
  /** Its number within the block (0 …) and the devices on it. */
  index: number;
  devices: number;
  /** First device of the block on it. */
  first: number;
  row: number;
  col: number;
  /** Floor position of its left-back corner (m); x to the right, z towards the front aisle. */
  x: number;
  z: number;
}

export interface Hall {
  tech: HallTech;
  spec: CabinetSpec;
  /** The CPU as priced: without its program ROM (see withoutProgram). */
  def: ComponentDef;
  /** The program ROM's instance name, or null when the CPU has none. */
  program: string | null;
  blocks: HallBlock[];
  cabinets: HallCabinet[];
  /** The whole CPU (without its program) priced at once: the totals. */
  total: Priced;
  /** total.devices − Σ blocks priced alone: fan-out of the nets running between blocks (relays: extra coils; tubes: followers
   *  and the rounding to whole envelopes), which pricing a block alone cannot see. */
  between: number;
  perRow: number;
  rows: number;
  /** Floor extents (m): x from 0 to width, z from −depth to 0 (the front aisle beyond). */
  width: number;
  depth: number;
  /** Floor area the rows and their aisles take (m²). */
  floor: number;
  /** Where a person stands for scale, and the table with the same CPU in CMOS (m, floor plane). */
  person: [number, number];
  speck: [number, number];
}

// ---------------------------------------------------------------- the CPU without its program

/** The CPU's program ROM (instance imem / rom), and the CPU priced without it (tech.ts withoutParts, which chapter 3's
 *  table and the Statistics tab use too, so every page quotes the same totals). */
export function withoutProgram(cpu: ComponentDef): { def: ComponentDef; program: string | null } {
  const rom = netlistOf(cpu)?.instances.find((i) => PROGRAM_NAMES.includes(i.name));
  return rom ? { def: withoutParts(cpu, [rom.name]), program: rom.name } : { def: cpu, program: null };
}

// ---------------------------------------------------------------- layout

const layouts = new WeakMap<ComponentDef, Partial<Record<HallTech, Hall>>>();

/** The hall of `cpu` in relays or tubes (memoized per definition). */
export function hallLayout(cpu: ComponentDef, tech: HallTech): Hall {
  const memo = layouts.get(cpu) ?? {};
  layouts.set(cpu, memo);
  const hit = memo[tech];
  if (hit) return hit;

  const spec = CABINET[tech];
  const { def, program } = withoutProgram(cpu);
  const total = price(def, tech, null);
  if (!total) throw new Error(`${cpu.id}: cannot be built in ${tech}s`);
  const blocks: HallBlock[] = [];
  for (const inst of netlistOf(def)!.instances) {
    if (inst.name === program) continue;
    const priced = price(inst.def, tech, null);
    if (!priced || priced.devices === 0) continue; // wiring, ties: nothing to build
    blocks.push({
      name: inst.name, label: inst.label ?? inst.def.name, def: inst.def, nands: stats(inst.def).nands, priced,
      devices: priced.devices, cabinets: 0, hue: 0,
    });
  }
  // Largest first; hues in that order, so the big blocks get distinct colours.
  blocks.sort((a, b) => b.priced.devices - a.priced.devices || a.name.localeCompare(b.name));
  blocks.forEach((b, i) => (b.hue = (i % HUES) + 1));
  // The devices only the whole sees (fan-out across block boundaries) are shared out in proportion to size, so the
  // hall holds exactly total.devices.
  const between = total.devices - blocks.reduce((s, b) => s + b.priced.devices, 0);
  share(blocks, between);
  for (const b of blocks) b.cabinets = Math.ceil(b.devices / spec.per);

  // Rows of cabinets, each block's cabinets side by side (a row may hold the end of one block and the start of the
  // next). Rows run along x; their fronts face +z and an aisle; row 0 stands at the front.
  const n = blocks.reduce((s, b) => s + b.cabinets, 0);
  const perRow = Math.max(4, Math.min(18, Math.ceil(Math.sqrt(n * 2.2))));
  const rows = Math.ceil(n / perRow);
  const pitchX = spec.w + GAP[tech], pitchZ = spec.d + AISLE;
  const list: HallCabinet[] = [];
  blocks.forEach((b, bi) => {
    for (let k = 0; k < b.cabinets; k++) {
      const i = list.length, row = Math.floor(i / perRow), col = i % perRow;
      list.push({
        block: bi, index: k, first: k * spec.per, devices: Math.min(spec.per, b.devices - k * spec.per),
        row, col, x: col * pitchX, z: -row * pitchZ - spec.d,
      });
    }
  });
  const width = Math.min(n, perRow) * pitchX - GAP[tech];
  const depth = (rows - 1) * pitchZ + spec.d;
  const hall: Hall = {
    tech, spec, def, program, blocks, cabinets: list, total,
    between,
    perRow, rows, width, depth, floor: width * rows * pitchZ,
    person: [-0.9, 0.9], speck: [-0.15, 1.0],
  };
  memo[tech] = hall;
  return hall;
}

/** Add n (any sign) to the blocks' devices in proportion to their own counts, by largest remainder. */
function share(blocks: HallBlock[], n: number): void {
  const sum = blocks.reduce((s, b) => s + b.priced.devices, 0);
  if (!n || !sum) return;
  const exact = blocks.map((b) => (n * b.priced.devices) / sum);
  const whole = exact.map((x) => Math.trunc(x));
  let left = n - whole.reduce((s, x) => s + x, 0);
  const order = exact.map((_, i) => i).sort((a, b) => Math.abs(exact[b] - whole[b]) - Math.abs(exact[a] - whole[a]));
  for (const i of order) { if (!left) break; whole[i] += Math.sign(left); left -= Math.sign(left); }
  blocks.forEach((b, i) => (b.devices = Math.max(1, b.priced.devices + whole[i])));
}

// ---------------------------------------------------------------- the two CPUs of the chapter

export interface HallCpu {
  id: HallDesign;
  name: string;
  /** What it runs in the hall. */
  programName: string;
  def: ComponentDef;
}

const cpus = new Map<HallDesign, HallCpu>();

/** The chapter's two CPUs with the programs the hall runs: the 4-bit CPU counting on its LEDs (it never halts) and
 *  the single-cycle RV32I writing Fibonacci numbers to its data memory. */
export function hallCpu(id: HallDesign): HallCpu {
  let c = cpus.get(id);
  if (!c) {
    if (id === 'cpu4') c = { id, name: '4-bit CPU', programName: 'count on the LEDs', def: cpu4(assemble4(COUNTER4).words) };
    else {
      const p = PROGRAMS.find((q) => q.id === 'fib')!;
      c = { id, name: 'RV32I single-cycle', programName: p.name, def: singleCycleCpu(assemble(p.source).words) };
    }
    cpus.set(id, c);
  }
  return c;
}

export interface HallFacts {
  nands: number;
  /** Clock period in NAND delays (static timing; the program lookup's delay included). */
  steps: number;
  relay: Hall;
  tube: Hall;
  cmos: Priced;
}

const facts = new Map<HallDesign, HallFacts>();

/** What the chapter says about a CPU: counts, both halls, and its clock period in steps (flattens it once). */
export function hallFacts(id: HallDesign): HallFacts {
  let f = facts.get(id);
  if (!f) {
    const cpu = hallCpu(id).def;
    const steps = analyzeTiming(flatten(cpu))?.period;
    if (!steps) throw new Error(`${cpu.id}: no clock period`);
    const relay = hallLayout(cpu, 'relay'), tube = hallLayout(cpu, 'tube');
    f = { nands: stats(relay.def).nands, steps, relay, tube, cmos: price(relay.def, 'cmos', steps)! };
    facts.set(id, f);
  }
  return f;
}

/** Seconds per clock (and per instruction: both CPUs are single-cycle) in a technology. */
export const periodIn = (steps: number, tech: 'cmos' | HallTech): number => steps * TECH[tech].step;

/** Cabinets of the hall (Σ per block) and the fewest the devices would fill if blocks shared them. */
export function cabinetCounts(h: Hall): { used: number; packed: number } {
  return { used: h.cabinets.length, packed: cabinets(h.total) };
}

/** The output net of every NAND of a flattened CPU, grouped by the top-level instance it sits in (flattening order):
 *  what each relay or tube of that block's racks shows in the hall. */
export function nandOutputsByBlock(d: FlatDesign): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  for (const leaf of d.leaves) {
    if (leaf.def.prim !== 'nand') continue;
    let n = leaf.node;
    while (n.parent && n.parent.parent) n = n.parent;
    let g = groups.get(n.name);
    if (!g) groups.set(n.name, (g = []));
    g.push(leaf.outputs[0][0]);
  }
  return groups;
}
