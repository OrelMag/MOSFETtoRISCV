// A codex entry in full: the one-line summary on top, then where to learn it and how it connects (builds on, leads
// to, see also: codexlinks.ts), the idea, a worked example, common mistakes, where it sits in the CPU and questions to
// check yourself (written in codexmore*.ts / codexcheck*.ts), next to figures generated from the library so they
// cannot drift: a widget for an entry without a part (codexfigs.ts), the part's schematic, live (click an input to flip
// it), its truth table and pins, and its cost against the alternatives.

import { flatten } from '../../sim/flatten';
import { GateSim } from '../../sim/gatesim';
import { needsSwitchLevel } from '../../sim/harness';
import type { Sim } from '../../sim/sim';
import { SwitchSim } from '../../sim/switchsim';
import { pack } from '../../sim/values';
import { h, icon } from '../../ui/dom';
import { quizBox } from '../../ui/quiz';
import { settings } from '../../ui/settings';
import { ViewCtx } from '../../view/context';
import { SchematicView } from '../../view/schematic';
import { fsmOf } from '../../lib/fsms';
import { resolveComponent } from '../../lib/resolve';
import { fsmDiagram } from '../../view/fsmdiagram';
import { CODEX_KINDS, type CodexEntry } from '../codex';
import { buildsOn, leadsTo, neighbours, seeAlso, teachingLevels } from '../codexlinks';
import type { CodexMore } from '../codexmore';
import { DRILLS, rng, type Drill } from '../drills';
import { libCost } from '../measure';
import type { ProgressView } from '../graph';
import type { Quiz } from '../../chapters/types';
import { codexFigure } from './codexfigs';
import { anatomySvg } from './svgs';

const rich = (tag: 'p' | 'div' | 'li' | 'span', html: string, cls?: string) => {
  const el = h(tag, cls ? { class: cls } : null);
  el.innerHTML = html;
  return el;
};

/** A library part's schematic, simulated: its inputs toggle on click. */
export function liveSchematic(id: string): HTMLElement | null {
  const def = resolveComponent(id);
  if (!def) return null;
  const level = needsSwitchLevel(def) ? 'switch' : 'gate';
  const design = flatten(def, { mode: level, expand: (d, n) => n.parent === null || !d.preferBehavior });
  const sim: Sim = level === 'switch' ? new SwitchSim(design) : new GateSim(design);
  sim.reset('zero');
  sim.settle();
  const host = h('div', { class: 'cx-fig-canvas' });
  const view: SchematicView = new SchematicView(host, {
    open: () => {}, select: () => {}, editInput: () => {},
    toggleInput: (port) => {
      const v = pack(sim.getBits(design.root.ports[port]));
      sim.setInput(port, v ? 0 : 1);
      sim.settle();
      view.update();
    },
  });
  view.show(new ViewCtx(sim, design.root), true);
  // Fit once the host has a size.
  const ro = new ResizeObserver(() => {
    if (host.clientWidth > 0) {
      view.fit();
      ro.disconnect();
    }
  });
  ro.observe(host);
  return host;
}

/** The idea as paragraphs (written with <br> between them), its first sentence set as the lead. */
function ideaEl(html: string): HTMLElement {
  const paras = html.split(/<br\s*\/?>/i).map((p) => p.trim()).filter(Boolean);
  const el = h('div', { class: 'cx-prose cx-idea' });
  paras.forEach((p, i) => {
    // the first sentence: up to a full stop or colon after a letter, digit or bracket, then a space and a capital
    const m = i === 0 ? /^([^<]*?[A-Za-z0-9)\]][.:])\s+(?=[A-Z])/.exec(p) : null;
    el.append(m ? h('p', null, rich('span', m[1], 'cx-lead'), ' ', rich('span', p.slice(m[0].length))) : rich('p', p));
  });
  return el;
}

/** Codex entries whose number skills a drill trains: a fresh question each time. */
const DRILL_OF: Record<string, string> = {
  positional: 'binary', hex: 'binary', twos: 'twos', overflow: 'twos', identities: 'boolean', rv16: 'isa16', ieee754: 'float',
  relaystep: 'relay', hollerith: 'hollerith',
};

