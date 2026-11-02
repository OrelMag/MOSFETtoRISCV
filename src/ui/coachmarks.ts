// First-run coach marks: the page dims, a ring is cut out around one control, and a card ("2 OF 5", dots, title, a
// sentence or two, Skip the tour / Back / Next) says what it does. Beats are in coachplan.ts; one whose control is
// not on the page is skipped. The card is a dialog with the focus inside; Esc ends the tour and gives the focus
// back; the ring follows resizes. Finished or skipped is remembered (settings.coachDone); "Show me the controls" in
// the ? sheet and the search's > actions plays it again. Never starts while a content tour (ui/tour.ts) plays.

import { h } from './dom';
import { beatsOf, type CoachBeat, type CoachKind, coachFits, mayAutoStart, move, pickBeats } from './coachplan';
import { settings } from './settings';

let active: Coach | null = null;

/** Dialogs that may sit above a tour and take its keys. */
const OVER_TOUR = '[role="dialog"][aria-modal="true"]:not(.coach-card), .kh-back, dialog[open]';

const shown = (sel: string): HTMLElement | null => {
  const el = document.querySelector<HTMLElement>(sel);
  if (!el || el.hidden || !el.getClientRects().length) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? el : null;
};

class Coach {
  private beats: CoachBeat[];
  private i = 0;
  private ring = h('div', { class: 'coach-ring', 'aria-hidden': 'true' });
  private arrow = h('div', { class: 'coach-arrow', 'aria-hidden': 'true' });
  private count = h('span', { class: 'coach-count' });
  private dots = h('span', { class: 'coach-dots', 'aria-hidden': 'true' });
  private title = h('h2', { class: 'coach-title', id: 'coach-title' });
  private text = h('p', { class: 'coach-text', id: 'coach-text' });
  private back = h('button', { type: 'button', class: 'btn coach-back', onclick: () => this.go('back') }, 'Back') as HTMLButtonElement;
  private next = h('button', { type: 'button', class: 'btn primary coach-next', onclick: () => this.go('next') }, 'Next') as HTMLButtonElement;
  private card: HTMLElement;
  readonly el: HTMLElement;
  private opener: HTMLElement | null;
  private raf = 0;
  private ro: ResizeObserver;

