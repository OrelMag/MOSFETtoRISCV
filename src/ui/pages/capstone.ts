// A tier capstone (#/campaign/play/cap_t<tier>): one design built from a spec sheet, with no walkthrough, hints or
// "Do it for me" until it is passed. The level screen's layout (the spec sheet in the side pane, the editor in level
// mode, the Check strip under the canvas) around campaign/capstone.ts's challenge; a pass is recorded under the
// capstone's id in the campaign progress (which My path reads: learn/capstones.ts). Loaded on demand with the editor.

import { groupDigits } from '../../sim/numfmt';
import '../../styles/editor.css';
import '../../styles/sbchips.css';
import '../../styles/campaign.css';
import '../../styles/level.css';
import '../../styles/capstone.css';
import { partNames } from '../../campaign/cardlabel';
import { briefRefs, briefStars } from '../../campaign/brief';
import { builtCapstones, capstoneById, capstoneChallenge, capstoneChipId, capstoneRank, capstoneRule, referenceNands, referenceScore, type ReferenceScore, solutionsOpen } from '../../campaign/capstone';
import { coreSpecOf } from '../../campaign/corecheck';
import { measured } from '../../campaign/grade';
import { progress } from '../../campaign/progress';
import { installChallenges } from '../../editor/challengeui';
import { type BuildChallenge, type CheckResult, importAnswer, startChallenge } from '../../editor/challenges';
import { Editor } from '../../editor/editor';
import { loadWorkspace, saveWorkspace } from '../../editor/store';
import '../../editor/features';
import type { Capstone } from '../../learn/capstones';
import { resolveComponent } from '../../lib/resolve';
import { h, icon } from '../dom';
import { markJump } from '../returnto';
import { briefResults, GRADE_WORD, starText } from './briefview';
import type { Page } from './chapter';

type Tab = 'spec' | 'tests' | 'rules' | 'others';
/** The design brief (tier 4) has two views: the editor, and the chart of what has been measured. */
type View = 'design' | 'results';

/** The level screen keeps the toolbar to what building and checking needs. */
const ACTIONS = ['undo', 'redo', 'zout', 'zin', 'fit', 'iobar', 'probe', 'timing', 'package', 'inspect', 'cpu', 'memory', 'props', 'help'];

/** What each pin of a capstone is, for the spec sheet's pin table. */
export const PIN_NOTES: Record<string, string> = {
  d: 'the value keyed in', add: 'add d to the accumulator at the next edge', rst: 'clear (for a core: hold the PC at 0)', clk: 'rising edge',
  acc: 'the accumulator', c: 'carry out of the last addition, held',
  instr: 'the bench answers imem[pc] in the same cycle', drdata: 'the bench answers dmem[daddr] in the same cycle',
  pc: 'address of the instruction', daddr: 'data address', dwdata: 'the word to store', dwe: 'a store at the clock edge',
  rwe: 'a register write (the bench watches it)', rwa: 'its register number', rwd: 'the value written to x[rwa]',
};

const rich = (tag: 'p' | 'div' | 'li' | 'span', html: string, cls?: string) => {
  const el = h(tag, cls ? { class: cls } : null);
  el.innerHTML = html;
  return el;
};

/** The phone layout: the spec folds away above the editor. */
const narrow = () => matchMedia('(max-width: 900px)').matches;

/** The Tests tab's rows: each directed program with what it exercises; seeded random ones of a kind in one row. */
function testRows(tests: readonly { name: string; what?: string }[]): [string, string | undefined][] {
  const rows: [string, string | undefined][] = [];
  const groups = new Map<string, { n: number; first: string; last: string; row: number }>();
  for (const t of tests) {
    if (!t.name.startsWith('random')) { rows.push([t.name, t.what]); continue; }
    const kind = t.name.replace(/[.][0-9]+$/, '');
    const g = groups.get(kind);
    if (g) { g.n++; g.last = t.name; } else { groups.set(kind, { n: 1, first: t.name, last: t.name, row: rows.push([t.name, t.what]) - 1 }); }
  }
  for (const g of groups.values()) if (g.n > 1) rows[g.row][0] = `${g.first} … ${g.last} (${g.n})`;
  return rows;
}

