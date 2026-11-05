// Where a pointer's value goes: a straight line from the net's driver to each of its other pointers, drawn over the
// circuit on hover and as a value travels in slow motion. Straight and dashed, so it never reads as a routed wire.
import type { Vec } from '../sim/geometry';
import { tagGeom, type NetTag } from './route';

/** A net as drawn: its pointers, in order, and its wires. */
export interface PartnerNet {
  tags: NetTag[];
  paths: Vec[][];
}

/** Lines from the driver (its pointer, else the start of its wires) to every other pointer of the net. */
export function partnerLines(net: PartnerNet, name: string, driverEnd: string): [Vec, Vec][] {
  const tips = net.tags.map((t) => ({ end: t.end, tip: tagGeom(t, name).tip }));
  const own = tips.find((t) => t.end === driverEnd);
  const from = own?.tip ?? net.paths[0]?.[0];
  if (!from) return [];
  return tips.filter((t) => t !== own).map((t): [Vec, Vec] => [from, t.tip]);
}
