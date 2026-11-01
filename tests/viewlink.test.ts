import { describe, expect, it } from 'vitest';
import { SITE_URL as FILES_SITE_URL } from '../src/editor/files';
import { SITE_URL, decodeView, emptyView, encodeView, linkTo, splitView } from '../src/ui/viewlink';

describe('view links', () => {
  it('round trips inputs, probes and cycles', () => {
    const v = { inputs: { a: 5n, 'b c': (1n << 80n) + 3n }, probes: [{ path: ['dp', 'al/u'], net: 12 }, { path: [], net: 3 }], cycles: 42 };
    const q = encodeView(v);
    expect(q.startsWith('?')).toBe(true);
    expect(q).not.toMatch(/[ #]/);
    expect(decodeView(q)).toEqual(v);
  });
  it('is empty for the scene as loaded and old links have no suffix', () => {
    expect(encodeView(emptyView())).toBe('');
    expect(splitView('#/c/adders/3/fa0')).toEqual({ route: '#/c/adders/3/fa0', query: '' });
    expect(splitView('#/c/adders/3/fa0?n=5')).toEqual({ route: '#/c/adders/3/fa0', query: '?n=5' });
    expect(decodeView('')).toBeNull();
  });
  it('drops malformed or hostile pieces and caps cycles', () => {
    expect(decodeView('?i=a~zz,b~%E0%A4%A,~5&p=x~-1,y~q&n=-3')).toBeNull();
    expect(decodeView('?n=99999999999')!.cycles).toBe(1_000_000);
    expect(decodeView('?i=a~ff&junk&p=')!.inputs).toEqual({ a: 255n });
  });
  it('points the desktop program at the public site', () => {
    expect(SITE_URL).toBe(FILES_SITE_URL);
    expect(linkTo('#/c/x/1', 'app://mosfet/index.html#/c/x/1')).toBe(`${SITE_URL}#/c/x/1`);
    expect(linkTo('#/c/x/1', 'https://h.io/sub/#/c/y')).toBe('https://h.io/sub/#/c/x/1');
  });
});
