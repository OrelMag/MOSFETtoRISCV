// The tools every 3D model's stage carries (studiostage.ts, and the views that drive the renderer themselves: relay,
// triode, the machine hall, the water kit): full screen, save image, turn by itself. A cluster of icon buttons in the
// stage's bottom-right corner.
// Full screen takes the model's whole panel (its controls and readouts come along: model3d.css lays the stage out to
// fill the screen beside or above them) through the Fullscreen API, or where that is missing (iPhone Safari) the same
// class as a fixed overlay with the page's scroll locked and Esc handled here. The renderer re-reads the canvas size and
// device pixel ratio every frame and the labels measure their frame live, so nothing is resized by hand.

import '../styles/model3d.css';
import type { Renderer } from '../gl/renderer';
import { h, icon } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import { saveFile } from '../view/image';
import { WHEEL_HINT } from '../gl/kit/wheel';

export interface ModelFrameOptions {
  /** The stage (`.r3-stage`): the tools go in its corner. */
  stage: HTMLElement;
  /** What the model is (file name and button labels). */
  name: string;
  /** The renderer once it is up (null while loading or in the flat view: no image, no turning). */
  renderer: () => Renderer | null;
  /** The HTML labels over the canvas, drawn into a saved image. */
  labels?: HTMLElement;
  /** What full screen takes (default: the stage's panel, else its widget, else the stage). */
  root?: () => HTMLElement;
}

export interface ModelFrame {
  el: HTMLElement;
  /** The flat view is showing (or the 3D one again): only full screen stays. */
  setFlat(on: boolean): void;
  /** Leave full screen and stop turning. */
  destroy(): void;
}

/** How to zoom, the one wording (gl/orbit.ts, gl/kit/wheel.ts: the wheel is the page's until the model is clicked). */
export const ZOOM_HOW = 'click the model, then scroll to zoom (or Ctrl + scroll, or pinch)';
/** The gestures, under every model (the keys are in the ? sheet: ui/keys.ts, group model). */
export const ORBIT_HINT = `Drag to orbit, right-drag or shift-drag to pan (two fingers on a touch screen); ${ZOOM_HOW}; double-click to reset. The corner buttons turn it, save an image and go full screen.`;
/** The same for a screen reader, keys included (the canvas's aria-label after the model's name). */
export const ORBIT_ARIA = 'drag to orbit, right-drag or shift-drag to pan; once focused, scroll to zoom (Ctrl + scroll at any time); arrow keys turn, shift and arrows pan, plus and minus zoom, Home resets, Escape lets the page scroll again';

const SPIN = 0.35; // radians per second while turning by itself
/** The wheel hint shows once a page load, over whichever model was scrolled past first. */
let wheelHinted = false;

/** The element full screen takes: the model's panel inside its widget (never a panel of the page around it), else the
 *  widget (the machine hall's controls sit in it), else the stage. */
const rootOf = (stage: HTMLElement): HTMLElement => {
  const widget = stage.closest<HTMLElement>('.m3d, .relay3d, .hall3d'), panel = stage.closest<HTMLElement>('.panel');
  return panel && widget?.contains(panel) ? panel : widget ?? stage;
};

/** A saved image's name: the model's name up to its first colon, comma or bracket (an aria text runs on), as a slug. */
export const fileName = (name: string): string =>
  `${name.split(/[:,(;]| in 3D/)[0].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48).replace(/-$/, '') || 'model'}.png`;

const fsApi = () => typeof document.documentElement.requestFullscreen === 'function' && document.fullscreenEnabled !== false;

