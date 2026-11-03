// Solved with help (Do it for me) earns no stars; a lesson earns none; both survive export / import.
import { describe, expect, it } from 'vitest';
import { cardHeads, levelCardLabel } from '../src/campaign/cardlabel';
import { statusOf } from '../src/campaign/graph';
import { nodeById } from '../src/campaign/nodes';
import { CAMPAIGN_KEY, mergeCampaign, Progress, sanitizeCampaign } from '../src/campaign/progress';

class MapKV {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}

describe('solved with help', () => {
  it('a pass of the answer Do it for me put in solves without stars', () => {
    const kv = new MapKV();
    const p = new Progress(kv);
    p.markHelp('g_xor', 'K1');
    const r = p.solve('g_xor', { nand: 5, depth: 3 }, 'K1');
    expect(r).toMatchObject({ stars: 0, helped: true, first: true });
    expect(p.get('g_xor')).toMatchObject({ status: 'solved', helped: true });
    expect(p.get('g_xor')!.stars).toBeUndefined();
    const n = nodeById('g_xor')!;
    expect(statusOf(n, p.view)).toBe('solved');
    // survives storage
    expect(new Progress(kv).get('g_xor')!.helped).toBe(true);
    // rebuilt by hand (another circuit): stars, and the mark goes
    const own = p.solve('g_xor', { nand: 5, depth: 3 }, 'K2');
    expect(own.helped).toBe(false);
    expect(own.stars).toBeGreaterThan(0);
    expect(p.get('g_xor')!.helped).toBeUndefined();
  });

  it('old stars stay when helped later', () => {
    const p = new Progress(new MapKV());
    p.solve('g_xor', { nand: 5, depth: 3 });
    const before = p.get('g_xor')!.stars;
    p.markHelp('g_xor', 'K');
    expect(p.solve('g_xor', { nand: 9, depth: 9 }, 'K').helped).toBe(true);
    expect(p.get('g_xor')!.stars).toBe(before);
    expect(p.get('g_xor')!.helped).toBeUndefined();
  });

  it('a lesson earns no stars and leaves the total', () => {
    const p = new Progress(new MapKV());
    const before = p.summary();
    expect(p.solve('intro').stars).toBe(0);
    expect(p.get('intro')!.stars).toBeUndefined();
    expect(p.summary().stars).toBe(0);
    expect(p.summary().maxStars).toBe(before.maxStars);
    // a save from before holds stars on a lesson: they are not counted
    const old = new Progress(new MapKV());
    old.replace(sanitizeCampaign({ nodes: { intro: { status: 'solved', stars: 3 } } }));
    expect(old.summary().stars).toBe(0);
  });

  it('round-trips through sanitize and merge; the card says so', () => {
    const st = sanitizeCampaign({ nodes: { g_xor: { status: 'solved', helped: true, helpKey: 'K' } } });
    expect(st.nodes.g_xor).toMatchObject({ helped: true, helpKey: 'K' });
    const m = mergeCampaign(st, sanitizeCampaign({}));
    expect(m.nodes.g_xor!.helped).toBe(true);
    const better = mergeCampaign(st, sanitizeCampaign({ nodes: { g_xor: { status: 'solved', stars: 2, best: { nand: 5 } } } }));
    expect(better.nodes.g_xor!.helped).toBeUndefined();
    const n = nodeById('g_xor')!;
    expect(cardHeads(n, 'solved', 0, true).status).toBe('helped');
    expect(levelCardLabel(n, 'solved', 0, true)).toContain('with help');
    expect(CAMPAIGN_KEY).toBeTruthy();
  });
});

describe('the walkthrough\'s whole answer', () => {
  it('marks like Do it for me: the same markHelp key makes the unchanged Check helped', () => {
    const p = new Progress(new MapKV());
    p.markHelp('g_xor', 'walk-key'); // levelwalk.ts takeOver at the last step in watch mode
    expect(p.solve('g_xor', { nand: 5, depth: 3 }, 'walk-key')).toMatchObject({ stars: 0, helped: true });
  });
});
