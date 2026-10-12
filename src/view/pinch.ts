// Two-finger pinch on a touch screen: zoom by the change in finger distance around their
// midpoint, and pan by the midpoint's movement. Listens in the capture phase and swallows
// the pointer events of a pinch (until every finger of it has lifted), so the element's own
// one-finger handlers (pan, tap, the sandbox's tools) never see the second finger.

export interface PinchHooks {
  /** A second finger came down: abandon whatever the first one started. */
  start(): void;
  /** `k` > 1 when the fingers spread; midpoints in client coordinates. */
  move(k: number, mid: [number, number], prev: [number, number]): void;
}

export function installPinch(el: Element, hooks: PinchHooks): void {
  const pts = new Map<number, [number, number]>();
  /** Pointers of the current or last pinch, swallowed until they lift. */
  const owned = new Set<number>();
  let pinching = false;
  const geom = () => {
    const [a, b] = [...pts.values()];
    return { d: Math.hypot(a[0] - b[0], a[1] - b[1]), mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as [number, number] };
  };
  const swallow = (e: Event) => { e.stopImmediatePropagation(); e.preventDefault(); };
  const opt = { capture: true };

  el.addEventListener('pointerdown', (ev) => {
    const e = ev as PointerEvent;
    if (e.pointerType !== 'touch') return;
    if (pts.size >= 2) { owned.add(e.pointerId); return swallow(e); } // a third finger
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size === 2) {
      pinching = true;
      for (const id of pts.keys()) owned.add(id);
      hooks.start();
      swallow(e);
    }
  }, opt);

  el.addEventListener('pointermove', (ev) => {
    const e = ev as PointerEvent;
    if (pts.has(e.pointerId)) {
      const before = pinching ? geom() : null;
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      const after = before && geom();
      if (before && after && before.d > 0 && after.d > 0) hooks.move(after.d / before.d, after.mid, before.mid);
    }
    if (owned.has(e.pointerId)) swallow(e);
  }, opt);

  // A finger left over from a pinch stays owned (it does not start a one-finger pan or a
  // band); a new second finger resumes the pinch.
  const end = (ev: Event) => {
    const e = ev as PointerEvent;
    pts.delete(e.pointerId);
    pinching = pts.size === 2;
    if (owned.delete(e.pointerId)) swallow(e);
  };
  el.addEventListener('pointerup', end, opt);
  el.addEventListener('pointercancel', end, opt);
}
