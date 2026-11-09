// DOM-free models behind the "steering signals" analogy figures (railway points, switchboard, microphone).
// Everything comes from the site's own parts: MUX2 on GateSim, decoder(n) with its stats, TRIBUF on SwitchSim.

import { decoder } from '../../lib/combinational';
import { MUX2 } from '../../lib/gates';
import { TRIBUF } from '../../lib/switchparts';
import { flatten } from '../../sim/flatten';
import { GateSim } from '../../sim/gatesim';
import { evalOnce, simulate } from '../../sim/harness';
import { stats } from '../../sim/stats';
import { shortText, SwitchSim } from '../../sim/switchsim';
import type { Bit, ComponentDef, InstanceDef, NetDef } from '../../sim/types';

// ---- railway points: MUX2 ----------------------------------------------------------------------------------------

export interface PointsStep {
  y: number;
  /** 0 <-> 1 transitions on the three input wires (a, b, s) in this step. */
  wireToggles: number;
  /** Transitions on every net inside the mux (its NAND outputs), this step. */
  innerToggles: number;
  /** Transitions of the output wire. */
  outToggles: number;
}

/** A live MUX2 on GateSim with its toggles counted, starting settled at s = a = b = 0. */
export class PointsRun {
  private sim: GateSim;
  private inNets: number[];
  private yNet: number;
  private last: Uint32Array;
  state = { s: 0, a: 0, b: 0 };

  constructor() {
    this.sim = new GateSim(flatten(MUX2));
    const p = this.sim.design.root.ports;
    this.inNets = [p.a[0], p.b[0], p.s[0]];
    this.yNet = p.y[0];
    this.apply(0, 0, 0);
    this.sim.countToggles();
    this.last = this.sim.toggles!.slice();
  }

  private apply(s: number, a: number, b: number): void {
    this.sim.setInput('s', s); this.sim.setInput('a', a); this.sim.setInput('b', b);
    this.sim.settle();
    this.state = { s, a, b };
  }

  /** Set the inputs, settle, and report the output and what switched. */
  set(s: number, a: number, b: number): PointsStep {
    this.apply(s, a, b);
    const t = this.sim.toggles!;
    let wire = 0, inner = 0, out = 0;
    for (let i = 0; i < t.length; i++) {
      const d = t[i] - this.last[i];
      if (d === 0) continue;
      if (i === this.yNet) out += d;
      else if (this.inNets.includes(i)) wire += d;
      else inner += d;
    }
    this.last = t.slice();
    return { y: this.sim.get(this.yNet), wireToggles: wire, innerToggles: inner, outToggles: out };
  }
}

// ---- switchboard: decoder(n) -------------------------------------------------------------------------------------

export const BOARD_BITS = [1, 2, 3, 4] as const;

/** The decoder for n address bits: its one-hot outputs for an address, and its NAND count. */
export function board(n: number, addr: number): { lines: number[]; nands: number; rooms: number } {
  const def = decoder(n);
  const out = evalOnce(simulate(def), [addr]);
  return { lines: out, nands: stats(def).nands, rooms: 2 ** n };
}

// ---- microphone: TRIBUFs on one wire -----------------------------------------------------------------------------

export const SPEAKERS = 4;
/** What each speaker would say (the data input of its tri-state buffer). */
export const SPEECH = [1, 0, 1, 0] as const;

const MIC: ComponentDef = (() => {
  const instances: InstanceDef[] = Array.from({ length: SPEAKERS }, (_, i) => ({ name: `t${i}`, def: TRIBUF }));
  const nets: NetDef[] = [];
  for (let i = 0; i < SPEAKERS; i++) nets.push({ ends: [`d${i}`, `t${i}.a`] }, { ends: [`e${i}`, `t${i}.en`] });
  nets.push({ name: 'bus', ends: [...instances.map((t) => `${t.name}.y`), 'bus'] });
  const ins = [...Array.from({ length: SPEAKERS }, (_, i) => `d${i}`), ...Array.from({ length: SPEAKERS }, (_, i) => `e${i}`)];
  return {
    id: 'an_mic', name: 'one wire, four tri-state buffers', category: 'cell', symbol: { kind: 'box' },
    ports: [...ins.map((name) => ({ name, width: 1, dir: 'in' as const })), { name: 'bus', width: 1, dir: 'inout' as const }],
    netlist: () => ({ level: 'switch', instances, nets }),
  } as ComponentDef;
})();

export interface MicRead {
  /** The wire: '0' | '1' | 'X' (shorted) | 'Z' (nobody drives it). */
  value: '0' | '1' | 'X' | 'Z';
  /** The solver's description of the short, when there is one. */
  short: string | null;
}

const NAME: readonly MicRead['value'][] = ['0', '1', 'X', 'Z'];

/** Settle the bus for a set of enabled speakers. */
export function mic(enabled: readonly boolean[]): MicRead {
  const s = new SwitchSim(flatten(MIC, { mode: 'switch' }));
  for (let i = 0; i < SPEAKERS; i++) { s.setInput(`d${i}`, SPEECH[i]); s.setInput(`e${i}`, enabled[i] ? 1 : 0); }
  s.settle();
  const v: Bit = s.get(s.design.root.ports.bus[0]);
  const sh = s.shorts();
  return { value: NAME[v] ?? 'X', short: sh.length ? shortText(s, sh[0]) : null };
}
