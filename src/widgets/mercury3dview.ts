// EDSAC's mercury delay line in 3D on the studio renderer (loaded on demand, modelhost.ts; drawn by mercury3dkit.ts). The tube, its length, the sound speed, the slot and the
// 576 slots are mercury3dparts.ts's figures (the 1948 report's, delay = length / speed); the pulses move at the real sound
// speed and spacing, slowed by a stated factor. What is drawn rather than modelled is in the note below the stage.

import '../styles/mercury3d.css';
import { h } from '../ui/dom';
import { groupNum } from '../sim/numfmt';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import type { OrbitView } from '../gl/camera';
import { frameLoop } from './mosfet';
import { packInstances } from '../gl/instances';
import { studioStage } from './studiostage';
import { BAND_GEO, BAND_MAT, HG_VIEWS, PULSE_GEO, PULSE_MAT, bandInstances, mercuryModel, pulseInstances, shownKey } from './mercury3dkit';
import {
  CARRIER_HZ, CUT_LENGTH_M, LENGTH_M, OD_M, ROW_HIT_S, SLOTS, SLOTS_PER_WORD, SOUND_M_S, TANKS, TANK_C, Tank, WINDOW_TOL, WORDS, bitsInTank,
  carrierCycles, circulationHz, delayS, dramRatio, histogram, inWindow, meanWaitS, offsetSlots, pulseLengthM,
  randomWaits, rateHz, reportTubeDelayS, slotPitchM, slotS, soundAt, storeLongWords, tubeDelayAt, MAX35, initialWord,
} from './mercury3dparts';

/** Slowdown choices: how many times slower than the real thing the pulses move on screen. */
const SLOWS = [2000, 20000] as const;
const VIEWS = HG_VIEWS;
/** A phone is narrow and the tube is 64 times longer than wide: stand further back. */
const narrow = () => typeof matchMedia === 'function' && matchMedia('(max-width: 600px)').matches;
const wholeView = (): OrbitView => (narrow() ? { ...VIEWS.whole, dist: 340 } : { ...VIEWS.whole } as OrbitView);
/** On a phone the 64:1 tube is a thin strip: open on the sending end, where pulses and crystal are large enough to see. */
const startKey = (): keyof typeof VIEWS => (narrow() ? 'tx' : 'whole');
const startView = (): OrbitView => (startKey() === 'whole' ? wholeView() : { ...VIEWS[startKey()] } as OrbitView);
const BINS = 8;
const PREDICT = ['first quarter (0 to 0.29 ms)', 'second quarter', 'third quarter', 'last quarter (to 1.15 ms)'];
const VIEW_NAMES: Record<keyof typeof VIEWS, string> = { whole: 'Whole tank', rx: 'Receiving end', tx: 'Sending end' };
const us = (s: number) => `${(s * 1e6).toFixed(s < 1e-4 ? 1 : 0)} µs`;
const ms = (s: number) => `${(s * 1e3).toFixed(3)} ms`;
const hex = (v: number) => `0x${v.toString(16).padStart(9, '0')}`;
const FT = (m: number) => { const i = Math.round(m / 0.0254), f = Math.floor(i / 12); return `${f} ft ${i - 12 * f} in`; };

