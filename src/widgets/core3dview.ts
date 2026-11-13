// A 4 x 4 plane of ferrite cores in 3D on the studio renderer (loaded on demand, modelhost.ts), in true geometry
// (core3dkit.ts). What the cores do is core3dparts.ts's rule, nothing else: a core sees the sum of its wires' currents and
// flips only at the switching current. A cycle is two phases, each planned whole (planOp) and then played: the currents,
// the flips and the sense pulse on screen are the plan's. The model is rebuilt only when what it shows changes (a wire
// starts or stops carrying current, a core starts or stops switching, a bit changes); the pulses on the wires, the flux
// sweeping round a switching core and the sense pulse travelling to the amplifier move every frame as instances.

import '../styles/core3d.css';
import { h, s } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { frameLoop } from './mosfet';
import { packInstances, type Instance } from '../gl/instances';
import { along, sphere } from '../gl/kit/geo';
import { M } from '../gl/kit/materials';
import type { Vec3 } from '../gl/math';
import { studioStage } from './studiostage';
import { CORE_HOME, CORE_HOME_FRAME, CORE_HOME_R, MATS, RO, coreModel, ringPoint, stackCoreSites, stackGeo, stackSites, wires, type CoreState } from './core3dkit';
import { FULL, HALF, HALF_MAX, HALF_MIN, IC, N, halfSelected, idle, idx, colOf, rowOf, planOp, marginOf, marginWindow, cycleFault, type Op, type Phase } from './core3dparts';

const PHASE_MS = 1100, HOLD_MS = 500;
/** A pattern worth reading: something of both kinds in every row and column. */
const START = [1, 0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1, 0];
const BEAD = sphere(3.2, 8, 5), PULSE = sphere(5, 8, 5), PER_WIRE = 5, PER_CORE = 8;
const WIRES = wires();
const amps = (a: number) => `${a > 0 ? '+' : a < 0 ? '−' : ''}${Math.abs(a).toFixed(2)} A`;
const half = (v: number) => (v === 0 ? 'off' : `${v > 0 ? '+' : '−'}½`);

