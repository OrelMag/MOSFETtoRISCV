// The MOSFET explainer: a cross-section whose channel forms as the gate voltage rises, a
// square-law current model, and the I–V curve. Used both as a chapter step and as the
// "inside" of any transistor opened from a schematic. Everything that moves is computed from
// the device model in mosphys.ts: channel thickness is the inversion charge, carrier speed is
// the field, the depletion depth stops at threshold, the pinch-off point is the Vds that saturates.

import { B1, type Bit } from '../sim/types';
import { h, s } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { carrierVelocity, channelCharge, current, depletionDepth, K, pinchPoint, Q_MIN, tween, VDD, VT } from './mosphys';

export interface MosfetOptions {
  type?: 'n' | 'p';
  allowTypeSwitch?: boolean;
  /** Live gate value from a running circuit (leaf mode). */
  gate?: () => Bit;
  caption?: string;
}

// Cross-section geometry (px). The channel runs between the wells, just under the oxide.
const CX0 = 228, CX1 = 412, CL = CX1 - CX0, CY = 150;
const CH_MAX = 22; // channel thickness at the largest possible charge, Vdd − Vt
const DEP_MAX = 44; // depletion depth at threshold
const RAMP_MS = 600; // leaf mode: how long the gate takes to follow a logic edge
const N_FLOW = 14;
const OUT = 1.08; // carriers run a little into the drain before they respawn at the source

const thickness = (q: number) => (CH_MAX * q) / (VDD - VT);

