// Orbit controls on a canvas: drag to orbit, wheel or pinch to zoom, arrows / + / − / Home while focused,
// double-click to reset. Every change calls onChange (the renderer then draws one frame).

import type { OrbitCamera } from './camera';

const ROT = 0.008; // radians per CSS pixel dragged
const KEY_ROT = 0.08;

export function attachOrbit(canvas: HTMLCanvasElement, cam: OrbitCamera, onChange: () => void): () => void {
  const pts = new Map<number, [number, number]>();
  let pinch = 0;
  const spread = () => { const [a, b] = [...pts.values()]; return Math.hypot(a[0] - b[0], a[1] - b[1]); };

  const down = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    canvas.setPointerCapture(e.pointerId);
    if (pts.size === 2) pinch = spread();
    canvas.classList.add('dragging');
  };
  const move = (e: PointerEvent) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    if (pts.size === 1) cam.orbit(-(e.clientX - p[0]) * ROT, (e.clientY - p[1]) * ROT);
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size === 2) { const d = spread(); if (pinch > 0 && d > 0) cam.zoom(pinch / d); pinch = d; }
    onChange();
  };
  const up = (e: PointerEvent) => {
    pts.delete(e.pointerId);
    pinch = pts.size === 2 ? spread() : 0;
    if (!pts.size) canvas.classList.remove('dragging');
  };
  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    // Pixel, line and page deltas to roughly the same feel; a trackpad pinch arrives as ctrl + wheel.
    const d = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
    cam.zoom(Math.exp(d * (e.ctrlKey ? 0.01 : 0.0015)));
    onChange();
  };
  const key = (e: KeyboardEvent) => {
    const k = e.key;
    if (k === 'ArrowLeft') cam.orbit(KEY_ROT, 0);
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

  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', wheel, { passive: false });
  canvas.addEventListener('keydown', key);
  canvas.addEventListener('dblclick', dbl);
  return () => {
    canvas.removeEventListener('pointerdown', down);
    canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerup', up);
    canvas.removeEventListener('pointercancel', up);
    canvas.removeEventListener('wheel', wheel);
    canvas.removeEventListener('keydown', key);
    canvas.removeEventListener('dblclick', dbl);
  };
}
