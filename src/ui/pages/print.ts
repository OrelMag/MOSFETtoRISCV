// Print this chapter (#/c/<id>/print[/<step>], its own chunk): the whole chapter as a book page flow, every step's text with its
// scene as a figure, the questions with their answers at the end, then the browser's print dialog (which also saves as PDF).
// What each step contributes is chapters/printplan.ts; the figures are drawn by ui/pages/printfig.ts on a white board in the Monochrome
// palette. The page stays on screen after the dialog: Print again, Back to the chapter. Ctrl+P on an ordinary step is app.css's own.

import { outlineOf } from '../../chapters/outline';
import { analogiesOf } from '../../chapters/analogies';
import { planChapter, truthTable, type ChapterPlan, type ModelFigure, type StepPlan } from '../../chapters/printplan';
import { chapterNo, type Chapter, type Layers, type Quiz, type Reading, type Step } from '../../chapters/types';
import { nextTask } from '../../sim/tasks';
import { h } from '../dom';
import { SITE_URL } from '../viewlink';
import type { Page } from './chapter';
import { FigureMaker } from './printfig';
import css from '../../styles/print.css?inline';

const LAYERS: [keyof Layers, string][] = [['derive', 'Derivation'], ['real', 'In real silicon'], ['pitfall', 'Common mistake'], ['numbers', 'Numbers']];
const LETTERS = 'ABCDEFGHIJ';

/** A step's address on the public site (the paper's link back to the live circuit). */
export const stepUrl = (chapter: string, step: number): string => `${SITE_URL}#/c/${chapter}/${step}`;

/** A frame to paint in (a hidden tab gets none: the timer lets the build go on). */
const paint = (): Promise<void> => new Promise((r) => { requestAnimationFrame(() => setTimeout(r, 0)); setTimeout(r, 120); });

/** A step's HTML as plain reading text: nothing points at the live circuit, asides are open, links go to the public site. */
export function proseEl(html: string, cls = 'pd-prose'): HTMLElement {
  const el = h('div', { class: cls, html });
  for (const e of el.querySelectorAll('[data-show], [data-ahead]')) { e.removeAttribute('data-show'); e.removeAttribute('data-ahead'); }
  for (const d of el.querySelectorAll('details')) d.setAttribute('open', '');
  for (const a of el.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) a.setAttribute('href', SITE_URL + a.getAttribute('href'));
  return el;
}

const rich = (tag: 'p' | 'div' | 'li' | 'span', html: string, cls?: string): HTMLElement => {
  const el = h(tag, cls ? { class: cls } : null);
  el.innerHTML = html;
  return el;
};

/** A question as printed: its options lettered, the answer left for the end of the chapter. */
function questionEl(n: number, q: Quiz): HTMLElement {
  return h('div', { class: 'pd-q' },
    h('div', { class: 'pd-q-k' }, `Question ${n}`),
    rich('div', q.question, 'pd-q-text'),
    h('ol', { class: 'pd-opts', type: 'A' }, q.options.map((o) => rich('li', o))));
}

const inputsText = (inputs: Record<string, number> | undefined): string => {
  const e = Object.entries(inputs ?? {});
  return e.length ? e.slice(0, 8).map(([k, v]) => `${k} = ${v}`).join(', ') + (e.length > 8 ? ', …' : '') : '';
};

