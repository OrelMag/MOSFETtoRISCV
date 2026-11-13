// The triode close-up (Phase 14b, "A hot cathode"). This entry stays tiny: it shows a placeholder and loads the
// studio close-up (widgets/triode3dnext.ts: true geometry, the same physics and panel) and, inside it, the studio
// renderer (gl/studio.ts) as their own chunks, so a chapter that lists the step does not grow the main bundle.

import type { Widget } from '../view/stage';
import { whenAsked } from './modelshot';

export function triodeCloseup(): Widget {
  const el = document.createElement('div');
  el.className = 'widget tube3d';
  // Roughly the loaded height, so the page does not jump when it arrives (the stylesheet comes with the chunk).
  el.style.minHeight = '520px';
  el.textContent = 'Loading the triode…';
  let inner: Widget | null = null, dead = false;
  whenAsked(el, 'the triode', () => import('./triode3dnext')
    .then((m) => {
      if (dead) return;
      inner = m.triodeNextView();
      el.style.minHeight = '';
      el.replaceChildren(inner.el);
    })
    .catch((e: unknown) => { if (!dead) el.textContent = `The triode close-up did not load (${String(e)}).`; }));
  return {
    el,
    update: () => inner?.update?.(),
    destroy: () => { dead = true; inner?.destroy?.(); },
  };
}
