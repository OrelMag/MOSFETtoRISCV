// A structural fingerprint of a component and everything below it: ids, ports, every level's instances (name, part,
// place) and nets (ends, name, routing hints), hashed. Two defs with the same fingerprint draw, simulate and cost the
// same; tests/rv16-custom.test.ts pins the RV16 cores' and the campaign's reference answers' fingerprints so custom rows
// cannot move them.

import { registry } from '../src/lib/define';
import { netlistOf, type ComponentDef } from '../src/sim/types';

const memo = new WeakMap<ComponentDef, string>();

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function fingerprint(d: ComponentDef): string {
  const hit = memo.get(d);
  if (hit) return hit;
  const nl = netlistOf(d);
  const body = JSON.stringify({
    id: d.id, prim: d.prim ?? null, ports: d.ports.map((p) => [p.name, p.dir, p.width]),
    inst: nl ? nl.instances.map((i) => [i.name, fingerprint(i.def), i.at ?? null, i.flip ?? null, i.rot ?? null]) : null,
    nets: nl ? nl.nets.map((n) => [n.ends, n.name ?? null, n.trunk ?? null, n.via ?? null, n.tags ?? null]) : null,
  });
  const f = fnv(body);
  memo.set(d, f);
  return f;
}

/** Every registered rv16_* part's fingerprint, and the reference answer documents of every level built (hashed). */
export function rv16Fingerprints(levels: (() => { answer: () => unknown } | null | undefined)[]): { parts: Record<string, string>; answers: Record<string, string> } {
  const answers: Record<string, string> = {};
  for (const mk of levels) {
    let ch: { id?: string; answer: () => unknown } | null | undefined;
    try { ch = mk() as typeof ch; } catch { continue; }
    if (!ch?.id) continue;
    let a: unknown;
    try { a = ch.answer(); } catch { continue; }
    const text = JSON.stringify(a);
    if (/rv16_/.test(text)) answers[ch.id] = fnv(text);
  }
  const parts: Record<string, string> = {};
  for (const [id, d] of [...registry].sort((x, y) => x[0].localeCompare(y[0]))) if (id.startsWith('rv16_')) parts[id] = fingerprint(d);
  return { parts, answers };
}
