// The campaign map for a screen reader and the keyboard: each card's accessible name (kind, title,
// state), and the order the cards are drawn in, which is the Tab order (act by act).

import { describe, expect, it } from 'vitest';
import { KIND_LABEL, levelCardLabel } from '../src/campaign/cardlabel';
import { statusOf } from '../src/campaign/graph';
import { mapLayout } from '../src/campaign/layout';
import { ACTS, NODES, nodeById } from '../src/campaign/nodes';
import type { CampaignNode } from '../src/campaign/types';

const node = (o: Partial<CampaignNode>) => ({ kind: 'build', title: 'CMOS inverter', ...o }) as CampaignNode;

describe('levelCardLabel', () => {
  it('reads kind: title, state', () => {
    expect(levelCardLabel(node({}), 'locked')).toBe('Build: CMOS inverter, locked');
    expect(levelCardLabel(node({ kind: 'lesson', title: 'Anatomy of a CPU' }), 'available')).toBe('Lesson: Anatomy of a CPU, available');
    expect(levelCardLabel(node({ kind: 'program', title: 'Loops' }), 'started')).toBe('Program: Loops, in progress');
    expect(levelCardLabel(node({ kind: 'drill' }), 'skipped')).toBe('Drill: CMOS inverter, skipped');
  });

  it('adds stars to a solved graded level, not to a lesson', () => {
    expect(levelCardLabel(node({}), 'solved', 2)).toBe('Build: CMOS inverter, solved, 2 of 3 stars');
    expect(levelCardLabel(node({ kind: 'lesson' }), 'solved', 0)).toBe('Lesson: CMOS inverter, solved');
  });

  it('says optional, and coming soon in place of the state', () => {
    expect(levelCardLabel(node({ kind: 'core', title: 'A faster core', optional: true }), 'locked')).toBe('CPU core: A faster core, locked, optional');
    expect(levelCardLabel(node({ optional: true, soon: true }), 'solved', 3)).toBe('Build: CMOS inverter, coming soon, optional');
  });

  it('names every level on the map, with its kind and title', () => {
    const fresh = () => undefined;
    for (const n of NODES) {
      const l = levelCardLabel(n, statusOf(n, fresh), 0);
      expect(l.startsWith(`${KIND_LABEL[n.kind]}: ${n.title}, `), n.id).toBe(true);
    }
    expect(levelCardLabel(nodeById('t_inv')!, statusOf(nodeById('t_inv')!, () => undefined))).toBe('Build: CMOS inverter, locked');
  });
});

describe('map order (= Tab order)', () => {
  it('places the levels act by act, in the order of the acts', () => {
    for (const cols of [Infinity, 4, 2, 1]) {
      const acts = [...mapLayout(cols).nodes.values()].map((p) => ACTS.findIndex((a) => a.num === p.node.act));
      expect(acts.every((a, i) => i === 0 || a >= acts[i - 1]), `cols ${cols}`).toBe(true);
    }
  });
});
