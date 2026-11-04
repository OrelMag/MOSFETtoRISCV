// The user's motion preference, shared by everything that animates from script (CSS animations
// are already disabled globally in app.css; requestAnimationFrame loops are not).

const motionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

/** The system asks for less motion (View options then shows its own switch as on, and locked). */
export const systemReducedMotion = (): boolean => !!motionQuery?.matches;

/** The system or View options' switch (settings.reduceMotion, data-reduce-motion on <html>). */
export const reducedMotion = (): boolean =>
  systemReducedMotion() || (typeof document !== 'undefined' && document.documentElement.hasAttribute('data-reduce-motion'));
