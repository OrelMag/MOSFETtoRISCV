// The campaign's level screen (#/campaign/play/<node>): one level on a screen of its own. The
// level bar (where you are, par, stars, the way on), the brief in tabs (Why: the level's case,
// with the CPU diagram and this block lit; Task; Tips; Codex), and the editor in level mode: the
// level's chip and the chips it uses, the level's parts only, Check under the canvas. A pass opens
// a card with the measured cost against par and the alternatives, and what it is worth in the
// finished CPU. The chip is the same one the sandbox opens ("Open in sandbox"), nothing is copied.
// Loaded on demand with the editor (app.ts imports it dynamically).

import '../../styles/editor.css';
import '../../styles/sbchips.css';
import '../../styles/campaign.css';
import '../../styles/level.css';
import { caseOf } from '../../campaign/cases';
import { codexById } from '../../campaign/codex';
import { type AreaUnit, areaBars, METRIC, measured } from '../../campaign/grade';
import { dependents, isDone, nextAvailable, statusOf } from '../../campaign/graph';
import { levelChallenge, levelChipId } from '../../campaign/levels';
import { altCost, copiesInFinal, countedPart, finalCpu } from '../../campaign/measure';
import { walkOf } from '../../campaign/walk';
import { actName, actTitle, nodeById } from '../../campaign/nodes';
import { progress } from '../../campaign/progress';
import type { CampaignNode, Metric, Par } from '../../campaign/types';
import { criteria, gradeTable } from '../../campaign/ui/levelinfo';
import { hideGlossary, markTerms } from '../../campaign/ui/glossaryui';
import { anatomySvg } from '../../campaign/ui/svgs';
import { installChallenges } from '../../editor/challengeui';
import { type BuildChallenge, type CheckResult, importAnswer, ruleKind, startChallenge } from '../../editor/challenges';
import { Editor } from '../../editor/editor';
import { loadWorkspace, saveWorkspace } from '../../editor/store';
import '../../editor/features';
import { resolveComponent } from '../../lib/resolve';
import { h, icon } from '../dom';
import { settings } from '../settings';
import type { Page } from './chapter';
import { WalkMode } from './levelwalk';
import { tipsOf } from '../../campaign/nudges';

type Tab = 'walk' | 'why' | 'task' | 'tips' | 'codex';

const KIND_LABEL: Record<CampaignNode['kind'], string> = { lesson: 'LESSON', drill: 'DRILL', build: 'BUILD', program: 'PROGRAM', core: 'CPU CORE' };
/** The level screen keeps the toolbar to what building and checking a level needs. */
const LEVEL_ACTIONS = ['undo', 'redo', 'zout', 'zin', 'fit', 'iobar', 'probe', 'timing', 'package', 'inspect', 'cpu', 'props', 'help'];

const rich = (tag: 'p' | 'div' | 'li' | 'span', html: string, cls?: string) => {
  const el = h(tag, cls ? { class: cls } : null);
  el.innerHTML = html;
  return el;
};

/** Where a level opens: its own screen when it is built in the editor, else its panel on the map. */
export function levelRoute(n: CampaignNode): string {
  return levelChallenge(n) && !n.soon ? `#/campaign/play/${n.id}` : `#/campaign/n/${n.id}`;
}

export class LevelPage implements Page {
  readonly kind = 'level';
  readonly el: HTMLElement;
  readonly nodeId: string;
  private node?: CampaignNode;
  private ch?: BuildChallenge;
  private editor?: Editor;
  private chal?: ReturnType<typeof installChallenges>;
  private bar = h('div', { class: 'lv-bar' });
  private side = h('aside', { class: 'lv-side', 'aria-label': 'The level' });
  private edWrap = h('div', { class: 'lv-ed' });
  private tab: Tab = 'why';
  /** A phone: the brief is folded to its tabs (a tap opens one, a tap on the open one folds it) so the canvas and Check stay on screen. */
  private folded = narrow();
  /** The Tips tab asks before it shows the whole solution. */
  private confirmSolution = false;
  private result: HTMLElement | null = null;
  /** The walkthrough, while it is shown. */
  private walk: WalkMode | null = null;
  private chipId = '';
  private offs: (() => void)[] = [];

