// The watch crystal and its Pierce oscillator in 3D (loaded on demand, modelhost.ts). The numbers (fork size from beam
// theory, temperature curve, load capacitance, the ÷2^15 chain) are quartz3dparts.ts's; the motion is a drawing: the tine
// swing is exaggerated and time is slowed by a stated factor.

import '../styles/quartz3d.css';
import { h } from '../ui/dom';
import { groupNum } from '../sim/numfmt';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { frameLoop } from './mosfet';
import { modelStage } from './modelstage';
import {
  boardAnchors, boardParts, crystalAnchors, crystalParts, DIVIDE, driftAnchors, driftOf, realPerScreen, screenSlip, SLIP_S, driftParts, driveCurrent, DRIVE_W, F_WATCH, fmtTime, freqAt, inWindow,
  loadCap, loaded, PIERCE, Q_FORK, ringTau, secPerDay, STAGES, stageBits, stageFreq, tempPpm, TINE_L, TINE_W, tipAmplitude, TIP_DRAWN, TOL_PPM, WAFER_T,
  type QuartzPalette,
} from './quartz3dparts';

const SHOWN_HZ = 2; // the crystal view draws the fork at this many swings a second
const HALF = DIVIDE / 2;
const F_FAST = 200e6; // the step's quiz: two 200 MHz clocks
const sgnPpm = (x: number): string => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(1)} ppm`;
// The site's digit rule (sim/numfmt.ts): grouped by U+202F only from five digits.
const grp = (x: number): string => groupNum(Math.round(x));
const F_WATCH_TXT = groupNum(F_WATCH);
const hz = (f: number): string => (f >= 1000 ? `${(f / 1000).toFixed(3)} kHz` : f >= 10 ? `${f.toFixed(2)} Hz` : `${f.toFixed(4)} Hz`);
const cur = (f: number): string => (f >= 1e4 ? groupNum(Math.round(f * 10) / 10) : f >= 10 ? f.toFixed(1) : f.toFixed(2));

export function quartzView(): Widget {
  let view: 'crystal' | 'loop' | 'drift' = 'crystal', n = 0, running = false, lid = false, temp = 25, rateExp = 6;
  // Two crystals (view 'drift'): A is the one the other views show. Tolerances in ppm at 25 °C, B's own temperature, the clock they are scaled to,
  // and the phase B has gained on A in cycles (the ring), advanced SLIP_S of screen time per slip cycle.
  let tolA = TOL_PPM, tolB = -TOL_PPM, tempB = 25, fast = false, slip = 0;
  const panel = h('div', { class: 'panel' });
  const CRYSTAL = { target: [-2, 3, 0] as [number, number, number], yaw: 0.2, pitch: 1.15, dist: 36 };
  const LOOP = { target: [1, 0, -2] as [number, number, number], yaw: 0.2, pitch: 0.85, dist: 78 };
  const DRIFT = { target: [0, 0, 1] as [number, number, number], yaw: 0.2, pitch: 1.1, dist: 108 };
  // A phone-width canvas (the stage's own container query, 480 px): the oscillator board closer, its LEDs larger.
  const narrow = (): boolean => stage.el.clientWidth > 0 && stage.el.clientWidth < 480;
  const loopCam = () => (narrow() ? { ...LOOP, dist: 60 } : LOOP);
  const driftCam = () => (narrow() ? { ...DRIFT, target: [0, 0, 6] as [number, number, number], dist: 78 } : DRIFT);
  const stage = modelStage(panel, {
    aria: 'A 32768 hertz quartz tuning fork in its ceramic package, and the Pierce oscillator and fifteen-stage divider around it',
    camera: CRYSTAL,
    limits: { minDist: 12, maxDist: 160 },
    note: `Drawn, not modelled: a tine swings ${(TIP_DRAWN / 10).toFixed(2)} mm here (estimated from a 0.1 µW drive level and Q = 50 000, a real tine moves about ${(tipAmplitude() * 1e6).toFixed(0)} µm, ${Math.round(TIP_DRAWN * 100 / (tipAmplitude() * 1e6))} times less); the fork is drawn at ${SHOWN_HZ} swings a second, ${grp(F_WATCH / SHOWN_HZ)} times slower than real; the tine length comes from a plain beam formula, the groove width and depth are drawn choices inside the ranges of the tuning-fork patents, the package is vacuum sealed under a metal lid (the lid is drawn clear so that you can see in) with two pads underneath. In the two-crystals view each fork swings at the same drawn rate and the ring is slowed by one fixed factor, so it turns at the difference: 40 ppm apart is one turn in ${SLIP_S} s of screen time, 20 ppm apart one in ${2 * SLIP_S} s, equal clocks stand still; a 200 MHz clock is a multiple of its crystal, so its ppm are the crystal's. In the oscillator view the divider counts at the Rate shown (cycles of the crystal a second, up to the real ${F_WATCH_TXT}), the fork swings at that rate, and the inverter, the fifteen stages and the parts around them are drawn as boxes, not as their gates.`,
    draw: () => paint(),
  });
  const palette = (): QuartzPalette => ({
    quartz: stage.rgba('--qz-quartz', 0.5), gold: stage.rgb('--qz-gold'), ceramic: stage.rgb('--qz-ceramic'), pad: stage.rgb('--qz-gold'), glue: stage.rgb('--qz-glue'),
    lid: stage.rgba('--qz-lid', 0.28), plus: stage.rgb('--qz-plus'), minus: stage.rgb('--qz-minus'), pcb: stage.rgb('--qz-pcb'), copper: stage.rgb('--qz-copper'),
    body: stage.rgb('--qz-body'), chip: stage.rgb('--qz-chip'), led: stage.rgb('--qz-led'), ledOff: stage.rgb('--qz-led-off'), metal: stage.rgb('--m3-metal'),
  });
  const dHz = (): number => driftOf(fast ? F_FAST : F_WATCH, tolA, temp, tolB, tempB).dHz;
  const rate = (): number => (view === 'crystal' ? SHOWN_HZ : 2 ** rateExp);
  // The swing follows the cycle count's fraction; under reduced motion it jumps between its two extremes, one per cycle.
  const disp = (): number => (reducedMotion() ? (Math.floor(n) % 2 === 0 ? 1 : -1) : Math.cos(2 * Math.PI * n));
  function paint(): void {
    const d = disp();
    if (view === 'crystal') stage.paint(crystalParts({ disp: d, lid }, palette()), crystalAnchors({ disp: d, lid }));
    else if (view === 'drift') stage.paint(driftParts({ disp: d, dispB: reducedMotion() ? -d : Math.cos(2 * Math.PI * (n + slip)), slip }, palette()), driftAnchors(slip, narrow()));
    else stage.paint(boardParts({ bits: stageBits(Math.floor(n)), vib: d, big: narrow() }, palette()), boardAnchors());
  }

  const chip = h('span', { class: 'r3-chip' }), kv = h('div', { class: 'r3-kv' }), live = h('div', { class: 'sr-only', 'aria-live': 'polite' });
  stage.chips.append(chip);
  let spoken = '';
  function readout(): void {
    const f = freqAt(temp, F_WATCH, tolA), ppm = tempPpm(temp) + tolA, bits = stageBits(Math.floor(n)), CL = loadCap(PIERCE.c, PIERCE.c, PIERCE.cs);
    const out = f / DIVIDE, cycles = Math.floor(n);
    const fN = fast ? F_FAST : F_WATCH, dr = driftOf(fN, tolA, temp, tolB, tempB), hit = inWindow(slip);
    chip.textContent = view === 'drift' ? (hit ? "B's edge is inside A's window" : `phase of B on A: ${(((slip % 1) + 1) % 1).toFixed(2)} cycle`) : view === 'crystal' ? `drawn at ${SHOWN_HZ} Hz, real ${grp(F_WATCH)} Hz` : `${grp(cycles)} cycles, 1 Hz output ${bits[STAGES - 1] ? 'high' : 'low'}`;
    chip.className = `r3-chip ${(view === 'loop' && bits[STAGES - 1]) || (view === 'drift' && !hit) ? 'good' : ''}`;
    const rows: [string, string][] = view === 'drift'
      ? [
        ['Clock', fast ? '200 MHz from a crystal' : `${F_WATCH_TXT} Hz fork`],
        ['A', `${tolA >= 0 ? '+' : '−'}${Math.abs(tolA)} ppm at 25 °C, ${temp} °C: ${sgnPpm(ppm)}`],
        ['B', `${tolB >= 0 ? '+' : '−'}${Math.abs(tolB)} ppm at 25 °C, ${tempB} °C: ${sgnPpm(tempPpm(tempB) + tolB)}`],
        ['Relative drift', `${sgnPpm(dr.dppm)} = ${cur(Math.abs(dr.dHz))} Hz of ${fast ? '200 MHz' : F_WATCH_TXT + ' Hz'}`],
        ['One cycle of slip', dr.slipS === Infinity ? 'never: locked to each other' : `every ${fmtTime(dr.slipS)} (1 / Δf)`],
        ['Ring', dr.slipS === Infinity ? 'B stands still' : `screen: 1 s = ${fmtTime(realPerScreen(fN))}; one turn in ${(SLIP_S * 40 / Math.abs(dr.dppm)).toFixed(1)} s (40 ppm apart: ${SLIP_S} s)`],
        ['Drive level', `${DRIVE_W * 1e6} µW typ (FC-135 listing), about ${(driveCurrent() * 1e6).toFixed(1)} µA at 50 kΩ ESR`],
      ]
      : view === 'crystal'
      ? [
        ['Mode', 'flexural: tines bend in antiphase'],
        ['Tine', `${TINE_L.toFixed(2)} × ${TINE_W} × ${WAFER_T} mm`],
        ['Package', '3.2 × 1.5 × 0.8 mm (Epson FC-135)'],
        [`At ${temp} °C`, `${cur(f)} Hz (${ppm.toFixed(1)} ppm, tolerance ${sgnPpm(tolA)} included)`],
        ['Clock error', `${secPerDay(ppm).toFixed(2)} s a day`],
        ['Q', `${grp(Q_FORK)} (Epson ECX-306X minimum; others list 3×10⁴ – 9×10⁴)`],
        ['Tine tip, estimated', `${(tipAmplitude() * 1e6).toFixed(1)} µm at ${DRIVE_W * 1e6} µW`],
        ['Ring-down τ', `${ringTau().toFixed(2)} s, ${grp(ringTau() * F_WATCH)} swings`],
      ]
      : [
        ['Load CL', `${(CL * 1e12).toFixed(1)} pF (15 pF in series with 15 pF, + 1.5 pF stray)`],
        ['Pulled to', `${cur(loaded(CL))} Hz from fs ${groupNum(32764.4)} Hz`],
        [`At ${temp} °C`, `${cur(f)} Hz`],
        ['Rd', 'series with the inverter output: limits the drive level'],
        ['Stage 1 (÷2)', hz(stageFreq(0, f))],
        ['Stage 8 (÷256)', hz(stageFreq(7, f))],
        ['Stage 15 (÷2¹⁵)', `${hz(out)}, period ${(1 / out).toFixed(5)} s`],
        ['Counting at', `${cur(rate())} cycles/s (${rate() >= F_WATCH ? 'real time' : `${grp(F_WATCH / rate())}× slower than real`})`],
      ];
    kv.replaceChildren(...rows.flatMap(([k, v]) => [h('span', null, k), h('span', { class: 'v' }, v)]));
    out_.textContent = view === 'loop' ? `${cur(rate())} cycles/s` : `${SHOWN_HZ} swings/s`;
    slider.disabled = view !== 'loop';
    driftBox.style.display = view === 'drift' ? '' : 'none';
    tlab.textContent = view === 'drift' ? 'Temp A' : 'Temp';
    tolLab.style.display = view === 'loop' ? 'none' : '';
    tolLab.firstChild!.textContent = view === 'drift' ? 'Tol. A' : 'Tolerance';
    tolOut.textContent = sgnPpm(tolA);
    runBtn.textContent = running ? 'Pause' : 'Run';
    lidBtn.style.display = view === 'crystal' ? '' : 'none';
    skip.style.display = view === 'loop' ? '' : 'none';
    tabs.forEach((b, k) => b.setAttribute('aria-pressed', String(k === ['crystal', 'loop', 'drift'].indexOf(view))));
    tbOut.textContent = `${tempB} °C`; tboutB.textContent = sgnPpm(tolB); freqBtn.textContent = fast ? '200 MHz' : '32 768 Hz';
    const say = view === 'loop' ? `${grp(cycles)} cycles of the crystal, divider output ${bits[STAGES - 1] ? 'high' : 'low'}` : '';
    if (say !== spoken && !running) { spoken = say; live.textContent = say; }
  }

  const loop = frameLoop((_now, dt) => {
    if (running) { n += rate() * dt; if (view === 'drift') slip += screenSlip(fast ? F_FAST : F_WATCH, dHz()) * dt; }
    readout(); paint();
  }, () => running && !reducedMotion());
  const repaint = () => { readout(); paint(); loop.kick(); };

  const mk = (label: string, aria: string, fn: () => void) => {
    const b = h('button', { type: 'button', class: 'btn sm', 'aria-label': aria }, label) as HTMLButtonElement;
    b.addEventListener('click', fn);
    return b;
  };
  const tabs = [
    mk('Crystal', 'Show the tuning fork inside its package', () => setView('crystal')),
    mk('Oscillator', 'Show the Pierce oscillator loop and the divider chain', () => setView('loop')),
    mk('Two crystals', 'Show two crystals with their own tolerance and temperature, and the phase between their clocks', () => setView('drift')),
  ];
  function setView(v: 'crystal' | 'loop' | 'drift'): void {
    view = v;
    stage.setView(v === 'crystal' ? CRYSTAL : v === 'loop' ? loopCam() : driftCam());
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
  const tlab = h('span', null, 'Temp');
  const mkTol = (label: string, get: () => number, set: (v: number) => void, aria: string) => {
    const sl = h('input', { type: 'range', min: -TOL_PPM, max: TOL_PPM, step: 1, value: get(), 'aria-label': aria }) as HTMLInputElement, o = h('output', null, '');
    sl.addEventListener('input', () => { set(Number(sl.value)); repaint(); });
    return { lab: h('label', { class: 'r3-sl qz-sl' }, h('span', null, label), sl, o) as HTMLElement, o };
  };
  const ta = mkTol('Tolerance', () => tolA, (v) => { tolA = v; }, 'Crystal A initial frequency tolerance in parts per million, at 25 degrees; the Epson FC-135 is plus or minus 20');
  const tb = mkTol('Tol. B', () => tolB, (v) => { tolB = v; }, 'Crystal B initial frequency tolerance in parts per million');
  const tolLab = ta.lab, tolOut = ta.o, tboutB = tb.o;
  const tbs = h('input', { type: 'range', min: -10, max: 60, step: 1, value: tempB, 'aria-label': 'Crystal B temperature in degrees Celsius' }) as HTMLInputElement;
  const tbOut = h('output', null, '');
  tbs.addEventListener('input', () => { tempB = Number(tbs.value); repaint(); });
  const freqBtn = mk('', 'Switch the nominal clock between a 32768 hertz watch crystal and a 200 megahertz clock', () => { fast = !fast; repaint(); });
  // Predict first: the step's quiz numbers. Two 200 MHz clocks, +20 and −20 ppm: 40 ppm apart = 8 kHz, one cycle of slip in 125 µs.
  const PRED = driftOf(F_FAST, TOL_PPM, 25, -TOL_PPM, 25).slipS;
  const predOut = h('p', { class: 'qz-pred-out', 'aria-live': 'polite' });
  const predBtns = [PRED / 10, PRED, PRED * 10].map((t) => {
    const b = h('button', { type: 'button', class: 'btn sm' }, fmtTime(t)) as HTMLButtonElement;
    b.addEventListener('click', () => {
      predOut.textContent = t === PRED
        ? `Yes, ${fmtTime(PRED)}: 200 MHz × 40 ppm = 8 kHz of slip, and one cycle of slip takes 1 / 8 kHz. Now drag the tolerances: the ring turns at the difference, not at either.`
        : `Not ${fmtTime(t)}. 40 ppm of 200 MHz is 8 kHz, so a cycle of slip takes 1 / 8 kHz = ${fmtTime(PRED)}. Set the clock to 200 MHz to read it in the panel.`;
    });
    return b;
  });
  const driftBox = h('div', { class: 'qz-drift' },
    h('p', { class: 'qz-pred' }, 'Predict: two 200 MHz clocks from separate crystals, one at +20 ppm and one at −20 ppm. How long until their phase has gone round once? ', ...predBtns),
    predOut,
    h('div', { class: 'r3-ctl' }, h('label', { class: 'r3-sl qz-sl' }, h('span', null, 'Clock'), freqBtn), tb.lab, h('label', { class: 'r3-sl qz-sl' }, h('span', null, 'Temp B'), tbs, tbOut)));

  panel.append(
    h('h3', { class: 'm3-title' }, 'The quartz crystal oscillator'),
    h('p', { class: 'm3-sub' }, `A watch crystal is a tuning fork cut from quartz, ringing at ${F_WATCH_TXT} Hz in a flexural mode: two tines bend toward and away from each other in antiphase, gold films on them turn bending into charge (piezoelectricity) and the field back into bending. It is not a disc between two plates: a thickness-shear AT-cut blank is a different crystal, in the MHz (16 MHz takes a blank 0.104 mm thick, f ∝ 1/thickness). The inverter, a 10 MΩ feedback resistor and two 15 pF capacitors keep the fork ringing (a Pierce oscillator), and fifteen divide-by-two stages count it down: 2¹⁵ = ${F_WATCH_TXT}, so the last one beats at exactly 1 Hz. The error is a parabola in temperature, −0.034 ppm/°C² about 25 °C (try 45 °C), on top of an initial tolerance of ±20 ppm for a part like the Epson FC-135. Two such crystals are two clocks: the Two crystals view shows the phase between them going round.`),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' },
        h('div', { class: 'r3-ctl' }, h('div', { class: 'qz-seg', role: 'group', 'aria-label': 'View' }, ...tabs),
          h('div', { class: 'r3-btns' }, runBtn, step, skip, reset, lidBtn, stage.resetBtn)),
        h('div', { class: 'r3-ctl' },
          h('label', { class: 'r3-sl qz-sl' }, h('span', null, 'Rate'), slider, out_),
          tolLab, h('label', { class: 'r3-sl qz-sl' }, tlab, tsl, tout)),
        stage.el, driftBox, stage.hint, live),
      h('div', { class: 'r3-side' }, h('h4', null, 'This crystal ', h('span', { class: 'r3-badge' }, 'model')), kv)));
  readout();
  paint();
  return { el: panel, destroy() { loop.stop(); stage.destroy(); } };
}
