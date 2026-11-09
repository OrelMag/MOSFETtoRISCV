// Boxes that keep the room they have needed: a line whose text changes as a run goes (a CPU panel's status: stall, miss
// and halt messages come and go every few cycles) never gets shorter again, so a change in how many lines it wraps to no
// longer moves the panels below it. Off the first-load path (ui/dom.ts stays small).

/** `el` keeps the tallest height it has had (min-height, border box); returns `el`. */
export function holdHeight<T extends HTMLElement>(el: T): T {
  if (typeof ResizeObserver !== 'function') return el;
  let max = 0;
  new ResizeObserver((es) => {
    const hgt = Math.ceil(es[0]?.borderBoxSize?.[0]?.blockSize ?? el.offsetHeight);
    if (hgt <= max) return;
    max = hgt;
    el.style.boxSizing = 'border-box';
    el.style.minHeight = `${hgt}px`;
  }).observe(el);
  return el;
}
