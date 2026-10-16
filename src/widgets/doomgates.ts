// Appendix B's gate window: the Doom computer at gate level (lib/doompc.ts) on the stage, and a
// panel playing Doom on the fast interpreter. Paused, the panel hands the moment to the gates
// (doom/gates.ts loadGates) and clocks them for a window of cycles while the interpreter steps
// beside them, every retired instruction compared; the pixels the gates wrote glow on the screen.
//
// The scene is built from the game's data, so it starts as the bare core on a bench; starting the
// game reloads the stage with the whole computer (the session lives across that reload).

import { bench } from '../chapters/types';
import { doomComputer } from '../lib/doompc';
import { systemCore } from '../lib/system';
import { DualSim } from '../sim/dualsim';
import { h } from '../ui/dom';
import type { Scene, Stage, Widget } from '../view/stage';
import type { DoomPlayer } from '../doom/player';
import { FREEDOOM, fetchBytes, loadProgram, wadProblem, type Loaded } from './doom';

const W = 320, H = 200;
const WINDOWS = [1000, 5000, 20000];
const fmt = (n: number) => Math.round(n).toLocaleString('en');
const dur = (s: number) => (s < 60 ? `${s.toFixed(0)} s` : s < 3600 ? `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, '0')} s` : `${(s / 3600).toFixed(1)} h`);

interface Session {
  loaded: Loaded;
  player: DoomPlayer;
  name: string;
  /** Cycles of the last complete frame (from mtime between FLIPs). */
  frameCycles: number;
  flipMt: number;
  /** The gates' measured rate in this page (cycles/s), once a window has run. */
  gateRate: number;
}

/** One game for the chapter, kept while the learner moves between its steps. */
let session: Session | null = null;

export function doomGatesScene(): Scene {
  // larger than a sandbox chip holds (8 MiB of RAM, a 32 MiB ROM): no Open in Sandbox
  const hide = { autoClock: false as const, panels: [doomGatesPanel], noRemix: true };
  if (!session) {
    const root = bench(systemCore({ m: true }));
    return { ...hide, root, hiddenInputs: ['clk', 'irq', 'instr', 'memRData'] };
  }
  const dev = session.player.dev;
  return { ...hide, root: doomComputer(session.loaded.image.text, dev.wadWords, dev.wadLength), hiddenInputs: ['clk'], engine: 'cycle' };
}

