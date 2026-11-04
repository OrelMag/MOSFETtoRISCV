// Chapter 41: why a pair is twisted, in 3D (loaded on demand, modelhost.ts).

import type { Widget } from '../view/stage';
import { lazyModel } from './modelhost';

export const cable3d = (): Widget => lazyModel('the twisted pair', () => import('./cable3dview').then((m) => m.cableView()));
