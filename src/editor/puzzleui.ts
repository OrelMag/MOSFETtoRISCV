// Program puzzles in the sandbox (src/puzzles): the Puzzles drawer (the list, by group, with stars), the
// dialog that starts one on a CPU (a ready-wired computer, a copy of one of your chips, your campaign core),
// and, while a puzzle chip is open, the strip under the canvas: the brief, the tests (a click plays one on
// the circuit, a cycle at a time, with the player's bar), Check, the score against the reference CPUs as a
// chart, Show answer and Do it for me. The puzzle chip's PUZZLE IN holds the selected test's words whenever
// the circuit powers on, so Run and the CPU drawer show it too.

import '../styles/sbchallenges.css';
import '../styles/sbpuzzles.css';
import { h, icon } from '../ui/dom';
import { REF_BY_ID, type RefCpu } from '../puzzles/computers';
import { dominatedBy, parFor, PuzzleProgress, type PuzzleScore, puzzleStars, refFront, type Stars } from '../puzzles/grade';
import { type Puzzle, PUZZLE_GROUPS, puzzleChipId, puzzleOfChip, PUZZLES, type PuzzleTest } from '../puzzles/puzzles';
import { refPoints, refProgram, type RefPoint } from '../puzzles/refs';
import { PuzzleReplay } from '../puzzles/replay';
import { findPorts, hardwareNands, programRoms, programWords, type PuzzleRun, runPuzzle } from '../puzzles/run';
import { type Candidate, chipLang, startCandidates, startPuzzle, type StartChoice, withProgram } from '../puzzles/start';
import { inputOn } from '../puzzles/puzzles';
import { dockPane, paneShown, showPane, undockPane } from './dock';
import { type Editor, registerEditorPlugin, registerToolbarAction } from './editor';
import { loadedIn, type PuzzleInState } from './puzzleparts';
import type { Sim } from '../sim/sim';

const uis = new WeakMap<Editor, PuzzleUi>();

let store: PuzzleProgress | null = null;
const progress = () => (store ??= new PuzzleProgress(typeof localStorage === 'undefined' ? null : localStorage));

const CPU_LABEL: Record<RefCpu, string> = { cpu4: '4-bit CPU', rv16: 'RV16', rv32: 'RV32I' };
const fmtN = (n: number) => n.toLocaleString('en');
const starText = (s: Stars) => '★'.repeat(s) + '☆'.repeat(3 - s);
const words = (ws: number[]) => (ws.length ? ws.map((v) => (v < 0 ? 'X' : String(v))).join(' ') : '—');

class PuzzleUi {
  private panel = h('section', { class: 'sb-chal sb-pz', 'aria-label': 'Puzzle' });
  private drawer: HTMLElement | null = null;
  private dlg: HTMLElement | null = null;
  private results = new Map<string, { r: PuzzleRun; key: string; score: PuzzleScore | null; stars: Stars | null }>();
  private collapsed = false;
  private confirming = false;
  private checking = false;
  private key = '';
  private version = 0;
  private lastChip = '';
  /** The test loaded on the circuit (selected row). */
  private sel = 0;
  private replay: PuzzleReplay | null = null;
  /** The simulation and power cycle the selected test was last loaded into (autoload). */
  private loadedOn: { sim: Sim | null; resets: number } = { sim: null, resets: -1 };
  private unsub: () => void;
  private unsubSim: () => void;
  private testsCache = new Map<string, PuzzleTest[]>();

  constructor(private ed: Editor) {
    ed.slots.bottom.append(this.panel);
    this.unsub = ed.onChange(() => this.sync());
    this.unsubSim = ed.onSimChange(() => { this.replay?.resync(); this.autoload(); });
    // every repaint: the player's position and the autoload after a Reset
    const paint = () => { this.autoload(); if (this.replay) this.render(true); };
    ed.paintHooks.add(paint);
    this.destroyPaint = () => ed.paintHooks.delete(paint);
    this.sync();
  }

  private destroyPaint: () => void;

