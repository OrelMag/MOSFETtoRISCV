import type { Chapter } from './types';

export const chSwitch: Chapter = {
  id: 'switch', num: 49, title: 'A switch', level: 'Communication',
  blurb: 'Can everyone talk at once: address learning, a crossbar and its arbiter, store-and-forward against cut-through, and head-of-line blocking.',
  builds: ['ethernet', 'exchange'],
  steps: [{ title: 'Everyone at once', body: '<p>A wire per machine, and a box in the middle.</p>' }],
};
