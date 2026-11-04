// Chapter 35: the DRAM array in 3D (loaded on demand, modelhost.ts).

import type { Widget } from '../view/stage';
import { lazyModel } from './modelhost';

export const dram3d = (): Widget => lazyModel('the DRAM array', () => import('./dram3dview').then((m) => m.dramView()));
