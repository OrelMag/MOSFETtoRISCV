// The Campaign page (#/campaign[/intro | /n/<node> | /codex[/<entry>]]): the map of levels, a
// level's panel (why, the test set, tips, codex, Start / Skip / Show solution), the CPU anatomy
// intro and the codex. Loaded on demand (app.ts imports it dynamically). Levels are played on the
// level screen (pages/level.ts): Play writes the level's chip into the saved workspace and opens
// #/campaign/play/<node>.

import '../../styles/campaign.css';
// The level screen's chips, bars and diagram frame, shared by the full codex entry.
import '../../styles/level.css';
import { BLOCKS, blockNodes } from '../../campaign/anatomy';
import { CODEX, CODEX_KINDS, codexById } from '../../campaign/codex';
import { type Datasheet, datasheetOf, datasheets } from '../../campaign/datasheet';
import type { CodexMore } from '../../campaign/codexmore';
import { CODEX_ORDER, plainSummary } from '../../campaign/codexlinks';
import type { Quiz } from '../../chapters/types';
import { codexEntryEl } from '../../campaign/ui/codexentry';
import { ancestors, dependents, isDone, nextAvailable, statusOf } from '../../campaign/graph';
import { LESSONS } from '../../campaign/lessons';
import { levelChallenge, levelChipId, startCandidates, startFrom } from '../../campaign/levels';
import { ACTS, actName, NODES, nodeById } from '../../campaign/nodes';
import { exportCampaign, importCampaign, progress } from '../../campaign/progress';
import type { CampaignNode } from '../../campaign/types';
import { PUZZLES } from '../../campaign/puzzles';
import { drillCard } from '../../campaign/ui/drillui';
import { puzzleCard } from '../../campaign/ui/puzzleui';
import { criteria, gradeTable } from '../../campaign/ui/levelinfo';
import { foldedActs, mapColsFor } from '../../campaign/layout';
import { anatomySvg, mapSvg } from '../../campaign/ui/svgs';
import { KIND_LABEL, partNames, STATUS_LABEL } from '../../campaign/cardlabel';
import { type BuildChallenge, importAnswer, startChallenge } from '../../editor/challenges';
import { loadWorkspace, saveWorkspace } from '../../editor/store';
import { resolveComponent } from '../../lib/resolve';
import { h, icon } from '../dom';
import { settings } from '../settings';
import type { Page } from './chapter';
import { tipsOf } from '../../campaign/nudges';

const html = (tag: 'div' | 'p' | 'span', cls: string, content: string) => {
  const el = h(tag, { class: cls });
  el.innerHTML = content;
  return el;
};

/**
 * Before `root` is redrawn: a function that puts the focus back on the redrawn twin of what had it (the
 * page is rebuilt on every selection and progress change: Enter on a map card or Skip in the panel would
 * otherwise drop a keyboard user at the top of the page). A map card, act button or diagram block by its
 * id; a panel button or link by its text, else the selected card. `selected`: the level the redraw selects;
 * a card that had the focus but is no longer selected (another level opened by a link) hands it to that one,
 * else the old card kept its focus ring beside the new selection.
 */
function keepFocus(root: HTMLElement, selected?: string): () => void {
  const a = document.activeElement;
  if (!(a instanceof HTMLElement || a instanceof SVGElement) || !root.contains(a)) return () => {};
  let sel = (['node', 'act', 'block'] as const).map((k) => [k, a.getAttribute(`data-${k}`)] as const).find(([, v]) => v !== null);
  if (sel?.[0] === 'node' && selected !== undefined && sel[1] !== selected) sel = ['node', selected];
  const text = a.matches('button, a') ? a.textContent : null;
  return () => {
    if (document.activeElement !== document.body && document.activeElement !== null) return; // something took it already
    const el = sel
      ? root.querySelector<SVGElement>(`[data-${sel[0]}="${CSS.escape(sel[1]!)}"][tabindex]`)
      : [...root.querySelectorAll<HTMLElement>('button, a')].find((b) => b.textContent === text) ?? root.querySelector<SVGElement>('.cp-node.sel');
    el?.focus({ preventScroll: true });
  };
}

