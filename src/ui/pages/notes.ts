// My notes (#/notes, its own chunk): the learner's notes and bookmarks on the left, filtered and searched, each linking back
// to its place; the review queue on the right (ui/review.ts: the questions answered wrong first, then the ones asked
// again, then the longest unseen, from chapters visited), asked with the same quizBox as everywhere; a drill with its
// typed answer (learn/asker.ts drillBox).

import '../../styles/path.css';
import { DRILLS, rng } from '../../campaign/drills';
import { drillBox } from '../../learn/asker';
import { h, icon } from '../dom';
import { noteHaystack, placeLabel } from '../notelabel';
import { type NoteItem, notes, openNoteNext, placeHref, snippet } from '../notes';
import { quizBox } from '../quiz';
import { buildQueue, type QueueItem, reviewLog, summarize } from '../review';
// campaign/nodes.ts (lesson titles) reaches lib/resolve.ts: the whole registry, as on the campaign page (tests/firstload.test.ts)
import '../../lib';
import { buildQuestions, type ReviewQ } from '../reviewbuild';
import { loadChapter } from '../../chapters/load';
import { outline } from '../../chapters/outline';
import { settings } from '../settings';
import type { Page } from './chapter';

type Filter = 'all' | 'note' | 'bookmark';
const SESSION = 12;

const date = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

export class NotesPage implements Page {
  readonly kind = 'notes';
  readonly el: HTMLElement;
  private filter: Filter = 'all';
  private query = '';
  private list = h('div', { class: 'np-items' });
  private chips = h('div', { class: 'np-chips', role: 'group', 'aria-label': 'Show' });
  private review = h('section', { class: 'np-review', 'aria-label': 'Review' });
  private off: () => void;
  private queue: QueueItem<ReviewQ>[] = [];
  private at = 0;
  private done = 0;
  private soonDone = new Set<string>();
  /** The questions of the chapters visited (loaded on demand: importing every chapter froze the page for seconds). */
  private qs: ReviewQ[] | null = null;
  private alive = true;

  constructor() {
    const search = h('input', { type: 'search', class: 'np-search', placeholder: 'Search notes', 'aria-label': 'Search notes' }) as HTMLInputElement;
    search.addEventListener('input', () => { this.query = search.value.trim().toLowerCase(); this.renderList(); });
    this.el = h('div', { class: 'np-page' },
      h('section', { class: 'np-left', 'aria-label': 'Notes and bookmarks' },
        h('h1', null, 'My notes'),
        h('div', { class: 'np-bar' }, this.chips, search),
        this.list),
      this.review);
    this.off = notes().onChange(() => this.renderList());
    this.renderList();
    this.startReview();
  }

  destroy(): void {
    this.off();
    this.alive = false;
  }

  private renderList(): void {
    const all = notes().list();
    const count = { all: all.length, note: all.filter((i) => i.type === 'note').length, bookmark: all.filter((i) => i.type === 'bookmark').length };
    this.chips.replaceChildren(...([['all', 'All'], ['note', 'Notes'], ['bookmark', 'Bookmarks']] as const).map(([k, label]) =>
      h('button', {
        class: `np-chip${this.filter === k ? ' on' : ''}`, type: 'button', 'aria-pressed': String(this.filter === k),
        onclick: () => { this.filter = k; this.renderList(); },
      }, label, h('small', null, ` ${count[k]}`))));
    const shown = all.filter((i) => (this.filter === 'all' || i.type === this.filter) && (!this.query || noteHaystack(i).includes(this.query)));
    this.list.replaceChildren(...(shown.length ? shown.map((i) => this.row(i)) : [h('p', { class: 'np-empty' },
      all.length ? 'Nothing matches.' : 'No notes or bookmarks yet. Use Bookmark and Add note in a step’s header, or the bookmark on a workbench component or a sandbox chip.')]));
  }

  private row(it: NoteItem): HTMLElement {
    const { head, sub } = placeLabel(it);
    const pin = it.pin?.inst ? ` · on ${it.pin.inst}` : it.pin ? ' · pinned' : '';
    const link = h('a', {
      class: 'np-link', href: placeHref(it.place, it.pin),
      title: it.pin ? 'Open the step with the part shown and the inputs put back' : 'Open',
      onclick: () => openNoteNext(it.type === 'note' ? it.id : null),
    }, it.type === 'bookmark' ? icon('bookmarkOn', 14) : null,
    h('span', { class: 'np-k' }, `${head}${sub ? ` · ${sub}` : ''}${pin}`),
    it.type === 'note' ? h('span', { class: 'np-text' }, snippet(it.text, 400)) : null);
    return h('div', { class: `np-item${it.type === 'bookmark' ? ' mark' : ''}` }, link,
      h('span', { class: 'np-when' }, date(it.edited)),
      h('button', { class: 'np-del btn ghost sm icon-only', type: 'button', 'aria-label': `Delete ${it.type}`, title: 'Delete', onclick: () => notes().remove(it.id) }, icon('close', 14)));
  }

