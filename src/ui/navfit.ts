// The top bar's section links on a phone: with every caption at full size the row can be a few px wider than its room
// (fonts, the My notes link, a longer return pill), which cut the last caption ("Sandbox" read "Sanc"). It sheds in
// steps until nothing is clipped: tighter captions, then icons alone (each link keeps its name as aria-label / title).

export const NAV_STAGES = ['', 'tight', 'icons'] as const;
export type NavStage = (typeof NAV_STAGES)[number];

/** The first stage at which the row is not clipped (pure: `clipped` measures with the stage applied); the last when none is. */
export function navStage(clipped: (stage: NavStage) => boolean): NavStage {
  for (const s of NAV_STAGES) if (!clipped(s)) return s;
  return NAV_STAGES[NAV_STAGES.length - 1];
}

const apply = (bar: HTMLElement, s: NavStage) => { if (s) bar.dataset.nav = s; else delete bar.dataset.nav; };

/** Keep `nav` unclipped inside `bar` (styles/app.css: [data-nav] under 760 px; wider screens scroll or shed labels already). */
export function installNavFit(bar: HTMLElement, nav: HTMLElement): void {
  let busy = false;
  const fit = () => {
    if (busy) return;
    busy = true;
    apply(bar, navStage((s) => { apply(bar, s); return nav.scrollWidth > nav.clientWidth + 1; }));
    busy = false;
  };
  // no fit() now: a ResizeObserver reports once on observe, after layout and before paint, so the first fit costs no
  // forced layout inside the page's startup task (~27 ms of a cold load)
  // the width, a link appearing (My notes), the return pill, the fonts arriving: each changes the room
  new ResizeObserver(fit).observe(document.documentElement);
  new ResizeObserver(fit).observe(nav);
  new MutationObserver(fit).observe(nav, { subtree: true, attributes: true, attributeFilter: ['hidden'], childList: true });
  void document.fonts?.ready.then(fit);
}
