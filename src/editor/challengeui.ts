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
import { addBench, addLaneBench, addPongBench, failingTest } from '../campaign/bench';
import { coreSpecOf } from '../campaign/corecheck';
import { measured } from '../campaign/grade';
import { isDone, nextAvailable } from '../campaign/graph';
import { levelChallenge, nodeOfChip } from '../campaign/levels';
import { actName, actTitle } from '../campaign/nodes';
import { progress } from '../campaign/progress';
import type { CampaignNode } from '../campaign/types';
import { CATS, libraryItems } from '../lib/catalog';
import { resolveComponent } from '../lib/resolve';
import { stats } from '../sim/stats';
import { h, icon } from '../ui/dom';
import { settings } from '../ui/settings';
import { CHALLENGES } from './challengeset';
import {
  type Allowed, type BuildChallenge, challengeChipId, challengeOf, type CheckResult, builderViolations, checkChallenge, importAnswer, LEVELS, libAllowed, type LibRule, type Limits,
  ruleKind, scoreUnit, solveChallenge, solvedKey, startChallenge,
} from './challenges';
import { dockPane, paneShown, showPane, undockPane } from './dock';
import { fsmOf } from '../lib/fsms';
import { readbackEl } from './fsmui';
import { type Editor, registerToolbarAction } from './editor';
import { type PaletteItem, registerPaletteGroup } from './palette';
import { TestPlayer } from './testplayer';
import { testSet } from './testrun';
import { tipsOf } from '../campaign/nudges';

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

function deviceItems(r: CheckResult, lim: Limits, item: (v: number, unit: string, par?: number, before?: boolean) => HTMLElement | null): (HTMLElement | null)[] {
  const s = r.score;
  return [
    s.relays !== undefined || lim.maxRelays !== undefined ? item(s.relays ?? 0, s.relays === 1 ? 'relay' : 'relays', lim.maxRelays) : null,
    s.tubes !== undefined || lim.maxTubes !== undefined ? item(s.tubes ?? 0, s.tubes === 1 ? 'tube section' : 'tube sections', lim.maxTubes) : null,
    s.steps !== undefined ? item(s.steps, s.steps === 1 ? 'relay step' : 'relay steps', lim.maxSteps) : null,
    // a bench that counts cycles (the card loader: cycles until run)
    s.cycles !== undefined ? item(s.cycles, 'cycles', lim.maxCycles) : null,
  ];
}

// ---- the "Unlocked parts" palette group ----------------------------------------------------------

/** The campaign rule of the chip being edited (set by the strip), listed by the palette group. */
let activeRule: LibRule | null = null;

