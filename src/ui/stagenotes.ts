// Feedback over a chapter's stage (ui/feedback.ts has the words): the step's challenge goal as a chip at the top of the
// canvas, which turns green when solved, and brief toasts when a "Try" box ticks itself. The text panel's cards are
// often out of sight while the learner toggles inputs, so the news comes where they are looking. Top right of the
// canvas, clear of the I/O bar and the stage's buttons; on a phone a row under the level badge.

import { oneLine, solvedNote, triedNote } from './feedback';
import { h, icon } from './dom';
import { reducedMotion } from './motion';

const TOAST_MS = 4500;

/** Scroll `el` into view in its scroll containers if it is not already (smoothly unless motion is reduced). */
export function reveal(el: Element, block: ScrollLogicalPosition = 'nearest'): void {
  el.scrollIntoView({ block, inline: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
}

export class StageNotes {
  /** Goes over the canvas (position: absolute). */
  readonly el = h('div', { class: 'stage-notes' });
  /** Announces solves to screen readers; kept across steps (a live region must exist before its text changes). */
  readonly live = h('div', { class: 'stage-notes-live', role: 'status', 'aria-live': 'polite' });
  private chip: HTMLElement | null = null;
  private goalText = '';
  private timers = new Set<number>();

  /** Show a step's challenge goal; a click on it shows the challenge card (`show`). */
  goal(text: string, solved: boolean, show: () => void): void {
    this.clear();
    this.goalText = text;
    this.chip = h('button', { class: 'stage-goal', type: 'button', onclick: show });
    this.paint(solved);
    this.el.prepend(this.chip);
  }

  /** The goal chip turns green and the solve is announced. */
  solved(): void {
    if (!this.chip) return;
    this.paint(true);
    this.chip.classList.add('pop');
    this.say(solvedNote(this.goalText));
  }

  /** A brief note under the goal (a "Try" box ticked), announced too. */
  tried(text: string): void {
    const msg = triedNote(text);
    const t = h('div', { class: 'stage-toast' }, icon('check', 13), h('span', null, msg));
    this.el.append(t);
    // at most two at once: the oldest goes
    const all = this.el.querySelectorAll('.stage-toast');
    if (all.length > 2) all[0].remove();
    this.say(msg);
    const id = window.setTimeout(() => {
      this.timers.delete(id);
      t.classList.add('out');
      const gone = window.setTimeout(() => { this.timers.delete(gone); t.remove(); }, reducedMotion() ? 0 : 300);
      this.timers.add(gone);
    }, TOAST_MS);
    this.timers.add(id);
  }

  /** Remove the goal and any toast (a new step). */
  clear(): void {
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
    this.el.replaceChildren();
    this.chip = null;
    this.goalText = '';
  }

  private paint(solved: boolean): void {
    const c = this.chip!;
    const goal = oneLine(this.goalText, 120);
    c.classList.toggle('solved', solved);
    c.title = `${solved ? 'Solved' : 'Challenge'}: ${this.goalText}\nShow the challenge in the text`;
    c.setAttribute('aria-label', `${solved ? 'Challenge solved' : 'Challenge'}: ${this.goalText}. Show the challenge in the text`);
    c.replaceChildren(
      h('span', { class: 'tag' }, solved ? [icon('check', 12), ' Solved'] : 'Challenge'),
      h('span', { class: 'txt' }, goal));
  }

  private say(msg: string): void {
    // cleared first, so the same words twice are still announced
    this.live.textContent = '';
    requestAnimationFrame(() => { this.live.textContent = msg; });
  }
}
