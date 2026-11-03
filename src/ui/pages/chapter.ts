// A chapter: narrative on the left, the live stage in the middle, the inspector on the right.

import { outline, outlineIndex, outlineOf } from '../../chapters/outline';
import { checksDone, recapIndex } from '../../chapters/checks';
import { chapterNo, type Chapter, type Step } from '../../chapters/types';
import { notes, type Place } from '../notes';
import { Inspector } from '../../view/inspector';
import { Stage } from '../../view/stage';
import { maybeCoach } from '../coachmarks';
import { transistorLeaf } from '../../widgets/mosfet';
import { h, icon } from '../dom';
import { drillLanded, drillSegs, syncDrill } from '../drillpath';
import { bindKeys } from '../keys';
import { toggleChapterMenu } from '../quicknav';
import { bookmarkButton, StepNotes } from '../notesui';
import { newPartsNavState, partsNav } from '../chapterparts';
import { quizBox } from '../quiz';
import { settings } from '../settings';
import { reveal, StageNotes } from '../stagenotes';
import { reducedMotion } from '../motion';
import { litLine, wireLooks } from './looks';
import { ledgerView } from '../ledger';
import { TourPlayer } from '../tour';
import { analogiesOf } from '../../chapters/analogies';
import { analogyEl } from '../analogy';
import type { Layers, Reading } from '../../chapters/types';

/** The layers under a step's body, in order, with their tab names. */
const LAYERS: [keyof Layers, string][] = [['derive', 'Derivation'], ['real', 'In real silicon'], ['pitfall', 'Common mistake'], ['numbers', 'Numbers']];
const LAYER_KEY = 'mosfet2riscv:layer';

export interface Page {
  el: HTMLElement;
  destroy(): void;
}

/** The page that last set the top bar's data-widget-step (a later page keeps it when an earlier one is destroyed). */
let widgetStepOwner: object | null = null;

export class ChapterPage implements Page {
  readonly kind = 'chapter';
  readonly el: HTMLElement;
  readonly chapter: Chapter;
  private stage: Stage;
  private inspector: Inspector;
  private head: HTMLElement;
  private tools = h('div', { class: 'step-tools' });
  /** The parts list's open parts (chapters with parts). */
  private partsState = newPartsNavState();
  private body: HTMLElement;
  /** The walkthrough playing on the stage, if any. */
  private tour: TourPlayer | null = null;
  private foot: HTMLElement;
  private step = -1;
  /** Has the stage shown anything yet (a step without a scene keeps the last one, or borrows a neighbour's)? */
  private shown = false;
  /** Is the stage showing a scene (not a widget)? Only a scene has a drill path in the hash. */
  private sceneShown = false;
  /** Following the address bar (a route): the stage's moves are not new history entries. */
  private routing = false;
  private unlisten: (() => void)[] = [];
  private pillOff: (() => void) | null = null;
  /** The step's challenge goal and "done" toasts over the canvas: the text panel's cards are often out of sight. */
  private notes = new StageNotes();
  private unbindKeys: () => void;
  /** This step's notes (cards, and markers on the stage); none on the recap. */
  private stepNotes: StepNotes | null = null;
  private offNotes: () => void;

