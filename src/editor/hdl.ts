// Verilog chips (DOM-free): a group of chips drawn from one Verilog source, one per module. The top module's chip
// holds the text; synthesizing it (Yosys in the page, hdl/yosys.ts) rebuilds every chip of the group in place
// (ids kept by module name, so parents keep their wires), adds chips for new modules and lets go of vanished ones.
// The bodies are generated: Editor.edit refuses to change them (isGenerated), Detach turns them into drawn chips.

import { type GateSet, synthesize } from '../hdl/yosys';
import { type HdlDiag, importYosysJson, type ImportedModule } from '../hdl/yosysjson';
import { type ChipDoc, emptyChip, type HdlDoc, slug, uniqueName, type Workspace } from './model';
import { openChip } from './session';
import { usedBy } from './library';

export const VERILOG_TEMPLATE = `// Each module becomes a chip: its ports are the chip's pins.
module my_chip(
  input  [3:0] a, b,
  input        sel,
  output [3:0] y
);
  assign y = sel ? a + b : a & b;
endmodule
`;

/** Module names in Verilog text, in order (a quick scan, before Yosys: comments and strings skipped). */
export function verilogModules(text: string): string[] {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, '').replace(/"(?:\\.|[^"\\])*"/g, '""');
  return [...clean.matchAll(/\bmodule\s+(?:automatic\s+|static\s+)?([A-Za-z_][\w$]*)/g)].map((m) => m[1]);
}

/** The chip holding a Verilog chip's source: itself, or the one it names. */
export function hdlHome(ws: Workspace, id: string): ChipDoc | undefined {
  const c = ws.chips[id];
  if (!c?.hdl) return undefined;
  if (c.hdl.src) return c;
  const home = c.hdl.of ? ws.chips[c.hdl.of] : undefined;
  return home?.hdl?.src ? home : undefined;
}

/** Every chip drawn from this home's source, the home first. */
export function hdlGroup(ws: Workspace, homeId: string): ChipDoc[] {
  const home = ws.chips[homeId];
  if (!home?.hdl?.src) return [];
  return [home, ...Object.values(ws.chips).filter((c) => c.hdl?.of === homeId)];
}

/** Is the chip's body generated, from Verilog or a truth table (ttable.ts), so the canvas must not edit it? */
export const isGenerated = (ws: Workspace, id: string): boolean => !!hdlHome(ws, id) || !!ws.chips[id]?.table || !!ws.chips[id]?.fsm;

/** The part of a chip a synthesis owns: changing it by hand is refused. */
export function bodyKey(doc: ChipDoc): string {
  return JSON.stringify([doc.pins.map(({ value: _v, ...p }) => p), doc.parts, doc.wires, doc.labels]);
}

/** A new Verilog chip (not yet synthesized), opened. */
export function newVerilogChip(ws: Workspace, text = VERILOG_TEMPLATE, file?: string, gates: GateSet = 'std', top?: string): { ws: Workspace; id: string } {
  const mods = verilogModules(text);
  const module = top ?? mods[mods.length - 1] ?? 'my_chip';
  const id = uniqueName(`u_${slug(module)}`, Object.keys(ws.chips));
  const hdl: HdlDoc = { module, src: { file: file ?? `${module}.v`, text, gates, ...(top ? { top } : {}) }, stale: true };
  const chip: ChipDoc = { ...emptyChip(id, module), hdl };
  return { ws: openChip({ ...ws, chips: { ...ws.chips, [id]: chip } }, id), id };
}

/** The source changed (typed): one undo step for the text, the bodies marked stale until synthesized. */
export function setSource(ws: Workspace, homeId: string, src: Partial<NonNullable<HdlDoc['src']>>): Workspace {
  const home = ws.chips[homeId];
  if (!home?.hdl?.src) return ws;
  const next = { ...home.hdl.src, ...src };
  if (!next.top) delete next.top;
  return { ...ws, chips: { ...ws.chips, [homeId]: { ...home, hdl: { ...home.hdl, src: next, stale: true } } } };
}

export type SynthOutcome =
  | { ok: true; ws: Workspace; diags: HdlDiag[]; modules: ImportedModule[]; added: string[]; dropped: string[] }
  | { ok: false; diags: HdlDiag[] };

