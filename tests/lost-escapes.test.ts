import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Release review: four regexes had lost their backslash (/s+/ for /\s+/, /d+n?$/, /^w+:$/) and cut letters out of
// section titles and listings or silently disabled a feature, with every test green. A bare class letter with + or *
// right after the start, a bracket, a bar or a space is never meant: it would be written out (ss+, (?:s)+).
const ROOT = join(__dirname, '..');
const files: string[] = [];
const walk = (d: string) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|mts|js|mjs|cjs)$/.test(e.name)) files.push(p);
  }
};
walk(join(ROOT, 'src'));
walk(join(ROOT, 'scripts'));

describe('no regex lost its backslash', () => {
  it('src/ and scripts/', () => {
    const bad: string[] = [];
    for (const f of files) {
      const sf = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (n: ts.Node): void => {
        if (n.kind === ts.SyntaxKind.RegularExpressionLiteral) {
          const t = n.getText(), body = t.slice(1, t.lastIndexOf('/'));
          if (/(^|[(|[\s^])[sdwSDW][+*]/.test(body)) bad.push(`${relative(ROOT, f)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} ${t}`);
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect(bad).toEqual([]);
  });
});
