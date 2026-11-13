// The pipeline as an assembly line in 3D (loaded on demand, modelhost.ts). Where each pallet is comes from
// riscv/pipetrace.ts, which tests/model-assembly.test.ts holds to the gate-level pipelinedCpu cycle by cycle; the stations
// are a drawing and the slide between two clocks is animation.

import '../styles/assembly3d.css';
import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { assemble } from '../riscv/asm';
import { disasm } from '../riscv/isa';
import { pipeSchedule, type Cycle } from '../riscv/pipetrace';
import { frameLoop } from './mosfet';
import { packInstances } from '../gl/instances';
import { M } from '../gl/kit/materials';
import { STATIONS, kindOfWord, palletsAt, flushText, outcomeOf, type Outcome } from './assembly3dparts';
import { BEAT_EVENTS, RIDER, armAngle, armMove, asmModel, clockOf, palletMove, riders, type AsmLook, type AsmRgb } from './assembly3dkit';
import { studioStage, type StudioStage } from './studiostage';
import { numOf } from '../chapters/order';

const FALLBACK: AsmRgb = { alu: [0.4, 0.6, 0.88], load: [0.25, 0.8, 0.54], store: [0.65, 0.51, 0.86], ctl: [0.94, 0.69, 0.24], wrong: [1, 0.42, 0.47], bubble: [0.3, 0.31, 0.41], hold: [0.31, 0.83, 0.91], off: [0.34, 0.36, 0.45], fwd: [1, 0.82, 0.25] };

export interface AssemblyProgram { id: string; name: string; source: string }

/** Cycles planned per program (the halt loop keeps flushing, so the plan never runs dry before this). */
const HORIZON = 160;
/** A clock's length on Play, and the share of it the slide takes; a stepped clock's slide. */
const PERIOD_MS = 900, MOVE = 0.6, STEP_MS = 500;
const hex = (pc: number) => `0x${pc.toString(16).padStart(2, '0')}`;

interface Loaded { words: number[]; plan: Cycle[]; /** The first cycle the halt loop's jump reaches Writeback. */ end: number }