function doomGatesPanel(stage: Stage): Widget {
  const canvas = h('canvas', { width: W, height: H, class: 'doom-screen', tabindex: 0, 'aria-label': 'Doom: click here, then play with the keyboard' });
  const g = canvas.getContext('2d')!;
  const img = g.createImageData(W, H);
  const status = h('div', { class: 'doom-status' });
  const controls = h('div', { class: 'param-row doom-row' });
  const result = h('div', { class: 'doom-gate-result' });
  const stats = h('div', { class: 'doom-kv' });
  const title = h('h4', null, 'Doom · interpreter and gates', h('span', { class: 'fold-hint' }));
  const el = h('div', { class: 'mem-panel cpu-panel doom-gates-panel', 'data-dock': 'right' }, title,
    h('div', { class: 'cpu-body' }, h('div', { class: 'doom-bezel' }, canvas), status, controls, result, stats,
      h('p', { class: 'cpu-sec-hint' }, 'Pause, then hand the moment to the gates: the registers, PC, CSRs and timer go into their flip-flops, the RAM, frame buffer and key queue into their memories, and the circuit on the left runs the next cycles while the interpreter steps beside it, comparing every instruction.')));

  let alive = true, raf = 0, last = 0, lastPanel = 0;
  let windowRun: { n: number; done: number; retired: number; t0: number; before: Uint8Array; chunk: number } | null = null;
  let windowSize = WINDOWS[1];
  const held = new Set<string>();

  const paint = () => {
    if (!session) return;
    const p = session.player;
    if (windowRun || (p.paused && result.dataset.gates === 'shown')) {
      // the gates' frame buffer, the pixels they wrote in this window glowing
      p.dev.rgba(img.data, true);
      const before = windowRun?.before ?? lastBefore;
      if (before) for (let i = 0; i < W * H; i++) if (p.dev.fb[i] !== before[i]) { const o = 4 * i; img.data[o] = 255; img.data[o + 1] = 212; img.data[o + 2] = 0; }
    } else p.dev.rgba(img.data, p.paused);
    g.putImageData(img, 0, 0);
  };
  let lastBefore: Uint8Array | null = null;

  const renderStats = () => {
    if (!session) return;
    const s = session, p = s.player;
    const rate = s.gateRate;
    const kv: [string, string][] = [
      ['Engine', windowRun ? `gates · cycle engine` : p.paused ? 'paused' : `interpreter · ${p.mips.toFixed(0)} MIPS`],
      ['Frame', fmt(p.dev.flips)],
      ['Cycles, last frame', s.frameCycles ? fmt(s.frameCycles) : '…'],
      ['Gates in this page', rate ? `${fmt(rate)} cycles/s` : 'not run yet'],
      ['That frame on the gates', rate && s.frameCycles ? `≈ ${dur(s.frameCycles / rate)}` : '…'],
    ];
    stats.replaceChildren(...kv.flatMap(([k, v]) => [h('span', null, k), h('span', null, v)]));
  };

  const renderControls = () => {
    if (!session) return;
    const p = session.player;
    const btn = (label: string, run: () => void, primary = false) => h('button', { type: 'button', class: primary ? 'btn sm primary' : 'btn sm', onclick: run }, label);
    if (windowRun) { controls.replaceChildren(btn('Stop', () => finishWindow(true))); return; }
    if (!p.paused) { controls.replaceChildren(btn('❚❚ Pause', () => { releaseAll(); p.pause(); renderControls(); renderStats(); paint(); }, true)); return; }
    const sel = h('select', { class: 'doom-win', 'aria-label': 'Cycles to run on the gates' }, WINDOWS.map((n) => h('option', { value: n, selected: n === windowSize }, `${fmt(n)} cycles`)));
    sel.addEventListener('change', () => { windowSize = Number(sel.value); });
    controls.replaceChildren(btn('▶ Resume', () => { result.dataset.gates = ''; p.resume(); canvas.focus(); renderControls(); }), sel, btn('Run on the gates', startWindow, true));
  };

  // ---- the gate window ----
  const startWindow = () => {
    if (!session || !(stage.sim instanceof DualSim)) return;
    const p = session.player;
    lastBefore = p.dev.fb.slice(0, W * H);
    const { loadGates } = gatesMod!;
    loadGates(stage.sim, p.cpu);
    windowRun = { n: windowSize, done: 0, retired: 0, t0: performance.now(), before: lastBefore, chunk: 50 };
    result.textContent = '';
    result.className = 'doom-gate-result';
    renderControls();
    stage.refresh();
  };

  const finishWindow = (stopped: boolean, mismatch?: string) => {
    if (!session || !windowRun) return;
    const w = windowRun, p = session.player;
    windowRun = null;
    const s = (performance.now() - w.t0) / 1000;
    if (w.done > 0 && s > 0) session.gateRate = w.done / s;
    p.steppedOutside();
    const diff = mismatch ?? gatesMod!.memoryDiff(stage.sim!, p.cpu) ?? undefined;
    result.dataset.gates = 'shown';
    result.className = `doom-gate-result ${diff ? 'bad' : 'good'}`;
    result.replaceChildren(diff
      ? h('span', null, h('b', null, 'The gates and the interpreter disagree: '), diff)
      : h('span', null, h('b', null, `✓ ${fmt(w.done)} cycles, ${fmt(w.retired)} instructions`), `${stopped ? ' (stopped)' : ''}: every instruction's PC and registers equal, then all 8 MiB of RAM and the frame buffer. The yellow pixels were drawn by the gates in this window.`));
    renderControls(); renderStats(); paint();
    stage.refresh();
  };

  const stepWindow = () => {
    if (!session || !windowRun || !stage.sim) return;
    const w = windowRun, t0 = performance.now();
    while (w.done < w.n && performance.now() - t0 < 25) {
      const n = Math.min(w.chunk, w.n - w.done);
      const t1 = performance.now();
      const r = gatesMod!.runWindow(stage.sim, session.player.cpu, n);
      w.done += r.cycles; w.retired += r.retired;
      if (r.mismatch) { finishWindow(false, r.mismatch); return; }
      // aim for chunks of about 8 ms
      const ms = performance.now() - t1;
      w.chunk = Math.max(10, Math.min(5000, Math.round(w.chunk * (ms > 0 ? 8 / ms : 2))));
    }
    status.textContent = `On the gates: ${fmt(w.done)} of ${fmt(w.n)} cycles, ${fmt(w.retired)} instructions compared.`;
    stage.refresh();
    if (w.done >= w.n) finishWindow(false);
  };

  // ---- the loop ----
  const loop = (now: number) => {
    if (!alive) return;
    raf = requestAnimationFrame(loop);
    if (!session) return;
    const p = session.player, dt = last ? now - last : 16;
    last = now;
    if (windowRun) { stepWindow(); paint(); }
    else if (!p.paused) {
      const f0 = p.dev.flips;
      p.advance(dt, 10, now);
      if (p.dev.flips !== f0) paint();
    }
    if (now - lastPanel > 250) { lastPanel = now; renderStats(); }
  };

  // ---- keys ----
  const releaseAll = () => {
    if (session) for (const code of held) { const k = session.loaded.keys.doomKey(code); if (k !== null) session.player.dev.key(k, false); }
    held.clear();
  };
  const onKey = (e: KeyboardEvent) => {
    if (!session || session.player.paused || windowRun) return;
    const k = session.loaded.keys.doomKey(e.code);
    if (k === null) return;
    e.preventDefault(); e.stopPropagation();
    const down = e.type === 'keydown';
    if (down && (e.repeat || held.has(e.code))) return;
    if (down) held.add(e.code); else held.delete(e.code);
    session.player.dev.key(k, down);
  };
  canvas.addEventListener('keydown', onKey);
  canvas.addEventListener('keyup', onKey);
  canvas.addEventListener('blur', releaseAll);

  // ---- starting ----
  let gatesMod: typeof import('../doom/gates') | null = null;
  const begin = async (wad: Uint8Array, name: string, loaded: Loaded) => {
    const problem = wadProblem(wad);
    if (problem) { status.textContent = `${name}: ${problem}.`; return; }
    const player = new loaded.mod.DoomPlayer(loaded.image, wad, loaded.syms);
    const s: Session = { loaded, player, name, frameCycles: 0, flipMt: 0, gateRate: 0 };
    player.dev.onFlip = () => { s.frameCycles = (player.cpu.mtime - s.flipMt) >>> 0; s.flipMt = player.cpu.mtime; };
    session = s;
    status.textContent = 'Building the gate-level computer…';
    // the stage now shows the whole computer; this panel is rebuilt with it
    setTimeout(() => stage.load(doomGatesScene()), 0);
  };

  if (!session) {
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    status.textContent = 'Loading the program…';
    loadProgram().then((loaded) => {
      if (!alive) return;
      status.textContent = 'This is the core alone. Start the game to build the whole Doom computer around it.';
      const file = h('input', { type: 'file', accept: '.wad,.WAD', class: 'doom-file', 'aria-label': 'Load your own WAD file' });
      file.addEventListener('change', async () => { const f = file.files?.[0]; if (f) void begin(new Uint8Array(await f.arrayBuffer()), f.name, loaded); });
      const play = h('button', { type: 'button', class: 'btn sm primary', onclick: async () => {
        play.setAttribute('disabled', '');
        try {
          const wad = await fetchBytes(FREEDOOM, (got, total) => { status.textContent = `Downloading Freedoom: ${(got / 1e6).toFixed(1)}${total ? ` of ${(total / 1e6).toFixed(1)}` : ''} MB…`; });
          if (alive) void begin(wad, 'Freedoom: Phase 1', loaded);
        } catch {
          status.textContent = 'Freedoom is not part of this build (the deploy adds it; locally: node scripts/doom/fetch-wad.mjs --public). You can load your own WAD instead.';
          play.removeAttribute('disabled');
        }
      } }, 'Play Freedoom (29 MB)');
      controls.replaceChildren(play, h('label', { class: 'btn sm' }, 'Load your own WAD…', file));
    }).catch((e: unknown) => { status.textContent = `Could not load the program: ${String(e)}`; });
  } else {
    status.textContent = `${session.name} on the interpreter. Click the screen to play; pause to hand it to the gates.`;
    void import('../doom/gates').then((m) => { gatesMod = m; renderControls(); });
    renderControls(); renderStats(); paint();
    raf = requestAnimationFrame(loop);
  }

  return {
    el,
    update() { /* the panel draws itself */ },
    destroy() {
      alive = false;
      cancelAnimationFrame(raf);
      releaseAll();
      // a window in progress ends with the panel (the interpreter has stepped as far as the gates)
      if (windowRun && session) { session.player.steppedOutside(); windowRun = null; }
    },
  };
}
