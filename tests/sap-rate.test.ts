// The SAP panel's clock rate (widgets/sap.ts pacedRun): whole cycles at the chosen rate on animation frames, a Pulse
// each up to 10 Hz (Back undoes one), batches above; a late frame does not make up the backlog; it stops when told.

import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/lib';
import type { Stage } from '../src/view/stage';
import { pacedRun } from '../src/widgets/sap';

function fakeStage() {
  const st = { cycles: 0, pulses: 0, checkpoints: 0 };
  const stage = {
    pulse: () => { st.pulses++; st.cycles++; },
    runCycles: (n: number, stop?: () => boolean) => { let i = 0; for (; i < n && !(stop && stop()); i++) st.cycles++; return i; },
    checkpoint: () => { st.checkpoints++; },
  } as unknown as Stage;
  return { st, stage };
}

let frames: ((t: number) => void)[] = [];
let clock = 0;
const frame = (t: number) => { clock = t; const f = frames; frames = []; f.forEach((cb) => cb(t)); };

describe('pacedRun', () => {
  afterEach(() => vi.unstubAllGlobals());
  const setup = () => {
    frames = [];
    clock = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => (frames.push(cb), frames.length));
    vi.stubGlobal('cancelAnimationFrame', () => { frames = []; });
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
  };

  it('clocks at the rate: a Pulse a cycle at 10 Hz, batches at 500 Hz', () => {
    setup();
    const a = fakeStage();
    pacedRun(a.stage, 10, () => false, () => {});
    for (let t = 16; t <= 1000; t += 16) frame(t);
    expect(a.st.pulses).toBeGreaterThanOrEqual(9);
    expect(a.st.pulses).toBeLessThanOrEqual(10);
    setup();
    const b = fakeStage();
    pacedRun(b.stage, 500, () => false, () => {});
    for (let t = 16; t <= 1008; t += 16) frame(t);
    expect(b.st.pulses).toBe(0);
    expect(b.st.cycles).toBe(504);
  });

  it('a late frame does not make up the backlog; until stops it', () => {
    setup();
    const a = fakeStage();
    let stopped = false;
    pacedRun(a.stage, 2, () => a.st.cycles >= 3, () => { stopped = true; });
    frame(600);
    expect(a.st.cycles).toBe(1);
    frame(60_000); // ten minutes late
    expect(a.st.cycles).toBe(2);
    frame(60_500);
    expect(a.st.cycles).toBe(3);
    expect(stopped).toBe(true);
    expect(frames).toEqual([]);
  });
});
