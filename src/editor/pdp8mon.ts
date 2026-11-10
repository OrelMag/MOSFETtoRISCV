// A PDP-8 in gates in the sandbox, DOM-free: a placed pdp8_core part (lib/pdp8.ts), its core a 4K × 12 RAM part, the
// panel's switch register and keys on pins wired to it (Examples ▸ PDP-8 in gates). The golden model (pdp8/pdp8.ts)
// runs in lock step: it steps once each time the gates finish an instruction (the core's retire output just before an
// edge) and AC, L, MQ, PC, ION, RUN, the printer flag and every word the instruction wrote must then agree. An interrupt
// the model takes after an instruction is the gates' next cycle (core[0] ← PC, PC ← 0001): compared after that one.
// The model joins the hardware at any Fetch whose values are known (at power-on, or when the drawer opens mid-run). The
// panel's keys act on both: LOAD ADD, DEP, EXAM, START and CONT at the edge a key goes down while the machine is stopped,
// STOP at any edge. The keyboard's waiting keys are the model's too, so a KCC that leaves one waiting interrupts on both.

import { PDP8_STATE } from '../lib/pdp8';
import { PDP8_PRESET } from '../isa/presets';
import { tableOf } from '../isa/table';
import { MASK, oct4, Pdp8 } from '../pdp8/pdp8';
import type { HierNode } from '../sim/flatten';
import { pack } from '../sim/values';
import type { Chips, Mismatch, MonitorSim, Retired } from './cpu';
import { partNode, readMem } from './cpu';
import type { ChipDoc, PartDoc } from './model';
import type { KeyboardState } from './parts';

/** The panel's keys: the processor's ports. */
export const PDP8_KEY_PORTS = ['ld', 'start', 'dep', 'exam', 'cont', 'stop', 'sstep'] as const;
export type Pdp8Key = (typeof PDP8_KEY_PORTS)[number];

export interface Pdp8Desc {
  /** The placed processor (a part of this chip). */
  core: string;
  /** The RAM part wired to its core port (its address input on the processor's maddr), when found. */
  ram?: string;
  /** The keyboard part, when there is one. */
  kbd?: string;
  /** Input pins driving the switch register and each key (absent: driven by something else). */
  sr?: string;
  keys: Partial<Record<Pdp8Key, string>>;
}

const isCore = (p: PartDoc) => 'lib' in p.ref && p.ref.lib === 'pdp8_core';

/** The net a part's port sits on, as the pins and parts sharing it: wires followed, pointers by name. */
function peers(doc: ChipDoc, part: string, port: string): { pins: string[]; parts: [string, string][] } {
  const key = (e: unknown) => JSON.stringify(e);
  const ends = new Map<string, Set<string>>();
  const link = (a: string, b: string) => { (ends.get(a) ?? ends.set(a, new Set()).get(a)!).add(b); (ends.get(b) ?? ends.set(b, new Set()).get(b)!).add(a); };
  const label = new Map((doc.labels ?? []).map((l) => [l.id, l.name]));
  const endKey = (e: Record<string, unknown>): string => ('label' in e ? `name:${label.get(e.label as string)}` : 'wire' in e ? `wire:${e.wire}` : key(e));
  for (const w of doc.wires) { link(`wire:${w.id}`, endKey(w.a as Record<string, unknown>)); link(`wire:${w.id}`, endKey(w.b as Record<string, unknown>)); }
  const seen = new Set<string>(), todo = [key({ part, port })];
  while (todo.length) {
    const k = todo.pop()!;
    if (seen.has(k)) continue;
    seen.add(k);
    for (const n of ends.get(k) ?? []) todo.push(n);
  }
  const pins: string[] = [], parts: [string, string][] = [];
  for (const k of seen) {
    if (!k.startsWith('{')) continue;
    const e = JSON.parse(k) as { pin?: string; part?: string; port?: string };
    if (e.pin) pins.push(e.pin);
    else if (e.part && e.port) parts.push([e.part, e.port]);
  }
  return { pins, parts };
}

