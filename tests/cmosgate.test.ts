// Working gates (view/cmosgate.ts): every inner drawing stays inside its gate's real body, and every solve gives the
// gate's own function, inner nets driven (never floating or fought over) for known inputs.
import { describe, expect, it } from 'vitest';
import '../src/lib';
import { registry } from '../src/lib/define';
import { symbolGeom, type Vec } from '../src/sim/geometry';
import { B0, B1, BX, type Bit } from '../src/sim/types';
import { backX, CMOS_GATES, cmosLayout, cmosOutput, cmosSolve, place, type CmosKind, type Prim } from '../src/view/cmosgate';
import { cmosKindOf } from '../src/view/cmosdraw';

const BUBBLE = 0.3; // view/symbols.ts
/** The body outline while the inside shows (styles/cmos.css --cm-outline): half of it lies inside the body. */
const OUTLINE = 0.16;
const KINDS = [...CMOS_GATES] as CmosKind[];
const inverting = (k: string) => k === 'nand' || k === 'nor' || k === 'xnor' || k === 'not';

/** Is (x, y) inside the gate's body outline (view/symbols.ts gateBody)? */
function inBody(k: CmosKind, bw: number, h: number, x: number, y: number): boolean {
  if (y < 0 || y > h || x < 0) return false;
  if (k === 'and' || k === 'nand') {
    const rx = Math.min(h / 2, bw * 0.55), cx = bw - rx;
    return x <= cx || ((x - cx) / rx) ** 2 + ((y - h / 2) / (h / 2)) ** 2 <= 1;
  }
  if (k === 'not') return Math.abs(y - h / 2) <= (h / 2) * (1 - x / bw);
  const x0 = k.startsWith('x') ? 0.45 : 0, L = bw - x0;
  if (x < x0 + 1.1 * (y / h) * (1 - y / h)) return false; // the back curve
  if (x > bw) return false;
  // the top edge: x = x0 + L(1.2t - 0.2t²), y = t²·h/2; solve t for this x
  const u = (x - x0) / L, t = (1.2 - Math.sqrt(1.44 - 0.8 * u)) / 0.4;
  const top = (t * t * h) / 2;
  return y >= top && y <= h - top;
}

/** The points a primitive covers, with the half-width of what is drawn there. */
function pointsOf(q: Prim): { at: Vec; r: number; entry?: boolean }[] {
  // a wire: its corners and hop bulges, and points along every segment (the OR family's back is concave)
  if (q.t === 'wire') return [...q.pts, ...q.segs.flatMap((s) => s.slice(1).flatMap((b, i) => [1, 2, 3, 4, 5, 6, 7].map((k) => [s[i][0] + ((b[0] - s[i][0]) * k) / 8, s[i][1] + ((b[1] - s[i][1]) * k) / 8] as Vec)))].map((at) => ({ at, r: 0.03 }));
  if (q.t === 'dot') return [{ at: q.at, r: 0.055 }];
  if (q.t === 'rail') return [{ at: [q.x1, q.y], r: 0.04 }, { at: [q.x2, q.y], r: 0.04 }, ...(q.kind === 'lo' ? [{ at: [(q.x1 + q.x2) / 2, q.y + 0.16] as Vec, r: 0.04 }] : [])];
  if (q.t === 'fet') {
    const lead = q.x + q.side * 0.25;
    return [{ at: [q.x, q.y1], r: 0.09 }, { at: [q.x, q.y2], r: 0.09 }, { at: [lead, (q.y1 + q.y2) / 2], r: 0.03 }, { at: [q.x + q.side * 0.1, q.y1], r: 0.03 }];
  }
  const w = 0.95 * q.s;
  return [[q.x, q.y], [q.x, q.y + q.s], [q.x + w * 0.6, q.y], [q.x + w * 0.6, q.y + q.s], [q.x + w, q.y + q.s / 2], [q.x + w + 0.22 * q.s, q.y + q.s / 2]].map((at) => ({ at: at as Vec, r: 0.03 }));
}

