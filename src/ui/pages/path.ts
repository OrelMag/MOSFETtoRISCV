// My path (#/path, its own chunk): the five tiers with each chapter's skills as chips coloured by state, test-out per
// chapter, the next three things to do with their time, and each tier's capstone (learn/path.ts, mastery.ts).

import '../../styles/path.css';
import { asker } from '../../learn/asker';
import { pathCtx } from '../../learn/evidence';
import type { SkillState } from '../../learn/mastery';
import { chapterById, currentTier, fmtMinutes, nextUp, stepMinutes, tierViews, type NextItem, type PathCtx, type TierView } from '../../learn/path';
import { testOutItems } from '../../learn/placement';
import { tierChapters } from '../../learn/skills';
import { learn, PERSONAS } from '../../learn/store';
import { h, icon } from '../dom';
import { settings } from '../settings';
import type { Page } from './chapter';

const STATE_LABEL: Record<SkillState, string> = { new: 'not started', learning: 'learning', practised: 'practised', mastered: 'mastered', rusty: 'rusty: a question is due' };
const KIND_LABEL: Record<NextItem['kind'], string> = { review: 'Review', learn: 'Learn', practise: 'Practise', capstone: 'Capstone' };
const PERSONA_LABEL: Record<(typeof PERSONAS)[number], string> = { new: 'New to hardware and code', software: 'I write software', logic: 'I know digital logic', hardware: 'I design hardware' };

export class PathPage implements Page {
  readonly kind = 'path';
  readonly el: HTMLElement;
  private main = h('div', { class: 'lp-tiers' });
  private side = h('aside', { class: 'lp-side' });
  private open = new Set<number>();
  private testing: string | null = null;
  private off: () => void;

  constructor() {
    this.el = h('div', { class: 'scroll' }, h('div', { class: 'lp-page' },
      h('header', { class: 'lp-top' }, h('div', null, h('div', { class: 'eyebrow' }, 'Zero to master'), h('h1', null, 'My path'), this.sub()),
        h('div', { class: 'lp-actions' }, h('a', { class: 'btn', href: '#/start' }, 'Change where I start'))),
      h('div', { class: 'lp-grid' }, this.main, this.side)));
    this.off = learn().onChange(() => this.render());
    this.render();
  }

  destroy(): void { this.off(); }

