// A long chapter's progress: one segment per named part, a status line, and the parts as a list (chapters/parts.ts).
// Only a view over the steps in their order: a row goes to the step, nothing is hidden or locked.

import { checksDone } from '../chapters/checks';
import { corePath, partIndex, partsOf } from '../chapters/parts';
import type { Chapter } from '../chapters/types';
import { h, icon } from './dom';

export interface PartsNavState {
  /** Parts the learner opened or closed by hand, against the default (only the current part open). */
  open: Map<number, boolean>;
  /** The whole list folded by hand (else open on a desk, folded on a phone). */
  folded: boolean | null;
  /** The part the list was last drawn for (a new current part opens itself). */
  at: number;
}

export const newPartsNavState = (): PartsNavState => ({ open: new Map(), folded: null, at: -2 });

/** Folded to begin with on a phone, and where a list beside the prose would leave it too little height. */
const startFolded = (): boolean => typeof matchMedia === 'function' && matchMedia('(max-width: 760px), (max-height: 799px)').matches;

/**
 * The parts block for the chapter header, or null for a chapter without parts. `step` is the step shown (the recap's
 * index on the recap), `recap` its index or -1; `solved(key)` as settings.isSolved.
 */
export function partsNav(
  c: Chapter, step: number, recap: number, visited: readonly number[], solved: (key: string) => boolean,
  go: (i: number) => void, st: PartsNavState,
): HTMLElement | null {
  const parts = partsOf(c);
  if (!parts) return null;
  const onRecap = recap >= 0 && step === recap;
  const cur = onRecap ? -1 : partIndex(parts, step);
  if (cur !== st.at) {
    st.open.delete(cur);
    st.at = cur;
  }
  const { done, total } = checksDone(c, solved);
  const status = [
    onRecap ? 'Recap' : `Part ${cur + 1} of ${parts.length}`,
    total ? `${done} / ${total} checks` : '',
    `core path ${corePath(c)} steps`,
  ].filter(Boolean).join(' · ');

  const segs = h('div', { class: 'parts-segs', 'aria-hidden': 'true' },
    ...parts.map((p, k) => {
      const seen = c.steps.slice(p.from, p.from + p.count).filter((_, j) => visited.includes(p.from + j) || p.from + j === step).length;
      return h('i', {
        class: k === cur ? 'cur' : seen === p.count ? 'done' : '', style: `flex:${p.count}`, title: p.name,
      }, h('b', { style: `width:${Math.round((100 * seen) / p.count)}%` }));
    }),
    recap >= 0 ? h('i', { class: `recap${onRecap ? ' cur' : ''}`, title: 'Recap' }) : null);

  const row = (i: number): HTMLElement => {
    const s = c.steps[i];
    const isCur = i === step;
    const ok = !!s.challenge && solved(`${c.id}:${i}`);
    return h('li', null, h('button', {
      type: 'button',
      class: ['pstep', isCur ? 'cur' : visited.includes(i) ? 'done' : '', ok ? 'solved' : ''].filter(Boolean).join(' '),
      title: `${i + 1}. ${s.title}${s.deep ? ' (deep dive)' : ''}${s.challenge ? (ok ? ' (check solved)' : ' (has a check)') : ''}`,
      ...(isCur ? { 'aria-current': 'step' } : {}),
      onclick: () => go(i),
    },
    h('span', { class: 'pn' }, String(i + 1)),
    h('span', { class: 'pt' }, s.title),
    ok ? h('span', { class: 'pck', title: 'Check solved' }, '✓', h('span', { class: 'sr-only' }, ' check solved')) : null,
    s.deep ? h('em', { class: 'deep' }, 'deep dive') : null));
  };

  const list = h('div', { class: 'parts-list' },
    ...parts.map((p, k) => {
      const dflt = k === cur;
      const open = st.open.get(k) ?? dflt;
      const d = h('details', { class: `part${k === cur ? ' cur' : ''}`, ...(open ? { open: '' } : {}) },
        h('summary', null, h('span', { class: 'pname' }, p.name),
          h('span', { class: 'pcount' }, `${p.count} step${p.count === 1 ? '' : 's'}${p.deep ? ` · ${p.deep} deep` : ''}`), icon('chevD', 14)),
        h('ol', { class: 'part-steps' }, ...Array.from({ length: p.count }, (_, j) => row(p.from + j))));
      d.addEventListener('toggle', () => {
        if (d.open === dflt) st.open.delete(k);
        else st.open.set(k, d.open);
      });
      return d;
    }),
    recap >= 0 ? h('button', {
      type: 'button', class: `pstep recap${onRecap ? ' cur' : ''}`, ...(onRecap ? { 'aria-current': 'step' } : {}), onclick: () => go(recap),
    }, h('span', { class: 'pn' }, '↳'), h('span', { class: 'pt' }, 'Recap')) : null);

  const folded = st.folded ?? startFolded();
  const wrap = h('details', { class: 'parts-wrap', ...(folded ? {} : { open: '' }) },
    h('summary', { class: 'parts-status' }, h('span', null, status), icon('chevD', 14)), list);
  // keep the current step in view in a list that scrolls (not while the list is folded: nothing is measured then)
  const reveal = (): void => {
    const el = list.querySelector<HTMLElement>('.pstep.cur');
    if (!el || !wrap.open || list.scrollHeight <= list.clientHeight) return;
    // the current part's heading at the top when the part fits, else its current row in the middle
    const part = el.closest<HTMLElement>('details.part');
    list.scrollTop = part && part.offsetHeight <= list.clientHeight
      ? part.offsetTop - list.offsetTop
      : Math.max(0, el.offsetTop - list.offsetTop - list.clientHeight / 2 + el.offsetHeight / 2);
  };
  wrap.addEventListener('toggle', () => {
    // only a fold the learner made counts: the element's own opening on creation is the default
    if (wrap.open === !startFolded()) st.folded = null;
    else st.folded = !wrap.open;
    if (wrap.open) reveal();
  });
  requestAnimationFrame(reveal);
  return h('div', { class: 'parts-nav' }, segs, wrap);
}
