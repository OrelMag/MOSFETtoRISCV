// Planar, fin and nanosheet transistors for the studio renderer (DOM-free, tested), in nanometres, to scale where the sources
// give the size (phys/gatecontrol.ts DEVICES: Intel 22 nm fins, IBM 2 nm sheets) and said to be drawn where they do not.
// Source to drain runs along z; the model opens with a cut across the middle of the gate, so the section shows what the
// device is about: how many sides of the channel the gate holds. On, the channel's section glows with the inversion layer;
// off, it glows as much as it still leaks (the off current from the swing, against the planar device's), and a bulk fin's
// sub-fin, below the gate's reach, leaks with it.

import { extrude, merge, roundedBox, transform, type Geo } from '../gl/kit/geo';
import { M, type Material } from '../gl/kit/materials';
import type { Beat, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import type { OrbitView } from '../gl/camera';
import type { Mat4 } from '../gl/math';
import { DEVICES, offRatio, SIDES, swing, weff, type GateKind } from '../phys/gatecontrol';

/** Half the gate length, the far end of source and drain, the substrate's and the trench's depth (nm). */
export const ZG = DEVICES.sheets.L / 2, ZS = 36, Y_SUB = -40, Y_STI = -20;
export const FIN_X = [-30, 30], OX = 1;

const mk = (m: Material): Material => M.make(m);
export const MATS = {
  si: mk({ ...M.silicon, label: 'silicon (p-type body)' }),
  nplus: mk({ base: '--ff-n', metal: 0.3, rough: 0.35, label: 'n+ silicon: source and drain' }),
  sti: mk({ base: '--ff-sti', metal: 0, rough: 0.25, coat: 0.4, label: 'trench oxide (STI)' }),
  hik: mk({ base: '--ff-hik', metal: 0, rough: 0.2, coat: 0.5, label: 'gate dielectric (high-k; about 1 nm equivalent oxide, drawn 1 nm)' }),
  gate: mk({ base: [0.78, 0.66, 0.42], metal: 0.9, rough: 0.3, label: 'metal gate (work-function metal and fill; illustrative)' }),
  bdi: mk({ base: '--ff-sti', metal: 0, rough: 0.25, label: 'bottom dielectric isolation (IBM 2 nm)' }),
};
/** The channel, on (the inversion layer) or off (glowing as much as it still leaks: 0 … 1). */
export const channelMat = (on: boolean, leak: number): Material => mk({
  ...M.silicon, emit: on ? '--ff-on' : '--ff-leak', glow: on ? 0.9 : 0.9 * leak, bloom: 1.2,
  label: on ? 'channel, on: the inversion layer the gate holds' : 'channel, off: what still leaks below threshold',
});

const tr = (x: number, y: number, z: number): Mat4 => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; m[12] = x; m[13] = y; m[14] = z; return m; };
const bx = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, r = 0): Geo =>
  transform(roundedBox(x1 - x0, y1 - y0, z1 - z0, r, r > 0 ? 2 : 0), tr((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2));
/** An outline in the xy plane pushed along z from z0 to z1. */
const slabZ = (outline: [number, number][], z0: number, z1: number): Geo => {
  const m = new Float32Array(16); m.set([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, z0, 1]);
  return transform(extrude(outline.map(([x, y]) => [x, -y] as [number, number]), z1 - z0), m);
};
/** Source / drain on both sides of the gate, from ZG to ZS. */
const sd = (x0: number, x1: number, y0: number, y1: number): Geo[] => [bx(x0, x1, y0, y1, -ZS, -ZG), bx(x0, x1, y0, y1, ZG, ZS)];

/** How much the device leaks, off, against the planar one: 1 planar … ~0 a good wrap (on a log scale over 3 decades). */
export const leakGlow = (k: GateKind): number => Math.max(0, Math.min(1, 1 + Math.log10(offRatio(DEVICES[k], DEVICES.planar)) / 3));

interface Parts { body: Geo[]; nplus: Geo[]; channel: Geo[]; sub: Geo[]; sti: Geo[]; hik: Geo[]; gate: Geo[]; bdi: Geo[] }
export function partsOf(k: GateKind): Parts {
  const p: Parts = { body: [bx(-60, 60, Y_SUB, Y_STI, -ZS, ZS)], nplus: [], channel: [], sub: [], sti: [], hik: [], gate: [], bdi: [] };
  if (k === 'planar') {
    const w = DEVICES.planar.W / 2, d = DEVICES.planar.H;
    p.sti.push(bx(-60, -w, Y_STI, 0, -ZS, ZS), bx(w, 60, Y_STI, 0, -ZS, ZS));
    p.body.push(bx(-w, w, Y_STI, -d, -ZS, ZS));
    p.nplus.push(...sd(-w, w, -d, 0));
    p.channel.push(bx(-w, w, -d, 0, -ZG, ZG));
    p.hik.push(bx(-w, w, 0, OX, -ZG, ZG));
    p.gate.push(bx(-w - 8, w + 8, OX, 26, -ZG, ZG));
  } else if (k === 'fin') {
    const { W, H } = DEVICES.fin, h = W / 2;
    // the trench oxide between the fins; each fin rises from the substrate through it
    p.sti.push(bx(-60, FIN_X[0] - h, Y_STI, 0, -ZS, ZS), bx(FIN_X[0] + h, FIN_X[1] - h, Y_STI, 0, -ZS, ZS), bx(FIN_X[1] + h, 60, Y_STI, 0, -ZS, ZS));
    const outline: [number, number][] = [[-60, 0]];
    for (const c of FIN_X) {
      p.sub.push(bx(c - h, c + h, Y_STI, 0, -ZS, ZS));
      p.channel.push(bx(c - h, c + h, 0, H, -ZG, ZG, 1.5));
      p.nplus.push(...sd(c - h, c + h, 0, H).map((g) => g));
      p.hik.push(bx(c - h - OX, c - h, 0, H, -ZG, ZG), bx(c + h, c + h + OX, 0, H, -ZG, ZG), bx(c - h - OX, c + h + OX, H, H + OX, -ZG, ZG));
      outline.push([c - h - OX, 0], [c - h - OX, H + OX], [c + h + OX, H + OX], [c + h + OX, 0]);
    }
    outline.push([60, 0], [60, H + 18], [-60, H + 18]);
    p.gate.push(slabZ(outline, -ZG, ZG));
  } else {
    const { W, H, gap = 5, n = 3 } = DEVICES.sheets, h = W / 2, y0 = 10, ys = Array.from({ length: n }, (_, i) => y0 + i * (H + gap));
    const top = ys[n - 1] + H;
    p.sti.push(bx(-60, -h, Y_STI, 0, -ZS, ZS), bx(h, 60, Y_STI, 0, -ZS, ZS));
    p.body.push(bx(-h, h, Y_STI, 0, -ZS, ZS));
    p.bdi.push(bx(-h, h, 0, 2, -ZS, ZS));
    // source and drain: epitaxial n+ joining the sheets' ends
    p.nplus.push(...sd(-h, h, 2, top + 2));
    for (const y of ys) {
      p.channel.push(bx(-h, h, y, y + H, -ZG, ZG));
      p.hik.push(bx(-h - OX, h + OX, y - OX, y, -ZG, ZG), bx(-h - OX, h + OX, y + H, y + H + OX, -ZG, ZG), bx(-h - OX, -h, y, y + H, -ZG, ZG), bx(h, h + OX, y, y + H, -ZG, ZG));
    }
    // the gate fills every gap: two columns and the slabs between the sheets
    const gx = h + OX;
    p.gate.push(bx(-h - 20, -gx, 2, top + 16, -ZG, ZG), bx(gx, h + 20, 2, top + 16, -ZG, ZG), bx(-gx, gx, 2, ys[0] - OX, -ZG, ZG));
    for (let i = 0; i + 1 < n; i++) p.gate.push(bx(-gx, gx, ys[i] + H + OX, ys[i + 1] - OX, -ZG, ZG));
    p.gate.push(bx(-gx, gx, top + OX, top + 16, -ZG, ZG));
  }
  return p;
}

export const FF_HOME: OrbitView = { target: [0, 8, 0], yaw: 0.4, pitch: 0.28, dist: 195 };
const NAME: Record<GateKind, string> = { planar: 'planar channel', fin: 'fins', sheets: 'nanosheets' };

/** The comparison: the three devices side by side, one scale, each on its own footprint (x offsets, nm). */
export const COMPARE_X: Record<GateKind, number> = { planar: -135, fin: 0, sheets: 135 };
export const COMPARE_VIEW: OrbitView = { target: [0, 8, 0], yaw: 0.2, pitch: 0.24, dist: 330 };
const KIND_LABEL: Record<GateKind, string> = { planar: 'planar', fin: 'fin', sheets: 'sheets' };

/** A device or 'all': the three side by side (the tour's last beat), off unless `on`. */
export function finfetModel(k: GateKind | 'all', on: boolean): Model3 {
  if (k === 'all') {
    const items: Item[] = [], anchors: StudioAnchor[] = [];
    for (const kk of ['planar', 'fin', 'sheets'] as const) {
      const m = finfetModel(kk, on), dx = COMPARE_X[kk], t = tr(dx, 0, 0);
      for (const it of m.items) items.push({ ...it, geo: transform(it.geo, t), name: `${it.name} (${KIND_LABEL[kk]})` });
      const r = offRatio(DEVICES[kk], DEVICES.planar);
      const at: [number, number] = kk === 'planar' ? [0, -5] : kk === 'fin' ? [FIN_X[0], DEVICES.fin.H / 2] : [0, 22.5];
      anchors.push({ text: `${KIND_LABEL[kk]}: off ${kk === 'planar' ? '1' : `1/${Math.round(1 / r)}`}`, p: [dx + at[0], at[1], 0], side: kk === 'sheets' ? 'r' : 'l', gutter: kk === 'sheets' ? 'r' : 'l', n: [0, 0, 1] });
    }
    return { items, anchors, beats: beatsOf(), floor: Y_SUB, look: { exposure: 1 }, cuts: { planes: [{ n: [0, 0, 1], d: 0 }], open: [ZS + 2] } };
  }
  const p = partsOf(k), items: Item[] = [], d = DEVICES[k];
  const add = (geo: Geo[], mat: Material, name: string, group: string, extra: Partial<Item> = {}) => { if (geo.length) items.push({ geo: merge(geo, name), mat, name, group, ...extra }); };
  const dim = (s: string) => ({ dim: s, source: d.source });
  add(p.body, MATS.si, 'silicon substrate', 'substrate');
  add(p.sti, MATS.sti, 'trench oxide', 'substrate');
  add(p.bdi, MATS.bdi, 'bottom dielectric isolation', 'substrate');
  add(p.sub, channelMat(false, on ? 0 : 0.6 * leakGlow('planar')), 'sub-fin', 'substrate', { info: { note: 'below the trench oxide’s top the gate does not reach the fin: in a bulk fin this is where it leaks (a punch-through stop implant is the cure)' } });
  add(p.channel, channelMat(on, leakGlow(k)), NAME[k], 'channel', {
    info: {
      ...dim(k === 'fin' ? `${d.W} nm wide, ${d.H} nm tall, ${d.pitch} nm apart` : k === 'sheets' ? `${d.n} sheets, ${d.W} × ${d.H} nm, ${d.gap} nm apart` : `${d.W} nm wide, gated from above only`),
      note: `the gate holds it on ${SIDES[k]} side${SIDES[k] > 1 ? 's' : ''}: effective width ${weff(d)} nm, swing ${swing(d).toFixed(0)} mV a decade at a ${d.L} nm gate`,
    },
  });
  add(p.nplus, MATS.nplus, 'source and drain', 'channel', { explode: [0, 0, 0] });
  add(p.hik, MATS.hik, 'gate dielectric', 'gate', { explode: [0, 30, 0] });
  add(p.gate, MATS.gate, 'gate', 'gate', { explode: [0, 60, 0], info: { dim: `${d.L} nm long (source to drain)` } });

  const top = k === 'planar' ? 26 : k === 'fin' ? DEVICES.fin.H + 18 : 51;
  const anchors: StudioAnchor[] = [
    { text: 'gate', p: [-15, top, -ZG / 2], side: 'l', n: [0, 1, 0], on: 'gate' },
    { text: k === 'planar' ? 'channel' : NAME[k], p: k === 'fin' ? [FIN_X[1], DEVICES.fin.H / 2, 0] : k === 'sheets' ? [0, 22.5, 0] : [0, -3, 0], side: 'r', n: [0, 0, 1] },
    // the cut takes the drain half away: the dielectric is what shows at the section
    { text: 'gate dielectric', p: k === 'fin' ? [FIN_X[0] - DEVICES.fin.W / 2 - OX / 2, DEVICES.fin.H * 0.6, 0] : k === 'sheets' ? [-DEVICES.sheets.W / 2 - OX / 2, 12.5, 0] : [-12, OX / 2, 0], side: 'l', n: [0, 0, 1], on: 'gate' },
    { text: 'trench oxide', p: [55, -4, ZS], side: 'r', n: [0, 0, 1] },
    { text: 'substrate', p: [-35, -32, 0], side: 'l', n: [0, 0, 1] },
  ];
  if (k === 'fin') anchors.push({ text: 'sub-fin', p: [FIN_X[1], -10, 0], side: 'r', n: [0, 0, 1] });
  return { items, anchors, beats: beatsOf(), floor: Y_SUB, look: { exposure: 1 }, cuts: { planes: [{ n: [0, 0, 1], d: 0 }], open: [ZS + 2] } };
}

/** The tour, the same on every device (finfet3dview.ts BEAT_STATE says which device and gate state each shows). */
function beatsOf(): Beat[] {
  const L = DEVICES.sheets.L;
  return [
    { title: 'A gate on one side', text: `The planar transistor: the gate sits on top of the channel and holds it from one side. At a ${L} nm gate the drain’s field reaches in from below, and the transistor no longer turns fully off.`, view: FF_HOME, cut: 1 },
    { title: 'A fin: three sides', text: `Stand the channel up as a fin and wrap the gate over it: Intel’s 22 nm fins were 8 nm wide and 34 nm tall at a 60 nm pitch. The gate holds it from both walls and the top, and the width that conducts is the walls plus the top, ${weff(DEVICES.fin)} nm per fin.`, view: { target: [0, 12, 0], yaw: 0.3, pitch: 0.24, dist: 200 }, cut: 1 },
    { title: 'Below the gate', text: 'Under the trench oxide’s top the fin goes on down into the substrate, where no gate reaches: off, that is where a bulk fin leaks.', view: { target: [30, -10, 0], yaw: 0.45, pitch: 0.16, dist: 165 }, cut: 1 },
    { title: 'Sheets: four sides', text: `Lay the channel down again as thin sheets and let the gate fill the gaps between them: IBM’s 2 nm test chip stacked three sheets 5 nm thick and 40 nm wide. Every sheet is held from all four sides, and a stack gives ${weff(DEVICES.sheets)} nm of width on a 44 nm footprint.`, view: { target: [0, 22, 0], yaw: 0.3, pitch: 0.2, dist: 160 }, cut: 1 },
    { title: 'Why it matters off', text: `The same ${L} nm gate on all three: the swing, the gate voltage per decade of current below threshold, is about ${swing(DEVICES.planar).toFixed(0)} mV planar, ${swing(DEVICES.fin).toFixed(0)} on a fin and ${swing(DEVICES.sheets).toFixed(0)} wrapped all round (60 is the limit). At a 0.3 V threshold that is ${Math.round(1 / offRatio(DEVICES.sheets, DEVICES.planar))} times less off current than planar.`, view: FF_HOME, cut: 1, explode: 0 },
    { title: 'Side by side', text: `All three off, at one scale, each on its own footprint: the planar channel glows with what it still leaks, the fin far less (its sub-fin, below the gate, the rest), the sheets barely. Same gate length, same threshold: ${Math.round(1 / offRatio(DEVICES.fin, DEVICES.planar))} and ${Math.round(1 / offRatio(DEVICES.sheets, DEVICES.planar))} times less leakage than planar, from nothing but the sides the gate holds.`, view: COMPARE_VIEW, cut: 1, explode: 0 },
  ];
}
