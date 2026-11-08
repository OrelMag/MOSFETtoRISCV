// The divider between a chapter's text and its stage: drag it, or focus it and use the arrow keys, to give the prose more
// (or less) room. A WAI-ARIA window splitter (role="separator", aria-valuenow in px). The width is remembered across visits
// and chapters (one number); a double-click lets go of it, and the column goes back to growing with the window (app.css
// --narr-auto). It never takes the room the stage and the inspector keep (--narr-room), and does not exist below 1181 px,
// where the page has its own narrower layout.

import { h } from './dom';

const KEY = 'mosfet2riscv:proseW';
const HARD_MAX = 760;
const STEP = 16;

const load = (): number | null => {
  try {
    const v = Number(localStorage.getItem(KEY));
    return Number.isFinite(v) && v >= 200 && v <= 2000 ? v : null;
  } catch {
    return null;
  }
};
const save = (w: number | null): void => {
  try {
    if (w === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(Math.round(w)));
  } catch { /* private window: this visit only */ }
};

/** Add the divider to `narrative` (inside `layout`). Returns the cleanup. */
export function installSplitter(layout: HTMLElement, narrative: HTMLElement): () => void {
  const el = h('div', {
    class: 'narr-split', role: 'separator', 'aria-orientation': 'vertical', tabindex: '0',
    'aria-label': 'Resize the text and circuit panes',
    title: 'Drag to resize the text. Arrow keys when focused, Home / End for the extremes, double-click to reset',
  });
  narrative.append(el);

  const cs = () => getComputedStyle(layout);
  const scale = (): number => parseFloat(cs().getPropertyValue('--prose-scale')) || 1;
  const lo = (): number => 300 * scale();
  const hi = (): number => {
    const room = parseFloat(cs().getPropertyValue('--narr-room')) || 880;
    return Math.max(lo(), Math.min(HARD_MAX, layout.clientWidth - room));
  };
  const clamp = (w: number): number => Math.max(lo(), Math.min(hi(), w));
  const width = (): number => narrative.getBoundingClientRect().width;

  const sync = (): void => {
    el.setAttribute('aria-valuemin', String(Math.round(lo())));
    el.setAttribute('aria-valuemax', String(Math.round(hi())));
    el.setAttribute('aria-valuenow', String(Math.round(width())));
  };
  const apply = (w: number | null): void => {
    if (w === null) {
      layout.classList.remove('sized');
      layout.style.removeProperty('--narr-w');
    } else {
      layout.style.setProperty('--narr-w', `${Math.round(w)}px`);
      layout.classList.add('sized');
    }
    sync();
  };
  const set = (w: number): void => {
    apply(clamp(w));
    save(clamp(w));
  };

  const saved = load();
  if (saved !== null) apply(saved);

  let raf = 0;
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(sync);
  });
  ro.observe(layout);
  ro.observe(narrative);
  requestAnimationFrame(sync);

  el.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const step = e.shiftKey ? STEP * 4 : STEP;
    if (e.key === 'ArrowLeft') set(width() - step);
    else if (e.key === 'ArrowRight') set(width() + step);
    else if (e.key === 'Home') set(lo());
    else if (e.key === 'End') set(hi());
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  el.addEventListener('dblclick', () => {
    apply(null);
    save(null);
  });

  let drag = false;
  let pending = 0;
  let dragRaf = 0;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = true;
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const x = e.clientX - layout.getBoundingClientRect().left;
    pending = clamp(x);
    // one layout per frame: a big scene refits its view on every change of the stage's size
    if (!dragRaf) dragRaf = requestAnimationFrame(() => {
      dragRaf = 0;
      apply(pending);
    });
  });
  const end = (e: PointerEvent): void => {
    if (!drag) return;
    drag = false;
    el.classList.remove('dragging');
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    if (pending) set(pending);
    pending = 0;
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);

  return () => {
    cancelAnimationFrame(raf);
    cancelAnimationFrame(dragRaf);
    ro.disconnect();
    el.remove();
  };
}
