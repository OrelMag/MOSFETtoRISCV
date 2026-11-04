// The Campaign page (#/campaign[/intro | /n/<node> | /codex[/<entry>]]): the map of levels, a
// level's panel (why, the test set, tips, codex, Start / Skip / Show solution), the CPU anatomy
// intro and the codex. Loaded on demand (app.ts imports it dynamically). Levels are played on the
// level screen (pages/level.ts): Play writes the level's chip into the saved workspace and opens
// #/campaign/play/<node>.

import { setPageTitle } from '../pagetitle';
import { reducedMotion } from '../motion';
import { groupDigits } from '../../sim/numfmt';
import '../../styles/campaign.css';
// The level screen's chips, bars and diagram frame, shared by the full codex entry.
import '../../styles/level.css';
import { BLOCKS, blockNodes } from '../../campaign/anatomy';
import { notFound } from '../notfound';
import { CODEX, CODEX_KINDS, codexById, type CodexEntry } from '../../campaign/codex';
import { matchNote, searchCodex } from '../../campaign/codexsearch';
import type { CodexMore } from '../../campaign/codexmore';
import { CODEX_ACTS, CODEX_BY_KIND, CODEX_ORDER } from '../../campaign/codexlinks';
import type { Quiz } from '../../chapters/types';
import { ANALOGIES, ANALOGY_INDEX_ID } from '../../chapters/analogies';
import { analogyIndexEl } from '../analogyindex';
import { codexEntryEl, entrySheets, liveSchematic, lockedEntryEl } from '../../campaign/ui/codexentry';
import { LESSON_EXTRAS } from '../../campaign/lessonextras';
import { quizBox } from '../quiz';
import { ancestors, dependents, isDone, nextAvailable, statusOf } from '../../campaign/graph';
import { LESSONS } from '../../campaign/lessons';
import { levelChallenge, levelChipId, startCandidates, startFrom } from '../../campaign/levels';
import { ACTS, actName, actTitle, NODES, nodeById } from '../../campaign/nodes';
import { hasTwin, twinKey } from '../../campaign/twinids';
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
import { markJump } from '../returnto';
import { settings } from '../settings';
import type { Page } from './chapter';
import { tipsOf } from '../../campaign/nudges';
import { closedAct } from '../../campaign/thread';
import { actEndEl, nextAfter, reachEl, type ThreadCtx, whyStackEl } from '../../campaign/ui/whystack';

