// Chip-level facts and edits that need no DOM: which chips place which (directly), the order a
// packaged chip shows its pins in, a pin rename that keeps every parent's wires, first guesses
// for the flip-flop roles, and how a click drives a bidirectional pin.

import { renamePort } from './library';
import { chipDeps, type ChipDoc, type DefOf, type PinDoc, type Workspace } from './model';
import { setPin } from './ops';

/** Chips that place `id` directly, and chips `id` places directly (names sorted). */
export function relations(ws: Workspace, id: string): { usedBy: string[]; uses: string[] } {
  const byName = (a: string, b: string) => (ws.chips[a]?.name ?? a).localeCompare(ws.chips[b]?.name ?? b);
  const doc = ws.chips[id];
  const uses = doc ? chipDeps(doc).filter((d) => ws.chips[d]).sort(byName) : [];
  const usedBy = Object.values(ws.chips).filter((c) => c.id !== id && chipDeps(c).includes(id)).map((c) => c.id).sort(byName);
  return { usedBy, uses };
}

/**
 * The pins as the packaged box shows them (compile.ts order): inputs then inouts on the left,
 * outputs on the right, each top to bottom (then left to right) by where they sit in the chip.
 */
export function pinOrder(doc: ChipDoc): { left: PinDoc[]; right: PinDoc[] } {
  const byPos = (a: PinDoc, b: PinDoc) => a.at[1] - b.at[1] || a.at[0] - b.at[0];
  const of = (d: PinDoc['dir']) => doc.pins.filter((p) => p.dir === d).sort(byPos);
  return { left: [...of('in'), ...of('inout')], right: of('out') };
}

/**
 * Rename a pin of `chipId`. The chip's own edit is ops.setPin (validation, the flip-flop marking
 * follows); every wire on that port of an instance of the chip, in every chip, follows too
 * (renamePort), so parents keep their connections.
 */
export function renamePin(ws: Workspace, chipId: string, pinId: string, name: string, defOf?: DefOf): { ws: Workspace } | { reason: string } {
  const doc = ws.chips[chipId];
  const pin = doc?.pins.find((p) => p.id === pinId);
  if (!doc || !pin) return { reason: `no pin '${pinId}'` };
  if (pin.name === name) return { ws };
  const r = setPin(doc, pinId, { name }, defOf);
  if (r.reason) return { reason: r.reason };
  const next = renamePort(ws, chipId, pin.name, name);
  return { ws: { ...next, chips: { ...next.chips, [chipId]: r.doc } } };
}

/**
 * First guess at the flip-flop roles: pins named like d / q / clk / en, else the first fitting
 * 1-bit pin (a clock-kind input for clk). Null when there is no 1-bit input pair and output.
 */
export function guessFf(doc: ChipDoc): NonNullable<ChipDoc['ff']> | null {
  const ins = doc.pins.filter((p) => p.dir === 'in' && p.width === 1);
  const outs = doc.pins.filter((p) => p.dir === 'out' && p.width === 1);
  const named = (ps: PinDoc[], re: RegExp) => ps.find((p) => re.test(p.name));
  const clk = ins.find((p) => p.kind === 'clock') ?? named(ins, /^(clk|clock|c|ck)$/i);
  const d = named(ins.filter((p) => p !== clk), /^d$/i) ?? ins.find((p) => p !== clk && !/^(en|e|we|ce)$/i.test(p.name));
  const q = named(outs, /^q$/i) ?? outs[0];
  const clk2 = clk ?? ins.find((p) => p !== d);
  if (!d || !q || !clk2) return null;
  const en = named(ins.filter((p) => p !== d && p !== clk2), /^(en|e|we|ce)$/i);
  return { d: d.name, q: q.name, clk: clk2.name, ...(en ? { en: en.name } : {}) };
}

/**
 * What a click drives onto a bidirectional pin next: Z (undriven, `undefined`) → 0 → all ones
 * → Z. The pin's `value` holds it; undefined means nothing drives it from outside.
 */
export function nextDrive(p: PinDoc): number | undefined {
  if (p.value === undefined) return 0;
  return p.value === 0 ? 2 ** p.width - 1 : undefined;
}
