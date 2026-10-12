// The campaign's two drawings: the map (levels by act, edges for requirements, status and stars)
// and the CPU anatomy (blocks lit as they are built). Plain SVG.

import { s } from '../../ui/dom';
import { BLOCKS, blockNodes, LINKS, VIEW } from '../anatomy';
import { ancestors, isDone, statusOf, type ProgressView } from '../graph';
import { BAND_GAP, COL_GAP, mapLayout, NODE_H, NODE_W, ROW_GAP } from '../layout';
import { ACTS } from '../nodes';
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

export function mapSvg(view: ProgressView, unlockAll: boolean, selected: string | undefined, go: (id: string) => void): SVGSVGElement {
  const L = mapLayout();
  const svg = s('svg', { class: 'cp-map', viewBox: `0 0 ${L.w} ${L.h}`, width: L.w, height: L.h, role: 'img', 'aria-label': 'The campaign map' });
  for (const b of L.bands) {
    const act = ACTS.find((a) => a.num === b.act)!;
    svg.append(s('rect', { class: 'cp-band', x: 4, y: b.y, width: L.w - 8, height: b.h, rx: 10 }),
      s('text', { class: 'cp-band-title', x: 16, y: b.y + 21 }, `Act ${act.num} · ${act.title}`));
  }
  // Edges under the nodes: from the right of a requirement to the left of the node. Within an act
  // they are short and always drawn; between acts they cross the whole map, so they appear only for
  // the level pointed at or selected (a port on its left edge says it has some).
  const edges = s('g', { class: 'cp-edges' });
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
      // the node, and a row gap (same act) or the gap above the node's act (another act) between them.
      const xa = x1 + COL_GAP / 2, xb = Math.max(8, x2 - COL_GAP / 2);
      let d: string;
      if (!cross && x2 - x1 <= COL_GAP + 1) d = `M${x1},${y1} C${x1 + 24},${y1} ${x2 - 24},${y2} ${x2},${y2}`;
      else {
        const band = L.bands.find((b) => b.act === p.node.act)!;
        const yc = cross ? band.y - BAND_GAP / 2 : p.y - ROW_GAP / 2;
        d = rounded([[x1, y1], [xa, y1], [xa, yc], [xb, yc], [xb, y2], [x2, y2]]);
      }
      const done = isDone(view(r));
      edges.append(s('path', { class: `cp-edge${done ? ' done' : ''}${p.node.optional ? ' opt' : ''}${cross ? ' cross' : ''}${hot ? ' hot' : ''}`, d, 'data-a': r, 'data-b': p.node.id }));
    }
  }
  svg.append(edges);
  for (const p of L.nodes.values()) {
    const n = p.node;
    const st = statusOf(n, view, unlockAll);
    const stars = view(n.id)?.stars ?? 0;
    const g = s('g', {
      class: `cp-node ${st}${n.optional ? ' opt' : ''}${n.soon ? ' soon' : ''}${n.id === selected ? ' sel' : ''}`,
      transform: `translate(${p.x},${p.y})`, tabindex: 0, role: 'button', 'data-node': n.id,
      'aria-label': `${n.title}: ${n.soon ? 'coming soon' : st}`,
    },
    s('title', null, `${n.title}${n.optional ? ' (optional)' : ''} — ${n.soon ? 'coming soon' : st}`),
    s('rect', { width: NODE_W, height: NODE_H, rx: 8 }),
    s('text', { class: 'cp-node-kind', x: 10, y: 15 }, `${KIND_MARK[n.kind]}${n.optional ? ' · optional' : ''}${n.soon ? ' · soon' : ''}`),
    s('text', { class: 'cp-node-title', x: 10, y: 34 }, n.title),
    st === 'solved' && n.kind !== 'lesson' ? s('text', { class: 'cp-node-stars', x: NODE_W - 8, y: 15, 'text-anchor': 'end' }, '★'.repeat(stars) + '☆'.repeat(3 - stars)) : null,
    st === 'skipped' ? s('text', { class: 'cp-node-skip', x: NODE_W - 8, y: 15, 'text-anchor': 'end' }, 'skipped') : null,
    st === 'locked' ? s('text', { class: 'cp-node-lock', x: NODE_W - 8, y: 15, 'text-anchor': 'end' }, 'locked') : null);
    const from = crossIn.get(n.id);
    if (from) {
      g.append(s('circle', { class: 'cp-port', cx: 0, cy: NODE_H / 2, r: 4 },
        s('title', null, `Builds on ${from.map((m) => `${m.title} (Act ${m.act})`).join(', ')}: point here to see the lines`)));
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
    svg.append(g);
  }
  return svg;
}

/** The anatomy diagram; a click on a block calls `pick`. */
export function anatomySvg(view: ProgressView, selected: string | undefined, pick: (id: string) => void): SVGSVGElement {
  const by = blockNodes();
  const svg = s('svg', { class: 'cp-anatomy', viewBox: `0 0 ${VIEW.w} ${VIEW.h}`, role: 'img', 'aria-label': 'Block diagram of the pipelined RV16 processor' });
  const pos = new Map(BLOCKS.map((b) => [b.id, b]));
  const links = s('g', { class: 'cp-links' });
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
    const g = s('g', { class: `cp-block${b.kind ? ` ${b.kind}` : ''}${built ? ' built' : ''}${b.id === selected ? ' sel' : ''}`, tabindex: 0, role: 'button', 'data-block': b.id },
      s('title', null, `${b.label}${built ? ' (built)' : ''}`),
      s('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: b.kind === 'preg' ? 3 : 7 }),
      b.kind === 'preg'
        ? s('text', { x: b.x + b.w / 2, y: b.y - 5, 'text-anchor': 'middle' }, b.label)
        : s('text', { x: b.x + b.w / 2, y: b.y + b.h / 2 + 4, 'text-anchor': 'middle' }, b.label));
    g.addEventListener('click', () => pick(b.id));
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        pick(b.id);
      }
    });
    svg.append(g);
  }
  return svg;
}
