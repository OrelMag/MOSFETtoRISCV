// Build every Rtl design the book shows: the library, then every scene of the Communication chapters (generators run on demand).
import '../src/lib';
import { chapters } from '../src/chapters';
import { RTL_TOPS } from '../src/lib/rtl';
import type { ComponentDef } from '../src/sim/types';

export function rtlDesigns(): ComponentDef[] {
  for (const c of chapters) {
    if (c.level !== 'Communication') continue;
    for (const s of c.steps) {
      try { const sc = typeof s.scene === 'function' ? (s.scene as () => unknown)() : s.scene; void sc; } catch { /* a scene that needs the DOM: its design is built by then or by another step */ }
    }
  }
  return [...RTL_TOPS];
}
