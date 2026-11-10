// Appendix E's Williams tube in 3D: this entry stays tiny; the model (williams3dview.ts, the renderer) loads as its own chunks.

import { lazyModel } from './modelhost';
import type { Widget } from '../view/stage';

export const williams3d = (words?: number[]): Widget => lazyModel('the Williams tube', () => import('./williams3dview').then((m) => m.williamsView(words)));
