// The MOSFET cross-section, drawn from the device model in mosphys.ts: channel thickness is the
// inversion charge, carrier speed is the field, the depletion depth stops at threshold, the pinch-off
// point is where the drain voltage saturates the channel. Shared by the chapter's widgets (the whole
// device, or a close-up of the channel) and by a transistor opened from a schematic.

import { s } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import { carrierVelocity, channelCharge, current, depletionDepth, pinchPoint, Q_MIN, VDD, VT } from './mosphys';

export type MosType = 'n' | 'p';

export interface CrossSection {
  el: SVGSVGElement;
  /** Draw for gate / drain voltages (absolute, 0..VDD), moving carriers by dt seconds. True while carriers flow. */
  paint(type: MosType, vg: number, vd: number, dt: number): boolean;
}

// Geometry (SVG units). The channel runs between the wells, just under the oxide.
const CX0 = 228, CX1 = 412, CL = CX1 - CX0, CY = 150;
const CH_MAX = 24; // channel thickness at the largest possible charge, VDD − VT
const DEP_MAX = 46; // depletion depth at threshold
const N_FLOW = 16;
const OUT = 1.08; // carriers run a little into the drain before they respawn at the source
const VIEW = { device: '70 30 500 236', channel: '196 118 248 84' };

const thickness = (q: number) => (CH_MAX * q) / (VDD - VT);

