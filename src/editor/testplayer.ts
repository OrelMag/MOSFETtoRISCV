// The test player under a challenge's result (Turing Complete style): Check's cases played one at
// a time on the open chip, so the canvas, its pins and the I/O bar show the case live. Step, scrub,
// play at a chosen rate (stopping at a failing case), jump between the failures Check found, and
// edit the circuit while paused: the case plays again on the rebuilt circuit and the live row says
// whether it now passes. The document is never written (except by "Keep these inputs"); closing
// gives the simulation back as it was. Anything else driving the simulation (Run, Step, a clock
// click, Reset) ends the replay.

import { h, icon } from '../ui/dom';
import { type BuildChallenge, type CheckResult, fmtBits, fmtNum, MAX_FAILED } from './challenges';
import type { Editor } from './editor';
import type { EditorSim } from './runtime';
import { type CaseView, TestReplay, type TestSet } from './testrun';

/** Cases per second; 0: one per frame. */
const RATES = [1, 2, 5, 10, 30, 0];
let rate = 5;
/** Rows of the case table around the current one. */
const WINDOW = 5;
/** Most failure marks drawn on the scrubber (the rest share their pixel). */
const MARKS = 240;

export class TestPlayer {
  readonly el = h('div', { class: 'sb-chal-tests', 'data-chal': 'player', role: 'group', 'aria-label': 'Test player' });
  private readonly rp: TestReplay;
  private readonly failed: number[];
  private readonly bad: Set<number>;
  private readonly es: EditorSim;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private raf = 0;
  private note = '';
  /** Our own replay is driving the simulation (its change notices are not someone else's). */
  private busy = false;
  /** What the simulation looked like after our own last move (anything else: someone else drove it). */
  private mine = { resets: 0, cycles: 0, sim: null as unknown };
  /** The circuit was edited since Check: the ✓ / ✗ marks are Check's, the live row is now. */
  stale = false;

  constructor(private readonly ed: Editor, readonly ch: BuildChallenge, readonly set: TestSet, r: CheckResult, private readonly onClose: () => void) {
    this.es = ed.sim;
    this.rp = new TestReplay(ed.sim, set, ch.check);
    this.failed = r.failed ?? [];
    this.bad = new Set(this.failed);
  }

  get k(): number {
    return this.rp.k;
  }

  /** Play case k and show it. */
  goto(k: number): void {
    this.busy = true;
    try {
      this.rp.goto(k);
    } finally {
      this.busy = false;
    }
    this.mark();
    this.render();
  }

  /** Stop, give the simulation back, and leave. */
  close(): void {
    this.pause();
    this.busy = true;
    try {
      if (this.rp.active) this.rp.end();
    } finally {
      this.busy = false;
    }
    this.el.remove();
  }

  /** The editor's simulation changed: an edit (rebuilt), someone else driving it, or just values. */
  simChanged(): void {
    const es = this.es;
    if (!this.rp.active || this.busy) return;
    if (es.running || es.cycles !== this.mine.cycles || es.resets !== this.mine.resets) return this.onClose();
    if (es.sim !== this.mine.sim) {
      this.stale = true;
      this.busy = true;
      try {
        this.rp.resync();
      } finally {
        this.busy = false;
      }
      this.mark();
    }
    this.render();
  }

  private mark(): void {
    this.mine = { resets: this.es.resets, cycles: this.es.cycles, sim: this.es.sim };
  }

  // ---- playing ------------------------------------------------------------------------------

  private get playing(): boolean {
    return this.timer !== null || this.raf !== 0;
  }

  private play(): void {
    if (this.playing) return;
    if (this.rp.k >= this.set.n - 1) this.goto(0);
    this.note = '';
    const tick = () => {
      this.timer = null;
      this.raf = 0;
      if (!this.rp.active) return;
      this.goto(this.rp.k + 1);
      const v = this.rp.read();
      const what = this.set.kind === 'sequence' ? 'step' : 'test';
      if (!v.ok) return this.stop(`Stopped: ${what} ${v.k + 1} fails. Play again to go on.`);
      if (v.k >= this.set.n - 1) return this.stop(`All ${this.set.n} ${what}s played.`);
      this.schedule(tick);
    };
    this.schedule(tick);
    this.render();
  }

