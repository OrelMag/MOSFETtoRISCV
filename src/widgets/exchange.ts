// Chapter 40's explainers: the cost of wiring everyone to everyone, of a switching network, the busy tone (Erlang B)
// and the teleprinter's start-stop frame. All numbers come from comm/exchange.ts and comm/startstop.ts.

import { bestClos, capacityAt, clos, crossbarCrosspoints, erlangB, foldedCrosspoints, meshWires, offered, trunksFor } from '../comm/exchange';
import { ITA2_START_STOP, UART_8N1, frameUnits, receive, segments, stopIndex, tolerance, toleranceClosedForm, type Frame } from '../comm/startstop';
import { groupDigits } from '../sim/numfmt';
import { h, s } from '../ui/dom';
import type { Widget } from '../view/stage';
import { chipRow } from './comm';
import { slider } from './mosparts';

const n0 = (x: number) => groupDigits(Math.round(x));

// ---------------------------------------------------------------- everyone to everyone

export function meshWidget(): Widget {
  let n = 6;
  const W = 640, H = 270, R = 100, CY = 135;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'mos-plot comm-mesh', role: 'img', 'aria-label': 'n telephones wired to each other, and wired to one exchange' });
  const chips = chipRow();
  const note = h('p', { class: 'sub mos-note' });
  function paint() {
    svg.replaceChildren();
    const ang = (i: number) => (2 * Math.PI * i) / n - Math.PI / 2;
    const left = (i: number): [number, number] => [165 + R * Math.cos(ang(i)), CY + R * Math.sin(ang(i))];
    const right = (i: number): [number, number] => [475 + R * Math.cos(ang(i)), CY + R * Math.sin(ang(i))];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) svg.append(s('line', { x1: left(i)[0], y1: left(i)[1], x2: left(j)[0], y2: left(j)[1], class: 'mesh-wire' }));
    for (let i = 0; i < n; i++) svg.append(s('line', { x1: right(i)[0], y1: right(i)[1], x2: 475, y2: CY, class: 'mesh-wire star' }));
    for (let i = 0; i < n; i++) svg.append(s('circle', { cx: left(i)[0], cy: left(i)[1], r: 6, class: 'mesh-node' }), s('circle', { cx: right(i)[0], cy: right(i)[1], r: 6, class: 'mesh-node' }));
    svg.append(s('rect', { x: 459, y: CY - 16, width: 32, height: 32, rx: 4, class: 'mesh-ex' }), s('text', { x: 475, y: CY + 4, 'text-anchor': 'middle', class: 'tick' }, 'switch'),
      s('text', { x: 165, y: 14, 'text-anchor': 'middle', class: 'axl' }, `a wire for every pair: ${meshWires(n)}`), s('text', { x: 475, y: 14, 'text-anchor': 'middle', class: 'axl' }, `a wire for every phone: ${n}`));
    chips.set(0, String(meshWires(n)), `wires in the full mesh, n(n − 1) / 2`);
    chips.set(1, String(n - 1), 'jacks on each phone in the mesh (1 on the exchange)');
    chips.set(2, n0(meshWires(1000)), 'wires for 1 000 phones in a mesh');
    chips.set(3, n0(crossbarCrosspoints(1000)), 'crosspoints in a 1 000 × 1 000 crossbar: contacts, not wires');
    note.textContent = `The exchange turns n(n − 1) / 2 permanent wires into n wires and a switch that makes the one wire a call needs. From four phones up the star needs fewer wires (${meshWires(4)} for a mesh, 4 for a star).`;
  }
  const nSl = slider('Phones', 2, 16, 1, n, (v) => String(v), (v) => { n = v; paint(); });
  const el = h('div', { class: 'widget mos comm' }, h('div', { class: 'panel' }, h('h3', null, 'Everyone to everyone, or everyone to one place'), svg),
    h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' }, nSl.el), note), chips.el);
  paint();
  return { el };
}