/** One generated question with its exact checker, and New question. */
function tryOne(d: Drill): HTMLElement {
  const box = h('div', { class: 'challenge cx-try' });
  let seed = Date.now() % 100000;
  const draw = () => {
    const q = d.make(rng(seed++));
    const input = h('input', { class: 'cx-try-in', type: 'text', placeholder: q.placeholder ?? 'Your answer', 'aria-label': 'Your answer' });
    const out = h('div', { class: 'explain' });
    const check = () => {
      const r = q.check(input.value);
      out.innerHTML = r.ok ? `<strong>Right.</strong> ${q.explain ?? ''}` : (r.why ?? 'Not quite.');
      box.classList.toggle('solved', r.ok);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') check(); });
    box.classList.remove('solved');
    box.replaceChildren(
      h('div', { class: 'challenge-head' }, h('span', { class: 'tag' }, 'Try one'), rich('span', q.prompt)),
      h('div', { class: 'cx-try-row' }, input,
        h('button', { class: 'btn sm', onclick: check }, 'Check'),
        h('button', { class: 'btn ghost sm', onclick: () => { out.innerHTML = `${q.answer}${q.explain ? `: ${q.explain}` : ''}`; } }, 'Show answer'),
        h('button', { class: 'btn ghost sm', onclick: draw }, 'New question')),
      out);
  };
  draw();
  return box;
}

const chip = (cls: string, href: string, ...body: (string | Node)[]) => h('a', { class: `lv-chip ${cls}`.trim(), href }, ...body);

/** The rows under the summary: where to learn it, then how it connects (each entry shown once, the closest relation first). */
function linksEl(e: CodexEntry, more: CodexMore | undefined): HTMLElement {
  const learn = [
    ...(more?.chapters ?? []).map((c) => chip('acc', `#/c/${c.chapter}/${c.step ?? 0}`, icon('book', 12), c.label)),
    ...teachingLevels(e.id).map((n) => chip('acc', `#/campaign/n/${n.id}`, icon('flag', 12), n.title)),
  ];
  const seen = new Set<string>([e.id]);
  const once = (xs: CodexEntry[]) => xs.filter((x) => !seen.has(x.id) && !!seen.add(x.id));
  const builds = once(buildsOn(e.id)), leads = once(leadsTo(e.id)), also = once(seeAlso(e.id));
  const row = (label: string, items: HTMLElement[]) => items.length ? h('div', { class: 'cx-row' }, h('span', { class: 'cx-row-k' }, label), ...items) : null;
  const cx = (xs: CodexEntry[]) => xs.map((x) => chip('', `#/campaign/codex/${x.id}`, x.title));
  return h('div', { class: 'cx-rows' },
    row('Learn it', learn), row('Builds on', cx(builds)), row('Leads to', cx(leads)), row('See also', cx(also)));
}

/** The entries before and after this one. */
function prevNextEl(id: string): HTMLElement {
  const { prev, next } = neighbours(id);
  return h('nav', { class: 'cx-prevnext' },
    prev ? h('a', { href: `#/campaign/codex/${prev.id}` }, icon('chevL', 13), prev.title) : h('span'),
    next ? h('a', { href: `#/campaign/codex/${next.id}` }, next.title, icon('chevR', 13)) : h('span'));
}

/** Where it sits in the CPU: one diagram, a button per block when it sits in several. */
function anatomyEl(view: ProgressView, blocks: string[]): HTMLElement {
  const holder = h('div', { class: 'lv-anat cx-anat' });
  const chips = h('div', { class: 'cx-anat-chips' });
  const showBlock = (b: string) => {
    holder.replaceChildren(anatomySvg(view, b, () => {}));
    for (const c of chips.children) c.classList.toggle('on', (c as HTMLElement).dataset.b === b);
  };
  if (blocks.length > 1) chips.append(...blocks.map((b) => h('button', { class: 'btn ghost sm', 'data-b': b, onclick: () => showBlock(b) }, b)));
  showBlock(blocks[0]);
  return h('div', null, chips.childElementCount ? chips : null, holder);
}

export function codexEntryEl(e: CodexEntry, more: CodexMore | undefined, view: ProgressView, sheets: HTMLElement[], checks: Quiz[] = []): HTMLElement {
  const kind = CODEX_KINDS.find((k) => k.id === e.kind)!.title.replace(/s$/, '');
  const cost = more?.lib ? libCost(more.lib) : undefined;
  const head = h('header', { class: 'cx-head' },
    h('h2', null, e.title, h('span', { class: 'cp-badge kind' }, kind),
      cost ? h('span', { class: 'cp-badge cost', title: 'Measured from the library part' }, `${cost.nand.toLocaleString()} NAND · ${cost.transistors.toLocaleString()} T${cost.depth !== null ? ` · depth ${cost.depth}` : ''}`) : null),
    rich('div', e.body, 'cx-sum'), linksEl(e, more));
  const drill = DRILLS[DRILL_OF[e.id] ?? ''];
  const left = h('div', { class: 'cx-col' },
    more ? h('section', null, h('h4', null, 'The idea'), ideaEl(more.idea)) : null,
    more?.example ? h('section', null, h('h4', null, `Worked example: ${more.example.title}`), rich('div', more.example.body, 'cx-prose cx-example')) : null,
    more?.mistakes?.length ? h('section', null, h('h4', null, 'Common mistakes'), h('ul', { class: 'cx-mist' }, more.mistakes.map((m) => rich('li', m)))) : null,
    more?.anatomy?.length ? h('section', null, h('h4', null, 'Where it sits'), anatomyEl(view, more.anatomy)) : null,
    checks.length || drill ? h('section', { class: 'cx-check' }, h('h4', null, 'Check yourself'),
      ...checks.map((q, k) => quizBox(q, `codex:${e.id}:${k}`, `${k + 1} of ${checks.length}`, () => {})),
      drill ? tryOne(drill) : null) : null);
  const figure = codexFigure(e.id);
  const fig = more?.lib ? liveSchematic(more.lib) : null;
  const fsm = fsmOf(more?.lib);
  const compare = [more?.lib, ...(more?.compare ?? [])].filter((x): x is string => !!x).map((id) => ({ id, name: resolveComponent(id)?.name ?? id, c: libCost(id) }));
  const max = Math.max(1, ...compare.map((x) => x.c?.nand ?? 0));
  const right = h('div', { class: 'cx-col' },
    figure ? h('figure', { class: 'cx-fig cx-widget' }, figure.el, h('figcaption', null, figure.caption)) : null,
    fig ? h('figure', { class: 'cx-fig' }, fig,
      h('figcaption', null, 'The library part, simulated: click an input to flip it. ', h('a', { href: `#/workbench/${more!.lib}` }, 'Open it on the workbench'), ' to drill down to transistors.')) : null,
    fsm ? h('figure', { class: 'cx-fig' }, fsmDiagram(fsm).el,
      h('figcaption', null, 'Its state diagram, drawn from the same table as the circuit (a test reads the circuit back into it). Arcs read input / output.')) : null,
    ...sheets,
    compare.length > 1 ? h('section', null, h('h4', null, 'Cost against the alternatives'),
      h('div', { class: 'lv-bars' }, compare.flatMap((x, i) => [
        h('a', { href: `#/workbench/${x.id}` }, x.name),
        h('span', { class: 'track' }, h('i', { class: i === 0 ? 'you' : '', style: `width:${(100 * (x.c?.nand ?? 0) / max).toFixed(1)}%` })),
        h('span', { class: 'v' }, `${x.c?.nand.toLocaleString() ?? '—'}${x.c?.depth !== null && x.c?.depth !== undefined ? ` · d ${x.c.depth}` : ''}`)])),
      h('p', { class: 'sub' }, 'NANDs (bar) and depth in NAND delays, measured.')) : null);
  const article = h('article', { class: 'cp-codex-entry cx-entry' }, head, h('div', { class: 'cx-cols' }, left, right), prevNextEl(e.id));
  // Hover definitions inside the entry's own text (not for itself): a chunk of its own, marked once it arrives.
  if (settings.glossary) {
    import('./glossaryui').then((m) => {
      for (const el of article.querySelectorAll<HTMLElement>('.cx-idea, .cx-example, .cx-mist')) if (el.isConnected) m.markTerms(el, 8, new Set([e.id]));
    }, () => {});
  }
  return article;
}
