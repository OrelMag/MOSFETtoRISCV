// The campaign's two drawings: the map (levels by act, edges for requirements, status and stars)
// and the CPU anatomy (blocks lit as they are built). Plain SVG.

import { s } from '../../ui/dom';
import { BLOCKS, blockNodes, LINKS, VIEW } from '../anatomy';
import { isDone, statusOf, type ProgressView } from '../graph';
import { mapLayout, NODE_H, NODE_W } from '../layout';
import { ACTS } from '../nodes';
import type { CampaignNode } from '../types';

const KIND_MARK: Record<CampaignNode['kind'], string> = { lesson: 'read', drill: 'drill', build: 'build', program: 'code', core: 'CPU' };

export function mapSvg(view: ProgressView, unlockAll: boolean, selected: string | undefined, go: (id: string) => void): SVGSVGElement {
  const L = mapLayout();
  const svg = s('svg', { class: 'cp-map', viewBox: `0 0 ${L.w} ${L.h}`, width: L.w, height: L.h, role: 'img', 'aria-label': 'The campaign map' });
  for (const b of L.bands) {
    const act = ACTS.find((a) => a.num === b.act)!;
    svg.append(s('rect', { class: 'cp-band', x: 4, y: b.y, width: L.w - 8, height: b.h, rx: 10 }),
      s('text', { class: 'cp-band-title', x: 16, y: b.y + 21 }, `Act ${act.num} · ${act.title}`));
  }
  // Edges under the nodes: from the right of a requirement to the left of the node.
  const edges = s('g', { class: 'cp-edges' });
  for (const p of L.nodes.values()) {
    for (const r of p.node.requires) {
      const q = L.nodes.get(r);
      // Everything starts at the intro: its edges would only add clutter.
      if (!q || r === 'intro') continue;
      const cross = q.node.act !== p.node.act;
      const hot = selected !== undefined && (r === selected || p.node.id === selected);
      const x1 = q.x + NODE_W, y1 = q.y + NODE_H / 2, x2 = p.x, y2 = p.y + NODE_H / 2;
      const d = x2 > x1 + 8
        ? `M${x1},${y1} C${x1 + 24},${y1} ${x2 - 24},${y2} ${x2},${y2}`
        // Backwards (a requirement in a later column of an earlier act): down from its bottom edge.
        : `M${q.x + NODE_W / 2},${q.y + NODE_H} C${q.x + NODE_W / 2},${q.y + NODE_H + 40} ${x2 - 30},${y2} ${x2},${y2}`;
      const done = isDone(view(r));
      edges.append(s('path', { class: `cp-edge${done ? ' done' : ''}${p.node.optional ? ' opt' : ''}${cross ? ' cross' : ''}${hot ? ' hot' : ''}`, d }));
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