  destroy(): void {
    this.closePlayer();
    this.unsub();
    this.unsubSim();
    this.destroyPaint();
    this.panel.remove();
    this.closeList();
    this.dlg?.remove();
    uis.delete(this.ed);
  }

  private get puzzle(): Puzzle | undefined {
    return puzzleOfChip(this.ed.chipId);
  }

  private tests(p: Puzzle): PuzzleTest[] {
    let t = this.testsCache.get(p.id);
    if (!t) this.testsCache.set(p.id, (t = p.tests()));
    return t;
  }

  /** What a result was computed on: the connectivity and the programs (an edit to either makes it stale). */
  private stateKey(): string {
    const ed = this.ed;
    return `${ed.compiled?.connKey ?? ''}|${JSON.stringify(programRoms(ed.doc, ed.ws.chips).map((r) => (r.part.ref as { rom: { src: string } }).rom.src))}`;
  }

  private sync(): void {
    const ed = this.ed;
    if (ed.chipId !== this.lastChip) {
      this.closePlayer();
      this.lastChip = ed.chipId;
      this.confirming = false;
      this.sel = 0;
      this.loadedOn = { sim: null, resets: -1 };
    }
    this.autoload();
    this.render();
    if (this.drawer) this.renderList();
  }

  /**
   * Outside the player: whenever the circuit powers on (a new simulation, Reset), PUZZLE IN gets the
   * selected test's words, so Run plays that test.
   */
  private autoload(): void {
    const p = this.puzzle, es = this.ed.sim, sim = es.sim;
    if (!p || this.replay || !sim) return;
    if (this.loadedOn.sim === sim && this.loadedOn.resets === es.resets) return;
    this.loadedOn = { sim, resets: es.resets };
    const ports = findPorts(es);
    if (Array.isArray(ports)) return;
    const st = sim.leafState(ports.inLi) as PuzzleInState;
    if (st.q.length || st.i || st.e) return; // carried over from before an edit: leave it
    const t = this.tests(p)[this.sel];
    if (t) es.pokeLeaf(ports.inLi, loadedIn(inputOn(p, t, ports.inW), st));
  }

  // ---- the strip ---------------------------------------------------------------------------------

