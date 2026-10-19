// A double tap on a touch screen, told apart from two single taps: what opens a part on the stage, in the
// sandbox and in its look-inside view, where a mouse double-clicks. Chrome turns a double tap into a dblclick;
// iOS Safari may not, so the views also count touch pointerups themselves, and drop the browser's dblclick
// for the taps they already acted on. The logic is DOM-free (tests/doubletap.test.ts).

/** Two taps at most this far apart in time (ms)… */
export const DOUBLE_TAP_MS = 300;
/** …and in space (px, client coordinates) are a double tap. */
export const DOUBLE_TAP_PX = 24;
/** A dblclick this soon (ms) after a double tap was acted on is the browser's own for the same taps. */
export const DOUBLE_TAP_DEDUPE_MS = 600;

/** When a double tap was last acted on, by any view: the browser's dblclick for it may land on another one (the
 *  sandbox's look-inside overlay, drawn over the part the taps opened). */
let fired = -Infinity;

export class DoubleTap {
  private last: { t: number; x: number; y: number; key: unknown } | null = null;

  /**
   * A pointer was released at time `t` (ms), at (x, y), over `key` (what was tapped: a part's name, a hit…),
   * without dragging. True when it completes a double tap: the second touch tap on the same key, soon enough and
   * close enough to the first. A mouse or pen release (`touch` false) breaks a pending pair: they double-click.
   */
  up(t: number, x: number, y: number, key: unknown, touch: boolean): boolean {
    const l = this.last;
    if (!touch) {
      this.last = null;
      return false;
    }
    if (l && l.key === key && t - l.t <= DOUBLE_TAP_MS && t >= l.t && Math.hypot(x - l.x, y - l.y) <= DOUBLE_TAP_PX) {
      this.last = null; // a third tap starts a new pair
      fired = t;
      return true;
    }
    this.last = { t, x, y, key };
    return false;
  }

  /** A drag or a pinch came between: the next tap starts afresh. */
  reset(): void {
    this.last = null;
  }

  /** A dblclick arrived at time `t`: act on it? False when it is the browser's for a double tap already handled. */
  dblclick(t: number): boolean {
    return !(t >= fired && t - fired <= DOUBLE_TAP_DEDUPE_MS);
  }

  /** A pointerup event, as up() takes it (its time, place and pointer type). A second finger (not the primary
   *  pointer: a pinch) breaks a pair like a mouse does. */
  upEvent(e: PointerEvent, key: unknown): boolean {
    return this.up(e.timeStamp, e.clientX, e.clientY, key, e.pointerType === 'touch' && e.isPrimary);
  }
}
