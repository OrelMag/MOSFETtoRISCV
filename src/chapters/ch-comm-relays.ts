import type { Chapter } from './types';

export const chTelegraph: Chapter = {
  id: 'telegraph', num: 39, title: 'Two machines, one wire', level: 'Communication',
  blurb: 'Why moving a bit is harder than computing one: a telegraph line, the relay that repeats it, and the limits Nyquist and Shannon set.',
  builds: ['relays', 'bus'],
  steps: [{ title: 'A line that fades', body: '<p>A telegraph key, a battery and a mile of iron wire.</p>' }],
};

export const chExchange: Chapter = {
  id: 'exchange', num: 40, title: 'The telephone exchange', level: 'Communication',
  blurb: 'How many people reach each other: a dial exchange from relays, circuit switching and what it costs in contacts.',
  builds: ['telegraph'],
  steps: [{ title: 'Everyone to everyone', body: '<p>n people need n(n − 1) / 2 wires, or one exchange.</p>' }],
};
