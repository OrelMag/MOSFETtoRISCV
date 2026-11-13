// The optical fibre on the studio renderer, in true section (DOM-free). Everything it says is fibre3dparts.ts's, i.e. the
// chapter's phys/fibre.ts: the rays are rayPath / rayPathGraded's points, the cone is naOf's, the packets lag by lagFactor.
// Here they become things: the cladding and core as glass (the core a faint tint: doped silica looks the same as the
// cladding), the acrylate coating a matte translucent polymer stripped back at the input, the rays and the single-mode field
// as light. The model is cut in half along the ray plane (z = 0), so the rays lie on the cut face and the layers' thickness
// shows at its edge.
//
// Scale: 1 unit = 12.5 µm, across and along (fibre3dparts.ts).

import { lathe, merge, sphere, transform, tube, type Geo } from '../gl/kit/geo';
import { M, type Material } from '../gl/kit/materials';
import type { Beat, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import type { Mat4, Vec3 } from '../gl/math';
import { acceptanceDeg, n2Of, naOf } from '../phys/fibre';
import { FAN, FIBRES, MFD_UM, R_CLAD, R_COAT, UM, X0, X1, coreR, fanAngles, fibreAnchors, lagFactor, lagFactorGraded, packetX, pathY, profileOf, rayPath, rayPathGraded, type FibreState, type Profile, type RayPath } from './fibre3dparts';
import type { Fibre } from '../phys/fibre';

/** Where the coating starts: it is stripped back at the input end. */
export const COAT_X = X0 + 14;
/** The launch beam's length in air before the end face. */
const AIR = 8;

const mat = (o: Material): Material => M.make(o);
export const MATS = {
  clad: mat({ ...M.quartz, base: '--fb-glass', tint: '--fb-glass', transmit: 0.82, label: 'silica cladding (n₂)' }),
  core: mat({ ...M.quartz, base: '--fb-core', tint: '--fb-core', transmit: 0.7, label: 'germanium-doped silica core (n₁): it looks the same as the cladding, tinted here' }),
  coat: mat({ base: '--fb-coat', metal: 0, rough: 0.65, transmit: 0.42, tint: '--fb-coat', label: 'dual acrylate coating (higher index: it strips light that leaks)' }),
  ray: M.beam('--fb-ray', 1.7, 'this ray'),
  fan: M.beam('--fb-fan', 0.9, 'the fan of guided rays'),
  leak: M.beam('--fb-leak', 1.7, 'a leaking ray'),
  air: M.beam('--fb-air', 0.9, 'the launch beam in air'),
  cone: M.beam('--fb-air', 0.32, 'the acceptance cone: every launch inside it is guided'),
  field: (k: number) => M.beam('--fb-glow', k, 'the one mode’s field (Gaussian, 10.4 µm mode-field diameter)'),
  pulse: mat({ base: '--fb-pulse', metal: 0, rough: 0.4, emit: '--fb-pulse', glow: 1.4, bloom: 1.5, label: 'a packet of the pulse (one per ray)' }),
};

const tr = (p: Vec3, s: Vec3 = [1, 1, 1]): Mat4 => { const m = new Float32Array(16); m[0] = s[0]; m[5] = s[1]; m[10] = s[2]; m[15] = 1; m[12] = p[0]; m[13] = p[1]; m[14] = p[2]; return m; };
/** A lathe (profile [r, y], about y) laid along x from x0: y → x. */
const alongX = (g: Geo, x0: number): Geo => { const m = new Float32Array(16); m[1] = -1; m[4] = 1; m[10] = 1; m[15] = 1; m[12] = x0; return transform(g, m); };
/** A solid round rod along x. */
const rodX = (x0: number, x1: number, r: number, seg = 48): Geo => alongX(lathe([[0, 0], [r, 0], [r, x1 - x0], [0, x1 - x0]], { seg }), x0);
/** A round shell along x, inner radius ri (a sleeve over the fibre). */
const sleeveX = (x0: number, x1: number, ri: number, ro: number, seg = 48): Geo =>
  alongX(lathe([[ri, 0], [ro, 0], [ro, x1 - x0], [ri, x1 - x0], [ri, 0]], { seg }), x0);

interface Statics { clad: Geo; core: Record<string, Geo>; coat: Geo; packet: Geo }
const memo = new Map<string, Statics>();
function statics(detail: 'full' | 'flat'): Statics {
  const hit = memo.get(detail);
  if (hit) return hit;
  const seg = detail === 'flat' ? 20 : 48;
  const s: Statics = {
    clad: rodX(X0, X1, R_CLAD, seg),
    core: Object.fromEntries((['multi', 'single'] as const).map((k) => [k, rodX(X0 - 0.01, X1 + 0.01, Math.max(coreR(FIBRES[k]), 0.2), seg)])),
    coat: sleeveX(COAT_X, X1, R_CLAD, R_COAT, seg),
    packet: sphere(1, detail === 'flat' ? 8 : 14, detail === 'flat' ? 5 : 8),
  };
  memo.set(detail, s);
  return s;
}

/** A ray's points as a path in the ray plane (z = 0). Graded rays are resampled finer, so the tube follows the sinusoid. */
const pathOf = (r: RayPath): Vec3[] => r.pts.map(([x, y]) => [x, y, 0] as Vec3);
const rayFor = (p: Profile, deg: number, f: Fibre): RayPath => (p === 'graded' ? rayPathGraded(deg, f, X0, X1, 0.8) : rayPath(deg, f));
const lagFor = (p: Profile, deg: number, f: Fibre): number => (p === 'graded' ? lagFactorGraded(deg, f) : lagFactor(rayPath(deg, f).stretch));

/** Where each packet of the pulse is now (one per ray of the fan; one on the axis for the single-mode fibre), none before a send. */
export function packetsAt(st: FibreState): Vec3[] {
  if (st.tau < 0) return [];
  const f = FIBRES[st.kind], prof = profileOf(st);
  if (st.kind === 'single') return rayPath(st.deg, f).guided ? [[packetX(st.tau, 1), 0, 0]] : [];
  return fanAngles(f, FAN).map((d) => { const p = rayFor(prof, d, f), x = packetX(st.tau, lagFor(prof, d, f)); return [x, pathY(p.pts, x), 0.15] as Vec3; });
}

/** The flat drawing skips additive light, so there the rays become solid lit lines (the cone and the field's outer glows go). */
const solid = (m: Material): Material => M.make({ base: m.emit!, metal: 0, rough: 1, emit: m.emit, glow: 1, label: m.label });

export function fibreModel(st: FibreState, detail: 'full' | 'flat' = 'full'): Model3 {
  const flat = detail === 'flat', L = (m: Material) => (flat ? solid(m) : m);
  const S = statics(detail), f = FIBRES[st.kind], single = st.kind === 'single', prof = profileOf(st), items: Item[] = [];
  const NOTE_UNIT = '1 unit = 12.5 µm, across and along';
  items.push({ geo: S.core[st.kind], mat: MATS.core, name: 'core', group: 'glass', order: 2, info: { dim: `${f.aUm * 2} µm`, note: single ? 'single-mode: so thin that one mode fits' : prof === 'graded' ? 'graded index: highest on the axis, falling as r² to the cladding’s at the edge' : 'step index: one value across the core' } });
  items.push({ geo: S.clad, mat: MATS.clad, name: 'cladding', group: 'glass', order: 1, info: { dim: '125 µm', source: 'ITU-T G.651.1 / G.652', note: NOTE_UNIT } });
  items.push({ geo: S.coat, mat: MATS.coat, name: 'coating', group: 'coat', order: 3, info: { dim: 'nominal 250 µm (data sheets 242–245)', source: 'Corning SMF-28 Ultra data sheet', note: 'stripped back at the input end' } });

  // the launch: the beam in air at the chosen angle, meeting the end face on the axis, and the acceptance cone round it
  const a = (st.deg * Math.PI) / 180;
  items.push({ geo: tube([[X0 - AIR, -Math.tan(a) * AIR, 0], [X0, 0, 0]], 0.2, { sides: 10 }), mat: L(MATS.air), name: 'launch beam', group: 'light', cut: 'none', shadow: false });
  if (st.cone !== false && !flat) {
    const acc = (acceptanceDeg(naOf(f.n1, n2Of(f))) * Math.PI) / 180, R = Math.tan(acc) * AIR;
    // a cone with its apex on the end face, opening into the air (y → −x)
    const g = lathe([[0, 0], [R, AIR], [0, AIR]], { seg: 40 }), m = new Float32Array(16);
    m[1] = 1; m[4] = -1; m[10] = 1; m[15] = 1; m[12] = X0;
    items.push({ geo: transform(g, m), mat: MATS.cone, name: 'acceptance cone', group: 'light', cut: 'none', shadow: false });
  }
  const main = rayFor(prof, st.deg, f);
  if (single && main.guided) {
    // one mode: a Gaussian field (1/e² radius w = MFD / 2), nested glows at 1.5 w, w and 0.5 w
    const w = MFD_UM / 2 / UM;
    for (const [k, g] of (flat ? [[0.5, 0.6]] : [[1.5, 0.18], [1, 0.32], [0.5, 0.6]]) as [number, number][]) items.push({ geo: rodX(X0, X1, w * k, 24), mat: L(MATS.field(g)), name: 'mode field', group: 'light', cut: 'none', shadow: false });
  } else {
    items.push({ geo: tube(pathOf(main), 0.2, { sides: 10 }), mat: L(main.guided ? MATS.ray : MATS.leak), name: main.guided ? 'this ray' : 'this ray, leaking', group: 'light', cut: 'none', shadow: false,
      info: { note: main.guided ? (prof === 'graded' ? 'bends back smoothly in the falling index' : `reflects totally: ${(90 - main.coreDeg).toFixed(1)}° to the wall’s normal`) : 'refracts into the cladding and is stripped by the coating' } });
  }
  if (!single) items.push({ geo: merge(fanAngles(f, FAN).map((d) => tube(pathOf(rayFor(prof, d, f)), 0.1, { sides: 6 })), 'fan'), mat: L(MATS.fan), name: 'guided rays', group: 'light', cut: 'none', shadow: false });
  const ps = packetsAt(st);
  if (ps.length) {
    const sz: Vec3 = single ? [1.6, 0.35, 0.35] : [0.8, 0.45, 0.45];
    items.push({ geo: merge(ps.map((p) => transform(S.packet, tr(p, sz))), 'packets'), mat: MATS.pulse, name: 'pulse', group: 'pulse', cut: 'none', shadow: false });
  }

  const anchors: StudioAnchor[] = [
    ...fibreAnchors(st).map((x) => ({ ...x, on: x.text.startsWith('coating') ? 'coat' : x.text.startsWith('cladding') || x.text.startsWith('core') ? 'glass' : undefined })),
  ];
  const view = (yaw: number, pitch: number, target: Vec3, dist: number) => ({ yaw, pitch, target, dist });
  const beats: Beat[] = [
    { title: 'Glass in glass', text: 'A glass core inside a glass cladding of slightly lower index, in a polymer coating. Cut in half along the light’s path: 1 mm of fibre, at true scale across and along.', view: view(0.2, 0.42, [0, 0, 0], 120), frame: ['glass', 'coat'] },
    { title: single ? 'One mode' : prof === 'graded' ? 'Bent back by the index' : 'Total internal reflection', text: single ? 'The 8 µm core is so thin that light fits in it one way only: one mode, drawn as its field, part of it running in the cladding. No rays, one speed.' : prof === 'graded' ? 'The core’s index falls from the axis outward, so a ray bends back before it reaches the cladding, along a sinusoid. Steeper rays go further out where the index, and so the delay, is lower: they nearly keep pace.' : 'A ray meets the core wall beyond the critical angle and reflects totally. Steeper rays bounce more often and travel further, so they arrive later.', view: view(-0.55, 0.32, [X0 + 14, 0, 0], single ? 26 : 44), show: ['glass', 'light'] },
    { title: 'The acceptance cone', text: 'Every launch inside this cone in air is guided; a steeper one meets the wall under the critical angle, refracts into the cladding and is stripped by the coating. Try a launch angle beyond the cone.', view: view(-1.05, 0.25, [X0 - 2, 0, 0], single ? 20 : 34), show: ['glass', 'light'] },
    { title: 'A pulse spreads', text: 'Send a pulse: one packet per ray. In a step core the steep rays fall behind and the pulse smears; in a graded core they keep together. The plot is for 1 km.', view: view(0.15, 0.55, [0, 0, 0], 118), show: ['glass', 'light', 'pulse'] },
  ];
  return {
    items, anchors, beats, flatOrder: 'items',
    cuts: { planes: [{ n: [0, 0, 1], d: 0 }], open: [R_COAT + 1] },
    look: { exposure: 1 },
  };
}

export const FIBRE_HOME = { yaw: 0.2, pitch: 0.42, target: [0, 0, 0] as Vec3, dist: 120 };
export const FIBRE_HOME_FRAME = ['glass', 'coat'];
/** The stretch is long and thin: a wide canvas. */
export const FIBRE_ASPECT = 2;
/** Close on the input end face, where the core is: a 50 µm core fills a little of the 250 µm coating, an 8 µm one needs the closer view. */
export const lookIn = (single: boolean) => ({ target: [X0 + 4, 0, 0] as Vec3, yaw: -0.9, pitch: 0.3, dist: single ? 11 : 30 });
