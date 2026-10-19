import { describe, expect, it } from 'vitest';
import { errorParts, isNoise, issueUrl, MAX_URL, oneLine, REPO_URL, safeRoute, siteVersion, trimStack, type ReportInfo } from '../src/ui/report';

const ORIGIN = 'https://orelmag.github.io';
const env: ReportInfo = {
  route: '#/c/alu/3', version: '1.002.345 (abc1234, 2026-10-12)', userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130',
  theme: 'dark (auto)', time: '2026-10-12T10:00:00.000Z',
};
const decode = (u: string) => {
  const q = new URL(u).searchParams;
  return { title: q.get('title') ?? '', body: q.get('body') ?? '' };
};
const frames = (n: number, width = 60) =>
  ['Error: boom', ...Array.from({ length: n }, (_, i) => `    at fn${i} (${ORIGIN}/MOSFETtoRISCV/assets/index-${'x'.repeat(width)}.js:${i + 1}:${i * 7})`)].join('\n');

describe('problem reports', () => {
  it('builds a new-issue URL with the error, route, version, browser, theme and time', () => {
    const u = issueUrl({ ...env, message: 'TypeError: x is undefined', stack: 'TypeError: x is undefined\n    at f (/assets/a.js:1:2)' });
    expect(u.startsWith(`${REPO_URL}/issues/new?`)).toBe(true);
    const { title, body } = decode(u);
    expect(title).toBe('Error: TypeError: x is undefined');
    for (const s of ['TypeError: x is undefined', 'at f (/assets/a.js:1:2)', '#/c/alu/3', '1.002.345 (abc1234, 2026-10-12)', 'Chrome/130', 'dark (auto)', '2026-10-12T10:00:00.000Z'])
      expect(body).toContain(s);
  });

  it('a plain report has the environment and no error section', () => {
    const { title, body } = decode(issueUrl(env));
    expect(title).toBe('Problem report');
    expect(body).not.toContain('**Error**');
    expect(body).toContain('#/c/alu/3');
  });

  it('mentions repeated errors', () => {
    expect(decode(issueUrl({ ...env, message: 'boom', count: 5, distinct: 2 })).body).toContain('5 errors in this session, 2 different');
  });

  it('stays under the length cap, trimming the stack first', () => {
    const u = issueUrl({ ...env, message: 'boom', stack: frames(400) });
    expect(u.length).toBeLessThanOrEqual(MAX_URL);
    const { body } = decode(u);
    expect(body).toContain('boom');
    expect(body).toContain('at fn0 ');
    expect(body).toContain('(trimmed)');
    expect(body).not.toContain('at fn399 ');
    expect(body).toContain('#/c/alu/3');
    // A short stack is left whole.
    const short = decode(issueUrl({ ...env, message: 'boom', stack: frames(3) })).body;
    expect(short).toContain('at fn2 ');
    expect(short).not.toContain('(trimmed)');
  });

  it('cuts an enormous message (or user agent) to fit', () => {
    for (const message of ['é'.repeat(50_000), 'a\n'.repeat(20_000)]) {
      const u = issueUrl({ ...env, message, stack: frames(50) });
      expect(u.length).toBeLessThanOrEqual(MAX_URL);
      expect(decode(u).body).toContain('#/c/alu/3');
    }
    expect(issueUrl({ ...env, userAgent: 'U'.repeat(20_000), message: 'boom' }).length).toBeLessThanOrEqual(MAX_URL);
    expect(issueUrl({ ...env, message: 'boom' }, 3000).length).toBeLessThanOrEqual(3000);
  });

  it('never carries a shared circuit: share-link payloads are dropped from the route', () => {
    expect(safeRoute('#/sandbox/s/eJyrVkrOz0nVUcrJT0w')).toBe('#/sandbox/s/(share link)');
    expect(safeRoute('')).toBe('#/');
    expect(safeRoute('#/c/' + 'x'.repeat(500)).length).toBeLessThan(200);
    expect(safeRoute('#/workbench/rca4')).toBe('#/workbench/rca4');
  });

  it('trims stacks: origin removed, frames capped', () => {
    const t = trimStack(frames(40), ORIGIN);
    expect(t).not.toContain(ORIGIN);
    expect(t).toContain('/MOSFETtoRISCV/assets/');
    expect(t.split('\n')).toHaveLength(26);
    expect(t.startsWith('    at fn0 ')).toBe(true);
    // Firefox / Safari frames have no message line to drop.
    expect(trimStack(`f@${ORIGIN}/a.js:1:2\ng@${ORIGIN}/a.js:3:4`, ORIGIN)).toBe('f@/a.js:1:2\ng@/a.js:3:4');
    expect(t).toContain('more frames');
  });

  it('reads anything thrown', () => {
    expect(errorParts(new TypeError('bad')).message).toBe('TypeError: bad');
    expect(errorParts(new Error('plain')).message).toBe('plain');
    expect(errorParts('a string').message).toBe('a string');
    expect(errorParts(undefined).message).toContain('undefined');
    expect(errorParts({ message: 'like an error' }).message).toBe('like an error');
    expect(errorParts(Object.create(null)).message).toBe('Unknown error');
    expect(oneLine('  first\n second  ')).toBe('first');
    expect(oneLine('x'.repeat(300), 50)).toHaveLength(50);
  });

  it('ignores noise', () => {
    const ours = `Error: boom\n    at f (${ORIGIN}/MOSFETtoRISCV/assets/index.js:1:2)`;
    expect(isNoise({ message: 'ResizeObserver loop completed with undelivered notifications.' }, ORIGIN)).toBe(true);
    expect(isNoise({ message: 'ResizeObserver loop limit exceeded' }, ORIGIN)).toBe(true);
    expect(isNoise({ message: 'Script error.' }, ORIGIN)).toBe(true);
    expect(isNoise({ message: 'x', name: 'AbortError' }, ORIGIN)).toBe(true);
    expect(isNoise({ message: 'boom', stack: 'Error: boom\n    at x (chrome-extension://abcdef/content.js:1:2)' }, ORIGIN)).toBe(true);
    expect(isNoise({ message: 'boom', stack: `Error: boom\n    at x (moz-extension://abc/c.js:1:2)\n    at f (${ORIGIN}/a.js:1:2)` }, ORIGIN)).toBe(true);
    expect(isNoise({ message: 'boom', stack: 'Error: boom\n    at x (https://other.example/ad.js:1:2)' }, ORIGIN)).toBe(true);
    expect(isNoise({ message: 'boom', filename: 'chrome-extension://abc/x.js' }, ORIGIN)).toBe(true);
    expect(isNoise({ message: 'boom', stack: ours }, ORIGIN)).toBe(false);
    expect(isNoise({ message: 'boom', stack: ours, filename: `${ORIGIN}/MOSFETtoRISCV/assets/index.js` }, ORIGIN)).toBe(false);
    expect(isNoise({ message: 'boom' }, ORIGIN)).toBe(false);
    // No URLs in the stack (eval'd code, some engines): reported.
    expect(isNoise({ message: 'boom', stack: 'Error: boom\n    at <anonymous>:1:7' }, ORIGIN)).toBe(false);
  });

  it('knows the site version', () => {
    // the build number (commits on main) is padded to three digits, not cut: 1.000.1032 past a thousand
    expect(siteVersion()).toMatch(/^\d+\.\d{3}\.\d{3,} \(.+, \d{4}-\d{2}-\d{2}\)$/);
  });
});