export function assemblyView(programs: readonly AssemblyProgram[]): Widget {
  const loaded = new Map<string, Loaded>();
  const load = (p: AssemblyProgram): Loaded => {
    let l = loaded.get(p.id);
    if (!l) {
      const words = assemble(p.source).words, plan = pipeSchedule(words, HORIZON);
      l = { words, plan, end: Math.max(0, plan.findIndex((c) => c.slots[4].valid && words[c.slots[4].pc >>> 2] === 0x0000006f)) };
      loaded.set(p.id, l);
    }
    return l;
  };
  let prog = programs.find((p) => p.id === 'hazards') ?? programs[0], L = load(prog);
  // Opens with the line full, so the first Step has something to show.
  let t = 4, u = 1, running = false, acc = 0, verdict = '';
  const word = (pc: number) => L.words[(pc >>> 2) & 63] ?? 0;
  // a fetch past the program reads the ROM's empty words: only wrong-path instructions ever do
  const text = (pc: number) => (word(pc) === 0 ? '(empty ROM word)' : disasm(word(pc), pc));
  const ctx = {
    kindOf: (pc: number) => kindOfWord(word(pc)), mnemonicOf: (pc: number) => (word(pc) === 0 ? 'empty' : text(pc).split(' ')[0]),
    textOf: text, hexOf: (pc: number) => `${hex(pc)} · 0x${(word(pc) >>> 0).toString(16).padStart(8, '0')}`,
  };
  let stageRef: StudioStage | null = null;
  const rgb = (): AsmRgb => {
    const s = stageRef;
    return s ? { alu: s.rgb('--as-alu'), load: s.rgb('--as-load'), store: s.rgb('--as-store'), ctl: s.rgb('--as-ctl'), wrong: s.rgb('--as-wrong'), bubble: s.rgb('--as-bubble'), hold: s.rgb('--as-hold'), off: s.rgb('--as-off'), fwd: s.rgb('--as-fwd') } : FALLBACK;
  };
  const look = (detail: AsmLook['detail']): AsmLook => ({ detail, plan: L.plan, t, u, ctx, rgb: rgb() });

  const panel = h('div', { class: 'panel' });
  const stage = studioStage({
    aria: 'The five-stage pipeline as an assembly line in 3D: Fetch, Decode, Execute, Memory and Writeback stations on a belt, a pallet for every instruction in flight, an empty pallet for a bubble, chutes that carry a forwarded value back to Execute',
    home: { target: [0, 0, 0], yaw: 0.35, pitch: 0.42, dist: 200 },
    homeFrame: ['homebox'],
    // one shape for every clock (a rebuild would otherwise resize the canvas and refit home)
    aspect: 1.5,
    hidden: ['homebox', 'chutebox', 'stallbox', 'flushbox'],
    limits: { minDist: 20, maxDist: 600 },
    // each beat goes to the first clock of this program where its event happens
    onBeat: (i) => { const e = BEAT_EVENTS[i]; const to = e ? clockOf(L.plan, e) : null; if (to !== null) { verdict = ''; running = false; acc = 0; t = to; u = 1; } key = ''; readout(); put(); },
    note: 'The stations, belt, chutes and arm are a drawing; the timing is the pipeline’s, item for item, and so is every forward, stall and flush (details below).',
    build: (detail) => asmModel(look(detail)),
  });
  stageRef = stage;
  const NONE = new Float32Array(0);
  const riderMat = M.make({ base: [1, 1, 1], metal: 0, rough: 0.3, bloom: 1, label: 'the value forwarded' });
  /** The model is rebuilt at a clock and when its slide ends (the set of pallets changes); the moves place them between. */
  let key = '', built: number[] = [], flatAt = 0;
  function put(): void {
    const k = `${prog.id}|${t}|${u >= 1}`, now = performance.now();
    if (stage.isFlat()) { if (k !== key || (u < 1 && now - flatAt > 150)) { key = k; flatAt = now; stage.refresh(); } return; }
    const ps = palletsAt(L.plan, t, u, ctx);
    if (k !== key) { key = k; built = ps.map((p) => p.seq); stage.refresh(); }
    const at = new Map(ps.map((p) => [p.seq, p] as const)), moves = new Map<string, Float32Array>();
    for (const s of built) { const p = at.get(s); moves.set(`pal${s}`, p ? palletMove(p) : palletMove({ seq: s, x: 0, y: -40, z: 0, size: 0, kind: 'bubble', wrong: false, text: '' })); }
    moves.set('arm', armMove(armAngle(L.plan, t, u)));
    stage.move(moves);
    stage.instances('rider', RIDER, riderMat, u < 1 && !reducedMotion() ? packInstances(riders(L.plan[t], u, rgb())) : NONE);
    stage.studio()?.invalidate();
  }
  const paint = (): void => put();

  const chip = h('span', { class: 'r3-chip' }), kv = h('div', { class: 'r3-kv as-stages' }), status = h('p', { class: 'as-status', 'aria-live': 'polite' });
  stage.chips.append(chip);

  /** What this clock's hazard logic does, in a sentence. */
  function say(c: Cycle): string {
    const [F, D, E] = c.slots, n = (s: Cycle['slots'][number]) => (s.valid ? `“${text(s.pc)}”` : 'a bubble');
    if (c.stall) return `Cycle ${t}: load-use. ${n(E)} is a load and ${n(D)} reads its result, which exists only after Memory: Fetch and Decode hold, a bubble goes into Execute.`;
    if (c.flush) return `Cycle ${t}: ${n(E)} redirects the PC from Execute (a jump or taken branch). ${c.pulled.length} wrong-path instruction${c.pulled.length > 1 ? 's' : ''} pulled off the line (${[F, D].filter((s) => c.pulled.includes(s.seq)).map(n).join(' and ')}); Fetch restarts at the target.`;
    if (t === 0) return 'Cycle 0: power-on. The first instruction is being fetched; the other four stations are empty.';
    if (c.slots.every((s) => s.valid)) return `Cycle ${t}: the line is full, five instructions in flight; “${text(c.slots[4].pc)}” is retiring.`;
    // Every station holding a bubble, by name; "(flush)" when they are the two slots the last cycle's redirect emptied.
    const empty = c.slots.map((s, i) => (s.valid ? '' : STATIONS[i])).filter(Boolean);
    const why = t > 0 && L.plan[t - 1].flush ? ' (flush)' : '';
    const where = empty.length === 1 ? `a bubble in ${empty[0]}` : `bubbles in ${empty.slice(0, -1).join(', ')} and ${empty[empty.length - 1]}`;
    return `Cycle ${t}: ${5 - empty.length} of 5 stations hold an instruction; ${where}${why}.`;
  }

  function readout(): void {
    const c = L.plan[t];
    let stalls = 0, flushes = 0, retired = 0;
    for (let i = 0; i < t; i++) { const q = L.plan[i]; if (q.stall) stalls++; if (q.flush) flushes++; if (q.slots[4].valid) retired++; }
    chip.textContent = c.stall ? 'Stall: bubble into E' : c.flush ? flushText(c) : 'Flowing';
    chip.className = `r3-chip ${c.stall || c.flush ? 'warn' : 'good'}`;
    const rows: [string, string, string][] = [
      ['Clock cycle', String(t), ''],
      ...c.slots.map((s, i): [string, string, string] => [STATIONS[i], s.valid ? `${hex(s.pc)}  ${text(s.pc)}` : 'bubble', s.valid ? (c.flush && c.pulled.includes(s.seq) ? 'wrong' : '') : 'bub']),
      ['Retired so far', String(retired), ''],
      ['Stall cycles so far', String(stalls), ''],
      ['Flush cycles so far', `${flushes} (${2 * flushes} slots lost)`, ''],
      ['Cycles per instruction', retired ? (t / retired).toFixed(2) : '–', ''],
    ];
    kv.replaceChildren(...rows.flatMap(([k, v, cls]) => [h('span', null, k), h('span', { class: `v ${cls}` }, v)]));
    const msg = verdict + say(c);
    if (status.textContent !== msg) status.textContent = msg;
    status.setAttribute('aria-live', running ? 'off' : 'polite');
    playBtn.textContent = running ? 'Pause' : 'Play';
    playBtn.setAttribute('aria-pressed', String(running));
    stepBtn.disabled = t + 1 >= L.plan.length;
    backBtn.disabled = t === 0;
    for (const b of predictBtns) b.disabled = t + 1 >= L.plan.length;
    scrub.value = String(t); scrubOut.textContent = String(t);
    hazBtn.disabled = !L.plan.some((q) => q.stall || q.flush);
  }

  const loop = frameLoop((_now, dt) => {
    if (running) {
      acc += dt * 1000;
      const period = reducedMotion() ? 1100 : PERIOD_MS;
      if (acc >= period) { acc -= period; advance(); }
      u = reducedMotion() ? 1 : Math.min(1, acc / (period * MOVE));
    } else if (u < 1) u = Math.min(1, u + (dt * 1000) / STEP_MS);
    readout(); paint();
  }, () => running || u < 1);
  const repaint = () => { readout(); paint(); loop.kick(); };

  /** One clock on; the slide starts over (no slide with reduced motion). */
  function advance(): void {
    if (t + 1 >= L.plan.length) { running = false; return; }
    t++; u = reducedMotion() ? 1 : 0; verdict = '';
    if (running && t >= L.end) running = false; // the program has halted: its spin loop only repeats
  }
  const go = (to: number, slide: boolean) => { verdict = ''; running = false; acc = 0; t = Math.min(L.plan.length - 1, Math.max(0, to)); u = slide && !reducedMotion() ? 0 : 1; repaint(); };

  const select = h('select', { 'aria-label': 'Program' }, ...programs.map((p) => h('option', { value: p.id }, p.name))) as HTMLSelectElement;
  select.value = prog.id;
  select.addEventListener('change', () => { prog = programs.find((p) => p.id === select.value)!; L = load(prog); go(0, false); });
  const playBtn = h('button', { type: 'button', class: 'btn sm primary', 'aria-pressed': 'false' }, 'Play') as HTMLButtonElement;
  playBtn.addEventListener('click', () => {
    if (running) { running = false; u = 1; repaint(); return; }
    if (t >= L.end) { t = 0; u = 1; }
    running = true; acc = 0; u = 1; repaint();
  });
  const stepBtn = h('button', { type: 'button', class: 'btn sm' }, 'Step one clock') as HTMLButtonElement;
  stepBtn.addEventListener('click', () => go(t + 1, true));
  const backBtn = h('button', { type: 'button', class: 'btn sm' }, 'Back') as HTMLButtonElement;
  backBtn.addEventListener('click', () => go(t - 1, false));
  const hazBtn = h('button', { type: 'button', class: 'btn sm' }, 'Next hazard') as HTMLButtonElement;
  hazBtn.addEventListener('click', () => {
    const k = L.plan.findIndex((q, i) => i > t && (q.stall || q.flush)), to = k >= 0 ? k : L.plan.findIndex((q) => q.stall || q.flush);
    go(to, to === t + 1);
  });
  // Predict, then see: the answer is the plan's own next cycle, no new model.
  const ASK: [Outcome, string][] = [['flow', 'Flows on'], ['stall', 'Bubble into Execute'], ['flush', 'Pull the wrong path']];
  const WORD: Record<Outcome, string> = { flow: 'the line flows on', stall: 'a load-use stall puts a bubble into Execute', flush: 'a redirect pulls the wrong-path fetches' };
  let asked = 0, right = 0;
  const score = h('span', { class: 'as-score' }), predictBtns = ASK.map(([o, label]) => {
    const b = h('button', { type: 'button', class: 'btn sm' }, label) as HTMLButtonElement;
    b.addEventListener('click', () => {
      const actual = outcomeOf(L.plan[t + 1]);
      asked++; if (actual === o) right++;
      go(t + 1, true);
      verdict = `${actual === o ? 'Right' : 'Not quite'}: ${WORD[actual]}. `;
      score.textContent = `Predicted ${right} of ${asked}`; readout();
    });
    return b;
  });
  const resetBtn = h('button', { type: 'button', class: 'btn sm' }, 'Reset') as HTMLButtonElement;
  resetBtn.addEventListener('click', () => { asked = right = 0; score.textContent = ''; go(0, false); });
  const scrubOut = h('output', null, String(t));
  const scrub = h('input', { type: 'range', min: 0, max: HORIZON - 1, step: 1, value: t, 'aria-label': 'Clock cycle' }) as HTMLInputElement;
  scrub.addEventListener('input', () => go(Number(scrub.value), false));

  const swatch = (c: string, label: string) => h('span', null, h('i', { style: `background:var(${c})` }), label);
  panel.append(
    h('h3', { class: 'm3-title' }, 'The pipeline as an assembly line'),
    h('p', { class: 'm3-sub' }, 'Overlapped, each instruction still takes five stations, but once the line is full one comes out every clock. Every clock moves every pallet one station on. A load whose result the next instruction needs sends an empty pallet down the line (the bubble) while Fetch and Decode wait. A jump or taken branch is only known in Execute, so the two instructions fetched behind it, a guess that the road went straight on, are pulled off the line. Pick one of the chapter’s programs and step through its stalls and flushes.'),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' },
        h('div', { class: 'r3-ctl' }, h('label', { class: 'as-prog' }, h('span', null, 'Program'), select),
          h('div', { class: 'r3-btns' }, stepBtn, playBtn, backBtn, hazBtn, resetBtn)),
        stage.el, status,
        h('div', { class: 'as-predict', role: 'group', 'aria-label': 'Predict the next clock' }, h('span', { class: 'as-q' }, 'Predict the next clock:'), ...predictBtns, score),
        h('label', { class: 'as-scrub' }, h('span', null, 'Clock'), scrub, scrubOut),
        h('div', { class: 'as-legend', 'aria-label': 'Colours' }, swatch('--as-alu', 'arithmetic'), swatch('--as-load', 'load'), swatch('--as-store', 'store'), swatch('--as-ctl', 'branch / jump'),
          swatch('--as-wrong', '✗ wrong path, pulled'), swatch('--as-bubble', 'empty pallet: bubble'), swatch('--as-hold', 'lamp: Fetch / Decode hold'), swatch('--as-wrong', 'lamp: flush')),
        h('details', { class: 'deeper as-note' }, h('summary', null, 'What is drawn and what is modelled'),
          h('p', null, 'The timing is the five-stage pipeline’s own, item for item: which instruction, or bubble, is in each station every clock, and when the hazard unit stalls or flushes, are held by test to the gate-level CPU’s pipeline registers on these programs (tests/model-assembly.test.ts, including jal and jalr). The rules are those of lib/pipeline.ts’s hazard unit as chapter ' + numOf('pipeline') + ' describes them. What is simplified:'),
          h('ul', null,
            h('li', null, 'The stations, belt, pallets, chutes and the flush arm are a drawing. The slide between two clocks is animation: in the circuit, everything changes at the clock edge, and a forwarded value does not travel: it is a mux choosing another wire.'),
            h('li', null, 'A laundromat’s machines each run at their own pace. Here one clock moves every station together, so the slowest stage sets the beat for all of them (the next step measures what that costs).'),
            h('li', null, 'Only which instruction is where is kept, not values: whether a branch is taken comes from the golden model. Forwarding costs no cycle; the chutes show where it happens, lit on the clocks the hazard unit’s forwardA or forwardB selects Memory or Writeback (held to the gates too). It is why a dependent pair of arithmetic instructions never stalls; only a load followed by its user does.'),
            h('li', null, 'All five stations are drawn the same size. They are not the same length of logic: Execute is nearly the whole path of the single-cycle CPU, and it sets the clock for every station (the next step measures it).'),
            h('li', null, 'Memory is ideal: no cache misses, and no multi-cycle instructions (this CPU has no multiply or divide).'),
            h('li', null, 'The hazard unit compares the load’s destination with the register fields of the instruction in Decode whether or not that instruction reads them, so it could stall where no register is used. None of these programs does; the test checks it.'),
            h('li', null, 'A branch whose target is the very next instruction would still flush in the circuit; the model cannot tell it from a branch not taken. None of these programs has one.')))),
      h('div', { class: 'r3-side' }, h('h4', null, 'This line ', h('span', { class: 'r3-badge' }, 'model')), kv)));
  readout();
  const ready = setInterval(() => { if (stage.studio() || stage.isFlat()) { clearInterval(ready); key = ''; put(); } }, 100);
  return { el: panel, destroy() { clearInterval(ready); loop.stop(); stage.destroy(); } };
}