  constructor(nodeId: string) {
    this.nodeId = nodeId;
    const n = nodeById(nodeId);
    const ch = n && !n.soon ? levelChallenge(n) : undefined;
    const p = progress();
    if (!n || !ch) {
      this.el = this.notice('This level is not built in the editor', n ? 'It is a lesson, a drill or a program: it opens on the map.' : `There is no level “${nodeId}”.`, n);
      return;
    }
    if (statusOf(n, p.view, p.unlockAll) === 'locked') {
      const missing = n.requires.filter((r) => !isDone(p.view(r))).map((r) => nodeById(r)?.title ?? r);
      this.el = this.notice(`${n.title} is locked`, `Finish or skip first: ${missing.join(', ')}. Or tick Unlock all on the map.`, n);
      return;
    }
    this.node = n;
    this.ch = ch;
    // The level's chip lives in the sandbox's workspace: create it (pins in place) on the first visit.
    const chipId = levelChipId(n);
    this.chipId = chipId;
    let ws = loadWorkspace();
    if (!ws.chips[chipId]) {
      ws = startChallenge(ws, ch).ws;
      const saved = saveWorkspace(ws);
      if (!saved.ok) {
        this.el = this.notice('The level could not start', saved.reason, n);
        return;
      }
    }
    p.open(n.id, true);
    // A relay / tube level (a strict rule) lists its own parts under Unlocked parts and has no NAND.
    const strict = typeof ch.allowed === 'object' && !!ch.allowed.strict;
    const hide = ruleKind(ch.allowed) === 'transistors' ? [] : strict ? ['fets', 'switch', 'lib'] : ['fets', 'switch'];
    // A transistor level's own parts (transistors and rails) lead the palette, before wiring and NAND.
    const first = ruleKind(ch.allowed) === 'transistors' ? ['fets', 'unlocked', 'wiring', 'const', 'switch', 'lib', 'mine'] : undefined;
    this.editor = new Editor(chipId, { level: { chipId, actions: LEVEL_ACTIONS, hideGroups: hide, first } });
    if (this.editor.chipId !== chipId) this.editor.openChip(chipId);
    const hasWalk = !!walkOf(n)?.steps.length;
    this.chal = installChallenges(this.editor, {
      checked: (r, g) => this.checked(r, g),
      actions: () => (hasWalk ? [h('button', { class: 'btn sm', 'data-chal': 'walk', title: 'The reference answer built step by step, each step explained', onclick: () => this.startWalk(0) }, icon('play', 12), 'Walk me through it')] : []),
      // Show answer is the ladder's last rung: the Tips tab asks first.
      showAnswer: () => { if (this.walk) return this.startWalk(Infinity); this.tab = 'tips'; this.folded = false; this.confirmSolution = true; this.renderSide(); },
    });
    this.edWrap.append(this.editor.el);
    this.el = h('div', { class: 'lv-page' }, this.bar, h('div', { class: 'lv-body' }, this.side, this.edWrap));
    this.offs.push(p.onChange(() => { this.renderBar(); this.renderSide(); }));
    this.renderBar();
    this.renderSide();
  }

  destroy(): void {
    hideGlossary();
    this.walk?.leave();
    this.walk = null;
    this.offs.forEach((f) => f());
    this.chal?.destroy();
    this.editor?.destroy();
  }

  private notice(title: string, text: string, n?: CampaignNode): HTMLElement {
    return h('div', { class: 'lv-page lv-notice' }, h('div', { class: 'panel' }, h('h3', null, title), h('p', { class: 'sub' }, text),
      h('p', null, h('a', { class: 'btn', href: n ? `#/campaign/n/${n.id}` : '#/campaign' }, icon('chevL', 14), 'Back to the map'))));
  }

  // ---- the level bar ---------------------------------------------------------------------------

