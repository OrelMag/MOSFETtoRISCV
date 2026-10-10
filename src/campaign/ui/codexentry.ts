// A codex entry in full: the one-line summary on top, then the idea, a worked example, common
// mistakes and where it sits in the CPU (written in codexmore*.ts), next to figures generated from
// the library so they cannot drift: the part's schematic, live (click an input to flip it), its
// truth table and pins, and its cost against the alternatives.

import { flatten } from '../../sim/flatten';
import { GateSim } from '../../sim/gatesim';
import { needsSwitchLevel } from '../../sim/harness';
import type { Sim } from '../../sim/sim';
import { SwitchSim } from '../../sim/switchsim';
import { pack } from '../../sim/values';
import { h, icon } from '../../ui/dom';
import { ViewCtx } from '../../view/context';
import { SchematicView } from '../../view/schematic';
import { resolveComponent } from '../../lib/resolve';
import { CODEX_KINDS, codexById, type CodexEntry } from '../codex';
import type { CodexMore } from '../codexmore';
import { libCost } from '../measure';
import { NODES } from '../nodes';
import type { ProgressView } from '../graph';
import { anatomySvg } from './svgs';

const rich = (tag: 'p' | 'div' | 'li', html: string, cls?: string) => {
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

/** The levels that teach an entry. */
const taughtIn = (id: string) => NODES.filter((n) => n.codex.includes(id));

export function codexEntryEl(e: CodexEntry, more: CodexMore | undefined, view: ProgressView, sheets: HTMLElement[]): HTMLElement {
  const kind = CODEX_KINDS.find((k) => k.id === e.kind)!.title.replace(/s$/, '');
  const cost = more?.lib ? libCost(more.lib) : undefined;
  const head = h('header', { class: 'cx-head' },
    h('h2', null, e.title, h('span', { class: 'cp-badge kind' }, kind),
      cost ? h('span', { class: 'cp-badge cost', title: 'Measured from the library part' }, `${cost.nand.toLocaleString()} NAND · ${cost.transistors.toLocaleString()} T${cost.depth !== null ? ` · depth ${cost.depth}` : ''}`) : null),
    rich('div', e.body, 'cx-sum'));
  const links = h('div', { class: 'cx-links' },
    ...taughtIn(e.id).map((n) => h('a', { class: 'lv-chip acc', href: `#/campaign/n/${n.id}` }, `Level: ${n.title}`)),
    ...(more?.chapters ?? []).map((c) => h('a', { class: 'lv-chip acc', href: `#/c/${c.chapter}/${c.step ?? 0}` }, icon('book', 12), c.label)),
    ...(e.related ?? []).map((r) => h('a', { class: 'lv-chip', href: `#/campaign/codex/${r}` }, `Related: ${codexById(r)?.title ?? r}`)));
  if (!more) {
    // Not written up yet: the summary and the generated datasheets.
    return h('article', { class: 'cp-codex-entry cx-entry' }, head, ...sheets, links.childElementCount ? h('section', null, h('h4', null, 'Used in'), links) : null);
  }
  const left = h('div', { class: 'cx-col' },
    h('section', null, h('h4', null, 'The idea'), rich('div', more.idea, 'cx-prose')),
    more.example ? h('section', null, h('h4', null, `Worked example: ${more.example.title}`), rich('div', more.example.body, 'cx-prose cx-example')) : null,
    more.mistakes?.length ? h('section', null, h('h4', null, 'Common mistakes'), h('ul', { class: 'cx-mist' }, more.mistakes.map((m) => rich('li', m)))) : null,
    more.anatomy?.length ? h('section', null, h('h4', null, 'Where it sits'), h('div', { class: 'lv-anat cx-anat' }, anatomySvg(view, more.anatomy[0], () => {}))) : null);
  const fig = more.lib ? liveSchematic(more.lib) : null;
  const compare = [more.lib, ...(more.compare ?? [])].filter((x): x is string => !!x).map((id) => ({ id, name: resolveComponent(id)?.name ?? id, c: libCost(id) }));
  const max = Math.max(1, ...compare.map((x) => x.c?.nand ?? 0));
  const right = h('div', { class: 'cx-col' },
    fig ? h('figure', { class: 'cx-fig' }, fig,
      h('figcaption', null, 'The library part, simulated: click an input to flip it. ', h('a', { href: `#/workbench/${more.lib}` }, 'Open it on the workbench'), ' to drill down to transistors.')) : null,
    ...sheets,
    compare.length > 1 ? h('section', null, h('h4', null, 'Cost against the alternatives'),
      h('div', { class: 'lv-bars' }, compare.flatMap((x, i) => [
        h('a', { href: `#/workbench/${x.id}` }, x.name),
        h('span', { class: 'track' }, h('i', { class: i === 0 ? 'you' : '', style: `width:${(100 * (x.c?.nand ?? 0) / max).toFixed(1)}%` })),
        h('span', { class: 'v' }, `${x.c?.nand.toLocaleString() ?? '—'}${x.c?.depth !== null && x.c?.depth !== undefined ? ` · d ${x.c.depth}` : ''}`)])),
      h('p', { class: 'sub' }, 'NANDs (bar) and depth in NAND delays, measured.')) : null,
    links.childElementCount ? h('section', null, h('h4', null, 'Used in'), links) : null);
  return h('article', { class: 'cp-codex-entry cx-entry' }, head, h('div', { class: 'cx-cols' }, left, right));
}
