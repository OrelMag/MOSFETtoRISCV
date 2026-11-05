// Chapter "Keeping it secret" scenes (DOM-free: they only build circuits). Each root is the cipher part on a small bench whose wide inputs are
// constants wired from the NIST vectors: a Scene's `inputs` are JS numbers, exact to 53 bits, and a 128-bit key does not fit. The bench holds
// the vector, the part inside is the same registered part (aes_round, aes_core, sha_round, sha_core) the learner drills into.
//   aesRoundScene  FIPS 197 Appendix B, round 1 (start of round 19a0…, round key a088…): out = the start of round 2
//   sboxScene      the S-box alone, input 0x53 (the byte FIPS 197 §5.1.1 works through)
//   aesCoreScene   the core with Appendix B's block and key: press start, pulse eleven times, done, out = 3925841d…
//   shaRoundScene  the NIST example's round t = 0 on "abc": the working variables are the initial hash value
//   shaCoreScene   the compression core on the padded "abc" block with the initial hash value: 65 pulses, out = ba7816bf…
import type { Scene } from '../view/stage';
import { encryptTrace } from '../crypto/aes';
import { H0, K, blocksOf, utf8 } from '../crypto/sha256';
import { APPENDIX_B, SHA_ABC } from '../crypto/vectors';
import { aesCore, aesRound, aesSbox } from '../lib/aes';
import { constWord } from '../lib/alu';
import { Builder } from '../lib/builder';
import { define, merger } from '../lib/define';
import { shaCore, shaRound } from '../lib/sha256';
import type { ComponentDef, PortDef } from '../sim/types';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });

/** A bus held at a constant: one tied-off part per byte (or word), merged. */
function constBus(b: Builder, chunks: number[], width: 8 | 32): string {
  const parts = chunks.map((v) => b.op1(constWord(width, v), []));
  return b.op1(merger(new Array<number>(chunks.length).fill(width)), parts);
}

const benches = new Map<string, ComponentDef>();
const bench = (id: string, make: () => ComponentDef) => { let d = benches.get(id); if (!d) benches.set(id, (d = make())); return d; };

