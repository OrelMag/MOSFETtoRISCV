// A chapter: narrative on the left, the live stage in the middle, the inspector on the right.

import { chapters } from '../../chapters';
import { checksDone, recapIndex } from '../../chapters/checks';
import { chapterNo, type Chapter, type Step } from '../../chapters/types';
import { Inspector } from '../../view/inspector';
import { Stage } from '../../view/stage';
import { transistorLeaf } from '../../widgets/mosfet';
import { h, icon } from '../dom';
import { drillLanded, drillSegs, syncDrill } from '../drillpath';
import { toggleChapterMenu } from '../quicknav';
import { quizBox } from '../quiz';
import { settings } from '../settings';
import { litLine, wireLooks } from './looks';

export interface Page {
  el: HTMLElement;
  destroy(): void;
}

export class ChapterPage implements Page {
  readonly el: HTMLElement;
  readonly chapter: Chapter;
  private stage: Stage;
  private inspector: Inspector;
  private head: HTMLElement;
  private body: HTMLElement;
  private foot: HTMLElement;
  private step = -1;
  /** Has the stage shown anything yet (a step without a scene keeps the last one, or borrows a neighbour's)? */
  private shown = false;
  /** Is the stage showing a scene (not a widget)? Only a scene has a drill path in the hash. */
  private sceneShown = false;
  /** Following the address bar (a route): the stage's moves are not new history entries. */
  private routing = false;
  private unlisten: (() => void)[] = [];

  constructor(chapter: Chapter, step: number, path?: string[]) {
    this.chapter = chapter;
    this.inspector = new Inspector();
    this.stage = new Stage(this.inspector);
    this.stage.leafFactory = transistorLeaf;
    this.head = h('div', { class: 'narrative-head' });
    this.body = h('div', { class: 'narrative-body' });
    this.foot = h('div', { class: 'narrative-foot' });
    const narrative = h('aside', { class: 'narrative' }, this.head, this.body, this.foot);
    this.el = h('div', { class: 'layout' }, narrative, this.stage.el, this.inspector.el);
    // Each level opened is a history entry (ui/drillpath.ts): #/c/<chapter>/<step>/<instance>/…
    this.stage.onNavigate(() => {
      if (this.sceneShown) syncDrill(this.hash(), this.routing);
    });
    this.goStep(step, path);
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
    if (st.scene) this.stage.load(st.scene(), path);
    else this.stage.showWidget(st.widget!());
    this.shown = true;
    this.sceneShown = !!st.scene;
    this.el.classList.toggle('no-inspector', !st.scene);
  }

  private renderHead(): void {
    const c = this.chapter;
    const visited = settings.visited(c.id);
    const dots = c.steps.map((s, i) => {
      const solved = !!s.challenge && settings.isSolved(`${c.id}:${i}`);
      return h('button', {
        class: [i === this.step ? 'cur' : visited.includes(i) ? 'done' : '', solved ? 'solved' : ''].filter(Boolean).join(' '),
        title: `${i + 1}. ${s.title}${s.challenge ? (solved ? ' (check solved)' : ' (has a check)') : ''}`,
        'aria-label': `Step ${i + 1}: ${s.title}${solved ? ', check solved' : ''}`,
        onclick: () => this.goStep(i),
      });
    });
    if (this.recap >= 0) {
      dots.push(h('button', {
        class: `recap${this.step === this.recap ? ' cur' : ''}`, title: 'Recap', 'aria-label': 'Recap', onclick: () => this.goStep(this.recap),
      }));
    }
    const { done, total } = checksDone(c, (k) => settings.isSolved(k));
    this.head.replaceChildren(
      h('div', { class: `chapter-kicker${c.appendix ? ' appendix' : c.prologue ? ' prologue' : ''}` }, `${c.appendix ? `Appendix ${c.appendix}` : c.prologue ? `Prologue ${c.prologue}` : `Chapter ${c.num}`} · ${c.level}`),
      h('h1', { class: 'chapter-title' }, h('button', {
        class: 'chapter-switch', title: 'Switch chapter', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
        onclick: (e: Event) => toggleChapterMenu(e.currentTarget as HTMLElement),
      }, h('span', null, c.title), icon('chevD', 18))),
      h('div', { class: 'steps-row' },
        h('div', { class: 'steps-dots', role: 'tablist' }, dots),
        total ? h('span', { class: 'checks-count', title: 'Questions and challenges solved in this chapter' }, `${done} / ${total} checks`) : null),
    );
  }

