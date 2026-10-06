// Core data model. One description of a component drives everything: simulation, the
// schematic, statistics and the generated Verilog. Keep it plain data so it can later be
// serialized (sandbox save/share).

/** A single bit on a wire: 0, 1, X (unknown / contention) or Z (floating, switch level only). */
export const B0 = 0;
export const B1 = 1;
export const BX = 2;
export const BZ = 3;
export type Bit = 0 | 1 | 2 | 3;

export type Dir = 'in' | 'out' | 'inout';
export type Side = 'left' | 'right' | 'top' | 'bottom';

export interface PortDef {
  name: string;
  width: number;
  dir: Dir;
  /** Where the pin sits on a box symbol (default: inputs left, outputs right). */
  side?: Side;
  /** Shown as a clock input (triangle) on box symbols. */
  clock?: boolean;
  /** Human description for tooltips / the inspector. */
  doc?: string;
  /**
   * Switch level: an output that can let go of its net (Z, or only a weak pull): a tri-state
   * driver, an open-drain stage, a pull-up. Several such outputs may share one net (a bus); the
   * sandbox warns only when outputs that always drive share one. Purely descriptive: the
   * switch-level solver needs no flag to resolve a shared net.
   */
  tri?: boolean;
}

/** Visual kinds. Gate shapes follow ANSI/IEEE 91 distinctive shapes. */
export type SymbolKind =
  | 'nand' | 'and' | 'or' | 'nor' | 'xor' | 'xnor' | 'not' | 'buf'
  | 'mux' | 'box' | 'split' | 'merge'
  | 'nmos' | 'pmos' | 'vdd' | 'gnd'
  /** Switch-level parts: resistor, pull-up / pull-down, capacitor, transmission gate, tri-states. */
  | 'res' | 'pullup' | 'pulldown' | 'cap' | 'tgate' | 'tribuf' | 'triinv';

export interface SymbolSpec {
  kind: SymbolKind;
  /** Box size in grid units (only for kind 'box'; others have fixed geometry). */
  w?: number;
  h?: number;
  /** Text inside a box symbol (defaults to the component name). */
  label?: string;
  /** Pin spacing in grid units for boxes, splitters and mergers (default 2). */
  pitch?: number;
  /** Explicit y (left/right ports) or x (top/bottom ports) offsets for box ports. */
  portPos?: Record<string, number>;
  /** Do not print port names inside the box (e.g. tall pipeline registers). */
  noPortLabels?: boolean;
  /** Draw the label vertically (narrow boxes). */
  verticalLabel?: boolean;
  /** Hue (0–359) tinting a user chip's box; lightness comes from the theme. */
  color?: number;
}

export interface InstanceDef {
  name: string;
  def: ComponentDef;
  /** Top-left of the symbol, in grid units. Omitted → auto-layout. */
  at?: [number, number];
  /** Mirror horizontally (inputs on the right). Useful in feedback layouts. */
  flip?: boolean;
  /** Short caption drawn near the symbol (defaults to the instance name). */
  label?: string;
}

/**
 * A net connects endpoints. An endpoint is `port` (a pin of the component being defined),
 * or `inst.port`. The first endpoint is treated as the driver for routing purposes.
 */
export interface NetDef {
  name?: string;
  ends: string[];
  /** x (grid units) of the vertical trunk used by the default router. */
  trunk?: number;
  /** Explicit corner points per sink endpoint, overriding the default route. */
  via?: { [end: string]: [number, number][] | undefined };
  /** Draw the bus value label for this net (default: true for buses, false for bits). */
  showValue?: boolean;
  /**
   * Endpoints drawn as named net labels (tags) instead of wires, like a schematic's global
   * net names. `true` tags every endpoint. The driver is tagged when all its sinks are.
   */
  tags?: string[] | true;
  /**
   * Hand-placed tags: the tag of that endpoint is drawn at this point, joined to the endpoint
   * by an orthogonal stub (leaving the pin in its exit direction, then turning once). Used by
   * the sandbox, so a packaged chip shows its pointers where the user put them.
   */
  tagAt?: { [end: string]: [number, number] | undefined };
  /**
   * Switch level: the net has significant capacitance (a bit line, a DRAM storage node). When
   * nothing drives it, it keeps its last value as stored charge instead of floating to Z.
   */
  cap?: boolean;
}

export interface Netlist {
  instances: InstanceDef[];
  nets: NetDef[];
  /** Positions of this component's own pins in the internal view (grid units). */
  pins?: Record<string, [number, number]>;
  /** Direction a wire leaves each pin (default: inputs → right, outputs → left). */
  pinDirs?: Record<string, 'left' | 'right' | 'up' | 'down'>;
  /** Canvas size in grid units (default: computed bounds). */
  size?: [number, number];
  /** 'switch' netlists contain transistors and are solved by the switch-level solver. */
  level?: 'gate' | 'switch';
}

