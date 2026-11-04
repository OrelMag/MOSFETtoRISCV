// The naval Enigma M4 in 3D (loaded on demand, modelhost.ts). Its wheels, pawls, lamps, plugs and current are the cipher's
// state (crypto/enigma.ts); the machine opens up as an operator would open it. Press a key on the drawn keyboard or, with
// the machine focused, on your own.

import '../styles/enigma3d.css';
import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { chr, DEFAULT_SETTINGS, Enigma, GREEK, idx, KEY_ROWS, plugMap, REFLECTORS, ROTORS, socketOf, U264, type EnigmaSettings, type GreekName, type Moved, type ReflectorName, type RotorName, type Trace } from '../crypto/enigma';
import type { OrbitView } from '../gl/camera';
import { frameLoop } from './mosfet';
import { modelStage } from './modelstage';
import { enigmaAnchors, enigmaParts, type EnigmaPalette, type EnigmaPose } from './enigma3dparts';

type Openness = Pick<EnigmaPose, 'lid' | 'cover' | 'flap' | 'lamps' | 'out'>;
interface View { id: string; label: string; pose: Openness; camera: OrbitView; ghost?: boolean }

const VIEWS: View[] = [
  { id: 'shut', label: 'Case shut', pose: { lid: 0, cover: 0, flap: 0, lamps: 0, out: 0 }, camera: { target: [0, 70, 0], yaw: 0.6, pitch: 0.46, dist: 1050 } },
  { id: 'use', label: 'In use', pose: { lid: 1, cover: 0, flap: 0, lamps: 0, out: 0 }, camera: { target: [0, 150, -40], yaw: 0.3, pitch: 0.66, dist: 1250 } },
  { id: 'plugs', label: 'Plugboard', pose: { lid: 1, cover: 0, flap: 1, lamps: 0, out: 0 }, camera: { target: [0, 40, 130], yaw: 0.4, pitch: 0.55, dist: 620 } },
  { id: 'wheels', label: 'Wheels', pose: { lid: 1, cover: 1, flap: 0, lamps: 0, out: 0 }, camera: { target: [-20, 80, -70], yaw: 0.1, pitch: 1.12, dist: 500 } },
  { id: 'lamps', label: 'Bulbs', pose: { lid: 1, cover: 1, flap: 0, lamps: 1, out: 0 }, camera: { target: [50, 80, -20], yaw: 0.4, pitch: 0.85, dist: 760 } },
  { id: 'out', label: 'Stack out', pose: { lid: 1, cover: 1, flap: 0, lamps: 0, out: 1 }, camera: { target: [-15, 180, -84], yaw: 0.3, pitch: 0.3, dist: 680 } },
  { id: 'path', label: 'The current', pose: { lid: 1, cover: 1, flap: 1, lamps: 0, out: 0 }, camera: { target: [-20, 60, -55], yaw: 0.08, pitch: 1.38, dist: 480 }, ghost: true },
];

const STROKE_MS = 170, HOLD_MS = 330, OPEN_RATE = 1.6;

const groups = (s: string) => s.replace(/(.{4})(?=.)/g, '$1 ');

export interface EnigmaViewOptions {
  /** The machine's key to start from. */
  settings?: EnigmaSettings;
  /** A view by its id: shut, use, plugs, wheels, lamps, out, path. */
  view?: string;
  /** A camera other than the view's own. */
  camera?: OrbitView;
}