export class CapstonePage implements Page {
  readonly kind = 'capstone';
  readonly el: HTMLElement;
  readonly nodeId: string;
  private cap?: Capstone;
  private ch?: BuildChallenge;
  private editor?: Editor;
  private chal?: ReturnType<typeof installChallenges>;
  private bar = h('div', { class: 'lv-bar' });
  private side = h('aside', { class: 'lv-side', 'aria-label': 'The spec sheet' });
  private edWrap = h('div', { class: 'lv-ed' });
  private tab: Tab = 'spec';
  private view: View = 'design';
  private resultsEl: HTMLElement | null = null;
  private folded = narrow();
  private result: HTMLElement | null = null;
  /** The reference's own numbers, computed once on demand (a pass, or the NAND count shown on the sheet). */
  private ref?: ReferenceScore;
  private offs: (() => void)[] = [];

  constructor(id: string) {
    this.nodeId = id;
    const cap = capstoneById(id), ch = cap && capstoneChallenge(id);
    if (!cap || !ch) {
      this.el = h('div', { class: 'lv-page lv-notice' }, h('div', { class: 'panel' }, h('h3', null, cap ? `${cap.title} is not built yet` : `There is no capstone “${id}”`),
        h('p', { class: 'sub' }, cap ? 'Its tier has no checker yet.' : 'The capstones are cap_t1 to cap_t4.'),
        h('p', null, h('a', { class: 'btn', href: '#/campaign' }, icon('chevL', 14), 'Back to the campaign'))));
      return;
    }
    this.cap = cap;
    this.ch = ch;
    const p = progress();
    const chipId = capstoneChipId(id);
    let ws = loadWorkspace();
    if (!ws.chips[chipId]) {
      ws = startChallenge(ws, ch).ws;
      const saved = saveWorkspace(ws);
      if (!saved.ok) {
        this.el = h('div', { class: 'lv-page lv-notice' }, h('div', { class: 'panel' }, h('h3', null, 'The capstone could not start'), h('p', { class: 'sub' }, saved.reason)));
        return;
      }
    }
    p.open(id, true);
    this.editor = new Editor(chipId, { level: { chipId, actions: ACTIONS, hideGroups: ['fets', 'switch'] } });
    if (this.editor.chipId !== chipId) this.editor.openChip(chipId);
    this.chal = installChallenges(this.editor, {
      challenge: ch,
      // Show answer and Do it for me wait for the pass; the answer opens as chips in the full sandbox
      solutions: () => this.passed(),
      showAnswer: () => this.showAnswer(),
      record: (r) => this.record(r),
      checked: () => this.renderBar(),
    });
    this.edWrap.append(this.editor.el);
    this.el = h('div', { class: 'lv-page cap-page' }, this.bar, h('div', { class: 'lv-body' }, this.side, this.edWrap));
    this.offs.push(p.onChange(() => { this.renderBar(); this.chal?.refresh(); }));
    this.renderBar();
    this.renderSide();
    this.renderResults();
    // the reference's NAND count for the sheet: compiling it is cheap, running its check is not (that waits for a pass)
    if (!this.isBrief()) setTimeout(() => this.fillRefNands(), 0);
  }

  destroy(): void {
    this.offs.forEach((f) => f());
    this.chal?.destroy();
    this.editor?.destroy();
  }

  private passed(): boolean {
    return solutionsOpen(this.nodeId, { [this.nodeId]: progress().get(this.nodeId) });
  }

  // ---- the bar ---------------------------------------------------------------------------------------

  private renderBar(): void {
    const cap = this.cap!;
    const others = builtCapstones().filter((c) => c.id !== cap.id);
    this.bar.replaceChildren(...[
      h('a', { class: 'lv-back', href: '#/campaign', title: 'The campaign' }, icon('chevL', 14), 'Campaign'),
      h('span', { class: 'lv-badge cap-tier' }, `TIER ${cap.tier} CAPSTONE`),
      h('span', { class: 'lv-crumb' }, h('b', null, cap.title)),
      this.isBrief() ? this.briefBadge() : this.passed() ? h('span', { class: 'lv-badge good' }, 'PASSED') : null,
      h('span', { class: 'lv-spacer' }),
      ...(this.isBrief() ? this.viewButtons() : []),
      ...others.map((c) => h('a', { class: 'btn sm ghost', href: c.route ?? '#/campaign', title: c.title }, h('span', { class: 'lbl' }, `Tier ${c.tier}`))),
    ].filter((x): x is HTMLElement => !!x));
  }

  // ---- the spec sheet --------------------------------------------------------------------------------

