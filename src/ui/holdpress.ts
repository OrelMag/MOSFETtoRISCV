// Press and hold on a touch screen: what a right-click is on a desktop. Browsers send no `contextmenu` for a held
// finger reliably (iOS never does, Chrome only on some builds), so the canvases make the gesture themselves from
// pointer events. The timing and cancelling rules are DOM-free (HoldPress, tests/holdpress.test.ts); installHold
// wires them to an element: touch pointers only, a mouse or pen keeps its right button.

/** Held this long (ms) without moving: a press-and-hold. */
export const HOLD_MS = 500;
/** A finger that strays further than this (px, client coordinates) is dragging, not holding. */
export const HOLD_SLOP = 8;
/** The click or contextmenu the browser sends after a hold that fired is dropped for this long (ms). */
export const HOLD_QUIET_MS = 700;

export interface Timers { set(f: () => void, ms: number): unknown; clear(t: unknown): void }
const realTimers: Timers = { set: (f, ms) => setTimeout(f, ms), clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) };

/**
 * One hold at a time. `start` arms it for a pointer; it fires `onFire(x, y)` after HOLD_MS unless `move` strays past
 * the slop, a second pointer arrives (a pinch or a pan), the pointer lifts (`end`), or `cancel` is called. A second
 * pointer also ends a hold that already fired for the first.
 */
export class HoldPress {
  private id: number | null = null;
  private timer: unknown = null;
  private x = 0;
  private y = 0;
  /** The hold fired and its pointer is still down. */
  fired = false;

  constructor(private onFire: (x: number, y: number) => void, private timers: Timers = realTimers, private ms = HOLD_MS, private slop = HOLD_SLOP) {}

  get active(): boolean {
    return this.id !== null;
  }

  start(id: number, x: number, y: number): void {
    if (this.id !== null && this.id !== id) return this.cancel(); // a second finger: pinch or pan, not a hold
    this.cancel();
    this.id = id;
    this.x = x;
    this.y = y;
    this.timer = this.timers.set(() => {
      this.timer = null;
      this.fired = true;
      this.onFire(this.x, this.y);
    }, this.ms);
  }

  /** The pointer moved; true while it is still a hold candidate. */
  move(id: number, x: number, y: number): boolean {
    if (id !== this.id || this.fired) return this.id === id;
    if (Math.hypot(x - this.x, y - this.y) > this.slop) {
      this.cancel();
      return false;
    }
    return true;
  }

  /** The pointer lifted (or the browser took it over). Returns whether the hold had fired. */
  end(id: number): boolean {
    if (id !== this.id) return false;
    const f = this.fired;
    this.cancel();
    return f;
  }

  cancel(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    this.id = null;
    this.fired = false;
  }
}

export interface HoldOptions {
  /** Whether a press here may become a hold at all (checked at the press and again when it fires). */
  accept?(e: PointerEvent): boolean;
  /** The hold fired at a client point: true when it did something (the click after it is dropped, a ring and a buzz mark it). */
  onHold(x: number, y: number, e: PointerEvent): boolean | void;
}

/**
 * Press-and-hold on an element, for touch pointers. A faint ring grows under the finger after a moment so the hold is
 * seen coming; the click the browser sends when the finger lifts is dropped, and so is a `contextmenu` it sends for the
 * same hold (Android), so the menu opens once (a view with its own contextmenu listener, registered before this, asks
 * `quiet()` first). `off` removes it.
 */
export function installHold(el: Element, o: HoldOptions): { off(): void; quiet(): boolean; cancel(): void } {
  let down: PointerEvent | null = null;
  let ring: HTMLElement | null = null;
  let ringTimer: ReturnType<typeof setTimeout> | null = null;
  let quietUntil = 0;
  const unring = () => {
    if (ringTimer) clearTimeout(ringTimer);
    ringTimer = null;
    ring?.remove();
    ring = null;
  };
  const hold = new HoldPress((x, y) => {
    unring();
    if (!down || (o.accept && !o.accept(down))) return;
    if (o.onHold(x, y, down) === false) return;
    quietUntil = performance.now() + HOLD_QUIET_MS;
    // a buzz only once the page has had a tap (Chrome blocks it, and logs, before that)
    try { if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(12); } catch { /* no haptics: the menu is the feedback */ }
  });
  const onDown = (e: Event) => {
    const p = e as PointerEvent;
    if (p.pointerType !== 'touch' || (p.button !== 0 && p.button !== -1)) return hold.cancel();
    if (hold.active) { hold.cancel(); unring(); return; } // a second finger: pinch or pan, not a hold
    if (o.accept && !o.accept(p)) return;
    down = p;
    hold.start(p.pointerId, p.clientX, p.clientY);
    unring();
    ringTimer = setTimeout(() => {
      ring = document.createElement('div');
      ring.className = 'hold-ring';
      ring.style.left = `${p.clientX}px`;
      ring.style.top = `${p.clientY}px`;
      document.body.append(ring);
    }, 120);
  };
  const onMove = (e: Event) => {
    const p = e as PointerEvent;
    if (!hold.move(p.pointerId, p.clientX, p.clientY)) unring();
  };
  const onEnd = (e: Event) => {
    hold.end((e as PointerEvent).pointerId);
    unring();
  };
  const onClick = (e: Event) => {
    if (performance.now() >= quietUntil) return;
    e.preventDefault();
    e.stopPropagation();
  };
  const onContext = (e: Event) => {
    if (performance.now() < quietUntil) e.preventDefault();
  };
  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onEnd);
  el.addEventListener('pointercancel', onEnd);
  el.addEventListener('click', onClick, true);
  el.addEventListener('contextmenu', onContext, true);
  const off = () => {
    hold.cancel();
    unring();
    for (const [k, f, c] of [['pointerdown', onDown], ['pointermove', onMove], ['pointerup', onEnd], ['pointercancel', onEnd], ['click', onClick, true], ['contextmenu', onContext, true]] as const) el.removeEventListener(k, f, c);
  };
  // a pinch (view/pinch.ts) swallows its fingers' moves and lifts before this sees them: it calls this, or the hold would fire
  return { off, quiet: () => performance.now() < quietUntil, cancel: () => { hold.cancel(); unring(); } };
}
