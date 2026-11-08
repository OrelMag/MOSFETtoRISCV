// The on-ramp's explorers: a message as bits, how long it takes, what fits on the line, what packets and layers cost, and decibels.
// Every number is comm/message.ts's; nothing here assumes more than Chapter 0.

import { bytesWithLoss, cleanChance, delayOf, layerCost, onTheLine, packetCount, pushTime, storeAndForward, travelTime, TCP_HEADER, WIRE_OVERHEAD } from '../comm/message';
import { dbToRatio } from '../comm/limits';
import { IP_HEADER } from '../net/ipv4';
import { h, s } from '../ui/dom';
import type { Widget } from '../view/stage';
import { line, mkChips, plotOf } from './line';
import { slider } from './mosparts';
import '../styles/line.css';
import '../styles/fourier.css';
import '../styles/signals.css';

/** 10 to a whole power, set as text: 10⁻³. */
export const pow10 = (e: number): string => (e === 0 ? '1' : `10${e < 0 ? '⁻' : ''}${[...String(Math.abs(e))].map((c) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(c)]).join('')}`);

/** A time, in the unit that reads best. */
export function fmtTime(t: number): string {
  if (t < 1e-6) return `${+(t * 1e9).toPrecision(3)} ns`;
  if (t < 1e-3) return `${+(t * 1e6).toPrecision(3)} µs`;
  if (t < 1) return `${+(t * 1e3).toPrecision(3)} ms`;
  if (t < 120) return `${+t.toPrecision(3)} s`;
  if (t < 7200) return `${+(t / 60).toPrecision(3)} min`;
  if (t < 172800) return `${+(t / 3600).toPrecision(3)} h`;
  return `${+(t / 86400).toPrecision(3)} days`;
}
export function fmtBytes(b: number): string {
  if (b < 1e3) return `${+b.toPrecision(3)} B`;
  if (b < 1e6) return `${+(b / 1e3).toPrecision(3)} KB`;
  if (b < 1e9) return `${+(b / 1e6).toPrecision(3)} MB`;
  if (b < 1e12) return `${+(b / 1e9).toPrecision(3)} GB`;
  return `${+(b / 1e12).toPrecision(3)} TB`;
}
export function fmtRate(r: number): string {
  if (r < 1e3) return `${+r.toPrecision(3)} b/s`;
  if (r < 1e6) return `${+(r / 1e3).toPrecision(3)} kb/s`;
  if (r < 1e9) return `${+(r / 1e6).toPrecision(3)} Mb/s`;
  if (r < 1e12) return `${+(r / 1e9).toPrecision(3)} Gb/s`;
  return `${+(r / 1e12).toPrecision(3)} Tb/s`;
}

const RATES = [300, 56e3, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 4e11, 8e11, 1.6e12];
const SIZES = [100, 500, 1e3, 1e4, 1e5, 1e6, 5e6, 1e7, 1e8, 1e9, 1e10];
const DISTS: [number, string][] = [[10, '10 m'], [1e3, '1 km'], [5e5, '500 km'], [3e6, '3000 km'], [5.6e6, '5600 km'], [2e7, '20 000 km']];

// ---- a message as bits ------------------------------------------------------------------------------------------------------------