export function enigmaView(opts: EnigmaViewOptions = {}): Widget {
  let settings: EnigmaSettings = opts.settings ?? { ...DEFAULT_SETTINGS, plugs: 'AQ BJ DL EX FP GU HZ IK MV NY' };
  let machine = new Enigma(settings);
  let shown: number[] = [...machine.pos]; // what the wheels draw while turning
  let view = VIEWS.find((v) => v.id === opts.view) ?? VIEWS[1], open: Openness = { ...view.pose }, stroke = 0, strokeDir = 0, hold = 0;
  let key: string | null = null, lit: string | null = null, trace: Trace | null = null;
  let typed = '', lamps = '', feed = '', fed = 0;
  let autoplay = 0;

  const panel = h('div', { class: 'panel en' });
  const stage = modelStage(panel, {
    aria: 'The German navy’s four-wheel Enigma M4 in 3D: wooden case, keyboard, lamps, plugboard and rotor stack',
    camera: opts.camera ?? view.camera,
    limits: { minDist: 90, maxDist: 2600 },
    note: 'Proportions measured from photographs. The wires below the deck and the stepping link are schematic; the current’s contacts on the wheels are computed (out in orange, back in blue).',
    draw: () => paint(),
  });

  const palette = (): EnigmaPalette => ({
    wood: stage.rgb('--en-wood'), woodDark: stage.rgb('--en-wood-dark'), black: stage.rgb('--en-black'), panel: stage.rgb('--en-panel'), zinc: stage.rgb('--en-zinc'),
    steel: stage.rgb('--en-steel'), brass: stage.rgb('--en-brass'), bakelite: stage.rgb('--en-bakelite'), ivory: stage.rgb('--en-ivory'), red: stage.rgb('--en-red'),
    paper: stage.rgb('--en-paper'), glass: stage.rgb('--en-glass'), lampOn: stage.rgb('--en-lamp'), lampLetter: stage.rgb('--en-letter'), forward: stage.rgb('--en-forward'),
    back: stage.rgb('--en-back'), cable: stage.rgb('--en-cable'), cotton: stage.rgb('--en-cotton'),
  });
  const pose = (): EnigmaPose => ({
    settings, pos: shown, ...open, ghost: !!view.ghost, key, lit, stroke, moves: machine.nextMoves(), trace: view.ghost ? trace : null, lite: stage.isFlat(),
  });
  function paint(): void { const p = pose(); stage.paint(enigmaParts(p, palette()), enigmaAnchors(p)); }

  // ------------------------------------------------------------ the readout
  const chip = h('span', { class: 'r3-chip' }), kv = h('div', { class: 'r3-kv' }), pathRow = h('div', { class: 'en-path' }), tape = h('p', { class: 'en-tape' });
  stage.chips.append(chip);
  function readout(): void {
    const w = machine.windows(), m: Moved = machine.nextMoves();
    chip.textContent = lit ? `${key} lights ${lit}` : `Windows ${w}`;
    chip.className = `r3-chip ${lit ? 'good' : ''}`;
    const will = m[0] ? 'left, middle and right' : m[1] ? 'middle and right' : 'right only';
    const rows: [string, string][] = [
      ['Windows', w],
      ['Rings', settings.rings],
      ['Wheels', `${settings.greek === 'beta' ? 'β' : 'γ'} ${settings.rotors.join(' ')}`],
      ['Reflector', `thin ${settings.reflector}`],
      ['Next press moves', will],
      ['Plugs, as a key sheet gave them', settings.plugs ? settings.plugs.split(/\s+/).map((p) => `${socketOf(p[0])}/${socketOf(p[1])}`).join(' ') : 'none'],
    ];
    kv.replaceChildren(...rows.flatMap(([k, v]) => [h('span', null, k), h('span', { class: 'v' }, v)]));
    if (trace) {
      const stages = [trace.input, chr(trace.entry)].map((c) => h('span', { class: 'f' }, c)).concat(trace.out.map((c) => h('span', { class: 'f' }, chr(c))), [h('span', null, 'UKW')], [h('span', { class: 'b' }, chr(trace.back))], trace.ret.map((c) => h('span', { class: 'b' }, chr(c))), [h('span', { class: 'b' }, trace.output)]);
      pathRow.replaceChildren(h('span', null, 'Contacts:'), ...stages);
    } else pathRow.replaceChildren(h('span', null, 'Press a key to see the current’s contacts, wheel by wheel.'));
    tape.replaceChildren(h('span', null, 'In: '), h('b', null, groups(typed.slice(-48)) || '–'), h('br'), h('span', null, 'Lamp: '), h('b', null, groups(lamps.slice(-48)) || '–'));
    keys.forEach((b, ch) => b.classList.toggle('on', ch === key));
    next.hidden = !feed || fed >= feed.length;
    next.textContent = `Next letter (${fed}/${feed.length})`;
    play.hidden = !feed || fed >= feed.length;
    play.textContent = autoplay ? 'Stop' : 'Type it all';
  }

  // ------------------------------------------------------------ pressing a key
  const moving = () => strokeDir !== 0 || openDelta() > 1e-3 || shown.some((v, i) => v !== machine.pos[i]) || hold > 0 || autoplay > 0;
  const target = () => view.pose;
  const openDelta = () => { const t = target(); return (Object.keys(t) as (keyof Openness)[]).reduce((n, k) => Math.max(n, Math.abs(t[k] - open[k])), 0); };

  function press(ch: string): void {
    if (key) release();
    machine.step();
    trace = machine.trace(ch);
    key = ch; lit = trace.output;
    typed += ch; lamps += trace.output;
    if (reducedMotion()) { stroke = 1; strokeDir = 0; shown = [...machine.pos]; hold = HOLD_MS; }
    else { strokeDir = 1; hold = 0; }
    readout(); paint(); loop.kick();
  }
  function release(): void { key = null; lit = null; if (reducedMotion()) { stroke = 0; strokeDir = 0; } else strokeDir = -1; hold = 0; readout(); paint(); loop.kick(); }

  const loop = frameLoop((_now, dt) => {
    const ms = dt * 1000;
    if (strokeDir > 0) {
      stroke = Math.min(1, stroke + ms / STROKE_MS);
      if (stroke >= 1) { strokeDir = 0; hold = HOLD_MS; }
    } else if (strokeDir < 0) {
      stroke = Math.max(0, stroke - ms / STROKE_MS);
      if (stroke <= 0) strokeDir = 0;
    } else if (hold > 0 && !heldByKey) {
      hold -= ms;
      if (hold <= 0) { hold = 0; if (autoplay) { key = null; lit = null; strokeDir = -1; } else release(); }
    }
    // The wheels turn with the stroke.
    shown = shown.map((v, i) => {
      const goal = machine.pos[i];
      if (v === goal) return v;
      const d = ((goal - v) % 26 + 26) % 26, st = Math.min(d, ms / STROKE_MS);
      return d - st < 1e-3 ? goal : v + st;
    });
    // Openings move a part at a time, like hands doing it.
    const t = target();
    (Object.keys(t) as (keyof Openness)[]).forEach((k) => {
      const d = t[k] - open[k], m = dt * OPEN_RATE;
      open[k] = Math.abs(d) <= m ? t[k] : open[k] + Math.sign(d) * m;
    });
    if (autoplay > 0 && strokeDir === 0 && hold === 0 && !key) {
      autoplay -= ms;
      if (autoplay <= 0) { if (fed < feed.length) feedNext(); else autoplay = 0; if (fed >= feed.length && !key) autoplay = 0; else autoplay = 90; }
    }
    readout(); paint();
  }, moving);

  let heldByKey = false;
  function feedNext(): void { if (fed < feed.length) press(feed[fed++]); }

  // ------------------------------------------------------------ the drawn keyboard
  const keys = new Map<string, HTMLButtonElement>();
  const keyRows = KEY_ROWS.map((row) => h('div', null, ...[...row].map((ch) => {
    const b = h('button', { type: 'button', class: 'en-key', 'aria-label': `Key ${ch}` }, ch) as HTMLButtonElement;
    keys.set(ch, b);
    b.addEventListener('pointerdown', (ev) => { ev.preventDefault(); heldByKey = true; press(ch); });
    b.addEventListener('pointerup', () => { heldByKey = false; if (key) hold = Math.max(hold, 120); loop.kick(); });
    b.addEventListener('pointerleave', () => { if (heldByKey) { heldByKey = false; loop.kick(); } });
    b.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.stopPropagation(); press(ch); } });
    return b;
  })));
  const keypad = h('div', { class: 'en-keys' }, ...keyRows);

  panel.addEventListener('keydown', (ev) => {
    const e = ev as KeyboardEvent, t = e.target as HTMLElement;
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (t.closest('input, select, textarea')) return;
    const ch = e.key.toUpperCase();
    if (ch.length !== 1 || ch < 'A' || ch > 'Z') return;
    e.preventDefault(); e.stopPropagation();
    heldByKey = true; press(ch);
  });
  panel.addEventListener('keyup', () => { if (heldByKey) { heldByKey = false; loop.kick(); } });

  // ------------------------------------------------------------ views
  const viewBtns = VIEWS.map((v) => {
    const b = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': v === view ? 'true' : 'false' }, v.label) as HTMLButtonElement;
    b.addEventListener('click', () => {
      view = v;
      viewBtns.forEach((o, i) => o.setAttribute('aria-pressed', VIEWS[i] === v ? 'true' : 'false'));
      if (reducedMotion()) open = { ...v.pose };
      stage.setView(v.camera);
      paint(); loop.kick();
    });
    return b;
  });

  stage.resetBtn.addEventListener('click', () => stage.setView(view.camera));

  // ------------------------------------------------------------ settings
  const pick = <T extends string>(label: string, opts: readonly T[], val: T, on: (v: T) => void) => {
    const sel = h('select', { 'aria-label': label }, ...opts.map((o) => h('option', { value: o }, o))) as HTMLSelectElement;
    sel.value = val;
    sel.addEventListener('change', () => on(sel.value as T));
    return sel;
  };
  const ALL = Object.keys(ROTORS) as RotorName[];
  const sets: Record<'reflector' | 'greek' | 'w0' | 'w1' | 'w2', HTMLSelectElement> = {
    reflector: pick('Reflector', Object.keys(REFLECTORS) as ReflectorName[], settings.reflector, () => apply()),
    greek: pick('Greek wheel', Object.keys(GREEK) as GreekName[], settings.greek, () => apply()),
    w0: pick('Left wheel', ALL, settings.rotors[0], () => apply()),
    w1: pick('Middle wheel', ALL, settings.rotors[1], () => apply()),
    w2: pick('Right wheel', ALL, settings.rotors[2], () => apply()),
  };
  const ringIn = h('input', { type: 'text', maxlength: 4, 'aria-label': 'Ring settings, Greek wheel first', value: settings.rings }) as HTMLInputElement;
  const startIn = h('input', { type: 'text', maxlength: 4, 'aria-label': 'Window letters, Greek wheel first', value: settings.start }) as HTMLInputElement;
  const plugIn = h('input', { type: 'text', 'aria-label': 'Plug pairs', value: settings.plugs }) as HTMLInputElement;
  const err = h('p', { class: 'en-err' });
  for (const i of [ringIn, startIn, plugIn]) i.addEventListener('change', () => apply());

  function restart(s: EnigmaSettings, keepFeed = false): void {
    settings = s; machine = new Enigma(s); shown = [...machine.pos]; trace = null; key = null; lit = null; typed = ''; lamps = ''; stroke = 0; strokeDir = 0; hold = 0;
    if (!keepFeed) { feed = ''; fed = 0; autoplay = 0; }
    sets.reflector.value = s.reflector; sets.greek.value = s.greek; sets.w0.value = s.rotors[0]; sets.w1.value = s.rotors[1]; sets.w2.value = s.rotors[2];
    ringIn.value = s.rings; startIn.value = s.start; plugIn.value = s.plugs;
    readout(); paint();
  }
  function apply(): void {
    const s: EnigmaSettings = {
      reflector: sets.reflector.value as ReflectorName, greek: sets.greek.value as GreekName,
      rotors: [sets.w0.value as RotorName, sets.w1.value as RotorName, sets.w2.value as RotorName],
      rings: ringIn.value.toUpperCase(), start: startIn.value.toUpperCase(), plugs: plugIn.value.toUpperCase().trim(),
    };
    err.textContent = '';
    if (new Set(s.rotors).size !== 3) { err.textContent = 'A wheel can only be fitted once.'; return; }
    if (!/^[A-Z]{4}$/.test(s.rings) || !/^[A-Z]{4}$/.test(s.start)) { err.textContent = 'Rings and windows are four letters each, Greek wheel first.'; return; }
    try { plugMap(s.plugs); } catch (e) { err.textContent = (e as Error).message; return; }
    restart(s);
  }

  const u264 = h('button', { type: 'button', class: 'btn sm' }, 'Set up U-264’s message') as HTMLButtonElement;
  u264.addEventListener('click', () => { feed = U264.cipher; fed = 0; autoplay = 0; restart(U264.settings, true); });
  const next = h('button', { type: 'button', class: 'btn sm', hidden: true }, 'Next letter') as HTMLButtonElement;
  next.addEventListener('click', feedNext);
  const play = h('button', { type: 'button', class: 'btn sm', hidden: true }, 'Type it all') as HTMLButtonElement;
  play.addEventListener('click', () => { autoplay = autoplay ? 0 : 1; readout(); loop.kick(); });
  const reset = h('button', { type: 'button', class: 'btn sm' }, 'Back to the start') as HTMLButtonElement;
  reset.addEventListener('click', () => restart(settings));
  const nudge = h('button', { type: 'button', class: 'btn sm' }, 'Show a double step') as HTMLButtonElement;
  nudge.addEventListener('click', () => {
    // The middle wheel one short of its turnover, the right wheel two: the third press moves all three.
    const mid = chr(idx(ROTORS[settings.rotors[1]].turnover[0]) - 1), right = chr(idx(ROTORS[settings.rotors[2]].turnover[0]) - 1);
    restart({ ...settings, start: `${settings.start[0]}${settings.start[1]}${mid}${right}` });
  });

  panel.append(
    h('h3', { class: 'm3-title' }, 'The naval Enigma M4'),
    h('p', { class: 'm3-sub' }, 'Case lid back, plug flap closed, as an operator had it. The wheels, pawls, plugs and lamps are the cipher itself: the U-boat traffic of 1942, Hartwig Looks’s message among it, deciphers on this machine letter for letter. Type on the keys below, or on your own keyboard once the machine has focus.'),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' },
        h('div', { class: 'en-views' }, ...viewBtns, stage.resetBtn),
        stage.el, stage.hint, keypad, pathRow, tape),
      h('div', { class: 'r3-side' },
        h('h4', null, 'This machine ', h('span', { class: 'r3-badge' }, 'model')), kv,
        h('h4', null, 'The day’s key'),
        h('div', { class: 'en-set' },
          h('span', null, 'Reflector'), sets.reflector,
          h('span', null, 'Greek wheel'), sets.greek,
          h('span', null, 'Wheels'), h('div', { class: 'en-wheels' }, sets.w0, sets.w1, sets.w2),
          h('span', null, 'Rings'), ringIn,
          h('span', null, 'Windows'), startIn,
          h('span', null, 'Plugs'), plugIn),
        err,
        h('div', { class: 'r3-btns' }, u264, next, play),
        h('div', { class: 'r3-btns', style: 'margin-top:6px' }, reset, nudge))));
  readout();
  paint();
  return { el: panel, destroy() { loop.stop(); stage.destroy(); } };
}