export function modelFrame(o: ModelFrameOptions): ModelFrame {
  const btn = (ic: string, label: string) => {
    const b = h('button', { type: 'button', class: 'r3-tool', 'aria-label': label, title: label }, icon(ic, 16)) as HTMLButtonElement;
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    return b;
  };
  const full = btn('expand', 'Full screen');
  const shot = btn('image', 'Save image (PNG, with its labels)');
  const spin = btn('spin', 'Turn by itself');
  full.setAttribute('aria-pressed', 'false');
  spin.setAttribute('aria-pressed', 'false');
  const el = h('div', { class: 'r3-tools' }, spin, shot, full);
  o.stage.append(el);
  // the wheel over a canvas nobody clicked scrolls the page (gl/orbit.ts fires orbit:wheelpass): say once how to zoom
  const whint = h('div', { class: 'r3-whint', 'aria-hidden': 'true' }, WHEEL_HINT);
  o.stage.append(whint);
  o.stage.addEventListener('orbit:wheelpass', () => {
    if (wheelHinted) return;
    wheelHinted = true;
    whint.classList.add('on');
    setTimeout(() => whint.classList.remove('on'), 3200);
  });

  // ---- full screen ----
  let root: HTMLElement | null = null, overlay = false;
  const showFull = (on: boolean) => {
    full.replaceChildren(icon(on ? 'shrink' : 'expand', 16));
    const label = on ? 'Leave full screen (Esc)' : 'Full screen';
    full.setAttribute('aria-label', label); full.title = label;
    full.setAttribute('aria-pressed', String(on));
  };
  const onEsc = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault(); e.stopPropagation(); // not also the page's Esc (up a level, close a menu)
    leave();
  };
  // The overlay is fixed over the viewport, but an ancestor with a z-index (the chapter's widget host) caps it below the
  // top bar: raised while it is open, then given back.
  let raised: [HTMLElement, string][] = [];
  const unraise = () => { for (const [e, z] of raised) e.style.zIndex = z; raised = []; };
  const settle = () => {
    if (!root) return;
    root.classList.remove('m3-full');
    document.documentElement.classList.remove('m3-lock');
    document.removeEventListener('keydown', onEsc, true);
    unraise();
    root = null; overlay = false;
    showFull(false);
    full.focus({ preventScroll: true });
    full.scrollIntoView({ block: 'nearest' });
  };
  const asOverlay = () => {
    overlay = true;
    document.documentElement.classList.add('m3-lock');
    document.addEventListener('keydown', onEsc, true);
    for (let e = root?.parentElement ?? null; e && e !== document.body; e = e.parentElement) {
      if (getComputedStyle(e).zIndex !== 'auto') { raised.push([e, e.style.zIndex]); e.style.zIndex = '2147483000'; }
    }
  };
  const enter = () => {
    root = o.root?.() ?? rootOf(o.stage);
    root.classList.add('m3-full');
    showFull(true);
    if (fsApi()) root.requestFullscreen({ navigationUI: 'hide' }).catch(() => { if (root) asOverlay(); });
    else asOverlay();
    o.renderer()?.invalidate();
  };
  const leave = () => {
    if (!root) return;
    if (!overlay && document.fullscreenElement === root) void document.exitFullscreen().catch(settle);
    else settle();
  };
  const onFsChange = () => { if (root && !overlay && document.fullscreenElement !== root) settle(); };
  document.addEventListener('fullscreenchange', onFsChange);
  full.addEventListener('click', () => (root ? leave() : enter()));

  // ---- save image: the frame as drawn, then the labels on it ----
  shot.addEventListener('click', () => {
    const r = o.renderer();
    if (!r) return;
    const c = r.canvas, out = document.createElement('canvas');
    out.width = c.width; out.height = c.height;
    const g = out.getContext('2d');
    if (!g) return;
    g.fillStyle = getComputedStyle(o.stage).backgroundColor || '#fff';
    g.fillRect(0, 0, out.width, out.height);
    r.render(); // the drawing buffer is only valid in the task that drew it
    g.drawImage(c, 0, 0);
    const cr = c.getBoundingClientRect(), k = c.width / Math.max(1, cr.width);
    for (const lb of o.labels?.querySelectorAll<HTMLElement>('.r3-lbl') ?? []) {
      const b = lb.querySelector('b'), dot = lb.querySelector('i');
      if (!b || !dot) continue;
      const cs = getComputedStyle(lb), bs = getComputedStyle(b);
      if (cs.display === 'none' || cs.visibility === 'hidden' || bs.visibility === 'hidden') continue;
      g.globalAlpha = +cs.opacity || 1;
      const d = dot.getBoundingClientRect();
      g.fillStyle = getComputedStyle(dot).backgroundColor;
      g.beginPath(); g.arc((d.left + d.width / 2 - cr.left) * k, (d.top + d.height / 2 - cr.top) * k, (d.width / 2) * k, 0, 2 * Math.PI); g.fill();
      const t = b.getBoundingClientRect();
      g.fillStyle = bs.backgroundColor;
      g.fillRect((t.left - cr.left) * k, (t.top - cr.top) * k, t.width * k, t.height * k);
      g.fillStyle = bs.color;
      g.font = `${bs.fontWeight} ${parseFloat(bs.fontSize) * k}px ${bs.fontFamily}`;
      g.textBaseline = 'middle';
      const lines = (b.textContent ?? '').split('\n'), lh = t.height / lines.length;
      lines.forEach((s, i) => {
        const w = g.measureText(s).width / k;
        g.fillText(s, (t.left + (t.width - w) / 2 - cr.left) * k, (t.top + lh * (i + 0.5) - cr.top) * k);
      });
    }
    g.globalAlpha = 1;
    out.toBlob((blob) => { if (blob) saveFile(fileName(o.name), blob); }, 'image/png');
  });

  // ---- turn by itself: a slow orbit until any input on the canvas, off under reduced motion ----
  let raf = 0, t0 = 0;
  const stop = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    spin.setAttribute('aria-pressed', 'false');
  };
  const tick = (t: number) => {
    const r = o.renderer();
    if (!r || reducedMotion()) { stop(); return; }
    r.camera.orbit(-SPIN * Math.min(0.1, (t - t0) / 1000), 0);
    t0 = t;
    r.invalidate();
    raf = requestAnimationFrame(tick);
  };
  spin.addEventListener('click', () => {
    if (raf) { stop(); return; }
    if (!o.renderer() || reducedMotion()) return;
    spin.setAttribute('aria-pressed', 'true');
    t0 = performance.now();
    raf = requestAnimationFrame(tick);
  });
  // any press, wheel or key in the stage stops it, except on these buttons (Enter on Turn would stop it, then start it)
  const touched = (e: Event) => { if (raf && !(e.target instanceof Node && el.contains(e.target))) stop(); };
  for (const ev of ['pointerdown', 'wheel', 'keydown']) o.stage.addEventListener(ev, touched, { passive: true });
  const motion = () => { spin.hidden = reducedMotion(); };
  motion();

  const setFlat = (on: boolean) => {
    shot.hidden = on;
    spin.hidden = on || reducedMotion();
    if (on) stop();
  };
  return {
    el, setFlat,
    destroy() {
      stop();
      document.removeEventListener('fullscreenchange', onFsChange);
      if (root) {
        if (!overlay && document.fullscreenElement === root) void document.exitFullscreen().catch(() => {});
        root.classList.remove('m3-full');
        document.documentElement.classList.remove('m3-lock');
        document.removeEventListener('keydown', onEsc, true);
        unraise();
        root = null;
      }
    },
  };
}