export class CampaignPage implements Page {
  /** The fuller codex (loaded on the first visit to an entry). */
  private moreOf: ((id: string) => CodexMore | undefined) | undefined;
  private checkOf: (id: string) => Quiz[] = () => [];
  /** The codex list's search text and kind filter, kept across entries. */
  private cxQuery = '';
  private cxKind = '';
  /** A narrow screen: the codex list folded under the open entry (a button opens it). */
  private cxListOpen = false;
  /** Until when a map redraw (its columns found) should bring the selected level into view again. */
  private revealUntil = 0;
  readonly kind = 'campaign';
  readonly el: HTMLElement;
  private main = h('div', { class: 'cp-main' });
  private head = h('header', { class: 'cp-head' });
  private note = h('span', { class: 'cp-note', role: 'status', 'aria-live': 'polite' });
  private parts: string[] = [];
  private unsub: () => void;
  private mapScroll: { left: number; top: number } | null = null;
  /** Columns the map was last drawn with: as many as its pane holds (wider acts wrap), redrawn when that changes. */
  private mapCols = Infinity;
  private mapFit: ResizeObserver | null = null;
  /** The route last drawn (parts joined). */
  private drawn = '';
  /** Drill and puzzle cards keep their state (question, count, code) while the page redraws around them. */
  private cards = new Map<string, HTMLElement>();

  constructor(parts: string[]) {
    progress().reload();
    this.el = h('div', { class: 'scroll cp-page' }, h('div', { class: 'cp-wrap' }, this.head, this.main));
    this.unsub = progress().onChange(() => this.render());
    this.open(parts);
  }

  open(parts: string[]): void {
    this.parts = parts;
    this.render();
  }

  destroy(): void {
    this.mapFit?.disconnect();
    this.unsub();
  }

  private render(): void {
    const sc = this.main.querySelector<HTMLElement>('.cp-map-scroll');
    if (sc) this.mapScroll = { left: sc.scrollLeft, top: sc.scrollTop };
    // The level panel redrawn for the same level (a tip shown, Done reading) keeps its place in the text.
    const route = this.parts.join('/');
    const changed = route !== this.drawn;
    const panelTop = changed ? 0 : this.main.querySelector<HTMLElement>('.cp-panel')?.scrollTop ?? 0;
    this.drawn = route;
    const [a, b] = this.parts;
    const refocus = keepFocus(this.main, a === 'n' ? b : undefined);
    this.renderHead();
    if (changed) this.cxListOpen = false;
    if (a === 'intro') this.main.replaceChildren(this.introView());
    else if (a === 'codex') this.main.replaceChildren(this.codexView(b));
    else this.main.replaceChildren(this.mapView(a === 'n' ? b : undefined));
    const sc2 = this.main.querySelector<HTMLElement>('.cp-map-scroll');
    if (sc2 && this.mapScroll) {
      sc2.scrollLeft = this.mapScroll.left;
      sc2.scrollTop = this.mapScroll.top;
    }
    const panel = this.main.querySelector<HTMLElement>('.cp-panel');
    if (panel && panelTop) panel.scrollTop = panelTop;
    refocus();
    if (changed && b) {
      this.revealUntil = performance.now() + 1000;
      requestAnimationFrame(() => (a === 'codex' ? this.revealEntry() : this.reveal()));
    }
  }

  /**
   * A level opened (a click, a link, a URL): its card scrolled into the map's view unless it is in view already
   * (a click on a visible card does not move the map); on a narrow screen, where the panel sits under the map,
   * the page scrolled to the panel unless its heading shows (it was under the fold and the sticky action bar).
   */
  private reveal(): void {
    const sc = this.main.querySelector<HTMLElement>('.cp-map-scroll');
    const node = sc?.querySelector<SVGGraphicsElement>('.cp-node.sel');
    if (!sc || !node) return;
    const behavior: ScrollBehavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    const r = node.getBoundingClientRect(), v = sc.getBoundingClientRect();
    if (r.top < v.top || r.bottom > v.bottom || r.left < v.left || r.right > v.right) {
      sc.scrollTo({ top: sc.scrollTop + r.top - v.top - (v.height - r.height) / 2, left: sc.scrollLeft + r.left - v.left - (v.width - r.width) / 2, behavior });
    }
    const head = this.main.querySelector<HTMLElement>('.cp-node-panel h2');
    if (head && matchMedia('(max-width: 1000px)').matches) {
      const hr = head.getBoundingClientRect(), bar = this.main.querySelector<HTMLElement>('.cp-node-actions.sticky')?.offsetHeight ?? 0;
      if (hr.top < 0 || hr.bottom > innerHeight - bar) (head.closest<HTMLElement>('.cp-panel') ?? head).scrollIntoView({ block: 'start', behavior });
    }
  }

  /** A codex entry opened: its top in view (on a narrow screen it may have been opened from far down the list). */
  private revealEntry(): void {
    const top = this.main.querySelector<HTMLElement>('.cp-codex-entry')?.getBoundingClientRect().top;
    if (top !== undefined && (top < 0 || top > innerHeight * 0.6)) this.main.querySelector<HTMLElement>('.cp-codex-entry')!.scrollIntoView({ block: 'start' });
  }

