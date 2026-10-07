// The build challenges in the sandbox: a "Challenges" button opens the list (by level, solved
// ones ticked); starting one creates its chip with the pins in place. While a challenge chip is
// open, a strip under the canvas shows the brief, Check (pass, failing vectors, forbidden parts,
// score against par), Show answer (the reference chips imported as new ones) and Do it for me
// (the chip's drawing replaced by the answer, one undo step). A challenge restricted to NANDs or
// transistors switches the palette to purist mode while its chip is open. Progress lives in the
// site's settings (sandbox:<id>); nothing else is stored beyond the workspace.
//
// Campaign levels (chips u_ch_cp_<node>) use the same strip: a breadcrumb back to the campaign,
// stars against par, tips one at a time, the next level; a pass is recorded in the campaign's
// progress. Their rule (NAND + the parts unlocked by the levels below) fills the palette's
// "Unlocked parts" group.

import '../styles/sbchallenges.css';
import { measured } from '../campaign/grade';
import { nextAvailable } from '../campaign/graph';
import { levelChallenge, nodeOfChip } from '../campaign/levels';
import { ACTS } from '../campaign/nodes';
import { progress } from '../campaign/progress';
import type { CampaignNode } from '../campaign/types';
import { libraryItems } from '../lib/catalog';
import { resolveComponent } from '../lib/resolve';
import { h, icon } from '../ui/dom';
import { settings } from '../ui/settings';
import { CHALLENGES } from './challengeset';
import {
  type Allowed, type BuildChallenge, challengeChipId, challengeOf, type CheckResult, checkChallenge, importAnswer, LEVELS, libAllowed, type LibRule,
  ruleKind, solveChallenge, solvedKey, startChallenge,
} from './challenges';
import { dockPane, paneShown, showPane, undockPane } from './dock';
import { type Editor, registerToolbarAction } from './editor';
import { type PaletteItem, registerPaletteGroup } from './palette';

const RULE: Record<'transistors' | 'nand' | 'any', [string, string]> = {
  transistors: ['transistors only', 'Transistors, rails, wiring and your own chips built from them'],
  nand: ['NAND only', 'NAND gates (or below), wiring, constants and your own chips built from them'],
  any: ['any part', 'The whole library is allowed'],
};

/** Badge text and tooltip of a rule. */
function rule(a: Allowed): [string, string] {
  if (typeof a === 'string') return RULE[a];
  return [a.label ?? 'unlocked parts', `NAND, wiring, constants, your own chips, and the parts unlocked by the levels this one builds on: ${a.lib.filter((x) => x !== 'nand').join(', ') || 'none yet'}`];
}

// ---- the "Unlocked parts" palette group ----------------------------------------------------------

/** The campaign rule of the chip being edited (set by the strip), listed by the palette group. */
let activeRule: LibRule | null = null;

function unlockedItems(r: LibRule): PaletteItem[] {
  const out = new Map<string, PaletteItem>();
  for (const c of libraryItems()) {
    for (const it of c.items) {
      if (it.id !== 'nand' && libAllowed(r, it.id)) out.set(it.id, { id: it.id, name: it.name, section: c.title, place: { part: { lib: it.id } } });
    }
  }
  for (const id of r.lib) {
    if (id.endsWith('*') || id === 'nand' || out.has(id)) continue;
    const d = resolveComponent(id);
    if (d) out.set(id, { id, name: d.name, place: { part: { lib: id } } });
  }
  return [...out.values()];
}

registerPaletteGroup({
  id: 'unlocked', title: 'Unlocked parts', order: 65, purist: true,
  items: () => (activeRule ? unlockedItems(activeRule) : []),
});

const uis = new WeakMap<Editor, ChallengeUi>();

/** Install the challenge panel on an editor (once per page); returns its teardown. */
export function installChallenges(ed: Editor): { destroy(): void } {
  let ui = uis.get(ed);
  if (!ui) uis.set(ed, (ui = new ChallengeUi(ed)));
  return ui;
}

class ChallengeUi {
  private panel = h('section', { class: 'sb-chal', 'aria-label': 'Challenge' });
  private drawer: HTMLElement | null = null;
  /** Last check per challenge chip, with the connectivity it was run on (an edit makes it stale). */
  private results = new Map<string, { r: CheckResult; conn: string }>();
  private collapsed = false;
  private confirming = false;
  private lastChip = '';
  /** Purist mode was switched on by a challenge (and is switched off when leaving it). */
  private forcedPurist = false;
  private key = '';
  /** Bumped when a result is stored or dropped. */
  private version = 0;
  private unsub: () => void;

