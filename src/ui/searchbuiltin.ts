// The search's built-in sources: chapters and steps and the workbench's components (both already in the
// main bundle), campaign levels and the codex (a chunk loaded on the first keystroke: searchcampaign.ts),
// and the actions everyone has (theme, radix, the stage's controls, the keys …). The sandbox adds its own
// actions while an editor is mounted (editor/searchactions.ts).

import { chapters } from '../chapters';
import { checksDone, recapIndex } from '../chapters/checks';
import { libraryItems } from '../lib/catalog';
import { navEntries, type NavItem } from './chapternav';
import { showPageKeys } from './keyhelp';
import { keyDef } from './keys';
import { allActions, here, registerActions, registerSearchSource, type SearchCtx } from './searchsources';
import { applyTheme, settings, type Theme } from './settings';

const route = (ctx: SearchCtx) => ctx.hash.replace(/^#\/?/, '').split('/');
/** The stage of a chapter or the workbench (none outside a browser: the tests). */
const stageEl = () => (typeof document === 'undefined' ? null : document.querySelector<HTMLElement>('#view section.stage'));
const caps = (id: string) => keyDef(id)?.caps.filter((c) => c !== '·' && c !== '…');

// ---- chapters and steps ----------------------------------------------------------------------------

let chapterCache: NavItem[] | null = null;
settings.onChange(() => { chapterCache = null; });

function chapterItems(): NavItem[] {
  if (chapterCache) return chapterCache;
  const steps = new Map(chapters.map((c) => [c.id, c.steps.length]));
  return chapterCache = navEntries(chapters).map((e): NavItem => {
    const n = steps.get(e.chapter) ?? 1;
    const ch = e.step < 0;
    let note = '';
    if (ch && settings.visited(e.chapter).length) {
      const c = chapters.find((x) => x.id === e.chapter)!;
      const { done, total } = checksDone(c, (k) => settings.isSolved(k));
      if (total) note = ` · ${done} / ${total} checks`;
    }
    return {
      kind: ch ? 'chapter' : 'step', id: `${e.chapter}/${e.step}`, title: e.title, no: e.no, href: e.href, entry: e,
      sub: ch ? `${e.level} · ${n} steps${note}` : `${e.chTitle} · step ${e.step + 1} of ${n}`, text: e.text,
    };
  });
}

registerSearchSource({
  id: 'chapters', title: 'Chapters and steps', scope: 'Chapters',
  order: (ctx) => (route(ctx)[0] === 'workbench' ? 2 : route(ctx)[0] === 'sandbox' ? 3 : 0),
  items: chapterItems,
  browse: () => chapterItems().filter((it) => it.kind === 'chapter'),
});

// ---- workbench components ----------------------------------------------------------------------------

let benchCache: NavItem[] | null = null;
registerSearchSource({
  id: 'workbench', title: 'Workbench', scope: 'Workbench',
  order: (ctx) => (route(ctx)[0] === 'workbench' ? 0 : route(ctx)[0] === 'sandbox' ? 2 : 1),
  items: () => benchCache ??= libraryItems().flatMap((g) => g.items.map((it): NavItem => ({
    kind: 'component', id: it.id, title: it.name, sub: `${it.id} · ${g.title}${it.family ? ' · sizes' : ''}`, alt: `${it.id} ${g.title}`,
    href: `#/workbench/${it.id}`,
  }))),
});

// ---- campaign levels and the codex (lazy) --------------------------------------------------------------

type CampaignMod = typeof import('./searchcampaign');
let cmod: CampaignMod | null = null;
let cload: Promise<unknown> | null = null;
const loadCampaign = () => cload ??= import('./searchcampaign').then((m) => { cmod = m; }, (e) => { cload = null; throw e; });
/** Levels and codex as of this opening of the search (progress may have moved since the last). */
let levels: NavItem[] | null = null, codex: NavItem[] | null = null;
export function resetSearchCaches(): void {
  levels = codex = null;
}
const campaignFirst = (ctx: SearchCtx) => route(ctx)[0] === 'campaign';

registerSearchSource({
  id: 'campaign', title: 'Campaign', scope: 'Campaign', order: (ctx) => (campaignFirst(ctx) ? 0 : 3),
  items: () => (cmod ? levels ??= cmod.levelItems() : null), load: loadCampaign,
});
registerSearchSource({
  id: 'codex', title: 'Codex', scope: 'Codex', order: (ctx) => (campaignFirst(ctx) ? 1 : 4),
  items: () => (cmod ? codex ??= cmod.codexItems() : null), load: loadCampaign,
});

// ---- actions ------------------------------------------------------------------------------------------

registerSearchSource({
  id: 'actions', title: 'Actions', scope: 'Actions', prefix: '>',
  order: (ctx) => (route(ctx)[0] === 'sandbox' || (route(ctx)[0] === 'campaign' && route(ctx)[1] === 'play') ? -1 : 5),
  items: allActions,
});

const act = (id: string, title: string, sub: string, run: () => void, keys?: string[]): NavItem => ({ kind: 'action', id, title, sub, run, keys });
const toggle = (k: 'animate' | 'wireFlow' | 'netColors' | 'glossary' | 'autoClock' | 'simpleWires' | 'singleKeys' | 'wide') => () => {
  settings.set(k, !settings[k]);
  applyTheme();
};
const onOff = (b: boolean) => (b ? 'on' : 'off');
const THEMES: Theme[] = ['auto', 'light', 'dark'];
const RADIXES = ['hex', 'bin', 'dec'] as const;
const go = (href: string) => () => { location.hash = href; };

/** The stage's own buttons (Run, Pulse, Step, Back, Reset, the inputs, Probe, Up, zoom): what they say is what they do. */
function stageActions(): NavItem[] {
  const st = stageEl();
  if (!st) return [];
  const label = (b: HTMLElement) => (b.textContent?.trim() || b.getAttribute('aria-label') || b.title || '').replace(/\s+/g, ' ');
  const out: NavItem[] = [];
  const seen = new Set<string>();
  const add = (b: HTMLButtonElement, title: string, sub: string, keys?: string[], onPage = true) => {
    if (b.disabled || !title || seen.has(title) || !b.getClientRects().length) return;
    seen.add(title);
    const it = act(`stage.${title}`, title, sub, () => b.click(), keys);
    out.push(onPage ? here(it) : it);
  };
  // Run / Pulse / Step / Back / Reset (worded buttons: not a bus's − + or an output's radix), then the 1-bit inputs
  for (const b of st.querySelectorAll<HTMLButtonElement>('.controls button.btn')) {
    const t = label(b);
    if (/^[A-Za-z][A-Za-z ]{2,}$/.test(t)) add(b, t, `Circuit · ${b.title || 'control'}`);
  }
  for (const b of st.querySelectorAll<HTMLButtonElement>('.controls button.in-toggle')) add(b, `Toggle input ${b.dataset.port ?? label(b)}`, 'Circuit · input');
  for (const b of st.querySelectorAll<HTMLButtonElement>('.stage-bar button')) {
    const t = b.getAttribute('aria-label') || b.title || label(b);
    // not the crumbs (places, not actions) nor a menu's own items
    if (!t || b.closest('.pal-menu, .crumbs')) continue;
    const name = t.replace(/\s*\(.*\)$/, '').replace(/:.*$/, '');
    add(b, name, `Circuit · ${t}`, /probe/i.test(t) ? ['P'] : /^Up one level/.test(t) ? ['Esc'] : undefined, false);
  }
  return out;
}

/** The chapter page's moves, as places (the router turns #/c/<id>/<n> into a step change). */
function chapterActions(ctx: SearchCtx): NavItem[] {
  const [key, id, s] = route(ctx);
  if (key !== 'c') return [];
  const i = chapters.findIndex((c) => c.id === id);
  if (i < 0) return [];
  const c = chapters[i], step = Number(s ?? 0) || 0;
  const last = recapIndex(c) ?? c.steps.length - 1;
  const prev = chapters[i - 1], next = chapters[i + 1];
  const out: NavItem[] = [];
  if (step < last) out.push(act('step.next', 'Next step', `${c.title} · step ${step + 2}`, go(`#/c/${c.id}/${step + 1}`), caps('step.next')));
  if (step > 0) out.push(act('step.prev', 'Previous step', `${c.title} · step ${step}`, go(`#/c/${c.id}/${step - 1}`), caps('step.prev')));
  if (next) out.push(act('chapter.next', 'Next chapter', next.title, go(`#/c/${next.id}/0`), caps('chapter.next')));
  if (prev) out.push(act('chapter.prev', 'Previous chapter', prev.title, go(`#/c/${prev.id}/0`), caps('chapter.prev')));
  return out;
}

registerActions((ctx) => {
  const [key] = route(ctx);
  const stage = !!stageEl();
  const editor = key === 'sandbox' || ctx.hash.startsWith('#/campaign/play');
  const out: NavItem[] = [...chapterActions(ctx), ...stageActions()];
  if (stage) out.push(here(act('stage.focus', 'Focus the circuit', 'Circuit · then Tab on to its controls', () => stageEl()?.focus(), caps('stage.focus'))));
  out.push(here(act('theme', 'Toggle theme', `${THEMES.join(' → ')} (now ${settings.theme})`, () => {
    settings.set('theme', THEMES[(THEMES.indexOf(settings.theme) + 1) % THEMES.length]);
    applyTheme();
  })));
  if (stage || editor) {
    out.push(here(act('radix', 'Radix: hex / bin / dec', `how bus values are shown (now ${settings.radix})`,
      () => settings.set('radix', RADIXES[(RADIXES.indexOf(settings.radix as typeof RADIXES[number]) + 1) % 3]))));
  }
  if (stage) {
    out.push(here(act('slow', 'Slow motion', `one gate delay at a time (${onOff(settings.animate)})`, toggle('animate'))));
    out.push(act('wide', 'Hide the side panes', `the circuit full width (${onOff(settings.wide)})`, toggle('wide')));
  }
  if (!editor) out.push(act('keys', 'Keys on this page', 'every shortcut that works here', () => showPageKeys(), ['?']));
  out.push(
    act('singleKeys', 'Single-key shortcuts', `letters, digits and / [ ] ? as shortcuts (${onOff(settings.singleKeys)})`, toggle('singleKeys')),
    act('flow', 'Flowing bits', `1s march along wires (${onOff(settings.wireFlow)})`, toggle('wireFlow')),
    act('nets', 'Colour per net', `each net in a hue of its own (${onOff(settings.netColors)})`, toggle('netColors')),
    act('vivid', 'Vivid look', `bright filled parts, thick wires (${onOff(settings.vivid)})`, () => { settings.setVivid(!settings.vivid); applyTheme(); }),
    act('gloss', 'Hover definitions', `codex terms underlined in the chapters (${onOff(settings.glossary)})`, toggle('glossary')),
    act('clock', 'Automatic clock', `a circuit with a clock starts running (${onOff(settings.autoClock)})`, toggle('autoClock')),
    act('simple', 'Simple connections', `sandbox: straight wires at any angle (${onOff(settings.simpleWires)})`, toggle('simpleWires')),
    act('go.journey', 'Go to the journey map', 'home', go('#/')),
    act('go.campaign', 'Go to the campaign map', 'campaign', go('#/campaign')),
    act('go.codex', 'Open the codex', 'campaign · every entry', go('#/campaign/codex')),
    act('go.sandbox', 'Open the sandbox', 'build your own chips', go('#/sandbox')),
    act('go.stats', 'Workbench statistics', 'gate counts and delays of every component', go('#/workbench/stats')),
    act('go.bench', 'Benchmarks', 'every CPU on the benchmark set', go('#/workbench/bench')),
  );
  return out;
});
