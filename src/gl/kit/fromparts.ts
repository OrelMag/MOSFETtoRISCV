// The unit box and cylinder: kits that place many identical boxy or round parts (loom, masks, mercury, strowger, crossbar,
// enigma) instance these, scaled per part. (Phase 0's mapping of box / cyl parts onto the studio lived here; it went with
// the last model on the old stage.) DOM-free.

import { lathe, roundedBox, type Geo } from './geo';

export const UNIT_BOX: Geo = roundedBox(1, 1, 1, 0);
export const UNIT_CYL: Geo = lathe([[0, -0.5], [0.5, -0.5], [0.5, 0.5], [0, 0.5]], { seg: 28, crease: 60 });
