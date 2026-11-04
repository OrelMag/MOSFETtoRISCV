import type { Chapter } from './types';

export const chClocks: Chapter = {
  id: 'clocks', num: 42, title: 'Crossing clocks', level: 'Communication',
  blurb: 'When the receiver may look: noise margins, a Schmitt trigger, metastability, a two-flop synchronizer and an asynchronous FIFO.',
  builds: ['latches', 'wire'],
  steps: [{ title: 'What a receiver decides', body: '<p>A receiver turns a voltage into a bit.</p>' }],
};
