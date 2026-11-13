// Four pixels of an image sensor, cut open, on the studio renderer (DOM-free, tested): sensorstack3dgeom.ts's stack and
// traced rays in true shapes. The back row whole, the front row drawn to its middle so its cut face shows every layer in
// its own solid colour: microlens (a spherical cap), filter, oxide with the metal in it (FSI) or the grid between the
// filters (BSI), the anti-reflection film, the silicon with the photodiode under its pinning layer, the deep trenches, the
// metal and the logic wafer below a BSI pixel. The rays lie on the cut face, in their wavelength's colour, ending where
// they are absorbed (warn colour: in the wrong pixel, or on metal).
//
// Units: K drawing units a µm (sensorstack3dgeom.ts).

import { merge, roundedBox, sphere, surface, tube, type Geo } from '../gl/kit/geo';
import { M, type Material } from '../gl/kit/materials';
import type { Beat, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import type { OrbitView } from '../gl/camera';
import type { Vec3 } from '../gl/math';
import {
  BAYER, K, PPLUS, diodeSpan, fmtUm, lensHeight, spotSize, stackHeight, wavelengthRgb,
  type Cfa, type Layer, type StackSpec, type TraceResult,
} from './sensorstack3dgeom';

type Detail = 'full' | 'flat';
export interface StackPose { spec: StackSpec; nm: number; angle: number; row: 0 | 1; trace: TraceResult }

// ---------------------------------------------------------------- shapes

const boxes = new Map<string, Geo>();
/** A box between two corners (drawing units): a geometry memoized by size, and its centre. */
function bx(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): { geo: Geo; at: Vec3 } {
  const w = x1 - x0, h = y1 - y0, d = z1 - z0, key = `${w.toFixed(3)},${h.toFixed(3)},${d.toFixed(3)}`;
  let geo = boxes.get(key);
  if (!geo) { geo = roundedBox(w, h, d, Math.min(0.06, w / 4, h / 4, d / 4), 1); boxes.set(key, geo); }
  return { geo, at: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2] };
}
/** The microlens over one pixel: its cap surface over [xa, xb] × [za, zb] and, on the cut row, the cap's profile at zb. */
function lensGeo(s: StackSpec, rc: number, h: number, xa: number, za: number, zb: number, cut: boolean, d: Detail): Geo {
  const P = s.pitch, H = stackHeight(s), n = d === 'full' ? 28 : 10, cx = xa + P / 2, cz = cut ? zb : za + P / 2;
  const hh = (x: number, z: number) => Math.max(0, Math.sqrt(Math.max(0, rc * rc - (x - cx) ** 2 - (z - cz) ** 2)) - (rc - h));
  const top = surface((u, v) => { const x = xa + u * P, z = zb - v * (zb - za); return [x * K, (H + hh(x, z)) * K, z * K]; }, n, Math.max(4, Math.round((n * (zb - za)) / P)));
  if (!cut) return top;
  const face = surface((u, v) => { const x = xa + (1 - u) * P; return [x * K, (H + v * hh(x, zb)) * K, zb * K]; }, n, 2);
  return merge([top, face], 'microlens');
}

// ---------------------------------------------------------------- materials

const solid = (base: Material['base'], label: string, rough = 0.5, metal = 0): Material => M.make({ base, metal, rough, label });
const FILTER: Record<Cfa, Material> = {
  R: solid('--ss-r', 'red filter (dyed resist)', 0.45), G: solid('--ss-g', 'green filter (dyed resist)', 0.45), B: solid('--ss-b', 'blue filter (dyed resist)', 0.45),
};
const lensMat = M.make({ base: '--ss-lens', metal: 0, rough: 0.06, coat: 0.7, transmit: 0.55, tint: [0.92, 0.96, 1], label: 'microlens (polymer)' });
const oxideMat = solid([0.5, 0.58, 0.72], 'silicon dioxide (and the planarizing layers)', 0.45);
const beolMat = solid([0.44, 0.51, 0.64], 'oxide between the metal levels', 0.45);
const siMat = solid('--m3-si', 'silicon (p-type)', 0.35, 0.3);
const diodeMat = solid('--m3-n', 'photodiode (n region)', 0.4);
const pplusMat = solid('--ss-pplus', 'p+ pinning layer', 0.4);
const arcMat = solid('--ss-arc', 'anti-reflection film', 0.25);
const dtiMat = solid('--ss-dti', 'deep trench isolation (oxide)', 0.3);
const metalMat = M.make({ base: [0.95, 0.66, 0.5], metal: 0.55, rough: 0.35, label: 'copper interconnect' });
const gridMat = M.make({ base: [0.85, 0.86, 0.88], metal: 0.55, rough: 0.35, label: 'metal grid (tungsten or aluminium)' });
const warnMat = M.glow(solid('--ss-warn', 'lost: on metal, or in the wrong pixel', 0.4), '--ss-warn', 0.7);
const dimMat = solid('--ss-dim', 'a ray stopped before the silicon', 0.5);
const rayMat = (nm: number): Material => { const c = wavelengthRgb(nm); return M.glow(M.make({ base: c, metal: 0, rough: 0.4, label: `light, ${nm} nm` }), c, 0.7); };

