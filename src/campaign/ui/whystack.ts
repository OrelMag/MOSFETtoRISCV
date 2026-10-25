// The thread on screen (campaign/thread.ts): one why stack for the map's level panel and the level screen's Why tab
// (the why as the lead, where the part goes, the case, how later levels use it, what it builds on, then the rest),
// the act-end card and "Now within reach". Both pages pass how a level opens (the map's panel or the level screen).

import { actName, actTitle, nodeById } from '../nodes';
import { isDone, type ProgressView } from '../graph';
import { altCost } from '../measure';
import type { CampaignNode } from '../types';
import { actEnd, actNext, type Chain, closedAct, endLinks, sideQuest, whyStack, withinReach } from '../thread';
import { h, icon } from '../../ui/dom';

export interface ThreadCtx {
  view: ProgressView;
  /** Where a level opens. */
  route: (n: CampaignNode) => string;
  /** Can the learner open it now (not locked, built)? */
  open: (n: CampaignNode) => boolean;
}

const rich = (tag: 'p' | 'div' | 'span' | 'li', html: string, cls?: string) => {
  const el = h(tag, cls ? { class: cls } : null);
  el.innerHTML = html;
  return el;
};
const sec = (title: string, ...body: (Node | null)[]) => h('section', { class: 'th-sec' }, h('h4', null, title), ...body);

/** 16-bit adder → Adder / subtractor (Act 2) → … → ALU block. */
export function chainEl(c: Chain, ctx: ThreadCtx): HTMLElement {
  const [me, ...rest] = c.nodes;
  const arrow = () => h('span', { class: 'th-arr', 'aria-hidden': 'true' }, '→');
  const items: Node[] = [h('span', { class: 'th-n me' }, me.title)];
  for (const n of rest) {
    items.push(arrow(), h('a', { class: `th-n${isDone(ctx.view(n.id)) ? ' done' : ''}`, href: ctx.route(n) }, n.title, h('span', { class: 'th-act' }, actName(n.act))));
  }
  if (c.block) {
    items.push(arrow(), h('span', { class: 'th-n blk' }, c.block === 'all' ? 'every block of the CPU' : `${c.block.label} block`));
  }
  return h('p', { class: 'th-chain', 'aria-label': `Goes into: ${[me.title, ...rest.map((n) => `${n.title} (${actName(n.act)})`), ...(c.block ? [c.block === 'all' ? 'every block of the CPU' : `the ${c.block.label} block`] : [])].join(', then ')}` }, ...items);
}

/**
 * The why stack. `map`: the case's cost in words and a More fold (without it, alternatives measured, pitfalls); `level`:
 * without it inline, the caller's cost section (`cost`, with its table) in its place, and the pitfalls on the Task tab
 * (`pitfalls` opens it).
 */
export function whyStackEl(n: CampaignNode, ctx: ThreadCtx, mode: 'map' | 'level', opts: { cost?: HTMLElement; pitfalls?: () => void; title?: string } = {}): HTMLElement {
  const w = whyStack(n.id)!;
  const el = h('div', { class: `th-why ${mode}` }, h('div', { class: 'th-leadbox' }, opts.title ? h('h4', null, opts.title) : null, rich('p', w.lead, 'th-lead')));
  if (w.chain) el.append(sec('Goes into', chainEl(w.chain, ctx)));
  if (w.problem) el.append(sec('The problem', rich('p', w.problem)));
  if (mode === 'level' && w.without) el.append(sec('Without it', rich('p', w.without)));
  if (mode === 'map' && w.cost) el.append(sec('What it costs', rich('p', w.cost)));
  if (opts.cost) el.append(opts.cost);
  if (w.later.length) {
    el.append(sec('Used later in', h('ul', { class: 'th-later' }, w.later.map((u) => h('li', null,
      h('a', { href: ctx.route(u.node), class: isDone(ctx.view(u.node.id)) ? 'done' : '' }, u.node.title),
      h('span', { class: 'th-act' }, `${actName(u.node.act)}${u.node.optional ? ' · optional' : ''}`),
      u.clause ? [': ', u.clause] : null)))));
  }
  const req = n.requires.map((r) => nodeById(r)).filter((x): x is CampaignNode => !!x);
  if (req.length) {
    el.append(h('p', { class: 'th-builds' }, h('b', null, 'Builds on: '),
      req.map((r, i) => [i ? ', ' : '', h('a', { href: ctx.route(r), class: isDone(ctx.view(r.id)) ? 'done' : '' }, r.title)])));
  }
  if (mode === 'map') {
    const parts = [w.without ? 'without it' : '', w.alts.length ? 'alternatives' : '', w.pitfalls.length ? 'pitfalls' : ''].filter(Boolean);
    if (parts.length) {
      const body = h('div', { class: 'th-more-body' });
      const more = h('details', { class: 'th-more' }, h('summary', null, `More: ${parts.join(', ')}`), body);
      // the alternatives are measured (a library part's NANDs and depth) only once the fold is opened
      more.addEventListener('toggle', () => {
        if (!more.open || body.childElementCount) return;
        if (w.without) body.append(sec('Without it', rich('p', w.without)));
        if (w.alts.length) {
          body.append(sec('Alternatives', h('div', { class: 'lv-cost' }, w.alts.flatMap((a) => {
            const c = altCost(a);
            const v = [c.nand !== undefined ? `${c.nand.toLocaleString()} NAND` : '', c.depth !== undefined && c.depth !== null ? `depth ${c.depth}` : ''].filter(Boolean).join(' · ') || '—';
            return [h('span', null, a.name), h('span', { class: 'v' }, v)];
          }))));
        }
        if (w.pitfalls.length) body.append(sec('Pitfalls', h('ul', { class: 'th-pits' }, w.pitfalls.map((p) => rich('li', p)))));
      });
      el.append(more);
    }
  } else if (opts.pitfalls && w.pitfalls.length) {
    el.append(h('p', { class: 'th-builds' }, h('button', { class: 'btn sm ghost', onclick: opts.pitfalls }, `Pitfalls (${w.pitfalls.length}) on the Task tab`, icon('chevR', 12))));
  }
  return el;
}

