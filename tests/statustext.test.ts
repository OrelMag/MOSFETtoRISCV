import { describe, expect, it } from 'vitest';
import { shortStatus } from '../src/view/statustext';

describe('the status line in short', () => {
  it('keeps what happened and drops the words around it', () => {
    expect(shortStatus('edge settled in 57 delays')).toBe('57 delays');
    expect(shortStatus('settled in 3 gate delays')).toBe('3 gate delays');
    expect(shortStatus('solved instantly')).toBe('solved');
  });
  it('drops a time in brackets, whole or fractional', () => {
    expect(shortStatus('settled in 3 relay steps (24.6 ms)')).toBe('3 relay steps');
    expect(shortStatus('settled in 3 relay steps (25 ms)')).toBe('3 relay steps');
  });
});
