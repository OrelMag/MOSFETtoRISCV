// What a chapter imports to show a 3D model: stays tiny, so a chapter that lists one does not grow by the model. The
// model (its view, the renderer) loads as its own chunks; withModel puts it under the step's existing widget.

import type { Widget } from '../view/stage';

/** A placeholder of about the loaded height until `load` answers. */
export function lazyModel(what: string, load: () => Promise<Widget>): Widget {
  const el = document.createElement('div');
  el.className = 'widget relay3d m3d';
  el.style.minHeight = '520px';
  el.textContent = `Loading ${what}…`;
  let inner: Widget | null = null, dead = false;
  load()
    .then((w) => {
      if (dead) { w.destroy?.(); return; }
      inner = w;
      el.style.minHeight = '';
      el.replaceChildren(w.el);
    })
    .catch((e: unknown) => { if (!dead) el.textContent = `${what[0].toUpperCase()}${what.slice(1)} did not load (${String(e)}).`; });
  return {
    el,
    update: () => inner?.update?.(),
    destroy: () => { dead = true; inner?.destroy?.(); },
  };
}

/** A step's widget with a model below it. */
export function withModel(base: Widget, model: Widget): Widget {
  const el = document.createElement('div');
  el.className = 'm3d-stack';
  el.append(base.el, model.el);
  return {
    el,
    update: () => { base.update?.(); model.update?.(); },
    destroy: () => { base.destroy?.(); model.destroy?.(); },
  };
}

/** Chapter 1: the transistor with its width showing. */
export const mosfet3d = (): Widget => lazyModel('the 3D transistor', () => import('./mosfet3dview').then((m) => m.mosfetView()));
