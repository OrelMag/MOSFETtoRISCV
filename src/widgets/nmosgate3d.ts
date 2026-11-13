// Appendix A's 6502-style NMOS gate in 3D: this entry stays tiny; the model (widgets/nmosgate3dview.ts, the renderer) loads as
// its own chunks when the step opens.

import { lazyModel } from './modelhost';
import type { Widget } from '../view/stage';

export const nmosGate3d = (): Widget => lazyModel('a 6502-style NMOS gate', () => import('./nmosgate3dview').then((m) => m.nmosGateView()));
