// Core rope in 3D: this entry stays tiny; the model (widgets/rope3dview.ts, the renderer) loads as its own chunks.

import { lazyModel } from './modelhost';
import type { Widget } from '../view/stage';

export const rope3d = (): Widget => lazyModel('the core rope', () => import('./rope3dview').then((m) => m.ropeView()));