  private renderBar(): void {
    const n = this.node!, p = progress();
    const np = p.get(n.id);
    const st = statusOf(n, p.view, p.unlockAll);
    const done = isDone(p.view(n.id));
    const next = done ? nextAvailable(p.view, p.unlockAll, n.id) : undefined;
    const par = n.par ?? {};
    if (this.walk) {
      this.bar.replaceChildren(
        h('a', { class: 'lv-back', href: `#/campaign/n/${n.id}`, title: 'The campaign map' }, icon('chevL', 14), 'Map'),
        h('span', { class: 'lv-crumb' }, h('span', { class: 'lv-act' }, `${actName(n.act)} · ${actTitle(n.act)}`, h('span', { class: 'sep' }, '›')), h('b', null, n.title)),
        h('span', { class: 'lv-badge acc' }, 'WALKTHROUGH'),
        h('span', { class: 'lv-spacer' }),
        h('button', { class: 'btn sm ghost', title: 'Back to your own circuit, as you left it', 'aria-label': 'Leave the walkthrough', onclick: () => this.leaveWalk() }, h('span', null, 'Leave', h('span', { class: 'lbl' }, ' the walkthrough'))));
      return;
    }
    const parText = (Object.keys(par) as Metric[]).map((k) => `${k === 'depth' || k === 'period' ? `${k} ` : ''}${par[k]!.toLocaleString()}${k === 'depth' || k === 'period' ? '' : ` ${par[k] === 1 ? METRIC[k].unit.replace(/s$/, '') : METRIC[k].unit}`}`);
    this.bar.replaceChildren(...[
      h('a', { class: 'lv-back', href: `#/campaign/n/${n.id}`, title: 'The campaign map' }, icon('chevL', 14), 'Map'),
      h('span', { class: 'lv-crumb' }, h('span', { class: 'lv-act' }, `${actName(n.act)} · ${actTitle(n.act)}`, h('span', { class: 'sep' }, '›')), h('b', null, n.title)),
      h('span', { class: 'lv-badge lv-kind' }, KIND_LABEL[n.kind]),
      st === 'solved' ? h('span', { class: 'lv-badge good' }, 'SOLVED') : st === 'skipped' ? h('span', { class: 'lv-badge' }, 'SKIPPED') : null,
      parText.length ? h('span', { class: 'lv-par', title: 'Par: three stars at or under it on every metric' }, 'par ', h('b', null, parText.join(' · '))) : null,
      np?.stars ? h('span', { class: 'lv-stars', title: `Best: ${np.stars} of 3 stars` }, '★'.repeat(np.stars), h('span', { class: 'off' }, '★'.repeat(3 - np.stars))) : null,
      h('span', { class: 'lv-spacer' }),
      h('a', { class: 'btn sm ghost', href: `#/sandbox/${levelChipId(n)}`, title: 'The same chip in the full sandbox editor', 'aria-label': 'Open in sandbox' }, h('span', { class: 'lbl' }, 'Open in sandbox'), icon('open', 13)),
      st !== 'solved' ? (st === 'skipped'
        ? h('button', { class: 'btn sm ghost', title: 'Back to unfinished', onclick: () => p.unskip(n.id) }, 'Un-skip')
        : h('button', { class: 'btn sm ghost', title: 'Count this level as done: its part unlocks (the reference solution stands in for yours)', onclick: () => p.skip(n.id) }, 'Skip')) : null,
      next ? h('a', { class: `btn sm${st === 'solved' ? ' primary' : ''}`, href: levelRoute(next), title: next.title, 'aria-label': `Next: ${next.title}` }, h('span', null, 'Next', h('span', { class: 'lbl' }, `: ${next.title}`)), icon('chevR', 13)) : null,
    ].filter((x): x is HTMLElement => !!x));
  }

  // ---- the side panel ----------------------------------------------------------------------------

  private renderSide(): void {
    const n = this.node!, p = progress();
    const shownTips = Math.min(p.get(n.id)?.tips ?? 0, tipsOf(n).length);
    const tabs: [Tab, string, string?][] = this.walk ? [['walk', 'Walkthrough'], ['why', 'Why'], ['task', 'Task']]
      : [['why', 'Why'], ['task', 'Task'], ['tips', 'Tips', tipsOf(n).length ? `${shownTips}/${tipsOf(n).length}` : undefined], ['codex', 'Codex', n.codex.length ? String(n.codex.length) : undefined]];
    if (!tabs.some(([id]) => id === this.tab)) this.tab = tabs[0][0];
    const bar = h('div', { class: 'lv-tabs', role: 'tablist' }, tabs.map(([id, label, badge]) => {
      const on = this.tab === id && !this.folded;
      return h('button', { class: on ? 'on' : '', role: 'tab', 'aria-selected': String(on), 'aria-expanded': narrow() ? String(on) : null,
        onclick: () => { this.folded = narrow() && on; this.tab = id; this.renderSide(); } }, label, badge ? h('small', null, badge) : null);
    }));
    const body = h('div', { class: 'lv-sidebody', role: 'tabpanel' });
    if (this.tab === 'walk' && this.walk) body.append(this.walk.panel(n.par ?? {}, () => this.leaveWalk(), () => this.takeWalk(), () => this.finishWalk()));
    else if (this.tab === 'why') this.whyTab(body);
    else if (this.tab === 'task') this.taskTab(body);
    else if (this.tab === 'tips') this.tipsTab(body);
    else this.codexTab(body);
    this.side.replaceChildren(bar, body);
    this.side.classList.toggle('folded', this.folded);
    if (settings.glossary && this.tab !== 'codex') markTerms(body, 8);
    body.classList.toggle('walking', this.tab === 'walk');
  }