/** localStorage: the codex list's order (act or kind). */
const CX_VIEW_KEY = 'mosfet2riscv:codex-view';

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
  /** The codex list by act (the reading order) or by kind, as the reader last chose. */
  /** The acts left open in the codex list (the selected entry's act always opens): 177 entries are not read from the top. */
  private cxOpen = new Set<string>();
  private cxView: 'act' | 'kind' = (() => { try { return localStorage.getItem(CX_VIEW_KEY) === 'kind' ? 'kind' : 'act'; } catch { return 'act'; } })();
  /** Locked entries the reader asked to see anyway (this visit). */
  private cxPeek = new Set<string>();
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
    const [a, b] = parts;
    if (a === 'codex' && codexById(b ?? '')) setPageTitle(codexById(b)!.title, 'Codex');
    else if (a === 'n' && nodeById(b ?? '')) setPageTitle(nodeById(b)!.title, 'Campaign');
    this.render();
  }

  /** The top bar's way back names the open entry or level (ui/returnto.ts). */
  returnLabel(): { label: string; short: string } | null {
    const [a, b] = this.parts;
    const t = a === 'codex' ? codexById(b ?? '')?.title : a === 'n' ? nodeById(b ?? '')?.title : undefined;
    if (!t) return { label: 'the campaign map', short: 'Map' };
    return a === 'codex' ? { label: `Codex: ${t}`, short: `Codex: ${t}` } : { label: `${t} (map)`, short: t };
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
    // an address that names no level or entry: the shared notice, with the way back, not the map under a wrong address
    if (a === 'n' && b && !nodeById(b)) this.main.replaceChildren(notFound(`No level called “${b}”`, 'The address may be stale or mistyped.', [['Open the campaign map', '#/campaign'], ['Open the codex', '#/campaign/codex']]));
    else if (a === 'codex' && b && b !== ANALOGY_INDEX_ID && !codexById(b)) this.main.replaceChildren(notFound(`No codex entry called “${b}”`, 'The address may be stale or mistyped.', [['Open the codex', '#/campaign/codex'], ['Open the campaign map', '#/campaign']]));
    else if (a && a !== 'n' && a !== 'codex' && a !== 'intro') this.main.replaceChildren(notFound(`No campaign page called “${a}”`, 'The map, the intro and the codex are the pages here.', [['Open the campaign map', '#/campaign'], ['Open the codex', '#/campaign/codex']]));
    else if (a === 'intro') this.main.replaceChildren(this.introView());
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
    const behavior: ScrollBehavior = reducedMotion() ? 'auto' : 'smooth';
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

  /** A codex entry opened: its top in view (on a narrow screen it may have been opened from far down the list), and its row in the sticky list's view. */
  private revealEntry(): void {
    const list = this.main.querySelector<HTMLElement>('.cp-codex-list');
    const row = list?.querySelector<HTMLElement>('a.on');
    if (list && row && list.scrollHeight > list.clientHeight) {
      const r = row.getBoundingClientRect(), v = list.getBoundingClientRect();
      if (r.top < v.top + 40 || r.bottom > v.bottom - 8) list.scrollTop += r.top - v.top - list.clientHeight / 3;
    }
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
        h('button', { class: 'btn sm ghost', title: 'Your progress and your level chips, as one .json file', onclick: () => this.exportFile() }, 'Export campaign'),
        h('button', { class: 'btn sm ghost', title: 'Merge a campaign file into your progress (your chips are never overwritten)', onclick: () => file.click() }, 'Import campaign'),
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
    // The frontier: the next open level is ringed, and a map opened with no level selected scrolls to it
    const frontier = nextAvailable(p.view, p.unlockAll)?.id;
    const ring = () => scroll.querySelector('.cp-node.next')?.classList.remove('next');
    const mark = () => {
      ring();
      if (frontier && !sel) scroll.querySelector(`.cp-node[data-node="${frontier}"]`)?.classList.add('next');
    };
    const scroll = h('div', { class: 'cp-map-scroll' }, draw(this.mapCols));
    mark();
    if (!sel && !this.mapScroll && frontier) {
      requestAnimationFrame(() => {
        const node = scroll.querySelector<SVGGraphicsElement>('.cp-node.next');
        if (!node) return;
        const r = node.getBoundingClientRect(), v = scroll.getBoundingClientRect();
        scroll.scrollTop += r.top - v.top - (v.height - r.height) / 2;
        scroll.scrollLeft += r.left - v.left - (v.width - r.width) / 2;
      });
    }
    this.mapFit?.disconnect();
    this.mapFit = new ResizeObserver(() => {
      const cols = mapColsFor(scroll.clientWidth);
      if (scroll.clientWidth <= 0 || cols === this.mapCols) return;
      this.mapCols = cols;
      const refocus = keepFocus(scroll);
      scroll.replaceChildren(draw(cols));
      mark();
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
        h('span', { class: 'cp-badge kind' }, n.bug ? 'Bug hunt' : KIND_LABEL[n.kind]),
        n.optional ? h('span', { class: 'cp-badge opt' }, 'optional') : null,
        n.soon ? h('span', { class: 'cp-badge soon' }, 'coming soon') : h('span', { class: `cp-badge st ${st}` }, STATUS_LABEL[st]),
        np?.stars ? h('span', { class: 'cp-badge stars', title: 'Best result' }, '★'.repeat(np.stars) + '☆'.repeat(3 - np.stars)) : null),
      whyStackEl(n, this.ctx(), 'map', { title: 'Why you need it' }));

    if (n.id === 'intro') {
      el.append(h('a', { class: 'cp-mini-anatomy', href: '#/campaign/intro', title: 'Open the full diagram', 'aria-label': 'The CPU: open the full block diagram' }, anatomySvg(p.view, undefined)));
    }
    if (n.body && LESSONS[n.body]) el.append(html('div', 'cp-lesson', LESSONS[n.body]));
    const extra = n.body ? LESSON_EXTRAS[n.body] : undefined;
    if (extra) {
      for (const f of extra.figures) {
        const fig = liveSchematic(f.lib);
        if (fig) el.append(h('figure', { class: 'cx-fig cp-lesson-fig' }, fig, h('figcaption', null, f.caption, ' ', h('a', { href: `#/workbench/${f.lib}` }, 'Open it on the workbench'), '.')));
      }
      el.append(h('section', { class: 'cx-check cp-lesson-check' }, h('h4', null, 'Check yourself'),
        ...extra.check.map((q, k) => quizBox(q, `lesson:${n.body}:${k}`, `${k + 1} of ${extra.check.length}`, () => {}))));
    }
    // A drill's question and a program's editor with its Check come first, right under the title: the essay (why,
    // costs, criteria) is reference for after the first try, so it sits below them.
    let practice: HTMLElement[] = [];
    if (ch) el.append(h('div', { class: 'cp-brief' }, h('h4', null, 'The task'), html('p', '', ch.brief)));
    if (n.kind === 'drill' && n.drill && !n.soon && st !== 'locked') {
      let card = this.cards.get(n.id);
      if (!card) this.cards.set(n.id, (card = drillCard(n)));
      practice = [h('div', { class: 'cp-drill-wrap' }, h('h4', null, 'Practice'), card)];
    }
    const pz = n.kind === 'program' && !n.soon ? PUZZLES[n.id] : undefined;
    if (pz) {
      practice = [h('div', { class: 'cp-brief' }, h('h4', null, 'The task'), html('p', '', pz.brief))];
      el.append(h('div', { class: 'cp-criteria' }, h('h4', null, 'Success criteria'),
          h('ul', null, h('li', null, pz.lanes && pz.warps
            ? `${pz.tests().length} tests on the two-warp golden model (${pz.warps} warps of ${pz.lanes} lanes taking turns, one shared memory); each must end within ${groupDigits(pz.maxSteps)} cycles with the expected memory, and again with warp ${pz.warps - 1} running ahead.`
            : pz.lanes
            ? `${pz.tests().length} tests on the lane golden model (${pz.lanes} lanes, one shared memory); each must halt within ${groupDigits(pz.maxSteps)} warp instructions with the expected memory.`
            : `${pz.tests().length} tests on the golden model; each must halt within ${groupDigits(pz.maxSteps)} ${pz.dma ? 'cycles (flash stalls included)' : 'instructions'} with the expected output.`),
            pz.tests().map((t) => h('li', null, t.name)))));
      if (st !== 'locked') {
        let card = this.cards.get(n.id);
        if (!card) this.cards.set(n.id, (card = puzzleCard(n)));
        practice.push(h('div', { class: 'cp-drill-wrap' }, h('h4', null, 'Your program'), card));
      }
    }
    if (practice.length) {
      const at = el.querySelector(':scope > .th-why');
      for (const x of practice) el.insertBefore(x, at);
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

    // The parts it may use, what it unlocks.
    const unlocks = partNames(n.unlocks ?? [], (u) => resolveComponent(u)?.name);
    const rule = ch && typeof ch.allowed === 'object' ? ch.allowed.lib.filter((x) => x !== 'nand') : [];
    // (what it builds on and what uses it sit in the why stack, above)
    el.append(h('div', { class: 'cp-deps' },
      rule.length ? h('p', null, h('b', null, 'Parts you may place: '), 'NAND, ', partNames(rule, (u) => resolveComponent(u)?.name).join(', ')) : null,
      unlocks.length ? h('p', null, h('b', null, 'Unlocks: '), unlocks.join(', ')) : null));

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
          return unlocked.has(c) ? h('a', { class: 'cp-chip', href: `#/campaign/codex/${c}` }, e.title)
            : h('a', { class: 'cp-chip locked', href: `#/campaign/codex/${c}`, title: 'Unlocks when you finish this level: its summary and questions now' }, icon('lock', 11), e.title);
        })));
    }
    if (n.chapters?.length) {
      el.append(h('div', { class: 'cp-chapters' }, h('h4', null, 'Go deeper'),
        n.chapters.map((c) => h('a', { class: 'cp-chip', href: `#/c/${c.chapter}/${c.step ?? 0}` }, icon('book', 13), c.label))));
    }
    // A done level that closes its act (the last of a chain in it): what the machine can do now.
    if (closedAct(n, p.view) !== undefined && !dependents(n.id).some((d) => d.act === n.act && !d.optional)) {
      const end = actEndEl(n.act, this.ctx(), false);
      if (end) el.append(end);
    }
    if (hasTwin(n.id) && !n.soon && st !== 'locked') {
      const vp = p.get(twinKey(n.id));
      el.append(h('div', { class: 'cp-twin' }, h('b', null, 'Also in Verilog'),
        h('p', { class: 'sub' }, vp?.stars ? `Passed with ${'★'.repeat(vp.stars)}${vp.best?.nand !== undefined ? ` at ${groupDigits(vp.best.nand)} NANDs` : ''}. Optional.` : 'The same block written as Verilog: Yosys in your browser turns it into NANDs and the level’s own check grades it. Optional.'),
        h('a', { class: 'btn sm', href: `#/campaign/play/${twinKey(n.id)}` }, icon('play', 13), vp?.status ? 'Continue' : 'Try it in Verilog')));
    }
    el.append(this.actions(n, st, ch));
    return el;
  }

  /** How the thread's links open a level here: its panel on the map. */
  private ctx(): ThreadCtx {
    const p = progress();
    return { view: p.view, route: (m) => `#/campaign/n/${m.id}`, open: (m) => !m.soon && statusOf(m, p.view, p.unlockAll) !== 'locked' };
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
      const missing = n.requires.filter((r) => !isDone(p.view(r)));
      bar.append(h('p', { class: 'sub' }, `Finish or skip first: ${missing.map((r) => nodeById(r)?.title ?? r).join(', ')}. Or tick Unlock all.`));
      // the way on: the first prerequisite that is itself open (a locked one has its own blockers)
      const open = missing.map((r) => nodeById(r)).find((m): m is CampaignNode => !!m && !m.soon && statusOf(m, p.view, p.unlockAll) !== 'locked') ?? nodeById(missing[0] ?? '');
      if (open) bar.append(h('a', { class: 'btn primary', href: `#/campaign/n/${open.id}` }, `Open the prerequisite: ${open.title}`, icon('chevR', 14)));
      bar.classList.add('sticky');
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
      if (n.id === 'intro') bar.append(h('a', { class: 'btn sm', href: '#/campaign/intro' }, 'The full diagram'));
    } else if (ch) {
      const chip = levelChipId(n);
      const exists = !!loadWorkspace().chips[chip];
      bar.append(h('button', { class: 'btn primary', onclick: () => this.start(n, ch) }, icon('play', 14), exists ? 'Continue' : 'Play'));
      if (exists) bar.append(h('a', { class: 'btn ghost', href: `#/sandbox/${chip}`, title: 'The same chip in the full sandbox editor' }, 'Open in Sandbox'));
      // A core level: start from a copy of the core you built for an earlier level.
      const from = exists ? undefined : startCandidates(n, loadWorkspace())[0];
      if (from) bar.append(h('button', { class: 'btn', title: `A copy of your “${from.title}” chip, with this level's pins added`, onclick: () => this.start(n, ch, levelChipId(from)) }, `Start from ${from.title}`));
      bar.append(h('button', { class: 'btn ghost', title: 'Import the reference answer as new chips and open it in the sandbox', onclick: () => this.solution(ch) }, 'Show answer'));
    }
    if (n.kind !== 'lesson' && st !== 'solved') {
      bar.append(st === 'skipped'
        ? h('button', { class: 'btn ghost', title: 'Back to unfinished', onclick: () => p.unskip(n.id) }, 'Un-skip')
        : h('button', { class: 'btn ghost', title: 'Count this level as done: its part unlocks (the reference solution stands in for yours)', onclick: () => p.skip(n.id) }, 'Skip'));
    }
    // after a pass: the level it moved closest to ready, else the next open one in order; and its side quest
    const reach = isDone(p.view(n.id)) ? reachEl(n, this.ctx()) : undefined;
    const next = reach ? nextAfter(n, this.ctx()) ?? nextAvailable(p.view, p.unlockAll, n.id) : undefined;
    // the main action once nothing else is (a lesson read, a drill passed): where to go next
    if (next) {
      const main = !bar.querySelector('.btn.primary');
      const go = h('a', { class: `btn ${main ? 'primary' : 'ghost'} cp-next`, href: `#/campaign/n/${next.id}` }, `Next: ${next.title}`, icon('chevR', 14));
      // a read lesson: right after its tick, before the lesson's extras
      if (main && n.kind === 'lesson') bar.insertBefore(go, bar.children[1] ?? null);
      else bar.append(go);
    }
    if (reach?.side && reach.side.id !== next?.id) bar.append(h('a', { class: 'btn sm ghost cp-side', href: `#/campaign/n/${reach.side.id}`, title: `Side quest: ${reach.side.title}` }, `Side quest: ${reach.side.title}`));
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
    markJump();
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
    // Search (names and aliases first, then summaries: codexsearch.ts, as the Ctrl K box) and a kind filter, applied in
    // place and kept across entries. While a query is typed the groups give way to one ranked list.
    const search = h('input', { class: 'cx-search', type: 'search', placeholder: `Search ${CODEX.length} entries`, 'aria-label': 'Search the codex', value: this.cxQuery });
    const kinds = h('div', { class: 'cx-kinds', role: 'group', 'aria-label': 'Kinds' }, [{ id: '', title: 'All' }, ...CODEX_KINDS].map((k) =>
      h('button', { class: `cx-kind${this.cxKind === k.id ? ' on' : ''}`, 'data-k': k.id, 'aria-pressed': String(this.cxKind === k.id), onclick: () => { this.cxKind = k.id; filter(); } }, k.title)));
    const views = h('div', { class: 'cx-views', role: 'group', 'aria-label': 'Order' }, (['act', 'kind'] as const).map((v) =>
      h('button', { class: `cx-kind${this.cxView === v ? ' on' : ''}`, 'aria-pressed': String(this.cxView === v), onclick: () => {
        if (this.cxView === v) return;
        this.cxView = v;
        try { localStorage.setItem(CX_VIEW_KEY, v); } catch { /* not kept */ }
        this.redrawCodex(sel);
        this.main.querySelector<HTMLElement>('.cx-views .on')?.focus();
      } }, v === 'act' ? 'By act' : 'By kind')));
    const empty = h('p', { class: 'sub', hidden: true }, 'No entry matches.');
    const item = (e: CodexEntry) => h('li', { 'data-id': e.id, 'data-k': e.kind }, h('a', {
      href: `#/campaign/codex/${e.id}`, class: `${unlocked.has(e.id) ? '' : 'locked'}${e.id === sel ? ' on' : ''}`,
      ...(unlocked.has(e.id) ? {} : { title: 'Not discovered yet' }), ...(e.id === sel ? { 'aria-current': 'page' } : {}),
    }, unlocked.has(e.id) ? null : icon('lock', 11), e.title));
    // The groups: by act (the reading order, Further entries under their act) or by kind.
    const groups = this.cxView === 'act'
      ? CODEX_ACTS.map((g) => ({
        head: g.act === undefined ? 'Elsewhere' : `${actName(g.act)} · ${actTitle(g.act)}`,
        parts: [{ sub: '', ul: h('ul', null, g.main.map(item)) }, ...(g.further.length ? [{ sub: 'Further', ul: h('ul', null, g.further.map(item)) }] : [])],
      }))
      : CODEX_KINDS.map((k) => ({ head: k.title, parts: [{ sub: '', ul: h('ul', null, CODEX_BY_KIND.filter((e) => e.kind === k.id).map(item)) }] }));
    const fold = this.cxView === 'act';
    const folds: (() => void)[] = [];
    const sections = groups.map((g) => {
      const parts = g.parts.map((x) => ({ ...x, h: x.sub ? h('h5', { title: x.sub === 'Further' ? 'Unlocked by this act\'s levels, which do not need them: read beyond the task' : '' }, x.sub) : null }));
      const holdsSel = !!sel && g.parts.some((x) => [...x.ul.children].some((li) => (li as HTMLElement).dataset.id === sel));
      if (holdsSel) this.cxOpen.add(g.head);
      const el = h('section', { class: 'cx-grp' }, h('h4', null, g.head), parts.flatMap((x) => [x.h, x.ul]));
      if (fold) {
        const btn = h('button', { class: 'cx-grp-t', type: 'button' }, g.head) as HTMLButtonElement;
        el.querySelector('h4')!.replaceChildren(btn);
        const sync = () => {
          const open = this.cxOpen.has(g.head) || !!this.cxKind;
          el.classList.toggle('folded', !open);
          btn.setAttribute('aria-expanded', String(open));
        };
        btn.addEventListener('click', () => { if (this.cxOpen.has(g.head)) this.cxOpen.delete(g.head); else this.cxOpen.add(g.head); sync(); });
        sync();
        folds.push(sync);
      }
      return { el, parts };
    });
    const ranked = h('ul', { class: 'cx-ranked', hidden: true });
    const filter = () => {
      const q = this.cxQuery.trim();
      let shown = 0;
      ranked.hidden = !q;
      if (q) {
        const hits = searchCodex(q).filter((e) => !this.cxKind || e.kind === this.cxKind);
        ranked.replaceChildren(...hits.map((e) => {
          const li = item(e), why = matchNote(e, q);
          if (why) li.append(h('span', { class: 'cx-why' }, why));
          return li;
        }));
        shown = hits.length;
        for (const g of sections) g.el.hidden = true;
      } else {
        for (const g of sections) {
          let any = 0;
          for (const x of g.parts) {
            let n = 0;
            for (const li of x.ul.children as HTMLCollectionOf<HTMLElement>) {
              li.hidden = !!this.cxKind && li.dataset.k !== this.cxKind && li.dataset.id !== sel;
              if (!li.hidden) n++;
            }
            x.ul.hidden = n === 0;
            if (x.h) x.h.hidden = n === 0;
            any += n;
          }
          g.el.hidden = any === 0;
          shown += any;
        }
      }
      for (const f of folds) f();
      empty.hidden = shown > 0;
      for (const b of kinds.children) {
        b.classList.toggle('on', (b as HTMLElement).dataset.k === this.cxKind);
        b.setAttribute('aria-pressed', String((b as HTMLElement).dataset.k === this.cxKind));
      }
    };
    search.addEventListener('input', () => { this.cxQuery = search.value; filter(); });
    // A narrow screen stacks the list and the entry: with an entry open, the entry comes first and the list folds
    // behind a button (campaign.css), else the entry sat under all the items.
    const browse = h('button', { class: 'btn sm cx-browse', 'aria-expanded': String(this.cxListOpen), onclick: () => {
      this.cxListOpen = !this.cxListOpen;
      list.classList.toggle('open', this.cxListOpen);
      browse.setAttribute('aria-expanded', String(this.cxListOpen));
    } }, icon('book', 14), `All ${CODEX.length} entries`, icon('chevD', 12));
    const list = h('nav', { class: `cp-codex-list${this.cxListOpen ? ' open' : ''}`, 'aria-label': 'Codex entries' }, sel ? browse : null,
      h('div', { class: 'cx-listbody' },
        h('p', { class: 'sub' }, `${[...unlocked].filter((u) => codexById(u)).length} of ${CODEX.length} entries discovered`),
        h('a', { class: `cx-axlink${sel === ANALOGY_INDEX_ID ? ' on' : ''}`, href: `#/campaign/codex/${ANALOGY_INDEX_ID}`, ...(sel === ANALOGY_INDEX_ID ? { 'aria-current': 'page' } : {}) },
          icon('like', 13), `All ${ANALOGIES.length} analogies`),
        search, h('div', { class: 'cx-filters' }, views, kinds), empty, ranked, sections.map((g) => g.el)));
    filter();
    const e = sel ? codexById(sel) : undefined;
    let detail: HTMLElement;
    if (sel === ANALOGY_INDEX_ID) {
      detail = analogyIndexEl();
    } else if (!e) {
      detail = this.codexLanding(unlocked);
    } else if (this.moreOf === undefined) {
      // The fuller texts (and the questions) are a chunk of their own: load them, then draw the entry.
      detail = h('div', { class: 'cp-codex-entry' }, h('h2', null, e.title), html('div', 'cp-codex-body', e.body));
      import('../../campaign/codexmore').then((m) => {
        this.moreOf = m.moreOf;
        this.checkOf = m.checkOf;
        if (location.hash !== `#/campaign/codex/${e.id}`) return;
        this.main.replaceChildren(this.codexView(e.id));
        requestAnimationFrame(() => this.revealEntry());
      }, () => { this.moreOf = () => undefined; });
    } else if (!unlocked.has(e.id) && !this.cxPeek.has(e.id)) {
      detail = lockedEntryEl(e, this.moreOf(e.id), this.checkOf(e.id), () => {
        this.cxPeek.add(e.id);
        this.redrawCodex(e.id);
      });
    } else {
      const more = this.moreOf(e.id);
      detail = codexEntryEl(e, more, p.view, entrySheets(e, more), this.checkOf(e.id));
      if (!unlocked.has(e.id)) detail.querySelector('.cx-head h2')?.append(h('span', { class: 'cp-badge cx-lockbadge' }, icon('lock', 11), 'not discovered: shown anyway'));
    }
    return h('div', { class: `cp-codex${sel ? ' has-sel' : ''}` }, list, detail);
  }

  /** The codex view drawn again in place (an order switched, an entry shown anyway), the list where it was scrolled. */
  private redrawCodex(sel: string | undefined): void {
    const top = this.main.querySelector<HTMLElement>('.cp-codex-list')?.scrollTop ?? 0;
    this.main.replaceChildren(this.codexView(sel));
    const list = this.main.querySelector<HTMLElement>('.cp-codex-list');
    if (list) list.scrollTop = top;
  }

  /** The codex with no entry open: what was found lately, what the next level adds, each act's count, where to start. */
  private codexLanding(unlocked: Set<string>): HTMLElement {
    const p = progress();
    const link = (e: CodexEntry) => h('a', { class: `cp-chip${unlocked.has(e.id) ? '' : ' locked'}`, href: `#/campaign/codex/${e.id}` }, unlocked.has(e.id) ? null : icon('lock', 11), e.title);
    // Recently discovered: the entries of the levels solved last.
    const solved = NODES.map((n) => ({ n, at: p.get(n.id)?.at ?? 0 })).filter((x) => x.at > 0).sort((a, b) => b.at - a.at);
    const recent = [...new Set(solved.flatMap((x) => x.n.codex))].map((id) => codexById(id)).filter((x): x is CodexEntry => !!x && unlocked.has(x.id)).slice(0, 8);
    const next = nextAvailable(p.view, p.unlockAll);
    const coming = (next?.codex ?? []).map((id) => codexById(id)).filter((x): x is CodexEntry => !!x && !unlocked.has(x.id));
    const firstNew = CODEX_ORDER.find((x) => !unlocked.has(x.id));
    return h('div', { class: 'cp-codex-entry cx-landing' },
      h('h2', null, 'Codex'),
      h('p', null, `Every component you build, every law and tool you use, collected as you go: ${CODEX.length} entries in the order the map teaches them. An entry unlocks when you finish (or skip) the level that teaches it; one not discovered yet still shows its summary and questions.`),
      h('p', { class: 'cx-landing-go' },
        h('a', { class: 'btn primary', href: `#/campaign/codex/${CODEX_ORDER[0].id}` }, `Start reading: ${CODEX_ORDER[0].title}`, icon('chevR', 14)),
        firstNew && firstNew !== CODEX_ORDER[0] ? h('a', { class: 'btn ghost', href: `#/campaign/codex/${firstNew.id}`, title: 'The first entry in reading order you have not discovered' }, `First undiscovered: ${firstNew.title}`) : null),
      h('section', null, h('h4', null, 'Analogies'),
        h('p', null, `${ANALOGIES.length} familiar pictures for abstract ideas, each with where it stops being true: `,
          h('a', { href: `#/campaign/codex/${ANALOGY_INDEX_ID}` }, 'the analogy index'), '.')),
      recent.length ? h('section', null, h('h4', null, 'Recently discovered'), h('div', null, recent.map(link))) : null,
      next ? h('section', null, h('h4', null, 'Next to discover'),
        h('p', { class: 'sub' }, 'With ', h('a', { href: levelChallenge(next) && !next.soon ? `#/campaign/play/${next.id}` : `#/campaign/n/${next.id}` }, next.title), coming.length ? ':' : ': nothing new for the codex.'),
        coming.length ? h('div', null, coming.map(link)) : null) : null,
      h('section', null, h('h4', null, 'By act'),
        h('table', { class: 'cx-acts' }, CODEX_ACTS.map((g) => {
          const all = [...g.main, ...g.further];
          const have = all.filter((x) => unlocked.has(x.id)).length;
          const first = all.find((x) => !unlocked.has(x.id)) ?? all[0];
          return h('tr', null,
            h('td', null, h('a', { href: `#/campaign/codex/${first.id}` }, g.act === undefined ? 'Elsewhere' : `${actName(g.act)} · ${actTitle(g.act)}`)),
            h('td', { class: 'n' }, `${have} / ${all.length}`),
            h('td', { class: 'bar' }, h('span', { class: 'track' }, h('i', { style: `width:${(100 * have / all.length).toFixed(0)}%` }))));
        }))));
  }

}
