// A SAP-1 in the sandbox, DOM-free: Examples ▸ SAP-1 breadboard computer (its modules placed as clock, pc, mar, ram,
// ir, ctl, a, alu, flags, b, out, bus: lib/sap.ts's instance names), or the library's sap1 part placed whole. The golden
// model (sap/iss.ts) is cycle exact, so it runs in lock step with the clock: before every rising edge the hardware's
// registers, step, RAM and bus are compared with the model's (the state the last full period left, the falling edge's
// step included), the model takes its cycle, and after the edge the registers it loaded are compared again.
// The model starts from the hardware at power-on (the RAM's contents are the program). While PROG is on the clock and
// the switches drive the RAM, which the model does not cover: it is followed, and taken up again from the hardware
// at the first edge after PROG goes off. RESET clears the PC, the step, A, B, the IR and the flags at once: held through an
// edge the model's cycle(true) follows it; pressed between two edges, the model takes reset() at the next edge when the
// hardware holds exactly what a reset leaves and the model does not (so PROG, a program, RESET, Run stays checked).

import { SAP_STATE } from '../lib/sap';
import { CTRL, ctrlText, disasm, microcode, SAP_STEPS } from '../sap/isa';
import { SapISS } from '../sap/iss';
import type { HierNode } from '../sim/flatten';
import { pack } from '../sim/values';
import type { Chips, Mismatch, MonitorSim, Retired } from './cpu';
import { partAt, partNode } from './cpu';
import type { ChipDoc, PartDoc } from './model';

/** The modules the computer is drawn from, by the top's instance names. */
export const SAP_MODULES = ['clock', 'pc', 'mar', 'ram', 'ir', 'ctl', 'a', 'alu', 'flags', 'b', 'out', 'bus'] as const;

export interface SapDesc {
  /** '' when the modules are parts of this chip, else the path of the placed computer and a dot ('sap.'). */
  prefix: string;
}

const isSapLib = (p: PartDoc) => 'lib' in p.ref && /^sap1(_[0-9a-f]{32})?$/.test(p.ref.lib);

/** A SAP-1 on the chip: its modules as parts (the example), or a placed sap1 part; null otherwise. */
export function detectSap(doc: ChipDoc, _chips?: Chips): SapDesc | null {
  const ids = new Set(doc.parts.map((p) => p.id));
  if (SAP_MODULES.every((m) => ids.has(m))) return { prefix: '' };
  const whole = doc.parts.find(isSapLib);
  return whole ? { prefix: `${whole.id}.` } : null;
}

/** The architectural state (-1: unknown). */
export interface SapRead { pc: number; mar: number; ir: number; a: number; b: number; out: number; cf: number; zf: number; step: number; ram: number[] }

const REGS: [keyof SapRead, string, number][] = [
  ['pc', 'PC', 1], ['mar', 'MAR', 1], ['ir', 'IR', 2], ['a', 'A', 2], ['b', 'B', 2], ['out', 'OUT', 2], ['cf', 'CF', 1], ['zf', 'ZF', 1], ['step', 'step', 1],
];

/** The modules (part ids of the example) a control word uses: the drivers and loaders it enables, the control logic. */
export function sapUse(cw: number): string[] {
  const on = (l: keyof typeof CTRL) => (cw & CTRL[l]) !== 0;
  const u = new Set<string>(['ctl']);
  if (on('hlt')) u.add('clock');
  if (on('co') || on('ce') || on('j')) u.add('pc');
  if (on('mi')) u.add('mar');
  if (on('ri') || on('ro')) u.add('ram').add('mar');
  if (on('ii') || on('io')) u.add('ir');
  if (on('ai') || on('ao')) u.add('a');
  if (on('eo') || on('fi')) u.add('alu').add('a').add('b');
  if (on('fi')) u.add('flags');
  if (on('bi')) u.add('b');
  if (on('oi')) u.add('out').add('disp');
  if (on('co') || on('ro') || on('io') || on('ao') || on('eo')) u.add('bus');
  return [...u];
}

