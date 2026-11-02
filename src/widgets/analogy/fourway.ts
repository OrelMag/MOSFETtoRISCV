// Figure: a four-way stop (chapter "multicore", "The arbiter"). Round robin is arbiterN's policy (pinned to the gate-level
// arbiter in tests/analogyfigs-h.test.ts); "first come" is the fixed order a request-wire arbiter can have.

import { h, s } from '../../ui/dom';
import { arbMaxWait, arbRun, arbStart, arbStep, ARB_MAX, type ArbState, type Policy } from './system';
import { button, frames, reducedMotion } from './common';
import { choice, stepper } from './sysui';

const W = 360, CX = 180, CY = 92, STEP_MS = 450, MAXW = 6;
const POS: [number, number][] = [[CX, 28], [CX + 84, CY], [CX, CY + 66], [CX - 84, CY]];
const POLICIES: Policy[] = ['first', 'rr'];

export default function mount(host: HTMLElement): void {
  let n = 4, pol = 1, want = [6, 2, 2, 2], st: ArbState = arbStart(want), last = -1, playing = false;
  const svg = s('svg', { viewBox: `0 0 ${W} 262`, class: 'af-svg', role: 'img', 'aria-label': 'A four-way stop: cars waiting, the one going through, and the order they went' });
  const read = h('p', { class: 'af-read', 'aria-live': 'polite' });
  const pols = choice(['First come (lowest core)', 'Round robin'], (i) => { pol = i; reset(); });
  const cores = choice(['2 cores', '3 cores', '4 cores'], (i) => { n = i + 2; reset(); });
  const steppers = Array.from({ length: ARB_MAX }, (_, i) => stepper(`Core ${i}`, () => want[i], (v) => { want[i] = v; reset(); }, 0, MAXW));
  const stop = () => { playing = false; };
  const left = () => st.want.some((w, i) => i < n && w > 0);
  const advance = () => { if (!left()) { stop(); paint(); return; } const r = arbStep(st, POLICIES[pol]); st = r; last = r.grant; paint(); };
  const stepBtn = button('Step', () => { stop(); advance(); });
  const runBtn = button('Run', () => {
    if (reducedMotion()) { stop(); while (left()) { const r = arbStep(st, POLICIES[pol]); st = r; last = r.grant; } paint(); return; }
    if (playing) { stop(); paint(); return; }
    playing = true;
    let acc = 0;
    frames(host, (dt) => { if (!playing) return false; acc += dt; while (acc >= STEP_MS && playing) { acc -= STEP_MS; advance(); } if (!playing) { paint(); return false; } });
    paint();
  });
  const reset = () => { stop(); st = arbStart(want.slice(0, n)); last = -1; paint(); };
  const resetBtn = button('Reset', reset);

  const paint = () => {
    const kids: SVGElement[] = [
      s('rect', { x: CX - 20, y: 8, width: 40, height: 168, class: 'af-road' }),
      s('rect', { x: CX - 104, y: CY - 20, width: 208, height: 40, class: 'af-road' }),
      s('rect', { x: CX - 20, y: CY - 20, width: 40, height: 40, class: 'af-frame' }),
    ];
    for (let i = 0; i < n; i++) {
      const [x, y] = POS[i], w = st.want[i];
      kids.push(s('circle', { cx: x, cy: y, r: 16, class: `af-car af-st${i}${w === 0 ? ' idle' : ''}` }),
        s('text', { x, y: y + 6, 'text-anchor': 'middle', class: 'af-big sm' }, String(i)),
        s('text', { x: i === 0 || i === 2 ? x + 24 : x, y: i === 0 || i === 2 ? y + 6 : y + 34, 'text-anchor': i === 0 || i === 2 ? 'start' : 'middle', class: 'af-t' }, `${w} to go`));
    }
    if (last >= 0) kids.push(s('circle', { cx: CX, cy: CY, r: 13, class: `af-car af-st${last}` }), s('text', { x: CX, y: CY + 6, 'text-anchor': 'middle', class: 'af-big sm' }, String(last)));
    kids.push(s('text', { x: 4, y: 206, class: 'af-t af-m' }, 'order they went through:'));
    st.grants.forEach((g, k) => {
      const x = 6 + (k % 12) * 28, y = 214 + Math.floor(k / 12) * 24;
      kids.push(s('rect', { x, y, width: 24, height: 20, rx: 3, class: `af-hist af-st${g}` }), s('text', { x: x + 12, y: y + 15, 'text-anchor': 'middle', class: 'af-t' }, String(g)));
    });
    svg.replaceChildren(...kids);
    pols.mark(pol); cores.mark(n - 2);
    steppers.forEach((sp, i) => { sp.refresh(); sp.el.hidden = i >= n; });
    stepBtn.disabled = !left();
    runBtn.textContent = reducedMotion() ? 'Run to end' : playing ? 'Pause' : 'Run';
    const total = want.slice(0, n).reduce((a, b) => a + b, 0);
    const waits = st.waited.slice(0, n).map((w, i) => `core ${i}: ${w}`).join(', ');
    const gr = arbRun(want.slice(0, n), POLICIES[pol]);
    const worst = want.slice(0, n).map((w, i) => (w ? `core ${i}: ${arbMaxWait(gr, want.slice(0, n), i)}` : null)).filter(Boolean).join(', ');
    read.textContent = total === 0 ? 'Give some cores requests to make.'
      : `${st.grants.length} of ${total} requests served. Cycles each core has waited so far (${waits}). `
      + (left() ? '' : `Done. The longest stretch each core waited between two turns: ${worst}. `)
      + (pol === 0 ? 'The arbiter sees only the request wires, so "first" can only be a fixed order: the lowest core that asks goes, and a core that keeps asking keeps winning.'
        : 'After a conflict the pointer moves past the winner, so every core that asks is served within a round of the cores.');
  };
  host.replaceChildren(svg, h('div', { class: 'af-ctl' }, pols.el, cores.el), h('div', { class: 'af-ctl af-grid2' }, ...steppers.map((x) => x.el)), h('div', { class: 'af-ctl' }, stepBtn, runBtn, resetBtn), read);
  paint();
}