  private whyTab(el: HTMLElement): void {
    const n = this.node!, p = progress();
    const c = caseOf(n.id);
    const blk = blockOf(n);
    if (blk) {
      el.append(h('div', { class: 'lv-anat', title: blk.own ? 'The CPU you will finish: this level builds the lit block' : 'The CPU you will finish: this level\'s part ends up in the lit block' },
        anatomySvg(p.view, blk.id, () => {})));
    }
    el.append(h('section', null, h('h4', null, 'The problem'), rich('p', c?.problem ?? n.why)));
    if (c?.without) el.append(h('section', null, h('h4', null, 'Without it'), rich('p', c.without)));
    const alts = (c?.alts ?? []).map((a) => ({ a, cost: altCost(a) }));
    if (c?.cost || alts.length || n.par) {
      const sec = h('section', null, h('h4', null, 'What it costs'));
      if (c?.cost) sec.append(rich('p', c.cost));
      const rows: [string, string][] = [];
      const par = n.par ?? {};
      // A relay or tube level compares in its own devices (the technology setting's price of a NAND alternative).
      const devices = par.relays !== undefined || par.tubes !== undefined || par.steps !== undefined;
      // A transistor level compares in transistors (its parts have no NANDs: "0 NAND" said nothing).
      const fets = !devices && par.transistors !== undefined && par.nand === undefined;
      const fetText = (v: number | undefined) => (v === undefined ? '—' : `${v.toLocaleString()} transistor${v === 1 ? '' : 's'}`);
      if (devices) rows.push(['Par', deviceText(par, par)]);
      else if (fets) rows.push(['Par', fetText(par.transistors)]);
      else if (par.nand !== undefined || par.depth !== undefined) rows.push(['Par', costText(par.nand, par.depth)]);
      for (const { a, cost } of alts) rows.push([a.name, devices ? deviceText(cost, par) : fets ? fetText(cost.transistors) : costText(cost.nand, cost.depth)]);
      if (rows.length) sec.append(h('div', { class: 'lv-cost' }, rows.flatMap(([k, v]) => [h('span', null, k), h('span', { class: 'v' }, v)])));
      const copies = h('p', { class: 'lv-copies' });
      sec.append(copies);
      // Compiling the finished CPU takes a moment: after the panel is on screen.
      setTimeout(() => {
        const k = copiesInFinal(n), part = countedPart(n);
        if (k > 0 && part) copies.replaceChildren(h('b', null, k.toLocaleString()), ` × ${part.name} in the finished CPU (${finalCpu(n)?.node.title ?? ''}).`);
      }, 0);
      el.append(sec);
    }
    const later = dependents(n.id);
    if (later.length) el.append(h('section', null, h('h4', null, 'Used later in'), h('div', { class: 'lv-chips' }, later.map((d) => h('a', { class: 'lv-chip', href: levelRoute(d) }, d.title)))));
    if (n.chapters?.length) el.append(h('section', null, h('h4', null, 'Go deeper'), h('div', { class: 'lv-chips' }, n.chapters.map((c2) => h('a', { class: 'lv-chip', href: `#/c/${c2.chapter}/${c2.step ?? 0}` }, icon('book', 12), c2.label)))));
  }

  private taskTab(el: HTMLElement): void {
    const n = this.node!, ch = this.ch!;
    el.append(h('section', null, h('h4', null, 'The task'), rich('p', ch.brief)),
      h('section', { class: 'cp-criteria' }, h('h4', null, 'Success criteria'), h('ul', null, criteria(ch).map((c) => h('li', null, c)))),
      gradeTable(n));
    const req = n.requires.map((r) => nodeById(r)).filter((x): x is CampaignNode => !!x);
    const rule = typeof ch.allowed === 'object' ? ch.allowed.lib.filter((x) => x !== 'nand') : [];
    const name = (u: string) => (u.endsWith('*') ? `${u.slice(0, -1)}…` : resolveComponent(u)?.name ?? u);
    el.append(h('section', { class: 'cp-deps' },
      req.length ? h('p', null, h('b', null, 'Builds on: '), req.map((r, i) => [i ? ', ' : '', h('a', { href: levelRoute(r) }, r.title)])) : null,
      rule.length ? h('p', null, h('b', null, 'Parts you may place: '), 'NAND, ', rule.map(name).join(', ')) : null,
      n.unlocks?.length ? h('p', null, h('b', null, 'Unlocks: '), n.unlocks.map(name).join(', ')) : null));
  }

