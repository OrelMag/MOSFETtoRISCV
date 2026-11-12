// The triode close-up (Phase 14b, "A hot cathode"). This entry stays tiny: it shows a placeholder and loads the
// close-up and, inside it, the WebGL renderer as their own chunks, so a chapter that lists the step does not grow the
// main bundle. PROTOTYPE (proto/3d-rock): a Before / After switch between today's close-up (widgets/triode3dview.ts on
// gl/renderer.ts) and the studio one (widgets/triode3dnext.ts on gl/studio.ts); After is the default.

import type { Widget } from '../view/stage';

export function triodeCloseup(): Widget {
  const el = document.createElement('div');
  el.className = 'widget tube3d';
  el.style.minHeight = '520px';
  const head = document.createElement('div');
  head.className = 't3n-head';
  const title = document.createElement('b');
  title.textContent = 'Prototype: the 3D renderer, before and after';
  const ab = document.createElement('div');
  ab.className = 't3n-ab';
  ab.setAttribute('role', 'group');
  ab.setAttribute('aria-label', 'Renderer');
  const btn = (label: string) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn sm'; b.textContent = label; ab.append(b); return b; };
  const before = btn('Before'), after = btn('After');
  head.append(title, ab);
  const body = document.createElement('div');
  body.textContent = 'Loading the triode…';
  el.append(head, body);
  let inner: Widget | null = null, dead = false, gen = 0;
  const show = (which: 'before' | 'after') => {
    const g = ++gen;
    before.setAttribute('aria-pressed', String(which === 'before'));
    after.setAttribute('aria-pressed', String(which === 'after'));
    inner?.destroy?.(); inner = null;
    body.textContent = 'Loading the triode…';
    (which === 'before' ? import('./triode3dview').then((m) => m.triodeView()) : import('./triode3dnext').then((m) => m.triodeNextView()))
      .then((w) => {
        if (dead || g !== gen) { w.destroy?.(); return; }
        inner = w;
        el.style.minHeight = '';
        body.replaceChildren(w.el);
      })
      .catch((e: unknown) => { if (!dead) body.textContent = `The triode close-up did not load (${String(e)}).`; });
  };
  before.addEventListener('click', () => show('before'));
  after.addEventListener('click', () => show('after'));
  show(/before3d/.test(location.hash + location.search) ? 'before' : 'after');
  return {
    el,
    update: () => inner?.update?.(),
    destroy: () => { dead = true; inner?.destroy?.(); },
  };
}
