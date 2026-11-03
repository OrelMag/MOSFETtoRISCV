import { describe, expect, it } from 'vitest';
import { goalText } from '../src/campaign/cardlabel';

describe('a level goal in one line', () => {
  it('keeps every letter and closes up the white space', () => {
    expect(goalText('Build <b>y</b>: the pull-down must\n  conduct.').plain).toBe('Build y: the pull-down must conduct.');
  });
  it('ends at the first sentence, not at a dot inside a word', () => {
    expect(goalText('Make it 1.5 x par. Then stop.').first).toBe('Make it 1.5 x par.');
    expect(goalText('No full stop here').first).toBe('No full stop here');
  });
});