  /** The hint ladder: the tips one at a time (a nudge first), then the walkthrough from step 1, then the solution. */
  private tipsTab(el: HTMLElement): void {
    const n = this.node!, p = progress();
    const tips = tipsOf(n);
    const shown = Math.min(p.get(n.id)?.tips ?? 0, tips.length);
    const hasWalk = !!walkOf(n)?.steps.length;
    const rung = (label: string, used: boolean, ...body: (HTMLElement | null)[]) =>
      h('section', { class: `lv-rung${used ? ' used' : ''}` }, h('div', { class: 'lv-rung-k' }, used ? icon('check', 11) : null, label), ...body);
    const rungs: HTMLElement[] = [];
    if (tips.length) {
      rungs.push(rung(`Tips · ${shown} of ${tips.length}`, shown >= tips.length,
        shown ? h('ol', { class: 'lv-tips' }, tips.slice(0, shown).map((t) => rich('li', t)))
          : h('p', { class: 'sub' }, 'Revealed one at a time, the first a nudge, the last usually how par is reached.'),
        shown < tips.length ? h('p', null, h('button', { class: 'btn sm', onclick: () => p.revealTip(n.id, tips.length) }, icon('info', 13), shown ? 'Another tip' : 'Show a tip')) : null));
    }
    if (hasWalk) {
      rungs.push(rung('Walk', false,
        h('p', { class: 'sub' }, 'The reference answer built a step at a time, each step explained; some ask you to predict first. Your chip stays as it is.'),
        h('p', null, h('button', { class: 'btn sm', onclick: () => this.startWalk(0) }, icon('play', 12), 'Walk me through it'))));
    }
    const solve = () => { this.confirmSolution = false; if (hasWalk) this.startWalk(Infinity); else this.showAnswer(); };
    rungs.push(rung('Solution', false,
      h('p', { class: 'sub' }, 'The whole reference circuit. Stars you already earned stay.'),
      this.confirmSolution
        ? h('div', { class: 'lv-confirm' }, h('span', null, 'Show the whole answer?'),
          h('button', { class: 'btn sm primary', onclick: solve }, 'Show it'),
          h('button', { class: 'btn sm ghost', onclick: () => { this.confirmSolution = false; this.renderSide(); } }, 'Not yet'))
        : h('p', null, h('button', { class: 'btn sm ghost', onclick: () => { this.confirmSolution = true; this.renderSide(); } }, 'Show solution…'))));
    el.append(h('div', { class: 'lv-ladder' }, rungs));
  }

  private codexTab(el: HTMLElement): void {
    const n = this.node!;
    const unlocked = progress().codexUnlocked();
    if (!n.codex.length) return void el.append(h('p', { class: 'sub' }, 'This level adds nothing to the codex.'));
    for (const id of n.codex) {
      const e = codexById(id);
      if (!e) continue;
      el.append(unlocked.has(id)
        ? h('section', { class: 'lv-cx' }, h('h4', null, e.title), rich('p', e.body), h('a', { class: 'lv-more', href: `#/campaign/codex/${id}` }, 'Open in the codex', icon('chevR', 12)))
        : h('section', { class: 'lv-cx locked' }, h('h4', null, e.title), rich('p', e.body), h('p', { class: 'sub' }, 'The full entry is added to the codex when you pass or skip this level.')));
    }
  }

  // ---- checks ------------------------------------------------------------------------------------

  private checked(r: CheckResult, g?: { stars: 1 | 2 | 3; best: boolean; first: boolean }): void {
    this.renderBar();
    if (r.ok && g) this.showResult(r, g);
  }

