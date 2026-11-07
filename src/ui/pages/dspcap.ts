// The signal-processing capstones that are programs, not circuits (learn/capstones.ts): Cancel the echo (cap_echo, campaign/capecho.ts). No sandbox:
// a page with the brief, the machine to choose, the sample port, an assembly editor and a bench that runs the program on the golden model against
// echo paths drawn from a seed the learner never sees. A pass is recorded under the capstone's id in the campaign progress.

import { assembleEcho, BLOCK, ECHO_IO, ECHO_MACHINES, ECHO_SPEC, ECHO_STARTERS, echoPaths, type EchoMachineId, freshSeed, machineName, REF_Q, REF_TAPS, RV_PASSING_SHIFTS, referenceCycles, referenceFor, runPath, summarize, tailWord, type EchoVerdict, type PathResult } from '../../campaign/capecho';
import { DSP_IO, DSP_PASSING_SHIFTS } from '../../campaign/capechodsp';
import { MEM24_WORDS, ROM24_WORDS } from '../../dsp/isa24';
import { progress } from '../../campaign/progress';
import { DSP_CAPSTONES } from '../../learn/capstones';
import { groupDigits } from '../../sim/numfmt';
import { codeEditor, type CodeEditor } from '../../widgets/codeedit';
import type { CodeLang } from '../../widgets/codetok';
import { h, s } from '../dom';
import '../../styles/codeedit.css';
import '../../styles/signals.css';
import '../../styles/dspcap.css';

/** Each machine's draft is kept apart: the RV32IM one under the key the page always used. */
const KEY = 'mosfet2riscv:capecho:src', MACHINE_KEY = 'mosfet2riscv:capecho:machine', PASSED_KEY = 'mosfet2riscv:capecho:passed';
const keyOf = (m: EchoMachineId): string => (m === 'rv32im' ? KEY : `${KEY}:${m}`);
const load = (m: EchoMachineId): string => { try { return localStorage.getItem(keyOf(m)) || ECHO_STARTERS[m]; } catch { return ECHO_STARTERS[m]; } };
const save = (m: EchoMachineId, v: string) => { try { localStorage.setItem(keyOf(m), v); } catch { /* storage blocked: the text just is not kept */ } };
const loadMachine = (): EchoMachineId => { try { const v = localStorage.getItem(MACHINE_KEY); return v === 'mac' || v === 'dsp' ? v : 'rv32im'; } catch { return 'rv32im'; } };
/** The worst sample of the learner's best passing program, per machine. */
const loadPassed = (): Partial<Record<EchoMachineId, number>> => { try { return JSON.parse(localStorage.getItem(PASSED_KEY) || '{}') as Partial<Record<EchoMachineId, number>>; } catch { return {}; } };
const savePassed = (p: Partial<Record<EchoMachineId, number>>) => { try { localStorage.setItem(PASSED_KEY, JSON.stringify(p)); } catch { /* not kept */ } };
const LANG: Record<EchoMachineId, CodeLang> = { rv32im: 'rvasm', mac: 'rvmacasm', dsp: 'dsp24asm' };
const PATH_HUES = ['var(--probe-0, #4c8)', 'var(--probe-1, #48c)', 'var(--probe-2, #c84)', 'var(--probe-3, #a6c)'];

