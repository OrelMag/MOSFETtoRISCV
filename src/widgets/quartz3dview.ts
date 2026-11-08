// The watch crystal and its Pierce oscillator in 3D (loaded on demand, modelhost.ts). The numbers (fork size from beam
// theory, temperature curve, load capacitance, the ÷2^15 chain) are quartz3dparts.ts's; the motion is a drawing: the tine
// swing is exaggerated and time is slowed by a stated factor.

import '../styles/quartz3d.css';
import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { frameLoop } from './mosfet';
import { modelStage } from './modelstage';
import {
  boardAnchors, boardParts, crystalAnchors, crystalParts, DIVIDE, F_WATCH, freqAt, loadCap, loaded, PIERCE, Q_FORK, ringTau, secPerDay, STAGES,
  stageBits, stageFreq, tempPpm, TINE_L, TINE_W, TIP_DRAWN, WAFER_T, type QuartzPalette,
} from './quartz3dparts';

const SHOWN_HZ = 2; // the crystal view draws the fork at this many swings a second
const HALF = DIVIDE / 2;
const thin = (s: string): string => s.replace(/,/g, ' ');
const grp = (x: number): string => thin(Math.round(x).toLocaleString('en-US'));
const hz = (f: number): string => (f >= 1000 ? `${(f / 1000).toFixed(3)} kHz` : f >= 10 ? `${f.toFixed(2)} Hz` : `${f.toFixed(4)} Hz`);
const cur = (f: number): string => (f >= 1e4 ? thin(f.toLocaleString('en-US', { maximumFractionDigits: 1 })) : f >= 10 ? f.toFixed(1) : f.toFixed(2));