  // ---- header ---------------------------------------------------------------------------------

  private renderHead(): void {
    const p = progress();
    const sum = p.summary();
    const view = this.parts[0] ?? '';
    const tab = (href: string, label: string, on: boolean, ic: string) => h('a', { class: `cp-tab${on ? ' on' : ''}`, href }, icon(ic, 15), label);
    const unlock = h('label', { class: 'cp-unlock', title: 'Open every level, whatever you have solved (the parts each level may use do not change)' },
      h('input', { type: 'checkbox', ...(p.unlockAll ? { checked: true } : {}), onchange: (e: Event) => p.setUnlockAll((e.target as HTMLInputElement).checked) }),
      'Unlock all');
    const file = h('input', { type: 'file', accept: '.json,application/json', hidden: true }) as HTMLInputElement;
    file.addEventListener('change', () => {
      const f = file.files?.[0];
      if (f) void f.text().then((t) => this.importText(t));
      file.value = '';
    });
    this.head.replaceChildren(
      h('div', { class: 'cp-title' },
        h('h1', null, 'Campaign'),
        h('p', null, 'From a transistor NAND to a pipelined 16-bit RISC-V processor, one block at a time.')),
      h('div', { class: 'cp-stats' },
        h('span', null, h('b', null, `${sum.requiredDone}/${sum.required}`), ' required levels'),
        h('span', null, h('b', null, `${sum.done}`), ' done in all'),
        h('span', null, h('b', { class: 'cp-star' }, `★ ${sum.stars}`), `/${sum.maxStars}`)),
      h('nav', { class: 'cp-tabs' },
        tab('#/campaign', 'Map', view === '' || view === 'n', 'layers'),
        tab('#/campaign/intro', 'The CPU', view === 'intro', 'chip'),
        tab('#/campaign/codex', 'Codex', view === 'codex', 'book')),
      h('div', { class: 'cp-actions' }, unlock,
        h('button', { class: 'btn sm ghost', title: 'Your progress and your level chips, as one .json file', onclick: () => this.exportFile() }, 'Export'),
        h('button', { class: 'btn sm ghost', title: 'Merge a campaign file into your progress (your chips are never overwritten)', onclick: () => file.click() }, 'Import'),
        file, this.note));
  }

  private say(msg: string): void {
    this.note.textContent = msg;
    setTimeout(() => { if (this.note.textContent === msg) this.note.textContent = ''; }, 6000);
  }

  private exportFile(): void {
    const text = exportCampaign(progress().state, loadWorkspace());
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: `campaign-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    this.say('Exported');
  }

  private importText(text: string): void {
    const r = importCampaign(text, progress().state, loadWorkspace());
    if ('error' in r) return this.say(`Import failed: ${r.error}`);
    const saved = saveWorkspace(r.ws);
    if (!saved.ok) return this.say(`Import failed: ${saved.reason}`);
    progress().replace(r.state);
    this.say(`Imported: progress merged, ${r.chips.added.length} chip${r.chips.added.length === 1 ? '' : 's'} added`);
  }

  // ---- map + level panel ----------------------------------------------------------------------

  private mapView(selected: string | undefined): HTMLElement {
    const p = progress();
    const sel = selected ? nodeById(selected) : undefined;
    // Optional acts fold to a header line (Act P would push act 1 down), as the learner last left them.
    const folded = foldedActs(p.view, (a) => settings.actOpen(a), sel?.id);
    const fold = (act: number, f: boolean) => {
      settings.setActOpen(act, !f);
      // the selected level keeps its act open: folding that act leaves the level
      if (f && sel?.act === act) { location.hash = '#/campaign'; return; }
      this.render();
      this.main.querySelector<SVGElement>(`.cp-fold[data-act="${act}"]`)?.focus();
    };
    const draw = (cols: number) => mapSvg(p.view, p.unlockAll, sel?.id, (id) => { location.hash = `#/campaign/n/${id}`; }, cols, folded, fold);
    const legend = h('div', { class: 'cp-legend' },
      h('span', { class: 'l available' }, 'available'), h('span', { class: 'l solved' }, 'solved'), h('span', { class: 'l skipped' }, 'skipped'),
      h('span', { class: 'l locked' }, 'locked'), h('span', { class: 'l opt' }, 'optional'), NODES.some((n) => n.soon) ? h('span', { class: 'l soon' }, 'coming soon') : null,
      h('span', { class: 'l port', title: 'Lines between acts are drawn for the level you point at or select' }, 'builds on earlier acts (point at it)'));
    const scroll = h('div', { class: 'cp-map-scroll' }, draw(this.mapCols));
    this.mapFit?.disconnect();
    this.mapFit = new ResizeObserver(() => {
      const cols = mapColsFor(scroll.clientWidth);
      if (scroll.clientWidth <= 0 || cols === this.mapCols) return;
      this.mapCols = cols;
      const refocus = keepFocus(scroll);
      scroll.replaceChildren(draw(cols));
      refocus();
      // the first draw guessed the columns: the selected level moved
      if (performance.now() < this.revealUntil) this.reveal();
    });
    this.mapFit.observe(scroll);
    return h('div', { class: 'cp-split' },
      h('section', { class: 'cp-map-pane' }, legend, scroll),
      h('aside', { class: 'cp-panel' }, sel ? this.nodePanel(sel) : this.welcome()));
  }