/** The act-end card: what the machine can do now, what it still cannot, and the way on. */
export function actEndEl(act: number, ctx: ThreadCtx, primary = true): HTMLElement | null {
  const e = actEnd(act);
  if (!e) return null;
  const next = actNext(e, ctx.view, ctx.open);
  // the side quests still worth offering (built, not done), in the card's order
  const sides = endLinks(e).filter((l) => l.side && !l.node.soon && !isDone(ctx.view(l.node.id)));
  return h('div', { class: 'th-end', role: 'group', 'aria-label': `${actName(act)} complete` },
    h('div', { class: 'th-eyebrow' }, `${actName(act)} complete · ${actTitle(act)}`),
    h('div', { class: 'th-grid' },
      h('div', { class: 'th-cell can' }, h('h4', null, 'Your machine can now'), rich('p', e.can)),
      h('div', { class: 'th-cell cannot' }, h('h4', null, 'It still can’t'), rich('p', e.cannot))),
    next || sides.length ? h('div', { class: 'th-row' },
      next ? h('a', { class: `btn${primary ? ' primary' : ''}`, href: ctx.route(next) }, e.nextLabel && next.id === e.next ? e.nextLabel : `${actName(next.act)}: ${next.title}`, icon('chevR', 14)) : null,
      sides.map((l) => h('a', { class: 'btn', href: ctx.route(l.node) }, l.label))) : null);
}

/** "Now within reach": the required levels the pass moved forward, and the primary way on (the closest to ready, if open). */
export function reachEl(n: CampaignNode, ctx: ThreadCtx): { el: HTMLElement | null; next?: CampaignNode; side?: CampaignNode } {
  const r = withinReach(n.id, ctx.view);
  const side = sideQuest(n.id, ctx.view);
  const next = r.find((x) => x.missing.length === 0 && ctx.open(x.node))?.node;
  if (!r.length) return { el: null, next, side };
  const meter = (x: (typeof r)[number]) => (x.missing.length === 0 ? 'ready'
    : `${x.done} of ${x.total} done · needs ${x.missing.map((m) => m.title).join(', ')}`);
  const el = h('div', { class: 'th-reach' }, h('h4', null, 'Now within reach'),
    h('ul', null, r.slice(0, 5).map((x) => h('li', { class: x.node === next ? 'top' : '' },
      h('span', null, h('a', { href: ctx.route(x.node) }, x.node.title), h('span', { class: 'th-act' }, actName(x.node.act)), x.clause ? [': ', x.clause] : null),
      h('span', { class: `th-meter${x.missing.length ? '' : ' ready'}` }, meter(x))))));
  return { el, next, side };
}

/** The way on after `n` is done: the next act's level when it closed its act, else the level it moved closest to ready (undefined: the caller's default). */
export function nextAfter(n: CampaignNode, ctx: ThreadCtx): CampaignNode | undefined {
  const end = closedAct(n, ctx.view) !== undefined ? actEnd(n.act) : undefined;
  return (end && actNext(end, ctx.view, ctx.open)) || reachEl(n, ctx).next;
}