export class PrintPage implements Page {
  readonly kind = 'print';
  readonly noTools = true;
  readonly el: HTMLElement;
  private readonly plan: ChapterPlan;
  private readonly style: HTMLStyleElement;
  private readonly bar = h('div', { class: 'pv-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, h('i'));
  private readonly status = h('span', { class: 'pv-status', role: 'status' });
  private readonly cancel = h('button', { class: 'btn sm', type: 'button', onclick: () => { this.cancelled = true; } }, 'Cancel');
  private readonly printBtn = h('button', { class: 'btn primary sm', type: 'button', hidden: true, onclick: () => window.print() }, 'Print again');
  private readonly slots = new Map<number, HTMLElement>();
  /** A 3D model's figure body, by model id. */
  private readonly modelSlots = new Map<string, HTMLElement>();
  private cancelled = false;
  private dead = false;
  private maker: FigureMaker | null = null;

  constructor(private readonly chapter: Chapter, from: number) {
    this.plan = planChapter(chapter);
    // The page footer (Chrome's margin boxes; Firefox has none): the site, the chapter's address, the page. Only while this page is shown.
    this.style = h('style', { 'data-print-view': '' });
    this.style.textContent = `${css}\n@page { @bottom-center { content: "#/c/${chapter.id}"; } }`;
    document.head.append(this.style);
    const back = h('a', { class: 'btn sm', href: `#/c/${chapter.id}/${Math.max(0, Math.min(from, chapter.steps.length - 1))}` }, 'Back to the chapter');
    const tools = h('div', { class: 'pv-tools' }, this.status, this.bar, this.cancel, this.printBtn, back);
    this.el = h('div', { class: 'scroll print-view', 'data-print-ready': 'no' }, tools, this.document());
    void this.build();
  }

  // ---- the document --------------------------------------------------------------------------------

  private document(): HTMLElement {
    const c = this.chapter;
    const meta = outlineOf(c.id)!;
    const no = c.appendix ? `Appendix ${c.appendix}` : c.prologue ? `Prologue ${c.prologue}` : c.label ?? `Chapter ${c.num}`;
    const head = h('header', { class: 'pd-head' },
      h('div', { class: 'pd-kicker' }, `${no} · ${c.level}`),
      h('h1', null, c.title),
      rich('p', c.blurb, 'pd-blurb'));
    if (c.goals?.length) head.append(h('div', { class: 'pd-goals' }, h('b', null, 'In this chapter you will'), h('ul', null, c.goals.map((g) => rich('li', g)))));
    const builds = (c.builds ?? []).map((id) => outlineOf(id)).filter((x): x is NonNullable<typeof x> => !!x);
    if (builds.length) head.append(h('p', { class: 'pd-builds' }, 'Builds on: ', builds.map((x) => `${chapterNo(x)} · ${x.title}`).join('; ')));
    head.append(h('p', { class: 'pd-src' }, `${meta.steps.length} steps. The live chapter, with its circuits to operate: `, h('a', { href: stepUrl(c.id, 0) }, stepUrl(c.id, 0))));
    const doc = h('article', { class: 'pd-doc' }, head);
    this.plan.steps.forEach((p, i) => doc.append(this.stepEl(this.chapter.steps[i], p, i)));
    if (c.recap) doc.append(this.recapEl());
    doc.append(this.answersEl());
    return doc;
  }

  private stepEl(st: Step, p: StepPlan, i: number): HTMLElement {
    const c = this.chapter;
    const prose = proseEl(st.body);
    // a step with a 3D model: its Try lines ask for the model's buttons, which paper has not got; they follow the figure, for the site
    const tries = p.models.length ? [...prose.querySelectorAll<HTMLElement>('.try')] : [];
    for (const t of tries) t.remove();
    const sec = h('section', { class: 'pd-step' },
      h('h2', null, st.title),
      h('div', { class: 'pd-addr' }, `Step ${i + 1} of ${c.steps.length} · ${stepUrl(c.id, i)}`),
      prose);
    if (p.mode === 'sim' || p.mode === 'top') sec.append(this.figureSlot(p, st));
    else if (p.mode === 'link') sec.append(this.linkNote(i, `Not drawn: ${p.reason}.`));
    else if (p.mode === 'live') sec.append(this.linkNote(i, 'A live explainer; it does not print.'));
    for (const m of p.models) sec.append(this.modelSlot(m, i));
    for (const t of tries) sec.append(h('p', { class: 'pd-note pd-onsite' }, h('b', null, 'On the site: '), rich('span', t.innerHTML)));
    for (const a of analogiesOf(c.id, st.title)) {
      const box = h('aside', { class: 'pd-aside' }, h('b', null, 'Analogy: '), h('b', null, a.title));
      if (a.figure) box.append(h('p', null, 'This analogy has a live figure; open the step on the site to see it.'));
      else {
        box.append(proseEl(a.body, 'pd-prose'));
        if (a.map?.length) box.append(h('dl', { class: 'pd-map' }, a.map.flatMap(([k, v]) => [h('dt', { html: k }), h('dd', { html: v })])));
        box.append(rich('p', `<b>Where it breaks: </b>${a.breaks}`));
      }
      sec.append(box);
    }
    if (st.more) for (const [k, label] of LAYERS) if (st.more[k]) sec.append(h('aside', { class: 'pd-aside' }, h('b', null, label), proseEl(st.more[k]!)));
    if (st.reading) sec.append(this.readingEl(st.reading));
    if (st.challenge?.kind === 'quiz') sec.append(questionEl(this.plan.questions.find((q) => q.quiz === st.challenge)!.n, st.challenge));
    else if (st.challenge) {
      sec.append(h('div', { class: 'pd-challenge' }, h('b', null, 'Challenge. '), rich('span', st.challenge.goal),
        h('div', { class: 'pd-try' }, 'Try it on the site: ', h('a', { href: stepUrl(c.id, i) }, stepUrl(c.id, i)))));
    }
    return sec;
  }

  private readingEl(r: Reading): HTMLElement {
    const el = h('aside', { class: 'pd-aside pd-reading' }, h('b', null, 'Read the spec'), h('p', { class: 'pd-src' }, `${r.source}, `, h('b', null, r.section)),
      ...r.quote.map((p) => h('blockquote', null, p)), rich('p', r.note));
    for (const q of r.quizzes) el.append(questionEl(this.plan.questions.find((x) => x.quiz === q)!.n, q));
    return el;
  }

  private recapEl(): HTMLElement {
    const r = this.chapter.recap!;
    const sec = h('section', { class: 'pd-step pd-recap' }, h('h2', null, 'Recap'), h('div', { class: 'pd-k' }, 'What to keep'),
      h('ul', { class: 'pd-prose' }, r.keep.map((k) => rich('li', k))));
    const qs = this.plan.questions.filter((q) => q.step === -1);
    if (qs.length) sec.append(h('div', { class: 'pd-k' }, 'Check yourself'), ...qs.map((q) => questionEl(q.n, q.quiz)));
    return sec;
  }

  private answersEl(): HTMLElement {
    const qs = this.plan.questions;
    const sec = h('section', { class: 'pd-step pd-answers' }, h('h2', null, 'Answers'));
    if (!qs.length) return h('section', { class: 'pd-answers', hidden: true });
    sec.append(h('ol', null, qs.map((q) => {
      return h('li', { value: String(q.n) }, h('b', null, `${LETTERS[q.quiz.answer] ?? '?'}. `), rich('span', q.quiz.options[q.quiz.answer] ?? ''), ' ', rich('span', q.quiz.explain, 'pd-explain'));
    })));
    return sec;
  }

  private figureSlot(p: StepPlan, st: Step): HTMLElement {
    const body = h('div', { class: 'pd-fig-body' }, h('span', { class: 'pd-wait' }, 'Waiting to be drawn…'));
    const inputs = inputsText(p.scene?.inputs);
    const cap = h('figcaption', null, h('b', null, `${p.label}. `), st.title,
      p.mode === 'top' ? '. Top level only: the parts are drawn as blocks and carry no values here; open the step on the site to look inside.'
        : inputs ? `. Initial inputs: ${inputs}.` : '.');
    const fig = h('figure', { class: 'pd-fig' }, body, cap);
    this.slots.set(p.step, body);
    const frag = h('div', { class: 'pd-figwrap' }, fig);
    return frag;
  }

  private modelSlot(m: ModelFigure, step: number): HTMLElement {
    const body = h('div', { class: 'pd-fig-body' }, h('span', { class: 'pd-wait' }, 'Waiting to be drawn…'));
    const url = stepUrl(this.chapter.id, step);
    const cap = h('figcaption', null, h('b', null, `${m.label}. `), m.title, '. The live model, to turn, cut open and take apart: ', h('a', { href: url }, url));
    this.modelSlots.set(m.id, body);
    return h('div', { class: 'pd-figwrap' }, h('figure', { class: 'pd-fig pd-fig-model' }, body, cap));
  }

  private linkNote(step: number, text: string): HTMLElement {
    return h('p', { class: 'pd-note' }, `${text} Open this step on the site: `, h('a', { href: stepUrl(this.chapter.id, step) }, stepUrl(this.chapter.id, step)));
  }

  // ---- building the figures ------------------------------------------------------------------------

  private async build(): Promise<void> {
    const todo = this.plan.steps.filter((p) => p.mode === 'sim' || p.mode === 'top');
    // every figure in reading order: a step's scene, then its models (one model at a time: each releases its WebGL context)
    const jobs: ({ scene: StepPlan } | { model: ModelFigure; step: number })[] = this.plan.steps.flatMap((p) => [
      ...(p.mode === 'sim' || p.mode === 'top' ? [{ scene: p }] : []),
      ...p.models.map((model) => ({ model, step: p.step })),
    ]);
    const stop = () => this.cancelled || this.dead;
    try {
      if (todo.length) this.maker = new FigureMaker();
      let done = 0;
      for (const job of jobs) {
        if (stop()) break;
        this.progress(done, jobs.length);
        await paint();
        if (stop()) break;
        if ('scene' in job) {
          const p = job.scene, slot = this.slots.get(p.step)!;
          try {
            slot.replaceChildren(this.maker!.svg(p.scene!, p.mode === 'top'));
            if (p.truth) slot.parentElement!.after(this.truthEl(p));
          } catch (e) {
            this.fail(p, e);
          }
        } else {
          const slot = this.modelSlots.get(job.model.id)!;
          try {
            const { modelFigure } = await import('./printmodel');
            slot.replaceChildren(await modelFigure(job.model.id, stop));
          } catch (e) {
            if (!stop()) slot.replaceChildren(this.linkNote(job.step, `This model could not be drawn (${e instanceof Error ? e.message : String(e)}).`));
          }
        }
        done++;
        await nextTask();
      }
      // cancelled: what was not drawn is a line with the address
      for (const p of todo) {
        const slot = this.slots.get(p.step)!;
        if (!slot.querySelector('svg') && slot.querySelector('.pd-wait')) this.fail(p, null);
      }
      for (const job of jobs) {
        if (!('model' in job)) continue;
        const slot = this.modelSlots.get(job.model.id)!;
        if (slot.querySelector('.pd-wait')) slot.replaceChildren(this.linkNote(job.step, 'This model was not drawn.'));
      }
    } finally {
      this.maker?.destroy();
      this.maker = null;
    }
    if (this.dead) return;
    this.cancel.hidden = true;
    this.bar.hidden = true;
    this.printBtn.hidden = false;
    this.status.textContent = this.cancelled ? 'Cancelled: the figures not yet drawn are links.' : 'Ready. Choose Save as PDF in the print dialog to keep a file.';
    this.el.setAttribute('data-print-ready', 'yes');
    if (!this.cancelled) window.print();
  }

  private progress(done: number, total: number): void {
    this.status.textContent = `Building figure ${done + 1} of ${total}`;
    this.bar.setAttribute('aria-valuenow', String(Math.round((100 * done) / total)));
    (this.bar.firstElementChild as HTMLElement).style.width = `${Math.round((100 * done) / total)}%`;
  }

  /** A figure that could not be drawn (or was cancelled): its place holds a line with the step's address. */
  private fail(p: StepPlan, e: unknown): void {
    const slot = this.slots.get(p.step)!;
    slot.replaceChildren(this.linkNote(p.step, e ? `This figure could not be drawn (${e instanceof Error ? e.message : String(e)}).` : 'This figure was not drawn.'));
  }

  private truthEl(p: StepPlan): HTMLElement {
    try {
      const t = truthTable(p.scene!.root);
      return h('table', { class: 'pd-truth' },
        h('caption', null, 'Truth table'),
        h('thead', null, h('tr', null, t.head.map((n, i) => h('th', { class: i >= t.inCount ? 'out' : '' }, n)))),
        h('tbody', null, t.rows.map((r) => h('tr', null, r.map((v, i) => h('td', { class: i >= t.inCount ? 'out' : '' }, v))))));
    } catch {
      return h('span');
    }
  }

  destroy(): void {
    this.dead = true;
    this.cancelled = true;
    this.maker?.destroy();
    this.style.remove();
  }
}
