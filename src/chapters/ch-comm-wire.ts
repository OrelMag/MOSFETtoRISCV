import type { Chapter } from './types';

export const chWire: Chapter = {
  id: 'wire', num: 41, title: 'A wire is not a wire', level: 'Communication',
  blurb: 'Between the driver\'s drain and the far pin: on-chip RC, repeaters, transmission lines, reflections, termination, differential pairs and an I/O pad.',
  builds: ['inverter', 'telegraph'],
  steps: [{ title: 'The driver and its load', body: '<p>A long wire is a load the inverter has to charge.</p>' }],
};