  constructor(private ed: Editor) {
    ed.slots.bottom.append(this.panel);
    this.unsub = ed.onChange(() => this.sync());
    this.sync();
  }

  destroy(): void {
    activeRule = null;
    this.unsub();
    this.panel.remove();
    this.closeList();
    uis.delete(this.ed);
  }

  /** The campaign level of the open chip, if it is one. */
  private get level(): CampaignNode | undefined {
    const n = nodeOfChip(this.ed.chipId);
    return n && levelChallenge(n) ? n : undefined;
  }

  private get challenge(): BuildChallenge | undefined {
    const n = this.level;
    return n ? levelChallenge(n) : challengeOf(this.ed.chipId, CHALLENGES);
  }

  private sync(): void {
    const ed = this.ed;
    const ch = this.challenge;
    if (ed.chipId !== this.lastChip) {
      this.lastChip = ed.chipId;
      this.confirming = false;
      const lib = ch && typeof ch.allowed === 'object' ? ch.allowed : null;
      if (lib !== activeRule) {
        activeRule = lib;
        ed.refresh();
      }
      if (this.level) progress().open(this.level.id, true);
      const restricted = !!ch && ch.allowed !== 'any';
      if (restricted && !ed.ws.purist) {
        this.forcedPurist = true;
        ed.volatile({ ...ed.ws, purist: true });
        ed.toast(`Palette limited to what this ${this.level ? 'level' : 'challenge'} allows (${rule(ch.allowed)[0]})`);
        return; // volatile() refreshed the editor, which called sync() again
      }
      if (!restricted && this.forcedPurist) {
        this.forcedPurist = false;
        if (ed.ws.purist) return void ed.volatile({ ...ed.ws, purist: undefined });
      }
    }
    this.render();
    if (this.drawer) this.renderList();
  }

  // ---- the strip under the canvas -------------------------------------------------------------

  private render(): void {
    const ch = this.challenge;
    const ed = this.ed;
    const res = ch ? this.results.get(ed.chipId) : undefined;
    const stale = !!res && res.conn !== ed.compiled?.connKey;
    const lv = this.level;
    const lp = lv ? progress().get(lv.id) : undefined;
    const key = JSON.stringify([ed.chipId, !!ch, this.collapsed, this.confirming, this.version, stale, ch && settings.isSolved(solvedKey(ch)), lp]);
    if (key === this.key) return;
    this.key = key;
    this.panel.hidden = !ch;
    this.panel.replaceChildren();
    if (!ch) return;
    const solved = lv ? lp?.status === 'solved' : settings.isSolved(solvedKey(ch));
    const pinList = (dir: 'in' | 'out') => ch.ports.filter((p) => p.dir === dir).map((p) => h('code', null, p.width > 1 ? `${p.name}[${p.width - 1}:0]` : p.name));
    const actions = this.confirming
      ? [h('span', { class: 'sb-chal-ask' }, 'Replace your circuit with the answer?'),
        h('button', { class: 'btn sm primary', 'data-chal': 'solve-yes', onclick: () => this.solve() }, 'Replace'),
        h('button', { class: 'btn sm ghost', onclick: () => { this.confirming = false; this.render(); } }, 'Cancel')]
      : [h('button', { class: 'btn sm primary', 'data-chal': 'check', title: 'Run the chip against the specification', onclick: () => this.check() }, icon('check', 14), 'Check'),
        h('button', { class: 'btn sm ghost', 'data-chal': 'answer', title: 'Import the reference answer as new chips (yours stay as they are)', onclick: () => this.showAnswer() }, 'Show answer'),
        h('button', { class: 'btn sm ghost', 'data-chal': 'solve', title: 'Replace this chip\'s circuit with the reference answer', onclick: () => { this.confirming = true; this.render(); } }, 'Do it for me')];
    this.panel.append(
      h('header', { class: 'sb-chal-head' },
        h('button', { class: `btn ghost icon-only sb-chal-fold${this.collapsed ? '' : ' open'}`, title: this.collapsed ? 'Show the brief' : 'Hide the brief', 'aria-expanded': String(!this.collapsed),
          onclick: () => { this.collapsed = !this.collapsed; this.render(); } }, icon('chevR', 14)),
        lv
          ? h('a', { class: `sb-chal-flag${solved ? ' solved' : ''}`, href: `#/campaign/n/${lv.id}`, title: `Back to the campaign: ${ACTS[lv.act]?.title ?? ''}` }, icon(solved ? 'check' : 'flag', 13), `Campaign · Act ${lv.act}`)
          : h('span', { class: `sb-chal-flag${solved ? ' solved' : ''}`, title: solved ? 'Solved' : 'Challenge' }, icon(solved ? 'check' : 'flag', 13), LEVELS.find((l) => l.id === ch.level)?.title ?? ch.level),
        h('h3', null, ch.title),
        lv && lp?.stars ? h('span', { class: 'sb-chal-stars', title: `Best: ${lp.stars} of 3 stars` }, '★'.repeat(lp.stars) + '☆'.repeat(3 - lp.stars)) : null,
        h('span', { class: 'sb-chal-pins', title: 'The pins to build' }, ...pinList('in'), h('span', { class: 'arrow' }, '→'), ...pinList('out')),
        h('span', { class: `sb-chal-rule ${ruleKind(ch.allowed)}`, title: rule(ch.allowed)[1] }, rule(ch.allowed)[0]),
        // One group: when the strip is narrow it wraps as a whole, to the right of the next row.
        h('span', { class: 'sb-chal-actions' }, ...actions,
          lv ? null : h('button', { class: 'btn ghost icon-only', title: 'All challenges', 'aria-label': 'All challenges', onclick: () => this.toggleList() }, icon('menu', 15)))),
    );
    if (this.collapsed) return;
    const brief = h('p', { class: 'sb-chal-brief' });
    brief.innerHTML = ch.brief;
    const body = h('div', { class: 'sb-chal-body' }, brief);
    if (lv) body.append(this.levelEl(lv));
    if (res) body.append(this.resultEl(ch, res.r, stale));
    this.panel.append(body);
  }

