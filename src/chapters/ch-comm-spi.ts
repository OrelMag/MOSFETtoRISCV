import type { Chapter } from './types';

export const chSpi: Chapter = {
  id: 'spi', num: 44, title: 'SPI and I²C', level: 'Communication',
  blurb: 'A shared clock, or many devices on two wires: SPI\'s modes, I²C at switch level with open drain, arbitration and clock stretching.',
  builds: ['uart'],
  steps: [{ title: 'Send the clock too', body: '<p>Four wires and a master.</p>' }],
};
