// The SAP panel's lock step, DOM-free (tests drive it as the stage would): the golden model (sap/iss.ts SapISS) beside
// the gate-level computer, compared at every rising clock edge. The stage's edge hooks give two moments: `before` a
// rising edge (the falling edge before it has advanced the step counter: everything, the step included, must equal the
// model), and `after` it (the registers and RAM have loaded; the step has not moved yet: the model's cycle() runs here
// and everything but the step is compared). Programming mode (PROG = 1: the switches write the RAM, the model cannot
// know what) pauses the comparison; the model is set from the hardware when PROG goes back to 0. RESET (the RESET input)
// is asynchronous: held through an edge the model's cycle(true) follows it; pressed and let go between two edges it
// leaves nothing but its effect, so the model takes reset() when the hardware shows exactly what a reset leaves (PC,
// step, IR, A, B and the flags all 0) and the model does not.

import { SAP_STATE } from '../lib/sap';
import { CTRL, ctrlText, microcode, SAP_CTRL, SAP_STEPS } from '../sap/isa';
import { SapISS, type SapState } from '../sap/iss';
import { findNode, type HierNode } from '../sim/flatten';
import type { Sim } from '../sim/sim';
import { pack } from '../sim/values';

/** The computer's architectural state as the hardware holds it (read at the chips' own outputs). */
export interface SapHw {
  pc: number; mar: number; ir: number; a: number; b: number; out: number; cf: number; zf: number; step: number;
  /** The control word on the 16 lines (bit 15 HLT … bit 0 FI), the bus, two drivers at once. */
  cw: number; bus: number; clash: number;
}

/** Nets of a port by path, found once per flattened design (the hooks read them at every edge). */
const netCache = new WeakMap<HierNode, Map<string, readonly number[] | null>>();
const read = (sim: Sim, root: HierNode, path: string, port: string): number => {
  let m = netCache.get(root);
  if (!m) netCache.set(root, (m = new Map()));
  const key = `${path}:${port}`;
  let nets = m.get(key);
  if (nets === undefined) m.set(key, (nets = findNode(root, path.split('.'))?.ports[port] ?? null));
  return nets ? pack(sim.getBits(nets)) : -1;
};

export function sapHw(sim: Sim): SapHw {
  const root = sim.design.root;
  const r = (k: keyof typeof SAP_STATE) => read(sim, root, SAP_STATE[k][0], SAP_STATE[k][1]);
  const nib = (lo: keyof typeof SAP_STATE, hi: keyof typeof SAP_STATE) => {
    const l = r(lo), h = r(hi);
    return l < 0 || h < 0 ? -1 : (h << 4) | l;
  };
  const f = r('flags');
  let cw = 0;
  SAP_CTRL.forEach((n, i) => {
    const v = read(sim, root, 'ctl', n);
    if (cw >= 0) cw = v < 0 ? -1 : cw | (v << (15 - i));
  });
  return {
    pc: r('pc'), mar: r('mar'), ir: nib('irLo', 'irHi'), a: nib('aLo', 'aHi'), b: nib('bLo', 'bHi'), out: r('out'),
    cf: f < 0 ? -1 : f & 1, zf: f < 0 ? -1 : (f >> 1) & 1, step: r('step'), cw,
    bus: pack(sim.getBits(root.ports.bus)), clash: pack(sim.getBits(root.ports.clash)),
  };
}

/** The 16 bytes of RAM, from the 189s' latches (-1: a byte with an unknown bit). */
export function sapRam(sim: Sim): number[] {
  const root = sim.design.root;
  return Array.from({ length: 16 }, (_, i) => {
    let v = 0;
    for (let j = 0; j < 8; j++) {
      const b = read(sim, root, `ram.${j < 4 ? 'lo' : 'hi'}.mem.w${i}.l${j % 4}`, 'q');
      if (b < 0) return -1;
      v |= b << j;
    }
    return v;
  });
}

/** The hardware holds what RESET leaves: PC, step, IR, A, B and the flags all 0. */
export const atReset = (hw: SapHw): boolean => !hw.pc && !hw.step && !hw.ir && !hw.a && !hw.b && !hw.cf && !hw.zf;

const NAMES: [keyof SapHw & keyof SapState, string][] = [['pc', 'PC'], ['mar', 'MAR'], ['ir', 'IR'], ['a', 'A'], ['b', 'B'], ['out', 'OUT'], ['cf', 'CF'], ['zf', 'ZF']];
const hx = (v: number) => (v < 0 ? 'X' : `0x${v.toString(16).toUpperCase().padStart(2, '0')}`);

export interface FollowerState { iss: SapState; mismatch: string | null; outs: number[]; stale: boolean; cur: number }

export class SapFollower {
  iss: SapISS;
  /** The first difference, loud; null while in step. */
  mismatch: string | null = null;
  /** Every value OUT took, in order (one per OUT instruction). */
  outs: number[] = [];
  /** PROG was on since the last edge: the model takes the hardware's state before the next. */
  stale = false;
  /** The address the instruction in the IR was fetched from (-1: none yet). */
  cur = -1;

  constructor(private readonly bytes: readonly number[]) {
    this.iss = new SapISS(bytes);
  }

  reset(): void {
    this.iss = new SapISS(this.bytes);
    this.mismatch = null;
    this.outs = [];
    this.stale = false;
    this.cur = -1;
  }

