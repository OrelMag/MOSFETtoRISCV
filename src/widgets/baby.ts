// Appendix E's scenes: the Baby in gates with the Baby panel. The store's face as the display tube showed it (a dash for
// a 1, a dot for a 0, digit 0 on the left, line 0 at the top), or as charge (each line fading between its rewrites);
// the four beats, CI / PI / A, the test and stop lamps, the program in both notations, and the golden model in lock
// step at every edge that ends an instruction. Run at 1948 speed (a beat every 306 µs) or flat out; Run to the end with
// a progress bar measured against the golden model's count; Regeneration off lets the tube forget.

import '../styles/baby.css';
import { babyComputer, BEAT_US, HOLD_BEATS, type TubeState } from '../lib/baby';
import { DualSim } from '../sim/dualsim';
import { groupDigits } from '../sim/numfmt';
import { assembleSsem } from '../ssem/asm';
import { disasm, fnOf, lineOf, notebook, usesLine } from '../ssem/isa';
import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import { settings } from '../ui/settings';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { BabyFollower, babyHw, instructionsToStop, signed, tubeLeaf, tubeOf } from './babymon';

export interface BabyOptions {
  /** The program, in the Baby's assembly (src/ssem/asm.ts). */
  source: string;
  highlight?: string[];
  path?: string[];
  /** Stay paused on load. */
  paused?: boolean;
  /** Beats a second on load (one of BABY_RATES). */
  rate?: number;
  /** The face's first view. */
  view?: 'face' | 'charge';
  /** Regeneration off from the start. */
  noRegen?: boolean;
}

/** Beats a second at 1948 speed: a beat of 36 digits of 8.5 µs. */
export const BEATS_1948 = Math.round(1e6 / BEAT_US);
/** Run's rates in beats a second (0: as fast as the page runs). */
export const BABY_RATES: [number, string][] = [[BEATS_1948, '1948 speed'], [0, 'Flat out'], [400, '400 beats / s'], [40, '40 beats / s'], [4, '4 beats / s']];
const BEAT_NAMES = ['S1', 'A1', 'S2', 'A2'];

export function babyScene(o: BabyOptions): Scene {
  const r = assembleSsem(o.source);
  if (r.errors.length) throw new Error(`baby program, line ${r.errors[0].line}: ${r.errors[0].message}`);
  return {
    root: babyComputer(r.words), clock: 'clk', engine: 'cycle', inputs: { regen: o.noRegen ? 0 : 1 },
    path: o.path, highlight: o.highlight, autoClock: false, panels: [babyPanel(o, r.words, r.lines)], resetLabel: 'Power cycle',
  };
}

const PX = 10, PY = 8;

