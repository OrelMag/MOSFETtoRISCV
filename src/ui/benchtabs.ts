// The workbench's views, Parts (one part on the stage; "Parts", not "Components": the four tabs must fit the 270 px list), Statistics (every part in a table,
// ui/pages/hwstats.ts) and Benchmarks (programs on every CPU, ui/pages/benchmarks.ts), Lab (the out-of-order lab, ui/pages/ooolab.ts): tabs shared by
// the pages. Parts goes back to the last part.

import { h } from './dom';

let last = 'rca4';

/** The workbench opened this component (Parts then returns to it); `root`: the page, before it is attached. */
export function benchOpened(id: string, root: ParentNode = document): void {
  last = id;
  for (const a of root.querySelectorAll<HTMLAnchorElement>('.bench-tab[data-tab="components"]')) a.href = `#/workbench/${id}`;
}

export function benchTabs(active: 'components' | 'stats' | 'bench' | 'lab'): HTMLElement {
  const tab = (key: typeof active, href: string, label: string, title?: string) =>
    h('a', { class: `bench-tab${key === active ? ' on' : ''}`, href, 'data-tab': key, 'aria-current': key === active ? 'page' : null, title: title ?? null }, label);
  return h('nav', { class: 'bench-tabs', 'aria-label': 'Workbench views' },
    tab('components', `#/workbench/${last}`, 'Parts'), tab('stats', '#/workbench/stats', 'Statistics'), tab('bench', '#/workbench/bench', 'Benchmarks'),
    tab('lab', '#/workbench/lab', 'Lab', 'Out-of-order lab: the core in any shape'));
}