/** A part's NAND count as a short tag ('9 NAND', '1.2k NAND'); memoized: the palette re-lists on every render. */
const nandTags = new Map<string, string | undefined>();
function nandTag(id: string): string | undefined {
  if (!nandTags.has(id)) {
    const d = resolveComponent(id);
    const n = d ? stats(d).nands : 0;
    nandTags.set(id, n ? `${n < 1000 ? n : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`} NAND` : undefined);
  }
  return nandTags.get(id);
}

/** Every unlocked part in a section by its library category (catalog order), each tagged with what it costs. */
function unlockedItems(r: LibRule): PaletteItem[] {
  const out = new Map<string, PaletteItem & { rank: number }>();
  const title = (cat: string) => CATS.find(([c]) => c === cat)?.[1] ?? 'Other parts';
  const rank = (cat: string) => { const i = CATS.findIndex(([c]) => c === cat); return i < 0 ? CATS.length : i; };
  const item = (id: string, name: string, cat: string) => ({ id, name, section: title(cat), tag: nandTag(id), rank: rank(cat), place: { part: { lib: id } } });
  for (const c of libraryItems()) {
    for (const it of c.items) {
      if (it.id !== 'nand' && libAllowed(r, it.id)) out.set(it.id, item(it.id, it.name, c.cat));
    }
  }
  for (const id of r.lib) {
    if (id.endsWith('*') || id === 'nand' || out.has(id)) continue;
    const d = resolveComponent(id);
    if (d) out.set(id, item(id, d.name, d.category));
  }
  // stable: catalog order within a category, then the rule's
  return [...out.values()].sort((a, b) => a.rank - b.rank).map(({ rank: _, ...it }) => it);
}

registerPaletteGroup({
  id: 'unlocked', title: 'Unlocked parts', order: 65, purist: true,
  items: () => (activeRule ? unlockedItems(activeRule) : []),
});

const uis = new WeakMap<Editor, ChallengeUi>();

/**
 * The campaign's level screen: the strip shows only Check, the result and the test player (the
 * screen's own bar and panel carry the title, pins, brief and tips), and the screen hears of
 * every check.
 */
export interface LevelScreenHooks {
  /** After Check: the result, and the grade when a campaign level passed. */
  checked(r: CheckResult, grade?: { stars: 1 | 2 | 3; best: boolean; first: boolean }): void;
  /** Buttons put before Show answer (the walkthrough). */
  actions?(): HTMLElement[];
  /** Replaces "Show answer" (which would import the answer as chips the screen does not show). */
  showAnswer?(): void;
}

/** Install the challenge panel on an editor (once per page); returns its teardown. */
export function installChallenges(ed: Editor, screen?: LevelScreenHooks): { destroy(): void; check(): void; refresh(): void } {
  let ui = uis.get(ed);
  if (!ui) uis.set(ed, (ui = new ChallengeUi(ed, screen)));
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
  /** The test player, while Check's cases are played on the circuit. */
  private player: TestPlayer | null = null;
  /** The document's input values when the player opened (changing one by hand ends it). */
  private playerPins = '';
  private unsub: () => void;
  private unsubSim: () => void;

  constructor(private ed: Editor, private screen?: LevelScreenHooks) {
    if (screen) this.panel.classList.add('sb-chal-screen');
    ed.slots.bottom.append(this.panel);
    this.unsub = ed.onChange(() => this.sync());
    this.unsubSim = ed.onSimChange(() => this.player?.simChanged());
    this.sync();
  }

  destroy(): void {
    activeRule = null;
    this.closePlayer();
    this.unsub();
    this.unsubSim();
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
    if (this.player && (ed.chipId !== this.lastChip || this.inputsKey() !== this.playerPins)) {
      // Another chip, or an input changed by hand: the replay gives the circuit back first.
      this.closePlayer();
      if (ed.chipId === this.lastChip) ed.sim.reapply();
    }
    if (ed.chipId !== this.lastChip) {
      this.lastChip = ed.chipId;
      this.confirming = false;
      const lib = ch && typeof ch.allowed === 'object' ? ch.allowed : null;
      if (lib !== activeRule) {
        activeRule = lib;
        // The palette redraws only when its own key changes: the rule is not part of it.
        ed.refresh();
        ed.palette.render();
      }
      if (this.level) progress().open(this.level.id, true);
      // The level screen's palette is locked to the rule already.
      const restricted = !!ch && ch.allowed !== 'any' && !this.screen;
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
    if (this.screen) return this.renderScreen(ch, res, stale);
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
          ? h('a', { class: `sb-chal-flag${solved ? ' solved' : ''}`, href: `#/campaign/n/${lv.id}`, title: `Back to the campaign: ${actTitle(lv.act)}` }, icon(solved ? 'check' : 'flag', 13), `Campaign · ${actName(lv.act)}`)
          : h('span', { class: `sb-chal-flag${solved ? ' solved' : ''}`, title: solved ? 'Solved' : 'Challenge' }, icon(solved ? 'check' : 'flag', 13), LEVELS.find((l) => l.id === ch.level)?.title ?? ch.level),
        h('h3', null, ch.title),
        lv && lp?.stars ? h('span', { class: 'sb-chal-stars', title: `Best: ${lp.stars} of 3 stars` }, '★'.repeat(lp.stars) + '☆'.repeat(3 - lp.stars)) : null,
        h('span', { class: 'sb-chal-pins', title: 'The pins to build' }, ...pinList('in'), h('span', { class: 'arrow' }, '→'), ...pinList('out')),
        h('span', { class: `sb-chal-rule ${ruleKind(ch.allowed)}`, title: rule(ch.allowed)[1] }, rule(ch.allowed)[0]),
        // One group: when the strip is narrow it wraps as a whole, to the right of the next row.
        h('span', { class: 'sb-chal-actions' }, ...actions,
          lv ? null : h('button', { class: 'btn ghost icon-only', title: 'All challenges', 'aria-label': 'All challenges', onclick: () => this.toggleList() }, icon('menu', 15)))),
    );
    if (this.collapsed) {
      if (this.player) this.panel.append(this.player.el);
      return;
    }
    const brief = h('p', { class: 'sb-chal-brief' });
    brief.innerHTML = ch.brief;
    const body = h('div', { class: 'sb-chal-body' }, brief);
    if (lv) body.append(this.levelEl(lv));
    if (res) body.append(this.resultEl(ch, res.r, stale));
    this.panel.append(body);
    if (this.player) this.panel.append(this.player.el);
  }

  /** Redraw (the screen's buttons changed state). */
  refresh(): void {
    this.version++;
    this.render();
  }

  /** The level screen's strip: Check and its result, the walkthrough, Show answer, Do it for me. */
  private renderScreen(ch: BuildChallenge, res: { r: CheckResult } | undefined, stale: boolean): void {
    const sc = this.screen!;
    const actions = this.confirming
      ? [h('span', { class: 'sb-chal-ask' }, 'Replace your circuit with the answer?'),
        h('button', { class: 'btn sm primary', 'data-chal': 'solve-yes', onclick: () => this.solve() }, 'Replace'),
        h('button', { class: 'btn sm ghost', onclick: () => { this.confirming = false; this.render(); } }, 'Cancel')]
      : [...(sc.actions?.() ?? []),
        h('button', { class: 'btn sm ghost', 'data-chal': 'answer', title: 'The reference answer', onclick: () => (sc.showAnswer ? sc.showAnswer() : this.showAnswer()) }, 'Show answer'),
        h('button', { class: 'btn sm ghost', 'data-chal': 'solve', title: 'Replace this chip\'s circuit with the reference answer (one undo step)', onclick: () => { this.confirming = true; this.render(); } }, 'Do it for me')];
    this.panel.append(h('header', { class: 'sb-chal-head' },
      h('button', { class: 'btn sm primary', 'data-chal': 'check', title: 'Run the chip against the specification', onclick: () => this.check() }, icon('check', 14), 'Check'),
      res ? this.summaryEl(ch, res.r, stale) : h('span', { class: 'sb-chal-sum muted' }, 'Check runs every test and scores your circuit against par.'),
      h('span', { class: 'sb-chal-actions' }, ...actions)));
    if (res && (!res.r.ok || res.r.failures.length || res.r.restrictionViolations.length || coreSpecOf(ch.check))) {
      this.panel.append(h('div', { class: 'sb-chal-body' }, this.resultEl(ch, res.r, stale)));
    }
    if (this.player) this.panel.append(this.player.el);
  }

  /** One line: pass or not, and the score against par. */
  private summaryEl(ch: BuildChallenge, r: CheckResult, stale: boolean): HTMLElement {
    const lim = ch.limits ?? {};
    const item = (v: number | null | undefined, unit: string, par?: number, before = false) => {
      if (v === null || v === undefined) return null;
      const cls = par === undefined ? '' : v <= par ? 'par' : 'over';
      return h('span', { class: cls, title: cls === 'par' ? 'At or under par' : cls ? 'Over par' : '' },
        before ? `${unit} ` : null, h('b', null, v.toLocaleString()), before ? null : ` ${unit}`, par !== undefined ? h('small', null, ` par ${par}`) : null);
    };
    const lv = this.level;
    const lp = lv ? progress().get(lv.id) : undefined;
    const unit = scoreUnit(ch);
    const score = unit === 'transistors' ? [item(r.score.transistors, 'transistors', lim.maxTransistors)]
      : unit === 'devices' ? deviceItems(r, lim, item)
      : [item(r.score.nand, 'NAND', lim.maxNand), item(r.score.depth, 'depth', lim.maxDepth, true), item(r.score.period, 'period', lim.maxPeriod, true), item(r.score.cycles, 'cycles', lim.maxCycles)];
    return h('span', { class: `sb-chal-sum ${r.ok ? 'ok' : 'bad'}${stale ? ' stale' : ''}`, role: 'status' },
      r.ok ? h('b', { class: 'v' }, icon('check', 13), 'Passes') : h('b', { class: 'v' }, icon('close', 13), 'Not yet'),
      ...score,
      r.ok && lp?.stars ? h('span', { class: 'sb-chal-stars', title: `Best: ${lp.stars} of 3 stars` }, '★'.repeat(lp.stars) + '☆'.repeat(3 - lp.stars)) : null,
      stale ? h('span', { class: 'sb-chal-stale' }, 'edited since: check again') : null,
      !this.player && r.ok && r.tested && ch.check.kind !== 'custom'
        ? h('button', { class: 'btn sm ghost sb-chal-watch', 'data-chal': 'watch', title: 'Play the tests one by one on your circuit', onclick: () => this.openPlayer(ch, r, 0) }, icon('play', 12), 'Watch the tests')
        : null);
  }

  // ---- the test player ------------------------------------------------------------------------

  private inputsKey(): string {
    return JSON.stringify(this.ed.doc?.pins.filter((p) => p.dir !== 'out').map((p) => [p.id, p.value]) ?? []);
  }

  /** Play Check's cases on the circuit, from case k. */
  private openPlayer(ch: BuildChallenge, r: CheckResult, k: number): void {
    this.closePlayer();
    const set = testSet(ch);
    if (!set || !set.n) return;
    const p = new TestPlayer(this.ed, ch, set, r, () => { this.closePlayer(); this.version++; this.render(); });
    this.player = p;
    this.playerPins = this.inputsKey();
    p.goto(k);
    this.version++;
    this.render();
  }

  private closePlayer(): void {
    const p = this.player;
    if (!p) return;
    this.player = null;
    p.close();
  }

  /** A campaign level's tips (one at a time) and its way back / onward. */
  private levelEl(n: CampaignNode): HTMLElement {
    const p = progress();
    const shown = Math.min(p.get(n.id)?.tips ?? 0, tipsOf(n).length);
    const tips = h('ol', { class: 'sb-chal-tips' }, tipsOf(n).slice(0, shown).map((t) => {
      const li = h('li');
      li.innerHTML = t;
      return li;
    }));
    const next = isDone(p.view(n.id)) ? nextAvailable(p.view, p.unlockAll, n.id) : undefined;
    return h('div', { class: 'sb-chal-level' },
      shown ? tips : null,
      h('div', { class: 'sb-chal-links' },
        shown < tipsOf(n).length ? h('button', { class: 'btn sm ghost', 'data-chal': 'tip', onclick: () => { p.revealTip(n.id, tipsOf(n).length); this.version++; this.render(); } }, icon('info', 13), shown ? 'Another tip' : 'A tip') : null,
        h('a', { class: 'btn sm ghost', href: `#/campaign/n/${n.id}` }, icon('chevL', 13), 'Campaign'),
        h('a', { class: 'btn sm ghost', href: `#/campaign/play/${n.id}`, title: 'This level on its own screen: the brief, the why, the walkthrough' }, 'Level screen'),
        next ? h('a', { class: 'btn sm', href: levelChallenge(next) && !next.soon ? `#/campaign/play/${next.id}` : `#/campaign/n/${next.id}`, title: next.title }, `Next: ${next.title}`, icon('chevR', 13)) : null));
  }

  private resultEl(ch: BuildChallenge, r: CheckResult, stale: boolean): HTMLElement {
    const el = h('div', { class: `sb-chal-result ${r.ok ? 'ok' : 'bad'}${stale ? ' stale' : ''}`, role: 'status' });
    const what = ch.check.kind === 'table' ? `${r.tested} input combination${r.tested === 1 ? '' : 's'}` : ch.check.kind === 'custom' ? `${r.tested} test program${r.tested === 1 ? '' : 's'}` : `${r.tested} steps`;
    el.append(h('div', { class: 'sb-chal-verdict' },
      r.ok ? h('b', null, icon('check', 14), 'Passes') : h('b', null, icon('close', 14), 'Not yet'),
      h('span', null, r.ok ? `all ${what} correct` : r.tested ? `checked ${what}` : 'not simulated'),
      stale ? h('span', { class: 'sb-chal-stale' }, 'edited since: check again') : null,
      !this.player && r.tested && ch.check.kind !== 'custom'
        ? h('button', { class: 'btn sm ghost sb-chal-watch', 'data-chal': 'watch', title: 'Play the tests one by one on your circuit: step, scrub, jump to failures',
          onclick: () => this.openPlayer(ch, r, r.failed?.[0] ?? 0) }, icon('play', 12), r.ok ? 'Watch the tests' : 'Watch the failing test')
        : null,
      fsmOf(ch.fsm) ? h('button', { class: 'btn sm ghost', 'data-chal': 'states', title: 'Your circuit read back as a state machine, over the target diagram', onclick: () => this.showStates(ch) }, 'State diagram') : null));
    if (r.failures.length || r.restrictionViolations.length || !r.ok) el.append(this.problems(r, ch));
    const progs = this.programsEl(ch, r);
    if (progs) el.append(progs);
    el.append(this.scoreEl(ch, r));
    return el;
  }

  /** A core level: every test program, failing ones first; each can be watched on a bench around this core. */
  private programsEl(ch: BuildChallenge, r: CheckResult): HTMLElement | null {
    const spec = coreSpecOf(ch.check);
    if (!spec || !r.tested || !r.failed) return null;
    const bad = new Set(r.failed);
    const tests = spec.tests().map((t, i) => ({ t, bad: bad.has(i) }));
    tests.sort((a, b) => Number(b.bad) - Number(a.bad));
    const what = spec.lanes ? `a data memory with a port per lane${spec.raster ? ', the screen' : ''}` : 'a RAM and LEDs';
    return h('div', { class: 'sb-tp-progs' },
      h('span', { class: 'sb-tp-progs-h', title: `Each opens a new chip: the program in a ROM, your core, ${what}, with the CPU panel running it against the golden model` }, 'Watch a program run:'),
      // a core that runs every RV16I program it was given: a game on it, on the bench with a screen and switches
      r.ok && spec.rv16i && !spec.lanes
        ? h('button', { class: 'sb-tp-prog pong', 'data-chal': 'pong', title: 'A new chip: Pong in a ROM, your core, a RAM, LEDs, eight switches and a 32 × 32 screen; the CPU panel checks every write against the golden model while you play', onclick: () => this.pong() },
          icon('play', 11), 'Play Pong on your core')
        : null,
      tests.map(({ t, bad: b }) => h('button', { class: `sb-tp-prog${b ? ' bad' : ''}`, 'data-chal': 'program', title: `${b ? 'Fails' : 'Passes'}: open “${t.name}” on a bench around your core`, onclick: () => this.debug(t) },
        icon(b ? 'close' : 'check', 11), t.name)));
  }

  private problems(r: CheckResult, ch: BuildChallenge): HTMLElement {
    const box = h('div', { class: 'sb-chal-problems' });
    if (r.failures.length) box.append(h('ul', { class: 'sb-chal-fails' }, r.failures.map((f) => h('li', null, f))));
    // A core level: open the first failing program as a computer around this core, with the CPU panel.
    const spec = coreSpecOf(ch.check);
    const t = spec && r.failures.length ? failingTest(spec, r.failures[0]) : null;
    if (t) {
      box.append(h('button', { class: 'sb-chal-apply', 'data-chal': 'bench', title: `A new chip: this program in a ROM, your core, ${spec?.lanes ? 'a data memory with a port per lane' : 'a RAM and LEDs'}; the CPU panel runs it against the golden model and stops at the first wrong write`, onclick: () => this.debug(t) },
        icon('code', 13), `Debug “${t.name}” in the sandbox`));
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
    const unit = scoreUnit(ch);
    const parts = unit === 'transistors'
      ? [item(r.score.transistors, 'transistors', lim.maxTransistors)]
      : unit === 'devices' ? deviceItems(r, lim, item)
      : [item(r.score.nand, 'NAND', lim.maxNand), r.score.depth !== null ? item(r.score.depth, 'depth', lim.maxDepth, true) : null,
        period !== undefined && period !== null ? item(period, 'period', lim.maxPeriod, true) : null,
        r.score.cycles !== undefined ? item(r.score.cycles, 'cycles', lim.maxCycles) : null,
        h('span', null, h('b', null, r.score.transistors.toLocaleString()), ' transistors')];
    return h('p', { class: 'sb-chal-score' }, ...parts);
  }

  check(): void {
    const ed = this.ed;
    const ch = this.challenge;
    if (!ch) return;
    // Check's own simulators are separate; the player's replay is given back first all the same,
    // so a new result never opens over an old replay.
    this.closePlayer();
    const r = checkChallenge(ch, ed.compiled);
    // the truth-table and state-machine builders would hand in the answer here (challenges.ts builderViolations)
    const locked = builderViolations(ed.ws, [ed.chipId, ...ed.lib.deps(ed.chipId)], ch);
    if (locked.length) { r.restrictionViolations.push(...locked); r.ok = false; }
    this.results.set(ed.chipId, { r, conn: ed.compiled?.connKey ?? '' });
    this.version++;
    this.collapsed = false;
    const lv = this.level;
    if (r.ok && lv) {
      const g = progress().solve(lv.id, measured(r.score));
      const st = '★'.repeat(g.stars) + '☆'.repeat(3 - g.stars);
      if (this.screen) this.screen.checked(r, g);
      else ed.toast(`${g.first ? 'Solved' : 'Passes'}: ${ch.title} ${st}${g.best && !g.first ? ' (new best)' : ''}`);
    } else if (r.ok) {
      const first = !settings.isSolved(solvedKey(ch));
      settings.solve(solvedKey(ch));
      ed.toast(first ? `Solved: ${ch.title}` : `Still passes: ${ch.title}`);
    }
    if (!r.ok) this.screen?.checked(r);
    if (paneShown(ed, 'fsm-states')) this.showStates(ch);
    // A failure opens the player on the first failing test: the circuit shows it.
    if (!r.ok && r.failed?.length && ch.check.kind !== 'custom') this.openPlayer(ch, r, r.failed[0]);
    else this.render();
    if (this.drawer) this.renderList();
  }

  private debug(t: NonNullable<ReturnType<typeof failingTest>>): void {
    const ed = this.ed;
    const core = ed.compiled?.def, coreId = ed.chipId;
    const spec = this.challenge ? coreSpecOf(this.challenge.check) : null;
    if (!core) return;
    let err = '';
    ed.editWs((ws) => {
      const b = spec?.lanes ? addLaneBench(ws, core, coreId, t, spec) : addBench(ws, core, coreId, t);
      if ('error' in b) { err = b.error; return ws; }
      return b.ws;
    });
    // The level screen shows only the level's chips: the bench opens in the full sandbox.
    if (!err && this.screen) location.hash = `#/sandbox/${ed.chipId}`;
    else ed.toast(err ? `Cannot build the bench: ${err}` : `New chip “${ed.doc.name}”: Run to halt in the CPU panel (Ctrl+Z removes it)`);
  }

  /** Pong on a bench around this core (a passing RV16I core level). */
  private pong(): void {
    const ed = this.ed;
    const core = ed.compiled?.def, coreId = ed.chipId;
    if (!core) return;
    let err = '';
    ed.editWs((ws) => {
      const b = addPongBench(ws, core, coreId);
      if ('error' in b) { err = b.error; return ws; }
      return b.ws;
    });
    if (!err && this.screen) location.hash = `#/sandbox/${ed.chipId}`;
    else ed.toast(err ? `Cannot build the bench: ${err}` : `New chip “${ed.doc.name}”: Run, then switches 7 and 6 move your paddle (Ctrl+Z removes it)`);
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
    this.closePlayer();
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

  /** The state-machine read-back drawer (a state-machine challenge): opened from the result, redrawn by Check. */
  private showStates(ch: BuildChallenge): void {
    const spec = fsmOf(ch.fsm);
    if (!spec) return;
    const close = () => undockPane(this.ed, 'fsm-states');
    const c = this.ed.compiled;
    const el = h('aside', { class: 'sb-drawer sb-fsm-drawer', 'aria-label': 'State diagram' },
      h('div', { class: 'sb-drawer-head' }, icon('flag', 15), h('h3', null, `${spec.title}: your circuit`),
        h('button', { class: 'btn ghost icon-only', title: 'Close', 'aria-label': 'Close the state diagram', onclick: close }, icon('close', 15))),
      readbackEl(spec, c?.def, c?.mode === 'switch' ? 'switch' : 'gate'));
    dockPane(this.ed, { id: 'fsm-states', label: 'States', icon: 'flag', el, width: 460 });
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