// ---------------------------------------------------------------- the model

/** A drawing framed whole: from the lens' top to the bottom of what hangs below the silicon, wider for the wider pixel. */
export function stackView(s: StackSpec, rc: number): OrbitView {
  const top = stackHeight(s) + lensHeight(s, rc), bot = -s.si - (s.beolBelow > 0 ? s.beolBelow + 1.2 : 0.8);
  const span = Math.max(top - bot, 2.2 * s.pitch) * K;
  return { target: [0, ((top + bot) / 2) * K, -s.pitch * K * 0.3], yaw: 0.45, pitch: 0.24, dist: 1.7 * span };
}

const MARK = new Map<Detail, Geo>();
const markGeo = (d: Detail) => { let g = MARK.get(d); if (!g) { g = sphere(0.75, d === 'full' ? 16 : 6, d === 'full' ? 8 : 4); MARK.set(d, g); } return g; };

export function stackModel(q: StackPose, detail: Detail = 'full'): Model3 {
  const s = q.spec, P = s.pitch, H = stackHeight(s), { rc, h } = q.trace, items: Item[] = [];
  const add = (b: { geo: Geo; at: Vec3 }, mat: Material, name: string, group: string, info?: Item['info']) => items.push({ geo: b.geo, at: b.at, mat, name, group, cut: 'none', info });
  // the cut row in front (z 0 … P/2), the other behind (−P … 0)
  const rows: (0 | 1)[] = [q.row, (1 - q.row) as 0 | 1];
  for (const r of rows) {
    const cut = r === q.row, za = cut ? 0 : -P, zb = cut ? P / 2 : 0, Z0 = za * K, Z1 = zb * K;
    for (let px = 0; px < 2; px++) {
      const xa = (px - 1) * P, xb = px * P, X0 = xa * K, X1 = xb * K, cfa = BAYER[r][px];
      let y = H;
      for (const L of s.layers) {
        const kind: Layer['kind'] = L.kind;
        const mat = kind === 'cfa' ? FILTER[cfa] : kind === 'beol' ? beolMat : oxideMat, name = kind === 'cfa' ? 'colour filter' : kind === 'beol' ? 'oxide between the metal' : 'oxide';
        add(bx(X0, X1, (y - L.t) * K, y * K, Z0, Z1), mat, name, kind === 'cfa' ? 'filters' : 'stack', { dim: `${L.name}: ${fmtUm(L.t)}, n = ${L.n}` });
        y -= L.t;
      }
      items.push({ geo: lensGeo(s, rc, h, xa, za, zb, cut, detail), mat: lensMat, name: 'microlens', group: 'lenses', cut: 'none', info: { dim: `${fmtUm(h)} high on a ${fmtUm(P)} pixel`, note: 'a spherical cap whose focus the stack was designed for: it bends the light toward the photodiode' } });
      const [d0, d1] = diodeSpan(s), inset = (s.dti ? 0.08 : 0.12) * P, pTop = s.illum === 'fsi' ? 0 : d0;
      add(bx(X0, X1, -s.si * K, 0, Z0, Z1), siMat, 'silicon', 'silicon', { dim: `${fmtUm(s.si)} that collects`, note: s.illum === 'bsi' ? 'thinned: the light enters from this side, the back' : 'the light enters from the top, past the metal' });
      // on the cut face the diode and its pinning layer stand just proud of the silicon, so they show
      const zf = Z1 + (cut ? 0.08 : -0.01);
      add(bx((xa + inset) * K, (xb - inset) * K, d0 * K, d1 * K, Z0 + 0.01, zf), diodeMat, 'photodiode', 'silicon', { note: 'the n region the pixel collects its electrons in; charge made below it diffuses to it' });
      add(bx((xa + inset) * K, (xb - inset) * K, (pTop - PPLUS) * K, pTop * K, Z0 + 0.01, zf + 0.02), pplusMat, 'p+ pinning layer', 'silicon', { note: 'holds the surface at a fixed potential: less dark current from the interface' });
      if (s.arc) add(bx(X0, X1, 0, Math.max(s.arc.d, 0.04) * K, Z0, Z1), arcMat, 'anti-reflection film', 'stack', { dim: `${fmtUm(s.arc.d)}, n = ${s.arc.n}` });
      if (s.illum === 'fsi') add(bx(X0, X1, (-s.si - 0.8) * K, -s.si * K, Z0, Z1), siMat, 'silicon', 'silicon');
      if (s.beolBelow > 0) {
        const bot = -s.si;
        add(bx(X0, X1, (bot - s.beolBelow) * K, bot * K, Z0, Z1), beolMat, 'oxide between the metal', 'below');
        const cx = (xa + xb) / 2;
        for (const [y0, y1, w] of [[0.3, 0.5, 0.5], [1.0, 1.25, 0.6], [1.75, 2.05, 0.4]]) add(bx((cx - (w * P) / 2) * K, (cx + (w * P) / 2) * K, (bot - y1) * K, (bot - y0) * K, Z0, Z1), metalMat, 'metal, below the silicon', 'below');
        add(bx(X0, X1, (bot - s.beolBelow - 1.2) * K, (bot - s.beolBelow) * K, Z0, Z1), siMat, 'logic wafer', 'below', { note: 'the wafer the thinned sensor is bonded to: its readout and logic' });
      }
    }
    for (const m of s.metal) {
      const x0 = Math.max(-P, m.x0), x1 = Math.min(P, m.x1);
      if (x1 > x0) add(bx(x0 * K, x1 * K, m.y0 * K, m.y1 * K, Z0, Z1), s.illum === 'fsi' ? metalMat : gridMat, 'metal', 'metal', { note: s.illum === 'fsi' ? 'the interconnect: three levels between the light and the silicon' : 'the grid between the filters: it stops light crossing into the next pixel' });
    }
    if (s.dti) for (const x of [-P, 0, P]) add(bx(Math.max(-P, x - 0.05) * K, Math.min(P, x + 0.05) * K, -s.si * K, 0, Z0, Z1), dtiMat, 'deep trench isolation', 'silicon', { note: 'oxide walls the full depth of the silicon: light that strays toward the neighbour reflects back' });
  }
  // the rays on the cut face; a ray the filter takes is drawn down to the filter's middle
  const zc = (P / 2) * K + 0.4, ray = rayMat(q.nm);
  let cfaMid = H;
  for (const L of s.layers) { if (L.kind === 'cfa') { cfaMid -= L.t / 2; break; } cfaMid -= L.t; }
  const rayPaths: Vec3[][] = [], dimPaths: Vec3[][] = [];
  for (const r of q.trace.rays) {
    const stopped = r.fate === 'metal' || r.fate === 'filter', yStop = r.fate === 'filter' ? cfaMid : -Infinity;
    for (const path of r.paths) {
      const pts: Vec3[] = [];
      for (let k = 0; k < path.length; k++) {
        let p = path[k];
        if (k > 0 && p[1] < yStop) { const o = path[k - 1], f = (o[1] - yStop) / (o[1] - p[1]); p = [o[0] + f * (p[0] - o[0]), yStop]; pts.push([p[0] * K, p[1] * K, zc]); break; }
        pts.push([p[0] * K, p[1] * K, zc]);
      }
      const clean = pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 1e-6);
      if (clean.length > 1) (stopped ? dimPaths : rayPaths).push(clean);
    }
    if (r.fate !== 'filter') items.push({ geo: markGeo(detail), at: [r.end[0] * K, r.end[1] * K, zc], mat: r.fate === 'cross' || r.fate === 'metal' ? warnMat : ray, name: r.fate === 'own' ? 'absorbed in its own pixel' : r.fate === 'cross' ? 'absorbed in the wrong pixel' : r.fate === 'metal' ? 'stopped on metal' : r.fate === 'reflected' ? 'reflected' : 'through the silicon', group: 'rays', cut: 'none' });
  }
  const sides = detail === 'full' ? 6 : 3;
  if (rayPaths.length) items.push({ geo: merge(rayPaths.map((p) => tube(p, 0.18, { sides })), 'rays'), mat: ray, name: 'rays', group: 'rays', cut: 'none', shadow: false, info: { note: 'geometric rays in the cut\'s plane, refracted at every interface (Snell)' } });
  if (dimPaths.length) items.push({ geo: merge(dimPaths.map((p) => tube(p, 0.18, { sides })), 'rays'), mat: dimMat, name: 'rays stopped', group: 'rays', cut: 'none', shadow: false });
  // the absorption depth 1/α: a thin glowing line across the cut silicon
  const dY = -Math.min(q.trace.depth, s.si), c = wavelengthRgb(q.nm);
  add(bx(-P * K, P * K, dY * K - 0.15, dY * K + 0.15, (P / 2) * K + 0.05, (P / 2) * K + 0.25), M.glow(M.make({ base: c, metal: 0, rough: 0.4, label: 'absorption depth' }), c, 0.6), 'absorption depth', 'rays', { note: 'where a ray of this wavelength has lost 63 % of its power, on average' });
  // the diffraction-limited spot at the focus, under each lens
  const spot = Math.min(spotSize(s, rc, q.nm), P), fy = -s.focus;
  for (const cx of [-P / 2, P / 2]) add(bx((cx - spot / 2) * K, (cx + spot / 2) * K, fy * K - 0.25, fy * K + 0.25, zc + 0.3, zc + 0.6), warnMat, 'diffraction spot', 'rays', { note: '2.44 λ N: the light is never focused narrower than this, whatever the rays show' });
  return { items, anchors: anchors(q), beats: beats(q), floor: (-s.si - (s.beolBelow > 0 ? s.beolBelow + 1.2 : 0.8)) * K, flatOrder: 'items' };
}

