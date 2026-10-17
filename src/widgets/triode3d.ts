// The triode close-up (Phase 14b, "A hot cathode"). This entry stays tiny: it shows a placeholder and loads the
// close-up (widgets/triode3dview.ts: the model, plots and drawing) and, inside it, the WebGL renderer as their own
// chunks, so a chapter that lists the step does not grow the main bundle.

import type { Widget } from '../view/stage';

export function triodeCloseup(): Widget {
  const el = document.createElement('div');
  el.className = 'widget tube3d';
  // Roughly the loaded height, so the page does not jump when it arrives (the stylesheet comes with the chunk).
  el.style.minHeight = '520px';
  el.textContent = 'Loading the triode…';
  let inner: Widget | null = null, dead = false;
  import('./triode3dview')
    .then((m) => {
      if (dead) return;
      inner = m.triodeView();
      el.style.minHeight = '';
      el.replaceChildren(inner.el);
    })
    .catch((e: unknown) => { if (!dead) el.textContent = `The triode close-up did not load (${String(e)}).`; });
  return {
    el,
    update: () => inner?.update?.(),
    destroy: () => { dead = true; inner?.destroy?.(); },
  };
}
