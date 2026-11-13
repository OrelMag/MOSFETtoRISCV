// The sandbox's exports are stored zips (zip.ts); unzipStored reads them back so an export can be imported (G-5 of
// the eyes pass: the Digital export failed as "XML line …: more than one root element").
import { describe, expect, it } from 'vitest';
import { unzipStored, zipFiles } from '../src/editor/zip';

describe('unzipStored', () => {
  it('gives back what zipFiles wrote, names and UTF-8 text', () => {
    const files = [{ name: 'top.dig', text: '<?xml version="1.0"?>\n<circuit>ü → ∑</circuit>' }, { name: 'sub/half.dig', text: 'x'.repeat(5000) }, { name: 'empty.txt', text: '' }];
    const back = unzipStored(zipFiles(files));
    expect(back).toEqual([files[0], { name: 'half.dig', text: files[1].text }, files[2]]);
  });
  it('refuses a compressed entry and what is not a zip, with a reason', () => {
    const z = zipFiles([{ name: 'a.dig', text: 'abc' }]);
    z[8] = 8; // method: deflate
    expect(unzipStored(z)).toEqual({ error: expect.stringContaining('compressed') });
    expect(unzipStored(new TextEncoder().encode('<circuit/>'))).toEqual({ error: expect.stringContaining('not a zip') });
  });
});
