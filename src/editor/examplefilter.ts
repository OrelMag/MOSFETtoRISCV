// The Examples gallery's sections and its search, DOM-free (editor/examplegallery.ts draws them).
import type { Example, ExampleGroup } from './examples';

export const EXAMPLE_GROUPS: { id: ExampleGroup; title: string }[] = [
  { id: 'first', title: 'First circuits' },
  { id: 'computers', title: 'Whole computers' },
  { id: 'widths', title: 'RISC-V widths' },
  { id: 'techniques', title: 'Circuit techniques' },
];

/** Does the example match every word of the query (name, card line and full blurb, case-insensitive)? */
export function exampleMatches(ex: Pick<Example, 'name' | 'short' | 'blurb'>, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const text = `${ex.name} ${ex.short} ${ex.blurb}`.toLowerCase();
  return words.every((w) => text.includes(w));
}

/** The sections that have a match, in section order, each with its matching examples in list order. */
export function filterExamples<E extends Pick<Example, 'name' | 'short' | 'blurb' | 'group'>>(examples: readonly E[], query: string): { id: ExampleGroup; title: string; items: E[] }[] {
  return EXAMPLE_GROUPS
    .map((g) => ({ ...g, items: examples.filter((e) => e.group === g.id && exampleMatches(e, query)) }))
    .filter((g) => g.items.length > 0);
}
