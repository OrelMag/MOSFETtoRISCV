// The gate and drain voltages two views of the same NMOS share (DOM-free): the 2D cross-section (mosfet.ts) and the 3D model
// under it (mosfet3dview.ts) each publish their own change and follow the other's, so the 3D shows the extra dimension (W, L,
// the taper along the length) for the operating point the learner already chose above.

export interface BiasLink {
  readonly vg: number;
  readonly vd: number;
  /** Publish a new bias from `from` (its own listener is not called); a no-op when nothing changed. */
  set(vg: number, vd: number, from?: object): void;
  /** Follow the other side's changes; returns the unsubscribe. */
  follow(who: object, cb: (vg: number, vd: number) => void): () => void;
}

export function biasLink(vg = 0, vd = 0.9): BiasLink {
  let g = vg, d = vd;
  const subs = new Map<object, (vg: number, vd: number) => void>();
  return {
    get vg() { return g; },
    get vd() { return d; },
    set(ng, nd, from) {
      if (ng === g && nd === d) return;
      g = ng; d = nd;
      for (const [who, cb] of subs) if (who !== from) cb(g, d);
    },
    follow(who, cb) { subs.set(who, cb); return () => { subs.delete(who); }; },
  };
}
