// The codex's 3D model index (#/campaign/codex/models[/<model>]: MODELS_INDEX_ID, in the codex's detail pane): a card per
// model of widgets/models3dindex.ts, filtered by text and category; "Open here" loads the model above the cards (the same
// entry the chapter step mounts: placeholder, controls, SVG fallback), "In chapter" goes to its step. The campaign page
// owns the open model's lifetime (one at a time, destroyed when it closes or the page leaves): a WebGL context each.

import { chapterNo } from '../chapters/meta';
import { outlineOf } from '../chapters/outline';
import { codexById } from '../campaign/codex';
import type { Widget } from '../view/stage';
import { MODEL_CATEGORIES, MODELS_3D, MODELS_INDEX_ID, searchModels, type Model3d } from '../widgets/models3dindex';
import { h, icon } from './dom';

export const modelHref = (id?: string): string => `#/campaign/codex/${MODELS_INDEX_ID}${id ? `/${id}` : ''}`;

/** Where a model lives in the journey: "07 · Relays: A switch you can hear". */
export function modelPlace(m: Model3d): string {
  const c = outlineOf(m.chapter);
  if (!c) return m.chapter;
  return `${chapterNo(c)} · ${c.title}: ${c.steps[m.step]?.title ?? `step ${m.step + 1}`}`;
}

/** A model mounted now: a holder at once, the model's own widget in it when its chunk arrives. */
export function mountModel(m: Model3d): Widget {
  const el = h('div', { class: 'mx-model' }, h('p', { class: 'sub' }, `Loading ${m.title}…`));
  let inner: Widget | null = null, dead = false;
  m.open().then((w) => {
    if (dead) { w.destroy?.(); return; }
    inner = w;
    el.replaceChildren(w.el);
  }, (e: unknown) => { if (!dead) el.replaceChildren(h('p', { class: 'sub' }, `${m.title} did not load (${String(e)}).`)); });
  return { el, update: () => inner?.update?.(), destroy: () => { dead = true; inner?.destroy?.(); } };
}

export interface ModelsIndexOpts {
  /** The open model and its mounted widget. */
  open?: { model: Model3d; widget: Widget };
  query: string;
  cat: string;
  onFilter(query: string, cat: string): void;
  onOpen(id: string): void;
  onClose(id: string): void;
}

export function modelsIndexEl(o: ModelsIndexOpts): HTMLElement {
  let { query, cat } = o;
  const cats = MODEL_CATEGORIES.filter((c) => MODELS_3D.some((m) => m.category === c.id));
  const catTitle = (id: string) => MODEL_CATEGORIES.find((c) => c.id === id)?.title ?? id;
  const cards = MODELS_3D.map((m) => {
    const on = o.open?.model.id === m.id;
    const cx = (m.codex ?? []).map((id) => codexById(id)).filter((e) => !!e);
    const el = h('li', { class: `mx-card${on ? ' on' : ''}`, 'data-id': m.id, 'data-cat': m.category },
      h('div', { class: 'mx-card-head' }, h('h3', null, m.title), h('span', { class: 'cp-badge mx-cat' }, catTitle(m.category))),
      h('p', { class: 'mx-sum' }, m.summary),
      h('p', { class: 'mx-where' }, icon('book', 12), h('a', { href: `#/c/${m.chapter}/${m.step}` }, modelPlace(m))),
      cx.length ? h('p', { class: 'ax-codex' }, 'In the codex: ', cx.map((e) => h('a', { class: 'cp-chip', href: `#/campaign/codex/${e.id}` }, e.title))) : null,
      h('div', { class: 'mx-acts' },
        on ? h('button', { class: 'btn sm', type: 'button', 'data-mx': m.id, onclick: () => o.onClose(m.id) }, icon('close', 13), 'Close')
          : h('button', { class: 'btn sm primary', type: 'button', 'data-mx': m.id, 'aria-label': `Open ${m.title} here`, onclick: () => o.onOpen(m.id) }, icon('cube', 13), 'Open here'),
        h('a', { class: 'btn sm ghost', href: `#/c/${m.chapter}/${m.step}`, 'aria-label': `${m.title} in its chapter` }, 'In chapter', icon('chevR', 13))));
    return { m, el };
  });
  const empty = h('p', { class: 'sub', hidden: true }, 'No model matches.');
  const search = h('input', { class: 'cx-search', type: 'search', placeholder: `Filter ${MODELS_3D.length} models`, 'aria-label': 'Filter the 3D models', value: query });
  const chips = h('div', { class: 'cx-kinds', role: 'group', 'aria-label': 'Categories' }, [{ id: '', title: 'All' }, ...cats].map((c) =>
    h('button', { class: 'cx-kind', type: 'button', 'data-k': c.id, onclick: () => { cat = c.id; apply(); } }, c.title)));
  const apply = () => {
    const hits = query.trim() ? new Set(searchModels(query).map((m) => m.id)) : null;
    let shown = 0;
    for (const c of cards) {
      c.el.hidden = (!!hits && !hits.has(c.m.id)) || (!!cat && c.m.category !== cat);
      if (!c.el.hidden) shown++;
    }
    empty.hidden = shown > 0;
    for (const b of chips.children as HTMLCollectionOf<HTMLElement>) {
      b.classList.toggle('on', b.dataset.k === cat);
      b.setAttribute('aria-pressed', String(b.dataset.k === cat));
    }
    o.onFilter(query, cat);
  };
  search.addEventListener('input', () => { query = search.value; apply(); });
  apply();
  const open = o.open;
  const stage = open ? h('section', { class: 'mx-open', 'aria-labelledby': 'mx-open-t' },
    h('div', { class: 'mx-open-head' },
      h('h3', { id: 'mx-open-t', tabindex: '-1' }, icon('cube', 16), open.model.title),
      h('a', { class: 'btn sm ghost', href: `#/c/${open.model.chapter}/${open.model.step}` }, 'In chapter', icon('chevR', 13)),
      h('button', { class: 'btn sm', type: 'button', 'aria-label': `Close ${open.model.title}`, onclick: () => o.onClose(open.model.id) }, icon('close', 13), 'Close')),
    h('p', { class: 'sub' }, modelPlace(open.model)),
    open.widget.el) : null;
  return h('div', { class: 'cp-codex-entry mx-index' },
    h('h2', null, icon('cube', 18), '3D models'),
    h('p', null, `Every machine and device the journey shows in 3D, ${MODELS_3D.length} in all. Each one is driven by the same model as its chapter: open it here, or go to the step that tells its story. Without WebGL2 a model draws a flat view instead.`),
    stage,
    h('div', { class: 'ax-tools' }, search, chips),
    empty,
    h('ul', { class: 'mx-grid' }, cards.map((c) => c.el)));
}
