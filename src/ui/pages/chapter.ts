// A chapter: narrative on the left, the live stage in the middle, the inspector on the right.

import { chapters } from '../../chapters';
import type { Chapter, Step } from '../../chapters/types';
import { Inspector } from '../../view/inspector';
import { Stage } from '../../view/stage';
import { transistorLeaf } from '../../widgets/mosfet';
import { h, icon } from '../dom';
import { toggleChapterMenu } from '../quicknav';
import { settings } from '../settings';

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
  private unlisten: (() => void) | null = null;

  constructor(chapter: Chapter, step: number) {
    this.chapter = chapter;
    this.inspector = new Inspector();
    this.stage = new Stage(this.inspector);
    this.stage.leafFactory = transistorLeaf;
    this.head = h('div', { class: 'narrative-head' });
    this.body = h('div', { class: 'narrative-body' });
    this.foot = h('div', { class: 'narrative-foot' });
    const narrative = h('aside', { class: 'narrative' }, this.head, this.body, this.foot);
    this.el = h('div', { class: 'layout' }, narrative, this.stage.el, this.inspector.el);
    this.goStep(step);
  }

  goStep(i: number): void {
    const steps = this.chapter.steps;
    i = Math.max(0, Math.min(steps.length - 1, i));
    if (i === this.step) return;
    this.step = i;
    settings.visit(this.chapter.id, i);
    const st = steps[i];
    this.unlisten?.();
    this.unlisten = null;
    if (st.scene) this.stage.load(st.scene());
    else if (st.widget) this.stage.showWidget(st.widget());
    this.el.classList.toggle('no-inspector', !st.scene);
    this.renderHead();
    this.renderBody(st);
    this.renderFoot();
    this.body.scrollTop = 0;
    const want = `#/c/${this.chapter.id}/${i}`;
    if (location.hash !== want) history.replaceState(null, '', want);
  }

  private renderHead(): void {
    const c = this.chapter;
    const visited = settings.visited(c.id);
    this.head.replaceChildren(
      h('div', { class: 'chapter-kicker' }, `Chapter ${c.num} · ${c.level}`),
      h('h1', { class: 'chapter-title' }, h('button', {
        class: 'chapter-switch', title: 'Switch chapter', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
        onclick: (e: Event) => toggleChapterMenu(e.currentTarget as HTMLElement),
      }, h('span', null, c.title), icon('chevD', 18))),
      h('div', { class: 'steps-dots', role: 'tablist' }, c.steps.map((s, i) =>
        h('button', {
          class: i === this.step ? 'cur' : visited.includes(i) ? 'done' : '',
          title: `${i + 1}. ${s.title}`, 'aria-label': `Step ${i + 1}: ${s.title}`,
          onclick: () => this.goStep(i),
        }))),
    );
  }

  private renderBody(st: Step): void {
    const b = this.body;
    b.replaceChildren(h('h2', { class: 'step-title' }, st.title), h('div', { class: 'prose', html: st.body }));
    if (st.actions?.length) {
      b.append(h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin:4px 0 8px' },
        st.actions.map((a) => h('button', { class: 'btn sm', onclick: () => a.run(this.stage) }, a.label))));
    }
    if (st.challenge) b.append(this.renderChallenge(st));
  }

  private renderChallenge(st: Step): HTMLElement {
    const ch = st.challenge!;
    const key = `${this.chapter.id}:${this.step}`;
    const box = h('div', { class: 'challenge' });
    const tag = h('span', { class: 'tag' }, ch.kind === 'quiz' ? 'Question' : 'Challenge');
    const markSolved = () => {
      box.classList.add('solved');
      tag.replaceChildren(icon('check', 12));
      tag.append(' Solved');
      settings.solve(key);
    };
    if (ch.kind === 'reach') {
      box.append(h('div', { class: 'challenge-head' }, tag, ch.goal));
      const ans = h('div', { class: 'explain' });
      const row = h('div', { class: 'challenge-actions' });
      const show = h('button', { class: 'btn ghost sm' }, 'Show answer');
      show.addEventListener('click', () => {
        ans.textContent = ch.answer;
        show.remove();
        if (ch.solve) row.append(h('button', { class: 'btn sm', onclick: () => ch.solve!(this.stage) }, 'Do it for me'));
      });
      row.append(show);
      box.append(row, ans);
      if (settings.isSolved(key)) markSolved();
      const check = () => {
        if (!box.classList.contains('solved') && ch.check(this.stage)) markSolved();
      };
      this.unlisten = this.stage.onChange(check);
    } else {
      box.append(h('div', { class: 'challenge-head' }, tag, ch.question));
      const explain = h('div', { class: 'explain' });
      const opts = h('div', { class: 'options' });
      const reveal = h('button', { class: 'btn ghost sm', style: 'margin-top:8px' }, 'Show answer');
      reveal.addEventListener('click', () => {
        (opts.children[ch.answer] as HTMLElement).classList.add('right');
        explain.textContent = ch.explain;
        reveal.remove();
      });
      ch.options.forEach((o, i) => {
        const btn = h('button', { class: 'btn' }, o);
        btn.addEventListener('click', () => {
          if (i === ch.answer) {
            btn.classList.add('right');
            explain.textContent = ch.explain;
            reveal.remove();
            markSolved();
          } else {
            btn.classList.add('wrong');
            explain.textContent = 'Not quite. Try another answer.';
          }
        });
        opts.append(btn);
      });
      box.append(opts, reveal, explain);
      if (settings.isSolved(key)) {
        reveal.remove();
        markSolved();
        explain.textContent = ch.explain;
        (opts.children[ch.answer] as HTMLElement).classList.add('right');
      }
    }
    return box;
  }

  private renderFoot(): void {
    const n = this.chapter.steps.length;
    const idx = chapters.indexOf(this.chapter);
    const next = chapters[idx + 1];
    const prev = chapters[idx - 1];
    const prevBtn = this.step > 0
      ? h('button', { class: 'btn', onclick: () => this.goStep(this.step - 1) }, icon('chevL', 16), 'Back')
      : prev ? h('a', { class: 'btn', href: `#/c/${prev.id}/${prev.steps.length - 1}` }, icon('chevL', 16), prev.title) : h('span');
    const nextBtn = this.step < n - 1
      ? h('button', { class: 'btn primary', onclick: () => this.goStep(this.step + 1) }, 'Next', icon('chevR', 16))
      : next ? h('a', { class: 'btn primary', href: `#/c/${next.id}/0` }, next.title, icon('chevR', 16))
        : h('a', { class: 'btn primary', href: '#/' }, 'Back to the map');
    this.foot.replaceChildren(prevBtn, h('span', { class: 'count' }, `${this.step + 1} / ${n}`), nextBtn);
  }

  destroy(): void {
    this.unlisten?.();
    this.stage.destroy();
  }
}
