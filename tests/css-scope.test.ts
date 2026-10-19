import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// `.cmp` names both the instruction builder (composer.css, a div) and the comparison tables (app.css, ~15 widgets):
// a bare `.cmp { display: grid }` turned every table's head and body into separate grids, misaligning their columns.
describe('class name collisions in the stylesheets', () => {
  it('the instruction builder\'s .cmp layout does not reach the comparison tables', () => {
    const css = readFileSync('src/styles/composer.css', 'utf8');
    expect(css).not.toMatch(/(^|[\s,}])\.cmp\s*\{[^}]*display/m);
  });
});