  /** Hover definitions: a chunk of its own, marked once it arrives (if still shown), skipping terms met in earlier steps seen. */
  private gloss(el: HTMLElement): void {
    if (!settings.glossary) return;
    const c = this.chapter;
    const met = settings.visited(c.id).filter((k) => k < this.step && k < c.steps.length).map((k) => c.steps[k].body);
    import('../../campaign/ui/glossaryui').then((m) => {
      if (!el.isConnected) return;
      const skip = m.chapterSkip(c);
      for (const b of met) for (const id of m.termsIn(b)) skip.add(id);
      m.markTerms(el, 10, skip);
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
    this.unlisten.push(wireLooks(b, this.stage));
    this.gloss(prose);
    this.wireTries(prose, st);
    if (st.actions?.length) {
      b.append(h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin:4px 0 8px' },
        st.actions.map((a) => h('button', { class: 'btn sm', onclick: () => a.run(this.stage) }, a.label))));
    }
    if (st.challenge) b.append(this.renderChallenge(st));
  }

  private goalsCard(): HTMLElement {
    const c = this.chapter;
    const builds = (c.builds ?? []).map((id) => chapters.find((x) => x.id === id)).filter((x): x is Chapter => !!x);
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
        if (box.classList.contains('tried') || !cond(this.stage)) return;
        settings.solve(key);
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
    const markSolved = () => {
      box.classList.add('solved');
      tag.replaceChildren(icon('check', 12), ' Solved');
      settings.solve(key);
    };
    box.append(h('div', { class: 'challenge-head' }, tag, ch.goal));
    const hints = h('div', { class: 'hints' });
    const ans = h('div', { class: 'explain' });
    const row = h('div', { class: 'challenge-actions' });
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
    box.append(hints, row, ans);
    if (settings.isSolved(key)) markSolved();
    this.unlisten.push(this.stage.onChange(() => {
      if (box.classList.contains('solved') || !ch.check(this.stage)) return;
      markSolved();
      this.renderHead();
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
    const idx = chapters.indexOf(this.chapter);
    const next = chapters[idx + 1];
    const prev = chapters[idx - 1];
    const last = this.recap >= 0 ? this.recap : n - 1;
    const prevBtn = this.step > 0
      ? h('button', { class: 'btn', onclick: () => this.goStep(this.step - 1) }, icon('chevL', 16), 'Back')
      : prev ? h('a', { class: 'btn', href: `#/c/${prev.id}/${recapIndex(prev) ?? prev.steps.length - 1}` }, icon('chevL', 16), prev.title) : h('span');
    const nextBtn = this.step < last
      ? h('button', { class: 'btn primary', onclick: () => this.goStep(this.step + 1) }, this.step + 1 === this.recap ? 'Recap' : 'Next', icon('chevR', 16))
      : next ? h('a', { class: 'btn primary', href: `#/c/${next.id}/0` }, next.title, icon('chevR', 16))
        : h('a', { class: 'btn primary', href: '#/' }, 'Back to the map');
    this.foot.replaceChildren(prevBtn, h('span', { class: 'count' }, this.step === this.recap ? 'Recap' : `${this.step + 1} / ${n}`), nextBtn);
  }

  destroy(): void {
    this.unlisten.forEach((f) => f());
    this.stage.destroy();
  }
}