  /** A campaign level's tips (one at a time) and its way back / onward. */
  private levelEl(n: CampaignNode): HTMLElement {
    const p = progress();
    const shown = Math.min(p.get(n.id)?.tips ?? 0, n.tips.length);
    const tips = h('ol', { class: 'sb-chal-tips' }, n.tips.slice(0, shown).map((t) => {
      const li = h('li');
      li.innerHTML = t;
      return li;
    }));
    const next = p.get(n.id)?.status === 'solved' ? nextAvailable(p.view, p.unlockAll, n.id) : undefined;
    return h('div', { class: 'sb-chal-level' },
      shown ? tips : null,
      h('div', { class: 'sb-chal-links' },
        shown < n.tips.length ? h('button', { class: 'btn sm ghost', 'data-chal': 'tip', onclick: () => { p.revealTip(n.id, n.tips.length); this.version++; this.render(); } }, icon('info', 13), shown ? 'Another tip' : 'A tip') : null,
        h('a', { class: 'btn sm ghost', href: `#/campaign/n/${n.id}` }, icon('chevL', 13), 'Campaign'),
        next ? h('a', { class: 'btn sm', href: `#/campaign/n/${next.id}`, title: next.title }, `Next: ${next.title}`, icon('chevR', 13)) : null));
  }

  private resultEl(ch: BuildChallenge, r: CheckResult, stale: boolean): HTMLElement {
    const el = h('div', { class: `sb-chal-result ${r.ok ? 'ok' : 'bad'}${stale ? ' stale' : ''}`, role: 'status' });
    const what = ch.check.kind === 'table' ? `${r.tested} input combination${r.tested === 1 ? '' : 's'}` : ch.check.kind === 'custom' ? `${r.tested} test program${r.tested === 1 ? '' : 's'}` : `${r.tested} steps`;
    el.append(h('div', { class: 'sb-chal-verdict' },
      r.ok ? h('b', null, icon('check', 14), 'Passes') : h('b', null, icon('close', 14), 'Not yet'),
      h('span', null, r.ok ? `all ${what} correct` : r.tested ? `checked ${what}` : 'not simulated'),
      stale ? h('span', { class: 'sb-chal-stale' }, 'edited since: check again') : null));
    if (r.failures.length || r.restrictionViolations.length || !r.ok) el.append(this.problems(r));
    el.append(this.scoreEl(ch, r));
    return el;
  }

