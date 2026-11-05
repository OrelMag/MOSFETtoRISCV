// The tab's title (DOM-free but for the setter): bookmarks, history and a row of tabs tell pages apart by it. The route gives what it
// knows at once; a page that knows more (a level, a codex entry, a chip) refines it with setPageTitle.

import type { StepMeta } from '../chapters/meta';

export const SITE_TITLE = 'From Switch to RISC-V and Beyond';

/** What the address alone can name: most specific first. `chapter`: the chapter a `c` route opens, if it exists. */
export function routeTitle(parts: string[], chapter?: { title: string; steps: StepMeta[] }): string[] {
  switch (parts[0]) {
    case 'c': {
      if (!chapter) return ['No such chapter'];
      // the print view's title is the saved PDF's file name
      if (parts[2] === 'print') return [chapter.title];
      const i = Number(parts[2] ?? 0) || 0;
      const step = i >= chapter.steps.length ? 'Recap' : chapter.steps[Math.max(i, 0)].title;
      return [step, chapter.title];
    }
    case 'workbench': return parts[1] === 'stats' ? ['Statistics', 'Workbench'] : parts[1] === 'bench' ? ['Benchmarks', 'Workbench'] : parts[1] === 'lab' ? ['Out-of-order lab', 'Workbench'] : ['Workbench'];
    case 'campaign': return parts[1] === 'codex' ? ['Codex'] : parts[1] === 'intro' ? ['The CPU', 'Campaign'] : ['Campaign'];
    case 'sandbox': return ['Sandbox'];
    case 'path': return ['My path'];
    case 'start': return ['Where are you starting?'];
    case 'notes': return ['My notes'];
    default: return [];
  }
}

/** "Most specific · … · From Switch to RISC-V and Beyond". */
export const titleText = (names: string[]): string => [...names.filter(Boolean), SITE_TITLE].join(' · ');

export function setPageTitle(...names: string[]): void {
  document.title = titleText(names);
}