const up: Vec3 = [0, 1, 0], front: Vec3 = [0, 0, 1];
function anchors(q: StackPose): StudioAnchor[] {
  const s = q.spec, P = s.pitch, H = stackHeight(s), zc = (P / 2) * K;
  const yOf = (kind: Layer['kind']) => { let y = H; for (const l of s.layers) { if (l.kind === kind) return y - l.t / 2; y -= l.t; } return 0; };
  const [d0, d1] = diodeSpan(s), a: StudioAnchor[] = [
    { text: 'microlens', p: [-P * 0.5 * K, (H + q.trace.h) * K, 0], side: 't', n: up },
    { text: 'colour filters', p: [-P * K, yOf('cfa') * K, zc], side: 'l', n: front, gutter: 'l' },
    { text: s.illum === 'fsi' ? 'metal, three levels' : 'metal grid', p: [P * K, (s.illum === 'fsi' ? 1.2 : yOf('cfa') - 0.2) * K, zc], side: 'r', n: front, gutter: 'r' },
    { text: 'photodiode', p: [-P * K, ((d0 + d1) / 2) * K, zc], side: 'l', n: front, gutter: 'l' },
    { text: 'p+ pinning layer', p: [-P * K, (s.illum === 'fsi' ? -PPLUS / 2 : -s.si + PPLUS / 2) * K, zc], side: 'l', n: front, minor: true, gutter: 'l' },
    { text: `1/α = ${fmtUm(q.trace.depth)}`, p: [P * K, -Math.min(q.trace.depth, s.si) * K, zc], side: 'r', n: front, minor: true, gutter: 'r' },
  ];
  if (s.dti) a.push({ text: 'deep trench', p: [0, -s.si * K, zc], side: 'b', n: front, minor: true });
  if (s.beolBelow > 0) a.push({ text: 'metal below the silicon', p: [P * K, (-s.si - s.beolBelow / 2) * K, zc], side: 'r', n: front, minor: true, gutter: 'r' });
  return a;
}

