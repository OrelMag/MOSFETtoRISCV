// Chapter noise's gate-level scene: the SerDes link (lib/serdes.ts) and the panel beside it. The panel keeps a strip of the last cycles of
// the line, the sender's words against what the receiver decoded, and the clock-recovery loop's own numbers; it runs the link
// on the stage's simulation (the gate simulator: every flip-flop shares one clock, so the cycle engine could run it too, but a
// Step then shows each gate delay).

import { CYCLES_PER_BIT, FILTER_LIMIT, GATE_BIT_NS, GATE_MBPS, LINK_PATTERNS, lockRange, NOMINAL_INC, patternDensity, theoryRange } from '../comm/serdes';
import { nameOf } from '../comm/linecode';
import { SERDES_LINK } from '../lib/serdes';
import { h } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { slider } from './mosparts';
import { wavePanel } from './serial';
import { frameRun } from './slowctl';
import '../styles/serial.css';

export interface SerdesStatus {
  /** The receiver's recent words match the sender's (after a comma aligned it). */
  locked: boolean;
  /** A K code has been decoded without an error flag. */
  sawK: boolean;
  /** It was locked and has since decoded wrong words. */
  lost: boolean;
  words: number;
  wrong: number;
  /** The sender's rate offset set on the slider, in percent. */
  offset: number;
  /** The decoder has flagged a word since the link last locked. */
  sawErr: boolean;
}
export interface SerdesApi {
  status(): SerdesStatus;
  setPattern(i: number): void;
  setOffset(pct: number): void;
  run(cycles: number): void;
  flip(): void;
}
/** What a challenge (check, solve) can ask of the link panel. */
export const serdesApi = new WeakMap<Stage, SerdesApi>();

const STRIP = 64, CW = 4.5, WINDOW = 24;
type Word = [number, number, number];

export function serdesScene(view: 'link' | 'cdr'): Scene {
  return {
    root: SERDES_LINK,
    inputs: { inc: NOMINAL_INC, manual: 0, din: 0, kin: 0, flip: 0 },
    clock: 'clk', autoClock: false, hiddenInputs: ['inc', 'manual', 'din', 'kin', 'flip'],
    panels: [serdesPanel(view)],
  };
}