// ---------------------------------------------------------------- the cost of a switching network

export function networkCostWidget(): Widget {
  let k = 8;
  const W = 640, H = 280, M = { l: 62, r: 18, t: 14, b: 34 }, K0 = 3, K1 = 14;
  const lg = (v: number) => Math.log10(Math.max(v, 1));
  const Ymax = 9, X = (kk: number) => M.l + ((kk - K0) / (K1 - K0)) * (W - M.l - M.r), Y = (v: number) => M.t + ((Ymax - lg(v)) / Ymax) * (H - M.t - M.b);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'mos-plot', role: 'img', 'aria-label': 'Crosspoints against number of lines for a crossbar and a Clos network, on log axes' });
  for (let e = 0; e <= Ymax; e += 1) svg.append(s('line', { x1: M.l, x2: W - M.r, y1: Y(10 ** e), y2: Y(10 ** e), class: 'grid' }), s('text', { x: M.l - 6, y: Y(10 ** e) + 3.5, 'text-anchor': 'end', class: 'tick' }, `10^${e}`));
  for (let kk = K0; kk <= K1; kk += 1) svg.append(s('text', { x: X(kk), y: H - M.b + 14, 'text-anchor': 'middle', class: 'tick' }, groupDigits(2 ** kk)));
  svg.append(s('line', { x1: M.l, x2: W - M.r, y1: H - M.b, y2: H - M.b, class: 'ax' }), s('text', { x: W - M.r, y: H - 4, 'text-anchor': 'end', class: 'axl' }, 'lines'), s('text', { x: 8, y: M.t, 'text-anchor': 'end', 'dominant-baseline': 'hanging', transform: `rotate(-90 8 ${M.t})`, class: 'axl' }, 'crosspoints'));
  const curve = (f: (N: number) => number, cls: string) => {
    let d = '';
    for (let kk = K0; kk <= K1; kk += 0.25) d += `${d ? 'L' : 'M'}${X(kk).toFixed(1)} ${Y(f(2 ** kk)).toFixed(1)}`;
    return s('path', { d, class: cls });
  };
  // Clos at fractional k: the cost law, N at the continuous optimum (n = sqrt(N / 2), m = 2n - 1)
  const closLaw = (N: number) => { const n = Math.sqrt(N / 2); return 2 * N * (2 * n - 1) + (2 * n - 1) * (N / n) ** 2; };
  svg.append(curve(crossbarCrosspoints, 'cur'), curve(foldedCrosspoints, 'fam'), curve(closLaw, 'bound'));
  const dots = s('g');
  svg.append(dots);
  const chips = chipRow();
  const note = h('p', { class: 'sub mos-note' });
  function paint() {
    const N = 2 ** k, c = bestClos(N), cr = clos(N, c.n, c.n)!;
    dots.replaceChildren(s('circle', { cx: X(k), cy: Y(crossbarCrosspoints(N)), r: 5, class: 'op' }), s('circle', { cx: X(k), cy: Y(c.crosspoints), r: 5, class: 'op' }));
    chips.set(0, n0(crossbarCrosspoints(N)), `crossbar: N² for N = ${n0(N)}`);
    chips.set(1, n0(c.crosspoints), `Clos, n = ${c.n}, r = ${c.r}, m = ${c.m}: 2Nm + m r²`);
    chips.set(2, `${(crossbarCrosspoints(N) / c.crosspoints).toFixed(2)} ×`, c.crosspoints < crossbarCrosspoints(N) ? 'fewer crosspoints than the crossbar' : 'the crossbar is still cheaper here');
    chips.set(3, n0(cr.crosspoints), `Clos with m = n = ${c.n}: only rearrangeably non-blocking`);
    note.textContent = `A call can be blocked in a Clos network by calls already up, unless the middle stage has m ≥ 2n − 1 switches (Clos, 1953); with m ≥ n every blocked call can be made to fit by re-routing calls in progress, which a telephone line in the middle of a call cannot take. Plot: the solid curve is a crossbar, the thin one a switch per pair (N(N − 1) / 2), the dashed one a Clos network at its best n.`;
  }
  const kSl = slider('Lines', K0, K1, 1, k, (v) => n0(2 ** v), (v) => { k = v; paint(); });
  const el = h('div', { class: 'widget mos comm' }, h('div', { class: 'panel' }, h('h3', null, 'What it costs to let any line reach any other'), svg),
    h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' }, kSl.el), note), chips.el);
  paint();
  return { el };
}