  private render(force = false): void {
    const p = this.puzzle;
    const ed = this.ed;
    const res = p ? this.results.get(ed.chipId) : undefined;
    const stale = !!res && res.key !== this.stateKey();
    const rec = p ? progress().get(p.id) : undefined;
    const key = JSON.stringify([ed.chipId, !!p, this.collapsed, this.confirming, this.checking, this.version, stale, rec, this.sel, !!this.replay]);
    if (key === this.key && !force) return;
    this.key = key;
    this.panel.hidden = !p;
    this.panel.replaceChildren();
    if (!p) return;
    const isa = chipLang(ed.doc, ed.ws.chips);
    const lang = isa?.lang ?? null;
    const cpu = parFor(lang, refPoints(p.id))?.cpu ?? (lang === 'cpu4' ? 'cpu4' : lang === 'rv16' ? 'rv16' : lang === 'asm' ? 'rv32' : null);
    const refSrc = cpu ? refProgram(cpu, p.id) : undefined;
    const topRom = ed.doc.parts.filter((q) => 'rom' in q.ref).length === 1;
    const actions = this.confirming
      ? [h('span', { class: 'sb-chal-ask' }, 'Replace the program in the ROM with the reference?'),
        h('button', { class: 'btn sm primary', onclick: () => this.solve(refSrc!) }, 'Replace'),
        h('button', { class: 'btn sm ghost', onclick: () => { this.confirming = false; this.render(); } }, 'Cancel')]
      : [h('button', { class: 'btn sm primary', 'data-pz': 'check', title: 'Run every test on the circuit\'s gates', disabled: this.checking, onclick: () => this.check() }, icon('check', 14), this.checking ? 'Checking…' : 'Check'),
        h('button', { class: 'btn sm ghost', 'data-pz': 'answer', title: 'The reference solution', onclick: () => this.showAnswer(p, cpu) }, 'Show answer'),
        refSrc && topRom ? h('button', { class: 'btn sm ghost', 'data-pz': 'solve', title: 'Put the reference program in the ROM (one undo step)', onclick: () => { this.confirming = true; this.render(); } }, 'Do it for me') : null,
        h('button', { class: 'btn sm ghost', title: 'Start this puzzle again on another CPU (this chip is replaced; Ctrl+Z brings it back)', onclick: () => this.openStart(p, true) }, 'Start over…'),
        h('button', { class: 'btn ghost icon-only', title: 'All puzzles', 'aria-label': 'All puzzles', onclick: () => this.toggleList() }, icon('menu', 15))];
    const group = PUZZLE_GROUPS.find((g) => g.id === p.group)?.title ?? p.group;
    this.panel.append(h('header', { class: 'sb-chal-head' },
      h('button', { class: `btn ghost icon-only sb-chal-fold${this.collapsed ? '' : ' open'}`, title: this.collapsed ? 'Show the brief' : 'Hide the brief', 'aria-expanded': String(!this.collapsed),
        onclick: () => { this.collapsed = !this.collapsed; this.render(); } }, icon('chevR', 14)),
      h('span', { class: `sb-chal-flag${rec ? ' solved' : ''}` }, icon(rec ? 'check' : 'puzzle', 13), `Puzzle · ${group}`),
      h('h3', null, p.title),
      rec && !rec.shown ? h('span', { class: 'sb-chal-stars', title: `Best: ${rec.stars} of 3 stars` }, starText(rec.stars)) : null,
      isa ? h('span', { class: 'sb-chal-rule', title: 'The language of the program ROM' }, isa.label) : null,
      h('span', { class: 'sb-chal-actions' }, ...actions)));
    if (this.collapsed) {
      if (this.replay) this.panel.append(this.playerEl());
      return;
    }
    const brief = h('p', { class: 'sb-chal-brief' });
    brief.innerHTML = p.brief;
    const ioNote = cpu && this.isRefChip(cpu) ? h('p', { class: 'sb-pz-io' }) : null;
    if (ioNote && cpu) ioNote.innerHTML = REF_BY_ID.get(cpu)!.io;
    const body = h('div', { class: 'sb-chal-body sb-pz-body' },
      h('div', { class: 'sb-pz-left' }, brief, ioNote, this.testsEl(p, res?.r, stale)),
      this.scoreEl(p, res, stale, lang));
    this.panel.append(body);
    if (this.replay) this.panel.append(this.playerEl());
  }

  /** The open chip is a ready-wired computer of this kind (its ROM speaks the language, at the top level). */
  private isRefChip(cpu: RefCpu): boolean {
    const doc = this.ed.doc;
    return doc.parts.some((q) => 'rom' in q.ref && q.ref.rom.lang === REF_BY_ID.get(cpu)!.lang) && doc.parts.some((q) => 'puzzle' in q.ref);
  }

  private testsEl(p: Puzzle, r: PuzzleRun | undefined, stale: boolean): HTMLElement {
    const tests = this.tests(p);
    const rows = tests.map((t, i) => {
      const res = r?.results[i];
      return h('tr', { class: `${i === this.sel ? 'cur' : ''}${res && !res.ok ? ' bad' : ''}`, title: 'Play this test on the circuit', onclick: () => this.openPlayer(p, i) },
        h('td', { class: 'st' }, res ? (res.ok ? '✓' : '✗') : ''),
        h('td', { class: 'n' }, t.name),
        h('td', { class: 'w' }, words(t.input)),
        h('td', { class: 'w' }, words(t.expect)),
        h('td', { class: `w${res && !res.ok ? ' wrong' : ''}` }, res ? words(res.got) : ''),
        h('td', { class: 'c' }, res ? fmtN(res.cycles) : ''));
    });
    const fail = r?.results.find((x) => !x.ok);
    return h('div', { class: `sb-pz-tests${stale ? ' stale' : ''}` },
      r?.problems.length ? h('ul', { class: 'sb-chal-fails' }, r.problems.map((x) => h('li', null, x))) : null,
      h('div', { class: 'sb-tp-table' }, h('table', null,
        h('thead', null, h('tr', null, h('th', { class: 'st' }), h('th', { class: 'n' }, 'test'), h('th', null, 'IN'), h('th', null, 'expected OUT'), h('th', null, 'got'), h('th', null, 'cycles'))),
        h('tbody', null, rows))),
      fail ? h('p', { class: 'sb-tp-note err' }, `${fail.name}: ${fail.why}${fail.badAt ? ` (cycle ${fmtN(fail.badAt)})` : ''}. Click the test to play it.`) : null,
      stale ? h('p', { class: 'sb-tp-note' }, 'Edited since the last Check: check again.') : null);
  }

