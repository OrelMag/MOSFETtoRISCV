// Appendix D's scenes: Bit Runner at gate level on its boards, with the Screen panel: a monitor on the sync and video
// pins (runner/crt.ts), the buttons, and the reference model in lock step at every rising edge, a difference shown loudly.

import '../styles/runner.css';
import { BIT_RUNNER } from '../lib/bitrunner';
import { Crt } from '../runner/crt';
import { BitRunnerModel, RB_CLOCKS, RB_H, RB_LINE, RB_W, type RbState, type RbVideo } from '../runner/model';
import { DualSim } from '../sim/dualsim';
import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import { settings } from '../ui/settings';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { runnerLayout } from './runnerlayout';

export interface RunnerOptions {
  highlight?: string[];
  /** Open on the schematic at this path instead of the boards. */
  path?: string[];
  /** Clocks a second on load (one of RB_RATES); default the game's. */
  rate?: number;
  /** Stay paused on load (a step counted in lines or pulses). */
  paused?: boolean;
}

/** The game's speed: 30 frames a second. Slower chips would play in slow motion: game time counts frames. */
const GAME_HZ = RB_CLOCKS * 30;
/** Run's rates in clocks a second (0: as fast as the page runs). */
export const RB_RATES: [number, string][] = [[GAME_HZ, 'Game speed'], [0, 'Flat out'], [RB_CLOCKS, '1 frame / s'], [400, '400 pixels / s'], [40, '40 pixels / s']];

/** On-screen colours: the picture is a monitor's in both themes. */
const RGB = [[5, 7, 10], [242, 245, 255], [255, 176, 0], [56, 224, 255]];
const VIDEO_PINS = ['white', 'amber', 'cyan', 'hsync', 'vsync'] as const;
const BUTTONS = ['up', 'down', 'flip', 'start'] as const;
type Button = (typeof BUTTONS)[number];
const KEYS: Record<string, Button> = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', Space: 'flip', Enter: 'start' };

export function runnerScene(o: RunnerOptions = {}): Scene {
  return {
    root: BIT_RUNNER, clock: 'clk', engine: 'cycle', inputs: { up: 0, down: 0, flip: 0, start: 0 },
    path: o.path, highlight: o.highlight, autoClock: false, breadboard: runnerLayout(), panels: [runnerPanel(o)], resetLabel: 'Power cycle',
  };
}

