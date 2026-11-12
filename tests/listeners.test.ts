// A subscription to a long-lived store (settings, the notes store, an editor) made by a page, stage, panel or dialog must be
// undone when its owner goes, or the store's listener set keeps the owner (and its simulator and DOM) alive: every chapter visit
// kept its whole Stage until this was fixed (release review R1: 20 MB a visit on the CPU chapter, 162 MB on the GPU one).
// The tests have no DOM to build a Stage in, so this pins the two shapes that leaked, over the whole source tree.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', 'src');
const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
});
const SOURCES = files(ROOT).map((p) => ({ path: relative(ROOT, p).replace(/\\/g, '/'), lines: readFileSync(p, 'utf8').split('\n') }));

// App-lifetime subscriptions: made once at startup, inside a start / install function, and meant to last as long as the tab.
const APP_LIFETIME = new Set(['ui/app.ts', 'ui/keys.ts']);

describe('subscriptions are undone with their owner', () => {
  it('no settings / notes onChange whose unsubscribe is dropped, except at module scope or app start', () => {
    const bad: string[] = [];
    for (const { path, lines } of SOURCES) {
      if (APP_LIFETIME.has(path)) continue;
      lines.forEach((l, i) => {
        // indented = inside a function or class; a call in statement position throws its `off` away
        if (/^\s+(settings|notes\(\)|store)\.onChange\(/.test(l)) bad.push(`${path}:${i + 1}: ${l.trim()}`);
      });
    }
    expect(bad).toEqual([]);
  });

  it('no lazy unsubscribe that waits for the next change after its element has gone', () => {
    // `if (!el.isConnected) return off()` only runs when the store changes again: a reader who never changes it keeps every owner
    const bad: string[] = [];
    for (const { path, lines } of SOURCES) lines.forEach((l, i) => {
      if (/isConnected\)\s*return\s+(void\s+)?off\(\)/.test(l)) bad.push(`${path}:${i + 1}: ${l.trim()}`);
    });
    expect(bad).toEqual([]);
  });
});