/** Round 1 of Appendix B on its own: the state the round starts from and the round key, as constants. */
function aesRoundBench(): ComponentDef {
  return bench('secret_aes_round_bench', () => {
    const t = encryptTrace(APPENDIX_B.input, APPENDIX_B.key), r = t.rounds[0];
    const b = new Builder(24, 14, 4);
    b.pins('last');
    const s = constBus(b, r.start, 8), k = constBus(b, r.roundKey, 8);
    b.next();
    const rd = b.op(aesRound(), [s, k, 'last'], 'round 1', 'round');
    b.next();
    b.wire(`${rd}.y`, 'y');
    return define({
      id: 'secret_aes_round_bench', name: 'AES round 1 of FIPS 197 Appendix B', category: 'arithmetic',
      summary: 'Round 1 of the standard\'s worked example: the state 19a0 9ae9 … and round key a088 232a … wired in as constants. Set last = 1 to see the final round, which skips MixColumns.',
      ports: [bit('last', 'in', 'bottom'), bus('y', 128, 'out')], symbol: { kind: 'box', label: 'ROUND 1' },
      netlist: () => ({ pins: { last: [0, 6], y: [b.right, 12] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

function aesCoreBench(): ComponentDef {
  return bench('secret_aes_core_bench', () => {
    const b = new Builder(24, 14, 4);
    b.pins('clk', 'rst', 'start');
    const k = constBus(b, APPENDIX_B.key, 8), m = constBus(b, APPENDIX_B.input, 8);
    b.next();
    const core = b.op(aesCore(), ['clk', 'rst', 'start', k, m], 'AES-128', 'core');
    b.next();
    b.wire(`${core}.out`, 'out'); b.wire(`${core}.done`, 'done');
    return define({
      id: 'secret_aes_core_bench', name: 'AES-128 core on the FIPS 197 Appendix B vector', category: 'sequential',
      summary: 'The iterative core with the standard\'s example block 3243 f6a8 … and key 2b7e 1516 … as constants. Raise start for one clock, then pulse: eleven clocks later done is 1 and out is 3925 841d …',
      ports: [bit('clk', 'in', 'bottom', true), bit('rst', 'in'), bit('start', 'in'), bus('out', 128, 'out'), bit('done', 'out')], symbol: { kind: 'box', label: 'AES-128' },
      netlist: () => ({ pins: { clk: [0, 6], rst: [0, 18], start: [0, 30], out: [b.right, 12], done: [b.right, 30] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** The round the NIST example table starts with: the working variables are H0, K[0], W[0] of the padded "abc". */
function shaRoundBench(): ComponentDef {
  return bench('secret_sha_round_bench', () => {
    const b = new Builder(24, 14, 4);
    const v = constBus(b, [...H0], 32), k = constBus(b, [K[0]], 32), w = constBus(b, [blocksOf(utf8(SHA_ABC))[0][0]], 32);
    b.next();
    const rd = b.op(shaRound(), [v, k, w], 'round 0', 'round');
    b.next();
    b.wire(`${rd}.y`, 'y');
    return define({
      id: 'secret_sha_round_bench', name: 'SHA-256 round 0 on "abc"', category: 'arithmetic',
      summary: 'Round t = 0 of the NIST example: a..h are the initial hash value, K[0] = 428a2f98 and W[0] = 61626380 ("abc" and the padding bit). The new a on y is 5d6aebcd.',
      ports: [bus('y', 256, 'out')], symbol: { kind: 'box', label: 'ROUND 0' },
      netlist: () => ({ pins: { y: [b.right, 12] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

function shaCoreBench(): ComponentDef {
  return bench('secret_sha_core_bench', () => {
    const b = new Builder(24, 14, 4);
    b.pins('clk', 'rst', 'start');
    const h = constBus(b, [...H0], 32), blk = constBus(b, blocksOf(utf8(SHA_ABC))[0], 32);
    b.next();
    const core = b.op(shaCore(), ['clk', 'rst', 'start', h, blk], 'SHA-256', 'core');
    b.next();
    b.wire(`${core}.out`, 'out'); b.wire(`${core}.done`, 'done');
    return define({
      id: 'secret_sha_core_bench', name: 'SHA-256 core on the NIST "abc" block', category: 'sequential',
      summary: 'The compression core with the initial hash value and the padded block of "abc" as constants. Raise start for one clock, then pulse: 65 clocks later done is 1 and out is ba7816bf 8f01cfea … (the SHA-256 of "abc").',
      ports: [bit('clk', 'in', 'bottom', true), bit('rst', 'in'), bit('start', 'in'), bus('out', 256, 'out'), bit('done', 'out')], symbol: { kind: 'box', label: 'SHA-256' },
      netlist: () => ({ pins: { clk: [0, 6], rst: [0, 18], start: [0, 30], out: [b.right, 12], done: [b.right, 30] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** The benches, for the tests that check every schematic (layout, routing). */
export const secretBenches = (): ComponentDef[] => [aesRoundBench(), aesCoreBench(), shaRoundBench(), shaCoreBench()];

export const sboxScene = (): Scene => ({ root: aesSbox(), inputs: { x: 0x53 }, autoClock: false });
export const aesRoundScene = (): Scene => ({ root: aesRoundBench(), inputs: { last: 0 }, autoClock: false });
export const aesCoreScene = (): Scene => ({ root: aesCoreBench(), inputs: { rst: 0, start: 0, clk: 0 }, clock: 'clk', autoClock: false });
export const shaRoundScene = (): Scene => ({ root: shaRoundBench(), autoClock: false });
export const shaCoreScene = (): Scene => ({ root: shaCoreBench(), inputs: { rst: 0, start: 0, clk: 0 }, clock: 'clk', autoClock: false });