/** A pdp8_core part on the chip, with what is wired to it, or null. */
export function detectPdp8(doc: ChipDoc, _chips?: Chips): Pdp8Desc | null {
  const core = doc.parts.find(isCore);
  if (!core) return null;
  const pinOn = (port: string) => peers(doc, core.id, port).pins.find((id) => doc.pins.find((p) => p.id === id)?.dir === 'in');
  const ram = peers(doc, core.id, 'maddr').parts.find(([id, port]) => port === 'addr' && 'ram' in (doc.parts.find((p) => p.id === id)?.ref ?? {}))?.[0];
  const kbd = doc.parts.find((p) => 'keyboard' in p.ref)?.id;
  const keys: Partial<Record<Pdp8Key, string>> = {};
  for (const k of PDP8_KEY_PORTS) { const pin = pinOn(k); if (pin) keys[k] = pin; }
  const sr = pinOn('sr');
  return { core: core.id, ...(ram ? { ram } : {}), ...(kbd ? { kbd } : {}), ...(sr ? { sr } : {}), keys };
}

/** The registers and lamps as the gates hold them (-1: unknown). */
export interface Pdp8Read { pc: number; ma: number; mb: number; ac: number; l: number; mq: number; ir: number; state: number; run: number; ie: number; prn: number }

const STATE_NAMES = ['Fetch', 'Defer', 'Execute'];
export const pdp8StateName = (s: number) => STATE_NAMES[s] ?? '?';

const table = tableOf(PDP8_PRESET);
/** A core word as the PDP-8 table reads it at an address. */
export const pdp8Disasm = (w: number, at: number) => (w < 0 ? '?' : table.disasm(w & MASK, at));

export class Pdp8Monitor {
  desc: Pdp8Desc | null = null;
  iss: Pdp8 | null = null;
  mismatch: Mismatch | null = null;
  /** The model has joined the hardware. */
  get synced(): boolean { return !!this.iss; }
  retired = 0;
  readonly log: Retired[] = [];
  seq = 0;
  problem: string | null = null;
  /** The last instruction run was a HLT (or STOP stopped it). */
  halted = false;
  /** The address of the instruction under way (its Fetch), or of the next one. */
  at = 0;
  private waitInt = false;
  private edge: { retire: boolean; intCycle: boolean; writes: [number, number][]; keys: Set<Pdp8Key>; stopped: boolean } | null = null;
  private writes: [number, number][] = [];
  private prevKeys = new Set<Pdp8Key>();
  private lastDoc: ChipDoc | null = null;
  private lastChips: Chips | undefined;
  private resets = -1;
  private nodes: { root: unknown; map: Map<string, HierNode | undefined> } = { root: null, map: new Map() };
  private hook = { before: () => this.before(), after: () => this.after() };
  private static readonly LOG = 64;

  constructor(readonly es: MonitorSim, private doc: () => ChipDoc, private chips: () => Chips | undefined = () => undefined) {
    es.edgeHooks.add(this.hook);
    this.sync();
  }

  destroy(): void {
    this.es.edgeHooks.delete(this.hook);
  }

  /** Re-detect; start over on a reset (the program is the RAM's initial contents: a change there rebuilds and resets). */
  sync(): 'program' | null {
    const doc = this.doc(), chips = this.chips();
    if (doc === this.lastDoc && chips === this.lastChips && this.es.resets === this.resets) return null;
    this.lastDoc = doc;
    this.lastChips = chips;
    this.desc = detectPdp8(doc, chips);
    if (this.es.resets !== this.resets) {
      this.resets = this.es.resets;
      this.restart();
    }
    return null;
  }

  private restart(): void {
    this.mismatch = null;
    this.retired = 0;
    this.log.length = 0;
    this.seq++;
    this.iss = null;
    this.halted = false;
    this.waitInt = false;
    this.edge = null;
    this.writes = [];
    this.prevKeys.clear();
    this.problem = this.desc ? null : 'no PDP-8 processor on this chip';
  }

  private node(path: string): HierNode | undefined {
    const sim = this.es.sim;
    if (!sim) return undefined;
    if (this.nodes.root !== sim.design.root) this.nodes = { root: sim.design.root, map: new Map() };
    if (!this.nodes.map.has(path)) this.nodes.map.set(path, partNode(sim, path));
    return this.nodes.map.get(path);
  }

