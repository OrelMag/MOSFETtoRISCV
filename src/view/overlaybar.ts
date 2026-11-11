// The overlay bar's controls, shared by the stage's bar and the sandbox's run row: a segmented group of the
// overlays (a click on the pressed one turns it off), the same as one select on a phone (CSS swaps them), and the legend
// drawn from an OverlayResult. The state lives with the host; O / Shift O go through nextOverlay.

import { h, s as svgEl } from '../ui/dom';
import { settings } from '../ui/settings';
import { OVERLAY_KINDS, OVERLAY_LABEL, OVERLAY_TITLE, type OverlayKind, type OverlayResult } from './overlays';

/** Each overlay's glyph (24-unit strokes, like ui/dom.ts icons; kept here, off the first page's code). */
const GLYPH: Record<OverlayKind, string[]> = {
  slack: ['M12 7v5l3 2', 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z'],
  activity: ['M2 12h3l2-6 4 12 4-12 4 12 2-6h1'],
  load: ['M3 12h6', 'M9 12l11-7M9 12h11M9 12l11 7'],
  unknown: ['M6 6l12 12M18 6L6 18'],
  cost: ['M12 3v18', 'M17 7H9.5a2.5 2.5 0 0 0 0 5h5a2.5 2.5 0 0 1 0 5H7'],
  energy: ['M13 2L4 14h7l-1 8 9-12h-7l1-8z'],
  depth: ['M4 4v16h16', 'M8 16h3v-4h3V8h3'],
};
const glyph = (k: OverlayKind) => svgEl('svg', { class: 'icon ov-ic', viewBox: '0 0 24 24', width: 14, height: 14, 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
  ...GLYPH[k].map((d) => svgEl('path', { d })));

export class OverlayBar {
  readonly el: HTMLElement;
  private btns = new Map<OverlayKind, HTMLButtonElement>();
  private sel: HTMLSelectElement;
  private kind: OverlayKind | null = null;

  constructor(private pick: (k: OverlayKind | null) => void) {
    const seg = h('div', { class: 'seg ov-seg', role: 'group', 'aria-label': 'Overlay (O cycles, Shift O turns it off)' });
    for (const k of OVERLAY_KINDS) {
      const b = h('button', { class: 'ov-btn', 'data-k': k, 'aria-pressed': 'false', onclick: (e: Event) => {
        e.stopPropagation();
        this.pick(this.kind === k ? null : k);
      }, 'aria-label': OVERLAY_LABEL[k] }, glyph(k), h('span', { class: 'lbl' }, OVERLAY_LABEL[k])) as HTMLButtonElement;
      this.btns.set(k, b);
      seg.append(b);
    }
    this.sel = h('select', { class: 'ov-sel', 'aria-label': 'Overlay', title: 'Overlay: one quantity over the whole circuit (O cycles, Shift O turns it off)' },
      h('option', { value: '' }, 'Overlay: off'), OVERLAY_KINDS.map((k) => h('option', { value: k }, `Overlay: ${OVERLAY_LABEL[k]}`))) as HTMLSelectElement;
    this.sel.addEventListener('change', () => this.pick((this.sel.value || null) as OverlayKind | null));
    this.el = h('div', { class: 'ov-bar' }, seg, this.sel);
    this.set(null, {});
  }

  /** Show `kind` as on, and each overlay that cannot be shown here disabled with its reason. */
  set(kind: OverlayKind | null, refusals: Partial<Record<OverlayKind, string>>): void {
    this.kind = kind;
    for (const [k, b] of this.btns) {
      const why = refusals[k] ?? '';
      b.setAttribute('aria-pressed', String(k === kind));
      b.classList.toggle('on', k === kind);
      b.disabled = !!why && k !== kind;
      b.title = why ? `${OVERLAY_LABEL[k]}: ${why}` : `${OVERLAY_TITLE[k]}${k === kind ? '. Click again to turn it off' : ''} (O cycles, Shift O: off)`;
    }
    this.sel.value = kind ?? '';
    for (const o of this.sel.options) if (o.value) o.disabled = !!refusals[o.value as OverlayKind] && o.value !== kind;
  }
}

/** The overlay after `cur` that applies here (O), or none (Shift O). From off, the last one used. */
export function nextOverlay(cur: OverlayKind | null, refusals: Partial<Record<OverlayKind, string>>, off: boolean): OverlayKind | null {
  if (off) return null;
  const ok = OVERLAY_KINDS.filter((k) => !refusals[k]);
  if (!ok.length) return null;
  if (cur === null) {
    const last = settings.overlay as OverlayKind;
    return ok.includes(last) ? last : ok[0];
  }
  const i = OVERLAY_KINDS.indexOf(cur);
  for (let j = 1; j <= OVERLAY_KINDS.length; j++) {
    const k = OVERLAY_KINDS[(i + j) % OVERLAY_KINDS.length];
    if (ok.includes(k)) return k;
  }
  return null;
}

/** The legend: the bands with their text values and counts, what is measured, and a button that turns it off. */
export function overlayLegend(r: OverlayResult, close: () => void): HTMLElement {
  const L = r.legend;
  // on a phone the note is folded away (app.css) and a tap on the legend unfolds it: there is no tooltip to read it in
  return h('div', { class: 'ov-legend', role: 'region', 'aria-label': `${L.title} overlay legend`, title: `${L.rows.map((r) => `${r.label}: ${r.count}`).join(' · ')}. ${L.note}`,
    onclick: (e: Event) => (e.currentTarget as HTMLElement).classList.toggle('open') },
    h('div', { class: 'ov-lh' }, h('b', null, L.title), h('small', null, L.unit),
      h('button', { class: 'ov-x', title: 'Turn the overlay off (Shift O)', 'aria-label': 'Turn the overlay off', onclick: (e: Event) => { e.stopPropagation(); close(); } }, '×')),
    h('ul', { class: 'ov-rows' }, L.rows.map((row) => h('li', null,
      h('i', { class: `ov-sw${row.band === 'src' ? ' src' : ''}`, 'data-ov': row.band === 'src' ? 'x' : String(row.band) }),
      h('b', null, row.label), h('span', null, row.count)))),
    h('p', { class: 'ov-note' }, L.note));
}
