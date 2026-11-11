// The route cache's rules version (src/view/routecache.ts ROUTE_RULES): a hash of the sources a level's drawing and
// routing come from. vite.config.ts defines it for the page and scripts/lens-routes.ts writes it into the cache, so a
// cache made by another build of the router is never used: no version to remember to bump.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** What decides a level's wires: the router, wires-first, symbol geometry, the netlist types, the drawing key. */
export const ROUTE_SOURCES = ['src/view/route.ts', 'src/view/wirefirst.ts', 'src/sim/geometry.ts', 'src/sim/types.ts', 'src/view/layout.ts', 'src/view/routecache.ts'];

export function routeRules(root: string): string {
  const h = createHash('sha1');
  // line endings normalized: a Windows checkout and CI's Linux one hash alike
  for (const f of ROUTE_SOURCES) h.update(readFileSync(join(root, f), 'utf8').replace(/\r\n/g, '\n'));
  return h.digest('hex').slice(0, 12);
}