/** The five control words of an instruction byte (T0–T4) under the flags. */
export const sapSteps = (byte: number, cf: number, zf: number): number[] => Array.from({ length: SAP_STEPS }, (_, s) => microcode(byte >> 4, s, cf, zf));

const hx = (v: number, d: number) => (v < 0 ? '?'.repeat(d) : v.toString(16).toUpperCase().padStart(d, '0'));

/** The golden model in lock step with a SAP-1, compared at every clock edge. */
export class SapMonitor {
  iss: SapISS | null = null;
  desc: SapDesc | null = null;
  mismatch: Mismatch | null = null;
  /** The model started with the hardware (at power-on, or when PROG went off). */
  synced = false;
  /** Instructions completed (the step counter wrapped to T0). */
  retired = 0;
  readonly log: Retired[] = [];
  seq = 0;
  problem: string | null = null;
  /** PROG was on at the last edge: the switches own the RAM, the model waits. */
  programming = false;
  /** Where the instruction in IR was fetched from (-1: not known yet). */
  fetched = -1;
  private progKey = '';
  private lastDoc: ChipDoc | null = null;
  private lastChips: Chips | undefined;
  private resets = -1;
  private stepped = false;
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

  /** The RAM chip's two 189s as placed (the program rides in their refs), for noticing a new program. */
  private ramKey(doc: ChipDoc, chips: Chips | undefined): string {
    const p = this.desc?.prefix ?? '';
    return ['lo', 'hi'].map((n) => JSON.stringify(partAt(doc, `${p}ram.${n}`, chips)?.part.ref ?? null)).join('|');
  }

  /** As Cpu4Monitor.sync: re-detect; restart on a reset or a new program ('program' mid-run: the caller resets). */
  sync(): 'program' | null {
    const doc = this.doc(), chips = this.chips();
    if (doc === this.lastDoc && chips === this.lastChips && this.es.resets === this.resets) return null;
    this.lastDoc = doc;
    this.lastChips = chips;
    this.desc = detectSap(doc, chips);
    const pk = JSON.stringify([this.desc, this.ramKey(doc, chips)]);
    const changed = !!this.progKey && pk !== this.progKey;
    if (changed || this.es.resets !== this.resets || !this.progKey) {
      this.progKey = pk;
      this.resets = this.es.resets;
      this.restart();
      return changed && this.es.cycles > 0 ? 'program' : null;
    }
    return null;
  }

  private restart(): void {
    this.mismatch = null;
    this.retired = 0;
    this.log.length = 0;
    this.seq++;
    this.iss = null;
    this.programming = false;
    this.fetched = -1;
    this.synced = this.es.cycles === 0;
    this.problem = this.desc ? null : 'no SAP-1 on this chip';
  }

  private node(path: string): HierNode | undefined {
    const sim = this.es.sim;
    if (!sim) return undefined;
    if (this.nodes.root !== sim.design.root) this.nodes = { root: sim.design.root, map: new Map() };
    const full = `${this.desc?.prefix ?? ''}${path}`;
    if (!this.nodes.map.has(full)) this.nodes.map.set(full, partNode(sim, full));
    return this.nodes.map.get(full);
  }

  private value(path: string, port: string): number {
    const nets = this.node(path)?.ports[port], sim = this.es.sim;
    return nets && sim ? pack(sim.getBits(nets)) : -1;
  }

  /** The hierarchy has the computer's registers where lib/sap.ts puts them (SAP_STATE, the 189s' words). */
  get hasState(): boolean {
    return Object.values(SAP_STATE).every(([p, q]) => !!this.node(p)?.ports[q]) && !!this.node('ram.lo.mem.w0')?.ports.q && !!this.node('ram.hi.mem.w0')?.ports.q;
  }

  get checking(): boolean {
    return this.ensure() && this.synced && !this.problem && !this.programming && this.hasState;
  }

