// The user's motion preference, shared by everything that animates from script (CSS animations
// are already disabled globally in app.css; requestAnimationFrame loops are not).

const motionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

export const reducedMotion = (): boolean => !!motionQuery?.matches;
