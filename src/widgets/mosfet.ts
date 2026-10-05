// The MOSFET explainer: a cross-section whose channel forms as the gate voltage rises, a
// square-law current model, and the I–V curve. Used both as a chapter step and as the
// "inside" of any transistor opened from a schematic.

import { B1, type Bit } from '../sim/types';
import { h, s } from '../ui/dom';
import type { Widget } from '../view/stage';

const VDD = 1.8;
const VT = 0.45;
const K = 220; // µA/V² (k'·W/L), a plausible small device

export interface MosfetOptions {
  type?: 'n' | 'p';
  allowTypeSwitch?: boolean;
  /** Live gate value from a running circuit (leaf mode). */
  gate?: () => Bit;
  caption?: string;
}

function current(vov: number, vds: number): { id: number; region: string } {
  if (vov <= 0) return { id: 0, region: 'cut-off: no channel, no current' };
  if (vds < vov) return { id: K * (vov * vds - (vds * vds) / 2), region: 'linear: the channel acts like a resistor' };
  return { id: (K / 2) * vov * vov * (1 + 0.05 * vds), region: 'saturation: the channel pinches off near the drain' };
}

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
    .curve{fill:none;stroke:var(--accent);stroke-width:2} .axis{stroke:var(--border-strong)} .marker{fill:var(--w1)}
  `;
  svg.append(style);
  const sub = s('rect', { x: 30, y: 150, width: 580, height: 160, rx: 10 });
  const wellS = s('rect', { x: 80, y: 150, width: 150, height: 70, rx: 22 });
  const wellD = s('rect', { x: 410, y: 150, width: 150, height: 70, rx: 22 });
  const oxide = s('rect', { x: 215, y: 136, width: 210, height: 14, class: 'oxide' });
  const gate = s('rect', { x: 215, y: 92, width: 210, height: 44, rx: 4, class: 'gate' });
  const chan = s('rect', { x: 222, y: 150, width: 196, height: 12, rx: 3 });
  const carriers = s('g');
  const flow = s('g');
  const subLabel = s('text', { x: 320, y: 296, 'text-anchor': 'middle', class: 'lbl' });
  const wellSLabel = s('text', { x: 155, y: 202, 'text-anchor': 'middle', class: 'lbl' });
  const wellDLabel = s('text', { x: 485, y: 202, 'text-anchor': 'middle', class: 'lbl' });
  svg.append(sub, wellS, wellD, chan, oxide, gate, carriers, flow, subLabel, wellSLabel, wellDLabel,
    s('path', { d: 'M155,150 V60', class: 'lead' }), s('path', { d: 'M485,150 V60', class: 'lead' }), s('path', { d: 'M320,92 V60', class: 'lead' }),
    s('text', { x: 155, y: 50, 'text-anchor': 'middle', class: 'term' }, 'S'),
    s('text', { x: 320, y: 50, 'text-anchor': 'middle', class: 'term' }, 'G'),
    s('text', { x: 485, y: 50, 'text-anchor': 'middle', class: 'term' }, 'D'),
    s('text', { x: 320, y: 120, 'text-anchor': 'middle', class: 'lbl', style: 'fill:var(--surface)' }, 'gate (metal / polysilicon)'),
    s('text', { x: 436, y: 147, class: 'lbl-s' }, 'oxide, ~2 nm'));
  const vgText = s('text', { x: 330, y: 78, class: 'lbl' });
  const vdText = s('text', { x: 495, y: 78, class: 'lbl' });
  const vsText = s('text', { x: 165, y: 78, class: 'lbl' });
  svg.append(vgText, vdText, vsText);

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

  const out = (label: string) => {
    const o = h('output');
    return { o, row: (input: HTMLInputElement) => h('label', { class: 'slider' }, h('span', null, label), input, o) };
  };
  const gIn = h('input', { type: 'range', min: 0, max: VDD, step: 0.01, value: vg }) as HTMLInputElement;
  const dIn = h('input', { type: 'range', min: 0, max: VDD, step: 0.01, value: vd }) as HTMLInputElement;
  const g = out('Gate voltage'), d = out('Drain voltage');
  const readout = h('div', { class: 'readout' });
  const region = h('p', { class: 'sub', style: 'margin:10px 0 0' });
  const typeSel = h('div', { class: 'seg' });
  const caption = h('p', { class: 'sub' });
  const setType = (t: 'n' | 'p') => {
    type = t;
    for (const b of typeSel.querySelectorAll('button')) b.classList.toggle('on', b.dataset.t === t);
    if (t === 'p') vd = VDD - 0.9;
    dIn.value = String(vd);
    draw();
  };
  for (const t of ['n', 'p'] as const) typeSel.append(h('button', { 'data-t': t, onclick: () => setType(t) }, t === 'n' ? 'NMOS' : 'PMOS'));

  gIn.addEventListener('input', () => { vg = Number(gIn.value); draw(); });
  dIn.addEventListener('input', () => { vd = Number(dIn.value); draw(); });

  let raf = 0, phase = 0;
  const dots = Array.from({ length: 9 }, () => s('text', { class: 'carrier', 'text-anchor': 'middle' }));
  flow.append(...dots);
  let speed = 0;
  const animate = () => {
    phase = (phase + speed) % 1;
    dots.forEach((dot, i) => {
      const t = (i / dots.length + phase) % 1;
      dot.setAttribute('x', String(232 + t * 176));
      dot.setAttribute('y', String(160));
    });
    raf = requestAnimationFrame(animate);
  };

  function draw(): void {
    const n = type === 'n';
    // Source sits at GND for NMOS and at VDD for PMOS; the drive is the gate–source voltage.
    const vs = n ? 0 : VDD;
    const vov = n ? vg - vs - VT : vs - vg - VT;
    const vds = Math.abs(vd - vs);
    const { id, region: reg } = current(vov, vds);
    sub.setAttribute('class', n ? 'sub-p' : 'sub-n');
    wellS.setAttribute('class', n ? 'well-n' : 'well-p');
    wellD.setAttribute('class', n ? 'well-n' : 'well-p');
    chan.setAttribute('class', n ? 'chan-n' : 'chan-p');
    chan.setAttribute('opacity', String(Math.max(0, Math.min(1, vov / 0.9)) * 0.9));
    subLabel.textContent = n ? 'p-type silicon (few free electrons)' : 'n-type well (few free holes)';
    wellSLabel.textContent = n ? 'n+ source' : 'p+ source';
    wellDLabel.textContent = n ? 'n+ drain' : 'p+ drain';
    vgText.textContent = `${vg.toFixed(2)} V`;
    vdText.textContent = `${vd.toFixed(2)} V`;
    vsText.textContent = `${vs.toFixed(1)} V`;
    // Carriers in the wells, and induced charge under the gate.
    carriers.replaceChildren();
    const sym = n ? '−' : '+';
    const cls = n ? 'carrier e' : 'carrier hole';
    for (const x0 of [100, 430]) {
      for (let i = 0; i < 6; i++) carriers.append(s('text', { x: x0 + 18 + (i % 3) * 38, y: 172 + Math.floor(i / 3) * 22, class: cls, 'text-anchor': 'middle' }, sym));
    }
    const induced = Math.max(0, Math.min(8, Math.round((vov + 0.2) * 6)));
    for (let i = 0; i < induced; i++) carriers.append(s('text', { x: 240 + i * 22, y: 175, class: cls, 'text-anchor': 'middle', opacity: 0.85 }, sym));
    // Moving carriers when current flows.
    dots.forEach((dot) => { dot.textContent = sym; dot.setAttribute('class', cls); });
    speed = id > 0 ? Math.min(0.02, 0.0015 + id / 40000) : 0;
    flow.setAttribute('opacity', id > 0.5 ? '1' : '0');

    g.o.textContent = `${vg.toFixed(2)} V`;
    d.o.textContent = `${vd.toFixed(2)} V`;
    readout.replaceChildren(
      h('div', null, h('b', null, `${Math.max(0, vov + VT).toFixed(2)} V`), h('span', null, n ? 'Vgs (gate − source)' : 'Vsg (source − gate)')),
      h('div', null, h('b', null, `${VT} V`), h('span', null, 'threshold Vt')),
      h('div', null, h('b', null, id < 0.05 ? '0 µA' : `${id.toFixed(0)} µA`), h('span', null, 'drain current')),
      h('div', null, h('b', null, vov > 0 ? 'ON' : 'OFF', ), h('span', null, 'as a switch')),
    );
    region.textContent = `Region: ${reg}.`;

    // Curve of I vs gate drive at the current Vds.
    const px = (v: number) => 34 + (v / VDD) * (cW - 40);
    const maxI = (K / 2) * (VDD - VT) ** 2 * 1.1;
    const py = (i: number) => cH - 24 - (i / maxI) * (cH - 34);
    let dd = '';
    for (let v = 0; v <= VDD + 1e-9; v += 0.02) dd += `${dd ? 'L' : 'M'}${px(v)},${py(current(v - VT, vds).id)}`;
    curve.setAttribute('d', dd);
    const drive = Math.max(0, n ? vg - vs : vs - vg);
    marker.setAttribute('cx', String(px(drive)));
    marker.setAttribute('cy', String(py(id)));
    vtLine.setAttribute('x1', String(px(VT)));
    vtLine.setAttribute('x2', String(px(VT)));
    vtLabel.setAttribute('x', String(px(VT)));
    if (opts.caption) caption.textContent = opts.caption;
  }

  const el = h('div', { class: 'widget' },
    h('div', { class: 'wgrid' },
      h('div', { class: 'panel' },
        h('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:6px' },
          h('h3', null, 'Inside a MOSFET'), opts.allowTypeSwitch !== false ? typeSel : null),
        caption, svg),
      h('div', { class: 'panel' },
        h('h3', null, 'Drive it'),
        h('p', { class: 'sub' }, type === 'n'
          ? 'Raise the gate voltage past the threshold and a channel of electrons appears, connecting source to drain.'
          : 'For PMOS the source sits at VDD: pull the gate down and a channel of holes appears.'),
        g.row(gIn), d.row(dIn), readout, region,
        h('h3', { style: 'margin-top:14px' }, 'Current vs gate drive'), chart)));

  setType(type);
  raf = requestAnimationFrame(animate);

  return {
    el,
    update() {
      if (!opts.gate) return;
      const gv = opts.gate();
      if (gv !== lastGate) {
        lastGate = gv;
        vg = gv === B1 ? VDD : 0;
        gIn.value = String(vg);
        draw();
      }
    },
    destroy() {
      cancelAnimationFrame(raf);
    },
  };
}

/** Leaf factory for the stage: opening a transistor shows this widget, driven live. */
export function transistorLeaf(def: { prim?: string; name: string }, gate: () => Bit): Widget {
  const w = mosfetWidget({
    type: def.prim === 'pmos' ? 'p' : 'n', allowTypeSwitch: false, gate,
    caption: 'This is one transistor from the circuit you were looking at. Its gate follows the live logic value: 1 = 1.8 V, 0 = 0 V. Toggle inputs in the bar below and watch it switch.',
  });
  w.update?.();
  return w;
}