  // ---- review ------------------------------------------------------------------------------------------

  private opts() {
    return { now: Date.now(), visited: (c: string) => settings.visited(c).length > 0 };
  }

  private startReview(): void {
    if (!this.qs) {
      this.review.replaceChildren(h('div', { class: 'np-rhead' }, h('h2', null, 'Review')), h('p', { class: 'np-empty' }, 'Gathering the questions…'));
      const visited = outline.filter((c) => settings.visited(c.id).length > 0);
      Promise.all(visited.map((c) => loadChapter(c.id))).then((chs) => {
        this.qs = buildQuestions(chs);
        if (this.alive) this.startReview();
      }, () => {
        if (this.alive) this.review.replaceChildren(h('p', { class: 'np-empty' }, 'The questions could not load: reload the page to try again.'));
      });
      return;
    }
    const o = this.opts();
    this.queue = buildQueue(this.qs, reviewLog().state, { ...o, limit: SESSION });
    this.at = 0;
    this.done = 0;
    this.soonDone.clear();
    this.renderReview();
  }

  private summaryLine(): string {
    const s = summarize(this.qs ?? [], reviewLog().state, this.opts());
    const parts = [`${this.done} of ${this.queue.length} today`];
    if (s.missed) parts.push(`${s.missed} missed before`);
    if (s.stale) parts.push(`${s.stale} not seen for 2 weeks`);
    if (s.fresh) parts.push(`${s.fresh} not asked yet`);
    return parts.join(' · ');
  }

  private renderReview(): void {
    const q = this.queue[this.at];
    const total = this.queue.length;
    const head = h('div', { class: 'np-rhead' }, h('h2', null, 'Review'), h('span', { class: 'np-rsum' }, total ? this.summaryLine() : ''));
    if (!q) {
      const empty = !total && !this.done;
      this.review.replaceChildren(head,
        h('p', { class: 'np-empty' }, empty
          ? 'Nothing to review yet. Questions appear here from the chapters you have opened, after you answer them in the steps and recaps; the ones you miss come back first.'
          : `Done for today: ${this.done} question${this.done === 1 ? '' : 's'} answered. The right ones come back in 2, 7, 21 days.`),
        ...(empty ? [] : [h('button', { class: 'btn', type: 'button', onclick: () => this.startReview() }, 'Check for more')]));
      return;
    }
    const why = q.why === 'missed' ? this.missedNote(q.q.key) : q.why === 'soon' ? 'you asked to see this again' : q.why === 'new' ? 'not asked yet' : 'due again';
    const pct = Math.round((this.done / total) * 100);
    const onAnswer = (right: boolean) => { reviewLog().record(q.q.key, right); this.done++; this.progress(); };
    // a drill: a fresh question of it each time, under the drill's one key
    const drill = q.q.drill ? DRILLS[q.q.drill] : undefined;
    const box = drill ? drillBox(drill.make(rng(Date.now())), drill.how, onAnswer)
      : quizBox(q.q.quiz!, q.q.key, `${this.at + 1} of ${total}`, () => {}, { fresh: true, onAnswer });
    box.classList.add('np-quiz');
    const bar = h('div', { class: 'np-bar-track', role: 'progressbar', 'aria-valuenow': String(pct), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': 'Review progress' },
      h('div', { class: 'np-bar-fill', style: `width:${pct}%` }));
    const soon = h('button', { class: 'btn', type: 'button', title: 'Keep this question near the top of the queue until you answer it',
      onclick: () => { reviewLog().ask(q.q.key); this.soonDone.add(q.q.key); soon.textContent = 'Will ask again soon'; soon.setAttribute('disabled', ''); this.next(); } }, 'Ask again soon') as HTMLButtonElement;
    this.review.replaceChildren(head, bar,
      h('div', { class: 'np-origin' }, `${q.q.origin} · ${why}`),
      box,
      h('div', { class: 'np-actions' },
        h('a', { class: 'np-open', href: q.q.href }, 'Open the step'),
        h('span', { class: 'sp' }), soon,
        h('button', { class: 'btn primary', type: 'button', onclick: () => this.next() }, this.at + 1 < total ? 'Next question' : 'Finish')));
  }

  private progress(): void {
    const bar = this.review.querySelector<HTMLElement>('.np-bar-fill');
    const track = this.review.querySelector<HTMLElement>('.np-bar-track');
    const pct = Math.round((this.done / Math.max(1, this.queue.length)) * 100);
    if (bar) bar.style.width = `${pct}%`;
    track?.setAttribute('aria-valuenow', String(pct));
    const sum = this.review.querySelector('.np-rsum');
    if (sum) sum.textContent = this.summaryLine();
  }

  private next(): void {
    this.at++;
    this.renderReview();
  }

  private missedNote(key: string): string {
    const m = reviewLog().state.memos[key];
    return m?.missed ? `you missed this on ${date(m.missed)}` : 'you missed this';
  }
}