  /** Any time the panel looks (not during an edge): programming mode makes the model stale. */
  look(sim: Sim): void {
    if (sim.getInput('prog') === 1) this.stale = true;
  }

  /** Before a rising edge: the whole state must match, the step included. */
  before(sim: Sim): void {
    this.look(sim);
    if (this.stale) {
      if (sim.getInput('prog') === 1) return;
      this.adopt(sim);
    }
    if (this.mismatch) return;
    const hw = sapHw(sim);
    if (atReset(hw) && !this.iss.atReset) {
      this.iss.reset();
      this.cur = -1;
    }
    this.compare(hw, true);
    if (!this.mismatch && hw.cw !== this.iss.control()) this.mismatch = `control word: hardware ${hw.cw < 0 ? 'X' : hw.cw.toString(16)}, model ${this.iss.control().toString(16)} (step T${this.iss.step}, opcode ${this.iss.ir >> 4})`;
  }

  /** After a rising edge (before the fall): the model takes its cycle; registers and RAM must match. */
  after(sim: Sim): void {
    if (this.stale || sim.getInput('prog') === 1) return;
    const cw = this.iss.control(), oi = cw & CTRL.oi;
    if (cw & CTRL.ii) this.cur = this.iss.mar;
    const ran = this.iss.cycle(sim.getInput('RESET') === 1);
    if (ran && oi) this.outs.push(this.iss.out);
    if (this.mismatch) return;
    this.compare(sapHw(sim), false);
    if (!this.mismatch) {
      const ram = sapRam(sim);
      const i = ram.findIndex((v, k) => v !== this.iss.ram[k]);
      if (i >= 0) this.mismatch = `cycle ${this.iss.cycles}: RAM[${i}] is ${hx(ram[i])} in the hardware, ${hx(this.iss.ram[i])} in the model`;
    }
  }

  private compare(hw: SapHw, withStep: boolean): void {
    for (const [k, n] of NAMES) {
      if (hw[k] !== this.iss[k]) {
        this.mismatch = `cycle ${this.iss.cycles}: ${n} is ${hx(hw[k])} in the hardware, ${hx(this.iss[k])} in the model`;
        return;
      }
    }
    if (withStep && hw.step !== this.iss.step) this.mismatch = `cycle ${this.iss.cycles}: the step counter is T${hw.step} in the hardware, T${this.iss.step} in the model`;
  }

  /** Take the hardware's state (after programming by hand). */
  adopt(sim: Sim): void {
    const hw = sapHw(sim), ram = sapRam(sim);
    const m = this.iss;
    Object.assign(m, { pc: hw.pc, mar: hw.mar, ir: hw.ir, a: hw.a, b: hw.b, out: hw.out, cf: hw.cf, zf: hw.zf, step: hw.step });
    m.ram = Uint8Array.from(ram.map((v) => v & 0xff));
    this.mismatch = null;
    this.stale = false;
  }

  save(): FollowerState {
    return { iss: this.iss.save(), mismatch: this.mismatch, outs: this.outs.slice(), stale: this.stale, cur: this.cur };
  }

  restore(s: FollowerState): void {
    this.iss.restore(s.iss);
    this.mismatch = s.mismatch;
    this.outs = s.outs.slice();
    this.stale = s.stale;
    this.cur = s.cur;
  }
}

/** What a control word moves, in words: "PC → MAR", "RAM → IR, PC + 1", "A + B → A, flags". */
export function sapGloss(cw: number): string {
  const src: string[] = [];
  if (cw & CTRL.co) src.push('PC');
  if (cw & CTRL.ro) src.push('RAM');
  if (cw & CTRL.io) src.push('operand');
  if (cw & CTRL.ao) src.push('A');
  if (cw & CTRL.eo) src.push(cw & CTRL.su ? 'A − B' : 'A + B');
  const dst: string[] = [];
  if (cw & CTRL.mi) dst.push('MAR');
  if (cw & CTRL.ri) dst.push('RAM');
  if (cw & CTRL.ii) dst.push('IR');
  if (cw & CTRL.ai) dst.push('A');
  if (cw & CTRL.bi) dst.push('B');
  if (cw & CTRL.oi) dst.push('OUT');
  if (cw & CTRL.j) dst.push('PC');
  const extra: string[] = [];
  if (cw & CTRL.ce) extra.push('PC + 1');
  if (cw & CTRL.fi) extra.push('flags');
  if (cw & CTRL.hlt) extra.push('stop the clock');
  const move = src.length || dst.length ? `${src.join(' + ') || 'nothing'} → ${dst.join(', ') || 'nobody'}` : '';
  return [move, ...extra].filter(Boolean).join(', ') || 'nothing';
}

/** An opcode's five steps as an HTML table (the chapter's microcode tables): step, lines, what moves. */
export function microTable(op: number, cf = 0, zf = 0, caption = ''): string {
  const rows = Array.from({ length: SAP_STEPS }, (_, t) => {
    const w = microcode(op, t, cf, zf);
    return `<tr><td>T${t}</td><td><code>${ctrlText(w) || '–'}</code></td><td>${w ? sapGloss(w) : 'nothing (the step passes)'}</td></tr>`;
  }).join('');
  return `<table class="sap-mc">${caption ? `<caption>${caption}</caption>` : ''}<thead><tr><th>step</th><th>lines on</th><th>what moves</th></tr></thead><tbody>${rows}</tbody></table>`;
}