/** ERLE per block for each path against the pass line, the graded stretch shaded: where it settled, or that it never did. The viewBox is narrower on a phone, so the text stays readable. */
function erleChart(results: readonly PathResult[]): SVGElement {
  const narrow = typeof matchMedia === 'function' && matchMedia('(max-width: 600px)').matches;
  const W = narrow ? 340 : 760, H = narrow ? 230 : 250, L = 30, R = 8, T = 10, B = 30, nb = Math.floor(ECHO_SPEC.samples / BLOCK);
  const lo = -10, hi = 50, X = (b: number) => L + ((W - L - R) * (b + 0.5)) / nb, Y = (v: number) => T + ((H - T - B) * (hi - Math.max(lo, Math.min(hi, v)))) / (hi - lo);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'ec-chart', role: 'group', 'aria-label': 'ERLE of each path over time against the pass line' });
  const wx = L + ((W - L - R) * ECHO_SPEC.window) / ECHO_SPEC.samples;
  svg.append(s('rect', { x: wx, y: T, width: W - R - wx, height: H - T - B, class: 'ec-win' }));
  for (const v of [-10, 0, 10, 20, 30, 40, 50]) svg.append(s('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), class: v === 0 ? 'ec-zero' : 'ec-grid' }), s('text', { x: L - 4, y: Y(v) + 4, class: 'ec-tick', 'text-anchor': 'end' }, `${v}`));
  svg.append(s('line', { x1: L, x2: W - R, y1: Y(ECHO_SPEC.erleDb), y2: Y(ECHO_SPEC.erleDb), class: 'ec-need' }), s('text', { x: W - R - 4, y: Y(ECHO_SPEC.erleDb) - 4, class: 'ec-needt', 'text-anchor': 'end' }, `${ECHO_SPEC.erleDb} dB needed`));
  svg.append(s('text', { x: wx + 4, y: H - B - 4, class: 'ec-tick' }, 'graded'), s('text', { x: (L + W) / 2, y: H - 8, class: 'ec-tick', 'text-anchor': 'middle' }, `time (samples, 0 to ${groupDigits(ECHO_SPEC.samples)}), ERLE in dB`));
  results.forEach((r, i) => {
    let d = '';
    r.blocks.forEach((v, b) => { if (v !== null) d += `${r.blocks[b - 1] === null || b === 0 ? 'M' : 'L'}${X(b).toFixed(1)},${Y(v).toFixed(1)}`; });
    svg.append(s('path', { d, class: 'ec-line', style: `stroke:${PATH_HUES[i % PATH_HUES.length]}` }));
  });
  return svg;
}

/** The legend under the chart: a swatch, the path's number, its kind and what it reached. */
const legend = (results: readonly PathResult[]): HTMLElement => h('ul', { class: 'ec-legend' }, results.map((r, i) =>
  h('li', null, h('span', { class: 'ec-sw', style: `background:${PATH_HUES[i % PATH_HUES.length]}` }), `${r.path.index + 1}: ${r.path.cls} tail, ${r.path.source}, ${r.erle.toFixed(1)} dB`)));

export class DspCapstonePage {
  readonly kind = 'capstone';
  readonly el = h('div', { class: 'scroll' });
  private body = h('div', { class: 'cc-page ec-page' });
  private machine: EchoMachineId = loadMachine();
  private ed?: CodeEditor;
  private switcher = h('div', { class: 'ec-machines', role: 'radiogroup', 'aria-label': 'The machine' });
  private port = h('section', { class: 'cc-brief' });
  private hold = h('section', { class: 'cc-brief' });
  private edSec = h('section', { class: 'cc-brief' });
  private out = h('div', { class: 'ec-out', 'aria-live': 'polite' });
  private run = h('button', { type: 'button', class: 'btn primary' }) as HTMLButtonElement;
  private timer = 0;
  private busy = false;
  private extra = h('div');

  constructor(readonly nodeId: string) {
    const meta = DSP_CAPSTONES.find((c) => c.id === nodeId);
    this.el.append(this.body);
    this.body.append(h('p', { class: 'cc-crumb' }, h('a', { href: '#/path' }, 'My path'), ' › Signal processing capstone'), h('h1', null, 'Cancel the echo'),
      h('p', null, meta?.brief ?? ''));
    progress().open(nodeId, true);
    this.run.addEventListener('click', () => this.check());
    this.job();
    this.body.append(h('section', { class: 'cc-brief' }, h('h2', null, 'The machine'), this.switcher), this.port, this.hold, this.edSec, this.out, this.extra);
    this.paintMachine();
    this.showReference();
  }

  destroy(): void { clearTimeout(this.timer); this.ed?.destroy(); }


  private job(): void {
    const S = ECHO_SPEC;
    this.body.append(h('section', { class: 'cc-brief' }, h('h2', null, 'The job'),
      h('p', null, 'A caller\'s voice comes out of a loudspeaker (the far end, x), goes round a room or a hybrid, and comes back in the microphone as an echo of itself, with a little noise (d). Write the loop that learns that path from x and d alone and says, sample by sample, what the echo in the microphone is (ŷ). The bench scores ŷ against the true echo, never against your own error: the echo return loss enhancement, ERLE = 10 log₁₀(Σ echo² / Σ (echo − ŷ)²).'),
      h('p', null, `Pass: ERLE of at least ${S.erleDb} dB over the last ${groupDigits(S.samples - S.window)} of ${groupDigits(S.samples)} samples on each of ${S.paths} echo paths, with no sample taking more than ${groupDigits(S.budget)} cycles (a ${(S.budget * S.rate / 1e6).toFixed(1)} MHz core at ${S.rate / 1000} kHz). The bar is the same on all three machines: what differs is the cycles each one needs, and that comparison is shown after a pass.`)));
  }

  /** The three machines as a radio group; the selected one is the one Check grades. */
  private paintSwitcher(): void {
    const btns = ECHO_MACHINES.map((m) => {
      const on = m.id === this.machine;
      return h('button', { type: 'button', class: `ec-machine${on ? ' on' : ''}`, role: 'radio', 'aria-checked': String(on), tabindex: on ? '0' : '-1', title: m.note,
        onclick: () => this.setMachine(m.id), onkeydown: (e: Event) => this.arrow(e as KeyboardEvent, m.id) },
        h('b', null, m.name), h('span', { class: 'ec-soon' }, on ? 'graded by Check' : this.passedOn(m.id) ? 'passed' : 'select'), h('span', { class: 'ec-note' }, m.note));
    });
    this.switcher.replaceChildren(...btns);
  }

  private arrow(e: KeyboardEvent, from: EchoMachineId): void {
    const ids = ECHO_MACHINES.map((m) => m.id), i = ids.indexOf(from), d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    this.setMachine(ids[(i + d + ids.length) % ids.length]);
    (this.switcher.querySelector('[aria-checked="true"]') as HTMLElement | null)?.focus();
  }

  private passedOn(m: EchoMachineId): boolean { return loadPassed()[m] !== undefined; }

  private setMachine(m: EchoMachineId): void {
    if (m === this.machine || this.busy) return;
    if (this.ed) save(this.machine, this.ed.value);
    this.machine = m;
    try { localStorage.setItem(MACHINE_KEY, m); } catch { /* not kept */ }
    this.out.replaceChildren();
    this.paintMachine();
    this.showReference();
  }

  /** Everything that depends on the machine: the switcher, the port, the editor with this machine's draft, the button. */
  private paintMachine(): void {
    const m = this.machine, name = machineName(m);
    this.paintSwitcher();
    this.paintPort();
    this.paintHold();
    this.ed?.destroy();
    this.ed = codeEditor({ value: load(m), lang: LANG[m], rows: 26, onChange: (v) => { save(this.machine, v); this.ed?.setDiagnostics([]); } });
    const reset = h('button', { type: 'button', class: 'btn ghost', onclick: () => { if (this.ed) { this.ed.replaceAll(ECHO_STARTERS[this.machine]); save(this.machine, ECHO_STARTERS[this.machine]); } } }, 'Back to the starter');
    this.run.textContent = `Check the ${name} program on new echo paths`;
    const limit = m === 'dsp' ? `Up to ${ROM24_WORDS} words of code, ${MEM24_WORDS} words each of X and Y.` : `Up to ${ECHO_SPEC.codeWords} words.`;
    this.edSec.replaceChildren(h('h2', null, `Your program: ${name}`), h('p', { class: 'ec-grading' }, 'Check grades the ', h('b', null, name), ' program shown here. Each machine keeps its own code; switch above.'),
      this.ed.el, h('div', { class: 'cc-row' }, this.run, reset, h('span', { class: 'cc-hint' }, `${limit} A check takes a few seconds.`)));
  }

  private paintPort(): void {
    const S = ECHO_SPEC, hex = (n: number) => `0x${n.toString(16).padStart(8, '0')}`, m = this.machine;
    const table = (rows: [string, string, string][], head: string[]) => h('div', { class: 'ec-tw' }, h('table', { class: 'ec-t' }, h('thead', null, h('tr', null, head.map((t) => h('th', null, t)))),
      h('tbody', null, rows.map((r) => h('tr', null, r.map((c) => h('td', null, c)))))));
    if (m === 'dsp') {
      this.port.replaceChildren(h('h2', null, 'The sample port'),
        h('p', null, `The book's DSP core (DSP24): 16-bit data, 24-bit instructions, one instruction a clock, a ${ROM24_WORDS}-word program ROM and X and Y memories of ${MEM24_WORDS} words each, address generators with circular modes, a 40-bit accumulator and zero-overhead loops (chapter "A DSP core"). It has no input instruction, so two words are the bench's: x in X[${DSP_IO.x}] and d in Y[${DSP_IO.d}]. In this order, once per sample:`),
        table([
          [`X[${DSP_IO.x}]`, 'ld', 'x: the far-end sample, 16-bit signed (Q15). The next x is written here by the bench at each out.'],
          ['out ra', 'out', 'ŷ: your estimate of the echo, 16-bit signed, same scale. It ends the sample: cycles are counted from one out to the next. It may use x up to now and every earlier d, not this sample\'s d.'],
          [`Y[${DSP_IO.d}]`, 'ld', 'd: the microphone, echo + noise, written by the bench only after the out. A read before the out gives the last sample\'s d (allowed: past d is the learning signal).'],
        ], ['where', 'instruction', 'meaning']),
        h('p', { class: 'cc-hint' }, `X[${DSP_IO.x}] and Y[${DSP_IO.d}] are the bench's: a program that writes them is overwritten at the next out, so keep your circular windows clear of them. The program must not halt before the last sample. Every path starts from power-on: memories and registers are zero. The reference's step passes for rndc shifts ${DSP_PASSING_SHIFTS[0]} to ${DSP_PASSING_SHIFTS[1]}, a window of ${2 ** (DSP_PASSING_SHIFTS[1] - DSP_PASSING_SHIFTS[0])} in the step; the RV32 references pass a window of ${2 ** (RV_PASSING_SHIFTS[1] - RV_PASSING_SHIFTS[0])}. With 16-bit weights on this core a step that is too small stalls on rounding, and one that is too large is unstable on the speech.`));
      return;
    }
    this.port.replaceChildren(h('h2', null, 'The sample port'),
      h('p', null, `${m === 'mac' ? 'RV32IM assembly with the MAC chapter\'s four custom-2 instructions on the golden model (mac, mac2, clracc, racc: see the chapter "A MAC on the RV32"; one 40-bit accumulator, products of the signed low (mac) or both (mac2) 16-bit halves, racc reads it rounded and clamped).' : 'RV32IM assembly on the golden model.'} The program from address 0, ${groupDigits(S.ramWords)} words (${groupDigits(S.ramWords * 4)} bytes) of RAM from address 0, registers and RAM start at 0. Program and data memories are separate: the program is not in RAM, so a lw from it reads RAM, a .word table in the text cannot be read, and code cannot modify itself. Any access outside the RAM and the port is a fault; the port takes whole words only. Every instruction is one cycle, mul and div${m === 'mac' ? ' and the MAC instructions' : ''} included. One sample port, used in this order once per sample:`),
      table([
        [hex(ECHO_IO.x), 'lw', 'x: the next far-end sample, 16-bit signed (Q15). Starts the sample period; cycles are counted from one x read to the next.'],
        [hex(ECHO_IO.y), 'sw', 'ŷ: your estimate of the echo in this sample\'s microphone value, same scale. Once per x. It may use x up to now and every earlier d, not this sample\'s d.'],
        [hex(ECHO_IO.d), 'lw', 'd: the microphone, echo + noise. Only after ŷ is written; the moment to learn.'],
      ], ['address', 'access', 'meaning']),
      h('p', { class: 'cc-hint' }, 'The number format is yours to choose. Every path starts from power-on, so a weight is zero until you move it. The program must not stop before the last sample.'));
  }

  private paintHold(): void {
    const S = ECHO_SPEC, dsp = this.machine === 'dsp';
    this.hold.replaceChildren(h('h2', null, 'What the bench holds back'),
      h('ul', null,
        h('li', null, `${S.paths} echo paths per check, drawn from a seed you never see and new at every check: one short tail (16–32 taps), two medium (48–64) and one long of 96 taps, in a mixed order. A tap is 125 µs; the longest is 12 ms.`),
        h('li', null, 'A delay of 5–14 samples before the first echo, reflections that die away, and an echo return loss of 6–16 dB, different on every path.'),
        h('li', null, `The far end is generated: speech-like sound with line noise under it on two paths (about −27 to −30 dBFS rms), white noise on two (−26 dBFS rms). Speech comes in bursts with pauses, so the energy under your filter swings by tens of dB; the noise is steady. Whatever step you use has to suit both. Microphone noise ${S.noiseLsb} LSB rms.`),
        h('li', null, `A program that outputs ŷ = 0 scores 0 dB, ${dsp ? `one that executes two outs for one x is refused, a read of Y[${DSP_IO.d}] before the out gives only the last sample's d,` : 'one that reads d before writing ŷ is refused,'} and a failed check says which path, what was reached against what was needed, and why.`)));
  }

  private check(): void {
    if (this.busy || !this.ed) return;
    const src = this.ed.value, machine = this.machine;
    save(machine, src);
    const a = assembleEcho(src, machine);
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
        this.out.replaceChildren(h('p', { class: 'cc-hint' }, `Running path ${results.length + 1} of ${paths.length} on the ${machineName(machine)}…`));
        this.timer = window.setTimeout(() => { results.push(runPath(a.words, paths[results.length], ECHO_SPEC.budget, machine)); step(); }, 20);
        return;
      }
      this.busy = false;
      this.run.disabled = false;
      this.verdict(summarize(seed, results, a.words, machine), machine);
    };
    this.timer = window.setTimeout(step, 20);
  }

  private verdict(v: EchoVerdict, machine: EchoMachineId): void {
    const S = ECHO_SPEC;
    if (v.ok) {
      progress().solveCapstone(this.nodeId); // the status only: each machine's own figure is kept apart (loadPassed), so one machine's never stands for another's
      const p = loadPassed();
      p[machine] = Math.min(p[machine] ?? Infinity, v.worstCycles);
      savePassed(p);
      this.paintSwitcher();
    }
    const rows = v.results.map((r) => h('tr', { class: r.pass ? 'ok' : 'no' },
      h('td', null, r.pass ? 'pass' : 'FAIL'), h('td', null, `${r.path.index + 1}`), h('td', null, tailWord(r.path.cls).replace(/ \(.*\)/, '')), h('td', null, r.path.source),
      h('td', { class: 'num' }, r.fault && r.fault.kind !== 'budget' ? '—' : `${r.erle.toFixed(1)} dB`),
      h('td', { class: 'num' }, r.worstCycles ? groupDigits(r.worstCycles) : '—')));
    this.out.replaceChildren(...[
      h('h2', { class: v.ok ? 'ec-good' : 'ec-bad' }, v.ok ? `Passed on the ${machineName(machine)}: the echo is gone on all four paths` : `Not yet on the ${machineName(machine)}: ${v.results.filter((r) => !r.pass).length} of ${v.results.length} paths fail`),
      h('div', { class: 'ec-tw' }, h('table', { class: 'ec-t ec-table' },
        h('thead', null, h('tr', null, ['', 'path', 'tail', 'far end', 'ERLE', 'cycles'].map((t) => h('th', null, t)))), h('tbody', null, rows))),
      h('p', { class: 'cc-hint' }, `Needed: ERLE of ${S.erleDb} dB or more, and at most ${groupDigits(S.budget)} cycles for any sample.`),
      v.ok ? h('p', null, `Worst sample ${groupDigits(v.worstCycles)} cycles, mean ${groupDigits(Math.round(v.meanCycles))}; lowest ERLE ${v.minErle.toFixed(1)} dB. The next check draws other paths.`) : null,
      v.reasons.length ? h('ul', { class: 'ec-why' }, v.reasons.map((r) => h('li', null, r))) : null,
      v.diagnosis ? h('p', { class: 'ec-diag' }, h('b', null, 'Diagnosis. '), v.diagnosis) : null,
      v.results.some((r) => r.blocks.some((b) => b !== null)) ? erleChart(v.results) : null,
      v.results.some((r) => r.blocks.some((b) => b !== null)) ? legend(v.results) : null,
      h('p', { class: 'cc-hint' }, `ERLE of each ${BLOCK}-sample block, per path, against the pass line; the shaded part is graded. A block in a pause of the speech has no echo to cancel and is left out.`)].filter((x): x is Exclude<typeof x, null> => !!x));
    this.showReference();
  }

  /** After a pass on the selected machine: the cycles of each machine's reference beside the learner's own, and this machine's reference program. */
  private showReference(): void {
    const m = this.machine, mine = loadPassed();
    if (mine[m] === undefined) { this.extra.replaceChildren(); return; }
    const src = referenceFor(m), name = machineName(m);
    const rows = ECHO_MACHINES.map((x) => h('tr', null, h('td', null, x.name), h('td', { class: 'num' }, groupDigits(referenceCycles(x.id))), h('td', { class: 'num' }, mine[x.id] === undefined ? 'not passed yet' : groupDigits(mine[x.id]!))));
    this.extra.replaceChildren(h('section', { class: 'cc-brief' }, h('h2', null, 'The comparison'),
      h('p', null, `The same bar on all three machines (${ECHO_SPEC.erleDb} dB, at most ${groupDigits(ECHO_SPEC.budget)} cycles a sample). What differs is what each needs: the worst sample of each machine's reference, computed here, beside your best passing program on that machine.`),
      h('div', { class: 'ec-tw' }, h('table', { class: 'ec-t ec-table' }, h('thead', null, h('tr', null, ['machine', 'reference', 'yours'].map((t) => h('th', null, t)))), h('tbody', null, rows)))),
      h('section', { class: 'cc-brief' }, h('h2', null, `The ${name} reference`),
        h('p', null, REF_NOTE[m](referenceCycles(m))),
        h('details', null, h('summary', null, 'The program'), h('pre', { class: 'fb-lines' }, src)),
        h('div', { class: 'cc-row' }, h('button', { type: 'button', class: 'btn', onclick: () => { this.ed?.replaceAll(src); save(this.machine, src); } }, 'Load it into the editor'))));
  }
}

const REF_NOTE: Record<EchoMachineId, (cycles: number) => string> = {
  rv32im: (c) => `Normalized LMS on ${REF_TAPS} taps, weights in Q${REF_Q}, the history in a ring written twice so the window is contiguous. ${groupDigits(c)} cycles a sample against a budget of ${groupDigits(ECHO_SPEC.budget)}. The same task done one way, not the only way.`,
  mac: (c) => `Normalized LMS on ${REF_TAPS} taps, weights in Q15 one a word, the filter a mac a tap (unrolled by four), racc with shift 15; the update stays in software because the step is wider than 16 bits. ${groupDigits(c)} cycles a sample against a budget of ${groupDigits(ECHO_SPEC.budget)}. The same task done one way, not the only way.`,
  dsp: (c) => `Normalized LMS on ${REF_TAPS} taps, 16-bit Q15 weights in Y, the history in X, both circular windows, a mac and a rndc a tap in zero-overhead loops. The core has no divide: the step is a power of two read off the bit length of a leaky mean of x². ${groupDigits(c)} cycles a sample against a budget of ${groupDigits(ECHO_SPEC.budget)}. The same task done one way, not the only way.`,
};