  constructor(chapter: Chapter, step: number, path?: string[]) {
    this.chapter = chapter;
    this.inspector = new Inspector();
    this.stage = new Stage(this.inspector);
    this.stage.leafFactory = transistorLeaf;
    this.stage.onReady(() => maybeCoach('stage'));
    this.head = h('div', { class: 'narrative-head' });
    this.body = h('div', { class: 'narrative-body' });
    this.foot = h('div', { class: 'narrative-foot' });
    const narrative = h('aside', { class: 'narrative' }, this.head, this.body, this.foot);
    this.el = h('div', { class: 'layout' }, narrative, this.stage.el, this.inspector.el, this.notes.live);
    this.stage.el.querySelector('.canvas')?.append(this.notes.el);
    this.el.append(this.showCircuitButton());
    // Each level opened is a history entry (ui/drillpath.ts): #/c/<chapter>/<step>/<instance>/…
    this.stage.onNavigate(() => {
      if (this.sceneShown) syncDrill(this.hash(), this.routing);
    });
    // [ ] step, { } change chapter (ui/keys.ts): ] and [ press the foot's Next and Back, whatever they lead to
    const press = (el: Element | null) => (el instanceof HTMLButtonElement || el instanceof HTMLAnchorElement ? el.click() : false);
    const jump = (d: number) => {
      const c = outline[outlineIndex(this.chapter.id) + d];
      if (!c) return false;
      location.hash = `#/c/${c.id}/0`;
    };
    this.unbindKeys = bindKeys({
      'step.next': () => press(this.foot.lastElementChild),
      'step.prev': () => press(this.foot.firstElementChild),
      'chapter.next': () => jump(1),
      'chapter.prev': () => jump(-1),
    });
    // the head's Save / note count follow the store
    this.offNotes = notes().onChange(() => this.renderTools());
    this.goStep(step, path);
  }

  /** The step's place for notes and bookmarks (null on the recap). */
  private place(): Place | null {
    return this.step >= 0 && this.step < this.chapter.steps.length ? { kind: 'step', chapter: this.chapter.id, step: this.step } : null;
  }

  private placeTitle(): string {
    return `${chapterNo(this.chapter)} · ${this.chapter.title} · ${this.chapter.steps[this.step]?.title ?? ''}`;
  }

  /** This step's address, with the part open on the stage unless it is the scene's opening view. */
  private hash(): string {
    const drill = this.sceneShown ? drillSegs(this.stage.targetPath, this.stage.target?.path ?? []) : '';
    return `#/c/${this.chapter.id}/${this.step}${drill}`;
  }

  private clamp(i: number): number {
    return Math.max(0, Math.min(this.recap >= 0 ? this.recap : this.chapter.steps.length - 1, i));
  }

  /** The route: step `i` and the drill path after it (undefined: the scene's opening view). */
  route(i: number, path?: string[]): void {
    if (drillLanded()) {
      // our own step back (Up, a breadcrumb) arrived: the stage is there, or has moved on since
      if (this.sceneShown) syncDrill(this.hash());
      return;
    }
    if (this.clamp(i) !== this.step) return this.goStep(i, path);
    if (!this.sceneShown) return;
    this.routing = true;
    try {
      this.stage.openPath(path ?? this.stage.target?.path ?? []);
    } finally {
      this.routing = false;
    }
    syncDrill(this.hash(), true);
  }

  /** The recap's index (one past the last step), or -1 without one. */
  private get recap(): number {
    return recapIndex(this.chapter) ?? -1;
  }

  /** `path`: open the scene this deep (a drill path from the address bar), else at its opening view. */
  goStep(i: number, path?: string[]): void {
    const steps = this.chapter.steps;
    i = this.clamp(i);
    if (i === this.step) return;
    this.step = i;
    this.unlisten.forEach((f) => f());
    this.unlisten = [];
    this.tour?.close();
    this.notes.clear();
    this.stepNotes?.destroy();
    this.stepNotes = null;
    this.stage.noteMarks = null;
    // the recap leaves the last step's circuit on the stage: say so (app.css .recap-on)
    this.el.classList.toggle('recap-on', i === this.recap);
    if (i === this.recap) {
      this.show(steps.length - 1, path);
      this.renderHead();
      this.renderRecap();
    } else {
      settings.visit(this.chapter.id, i);
      this.show(i, path);
      this.renderHead();
      this.renderBody(steps[i]);
    }
    this.renderFoot();
    this.body.scrollTop = 0;
    const want = this.hash();
    if (location.hash !== want) history.replaceState(null, '', want);
  }