  /** The model, started from the hardware when there is none yet and the hardware is where it starts (false: none). */
  private ensure(): boolean {
    if (this.iss) return true;
    if (!this.synced || this.programming || this.problem || !this.desc || !this.hasState || this.prog === 1) return false;
    this.iss = this.fromHardware();
    if (!this.iss) this.problem = 'the hardware holds unknown values (X): power on "to 0" and Reset';
    return !!this.iss;
  }

  /** Why the model is not compared (null: it is, or it waits for a Reset). */
  get unchecked(): string | null {
    if (this.problem) return null;
    if (!this.hasState) return 'the registers are not where the SAP-1 example has them (pc.cnt, a.hi, a.lo, ram.lo.mem …)';
    return this.programming ? 'programming mode: PROG is on, the DIP switches write the RAM; the golden model takes over from the hardware when PROG goes off' : null;
  }

  get done(): boolean {
    return !!this.mismatch || !!this.iss?.halted;
  }

  read(): SapRead | null {
    if (!this.es.sim || !this.hasState) return null;
    const S = SAP_STATE, q = (k: keyof typeof SAP_STATE) => this.value(S[k][0], S[k][1]);
    const nib = (lo: number, hi: number) => (lo < 0 || hi < 0 ? -1 : (hi << 4) | lo);
    const f = q('flags');
    const ram = Array.from({ length: 16 }, (_, i) => nib(this.value(`ram.lo.mem.w${i}`, 'q'), this.value(`ram.hi.mem.w${i}`, 'q')));
    return {
      pc: q('pc'), mar: q('mar'), ir: nib(q('irLo'), q('irHi')), a: nib(q('aLo'), q('aHi')), b: nib(q('bLo'), q('bHi')),
      out: q('out'), cf: f < 0 ? -1 : f & 1, zf: f < 0 ? -1 : (f >> 1) & 1, step: q('step'), ram,
    };
  }

  /** The bus and the clash line as the hardware has them (-1: unknown). */
  get bus(): { bus: number; clash: number } {
    return { bus: this.value('bus', 'bus'), clash: this.value('bus', 'clash') };
  }

  /** The control word the hardware's control logic puts out now (-1: unknown). */
  get controlWord(): number {
    let w = 0;
    for (const [l, bit] of Object.entries(CTRL)) {
      const v = this.value('ctl', l);
      if (v < 0) return -1;
      if (v) w |= bit;
    }
    return w;
  }

  /** RESET as the PC sees it. */
  private get rst(): number {
    return this.value('pc', 'rst');
  }

  /** PROG as the MAR sees it. */
  private get prog(): number {
    return this.value('mar', 'prog');
  }

  /** The PC (-1: X, null: none). */
  get pc(): number | null {
    return this.hasState ? this.value(SAP_STATE.pc[0], SAP_STATE.pc[1]) : null;
  }

  /** The RAM row of the instruction under way: the PC at T0, else where IR was fetched from. */
  get current(): number | null {
    const r = this.read();
    if (!r || r.pc < 0) return null;
    if (r.step === 0) return r.pc;
    return this.fetched >= 0 ? this.fetched : (r.pc + 15) & 15;
  }

  /** The model from the hardware's state (null: some of it is unknown). */
  private fromHardware(): SapISS | null {
    const r = this.read();
    if (!r || [r.pc, r.mar, r.ir, r.a, r.b, r.out, r.cf, r.zf, r.step, ...r.ram].some((v) => v < 0)) return null;
    const m = new SapISS(r.ram);
    Object.assign(m, { pc: r.pc, mar: r.mar, ir: r.ir, a: r.a, b: r.b, out: r.out, cf: r.cf, zf: r.zf, step: r.step });
    return m;
  }

