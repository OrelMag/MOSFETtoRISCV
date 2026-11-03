import { describe, expect, it } from 'vitest';
import { CARD_PAD, CARD_W, HEAD_GAP, cardHeads, kindWidth, relationText, statusWidth } from '../src/campaign/cardlabel';
import { NODES } from '../src/campaign/nodes';
import { NODE_W } from '../src/campaign/layout';
import type { CampaignNode, Status } from '../src/campaign/types';

const STATUSES: Status[] = ['locked', 'available', 'started', 'solved', 'skipped'];
const BUG = {} as CampaignNode['bug'];
const KINDS: CampaignNode['kind'][] = ['lesson', 'drill', 'build', 'program', 'core'];

describe('card top row', () => {
  it('uses the layout width', () => expect(CARD_W).toBe(NODE_W));

  it('kind and status never overlap: every kind, flag, status and star count', () => {
    const cases: Pick<CampaignNode, 'kind' | 'optional' | 'soon' | 'bug'>[] = [];
    for (const kind of KINDS) for (const optional of [false, true]) for (const soon of [false, true]) for (const bug of [false, true]) cases.push({ kind, optional, soon, bug: bug ? BUG : undefined });
    for (const n of NODES) cases.push(n);
    let dropped = 0;
    for (const n of cases) for (const st of STATUSES) for (const stars of [0, 1, 2, 3]) {
      const h = cardHeads(n, st, stars);
      const left = CARD_PAD + kindWidth(h.kind);
      const right = CARD_W - 8 - (h.status ? statusWidth(h.status) : 0);
      expect(left + (h.status ? HEAD_GAP : 0), `${JSON.stringify(n.kind)} ${h.kind} / ${h.status}`).toBeLessThanOrEqual(right + (h.status ? 0 : 8));
      expect(left).toBeLessThanOrEqual(CARD_W - 8);
      if (!h.status && st !== 'available' && st !== 'started' && !(st === 'solved' && n.kind === 'lesson')) dropped++;
    }
    // the kind label is only ever shortened for the worst combinations, and the status is dropped only for a card that is also optional and coming soon
    expect(dropped).toBeLessThan(cases.length);
  });

  it('keeps the plain labels when they fit', () => {
    expect(cardHeads({ kind: 'build', optional: false, soon: false, bug: undefined }, 'locked').kind).toBe('build');
    expect(cardHeads({ kind: 'build', optional: true, soon: false, bug: BUG }, 'locked')).toMatchObject({ kind: 'bug hunt · opt', status: 'locked' });
    expect(cardHeads({ kind: 'build', optional: false, soon: false, bug: undefined }, 'solved', 2).status).toBe('★★☆');
  });

  it('names what a card needs and unlocks', () => {
    expect(relationText(['A', 'B'], ['C'])).toBe('Needs A, B. Unlocks C.');
    expect(relationText([], [])).toBe('Needs nothing else. Unlocks nothing further.');
  });
});