  private problems(r: CheckResult): HTMLElement {
    const box = h('div', { class: 'sb-chal-problems' });
    if (r.failures.length) box.append(h('ul', { class: 'sb-chal-fails' }, r.failures.map((f) => h('li', null, f))));
    if (r.vector) {
      const v = r.vector;
      box.append(h('button', { class: 'sb-chal-apply', 'data-chal': 'apply', title: 'Set the input pins to the first failing combination', onclick: () => this.apply(v) },
        'Set the inputs to the first failing row'));
    }
    if (r.restrictionViolations.length) {
      box.append(h('p', { class: 'sb-chal-viol-h' }, 'Not allowed in this challenge:'),
        h('ul', { class: 'sb-chal-viol' }, r.restrictionViolations.slice(0, 6).map((f) => h('li', null, f))));
      if (r.restrictionViolations.length > 6) box.append(h('p', { class: 'sb-chal-viol-h' }, `… and ${r.restrictionViolations.length - 6} more`));
    }
    return box;
  }

  private scoreEl(ch: BuildChallenge, r: CheckResult): HTMLElement {
    const lim = ch.limits ?? {};
    const item = (v: number, unit: string, par?: number, before = false) => {
      const cls = par === undefined ? '' : v <= par ? 'par' : 'over';
      return h('span', { class: cls, title: cls === 'par' ? 'At or under par' : cls ? 'Over par (allowed: par is a target)' : '' },
        before ? `${unit} ` : null, h('b', null, v.toLocaleString()), before ? null : ` ${unit}`, par !== undefined ? h('small', null, ` par ${par}`) : null);
    };
    const period = r.score.period;
    const parts = ch.allowed === 'transistors'
      ? [item(r.score.transistors, 'transistors', lim.maxTransistors)]
      : [item(r.score.nand, 'NAND', lim.maxNand), r.score.depth !== null ? item(r.score.depth, 'depth', lim.maxDepth, true) : null,
        period !== undefined && period !== null ? item(period, 'period', lim.maxPeriod, true) : null,
        r.score.cycles !== undefined ? item(r.score.cycles, 'cycles', lim.maxCycles) : null,
        h('span', null, h('b', null, r.score.transistors.toLocaleString()), ' transistors')];
    return h('p', { class: 'sb-chal-score' }, ...parts);
  }

  private check(): void {
    const ed = this.ed;
    const ch = this.challenge;
    if (!ch) return;
    const r = checkChallenge(ch, ed.compiled);
    this.results.set(ed.chipId, { r, conn: ed.compiled?.connKey ?? '' });
    this.version++;
    this.collapsed = false;
    const lv = this.level;
    if (r.ok && lv) {
      const g = progress().solve(lv.id, measured(r.score));
      const st = '★'.repeat(g.stars) + '☆'.repeat(3 - g.stars);
      ed.toast(`${g.first ? 'Solved' : 'Passes'}: ${ch.title} ${st}${g.best && !g.first ? ' (new best)' : ''}`);
    } else if (r.ok) {
      const first = !settings.isSolved(solvedKey(ch));
      settings.solve(solvedKey(ch));
      ed.toast(first ? `Solved: ${ch.title}` : `Still passes: ${ch.title}`);
    }
    this.render();
    if (this.drawer) this.renderList();
  }

  private apply(v: Record<string, number>): void {
    const ed = this.ed;
    for (const [name, x] of Object.entries(v)) {
      const p = ed.doc.pins.find((q) => q.name === name && q.dir === 'in');
      if (p) ed.setPinValue(p.id, x);
    }
  }

  private showAnswer(): void {
    const ed = this.ed;
    const ch = this.challenge;
    if (!ch) return;
    let added: string[] = [];
    ed.editWs((ws) => {
      const r = importAnswer(ws, ch);
      added = r.added;
      return r.ws;
    });
    const names = added.map((id) => ed.ws.chips[id]?.name).filter(Boolean);
    ed.toast(names.length ? `Answer imported: ${names.join(', ')} (Ctrl+Z removes it)` : 'The answer is already among your chips: opened it');
  }