  /** The walkthrough from step k (Infinity: the last, the whole answer). */
  private startWalk(k: number): void {
    if (this.walk) return void this.walk.go(k === Infinity ? this.walk.steps.length - 1 : k);
    this.result?.remove();
    this.result = null;
    const w = walkOf(this.node!);
    const at = k === Infinity ? (w?.steps.length ?? 1) - 1 : k;
    this.walk = WalkMode.open(this.editor!, this.node!, this.ch!, at, this.chipId, () => this.renderSide()) ?? null;
    if (!this.walk) return this.showAnswer();
    this.tab = 'walk';
    this.folded = false;
    this.renderBar();
    this.renderSide();
  }

  private leaveWalk(): void {
    this.walk?.leave();
    this.walk = null;
    this.tab = 'why';
    this.folded = narrow();
    this.renderBar();
    this.renderSide();
  }

  private takeWalk(): void {
    this.walk?.takeOver();
    this.walk = null;
    this.tab = 'task';
    this.folded = narrow();
    this.renderBar();
    this.renderSide();
  }

  /** Build along's last step: the learner's circuit becomes the level's chip and is checked (a pass shows the result card). */
  private finishWalk(): void {
    this.takeWalk();
    this.chal?.check();
  }

  private showAnswer(): void {
    // Until the walkthrough: the reference answer in the full sandbox, as chips of their own.
    const ed = this.editor!, ch = this.ch!;
    let main = '';
    ed.editWs((ws) => { const r = importAnswer(ws, ch); main = r.main; return r.ws; });
    location.hash = `#/sandbox/${main}`;
  }

  /** The after-pass card: the measured cost against par and the alternatives, and what it is worth in the finished CPU. */
  private showResult(r: CheckResult, g: { stars: 1 | 2 | 3; best: boolean; first: boolean }): void {
    const n = this.node!;
    this.result?.remove();
    const m = measured(r.score);
    const par = n.par ?? {};
    const c = caseOf(n.id);
    const alts = (c?.alts ?? []).map((a) => ({ name: a.name, cost: altCost(a) }));
    const metrics = (['nand', 'transistors', 'relays', 'tubes', 'steps', 'depth', 'period', 'cycles'] as Metric[]).filter((k) => par[k] !== undefined || (k === 'transistors' && par.nand !== undefined));
    const cell = (v: number | null | undefined) => (v === undefined || v === null ? '—' : v.toLocaleString());
    const table = metrics.length ? h('table', { class: 'lv-res-table' },
      h('tr', null, h('th', null, 'Metric'), h('th', null, 'Yours'), h('th', null, 'Par'), alts.map((a) => h('th', null, a.name))),
      metrics.map((k) => h('tr', null, h('td', null, METRIC[k].label),
        h('td', { class: par[k] === undefined ? '' : (m[k] ?? Infinity) <= par[k]! ? 'par' : 'over' }, cell(m[k])),
        h('td', null, cell(par[k])),
        alts.map((a) => h('td', null, cell((a.cost as Record<string, number | null | undefined>)[k])))))) : null;
    // Area bars: yours, par and the alternatives on one scale, in the level's area metric, labelled with it.
    const area = areaBars(m, par, alts.map((a) => ({ name: a.name, cost: a.cost as Partial<Record<AreaUnit, number>> })));
    const max = Math.max(1, ...(area?.bars ?? []).map((b) => b[1]));
    const barEl = area ? h('div', { class: 'lv-bars-box' },
      h('div', { class: 'lv-bars-k' }, `Area, in ${area.unit === 'nand' ? 'NANDs' : METRIC[area.unit].label.toLowerCase()}`),
      h('div', { class: 'lv-bars', title: METRIC[area.unit].hint }, area.bars.flatMap(([k, v, you]) =>
        [h('span', null, k), h('span', { class: 'track' }, h('i', { class: you ? 'you' : '', style: `width:${(100 * v / max).toFixed(1)}%` })), h('span', { class: 'v' }, v.toLocaleString())]))) : null;
    const callout = h('div', { class: 'lv-callout' });
    const unlocks = (n.unlocks ?? []).filter((u) => !u.endsWith('*')).map((u) => resolveComponent(u)?.name ?? u);
    const codex = n.codex.map((id) => codexById(id)).filter((e) => !!e);
    const next = nextAvailable(progress().view, progress().unlockAll, n.id);
    const close = () => { this.result?.remove(); this.result = null; };
    const card = h('div', { class: 'lv-result', role: 'dialog', 'aria-label': 'Level passed' },
      h('h3', null, h('span', { class: 'lv-big' }, '★'.repeat(g.stars), h('span', { class: 'off' }, '★'.repeat(3 - g.stars))),
        g.stars === 3 ? 'Passed at par' : g.first ? 'Passed' : g.best ? 'New best' : 'Passes'),
      table, barEl, callout,
      unlocks.length || codex.length ? h('p', { class: 'lv-unl' },
        unlocks.length ? [h('b', null, 'Unlocked: '), unlocks.join(', '), ' (placeable from the next level on)'] : null,
        unlocks.length && codex.length ? ' · ' : null,
        codex.length ? [h('b', null, 'Codex: '), codex.map((e, i) => [i ? ', ' : '', h('a', { href: `#/campaign/codex/${e!.id}` }, e!.title)])] : null) : null,
      h('div', { class: 'lv-res-act' },
        h('button', { class: 'btn ghost', onclick: close }, g.stars < 3 ? 'Keep improving' : 'Close'),
        h('a', { class: 'btn', href: `#/campaign/n/${n.id}` }, 'Back to the map'),
        next ? h('a', { class: 'btn primary', href: levelRoute(next) }, `Next: ${next.title}`, icon('chevR', 14)) : null));
    this.result = h('div', { class: 'lv-veil', onclick: (e: Event) => { if (e.target === this.result) close(); } }, card);
    this.result.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Escape') close(); });
    this.edWrap.append(this.result);
    (card.querySelector('.btn.primary, .btn') as HTMLElement | null)?.focus();
    setTimeout(() => this.fillCallout(callout, m.nand, par.nand, alts), 0);
  }

