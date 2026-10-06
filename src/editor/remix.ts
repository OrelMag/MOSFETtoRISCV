// "Open in Sandbox": any circuit the site shows becomes an editable chip of the learner's
// workspace (a remix). Called from the workbench and chapter scenes, which live in the main
// bundle, so this module touches neither the DOM nor the editor UI: it reads the saved
// workspace, adds the chip (docFromDef: parts, wires, and the schematic's tags as pointers) and
// saves it; the sandbox page then opens it from storage.
//
// A part is placed by library reference only when a fresh page load can find it by that id
// (a part defined when the site loads, a family member, a generator pattern). Parts generated
// on the way (a CPU's data memory, its program ROM, its constants) would not resolve after a
// reload, so they come along as sandbox parts (ROM, constant) or as chips of their own.

import { listed } from '../lib/catalog';
import { registry } from '../lib/define';
import { regenerable } from '../lib/resolve';
import { disasm } from '../riscv/isa';
import { type ComponentDef, netlistOf } from '../sim/types';
import { docFromDef } from './fromdef';
import { same } from './history';
import { type ChipDoc, type PartRef, slug, uniqueName, type Workspace } from './model';
import { MAX_ROM_K } from './parts';
import { openChip } from './session';
import { type KV, loadWorkspace, saveWorkspace } from './store';

/** True for a user chip of `ws` (a def compiled by the sandbox, id `u_…`). */
const userChip = (ws: Workspace, d: ComponentDef) => d.category === 'custom' && d.id.startsWith('u_') && !!ws.chips[d.id];

/** Will `{ lib: d.id }` still resolve after a reload? (Splitters and mergers go by their widths.) */
export function stableRef(d: ComponentDef): boolean {
  if (d.prim === 'alias' || regenerable(d.id)) return true;
  return registry.get(d.id) === d && (listed(d.id) || !netlistOf(d) || /^tie[01]$/.test(d.id));
}

/** A library constant (constWord) as a sandbox constant: the same circuit. */
function constRef(d: ComponentDef): PartRef | undefined {
  const m = d.id.match(/^const(\d+)_([0-9a-f]+)$/);
  const w = m ? Number(m[1]) : 0;
  if (!m || w > 53 || d.ports.length !== 1 || d.ports[0].name !== 'y') return undefined;
  return { const: { width: w, value: parseInt(m[2], 16) } };
}

/**
 * A CPU's instruction memory (lib/cpu.ts rom: 32-bit byte address, 32-bit words, a lookup
 * leaf) as a sandbox ROM part with the same ports, its program as hex with the disassembly.
 */
function romRef(d: ComponentDef): PartRef | undefined {
  const [a, q] = d.ports;
  if (!d.id.startsWith('rom_') || !d.behavior || d.ports.length !== 2 || a.name !== 'addr' || a.width !== 32 || q.name !== 'data' || q.width !== 32) return undefined;
  const n = netlistOf(d)?.instances.filter((i) => /^c\d+$/.test(i.name)).length ?? 0;
  const k = Math.log2(n);
  if (!Number.isInteger(k) || k < 1 || k > MAX_ROM_K) return undefined;
  const words = Array.from({ length: n }, (_, i) => d.behavior!.eval([4 * i], undefined)[0] >>> 0);
  while (words.length > 1 && words[words.length - 1] === 0x13) words.pop();
  const src = words.map((w, i) => `${w.toString(16).padStart(8, '0')}  # ${(4 * i).toString(16).padStart(3, '0')}: ${disasm(w, 4 * i)}`).join('\n');
  return { rom: { k, w: 32, addr: 'rv32', lang: 'hex', src: `${src}\n` } };
}

/**
 * `def` as a new chip of `ws` (id `u_<id>_copy`, made unique; name "<name> copy"), opened as
 * the active tab, with any chips it needs (`added`, the new chip last). A user chip is copied as
 * drawn; user chips inside a remixed circuit are placed by reference.
 */
export function remixDef(ws: Workspace, def: ComponentDef): { ws: Workspace; id: string; added: string[] } | { error: string } {
  const taken = new Set(Object.keys(ws.chips));
  const base = def.id.startsWith('u_') ? def.id.slice(2) : def.id;
  const id = uniqueName(`u_${slug(base)}_copy`, taken);
  taken.add(id);
  const names = new Set(Object.values(ws.chips).map((c) => c.name));
  let name = `${def.name} copy`;
  for (let i = 2; names.has(name); i++) name = `${def.name} copy ${i}`;

  const chips: Record<string, ChipDoc> = {};
  const chipFor = new Map<ComponentDef, string | null>();
  const refOf = (d: ComponentDef): PartRef | undefined => {
    if (userChip(ws, d)) return { chip: d.id };
    if (stableRef(d)) return undefined;
    const special = romRef(d) ?? constRef(d);
    if (special) return special;
    // Brought along as a chip (reusing an identical one from an earlier remix). If it cannot be
    // one (a port wider than a pin), the library reference stays: it works until a reload.
    let cid = chipFor.get(d);
    if (cid === undefined) {
      const want = `u_${slug(d.id)}`;
      const sub = docFromDef(d, { id: want, refOf });
      if ('error' in sub) cid = null;
      else if (ws.chips[want] && same(ws.chips[want], sub)) cid = want;
      else {
        cid = uniqueName(want, taken);
        taken.add(cid);
        chips[cid] = { ...sub, id: cid };
      }
      chipFor.set(d, cid);
    }
    return cid ? { chip: cid } : undefined;
  };

  let doc: ChipDoc | { error: string };
  const own = userChip(ws, def) ? ws.chips[def.id] : undefined;
  if (own) doc = { ...structuredClone(own), id, name };
  else doc = docFromDef(def, { id, name, refOf });
  if ('error' in doc) return { error: doc.error };
  // Input values are the learner's own state, not part of the circuit.
  chips[id] = { ...doc, pins: doc.pins.map(({ value: _v, ...p }) => p) };
  return { ws: openChip({ ...ws, chips: { ...ws.chips, ...chips } }, id), id, added: Object.keys(chips) };
}

/** remixDef on the saved workspace, saved back. Returns the new chip's id (for #/sandbox/<id>). */
export function remixIntoStorage(def: ComponentDef, kv?: KV | null): { id: string; added: string[] } | { error: string } {
  const ws = kv === undefined ? loadWorkspace() : loadWorkspace(kv);
  const r = remixDef(ws, def);
  if ('error' in r) return r;
  const saved = kv === undefined ? saveWorkspace(r.ws) : saveWorkspace(r.ws, kv);
  return saved.ok ? { id: r.id, added: r.added } : { error: saved.reason };
}