  private solve(): void {
    const ed = this.ed;
    const ch = this.challenge;
    this.confirming = false;
    if (!ch) return;
    ed.editWs((ws) => solveChallenge(ws, ch).ws);
    this.results.delete(challengeChipId(ch));
    this.version++;
    ed.toast('Replaced with the reference answer (Ctrl+Z brings yours back)');
    this.render();
  }

  // ---- the list -------------------------------------------------------------------------------

  toggleList(): void {
    // Behind another drawer of the dock: bring it to the front rather than closing it.
    if (this.drawer && !paneShown(this.ed, 'challenges')) return showPane(this.ed, 'challenges');
    if (this.drawer) return this.closeList();
    this.drawer = h('aside', { class: 'sb-drawer sb-chal-list', 'aria-label': 'Build challenges' });
    this.drawer.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.closeList();
    });
    dockPane(this.ed, { id: 'challenges', label: 'Challenges', icon: 'flag', el: this.drawer, width: 380 });
    this.renderList();
    this.drawer.querySelector<HTMLElement>('.sb-chal-item')?.focus();
  }

  private closeList(): void {
    if (this.drawer) undockPane(this.ed, 'challenges');
    this.drawer = null;
  }

  private renderList(): void {
    const d = this.drawer;
    if (!d) return;
    const ws = this.ed.ws;
    const done = CHALLENGES.filter((c) => settings.isSolved(solvedKey(c))).length;
    const body = h('div', { class: 'sb-chal-list-body' },
      h('p', { class: 'sb-chal-intro' }, 'Optional. Build each chip from the parts allowed; Check runs it on every input (or a clocked sequence) and scores it against par. Every challenge has an answer.'));
    for (const l of LEVELS) {
      const cs = CHALLENGES.filter((c) => c.level === l.id);
      if (!cs.length) continue;
      // One rule for the whole level is said once, in its heading.
      const one = cs.every((c) => c.allowed === cs[0].allowed) ? cs[0].allowed : null;
      body.append(h('h4', null, h('span', null, l.title), one ? h('small', { class: `sb-chal-rule ${ruleKind(one)}`, title: rule(one)[1] }, rule(one)[0]) : null,
        h('small', { class: 'n' }, `${cs.filter((c) => settings.isSolved(solvedKey(c))).length}/${cs.length}`)));
      for (const c of cs) {
        const solved = settings.isSolved(solvedKey(c));
        const started = !!ws.chips[challengeChipId(c)];
        const cur = this.ed.chipId === challengeChipId(c);
        body.append(h('button', {
          class: `sb-chal-item${solved ? ' solved' : ''}${cur ? ' cur' : ''}`, 'data-challenge': c.id,
          title: solved ? 'Solved: open it' : started ? 'Started: open it' : 'Start: a new chip with the pins in place', onclick: () => this.start(c),
        },
        h('span', { class: 'tick', 'aria-label': solved ? 'solved' : started ? 'started' : 'not started' }, solved ? icon('check', 13) : h('i', { class: started ? 'started' : '' })),
        h('span', { class: 'name' }, c.title),
        one ? null : h('small', { class: `sb-chal-rule ${ruleKind(c.allowed)}` }, rule(c.allowed)[0]),
        h('span', { class: 'go' }, cur ? 'open' : started ? 'Open' : 'Start')));
      }
    }
    d.replaceChildren(
      h('div', { class: 'sb-drawer-head' }, icon('flag', 15), h('h3', null, 'Build challenges'), h('span', { class: 'sb-chal-count' }, `${done}/${CHALLENGES.length} solved`),
        h('button', { class: 'btn ghost icon-only', title: 'Close', 'aria-label': 'Close the challenges', onclick: () => this.closeList() }, icon('close', 15))),
      body);
  }

  private start(c: BuildChallenge): void {
    const ed = this.ed;
    const id = challengeChipId(c);
    if (ed.ws.chips[id]) ed.openChip(id);
    else {
      ed.editWs((ws) => startChallenge(ws, c).ws);
      ed.toast(`New chip “${ed.doc.name}”: its pins are in place (Ctrl+Z removes it)`);
    }
    this.closeList();
  }
}

registerToolbarAction({
  id: 'challenges', title: 'Build challenges: recreate every level, checked and scored', icon: 'flag', label: 'Challenges', order: 64,
  run: (ed) => (uis.get(ed) ?? (installChallenges(ed), uis.get(ed)!)).toggleList(),
});