export function bitsWidget(): Widget {
  let rate = 1;
  const input = h('input', { class: 'comm-input', value: 'Hi', maxlength: '8', 'aria-label': 'A message of up to 8 characters' }) as HTMLInputElement;
  const W = 640, H = 90;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'mos-plot', role: 'img', 'aria-label': 'The message as a voltage on a wire: high for 1, low for 0, each bit for the same time' }) as SVGSVGElement;
  const rows = h('div', { class: 'sg-bytes' }), chips = mkChips(3);
  function paint() {
    const bytes = [...new TextEncoder().encode(input.value)];
    const bits = bytes.flatMap((b) => Array.from({ length: 8 }, (_, i) => (b >> (7 - i)) & 1));
    rows.replaceChildren(...bytes.map((b) => h('div', null, h('code', null, b.toString(2).padStart(8, '0')), h('span', null, String(b)))));
    svg.replaceChildren();
    if (bits.length) {
      const dx = W / bits.length, y = (b: number) => (b ? 16 : 70);
      let d = `M0 ${y(bits[0])}`;
      bits.forEach((b, i) => { d += `H${(i * dx).toFixed(1)}V${y(b)}H${((i + 1) * dx).toFixed(1)}`; });
      for (let i = 8; i < bits.length; i += 8) svg.append(s('line', { x1: i * dx, x2: i * dx, y1: 4, y2: H - 4, class: 'sg-tick' }));
      svg.append(s('path', { d, class: 'ln-s real' }));
    }
    chips.set(0, String(bytes.length), 'bytes');
    chips.set(1, String(bits.length), 'bits');
    chips.set(2, fmtTime(bits.length / rate), `to send at ${fmtRate(rate)}`);
  }
  input.addEventListener('input', paint);
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'A message on a wire'), h('label', { class: 'mos-sl ln-sel' }, h('span', null, 'Message'), input), rows, svg),
      h('div', { class: 'panel mos-ctl' }, slider('Rate', 0, 6, 1, 0, (v) => fmtRate(10 ** v), (v) => { rate = 10 ** v; paint(); }).el, chips.el)),
  };
}

// ---- how long does it take ----------------------------------------------------------------------------------------------------------

/** The two parts of a delay as one bar. */
function splitBar(aLabel: string, bLabel: string) {
  const a = h('div', { class: 'sg-seg a' }), b = h('div', { class: 'sg-seg b' });
  const bar = h('div', { class: 'sg-bar', role: 'img' }, a, b);
  return {
    el: h('div', null, bar, h('div', { class: 'ln-key' }, h('span', { class: 'sg-ka' }, aLabel), h('span', { class: 'sg-kb' }, bLabel))),
    set(x: number, y: number) {
      const share = (100 * x) / (x + y);
      a.style.width = `${share}%`;
      b.style.width = `${100 - share}%`;
      bar.setAttribute('aria-label', `${aLabel} ${fmtTime(x)}; ${bLabel} ${fmtTime(y)}`);
    },
  };
}

export function delayWidget(): Widget {
  let size = 2, rate = 5, dist = 4;
  const bar = splitBar('pushing onto the line', 'travelling'), chips = mkChips(3);
  function paint() {
    const b = SIZES[size], r = RATES[rate], m = DISTS[dist][0];
    bar.set(pushTime(b, r), travelTime(m));
    chips.set(0, fmtTime(pushTime(b, r)), 'pushing: size ÷ rate');
    chips.set(1, fmtTime(travelTime(m)), 'travelling: distance ÷ speed');
    chips.set(2, fmtTime(delayOf(b, r, m)), 'the whole delay');
  }
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'Where the time goes'), bar.el, chips.el),
      h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' },
        slider('Size', 0, SIZES.length - 1, 1, size, (v) => fmtBytes(SIZES[v]), (v) => { size = v; paint(); }).el,
        slider('Rate', 0, RATES.length - 1, 1, rate, (v) => fmtRate(RATES[v]), (v) => { rate = v; paint(); }).el,
        slider('Distance', 0, DISTS.length - 1, 1, dist, (v) => DISTS[v][1], (v) => { dist = v; paint(); }).el))),
  };
}

// ---- what fits on the line ------------------------------------------------------------------------------------------------------------

/** Kilometres an hour of a van on a motorway: only the arithmetic matters. */
export const VAN_KMH = 80;