  private compare(withStep: boolean, after: string): void {
    const iss = this.iss!, hw = this.read();
    if (!hw || this.mismatch) return;
    const want = REGS.filter(([k]) => withStep || k !== 'step').map(([k, name, d]): [string, string, number, number, number] => [k, name, iss[k as keyof SapISS] as number, hw[k] as number, d]);
    for (let i = 0; i < 16; i++) want.push([`ram${i}`, `RAM [${hx(i, 1)}]`, iss.ram[i], hw.ram[i], 2]);
    if (withStep) {
      const { bus, drivers } = iss.drive(), b = this.bus;
      want.push(['bus', 'bus', bus, b.bus, 2], ['clash', 'bus clash', drivers > 1 ? 1 : 0, b.clash, 1]);
    }
    const bad = want.find(([, , e, g]) => e !== g);
    if (bad) {
      const [what, name, e, g, d] = bad;
      this.mismatch = { what, name, expected: e, got: g, after, cycle: this.es.cycles, detail: `${name}: expected ${hx(e, d)}, got ${hx(g, d)}` };
    }
  }

  private before(): void {
    this.stepped = false;
    if (!this.desc || this.problem || this.mismatch || !this.hasState) return;
    if (this.prog === 1) {
      // The switches own the RAM and the MAR's address: nothing for the model to follow.
      if (!this.programming) this.seq++;
      this.programming = true;
      this.iss = null;
      return;
    }
    if (this.programming) {
      // PROG went off: take the machine as the switches left it
      this.programming = false;
      this.synced = true;
      this.iss = null;
    }
    if (!this.ensure()) return;
    const iss = this.iss;
    if (!iss || !this.synced) return;
    const r = this.read();
    if (r && !r.pc && !r.step && !r.ir && !r.a && !r.b && !r.cf && !r.zf && !iss.atReset) {
      iss.reset();
      this.fetched = -1;
      this.seq++;
    }
    if (iss.halted) return;
    this.compare(true, this.log.at(-1)?.text ?? 'power-on');
    if (this.mismatch) return;
    const cw = iss.control(), step = iss.step, ir = iss.ir, mar = iss.mar;
    const was = iss.save(), held = this.rst === 1;
    iss.cycle(held);
    this.stepped = true;
    if (cw & CTRL.ii) this.fetched = mar;
    const text = held ? 'RESET held' : `${step < 2 ? 'fetch' : disasm(ir)}  T${step}`;
    const eff: string[] = [];
    if (iss.mar !== was.mar) eff.push(`MAR ← ${hx(iss.mar, 1)}`);
    if (iss.ir !== was.ir) eff.push(`IR ← ${hx(iss.ir, 2)}`);
    if (iss.a !== was.a) eff.push(`A ← ${iss.a}`);
    if (iss.b !== was.b) eff.push(`B ← ${iss.b}`);
    if (iss.out !== was.out || cw & CTRL.oi) eff.push(`OUT ← ${iss.out}`);
    if (cw & CTRL.ri) eff.push(`RAM [${hx(mar, 1)}] ← ${hx(iss.ram[mar], 2)}`);
    if (cw & CTRL.fi) eff.push(`CF ${iss.cf} ZF ${iss.zf}`);
    if (iss.pc !== was.pc) eff.push(`PC → ${hx(iss.pc, 1)}`);
    if (iss.step === 0 && !held) this.retired++;
    this.seq++;
    this.log.push({ cycle: this.es.cycles, pc: this.fetched >= 0 ? this.fetched : was.pc, text, effect: `${cw ? ctrlText(cw) : '—'}${eff.length ? `: ${eff.join(', ')}` : ''}` });
    if (this.log.length > SapMonitor.LOG) this.log.shift();
  }

  private after(): void {
    // The registers the rising edge loaded (the step counter moves at the falling edge: checked before the next one).
    if (this.stepped && this.iss) this.compare(false, this.log.at(-1)?.text ?? '');
  }

  runToHalt(budgetMs = 12, cap = 50000): number {
    if (!this.checking) return 0;
    const left = cap - this.es.cycles;
    return left > 0 ? this.es.runCycles(left, () => this.done, budgetMs) : 0;
  }

  /** One instruction: clock to the next T0 (five steps). */
  stepInstr(): number {
    const from = this.es.cycles;
    return this.es.runCycles(SAP_STEPS, () => this.done || (this.es.cycles > from && (this.read()?.step ?? 0) === 0));
  }
}
