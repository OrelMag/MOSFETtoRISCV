import type { Chapter } from './types';

export const chUart: Chapter = {
  id: 'uart', num: 43, title: 'A UART', level: 'Communication',
  blurb: 'How two clocks agree for one byte: a baud divider, shift registers, 16× oversampling, framing errors, FIFOs, and two computers chatting over a wire.',
  builds: ['clocks', 'bus'],
  steps: [{ title: 'One byte, no clock', body: '<p>Two unrelated clocks and one wire.</p>' }],
};
