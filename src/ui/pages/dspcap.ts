// The signal-processing capstones that are programs, not circuits (learn/capstones.ts): Cancel the echo (cap_echo, campaign/capecho.ts). No sandbox:
// a page with the brief, the machine to choose, the sample port, an assembly editor and a bench that runs the program on the golden model against
// echo paths drawn from a seed the learner never sees. A pass is recorded under the capstone's id in the campaign progress.

import { assembleEcho, BLOCK, ECHO_IO, ECHO_MACHINES, ECHO_SPEC, ECHO_STARTER, echoPaths, echoReference, freshSeed, runPath, summarize, tailWord, type EchoVerdict, type PathResult } from '../../campaign/capecho';
import { progress } from '../../campaign/progress';
import { DSP_CAPSTONES } from '../../learn/capstones';
import { codeEditor, type CodeEditor } from '../../widgets/codeedit';
import { h, s } from '../dom';
import '../../styles/codeedit.css';
import '../../styles/signals.css';
import '../../styles/dspcap.css';

const KEY = 'mosfet2riscv:capecho:src';
const load = (): string => { try { return localStorage.getItem(KEY) || ECHO_STARTER; } catch { return ECHO_STARTER; } };
const save = (v: string) => { try { localStorage.setItem(KEY, v); } catch { /* storage blocked: the text just is not kept */ } };
const PATH_HUES = ['var(--probe-0, #4c8)', 'var(--probe-1, #48c)', 'var(--probe-2, #c84)', 'var(--probe-3, #a6c)'];

