// Hand placement of a Builder-built netlist (the warp core's and the out-of-order core's top levels): instances placed
// by name in groups (blocks), then each net drawn as a wire inside a block or as labels between blocks, like a real
// schematic. Only positions and labels change: the instances and connections stay the Builder's.

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef } from '../sim/types';

export type At = [number, number];

/** Places a built netlist's instances by name; names a variant lacks are skipped, so one plan serves every variant. */
export class Placer {
  readonly at = new Map<string, At>();
  readonly group = new Map<string, string>();
  private readonly defs: Map<string, ComponentDef>;
  constructor(insts: InstanceDef[]) { this.defs = new Map(insts.map((i) => [i.name, i.def])); }
  has(nm: string): boolean { return this.defs.has(nm); }
  private geom(nm: string) { return symbolGeom(this.defs.get(nm)!); }
  w(nm: string): number { return this.has(nm) ? this.geom(nm).w : 0; }
  h(nm: string): number { return this.has(nm) ? this.geom(nm).h : 0; }
  private port(nm: string, port: string | number): string {
    return typeof port === 'string' ? port : this.defs.get(nm)!.ports.filter((p) => p.dir !== 'out')[port].name;
  }
  /** The first output's name. */
  out(nm: string): string { return this.defs.get(nm)!.ports.find((p) => p.dir === 'out')!.name; }
  put(grp: string, nm: string, x: number, y: number): void {
    if (!this.has(nm)) return;
    this.at.set(nm, [x, y]);
    this.group.set(nm, grp);
  }
  /** Put nm at x with a port (by name, or the k-th input) on row y. */
  row(grp: string, nm: string, port: string | number, x: number, y: number): void {
    if (this.has(nm)) this.put(grp, nm, x, y - this.geom(nm).ports[this.port(nm, port)].pos[1]);
  }
  /** Where a placed port is (by name, or the k-th input). */
  pin(nm: string, port: string | number): At {
    // a part or port this variant lacks: so does the part placed by it
    const g = this.at.has(nm) ? this.geom(nm).ports[this.port(nm, port)] : undefined;
    if (!g) return [NaN, NaN];
    const [x, y] = this.at.get(nm)!;
    return [x + g.pos[0], y + g.pos[1]];
  }
  x(nm: string): number { return this.at.get(nm)?.[0] ?? NaN; }
  y(nm: string): number { return this.at.get(nm)?.[1] ?? NaN; }
  right(nm: string): number { return this.at.has(nm) ? this.x(nm) + this.w(nm) : -Infinity; }
  bottom(nm: string): number { return this.at.has(nm) ? this.y(nm) + this.h(nm) : -Infinity; }
  /** Columns from (x, y), gap apart, their parts vgap apart. Returns the right edge and the bottom. */
  cols(grp: string, x: number, y: number, columns: string[][], gap = 12, vgap = 4): { right: number; bottom: number } {
    let cx = x, right = x, bottom = y;
    for (const c of columns) {
      const names = c.filter((nm) => this.has(nm));
      if (!names.length) continue;
      let cy = y, cw = 0;
      for (const nm of names) { this.put(grp, nm, cx, cy); cy += this.h(nm) + vgap; cw = Math.max(cw, this.w(nm)); }
      bottom = Math.max(bottom, cy - vgap);
      right = cx + cw;
      cx += cw + gap;
    }
    return { right, bottom };
  }
  /** The rightmost and lowest edges of the parts placed in some groups. */
  extent(...groups: string[]): { right: number; bottom: number } {
    let right = 0, bottom = 0;
    for (const [nm, g] of this.group) if (groups.includes(g)) { right = Math.max(right, this.right(nm)); bottom = Math.max(bottom, this.bottom(nm)); }
    return { right, bottom };
  }
}


/**
 * The nets of a placed netlist: a wire inside a block (one sink, to the right of its driver, in the same group), or one
 * asked for (`wired`: 'driver>sink'); labels otherwise, and always for drivers in `labelled`. Unnamed nets are named by
 * `names` (driver end → name), else by their driver part (its first output), else by the driver end.
 */
export function placedNets(P: Placer, raw: NetDef[], o: { names?: Record<string, string>; byPort?: (inst: string) => boolean; wired?: Set<string>; labelled?: Set<string>; trunks?: Map<string, number> } = {}): NetDef[] {
  const used = new Set<string>();
  for (const nt of raw) if (nt.name) used.add(nt.name);
  const instOf = (e: string) => (e.includes('.') ? e.slice(0, e.indexOf('.')) : '');
  return raw.map((nt): NetDef => {
    const drv = nt.ends[0], sinks = nt.ends.slice(1), di = instOf(drv);
    let name = nt.name;
    if (!name && di) {
      const port = drv.slice(di.length + 1);
      const want = o.names?.[drv] ?? (o.byPort?.(di) ? port : P.out(di) === port ? di : drv);
      name = used.has(want) ? drv : want;
      used.add(name);
    }
    const asWire = (s: string) => {
      const si = instOf(s);
      if (!di || !si || o.labelled?.has(drv)) return false;
      if (o.wired?.has(`${drv}>${s}`)) return true;
      return sinks.length === 1 && P.group.get(di) === P.group.get(si) && P.x(si) >= P.right(di);
    };
    const tags = sinks.filter((s) => !asWire(s));
    const trunk = o.trunks?.get(drv);
    return { name, ends: nt.ends, ...(tags.length === sinks.length ? { tags: true as const } : tags.length ? { tags } : {}), ...(trunk !== undefined ? { trunk } : {}) };
  });
}