export function crossSection(view: keyof typeof VIEW = 'device', label = 'Cross-section of a MOSFET'): CrossSection {
  const svg = s('svg', { viewBox: VIEW[view], class: `mos-x mos-x-${view}`, role: 'img', 'aria-label': label }) as SVGSVGElement;
  const add = <T extends SVGElement>(e: T): T => (svg.append(e), e);
  const dot = (cx: number, cy: number) => s('circle', { cx, cy, r: 3.4 });

  const sub = add(s('rect', { x: 30, y: 150, width: 580, height: 160 }));
  const depl = add(s('rect', { x: CX0, y: CY, width: CL, height: 0, class: 'depl' }));
  const body = Array.from({ length: 9 }, (_, i) => add(dot(240 + i * 21, 0))); // the body's majority carriers
  const wells = [80, 410].map((x) => add(s('rect', { x, y: 150, width: 150, height: 74, rx: 24 })));
  const fixed = [100, 430].flatMap((x0) => Array.from({ length: 8 }, (_, i) => add(dot(x0 + 14 + (i % 4) * 34, 170 + Math.floor(i / 4) * 24))));
  // Minority carriers start scattered deep in the substrate and rise to the oxide near threshold.
  const induced = Array.from({ length: 8 }, (_, i) => ({ el: add(dot(242 + i * 22, 0)), y0: 234 + ((i * 7) % 3) * 6 }));
  const chan = add(s('path'));
  add(s('rect', { x: 215, y: 136, width: 210, height: 14, class: 'oxide' }));
  const field = add(s('g', { class: 'field' }));
  const arrows = Array.from({ length: 6 }, (_, i) => field.appendChild(s('path', { 'data-x': 250 + i * 28 })));
  add(s('rect', { x: 215, y: 92, width: 210, height: 44, rx: 4, class: 'gate' }));
  const gateQ = Array.from({ length: 7 }, (_, i) => add(s('text', { x: 242 + i * 26, y: 132, class: 'gq', 'text-anchor': 'middle' })));
  add(s('text', { x: 320, y: 112, class: 'gl', 'text-anchor': 'middle' }, 'gate'));
  const flow = Array.from({ length: N_FLOW }, (_, i) => ({ el: add(s('circle', { r: 3.2 })), x: (i / N_FLOW) * OUT, seed: (i * 0.618) % 1 }));
  const text = (x: number, y: number, cls: string, anchor = 'middle', t = '') => add(s('text', { x, y, class: cls, 'text-anchor': anchor }, t));
  const wellS = text(155, 214, 'lbl'), wellD = text(485, 214, 'lbl'), subL = text(320, 262, 'lbl');
  text(210, 147, 'lbl-s', 'end', 'oxide');
  const deplL = text(CX0 + 6, 0, 'lbl-s', 'start', 'depletion');
  const pinchMark = add(s('line', { y1: 150, y2: 180, class: 'pinch' }));
  const pinchL = text(0, 190, 'lbl-p', 'end', 'pinch-off');
  for (const [x, t] of [[155, 'S'], [320, 'G'], [485, 'D']] as const) {
    add(s('path', { d: `M${x},${t === 'G' ? 92 : 150} V62`, class: 'lead' }));
    text(x, 52, 'term', 'middle', t);
  }
  const vText = [165, 330, 495].map((x) => text(x, 76, 'volt', 'start'));

  let lastType: MosType | null = null;
  const relayout = (type: MosType) => {
    const n = type === 'n';
    // Symbols: electrons are filled dots, holes are rings.
    const [chanCls, bodyCls] = n ? ['e', 'h'] : ['h', 'e'];
    sub.setAttribute('class', n ? 'sub-p' : 'sub-n');
    for (const w of wells) w.setAttribute('class', n ? 'well-n' : 'well-p');
    chan.setAttribute('class', n ? 'chan-n' : 'chan-p');
    for (const c of fixed) c.setAttribute('class', chanCls);
    for (const c of induced) c.el.setAttribute('class', chanCls);
    for (const c of body) c.setAttribute('class', bodyCls);
    for (const c of flow) c.el.setAttribute('class', `fl ${chanCls}`);
    wellS.textContent = n ? 'n+ source' : 'p+ source';
    wellD.textContent = n ? 'n+ drain' : 'p+ drain';
    subL.textContent = n ? 'p-type silicon' : 'n-type well';
    // The field points from the positive plate to the negative one: down for NMOS, up for PMOS.
    for (const a of arrows) {
      const x = Number(a.dataset.x);
      a.setAttribute('d', n ? `M${x},138 V148 M${x - 2.5},144.5 L${x},148 L${x + 2.5},144.5` : `M${x},148 V138 M${x - 2.5},141.5 L${x},138 L${x + 2.5},141.5`);
    }
    for (const q of gateQ) q.textContent = n ? '+' : '−';
  };

  const paint = (type: MosType, vg: number, vd: number, dt: number): boolean => {
    if (type !== lastType) { relayout(type); lastType = type; }
    const n = type === 'n';
    const vs = n ? 0 : VDD;
    const drive = Math.max(0, n ? vg - vs : vs - vg); // Vgs, or Vsg for PMOS
    const vov = drive - VT, vds = Math.abs(vd - vs);
    const { id } = current(vov, vds);
    const xp = pinchPoint(vov, vds);
    const qAt = (x: number) => channelCharge(vov, vds, x);

    // Channel: thickness ∝ inversion charge, so it tapers toward the drain and pinches off in saturation.
    const q0 = qAt(0);
    if (q0 > 0) {
      let d = `M${CX0},${CY} H${CX1}`;
      for (let i = 40; i >= 0; i--) d += ` L${CX0 + (i / 40) * CL},${(CY + thickness(qAt(i / 40))).toFixed(2)}`;
      chan.setAttribute('d', `${d} Z`);
      chan.setAttribute('opacity', String(Math.min(0.9, 0.35 + q0)));
    } else chan.setAttribute('d', '');

    // Depletion under the gate, and the body's majority carriers it pushes away.
    const dep = DEP_MAX * depletionDepth(drive);
    depl.setAttribute('height', String(dep));
    depl.style.display = dep > 0.5 ? '' : 'none';
    deplL.setAttribute('y', String(CY + dep - 6));
    deplL.style.display = dep > 26 ? '' : 'none';
    body.forEach((c, i) => c.setAttribute('cy', String(Math.max(204 + (i % 3) * 10, CY + dep + 8 + (i % 3) * 10))));

    // Gate charge and oxide field grow with the drive.
    const k = Math.min(1, drive / VDD);
    gateQ.forEach((q, i) => q.setAttribute('opacity', String(Math.min(1, Math.max(0, k * gateQ.length - i)))));
    field.setAttribute('opacity', String(k));

    // Minority carriers rise to the oxide as the drive nears threshold, then hand over to the flowing ones.
    const pull = Math.min(1, drive / (VT + 0.25)), rise = pull * pull * (3 - 2 * pull), handover = Math.min(1, id / 5);
    for (const c of induced) {
      c.el.setAttribute('cy', String(c.y0 + (CY + 6 - c.y0) * rise));
      c.el.setAttribute('opacity', String((0.3 + 0.6 * pull) * (1 - handover)));
    }

    // Flowing carriers: speed ∝ field = I / Q, so they bunch near the source and race through the
    // pinched-off gap. In reduced motion they stand still, spread over the channel.
    const flowing = id > 0.5;
    const sat = flowing && xp < 1;
    pinchL.style.display = pinchMark.style.display = sat ? '' : 'none';
    const px = CX0 + xp * CL;
    pinchL.setAttribute('x', String(px - 5));
    pinchMark.setAttribute('x1', String(px));
    pinchMark.setAttribute('x2', String(px));
    const shown = flowing ? Math.max(3, Math.round(N_FLOW * Math.min(1, vov / (VDD - VT)))) : 0;
    const still = reducedMotion();
    flow.forEach((p, i) => {
      if (i >= shown) { p.el.setAttribute('opacity', '0'); return; }
      if (still) p.x = ((i + 0.5) / shown) * xp;
      else {
        p.x += carrierVelocity(id, p.x < xp ? qAt(p.x) : Q_MIN) * dt;
        if (p.x >= OUT) p.x -= OUT;
      }
      const t = thickness(qAt(Math.min(p.x, 1)));
      p.el.setAttribute('cx', (CX0 + p.x * CL).toFixed(1));
      p.el.setAttribute('cy', (CY + 4 + p.seed * Math.max(0, t - 7)).toFixed(1));
      p.el.setAttribute('opacity', String(p.x > 1 ? Math.max(0, 1 - (p.x - 1) / (OUT - 1)) : p.x >= xp ? 0.65 : 1));
    });

    vText[0].textContent = `${vs.toFixed(1)} V`;
    vText[1].textContent = `${vg.toFixed(2)} V`;
    vText[2].textContent = `${vd.toFixed(2)} V`;
    return flowing;
  };

  return { el: svg, paint };
}