function beats(q: StackPose): Beat[] {
  const s = q.spec, home = stackView(s, q.trace.rc), P = s.pitch * K;
  return [
    { title: 'Four pixels, cut open', text: `A Bayer quad, ${fmtUm(s.pitch)} a pixel, cut through the middle of its front row: every layer shows on the cut face in its own colour. ${s.illum === 'fsi' ? 'Front-side illuminated: the light passes between three levels of metal before the silicon.' : 'Back-side illuminated: the wafer thinned and turned over, the light enters the back, the metal is below.'}`, view: home, frame: [], cut: 0, explode: 0 },
    { title: 'Lens and filter', text: 'Each microlens is a cap of polymer focusing its pixel\'s light down the stack; under it a dyed filter passes one colour and absorbs the rest, so a pixel counts only its colour.', view: { ...home, target: [0, (stackHeight(s) - 0.4) * K, 0], dist: home.dist * 0.6, pitch: 0.35 }, frame: ['lenses', 'filters'], cut: 0, explode: 0 },
    { title: 'Into the silicon', text: `The light is absorbed on its way down: blue in the first few hundred nanometres, red microns deep. At ${q.nm} nm the mean depth is ${fmtUm(q.trace.depth)}; the line across the cut marks it. Where a ray is absorbed, not where it entered, decides which pixel counts it.`, view: { ...home, target: [0, -s.si * K * 0.5, P * 0.3], dist: home.dist * 0.6, yaw: 0.15 }, frame: ['silicon', 'rays'], cut: 0, explode: 0 },
  ];
}