/**
 * Behavioural model of a leaf. Input values are packed per input port (LSB = bit 0);
 * a port containing an X bit is passed as -1. Returns packed outputs per output port
 * (-1 = all X). `state` is private to the instance.
 */
export interface Behavior {
  delay?: number;
  init?: () => unknown;
  eval: (inputs: number[], state: unknown) => number[];
}

export interface ComponentDef {
  id: string;
  name: string;
  /** One-line summary shown in the inspector and library. */
  summary?: string;
  category: Category;
  ports: PortDef[];
  symbol: SymbolSpec;

  /** Built-in primitive handled directly by the simulators. */
  prim?: 'nand' | 'nmos' | 'pmos' | 'vdd' | 'gnd' | 'res' | 'cap' | 'alias';
  /**
   * Switch level: drive strength of a conducting element, 1 … 4. Transistors are 2 (weak) … 4
   * (strong), default 3; a resistor (prim 'res') is 1 by default, weaker than any transistor. Where
   * paths of different strength fight, the stronger one decides the node (ratioed logic, SRAM
   * writes, pull-ups).
   */
  strength?: number;
  /**
   * For prim 'alias' (splitters / mergers): pairs of [portA, bitA, portB, bitB] that are the
   * same electrical node. Costs nothing and has no delay.
   */
  alias?: [string, number, string, number][];

  /** Internal structure (lazy so generators and recursive libraries stay cheap). */
  netlist?: () => Netlist;
  /** Fast model used when the flattener cuts above this component. */
  behavior?: Behavior;
  /** Simulate by behaviour by default (the structure is still shown when the box is opened). */
  preferBehavior?: boolean;
  /** Reference function for tests and truth tables: packed inputs → packed outputs. */
  spec?: (inputs: number[]) => number[];
  /** Power-on hints for 'zero' mode: internal net name → value. */
  powerOn?: Record<string, 0 | 1>;
  /**
   * Marks an edge-triggered flip-flop (port names, all 1 bit): q takes d at the rising edge of
   * clk (when en = 1, if there is an en). Static timing (timing.ts) makes it a register boundary
   * and synthesis export (vexport.ts) writes it as a process instead of its gates. Set on the
   * library DFF / DFFE, and by the sandbox when the user ticks "this chip is a flip-flop" (after
   * checking that it behaves like one).
   */
  ff?: { d: string; q: string; clk: string; en?: string };

  hdl?: { verilog?: string; vhdl?: string };
  /** Long-form notes for the inspector (HTML allowed). */
  notes?: string;
}

export type Category =
  | 'transistor' | 'cell' | 'gate' | 'plumbing' | 'arithmetic'
  | 'routing' | 'sequential' | 'memory' | 'cpu'
  /** User chips made in the sandbox. */
  | 'custom';

export function inPorts(d: ComponentDef): PortDef[] {
  return d.ports.filter((p) => p.dir === 'in');
}
export function outPorts(d: ComponentDef): PortDef[] {
  return d.ports.filter((p) => p.dir === 'out');
}
export function port(d: ComponentDef, name: string): PortDef {
  const p = d.ports.find((q) => q.name === name);
  if (!p) throw new Error(`${d.id}: no port '${name}'`);
  return p;
}

// Netlists are lazy; memoize them per definition so identity is stable.
const netlistCache = new WeakMap<ComponentDef, Netlist>();
export function netlistOf(d: ComponentDef): Netlist | undefined {
  if (!d.netlist) return undefined;
  let n = netlistCache.get(d);
  if (!n) {
    n = d.netlist();
    netlistCache.set(d, n);
  }
  return n;
}

/** Parse an endpoint reference: 'a' → own port a; 'g1.y' → instance g1, port y. */
export function parseEnd(end: string): { inst: string | null; port: string } {
  const i = end.indexOf('.');
  return i < 0 ? { inst: null, port: end } : { inst: end.slice(0, i), port: end.slice(i + 1) };
}

export type HierLeafKind = 'nand' | 'nmos' | 'pmos' | 'vdd' | 'gnd' | 'res' | 'cap' | 'behavior';

/**
 * Primitives of the switch-level solver: transistors, rails, resistors (always-on weak paths) and
 * capacitors (mark their net as charge-keeping). A gate-level flatten cannot simulate them.
 */
export function isSwitchPrim(d: ComponentDef): boolean {
  const p = d.prim;
  return p === 'nmos' || p === 'pmos' || p === 'vdd' || p === 'gnd' || p === 'res' || p === 'cap';
}