  /** What the result is worth in the finished CPU: its copies there, times the NANDs saved (or still to save). */
  private fillCallout(el: HTMLElement, yours: number | undefined, par: number | undefined, alts: { name: string; cost: { nand?: number } }[]): void {
    const n = this.node!;
    const k = copiesInFinal(n), part = countedPart(n);
    if (k <= 0 || !part || yours === undefined) return el.remove();
    const parts: (string | Node)[] = [`The finished CPU holds `, h('b', null, k.toLocaleString()), ` × ${part.name}.`];
    // Against the first alternative the case lists (the textbook way), not the costliest: a later one may do more (a reset).
    const base = alts[0];
    if (base?.cost.nand !== undefined && base.cost.nand > yours) {
      parts.push(` Compared with “${base.name}”, your design saves `, h('b', null, ((base.cost.nand - yours) * k).toLocaleString()), ' NANDs there.');
    }
    if (par !== undefined && yours > par) parts.push(' At par it would be ', h('b', null, ((yours - par) * k).toLocaleString()), ' fewer.');
    el.replaceChildren(...parts);
  }
}

/** The phone layout (level.css): the brief folds away above the editor. */
const narrow = () => matchMedia('(max-width: 900px)').matches;

/** The anatomy block a level builds, else the one its part first ends up in (the nearest later required level that names one). */
function blockOf(n: CampaignNode): { id: string; own: boolean } | undefined {
  if (n.anatomy?.length) return { id: n.anatomy[0], own: true };
  const seen = new Set([n.id]);
  let ring = dependents(n.id).filter((d) => !d.optional);
  while (ring.length) {
    const hit = ring.find((d) => d.anatomy?.length);
    if (hit) return { id: hit.anatomy![0], own: false };
    ring.forEach((d) => seen.add(d.id));
    ring = ring.flatMap((d) => dependents(d.id)).filter((d) => !d.optional && !seen.has(d.id));
  }
  return undefined;
}

/** Relays, tube sections and relay steps of `c`, those the level grades (`par`) only. */
function deviceText(c: { relays?: number; tubes?: number; steps?: number }, par: Par): string {
  const n = (v: number, one: string, many: string) => `${v.toLocaleString()} ${v === 1 ? one : many}`;
  const out: string[] = [];
  if (c.relays !== undefined && par.relays !== undefined) out.push(n(c.relays, 'relay', 'relays'));
  if (c.tubes !== undefined && par.tubes !== undefined) out.push(n(c.tubes, 'tube section', 'tube sections'));
  if (c.steps !== undefined && par.steps !== undefined) out.push(n(c.steps, 'step', 'steps'));
  return out.join(' · ') || '—';
}

function costText(nand: number | undefined, depth: number | null | undefined): string {
  const out: string[] = [];
  if (nand !== undefined) out.push(`${nand.toLocaleString()} NAND`);
  if (depth !== undefined && depth !== null) out.push(`depth ${depth}`);
  return out.join(' · ') || '—';
}