/**
 * Synthesize a group's source and rebuild its chips. Ids are kept by module (the top module always on the home
 * chip, whatever it is called now); a module that vanished from the text is deleted, or detached when a chip
 * outside the group places it. Name, colour and notes stay with the chip.
 */
export async function resynthesize(ws: Workspace, homeId: string, progress?: (done: number, total: number) => void): Promise<SynthOutcome> {
  const home = ws.chips[homeId];
  const src = home?.hdl?.src;
  if (!src) return { ok: false, diags: [{ level: 'error', msg: 'not a Verilog chip' }] };
  const r = await synthesize({ [src.file]: src.text }, { top: src.top, gates: src.gates, progress });
  if (!r.json) return { ok: false, diags: r.diags.length ? r.diags : [{ level: 'error', msg: 'Yosys wrote no netlist' }] };
  return applyNetlist(ws, homeId, r.json, r.diags);
}

/** The second half of resynthesize, given Yosys's JSON (tests feed it directly). */
export function applyNetlist(ws: Workspace, homeId: string, json: unknown, yosysDiags: HdlDiag[] = []): SynthOutcome {
  const home = ws.chips[homeId];
  const src = home.hdl!.src!;
  const group = hdlGroup(ws, homeId);
  const groupIds = new Set(group.map((c) => c.id));
  const imp = importYosysJson(json, {
    top: src.top,
    idOf: (m, isTop) => (isTop ? homeId : group.find((c) => c.id !== homeId && c.hdl!.module === m)?.id),
    taken: Object.keys(ws.chips).filter((id) => !groupIds.has(id)),
  });
  if ('error' in imp) return { ok: false, diags: [...yosysDiags.filter((d) => d.level === 'error'), { level: 'error', msg: imp.error }] };
  const chips = { ...ws.chips };
  const added: string[] = [];
  for (const doc of imp.chips) {
    const old = ws.chips[doc.id];
    const module = imp.modules.find((m) => m.chip === doc.id)!.module;
    if (!old) added.push(doc.id);
    const hdl: HdlDoc = doc.id === homeId ? { module, src } : { module, of: homeId };
    chips[doc.id] = {
      ...doc,
      name: old && !old.hdl?.stale && old.name !== old.hdl?.module ? old.name : doc.name, // a name the user gave stays
      ...(old?.hue !== undefined ? { hue: old.hue } : {}),
      ...(old?.notes ? { notes: old.notes } : {}),
      hdl,
    };
  }
  const dropped: string[] = [];
  const made = new Set(imp.chips.map((c) => c.id));
  for (const c of group) {
    if (made.has(c.id)) continue;
    const outside = usedBy({ ...ws, chips }, c.id).filter((p) => !groupIds.has(p));
    if (outside.length) { const { hdl: _h, ...rest } = c; chips[c.id] = rest; }
    else delete chips[c.id];
    dropped.push(c.id);
  }
  const open = ws.open.filter((id) => chips[id]);
  return { ok: true, ws: { ...ws, chips, open: open.length ? open : [homeId] }, diags: [...yosysDiags, ...imp.diags], modules: imp.modules, added, dropped };
}

/** Detach: every chip of the group becomes an ordinary drawn chip (the source is dropped). */
export function detachGroup(ws: Workspace, id: string): { ws: Workspace; ids: string[] } {
  const home = hdlHome(ws, id);
  if (!home) return { ws, ids: [] };
  const chips = { ...ws.chips };
  const ids = hdlGroup(ws, home.id).map((c) => c.id);
  for (const cid of ids) { const { hdl: _h, ...rest } = chips[cid]; chips[cid] = rest; }
  return { ws: { ...ws, chips }, ids };
}

/** Yosys JSON netlist → drawn chips added to the workspace (no source to keep: they are ordinary chips). */
export function importNetlist(ws: Workspace, json: unknown): { ws: Workspace; top: string; added: string[]; diags: HdlDiag[] } | { error: string } {
  const imp = importYosysJson(json, { taken: Object.keys(ws.chips) });
  if ('error' in imp) return imp;
  const chips = { ...ws.chips };
  for (const c of imp.chips) chips[c.id] = c;
  return { ws: openChip({ ...ws, chips }, imp.top), top: imp.top, added: imp.chips.map((c) => c.id), diags: imp.diags };
}