export function quartzView(): Widget {
  let view: 'crystal' | 'loop' = 'crystal', n = 0, running = false, lid = false, temp = 25, rateExp = 6;
  const panel = h('div', { class: 'panel' });
  const CRYSTAL = { target: [-2, 3, 0] as [number, number, number], yaw: 0.2, pitch: 1.15, dist: 36 };
  const LOOP = { target: [1, 0, -2] as [number, number, number], yaw: 0.2, pitch: 0.85, dist: 78 };
  const stage = modelStage(panel, {
    aria: 'A 32 768 hertz quartz tuning fork in its ceramic package, and the Pierce oscillator and fifteen-stage divider around it',
    camera: CRYSTAL,
    limits: { minDist: 12, maxDist: 160 },
    note: `Drawn, not modelled: a tine swings ${(TIP_DRAWN / 10).toFixed(2)} mm here (a real tine moves far less than a micrometre, so at least a hundred times less); the fork is drawn at ${SHOWN_HZ} swings a second, ${grp(F_WATCH / SHOWN_HZ)} times slower than real; the tine length comes from a plain beam formula, and a real fork has grooves in its tines.`,
    draw: () => paint(),
  });
  const palette = (): QuartzPalette => ({
    quartz: stage.rgba('--qz-quartz', 0.5), gold: stage.rgb('--qz-gold'), ceramic: stage.rgb('--qz-ceramic'), pad: stage.rgb('--qz-gold'), glue: stage.rgb('--qz-glue'),
    lid: stage.rgba('--qz-lid', 0.28), plus: stage.rgb('--qz-plus'), minus: stage.rgb('--qz-minus'), pcb: stage.rgb('--qz-pcb'), copper: stage.rgb('--qz-copper'),
    body: stage.rgb('--qz-body'), chip: stage.rgb('--qz-chip'), led: stage.rgb('--qz-led'), ledOff: stage.rgb('--qz-led-off'), metal: stage.rgb('--m3-metal'),
  });
  const rate = (): number => (view === 'crystal' ? SHOWN_HZ : 2 ** rateExp);
  // The swing follows the cycle count's fraction; under reduced motion it jumps between its two extremes, one per cycle.
  const disp = (): number => (reducedMotion() ? (Math.floor(n) % 2 === 0 ? 1 : -1) : Math.cos(2 * Math.PI * n));
  function paint(): void {
    const d = disp();
    if (view === 'crystal') stage.paint(crystalParts({ disp: d, lid }, palette()), crystalAnchors({ disp: d, lid }));
    else stage.paint(boardParts({ bits: stageBits(Math.floor(n)), vib: d }, palette()), boardAnchors());
  }

  const chip = h('span', { class: 'r3-chip' }), kv = h('div', { class: 'r3-kv' }), live = h('div', { class: 'sr-only', 'aria-live': 'polite' });
  stage.chips.append(chip);
  let spoken = '';
  function readout(): void {
    const f = freqAt(temp), ppm = tempPpm(temp), bits = stageBits(Math.floor(n)), CL = loadCap(PIERCE.c, PIERCE.c, PIERCE.cs);
    const out = f / DIVIDE, cycles = Math.floor(n);
    chip.textContent = view === 'crystal' ? `drawn at ${SHOWN_HZ} Hz, real ${grp(F_WATCH)} Hz` : `${grp(cycles)} cycles, 1 Hz output ${bits[STAGES - 1] ? 'high' : 'low'}`;
    chip.className = `r3-chip ${view === 'loop' && bits[STAGES - 1] ? 'good' : ''}`;
    const rows: [string, string][] = view === 'crystal'
      ? [
        ['Mode', 'flexural: tines bend in antiphase'],
        ['Tine', `${TINE_L.toFixed(2)} × ${TINE_W} × ${WAFER_T} mm`],
        ['Package', '3.2 × 1.5 × 0.8 mm (Epson FC-135)'],
        [`At ${temp} °C`, `${cur(f)} Hz (${ppm.toFixed(1)} ppm)`],
        ['Clock error', `${secPerDay(ppm).toFixed(2)} s a day`],
        ['Q', `${grp(Q_FORK)} (datasheets 3×10⁴ – 9×10⁴)`],
        ['Ring-down τ', `${ringTau().toFixed(2)} s, ${grp(ringTau() * F_WATCH)} swings`],
      ]
      : [
        ['Load CL', `${(CL * 1e12).toFixed(1)} pF (15 pF in series with 15 pF, + 1.5 pF stray)`],
        ['Pulled to', `${cur(loaded(CL))} Hz from fs 32 764.4 Hz`],
        [`At ${temp} °C`, `${cur(f)} Hz`],
        ['Stage 1 (÷2)', hz(stageFreq(0, f))],
        ['Stage 8 (÷256)', hz(stageFreq(7, f))],
        ['Stage 15 (÷2¹⁵)', `${hz(out)}, period ${(1 / out).toFixed(5)} s`],
        ['Counting at', `${cur(rate())} cycles/s (${rate() >= F_WATCH ? 'real time' : `${grp(F_WATCH / rate())}× slower than real`})`],
      ];
    kv.replaceChildren(...rows.flatMap(([k, v]) => [h('span', null, k), h('span', { class: 'v' }, v)]));
    out_.textContent = view === 'crystal' ? `${SHOWN_HZ}` : cur(rate());
    slider.disabled = view === 'crystal';
    runBtn.textContent = running ? 'Pause' : 'Run';
    lidBtn.style.display = view === 'crystal' ? '' : 'none';
    skip.style.display = view === 'loop' ? '' : 'none';
    tabs.forEach((b, k) => b.setAttribute('aria-pressed', String((k === 0) === (view === 'crystal'))));
    const say = view === 'loop' ? `${grp(cycles)} cycles of the crystal, divider output ${bits[STAGES - 1] ? 'high' : 'low'}` : '';
    if (say !== spoken && !running) { spoken = say; live.textContent = say; }
  }

  const loop = frameLoop((_now, dt) => {
    if (running) n += rate() * dt;
    readout(); paint();
  }, () => running && !reducedMotion());
  const repaint = () => { readout(); paint(); loop.kick(); };

  const mk = (label: string, aria: string, fn: () => void) => {
    const b = h('button', { type: 'button', class: 'btn sm', 'aria-label': aria }, label) as HTMLButtonElement;
    b.addEventListener('click', fn);
    return b;
  };
  const tabs = [
    mk('Inside the crystal', 'Show the tuning fork inside its package', () => setView('crystal')),
    mk('The oscillator', 'Show the Pierce oscillator loop and the divider chain', () => setView('loop')),
  ];
  function setView(v: 'crystal' | 'loop'): void {
    view = v;
    stage.setView(v === 'crystal' ? CRYSTAL : LOOP);
    repaint();
  }
  const runBtn = mk('Run', 'Run or pause the crystal', () => {
    if (reducedMotion()) { running = false; n = Math.floor(n) + 1; repaint(); return; } // a calm Run: one cycle a press
    running = !running;
    repaint();
  });
  const step = mk('Step', 'Advance one cycle of the crystal', () => { running = false; n = Math.floor(n) + 1; repaint(); });
  const skip = mk('Skip ½ s', 'Advance to the next half second: the 1 hertz output changes', () => { running = false; n = (Math.floor(n / HALF) + 1) * HALF; repaint(); });
  const reset = mk('Reset', 'Reset the divider to zero', () => { running = false; n = 0; repaint(); });
  const lidBtn = mk('Lid', 'Show or hide the package lid', () => { lid = !lid; repaint(); });
  const slider = h('input', { type: 'range', min: 0, max: STAGES, step: 1, value: rateExp, 'aria-label': 'Counting rate in cycles of the crystal per second, a power of two' }) as HTMLInputElement;
  const out_ = h('output', null, '');
  slider.addEventListener('input', () => { rateExp = Number(slider.value); repaint(); });
  const tsl = h('input', { type: 'range', min: -10, max: 60, step: 1, value: temp, 'aria-label': 'Temperature in degrees Celsius' }) as HTMLInputElement;
  const tout = h('output', null, `${temp} °C`);
  tsl.addEventListener('input', () => { temp = Number(tsl.value); tout.textContent = `${temp} °C`; repaint(); });

  panel.append(
    h('h3', { class: 'm3-title' }, 'The quartz crystal oscillator'),
    h('p', { class: 'm3-sub' }, 'A watch crystal is a tuning fork cut from quartz, ringing at 32 768 Hz in a flexural mode: two tines bend toward and away from each other in antiphase, gold films on them turn bending into charge (piezoelectricity) and the field back into bending. It is not a disc between two plates: a thickness-shear AT-cut blank is a different crystal, in the MHz (16 MHz takes a blank 0.104 mm thick, f ∝ 1/thickness). The inverter, a 10 MΩ feedback resistor and two 15 pF capacitors keep the fork ringing (a Pierce oscillator), and fifteen divide-by-two stages count it down: 2¹⁵ = 32 768, so the last one beats at exactly 1 Hz. The error is a parabola in temperature, −0.034 ppm/°C² about 25 °C: try 45 °C.'),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' },
        h('div', { class: 'r3-ctl' }, h('div', { class: 'qz-seg', role: 'group', 'aria-label': 'View' }, ...tabs),
          h('div', { class: 'r3-btns' }, runBtn, step, skip, reset, lidBtn, stage.resetBtn)),
        h('div', { class: 'r3-ctl' },
          h('label', { class: 'r3-sl qz-sl' }, h('span', null, 'Rate'), slider, out_),
          h('label', { class: 'r3-sl qz-sl' }, h('span', null, 'Temp'), tsl, tout)),
        stage.el, stage.hint, live),
      h('div', { class: 'r3-side' }, h('h4', null, 'This crystal ', h('span', { class: 'r3-badge' }, 'model')), kv)));
  readout();
  paint();
  return { el: panel, destroy() { loop.stop(); stage.destroy(); } };
}