  private renderSide(): void {
    const tabs: [Tab, string][] = this.isBrief() ? [['spec', 'Brief'], ['rules', 'Rules'], ['tests', 'Tests'], ['others', 'Other briefs']] : [['spec', 'Spec'], ['tests', 'Tests']];
    const bar = h('div', { class: 'lv-tabs', role: 'tablist' }, tabs.map(([id, label]) => {
      const on = this.tab === id && !this.folded;
      return h('button', { class: on ? 'on' : '', role: 'tab', 'aria-selected': String(on), 'aria-expanded': narrow() ? String(on) : null,
        onclick: () => { this.folded = narrow() && on; this.tab = id; this.renderSide(); } }, label);
    }));
    const body = h('div', { class: 'lv-sidebody', role: 'tabpanel' });
    if (this.tab === 'spec') { if (this.isBrief()) this.briefTab(body); else this.specTab(body); }
    else if (this.tab === 'rules') this.specTab(body, true);
    else if (this.tab === 'others') this.othersTab(body);
    else this.testsTab(body);
    this.side.replaceChildren(bar, body);
    this.side.classList.toggle('folded', this.folded);
  }

  // ---- the design brief (tier 4) ---------------------------------------------------------------------

  private isBrief(): boolean {
    return this.nodeId === 'cap_t4';
  }

  private subs() {
    return progress().get(this.nodeId)?.subs ?? [];
  }

  private briefBadge(): HTMLElement | null {
    const best = this.subs().reduce((m, q) => Math.max(m, q.stars), 0);
    return best ? h('span', { class: 'lv-badge good', title: 'Your best grade so far' }, starText(best as 1 | 2 | 3)) : null;
  }

  private viewButtons(): HTMLElement[] {
    const btn = (v: View, label: string) => h('button', { class: `btn sm ${this.view === v ? '' : 'ghost'}`, 'aria-pressed': String(this.view === v), onclick: () => this.setView(v) }, label);
    return [btn('design', 'Design'), btn('results', `Results (${this.subs().length})`),
      h('button', { class: 'btn sm primary', title: 'Run the workload on your core and keep the result as a submission', onclick: () => { this.setView('design'); this.chal?.check(); } }, 'Measure')];
  }

  private setView(v: View): void {
    this.view = v;
    this.renderResults();
    this.renderBar();
  }

  /** The results view fills the editor's place (the editor stays alive underneath). */
  private renderResults(): void {
    if (!this.isBrief()) return;
    this.resultsEl?.remove();
    this.resultsEl = null;
    this.edWrap.classList.toggle('bf-hide', this.view === 'results');
    if (this.view !== 'results') return;
    this.resultsEl = briefResults(this.subs());
    this.edWrap.append(this.resultsEl);
  }

  private briefTab(el: HTMLElement): void {
    const refs = briefRefs();
    el.append(
      h('section', null, h('h4', null, 'The problem'), h('p', null, 'Any RV16 core you like (single-cycle, multicycle, pipelined, with fast adders or shared ones) that runs the workload to the golden model’s results. There is no single right answer: every design is a point on a cost / speed chart.')),
      h('section', null, h('h4', null, 'Measured'), h('ul', null,
        rich('li', '<b>Cost</b>: NANDs of the core (the program memory is the bench’s)'),
        rich('li', '<b>Speed</b>: total time = cycles × clock period over the workload'),
        rich('li', '<b>Correctness first</b>: every register write and store against the golden model'))),
      h('section', null, h('h4', null, 'Graded on the front'), h('ul', null,
        h('li', null, h('span', { class: 'bf-st' }, starText(1)), ' ', GRADE_WORD[1]),
        h('li', null, h('span', { class: 'bf-st' }, starText(2)), ' no reference is both at least as cheap and at least as fast as yours'),
        h('li', null, h('span', { class: 'bf-st' }, starText(3)), ' yours is cheaper and faster than one of them'))),
      h('section', null, h('h4', null, 'The references'), h('ul', null, refs.map((r) => rich('li', `<b>${r.name}</b>: ${groupDigits(r.nand)} NANDs, ${groupDigits(r.time)} gate delays (${r.period} × ${groupDigits(r.cycles)})`)))),
      h('p', { class: 'cap-note' }, h('b', null, 'Why a brief: '), 'tier 4 has no fixed checker. A brief fixes the programs and the measure and leaves the design open. A pass (★) marks the tier done on My path; the stars are for exploring.'),
    );
  }