export function runnerPanel(o: RunnerOptions): ScenePanel {
  return (stage: Stage): Widget => {
    let model = new BitRunnerModel();
    const crt = new Crt();
    let mismatch = '';
    let raf: number | null = null, last = 0, rate = o.rate ?? GAME_HZ, fps = 0, fpsAt = 0, fpsFrames = 0, shownAt = 0;
    const netOf = (p: string) => stage.sim!.design.root.ports[p][0];
    let pins: { v: Record<(typeof VIDEO_PINS)[number], number>; b: Record<Button, number> } | null = null;
    const look = () => {
      pins = {
        v: Object.fromEntries(VIDEO_PINS.map((p) => [p, netOf(p)])) as Record<(typeof VIDEO_PINS)[number], number>,
        b: Object.fromEntries(BUTTONS.map((p) => [p, netOf(p)])) as Record<Button, number>,
      };
    };
    const read = (): RbVideo => {
      const s = stage.sim!, v = pins!.v;
      return { white: s.get(v.white), amber: s.get(v.amber), cyan: s.get(v.cyan), hsync: s.get(v.hsync), vsync: s.get(v.vsync) };
    };
    stage.edgeHooks.add({
      before: () => {
        if (!stage.sim) return;
        if (!pins) look();
        const s = stage.sim, b = pins!.b;
        model.step({ up: s.get(b.up), down: s.get(b.down), flip: s.get(b.flip), start: s.get(b.start) });
      },
      after: () => {
        if (!stage.sim || stage.inEdge) return;
        const v = read(), m = model.video();
        crt.scan(v);
        if (!mismatch) for (const p of VIDEO_PINS) if (v[p] !== m[p]) mismatch = `${p} is ${v[p]} at (${model.s.h}, ${model.s.v}), the model says ${m[p]}`;
      },
    });
    stage.historyHooks.add({
      save: () => ({ s: { ...model.s }, c: crt.save(), mismatch }),
      restore: (x) => {
        pause();
        const r = x as { s: RbState; c: ReturnType<Crt['save']>; mismatch: string };
        model.s = { ...r.s };
        crt.restore(r.c);
        mismatch = r.mismatch;
        paint();
      },
    });
    stage.resetHooks.add(() => {
      model = new BitRunnerModel();
      crt.restore(new Crt().save());
      mismatch = '';
      pins = null;
      paint();
    });

    const cv = h('canvas', { class: 'rb-screen', width: RB_W, height: RB_H, tabindex: '0', 'aria-label': 'Bit Runner screen. Arrow keys move, Space flips your colour, Enter starts.' }) as HTMLCanvasElement;
    const ctx = cv.getContext('2d');
    const image = ctx?.createImageData(RB_W, RB_H) ?? null;
    const prompt = h('div', { class: 'rb-prompt' }, 'Press Start');
    const stateLine = h('div', { class: 'rb-state', 'aria-live': 'polite' });
    const beam = h('div', { class: 'rb-beam' });
    const alarm = h('div', { class: 'rb-alarm', role: 'alert', hidden: true });
    const verdict = h('span', { class: 'rb-verdict good' }, 'matches the model');

    // a tap shorter than a frame still counts: the button stays down until a frame has gone by
    const pressedAt: Partial<Record<Button, number>> = {};
    const pending = new Set<Button>();
    const setPin = (b: Button, v: number) => {
      const s = stage.sim;
      if (!s) return;
      s.setInput(b, v);
      s.settle();
    };
    const press = (b: Button) => { pressedAt[b] = crt.frames; pending.delete(b); setPin(b, 1); };
    const release = (b: Button) => {
      if (raf !== null && pressedAt[b] === crt.frames) pending.add(b);
      else setPin(b, 0);
    };
    const onKey = (e: KeyboardEvent) => {
      const b = KEYS[e.code];
      if (!b) return;
      e.preventDefault();
      if (e.type === 'keydown') { if (!e.repeat) press(b); }
      else release(b);
    };
    cv.addEventListener('keydown', onKey);
    cv.addEventListener('keyup', onKey);
    cv.addEventListener('blur', () => { for (const b of BUTTONS) setPin(b, 0); pending.clear(); });

    const button = (b: Button, label: string, cls = '') => {
      const el = h('button', { class: `btn rb-btn ${cls}`, type: 'button' }, label) as HTMLButtonElement;
      el.addEventListener('pointerdown', (e) => { e.preventDefault(); press(b); });
      for (const t of ['pointerup', 'pointerleave', 'pointercancel']) el.addEventListener(t, () => { if (stage.sim?.get(pins?.b[b] ?? netOf(b)) === 1) release(b); });
      // the keyboard's click (Enter or Space on the button): one frame's press
      el.addEventListener('click', (e) => { if (e.detail === 0) { press(b); release(b); } });
      return el;
    };

    const runBtn = h('button', { class: 'btn sm primary', type: 'button' }, 'Run') as HTMLButtonElement;
    const rateSel = h('select', { 'aria-label': 'clock rate' }, ...RB_RATES.map(([r, n]) => h('option', { value: String(r) }, n))) as HTMLSelectElement;
    rateSel.value = String(rate);
    rateSel.addEventListener('change', () => { rate = Number(rateSel.value); last = performance.now(); });

    const paintScreen = () => {
      if (ctx && image) {
        const d = image.data, px = crt.px;
        for (let i = 0; i < px.length; i++) { const c = RGB[px[i]]; d[4 * i] = c[0]; d[4 * i + 1] = c[1]; d[4 * i + 2] = c[2]; d[4 * i + 3] = 255; }
        // the beam itself, when it is slow enough to see
        if (rate > 0 && rate <= RB_CLOCKS && crt.x < RB_W && crt.y < RB_H) { const i = crt.y * RB_W + crt.x; d[4 * i] = 255; d[4 * i + 1] = 60; d[4 * i + 2] = 60; }
        ctx.putImageData(image, 0, 0);
      }
      for (const b of pending) if (pressedAt[b] !== crt.frames) { pending.delete(b); setPin(b, 0); }
    };
    // text lays out the page: a few times a second while running
    const paintText = () => {
      const st = stage.sim;
      if (!st) return;
      const run = stage.value('run') === 1, lost = stage.value('lives');
      prompt.hidden = run;
      prompt.textContent = lost === 3 ? `Game over: ${stage.value('tens')}${stage.value('ones')}. Press Start` : 'Press Start';
      stateLine.textContent = `score ${stage.value('tens')}${stage.value('ones')} · lives ${3 - lost}`;
      beam.textContent = `beam (${model.s.h}, ${model.s.v}) · frame ${crt.frames}${raf !== null && fps ? ` · ${fps.toFixed(0)} frames/s` : ''}`;
      alarm.hidden = !mismatch;
      alarm.textContent = mismatch;
      verdict.textContent = mismatch ? 'differs from the model' : 'matches the model';
      verdict.classList.toggle('good', !mismatch);
      verdict.classList.toggle('bad', !!mismatch);
    };
    const paint = () => { paintScreen(); paintText(); };

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const deadline = now + 12;
      let due = 1e7;
      if (rate) {
        due = Math.floor(((now - last) * rate) / 1000);
        if (due < 1) return;
        // never a backlog: a slow machine plays in slow motion
        last = due > rate / 10 ? now : last + (due * 1000) / rate;
      } else last = now;
      if (stage.sim instanceof DualSim) stage.sim.preferFast = true;
      if (!pins) look();
      const f0 = crt.frames;
      stage.runCycles(due, () => performance.now() > deadline, 0, true);
      // the screen every frame, the boards and the rest of the stage a few times a second: redrawing them costs fifty times the gates
      if (now - shownAt > 200) { shownAt = now; stage.refresh(); paintText(); }
      fpsFrames += crt.frames - f0;
      if (now - fpsAt > 500) { fps = (fpsFrames * 1000) / (now - fpsAt); fpsAt = now; fpsFrames = 0; }
      paintScreen();
    };
    const start = () => {
      if (raf !== null || !stage.sim) return;
      if (stage.sim instanceof DualSim) stage.sim.prepare();
      stage.checkpoint();
      last = fpsAt = performance.now();
      fpsFrames = 0;
      runBtn.textContent = 'Pause';
      raf = requestAnimationFrame(tick);
    };
    function pause(): void {
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
      runBtn.textContent = 'Run';
      stage.refresh();
    }
    runBtn.addEventListener('click', () => (raf !== null ? pause() : start()));
    const stepBy = (n: number) => () => { pause(); stage.checkpoint(); if (!pins) look(); stage.runCycles(n); paint(); };
    const lineBtn = h('button', { class: 'btn sm', type: 'button', title: `${RB_LINE} clocks`, onclick: stepBy(RB_LINE) }, 'Line');
    const frameBtn = h('button', { class: 'btn sm', type: 'button', title: `${RB_CLOCKS} clocks`, onclick: stepBy(RB_CLOCKS) }, 'Frame');

    const el = h('div', { class: 'mem-panel rb-panel', 'data-dock': 'right', 'data-phone': 'flow' },
      h('h4', null, 'Screen ', verdict, h('span', { class: 'fold-hint' })),
      h('div', { class: 'rb-body' },
        h('div', { class: 'rb-crt' }, cv, prompt),
        stateLine,
        h('div', { class: 'rb-pad' }, button('up', '▲ Up'), button('down', '▼ Down'), button('flip', 'Flip bit'), button('start', 'Start', 'primary')),
        h('div', { class: 'rb-keys' }, 'Click the screen for keys: ↑ ↓ move, Space flips, Enter starts'),
        h('div', { class: 'param-row' }, runBtn, rateSel, lineBtn, frameBtn),
        beam, alarm));

    const moved = settings.autoClock && !o.paused && !reducedMotion();
    const boot = requestAnimationFrame(() => { paint(); if (moved) start(); });
    return {
      el,
      update: () => { if (raf === null) paint(); },
      destroy: () => { cancelAnimationFrame(boot); if (raf !== null) cancelAnimationFrame(raf); raf = null; },
    };
  };
}
