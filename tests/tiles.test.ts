// The program as tiles: kinds, registers read and written, branch targets, producers, moving a line.

import { describe, expect, it } from 'vitest';
import { composeIsaOf } from '../src/isa/compose';
import { moveLine, programTiles } from '../src/isa/tiles';

const SUM = `# sum the array at a0 (a1 words) into t0
        li   t0, 0
loop:   lw   t1, 0(a0)
        add  t0, t0, t1
        addi a0, a0, 4
        addi a1, a1, -1
        bne  a1, zero, loop
        sw   t0, 0(a2)
        li   a3, 0x12345678
done:   j    done`;

describe('program tiles', () => {
  const tiles = programTiles(composeIsaOf('asm')!, SUM);

  it('a tile per line, of the right kind', () => {
    expect(tiles.map((t) => t.kind)).toEqual(['comment', 'instr', 'instr', 'instr', 'instr', 'instr', 'instr', 'instr', 'pseudo', 'instr']);
    expect(tiles[2].labels).toEqual(['loop']);
    expect(tiles[2].name).toBe('lw');
  });

  it('reads, writes and where each read register was written', () => {
    const add = tiles[3];
    expect(add.writes.map((r) => r.name)).toEqual(['t0']);
    expect(add.reads.map((r) => r.name)).toEqual(['t0', 't1']);
    expect(add.from.map((f) => [f.reg.name, f.tile])).toEqual([['t0', 1], ['t1', 2]]);
    // bne a1, zero: zero is never a dependency
    expect(tiles[6].reads.map((r) => r.name)).toEqual(['a1']);
    expect(tiles[6].from.map((f) => f.tile)).toEqual([5]);
  });

  it('branches point at the line of their target', () => {
    expect(tiles[6].target).toBe(2);
    expect(tiles[9].target).toBe(9);
  });

  it('works for RV16 and the 4-bit CPU too', () => {
    const t16 = programTiles(composeIsaOf('rv16')!, 'loop: addi a0, a0, -1\n      bne a0, zero, loop');
    expect(t16[1].target).toBe(0);
    expect(t16[1].from.map((f) => f.tile)).toEqual([0]);
    const t4 = programTiles(composeIsaOf('cpu4')!, 'start: LDM 5\n       XCH R3\n       JUN start');
    expect(t4.map((t) => t.kind)).toEqual(['instr', 'instr', 'instr']);
  });

  it('marks lines that do not assemble', () => {
    const t = programTiles(composeIsaOf('asm')!, 'add a0, a0\nnop');
    expect(t[0].kind).toBe('error');
    expect(t[0].error).toBeTruthy();
  });

  it('moves a line before another, both ways', () => {
    expect(moveLine('a\nb\nc\nd', 4, 2)).toBe('a\nd\nb\nc');
    expect(moveLine('a\nb\nc\nd', 1, 4)).toBe('b\nc\na\nd');
    expect(moveLine('a\nb\nc', 1, 4)).toBe('b\nc\na');
    expect(moveLine('a\nb\nc', 2, 3)).toBe('a\nb\nc');
  });
});