  private othersTab(el: HTMLElement): void {
    el.append(h('section', null, h('h4', null, 'Briefs'),
      h('div', { class: 'bf-brief' }, h('b', null, 'The cheapest core that runs the benchmarks'), h('span', { class: 'lv-badge good' }, 'this one')),
      h('p', { class: 'sub' }, 'This is the only brief for now.')));
  }

  private specTab(el: HTMLElement, rulesOnly = false): void {
    const ch = this.ch!;
    const pinRow = (p: BuildChallenge['ports'][number]) => h('tr', null,
      h('td', null, p.name), h('td', null, p.dir === 'in' ? 'in' : 'out'), h('td', null, String(p.width)), h('td', null, PIN_NOTES[p.name] ?? ''));
    const rule = capstoneRule(this.nodeId);
    const names = partNames((rule?.lib ?? []).filter((x) => x !== 'nand'), (u) => resolveComponent(u)?.name);
    const core = coreSpecOf(ch.check);
    const graded = core
      ? `${core.tests().length} programs against the golden model, write by write (registers and stores, in order), within the cycle budget; Pong among them. Scored on NANDs, clock period and cycles.`
      : `A test sequence of ${ch.check.kind === 'sequence' ? ch.check.steps.length : 0} clocked steps, every output compared after every step. Scored on NANDs and clock period.`;
    el.append(
      ...(rulesOnly ? [] : [h('section', null, h('h4', null, 'The brief'), rich('p', ch.brief))]),
      h('section', null, h('h4', null, 'Pins'), h('div', { class: 'cap-tw' }, h('table', { class: 'cap-pins' },
        h('thead', null, h('tr', null, ['pin', 'dir', 'w', 'meaning'].map((t) => h('th', null, t)))), h('tbody', null, ch.ports.map(pinRow))))),
      ...(rulesOnly ? [h('section', null, h('h4', null, 'Check'), h('p', null, graded))] : [h('section', null, h('h4', null, 'Graded'), h('p', null, graded),
        h('p', { class: 'cap-ref' }, h('b', null, 'Reference: '), h('span', { 'data-ref': 'nand' }, '… NANDs'), ' (period and cycles are shown after a pass)'))]),
      h('section', null, h('h4', null, 'Allowed'),
        h('p', null, `NAND and ${names.length} unlocked parts (the palette's Unlocked parts lists them). Your own chips count by their NANDs.`),
        h('details', { class: 'cap-parts' }, h('summary', null, 'The parts'), h('p', null, names.join(', ')))),
      ...(rulesOnly ? [] : [h('p', { class: 'cap-note' }, h('b', null, 'Capstones only: '), 'no exam and no certificate. There is no walkthrough, no tip and no “Do it for me”; the reference answer opens after a pass, and a pass marks the tier done on My path.')]),
    );
    if (this.ref) this.showRefNands(el);
  }

  private testsTab(el: HTMLElement): void {
    const ch = this.ch!;
    const core = coreSpecOf(ch.check);
    if (core) {
      const tests = core.tests();
      el.append(h('section', null, h('h4', null, `${tests.length} programs`),
        h('p', { class: 'sub' }, 'Each runs on the golden model first; your core must make the same register writes and stores in the same order. The Check strip lists every one, failing ones first, and opens a failing one on a bench around your core.'),
        h('ul', { class: 'cap-tests' }, testRows(tests).map(([name, what]) => h('li', null, h('b', null, name), what ? `: ${what}` : '')))));
    } else if (ch.check.kind === 'sequence') {
      el.append(h('section', null, h('h4', null, `${ch.check.steps.length} steps`),
        h('p', { class: 'sub' }, 'A reset, directed steps (a plain sum, hold, the carry and its holding, reset beating add, d wiggling between edges) and seeded random ones. Check plays them on your circuit; a failing step is shown with its inputs and the expected outputs.')));
    }
  }

  /** The reference's NANDs on the sheet (stats of the compiled reference: no simulation). */
  private fillRefNands(): void {
    const n = referenceNands(this.nodeId);
    if (n === undefined) return;
    this.refNands = n;
    this.showRefNands(this.side);
  }
  private refNands?: number;
  private showRefNands(el: HTMLElement): void {
    if (this.refNands !== undefined) el.querySelector('[data-ref="nand"]')?.replaceChildren(`${groupDigits(this.refNands)} NANDs`);
  }