  /** Put step i's scene or widget on the stage; a step without either keeps what is shown, or borrows the nearest earlier one's. */
  private show(i: number, path?: string[]): void {
    const steps = this.chapter.steps;
    const has = (k: number) => !!(steps[k].scene || steps[k].widget);
    let k = i;
    if (!has(k)) {
      if (this.shown) {
        if (path && this.sceneShown) {
          this.routing = true;
          try {
            this.stage.openPath(path);
          } finally {
            this.routing = false;
          }
        }
        return;
      }
      while (k > 0 && !has(k)) k--;
      if (!has(k)) k = steps.findIndex((s) => s.scene || s.widget);
      if (k < 0) return;
    }
    const st = steps[k];
    if (st.scene) {
      const t0 = performance.now();
      const sc = st.scene();
      this.stage.load(sc, path, performance.now() - t0);
    }
    else this.stage.showWidget(st.widget!());
    this.shown = true;
    this.sceneShown = !!st.scene;
    this.el.classList.toggle('no-inspector', !st.scene);
    // a widget has no gate delays to slow down: the top bar's Slow motion button hides (app.css)
    widgetStepOwner = this;
    document.documentElement.toggleAttribute('data-widget-step', !st.scene);
  }

  private renderHead(): void {
    const c = this.chapter;
    const visited = settings.visited(c.id);
    const dots: HTMLElement[] = c.steps.map((s, i) => {
      const solved = !!s.challenge && settings.isSolved(`${c.id}:${i}`);
      return h('button', {
        class: [i === this.step ? 'cur' : visited.includes(i) ? 'done' : '', solved ? 'solved' : ''].filter(Boolean).join(' '),
        title: `${i + 1}. ${s.title}${s.challenge ? (solved ? ' (check solved)' : ' (has a check)') : ''}`,
        'aria-label': `Step ${i + 1}: ${s.title}${solved ? ', check solved' : ''}`,
        onclick: () => this.goStep(i),
      });
    });
    for (const t of c.soon ?? []) dots.push(h('span', { class: 'soon', role: 'img', title: `Coming: ${t}`, 'aria-label': `Coming later: ${t}` }));
    if (this.recap >= 0) {
      dots.push(h('button', {
        class: `recap${this.step === this.recap ? ' cur' : ''}`, title: 'Recap', 'aria-label': 'Recap', onclick: () => this.goStep(this.recap),
      }));
    }
    const { done, total } = checksDone(c, (k) => settings.isSolved(k));
    // a long chapter shows named parts in place of the rows of dots
    const refocus = this.head.contains(document.activeElement) && !!document.activeElement?.classList.contains('pstep');
    const parts = partsNav(c, this.step, this.recap, visited, (k) => settings.isSolved(k), (i) => this.goStep(i), this.partsState);
    this.head.replaceChildren(
      h('div', { class: `chapter-kicker${c.appendix ? ' appendix' : c.prologue ? ' prologue' : ''}` }, `${c.appendix ? `Appendix ${c.appendix}` : c.prologue ? `Prologue ${c.prologue}` : c.label ?? `Chapter ${c.num}`} · ${c.level}`),
      h('h1', { class: 'chapter-title' }, h('button', {
        class: 'chapter-switch', title: 'Switch chapter', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
        onclick: (e: Event) => toggleChapterMenu(e.currentTarget as HTMLElement),
      }, h('span', null, c.title), icon('chevD', 18))),
      parts ?? h('div', { class: 'steps-row' },
        h('div', { class: 'steps-dots', role: 'tablist' }, dots),
        total ? h('span', { class: 'checks-count', title: 'Questions and challenges solved in this chapter' }, `${done} / ${total} checks`) : null),
      this.tools,
    );
    if (refocus) this.head.querySelector<HTMLElement>('.pstep.cur')?.focus({ preventScroll: true });
    this.renderTools();
  }

  /** Save (bookmark) and Add note, for the step shown; nothing on the recap. */
  private renderTools(): void {
    const place = this.place();
    if (!place) return void this.tools.replaceChildren();
    const n = notes().notesAt(place).length;
    this.tools.replaceChildren(
      bookmarkButton(place, () => this.placeTitle()),
      h('button', { class: 'btn sm note-add', type: 'button', title: 'A note on this step, pinned to the part selected on the stage', onclick: () => this.stepNotes?.add() },
        icon('note', 15), h('span', { class: 'lbl' }, 'Add note'), n ? h('small', null, ` · ${n}`) : null));
  }