  private sub(): HTMLElement {
    const s = learn().state.start;
    return h('p', { class: 'lp-sub' }, s ? `Started as "${PERSONA_LABEL[s.persona]}" · ${new Date(s.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
      : 'Every chapter and level stays open: this page only suggests an order.');
  }

  private render(): void {
    const ctx = pathCtx();
    const views = tierViews(ctx);
    const start = learn().state.start?.tier ?? 0;
    const cur = currentTier(views, start);
    if (!this.open.size) this.open.add(cur);
    this.main.replaceChildren(...views.map((v) => this.tier(v, ctx, cur, start)),
      h('div', { class: 'lp-legend' }, ...(['mastered', 'practised', 'rusty', 'learning', 'new'] as SkillState[]).map((s) => h('span', null, h('span', { class: `lp-chip ${s}` }, 'a'), STATE_LABEL[s]))),
      h('p', { class: 'lp-note' }, 'Mastered: understood (a question right), built (its level or challenge), and remembered (right twice, days apart). Times are estimates.'));
    this.side.replaceChildren(this.next(nextUp(ctx, start)), ...views.filter((v) => v.tier === cur && v.capstone).map((v) => this.capCard(v)));
  }

  private tier(v: TierView, ctx: PathCtx, cur: number, start: number): HTMLElement {
    const isOpen = this.open.has(v.tier);
    const pct = v.skills.length ? Math.round((100 * v.done) / v.skills.length) : 0;
    const status = v.tier < start && v.done < v.skills.length ? 'skipped by your start' : v.done === v.skills.length ? 'done' : v.tier === cur ? `${fmtMinutes(v.minutesLeft)} left` : '';
    const head = h('button', { class: 'lp-th', type: 'button', 'aria-expanded': isOpen ? 'true' : 'false',
      onclick: () => { if (isOpen) this.open.delete(v.tier); else this.open.add(v.tier); this.render(); } },
      h('span', { class: 'lp-tt' }, `Tier ${v.tier} · ${v.title}`), h('span', { class: 'lp-tm' }, `${v.done} / ${v.skills.length} skills${status ? ` · ${status}` : ''}`), icon(isOpen ? 'chevD' : 'chevR', 16));
    const card = h('section', { class: `lp-tier${v.tier === cur ? ' cur' : ''}` }, head,
      h('div', { class: 'lp-meter', role: 'img', 'aria-label': `${pct}% of tier ${v.tier}` }, h('i', { style: `width:${pct}%` })));
    if (!isOpen) return card;
    card.append(h('p', { class: 'lp-blurb' }, v.blurb));
    for (const c of tierChapters(v.tier)) {
      const mine = v.skills.filter((x) => x.skill.chapter === c.id);
      const seen = settings.visited(c.id).filter((i) => i < c.steps.length).length;
      const tested = ctx.testedOut(c.id);
      const allDone = mine.length > 0 && mine.every((x) => x.state !== 'new' && x.state !== 'learning');
      const row = h('div', { class: 'lp-row' },
        h('a', { class: 'lp-ch', href: `#/c/${c.id}/${Math.min(seen, c.steps.length - 1)}` }, c.title, h('small', null, `${c.label ?? `ch ${c.num}`} · ${seen} / ${c.steps.length} steps${tested ? ' · tested out' : ''}`)),
        h('div', { class: 'lp-chips' }, ...mine.map(({ skill, state }) => h('a', { class: `lp-chip ${state}`, href: `#/campaign/codex/${skill.id}`, title: `${skill.title}: ${STATE_LABEL[state]}` }, skill.title))),
        h('div', { class: 'lp-rowact' }, !tested && !allDone && c.recap?.check?.length ? h('button', { class: 'btn sm', type: 'button', title: this.testing === c.id ? 'Close the questions' : `Skip ${c.title}: answer its recap questions, all right to count it as known`, onclick: () => { this.testing = this.testing === c.id ? null : c.id; this.render(); } }, this.testing === c.id ? 'Close' : 'Test out') : null,
          tested ? h('button', { class: 'btn sm', type: 'button', title: 'Count this chapter as not tested out', onclick: () => learn().untest(c.id) }, 'Undo test-out') : null));
      card.append(row);
      if (this.testing === c.id) card.append(this.testOut(c.id));
    }
    return card;
  }

  private testOut(chapter: string): HTMLElement {
    const c = chapterById(chapter)!;
    const items = testOutItems(chapter);
    const box = h('div', { class: 'lp-test' });
    box.append(h('p', { class: 'lp-sub' }, `Test out of ${c.title}: ${items.length} questions, all right to pass. Nothing here counts toward the chapter's own checks.`),
      asker(items, (answers) => {
        const right = answers.filter((a) => a.right).length;
        if (right === answers.length) { learn().testOut(chapter); this.testing = null; return; }
        const mins = c.steps.reduce((m, s) => m + stepMinutes(s), 0);
        box.replaceChildren(h('p', null, `${right} of ${answers.length} right: not this time. The chapter takes ${fmtMinutes(mins)}.`),
          h('div', { class: 'lp-nav' }, h('a', { class: 'btn primary', href: `#/c/${chapter}/0` }, 'Open the chapter'), h('button', { class: 'btn', type: 'button', onclick: () => { this.testing = null; this.render(); } }, 'Close')));
      }, 'Test-out'));
    return box;
  }

  private next(items: NextItem[]): HTMLElement {
    const total = items.reduce((m, x) => m + x.minutes, 0);
    const first = items.find((x) => x.href);
    return h('section', { class: 'lp-next', 'aria-label': 'Next up' },
      h('div', { class: 'lp-nh' }, h('b', null, 'Next up'), items.length ? h('span', null, fmtMinutes(total)) : null),
      ...(items.length ? items.map((x) => h(x.href ? 'a' : 'div', { class: 'lp-item', ...(x.href ? { href: x.href } : {}) },
        h('span', { class: 'lp-kind' }, KIND_LABEL[x.kind]), h('span', { class: 'lp-it' }, x.title), h('small', null, fmtMinutes(x.minutes))))
        : [h('p', { class: 'lp-sub' }, 'Every tier is done. The sandbox and the campaign\'s optional acts are yours.')]),
      first ? h('a', { class: 'btn primary lp-go', href: first.href! }, 'Start', icon('chevR', 16)) : null,
      h('p', { class: 'lp-note' }, 'Questions due come first, then the next step of your tier, then a level that practises what you have read.'));
  }

  private capCard(v: TierView): HTMLElement {
    const c = v.capstone!;
    const left = v.skills.length - v.done;
    return h('section', { class: 'lp-cap' },
      h('div', { class: 'lp-nh' }, h('b', null, `Tier ${v.tier} capstone`), h('span', { class: `lp-pill ${c.status}` }, c.status === 'passed' ? 'passed' : left ? `${left} skill${left > 1 ? 's' : ''} to go` : 'ready')),
      h('b', null, c.title), h('p', { class: 'lp-sub' }, c.brief),
      c.route ? h('a', { class: 'btn sm', href: c.route }, c.status === 'none' ? 'Open the spec' : 'Continue') : h('p', { class: 'lp-note' }, 'Being built: it opens here when ready.'));
  }
}