/** ERLE per block for each path against the pass line, the graded stretch shaded: where it settled, or that it never did. */
function erleChart(results: readonly PathResult[]): SVGElement {
  const W = 640, H = 220, L = 38, R = 8, T = 10, B = 28, nb = Math.floor(ECHO_SPEC.samples / BLOCK);
  const lo = -20, hi = 50, X = (b: number) => L + ((W - L - R) * (b + 0.5)) / nb, Y = (v: number) => T + ((H - T - B) * (hi - Math.max(lo, Math.min(hi, v)))) / (hi - lo);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'ec-chart', role: 'group', 'aria-label': 'ERLE of each path over time against the pass line' });
  const wx = L + ((W - L - R) * ECHO_SPEC.window) / ECHO_SPEC.samples;
  svg.append(s('rect', { x: wx, y: T, width: W - R - wx, height: H - T - B, class: 'ec-win' }));
  for (const v of [-20, 0, 10, 20, 30, 40, 50]) svg.append(s('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), class: v === 0 ? 'ec-zero' : 'ec-grid' }), s('text', { x: L - 5, y: Y(v) + 4, class: 'ec-tick', 'text-anchor': 'end' }, `${v}`));
  svg.append(s('line', { x1: L, x2: W - R, y1: Y(ECHO_SPEC.erleDb), y2: Y(ECHO_SPEC.erleDb), class: 'ec-need' }), s('text', { x: W - R - 3, y: Y(ECHO_SPEC.erleDb) - 4, class: 'ec-needt', 'text-anchor': 'end' }, `${ECHO_SPEC.erleDb} dB needed`));
  svg.append(s('text', { x: wx + 4, y: H - B - 5, class: 'ec-tick' }, 'graded'), s('text', { x: (L + W) / 2, y: H - 6, class: 'ec-tick', 'text-anchor': 'middle' }, 'time (samples)'));
  results.forEach((r, i) => {
    let d = '';
    r.blocks.forEach((v, b) => { if (v !== null) d += `${r.blocks[b - 1] === null || b === 0 ? 'M' : 'L'}${X(b).toFixed(1)},${Y(v).toFixed(1)}`; });
    svg.append(s('path', { d, class: 'ec-line', style: `stroke:${PATH_HUES[i % PATH_HUES.length]}` }));
    const last = [...r.blocks].reverse().find((v) => v !== null);
    if (last !== undefined && last !== null) svg.append(s('text', { x: W - R - 3, y: Y(last) + (r.pass ? 12 : -4) + (i - 1.5) * 4, class: 'ec-tick', 'text-anchor': 'end' }, `${i + 1}`));
  });
  return svg;
}

export class DspCapstonePage {
  readonly kind = 'capstone';
  readonly el = h('div', { class: 'scroll' });
  private body = h('div', { class: 'cc-page ec-page' });
  private ed?: CodeEditor;
  private out = h('div', { class: 'ec-out', 'aria-live': 'polite' });
  private run = h('button', { type: 'button', class: 'btn primary' }, 'Check on new echo paths') as HTMLButtonElement;
  private timer = 0;
  private busy = false;
  private extra = h('div');

  constructor(readonly nodeId: string) {
    const meta = DSP_CAPSTONES.find((c) => c.id === nodeId);
    this.el.append(this.body);
    this.body.append(h('p', { class: 'cc-crumb' }, h('a', { href: '#/path' }, 'My path'), ' › Signal processing capstone'), h('h1', null, 'Cancel the echo'),
      h('p', null, meta?.brief ?? ''));
    progress().open(nodeId, true);
    this.brief();
    this.editor();
    this.body.append(this.out, this.extra);
    if (this.passed()) this.reference();
  }

  destroy(): void { clearTimeout(this.timer); this.ed?.destroy(); }

  private passed(): boolean { return progress().get(this.nodeId)?.status === 'solved'; }

  private brief(): void {
    const S = ECHO_SPEC, hex = (n: number) => `0x${n.toString(16).padStart(8, '0')}`;
    const machines = h('div', { class: 'ec-machines', role: 'radiogroup', 'aria-label': 'The machine' }, ECHO_MACHINES.map((m) =>
      h('button', { type: 'button', class: `ec-machine${m.ready ? ' on' : ''}`, role: 'radio', 'aria-checked': String(m.ready), disabled: !m.ready, title: m.note },
        h('b', null, m.name), h('span', { class: 'ec-soon' }, m.ready ? 'available' : 'coming soon'), h('span', { class: 'ec-note' }, m.note))));
    this.body.append(
      h('section', { class: 'cc-brief' }, h('h2', null, 'The job'),
        h('p', null, 'A caller\'s voice comes out of a loudspeaker (the far end, x), goes round a room or a hybrid, and comes back in the microphone as an echo of itself, with a little noise (d). Write the loop that learns that path from x and d alone and says, sample by sample, what the echo in the microphone is (ŷ). The bench scores ŷ against the true echo, never against your own error: the echo return loss enhancement, ERLE = 10 log₁₀(Σ echo² / Σ (echo − ŷ)²).'),
        h('p', null, `Pass: ERLE of at least ${S.erleDb} dB over the last ${S.samples - S.window} of ${S.samples.toLocaleString('en')} samples on each of ${S.paths} echo paths, with no sample taking more than ${S.budget.toLocaleString('en')} cycles (a ${(S.budget * S.rate / 1e6).toFixed(1)} MHz core at ${S.rate / 1000} kHz).`)),
      h('section', { class: 'cc-brief' }, h('h2', null, 'The machine'), machines),
      h('section', { class: 'cc-brief' }, h('h2', null, 'The sample port'),
        h('p', null, `RV32IM assembly on the golden model: the program from address 0, ${S.ramWords.toLocaleString('en')} words of RAM from address 0, registers and RAM start at 0. Every instruction is one cycle, mul and div included. One sample port, used in this order once per sample:`),
        h('div', { class: 'ec-tw' }, h('table', { class: 'ec-t' },
          h('thead', null, h('tr', null, ['address', 'access', 'meaning'].map((t) => h('th', null, t)))),
          h('tbody', null,
            h('tr', null, h('td', null, hex(ECHO_IO.x)), h('td', null, 'lw'), h('td', null, 'x: the next far-end sample, 16-bit signed (Q15). Starts the sample period; cycles are counted from one x read to the next.')),
            h('tr', null, h('td', null, hex(ECHO_IO.y)), h('td', null, 'sw'), h('td', null, 'ŷ: your estimate of the echo in this sample\'s microphone value, same scale. Once per x. It may use x up to now, not d.')),
            h('tr', null, h('td', null, hex(ECHO_IO.d)), h('td', null, 'lw'), h('td', null, 'd: the microphone, echo + noise. Only after ŷ is written; the moment to learn.'))))),
        h('p', { class: 'cc-hint' }, 'The number format is yours to choose. Every path starts from power-on, so a weight is zero until you move it.')),
      h('section', { class: 'cc-brief' }, h('h2', null, 'What the bench holds back'),
        h('ul', null,
          h('li', null, `${S.paths} echo paths per check, drawn from a seed you never see and new at every check: one short tail (16–32 taps), two medium (48–64), one long (88–96), in a mixed order. A tap is 125 µs; the longest is 12 ms.`),
          h('li', null, 'A delay of 5–14 samples before the first echo, reflections that die away, and an echo return loss of 6–16 dB, different on every path.'),
          h('li', null, `The far end is generated: speech-like sound with line noise under it on two paths, white noise on two (both about −26 dBFS rms). Microphone noise ${S.noiseLsb} LSB rms.`),
          h('li', null, 'A program that outputs ŷ = 0 scores 0 dB, one that reads d before writing ŷ is refused, and a failed check says which path, what was reached against what was needed, and why.'))));
  }

  private editor(): void {
    this.ed = codeEditor({ value: load(), lang: 'rvasm', rows: 26, onChange: (v) => { save(v); this.ed?.setDiagnostics([]); } });
    const reset = h('button', { type: 'button', class: 'btn ghost', onclick: () => { if (this.ed) { this.ed.replaceAll(ECHO_STARTER); save(ECHO_STARTER); } } }, 'Back to the starter');
    this.run.addEventListener('click', () => this.check());
    this.body.append(h('section', { class: 'cc-brief' }, h('h2', null, 'Your program'), this.ed.el, h('div', { class: 'cc-row' }, this.run, reset, h('span', { class: 'cc-hint' }, `Up to ${ECHO_SPEC.codeWords} words. A check takes a few seconds.`))));
  }

  private check(): void {
    if (this.busy || !this.ed) return;
    const src = this.ed.value;
    save(src);
    const a = assembleEcho(src);
    if (a.errors.length) {
      this.ed.setDiagnostics(a.errors.map((e) => ({ line: e.line, message: e.message, level: 'error' as const })));
      this.out.replaceChildren(h('p', { class: 'ec-bad' }, `The program does not assemble: line ${a.errors[0].line}: ${a.errors[0].message}`));
      return;
    }
    this.busy = true;
    this.run.disabled = true;
    const seed = freshSeed(), paths = echoPaths(seed), results: PathResult[] = [];
    const step = () => {
      if (results.length < paths.length) {
        this.out.replaceChildren(h('p', { class: 'cc-hint' }, `Running path ${results.length + 1} of ${paths.length}…`));
        this.timer = window.setTimeout(() => { results.push(runPath(a.words, paths[results.length])); step(); }, 20);
        return;
      }
      this.busy = false;
      this.run.disabled = false;
      this.verdict(summarize(seed, results));
    };
    this.timer = window.setTimeout(step, 20);
  }

  private verdict(v: EchoVerdict): void {
    const S = ECHO_SPEC;
    if (v.ok) progress().solveCapstone(this.nodeId, { cycles: Math.round(v.worstCycles) }, (m) => [m.cycles ?? Infinity]);
    const rows = v.results.map((r) => h('tr', { class: r.pass ? 'ok' : 'no' },
      h('td', null, `${r.path.index + 1}`), h('td', null, tailWord(r.path.cls).replace(/ \(.*\)/, '')), h('td', null, r.path.source),
      h('td', { class: 'num' }, r.fault && r.fault.kind !== 'budget' ? '—' : `${r.erle.toFixed(1)} dB`),
      h('td', { class: 'num' }, r.worstCycles ? r.worstCycles.toLocaleString('en') : '—'),
      h('td', null, r.pass ? 'pass' : 'fail')));
    this.out.replaceChildren(...[
      h('h2', { class: v.ok ? 'ec-good' : 'ec-bad' }, v.ok ? 'Passed: the echo is gone on all four paths' : `Not yet: ${v.results.filter((r) => !r.pass).length} of ${v.results.length} paths fail`),
      h('div', { class: 'ec-tw' }, h('table', { class: 'ec-t ec-table' },
        h('thead', null, h('tr', null, ['path', 'tail', 'far end', `ERLE (need ${S.erleDb})`, `cycles (max ${S.budget.toLocaleString('en')})`, ''].map((t) => h('th', null, t)))), h('tbody', null, rows))),
      v.ok ? h('p', null, `Worst sample ${v.worstCycles.toLocaleString('en')} cycles, mean ${Math.round(v.meanCycles).toLocaleString('en')}; lowest ERLE ${v.minErle.toFixed(1)} dB. The next check draws other paths.`) : null,
      v.reasons.length ? h('ul', { class: 'ec-why' }, v.reasons.map((r) => h('li', null, r))) : null,
      v.results.some((r) => r.blocks.some((b) => b !== null)) ? erleChart(v.results) : null,
      h('p', { class: 'cc-hint' }, 'ERLE of each 250-sample block, per path (numbered at the right), against the pass line; the shaded part is graded. A block in a pause of the speech has no echo to cancel and is left out.')].filter((x): x is Exclude<typeof x, null> => !!x));
    if (v.ok) this.reference();
  }

  /** The reference program, after a pass only. */
  private reference(): void {
    const src = echoReference();
    this.extra.replaceChildren(h('section', { class: 'cc-brief' }, h('h2', null, 'The reference'),
      h('p', null, 'Normalized LMS on 96 taps, weights in Q14, the history in a ring written twice so the window is contiguous. About 1,855 cycles a sample against a budget of 2,400. The same task done one way, not the only way.'),
      h('details', null, h('summary', null, 'The program'), h('pre', { class: 'fb-lines' }, src)),
      h('div', { class: 'cc-row' }, h('button', { type: 'button', class: 'btn', onclick: () => { this.ed?.replaceAll(src); save(src); } }, 'Load it into the editor'))));
  }
}