export function coreView(): Widget {
  let halfA = HALF, spread = false, threeWire = false, lastPlan: Phase[] | null = null;
  let bits = [...START], addr = idx(1, 1), plan: Phase[] | null = null, k = 0, u = 1, hold = 0, last: Phase | null = null, lastOp: Op | null = null;

  const panel = h('div', { class: 'panel co3' });
  let stackOn = false, sweep = 0, pulseU = 0, shownKey = '';
  const stage = studioStage({
    aria: 'A plane of sixteen ferrite cores in 3D, threaded by X and Y select wires, a sense wire and an inhibit wire; a lit wire carries current and an arrow on each core shows its magnetisation',
    home: CORE_HOME,
    homeFrame: CORE_HOME_FRAME,
    homeRadius: CORE_HOME_R,
    scaleBar: (len) => (len >= 1000 ? (len / 1000) + ' in' : len + ' mil'),
    onBeat: (i) => { stackOn = i === 4; instances(); },
    limits: { minDist: 120, maxDist: 60000, maxPan: 12000 },
    build: (detail) => coreModel(state(), detail),
    note: `To scale in mils: an 80 mil core the size of Whirlwind’s, 32-gauge wire at its bare size, a 4 × 4 crop of a plane. The wires are tinted to tell them apart (real ones are all one amber). The currents are Whirlwind’s (0.45 A half-select); the 0.65 A switching threshold is the model’s own, the loop drawn perfectly square and the sense pulse as one pulse. A cycle takes about a second here, not microseconds.`,
    noteMore: 'To scale in mils. The core is 80 mil outside, the size of Whirlwind’s second bank (MIT Report R-221, 1954, sec. 5.22); its 50 mil hole and 20 mil height are a later Lincoln Laboratory core’s. The wire is R-221’s 32-gauge magnet wire (sec. 5.24), drawn at its bare 7.95 mil since no source gives it insulated, and tinted to tell the four apart (real Formex is one amber colour). The pitch, 250 mil, is R-221’s 9.5 in frame for 32 cores a side less an assumed border; this is a 4 × 4 crop and its frame, and the 45° tilt of the cores is the model’s choice. The half-select current is Whirlwind’s, 0.45 A on each selected X and Y line (R-221), so a full select is 0.90 A; the switching current, 0.65 A, is the model’s own figure between them (R-221 gives about 0.85 A to switch a core in a set time, not a threshold), and the loop is drawn perfectly square. Real cores switch over a range (the drive-spread switch gives each core its own Ic, up to 20 % off). The diagonal sense wire lets the half-select noise of a core’s neighbours cancel; the cancelling is not modelled and the pulse is drawn as one pulse. The three-wire plane merges sense and inhibit into that wire. A cycle lasts about a second here, not microseconds; the tour’s last beat shows the stack of 17 planes, with the spacing assumed.',
  });
  const beadMat = (tok: '--co-one' | '--co-zero') => M.make({ base: tok, metal: 0, rough: 0.4, emit: tok, glow: 1.2, bloom: 1.4, label: 'the flux reversing (drawn)' });
  const pulseMat = M.make({ base: '--co-live', metal: 0, rough: 0.4, emit: '--co-live', glow: 1.4, bloom: 1.5, label: 'current (drawn as pulses)' });
  const senseMat = M.make({ base: '--co-lamp', metal: 0, rough: 0.4, emit: '--co-lamp', glow: 1.8, bloom: 1.8, label: 'the sense pulse' });
  function ph(): Phase | null { return plan ? plan[k] : null; }
  /** What is drawn now: the cores flip in the middle of the phase (u >= 0.45), the sense pulse with them. */
  function state(): CoreState {
    const p = ph();
    if (!p) return { bits, drive: idle(), flipping: [], addr, sense: false, threeWire };
    const flipNow = u >= 0.45;
    return { bits: flipNow ? p.after : p.before, drive: p.drive, flipping: u >= 0.45 && u < 0.9 ? p.flipped : [], addr, sense: p.strobed && p.pulse && flipNow && u < 0.95, threeWire };
  }
  /** Rebuild only when what the model shows changed; the instances follow every frame. */
  function paint(): void {
    const s = state(), key = JSON.stringify([s.bits, s.drive, s.flipping, s.addr, s.sense, s.threeWire]);
    if (key !== shownKey) { shownKey = key; stage.refresh(); }
    instances();
  }
  function instances(): void {
    const s = state(), pulses: Instance[] = [], sense: Instance[] = [], flux1: Instance[] = [], flux0: Instance[] = [];
    // current: pulses running along each live wire's runs, in the current's direction
    for (const w of WIRES) {
      const dir = w.kind === 'x' ? s.drive.x[w.i] : w.kind === 'y' ? s.drive.y[w.i] : w.kind === 'inh' && !s.threeWire ? s.drive.inh : 0;
      if (!dir) continue;
      for (const [a, b] of w.runs) for (let i = 0; i < PER_WIRE; i++) {
        const f = (pulseU + i / PER_WIRE) % 1, q = dir > 0 ? f : 1 - f;
        pulses.push({ pos: [a[0] + (b[0] - a[0]) * q, a[1] + (b[1] - a[1]) * q, a[2] + (b[2] - a[2]) * q], color: [1, 1, 1] });
      }
    }
    // the flux of a switching core sweeping round in its new direction
    for (const k of s.flipping) {
      const dir = s.bits[k] ? 1 : -1, list = s.bits[k] ? flux1 : flux0;
      for (let i = 0; i < PER_CORE; i++) list.push({ pos: ringPoint(k, dir * sweep + (i / PER_CORE) * 2 * Math.PI, RO + 3), color: [1, 1, 1] });
    }
    // the sense pulse: from the switching core along the sense wire to the amplifier
    if (s.sense) {
      const path = WIRES.find((w) => w.kind === 'sense')!.path;
      for (let i = 0; i < 4; i++) sense.push({ pos: along(path, Math.min(1, (u - 0.45) / 0.5 + i * 0.03)) as Vec3, color: [1, 1, 1] });
    }
    stage.instances('current', PULSE, pulseMat, packInstances(pulses));
    stage.instances('flux 1', BEAD, beadMat('--co-one'), packInstances(flux1));
    stage.instances('flux 0', BEAD, beadMat('--co-zero'), packInstances(flux0));
    stage.instances('sense pulse', PULSE, senseMat, packInstances(sense));
    const S = stackGeo();
    stage.instances('stack cores', S.stackRing, MATS.ferrite, packInstances(stackOn ? stackCoreSites().map((p) => ({ pos: p, color: [1, 1, 1] })) : []), true);
    stage.instances('stack frames', S.stackFrame, MATS.frame, packInstances(stackOn ? stackSites().map((p) => ({ pos: p, color: [1, 1, 1] })) : []), true);
  }

  // ---- readout
  const chip = h('span', { class: 'r3-chip' }), kv = h('div', { class: 'r3-kv' }), live = h('p', { class: 'r3-hint', 'aria-live': 'polite' });
  stage.chips.append(chip);
  const bh = s('svg', { class: 'co-bh', viewBox: '0 0 240 150', role: 'img', 'aria-label': 'The core’s hysteresis loop against the current through it' }) as SVGSVGElement;
  const LX = 1.05, BX = (a: number) => 120 + (a / LX) * 100, BY = (b: number) => 70 - b * 42;
  function drawLoop(p: Phase | null): void {
    const g = s('g'), line = (a: number, b: number, c: number, d: number, cls: string) => s('line', { x1: a, y1: b, x2: c, y2: d, class: cls });
    g.append(line(15, BY(0), 225, BY(0), 'co-ax'), line(BX(0), 14, BX(0), 126, 'co-ax'));
    g.append(s('path', { d: `M${BX(-LX)},${BY(-1)} H${BX(IC)} V${BY(1)} H${BX(LX)} M${BX(LX)},${BY(1)} H${BX(-IC)} V${BY(-1)} H${BX(-LX)}`, class: 'co-loop', fill: 'none' }));
    const hv = p ? p.half : halfA;
    for (const [a, t] of [[-2 * hv, '−full'], [-IC, '−Ic'], [-hv, '−½'], [hv, '+½'], [IC, 'Ic'], [2 * hv, 'full']] as [number, string][]) {
      const cls = Math.abs(a) === IC ? 'co-tick ic' : 'co-tick';
      g.append(line(BX(a), BY(0) - 3, BX(a), BY(0) + 3, cls), s('text', { x: BX(a) + (a === IC ? 4 : a === -IC ? -4 : 0), y: Math.abs(a) === IC ? BY(0) - 7 : BY(0) + 14, class: `co-lbl${Math.abs(a) === IC ? ' ic' : ''}`, 'text-anchor': a === IC ? 'start' : a === -IC ? 'end' : 'middle' }, t));
    }
    g.append(s('text', { x: BX(LX - 0.02), y: BY(1) - 4, class: 'co-lbl', 'text-anchor': 'end' }, '1'), s('text', { x: BX(-LX + 0.02), y: BY(-1) + 11, class: 'co-lbl' }, '0'),
      s('text', { x: 232, y: 144, class: 'co-lbl', 'text-anchor': 'end' }, 'net current through the core'));
    if (p) { // the addressed core, and one half-selected core, where the drive puts them on the loop
      const hs = halfSelected(addr)[0], dot = (kk: number, cls: string) => g.append(s('circle', { cx: BX(p.net[kk]), cy: BY(p.after[kk] ? 1 : -1), r: 4.5, class: cls }));
      dot(hs, 'co-dot half'); dot(addr, 'co-dot sel');
    }
    bh.replaceChildren(g);
  }

  function readout(announce = false): void {
    const p = ph() ?? last;
    const a = `row ${rowOf(addr)}, column ${colOf(addr)}`;
    const rows: [string, string][] = [['Address', `${a}, stores ${bits[addr]}`]];
    if (p) {
      const xs = p.drive.x.flatMap((v, i) => (v ? [`X${i} ${half(v)}`] : [])), ys = p.drive.y.flatMap((v, i) => (v ? [`Y${i} ${half(v)}`] : []));
      rows.push(['Phase', p.title], ['Select wires', `${xs.join(', ')} · ${ys.join(', ')} (½ = ${p.half.toFixed(2)} A)`], ['Inhibit wire', p.drive.inh ? `${half(p.drive.inh)}: against the select currents` : 'off']);
      const hs = halfSelected(addr), mx = Math.max(...hs.map((x) => Math.abs(p.net[x])));
      rows.push(['Addressed core', `${amps(p.net[addr])} vs Ic ${IC.toFixed(2)} A: ${p.flipped.includes(addr) ? `flips to ${p.after[addr]}` : 'stays'}`],
        ['Half-selected', `${hs.length} cores, at most ${mx.toFixed(2)} A: ${p.stray.length ? `${p.stray.length} FLIPPED` : 'none flips'}`],
        ['Sense wire', p.strobed ? (p.pulse ? 'pulse: it held a 1' : 'quiet: it held a 0') : p.pulse ? 'a pulse, but nobody is listening' : 'quiet, not listened to']);
      if (p.missed || p.stray.length) rows.push(['Fault', faultText(p)]);
    } else rows.push(['Phase', 'idle: nothing driven']);
    kv.replaceChildren(...rows.flatMap(([kk, v]) => [h('span', null, kk), h('span', { class: 'v' }, v)]));
    const waiting = !!plan && (reducedMotion() ? u >= 1 : true);
    chip.textContent = !plan ? 'Idle' : `Phase ${k + 1} of 2`;
    chip.className = `r3-chip ${plan ? 'warn' : 'good'}`;
    nextBtn.disabled = !plan || !waiting;
    for (const b of [readBtn, w0Btn, w1Btn, slider, spreadBtn]) b.disabled = !!plan;
    predict.textContent = promptText();
    const cells = grid.querySelectorAll('button');
    cells.forEach((c, i) => { c.textContent = String(bits[i]); c.setAttribute('aria-pressed', String(i === addr)); c.classList.toggle('on', i === addr); c.classList.toggle('one', bits[i] === 1);
      c.setAttribute('aria-label', `Core row ${rowOf(i)} column ${colOf(i)}, stores ${bits[i]}${i === addr ? ', selected' : ''}`); c.disabled = !!plan; });
    rowBtns.forEach((b, i) => { b.setAttribute('aria-pressed', String(i === rowOf(addr))); b.disabled = !!plan; });
    colBtns.forEach((b, i) => { b.setAttribute('aria-pressed', String(i === colOf(addr))); b.disabled = !!plan; });
    drawLoop(p);
    let text = '';
    if (p && (!plan || announce)) text = `${p.title}. ${p.pulse ? (p.strobed ? 'The sense wire pulsed: the core held a 1.' : 'The core flipped.') : p.strobed ? 'No sense pulse: the core held a 0.' : 'No core flipped.'}${p.drive.inh ? ' The inhibit wire cancelled the write.' : ''}`;
    if (!plan && lastOp) text = lastPlan && cycleFault(lastPlan, lastOp) ? `${lastOpText()} ${cycleFault(lastPlan, lastOp)}` : `${lastOpText()} Cores unchanged elsewhere.`;
    if (text && live.textContent !== text) live.textContent = text;
  }
  function faultText(p: Phase): string {
    const parts: string[] = [];
    if (p.missed) parts.push(`the addressed core did not reach its value (${Math.abs(p.net[addr]).toFixed(2)} A against Ic ${IC.toFixed(2)} A)`);
    if (p.stray.length) parts.push(`${p.stray.length} other core${p.stray.length > 1 ? 's' : ''} flipped: their data is lost`);
    return parts.join('; ');
  }
  function lastOpText(): string {
    const a = `row ${rowOf(addr)}, column ${colOf(addr)}`;
    return lastOp === 'read' ? `Read of ${a} done: it held ${last?.senseBit ?? bits[addr]} and has been written back.` : `Wrote ${lastOp === 'write1' ? 1 : 0} at ${a}.`;
  }

  // ---- the cycle
  function begin(op: Op): void {
    if (plan) return;
    lastOp = op; plan = planOp(bits, addr, op, { half: halfA, spread }); lastPlan = plan; k = 0; hold = 0; u = reducedMotion() ? 1 : 0;
    readout(true); loop.kick();
  }
  function finishPhase(): void {
    const p = plan![k];
    bits = [...p.after];
    if (p.senseBit !== null) last = p;
    if (k + 1 < plan!.length) { k++; u = reducedMotion() ? 1 : 0; hold = 0; } else { last = last ?? p; plan = null; u = 1; if (lastOp !== 'read') last = p; }
    readout(true);
  }
  function next(): void { if (!plan) return; if (u < 1) { u = 1; paint(); } finishPhase(); loop.kick(); paint(); }
  const loop = frameLoop((_n, dt) => {
    pulseU = (pulseU + dt * 0.9) % 1; sweep += dt * 9;
    if (plan && !reducedMotion()) {
      if (u < 1) u = Math.min(1, u + (dt * 1000) / PHASE_MS);
      else { hold += dt * 1000; if (hold >= HOLD_MS) finishPhase(); }
    }
    readout(); paint();
  }, () => !!plan && !reducedMotion());

  // ---- controls
  const btn = (label: string, fn: () => void, cls = 'btn sm') => { const b = h('button', { type: 'button', class: cls }, label) as HTMLButtonElement; b.addEventListener('click', fn); return b; };
  const readBtn = btn('Read', () => begin('read')), w0Btn = btn('Write 0', () => begin('write0')), w1Btn = btn('Write 1', () => begin('write1'));
  const nextBtn = btn('Next phase', next);
  const choose = (r: number, c: number) => { if (plan) return; last = null; lastOp = null; live.textContent = ''; addr = idx(r, c); readout(true); paint(); };
  const grid = h('div', { class: 'co-grid', role: 'group', 'aria-label': 'The sixteen cores: choose the address' },
    ...Array.from({ length: N * N }, (_, i) => btn('0', () => choose(rowOf(i), colOf(i)), 'co-cell')));
  const rowBtns = Array.from({ length: N }, (_, i) => btn(String(i), () => choose(i, colOf(addr))));
  const colBtns = Array.from({ length: N }, (_, i) => btn(String(i), () => choose(rowOf(addr), i)));
  const slider = h('input', { type: 'range', min: String(HALF_MIN), max: String(HALF_MAX), step: '0.005', value: String(halfA), 'aria-label': 'Half-select current, amperes' }) as HTMLInputElement;
  const sliderOut = h('output', null, `${halfA.toFixed(2)} A`);
  slider.addEventListener('input', () => { halfA = Number(slider.value); sliderOut.textContent = `${halfA.toFixed(2)} A`; last = null; lastOp = null; lastPlan = null; live.textContent = ''; readout(); paint(); });
  const spreadBtn = btn('Drive spread ±20 %', () => { spread = !spread; spreadBtn.setAttribute('aria-pressed', String(spread)); lastPlan = null; lastOp = null; live.textContent = ''; readout(); });
  spreadBtn.setAttribute('aria-pressed', 'false');
  const wireBtn = btn('3-wire plane', () => { threeWire = !threeWire; wireBtn.setAttribute('aria-pressed', String(threeWire)); paint(); });
  wireBtn.setAttribute('aria-pressed', 'false');
  /** The prediction prompt: asked before the cycle with the numbers needed to answer it; the window only once a cycle has run. */
  const predict = h('p', { class: 'r3-hint co-predict' });
  function promptText(): string {
    if (plan) return '';
    const w = marginWindow(spread), m = marginOf(halfA, spread);
    if (lastPlan) return `Window for this plane: ${w.lo.toFixed(3)} A up to just under ${w.hi.toFixed(2)} A (Ic/2 to Ic${spread ? ', with each core’s own Ic' : ''}). At ${halfA.toFixed(2)} A: ${m === 'ok' ? 'inside it' : m === 'low' ? 'too low, the crossing core cannot reach Ic' : 'too high, a half select reaches Ic'}.`;
    return `Predict, then press Read: with ${halfA.toFixed(2)} A on each select wire, does the addressed core flip, and what happens to the cores along its row and column?`;
  }
  const resetBtn = btn('Reset contents', () => { if (plan) return; bits = [...START]; last = null; lastOp = null; live.textContent = 'Contents reset.'; readout(); paint(); });

  panel.append(
    h('h3', { class: 'm3-title' }, 'A plane of cores'),
    h('p', { class: 'm3-sub' }, `Sixteen ferrite rings, each threaded by four wires: an X and a Y select wire, a sense wire and an inhibit wire. A core flips only when the current through it reaches ${IC.toFixed(2)} A. By default a select wire carries ${HALF.toFixed(2)} A (the slider sets it), half of the ${FULL.toFixed(1)} A that flips a core: the whole row and column of the address feel ${HALF.toFixed(2)} A and hold, and the one core where both wires cross feels ${FULL.toFixed(1)} A and flips. Reading drives the core toward 0: a 1 flips and the sense wire pulses, a 0 does not move. That erased the 1, so the second phase writes back what was read; to write a 0 the inhibit wire carries ${HALF.toFixed(2)} A the other way, cancelling one half select so the crossing core sees only ${HALF.toFixed(2)} A and holds.`),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' }, predict, stage.el, live),
      h('div', { class: 'r3-side' },
        h('div', null, h('h4', null, 'Address ', h('span', { class: 'r3-badge' }, 'pick a core')), grid,
        h('div', { class: 'co-rc' }, h('span', null, 'Row'), h('div', { class: 'co-seg', role: 'group', 'aria-label': 'Row' }, ...rowBtns), h('span', null, 'Column'), h('div', { class: 'co-seg', role: 'group', 'aria-label': 'Column' }, ...colBtns))),
        h('div', null, h('h4', null, 'This cycle ', h('span', { class: 'r3-badge' }, 'model')), kv), h('div', null, h('h4', null, 'The loop'), bh))));
  stage.slot.append(h('div', { class: 'r3-ctl' }, h('div', { class: 'r3-btns' }, readBtn, w0Btn, w1Btn, nextBtn, resetBtn),
    h('label', { class: 'r3-sl co-sl' }, h('span', null, 'Half select'), slider, sliderOut), spreadBtn, wireBtn));
  // Escape is left alone: Enter and Space on the focused Next phase button advance, nothing else does.
  const mq = typeof matchMedia === 'function' ? matchMedia('(max-width: 600px)') : null, onMq = () => paint();
  mq?.addEventListener?.('change', onMq);
  readout(); paint();
  return { el: panel, destroy() { mq?.removeEventListener?.('change', onMq); loop.stop(); stage.destroy(); } };
}
