// EUV lithography in 3D on the studio renderer (euv3dkit.ts; loaded on demand, modelhost.ts): two scenes behind one switch,
// the light source (a laser, tin droplets and a collector) and the scanner (ten mirrors from the source to the wafer). The
// numbers are phys/euv.ts's; the source's droplets move at their real speed slowed SLOW times.

import '../styles/euv3d.css';
import { groupDigits } from '../sim/numfmt';
import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { CHAIN, CRA_DEG, LAMBDA_NM, OPTICS, REFLECTIONS, R_MIRROR, conesApart, halfPitchNm, maskField, maskHalfDeg, onTargetNeeded, periodUs, powerAtIf, spacingMm, transmission, waferHalfDeg, type Optics } from '../phys/euv';
import { frameLoop } from './mosfet';
import { studioStage, type StudioStage } from './studiostage';
import { RIM_DEG, SCAN_FRAME, SCAN_HOME, SLOW, SRC_FRAME, SRC_HOME, mainAt, scannerModel, sourceModel, srcDefault, type SrcState } from './euv3dkit';

type Scene = 'source' | 'scanner';

export function euvView(initial: Scene = 'source'): Widget {
  let scene: Scene = initial, stage: StudioStage | null = null, playing = !reducedMotion();
  const src: SrcState = srcDefault();
  let optics: Optics = OPTICS[0], refl = R_MIRROR;
  const panel = h('div', { class: 'panel euv3' });
  const host = h('div', { class: 'euv-host' }), ctl = h('div', { class: 'r3-ctl' }), kv = h('div', { class: 'r3-kv' }), side = h('h4');
  const chip = h('span', { class: 'r3-chip', role: 'status', 'aria-live': 'polite' });
  const f1 = (v: number) => v.toFixed(1), pc = (v: number) => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)} %`;

  // ---------------------------------------------------------------- the source
  const loop = frameLoop((_now, dt) => {
    if (!playing || scene !== 'source') return;
    src.tau = (src.tau + (dt * 1e6) / periodUs(src.fKhz) / SLOW) % 1;
    tauIn.value = String(src.tau);
    stage?.refresh();
    readout();
  }, () => playing && scene === 'source');

  const slider = (label: string, min: number, max: number, step: number, val: number, set: (v: number) => void, fmt: (v: number) => string) => {
    const inp = h('input', { type: 'range', min, max, step, value: val, 'aria-label': label }) as HTMLInputElement, out = h('output', null, fmt(val));
    inp.addEventListener('input', () => { set(Number(inp.value)); out.textContent = fmt(Number(inp.value)); stage?.refresh(); readout(); });
    return { el: h('label', { class: 'r3-sl' }, h('span', null, label), inp, out), inp, out };
  };
  const tauS = slider('Time in one cycle', 0, 0.999, 0.001, src.tau, (v) => { src.tau = v; setPlaying(false); }, (v) => `${f1(v * periodUs(src.fKhz))} µs`);
  const tauIn = tauS.inp;
  const playBtn = h('button', { type: 'button', class: 'btn sm primary' }, 'Pause') as HTMLButtonElement;
  const setPlaying = (p: boolean) => { playing = p; playBtn.textContent = p ? 'Pause' : 'Play'; playBtn.setAttribute('aria-pressed', String(p)); if (p) loop.kick(); };
  playBtn.addEventListener('click', () => setPlaying(!playing));
  const rateS = slider('Droplets', 40, 100, 5, src.fKhz, (v) => { src.fKhz = v; }, (v) => `${v} kHz`);
  const speedS = slider('Speed', 60, 120, 5, src.vMs, (v) => { src.vMs = v; }, (v) => `${v} m/s`);

  // ---------------------------------------------------------------- the scanner
  const optBtns = OPTICS.map((o) => {
    const b = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': String(o === optics) }, o.name) as HTMLButtonElement;
    b.addEventListener('click', () => { optics = o; optBtns.forEach((x, i) => x.setAttribute('aria-pressed', String(OPTICS[i] === o))); stage?.refresh(); readout(); });
    return b;
  });
  const reflS = slider('Mirror reflectivity', 0.6, 0.72, 0.01, refl, (v) => { refl = v; }, (v) => `${Math.round(v * 100)} %`);

  function readout(): void {
    let rows: [string, string][];
    if (scene === 'source') {
      const sp = spacingMm(src.vMs, src.fKhz), m = mainAt(src), t = src.tau, pIf = powerAtIf(20), need = onTargetNeeded(20, 200);
      chip.textContent = t < m ? (t < 0.04 ? 'Pre-pulse' : 'The target falls to the focus') : t - m < 0.25 ? 'Main pulse: plasma, 13.5 nm light' : 'Next droplet';
      chip.className = `r3-chip ${t >= m && t - m < 0.25 ? 'warn' : ''}`;
      rows = [
        ['Droplets', `${src.fKhz} kHz at ${src.vMs} m/s: ${sp.toFixed(2)} mm apart, one every ${f1(periodUs(src.fKhz))} µs`],
        ['Shown', `${groupDigits(SLOW)} times slower`],
        ['Conversion (in band, into 2π)', pc(CHAIN.ce)],
        ['Collected', `${CHAIN.sr} sr of 2π (${pc(CHAIN.sr / (2 * Math.PI))}), the rim at ${RIM_DEG.toFixed(0)}°`],
        ['Collector reflectivity', `${pc(CHAIN.rColl)} (at best)`],
        ['Hydrogen absorbs', pc(CHAIN.gasAbs)],
        ['20 kW of laser, all on target', `${pIf.toFixed(0)} W at the intermediate focus`],
        ['For the published 200 W', `${pc(need)} of the laser must land on the target (not published)`],
      ];
      side.replaceChildren('The power chain ', h('span', { class: 'r3-badge' }, 'model'));
    } else {
      const o = optics, tr = transmission(refl, REFLECTIONS), mh = maskHalfDeg(o.na, o.mScan), ok = conesApart(o.na, o.mScan), [ms, ml] = maskField(o);
      chip.textContent = ok ? `${pc(tr)} of the light reaches the wafer` : 'The cones at the mask overlap: this does not work';
      chip.className = `r3-chip ${ok ? '' : 'bad'}`;
      rows = [
        ['Reflections, IF to wafer', `${REFLECTIONS}: 3 in the illuminator (derived), the mask, 6 projecting`],
        ['Light left', `${pc(refl)} each: ${pc(transmission(refl, 1))} after one, ${pc(transmission(refl, 5))} after five, ${pc(tr)} after ten`],
        ['250 W at the intermediate focus', `${f1(250 * tr)} W at the wafer`],
        ['Half-pitch k₁ · λ / NA', `0.3 · ${LAMBDA_NM} nm / ${o.na} = ${halfPitchNm(0.3, LAMBDA_NM, o.na).toFixed(1)} nm`],
        ['Cone at the wafer', `${waferHalfDeg(o.na).toFixed(1)}° half-angle`],
        ['Cones at the mask', `${mh.toFixed(1)}° each about chief rays ${CRA_DEG}° off the normal: ${ok ? 'apart' : 'overlapping'}`],
        ['Field', `${ml} × ${ms} mm on the mask → ${o.field[1]} × ${o.field[0]} mm on the wafer (× ${o.mScan} along the scan, × ${o.mSlit} across)`],
      ];
      side.replaceChildren('The light’s path ', h('span', { class: 'r3-badge' }, 'model'));
    }
    kv.replaceChildren(...rows.flatMap(([k, v]) => [h('span', null, k), h('span', { class: 'v' }, v)]));
  }

  function mount(): void {
    stage?.destroy();
    const isSrc = scene === 'source';
    stage = studioStage({
      aria: isSrc
        ? 'An EUV light source in 3D, cut in half: a CO2 laser comes through a hole in an ellipsoidal mirror and strikes tin droplets at its focus; the mirror brings the 13.5 nm light to an intermediate focus'
        : 'An EUV scanner’s optical path in 3D: from the intermediate focus through three illuminator mirrors onto the mask, then six projection mirrors down to the wafer',
      home: isSrc ? SRC_HOME : SCAN_HOME, homeFrame: isSrc ? SRC_FRAME : SCAN_FRAME, aspect: isSrc ? 1.7 : 1.3,
      limits: isSrc ? { minDist: 0.6, maxDist: 6000 } : { minDist: 200, maxDist: 8000 },
      knobs: isSrc ? { cut: 1 } : undefined,
      // the vessel's far half would wall the view in: shown with the hydrogen it holds (the last beat)
      hidden: isSrc ? ['vessel'] : undefined,
      scaleBar: (l) => (l < 1 ? `${Math.round(l * 1000)} µm` : l < 1000 ? `${+l.toFixed(2)} mm` : `${+(l / 1000).toFixed(2)} m`),
      onBeat: isSrc ? (i) => {
        const m = mainAt(src);
        if (i <= 1) { setPlaying(!reducedMotion()); return; }
        setPlaying(false);
        src.tau = i === 2 ? m * 0.7 : i === 3 ? m + 0.004 : m + 0.03;
        tauIn.value = String(src.tau); stage?.refresh(); readout();
      } : undefined,
      note: isSrc
        ? `Schematic: the vessel, the collector’s size and the distance to the intermediate focus (not published); the collector is an exact ellipsoid subtending the published 5 sr, and every ray drawn goes from one focus by the mirror to the other. To scale: the droplets (30 µm, 1.5 mm apart at 50 kHz and 75 m/s, after Fomenkov et al., Adv. Opt. Techn. 2017) and the 400 µm target. Illustrative: the ${3} µs delay from pre-pulse to main pulse. The plasma’s glow and the beams are drawn far wider than they are; 13.5 nm and 10.6 µm are both invisible.`
        : 'Schematic: the mirrors’ positions, sizes and shapes (an illustration of the path, not a design). True: ten reflections from the intermediate focus to the wafer (Fomenkov et al. 2017), six of them projection mirrors (ASML), so three in the illuminator (derived); the chief ray 6° off the mask’s normal (quoted for the 0.33 NA tools); the cones’ half-angles; the mask (152 mm, SEMI P37) and the fields (ASML) to scale with each other. A beam’s cross-section is drawn in proportion to the power left on it (its glow to that power to the 0.4, so the last segments still show).',
      build: (detail) => (isSrc ? sourceModel(src, detail) : scannerModel({ optics, r: refl }, detail)),
    });
    stage.chips.append(chip);
    ctl.replaceChildren(...(isSrc
      ? [h('div', { class: 'r3-btns' }, playBtn), tauS.el, rateS.el, speedS.el]
      : [h('div', { class: 'seg euv-seg', role: 'group', 'aria-label': 'Optics' }, ...optBtns), reflS.el]));
    stage.slot.append(ctl);
    host.replaceChildren(stage.el);
    sceneBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.scene === scene)));
    readout();
    if (isSrc) setPlaying(playing);
  }

  const sceneBtns = (['source', 'scanner'] as const).map((k) => {
    const b = h('button', { type: 'button', class: 'btn sm', 'data-scene': k }, k === 'source' ? 'The light source' : 'The scanner') as HTMLButtonElement;
    b.addEventListener('click', () => { if (scene !== k) { scene = k; mount(); } });
    return b;
  });
  panel.append(
    h('h3', { class: 'm3-title' }, 'Extreme ultraviolet'),
    h('p', { class: 'm3-sub' }, '13.5 nm light is absorbed by every lens and by air, so it is made in a vacuum vessel and handled only by mirrors. The source makes it by turning falling drops of tin into plasma with a laser; the scanner carries it over ten mirrors, the mask among them, down to the wafer, losing a third at every bounce.'),
    h('div', { class: 'seg euv-seg', role: 'group', 'aria-label': 'Scene' }, ...sceneBtns),
    h('div', { class: 'r3' }, h('div', { class: 'r3-main' }, host), h('div', { class: 'r3-side' }, side, kv)));
  mount();
  return { el: panel, destroy() { loop.stop(); stage?.destroy(); } };
}