// ---------------------------------------------------------------- the busy tone

export function erlangWidget(): Widget {
  let subs = 1000, perHour = 2, holdMin = 3, trunks = 60;
  const W = 640, H = 270, M = { l: 66, r: 18, t: 14, b: 34 }, TMAX = 200;
  const X = (m: number) => M.l + (m / TMAX) * (W - M.l - M.r);
  const Y = (b: number) => M.t + ((Math.log10(1) - Math.log10(Math.max(b, 1e-4))) / 4) * (H - M.t - M.b);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'mos-plot', role: 'img', 'aria-label': 'Probability that a call is blocked against the number of trunks' });
  for (const v of [1e-4, 1e-3, 1e-2, 1e-1, 1]) svg.append(s('line', { x1: M.l, x2: W - M.r, y1: Y(v), y2: Y(v), class: 'grid' }), s('text', { x: M.l - 6, y: Y(v) + 3.5, 'text-anchor': 'end', class: 'tick' }, v === 1 ? '100 %' : `${+(v * 100).toPrecision(2)} %`));
  for (let m = 0; m <= TMAX; m += 50) svg.append(s('text', { x: X(m), y: H - M.b + 14, 'text-anchor': 'middle', class: 'tick' }, String(m)));
  svg.append(s('line', { x1: M.l, x2: W - M.r, y1: H - M.b, y2: H - M.b, class: 'ax' }), s('text', { x: W - M.r, y: H - 4, 'text-anchor': 'end', class: 'axl' }, 'trunks'), s('text', { x: 8, y: M.t, 'text-anchor': 'end', 'dominant-baseline': 'hanging', transform: `rotate(-90 8 ${M.t})`, class: 'axl' }, 'calls blocked'));
  const cur = s('path', { class: 'cur' }), gos = s('line', { class: 'bound' }), dot = s('circle', { r: 6, class: 'op' });
  svg.append(gos, cur, dot);
  const chips = chipRow();
  const note = h('p', { class: 'sub mos-note' });
  function paint() {
    const E = offered(subs, perHour, holdMin), b = erlangB(E, trunks), need = trunksFor(E, 0.01);
    let d = '';
    for (let m = 0; m <= TMAX; m += 1) d += `${d ? 'L' : 'M'}${X(m).toFixed(1)} ${Y(erlangB(E, m)).toFixed(1)}`;
    cur.setAttribute('d', d);
    gos.setAttribute('x1', String(M.l)); gos.setAttribute('x2', String(W - M.r)); gos.setAttribute('y1', String(Y(0.01))); gos.setAttribute('y2', String(Y(0.01)));
    dot.setAttribute('cx', String(X(trunks))); dot.setAttribute('cy', String(Y(b))); dot.setAttribute('class', `op ${b > 0.01 ? 'bad' : ''}`);
    chips.set(0, `${E.toFixed(1)} E`, `offered: ${n0(subs)} × ${perHour} calls an hour × ${holdMin} min ÷ 60`);
    chips.set(1, `${(100 * b).toFixed(b < 0.1 ? 2 : 1)} %`, `blocked with ${trunks} trunks (Erlang B)`);
    chips.set(2, String(need), `trunks for 1 % blocking (a trunk per phone: ${n0(subs)})`);
    chips.set(3, `${capacityAt(trunks, 0.01).toFixed(1)} E`, `${trunks} trunks carry at 1 % blocking`);
    note.textContent = 'Erlang B assumes calls arrive at random, are blocked calls cleared (the caller hangs up and does not retry at once) and hold the line for random times. Real callers retry, which makes the load worse than the model says.';
    note.classList.toggle('bad', b > 0.01);
  }
  const sSl = slider('Phones', 50, 5000, 50, subs, (v) => n0(v), (v) => { subs = v; paint(); });
  const cSl = slider('Calls/h', 0.5, 6, 0.5, perHour, (v) => String(v), (v) => { perHour = v; paint(); });
  const hSl = slider('Holding', 1, 10, 0.5, holdMin, (v) => `${v} min`, (v) => { holdMin = v; paint(); });
  const tSl = slider('Trunks', 1, TMAX, 1, trunks, (v) => String(v), (v) => { trunks = v; paint(); });
  const el = h('div', { class: 'widget mos comm' }, h('div', { class: 'panel' }, h('h3', null, 'Trunks between two exchanges, and the busy tone'), svg),
    h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' }, sSl.el, cSl.el), h('div', { class: 'mos-row' }, hSl.el, tSl.el), note), chips.el);
  paint();
  return { el };
}