  private welcome(): HTMLElement {
    const p = progress();
    const next = nextAvailable(p.view, p.unlockAll);
    return h('div', { class: 'cp-welcome' },
      h('h2', null, p.summary().done ? 'Welcome back' : 'Start here'),
      h('p', null, 'Each level builds one block of a processor from the blocks before it. Pick a level on the map, or continue with the next one.'),
      next ? h('a', { class: 'btn primary', href: `#/campaign/n/${next.id}` }, `${p.summary().done ? 'Continue' : 'Begin'}: ${next.title}`, icon('chevR', 16)) : null,
      h('h3', null, 'Acts'),
      h('ul', { class: 'cp-acts' }, ACTS.map((a) => h('li', null, h('b', null, `${actName(a.num)} · ${a.title}`), html('span', 'sub', ` — ${a.blurb}`)))));
  }

  private nodePanel(n: CampaignNode): HTMLElement {
    const p = progress();
    if (!n.soon) p.open(n.id);
    const st = statusOf(n, p.view, p.unlockAll);
    const np = p.get(n.id);
    const ch = levelChallenge(n);
    const act = ACTS.find((a) => a.num === n.act)!;
    const el = h('div', { class: `cp-node-panel ${st}` });
    el.append(
      h('div', { class: 'cp-crumb' }, h('a', { href: '#/campaign' }, 'Map'), ' › ', `${actName(act.num)}: ${act.title}`),
      h('h2', null, n.title),
      h('div', { class: 'cp-badges' },
        h('span', { class: 'cp-badge kind' }, KIND_LABEL[n.kind]),
        n.optional ? h('span', { class: 'cp-badge opt' }, 'optional') : null,
        n.soon ? h('span', { class: 'cp-badge soon' }, 'coming soon') : h('span', { class: `cp-badge st ${st}` }, STATUS_LABEL[st]),
        np?.stars ? h('span', { class: 'cp-badge stars', title: 'Best result' }, '★'.repeat(np.stars) + '☆'.repeat(3 - np.stars)) : null),
      h('div', { class: 'cp-why' }, h('h4', null, 'Why you need it'), html('p', '', n.why)));

    if (n.id === 'intro') {
      el.append(h('a', { class: 'cp-mini-anatomy', href: '#/campaign/intro', title: 'Open the full diagram', 'aria-label': 'The CPU: open the full block diagram' }, anatomySvg(p.view, undefined)));
    }
    if (n.body && LESSONS[n.body]) el.append(html('div', 'cp-lesson', LESSONS[n.body]));
    if (ch) el.append(h('div', { class: 'cp-brief' }, h('h4', null, 'The task'), html('p', '', ch.brief)));
    if (n.kind === 'drill' && n.drill && !n.soon && st !== 'locked') {
      let card = this.cards.get(n.id);
      if (!card) this.cards.set(n.id, (card = drillCard(n)));
      el.append(h('div', { class: 'cp-drill-wrap' }, h('h4', null, 'Practice'), card));
    }
    const pz = n.kind === 'program' && !n.soon ? PUZZLES[n.id] : undefined;
    if (pz) {
      el.append(h('div', { class: 'cp-brief' }, h('h4', null, 'The task'), html('p', '', pz.brief)),
        h('div', { class: 'cp-criteria' }, h('h4', null, 'Success criteria'),
          h('ul', null, h('li', null, pz.lanes && pz.warps
            ? `${pz.tests().length} tests on the two-warp golden model (${pz.warps} warps of ${pz.lanes} lanes taking turns, one shared memory); each must end within ${pz.maxSteps.toLocaleString()} cycles with the expected memory, and again with warp ${pz.warps - 1} running ahead.`
            : pz.lanes
            ? `${pz.tests().length} tests on the lane golden model (${pz.lanes} lanes, one shared memory); each must halt within ${pz.maxSteps.toLocaleString()} warp instructions with the expected memory.`
            : `${pz.tests().length} tests on the golden model; each must halt within ${pz.maxSteps.toLocaleString()} ${pz.dma ? 'cycles (flash stalls included)' : 'instructions'} with the expected output.`),
            pz.tests().map((t) => h('li', null, t.name)))));
      if (st !== 'locked') {
        let card = this.cards.get(n.id);
        if (!card) this.cards.set(n.id, (card = puzzleCard(n)));
        el.append(h('div', { class: 'cp-drill-wrap' }, h('h4', null, 'Your program'), card));
      }
    }

    if (n.kind === 'drill' && n.par?.mistakes !== undefined) {
      el.append(h('div', { class: 'cp-grade' }, h('h4', null, 'Grading'),
        h('p', { class: 'sub' }, `Passed after the required number of correct answers. ★★★ with at most ${n.par.mistakes} mistakes (a shown answer counts as one), ★★ with at most ${Math.floor(n.par.mistakes * 1.5)}.`)));
    }
    if (pz) el.append(gradeTable(n));
    // Success criteria and grading.
    if (ch) {
      el.append(h('div', { class: 'cp-criteria' }, h('h4', null, 'Success criteria'),
        h('ul', null, criteria(ch).map((c) => h('li', null, c)))));
      el.append(gradeTable(n));
    }

    // What it builds on, what it unlocks.
    const req = n.requires.map((r) => nodeById(r)).filter((x): x is CampaignNode => !!x);
    const unlocks = partNames(n.unlocks ?? [], (u) => resolveComponent(u)?.name);
    const rule = ch && typeof ch.allowed === 'object' ? ch.allowed.lib.filter((x) => x !== 'nand') : [];
    el.append(h('div', { class: 'cp-deps' },
      req.length ? h('p', null, h('b', null, 'Builds on: '), req.map((r, i) => [i ? ', ' : '', h('a', { href: `#/campaign/n/${r.id}`, class: isDone(p.view(r.id)) ? 'done' : '' }, r.title)])) : null,
      rule.length ? h('p', null, h('b', null, 'Parts you may place: '), 'NAND, ', partNames(rule, (u) => resolveComponent(u)?.name).join(', ')) : null,
      unlocks.length ? h('p', null, h('b', null, 'Unlocks: '), unlocks.join(', ')) : null,
      dependents(n.id).length ? h('p', null, h('b', null, 'Leads to: '), dependents(n.id).map((d, i) => [i ? ', ' : '', h('a', { href: `#/campaign/n/${d.id}` }, d.title)])) : null));

    // Tips, one at a time.
    if (tipsOf(n).length && !n.soon) {
      const shown = Math.min(np?.tips ?? 0, tipsOf(n).length);
      el.append(h('div', { class: 'cp-tips' }, h('h4', null, 'Tips'),
        shown ? h('ol', null, tipsOf(n).slice(0, shown).map((t) => { const li = h('li'); li.innerHTML = t; return li; })) : null,
        shown < tipsOf(n).length ? h('button', { class: 'btn sm ghost', onclick: () => p.revealTip(n.id, tipsOf(n).length) }, icon('info', 14), shown ? 'Another tip' : 'Show a tip') : null));
    }

    // Codex and chapters.
    const unlocked = p.codexUnlocked();
    if (n.codex.length) {
      el.append(h('div', { class: 'cp-codex-chips' }, h('h4', null, 'Codex'),
        n.codex.map((c) => {
          const e = codexById(c);
          if (!e) return null;
          return unlocked.has(c) ? h('a', { class: 'cp-chip', href: `#/campaign/codex/${c}` }, e.title) : h('span', { class: 'cp-chip locked', title: 'Unlocks when you finish this level' }, e.title);
        })));
    }
    if (n.chapters?.length) {
      el.append(h('div', { class: 'cp-chapters' }, h('h4', null, 'Go deeper'),
        n.chapters.map((c) => h('a', { class: 'cp-chip', href: `#/c/${c.chapter}/${c.step ?? 0}` }, icon('book', 13), c.label))));
    }
    el.append(this.actions(n, st, ch));
    return el;
  }

