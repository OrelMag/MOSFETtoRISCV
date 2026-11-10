// The ROM part's core-rope look (Appendix F): the same ROM, drawn larger with its first two words threaded through a
// band of cores; the ports keep their offsets (so wires stay on them) and the look survives a save.
import { describe, expect, it } from 'vitest';
import { partDef } from '../src/editor/parts';
import { sanitizeRef } from '../src/editor/store';
import { symbolGeom } from '../src/sim/geometry';
import type { ComponentDef } from '../src/sim/types';

const rom = (look?: 'rope') => ({ rom: { k: 6, w: 16 as const, addr: 'word' as const, lang: 'hex' as const, src: '0035\n0052\n', ...(look ? { look } : {}) } });
const def = (r: ReturnType<typeof rom>) => partDef(r, () => undefined) as ComponentDef;

describe('the ROM part drawn as core rope', () => {
  it('threads its first two words, low bit first: a 1 through the core, a 0 beside it', () => {
    expect(def(rom('rope')).symbol.rope).toEqual([[1, 0, 1, 0, 1, 1, 0], [0, 1, 0, 0, 1, 0, 1]]); // 0x35, 0x52
    expect(def(rom()).symbol.rope).toBeUndefined();
  });
  it('is the same ROM: same id and words, a larger box, the ports at their old offsets', () => {
    const plain = def(rom()), rope = def(rom('rope'));
    expect(rope.id).toBe(plain.id);
    expect(rope.behavior).toBe(plain.behavior);
    expect(rope.behavior!.eval([1], undefined)).toEqual([0x52]);
    const gp = symbolGeom(plain), gr = symbolGeom(rope);
    expect(gr.w).toBeGreaterThan(gp.w);
    expect(gr.ports.addr.pos).toEqual(gp.ports.addr.pos);
    expect(gr.ports.data.pos[1]).toBe(gp.ports.data.pos[1]);
    expect(def(rom('rope'))).toBe(rope); // one drawing per ROM
  });
  it('survives a save and a load', () => {
    expect(sanitizeRef(rom('rope'))).toMatchObject({ rom: { look: 'rope' } });
    expect(sanitizeRef({ rom: { ...rom().rom, look: 'lace' } })).not.toHaveProperty('rom.look');
  });
});
