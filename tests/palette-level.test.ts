// My chips on a campaign level screen: no empty chip, never the level's own chip or a walkthrough's scratch chip.

import { describe, expect, it } from 'vitest';
import { levelHides } from '../src/editor/palette';
import { chip, pin } from './editorkit';

describe('levelHides', () => {
  const level = 'u_ch_cp_g_not';
  it('hides the empty default chip, the level chip and walkthrough chips; keeps a learner chip', () => {
    expect(levelHides(chip('u_main', 'Main', {}), level)).toBe(true);
    expect(levelHides(chip(level, 'NOT from NAND', { pins: [pin('a', 'in', [0, 0])] }), level)).toBe(true);
    expect(levelHides(chip('u_walk_g_not', 'Walk', { pins: [pin('a', 'in', [0, 0])] }), level)).toBe(true);
    expect(levelHides(chip('u_half', 'Half adder', { pins: [pin('a', 'in', [0, 0])] }), level)).toBe(false);
  });
});
