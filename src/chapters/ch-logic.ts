import type { Chapter } from './types';
import { numOf } from './order';

export const chLogic: Chapter = {
  id: 'logic', num: numOf('logic'), title: 'From a table to a circuit', level: 'Gates',
  blurb: 'Truth table to sum of products, algebra, Karnaugh maps, don\'t cares, and the glitch.',
  steps: [],
};
