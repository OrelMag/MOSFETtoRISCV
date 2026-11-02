// Quick return: after a click that leaves one section for another (a codex term in a chapter, Open in Sandbox, a recap's
// level, a search pick), a pill in the top bar leads back to the place left, view and scroll included (returntrail.ts: the
// rules). It goes to the saved address rather than history.back(): a drill leaves one history entry per level.

import { h, icon } from './dom';
import { typing } from './keys';
import { currentViewHash, splitView } from './viewlink';
import { fallbackLabel, nextTrail, parseTrail, placeKey, RETURN_KEY, sectionOf, type Intent, type ReturnPlace } from './returntrail';

/** A page that names itself for the pill (ui/pages/*). */
export interface ReturnLabelled {
  returnLabel?(): { label: string; short?: string } | null;
}

let intent: { kind: Intent; at: number } | null = null;
/** A link clicked this long ago no longer explains a route (it went nowhere: the same address). */
const INTENT_MS = 1500;

/** A navigation made in code for the learner (a search pick, Open in Sandbox): a jump, like a link's. */
export function markJump(): void {
  intent = { kind: 'jump', at: Date.now() };
}

function load(): ReturnPlace[] {
  try { return parseTrail(sessionStorage.getItem(RETURN_KEY)); } catch { return []; }
}

function save(t: ReturnPlace[]): void {
  try {
    if (t.length) sessionStorage.setItem(RETURN_KEY, JSON.stringify(t));
    else sessionStorage.removeItem(RETURN_KEY);
  } catch { /* not kept: the pill still works for this page */ }
}

/** Boxes scrolled inside the view (by class list), and the page itself on a phone (''). */
function scrollOf(view: HTMLElement): [string, number][] {
  const out: [string, number][] = [];
  const doc = document.scrollingElement?.scrollTop ?? 0;
  if (doc > 0) out.push(['', doc]);
  for (const el of view.querySelectorAll<HTMLElement>('div, section, aside, main, article, ul, ol, nav')) {
    if (el.scrollTop > 0 && typeof el.className === 'string' && el.className.trim()) out.push([el.className.trim(), el.scrollTop]);
  }
  return out;
}

/** Scroll back once each box exists and is tall enough (pages load in chunks and grow), for up to a few seconds. */
function restoreScroll(scroll: [string, number][]): void {
  let left = scroll.slice();
  const until = Date.now() + 3000;
  const tick = () => {
    left = left.filter(([cls, top]) => {
      let el: Element | null;
      try { el = cls ? document.querySelector(`#view .${cls.split(/\s+/).map((c) => CSS.escape(c)).join('.')}`) : document.scrollingElement; } catch { return false; }
      if (!el || el.scrollHeight - el.clientHeight < top - 1) return true;
      el.scrollTop = top;
      return false;
    });
    if (left.length && Date.now() < until) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** The pill (for the top bar) and the router's hook, called first on every route while the page left is still mounted. */
export function installReturn(view: HTMLElement): { el: HTMLElement; route(page: ReturnLabelled | null): void } {
  let trail = load();
  let prev: string | null = null;
  window.addEventListener('hashchange', (e) => {
    try { prev = new URL(e.oldURL).hash || '#/'; } catch { prev = null; }
  });
  document.addEventListener('click', (e) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const a = (e.target as Element | null)?.closest?.('a[href^="#"]');
    if (a) intent = { kind: a.closest('.topbar .nav, .topbar .brand') ? 'nav' : 'jump', at: Date.now() };
  }, true);

  const long = h('span', { class: 'rt-long' });
  const short = h('span', { class: 'rt-short' });
  const go = h('a', { class: 'rt-go' }, icon('undo', 15), long, short);
  const forget = h('button', { class: 'rt-x', 'aria-label': 'Forget the way back', title: 'Forget the way back' }, icon('close', 13));
  const el = h('div', { class: 'return-pill' }, go, forget);
  const render = () => {
    const top = trail[trail.length - 1];
    el.hidden = !top;
    if (!top) return;
    go.setAttribute('href', top.hash);
    long.textContent = `Back to ${top.label}`;
    short.textContent = top.short;
    const before = trail.slice(0, -1).reverse().map((p) => p.label);
    go.title = `Back to ${top.label} (Alt+Backspace)${before.length ? `, then ${before.join(', then ')}` : ''}`;
    go.setAttribute('aria-label', `Back to ${top.label}`);
  };
  forget.addEventListener('click', () => {
    trail = [];
    save(trail);
    render();
  });
  window.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.key !== 'Backspace' || typing(e.target) || !trail.length) return;
    e.preventDefault();
    markJump();
    location.hash = trail[trail.length - 1].hash;
  });
  render();

  return {
    el,
    route(page) {
      const to = location.hash || '#/';
      const kind = intent && Date.now() - intent.at < INTENT_MS ? intent.kind : null;
      intent = null;
      const from = prev;
      prev = to;
      // the place left, measured only when it will be kept (reading every box's scroll costs a layout)
      let place: ReturnPlace | null = null;
      if (kind === 'jump' && from && sectionOf(from) !== sectionOf(to) && placeKey(from) !== placeKey(to)) {
        const named = page?.returnLabel?.() ?? null;
        // the stage's view suffix (inputs, probes, cycles) on the address left: the stage reads location.hash, already the new one
        const v = sectionOf(from) === 'c' || sectionOf(from) === 'workbench' ? currentViewHash() : null;
        const label = named?.label ?? fallbackLabel(from);
        place = { hash: splitView(from).route + (v ? v.slice(splitView(v).route.length) : ''), label, short: named?.short ?? label, scroll: scrollOf(view) };
      }
      const next = nextTrail(trail, place, to, kind);
      // arrived at a saved place: its scroll comes back too
      if (next.length < trail.length && placeKey(trail[next.length].hash) === placeKey(to)) restoreScroll(trail[next.length].scroll);
      if (next !== trail) {
        trail = next;
        save(trail);
        render();
      }
    },
  };
}
