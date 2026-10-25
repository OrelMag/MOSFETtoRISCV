// The campaign's two drawings: the map (levels by act, edges for requirements, status and stars)
// and the CPU anatomy (blocks lit as they are built). Plain SVG.

import { s } from '../../ui/dom';
import { BLOCKS, blockNodes, LINKS, VIEW } from '../anatomy';
import { ancestors, isDone, statusOf, type ProgressView } from '../graph';
import { BAND_GAP, COL_GAP, FOOT_LABEL_W, mapLayout, NODE_H, NODE_W, OPTIONAL_ACTS, ROW_GAP, SUB_LINE, SUB_Y, LINK_H, LINK_PAD } from '../layout';
import { actDone, actEnd, cardBlock, endLinks } from '../thread';
import { ACTS, actName, NODES } from '../nodes';
import { levelCardLabel } from '../cardlabel';
import type { CampaignNode } from '../types';

const KIND_MARK: Record<CampaignNode['kind'], string> = { lesson: 'read', drill: 'drill', build: 'build', program: 'code', core: 'CPU' };

const anc = new Map<string, Set<string>>();
const ancOf = (id: string) => anc.get(id) ?? anc.set(id, ancestors(id)).get(id)!;

/** A polyline with rounded corners (points on a grid of right angles). */
function rounded(pts: [number, number][], r = 7): string {
  const p = pts.filter((q, i) => i === 0 || q[0] !== pts[i - 1][0] || q[1] !== pts[i - 1][1]);
  let d = `M${p[0][0]},${p[0][1]}`;
  for (let i = 1; i < p.length - 1; i++) {
    const [x0, y0] = p[i - 1], [x1, y1] = p[i], [x2, y2] = p[i + 1];
    const d1 = Math.hypot(x1 - x0, y1 - y0), d2 = Math.hypot(x2 - x1, y2 - y1), k = Math.min(r, d1 / 2, d2 / 2);
    d += ` L${x1 + ((x0 - x1) / d1) * k},${y1 + ((y0 - y1) / d1) * k} Q${x1},${y1} ${x1 + ((x2 - x1) / d2) * k},${y1 + ((y2 - y1) / d2) * k}`;
  }
  const [xe, ye] = p[p.length - 1];
  return `${d} L${xe},${ye}`;
}

/**
 * The requirements a map draws: the direct ones only. A requirement that another requirement
 * already builds on goes without a line (the path through the other shows it); so does the intro,
 * which everything starts from.
 */
export function drawnRequires(n: CampaignNode): string[] {
  return n.requires.filter((r) => r !== 'intro' && !n.requires.some((o) => o !== r && ancOf(o).has(r)));
}

/** `g` made a button: a click, Enter or Space calls `f`. */
function pressable<T extends SVGElement>(g: T, f: () => void): T {
  g.addEventListener('click', f);
  g.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      f();
    }
  });
  return g;
}

/**
 * The map, its acts wrapped to at most `maxCols` columns a line (layout.ts mapColsFor). The optional
 * acts in `folded` are a header (title, what it holds, Show); `fold` folds or unfolds one.
 * For assistive tech it is a group of acts, each a group holding its Show / Hide button and its level
 * cards (buttons named by levelCardLabel), in that order: Tab walks the map act by act, column by column.
 */
