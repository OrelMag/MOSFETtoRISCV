// The image-sensor chapter's explainers (chapters/ch-sensors.ts). Every number comes from phys/imagesensor.ts; the two
// scenes run lib/sensor.ts's circuits (the 4T pixel at switch level, a row of column ADCs in gates).

import {
  absorptionDepth, afterTransfers, bayerAt, CCD42_40, ccdReadTime, ccdRetained, cdsSequence, CG_4T, C_FD_FF, clockHigh, darkCurrent, demosaic,
  dynamicRangeDb, IMX183, ktcNoise, mosaic, normal, outputVolts, packetGate, photonEv, poisson, qe, rng, rollingSkew, rowTime, SF_GAIN,
  STACK_BSI, STACK_CCD42, STACK_FSI, stepsPerPixel, VDD_PIX,
} from '../phys/imagesensor';
import { columnAdcRow, PIXEL_4T } from '../lib/sensor';
import { groupNum } from '../sim/numfmt';
import { pack } from '../sim/values';
import { h, s } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { line, mkChips, num, plotOf } from './line';
import { slider } from './mosparts';
import '../styles/line.css';
import '../styles/sensors.css';

const g = (x: number): string => groupNum(Math.round(x));
const btn = (label: string, fn: () => void, aria?: string) => h('button', { type: 'button', class: 'btn sm', onclick: fn, ...(aria ? { 'aria-label': aria } : {}) }, label);

// ---------------------------------------------------------------------------------------------------------------------
// 0. Light into charge

