// Keyboard for a popup menu (role="menu" under a button): Esc closes it and gives the focus back to its opener,
// Up / Down / Home / End move between its enabled items, Down on the opener enters it. One handler for every
// pal-menu user (top bar View options, the stage's Share and More, the layout menu).

/** The enabled items of a menu, in order. */
const itemsOf = (menu: HTMLElement): HTMLElement[] =>
  [...menu.querySelectorAll<HTMLElement>('button')].filter((b) => !(b as HTMLButtonElement).disabled && !b.hidden);

/** Where an arrow key goes from item `at` (-1: none focused) among `n` items; Home / End jump. */
export function menuStep(key: string, at: number, n: number): number {
  if (n <= 0) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return n - 1;
  if (key === 'ArrowDown') return at < 0 ? 0 : (at + 1) % n;
  if (key === 'ArrowUp') return at < 0 ? n - 1 : (at + n - 1) % n;
  return -1;
}

/**
 * Wire the keys. `root` holds the opener and the menu (their common wrapper); `close` is told to close the menu.
 * Esc is taken only while the menu is open (class `open`) so it still reaches the page when it is not.
 */
export function menuKeys(root: HTMLElement, menu: HTMLElement, opener: HTMLElement, close: () => void): void {
  root.addEventListener('keydown', (e) => {
    if (!menu.classList.contains('open')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      opener.focus({ preventScroll: true });
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    // a slider or text field inside keeps its own arrows
    if ((e.target as HTMLElement).closest('input, select, textarea')) return;
    const items = itemsOf(menu);
    const to = menuStep(e.key, items.indexOf(document.activeElement as HTMLElement), items.length);
    if (to < 0) return;
    e.preventDefault();
    items[to].focus();
  });
}