  private actions(n: CampaignNode, st: ReturnType<typeof statusOf>, ch: BuildChallenge | undefined): HTMLElement {
    const p = progress();
    const bar = h('div', { class: 'cp-node-actions' });
    if (n.soon) {
      bar.append(h('p', { class: 'sub' }, 'This level is being built (see docs/CAMPAIGN.md). You can skip it so that what follows opens.'));
      if (st !== 'skipped' && st !== 'solved') bar.append(h('button', { class: 'btn', onclick: () => p.skip(n.id) }, 'Skip'));
      return bar;
    }
    if (st === 'locked') {
      const missing = n.requires.filter((r) => !isDone(p.view(r))).map((r) => nodeById(r)?.title ?? r);
      bar.append(h('p', { class: 'sub' }, `Finish or skip first: ${missing.join(', ')}. Or tick Unlock all.`));
      return bar;
    }
    if (n.kind === 'lesson') {
      bar.append(st === 'solved'
        ? h('span', { class: 'cp-done' }, icon('check', 15), 'Read')
        : h('button', { class: 'btn primary', onclick: () => {
          p.solve(n.id);
          // the panel redrew: keyboard focus goes to the way on (Next), not back to the top of the page
          this.main.querySelector<HTMLElement>('.cp-next')?.focus({ preventScroll: true });
        } }, icon('check', 15), 'Done reading'));
      if (n.id === 'intro') bar.append(h('a', { class: 'btn', href: '#/campaign/intro' }, 'The full diagram'));
    } else if (ch) {
      const chip = levelChipId(n);
      const exists = !!loadWorkspace().chips[chip];
      bar.append(h('button', { class: 'btn primary', onclick: () => this.start(n, ch) }, icon('play', 14), exists ? 'Continue' : 'Play'));
      if (exists) bar.append(h('a', { class: 'btn ghost', href: `#/sandbox/${chip}`, title: 'The same chip in the full sandbox editor' }, 'Open in sandbox'));
      // A core level: start from a copy of the core you built for an earlier level.
      const from = exists ? undefined : startCandidates(n, loadWorkspace())[0];
      if (from) bar.append(h('button', { class: 'btn', title: `A copy of your “${from.title}” chip, with this level's pins added`, onclick: () => this.start(n, ch, levelChipId(from)) }, `Start from ${from.title}`));
      bar.append(h('button', { class: 'btn', title: 'Import the reference solution as new chips and open it in the sandbox', onclick: () => this.solution(ch) }, 'Show solution'));
    }
    if (n.kind !== 'lesson' && st !== 'solved') {
      bar.append(st === 'skipped'
        ? h('button', { class: 'btn ghost', title: 'Back to unfinished', onclick: () => p.unskip(n.id) }, 'Un-skip')
        : h('button', { class: 'btn ghost', title: 'Count this level as done: its part unlocks (the reference solution stands in for yours)', onclick: () => p.skip(n.id) }, 'Skip'));
    }
    const next = isDone(p.view(n.id)) ? nextAvailable(p.view, p.unlockAll, n.id) : undefined;
    // the main action once nothing else is (a lesson read, a drill passed): where to go next
    if (next) {
      const main = !bar.querySelector('.btn.primary');
      const go = h('a', { class: `btn ${main ? 'primary' : 'ghost'} cp-next`, href: `#/campaign/n/${next.id}` }, `Next: ${next.title}`, icon('chevR', 14));
      // a read lesson: right after its tick, before the lesson's extras
      if (main && n.kind === 'lesson') bar.insertBefore(go, bar.children[1] ?? null);
      else bar.append(go);
    }
    // sticky (campaign.css) only with a main action to keep in reach: a drill's lone Skip stays at the end
    bar.classList.toggle('sticky', !!bar.querySelector('.btn.primary'));
    return bar;
  }