  private scoreEl(p: Puzzle, res: { r: PuzzleRun; score: PuzzleScore | null; stars: Stars | null } | undefined, stale: boolean, lang: string | null): HTMLElement {
    const refs = refPoints(p.id);
    const par = parFor(lang, refs);
    const s = res?.score ?? null;
    const item = (k: string, v: string, parV?: number, mine?: number) => [
      h('span', { class: 'k' }, k), h('b', { class: 'v' }, v),
      h('small', { class: parV === undefined || mine === undefined ? 'p' : mine <= parV ? 'p par' : 'p over' }, parV === undefined ? '' : `par ${fmtN(parV)}`)];
    const out = h('div', { class: `sb-pz-score${stale ? ' stale' : ''}` });
    if (res?.r.ok && s) {
      out.append(h('div', { class: 'sb-pz-grid' },
        ...item('Cycles (mean)', fmtN(s.cycles), par?.cycles, s.cycles),
        ...item('NANDs (no ROM)', fmtN(s.nands)),
        ...item('Program words', s.words === null ? '—' : fmtN(s.words), par?.words, s.words ?? undefined)));
    } else out.append(h('p', { class: 'sb-pz-hint' }, res ? 'Not yet: every test must pass to be scored.' : 'Check runs every test on the gates and scores cycles, NANDs and the program\'s size.'));
    out.append(chart(refs, res?.r.ok ? s : null));
    if (res?.r.ok && s && res.stars) {
      const beaten = dominatedBy(s, refs);
      out.append(h('p', { class: 'sb-pz-grade' }, h('span', { class: 'sb-chal-stars' }, starText(res.stars)), ' ',
        res.stars === 3 ? 'cycles × NANDs below every reference' : res.stars === 2 ? 'on the front: no reference is both cheaper and faster'
          : `${beaten.map((b) => CPU_LABEL[b.cpu]).join(', ')} ${beaten.length > 1 ? 'match' : 'matches'} or ${beaten.length > 1 ? 'beat' : 'beats'} you on both NANDs and cycles`));
    } else if (refs.length) {
      out.append(h('p', { class: 'sb-pz-hint' }, '★ pass · ★★ no reference both cheaper and faster · ★★★ cycles × NANDs below every reference'));
    }
    return out;
  }

  // ---- Check ----------------------------------------------------------------------------------------

  check(): void {
    const p = this.puzzle;
    const ed = this.ed;
    if (!p || this.checking) return;
    this.closePlayer();
    this.checking = true;
    this.render();
    // let the button show "Checking…" before the (synchronous) run
    setTimeout(() => {
      try {
        const c = ed.compiled;
        const r = runPuzzle(p, c, ed.doc.pins);
        const score: PuzzleScore | null = r.ok ? { cycles: r.cycles, nands: hardwareNands(c.def), words: programWords(ed.doc, ed.ws.chips) } : null;
        const stars = score ? puzzleStars(score, refPoints(p.id)) : null;
        this.results.set(ed.chipId, { r, key: this.stateKey(), score, stars });
        if (score && stars) {
          const { best, first } = progress().record(p.id, score, stars);
          ed.toast(first ? `Solved: ${starText(stars)}` : best ? `New best: ${starText(stars)}` : 'Passes (not better than your best)');
        } else {
          const bad = r.results.findIndex((x) => !x.ok);
          if (bad >= 0) this.sel = bad;
        }
      } finally {
        this.checking = false;
        this.version++;
        this.render();
        if (this.drawer) this.renderList();
      }
    }, 20);
  }

