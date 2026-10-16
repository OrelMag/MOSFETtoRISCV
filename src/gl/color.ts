// Scene colours come from the site's CSS custom properties, so a 3D view follows the theme like every SVG does.
// A token may be any CSS colour (light-dark(), color-mix(), var()); the browser resolves it on a probe element.

import type { RGB, RGBA } from './instances';

/** A computed CSS colour as sRGB 0..1: #hex, rgb() / rgba() (comma or space syntax), color(srgb …). */
export function parseCssColor(s: string): RGBA | null {
  s = s.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
    return [n(0), n(2), n(4), h.length === 8 ? n(6) : 1];
  }
  const fn = /^(rgba?|color)\((.*)\)$/.exec(s);
  if (!fn) return null;
  let body = fn[2].trim();
  if (fn[1] === 'color') {
    if (!body.startsWith('srgb ')) return null;
    body = body.slice(5);
  }
  const parts = body.split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const num = (p: string, scale: number) => (p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p) / scale);
  const rgbScale = fn[1] === 'color' ? 1 : 255;
  const out: RGBA = [num(parts[0], rgbScale), num(parts[1], rgbScale), num(parts[2], rgbScale), parts[3] === undefined ? 1 : num(parts[3], 1)];
  return out.every((v) => Number.isFinite(v)) ? out : null;
}

/** Resolves colour tokens in the context of `host` (so tokens scoped to a widget class apply). */
export class CssColors {
  private readonly probe: HTMLElement;
  private readonly cache = new Map<string, RGBA>();

  constructor(host: HTMLElement) {
    this.probe = document.createElement('span');
    this.probe.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none';
    this.probe.setAttribute('aria-hidden', 'true');
    host.append(this.probe);
  }

  /** A token such as '--steel' (or any CSS colour); grey when it does not resolve. */
  rgba(token: string): RGBA {
    let c = this.cache.get(token);
    if (!c) {
      this.probe.style.color = '';
      this.probe.style.color = token.startsWith('--') ? `var(${token})` : token;
      c = parseCssColor(getComputedStyle(this.probe).color) ?? [0.5, 0.5, 0.5, 1];
      this.cache.set(token, c);
    }
    return c;
  }

  rgb(token: string): RGB { const [r, g, b] = this.rgba(token); return [r, g, b]; }

  /** Forget resolved colours (after a theme change). */
  invalidate(): void { this.cache.clear(); }

  destroy(): void { this.probe.remove(); }
}

/** Calls `cb` when the site's theme changes: data-theme / look attributes on <html>, or the OS colour scheme. */
export function watchTheme(cb: () => void): () => void {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-look', 'data-board', 'data-palette'] });
  const mq = matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', cb);
  return () => { mo.disconnect(); mq.removeEventListener('change', cb); };
}

export const mixRgb = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const scaleRgb = (a: RGB, k: number): RGB => [a[0] * k, a[1] * k, a[2] * k];