export function mercuryView(): Widget {
  const tank = new Tank();
  let tempC = TANK_C, predicted = -1, reads: number[] | null = null, running = false, slow = 0, sel = 3, idle = 0, tweenFrom = 0, step: { t0: number; slots: number } | null = null, listKey = '';
  const slotsPerSec = () => rateHz() / SLOWS[slow];

  const panel = h('div', { class: 'panel hg3' });
  let ready = false, built = '';
  /** The pulses' colours (theme tokens); before the stage exists, neutral ones. */
  function colours() {
    if (!ready) return { pulse: [0.25, 0.8, 0.55] as [number, number, number], chosen: [0.3, 0.5, 0.9] as [number, number, number], band: [0.3, 0.5, 0.9] as [number, number, number] };
    return { pulse: stage.rgb('--m3-charge'), chosen: stage.rgb('--m3-dim'), band: stage.rgb('--m3-dim') };
  }
  const stage = studioStage({
    home: startView(),
    fit: false,
    // the tube is 64 times longer than wide
    aspect: narrow() ? 1.25 : 1.9,
    knobs: { cut: 1 },
    onBeat: () => instances(),
    build: (detail) => mercuryModel({ tank, sel }, narrow(), detail === 'flat' ? colours() : undefined),
    aria: 'EDSAC’s mercury delay line in 3D: a steel tube of mercury with a quartz crystal at each end, a train of pulses travelling along it, the amplifier, reshaper and gate that feed the pulses back, and fifteen more tanks in the same housing',
    limits: { minDist: 25, maxDist: 700, maxPan: 200 },
    note: `The tube’s length, slots and pulse timing are the 1948 EDSAC report’s; the speed is sound’s in mercury at 40 °C, so the crystal faces are ${CUT_LENGTH_M.toFixed(3)} m apart. The bore, crystals, housing and electronics are drawn. The pulses move ${groupNum(SLOWS[0])} times slower than real (${groupNum(SLOWS[1])} on the slow setting) and their weakening down the tube is exaggerated; the temperature slider is our model of the drift.`,
    noteMore: `Length, outside diameter, slot count and pulse timing are the 1948 report’s and the sound speed is mercury’s; the bore and wall, the crystals’ size, the housing (the report only says all tanks must be at the same temperature) with its 4 × 4 grid of tubes standing for a battery of 16, and the electronics are drawn, not modelled; the clock fixes the timing as it did in EDSAC (500 kc/s, a 2 µs slot, 576 slots = 1.152 ms) and the tube is the length that fits it: sound goes ${SOUND_M_S.toFixed(0)} m/s in mercury at 40 °C (the temperature secondary sources give for heated mercury lines; no EDSAC source we could read states it), so the crystal faces are ${CUT_LENGTH_M.toFixed(3)} m apart, ${((CUT_LENGTH_M / LENGTH_M - 1) * 100).toFixed(1)} % more than the report’s ‘approximately 5 ft 4 in’ between end blocks (the path between the crystal faces is not given: our inference). The speed and its −0.46 m/s per K slope are one handbook table’s (Karl Deutsch, ‘Sound Velocity in Liquids’), a linear fit; the backing’s material is not given, so its box is generic; the temperature slider is our model of the drift, not a measurement. The pulses move at the real speed and spacing, ${groupNum(SLOWS[0])} times slower (${groupNum(SLOWS[1])} on the slow setting), and their weakening and spreading down the tube is exaggerated.`,
  });
  ready = true;
  /** The pulses and the picked word's sleeve move every frame as instances. */
  function instances(): void {
    if (!ready) return;
    const c = colours();
    stage.instances('pulses', PULSE_GEO, PULSE_MAT, packInstances(pulseInstances(tank, sel, c.pulse, c.chosen)));
    stage.instances('band', BAND_GEO, BAND_MAT, packInstances(bandInstances(tank, sel, c.band)));
  }
  /** Rebuild only when a lamp, the lever or the loop's wire changed (or every frame in the flat drawing, which has no instances). */
  function paint(): void {
    const key = shownKey({ tank, sel }, narrow());
    if (key !== built || stage.isFlat()) { built = key; stage.refresh(); }
    instances();
  }

  const chip = h('span', { class: 'r3-chip' }), kv = h('div', { class: 'r3-kv' }), list = h('ol', { class: 'hg-words', 'aria-label': 'The sixteen words in this tank' });
  const live = h('p', { class: 'r3-hint', 'aria-live': 'polite' });
  stage.chips.append(chip);

  const facts = (): [string, string][] => [
    ['Clock', `${(rateHz() / 1e3).toFixed(0)} kHz, ${(slotS() * 1e6).toFixed(0)} µs slot`],
    ['Circulation', `${ms(delayS())} = ${SLOTS} slots`],
    ['Tube', `${FT(LENGTH_M)}, ${FT(OD_M).replace('0 ft ', '')} OD`],
    ['Cut to', `${CUT_LENGTH_M.toFixed(3)} m (fits ${TANK_C} °C)`],
    ['Sound in Hg', `${soundAt(tempC).toFixed(0)} m/s at ${tempC.toFixed(1)} °C`],
    ['Tube L / v', ms(tubeDelayAt(tempC))],
    ['At 5 ft 4 in', `${ms(reportTubeDelayS())} at ${TANK_C} °C`],
    ['Bits in flight', `${bitsInTank().toFixed(0)} = ${WORDS} × ${SLOTS_PER_WORD}`],
    ['Pulses', `${(slotPitchM() * 1000).toFixed(1)} mm apart, ${(pulseLengthM() * 1000).toFixed(1)} long`],
    ['Carrier', `${(CARRIER_HZ / 1e6).toFixed(1)} MHz, ${carrierCycles().toFixed(0)} cycles`],
    ['Word returns', `${circulationHz().toFixed(0)} times a second`],
    ['Mean / worst', `${(meanWaitS() * 1e6).toFixed(0)} / ${(delayS() * 1e6).toFixed(0)} µs`],
    ['The store', `${TANKS} tanks, ${storeLongWords()} long words`],
  ];

  const sw = h('input', { type: 'text', value: hex(0x1a2b3c4d5 % MAX35), 'aria-label': 'Value to write, hexadecimal, up to 35 bits', spellcheck: 'false', inputmode: 'text' }) as HTMLInputElement;
  const wordSel = h('select', { 'aria-label': 'Which word' }, ...Array.from({ length: WORDS }, (_, w) => h('option', { value: String(w) }, String(w)))) as HTMLSelectElement;
  wordSel.value = String(sel);
  wordSel.addEventListener('change', () => { sel = Number(wordSel.value); readout(true); kick(); });

  function waitText(): string {
    const w = tank.waitFor(sel);
    return w === 0 ? 'arriving now' : `${us(w * slotS())} to wait`;
  }

  function verdict(waitSlots: number): string {
    if (predicted < 0) return '';
    const q = Math.min(3, Math.floor((waitSlots / SLOTS) * 4)), name = (i: number) => PREDICT[i].split(' (')[0];
    return q === predicted ? ` You guessed the ${name(predicted)}: right.` : ` You guessed the ${name(predicted)}; it was the ${name(q)}.`;
  }

  function status(): string {
    const a = tank.access;
    if (a) {
      if (a.started < 0) return `${a.kind === 'read' ? 'Reading' : 'Writing'} word ${a.word}: waiting for it to come round, ${us(tank.waitFor(a.word) * slotS())} of real time to go.`;
      return `${a.kind === 'read' ? 'Reading' : 'Writing'} word ${a.word}: its ${SLOTS_PER_WORD} pulses are passing the gate.`;
    }
    const l = tank.last;
    if (l) {
      if (l.kind === 'read' && l.lost) return `Read of word ${l.word} failed: ${l.lost} pulses fell outside the receiving window (tank at ${tempC.toFixed(1)} °C, ${offsetSlots(tempC).toFixed(2)} slots out); the tank is forgetting.`;
      const v = l.kind === 'read' ? l.got.reduce((s, b, i) => (i >= 1 && i <= 35 ? s + b * 2 ** (i - 1) : s), 0) : l.value;
      return `${l.kind === 'read' ? 'Read' : 'Wrote'} word ${l.word} = ${hex(v)} after waiting ${us(l.waitSlots * slotS())} (mean ${us(meanWaitS())}, worst ${us(delayS())}).${verdict(l.waitSlots)}`;
    }
    if (!inWindow(tempC)) return `At ${tempC.toFixed(1)} °C the pulses arrive ${Math.abs(offsetSlots(tempC)).toFixed(2)} slots ${offsetSlots(tempC) > 0 ? 'late' : 'early'}, beyond the ±${WINDOW_TOL.toFixed(2)} the receiver accepts: every pulse is missed and the tank empties in one circulation.`;
    return tank.loop ? `Word ${sel}: ${waitText()}. Nothing is read until its first pulse passes the gate.` : 'The loop is cut: each pulse that reaches the far end is lost, and the tank empties within one circulation.';
  }

  function readout(announce = false): void {
    const at = tank.atWord;
    chip.textContent = tank.loop ? (narrow() ? `At gate: ${at} · lit: ${sel}` : `Word ${at} at the receiver · word ${sel} lit`) : 'Loop cut';
    chip.className = `r3-chip ${tank.loop ? 'good' : 'bad'}`;
    kv.replaceChildren(...[...facts(), ['Time on screen', `1 : ${groupNum(SLOWS[slow])}`] as [string, string],
      ['Real time elapsed', ms(tank.t * slotS())], ['Passes of the gate', String(Math.floor(tank.t / SLOTS))]].flatMap(([k, v]) => [h('span', null, k), h('span', { class: 'v' }, v)]));
    const key = `${at}|${sel}|${Array.from({ length: WORDS }, (_, w) => tank.word(w)).join(',')}`;
    if (key !== listKey) {
      listKey = key;
      list.replaceChildren(...Array.from({ length: WORDS }, (_, w) => h('li', { class: `${w === sel ? 'sel ' : ''}${w === at ? 'now' : ''}` }, `${String(w).padStart(2, ' ')}  ${hex(tank.word(w))}`)));
    }
    runBtn.textContent = running ? 'Pause' : 'Run';
    runBtn.setAttribute('aria-pressed', String(running));
    cutBtn.setAttribute('aria-pressed', String(!tank.loop));
    cutBtn.textContent = tank.loop ? 'Cut the loop' : 'Close the loop';
    live.setAttribute('aria-live', running && !announce ? 'off' : 'polite');
    const text = status();
    if (live.textContent !== text) live.textContent = text;
  }

  const loop = frameLoop((now, dt) => {
    if (running) {
      if (reducedMotion()) { // whole words at a time, no sweep
        idle += dt;
        if (idle >= 0.7) { idle = 0; tank.advance(SLOTS_PER_WORD); }
      } else tank.advance(dt * slotsPerSec());
    } else if (step) {
      const u = Math.min(1, (now - step.t0) / 600), to = step.slots * u;
      tank.advance(to - tweenFrom); tweenFrom = to;
      if (u >= 1) step = null;
    }
    readout(); paint();
  }, () => running || step !== null);
  const kick = () => { readout(); paint(); loop.kick(); };

  const runBtn = h('button', { type: 'button', class: 'btn sm primary', 'aria-pressed': 'false' }, 'Run') as HTMLButtonElement;
  runBtn.addEventListener('click', () => { running = !running; step = null; idle = 0; readout(true); kick(); });
  const stepBtn = h('button', { type: 'button', class: 'btn sm' }, 'Step one word') as HTMLButtonElement;
  stepBtn.addEventListener('click', () => {
    running = false;
    if (reducedMotion()) { tank.advance(SLOTS_PER_WORD); step = null; } else { step = { t0: performance.now(), slots: SLOTS_PER_WORD }; tweenFrom = 0; }
    readout(true); kick();
  });
  const access = (kind: 'read' | 'write') => {
    let v = 0;
    if (kind === 'write') {
      const t = sw.value.trim().replace(/^0x/i, '');
      if (!/^[0-9a-f]{1,9}$/i.test(t) || parseInt(t, 16) >= MAX35) { live.textContent = 'Enter up to 35 bits as hexadecimal, 0 to 7ffffffff.'; sw.setAttribute('aria-invalid', 'true'); return; }
      sw.removeAttribute('aria-invalid');
      v = parseInt(t, 16);
    }
    tank.last = null;
    tank.request(kind, sel, v);
    running = true; step = null; idle = 0;
    readout(true); kick();
  };
  const readBtn = h('button', { type: 'button', class: 'btn sm' }, 'Read word') as HTMLButtonElement;
  readBtn.addEventListener('click', () => access('read'));
  const writeBtn = h('button', { type: 'button', class: 'btn sm' }, 'Write word') as HTMLButtonElement;
  writeBtn.addEventListener('click', () => access('write'));
  const cutBtn = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': 'false', title: 'Open the recirculation path: nothing refreshes the pulses' }, 'Cut the loop') as HTMLButtonElement;
  cutBtn.addEventListener('click', () => { tank.loop = !tank.loop; tank.last = null; running = true; idle = 0; readout(true); kick(); });
  const tempOut = h('output', { class: 'hg-temp-out' });
  const temp = h('input', { type: 'range', min: '30', max: '50', step: '0.5', value: String(TANK_C), 'aria-label': 'Tank temperature, 30 to 50 degrees Celsius' }) as HTMLInputElement;
  const setTemp = (c: number) => {
    tempC = c; tank.offset = offsetSlots(c); temp.value = String(c);
    tempOut.textContent = `${c.toFixed(1)} °C · ${inWindow(c) ? 'in window' : 'missed'}`; tempOut.className = `hg-temp-out ${inWindow(c) ? 'good' : 'bad'}`;
  };
  temp.addEventListener('input', () => { setTemp(Number(temp.value)); running = true; idle = 0; readout(true); kick(); });
  setTemp(TANK_C);
  const predictSel = h('select', { 'aria-label': 'Where will the wait fall, before you press Read' }, h('option', { value: '-1' }, 'no guess'), ...PREDICT.map((p, i) => h('option', { value: String(i) }, p))) as HTMLSelectElement;
  predictSel.addEventListener('change', () => { predicted = Number(predictSel.value); });
  const hist = h('div', { class: 'hg-hist', role: 'img', 'aria-label': 'Histogram of the waits of 20 random reads' });
  const histNote = h('p', { class: 'r3-hint' }, 'Twenty reads at random moments: where do their waits fall?');
  const drawHist = () => {
    if (!reads) return;
    const bins = histogram(reads, BINS), top = Math.max(...bins, 1), mean = (reads.reduce((x, y) => x + y, 0) / reads.length) * slotS();
    hist.replaceChildren(...bins.map((n, i) => h('div', { class: 'hg-bar', title: `${us((i / BINS) * delayS())} to ${us(((i + 1) / BINS) * delayS())}: ${n}` }, h('i', { style: `height:${(n / top) * 100}%` }), h('b', null, String(n)))));
    histNote.textContent = `Flat over one circulation (0 to ${ms(delayS())}), mean ${us(mean)}; half a circulation is ${us(meanWaitS())}. A DDR4-3200 row hit returns data in ${(ROW_HIT_S * 1e9).toFixed(2)} ns (tCAS, dram/timing.ts): the mean wait is ${groupNum(Math.round(dramRatio()))} times that.`;
  };
  const randBtn = h('button', { type: 'button', class: 'btn sm' }, 'Read 20 random words') as HTMLButtonElement;
  randBtn.addEventListener('click', () => { reads = randomWaits(20); drawHist(); });
  const resetBtn = h('button', { type: 'button', class: 'btn sm' }, 'Reset') as HTMLButtonElement;
  resetBtn.addEventListener('click', () => {
    tank.loop = true; tank.access = null; tank.last = null; tank.t = 0; running = false; step = null; setTemp(TANK_C);
    for (let w = 0; w < WORDS; w++) tank.setWord(w, initialWord(w));
    readout(true); kick();
  });

  const slowBtns = SLOWS.map((s, i) => {
    const b = h('button', { type: 'button', 'aria-pressed': String(i === slow), class: i === slow ? 'on' : '' }, `1 : ${groupNum(s)}`) as HTMLButtonElement;
    b.addEventListener('click', () => { slow = i; slowBtns.forEach((x, j) => { x.classList.toggle('on', j === i); x.setAttribute('aria-pressed', String(j === i)); }); readout(true); kick(); });
    return b;
  });
  // the preset views; a phone opens on the sending end
  const viewBtns = (Object.keys(VIEWS) as (keyof typeof VIEWS)[]).map((k) => {
    const b = h('button', { type: 'button', 'aria-pressed': String(k === startKey()), class: k === startKey() ? 'on' : '' }, VIEW_NAMES[k]) as HTMLButtonElement;
    b.addEventListener('click', () => { stage.goTo(k === 'whole' ? wholeView() : { ...VIEWS[k] } as OrbitView); viewBtns.forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); }); });
    return b;
  });

  panel.append(
    h('h3', { class: 'm3-title' }, 'EDSAC’s mercury delay line'),
    h('p', { class: 'm3-sub' }, `A circulating shift register made of sound. A quartz crystal turns each pulse into a ${(CARRIER_HZ / 1e6).toFixed(1)} MHz burst of ultrasound, the burst crosses the mercury in ${ms(delayS())}, the crystal at the far end turns it back into a voltage, and the electronics amplify it, reshape it against the clock and launch it again: ${bitsInTank().toFixed(0)} pulse slots (16 words of 36) in flight at once. Recirculation is refresh: the pulse is rewritten every ${ms(delayS())}, where a DRAM cell is rewritten every 64 ms. But there is no address, only time: a word can be read or written only as its slot passes the gate, so a request waits up to a whole circulation, ${us(meanWaitS())} on average.`),
    // the controls, then the tank across the panel's width (it is 64 times longer than wide), then the figures and the words
    h('div', { class: 'hg-ctls' },
      h('div', { class: 'r3-ctl' },
        h('label', { class: 'hg-in' }, 'Word ', wordSel),
        h('label', { class: 'hg-in' }, 'Value ', sw),
        h('label', { class: 'hg-in' }, 'Guess the wait ', predictSel),
        h('div', { class: 'r3-btns' }, readBtn, writeBtn)),
      h('div', { class: 'r3-ctl' },
        h('div', { class: 'r3-btns' }, runBtn, stepBtn, cutBtn, resetBtn),
        h('label', { class: 'hg-in' }, 'Tank temperature ', temp, tempOut)),
      h('div', { class: 'r3-ctl' },
        h('div', { class: 'seg', role: 'group', 'aria-label': 'View' }, ...viewBtns),
        h('div', { class: 'seg hg-seg', role: 'group', 'aria-label': 'How much slower than real time' }, ...slowBtns))),
    stage.el, live,
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' }, h('h4', null, 'Its sixteen words'), list, h('h4', null, 'Waits of random reads'), randBtn, hist, histNote),
      h('div', { class: 'r3-side' }, h('h4', null, 'This tank ', h('span', { class: 'r3-badge' }, `${SLOTS} slots`)), kv)));
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape' && running) { running = false; readout(true); kick(); } });
  readout(true);
  paint();
  return { el: panel, destroy() { loop.stop(); stage.destroy(); } };
}