  /** Hover definitions: a chunk of its own, marked once it arrives (if still shown), skipping terms met in earlier steps seen. */
  private gloss(el: HTMLElement): void {
    if (!settings.glossary) return;
    const c = this.chapter;
    const met = settings.visited(c.id).filter((k) => k < this.step && k < c.steps.length).map((k) => c.steps[k].body);
    Promise.all([import('../../campaign/ui/glossaryui'), import('../../chapters/firstuse')]).then(([m, f]) => {
      if (!el.isConnected) return;
      const skip = m.chapterSkip(c);
      for (const b of met) for (const id of m.termsIn(b)) skip.add(id);
      const at = outlineIndex(c.id);
      m.markTerms(el, 10, skip, (id) => f.later(outline, at, id));
    }, () => {});
  }

  private renderBody(st: Step): void {
    const b = this.body;
    const c = this.chapter;
    const prose = h('div', { class: 'prose', html: st.body });
    b.replaceChildren();
    if (this.step === 0 && (c.goals?.length || c.builds?.length)) b.append(this.goalsCard());
    b.append(h('h2', { class: 'step-title' }, st.title), prose);
    // target: a big scene is still being built (Stage.load)
    const lit = st.scene && this.stage.target ? litLine(this.stage.target, st.lit) : null;
    if (lit) b.append(lit);
    for (const a of analogiesOf(c.id, st.title)) {
      const el = analogyEl(a);
      b.append(el);
      this.gloss(el.querySelector<HTMLElement>('.analogy-in')!);
    }
    const place = this.place();
    if (place) {
      this.stepNotes = new StepNotes(st.scene || this.sceneShown ? this.stage : null, place, () => this.placeTitle());
      this.stage.noteMarks = this.stepNotes.marks;
      b.append(this.stepNotes.el);
      this.stage.updateNoteMarks();
    }
    this.unlisten.push(wireLooks(b, this.stage));
    this.gloss(prose);
    this.wireTries(prose, st);
    if (st.tour) {
      const go = h('button', { class: 'btn sm tour-go', onclick: () => {
        if (this.stage.loading) return;
        if (this.tour) return this.tour.el.focus();
        this.tour = new TourPlayer(this.stage, st.tour!, () => {
          this.tour = null;
          go.classList.remove('on');
          // Esc / Done / × leave the focus on the card that has just gone: back to the button that began the tour
          if (go.isConnected) go.focus({ preventScroll: true });
        });
        go.classList.add('on');
        this.tour.start();
      } }, icon('play', 14), h('span', null, st.tour.label ?? 'Walk me through it'));
      b.append(h('div', { class: 'tour-row' }, go, h('span', { class: 'muted' }, `${st.tour.beats.length} steps`)));
    }
    if (st.ledger && st.scene) {
      const lv = ledgerView(this.stage, st.ledger);
      b.append(lv.el);
      this.unlisten.push(this.stage.onChange(() => lv.update()));
    }
    if (st.more) b.append(this.layers(st.more));
    if (st.reading) b.append(this.reading(st.reading));
    if (st.actions?.length) {
      b.append(h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin:4px 0 8px' },
        st.actions.map((a) => h('button', { class: 'btn sm', onclick: () => a.run(this.stage) }, a.label))));
    }
    if (st.challenge) b.append(this.renderChallenge(st));
    this.stepNotes?.openPending();
  }

  /** "Read the spec": the manual's passage under the body, folded, with its questions (kept in the review queue). */
  private reading(r: Reading): HTMLElement {
    const key = (k: number) => `${this.chapter.id}:${this.step}:read:${k}`;
    const quotes = r.quote.map((p) => h('blockquote', null, p));
    const note = h('p', { class: 'reading-note' }); note.innerHTML = r.note;
    return h('details', { class: 'reading' },
      h('summary', null, icon('book', 14), h('span', null, 'Read the spec')),
      h('div', { class: 'reading-body' },
        h('p', { class: 'reading-src' }, r.source, ', ', h('b', null, r.section)),
        ...quotes, note,
        ...r.quizzes.map((q, k) => quizBox(q, key(k), `${k + 1} of ${r.quizzes.length}`, () => this.renderHead()))));
  }

  /** Tabs over the step's layers; one open at a time (the last chosen kind opens first on the next step that has it). */
  private layers(more: Layers): HTMLElement {
    const have = LAYERS.filter(([k]) => more[k]);
    const panel = h('div', { class: 'layer-body prose', role: 'tabpanel' });
    const tabs = have.map(([k, label]) => h('button', { role: 'tab', 'aria-selected': 'false', onclick: () => pick(k) }, label));
    let open: keyof Layers | null = null;
    const pick = (k: keyof Layers | null) => {
      open = open === k ? null : k;
      have.forEach(([kk], i) => tabs[i].setAttribute('aria-selected', String(kk === open)));
      panel.hidden = !open;
      panel.innerHTML = open ? more[open]! : '';
      if (open) this.gloss(panel);
      try { if (open) localStorage.setItem(LAYER_KEY, open); } catch { /* storage off: no memory */ }
    };
    let last: string | null = null;
    try { last = localStorage.getItem(LAYER_KEY); } catch { /* storage off */ }
    panel.hidden = true;
    const box = h('div', { class: 'layers' }, h('div', { class: 'layer-tabs', role: 'tablist', 'aria-label': 'Go deeper' }, ...tabs), panel);
    if (last && have.some(([k]) => k === last)) pick(last as keyof Layers);
    return box;
  }

  /**
   * On a phone the circuit sits under the text, below the fold, and nothing says so: a pill at the bottom of the screen
   * takes the learner to it, and goes away once the stage is in view (app.css .show-circuit shows it on a phone only).
   */
  private showCircuitButton(): HTMLElement {
    const b = h('button', { class: 'btn primary show-circuit', type: 'button', 'aria-label': 'Show the circuit', onclick: () => {
      this.stage.el.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
    } }, icon('chevD', 16), 'Show circuit');
    if (typeof IntersectionObserver !== 'undefined') {
      // Gone once the stage is mostly in view, and as soon as its bar is: the pill sits where the bar's right-hand icons do.
      let mostly = false, bar = false;
      const sync = () => { b.hidden = mostly || bar; };
      const io = new IntersectionObserver((es) => { for (const e of es) { if (e.target === this.stage.el) mostly = e.intersectionRatio > 0.35; else bar = e.isIntersecting; } sync(); }, { threshold: [0, 0.35, 0.6] });
      io.observe(this.stage.el);
      const barEl = this.stage.el.querySelector('.stage-bar');
      if (barEl) io.observe(barEl);
      // not in `unlisten`: that is emptied at every step change, and the pill lives as long as the page
      this.pillOff = () => io.disconnect();
    }
    return b;
  }

  private goalsCard(): HTMLElement {
    const c = this.chapter;
    const builds = (c.builds ?? []).map((id) => outlineOf(id)).filter((x) => !!x);
    return h('div', { class: 'ch-goals' },
      c.goals?.length ? h('div', { class: 'ch-goals-k' }, 'In this chapter you will') : null,
      c.goals?.length ? h('ul', null, c.goals.map((g) => h('li', { html: g }))) : null,
      builds.length ? h('div', { class: 'ch-links' }, h('span', { class: 'ch-links-k' }, 'Builds on'),
        builds.map((x) => h('a', { class: 'ch-chip', href: `#/c/${x.id}/0` }, `${chapterNo(x)} · ${x.title}`))) : null);
  }

  /**
   * A .try box with a condition (Step.tries) ticks itself once the condition holds on the stage, and stays ticked. A try
   * is practice, not one of the chapter's checks (challenges and recap questions, chapters/checks.ts): its tick says so,
   * in the quiet style, so it does not read as a solved check the counter missed.
   */
  private wireTries(prose: HTMLElement, st: Step): void {
    if (!st.tries?.length) return;
    const boxes = [...prose.querySelectorAll<HTMLElement>('.try')];
    st.tries.forEach((cond, k) => {
      const box = boxes[k];
      if (!box) return;
      const key = `${this.chapter.id}:${this.step}:try${k}`;
      const tick = () => {
        box.classList.add('tried');
        box.append(h('span', { class: 'try-done', title: 'Tries are practice on the circuit; the checks counted at the top are the Challenge and Question boxes' },
          icon('check', 13), 'Tried it', h('small', null, ' · practice, not a check')));
      };
      if (settings.isSolved(key)) return tick();
      this.unlisten.push(this.stage.onChange(() => {
        // not while the automatic clock runs untouched: the learner has not tried anything yet
        if (box.classList.contains('tried') || this.stage.autoRunning || !cond(this.stage)) return;
        settings.solve(key);
        this.notes.tried(box.textContent ?? '');
        tick();
      }));
    });
  }

  private renderChallenge(st: Step): HTMLElement {
    const ch = st.challenge!;
    const key = `${this.chapter.id}:${this.step}`;
    if (ch.kind === 'quiz') return quizBox(ch, key, 'Question', () => this.renderHead());
    const box = h('div', { class: 'challenge' });
    const tag = h('span', { class: 'tag' }, 'Challenge');
    box.append(h('div', { class: 'challenge-head' }, tag, ch.goal));
    const hints = h('div', { class: 'hints' });
    const ans = h('div', { class: 'explain' });
    const row = h('div', { class: 'challenge-actions' });
    // Once solved the card is the tick and the goal; the hints, the answer and Do it for me wait behind "Show how".
    const how = h('button', { class: 'btn ghost sm', 'aria-expanded': 'false' }, 'Show how') as HTMLButtonElement;
    how.addEventListener('click', () => {
      const open = how.getAttribute('aria-expanded') !== 'true';
      how.setAttribute('aria-expanded', String(open));
      how.textContent = open ? 'Hide how' : 'Show how';
      box.classList.toggle('how-open', open);
    });
    const markSolved = () => {
      box.classList.add('solved');
      tag.replaceChildren(icon('check', 12), ' Solved');
      settings.solve(key);
      how.hidden = false;
    };
    how.hidden = true;
    const all = ch.hints ?? [];
    if (all.length) {
      let n = 0;
      const more = h('button', { class: 'btn ghost sm' }, `Show a hint (0 of ${all.length})`);
      more.addEventListener('click', () => {
        hints.append(h('div', { class: 'hint-step' }, h('b', null, `Hint ${n + 1}. `), h('span', { html: all[n] })));
        n++;
        if (n >= all.length) more.remove();
        else more.textContent = `Another hint (${n} of ${all.length})`;
      });
      row.append(more);
    }
    const show = h('button', { class: 'btn ghost sm' }, 'Show answer');
    show.addEventListener('click', () => {
      ans.innerHTML = ch.answer;
      show.remove();
      if (ch.solve) row.append(h('button', { class: 'btn sm', onclick: () => ch.solve!(this.stage) }, 'Do it for me'));
    });
    row.append(show);
    box.append(hints, row, ans, h('div', { class: 'challenge-how' }, how));
    if (settings.isSolved(key)) markSolved();
    // The goal over the canvas too; a click on it shows this card (and lands keyboard focus there).
    box.tabIndex = -1;
    this.notes.goal(ch.goal, box.classList.contains('solved'), () => {
      reveal(box);
      box.focus({ preventScroll: true });
    });
    this.unlisten.push(this.stage.onChange(() => {
      if (box.classList.contains('solved') || !ch.check(this.stage)) return;
      markSolved();
      this.renderHead();
      this.notes.solved();
      // Where the text panel scrolls on its own (not on a phone, where it sits above the stage and moving it would
      // move the circuit away), bring the card, now green, into view.
      if (this.textScrolls()) reveal(box);
    }));
    return box;
  }

  private renderRecap(): void {
    const c = this.chapter;
    const r = c.recap!;
    const links = h('div', { class: 'recap-links' });
    const qs = r.check ?? [];
    this.body.replaceChildren(
      h('h2', { class: 'step-title' }, 'Recap'),
      h('div', { class: 'recap-k' }, 'What to keep'),
      h('ul', { class: 'prose recap-keep' }, r.keep.map((k) => h('li', { html: k }))),
      ...(qs.length ? [h('div', { class: 'recap-k recap-check' }, 'Check yourself')] : []),
      ...qs.map((q, k) => quizBox(q, `${c.id}:recap:${k}`, `${k + 1} of ${qs.length}`, () => this.renderHead())),
      links,
    );
    import('../../campaign/chapterlinks').then((m) => {
      if (!links.isConnected) return;
      const row = (label: string, cls: string, ls: { title: string; href: string }[]) => ls.length
        ? [h('div', { class: 'ch-links' }, h('span', { class: 'ch-links-k' }, label), ls.map((l) => h('a', { class: `ch-chip ${cls}`, href: l.href }, l.title)))]
        : [];
      links.replaceChildren(...row('In the codex', 'cx', m.codexFor(c.id)), ...row('Practise in the campaign', 'lv', m.practiceFor(c.id, r.practise)));
    }, () => {});
  }

  private renderFoot(): void {
    const n = this.chapter.steps.length;
    const idx = outlineIndex(this.chapter.id);
    const next = outline[idx + 1];
    const prev = outline[idx - 1];
    const last = this.recap >= 0 ? this.recap : n - 1;
    const prevBtn = this.step > 0
      ? h('button', { class: 'btn', onclick: () => this.goStep(this.step - 1) }, icon('chevL', 16), 'Back')
      : prev ? h('a', { class: 'btn', title: prev.title, href: `#/c/${prev.id}/${recapIndex(prev) ?? prev.steps.length - 1}` }, icon('chevL', 16), h('span', { class: 'lbl' }, h('small', null, 'Previous'), h('span', { class: 't' }, prev.title))) : h('span');
    const nextBtn = this.step < last
      ? h('button', { class: 'btn primary', onclick: () => this.goStep(this.step + 1) }, this.step + 1 === this.recap ? 'Recap' : 'Next', icon('chevR', 16))
      : next ? h('a', { class: 'btn primary', title: next.title, href: `#/c/${next.id}/0` }, h('span', { class: 'lbl' }, h('small', null, 'Next'), h('span', { class: 't' }, next.title)), icon('chevR', 16))
        : h('a', { class: 'btn primary', href: '#/' }, 'Back to the map');
    // the key on each (hidden on touch screens and with single-key shortcuts off: app.css)
    if (prevBtn instanceof HTMLButtonElement || prevBtn instanceof HTMLAnchorElement) {
      prevBtn.setAttribute('aria-keyshortcuts', '[');
      prevBtn.append(h('kbd', { class: 'kbd-hint', 'aria-hidden': 'true' }, '['));
    }
    nextBtn.setAttribute('aria-keyshortcuts', ']');
    nextBtn.append(h('kbd', { class: 'kbd-hint', 'aria-hidden': 'true' }, ']'));
    this.foot.replaceChildren(prevBtn, h('span', { class: 'count' }, this.step === this.recap ? 'Recap' : `${this.step + 1} / ${n}`), nextBtn);
  }

  /** Does the text panel scroll by itself (side by side with the stage), rather than with the page (a phone)? */
  private textScrolls(): boolean {
    const o = getComputedStyle(this.body).overflowY;
    return (o === 'auto' || o === 'scroll') && this.body.scrollHeight > this.body.clientHeight;
  }

  /** The top bar's way back (ui/returnto.ts): chapter and step. */
  returnLabel(): { label: string; short: string } {
    const no = chapterNo(this.chapter), st = this.chapter.steps[this.step];
    return st ? { label: `Ch ${no} · ${st.title}`, short: `Ch ${no} · ${this.step + 1}` } : { label: `Ch ${no} · Recap`, short: `Ch ${no} · recap` };
  }

  destroy(): void {
    // (the next page may already have set it: the old one is destroyed after the new one is built)
    if (widgetStepOwner === this) document.documentElement.removeAttribute('data-widget-step');
    this.offNotes();
    this.stepNotes?.destroy();
    this.notes.clear();
    this.unbindKeys();
    this.unlisten.forEach((f) => f());
    this.pillOff?.();
    this.stage.destroy();
  }
}