// ---------------------------------------------------------------- start-stop

const FRAMES: { name: string; f: Frame; ticks?: number }[] = [
  { name: 'Teleprinter: 5 data, stop 1.5', f: ITA2_START_STOP },
  { name: 'UART: 8 data, 1 stop', f: UART_8N1 },
];

export function startStopWidget(): Widget {
  let which = 0, code = 0b10110, err = 0, ticks = false;
  const W = 640, H = 170, ML = 14, MR = 14;
  const holder = h('div', { class: 'comm-tapes' });
  const chips = chipRow();
  const note = h('p', { class: 'sub mos-note' });
  const found = h('p', { class: 'sub mos-note' });
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Frame' });
  const buttons = FRAMES.map((fr, i) => { const b = h('button', { type: 'button' }, fr.name); b.addEventListener('click', () => { which = i; code = Math.min(code, 2 ** fr.f.data - 1); cSl.set(code); cSl.setMax(2 ** fr.f.data - 1); paint(); }); return b; });
  seg.append(...buttons);
  const tickBox = h('input', { type: 'checkbox', 'aria-label': 'Receiver counts 16 ticks a bit' }) as HTMLInputElement;
  tickBox.addEventListener('change', () => { ticks = tickBox.checked; paint(); });
  const cache = new Map<string, ReturnType<typeof tolerance>>();
  function paint() {
    const f = FRAMES[which].f, units = frameUnits(f), px = (W - ML - MR) / (units + 1);
    const r = receive(f, code, { err: err / 100, ticks: ticks ? 16 : undefined, phase: ticks ? 0.5 : 0 });
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'mos-plot comm-tape', role: 'img', 'aria-label': 'The frame on the line and the instants the receiver samples it' });
    const yH = 40, yL = 90;
    let d = `M${ML} ${yH}`;
    const segs = segments(f, code);
    let lvl = 1;
    for (const g of segs) { const y = g.level ? yH : yL; if (g.level !== lvl) d += `L${ML + g.from * px} ${lvl ? yH : yL}L${ML + g.from * px} ${y}`; d += `L${ML + g.to * px} ${y}`; lvl = g.level; }
    d += `L${ML + units * px} ${yH}L${W - MR} ${yH}`;
    for (const g of segs) svg.append(s('text', { x: ML + ((g.from + g.to) / 2) * px, y: 20, 'text-anchor': 'middle', class: 'tick' }, g.label), s('line', { x1: ML + g.from * px, x2: ML + g.from * px, y1: 28, y2: 110, class: 'grid' }));
    svg.append(s('path', { d, class: 'wave ita' }));
    for (const sm of r.samples) {
      const right = sm.level === (sm.label === 'stop' ? 1 : sm.label === 'p' ? segs.find((g) => g.label === 'p')!.level : (code >> Number(sm.label.slice(1))) & 1);
      svg.append(s('line', { x1: ML + sm.at * px, x2: ML + sm.at * px, y1: 28, y2: 124, class: `samp ${right ? 'ok' : 'bad'}` }),
        s('text', { x: ML + sm.at * px, y: 138 + (sm.label.endsWith('1') || sm.label === 'stop' ? 12 : 0), 'text-anchor': 'middle', class: `tick ${right ? '' : 'bad-l'}` }, sm.label));
    }
    svg.append(s('text', { x: W - MR, y: H - 4, 'text-anchor': 'end', class: 'axl' }, 'transmitter units; vertical lines: where the receiver looks'));
    holder.replaceChildren(svg);
    buttons.forEach((b, i) => { b.classList.toggle('on', i === which); b.setAttribute('aria-pressed', String(i === which)); });
    const bin = (v: number) => v.toString(2).padStart(f.data, '0');
    chips.set(0, bin(code), `sent (bit 1 first on the line: ${bin(code).split('').reverse().join('')})`);
    chips.set(1, bin(r.word), r.word === code ? 'received: the same' : 'received: different');
    chips.set(2, r.stopOk ? 'stop seen' : 'framing error', r.stopOk ? 'the line is high where the stop unit should be' : 'the stop sample found the line low');
    const cf = toleranceClosedForm(f);
    chips.set(3, `+${(100 * cf.fast).toFixed(2)} % / −${(100 * cf.slow).toFixed(2)} %`, `speed error allowed for an isolated character, sampling mid-bit (${stopIndex(f)} units before the stop)`);
    note.textContent = r.ok ? 'Every sample falls inside its own unit.' : 'A sample has crossed into a neighbouring unit: it reads that unit instead. The error is invisible when the neighbour has the same level, which is why one data word can pass where another fails.';
    note.classList.toggle('bad', !r.ok);
  }
  const key = () => `${which}:${ticks}`;
  const search = h('button', { type: 'button', class: 'btn' }, 'Search every code');
  search.addEventListener('click', () => {
    const f = FRAMES[which].f;
    found.textContent = `Trying all ${2 ** f.data} codes at every error from 0 outward in 0.01 % steps …`;
    setTimeout(() => {
      let t = cache.get(key());
      if (!t) { t = tolerance(f, ticks ? { ticks: 16 } : {}); cache.set(key(), t); }
      const w = (c: number | null) => (c === null ? 'none' : c.toString(2).padStart(f.data, '0'));
      found.textContent = `Found: every code is received from −${(100 * t.slow).toFixed(2)} % to +${(100 * t.fast).toFixed(2)} % (${ticks ? 'a 16-tick receiver, start edge at its worst phase' : 'a continuous clock'}). The first to fail: ${w(t.failFast)} on a fast receiver, ${w(t.failSlow)} on a slow one.`;
    }, 20);
  });
  const eSl = slider('Receiver', -12, 12, 0.1, err, (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} %`, (v) => { err = v; paint(); });
  const cSl = (() => { const x = slider('Data', 0, 2 ** FRAMES[which].f.data - 1, 1, code, (v) => v.toString(2).padStart(FRAMES[which].f.data, '0'), (v) => { code = v; paint(); }); const inp = x.el.querySelector('input')!; return { ...x, setMax(m: number) { inp.max = String(m); } }; })();
  const el = h('div', { class: 'widget mos comm' }, h('div', { class: 'panel' }, h('h3', null, 'A character, and a receiver whose clock is not quite right ', seg), holder),
    h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' }, eSl.el, cSl.el), h('label', { class: 'comm-check' }, tickBox, ' receiver counts 16 ticks a bit, and notices the start edge up to a tick late'), note, h('div', { class: 'mos-row' }, search), found), chips.el);
  paint();
  return { el };
}
