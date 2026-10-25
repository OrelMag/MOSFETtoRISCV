// The workbench's Lab tab (#/workbench/lab, its own chunk): chapter 26's out-of-order lab on a page of its own.

import { oooLabWidget } from '../../widgets/ooolab';
import { benchTabs } from '../benchtabs';
import { h } from '../dom';
import type { Page } from './chapter';

export class OooLabPage implements Page {
  readonly kind = 'ooolab';
  readonly el: HTMLElement;
  private readonly widget = oooLabWidget();

  constructor() {
    this.el = h('div', { class: 'hw-page' }, h('div', { class: 'hw-inner' },
      benchTabs('lab'),
      h('h1', null, 'Out-of-order lab'),
      h('p', { class: 'hw-sub' }, 'The model of chapter 26’s out-of-order core, which the gate-level core matches cycle for cycle, in any shape you give it: ',
        'widths, issue ports and their units, the window, the predictor, latencies. Run the benchmark set, a single program, your assembly or Python. ',
        'Every commit slot is accounted for; NANDs and the period are measured from the gates where the core can be built that way. ',
        h('a', { href: '#/c/ooo' }, 'Chapter 26'), ' explains the parts.'),
      this.widget.el));
  }

  destroy(): void { this.widget.destroy?.(); }
}
