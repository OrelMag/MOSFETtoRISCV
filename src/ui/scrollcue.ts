// An edge fade on a horizontally scrollable box while more lies past that edge: a wide table in a phone's column only
// clipped, with a scrollbar nobody sees. `trackScrollCue(root)` marks every box under `root` that matches SCROLL_BOXES
// (also those added later: widgets build lazily) with data-more="r" | "l" | "lr", which app.css turns into a mask.

/** The chapter widgets' scroll wrappers (a table, a strip, a grid wider than a phone). */
const SCROLL_BOXES = [
  '.dsp-scroll', '.ff-scroll', '.lay-scroll', '.tech-scroll', '.cl-scroll', '.ctl-scroll', '.eth-scroll', '.fe-scroll', '.in-scroll',
  '.ln-scroll', '.ns-scroll', '.lab-scroll', '.pc-scroll', '.se-scroll', '.spi-scroll', '.usb-scroll', '.wf-scroll', '.why-table',
  '.isd-scroll', '.cmp-scroll', '.ec-tw', '.cap-tw', '.net-wide', '.uc-gridwrap', '.bm-wrap', '.gfx-film-wrap', '.sb-tp-table', '.prose .eq',
].join(',');

function mark(el: HTMLElement): void {
  const max = el.scrollWidth - el.clientWidth;
  const l = el.scrollLeft > 2, r = el.scrollLeft < max - 2;
  const v = max > 2 ? (l ? 'l' : '') + (r ? 'r' : '') : '';
  if (v) el.dataset.more = v; else delete el.dataset.more;
}

export function trackScrollCue(root: HTMLElement): () => void {
  const seen = new WeakSet<HTMLElement>();
  const ros: ResizeObserver[] = [];
  const scan = (): void => {
    for (const el of root.querySelectorAll<HTMLElement>(SCROLL_BOXES)) {
      if (seen.has(el)) continue;
      seen.add(el);
      el.addEventListener('scroll', () => mark(el), { passive: true });
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => mark(el));
        ro.observe(el);
        if (el.firstElementChild) ro.observe(el.firstElementChild);
        ros.push(ro);
      }
      mark(el);
    }
  };
  let queued = 0;
  const mo = new MutationObserver(() => { if (!queued) queued = requestAnimationFrame(() => { queued = 0; scan(); }); });
  mo.observe(root, { childList: true, subtree: true });
  scan();
  return () => { mo.disconnect(); ros.forEach((r) => r.disconnect()); cancelAnimationFrame(queued); };
}