  private solve(src: string): void {
    const p = this.puzzle;
    this.confirming = false;
    const next = withProgram(this.ed.doc, src);
    if (!p || !next) return void this.render();
    this.ed.edit(() => next);
    progress().shown(p.id);
    this.ed.toast('The reference program is in the ROM: Check it, then try to beat it');
  }

  private showAnswer(p: Puzzle, cpu: RefCpu | null): void {
    const src = cpu ? refProgram(cpu, p.id) : undefined;
    const others = (['cpu4', 'rv16', 'rv32'] as RefCpu[]).filter((c) => c !== cpu && refProgram(c, p.id));
    const pre = (t: string) => h('pre', { class: 'sb-pz-code' }, t);
    this.dialog(`Answer: ${p.title}`, [
      h('p', { class: 'sb-dlg-lead' }, 'The idea, in pseudocode:'),
      pre(p.pseudo),
      src ? h('p', { class: 'sb-dlg-lead' }, `The reference program for ${REF_BY_ID.get(cpu!)!.name}:`) : null,
      src ? pre(src) : null,
      others.length ? h('details', null, h('summary', null, `On the other computers (${others.map((c) => CPU_LABEL[c]).join(', ')})`),
        ...others.flatMap((c) => [h('p', { class: 'sb-dlg-lead' }, REF_BY_ID.get(c)!.name), pre(refProgram(c, p.id)!)])) : null,
    ]);
  }

  // ---- the player ----------------------------------------------------------------------------------

  private openPlayer(p: Puzzle, k: number): void {
    this.sel = k;
    if (!this.replay) this.replay = new PuzzleReplay(this.ed.sim, p, this.tests(p));
    this.replay.load(k);
    this.version++;
    this.render(true);
  }

  private closePlayer(): void {
    const r = this.replay;
    if (!r) return;
    this.replay = null;
    r.end();
    // the circuit is back as it was: no autoload over it
    this.loadedOn = { sim: this.ed.sim.sim, resets: this.ed.sim.resets };
  }

  private playerEl(): HTMLElement {
    const rp = this.replay!;
    const v = rp.read();
    const t = rp.test!;
    const res = this.results.get(this.ed.chipId)?.r.results[rp.k];
    const end = Math.max(v.cycle, res?.cycles ?? 0, 1);
    const btn = (ic: string, title: string, run: () => void) => h('button', { class: 'btn ghost icon-only', title, 'aria-label': title, onclick: () => { run(); this.render(true); } }, icon(ic, 15));
    const scrub = h('input', { type: 'range', min: '0', max: String(end), value: String(v.cycle), 'aria-label': 'Cycle' }) as HTMLInputElement;
    scrub.addEventListener('input', () => { rp.goto(Number(scrub.value)); this.render(true); });
    const marks = h('div', { class: 'sb-tp-marks' },
      res?.badAt ? h('i', { style: `left:${(100 * Math.min(res.badAt, end)) / end}%`, title: `cycle ${res.badAt}: ${res.why}` }) : null);
    const verdict = v.verdict;
    return h('div', { class: 'sb-chal-tests sb-pz-player' },
      h('div', { class: 'sb-tp-bar' },
        h('span', { class: 'sb-tp-name' }, icon('play', 12), `Test: ${t.name}`),
        h('span', { class: 'sb-tp-nav' },
          btn('reset', 'Back to power-on (cycle 0)', () => rp.goto(0)),
          btn('stepBack', 'One cycle back', () => rp.step(-1)),
          btn('step', 'One cycle forward', () => rp.step(1)),
          btn('play', 'Run to the halt', () => rp.toEnd()),
          res?.badAt ? h('button', { class: 'btn sm ghost', title: 'Go to the cycle the first wrong word showed', onclick: () => { rp.goto(res.badAt! - 1); this.render(true); } }, 'To the mistake') : null),
        h('span', { class: 'sb-tp-pos' }, 'cycle ', h('b', null, fmtN(v.cycle)), ` · IN ${v.taken}/${t.input.length} taken · OUT `, h('b', null, words(v.got))),
        verdict ? h('b', { class: verdict.ok ? 'ok' : 'bad' }, verdict.ok ? '✓ passes' : `✗ ${verdict.why}`) : v.halted ? null : null,
        h('span', { class: 'sb-tp-tools' }, h('button', { class: 'btn sm ghost', title: 'Stop playing: the circuit goes back to how it was', onclick: () => { this.closePlayer(); this.version++; this.render(true); } }, icon('close', 13), 'Done'))),
      v.problems.length ? h('p', { class: 'sb-tp-note err' }, v.problems.join(' · ')) : h('div', { class: 'sb-tp-scrub' }, scrub, marks),
      h('p', { class: 'sb-tp-note' }, `expected OUT ${words(t.expect)}`));
  }