  private schedule(f: () => void): void {
    if (rate === 0 && typeof requestAnimationFrame === 'function') this.raf = requestAnimationFrame(f);
    else this.timer = setTimeout(f, 1000 / (rate || 60));
  }

  private stop(note: string): void {
    this.pause();
    this.note = note;
    this.render();
  }

  private pause(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.timer = null;
    this.raf = 0;
  }

  private jump(k: number): void {
    this.pause();
    this.note = '';
    this.goto(k);
  }

  private nextFail(dir: 1 | -1): number | undefined {
    const k = this.rp.k;
    return dir > 0 ? this.failed.find((f) => f > k) : [...this.failed].reverse().find((f) => f < k);
  }

  /** Table cases: the current inputs into the document (the circuit then keeps them). */
  private keep(): void {
    const c = this.rp.read().case;
    const pins = Object.entries(c.inputs).map(([name, v]) => [this.ed.doc.pins.find((p) => p.name === name && p.dir === 'in'), v] as const);
    this.onClose();
    for (const [p, v] of pins) if (p) this.ed.setPinValue(p.id, v);
  }

  // ---- drawing ------------------------------------------------------------------------------

  // Built once: rebuilding them on every case would drop a drag on the scrubber or an open menu.
  private readonly nav = h('span', { class: 'sb-tp-nav' });
  private readonly range = h('input', { type: 'range', min: '0', 'aria-label': 'Test', title: 'Scrub through the tests' }) as HTMLInputElement;
  private readonly marks = h('div', { class: 'sb-tp-marks', 'aria-hidden': 'true' });
  private readonly body = h('div', { class: 'sb-tp-body' });
  private built = false;

  private build(): void {
    this.built = true;
    const set = this.set;
    const btn = (ic: string, title: string, on: () => void, tp: string) =>
      h('button', { class: 'btn ghost icon-only sm', title, 'aria-label': title, onclick: on, 'data-tp': tp }, icon(ic, 14));
    const speed = h('select', { class: 'sb-tp-rate', title: 'Tests per second while playing', 'aria-label': 'Tests per second',
      onchange: (e: Event) => { rate = Number((e.target as HTMLSelectElement).value); if (this.playing) { this.pause(); this.play(); } } },
    RATES.map((r) => h('option', { value: String(r), selected: r === rate }, r ? `${r}/s` : 'max')));
    this.range.max = String(set.n - 1);
    this.range.addEventListener('input', () => this.jump(Number(this.range.value)));
    const n = set.n;
    const seen = new Set<number>();
    for (const f of this.failed) {
      const at = n > 1 ? Math.round((f / (n - 1)) * MARKS) : 0;
      if (seen.has(at)) continue;
      seen.add(at);
      this.marks.append(h('i', { style: `left: ${(at / MARKS) * 100}%` }));
    }
    this.el.append(
      h('div', { class: 'sb-tp-bar' },
        h('span', { class: 'sb-tp-name' }, icon('table', 14), 'Tests'), this.nav,
        h('span', { class: 'sb-tp-tools' }, speed,
          set.kind === 'table' ? h('button', { class: 'btn ghost sm', title: 'Close the player with this test\'s inputs set on your pins', onclick: () => this.keep() }, 'Keep these inputs') : null,
          btn('close', 'Close the player: your circuit gets its own inputs back', () => this.onClose(), 'close'))),
      h('div', { class: 'sb-tp-scrub' }, this.marks, this.range),
      this.body);
  }

