// User-coloured nets (Turing Complete style): a colour picked for a wire or a pointer belongs to its
// net. It is stored on the wires and pointers (`hue`), so a net drawn later from coloured pieces, or
// two coloured nets joined, needs no bookkeeping: each built net shows the colour most of its
// coloured wires and pointers carry. Brightness still says the value (palettes.css); the colour
// never reaches the compiler (library.ts leaves `hue` out of the document hash). DOM-free.

import type { Compiled } from './compile';
import type { ChipDoc, LabelDoc, NetHue, WireDoc } from './model';

/** The swatches: OKLCH hues spaced around the wheel, clear of the X red (≈ 15°) as netHue's are. */
export const WIRE_HUES: readonly { hue: number; name: string }[] = [
  { hue: 45, name: 'orange' }, { hue: 80, name: 'amber' }, { hue: 120, name: 'olive' }, { hue: 150, name: 'green' },
  { hue: 185, name: 'teal' }, { hue: 220, name: 'sky' }, { hue: 255, name: 'blue' }, { hue: 290, name: 'violet' },
  { hue: 320, name: 'magenta' },
];

/** Each built net's chosen colour by net index (undefined: none), the one most of its pieces carry. */
export function userHues(doc: ChipDoc, built: Compiled | null, nets: number): (NetHue | undefined)[] {
  const out: (NetHue | undefined)[] = new Array(nets);
  if (!built) return out;
  const votes = new Map<number, Map<NetHue, number>>();
  const vote = (net: number | undefined, hue: NetHue | undefined) => {
    if (hue === undefined || net === undefined || net < 0 || net >= nets) return;
    let m = votes.get(net);
    if (!m) votes.set(net, (m = new Map()));
    m.set(hue, (m.get(hue) ?? 0) + 1);
  };
  for (const w of doc.wires) vote(built.netOfWire.get(w.id), w.hue);
  for (const l of doc.labels) vote(built.netOfLabel.get(l.id), l.hue);
  for (const [net, m] of votes) {
    let best: NetHue | undefined, n = 0;
    // Most votes; a tie goes to the colour that sorts first, so the choice does not depend on order.
    for (const [hue, c] of m) if (c > n || (c === n && String(hue) < String(best))) { best = hue; n = c; }
    out[net] = best;
  }
  return out;
}

/** The wires and pointers on the nets of the given ones (the given ones alone when not built). */
export function netMembers(doc: ChipDoc, built: Compiled | null, wires: readonly string[], labels: readonly string[]): { wires: Set<string>; labels: Set<string> } {
  const w = new Set(wires), l = new Set(labels);
  if (!built) return { wires: w, labels: l };
  const nets = new Set<number>();
  for (const id of wires) { const n = built.netOfWire.get(id); if (n !== undefined && n >= 0) nets.add(n); }
  for (const id of labels) { const n = built.netOfLabel.get(id); if (n !== undefined && n >= 0) nets.add(n); }
  for (const x of doc.wires) if (nets.has(built.netOfWire.get(x.id) ?? -1)) w.add(x.id);
  for (const x of doc.labels) if (nets.has(built.netOfLabel.get(x.id) ?? -1)) l.add(x.id);
  return { wires: w, labels: l };
}

/** Colour the nets of the given wires and pointers (undefined: back to the palette's colours). */
export function colourNets(doc: ChipDoc, built: Compiled | null, wires: readonly string[], labels: readonly string[], hue: NetHue | undefined): ChipDoc {
  const m = netMembers(doc, built, wires, labels);
  const set = <T extends WireDoc | LabelDoc>(x: T): T => {
    if (x.hue === hue) return x;
    const { hue: _, ...rest } = x;
    return (hue === undefined ? rest : { ...rest, hue }) as T;
  };
  const ws = doc.wires.map((x) => (m.wires.has(x.id) ? set(x) : x));
  const ls = doc.labels.map((x) => (m.labels.has(x.id) ? set(x) : x));
  const changed = ws.some((x, i) => x !== doc.wires[i]) || ls.some((x, i) => x !== doc.labels[i]);
  return changed ? { ...doc, wires: ws, labels: ls } : doc;
}

/** The colour the given wires' and pointers' nets show, when they all show the same one (null: mixed). */
export function hueOfNets(doc: ChipDoc, built: Compiled | null, wires: readonly string[], labels: readonly string[]): NetHue | undefined | null {
  if (!built) {
    const hs = new Set<NetHue | undefined>([...doc.wires.filter((w) => wires.includes(w.id)).map((w) => w.hue), ...doc.labels.filter((l) => labels.includes(l.id)).map((l) => l.hue)]);
    return hs.size === 1 ? [...hs][0] : null;
  }
  const nets = new Set<number>();
  for (const id of wires) nets.add(built.netOfWire.get(id) ?? -1);
  for (const id of labels) nets.add(built.netOfLabel.get(id) ?? -1);
  const n = Math.max(0, ...nets) + 1;
  const hues = userHues(doc, built, n);
  const shown = new Set([...nets].map((i) => (i < 0 ? undefined : hues[i])));
  return shown.size === 1 ? [...shown][0] : null;
}
