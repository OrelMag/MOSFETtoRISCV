// Quick return (DOM-free): the places a learner left by a click into another section of the site, so the top bar can
// lead back. A trail of at most RETURN_MAX places, newest last; ui/returnto.ts keeps it for the tab and draws the pill.

import { splitView } from './viewlink';

export const RETURN_KEY = 'mosfet2riscv:return';
export const RETURN_MAX = 3;

/** A place left: its address (with the stage's view suffix), how the pill names it, and the scroll positions inside the page. */
export interface ReturnPlace {
  hash: string;
  label: string;
  /** For a narrow top bar ("Ch 07 · 3"). */
  short: string;
  /** Scrolled boxes in the page by their class list, and how far down. */
  scroll: [string, number][];
}

/** How the route was reached: a link or search inside the page (jump), the top nav or Home (nav), else unknown (null). */
export type Intent = 'jump' | 'nav' | null;

/** The part of the site an address is in. Moving inside one is not a jump: each has its own Back / Next. */
export function sectionOf(hash: string): string {
  const [a, b] = splitView(hash).route.replace(/^#\/?/, '').split('/');
  if (!a) return 'home';
  if (a === 'campaign') return b === 'codex' ? 'codex' : b === 'play' ? 'level' : 'campaign';
  if (a === 'start') return 'path';
  return a;
}

/** Hubs reached from the top bar anyway: leaving one sets no way back. */
const HUBS = new Set(['home', 'path']);

/** Two addresses are the same place when they name the same chapter step, workbench part or page (drill and view aside). */
export function placeKey(hash: string): string {
  const parts = splitView(hash).route.replace(/^#\/?/, '').split('/').filter(Boolean);
  return (parts[0] === 'c' ? parts.slice(0, 3) : parts[0] === 'workbench' ? parts.slice(0, 2) : parts).join('/');
}

/**
 * The trail after a route from `from` to `to`. Arriving at a saved place (the pill, the browser's Back, any link) ends the
 * trail there; the top nav forgets it; a jump into another section adds the place left (the oldest drops past RETURN_MAX).
 */
export function nextTrail(trail: ReturnPlace[], from: ReturnPlace | null, to: string, intent: Intent): ReturnPlace[] {
  const k = placeKey(to);
  const i = trail.findIndex((p) => placeKey(p.hash) === k);
  if (i >= 0) return trail.slice(0, i);
  if (intent === 'nav') return [];
  if (intent !== 'jump' || !from) return trail;
  const sec = sectionOf(from.hash);
  if (HUBS.has(sec) || sec === sectionOf(to)) return trail;
  return [...trail, from].slice(-RETURN_MAX);
}

/** A trail read back from storage (anything malformed dropped). */
export function parseTrail(text: string | null): ReturnPlace[] {
  try {
    const v = JSON.parse(text ?? '[]') as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((p): p is ReturnPlace => !!p && typeof p.hash === 'string' && p.hash.startsWith('#/') && typeof p.label === 'string'
      && typeof p.short === 'string' && Array.isArray(p.scroll)).slice(-RETURN_MAX);
  } catch {
    return [];
  }
}

/** The pill's label when the page left gave none. */
export function fallbackLabel(hash: string): string {
  const sec = sectionOf(hash);
  return ({ c: 'the chapter', workbench: 'the workbench', sandbox: 'the sandbox', campaign: 'the campaign map', codex: 'the codex',
    level: 'the level', notes: 'My notes' } as Record<string, string>)[sec] ?? 'where you were';
}
