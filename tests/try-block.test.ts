// A Try box is a block, whichever element a chapter writes it in: its finger is placed absolutely, and an inline one draws its border through the lines around it.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chapters } from '../src/chapters';

const rule = (file: string, selector: string): string => {
  const css = readFileSync(new URL(`../src/styles/${file}`, import.meta.url), 'utf8');
  const at = css.indexOf(`${selector} {`);
  expect(at, `${selector} in ${file}`).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf('}', at));
};

describe('Try boxes', () => {
  it('are blocks on the page and in print', () => {
    expect(rule('app.css', '.prose .try')).toMatch(/display:\s*block/);
    expect(rule('print.css', '.pd-prose .try')).toMatch(/display:\s*block/);
  });
  it('are written only as a div or a span, which that rule covers without changing how Tries finds them', () => {
    for (const c of chapters) for (const s of c.steps) for (const m of String(s.body).matchAll(/<(\w+)[^>]*class="try[" ]/g)) expect(['div', 'span', 'p']).toContain(m[1]);
  });
});
