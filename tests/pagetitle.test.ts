import { describe, expect, it } from 'vitest';
import { routeTitle, titleText } from '../src/ui/pagetitle';

const chapter = { title: 'Gates from NAND', steps: [{ title: 'NOT' }, { title: 'OR' }] };

describe('page titles', () => {
  it('names a step, then its chapter', () => {
    expect(routeTitle(['c', 'gates', '1'], chapter)).toEqual(['OR', 'Gates from NAND']);
    expect(routeTitle(['c', 'gates'], chapter)).toEqual(['NOT', 'Gates from NAND']);
  });
  it('calls the step past the last the recap, also when the address is out of range', () => {
    expect(routeTitle(['c', 'gates', '2'], chapter)[0]).toBe('Recap');
    expect(routeTitle(['c', 'gates', '99'], chapter)[0]).toBe('Recap');
    // the print view is titled by the chapter: that is the name a saved PDF gets
    expect(routeTitle(['c', 'gates', 'print', '2'], chapter)).toEqual(['Gates from NAND']);
  });
  it('says so for a chapter that does not exist', () => {
    expect(routeTitle(['c', 'nope'])).toEqual(['No such chapter']);
  });
  it('joins the names with the site last, the home page alone', () => {
    expect(titleText(['OR', 'Gates from NAND'])).toBe('OR · Gates from NAND · From Switch to RISC-V and Beyond');
    expect(titleText(routeTitle([]))).toBe('From Switch to RISC-V and Beyond');
  });
});
