import type { Chapter } from './types';

export const chEthernet: Chapter = {
  id: 'ethernet', num: 48, title: 'Ethernet', level: 'Communication',
  blurb: 'Who talks now, and to whom: addresses and the FCS, a MAC in gates, collisions, binary exponential backoff, and why a minimum frame exists.',
  builds: ['uart', 'errors'],
  steps: [{ title: 'Many machines, one wire', body: '<p>A frame needs an address.</p>' }],
};
