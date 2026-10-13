// Writing the 6502's blocks as logic: each helper adds an NMOS cell to the block and returns the
// net of its output, so a block reads like its equations while every gate is a real transistor cell.

import type { ComponentDef } from '../../sim/types';
import { NINV, nnand, nnor } from '../nmos';
import { NMOS } from '../transistors';
import { DLAT, naoi, PULL2, SCELL } from './cells';
import { Ckt } from './ckt';

/** A gate's input ports (in order) wired to nets. */
const inputs = (d: ComponentDef, nets: string[]) => Object.fromEntries(d.ports.filter((p) => p.dir === 'in').map((p, i) => [p.name, nets[i]]));

export class Logic extends Ckt {
  private seq = 0;
  /** A fresh internal net name. */
  net(prefix = 'n'): string {
    return `${prefix}${this.seq++}`;
  }
  private name(prefix: string): string {
    return `${prefix}${this.seq++}`;
  }
  inv(a: string, out = this.net()): string {
    this.add(this.name('inv'), NINV, { a, y: out });
    return out;
  }
  nor(ins: string[], out = this.net()): string {
    if (ins.length === 1) return this.inv(ins[0], out);
    const d = nnor(ins.length);
    this.add(this.name('nor'), d, { ...inputs(d, ins), y: out });
    return out;
  }
  nand(ins: string[], out = this.net()): string {
    if (ins.length === 1) return this.inv(ins[0], out);
    const d = nnand(ins.length);
    this.add(this.name('nand'), d, { ...inputs(d, ins), y: out });
    return out;
  }
  /** NOT(sum of products) of nets. */
  aoi(products: string[][], out = this.net()): string {
    if (products.length === 1) return this.nand(products[0], out);
    if (products.every((p) => p.length === 1)) return this.nor(products.map((p) => p[0]), out);
    const letters = new Map<string, string>();
    const expr = products.map((p) => p.map((n) => {
      if (!letters.has(n)) letters.set(n, String.fromCharCode(97 + letters.size + (letters.size >= 24 ? 1 : 0)));
      return letters.get(n)!;
    }).join('')).join('|');
    const conns: Record<string, string> = { y: out };
    for (const [n, l] of letters) conns[l] = n;
    this.add(this.name('aoi'), naoi(expr), conns);
    return out;
  }
  and(ins: string[], out = this.net()): string { return this.inv(this.nand(ins), out); }
  or(ins: string[], out = this.net()): string { return this.inv(this.nor(ins), out); }
  /** a XOR b, given both polarities. */
  xor(a: string, na: string, b: string, nb: string, out = this.net()): string { return this.aoi([[a, b], [na, nb]], out); }
  /** a XNOR b, given both polarities. */
  xnor(a: string, na: string, b: string, nb: string, out = this.net()): string { return this.aoi([[a, nb], [na, b]], out); }
  /** A pass transistor between a and b, gated by g. */
  pass(g: string, a: string, b: string): void {
    this.add(this.name('pass'), NMOS, { g, d: a, s: b });
  }
  /** A pull-down of `node` while g = 1 (a constant on a precharged bus, a clear). */
  pulldown(g: string, node: string): void {
    this.add(this.name('pd'), NMOS, { g, d: node, s: 'GND' });
  }
  /** A pull-up from VDD while g = 1 (an enhancement transistor: a driven 1). */
  pullup(g: string, node: string): void {
    this.add(this.name('pu'), NMOS, { g, d: 'VDD', s: node });
  }
  /** Bus driver: pull `bus` low while en = 1 and v = 1. */
  drive(en: string, v: string, bus: string): void {
    this.add(this.name('drv'), PULL2, { en, v, bus });
  }
  /** Dynamic latch: transparent while en = 1; returns its inverted output nq and its stored charge s (= d held). */
  dlat(d: string, en: string, nq = this.net(), s = this.net()): { nq: string; s: string } {
    this.add(this.name('lat'), DLAT, { d, en, nq, s });
    return { nq, s };
  }
  /**
   * Master–slave pair: `d`, computed in φ1, is caught by the master at the end of φ1 and shown by the
   * slave from φ2 until the next φ2. Returns q = d held and nq = NOT q (the slave's stored charge
   * is the master's inverted output).
   */
  ms(d: string, p1: string, p2: string, q = this.net(), nq = this.net()): { q: string; nq: string } {
    const m = this.dlat(d, p1);
    this.dlat(m.nq, p2, q, nq);
    return { q, nq };
  }
  /** Refreshed storage node q (loaded from outside through pass transistors); returns { nq, r }. */
  cell(q: string, rf: string, nq = this.net(), r = this.net()): { nq: string; r: string } {
    this.add(this.name('bit'), SCELL, { q, rf, nq, r });
    this.cap([q]);
    return { nq, r };
  }
}
