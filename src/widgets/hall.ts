// The machine hall (Phase 14c, chapter 25: "The same CPU in relays and tubes"). This entry stays tiny: it shows a
// placeholder and loads the hall (widgets/hallview.ts: layout, simulation, drawing) and, inside it, the WebGL
// renderer as their own chunks, so the chapter does not grow the main bundle.

import type { Widget } from '../view/stage';

export function machineHall(): Widget {
  const el = document.createElement('div');
  el.className = 'widget hall3d';
  // Roughly the loaded height, so the page does not jump when it arrives (the stylesheet comes with the chunk).
  el.style.minHeight = '560px';
  el.textContent = 'Loading the machine hall…';
  let inner: Widget | null = null, dead = false;
  import('./hallview')
    .then((m) => {
      if (dead) return;
      inner = m.hallView();
      el.style.minHeight = '';
      el.replaceChildren(inner.el);
    })
    .catch((e: unknown) => { if (!dead) el.textContent = `The machine hall did not load (${String(e)}).`; });
  return {
    el,
    update: () => inner?.update?.(),
    destroy: () => { dead = true; inner?.destroy?.(); },
  };
}