  // ---- the list drawer and the start dialog -------------------------------------------------------

  toggleList(): void {
    if (this.drawer && !paneShown(this.ed, 'puzzles')) return showPane(this.ed, 'puzzles');
    if (this.drawer) return this.closeList();
    this.drawer = h('aside', { class: 'sb-drawer sb-chal-list', 'aria-label': 'Program puzzles' });
    this.drawer.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.closeList();
    });
    dockPane(this.ed, { id: 'puzzles', label: 'Puzzles', icon: 'puzzle', el: this.drawer, width: 380 });
    this.renderList();
  }

  private closeList(): void {
    if (this.drawer) undockPane(this.ed, 'puzzles');
    this.drawer = null;
  }

  private renderList(): void {
    const d = this.drawer;
    if (!d) return;
    const ws = this.ed.ws;
    const pg = progress();
    const done = PUZZLES.filter((p) => pg.solved(p.id)).length;
    const body = h('div', { class: 'sb-chal-list-body' },
      h('p', { class: 'sb-chal-intro' }, 'Optional. Write a program for a CPU (one of the sandbox\'s, or one you built) that turns each test\'s input words into the expected output words. Check runs it on the gates and scores cycles, NANDs and the program\'s size against the reference CPUs.'));
    for (const g of PUZZLE_GROUPS) {
      const ps = PUZZLES.filter((p) => p.group === g.id);
      body.append(h('h4', null, h('span', null, g.title), h('small', { class: 'n' }, `${ps.filter((p) => pg.solved(p.id)).length}/${ps.length}`)));
      for (const p of ps) {
        const rec = pg.get(p.id);
        const started = !!ws.chips[puzzleChipId(p)];
        const cur = this.ed.chipId === puzzleChipId(p);
        body.append(h('button', {
          class: `sb-chal-item${rec ? ' solved' : ''}${cur ? ' cur' : ''}`, 'data-puzzle': p.id,
          title: started ? 'Open it' : 'Start: pick the CPU to solve it on', onclick: () => this.open(p),
        },
        h('span', { class: 'tick', 'aria-label': rec ? 'solved' : started ? 'started' : 'not started' }, rec ? icon('check', 13) : h('i', { class: started ? 'started' : '' })),
        h('span', { class: 'name' }, p.title, h('small', { class: 'sb-pz-short' }, p.short)),
        rec ? h('span', { class: 'sb-chal-stars', title: rec.shown ? 'Answer shown' : `Best: ${rec.stars} of 3 stars` }, rec.shown ? '·' : starText(rec.stars)) : null,
        h('span', { class: 'go' }, cur ? 'open' : started ? 'Open' : 'Start')));
      }
    }
    d.replaceChildren(
      h('div', { class: 'sb-drawer-head' }, icon('puzzle', 15), h('h3', null, 'Program puzzles'), h('span', { class: 'sb-chal-count' }, `${done}/${PUZZLES.length} solved`),
        h('button', { class: 'btn ghost icon-only', title: 'Close', 'aria-label': 'Close the puzzles', onclick: () => this.closeList() }, icon('close', 15))),
      body);
  }

  private open(p: Puzzle): void {
    const id = puzzleChipId(p);
    if (this.ed.ws.chips[id]) {
      this.ed.openChip(id);
      this.closeList();
    } else this.openStart(p, false);
  }

  private openStart(p: Puzzle, replace: boolean): void {
    const ed = this.ed;
    const cands = startCandidates(ed.ws, (id) => ed.lib.defOf(id));
    let pick: Candidate = cands[0];
    const opt = (c: Candidate) => {
      const el = h('label', { class: `sb-pz-opt${c === pick ? ' on' : ''}` },
        h('input', { type: 'radio', name: 'sb-pz-cpu', checked: c === pick }),
        h('span', null, h('b', null, c.name), h('span', { class: 'sb-pz-tag' }, c.tag), h('span', { class: 'sb-pz-tag isa' }, c.langLabel), h('small', null, c.detail)));
      el.querySelector('input')!.addEventListener('change', () => {
        pick = c;
        list.querySelectorAll('.sb-pz-opt').forEach((o) => o.classList.toggle('on', o === el));
      });
      return el;
    };
    const list = h('div', { class: 'sb-pz-opts', role: 'radiogroup', 'aria-label': 'The CPU' }, cands.map(opt));
    const d = this.dialog(`Start “${p.title}”`, [
      h('p', { class: 'sb-dlg-lead' }, 'Which CPU solves it? The puzzle gets a chip of its own, ', h('code', null, puzzleChipId(p)),
        ': a ready-wired computer, or a copy of your chip with PUZZLE IN, PUZZLE OUT (and a halt part) placed beside it for you to wire.',
        replace ? h('b', null, ' The puzzle chip you have now is replaced (Ctrl+Z brings it back).') : null),
      list,
    ], [
      h('button', { class: 'btn ghost sm', onclick: () => d.close() }, 'Cancel'),
      h('button', { class: 'btn primary sm', onclick: () => { d.close(); this.start(p, pick.choice); } }, replace ? 'Start over' : 'Start'),
    ]);
  }

  private start(p: Puzzle, choice: StartChoice): void {
    const ed = this.ed;
    let err: string | null = null;
    ed.editWs((ws) => {
      const r = startPuzzle(ws, p, choice, (id) => ed.lib.defOf(id));
      if ('error' in r) { err = r.error; return ws; }
      return r.ws;
    });
    if (err) return void ed.toast(`Cannot start: ${err}`, 'err');
    this.results.delete(puzzleChipId(p));
    this.closeList();
    ed.toast(choice.kind === 'chip' ? 'Wire PUZZLE IN, PUZZLE OUT and the halt part to your CPU, write the program, then Check' : 'Write the program (CPU drawer ▸ Edit… or the ROM\'s properties), then Check');
    ed.fitView();
  }

  private dialog(title: string, body: (Node | string | null)[], foot: HTMLElement[] = []): { close: () => void } {
    this.dlg?.remove();
    const close = () => { ov.remove(); if (this.dlg === ov) this.dlg = null; this.ed.view.svg.focus({ preventScroll: true }); };
    const ov = h('div', { class: 'sb-help sb-dlg sb-pz-dlg', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, onclick: (e: Event) => { if (e.target === ov) close(); } },
      h('div', { class: 'panel' },
        h('div', { class: 'sb-help-head' }, h('h3', null, title), h('button', { class: 'btn ghost icon-only', 'aria-label': 'Close', onclick: close }, icon('close', 16))),
        h('div', { class: 'sb-dlg-body' }, body),
        h('div', { class: 'sb-dlg-foot' }, foot.length ? foot : h('button', { class: 'btn primary sm', onclick: close }, 'OK'))));
    ov.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') close();
    });
    this.ed.el.append(ov);
    this.dlg = ov;
    (ov.querySelector('.sb-dlg-foot .primary') as HTMLButtonElement | null)?.focus();
    return { close };
  }
}

