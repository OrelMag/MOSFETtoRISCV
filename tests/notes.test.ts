import { describe, expect, it } from 'vitest';
import { mergeNotes, NotesStore, NOTES_KEY, placeHref, placeKey, sanitizeNotes, snippet, type KV, type Place } from '../src/ui/notes';
import { allQuestions } from '../src/ui/reviewqs';
import {
  answered, askSoon, buildQueue, DAY, emptyReview, INTERVALS_DAYS, mergeReview, ReviewLog, REVIEW_KEY, sanitizeReview, summarize,
  type Question, type ReviewState,
} from '../src/ui/review';

const mem = (): KV & { m: Map<string, string> } => {
  const m = new Map<string, string>();
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
};
const step: Place = { kind: 'step', chapter: 'adders', step: 2 };
const counter = (from = 1) => { let t = from; return () => t++; };

describe('notes store', () => {
  it('adds, edits, deletes and survives a reload', () => {
    const kv = mem();
    const s = new NotesStore(kv, counter(1000));
    const n = s.add(step, 'Adders', 'hello', { path: ['fa0'], inst: 'g4', inputs: { a: 1 }, cycle: 3 });
    s.update(n.id, { text: 'hello again' });
    expect(s.notesAt(step)).toHaveLength(1);
    expect(new NotesStore(kv).get(n.id)?.text).toBe('hello again');
    expect(new NotesStore(kv).get(n.id)?.pin?.inst).toBe('g4');
    s.update(n.id, { pin: null });
    expect(s.get(n.id)?.pin).toBeUndefined();
    s.remove(n.id);
    expect(s.list()).toHaveLength(0);
    expect(new NotesStore(kv).list()).toHaveLength(0);
  });

  it('toggles a bookmark per place', () => {
    const s = new NotesStore(mem(), counter());
    expect(s.toggleBookmark(step, 'Adders')).toBe(true);
    expect(s.isBookmarked(step)).toBe(true);
    expect(s.count).toBe(1);
    expect(s.toggleBookmark(step, 'Adders')).toBe(false);
    expect(s.isBookmarked(step)).toBe(false);
    expect(s.toggleBookmark(step, 'Adders')).toBe(true);
  });

  it('sanitizes what storage hands back', () => {
    const kv = mem();
    kv.setItem(NOTES_KEY, JSON.stringify({ items: {
      ok: { id: 'ok', type: 'note', place: { kind: 'bench', id: 'rca4' }, title: 't', text: 'x', at: 1, edited: 2, pin: { path: ['a'], inputs: { a: 1, b: 'x' } } },
      bad1: { id: 'bad1', type: 'note', place: { kind: 'nowhere' }, at: 1, edited: 1 },
      bad2: 'junk',
      bad3: { id: 'bad3', type: 'note', place: { kind: 'bench', id: 'x' }, at: 'now', edited: 1 },
    } }));
    const s = new NotesStore(kv);
    expect(s.list().map((i) => i.id)).toEqual(['ok']);
    expect(s.get('ok')?.pin?.inputs).toEqual({ a: 1 });
    expect(sanitizeNotes(null).items).toEqual({});
    kv.setItem(NOTES_KEY, '{nope');
    expect(new NotesStore(kv).list()).toEqual([]);
  });

  it('merges by id, newest edit wins, tombstones stay', () => {
    const a = new NotesStore(mem(), () => 100);
    const b = new NotesStore(mem(), () => 200);
    const n = a.add(step, 'x', 'old');
    b.replace(JSON.parse(JSON.stringify(a.state)));
    b.update(n.id, { text: 'newer' });
    expect(mergeNotes(a.state, b.state, 300).items[n.id].text).toBe('newer');
    expect(mergeNotes(b.state, a.state, 300).items[n.id].text).toBe('newer');
    const c = new NotesStore(mem(), () => 400);
    c.replace(JSON.parse(JSON.stringify(b.state)));
    c.remove(n.id);
    expect(mergeNotes(b.state, c.state, 500).items[n.id].gone).toBe(true);
    const other = b.add(step, 'y', 'second');
    expect(Object.keys(mergeNotes(b.state, c.state, 500).items).sort()).toEqual([n.id, other.id].sort());
    // an old tombstone is dropped
    expect(mergeNotes(c.state, c.state, 400 + 100 * DAY).items[n.id]).toBeUndefined();
  });

  it('names places', () => {
    expect(placeKey(step)).toBe('c:adders:2');
    expect(placeHref(step)).toBe('#/c/adders/2');
    expect(placeHref(step, { path: ['fa0', 'g 1'], inst: 'x' })).toBe('#/c/adders/2/fa0/g%201');
    expect(placeHref(step, { path: [] })).toBe('#/c/adders/2/~');
    expect(placeHref({ kind: 'bench', id: 'rca4' })).toBe('#/workbench/rca4');
    expect(snippet('  a   b\nc ', 100)).toBe('a b c');
    expect(snippet('abcdefghij', 5)).toBe('abcd…');
  });
});