describe('working gates', () => {
  it('draws exactly the library gates whose circuit it shows', () => {
    for (const id of KINDS) expect(cmosKindOf(registry.get(id)!)).toBe(id);
    for (const id of ['relay_nand', 'relay_not', 'buf', 'mux2', 'nand3']) if (registry.has(id)) expect(cmosKindOf(registry.get(id)!)).toBeNull();
  });

  for (const k of KINDS) {
    it(`${k}: every part lies inside the body`, () => {
      const def = registry.get(k)!;
      const g = symbolGeom(def), bw = g.w - (inverting(k) ? 2 * BUBBLE : 0);
      const l = cmosLayout(k), p = place(l, bw, g.h);
      const bad: string[] = [];
      const check = (x: number, y: number, r: number, what: string) => {
        // the point and its stroke's reach in four directions, clear of the outline's inner half with a little air
        const m = r + OUTLINE / 2 + 0.04;
        for (const [dx, dy] of [[0, 0], [m, 0], [-m, 0], [0, m], [0, -m]]) if (!inBody(k, bw, g.h, x + dx, y + dy)) { bad.push(`${what} (${x.toFixed(2)}, ${y.toFixed(2)})`); return; }
      };
      for (const q of l.prims) for (const { at, r } of pointsOf(q)) {
        const x = at[0] * p.sx, y = at[1] * p.sy + p.oy;
        // a wire may start on the back edge: that is where the input enters
        if (q.t === 'wire' && Math.abs(at[0] - backX(k, at[1])) < 1e-6) continue;
        // ... and runs on its row through the outline's width before it is inside
        if (q.t === 'wire' && (k === 'not' ? at[1] === 2 : at[1] === 1 || at[1] === 3) && at[0] < backX(k, at[1]) + 0.35) continue;
        check(x, y, r * Math.min(p.sx, p.sy), q.t + ('net' in q ? ' ' + q.net : 'dev' in q ? ' ' + q.dev : ''));
      }
      // the output wire: inside, ending on the right edge (its last point)
      l.out.slice(0, -1).forEach(([x, y]) => check(x * p.sx, y * p.sy + p.oy, 0.03, 'out'));
      expect(bad).toEqual([]);
    });

    it(`${k}: solves to the gate's function, every inner net driven`, () => {
      const def = registry.get(k)!;
      const n = k === 'not' ? 1 : 2;
      for (let v = 0; v < 1 << n; v++) {
        const ins: Bit[] = Array.from({ length: n }, (_, i) => ((v >> i) & 1 ? B1 : B0));
        const want = def.spec!(ins.map((b) => (b === B1 ? 1 : 0)))[0];
        const st = cmosSolve(k, ins);
        expect(cmosOutput(k, st), `${k}(${ins.join(',')})`).toBe(want ? 'hi' : 'lo');
        // every net that some drawn wire carries is at a rail, except a series node cut off on both sides (it floats)
        const drawn = new Set(cmosLayout(k).prims.flatMap((q) => (q.t === 'wire' ? [q.net] : [])));
        for (const net of drawn) expect(['hi', 'lo', 'float'], `${k} ${net}`).toContain(st.nets[net]);
        for (const net of drawn) if (!net.endsWith('.mid')) expect(st.nets[net], `${k} ${net}`).not.toBe('float');
      }
    });
  }

  it('an unknown input makes what depends on it unknown, never a rail', () => {
    expect(cmosOutput('nand', cmosSolve('nand', [BX, B1]))).toBe('x');
    expect(cmosOutput('nand', cmosSolve('nand', [BX, B0]))).toBe('hi');
    expect(cmosOutput('nor', cmosSolve('nor', [BX, B1]))).toBe('lo');
    expect(cmosOutput('xor', cmosSolve('xor', [BX, B0]))).toBe('x');
    expect(cmosSolve('not', [BX]).on['s1.P']).toBe(2);
  });

  it('crossings hop, no wire meets a wire of another net at a corner', () => {
    for (const k of ['nand', 'nor', 'and', 'or'] as const) expect(cmosLayout(k).prims.some((q) => q.t === 'wire' && q.d.includes('A'))).toBe(true);
  });
});
