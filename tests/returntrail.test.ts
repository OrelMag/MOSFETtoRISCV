import { describe, expect, it } from 'vitest';
import { nextTrail, parseTrail, placeKey, RETURN_MAX, sectionOf, type ReturnPlace } from '../src/ui/returntrail';

const at = (hash: string): ReturnPlace => ({ hash, label: hash, short: hash, scroll: [] });

describe('quick return trail', () => {
  it('names sections', () => {
    expect(sectionOf('#/c/adders/3/rca/fa2?i=1')).toBe('c');
    expect(sectionOf('#/campaign/codex/cla')).toBe('codex');
    expect(sectionOf('#/campaign/play/n_fa')).toBe('level');
    expect(sectionOf('#/campaign')).toBe('campaign');
    expect(sectionOf('#/')).toBe('home');
    expect(sectionOf('#/workbench/rca4')).toBe('workbench');
  });

  it('a place is the step or the part, drill and view aside', () => {
    expect(placeKey('#/c/adders/3/rca/fa2?i=1')).toBe(placeKey('#/c/adders/3'));
    expect(placeKey('#/c/adders/3')).not.toBe(placeKey('#/c/adders/4'));
    expect(placeKey('#/workbench/rca4/fa0')).toBe(placeKey('#/workbench/rca4'));
  });

  it('a jump into another section keeps the place left', () => {
    const t = nextTrail([], at('#/c/adders/3?i=5'), '#/campaign/codex/cla', 'jump');
    expect(t.map((p) => p.hash)).toEqual(['#/c/adders/3?i=5']);
  });

  it('moves inside a section, unknown routes and hubs keep the trail as it is', () => {
    const t = [at('#/c/adders/3')];
    expect(nextTrail(t, at('#/campaign/codex/cla'), '#/campaign/codex/ks', 'jump')).toBe(t);
    expect(nextTrail(t, at('#/campaign/codex/cla'), '#/workbench/rca4', null)).toBe(t);
    expect(nextTrail(t, at('#/'), '#/workbench/rca4', 'jump')).toBe(t);
  });

  it('chains, then steps back one place at a time', () => {
    let t = nextTrail([], at('#/c/adders/3'), '#/campaign/codex/cla', 'jump');
    t = nextTrail(t, at('#/campaign/codex/cla'), '#/workbench/cla4', 'jump');
    expect(t.map((p) => p.hash)).toEqual(['#/c/adders/3', '#/campaign/codex/cla']);
    t = nextTrail(t, null, '#/campaign/codex/cla', 'jump');
    expect(t.map((p) => p.hash)).toEqual(['#/c/adders/3']);
    // the browser's Back, with the stage's drill in the address, counts as arriving too
    t = nextTrail(t, null, '#/c/adders/3/rca', null);
    expect(t).toEqual([]);
  });

  it('arriving at an older place drops it and everything after', () => {
    const t = [at('#/c/adders/3'), at('#/campaign/codex/cla'), at('#/workbench/cla4')];
    expect(nextTrail(t, at('#/sandbox/x'), '#/c/adders/3', 'jump')).toEqual([]);
  });

  it('the top nav forgets it', () => {
    expect(nextTrail([at('#/c/adders/3')], at('#/campaign/codex/cla'), '#/campaign', 'nav')).toEqual([]);
  });

  it(`keeps at most ${RETURN_MAX} places`, () => {
    let t: ReturnPlace[] = [];
    const hops = ['#/c/a/0', '#/campaign/codex/x', '#/workbench/y', '#/sandbox/z', '#/notes'];
    for (let i = 1; i < hops.length; i++) t = nextTrail(t, at(hops[i - 1]), hops[i], 'jump');
    expect(t.map((p) => p.hash)).toEqual(hops.slice(1, 4));
  });

  it('reads back only well-formed places', () => {
    expect(parseTrail(null)).toEqual([]);
    expect(parseTrail('{')).toEqual([]);
    expect(parseTrail(JSON.stringify([at('#/c/a/0'), { hash: 'javascript:x', label: '', short: '', scroll: [] }, 3]))).toEqual([at('#/c/a/0')]);
  });
});
