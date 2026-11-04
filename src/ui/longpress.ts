// A long press on a touch screen, for the right-click menu: Android Chrome sends a contextmenu event for it, iOS
// Safari sends none, so the canvas times the press itself. DOM-free (tests/longpress.test.ts): the caller feeds
// pointer events and says what a firing does.

/** Held this long (ms) without moving, the press fires. Shorter than Android's own, so it comes first there too. */
export const LONG_PRESS_MS = 450;
/** Moving further than this (px, client coordinates) is a drag or a pan, not a press. */
export const LONG_PRESS_SLOP = 8;

export interface LongPressTimers {
  set(f: () => void, ms: number): unknown;
  clear(h: unknown): void;
}

const real: LongPressTimers = { set: (f, ms) => setTimeout(f, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

export class LongPress {
  private down = new Set<number>();
  private timer: unknown = null;
  private id = -1;
  private x = 0;
  private y = 0;
  /** When it last fired (ms on `now`), so the browser's own contextmenu for the same press can be dropped. */
  private firedAt = -Infinity;

  constructor(private fire: (x: number, y: number) => void, private timers: LongPressTimers = real, private now: () => number = () => Date.now()) {}

  /** A finger came down. A second one (while the first is still down) cancels, and so does any press after it until all lift. */
  press(id: number, x: number, y: number): void {
    this.down.add(id);
    if (this.down.size > 1) return this.cancel();
    this.cancel();
    this.id = id; this.x = x; this.y = y;
    this.timer = this.timers.set(() => {
      this.timer = null;
      this.firedAt = this.now();
      this.fire(this.x, this.y);
    }, LONG_PRESS_MS);
  }

  move(id: number, x: number, y: number): void {
    if (id === this.id && this.timer !== null && Math.hypot(x - this.x, y - this.y) > LONG_PRESS_SLOP) this.cancel();
  }

  /** A finger lifted (or the browser cancelled it). */
  release(id: number): void {
    this.down.delete(id);
    if (id === this.id) this.cancel();
  }

  /** Something else took the gesture (a drag began, a pinch, a mode change). */
  cancel(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }

  /** Is a contextmenu event just after a firing the browser's duplicate of it? */
  duplicate(window = 1000): boolean {
    return this.now() - this.firedAt < window;
  }
}
