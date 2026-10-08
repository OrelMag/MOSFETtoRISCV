// A drawn circuit as a standalone image: the sandbox's canvas (editor/fileui.ts) or the level on
// a chapter's or the workbench's stage (exportSchematic, loaded on demand). The SVG is styled by the site's CSS (custom
// properties that change with the theme and the wire palette), which a file opened elsewhere
// does not have: every element's computed style is copied inline, so the image looks exactly
// like the screen in the current theme. PNG draws that SVG on a canvas at 2× scale.

import { fileBase } from '../editor/files';
import { h } from '../ui/dom';
import type { ViewBox } from './camera';
import type { SchematicView } from './schematic';

/** Presentation properties the editor's CSS sets (computed values are already resolved). */
const PROPS = [
  'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin',
  'opacity', 'display', 'visibility', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor',
  'dominant-baseline', 'paint-order', 'letter-spacing', 'white-space',
];

/** Layers that are editing feedback, not the circuit (hit areas, previews, the grid, probe flags). */
const DROP = '.wire-hits, .ed-over, .grid-bg, .probes, defs';

/** Grid units → output pixels (1 unit = 10 px, like the schematics). */
const UNIT = 10;

export function svgImage(svg: SVGSVGElement, box: ViewBox, background: string): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  // Walk the original and the clone together (same structure) before anything is removed.
  const src = [svg, ...svg.querySelectorAll('*')];
  const dst = [clone, ...clone.querySelectorAll('*')];
  src.forEach((el, i) => {
    const cs = getComputedStyle(el);
    const d = dst[i] as SVGElement;
    if (cs.display === 'none') return void d.setAttribute('data-drop', '');
    d.setAttribute('style', PROPS.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(';'));
  });
  for (const el of clone.querySelectorAll(`${DROP}, [data-drop]`)) el.remove();
  for (const el of clone.querySelectorAll('[class]')) el.removeAttribute('class');
  clone.removeAttribute('class');
  clone.removeAttribute('role');
  clone.removeAttribute('tabindex');
  clone.removeAttribute('aria-label');
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('viewBox', `${box.x} ${box.y} ${box.w} ${box.h}`);
  clone.setAttribute('width', String(Math.round(box.w * UNIT)));
  clone.setAttribute('height', String(Math.round(box.h * UNIT)));
  clone.setAttribute('style', `background:${background}`);
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  for (const [k, v] of Object.entries({ x: box.x, y: box.y, width: box.w, height: box.h, fill: background })) bg.setAttribute(k, String(v));
  clone.insertBefore(bg, clone.firstChild);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}\n`;
}

/** The SVG text rasterized (scale × its own size), as a PNG blob. */
export async function pngImage(svgText: string, scale = 2): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.decoding = 'sync';
    await new Promise<void>((ok, fail) => {
      img.onload = () => ok();
      img.onerror = () => fail(new Error('the image could not be drawn'));
      img.src = url;
    });
    // Browsers cap canvas area (about 16k × 16k in Chrome): shrink a huge circuit to fit.
    const max = 16000;
    const k = Math.min(scale, max / img.naturalWidth, max / img.naturalHeight);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * k));
    c.height = Math.max(1, Math.round(img.naturalHeight * k));
    const g = c.getContext('2d');
    if (!g) throw new Error('no 2D canvas');
    g.drawImage(img, 0, 0, c.width, c.height);
    return await new Promise<Blob>((ok, fail) => c.toBlob((b) => (b ? ok(b) : fail(new Error('PNG encoding failed'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Download `data` as a file named `name`. */
export function saveFile(name: string, data: string | Blob, type = 'application/json'): void {
  const blob = typeof data === 'string' ? new Blob([data], { type }) : data;
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/** The first opaque background at or above `el` (the canvas itself is transparent). */
function backgroundOf(el: Element | null): string {
  for (; el; el = el.parentElement) {
    const c = getComputedStyle(el).backgroundColor;
    if (c && c !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(c)) return c;
  }
  return 'white';
}

/** The level a stage shows, whole (not just the part in view), as an SVG or PNG download. */
export async function exportSchematic(view: SchematicView, name: string, kind: 'svg' | 'png'): Promise<void> {
  const text = svgImage(view.el, view.contentBox(), backgroundOf(view.el));
  const base = fileBase(name, 'circuit');
  if (kind === 'svg') saveFile(`${base}.svg`, text, 'image/svg+xml');
  else saveFile(`${base}.png`, await pngImage(text));
}