export function lightWidget(): Widget {
  let nm = 550;
  const plot = plotOf({ W: 460, H: 230, x: [400, 1100], y: [0, 1], yTicks: [0, 0.25, 0.5, 0.75, 1], xLabel: 'wavelength, nm', yLabel: 'QE', aria: 'Quantum efficiency against wavelength for a back-illuminated CMOS pixel, a front-illuminated one and a deep-depleted CCD', xFmt: (v) => num(v, 0), yFmt: (v) => `${Math.round(v * 100)} %` });
  const slab = s('svg', { viewBox: '0 0 300 230', class: 'sn-slab', role: 'img', 'aria-label': 'Where light is absorbed in silicon: the share left at each depth' });
  const chips = mkChips(4), note = h('p', { class: 'sub mos-note' });
  const xs = Array.from({ length: 141 }, (_, i) => 400 + i * 5);
  const paint = () => {
    plot.clear();
    line(plot, xs, xs.map((x) => qe(x, STACK_CCD42)), 'lump');
    line(plot, xs, xs.map((x) => qe(x, STACK_FSI)), 'near');
    line(plot, xs, xs.map((x) => qe(x, STACK_BSI)), 'real');
    plot.layer.append(s('line', { x1: plot.X(nm), x2: plot.X(nm), y1: plot.Y(0), y2: plot.Y(1), class: 'ln-h t50' }));
    for (const [v, c] of [[IMX183.peakQe, IMX183.peakQeNm]] as const) plot.layer.append(s('circle', { cx: plot.X(c), cy: plot.Y(v), r: 4, class: 'sn-dot' }));
    // the slab: 0 … 20 µm deep, the light left at each depth as the shade, the 1/e depth and the BSI collection depth marked
    const D = 20, top = 20, bot = 210, Y = (d: number) => top + (Math.min(d, D) / D) * (bot - top), a = absorptionDepth(nm);
    const kids: SVGElement[] = [];
    for (let i = 0; i < 40; i++) {
      const d0 = (i / 40) * D, left = Math.exp(-d0 / a);
      kids.push(s('rect', { x: 40, y: Y(d0), width: 120, height: (bot - top) / 40 + 0.5, class: 'sn-si', style: `fill-opacity:${(0.08 + 0.85 * left).toFixed(3)}` }));
    }
    kids.push(s('rect', { x: 40, y: top, width: 120, height: bot - top, class: 'sn-si-edge' }));
    const ya = Y(a);
    kids.push(s('line', { x1: 34, x2: 166, y1: ya, y2: ya, class: 'sn-mark' }), s('text', { x: 172, y: ya + 4, class: 'sn-lbl' }, a < 0.1 ? '1/e: < 0.1 µm' : `1/e: ${num(a, a < 10 ? 2 : 0)} µm${a > D ? ' (below)' : ''}`));
    const yc = Y(STACK_BSI.collect);
    kids.push(s('line', { x1: 34, x2: 166, y1: yc, y2: yc, class: 'sn-mark coll' }), s('text', { x: 172, y: yc + 4, class: 'sn-lbl coll' }, 'BSI diode: 3 µm'));
    kids.push(s('text', { x: 100, y: 14, 'text-anchor': 'middle', class: 'sn-lbl' }, `light, ${nm} nm`), s('text', { x: 36, y: top + 4, 'text-anchor': 'end', class: 'sn-lbl' }, '0'), s('text', { x: 36, y: bot, 'text-anchor': 'end', class: 'sn-lbl' }, '20 µm'));
    slab.replaceChildren(...kids);
    chips.set(0, `${num(photonEv(nm), 2)} eV`, 'photon energy: one electron each, whatever the energy, above 1.12 eV');
    chips.set(1, `${num(a, a < 10 ? 2 : 0)} µm`, 'depth where 63 % has been absorbed');
    chips.set(2, `${Math.round(qe(nm, STACK_BSI) * 100)} %`, 'QE, back-illuminated (IMX183 class)');
    chips.set(3, `${Math.round(qe(nm, STACK_FSI) * 100)} %`, 'QE, front-illuminated, same pitch');
    note.textContent = 'Solid: back-illuminated CMOS, fitted to the IMX183\'s measured 79 % at 525 nm (the dot). Orange: the same pixel lit through its metal layers. Dashed: the deep-depleted CCD42-40, about 40 µm of silicon, fitted to its datasheet\'s QE table. A model of absorption depth and optics, not of the devices.';
  };
  const sl = slider('Wavelength', 400, 1100, 5, nm, (v) => `${v} nm`, (v) => { nm = v; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos sn' }, h('div', { class: 'panel sn-two' }, plot.el, slab), h('div', { class: 'panel mos-ctl' }, sl.el, note), chips.el) };
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. The CCD's bucket brigade

const CCD_PIX = 6;
const START = [9000, 2500, 14000, 600];

export function ccdWidget(): Widget {
  let n: 3 | 4 = 3, k = 0, cte = 0.99, running = false, last = 0, timer = 0;
  let read: { e: number; v: number }[] = [];
  const svg = s('svg', { viewBox: '0 0 640 190', class: 'sn-ccd', role: 'img', 'aria-label': 'A row of CCD gates clocked in phases, with charge packets moving to the output amplifier' });
  const chips = mkChips(4), note = h('p', { class: 'sub mos-note' }), live = h('div', { class: 'sr-only', 'aria-live': 'polite' });
  const gates = () => CCD_PIX * n;
  /** A packet's charge after t pixel transfers, and what it left behind. */
  const packets = () => {
    const done = Math.floor(k / stepsPerPixel(n));
    return START.map((q, i) => ({ q: q * afterTransfers(done, cte), trail: q * (1 - afterTransfers(done, cte)), at: i * n + packetGate(n, k) + (n === 3 ? 0.5 : 1) }));
  };
  const paint = () => {
    const G = gates(), x0 = 20, gw = 540 / G, high = clockHigh(n, k), kids: SVGElement[] = [];
    for (let i = 0; i < G; i++) {
      const ph = (i % n) + 1, on = high.includes(ph);
      kids.push(s('rect', { x: x0 + i * gw + 1, y: 40, width: gw - 2, height: 26, rx: 2, class: `sn-gate p${ph}${on ? ' on' : ''}` }), s('text', { x: x0 + (i + 0.5) * gw, y: 34, 'text-anchor': 'middle', class: 'sn-lbl sm' }, `∅${ph}`));
      if (i % n === 0) kids.push(s('line', { x1: x0 + i * gw, x2: x0 + i * gw, y1: 70, y2: 150, class: 'sn-pix' }));
    }
    kids.push(s('rect', { x: x0 + G * gw + 8, y: 70, width: 44, height: 60, rx: 4, class: 'sn-amp' }), s('text', { x: x0 + G * gw + 30, y: 104, 'text-anchor': 'middle', class: 'sn-lbl sm' }, 'out'));
    const top = 74, scale = 70 / 15_000;
    for (const p of packets()) {
      const x = x0 + p.at * gw;
      if (x > x0 + G * gw) continue;
      const hgt = Math.max(2, p.q * scale);
      kids.push(s('rect', { x: x - gw * 0.4, y: top, width: gw * 0.8, height: hgt, rx: 3, class: 'sn-q' }));
      if (p.trail > 1) kids.push(s('rect', { x: x - gw * 0.4 - gw * n, y: top, width: gw * 0.8, height: Math.max(1.5, p.trail * scale), rx: 2, class: 'sn-q trail' }));
    }
    read.slice(-4).forEach((r, i) => kids.push(s('text', { x: x0 + G * gw + 30, y: 150 + i * 12 - 0, 'text-anchor': 'middle', class: 'sn-lbl sm' }, `${(r.v * 1000).toFixed(1)} mV`)));
    kids.push(s('text', { x: x0, y: 180, class: 'sn-lbl sm' }, `step ${k} · ${n}-phase: ${high.map((p) => `∅${p}`).join(' + ')} high`));
    svg.replaceChildren(...kids);
    const transfers = Math.floor(k / stepsPerPixel(n));
    chips.set(0, String(transfers), 'pixel transfers so far');
    chips.set(1, `${(afterTransfers(transfers, cte) * 100).toFixed(3)} %`, `of each packet still in it, at CTE ${(cte * 100).toFixed(4)} %`);
    chips.set(2, `${(ccdRetained(2047, 2047) * 100).toFixed(1)} %`, 'CCD42-40: the far corner after 4096 transfers');
    chips.set(3, `${num(ccdReadTime(CCD42_40.readHz[1]), 1)} s`, `a 2048 × 2048 frame through one output at 3 MHz (${num(ccdReadTime(CCD42_40.readHz[0]) / 60, 1)} min at 20 kHz)`);
  };
  const step = () => {
    const before = packets().map((p) => p.at);
    k++;
    packets().forEach((p, i) => { if (before[i] <= gates() && p.at > gates()) read.push({ e: p.q, v: outputVolts(p.q, CCD42_40.cg) }); });
    if (packets().every((p) => p.at > gates() + n)) { k = 0; read = []; }
    paint();
    live.textContent = `Step ${k}: ${clockHigh(n, k).map((p) => `phase ${p}`).join(' and ')} high.`;
  };
  const tick = (now: number) => { if (!running) return; if (now - last > 280) { last = now; step(); } timer = requestAnimationFrame(tick); };
  const run = btn('Run', () => {
    if (reducedMotion()) { step(); return; }
    running = !running; run.textContent = running ? 'Pause' : 'Run';
    if (running) timer = requestAnimationFrame(tick);
  }, 'Run or pause the clock');
  const phases = h('div', { class: 'qz-seg', role: 'group', 'aria-label': 'Clock phases' },
    ...([3, 4] as const).map((p) => { const b = btn(`${p}-phase`, () => { n = p; k = 0; read = []; phases.querySelectorAll('button').forEach((x, i) => x.setAttribute('aria-pressed', String([3, 4][i] === n))); paint(); }); b.setAttribute('aria-pressed', String(p === n)); return b; }));
  const cteSl = slider('CTE', 0, 3, 1, 1, (v) => ['99 %', '99.9 %', '99.99 %', '99.9999 %'][v], (v) => { cte = [0.99, 0.999, 0.9999, 0.999999][v]; paint(); });
  cte = 0.999;
  note.textContent = 'Each packet is a pocket of electrons under the gates held high; moving the high gates one along drags the pocket with them. A real register leaves a little behind at every transfer (charge-transfer efficiency): drawn here at a poor CTE so the trail shows. The CCD42-40 does 99.9999 % per transfer in the image area and 99.9993 % in the register.';
  paint();
  return { el: h('div', { class: 'widget mos sn' }, h('div', { class: 'panel' }, svg, live), h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' }, phases, btn('Step', step, 'Advance the clock one step'), run, cteSl.el), note), chips.el), destroy() { running = false; cancelAnimationFrame(timer); } };
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. The CMOS active pixel: one CDS readout as a timing diagram

export function pixelWidget(): Widget {
  let e = 6000, seed = 1;
  const svg = s('svg', { viewBox: '0 0 640 230', class: 'sn-cds', role: 'img', 'aria-label': 'Timing of one row\'s readout: reset, reset sample, transfer, signal sample, with the floating diffusion\'s voltage' });
  const chips = mkChips(4), note = h('p', { class: 'sub mos-note' });
  const ktc = ktcNoise(C_FD_FF);
  const paint = () => {
    const r = rng(seed), off = normal(r) * ktc * CG_4T * 1e-6, seq = cdsSequence(e, { offset: off });
    const x0 = 90, W = 120, rows: [string, (i: number) => number][] = [['RST', (i) => (seq.phases[i].rst ? 1 : 0)], ['TX', (i) => (seq.phases[i].tx ? 1 : 0)], ['SEL', () => 1]];
    const kids: SVGElement[] = [];
    rows.forEach(([name, f], j) => {
      const y = 22 + j * 30;
      kids.push(s('text', { x: x0 - 10, y: y + 12, 'text-anchor': 'end', class: 'sn-lbl' }, name));
      let d = '';
      for (let i = 0; i < 4; i++) { const v = f(i), yy = y + (v ? 0 : 16); d += `${i ? 'L' : 'M'}${x0 + i * W},${yy}H${x0 + (i + 1) * W}`; }
      kids.push(s('path', { d, class: 'sn-dig' }));
    });
    const vy = (v: number) => 210 - ((v - (VDD_PIX - 1.05)) / 1.1) * 90;
    kids.push(s('text', { x: x0 - 10, y: 150, 'text-anchor': 'end', class: 'sn-lbl' }, 'FD'));
    let d = '';
    seq.phases.forEach((p, i) => { d += `${i ? 'L' : 'M'}${x0 + i * W},${vy(p.fd).toFixed(1)}H${x0 + (i + 1) * W}`; });
    kids.push(s('path', { d, class: 'ln-s real' }));
    for (const [i, lbl] of [[1, 'SHR'], [3, 'SHS']] as const) {
      const x = x0 + (i + 0.7) * W;
      kids.push(s('line', { x1: x, x2: x, y1: 112, y2: 214, class: 'ln-h t50' }), s('circle', { cx: x, cy: vy(seq.phases[i].fd), r: 4, class: 'sn-dot' }), s('text', { x: x + 4, y: 122, class: 'sn-lbl t50' }, lbl));
    }
    seq.phases.forEach((p, i) => kids.push(s('text', { x: x0 + i * W + W / 2, y: 226, 'text-anchor': 'middle', class: 'sn-lbl sm' }, `${num(p.fd, 3)} V`)));
    svg.replaceChildren(...kids);
    const noCds = (VDD_PIX - seq.phases[3].fd) / (CG_4T * 1e-6);
    chips.set(0, `${num(CG_4T, 0)} µV/e⁻`, `conversion gain: C_FD = q / CG = ${num(C_FD_FF, 2)} fF`);
    chips.set(1, `${num((VDD_PIX - seq.phases[2].fd) * 1000, 0)} mV`, `FD's drop for ${g(e)} e⁻`);
    chips.set(2, `${g(seq.cdsE)} e⁻`, 'CDS: reset sample − signal sample');
    chips.set(3, `${g(noCds)} e⁻`, `the signal sample alone, against an ideal reset: off by this reset's kTC noise (${num(ktc, 1)} e⁻ rms)`);
    note.textContent = `The source follower copies FD to the column with a gain of about ${SF_GAIN}. Each reset leaves FD a little off its nominal level (kTC noise: √(kTC)/q = ${num(ktc, 1)} e⁻ rms for ${num(C_FD_FF, 2)} fF), and the error stays until the next reset. Sampling the reset level first and subtracting it removes it. The IMX183 publishes no conversion gain: ${CG_4T} µV/e⁻ is illustrative for a 2.4 µm pixel, and its full well of ${g(IMX183.fullWell)} e⁻ then swings FD by ${num(IMX183.fullWell * CG_4T * 1e-3, 0)} mV.`;
  };
  const sl = slider('Light', 0, IMX183.fullWell, 100, e, (v) => `${g(v)} e⁻`, (v) => { e = v; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos sn' }, h('div', { class: 'panel' }, svg), h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' }, sl.el, btn('Another reset', () => { seed++; paint(); }, 'Reset again: a new kTC error')), note), chips.el) };
}

// ---------------------------------------------------------------------------------------------------------------------
// 3. The pixel, switch by switch (a scene on PIXEL_4T)

export const pixelApi = new WeakMap<Stage, { log: () => string[]; bright: () => boolean; demo: () => void }>();
type Lvl = { level(net: number): number };
const netIdx = (name: string) => PIXEL_4T.netlist!().nets.findIndex((n) => n.name === name);

const pixelPanel: ScenePanel = (stage: Stage): Widget => {
  let log: string[] = [], sawBright = false;
  const out = h('ol', { class: 'sn-log' }), read = h('div', { class: 'mc-status' });
  const lvl = (name: string): number | null => {
    const sim = stage.sim as unknown as Partial<Lvl> & { design: { root: { nets?: number[][] } } };
    const ids = sim?.design?.root?.nets?.[netIdx(name)];
    return sim && typeof sim.level === 'function' && ids ? sim.level(ids[0]) : null;
  };
  const paint = () => {
    const pd = lvl('PD'), fd = lvl('FD');
    read.replaceChildren(h('span', null, 'PD ', h('b', null, pd === null ? '–' : `${Math.round(pd * 100)} %`)), h('span', null, 'FD ', h('b', null, fd === null ? '–' : `${Math.round(fd * 100)} %`)), h('span', null, 'column ', h('b', null, String(stage.value('col') ?? '–'))));
    out.replaceChildren(...log.slice(-6).map((t) => h('li', null, t)));
  };
  const set = (k: Record<string, number>) => { for (const [p, v] of Object.entries(k)) stage.sim!.setInput(p, v); stage.sim!.settle(); stage.refresh(); };
  const doReset = () => { stage.checkpoint(); set({ rst: 1, tx: 1, light: 0, sel: 0 }); set({ rst: 0, tx: 0 }); log.push('RST + TX: photodiode emptied, FD at the supply'); paint(); };
  const expose = (lit: boolean) => () => { stage.checkpoint(); if (lit) { set({ light: 1 }); set({ light: 0 }); } log.push(lit ? 'exposure: light fills the photodiode (PD falls)' : 'exposure in the dark: PD keeps its level'); paint(); };
  const readout = () => {
    stage.checkpoint();
    set({ sel: 1, rst: 1 }); set({ rst: 0 });
    const r = stage.value('col');
    set({ tx: 1 }); set({ tx: 0 });
    const v = stage.value('col');
    log.push(`read: SHR column ${r}, SHS column ${v}${r === 1 && v === 0 ? ': a bright pixel' : r === 1 && v === 1 ? ': a dark pixel' : ''}`);
    if (r === 1 && v === 0) sawBright = true;
    set({ sel: 0 });
    paint();
  };
  pixelApi.set(stage, { log: () => log, bright: () => sawBright, demo: () => { doReset(); expose(true)(); readout(); } });
  stage.resetHooks.add(() => { log = []; sawBright = false; paint(); });
  const el = h('div', { class: 'mem-panel cpu-panel mc-panel sn-panel', 'data-dock': 'right', 'data-phone': 'flow' }, h('h4', null, 'One pixel, one read'),
    h('div', { class: 'dram-ops' }, btn('Reset', doReset, 'Empty the photodiode and reset FD'), btn('Dark', expose(false), 'Expose in the dark'), btn('Light', expose(true), 'Expose to full light'), btn('Read', readout, 'Read the row: RST, SHR, TX, SHS')),
    read, out, h('p', { class: 'sub' }, 'Levels are fractions of the supply. A level between 30 % and 70 % reads as X on a wire: the switch solver has no analog voltages, so the follower\'s output is shown as H (dark) or 0 (bright).'));
  paint();
  return { el, update: paint };
};

export function pixelScene(): Scene {
  return { root: PIXEL_4T, inputs: { rst: 0, tx: 0, light: 0, sel: 0 }, powerOn: 'zero', panels: [pixelPanel] };
}

// ---------------------------------------------------------------------------------------------------------------------
// 4. Column ADCs with digital CDS (a scene on columnAdcRow)

export const ADC_BITS = 5, ADC_COLS = 4;
export const adcApi = new WeakMap<Stage, { ran: () => boolean; agrees: () => boolean; run: () => void }>();

const adcPanel: ScenePanel = (stage: Stage): Widget => {
  let ran = false, ok = true, res: number[] = [], seed = 7;
  const read = h('div', { class: 'mc-status' }), note = h('p', { class: 'sub' }), rows = h('div', { class: 'sn-cols' });
  const full = 2 ** ADC_BITS;
  /** This row's samples in counts: a reset level with each column's own offset, and the signal on top. */
  const samples = () => {
    const r = rng(seed), sig = [18, 3, 11, 26];
    return sig.map((sv) => { const rst = 1 + Math.floor(r() * 4); return { rst, sig: Math.min(full - 1, rst + sv), want: Math.min(full - 1, rst + sv) - rst }; });
  };
  const paint = () => {
    const sm = samples();
    rows.replaceChildren(...sm.map((c, i) => h('div', { class: 'sn-col' }, h('b', null, `col ${i}`), h('span', null, `reset ${c.rst}, signal ${c.sig}`), h('span', null, ran ? `count ${res[i]}` : 'count –', ran ? (res[i] === c.want ? ' ✓' : ' ✗') : ''))));
    read.replaceChildren(h('span', null, 'clocks ', h('b', null, ran ? String(2 * (full + 1)) : '0')), h('span', null, 'agree ', h('b', null, ran ? (ok ? 'yes' : 'no') : '–')));
  };
  const run = () => {
    stage.checkpoint();
    const sim = stage.sim!, sm = samples();
    const set = (k: Record<string, number>) => { for (const [p, v] of Object.entries(k)) sim.setInput(p, v); sim.settle(); };
    const clock = () => { set({ clk: 1 }); set({ clk: 0 }); };
    sim.reset('zero');
    set({ clk: 0, go: 0, start: 1, clr: 1, up: 0 }); clock(); set({ clr: 0 });
    for (const phase of [0, 1]) {
      sm.forEach((c, i) => sim.setInput(`v${i}`, phase ? c.sig : c.rst));
      set({ up: phase, start: 1, go: 0 }); clock();
      set({ start: 0, go: 1 });
      for (let i = 0; i < full; i++) clock();
      set({ go: 0 });
    }
    res = sm.map((_, i) => { const raw = pack(sim.getBits(sim.design.root.ports[`d${i}`])); return raw >= full ? raw - 2 * full : raw; });
    ok = res.every((v, i) => v === sm[i].want);
    ran = true;
    stage.refresh();
    paint();
  };
  adcApi.set(stage, { ran: () => ran, agrees: () => ran && ok, run });
  stage.resetHooks.add(() => { ran = false; paint(); });
  note.textContent = `${ADC_BITS} bits and ${ADC_COLS} columns so it fits on the screen; the IMX183 converts all 5544 columns of a row at once at 12 bits, so the ramp is 4096 counts long. Each column's reset level differs (its own offset and kTC error); the count ends at signal − reset in every column.`;
  const el = h('div', { class: 'mem-panel cpu-panel mc-panel sn-panel', 'data-dock': 'right', 'data-phone': 'flow' }, h('h4', null, 'One row, converted'),
    h('div', { class: 'dram-ops' }, btn('Convert the row', run, 'Run the reset conversion, then the signal conversion'), btn('Other offsets', () => { seed++; ran = false; paint(); }, 'Draw new reset offsets')), rows, read, note);
  paint();
  return { el, update: () => {} };
};

export function adcScene(): Scene {
  const inputs: Record<string, number> = { up: 0, go: 0, start: 0, clr: 0, clk: 0 };
  for (let c = 0; c < ADC_COLS; c++) inputs[`v${c}`] = 0;
  return { root: columnAdcRow(ADC_BITS, ADC_COLS), inputs, clock: 'clk', autoClock: false, powerOn: 'zero', panels: [adcPanel] };
}

// ---------------------------------------------------------------------------------------------------------------------
// 5. Rolling against global shutter

const SW = 200, SH = 150;

export function shutterWidget(): Widget {
  let kind: 'rolling' | 'global' = 'rolling', speed = 3, flash = false, readMs = 1000 / IMX183.fps;
  const cv = h('canvas', { width: SW, height: SH, class: 'sn-canvas', role: 'img', 'aria-label': 'A spinning propeller photographed with a rolling or a global shutter' }) as HTMLCanvasElement;
  const chips = mkChips(4), note = h('p', { class: 'sub mos-note' });
  const paint = () => {
    const c = cv.getContext('2d');
    if (!c) return;
    const img = c.createImageData(SW, SH), tRead = readMs / 1000, rev = speed; // revolutions a second
    for (let y = 0; y < SH; y++) {
      const t = kind === 'rolling' ? (y / SH) * tRead : 0;
      const ang = 2 * Math.PI * rev * t;
      const lit = !flash || (kind === 'global' ? true : Math.abs(t - tRead * 0.45) < tRead * 0.12);
      for (let x = 0; x < SW; x++) {
        const dx = x - SW / 2, dy = y - SH / 2, r = Math.hypot(dx, dy), a = Math.atan2(dy, dx) - ang;
        const blade = r < 68 && r > 6 && Math.cos(3 * a) > 0.93;
        let v = blade ? 30 : 200 + ((x + y) % 2) * 6;
        if (flash && !lit) v *= 0.25;
        const i = 4 * (y * SW + x);
        img.data[i] = v; img.data[i + 1] = blade ? 60 : v; img.data[i + 2] = blade ? 120 : v; img.data[i + 3] = 255;
      }
    }
    c.putImageData(img, 0, 0);
    const tRow = (readMs / 1000) / IMX183.rows;
    chips.set(0, `${num(rowTime() * 1e6, 1)} µs`, 'IMX183 row time (frame rate over rows)');
    chips.set(1, `${num(readMs, 1)} ms`, 'top row to bottom row');
    chips.set(2, `${num(rollingSkew(1000, IMX183.rows, tRow), 0)} px`, 'skew of an edge crossing at 1000 pixels a second');
    chips.set(3, kind === 'rolling' ? `${num(360 * speed * readMs / 1000, 0)}°` : '0°', 'the propeller turns this much while the frame is read');
  };
  const seg = h('div', { class: 'qz-seg', role: 'group', 'aria-label': 'Shutter' }, ...(['rolling', 'global'] as const).map((k) => { const b = btn(k === 'rolling' ? 'Rolling' : 'Global', () => { kind = k; seg.querySelectorAll('button').forEach((x, i) => x.setAttribute('aria-pressed', String(['rolling', 'global'][i] === kind))); paint(); }); b.setAttribute('aria-pressed', String(k === kind)); return b; }));
  const sp = slider('Propeller', 0, 30, 1, speed, (v) => `${v} rev/s`, (v) => { speed = v; paint(); });
  const rd = slider('Readout', 1, 50, 1, Math.round(readMs), (v) => `${v} ms`, (v) => { readMs = v; paint(); });
  const fl = btn('Flash', () => { flash = !flash; fl.setAttribute('aria-pressed', String(flash)); paint(); }, 'A flash shorter than the readout');
  fl.setAttribute('aria-pressed', 'false');
  note.textContent = `A rolling shutter starts and stops each row ${num(rowTime() * 1e6, 1)} µs after the one above, so the rows see different moments: a moving blade bends, and a flash shorter than the readout lights only a band. A global shutter stores every pixel's charge at the same instant (in a storage node beside each photodiode, which costs area and adds noise) and reads it out afterwards.`;
  paint();
  return { el: h('div', { class: 'widget mos sn' }, h('div', { class: 'panel sn-center' }, cv), h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' }, seg, fl, sp.el, rd.el), note), chips.el) };
}

// ---------------------------------------------------------------------------------------------------------------------
// 6. Colour: the Bayer mosaic and demosaicing

const CW = 64, CH = 48;
/** The test card: a colour wheel, fine black-and-white stripes and a sharp red / blue edge. */
function card(): Float32Array {
  const o = new Float32Array(CW * CH * 3);
  for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
    let r: number, gg: number, b: number;
    if (x < 32) {
      const a = Math.atan2(y - 24, x - 16) / (2 * Math.PI) + 0.5, d = Math.hypot(x - 16, y - 24) / 16;
      const hue = (k: number) => Math.max(0, Math.min(1, Math.abs(((a * 6 + k) % 6) - 3) - 1));
      [r, gg, b] = d > 1 ? [0.9, 0.9, 0.9] : [hue(0) * d + (1 - d), hue(4) * d + (1 - d), hue(2) * d + (1 - d)];
    } else if (y < 24) { const v = Math.floor((x - 32) / (1 + Math.floor((x - 32) / 8))) % 2 ? 0.05 : 0.95; [r, gg, b] = [v, v, v]; }
    else { [r, gg, b] = x < 48 ? [0.85, 0.1, 0.1] : [0.1, 0.15, 0.85]; }
    o.set([r, gg, b], 3 * (y * CW + x));
  }
  return o;
}

export function colourWidget(): Widget {
  let view: 'card' | 'raw' | 'demosaic' = 'raw';
  const cv = h('canvas', { width: CW, height: CH, class: 'sn-canvas pix', role: 'img', 'aria-label': 'A test card, as the Bayer mosaic sees it, and after demosaicing' }) as HTMLCanvasElement;
  const chips = mkChips(3), note = h('p', { class: 'sub mos-note' });
  const src = card(), raw = mosaic(src, CW, CH), back = demosaic(raw, CW, CH);
  const paint = () => {
    const c = cv.getContext('2d');
    if (!c) return;
    const img = c.createImageData(CW, CH);
    for (let i = 0; i < CW * CH; i++) {
      const x = i % CW, y = Math.floor(i / CW);
      let rgb: number[];
      if (view === 'card') rgb = [src[3 * i], src[3 * i + 1], src[3 * i + 2]];
      else if (view === 'demosaic') rgb = [back[3 * i], back[3 * i + 1], back[3 * i + 2]];
      else { const f = bayerAt(x, y), v = raw[i]; rgb = [f === 'R' ? v : 0, f === 'G' ? v : 0, f === 'B' ? v : 0]; }
      img.data.set([rgb[0] * 255, rgb[1] * 255, rgb[2] * 255, 255], 4 * i);
    }
    c.putImageData(img, 0, 0);
    let err = 0, fc = 0;
    for (let i = 0; i < CW * CH; i++) {
      const d = Math.abs(back[3 * i] - src[3 * i]) + Math.abs(back[3 * i + 1] - src[3 * i + 1]) + Math.abs(back[3 * i + 2] - src[3 * i + 2]);
      err += d; if (d > 0.3) fc++;
    }
    chips.set(0, '50 %', 'of the pixels are green, 25 % red, 25 % blue');
    chips.set(1, String(fc), `pixels of ${g(CW * CH)} more than 0.3 off after demosaicing: the fine stripes and the edge`);
    chips.set(2, `${num(err / (CW * CH * 3), 3)}`, 'mean error a channel (0 to 1)');
  };
  const seg = h('div', { class: 'qz-seg', role: 'group', 'aria-label': 'View' }, ...([['card', 'The scene'], ['raw', 'Through the mosaic'], ['demosaic', 'Demosaiced']] as const).map(([k, t]) => { const b = btn(t, () => { view = k; seg.querySelectorAll('button').forEach((x, i) => x.setAttribute('aria-pressed', String(['card', 'raw', 'demosaic'][i] === view))); paint(); }); b.setAttribute('aria-pressed', String(k === view)); return b; }));
  note.textContent = 'Each pixel has one filter over it, so it measures one colour. Demosaicing guesses the other two from the neighbours (here bilinear: the average of the nearest pixels that have that colour). Smooth areas come back nearly exactly; where the scene changes from one pixel to the next, the guesses disagree and colour fringes appear that were never there.';
  paint();
  return { el: h('div', { class: 'widget mos sn' }, h('div', { class: 'panel sn-center' }, cv), h('div', { class: 'panel mos-ctl' }, seg, note), chips.el) };
}

// ---------------------------------------------------------------------------------------------------------------------
// 7. Noise: what limits a pixel

export function noiseWidget(): Widget {
  let photons = 1000, temp = 293, expo = 1;
  const plot = plotOf({ W: 460, H: 240, x: [0, 6], y: [-1, 3], yTicks: [-1, 0, 1, 2, 3], xLabel: 'photons on the pixel (log₁₀)', yLabel: 'SNR (log₁₀)', aria: 'Signal-to-noise ratio against light for the IMX183 and the CCD42-40', xFmt: (v) => `10${'⁰¹²³⁴⁵⁶'[Math.round(v)] ?? ''}`, yFmt: (v) => `${10 ** v >= 1 ? g(10 ** v) : num(10 ** v, 1)}` });
  const cv = h('canvas', { width: 48, height: 48, class: 'sn-canvas pix', role: 'img', 'aria-label': 'A patch of pixels at the chosen light, with shot and read noise' }) as HTMLCanvasElement;
  const chips = mkChips(4), note = h('p', { class: 'sub mos-note' });
  const snrOf = (p: number, part: { fullWell: number; readNoise: number; peakQe: number }, dark: number) => {
    const sig = Math.min(part.fullWell, p * part.peakQe);
    return sig / Math.sqrt(sig + dark + part.readNoise ** 2);
  };
  const paint = () => {
    const xs = Array.from({ length: 121 }, (_, i) => i / 20);
    const darkCcd = darkCurrent(temp) * expo;
    plot.clear();
    line(plot, xs, xs.map((x) => Math.log10(Math.max(0.1, snrOf(10 ** x, CCD42_40, darkCcd)))), 'lump');
    line(plot, xs, xs.map((x) => Math.log10(Math.max(0.1, snrOf(10 ** x, IMX183, 0)))), 'real');
    line(plot, xs, xs.map((x) => Math.log10(Math.max(0.1, Math.sqrt(10 ** x)))), 'near');
    const lx = Math.log10(photons);
    plot.layer.append(s('line', { x1: plot.X(lx), x2: plot.X(lx), y1: plot.Y(-1), y2: plot.Y(3), class: 'ln-h t50' }));
    // the patch: Poisson light + read noise, at the IMX183's numbers
    const c = cv.getContext('2d');
    if (c) {
      const r = rng(5), img = c.createImageData(48, 48), mean = Math.min(IMX183.fullWell, photons * IMX183.peakQe);
      for (let i = 0; i < 48 * 48; i++) {
        const e = Math.min(IMX183.fullWell, poisson(mean, r) + normal(r) * IMX183.readNoise);
        const v = Math.max(0, Math.min(255, (e / Math.max(1, mean * 2)) * 255));
        img.data.set([v, v, v, 255], 4 * i);
      }
      c.putImageData(img, 0, 0);
    }
    const sig = Math.min(IMX183.fullWell, photons * IMX183.peakQe);
    chips.set(0, `${num(snrOf(photons, IMX183, 0), 1)}`, `IMX183 SNR at ${g(photons)} photons (${g(sig)} e⁻)`);
    chips.set(1, `${num(dynamicRangeDb(IMX183), 1)} dB`, `IMX183 dynamic range: ${g(IMX183.fullWell)} e⁻ over ${IMX183.readNoise} e⁻`);
    chips.set(2, `${num(dynamicRangeDb(CCD42_40), 1)} dB`, `CCD42-40: ${g(CCD42_40.fullWell)} e⁻ over ${CCD42_40.readNoise} e⁻`);
    chips.set(3, `${g(darkCcd)} e⁻`, `CCD42-40 dark charge in ${expo} s at ${temp - 273} °C`);
  };
  const ph = slider('Light', 0, 6, 0.1, 3, (v) => `${g(10 ** v)} photons`, (v) => { photons = 10 ** v; paint(); });
  const tt = slider('CCD at', 173, 303, 5, temp, (v) => `${v - 273} °C`, (v) => { temp = v; paint(); });
  const ex = slider('Exposure', 0, 3, 1, 0, (v) => `${10 ** v} s`, (v) => { expo = 10 ** v; paint(); });
  note.textContent = 'Solid: the IMX183 (QE 79 %, 3.3 e⁻ read noise, 14 837 e⁻ full well, FLIR\'s EMVA measurement). Dashed: the CCD42-40 (80 %, 3 e⁻, 150 000 e⁻) with its dark charge at the temperature and exposure set. Orange: the limit no sensor beats, √photons. In the dark the read noise rules; in bright light the photons\' own randomness does; at the top the well is full and the curve stops.';
  paint();
  return { el: h('div', { class: 'widget mos sn' }, h('div', { class: 'panel sn-two' }, plot.el, cv), h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' }, ph.el, tt.el, ex.el), note), chips.el) };
}