export function serdesPanel(view: 'link' | 'cdr'): ScenePanel {
  return (stage: Stage): Widget => {
    let tx: number[] = [], rx: number[] = [], st: number[] = [], ea: number[] = [], la: number[] = [];
    let sent: [number, number][] = [], got: Word[] = [];
    let cycles = 0, delayed = 0, advanced = 0, votesE = 0, votesL = 0, pat = 0, pct = 0;
    let sawK = false, sawErr = false, everLocked = false, lost = false, preStrobe = 0, preEarly = 0, preLate = 0, stopRun: (() => void) | null = null, limitText = '', raf = 0;

    const incOf = (p: number) => Math.round(NOMINAL_INC * (1 + p / 100));
    const clear = () => {
      tx = []; rx = []; st = []; ea = []; la = []; sent = []; got = [];
      cycles = delayed = advanced = votesE = votesL = 0; sawK = sawErr = everLocked = lost = false;
    };
    const verdict = (): SerdesStatus => {
      const recent = got.slice(-WINDOW);
      if (got.length < 12) return { locked: false, sawK, lost, words: got.length, wrong: 0, offset: pct, sawErr };
      let best = Infinity;
      for (let off = -7; off <= 3; off++) {
        let e = 0;
        recent.forEach((g, k) => {
          const i = got.length - recent.length + k, sv = sent[i + off];
          if (!sv || g[2] || g[0] !== sv[0] || g[1] !== sv[1]) e++;
        });
        best = Math.min(best, e);
      }
      return { locked: best <= 1, sawK, lost, words: got.length, wrong: best, offset: pct, sawErr };
    };

    const setPattern = (i: number) => {
      pat = i;
      const p = LINK_PATTERNS[i];
      stage.setInputs({ manual: p.din === null ? 0 : 1, din: p.din ?? 0, kin: p.kin });
      sent = []; got = [];
    };
    const setOffset = (p: number) => { pct = p; stage.setInput('inc', incOf(p)); };

    const hook = {
      before: () => {
        preStrobe = stage.value('strobe'); preEarly = stage.value('early'); preLate = stage.value('late');
        if (stage.value('wload') === 1) sent.push([stage.value('sbyte'), stage.value('sk')]);
      },
      after: () => {
        cycles++;
        const push = (a: number[], v: number) => { a.push(v); if (a.length > STRIP) a.shift(); };
        push(tx, stage.value('txd')); push(rx, stage.value('rxd')); push(st, stage.value('strobe')); push(ea, preStrobe && preEarly ? 1 : 0); push(la, preStrobe && preLate ? 1 : 0);
        if (preStrobe) {
          const c = stage.value('phase');
          if (c === 4) delayed++; else if (c === 2) advanced++;
          if (preEarly) votesE++;
          if (preLate) votesL++;
        }
        if (stage.value('wv') === 1) {
          const w: Word = [stage.value('rbyte'), stage.value('rk'), stage.value('err')];
          got.push(w);
          if (w[1] && !w[2]) sawK = true;
          if (w[2] && everLocked) sawErr = true;
          if (got.length > 1500) { got.splice(0, 500); sent.splice(0, 500); }
        }
        const v = verdict();
        if (v.locked) everLocked = true; else if (everLocked && v.wrong > 3) lost = true;
        if (everLocked && v.locked) lost = false;
        schedule();
      },
    };
    stage.edgeHooks.add(hook);
    stage.resetHooks.add(() => { stopRun?.(); clear(); setPattern(pat); schedule(); });
    const snap = () => ({ tx: [...tx], rx: [...rx], st: [...st], ea: [...ea], la: [...la], sent: sent.map((x) => [...x]), got: got.map((x) => [...x]), cycles, delayed, advanced, votesE, votesL, pat, pct, sawK, sawErr, everLocked, lost });
    stage.historyHooks.add({
      save: snap,
      restore: (v) => {
        const x = v as ReturnType<typeof snap>;
        ({ tx, rx, st, ea, la } = { tx: [...x.tx], rx: [...x.rx], st: [...x.st], ea: [...x.ea], la: [...x.la] });
        sent = x.sent.map((y) => [...y] as [number, number]); got = x.got.map((y) => [...y] as Word);
        ({ cycles, delayed, advanced, votesE, votesL, pat, pct, sawK, sawErr, everLocked, lost } = x);
        schedule();
      },
    });

    const btn = (label: string, title: string, f: () => void, cls = 'btn sm') => { const b = h('button', { class: cls, title, type: 'button' }, label); b.addEventListener('click', f); return b; };
    const runBtn = btn('Run', 'Run the clock as fast as the page can draw', () => (stopRun ? stopRun() : start()), 'btn sm primary');
    runBtn.setAttribute('aria-pressed', 'false');
    const start = () => {
      stage.checkpoint();
      runBtn.textContent = 'Pause'; runBtn.setAttribute('aria-pressed', 'true');
      stopRun = frameRun(stage, () => false, () => { stopRun = null; runBtn.textContent = 'Run'; runBtn.setAttribute('aria-pressed', 'false'); schedule(); });
    };
    const act = (f: () => void) => { stopRun?.(); stage.checkpoint(); f(); stage.refresh(); schedule(); };
    const patSel = h('select', { class: 'mc-sel', 'aria-label': 'Bytes sent between the commas' }, ...LINK_PATTERNS.map((p, i) => h('option', { value: String(i) }, p.name))) as HTMLSelectElement;
    patSel.addEventListener('change', () => act(() => setPattern(Number(patSel.value))));
    const off = slider('Sender rate', -8, 8, 0.5, 0, (v) => `${v > 0 ? '+' : ''}${v} %`, (v) => act(() => setOffset(v)));
    const waves = h('div'), words = h('div'), loop = h('div', { class: 'mc-status' }), lock = h('div', { class: 'sr-lock' }), limit = h('p', { class: 'sub' });
    const nm = (w: Word) => (w[2] ? '??' : nameOf(w[0], !!w[1]));
    const update = () => {
      const pad = (a: number[]) => [...Array(Math.max(0, STRIP - a.length)).fill(0), ...a];
      const rows = [
        { label: 'tx', vals: pad(tx), cw: CW, cls: 'tx' }, { label: 'line', vals: pad(rx), cw: CW, cls: 'rx' }, { label: 'strobe', vals: pad(st), cw: CW, cls: 'strobe' },
        ...(view === 'cdr' ? [{ label: 'early', vals: pad(ea), cw: CW, cls: 'early' }, { label: 'late', vals: pad(la), cw: CW, cls: 'late' }] : []),
      ];
      waves.replaceChildren(wavePanel(58 + STRIP * CW + 6, rows, Array.from({ length: Math.floor(STRIP / CYCLES_PER_BIT) + 1 }, (_, i) => ({ x: i * CYCLES_PER_BIT * CW })), `The last ${STRIP} cycles of the line`));
      const v = verdict();
      const last = <T,>(xs: T[], n: number) => xs.slice(-n);
      words.replaceChildren(
        h('div', { class: 'cpu-sec' }, 'Sent (words taken by the serializer)'), h('div', { class: 'sr-words' }, ...last(sent, 8).map((x) => h('span', { class: x[1] ? 'k' : '' }, nameOf(x[0], !!x[1])))),
        h('div', { class: 'cpu-sec' }, 'Decoded by the receiver'), h('div', { class: 'sr-words' }, ...last(got, 8).map((w) => h('span', { class: `${w[2] ? 'bad' : ''}${w[1] && !w[2] ? ' k' : ''}` }, nm(w)))));
      const inc = incOf(pct);
      loop.replaceChildren(
        h('span', null, 'cycles ', h('b', null, String(cycles))), h('span', null, 'sender ', h('b', null, `${(4096 / inc).toFixed(3)} cycles a bit`)),
        h('span', null, 'strobe moved ', h('b', null, `${delayed} late, ${advanced} early`)), ...(view === 'cdr' ? [h('span', null, 'votes ', h('b', null, `${votesE} early · ${votesL} late`))] : []));
      lock.className = `sr-lock ${v.locked ? 'ok' : v.lost || (got.length >= 12 && !v.locked) ? 'bad' : ''}`;
      lock.textContent = v.locked ? `Locked: the last ${Math.min(WINDOW, got.length)} words match what was sent (${v.wrong} wrong).`
        : got.length < 12 ? 'Searching: the receiver waits for a comma to find the word boundary and a few words to compare.' : `Not locked: ${v.wrong} of the last ${WINDOW} words are wrong.`;
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; update(); }); };
    const limitBtn = btn('Find this pattern\'s limit', 'Run the golden model over offsets until a word goes wrong', () => {
      const p = LINK_PATTERNS[pat], rho = patternDensity(p.bytes), range = lockRange(p.bytes) / NOMINAL_INC;
      limitText = `${p.name}: ${(rho * 100).toFixed(0)} % of bit periods have an edge, so at most ${(theoryRange(rho) * 100).toFixed(1)} % (= ${(rho * 100).toFixed(0)} % ÷ (4 samples × ${FILTER_LIMIT} votes)); measured ±${(range * 100).toFixed(1)} %.`;
      limit.textContent = limitText;
    });
    const el = h('div', { class: 'mem-panel cpu-panel mc-panel sr-panel', 'data-dock': 'right', 'data-phone': 'flow' },
      h('h4', null, view === 'cdr' ? 'Clock recovery' : 'SerDes link', h('span', { class: 'fold-hint' })),
      h('div', { class: 'mc-row' }, patSel),
      h('div', { class: 'mc-row' }, off.el),
      h('div', { class: 'dram-ops' }, btn('Cycle', 'One clock cycle', () => act(() => stage.runCycles(1))), btn('Word', 'Forty cycles: one word', () => act(() => stage.runCycles(40))), runBtn,
        btn('Flip a line bit', 'Corrupt the next bit on the line', () => act(() => { stage.setInput('flip', 1); stage.runCycles(1); stage.setInput('flip', 0); }), 'btn sm'),
        ...(view === 'cdr' ? [limitBtn] : [])),
      waves, words, loop, lock, view === 'cdr' ? limit : null,
      h('p', { class: 'sub' }, `${CYCLES_PER_BIT} cycles a bit at ${(GATE_BIT_NS / CYCLES_PER_BIT).toFixed(2)} ns a cycle is ${GATE_MBPS.toFixed(0)} Mb/s: the gate-level link's speed. The rates of the later steps are the channel model's.`));
    update();
    serdesApi.set(stage, {
      status: verdict,
      setPattern: (i) => { patSel.value = String(i); act(() => setPattern(i)); },
      setOffset: (p) => { off.set(p); act(() => setOffset(p)); },
      run: (n) => act(() => { stage.runCycles(n); }),
      flip: () => act(() => { stage.setInput('flip', 1); stage.runCycles(1); stage.setInput('flip', 0); }),
    });
    return { el, update, destroy: () => { stopRun?.(); stage.edgeHooks.delete(hook); serdesApi.delete(stage); if (raf) cancelAnimationFrame(raf); } };
  };
}