  private start(n: CampaignNode, ch: BuildChallenge, from?: string): void {
    const r = from ? startFrom(loadWorkspace(), ch, from) : startChallenge(loadWorkspace(), ch);
    const saved = saveWorkspace(r.ws);
    if (!saved.ok) return this.say(saved.reason);
    progress().open(n.id, true);
    location.hash = `#/campaign/play/${n.id}`;
  }

  private solution(ch: BuildChallenge): void {
    const r = importAnswer(loadWorkspace(), ch);
    const saved = saveWorkspace(r.ws);
    if (!saved.ok) return this.say(saved.reason);
    location.hash = `#/sandbox/${r.main}`;
  }

  // ---- intro: the CPU anatomy -------------------------------------------------------------------

  private introView(): HTMLElement {
    const p = progress();
    const by = blockNodes();
    // read out when a block is picked (the diagram stays where it is)
    const info = h('div', { class: 'cp-block-info', 'aria-live': 'polite' });
    const pick = (id: string) => {
      const b = BLOCKS.find((x) => x.id === id);
      if (!b) return;
      for (const g of svgWrap.querySelectorAll('.cp-block')) {
        const on = (g as SVGElement).dataset.block === id;
        g.classList.toggle('sel', on);
        if (on) g.setAttribute('aria-current', 'true');
        else g.removeAttribute('aria-current');
      }
      const ns = (by.get(id) ?? []).map((x) => nodeById(x)).filter((x): x is CampaignNode => !!x);
      const all = new Set<string>();
      for (const x of ns) {
        all.add(x.id);
        ancestors(x.id).forEach((a) => all.add(a));
      }
      const doneCount = [...all].filter((a) => isDone(p.view(a))).length;
      info.replaceChildren(h('div', null, h('h3', null, b.label), html('p', '', b.why),
        ns.length ? h('p', null, h('b', null, 'Built in: '), ns.map((x, i) => [i ? ', ' : '', h('a', { href: `#/campaign/n/${x.id}` }, x.title)])) : null,
        all.size ? h('p', { class: 'sub' }, `${doneCount} of the ${all.size} levels leading to it done.`) : null));
    };
    const svgWrap = h('div', { class: 'cp-anatomy-wrap' }, anatomySvg(p.view, undefined, pick));
    info.append(h('p', { class: 'sub' }, 'Click a block: what it does, and the levels that build it.'));
    const intro = nodeById('intro')!;
    return h('div', { class: 'cp-intro' },
      h('div', { class: 'cp-intro-top' }, svgWrap, info),
      html('div', 'cp-lesson', LESSONS.intro),
      h('div', { class: 'cp-node-actions' },
        statusOf(intro, p.view, p.unlockAll) !== 'solved' ? h('button', { class: 'btn primary', onclick: () => { p.solve('intro'); location.hash = '#/campaign'; } }, 'Got it: to the map', icon('chevR', 15))
          : h('a', { class: 'btn primary', href: '#/campaign' }, 'To the map', icon('chevR', 15))));
  }