  /** A port of a node under the processor ('' = the processor itself). */
  private value(path: string, port: string): number {
    const full = path ? `${this.desc?.core}.${path}` : this.desc?.core ?? '';
    const nets = this.node(full)?.ports[port], sim = this.es.sim;
    return nets && sim ? pack(sim.getBits(nets)) : -1;
  }

  read(): Pdp8Read | null {
    if (!this.desc || !this.es.sim || !this.node(this.desc.core)) return null;
    const q = (k: keyof typeof PDP8_STATE) => this.value(PDP8_STATE[k], 'q');
    return { pc: q('pc'), ma: q('ma'), mb: q('mb'), ac: q('ac'), l: q('l'), mq: q('mq'), ir: q('ir'), state: q('state'), run: q('run'), ie: q('ie'), prn: q('prn') };
  }

  /** The core: the RAM's words (null: not readable). */
  core(): number[] | null {
    const sim = this.es.sim;
    return sim && this.desc?.ram ? readMem(sim, this.desc.ram) : null;
  }

  get pc(): number | null {
    const r = this.read();
    return r ? r.pc : null;
  }

  get checking(): boolean {
    return !!this.iss && !this.problem && !this.mismatch;
  }

  get done(): boolean {
    return !!this.mismatch || this.halted;
  }

  /** Why the model is not compared (null: it is). */
  get unchecked(): string | null {
    if (this.problem) return this.problem;
    if (!this.desc?.ram) return 'no RAM found on the processor\'s maddr: nothing to follow the core with';
    if (!this.iss) return 'the golden model joins at the next Fetch whose values are known (power on "to 0" and Reset)';
    return null;
  }

  /** The keyboard's waiting keys (oldest first), as its part holds them. */
  private queue(): number[] {
    const sim = this.es.sim, k = this.desc?.kbd;
    const li = k && sim ? this.node(k)?.leafIndex : undefined;
    if (li === undefined || !sim) return [];
    const s = sim.leafState(li) as KeyboardState | undefined;
    return s?.q ? [...s.q] : [];
  }

  /** The model from the gates' registers and the RAM (null: something unknown). */
  private fromHardware(): Pdp8 | null {
    const r = this.read(), mem = this.core();
    if (!r || !mem || Object.values(r).some((v) => v < 0) || mem.some((v) => v < 0)) return null;
    const m = new Pdp8(mem);
    Object.assign(m, { pc: r.pc, ma: r.ma, mb: r.mb, ac: r.ac, l: r.l, mq: r.mq, ir: r.ir, run: r.run === 1, ie: r.ie === 1, prn: r.prn === 1,
      ionDelay: this.value('ctl.dlyf', 'q') === 1 });
    return m;
  }

  /** Just before an edge: what the gates do at it. */
  private before(): void {
    if (!this.desc || this.problem || this.mismatch) return;
    const r = this.read();
    if (!r) return;
    if (r.state === 0) this.at = r.pc;
    if (!this.iss && r.state === 0) this.iss = this.fromHardware();
    const m = this.iss;
    if (!m) return;
    const v = (port: string) => this.value('', port);
    // the keyboard as the gates see it, and the keys behind it
    const kready = v('kready'), q = this.queue();
    m.kbd = kready === 1;
    if (m.kbd) m.kbuf = v('kcode');
    else m.kbuf = this.value('tty.kbuf', 'q');
    m.keys = q.slice(1);
    // the panel's keys: the ones that went down since the last edge
    const down = new Set(PDP8_KEY_PORTS.filter((k) => v(k) === 1));
    const keys = new Set([...down].filter((k) => !this.prevKeys.has(k)));
    this.prevKeys = down;
    const stopped = r.run === 0 && r.state === 0;
    m.sr = v('sr') & MASK;
    this.edge = { retire: v('retire') === 1, intCycle: this.value('ctl', 'zeroA') === 1, writes: [], keys, stopped };
    if (v('mwe') === 1) this.edge.writes.push([v('maddr'), v('din')]);
    if (stopped && !keys.has('sstep')) {
      if (keys.has('ld')) m.loadAddress();
      if (keys.has('dep')) m.deposit();
      if (keys.has('exam')) m.examine();
      if (keys.has('start')) m.start();
      if (keys.has('cont')) m.cont();
    }
    if (down.has('stop')) m.stop();
    // An interrupt cycle the model did not see coming: a key typed (or a flag raised) after its last instruction, before
    // this Fetch. The gates look at the flags here; the model looked when that instruction ended. It must be due by the
    // model's own rule now, and the model takes it (DEC's JMS 0).
    if (this.edge.intCycle && !this.waitInt) {
      if (m.ie && !m.ionDelay && (m.prn || m.kbd)) {
        m.mem[0] = m.pc; m.pc = 1; m.ie = false; m.cycles++;
        this.waitInt = true;
      } else this.mismatch = { what: 'int', name: 'interrupt', expected: 0, got: 1, after: this.log.at(-1)?.text ?? '', cycle: this.es.cycles, detail: 'the gates took an interrupt the golden model says is not due (ION off, just turned on, or no flag up)' };
    }
  }