export function mapSvg(view: ProgressView, unlockAll: boolean, selected: string | undefined, go: (id: string) => void, maxCols = Infinity,
  folded: ReadonlySet<number> = new Set(), fold?: (act: number, folded: boolean) => void): SVGSVGElement {
  // Each act's blurb under its title; a finished act's end card at its foot.
  const ended = new Set(ACTS.map((a) => a.num).filter((a) => actEnd(a) && actDone(a, view)));
  const endOf = (a: number) => {
    const e = actEnd(a);
    return e && { can: e.can, cannot: e.cannot, links: endLinks(e).map((l) => l.label) };
  };
  const L = mapLayout(maxCols, folded, { blurb: (a) => ACTS.find((x) => x.num === a)?.blurb, end: endOf }, ended);
  const svg = s('svg', { class: 'cp-map', viewBox: `0 0 ${L.w} ${L.h}`, width: L.w, height: L.h, role: 'group', 'aria-label': 'The campaign map' });
  // Painted bottom up: the bands, the edges, then each act's title, buttons and cards (the edges run under the cards).
  const bands = s('g', { class: 'cp-bands', 'aria-hidden': 'true' });
  const edges = s('g', { class: 'cp-edges', 'aria-hidden': 'true' });
  svg.append(bands, edges);
  const actGroups = new Map<number, SVGGElement>();
  for (const b of L.bands) {
    const act = ACTS.find((a) => a.num === b.act)!;
    const name = `${actName(act.num)} · ${act.title}`;
    const ag = s('g', { class: 'cp-act', role: 'group', 'aria-label': name });
    svg.append(ag);
    if (b.folded) {
      const ns = NODES.filter((n) => n.act === act.num);
      const done = ns.filter((n) => isDone(view(n.id))).length;
      const open = ns.filter((n) => !n.soon && ['available', 'started'].includes(statusOf(n, view, unlockAll))).length;
      const what = `Optional · ${ns.length} levels${done ? ` · ${done} done` : ''}${open ? ` · ${open} open` : ''}`;
      const g = s('g', { class: 'cp-fold folded', 'data-act': act.num, tabindex: 0, role: 'button', 'aria-expanded': 'false', 'aria-label': `${name}: ${what}. Show its levels` },
        s('title', null, 'Show this act\'s levels'),
        s('rect', { class: 'cp-band', x: 4, y: b.y, width: L.w - 8, height: b.h, rx: 10 }),
        s('text', { class: 'cp-band-title', x: 16, y: b.y + 21 }, name),
        s('text', { class: 'cp-fold-what', x: 16, y: b.y + 40 }, what),
        s('text', { class: 'cp-fold-btn', x: L.w - 16, y: b.y + 40, 'text-anchor': 'end' }, 'Show ▾'));
      ag.append(fold ? pressable(g, () => fold(act.num, false)) : g);
      continue;
    }
    actGroups.set(act.num, ag);
    bands.append(s('rect', { class: 'cp-band', x: 4, y: b.y, width: L.w - 8, height: b.h, rx: 10 }));
    // the group is named after the act: its title would be read twice
    ag.append(s('text', { class: 'cp-band-title', x: 16, y: b.y + 21, 'aria-hidden': 'true' }, name));
    for (const r of b.rows ?? []) ag.append(s('text', { class: 'cp-row-title', x: 16, y: r.y, 'aria-hidden': 'true' }, r.label));
    if (b.sub) {
      // the whole blurb for assistive tech and as a tooltip; the drawing may cut it short
      ag.append(s('text', { class: 'cp-band-sub', x: 16, y: b.y + SUB_Y, role: 'note', 'aria-label': act.blurb.replace(/<[^>]+>/g, '') },
        s('title', null, act.blurb.replace(/<[^>]+>/g, '')),
        ...b.sub.map((line, i) => s('tspan', { x: 16, dy: i ? SUB_LINE : 0, 'aria-hidden': 'true' }, line))));
    }
    const end = b.foot ? actEnd(act.num) : undefined;
    if (b.foot && end) {
      const f = b.foot, tx = 16 + FOOT_LABEL_W;
      const half = (label: string, lines: string[], y0: number, cls: string) => [
        s('text', { class: `cp-foot-k ${cls}`, x: 16, y: y0 }, label),
        s('text', { class: 'cp-foot-t', x: tx, y: y0 }, ...lines.map((line, i) => s('tspan', { x: tx, dy: i ? SUB_LINE : 0 }, line))),
      ];
      const plain = (t: string) => t.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      ag.append(s('g', { class: 'cp-foot', role: 'note', 'aria-label': `${actName(act.num)} complete. Can now: ${plain(end.can)} Still can't: ${plain(end.cannot)}` },
        s('title', null, `Can now: ${plain(end.can)}\nStill can’t: ${plain(end.cannot)}`),
        s('line', { class: 'cp-foot-rule', x1: 16, x2: L.w - 16, y1: f.y - 28, y2: f.y - 28 }),
        s('text', { class: 'cp-foot-head', x: 16, y: f.y - 14 }, `✓ ${actName(act.num)} complete`),
        ...half('Can now', f.can, f.y, 'can'),
        ...half('Still can’t', f.cannot, f.y + f.can.length * SUB_LINE, 'cannot')));
      // the ways on: the next act, the side quests (buttons, after the note they follow)
      endLinks(end).forEach((l, i) => {
        const p = f.links[i];
        if (!p) return;
        ag.append(pressable(s('g', { class: `cp-foot-link${l.side ? ' side' : ''}`, tabindex: 0, role: 'button', 'data-to': l.node.id, 'aria-label': l.label },
          s('title', null, `${l.node.title} (${actName(l.node.act)})`),
          s('rect', { x: p.x, y: p.y - LINK_H + 6, width: p.w, height: LINK_H, rx: LINK_H / 2 }),
          s('text', { x: p.x + LINK_PAD, y: p.y }, l.label)), () => go(l.node.id)));
      });
    }
    if (fold && OPTIONAL_ACTS.has(act.num)) {
      ag.append(pressable(s('g', { class: 'cp-fold', 'data-act': act.num, tabindex: 0, role: 'button', 'aria-expanded': 'true', 'aria-label': `Fold ${name}` },
        s('title', null, 'Fold this optional act to one line'),
        s('rect', { class: 'cp-fold-hit', x: L.w - 72, y: b.y + 6, width: 60, height: 22, rx: 6 }),
        s('text', { class: 'cp-fold-btn', x: L.w - 18, y: b.y + 21, 'text-anchor': 'end' }, 'Hide ▴')), () => fold(act.num, true)));
    }
  }
  // Edges under the nodes: from the right of a requirement to the left of the node. Within an act
  // they are short and always drawn; between acts they cross the whole map, so they appear only for
  // the level pointed at or selected (a port on its left edge says it has some).
  const crossIn = new Map<string, CampaignNode[]>();
  for (const p of L.nodes.values()) {
    for (const r of drawnRequires(p.node)) {
      const q = L.nodes.get(r);
      if (!q) continue;
      const cross = q.node.act !== p.node.act;
      if (cross) crossIn.set(p.node.id, [...(crossIn.get(p.node.id) ?? []), q.node]);
      const hot = selected !== undefined && (r === selected || p.node.id === selected);
      const x1 = q.x + NODE_W, y1 = q.y + NODE_H / 2, x2 = p.x, y2 = p.y + NODE_H / 2;
      // The gaps between boxes are the channels: the column gap after the requirement, the one before
      // the node, and a row gap (same act) or the gap above the node's act (another act) between them. An edge onto
      // the act's next line runs down the channel after the requirement and back left along the gap above that line.
      const xa = x1 + COL_GAP / 2, xb = Math.max(8, x2 - COL_GAP / 2);
      let d: string;
      if (!cross && q.line === p.line && x2 - x1 <= COL_GAP + 1) d = `M${x1},${y1} C${x1 + 24},${y1} ${x2 - 24},${y2} ${x2},${y2}`;
      else {
        const band = L.bands.find((b) => b.act === p.node.act)!;
        const yc = cross ? band.y - BAND_GAP / 2 : q.line !== p.line ? p.chanY : p.y - ROW_GAP / 2;
        d = rounded([[x1, y1], [xa, y1], [xa, yc], [xb, yc], [xb, y2], [x2, y2]]);
      }
      const done = isDone(view(r));
      edges.append(s('path', { class: `cp-edge${done ? ' done' : ''}${p.node.optional ? ' opt' : ''}${cross ? ' cross' : ''}${hot ? ' hot' : ''}`, d, 'data-a': r, 'data-b': p.node.id }));
    }
  }
  for (const p of L.nodes.values()) {
    const n = p.node;
    const st = statusOf(n, view, unlockAll);
    const stars = view(n.id)?.stars ?? 0;
    // A locked level opens too (its panel says what it needs), so it is a working button that says "locked", not a disabled one.
    const blk = cardBlock(n);
    const label = `${levelCardLabel(n, st, stars)}${blk ? (blk.all ? ', used in every block' : `, part of the ${blk.label} block`) : ''}`;
    const g = s('g', {
      class: `cp-node ${st}${n.optional ? ' opt' : ''}${n.soon ? ' soon' : ''}${n.id === selected ? ' sel' : ''}`,
      transform: `translate(${p.x},${p.y})`, tabindex: 0, role: 'button', 'data-node': n.id,
      'aria-label': label, 'aria-current': n.id === selected ? 'true' : null,
    },
    s('title', null, label),
    s('rect', { class: 'cp-card', width: NODE_W, height: NODE_H, rx: 8 }),
    s('text', { class: 'cp-node-kind', x: 10, y: 15 }, `${KIND_MARK[n.kind]}${n.optional ? ' · optional' : ''}${n.soon ? ' · soon' : ''}`),
    s('text', { class: 'cp-node-title', x: 10, y: 34 }, n.title),
    st === 'solved' && n.kind !== 'lesson' ? s('text', { class: 'cp-node-stars', x: NODE_W - 8, y: 15, 'text-anchor': 'end' }, '★'.repeat(stars) + '☆'.repeat(3 - stars)) : null,
    st === 'skipped' ? s('text', { class: 'cp-node-skip', x: NODE_W - 8, y: 15, 'text-anchor': 'end' }, 'skipped') : null,
    st === 'locked' ? s('text', { class: 'cp-node-lock', x: NODE_W - 8, y: 15, 'text-anchor': 'end' }, 'locked') : null);
    if (blk) {
      // the block it ends up in, as a tab on the card's bottom edge (lit while the card is pointed at)
      const w = 16 + blk.label.length * 5.6;
      g.append(s('g', { class: `cp-blk${blk.all ? ' all' : ''}`, transform: `translate(${NODE_W - 10 - w},${NODE_H - 6})`, 'aria-hidden': 'true' },
        s('rect', { width: w, height: 12, rx: 6 }),
        s('circle', { cx: 7, cy: 6, r: 2.5 }),
        s('text', { x: 12, y: 9 }, blk.label)));
    }
    const from = crossIn.get(n.id);
    if (from) {
      g.append(s('circle', { class: 'cp-port', cx: 0, cy: NODE_H / 2, r: 4, 'aria-hidden': 'true' },
        s('title', null, `Builds on ${from.map((m) => `${m.title} (${actName(m.act)})`).join(', ')}: point here to see the lines`)));
    }
    const hover = (on: boolean) => edges.querySelectorAll(`[data-a="${n.id}"], [data-b="${n.id}"]`).forEach((e) => e.classList.toggle('hover', on));
    g.addEventListener('mouseenter', () => hover(true));
    g.addEventListener('mouseleave', () => hover(false));
    g.addEventListener('focus', () => hover(true));
    g.addEventListener('blur', () => hover(false));
    g.addEventListener('click', () => go(n.id));
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        go(n.id);
      }
    });
    // the focus ring: outside the card, so it shows on a selected card (accent border) and a locked one (faded)
    g.append(s('rect', { class: 'cp-focus', x: -4, y: -4, width: NODE_W + 8, height: NODE_H + 8, rx: 11 }));
    actGroups.get(n.act)!.append(g);
  }
  return svg;
}