  // ---- codex ----------------------------------------------------------------------------------

  private codexView(sel: string | undefined): HTMLElement {
    const p = progress();
    const unlocked = p.codexUnlocked();
    const foundIn = (id: string) => NODES.filter((n) => n.codex.includes(id));
    // Search (titles first, then summaries) and a kind filter, applied in place and kept across entries.
    const search = h('input', { class: 'cx-search', type: 'search', placeholder: `Search ${CODEX.length} entries`, 'aria-label': 'Search the codex', value: this.cxQuery });
    const kinds = h('div', { class: 'cx-kinds' }, [{ id: '', title: 'All' }, ...CODEX_KINDS].map((k) =>
      h('button', { class: `cx-kind${this.cxKind === k.id ? ' on' : ''}`, 'data-k': k.id, onclick: () => { this.cxKind = k.id; filter(); } }, k.title)));
    const empty = h('p', { class: 'sub', hidden: true }, 'No entry matches.');
    const groups = CODEX_KINDS.map((k) => {
      const items = CODEX_ORDER.filter((e) => e.kind === k.id).map((e) => {
        const li = h('li', { 'data-id': e.id, 'data-k': e.kind, 'data-t': e.title.toLowerCase(), 'data-s': plainSummary(e).toLowerCase() }, unlocked.has(e.id)
          ? h('a', { href: `#/campaign/codex/${e.id}`, class: e.id === sel ? 'on' : '' }, e.title)
          : h('a', { href: `#/campaign/codex/${e.id}`, class: `locked${e.id === sel ? ' on' : ''}`, title: 'Not discovered yet' }, icon('flag', 11), e.title));
        return li;
      });
      return { head: h('h4', null, k.title), ul: h('ul', null, items), items };
    });
    const filter = () => {
      const q = this.cxQuery.trim().toLowerCase();
      let shown = 0;
      for (const g of groups) {
        let n = 0;
        for (const li of g.items) {
          const ok = (!this.cxKind || li.dataset.k === this.cxKind) && (!q || li.dataset.t!.includes(q) || li.dataset.s!.includes(q));
          // the open entry stays listed (marked) when the search kept from before does not match it
          li.hidden = !ok && li.dataset.id !== sel;
          if (!li.hidden) n++;
          if (ok) shown++;
        }
        g.head.hidden = g.ul.hidden = n === 0;
      }
      empty.hidden = shown > 0;
      empty.textContent = sel ? 'No other entry matches.' : 'No entry matches.';
      for (const b of kinds.children) b.classList.toggle('on', (b as HTMLElement).dataset.k === this.cxKind);
    };
    search.addEventListener('input', () => { this.cxQuery = search.value; filter(); });
    // A narrow screen stacks the list and the entry: with an entry open, the entry comes first and the list folds
    // behind a button (campaign.css), else the entry sat under all the items.
    const browse = h('button', { class: 'btn sm cx-browse', 'aria-expanded': String(this.cxListOpen), onclick: () => {
      this.cxListOpen = !this.cxListOpen;
      list.classList.toggle('open', this.cxListOpen);
      browse.setAttribute('aria-expanded', String(this.cxListOpen));
    } }, icon('book', 14), `All ${CODEX.length} entries`, icon('chevD', 12));
    const list = h('nav', { class: `cp-codex-list${this.cxListOpen ? ' open' : ''}` }, sel ? browse : null,
      h('div', { class: 'cx-listbody' },
        h('p', { class: 'sub' }, `${[...unlocked].filter((u) => codexById(u)).length} of ${CODEX.length} entries discovered`),
        search, kinds, empty, groups.flatMap((g) => [g.head, g.ul])));
    filter();
    const e = sel ? codexById(sel) : undefined;
    let detail: HTMLElement;
    if (!e) {
      detail = h('div', { class: 'cp-codex-entry' }, h('h2', null, 'Codex'),
        h('p', null, 'Every component you build, every law and tool you use, collected as you go. Entries unlock when you finish (or skip) the level that teaches them; Unlock all reveals them all.'));
    } else if (!unlocked.has(e.id)) {
      const where = foundIn(e.id);
      // The one-line summary is no secret (the hover cards show it): the rest unlocks with the level.
      detail = h('div', { class: 'cp-codex-entry locked' }, h('h2', null, e.title), html('div', 'cx-sum', e.body),
        h('p', null, 'The full entry unlocks when you pass ', where.map((n, i) => [i ? (i === where.length - 1 ? ' or ' : ', ') : '', h('a', { href: `#/campaign/n/${n.id}` }, n.title)]), '.'));
    } else if (this.moreOf === undefined) {
      // The fuller texts are a chunk of their own: load them, then draw the entry.
      detail = h('div', { class: 'cp-codex-entry' }, h('h2', null, e.title), html('div', 'cp-codex-body', e.body));
      import('../../campaign/codexmore').then((m) => {
        this.moreOf = m.moreOf;
        this.checkOf = m.checkOf;
        if (location.hash === `#/campaign/codex/${e.id}`) this.main.replaceChildren(this.codexView(e.id));
      }, () => { this.moreOf = () => undefined; });
    } else {
      const more = this.moreOf(e.id);
      const sheet = more?.lib ? datasheetOf(more.lib) : undefined;
      const sheets = sheet ? [sheetEl(sheet)] : e.kind === 'component' ? datasheets(e.id).map(sheetEl) : [];
      detail = codexEntryEl(e, more, p.view, sheets, this.checkOf(e.id));
    }
    return h('div', { class: `cp-codex${sel ? ' has-sel' : ''}` }, list, detail);
  }
}