  /** Just after it: the model takes the instruction the gates finished, then they are compared. */
  private after(): void {
    const e = this.edge, m = this.iss;
    this.edge = null;
    if (!e || !m || this.mismatch) return;
    this.writes.push(...e.writes);
    const r = this.read();
    if (r?.state === 0 && r.pc >= 0) this.at = r.pc;
    const panel = e.stopped && ['ld', 'dep', 'exam', 'start', 'cont'].some((k) => e.keys.has(k as Pdp8Key));
    if (e.retire) {
      const s = m.step();
      this.retired++;
      this.seq++;
      const eff: string[] = [];
      if (s.printed !== undefined) eff.push(`prints ${JSON.stringify(s.printed)}`);
      for (const [a, w] of this.writes) eff.push(`[${oct4(a)}] ← ${oct4(w)}`);
      this.log.push({ cycle: this.es.cycles, pc: s.pc, text: pdp8Disasm(s.word, s.pc), effect: `${eff.join(', ')}${eff.length ? ' · ' : ''}${s.cycles} cycle${s.cycles > 1 ? 's' : ''}${s.interrupt ? ', then the interrupt' : ''}` });
      if (this.log.length > Pdp8Monitor.LOG) this.log.shift();
      if (s.halted) this.halted = true;
      if (s.interrupt) { this.waitInt = true; return; }
    } else if (this.waitInt && e.intCycle) this.waitInt = false;
    else if (this.waitInt) {
      this.mismatch = { what: 'int', name: 'interrupt', expected: 1, got: 0, after: this.log.at(-1)?.text ?? '', cycle: this.es.cycles, detail: 'the golden model took an interrupt after this instruction; the gates did not (core[0] ← PC, PC ← 0001)' };
      return;
    }
    else if (!panel) return;
    this.compare(this.log.at(-1)?.text ?? 'the front panel');
    this.writes = [];
  }

  private compare(after: string): void {
    const m = this.iss!, r = this.read();
    if (!r) return;
    const want: [string, string, number, number][] = [
      ['pc', 'PC', m.pc, r.pc], ['ac', 'AC', m.ac, r.ac], ['l', 'L', m.l, r.l], ['mq', 'MQ', m.mq, r.mq],
      ['ie', 'ION', m.ie ? 1 : 0, r.ie], ['run', 'RUN', m.run ? 1 : 0, r.run], ['prn', 'printer flag', m.prn ? 1 : 0, r.prn],
      ...this.writes.map(([a, w]): [string, string, number, number] => ['mem', `core [${oct4(a)}]`, m.mem[a], w]),
    ];
    const bad = want.find(([, , x, y]) => x !== y);
    if (bad) {
      const [what, name, expected, got] = bad;
      this.mismatch = { what, name, expected, got, after, cycle: this.es.cycles, detail: `${name}: expected ${oct4(expected)}, got ${got < 0 ? '????' : oct4(got)}` };
    }
  }

  runToHalt(budgetMs = 12, cap = 200000): number {
    if (!this.checking) return 0;
    const left = cap - this.es.cycles;
    return left > 0 ? this.es.runCycles(left, () => this.done, budgetMs) : 0;
  }

  /** Clock to the end of the instruction under way (1 to 3 memory cycles, an interrupt one more). */
  stepInstr(): number {
    const from = this.retired;
    return this.es.runCycles(5, () => this.done || (this.retired > from && !this.waitInt));
  }
}