const qs = (n: number, chapter = 'c1'): Question[] => Array.from({ length: n }, (_, i) => ({ key: `${chapter}:${i}`, origin: 'o', href: '#/', chapter }));

describe('review schedule', () => {
  const T = 1_000_000_000_000;

  it('wrong is due now; right after wrong is due in 2, 7, 21, 60 days', () => {
    let m = answered(undefined, false, T);
    expect(m).toMatchObject({ miss: true, streak: 0, due: T });
    m = answered(m, true, T + DAY);
    expect(m.streak).toBe(1);
    expect(m.due).toBe(T + DAY + INTERVALS_DAYS[0] * DAY);
    expect(m.miss).toBeUndefined();
    expect(m.missed).toBe(T);
    m = answered(m, true, m.due);
    expect(m.due - m.last).toBe(INTERVALS_DAYS[1] * DAY);
    for (let i = 0; i < 6; i++) m = answered(m, true, m.due);
    expect(m.due - m.last).toBe(INTERVALS_DAYS[INTERVALS_DAYS.length - 1] * DAY);
    expect(answered(m, false, T).streak).toBe(0);
  });

  it('queues missed, then asked-soon, then new and due by age; only visited chapters', () => {
    const all = [...qs(6), ...qs(2, 'c2')];
    const st: ReviewState = emptyReview();
    st.memos['c1:0'] = answered(undefined, true, T - 30 * DAY); // due (2 days passed)
    st.memos['c1:1'] = answered(undefined, true, T - 1 * DAY); // not due
    st.memos['c1:2'] = answered(undefined, false, T - 5 * DAY); // missed
    st.memos['c1:3'] = askSoon(answered(undefined, true, T - 1 * DAY), T - DAY / 2);
    st.memos['c1:4'] = answered(undefined, false, T - 9 * DAY); // missed, older
    const visited = (c: string) => c === 'c1';
    const q = buildQueue(all, st, { now: T, visited });
    expect(q.map((x) => `${x.q.key}:${x.why}`)).toEqual(['c1:4:missed', 'c1:2:missed', 'c1:3:soon', 'c1:5:new', 'c1:0:due']);
    expect(buildQueue(all, st, { now: T, visited, limit: 2 })).toHaveLength(2);
    expect(summarize(all, st, { now: T, visited })).toEqual({ missed: 2, stale: 2, due: 5 });
    // a chapter not visited contributes nothing
    expect(buildQueue(all, emptyReview(), { now: T, visited: () => false })).toEqual([]);
  });

  it('logs through storage and merges', () => {
    const kv = mem();
    const t = T;
    const log = new ReviewLog(kv, () => t);
    log.record('a:1', false);
    log.ask('a:1');
    expect(new ReviewLog(kv).state.memos['a:1']).toMatchObject({ miss: true, soon: true });
    const other = new ReviewLog(mem(), () => t + 100);
    other.record('a:1', true);
    other.record('b:1', true);
    const merged = mergeReview(log.state, other.state);
    expect(merged.memos['a:1'].streak).toBe(1);
    expect(Object.keys(merged.memos).sort()).toEqual(['a:1', 'b:1']);
    kv.setItem(REVIEW_KEY, JSON.stringify({ memos: { x: { n: -1 }, y: { n: 1, last: 1, due: 1, streak: 1 } } }));
    expect(Object.keys(sanitizeReview(JSON.parse(kv.getItem(REVIEW_KEY)!)).memos)).toEqual(['y']);
  });

  it('the catalogue has the keys the quiz boxes use, unique', () => {
    const all = allQuestions();
    expect(all.length).toBeGreaterThan(100);
    expect(new Set(all.map((q) => q.key)).size).toBe(all.length);
    expect(all.some((q) => q.key.includes(':recap:'))).toBe(true);
    expect(all.some((q) => q.key.startsWith('codex:'))).toBe(true);
  });
});
