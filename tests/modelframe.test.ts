// The model frame's DOM-free parts: a saved image's file name, and the help texts naming the new gestures.
import { describe, expect, it } from 'vitest';
import { ORBIT_ARIA, ORBIT_HINT, fileName } from '../src/widgets/modelframe';

describe('model frame', () => {
  it('names a saved image after the model, not its whole description', () => {
    expect(fileName('A cut-away moving-coil loudspeaker in 3D, with a plot of the held samples behind it')).toBe('a-cut-away-moving-coil-loudspeaker.png');
    expect(fileName('The memory hierarchy as distances in 3D: a core, then along a road …')).toBe('the-memory-hierarchy-as-distances.png');
    expect(fileName('telephone relay')).toBe('telephone-relay.png');
    expect(fileName('6SN7 twin triode')).toBe('6sn7-twin-triode.png');
    expect(fileName('')).toBe('model.png');
    expect(fileName('x'.repeat(200)).length).toBeLessThanOrEqual(48 + 4);
  });
  it('the hint and the screen-reader text name pan, zoom and the keys', () => {
    for (const w of ['orbit', 'pan', 'zoom', 'double-click', 'full screen']) expect(ORBIT_HINT.toLowerCase()).toContain(w);
    for (const w of ['orbit', 'pan', 'zoom', 'arrow keys', 'shift', 'home']) expect(ORBIT_ARIA.toLowerCase()).toContain(w);
  });
});
