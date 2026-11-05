// How the wires-first rule draws every chapter's opening levels: labels before and after, per chapter.
// vite-node scripts/wire-audit.ts <out.json>
import { writeFileSync } from 'node:fs';
import { chapters } from '../src/chapters/index';
import { routeNetlist, wireOverlaps } from '../src/view/route';
import { drawnNetlist, wireCrossings } from '../src/view/wirefirst';
import { netlistOf } from '../src/sim/types';
import type { ComponentDef } from '../src/sim/types';

const seen = new Map<ComponentDef, Record<string, number | string>>();
const rows: unknown[] = [];
for (const ch of chapters) {
  let nets = 0, before = 0, after = 0, tnB = 0, tnA = 0;
  for (const step of ch.steps) {
    if (!step.scene) continue;
    let def: ComponentDef;
    try {
      const sc = step.scene();
      def = sc.root;
      for (const seg of sc.path ?? []) { const next = netlistOf(def)?.instances.find((i) => i.name === seg)?.def; if (!next) break; def = next; }
    } catch { continue; }
    const nl = netlistOf(def);
    if (!nl) continue;
    let m = seen.get(def);
    if (!m) {
      const a = routeNetlist(def, nl).nets;
      const t0 = Date.now();
      const dn = drawnNetlist(def, nl);
      const ms = Date.now() - t0;
      const b = routeNetlist(def, dn).nets;
      m = { id: def.id, ch: ch.id, nets: nl.nets.length, before: a.reduce((t, n) => t + n.tags.length, 0), after: b.reduce((t, n) => t + n.tags.length, 0), tnB: a.filter((n) => n.tags.length).length, tnA: b.filter((n) => n.tags.length).length, xB: wireCrossings(a), xA: wireCrossings(b), ovl: wireOverlaps(b).length, ms };
      seen.set(def, m);
    }
    nets += m.nets as number; before += m.before as number; after += m.after as number; tnB += m.tnB as number; tnA += m.tnA as number;
  }
  if (nets) rows.push({ ch: ch.id, nets, tnB, tnA, before, after });
}
writeFileSync(process.argv[2], JSON.stringify({ rows, levels: [...seen.values()] }));
