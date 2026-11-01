// "Walk me through it": a step's Tour played on the live stage. Each beat sets inputs, runs clock cycles, opens a
// level, lights and frames parts (or draws some as removed), then says what happened in a caption beside them.
// Back undoes a beat through the stage's own history (the depth noted before it), so every value shown is the
// simulation's, never a picture of it.

import type { Beat, Tour } from '../chapters/types';
import type { Stage } from '../view/stage';
import { h, icon } from './dom';
import { reveal } from './stagenotes';

/** How long Play holds each beat. */
const PLAY_MS = 4200;

/** A beat's caption with {v:port} / {b:port} filled from the stage. */
export function fillCaption(text: string, read: (port: string) => number, width: (port: string) => number): string {
  return text.replace(/\{([vb]):([\w.]+)\}/g, (_, k: string, port: string) => {
    const v = read(port);
    if (v < 0) return 'X';
    return k === 'v' ? String(v) : v.toString(2).padStart(width(port), '0');
  });
}

export class TourPlayer {
  readonly el: HTMLElement;
  private k = -1;
  /** The stage's history depth before each beat ran: Back returns to it. */
  private marks: number[] = [];
  private timer = 0;
  private caption: HTMLElement;
  private head: HTMLElement;
  private count: HTMLElement;
  private playBtn: HTMLButtonElement;
  private backBtn: HTMLButtonElement;
  private nextBtn: HTMLButtonElement;

  constructor(private stage: Stage, private tour: Tour, private onEnd: () => void) {
    this.head = h('b', { class: 'tour-title' });
    this.count = h('span', { class: 'tour-count' });
    this.caption = h('div', { class: 'tour-say' });
    const btn = (label: string, ic: string, f: () => void, cls = '') =>
      h('button', { class: `btn sm${cls}`, onclick: f }, icon(ic, 14), h('span', null, label)) as HTMLButtonElement;
    this.backBtn = btn('Back', 'chevL', () => this.back());
    this.nextBtn = btn('Next', 'chevR', () => this.next(), ' primary');
    this.playBtn = btn('Play', 'play', () => this.togglePlay());
    this.el = h('section', { class: 'tour-card', role: 'dialog', 'aria-label': 'Walkthrough', tabindex: '-1', 'aria-live': 'polite' },
      h('header', null, this.head, this.count,
        h('button', { class: 'btn ghost icon-only', title: 'End the walkthrough (Esc)', 'aria-label': 'End the walkthrough', onclick: () => this.close() }, icon('close', 14))),
      this.caption,
      h('div', { class: 'tour-ctl' }, this.backBtn, this.nextBtn, this.playBtn));
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); this.close(); }
      else if (e.key === 'ArrowRight') this.next();
      else if (e.key === 'ArrowLeft') this.back();
    });
  }

  start(): void {
    this.stage.stopClock();
    this.stage.overlay(this.el);
    this.k = -1;
    this.marks = [];
    this.next();
    this.el.focus({ preventScroll: true });
    // on a narrow screen the stage sits below the text: bring the caption into view
    requestAnimationFrame(() => reveal(this.el));
  }

  get beat(): Beat | null {
    return this.tour.beats[this.k] ?? null;
  }

  next(): void {
    if (this.k >= this.tour.beats.length - 1) return this.close();
    this.k++;
    this.marks[this.k] = this.stage.historyDepth;
    const b = this.tour.beats[this.k];
    if (b.reset) { this.stage.powerCycle(); this.marks[this.k] = this.stage.historyDepth; }
    if (b.at) this.go(b.at);
    if (b.set) this.stage.setInputs(b.set);
    for (let i = 0; i < (b.cycles ?? 0); i++) this.stage.pulse();
    this.paint();
  }

  back(): void {
    if (this.k <= 0) return;
    this.stop();
    while (this.stage.historyDepth > this.marks[this.k]) if (!this.stage.back()) break;
    this.k--;
    this.go(this.atOf(this.k));
    this.paint();
  }

  close(): void {
    this.stop();
    this.stage.ghost([]);
    this.stage.highlight(this.stage.target?.highlight ?? []);
    this.stage.overlay(this.el, false);
    this.onEnd();
  }

  private togglePlay(): void {
    if (this.timer) return this.stop();
    this.playBtn.querySelector('span')!.textContent = 'Pause';
    const tick = () => {
      if (this.k >= this.tour.beats.length - 1) return this.stop();
      this.next();
      this.timer = window.setTimeout(tick, PLAY_MS);
    };
    this.timer = window.setTimeout(tick, PLAY_MS);
  }

  private stop(): void {
    clearTimeout(this.timer);
    this.timer = 0;
    this.playBtn.querySelector('span')!.textContent = 'Play';
  }

  /** The level beat k is shown at: the last `at` up to it, else the scene's own. */
  private atOf(k: number): string[] {
    for (let i = k; i >= 0; i--) { const at = this.tour.beats[i].at; if (at) return at; }
    return this.stage.target?.path ?? [];
  }

  private go(path: string[]): void {
    if (path.join('/') !== this.stage.path.join('/')) this.stage.goTo(path);
  }

  private paint(): void {
    const b = this.tour.beats[this.k];
    const stage = this.stage;
    const show = b.show ?? [];
    stage.ghost(b.ghost ?? []);
    stage.highlight([...show, ...(b.ghost ?? [])], show.length > 0);
    // frame only what is out of view: zooming onto one part loses the circuit around it
    if (show.length) {
      const r = stage.instRect(show), c = stage.canvasRect;
      if (!r || r.left < c.left || r.top < c.top || r.right > c.right || r.bottom > c.bottom) stage.frame(show);
    }
    const width = (p: string) => stage.sim?.design.root.ports[p]?.length ?? 1;
    this.head.textContent = b.title ?? '';
    this.head.hidden = !b.title;
    this.count.textContent = `${this.k + 1} / ${this.tour.beats.length}`;
    this.caption.innerHTML = fillCaption(b.say, (p) => stage.value(p), width);
    this.backBtn.disabled = this.k === 0;
    this.nextBtn.querySelector('span')!.textContent = this.k === this.tour.beats.length - 1 ? 'Done' : 'Next';
    requestAnimationFrame(() => this.place(show));
  }

  /** Beside the lit parts where there is room (right, else left, else below), else in the bottom-left corner. */
  private place(show: string[]): void {
    const c = this.stage.canvasRect;
    const w = this.el.offsetWidth, hh = this.el.offsetHeight;
    const r = show.length ? this.stage.instRect(show) : null;
    let x = 12, y = c.height - hh - 56;
    if (r) {
      const rx = r.right - c.left, lx = r.left - c.left, ty = r.top - c.top, by = r.bottom - c.top;
      if (rx + 16 + w < c.width - 8) { x = rx + 16; y = ty; }
      else if (lx - 16 - w > 8) { x = lx - 16 - w; y = ty; }
      else { x = Math.max(8, Math.min(lx, c.width - w - 8)); y = by + 12; }
    }
    this.el.style.left = `${Math.max(8, Math.min(x, c.width - w - 8))}px`;
    this.el.style.top = `${Math.max(8, Math.min(y, c.height - hh - 8))}px`;
  }
}
