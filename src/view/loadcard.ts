// The card over a stage while a big scene is built (Stage.load): a title, a real bar, the phases with the time each
// took and the running one's count, and a line on what is being built. The numbers come from sim/loadplan.ts.

import { fmtCount, fmtSeconds, type LoadPlan } from '../sim/loadplan';
import { h } from '../ui/dom';

export class LoadCard {
  readonly el: HTMLElement;
  private bar: HTMLElement;
  private fill: HTMLElement;
  private list: HTMLElement;
  private eta: HTMLElement;
  /** Announced to a screen reader: the running phase's name, once per phase (the bar carries the rest). */
  private live: HTMLElement;
  private liveFor = '';

  constructor(private plan: LoadPlan, title: string, private about: string) {
    this.fill = h('div', { class: 'load-fill' });
    this.bar = h('div', { class: 'load-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', 'aria-label': 'Building the circuit' }, this.fill);
    this.list = h('ol', { class: 'load-phases' });
    this.eta = h('p', { class: 'load-note' });
    this.live = h('span', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
    this.el = h('div', { class: 'stage-busy' }, this.live,
      h('section', { class: 'load-card', 'aria-label': 'Loading the circuit' }, h('h2', null, title), this.bar, this.list, this.eta));
    this.paint();
  }

  /** Redraw from the plan (called as often as it changes; cheap). */
  paint(): void {
    const f = this.plan.fraction;
    this.fill.style.width = `${(f * 100).toFixed(1)}%`;
    this.bar.setAttribute('aria-valuenow', String(Math.round(f * 100)));
    const rows = this.plan.phases;
    // rows are kept and their text updated, so a screen reader is not read the list again at every tick
    while (this.list.children.length < rows.length) this.list.append(h('li', null, h('span', { class: 'mark' }), h('span', { class: 'what' }), h('span', { class: 'ms' })));
    rows.forEach((r, i) => {
      const li = this.list.children[i] as HTMLElement;
      li.className = r.state;
      const mark = li.children[0] as HTMLElement, what = li.children[1] as HTMLElement, ms = li.children[2] as HTMLElement;
      const m = r.state === 'done' ? '✓' : r.state === 'active' ? '●' : '○';
      if (mark.textContent !== m) mark.textContent = m;
      const count = r.state === 'active' && r.note ? `: ${r.note}` : r.state === 'active' && r.done !== undefined && r.total && r.unit ? `: ${fmtCount(r.done)} of about ${fmtCount(r.total)} ${r.unit}` : '';
      const text = `${r.label}${count}`;
      if (what.textContent !== text) what.textContent = text;
      const t = r.ms !== undefined ? fmtSeconds(r.ms) : '';
      if (ms.textContent !== t) ms.textContent = t;
    });
    const now = rows.find((r) => r.state === 'active')?.label ?? '';
    if (now !== this.liveFor) {
      this.liveFor = now;
      this.live.textContent = now ? `Building the circuit: ${now}` : '';
    }
    const left = this.plan.etaMs();
    this.eta.textContent = `${left !== null && left > 1500 ? `About ${Math.round(left / 1000)} s left. ` : ''}${this.about}`;
  }

  remove(): void {
    this.el.remove();
  }
}