function babyPanel(o: BabyOptions, words: number[], lines: { line: number; text: string }[]): ScenePanel {
  return (stage: Stage): Widget => {
    const mon = new BabyFollower(words);
    const total = instructionsToStop(words);
    let leaf = -1, raf: number | null = null, last = 0, rate = o.rate ?? BEATS_1948, view = o.view ?? 'face', toEnd = false, shownAt = 0, startedAt = 0;
    const sim = () => stage.sim;
    const findLeaf = () => { const s = sim(); leaf = s ? tubeLeaf(s) : -1; };

    stage.edgeHooks.add({
      before: () => { const s = sim(); if (s) mon.before(babyHw(s)); },
      after: () => { const s = sim(); if (s && !stage.inEdge) mon.after(babyHw(s)); },
    });
    stage.historyHooks.add({
      save: () => mon.save(),
      restore: (x) => { pause(); mon.restore(x as ReturnType<BabyFollower['save']>); paint(); },
    });
    stage.resetHooks.add(() => { mon.reset(); leaf = -1; paint(); });

    // ---- the face
    const cv = h('canvas', { class: 'bb-face', width: 32 * PX, height: 32 * PY, tabindex: '0', role: 'img' }) as HTMLCanvasElement;
    const ctx = cv.getContext('2d');
    const paintFace = () => {
      const s = sim();
      if (!ctx || !s) return;
      if (leaf < 0) findLeaf();
      const tube = tubeOf(s, leaf), hw = babyHw(s);
      ctx.fillStyle = '#07100b';
      ctx.fillRect(0, 0, cv.width, cv.height);
      const action = (hw.beat & 1) === 1;
      if (hw.line >= 0) {
        ctx.fillStyle = action ? 'rgba(255,200,110,0.20)' : 'rgba(220,245,200,0.10)';
        ctx.fillRect(0, hw.line * PY, cv.width, PY);
      }
      if (!tube) return;
      for (let l = 0; l < 32; l++) {
        const age = tube.age[l], lost = age > HOLD_BEATS, w = tube.x[l] ? 0 : tube.mem[l];
        const q = Math.max(0, 1 - age / HOLD_BEATS);
        for (let d = 0; d < 32; d++) {
          const one = (w >>> d) & 1, x = d * PX, y = l * PY + PY / 2;
          if (one && !(lost && view === 'face')) {
            ctx.fillStyle = view === 'charge' ? (lost ? 'rgba(210,110,80,0.7)' : `rgba(111,227,154,${(0.25 + 0.75 * q).toFixed(2)})`) : '#6fe39a';
            ctx.fillRect(x + 1.5, y - 1.5, PX - 3, 3);
          } else {
            ctx.fillStyle = view === 'charge' && one ? 'rgba(210,110,80,0.7)' : 'rgba(111,227,154,0.55)';
            ctx.fillRect(x + 4, y - 1, 2, 2);
          }
        }
      }
      cv.setAttribute('aria-label', `The store's face: line ${hw.line} is being ${action ? 'read or written' : 'regenerated'}; line 27 reads ${lineValue(tube, 27)}.`);
    };
    const lineValue = (t: TubeState, i: number) => (t.age[i] > HOLD_BEATS ? 0 : t.mem[i] | 0);

    // ---- beats, registers, lamps
    const beats = h('div', { class: 'bb-beats', 'aria-label': 'beats' }, ...BEAT_NAMES.map((n) => h('span', null, n)));
    const regs = h('dl', { class: 'bb-regs' });
    const lamp = (on: boolean) => `<span class="bb-lamp${on ? ' on' : ''}"></span>`;
    const paintRegs = () => {
      const s = sim();
      if (!s) return;
      const hw = babyHw(s);
      beats.querySelectorAll('span').forEach((e, i) => e.classList.toggle('on', i === hw.beat));
      const f = fnOf(hw.pi), ln = lineOf(hw.pi);
      regs.innerHTML = `<dt>CI</dt><dd>${signed(hw.ci)}</dd>`
        + `<dt>PI</dt><dd>${disasm(hw.pi)} <span class="bb-note">(${notebook(f, ln)})</span></dd>`
        + `<dt>A</dt><dd>${groupDigits(signed(hw.a))}</dd>`
        + `<dt>lamps</dt><dd>${lamp(hw.t === 1)}test ${lamp(hw.stop === 1)}stop</dd>`
        + `<dt>run</dt><dd>${groupDigits(mon.iss.instrs)} instructions${total ? ` of ${groupDigits(total)}` : ''}</dd>`;
    };

    // ---- the listing: every line the program writes
    const rows = new Map<number, HTMLTableRowElement>();
    const listing = h('div', { class: 'bb-list' }, h('table', null, ...lines.map((l) => {
      const w = words[l.line], isNum = /^\s*\.?num\b/i.test(l.text);
      const f = fnOf(w);
      const tr = h('tr', null,
        h('td', null, String(l.line)),
        h('td', null, isNum ? String(w | 0) : disasm(w)),
        h('td', { class: 'nb' }, isNum ? '' : notebook(f, usesLine(f) ? lineOf(w) : 0))) as HTMLTableRowElement;
      rows.set(l.line, tr);
      return tr;
    })));
    let curRow: HTMLTableRowElement | null = null;
    const paintList = () => {
      const s = sim();
      if (!s) return;
      const r = rows.get(babyHw(s).ci & 31) ?? null;
      if (r === curRow) return;
      curRow?.classList.remove('cur');
      r?.classList.add('cur');
      curRow = r;
    };

    // ---- verdict, alarm, progress
    const verdict = h('span', { class: 'bb-verdict good' }, 'matches the model');
    const alarm = h('div', { class: 'bb-alarm', role: 'alert', hidden: true });
    const bar = h('progress', { max: '1', value: '0' }) as HTMLProgressElement;
    const progText = h('span', null);
    const progress = h('div', { class: 'bb-progress', hidden: true }, bar, progText);
    const paintText = () => {
      alarm.hidden = !mon.mismatch;
      alarm.textContent = mon.mismatch;
      verdict.textContent = mon.mismatch ? 'differs from the model' : 'matches the model';
      verdict.classList.toggle('good', !mon.mismatch);
      verdict.classList.toggle('bad', !!mon.mismatch);
      if (toEnd && total) {
        progress.hidden = false;
        bar.value = mon.iss.instrs / total;
        const secs = (performance.now() - startedAt) / 1000, then = (mon.iss.instrs * 4 * BEAT_US) / 6e7;
        progText.textContent = `${groupDigits(mon.iss.instrs)} of ${groupDigits(total)} instructions · ${secs.toFixed(0)} s here, ${then.toFixed(1)} min in 1948`;
      }
    };
    const paint = () => { paintFace(); paintRegs(); paintList(); paintText(); };

    // ---- running
    const runBtn = h('button', { class: 'btn sm primary', type: 'button' }, 'Run') as HTMLButtonElement;
    const rateSel = h('select', { 'aria-label': 'beats a second' }, ...BABY_RATES.map(([r, n]) => h('option', { value: String(r) }, n))) as HTMLSelectElement;
    rateSel.value = String(rate);
    rateSel.addEventListener('change', () => { rate = Number(rateSel.value); last = performance.now(); });
    const stopped = () => babyHw(sim()!).stop === 1;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const deadline = now + 12;
      let due = 1e8;
      const r = toEnd ? 0 : rate;
      if (r) {
        due = Math.floor(((now - last) * r) / 1000);
        if (due < 1) return;
        last = due > r / 10 ? now : last + (due * 1000) / r;
      } else last = now;
      if (sim() instanceof DualSim) (sim() as DualSim).preferFast = true;
      stage.runCycles(due, () => performance.now() > deadline || (toEnd && stopped()), 0, true);
      if (toEnd && stopped()) { pause(); return; }
      if (now - shownAt > 250) { shownAt = now; stage.refresh(); }
      paint();
    };
    const start = (end = false) => {
      if (raf !== null || !sim()) return;
      const s = sim();
      if (s instanceof DualSim) s.prepare();
      stage.checkpoint();
      toEnd = end;
      last = startedAt = performance.now();
      runBtn.textContent = 'Pause';
      raf = requestAnimationFrame(tick);
    };
    function pause(): void {
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
      runBtn.textContent = 'Run';
      stage.refresh();
      paint();
    }
    runBtn.addEventListener('click', () => (raf !== null ? pause() : start()));
    const beatBtn = h('button', { class: 'btn sm', type: 'button', title: 'one beat: one clock edge' }, 'Beat');
    beatBtn.addEventListener('click', () => { pause(); stage.checkpoint(); stage.runCycles(1); paint(); });
    const instrBtn = h('button', { class: 'btn sm', type: 'button', title: 'to the end of the instruction (A2)' }, 'Instruction');
    instrBtn.addEventListener('click', () => {
      pause(); stage.checkpoint();
      const n0 = mon.iss.instrs;
      stage.runCycles(4, () => mon.iss.instrs > n0 || stopped());
      paint();
    });
    const endBtn = h('button', { class: 'btn sm', type: 'button', title: 'flat out to the stop lamp' }, 'Run to the end');
    endBtn.addEventListener('click', () => { pause(); start(true); });
    const regenBtn = h('button', { class: 'btn sm', type: 'button', 'aria-pressed': 'true' }, 'Regeneration on') as HTMLButtonElement;
    const paintRegen = () => {
      const on = stage.getInput('regen') === 1;
      regenBtn.textContent = on ? 'Regeneration on' : 'Regeneration off';
      regenBtn.setAttribute('aria-pressed', String(on));
    };
    regenBtn.addEventListener('click', () => { stage.setInput('regen', stage.getInput('regen') ? 0 : 1); paintRegen(); paint(); });
    const viewSel = h('select', { 'aria-label': 'how the face is drawn' },
      h('option', { value: 'face' }, 'Monitor: dots and dashes'), h('option', { value: 'charge' }, 'Charge: fading between rewrites')) as HTMLSelectElement;
    viewSel.value = view;
    viewSel.addEventListener('change', () => { view = viewSel.value as 'face' | 'charge'; paintFace(); });

    const el = h('div', { class: 'mem-panel bb-panel', 'data-dock': 'right', 'data-phone': 'flow' },
      h('h4', null, 'Baby ', verdict, h('span', { class: 'fold-hint' })),
      h('div', { class: 'bb-body' },
        h('div', { class: 'bb-crt' }, cv),
        h('div', { class: 'param-row' }, viewSel, regenBtn),
        beats, regs,
        h('div', { class: 'param-row' }, runBtn, rateSel, beatBtn, instrBtn, endBtn),
        progress, alarm, listing));

    const moving = settings.autoClock && !o.paused && !reducedMotion();
    const boot = requestAnimationFrame(() => { paintRegen(); paint(); if (moving) start(); });
    return {
      el,
      update: () => { if (raf === null) { paintRegen(); paint(); } },
      destroy: () => { cancelAnimationFrame(boot); if (raf !== null) cancelAnimationFrame(raf); raf = null; },
    };
  };
}
