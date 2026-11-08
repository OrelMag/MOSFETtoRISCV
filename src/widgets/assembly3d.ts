// Chapter 17's pipeline as an assembly line in 3D: this entry stays tiny; the model (widgets/assembly3dview.ts, the
// renderer) loads as its own chunks when the step opens.

import { lazyModel } from './modelhost';
import type { AssemblyProgram } from './assembly3dview';
import type { Widget } from '../view/stage';

export const assembly3d = (programs: readonly AssemblyProgram[]): Widget =>
  lazyModel('the assembly line', () => import('./assembly3dview').then((m) => m.assemblyView(programs)));
