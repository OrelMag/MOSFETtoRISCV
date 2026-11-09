// The learner's say over the readable-view rule (View options ▸ Labels; view/legible.ts applies it). A module of its own with no
// imports: settings.ts sets it on the first page, which must not reach the schematic code (tests/firstload.test.ts, pathindex.test.ts).

/** The fixed names' size as a factor of NAME_PX (0: none, a block keeps its own label however small), and whether text under
 *  MIN_TEXT_PX is hidden at all. */
export const legibleOptions = { names: 1, hideSmall: true };

const listeners = new Set<() => void>();

/** Told after the options change (view/legible.ts replans every schematic on the page). */
export function onLegibleOptions(f: () => void): void { listeners.add(f); }

/** New options: the schematics on the page follow at once. */
export function setLegibleOptions(o: Partial<typeof legibleOptions>): void {
  if ((o.names ?? legibleOptions.names) === legibleOptions.names && (o.hideSmall ?? legibleOptions.hideSmall) === legibleOptions.hideSmall) return;
  Object.assign(legibleOptions, o);
  listeners.forEach((f) => f());
}
