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
import { modelStage } from './modelstage';
import { STATIONS, assemblyAnchors, assemblyParts, kindOfWord, lampsOf, palletsAt, type AssemblyPalette } from './assembly3dparts';

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
  let t = 4, u = 1, running = false, acc = 0;
  const word = (pc: number) => L.words[(pc >>> 2) & 63] ?? 0;
  // a fetch past the program reads the ROM's empty words: only wrong-path instructions ever do
  const text = (pc: number) => (word(pc) === 0 ? '(empty ROM word)' : disasm(word(pc), pc));
  const ctx = { kindOf: (pc: number) => kindOfWord(word(pc)), mnemonicOf: (pc: number) => (word(pc) === 0 ? 'empty' : text(pc).split(' ')[0]) };

  const panel = h('div', { class: 'panel' });
  const stage = modelStage(panel, {
    aria: 'The five-stage pipeline as an assembly line in 3D: Fetch, Decode, Execute, Memory and Writeback stations on a belt, a pallet for every instruction in flight, an empty pallet for a bubble',
    // the stage is as wide as the model needs: a phone's narrow one sits further back
    camera: { target: [4, 8, 0], yaw: 0.35, pitch: 0.42, dist: typeof innerWidth === 'number' && innerWidth < 640 ? 185 : 165 },
    limits: { minDist: 70, maxDist: 420 },
    note: 'The stations are a drawing; the timing is the pipeline’s, item for item (details below).',
    draw: () => paint(),
  });
  const palette = (): AssemblyPalette => ({
    frame: stage.rgb('--m3-si'), belt: stage.rgb('--as-belt'), plate: stage.rgb('--as-plate'), bubble: stage.rgb('--as-bubble'),
    alu: stage.rgb('--as-alu'), load: stage.rgb('--as-load'), store: stage.rgb('--as-store'), ctl: stage.rgb('--as-ctl'), wrong: stage.rgb('--as-wrong'),
    off: stage.rgb('--as-off'), hold: stage.rgb('--as-ctl'), flush: stage.rgb('--as-wrong'),
  });
  function paint(): void {
    const p = palletsAt(L.plan, t, u, ctx);
    stage.paint(assemblyParts(p, lampsOf(L.plan[t]), palette()), assemblyAnchors(p));
  }

  const chip = h('span', { class: 'r3-chip' }), kv = h('div', { class: 'r3-kv as-stages' }), status = h('p', { class: 'as-status', 'aria-live': 'polite' });
  stage.chips.append(chip);

  /** What this clock's hazard logic does, in a sentence. */
  function say(c: Cycle): string {
    const [F, D, E] = c.slots, n = (s: Cycle['slots'][number]) => (s.valid ? `“${text(s.pc)}”` : 'a bubble');
    if (c.stall) return `Cycle ${t}: load-use. ${n(E)} is a load and ${n(D)} reads its result, which exists only after Memory: Fetch and Decode hold, a bubble goes into Execute.`;
    if (c.flush) return `Cycle ${t}: ${n(E)} redirects the PC from Execute (a jump or taken branch). ${c.pulled.length} wrong-path instruction${c.pulled.length > 1 ? 's' : ''} pulled off the line (${[F, D].filter((s) => c.pulled.includes(s.seq)).map(n).join(' and ')}); Fetch restarts at the target.`;
    if (t === 0) return 'Cycle 0: power-on. The first instruction is being fetched; the other four stations are empty.';
    if (c.slots.every((s) => s.valid)) return `Cycle ${t}: the line is full, five instructions in flight; “${text(c.slots[4].pc)}” is retiring.`;
    return `Cycle ${t}: ${c.slots.filter((s) => s.valid).length} of 5 stations hold an instruction${c.slots[2].valid ? '' : ' (a bubble is in Execute)'}.`;
  }

  function readout(): void {
    const c = L.plan[t];
    let stalls = 0, flushes = 0, retired = 0;
    for (let i = 0; i < t; i++) { const q = L.plan[i]; if (q.stall) stalls++; if (q.flush) flushes++; if (q.slots[4].valid) retired++; }
    chip.textContent = c.stall ? 'Stall: bubble into E' : c.flush ? 'Flush: 2 pulled' : 'Flowing';
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
    const msg = say(c);
    if (status.textContent !== msg) status.textContent = msg;
    status.setAttribute('aria-live', running ? 'off' : 'polite');
    playBtn.textContent = running ? 'Pause' : 'Play';
    playBtn.setAttribute('aria-pressed', String(running));
    stepBtn.disabled = t + 1 >= L.plan.length;
    backBtn.disabled = t === 0;
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
    t++; u = reducedMotion() ? 1 : 0;
    if (running && t >= L.end) running = false; // the program has halted: its spin loop only repeats
  }
  const go = (to: number, slide: boolean) => { running = false; acc = 0; t = Math.min(L.plan.length - 1, Math.max(0, to)); u = slide && !reducedMotion() ? 0 : 1; repaint(); };

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
  const resetBtn = h('button', { type: 'button', class: 'btn sm' }, 'Reset') as HTMLButtonElement;
  resetBtn.addEventListener('click', () => go(0, false));

  const swatch = (c: string, label: string) => h('span', null, h('i', { style: `background:var(${c})` }), label);
  panel.append(
    h('h3', { class: 'm3-title' }, 'The pipeline as an assembly line'),
    h('p', { class: 'm3-sub' }, 'Overlapped, each instruction still takes five stations, but once the line is full one comes out every clock. Every clock moves every pallet one station on. A load whose result the next instruction needs sends an empty pallet down the line (the bubble) while Fetch and Decode wait. A jump or taken branch is only known in Execute, so the two instructions fetched behind it, a guess that the road went straight on, are pulled off the line. Pick one of the chapter’s programs and step through its stalls and flushes.'),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' },
        h('div', { class: 'r3-ctl' }, h('label', { class: 'as-prog' }, h('span', null, 'Program'), select),
          h('div', { class: 'r3-btns' }, stepBtn, playBtn, backBtn, hazBtn, resetBtn, stage.resetBtn)),
        stage.el, stage.hint, status,
        h('div', { class: 'as-legend', 'aria-label': 'Colours' }, swatch('--as-alu', 'arithmetic'), swatch('--as-load', 'load'), swatch('--as-store', 'store'), swatch('--as-ctl', 'branch / jump'),
          swatch('--as-wrong', '✗ wrong path, pulled'), swatch('--as-bubble', 'empty pallet: bubble')),
        h('details', { class: 'deeper as-note' }, h('summary', null, 'What is drawn and what is modelled'),
          h('p', null, 'The timing is the five-stage pipeline’s own, item for item: which instruction, or bubble, is in each station every clock, and when the hazard unit stalls or flushes, are held by test to the gate-level CPU’s pipeline registers on these programs (tests/model-assembly.test.ts, including jal and jalr). The rules are those of lib/pipeline.ts’s hazard unit as chapter 17 describes them. What is simplified:'),
          h('ul', null,
            h('li', null, 'The stations, belt and pallets are a drawing. The slide between two clocks is animation: in the circuit, everything changes at the clock edge.'),
            h('li', null, 'A laundromat’s machines each run at their own pace. Here one clock moves every station together, so the slowest stage sets the beat for all of them (the next step measures what that costs).'),
            h('li', null, 'Only which instruction is where is kept, not values: whether a branch is taken comes from the golden model, and forwarding costs no cycle, so it is not drawn.'),
            h('li', null, 'Memory is ideal: no cache misses, and no multi-cycle instructions (this CPU has no multiply or divide).'),
            h('li', null, 'The hazard unit compares the load’s destination with the register fields of the instruction in Decode whether or not that instruction reads them, so it could stall where no register is used. None of these programs does; the test checks it.'),
            h('li', null, 'A branch whose target is the very next instruction would still flush in the circuit; the model cannot tell it from a branch not taken. None of these programs has one.')))),
      h('div', { class: 'r3-side' }, h('h4', null, 'This line ', h('span', { class: 'r3-badge' }, 'model')), kv)));
  readout();
  paint();
  return { el: panel, destroy() { loop.stop(); stage.destroy(); } };
}