/** The anatomy diagram; a click on a block calls `pick`. Without `pick` it is a picture (the level panel's, inside a link). */
export function anatomySvg(view: ProgressView, selected: string | ReadonlySet<string> | undefined, pick?: (id: string) => void): SVGSVGElement {
  const isSel = (id: string) => (typeof selected === 'string' ? id === selected : !!selected?.has(id));
  const by = blockNodes();
  const svg = s('svg', { class: 'cp-anatomy', viewBox: `0 0 ${VIEW.w} ${VIEW.h}`, role: pick ? 'group' : 'img', 'aria-label': 'Block diagram of the pipelined RV16 processor' });
  const pos = new Map(BLOCKS.map((b) => [b.id, b]));
  const links = s('g', { class: 'cp-links', 'aria-hidden': 'true' });
  let backs = 0;
  for (const l of LINKS) {
    const a = pos.get(l.from)!, b = pos.get(l.to)!;
    let d: string;
    if (l.back) {
      // Under everything: down from the source, along the bottom, up beside the target, into its left side.
      const yb = VIEW.h - 10 - 10 * backs++;
      const x1 = a.x + a.w / 2, xu = b.x - 6, yi = b.y + b.h - 16;
      d = `M${x1},${a.y + a.h} V${yb} H${xu} V${yi} H${b.x}`;
    } else {
      const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x;
      const y2 = Math.max(b.y + 6, Math.min(b.y + b.h - 6, y1));
      const xm = (x1 + x2) / 2;
      d = x2 > x1 ? `M${x1},${y1} H${xm} V${y2} H${x2}` : `M${a.x + a.w / 2},${a.y} V${b.y + b.h}`;
    }
    links.append(s('path', { d, class: l.back ? 'back' : '' }));
  }
  svg.append(links);
  for (const b of BLOCKS) {
    const ids = by.get(b.id) ?? [];
    const built = ids.length > 0 && ids.every((id) => isDone(view(id)));
    const g = s('g', { class: `cp-block${b.kind ? ` ${b.kind}` : ''}${built ? ' built' : ''}${isSel(b.id) ? ' sel' : ''}`, 'data-block': b.id },
      s('title', null, `${b.label}${built ? ' (built)' : ''}`),
      s('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: b.kind === 'preg' ? 3 : 7 }),
      b.kind === 'preg'
        ? s('text', { x: b.x + b.w / 2, y: b.y - 5, 'text-anchor': 'middle' }, b.label)
        : s('text', { x: b.x + b.w / 2, y: b.y + b.h / 2 + 4, 'text-anchor': 'middle' }, b.label));
    if (pick) {
      g.setAttribute('tabindex', '0');
      g.setAttribute('role', 'button');
      g.setAttribute('aria-label', `${b.label}${built ? ', built' : ''}`);
      if (isSel(b.id)) g.setAttribute('aria-current', 'true');
      pressable(g, () => pick(b.id));
    }
    svg.append(g);
  }
  return svg;
}
