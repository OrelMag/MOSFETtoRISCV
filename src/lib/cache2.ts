// A write-back, write-allocate data cache at gate level: dirty bits, a miss controller that writes
// the victim line back before fetching the new one, and an optional second way with an LRU bit per
// set. Same ports as cachedMemory, so the CPU can use either.

import type { ComponentDef, PortDef } from '../sim/types';
import { constWord, isZero } from './alu';
import { Builder } from './builder';
import { andN, busMux2, equal, incrementer } from './combinational';
import { define, merger, splitter } from './define';
import { AND, MUX2, NOT, OR } from './gates';
import { ram } from './memory';
import { register } from './sequential';
import { TIE0, TIE1 } from './transistors';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width, dir, side });

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

/** Cycles a miss stalls: 8 for a clean victim (4 latency + 4 words), 12 when a dirty line goes back first. */
export const WB_MISS_CLEAN = 8;
export const WB_MISS_DIRTY = 12;

/**
 * One way of a cache: a tag array holding {dirty, valid, tag} per set, a data array of 4-word lines,
 * and the comparator that decides hit.
 */
export function cacheWay(ib: number, t: number): ComponentDef {
  return memo(`cway${ib}_${t}`, () => {
    const b = new Builder(18, 14);
    b.pins('index', 'tag', 'daddr', 'din', 'dwe', 'twe', 'dirtyIn', 'clk');
    const tv = b.op1(merger([t, 1, 1]), ['tag', b.op1(TIE1, []), 'dirtyIn'], '{dirty, valid, tag}');
    b.next();
    const tags = b.op(ram(ib, t + 2), ['index', tv, 'twe', 'clk'], 'tag array', 'tags');
    const data = b.op(ram(ib + 2, 32), ['daddr', 'din', 'dwe', 'clk'], 'data array', 'data');
    b.next();
    const st = b.op(splitter([t, 1, 1]), [`${tags}.dout`]);
    b.next();
    const eq = b.op1(equal(t), ['tag', `${st}.o0`], 'tag match');
    b.next();
    b.wire(b.op1(AND, [eq, `${st}.o1`]), 'hit');
    b.wire(`${st}.o1`, 'valid');
    b.wire(`${st}.o2`, 'dirty');
    b.wire(`${st}.o0`, 'stag');
    b.wire(`${data}.dout`, 'dout');
    const R = b.right;
    return define({
      id: `cway${ib}_${t}`, name: `Cache way (${2 ** ib} lines × 4 words)`, category: 'memory',
      summary: 'Tag array ({dirty, valid, tag} per line) and data array, read by the set index; hit = valid and the stored tag equals the address tag. A store hit sets the dirty bit; a fill clears it.',
      ports: [bus('index', ib, 'in'), bus('tag', t, 'in'), bus('daddr', ib + 2, 'in'), bus('din', 32, 'in'), bit('dwe', 'in'), bit('twe', 'in'), bit('dirtyIn', 'in'), bit('clk', 'in', 'bottom', true),
        bit('hit', 'out'), bit('valid', 'out'), bit('dirty', 'out'), bus('stag', t, 'out'), bus('dout', 32, 'out')],
      symbol: { kind: 'box', label: 'WAY' },
      netlist: () => ({ pins: { index: [0, 4], tag: [0, 8], daddr: [0, 12], din: [0, 16], dwe: [0, 20], twe: [0, 24], dirtyIn: [0, 28], clk: [0, 34], hit: [R, 4], valid: [R, 8], dirty: [R, 12], stag: [R, 16], dout: [R, 20] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/**
 * Miss controller: a 4-bit counter that runs while stall = 1. Counts 0–3 write the victim line back
 * (only if it is dirty), 4–7 wait for memory, 8–11 fill the new line; the tag is written on 11 and the
 * counter returns to 0. A clean victim skips the write-back: 0 jumps straight to 5.
 */
export const MISS_CTRL: ComponentDef = (() => {
  const b = new Builder(18, 14);
  b.pins('stall', 'dirtyV', 'clk');
  const cnt = b.op(register(4), ['', 'stall', 'clk'], 'miss counter', 'cnt');
  const count = b.name(`${cnt}.q`, 'count', true);
  b.next();
  const sc = b.op(splitter([1, 1, 1, 1]), [count]);
  const inc = b.op1(incrementer(4), [count], '+1');
  const zero = b.op1(isZero(4), [count], '= 0');
  b.next();
  const nc2 = b.op1(NOT, [`${sc}.o2`]), nc3 = b.op1(NOT, [`${sc}.o3`]), ndv = b.op1(NOT, ['dirtyV']);
  b.next();
  const skip = b.name(b.op1(AND, [zero, ndv], 'clean: skip'), 'skip', true);
  const last = b.name(b.op1(andN(4), [`${sc}.o0`, `${sc}.o1`, nc2, `${sc}.o3`], '= 11'), 'last', true);
  const wb = b.op1(andN(4), ['stall', 'dirtyV', nc3, nc2], 'write back');
  const fill = b.op1(AND, ['stall', `${sc}.o3`], 'fill');
  b.next();
  const s5 = b.op1(busMux2(4), [inc, b.op1(constWord(4, 5), []), skip]);
  const nx = b.name(b.op1(busMux2(4), [s5, b.op1(constWord(4, 0), []), last]), 'next', true);
  b.wire(nx, `${cnt}.d`);
  b.next();
  b.wire(b.op1(merger([1, 1]), [`${sc}.o0`, `${sc}.o1`]), 'word');
  b.wire(wb, 'wb');
  b.wire(fill, 'fill');
  b.wire(b.op1(AND, ['stall', last]), 'last');
  const R = b.right;
  return define({
    id: 'missctrl', name: 'Write-back miss controller', category: 'sequential',
    summary: 'Counts through a miss: 0–3 write the dirty victim back (one word per cycle), 4–7 wait for memory, 8–11 bring the new line in, and on 11 the tag is written. A clean victim jumps from 0 to 5, so its miss costs 8 cycles instead of 12.',
    ports: [bit('stall', 'in'), bit('dirtyV', 'in'), bit('clk', 'in', 'bottom', true), bus('word', 2, 'out'), bit('wb', 'out'), bit('fill', 'out'), bit('last', 'out')],
    symbol: { kind: 'box', label: 'MISS FSM' },
    netlist: () => ({ pins: { stall: [0, 4], dirtyV: [0, 8], clk: [0, 14], word: [R, 4], wb: [R, 8], fill: [R, 12], last: [R, 16] }, instances: b.instances, nets: b.nets() }),
    hdl: {
      verilog: `always_ff @(posedge clk) if (stall)
  count <= count == 4'd11 ? 4'd0 : count == 4'd0 && !dirtyV ? 4'd5 : count + 1;
assign word = count[1:0];
assign wb   = stall && dirtyV && count < 4;     // victim line → memory
assign fill = stall && count[3];                // memory → new line (8..11)
assign last = stall && count == 4'd11;          // write the tag`,
    },
  });
})();

/**
 * Main memory (2^k words) behind a write-back, write-allocate cache of 2^ib sets × ways × 4 words.
 * Loads and stores that miss stall: 8 cycles if the victim is clean, 12 if it is dirty (written back
 * first). Store hits only update the cache and set the line's dirty bit. With 2 ways an LRU bit per set
 * picks the victim.
 */
export function wbCache(k = 6, ib = 2, ways: 1 | 2 = 1): ComponentDef {
  const t = k - 2 - ib, la = ib + 2;
  const id = `wbcache${k}_${ib}_${ways}`;
  return memo(id, () => {
    const b = new Builder(18, 16);
    b.pins('addr', 'wd', 'we', 're', 'clk');
    const sa = b.op(splitter([2, 2, ib, t, 30 - k]), ['addr']);
    const off = b.name(`${sa}.o1`, 'offset', true), idx = b.name(`${sa}.o2`, 'index', true), tag = b.name(`${sa}.o3`, 'tag', true);
    b.next();
    const fsm = b.op(MISS_CTRL, ['', '', 'clk'], 'miss controller', 'fsm');
    const word = b.name(`${fsm}.word`, 'word', true), wbPh = b.name(`${fsm}.wb`, 'writeBack', true);
    const fill = b.name(`${fsm}.fill`, 'fill', true), last = b.name(`${fsm}.last`, 'last', true);
    // address of the word in the data arrays: the CPU's, or the line being moved
    const da = b.name(b.op1(busMux2(la), [b.op1(merger([2, ib]), [off, idx]), b.op1(merger([2, ib]), [word, idx]), ''], 'data address'), 'daddr', true);
    b.next();
    const W = Array.from({ length: ways }, (_, w) => b.op(cacheWay(ib, t), [idx, tag, da, '', '', '', '', 'clk'], `way ${w}`, `way${w}`));
    b.next();
    // hit, the hitting way, and the victim way
    const hit = b.name(ways === 1 ? `${W[0]}.hit` : b.op1(OR, [`${W[0]}.hit`, `${W[1]}.hit`], 'hit'), 'hit', true);
    const access = b.name(b.op1(OR, ['re', 'we'], 'access'), 'access', true);
    const stall = b.name(b.op1(AND, [access, b.op1(NOT, [hit])], 'miss: stall'), 'stall', true);
    const storeHit = b.name(b.op1(AND, ['we', hit], 'store hit'), 'storeHit', true);
    let hitWay = '', victim = '';
    if (ways === 2) {
      hitWay = b.name(`${W[1]}.hit`, 'hitWay', true);
      const lru = b.op(ram(ib, 1), [idx, b.op1(NOT, [hitWay]), b.op1(AND, [access, hit]), 'clk'], 'LRU bit per set', 'lru');
      victim = b.name(`${lru}.dout`, 'victim', true);
    }
    b.next();
    const pick = (s: string, d0: string, d1: string, w: number, label?: string) => (ways === 1 ? d0 : b.op1(w === 1 ? MUX2 : busMux2(w), [d0, d1, s], label));
    const vOut = (port: string, w: number) => pick(victim, `${W[0]}.${port}`, ways === 2 ? `${W[1]}.${port}` : '', w);
    const dirtyV = b.name(b.op1(AND, [vOut('dirty', 1), vOut('valid', 1)], 'victim dirty'), 'dirtyV', true);
    const vTag = b.name(vOut('stag', t), 'victimTag', true);
    const vData = b.name(vOut('dout', 32), 'victimData', true);
    const rd = pick(hitWay, `${W[0]}.dout`, ways === 2 ? `${W[1]}.dout` : '', 32, 'hit way');
    b.wire(stall, `${fsm}.stall`);
    b.wire(dirtyV, `${fsm}.dirtyV`);
    b.wire(stall, `${da.split('.')[0]}.s`);
    b.next();
    // main memory: written only with victim lines, read only to fill
    const ma = b.op1(busMux2(k), [b.op1(merger([2, ib, t]), [word, idx, tag], 'fill address'), b.op1(merger([2, ib, t]), [word, idx, vTag], 'write-back address'), wbPh]);
    const mem = b.op(ram(k, 32), [ma, vData, wbPh, 'clk'], 'main memory', 'ram');
    b.next();
    const dIn = b.name(b.op1(busMux2(32), ['wd', `${mem}.dout`, stall], 'store / fill data'), 'dataIn', true);
    const dirtyIn = b.name(b.op1(NOT, [stall], 'dirty if a store'), 'dirtyIn', true);
    // per way: data write (fill into the victim, or a store hit into the hitting way) and tag write
    W.forEach((nm, w) => {
      const isV = ways === 1 ? '' : w === 1 ? victim : b.op1(NOT, [victim]);
      const isH = ways === 1 ? '' : w === 1 ? hitWay : b.op1(NOT, [hitWay]);
      const fillW = ways === 1 ? fill : b.op1(AND, [fill, isV]);
      const lastW = ways === 1 ? last : b.op1(AND, [last, isV]);
      const storeW = ways === 1 ? storeHit : b.op1(AND, [storeHit, isH]);
      b.wire(b.op1(OR, [fillW, storeW], `way ${w} data we`), `${nm}.dwe`);
      b.wire(b.op1(OR, [lastW, storeW], `way ${w} tag we`), `${nm}.twe`);
      b.wire(dIn, `${nm}.din`);
      b.wire(dirtyIn, `${nm}.dirtyIn`);
    });
    b.next();
    b.wire(rd, 'rd');
    b.wire(stall, 'stall');
    b.wire(hit, 'hit');
    const R = b.right;
    const bytes = 16 * 2 ** ib * ways;
    return define({
      id, name: `${4 * 2 ** k}-byte memory with a ${bytes}-byte write-back cache${ways === 2 ? ' (2-way)' : ''}`, category: 'memory',
      summary: `Main memory of ${2 ** k} words behind a ${ways === 2 ? '2-way set-associative' : 'direct-mapped'} write-back, write-allocate cache: ${2 ** ib} sets × ${ways} way${ways > 1 ? 's' : ''} × 4 words. Store hits stay in the cache (dirty bit). A miss, load or store, stalls ${WB_MISS_CLEAN} cycles, or ${WB_MISS_DIRTY} when the victim line is dirty and must be written back first.${ways === 2 ? ' An LRU bit per set picks the victim.' : ''}`,
      ports: [bus('addr', 32, 'in'), bus('wd', 32, 'in'), bit('we', 'in'), bit('re', 'in'), bit('clk', 'in', 'bottom', true), bus('rd', 32, 'out'), bit('stall', 'out'), bit('hit', 'out')],
      symbol: { kind: 'box', label: ways === 2 ? 'WB 2-WAY $ + MEM' : 'WB D$ + MEM' },
      netlist: () => ({ pins: { addr: [0, 4], wd: [0, 8], we: [0, 12], re: [0, 16], clk: [0, 22], rd: [R, 4], stall: [R, 8], hit: [R, 12] }, instances: b.instances, nets: b.nets() }),
      hdl: {
        verilog: `// per access: hit if any way's {valid, tag} matches
assign stall = (re | we) & ~hit;
always_ff @(posedge clk) begin
  if (we & hit) begin data[way][{idx, off}] <= wd; dirty[way][idx] <= 1; end
  if (wb)   mem[{vtag, idx, word}]      <= data[victim][{idx, word}];   // dirty victim out
  if (fill) data[victim][{idx, word}]   <= mem[{tag, idx, word}];       // new line in
  if (last) {dirty, valid, tags}[victim][idx] <= {1'b0, 1'b1, tag};
${ways === 2 ? '  if ((re | we) & hit) lru[idx] <= ~hitway;\n' : ''}end`,
      },
    });
  });
}

/**
 * An instruction cache in front of the instruction ROM: read-only, direct-mapped, 2^ib lines of 4
 * instructions. Same ports as the ROM (addr → data) plus stall, hit and clk. A miss stalls 8 cycles
 * while the line is copied from the ROM (which stands for slow main memory).
 */
export function iCache(rom: ComponentDef, ib = 3, k = 6): ComponentDef {
  const t = k - 2 - ib, la = ib + 2;
  const id = `icache${ib}_${rom.id}`;
  return memo(id, () => {
    const b = new Builder(18, 16);
    b.pins('addr', 'clk');
    const sa = b.op(splitter([2, 2, ib, t, 30 - k]), ['addr']);
    const off = b.name(`${sa}.o1`, 'offset', true), idx = b.name(`${sa}.o2`, 'index', true), tag = b.name(`${sa}.o3`, 'tag', true);
    const zero = b.op1(TIE0, []);
    b.next();
    const fsm = b.op(MISS_CTRL, ['', zero, 'clk'], 'miss controller', 'fsm');
    const word = b.name(`${fsm}.word`, 'word', true);
    const da = b.op1(busMux2(la), [b.op1(merger([2, ib]), [off, idx]), b.op1(merger([2, ib]), [word, idx]), ''], 'data address');
    // the ROM reads the line being filled: byte address {tag, index, word, 00}
    const z2 = b.op1(constWord(2, 0), []), zh = b.op1(constWord(30 - k, 0), []);
    const romAddr = b.op1(merger([2, 2, ib, t, 30 - k]), [z2, word, idx, tag, zh], 'line address');
    b.next();
    const mem = b.op(rom, [romAddr], 'instruction memory', 'rom');
    b.next();
    const way = b.op(cacheWay(ib, t), [idx, tag, da, `${mem}.data`, `${fsm}.fill`, `${fsm}.last`, zero, 'clk'], 'cache', 'way0');
    b.next();
    const stall = b.name(b.op1(NOT, [`${way}.hit`], 'miss: stall'), 'stall', true);
    b.wire(stall, `${fsm}.stall`);
    b.wire(stall, `${da.split('.')[0]}.s`);
    b.next();
    b.wire(`${way}.dout`, 'data');
    b.wire(stall, 'stall');
    b.wire(`${way}.hit`, 'hit');
    const R = b.right;
    return define({
      id, name: `Instruction cache (${2 ** ib} lines × 4 instructions)`, category: 'memory',
      summary: `A read-only direct-mapped cache of ${2 ** ib} lines × 4 instructions in front of the instruction memory. Every fetch is an access; a miss stalls ${WB_MISS_CLEAN} cycles while the line is copied in (4 cycles of latency, then a word per cycle). Loops that fit hit every time.`,
      ports: [bus('addr', 32, 'in'), bit('clk', 'in', 'bottom', true), bus('data', 32, 'out'), bit('stall', 'out', 'bottom'), bit('hit', 'out', 'bottom')],
      symbol: { kind: 'box', label: 'I-CACHE + ROM' },
      netlist: () => ({ pins: { addr: [0, 4], clk: [0, 10], data: [R, 4], stall: [R, 8], hit: [R, 12] }, instances: b.instances, nets: b.nets() }),
    });
  });
}
