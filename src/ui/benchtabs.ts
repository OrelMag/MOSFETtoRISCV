// The workbench's two views, Components (one part on the stage) and Statistics (every part in a
// table, ui/pages/hwstats.ts): tabs shared by both pages. Components goes back to the last part.

import { h } from './dom';

let last = 'rca4';

/** The workbench opened this component (Components then returns to it); `root`: the page, before it is attached. */
export function benchOpened(id: string, root: ParentNode = document): void {
  last = id;
  for (const a of root.querySelectorAll<HTMLAnchorElement>('.bench-tab[data-tab="components"]')) a.href = `#/workbench/${id}`;
}

export function benchTabs(active: 'components' | 'stats'): HTMLElement {
  const tab = (key: typeof active, href: string, label: string) =>
    h('a', { class: `bench-tab${key === active ? ' on' : ''}`, href, 'data-tab': key, 'aria-current': key === active ? 'page' : null }, label);
  return h('nav', { class: 'bench-tabs', 'aria-label': 'Workbench views' },
    tab('components', `#/workbench/${last}`, 'Components'), tab('stats', '#/workbench/stats', 'Statistics'));
}