  constructor(private kind: CoachKind, beats: CoachBeat[]) {
    this.beats = beats;
    this.opener = document.activeElement as HTMLElement | null;
    const skip = h('button', { type: 'button', class: 'btn ghost coach-skip', onclick: () => this.end() }, 'Skip the tour');
    this.card = h('section', { class: 'coach-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'coach-title', 'aria-describedby': 'coach-text', tabindex: '-1' },
      h('div', { class: 'coach-head' }, this.count, h('span', { class: 'sp' }), this.dots),
      this.title, this.text,
      h('div', { class: 'coach-ctl' }, skip, h('span', { class: 'sp' }), this.back, this.next));
    this.el = h('div', { class: 'coach', 'data-coach': kind }, this.ring, this.arrow, this.card);
    beats.forEach(() => this.dots.append(h('i')));
    // clicks outside the card go nowhere: the page below is dimmed, not live
    this.el.addEventListener('pointerdown', (e) => { if (!this.card.contains(e.target as Node)) e.preventDefault(); });
    document.addEventListener('keydown', this.key, true);
    window.addEventListener('hashchange', this.route);
    window.addEventListener('resize', this.schedule);
    window.addEventListener('scroll', this.schedule, true);
    this.ro = new ResizeObserver(this.schedule);
    this.ro.observe(document.body);
    document.body.append(this.el);
    this.show();
    this.card.focus({ preventScroll: true });
  }

  /** A route change to a page the tour is not about ends it, without counting it as seen. */
  private route = (): void => {
    if (!coachFits(this.kind, location.hash)) this.end(false);
  };

  private key = (e: KeyboardEvent): void => {
    // a dialog opened over the tour (the search, the keys sheet) owns its keys: Esc closes it, Tab moves in it
    if ((e.target as Element | null)?.closest?.(OVER_TOUR)) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.end();
    } else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); this.go('next'); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); this.go('back'); }
    else if (e.key === 'Tab') {
      // Tab stays inside the card
      const f = [...this.card.querySelectorAll<HTMLButtonElement>('button')].filter((b) => !b.disabled);
      const at = f.indexOf(document.activeElement as HTMLButtonElement);
      e.preventDefault();
      e.stopPropagation();
      f[(at + (e.shiftKey ? f.length - 1 : 1)) % f.length]?.focus();
    } else if ([...e.key].length === 1 && e.key !== ' ') {
      // the page's single-key shortcuts (P, W, M …) wait until the tour is over
      e.stopPropagation();
    }
  };

  private go(m: 'next' | 'back'): void {
    const n = move({ index: this.i, count: this.beats.length }, m);
    if (n === null) return this.end();
    this.i = n;
    this.show();
  }

  private schedule = (): void => {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.place();
    });
  };

  private show(): void {
    const b = this.beats[this.i];
    this.count.textContent = `${this.i + 1} OF ${this.beats.length}`;
    this.title.textContent = b.title;
    this.text.textContent = b.text;
    [...this.dots.children].forEach((d, k) => d.classList.toggle('on', k === this.i));
    this.back.disabled = this.i === 0;
    const last = this.i === this.beats.length - 1;
    this.next.textContent = last ? 'Done' : 'Next';
    this.place();
    // a button that was focused and is now disabled would drop the focus to the page
    if (!this.card.contains(document.activeElement)) this.card.focus({ preventScroll: true });
  }

  /** Ring around the target, card on the side with room (below, else above), kept inside the window. */
  private place(): void {
    // a control that has gone (the bar folded it into More on a resize) drops its beat
    let el = shown(this.beats[this.i].target);
    while (!el) {
      this.beats.splice(this.i, 1);
      if (!this.beats.length) return this.end();
      if (this.i >= this.beats.length) this.i = this.beats.length - 1;
      el = shown(this.beats[this.i].target);
      this.refreshCount();
    }
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const vw = window.innerWidth, vh = window.innerHeight, pad = 4;
    const t = el.getBoundingClientRect();
    const x0 = Math.max(0, t.left - pad), y0 = Math.max(0, t.top - pad);
    const x1 = Math.min(vw, t.right + pad), y1 = Math.min(vh, t.bottom + pad);
    Object.assign(this.ring.style, { left: `${x0}px`, top: `${y0}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });
    const cw = Math.min(340, vw - 24);
    this.card.style.width = `${cw}px`;
    const ch = this.card.offsetHeight;
    const below = vh - y1 - 16 >= ch + 8;
    const above = y0 - 16 >= ch + 8;
    const right = vw - x1 - 16 >= cw + 8, left = x0 - 16 >= cw + 8;
    const clampL = (v: number) => Math.max(12, Math.min(vw - cw - 12, v));
    const clampT = (v: number) => Math.max(12, Math.min(vh - ch - 12, v));
    let cl: number, ct: number, ax = 0, ay = 0, arrow = true;
    if (below || above) {
      cl = clampL((x0 + x1) / 2 - cw / 2);
      ct = below ? y1 + 14 : y0 - 14 - ch;
      // on a phone the chapter's Back / Next row is fixed above a bottom-sheet stage: keep the card off it
      const foot = document.querySelector<HTMLElement>('.narrative-foot');
      const f = foot && foot.getClientRects().length ? foot.getBoundingClientRect() : null;
      if (f && !below && ct + ch > f.top - 8 && ct < f.bottom) {
        ct = Math.max(12, f.top - 8 - ch);
        arrow = ct + ch + 24 > y0;
      }
      ax = Math.max(cl + 18, Math.min(cl + cw - 18, (x0 + x1) / 2)) - 8;
      ay = below ? ct - 8 : ct + ch - 8;
    } else if (right || left) {
      // a target as tall as the window (the parts list): the card beside it
      cl = right ? x1 + 14 : x0 - 14 - cw;
      ct = clampT((y0 + y1) / 2 - ch / 2);
      ax = right ? cl - 8 : cl + cw - 8;
      ay = Math.max(ct + 18, Math.min(ct + ch - 18, (y0 + y1) / 2)) - 8;
    } else {
      // no side has room (a target as large as the window): the card sits over its lower corner
      cl = clampL((x0 + x1) / 2 - cw / 2);
      ct = clampT(vh - ch - 12);
      arrow = false;
    }
    Object.assign(this.card.style, { left: `${cl}px`, top: `${ct}px` });
    this.arrow.hidden = !arrow;
    Object.assign(this.arrow.style, { left: `${ax}px`, top: `${ay}px` });
  }

  private refreshCount(): void {
    this.count.textContent = `${this.i + 1} OF ${this.beats.length}`;
    this.dots.replaceChildren(...this.beats.map((_, k) => h('i', { class: k === this.i ? 'on' : '' })));
  }

  end(seen = true): void {
    window.removeEventListener('hashchange', this.route);
    cancelAnimationFrame(this.raf);
    document.removeEventListener('keydown', this.key, true);
    window.removeEventListener('resize', this.schedule);
    window.removeEventListener('scroll', this.schedule, true);
    this.ro.disconnect();
    this.el.remove();
    if (seen) settings.setCoachDone(this.kind);
    if (active === this) active = null;
    if (!seen) return;
    // the opener may be <body> (a first visit) or gone (the ? sheet's button): then the stage / canvas
    const o = this.opener;
    const usable = !!o && o !== document.body && o !== document.documentElement && o.isConnected && o.getClientRects().length > 0;
    const back = usable ? o : document.querySelector<HTMLElement>(this.kind === 'stage' ? '.stage' : '.sandbox .sb-canvas');
    back?.focus({ preventScroll: true });
  }
}

/** Is a content tour (ui/tour.ts), a dialog or this tour already on screen? */
const busy = () => ({
  otherTour: !!document.querySelector('.tour-card') || active !== null,
  // a modal (keys, search, the backup dialogs), the Safari data note, or a note being typed
  dialogOpen: !!document.querySelector('.kh-back, dialog[open], .persist-note, [role="dialog"][aria-modal="true"]:not(.coach-card)')
    || !!(document.activeElement as HTMLElement | null)?.closest?.('.note-card'),
});

/** Play the tour of `kind` now (the ? sheet, the search's actions). False when no control of it is on the page. */
export function showCoach(kind: CoachKind): boolean {
  active?.end(false);
  const beats = pickBeats(beatsOf(kind), (sel) => !!shown(sel));
  if (!beats.length) return false;
  active = new Coach(kind, beats);
  return true;
}

/** The first visit: play the tour once, if it has not been seen and nothing else asks for attention. */
export function maybeCoach(kind: CoachKind): void {
  if (!mayAutoStart({ done: settings.coachDone(kind), ...busy() })) return;
  // a beat later: the page has settled and the stage bar has fitted itself
  window.setTimeout(() => {
    if (coachFits(kind, location.hash) && mayAutoStart({ done: settings.coachDone(kind), ...busy() })) showCoach(kind);
  }, 700);
}

/** Is the stage on this page (the ? sheet and the actions offer the tour only where it has something to show)? */
export const coachAvailable = (kind: CoachKind): boolean => pickBeats(beatsOf(kind), (sel) => !!shown(sel)).length > 0;
