// An example's gallery thumbnail, DOM-free: its top level drawn from its own document (part boxes at their places, wires as
// their polylines, pins) as a standalone SVG on a dark board that reads in both themes. scripts/example-thumbs.ts writes them
// into public/examples/ at build time, so a thumbnail cannot drift from the circuit it stands for.
import type { Category, ComponentDef } from '../sim/types';
import { type Example, addExample } from './examples';
import { UserLibrary } from './library';
import { type ChipDoc, emptyWorkspace, polyline } from './model';
import { partBox } from './geom';
import { isError, partDef } from './parts';

/** The thumbnail's shape; the gallery's card crops nothing at this ratio. */
export const THUMB_RATIO = 16 / 10;

const HUE: Partial<Record<Category, number>> = { gate: 200, arithmetic: 150, sequential: 30, memory: 280, cpu: 340, routing: 60, plumbing: 100, ttl: 20 };
const r1 = (n: number) => String(Math.round(n * 10) / 10);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

export function chipThumb(doc: ChipDoc, lib: UserLibrary): string {
  const defOf = (p: ChipDoc['parts'][number]): ComponentDef | undefined => {
    const r = partDef(p.ref, (id) => lib.defOf(id));
    return isError(r) ? undefined : r;
  };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (x: number, y: number) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  const boxes: string[] = [], names: string[] = [];
  for (const p of doc.parts) {
    const d = defOf(p);
    const b = partBox(d, p.at, p.flip, p.rot);
    grow(b.x, b.y); grow(b.x + b.w, b.y + b.h);
    const own = d?.symbol.color;
    const hue = own ?? ('chip' in p.ref ? 235 : d ? HUE[d.category] ?? 220 : 220);
    boxes.push(`<rect x="${r1(b.x)}" y="${r1(b.y)}" width="${r1(b.w)}" height="${r1(b.h)}" rx=".6" fill="hsl(${hue} 38% 30%)" stroke="hsl(${hue} 40% 62%)" stroke-width=".25"/>`);
    // a name only where the box can hold it at a size that reads
    const name = p.label ?? p.id;
    if (b.w >= 8 && b.h >= 4) {
      const fs = Math.min(2.2, b.h / 3, (b.w - 1) / Math.max(1, name.length * 0.62));
      if (fs >= 1.1) names.push(`<text x="${r1(b.x + b.w / 2)}" y="${r1(b.y + b.h / 2 + fs * 0.35)}" font-size="${r1(fs)}">${esc(name)}</text>`);
    }
  }
  let wires = '';
  for (const w of doc.wires) {
    const pl = polyline(doc, w, defOf);
    if (!pl) continue;
    wires += `M${pl.map((q) => { grow(q[0], q[1]); return `${r1(q[0])} ${r1(q[1])}`; }).join('L')}`;
  }
  const pins = doc.pins.map((p) => { grow(p.at[0] - 2, p.at[1] - 1); grow(p.at[0] + 2, p.at[1] + 1); return `<circle cx="${r1(p.at[0])}" cy="${r1(p.at[1])}" r=".9"/>`; });
  for (const l of doc.labels) grow(l.at[0], l.at[1]);
  if (!isFinite(x0)) { x0 = y0 = 0; x1 = 16; y1 = 10; }
  // pad, then widen the shorter side so the viewBox has the thumbnail's ratio
  let w = x1 - x0 + 4, h = y1 - y0 + 4;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  if (w / h < THUMB_RATIO) w = h * THUMB_RATIO; else h = w / THUMB_RATIO;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r1(cx - w / 2)} ${r1(cy - h / 2)} ${r1(w)} ${r1(h)}">`
    + `<rect x="${r1(cx - w / 2)}" y="${r1(cy - h / 2)}" width="${r1(w)}" height="${r1(h)}" fill="#1b1f2a"/>`
    + (wires ? `<path d="${wires}" fill="none" stroke="#5fd0b4" stroke-width=".3" stroke-linejoin="round" opacity=".85"/>` : '')
    + boxes.join('')
    + `<g fill="#e8b34a">${pins.join('')}</g>`
    + `<g fill="#dfe4f5" text-anchor="middle" font-family="system-ui,sans-serif">${names.join('')}</g></svg>`;
}

/** The example's thumbnail: added to an empty workspace the way the gallery adds it, then its top level drawn. */
export function exampleThumb(ex: Example): string {
  const { ws, id } = addExample(emptyWorkspace(), ex);
  return chipThumb(ws.chips[id], new UserLibrary(ws));
}