/** A library part's datasheet: cost, pins, and a small part's truth table. */
function sheetEl(d: Datasheet): HTMLElement {
  const fmt = (v: number, w: number) => (w > 4 ? `0x${v.toString(16)}` : w > 1 ? v.toString(2).padStart(w, '0') : String(v));
  const ins = d.pins.filter((p) => p.dir !== 'out').length;
  const widths = [...d.pins.filter((p) => p.dir !== 'out'), ...d.pins.filter((p) => p.dir === 'out')].map((p) => p.width);
  return h('div', { class: 'cp-sheet' },
    h('h4', null, 'Datasheet: ', h('a', { href: `#/workbench/${d.id}`, title: 'Open it in the workbench' }, d.name)),
    h('p', { class: 'sub' }, `${d.nand.toLocaleString('en')} NAND · ${d.transistors.toLocaleString('en')} transistors · ${d.depth !== null ? `depth ${d.depth}` : 'sequential'}`),
    h('div', { class: 'cp-sheet-cols' },
      h('table', null, h('tr', null, h('th', null, 'pin'), h('th', null, 'dir'), h('th', null, 'bits')),
        d.pins.map((p) => h('tr', null, h('td', null, p.name), h('td', null, p.dir), h('td', null, String(p.width))))),
      d.table ? h('table', null, h('tr', null, d.table.head.map((x, i) => h('th', i >= ins ? { class: 'out' } : null, x))),
        d.table.rows.map((r) => h('tr', null, r.map((v, i) => h('td', i >= ins ? { class: 'out' } : null, fmt(v, widths[i])))))) : null));
}
