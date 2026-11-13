// Orbit controls on a canvas. Drag to orbit; right-, middle- or shift-drag to pan; wheel (once engaged, below) or pinch to
// zoom toward the pointer (two fingers also pan); while focused, arrows orbit, shift + arrows pan, + / − zoom, Home resets, Esc lets go;
// double-click resets. Every change calls onChange (the renderer then draws one frame).
// The wheel and one-finger vertical swipes belong to the page until the canvas is engaged (focused: a click, a tap, Tab),
// so scrolling past a model never zooms it (kit/wheel.ts); Ctrl / ⌘ + wheel, a trackpad pinch and full screen always
// zoom. A wheel turn left to the page fires 'orbit:wheelpass' on the canvas (the studio stage shows its hint once).

import type { OrbitCamera } from './camera';
import { touchActionOf, wheelZooms } from './kit/wheel';

const ROT = 0.008; // radians per CSS pixel dragged
const KEY_ROT = 0.08;
const KEY_PAN = 40; // CSS pixels per shift + arrow

export function attachOrbit(canvas: HTMLCanvasElement, cam: OrbitCamera, onChange: () => void): () => void {
  const pts = new Map<number, [number, number]>();
  /** What a one-pointer drag does: orbit, or pan (right / middle button, or shift held at the press). */
  let mode: 'orbit' | 'pan' = 'orbit';
  // Two pointers: their spread and midpoint at the last move (pinch zooms about the midpoint, which pans as it moves).
  let pinch = 0, mid: [number, number] = [0, 0];
  const two = () => {
    const [a, b] = [...pts.values()];
    return { d: Math.hypot(a[0] - b[0], a[1] - b[1]), m: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as [number, number] };
  };
  // the Fullscreen API's or modelframe.ts's overlay (no API, an iPhone): .m3-full on the root either way
  const fullscreen = () => { const f = document.fullscreenElement; return (!!f && f.contains(canvas)) || !!canvas.closest('.m3-full'); };
  const focused = () => document.activeElement === canvas;
  const touch = () => { canvas.style.touchAction = touchActionOf(focused(), fullscreen()); };
  touch();
  const size = () => ({ w: Math.max(1, canvas.clientWidth), h: Math.max(1, canvas.clientHeight), r: canvas.getBoundingClientRect() });

  const down = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button > 2) return;
    if (e.button === 1) e.preventDefault(); // no autoscroll
    if (!focused()) canvas.focus({ preventScroll: true }); // engaged: the wheel zooms from now on
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    canvas.setPointerCapture(e.pointerId);
    if (pts.size === 1) mode = e.button === 1 || e.button === 2 || e.shiftKey ? 'pan' : 'orbit';
    if (pts.size === 2) ({ d: pinch, m: mid } = two());
    canvas.classList.add('dragging');
    canvas.classList.toggle('panning', mode === 'pan' && pts.size === 1);
  };
  const move = (e: PointerEvent) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p[0], dy = e.clientY - p[1];
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    const { w, h, r } = size();
    if (pts.size === 1) {
      if (mode === 'pan') cam.pan(dx, dy, h);
      else cam.orbit(-dx * ROT, dy * ROT);
    } else if (pts.size === 2) {
      const t = two();
      if (pinch > 0 && t.d > 0) cam.zoomAt(pinch / t.d, t.m[0] - r.left, t.m[1] - r.top, w, h);
      cam.pan(t.m[0] - mid[0], t.m[1] - mid[1], h);
      pinch = t.d; mid = t.m;
    }
    onChange();
  };
  const up = (e: PointerEvent) => {
    pts.delete(e.pointerId);
    if (pts.size === 2) ({ d: pinch, m: mid } = two()); else pinch = 0;
    // a finger left of a pinch orbits from where it is, without a jump
    if (pts.size === 1) mode = 'orbit';
    if (!pts.size) canvas.classList.remove('dragging', 'panning');
  };
  const wheel = (e: WheelEvent) => {
    if (!wheelZooms({ focused: focused(), ctrl: e.ctrlKey, meta: e.metaKey, fullscreen: fullscreen() })) {
      canvas.dispatchEvent(new CustomEvent('orbit:wheelpass', { bubbles: true }));
      return; // the page scrolls
    }
    e.preventDefault();
    // Pixel, line and page deltas to roughly the same feel; a trackpad pinch arrives as ctrl + wheel.
    const d = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
    const { w, h, r } = size();
    cam.zoomAt(Math.exp(d * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top, w, h);
    onChange();
  };
  const key = (e: KeyboardEvent) => {
    const k = e.key, h = size().h;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === 'Escape' && !fullscreen()) { canvas.blur(); return; } // let go: the wheel scrolls the page again
    if (e.shiftKey && k.startsWith('Arrow')) {
      const [dx, dy] = k === 'ArrowLeft' ? [KEY_PAN, 0] : k === 'ArrowRight' ? [-KEY_PAN, 0] : k === 'ArrowUp' ? [0, KEY_PAN] : [0, -KEY_PAN];
      cam.pan(dx, dy, h);
    } else if (k === 'ArrowLeft') cam.orbit(KEY_ROT, 0);
    else if (k === 'ArrowRight') cam.orbit(-KEY_ROT, 0);
    else if (k === 'ArrowUp') cam.orbit(0, KEY_ROT);
    else if (k === 'ArrowDown') cam.orbit(0, -KEY_ROT);
    else if (k === '+' || k === '=') cam.zoom(0.9);
    else if (k === '-' || k === '_') cam.zoom(1 / 0.9);
    else if (k === 'Home') cam.reset();
    else return;
    e.preventDefault();
    onChange();
  };
  const dbl = () => { cam.reset(); onChange(); };
  const menu = (e: Event) => e.preventDefault(); // right-drag pans

  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', wheel, { passive: false });
  canvas.addEventListener('keydown', key);
  canvas.addEventListener('dblclick', dbl);
  canvas.addEventListener('contextmenu', menu);
  canvas.addEventListener('focus', touch);
  canvas.addEventListener('blur', touch);
  document.addEventListener('fullscreenchange', touch);
  return () => {
    canvas.removeEventListener('focus', touch);
    canvas.removeEventListener('blur', touch);
    document.removeEventListener('fullscreenchange', touch);
    canvas.removeEventListener('pointerdown', down);
    canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerup', up);
    canvas.removeEventListener('pointercancel', up);
    canvas.removeEventListener('wheel', wheel);
    canvas.removeEventListener('keydown', key);
    canvas.removeEventListener('dblclick', dbl);
    canvas.removeEventListener('contextmenu', menu);
  };
}