  // ---- a pass ----------------------------------------------------------------------------------------

  private record(r: CheckResult): void {
    if (this.isBrief()) { this.recordBrief(r); return; }
    const g = progress().solveCapstone(this.nodeId, measured(r.score), capstoneRank(this.nodeId));
    this.renderSide();
    this.showResult(r, g);
  }

  /** A pass of the brief: the measurement is kept as a submission, graded against the references, and shown on the chart. */
  private recordBrief(r: CheckResult): void {
    const m = measured(r.score);
    if (m.nand === undefined || m.period === undefined || m.cycles === undefined) return;
    const p = progress();
    const stars = briefStars({ nand: m.nand, period: m.period, cycles: m.cycles });
    p.addSubmission(this.nodeId, { nand: m.nand, period: m.period, cycles: m.cycles, stars });
    p.solveCapstone(this.nodeId, m, capstoneRank(this.nodeId));
    this.setView('results');
    this.renderSide();
  }

  private showResult(r: CheckResult, g: { first: boolean; best: boolean }): void {
    const cap = this.cap!;
    this.result?.remove();
    const m = measured(r.score);
    const cell = (v: number | null | undefined) => (v === undefined || v === null ? '—' : groupDigits(v));
    type Key = 'nand' | 'period' | 'cycles' | 'speed';
    // tier 3 is ranked by period × cycles (capstoneRank)
    const val = (s: { nand?: number; period?: number | null; cycles?: number }, k: Key): number | undefined =>
      k === 'speed' ? (s.period != null && s.cycles !== undefined ? s.period * s.cycles : undefined) : (s[k] ?? undefined);
    const rows: [string, Key][] = [['NANDs', 'nand'], ['Clock period', 'period'], ['Cycles', 'cycles'], ...(cap.tier === 3 ? [['Period × cycles', 'speed'] as [string, Key]] : [])];
    const shown = rows.filter(([, k]) => val(m, k) !== undefined);
    const refCells = shown.map(([, k]) => h('td', { 'data-ref': k }, '…'));
    const table = h('table', { class: 'lv-res-table' }, h('tr', null, h('th', null, 'Metric'), h('th', null, 'Yours'), h('th', null, 'Reference')),
      shown.map(([label, k], i) => h('tr', null, h('td', null, label), h('td', null, cell(val(m, k))), refCells[i])));
    const close = () => { this.result?.remove(); this.result = null; };
    const card = h('div', { class: 'lv-result', role: 'dialog', 'aria-label': 'Capstone passed' },
      h('h3', null, icon('check', 20), g.first ? `Tier ${cap.tier} capstone passed` : g.best ? 'New best' : 'Passes'),
      h('p', { class: 'sub' }, g.first ? 'The tier is marked done on My path. Show answer and the reference are open now; the reference is the same task done one way, not the only way.' : 'Still passing.'),
      table,
      h('div', { class: 'lv-res-act' },
        h('button', { class: 'btn ghost', onclick: close }, 'Close'),
        h('button', { class: 'btn', onclick: () => this.showAnswer() }, 'Open the reference answer'),
        h('a', { class: 'btn primary', href: '#/campaign' }, 'Back to the campaign', icon('chevR', 14))));
    this.result = h('div', { class: 'lv-veil', onclick: (e: Event) => { if (e.target === this.result) close(); } }, card);
    this.result.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Escape') close(); });
    this.edWrap.append(this.result);
    (card.querySelector('.btn.primary, .btn') as HTMLElement | null)?.focus();
    // the reference's own numbers: its check runs after the card is on screen
    setTimeout(() => {
      this.ref ??= referenceScore(this.nodeId);
      const ref = this.ref;
      shown.forEach(([, k], i) => {
        const v = ref ? val(ref, k) : undefined;
        refCells[i].textContent = cell(v);
        const mine = val(m, k);
        if (typeof v === 'number' && typeof mine === 'number') refCells[i].previousElementSibling?.classList.add(mine <= v ? 'par' : 'over');
      });
    }, 0);
  }

  /** The reference answer as chips of their own, in the full sandbox (after a pass only). */
  private showAnswer(): void {
    if (!this.passed()) return;
    const ed = this.editor!, ch = this.ch!;
    let main = '';
    ed.editWs((ws) => { const r = importAnswer(ws, ch); main = r.main; return r.ws; });
    markJump();
    location.hash = `#/sandbox/${main}`;
  }
}