// ---- the chart: cycles against NANDs (log), the references, their front, your point -----------------

const SVGNS = 'http://www.w3.org/2000/svg';
function sv(tag: string, attrs: Record<string, string | number>, text?: string): SVGElement {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
}

function chart(refs: RefPoint[], you: PuzzleScore | null): SVGElement {
  const W = 290, H = 156, L = 36, R = 10, T = 14, B = 32;
  const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, class: 'sb-pz-chart', role: 'img', 'aria-label': 'Cycles against NANDs' });
  const pts = [...refs.map((r) => ({ n: r.nands, c: r.cycles })), ...(you ? [{ n: you.nands, c: you.cycles }] : [])];
  if (!pts.length) return svg;
  const lx = (n: number) => Math.log10(Math.max(1, n));
  let x0 = Math.min(...pts.map((p) => lx(p.n))), x1 = Math.max(...pts.map((p) => lx(p.n)));
  let y1 = Math.max(...pts.map((p) => p.c));
  if (x1 - x0 < 0.5) { x0 -= 0.25; x1 += 0.25; }
  x0 -= 0.1; x1 += 0.1; y1 *= 1.15;
  const X = (n: number) => L + ((lx(n) - x0) / (x1 - x0)) * (W - L - R);
  const Y = (c: number) => T + (1 - c / y1) * (H - T - B);
  svg.append(sv('line', { x1: L, y1: H - B, x2: W - R, y2: H - B, class: 'ax' }), sv('line', { x1: L, y1: T, x2: L, y2: H - B, class: 'ax' }),
    sv('text', { x: (L + W - R) / 2, y: H - 3, 'text-anchor': 'middle', class: 'lbl' }, 'NANDs (log) →'),
    sv('text', { x: 10, y: (T + H - B) / 2, 'text-anchor': 'middle', class: 'lbl', transform: `rotate(-90 10 ${(T + H - B) / 2})` }, 'cycles'));
  for (const d of [1e3, 1e4, 1e5]) {
    if (lx(d) < x0 || lx(d) > x1) continue;
    svg.append(sv('line', { x1: X(d), y1: H - B, x2: X(d), y2: H - B + 3, class: 'ax' }), sv('text', { x: X(d), y: H - B + 12, 'text-anchor': 'middle', class: 'tick' }, d >= 1e3 ? `${d / 1e3}k` : String(d)));
  }
  const front = refFront(refs);
  if (front.length > 1) svg.append(sv('polyline', { points: front.map((r) => `${X(r.nands)},${Y(r.cycles)}`).join(' '), class: 'front' }));
  // labels above their points, below when the one to the left would run into them
  let lastX = -Infinity, lastBelow = true;
  [...refs].sort((a, b) => a.nands - b.nands).forEach((r) => {
    const below = X(r.nands) - lastX < 90 && !lastBelow;
    lastX = X(r.nands);
    lastBelow = below;
    const g = sv('g', { class: `ref ${r.cpu}` });
    g.append(sv('circle', { cx: X(r.nands), cy: Y(r.cycles), r: 4.5 }), sv('title', {}, `${REF_BY_ID.get(r.cpu)!.name}: ${fmtN(r.nands)} NANDs, ${fmtN(r.cycles)} cycles, ${r.words} words`));
    const right = X(r.nands) < W - 80;
    g.append(sv('text', { x: X(r.nands) + (right ? 7 : -7), y: Y(r.cycles) + (below ? 13 : -6), 'text-anchor': right ? 'start' : 'end', class: 'name' }, CPU_LABEL[r.cpu]));
    svg.append(g);
  });
  if (you) {
    const g = sv('g', { class: 'you' });
    g.append(sv('circle', { cx: X(you.nands), cy: Y(you.cycles), r: 5.5 }), sv('text', { x: X(you.nands) + 8, y: Y(you.cycles) + 13, class: 'name' }, 'you'),
      sv('title', {}, `You: ${fmtN(you.nands)} NANDs, ${fmtN(you.cycles)} cycles`));
    svg.append(g);
  }
  return svg;
}

registerEditorPlugin((ed) => {
  if (ed.level) return;
  const ui = new PuzzleUi(ed);
  uis.set(ed, ui);
  return () => ui.destroy();
});

registerToolbarAction({
  id: 'puzzles', title: 'Program puzzles: write programs for a CPU, run on its gates and scored', icon: 'puzzle', label: 'Puzzles', order: 65,
  run: (ed) => uis.get(ed)?.toggleList(),
});