  render(): void {
    if (!this.rp.active) return;
    if (!this.built) this.build();
    const set = this.set;
    const v = this.rp.read();
    const btn = (ic: string, title: string, on: () => void, dis: boolean, tp: string) =>
      h('button', { class: 'btn ghost icon-only sm', title, 'aria-label': title, disabled: dis, onclick: on, 'data-tp': tp }, icon(ic, 14));
    const prevF = this.nextFail(-1), nextF = this.nextFail(1);
    const status = v.ok ? h('b', { class: 'ok' }, icon('check', 13), 'passes') : h('b', { class: 'bad' }, icon('close', 13), v.error ? 'cannot play' : 'fails');
    this.nav.replaceChildren(
      btn('stepBack', 'First test', () => this.jump(0), v.k === 0, 'first'),
      btn('chevL', 'Previous test', () => this.jump(v.k - 1), v.k === 0, 'prev'),
      this.playing
        ? btn('pause', 'Pause', () => { this.pause(); this.render(); }, false, 'pause')
        : btn('play', 'Play the tests on the circuit (stops at a failing one)', () => this.play(), false, 'play'),
      btn('chevR', 'Next test', () => this.jump(v.k + 1), v.k >= set.n - 1, 'next'),
      h('span', { class: 'sb-tp-pos' }, `${set.kind === 'sequence' ? 'Step' : 'Test'} `, h('b', null, (v.k + 1).toLocaleString()), ` / ${set.n.toLocaleString()}`),
      status,
      this.failed.length
        ? h('span', { class: 'sb-tp-fails' },
          h('button', { class: 'btn ghost sm', title: 'The previous failing test', disabled: prevF === undefined, onclick: () => prevF !== undefined && this.jump(prevF) }, icon('chevL', 12), 'failure'),
          h('button', { class: 'btn ghost sm', 'data-tp': 'nextfail', title: 'The next failing test', disabled: nextF === undefined, onclick: () => nextF !== undefined && this.jump(nextF) }, 'failure', icon('chevR', 12)),
          h('small', null, `${this.failed.length.toLocaleString()}${this.failed.length >= MAX_FAILED ? '+' : ''} failing`))
        : '');
    this.range.value = String(v.k);
    this.marks.classList.toggle('stale', this.stale);
    this.body.replaceChildren(this.table(v), this.noteEl(v) ?? '');
  }

  private table(v: CaseView): HTMLElement {
    const set = this.set;
    const n = set.n;
    const from = Math.max(0, Math.min(n - WINDOW, v.k - (WINDOW >> 1)));
    const rows: HTMLElement[] = [];
    for (let k = from; k < Math.min(n, from + WINDOW); k++) {
      const cur = k === v.k;
      const c = cur ? v.case : set.at(k);
      const fails = cur ? !v.ok : this.bad.has(k);
      const cells = [
        h('td', { class: 'n' }, String(k + 1)),
        ...set.inputs.map((p) => h('td', null, fmtNum(c.inputs[p.name], p.width))),
        set.kind === 'sequence' ? h('td', { class: 'clk', title: c.tick ? 'a clock cycle after the inputs' : 'no clock cycle: the clock stays at this level' }, c.tick ? '↑' : String(c.inputs[set.clock!] ?? 0)) : null,
        ...set.outputs.map((p, i) => {
          const want = c.expect[p.name];
          if (!cur) return h('td', { class: want === undefined ? 'dc' : '' }, want === undefined ? '–' : fmtNum(want, p.width));
          const o = v.outs[i];
          const got = o.got ? fmtBits(o.got) : '?';
          if (want === undefined) return h('td', { class: 'dc', title: 'not checked in this step' }, got);
          return o.ok ? h('td', { class: 'good', title: 'what your circuit shows: as expected' }, got)
            : h('td', { class: 'wrong', title: `your circuit shows ${got}, the test expects ${fmtNum(want, p.width)}` }, h('s', null, got), ' ', fmtNum(want, p.width));
        }),
        h('td', { class: 'st' }, fails ? icon('close', 12) : icon('check', 12)),
      ];
      rows.push(h('tr', { class: `${cur ? 'cur' : ''}${fails ? ' bad' : ''}`, onclick: cur ? null : () => this.jump(k) }, ...cells));
    }
    const head = h('tr', null, h('th', { class: 'n' }, '#'), ...set.inputs.map((p) => h('th', { class: 'in' }, p.name)),
      set.kind === 'sequence' ? h('th', { class: 'clk' }, set.clock ?? 'clk') : null,
      ...set.outputs.map((p) => h('th', { class: 'out' }, p.name)), h('th', { class: 'st' }, ''));
    return h('div', { class: 'sb-tp-table' }, h('table', null, h('thead', null, head), h('tbody', null, ...rows)));
  }

  private noteEl(v: CaseView): HTMLElement | null {
    const text = v.error ? `This test cannot be played: ${v.error}.`
      : this.note || (this.stale ? 'Edited since Check: the current row is your circuit now; the other marks are from the last Check.' : '');
    return text ? h('p', { class: `sb-tp-note${v.error ? ' err' : ''}` }, text) : null;
  }
}