export function mosfetWidget(opts: MosfetOptions = {}): Widget {
  let type: 'n' | 'p' = opts.type ?? 'n';
  let vg = 0, vd = 0.9;
  let lastGate: Bit | null = null;

  const W = 640, H = 330;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'mos-svg', style: 'width:100%;height:auto;display:block' });
  const style = s('style');
  style.textContent = `
    .sub-p{fill:color-mix(in srgb,#f472b6 16%,var(--surface))} .sub-n{fill:color-mix(in srgb,#60a5fa 16%,var(--surface))}
    .well-n{fill:color-mix(in srgb,#3b82f6 42%,var(--surface))} .well-p{fill:color-mix(in srgb,#ec4899 42%,var(--surface))}
    .oxide{fill:color-mix(in srgb,var(--muted) 45%,var(--surface))} .gate{fill:color-mix(in srgb,var(--text) 70%,var(--surface))}
    .lead{stroke:var(--text-2);stroke-width:3;fill:none} .term{font:700 18px var(--font-mono);fill:var(--text)}
    .lbl{font:12px var(--font-ui);fill:var(--text-2)} .lbl-s{font:11px var(--font-ui);fill:var(--muted)}
    .carrier{font:700 14px var(--font-mono)} .e{fill:#2563eb} .hole{fill:#db2777}
    .chan-n{fill:#3b82f6} .chan-p{fill:#ec4899}
    .fl.e{fill:light-dark(#1e3a8a,#dbeafe)} .fl.hole{fill:light-dark(#831843,#fce7f3)}
    .depl{fill:color-mix(in srgb,var(--surface) 62%,transparent);stroke:var(--muted);stroke-width:1;stroke-dasharray:3 3}
    .gq{font:700 13px var(--font-mono);fill:var(--surface)} .field{stroke:var(--text-2);stroke-width:1.2;fill:none}
    .curve{fill:none;stroke:var(--accent);stroke-width:2} .axis{stroke:var(--border-strong)} .marker{fill:var(--w1)}
  `;
  svg.append(style);
  const sub = s('rect', { x: 30, y: 150, width: 580, height: 160, rx: 10 });
  const depl = s('rect', { x: CX0, y: CY, width: CL, height: 0, class: 'depl' });
  const wellS = s('rect', { x: 80, y: 150, width: 150, height: 70, rx: 22 });
  const wellD = s('rect', { x: 410, y: 150, width: 150, height: 70, rx: 22 });
  const oxide = s('rect', { x: 215, y: 136, width: 210, height: 14, class: 'oxide' });
  const gate = s('rect', { x: 215, y: 92, width: 210, height: 44, rx: 4, class: 'gate' });
  const chan = s('path');
  const fixed = s('g'); // the wells' carriers, which do not move
  const majority = s('g'); // the substrate's majority carriers, pushed down by the gate
  const induced = s('g'); // minority carriers, pulled up to form the channel
  const flow = s('g'); // carriers crossing the channel
  const gateQ = s('g'); // charge on the gate plate
  const field = s('g'); // field across the oxide
  const subLabel = s('text', { x: 320, y: 296, 'text-anchor': 'middle', class: 'lbl' });
  const wellSLabel = s('text', { x: 155, y: 202, 'text-anchor': 'middle', class: 'lbl' });
  const wellDLabel = s('text', { x: 485, y: 202, 'text-anchor': 'middle', class: 'lbl' });
  const deplLabel = s('text', { x: CX0 + 6, class: 'lbl-s' }, 'depletion');
  const pinchLabel = s('text', { y: 184, 'text-anchor': 'end', class: 'lbl-s' }, 'pinch-off');
  svg.append(sub, depl, majority, wellS, wellD, induced, chan, oxide, field, gate, gateQ, fixed, flow,
    subLabel, wellSLabel, wellDLabel, deplLabel, pinchLabel,
    s('path', { d: 'M155,150 V60', class: 'lead' }), s('path', { d: 'M485,150 V60', class: 'lead' }), s('path', { d: 'M320,92 V60', class: 'lead' }),
    s('text', { x: 155, y: 50, 'text-anchor': 'middle', class: 'term' }, 'S'),
    s('text', { x: 320, y: 50, 'text-anchor': 'middle', class: 'term' }, 'G'),
    s('text', { x: 485, y: 50, 'text-anchor': 'middle', class: 'term' }, 'D'),
    s('text', { x: 320, y: 116, 'text-anchor': 'middle', class: 'lbl', style: 'fill:var(--surface)' }, 'gate (metal / polysilicon)'),
    s('text', { x: 210, y: 147, 'text-anchor': 'end', class: 'lbl-s' }, 'oxide'));
  const vgText = s('text', { x: 330, y: 78, class: 'lbl' });
  const vdText = s('text', { x: 495, y: 78, class: 'lbl' });
  const vsText = s('text', { x: 165, y: 78, class: 'lbl' });
  svg.append(vgText, vdText, vsText);

  // Pools of persistent glyphs: frames only move them.
  const glyph = (attrs: Record<string, string | number> = {}) => s('text', { class: 'carrier', 'text-anchor': 'middle', 'dominant-baseline': 'central', ...attrs });
  const gateGlyphs = Array.from({ length: 7 }, (_, i) => s('text', { x: 242 + i * 26, y: 132, class: 'gq', 'text-anchor': 'middle' }));
  gateQ.append(...gateGlyphs);
  const arrows = Array.from({ length: 6 }, (_, i) => ({ el: s('path', { class: 'field' }), x: 250 + i * 28 }));
  field.append(...arrows.map((a) => a.el));
  const maj = Array.from({ length: 6 }, (_, i) => glyph({ x: 252 + i * 27, opacity: 0.55 }));
  majority.append(...maj);
  // Minority carriers start scattered deep in the substrate.
  const ind = Array.from({ length: 8 }, (_, i) => ({ el: glyph({ x: 240 + i * 22 }), y0: 252 + ((i * 7) % 3) * 12 }));
  induced.append(...ind.map((c) => c.el));
  const parts = Array.from({ length: N_FLOW }, (_, i) => ({ el: glyph(), x: (i / N_FLOW) * OUT, seed: (i * 0.618) % 1 }));
  flow.append(...parts.map((p) => p.el));

  // I–Vgs curve
  const cW = 280, cH = 170;
  const chart = s('svg', { viewBox: `0 0 ${cW} ${cH}`, style: 'width:100%;height:auto;display:block' });
  const curve = s('path', { class: 'curve' });
  const marker = s('circle', { r: 5, class: 'marker' });
  const vtLine = s('line', { y1: 10, y2: cH - 24, stroke: 'var(--muted)', 'stroke-dasharray': '3 3' });
  chart.append(
    s('line', { x1: 34, y1: cH - 24, x2: cW - 6, y2: cH - 24, class: 'axis' }),
    s('line', { x1: 34, y1: 8, x2: 34, y2: cH - 24, class: 'axis' }),
    vtLine, curve, marker,
    s('text', { x: cW - 6, y: cH - 8, 'text-anchor': 'end', class: 'lbl-s' }, 'gate drive →'),
    s('text', { x: 8, y: 14, class: 'lbl-s' }, 'I'),
  );
  const vtLabel = s('text', { y: cH - 8, 'text-anchor': 'middle', class: 'lbl-s' }, 'Vt');
  chart.append(vtLabel);
  const px = (v: number) => 34 + (v / VDD) * (cW - 40);
  const maxI = (K / 2) * (VDD - VT) ** 2 * 1.1;
  const py = (i: number) => cH - 24 - (i / maxI) * (cH - 34);

  const out = (label: string) => {
    const o = h('output');
    return { o, row: (input: HTMLInputElement) => h('label', { class: 'slider' }, h('span', null, label), input, o) };
  };
  const gIn = h('input', { type: 'range', min: 0, max: VDD, step: 0.01, value: vg }) as HTMLInputElement;
  const dIn = h('input', { type: 'range', min: 0, max: VDD, step: 0.01, value: vd }) as HTMLInputElement;
  const g = out('Gate voltage'), d = out('Drain voltage');
  const bVgs = h('b'), bId = h('b'), bOn = h('b'), sVgs = h('span');
  const readout = h('div', { class: 'readout' },
    h('div', null, bVgs, sVgs), h('div', null, h('b', null, `${VT} V`), h('span', null, 'threshold Vt')),
    h('div', null, bId, h('span', null, 'drain current')), h('div', null, bOn, h('span', null, 'as a switch')));
  const region = h('p', { class: 'sub', style: 'margin:10px 0 0' });
  const typeSel = h('div', { class: 'seg' });
  const caption = h('p', { class: 'sub' }, opts.caption ?? '');
  const howTo = h('p', { class: 'sub' });
  const sweepBtn = h('button', { class: 'btn sm', type: 'button', onclick: () => (tw ? stopSweep() : sweep()) });

  // ── Gate-voltage animation: a queue of tweens (a sweep is up, hold, down) ──
  let tw: ReturnType<typeof tween> | null = null;
  let queue: { to: number; ms: number }[] = [];
  const syncSweep = () => { sweepBtn.textContent = tw ? '■ Stop' : '▶ Sweep'; };
  const next = (now: number) => {
    const seg = queue.shift();
    tw = seg ? tween(vg, seg.to, now, seg.ms) : null;
    syncSweep();
  };
  const play = (segs: { to: number; ms: number }[]) => {
    queue = segs;
    next(performance.now());
    kick();
  };
  const stopSweep = () => { queue = []; tw = null; syncSweep(); };
  const sweep = () => {
    // Off to fully on and back. For PMOS "on" is the gate pulled down to 0 V.
    const off = type === 'n' ? 0 : VDD, on = VDD - off;
    vg = off;
    play([{ to: on, ms: 3200 }, { to: on, ms: 900 }, { to: off, ms: 2000 }]);
  };

  const setType = (t: 'n' | 'p') => {
    type = t;
    stopSweep();
    for (const b of typeSel.querySelectorAll('button')) b.classList.toggle('on', b.dataset.t === t);
    vd = t === 'p' ? VDD - 0.9 : 0.9;
    vg = t === 'p' ? VDD : 0;
    dIn.value = String(vd);
    relayout();
    paint(0);
  };
  for (const t of ['n', 'p'] as const) typeSel.append(h('button', { 'data-t': t, onclick: () => setType(t) }, t === 'n' ? 'NMOS' : 'PMOS'));

  gIn.addEventListener('input', () => { stopSweep(); vg = Number(gIn.value); paint(0); kick(); });
  dIn.addEventListener('input', () => { vd = Number(dIn.value); relayout(); paint(0); kick(); });

  // ── Fixed for a given type and Vd: classes, labels, the wells' carriers, the I–V curve ──
  function relayout(): void {
    const n = type === 'n';
    const vs = n ? 0 : VDD;
    const vds = Math.abs(vd - vs);
    sub.setAttribute('class', n ? 'sub-p' : 'sub-n');
    wellS.setAttribute('class', n ? 'well-n' : 'well-p');
    wellD.setAttribute('class', n ? 'well-n' : 'well-p');
    chan.setAttribute('class', n ? 'chan-n' : 'chan-p');
    subLabel.textContent = n ? 'p-type silicon (few free electrons)' : 'n-type well (few free holes)';
    wellSLabel.textContent = n ? 'n+ source' : 'p+ source';
    wellDLabel.textContent = n ? 'n+ drain' : 'p+ drain';
    vsText.textContent = `${vs.toFixed(1)} V`;
    howTo.textContent = n
      ? 'Raise the gate voltage past the threshold and a channel of electrons appears, connecting source to drain.'
      : 'For PMOS the source sits at VDD: pull the gate down and a channel of holes appears.';
    sVgs.textContent = n ? 'Vgs (gate − source)' : 'Vsg (source − gate)';
    // The channel's carriers (the wells' majority) and the body's majority carriers.
    const [cSym, cCls] = n ? ['−', 'carrier e'] : ['+', 'carrier hole'];
    const [bSym, bCls] = n ? ['+', 'carrier hole'] : ['−', 'carrier e'];
    fixed.replaceChildren();
    for (const x0 of [100, 430]) {
      for (let i = 0; i < 6; i++) fixed.append(s('text', { x: x0 + 18 + (i % 3) * 38, y: 172 + Math.floor(i / 3) * 22, class: cCls, 'text-anchor': 'middle' }, cSym));
    }
    for (const c of ind) { c.el.textContent = cSym; c.el.setAttribute('class', cCls); }
    for (const p of parts) { p.el.textContent = cSym; p.el.setAttribute('class', `${cCls} fl`); }
    for (const m of maj) { m.textContent = bSym; m.setAttribute('class', bCls); }
    // The field points from the positive plate to the negative one: down for NMOS (gate above
    // its body), up for PMOS (gate below its body).
    for (const { el: a, x } of arrows) {
      a.setAttribute('d', n ? `M${x},138 V148 M${x - 2.5},144.5 L${x},148 L${x + 2.5},144.5` : `M${x},148 V138 M${x - 2.5},141.5 L${x},138 L${x + 2.5},141.5`);
    }
    for (const q of gateGlyphs) q.textContent = n ? '+' : '−';
    let dd = '';
    for (let v = 0; v <= VDD + 1e-9; v += 0.02) dd += `${dd ? 'L' : 'M'}${px(v)},${py(current(v - VT, vds).id)}`;
    curve.setAttribute('d', dd);
    vtLine.setAttribute('x1', String(px(VT)));
    vtLine.setAttribute('x2', String(px(VT)));
    vtLabel.setAttribute('x', String(px(VT)));
    d.o.textContent = `${vd.toFixed(2)} V`;
    vdText.textContent = `${vd.toFixed(2)} V`;
  }

  // ── Per frame: everything that depends on Vg, plus carrier motion over dt seconds ──
  let flowing = false;
  function paint(dt: number): void {
    const n = type === 'n';
    const vs = n ? 0 : VDD;
    const drive = Math.max(0, n ? vg - vs : vs - vg); // Vgs, or Vsg for PMOS
    const vov = drive - VT;
    const vds = Math.abs(vd - vs);
    const { id, region: reg } = current(vov, vds);
    const xp = pinchPoint(vov, vds);
    const qAt = (x: number) => channelCharge(vov, vds, x);

    // Channel: thickness ∝ inversion charge, so it tapers toward the drain and pinches off in
    // saturation. Top edge along the oxide, then back along the bottom from drain to source.
    const q0 = qAt(0);
    if (q0 > 0) {
      const pts: string[] = [];
      for (let i = 40; i >= 0; i--) pts.push(`${CX0 + (i / 40) * CL},${(CY + thickness(qAt(i / 40))).toFixed(2)}`);
      chan.setAttribute('d', `M${CX0},${CY} H${CX1} L${pts.join(' L')} Z`);
      chan.setAttribute('opacity', String(Math.min(0.9, 0.35 + q0)));
    } else chan.setAttribute('d', '');

    // Depletion under the gate, and the body's majority carriers it pushes away.
    const dep = DEP_MAX * depletionDepth(drive);
    depl.setAttribute('height', String(dep));
    depl.style.display = dep > 0.5 ? '' : 'none';
    deplLabel.setAttribute('y', String(CY + dep - 5));
    deplLabel.style.display = dep > 28 ? '' : 'none';
    maj.forEach((m, i) => m.setAttribute('y', String(Math.max(214 + (i % 2) * 18, CY + dep + 12 + (i % 2) * 12))));

    // Gate charge and oxide field grow with the drive.
    const k = Math.min(1, drive / VDD);
    gateGlyphs.forEach((q, i) => q.setAttribute('opacity', String(Math.min(1, Math.max(0, k * gateGlyphs.length - i)))));
    field.setAttribute('opacity', String(k));

    // Minority carriers rise to the oxide as the drive approaches threshold, then hand over to
    // the flowing carriers once current runs.
    const pull = Math.min(1, drive / (VT + 0.25));
    const rise = pull * pull * (3 - 2 * pull);
    const handover = Math.min(1, id / 5);
    for (const c of ind) {
      c.el.setAttribute('y', String(c.y0 + (CY + 6 - c.y0) * rise));
      c.el.setAttribute('opacity', String((0.3 + 0.6 * pull) * (1 - handover)));
    }

    // Flowing carriers: speed ∝ field = I / Q, so they bunch near the source and race through
    // the pinched-off gap. In reduced motion they stand still, spread over the channel.
    flowing = id > 0.5;
    flow.style.display = flowing ? '' : 'none';
    pinchLabel.style.display = flowing && xp < 1 ? '' : 'none';
    pinchLabel.setAttribute('x', String(CX0 + xp * CL - 4));
    if (flowing) {
      const shown = Math.max(3, Math.round(N_FLOW * Math.min(1, vov / (VDD - VT))));
      const still = reducedMotion();
      parts.forEach((p, i) => {
        if (i >= shown) { p.el.setAttribute('opacity', '0'); return; }
        if (still) p.x = ((i + 0.5) / shown) * xp;
        else {
          p.x += carrierVelocity(id, p.x < xp ? qAt(p.x) : Q_MIN) * dt;
          if (p.x >= OUT) p.x -= OUT;
        }
        const t = thickness(qAt(Math.min(p.x, 1)));
        p.el.setAttribute('x', (CX0 + p.x * CL).toFixed(1));
        p.el.setAttribute('y', (CY + 3 + p.seed * Math.max(0, t - 5)).toFixed(1));
        p.el.setAttribute('opacity', String(p.x > 1 ? Math.max(0, 1 - (p.x - 1) / (OUT - 1)) : p.x >= xp ? 0.6 : 1));
      });
    }

    vgText.textContent = `${vg.toFixed(2)} V`;
    g.o.textContent = `${vg.toFixed(2)} V`;
    gIn.value = String(vg);
    bVgs.textContent = `${drive.toFixed(2)} V`;
    bId.textContent = id < 0.05 ? '0 µA' : `${id.toFixed(0)} µA`;
    bOn.textContent = vov > 0 ? 'ON' : 'OFF';
    region.textContent = `Region: ${reg}.`;
    marker.setAttribute('cx', String(px(drive)));
    marker.setAttribute('cy', String(py(id)));
  }

  // ── The loop runs only while something moves: a gate ramp, or carriers in a conducting channel ──
  let raf = 0, lastT = 0;
  const moving = () => tw !== null || (flowing && !reducedMotion());
  const loop = (now: number) => {
    raf = 0;
    const dt = Math.min(0.05, Math.max(0, (now - lastT) / 1000)); // no jump after a hidden tab
    lastT = now;
    if (tw) {
      const r = tw(now);
      vg = r.v;
      if (r.done) next(now);
    }
    paint(dt);
    if (moving()) raf = requestAnimationFrame(loop);
  };
  function kick(): void {
    if (raf || !moving()) return;
    lastT = performance.now();
    raf = requestAnimationFrame(loop);
  }

  const el = h('div', { class: 'widget' },
    h('div', { class: 'wgrid' },
      h('div', { class: 'panel' },
        h('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:6px' },
          h('h3', null, 'Inside a MOSFET'), opts.allowTypeSwitch !== false ? typeSel : null),
        caption, svg),
      h('div', { class: 'panel' },
        h('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:12px' },
          // The circuit drives the gate in leaf mode; a sweep is motion the user asked for, but
          // reduced motion still gets the slider instead.
          h('h3', null, 'Drive it'), opts.gate || reducedMotion() ? null : sweepBtn),
        howTo,
        g.row(gIn), d.row(dIn), readout, region,
        h('h3', { style: 'margin-top:14px' }, 'Current vs gate drive'), chart)));

  syncSweep();
  setType(type);
  kick();

  return {
    el,
    update() {
      if (!opts.gate) return;
      const gv = opts.gate();
      if (gv === lastGate) return;
      // The first value arrives as the widget opens: show it as is. Later edges ramp.
      const ms = lastGate === null || reducedMotion() ? 0 : RAMP_MS;
      lastGate = gv;
      const to = gv === B1 ? VDD : 0;
      if (ms) play([{ to, ms }]);
      else { stopSweep(); vg = to; paint(0); kick(); }
    },
    destroy() {
      cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}

/** Leaf factory for the stage: opening a transistor shows this widget, driven live. */
export function transistorLeaf(def: { prim?: string; name: string }, gate: () => Bit): Widget {
  const w = mosfetWidget({
    type: def.prim === 'pmos' ? 'p' : 'n', allowTypeSwitch: false, gate,
    caption: 'This is one transistor from the circuit you were looking at. Its gate follows the live logic value (1 = 1.8 V, 0 = 0 V), ramping as the bit flips. Toggle inputs in the bar below and watch it switch.',
  });
  w.update?.();
  return w;
}
