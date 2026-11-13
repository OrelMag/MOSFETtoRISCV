// Every lazy 3D model has a measured placeholder height (widgets/modelhost.ts LOADED): a model renamed or added without one
// falls back to 520 px, which shifts what follows it when the model arrives.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { placeholderHeight } from '../src/widgets/modelhost';

const dir = new URL('../src/widgets/', import.meta.url);
const names = new Set<string>();
for (const f of readdirSync(dir)) {
  if (!f.endsWith('.ts')) continue;
  for (const m of readFileSync(new URL(f, dir), 'utf8').matchAll(/lazyModel\('([^']+)'/g)) names.add(m[1]);
}

describe('3D model placeholders', () => {
  it('finds the models', () => expect(names.size).toBeGreaterThan(30));
  it.each([...names])('%s has a measured height', (what) => expect(placeholderHeight(what)).toBeGreaterThan(520));
});
