// Custom ISAs in a workspace, DOM-free: the master tables live in ws.isas; a ROM that uses one holds a
// copy (romRef.isa), so it builds on its own (a share link, an exported chip). Editing a table writes
// it to ws.isas and to every ROM that holds that id, in one step (one undo step in the editor).

import { ISA_PRESETS } from '../isa/presets';
import type { IsaDoc } from '../isa/table';
import { type ChipDoc, slug, uniqueName, type Workspace } from './model';

/** Every table the workspace knows: its own, then any a ROM holds that the list lacks (an imported chip), by name. */
export function isaList(ws: Workspace): IsaDoc[] {
  const out = new Map(Object.entries(ws.isas ?? {}));
  for (const c of Object.values(ws.chips)) {
    for (const p of c.parts) if ('rom' in p.ref && p.ref.rom.lang === 'isa' && p.ref.rom.isa && !out.has(p.ref.rom.isa.id)) out.set(p.ref.rom.isa.id, p.ref.rom.isa);
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The table with this id: the workspace's, a ROM's copy, or a preset. */
export function isaById(ws: Workspace, id: string): IsaDoc | undefined {
  return ws.isas?.[id] ?? isaList(ws).find((d) => d.id === id) ?? ISA_PRESETS[id];
}

/** The ROMs (chip, part) that hold the table `id`. */
export function isaUses(ws: Workspace, id: string): { chip: string; part: string }[] {
  return Object.values(ws.chips).flatMap((c) => c.parts.flatMap((p) => ('rom' in p.ref && p.ref.rom.lang === 'isa' && p.ref.rom.isa?.id === id ? [{ chip: c.id, part: p.id }] : [])));
}

/** A copy of `from` (a preset or another table) under a new id and name, added to the workspace. */
export function copyIsa(ws: Workspace, from: IsaDoc, name = `${from.name} copy`): { ws: Workspace; id: string } {
  const taken = new Set([...isaList(ws).map((d) => d.id), ...Object.keys(ISA_PRESETS)]);
  const id = uniqueName(`isa_${slug(name) || 'isa'}`, taken);
  const names = isaList(ws).map((d) => d.name);
  const doc: IsaDoc = { ...structuredClone(from), id, name: uniqueName(name, names) };
  return { ws: { ...ws, isas: { ...ws.isas, [id]: doc } }, id };
}

/** Store an edited table, and its copy in every ROM that holds it (their word width follows). */
export function putIsa(ws: Workspace, doc: IsaDoc): Workspace {
  const chips: Record<string, ChipDoc> = {};
  for (const [cid, c] of Object.entries(ws.chips)) {
    let changed = false;
    const parts = c.parts.map((p) => {
      if (!('rom' in p.ref) || p.ref.rom.lang !== 'isa' || p.ref.rom.isa?.id !== doc.id) return p;
      changed = true;
      return { ...p, ref: { rom: { ...p.ref.rom, isa: doc, w: doc.wordBits, addr: 'word' as const } } };
    });
    chips[cid] = changed ? { ...c, parts } : c;
  }
  return { ...ws, chips, isas: { ...ws.isas, [doc.id]: doc } };
}

/** Remove a table from the list (the ROMs that hold it keep their copy, so it stays listed while one does). */
export function deleteIsa(ws: Workspace, id: string): Workspace {
  if (!ws.isas?.[id]) return ws;
  const { [id]: _gone, ...rest } = ws.isas;
  const next: Workspace = { ...ws, isas: rest };
  if (!Object.keys(rest).length) delete next.isas;
  return next;
}