export function pipeWidget(): Widget {
  let rate = 6, dist = 4, tb = 100, km = 500;
  const chips = mkChips(2), race = mkChips(2);
  function paint() {
    const r = RATES[rate], m = DISTS[dist][0], link = (tb * 1e12 * 8) / RATES[6], van = km / VAN_KMH * 3600;
    chips.set(0, fmtBytes(onTheLine(r, m)), `on the line at once, at ${fmtRate(r)}`);
    chips.set(1, fmtTime(2 * travelTime(m)), 'before a reply can come back');
    race.set(0, fmtTime(link), `${tb} TB over a ${fmtRate(RATES[6])} link`);
    race.set(1, fmtTime(van), `the same disks driven ${km} km at ${VAN_KMH} km/h`, van < link ? 'good' : '');
  }
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'A line is a long pipe'), chips.el, h('div', { class: 'mos-row' },
        slider('Rate', 0, RATES.length - 1, 1, rate, (v) => fmtRate(RATES[v]), (v) => { rate = v; paint(); }).el,
        slider('Distance', 0, DISTS.length - 1, 1, dist, (v) => DISTS[v][1], (v) => { dist = v; paint(); }).el)),
      h('div', { class: 'panel' }, h('h3', null, 'Fast is not the same as soon'), race.el, h('div', { class: 'mos-row' },
        slider('Data', 1, 1000, 1, tb, (v) => `${v} TB`, (v) => { tb = v; paint(); }).el,
        slider('Drive', 10, 2000, 10, km, (v) => `${v} km`, (v) => { km = v; paint(); }).el))),
  };
}

// ---- packets --------------------------------------------------------------------------------------------------------------------------

const MESSAGE = 1e6, HEADER = 40;

export function packetWidget(): Widget {
  let exp = 3, hops = 4, rate = 1e7, ber = -6;
  // the x axis is log10 of the payload, from 10 B (1) to the whole message (6)
  const plot = plotOf({ W: 640, H: 220, x: [0, 6], y: [0, 1], yTicks: [0, 0.5, 1], xLabel: 'data bytes a packet', yLabel: 'share of the longest', aria: 'Time to deliver a megabyte over the links, against the size of a packet', xFmt: pow10 });
  const chips = mkChips(4), note = h('p', { class: 'sub mos-note' });
  function paint() {
    const payload = Math.round(10 ** exp), plan = { bytes: MESSAGE, payload, header: HEADER, rate, hops };
    const xs = Array.from({ length: 61 }, (_, i) => i / 10), ys = xs.map((x) => (x < 1 ? NaN : storeAndForward({ ...plan, payload: Math.round(10 ** x) })));
    const top = Math.max(...ys.filter((v) => !Number.isNaN(v)));
    plot.clear();
    const scaled = (v: number) => v / top;
    const keep = xs.map((_, i) => i).filter((i) => !Number.isNaN(ys[i]));
    line(plot, keep.map((i) => xs[i]), keep.map((i) => scaled(ys[i])), 'ln-s real');
    plot.layer.append(s('circle', { cx: plot.X(exp), cy: plot.Y(scaled(storeAndForward(plan))), r: 5, class: 'sg-dot' }));
    chips.set(0, String(packetCount(plan)), 'packets');
    chips.set(1, fmtTime(storeAndForward(plan)), `to deliver 1 MB over ${hops} links at ${fmtRate(rate)}`);
    chips.set(2, `${(100 * cleanChance(payload + HEADER, 10 ** ber)).toFixed(1)} %`, `of packets arrive with no bit wrong, one bit in ${pow10(-ber)} flipped`);
    const sent = bytesWithLoss(plan, 10 ** ber);
    chips.set(3, sent < 1e15 ? fmtBytes(sent) : 'never finishes', 'sent in all, wrong ones sent again');
    note.textContent = `The curve's top is ${fmtTime(top)}. Small packets lose to their ${HEADER}-byte headers; large ones wait, whole, at every link.`;
  }
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'How big should a packet be?'), plot.el, chips.el, note),
      h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' },
        slider('Packet', 1, 6, 0.25, exp, (v) => fmtBytes(Math.round(10 ** v)), (v) => { exp = v; paint(); }).el,
        slider('Links', 1, 12, 1, hops, (v) => String(v), (v) => { hops = v; paint(); }).el,
        slider('Rate', 6, 9, 1, 7, (v) => fmtRate(10 ** v), (v) => { rate = 10 ** v; paint(); }).el,
        slider('Wrong bits', -9, -4, 1, ber, (v) => `1 in ${pow10(-v)}`, (v) => { ber = v; paint(); }).el))),
  };
}

// ---- layers ----------------------------------------------------------------------------------------------------------------------------

export function layersWidget(): Widget {
  let data = 1460;
  const stack = h('div', { class: 'sg-layers' }), chips = mkChips(2);
  const row = (label: string, what: string, n: number, cls: string, inner: HTMLElement | null) =>
    h('div', { class: `sg-layer ${cls}` }, h('div', { class: 'sg-lh' }, h('b', null, label), h('span', null, what), h('code', null, `${n} bytes`)), inner);
  function paint() {
    const c = layerCost(data);
    stack.replaceChildren(
      row('Ethernet', c.pad ? `which machine on this cable (14), a check of the frame (4), and the preamble and gap the line spends (20); ${c.pad} bytes of padding to its minimum` : 'which machine on this cable (14), a check of the frame (4), and the preamble and gap the line spends (20)', WIRE_OVERHEAD + c.pad, 'l3',
        row('IP', 'which machine in the world', IP_HEADER, 'l2',
          row('TCP', 'which program; which byte comes next', TCP_HEADER, 'l1',
            row('Your data', 'the only part the program asked to send', data, 'l0', null)))));
    chips.set(0, String(c.total), 'bytes on the wire');
    chips.set(1, `${(100 * c.share).toFixed(1)} %`, 'of them are your data', c.share < 0.5 ? 'bad' : '');
  }
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'An envelope inside an envelope'), stack, chips.el),
      h('div', { class: 'panel mos-ctl' }, slider('Data', 1, 1460, 1, data, (v) => `${v} bytes`, (v) => { data = v; paint(); }).el)),
  };
}

// ---- decibels ----------------------------------------------------------------------------------------------------------------------------

const ratio = (r: number) => (r >= 1000 || r < 0.01 ? r.toExponential(1).replace('e+', ' × 10^').replace('e-', ' × 10^−') : `${+r.toPrecision(3)}`);

export function decibelWidget(): Widget {
  const parts: { name: string; db: number; min: number; max: number }[] = [
    { name: 'Amplifier', db: 20, min: 0, max: 40 },
    { name: 'A long cable', db: -60, min: -100, max: 0 },
    { name: 'Second amplifier', db: 30, min: 0, max: 40 },
  ];
  let startDbm = 10;
  const rows = h('div', { class: 'sg-dbrows' }), chips = mkChips(3);
  function paint() {
    let at = startDbm;
    rows.replaceChildren(h('div', { class: 'sg-dbrow head' }, h('span', null, 'Stage'), h('span', null, 'dB'), h('span', null, '× power'), h('span', null, 'Level')),
      h('div', { class: 'sg-dbrow' }, h('span', null, 'Transmitter'), h('span', null, ''), h('span', null, ''), h('span', null, `${startDbm} dBm`)),
      ...parts.map((p) => { at += p.db; return h('div', { class: 'sg-dbrow' }, h('span', null, p.name), h('span', null, `${p.db > 0 ? '+' : p.db < 0 ? '−' : ''}${Math.abs(p.db)}`), h('span', null, `× ${ratio(dbToRatio(p.db))}`), h('span', null, `${at < 0 ? '−' : ''}${Math.abs(at)} dBm`)); }));
    const total = parts.reduce((m, p) => m + p.db, 0);
    chips.set(0, `${total < 0 ? '−' : ''}${Math.abs(total)} dB`, 'the whole chain: the sum');
    chips.set(1, `× ${ratio(dbToRatio(total))}`, 'the same, as a product');
    chips.set(2, `${ratio(10 ** (at / 10))} mW`, 'what arrives');
  }
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'Adding instead of multiplying'), rows, chips.el),
      h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' },
        slider('Transmitter', -10, 30, 1, startDbm, (v) => `${v} dBm`, (v) => { startDbm = v; paint(); }).el,
        ...parts.map((p) => slider(p.name, p.min, p.max, 1, p.db, (v) => `${v} dB`, (v) => { p.db = v; paint(); }).el)))),
  };
}
