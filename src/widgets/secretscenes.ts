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
import { define, merger } from '../lib/define';
import { shaCore, shaRound } from '../lib/sha256';
import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });

const benches = new Map<string, ComponentDef>();
const bench = (id: string, make: () => ComponentDef) => { let d = benches.get(id); if (!d) benches.set(id, (d = make())); return d; };

/** The benches are drawn as a schematic: each constant bus is a column of tied-off parts at the merger's pitch (a wire each, straight),
 *  the cipher part sits in the middle at the height of its first constant bus, the farther bus runs under the nearer one and up to its
 *  port, and the control pins and outputs sit beside the part, so the whole bench fits a 16:10 stage. */
interface Col { chunks: number[]; width: 8 | 32 }
class Sheet {
  instances: InstanceDef[] = [];
  nets: NetDef[] = [];
  private n = 0;
  /** A bus column at (x, y): the constants at the merger's pitch of 2, the merger 8 to the right. */
  col(c: Col, x: number, y: number): { out: string; h: number; outAt: [number, number] } {
    const names = c.chunks.map((v, i) => {
      const nm = `u${this.n++}`;
      this.instances.push({ name: nm, def: constWord(c.width, v), at: [x, y + 2 * i] });
      return nm;
    });
    const m = `u${this.n++}`;
    this.instances.push({ name: m, def: merger(new Array<number>(c.chunks.length).fill(c.width)), at: [x + 8, y] });
    names.forEach((nm, i) => this.nets.push({ ends: [`${nm}.y`, `${m}.i${i}`] }));
    const h = 2 * c.chunks.length;
    return { out: `${m}.out`, h, outAt: [x + 9, y + h / 2] };
  }
  part(def: ComponentDef, at: [number, number], label: string | undefined, name: string): void { this.instances.push({ name, def, at, label }); }
  net(name: string | undefined, ends: string[], via?: [number, number][]): void {
    this.nets.push({ name, ends, via: via ? { [ends[1]]: via } : undefined });
  }
}

/** Two constant buses into a cipher part (the near one at the upper port, the far one under it), the control pins beside the part. */
function coreBench(near: Col, far: Col, part: ComponentDef, label: string, portNear: string, portFar: string): { sh: Sheet; pins: Record<string, [number, number]> } {
  const sh = new Sheet();
  const hMax = Math.max(2 * near.chunks.length, 2 * far.chunks.length), mid = hMax / 2;
  const k = sh.col(near, 14, mid - near.chunks.length), m = sh.col(far, 0, mid - far.chunks.length);
  const g = symbolGeom(part), cx = 36, cy = mid - g.ports[portNear].pos[1];
  sh.part(part, [cx, cy], label, 'core');
  const bottom = hMax + 3;
  sh.net(undefined, [k.out, `core.${portNear}`]);
  sh.net(undefined, [m.out, `core.${portFar}`], [[m.outAt[0] + 2, m.outAt[1]], [m.outAt[0] + 2, bottom], [cx - 4, bottom], [cx - 4, cy + g.ports[portFar].pos[1]]]);
  const pins: Record<string, [number, number]> = {};
  for (const p of ['rst', 'start']) { pins[p] = [cx - 8, cy + g.ports[p].pos[1]]; sh.net(p, [p, `core.${p}`]); }
  pins.clk = [cx + g.ports.clk.pos[0], cy + g.h + 4]; sh.net('clk', ['clk', 'core.clk']);
  pins.out = [cx + g.w + 6, cy + g.ports.out.pos[1]]; sh.net(undefined, ['core.out', 'out']);
  pins.done = [cx + g.w + 6, cy + g.ports.done.pos[1]]; sh.net(undefined, ['core.done', 'done']);
  return { sh, pins };
}

/** Round 1 of Appendix B on its own: the state the round starts from and the round key, as constants. */
function aesRoundBench(): ComponentDef {
  return bench('secret_aes_round_bench', () => {
    const t = encryptTrace(APPENDIX_B.input, APPENDIX_B.key), r = t.rounds[0];
    const sh = new Sheet();
    const s = sh.col({ chunks: r.start, width: 8 }, 14, 0), k = sh.col({ chunks: r.roundKey, width: 8 }, 0, 0);
    const rd = aesRound(), g = symbolGeom(rd), cx = 36, cy = s.outAt[1] - g.ports.s.pos[1];
    sh.part(rd, [cx, cy], 'round 1', 'round');
    const bottom = s.h + 3;
    sh.net(undefined, [s.out, 'round.s']);
    sh.net(undefined, [k.out, 'round.k'], [[k.outAt[0] + 2, k.outAt[1]], [k.outAt[0] + 2, bottom], [cx - 4, bottom], [cx - 4, cy + g.ports.k.pos[1]]]);
    sh.net('last', ['last', 'round.last']);
    sh.net(undefined, ['round.y', 'y']);
    const pins = { last: [cx + g.ports.last.pos[0], cy + g.h + 4] as [number, number], y: [cx + g.w + 6, cy + g.ports.y.pos[1]] as [number, number] };
    return define({
      id: 'secret_aes_round_bench', name: 'AES round 1 of FIPS 197 Appendix B', category: 'arithmetic',
      summary: 'Round 1 of the standard\'s worked example: the state 19a0 9ae9 … and round key a088 232a … wired in as constants. Set last = 1 to see the final round, which skips MixColumns.',
      ports: [bit('last', 'in', 'bottom'), bus('y', 128, 'out')], symbol: { kind: 'box', label: 'ROUND 1' },
      netlist: () => ({ pins, instances: sh.instances, nets: sh.nets }),
    });
  });
}

function aesCoreBench(): ComponentDef {
  return bench('secret_aes_core_bench', () => {
    const { sh, pins } = coreBench({ chunks: APPENDIX_B.key, width: 8 }, { chunks: APPENDIX_B.input, width: 8 }, aesCore(), 'AES-128', 'key', 'in');
    return define({
      id: 'secret_aes_core_bench', name: 'AES-128 core on the FIPS 197 Appendix B vector', category: 'sequential',
      summary: 'The iterative core with the standard\'s example block 3243 f6a8 … and key 2b7e 1516 … as constants. Raise start for one clock, then pulse: eleven clocks later done is 1 and out is 3925 841d …',
      ports: [bit('clk', 'in', 'bottom', true), bit('rst', 'in'), bit('start', 'in'), bus('out', 128, 'out'), bit('done', 'out')], symbol: { kind: 'box', label: 'AES-128' },
      netlist: () => ({ pins, instances: sh.instances, nets: sh.nets }),
    });
  });
}

/** The round the NIST example table starts with: the working variables are H0, K[0], W[0] of the padded "abc". */
function shaRoundBench(): ComponentDef {
  return bench('secret_sha_round_bench', () => {
    const sh = new Sheet();
    const v = sh.col({ chunks: [...H0], width: 32 }, 0, 0);
    const rd = shaRound(), g = symbolGeom(rd), cx = 20, cy = v.outAt[1] - g.ports.v.pos[1];
    // k and w are single words: tied-off parts right at their ports
    const k = sh.col({ chunks: [K[0]], width: 32 }, cx - 11, cy + g.ports.k.pos[1] - 1);
    const w = sh.col({ chunks: [blocksOf(utf8(SHA_ABC))[0][0]], width: 32 }, cx - 11, cy + g.ports.w.pos[1] - 1);
    sh.part(rd, [cx, cy], 'round 0', 'round');
    sh.net(undefined, [v.out, 'round.v']);
    sh.net(undefined, [k.out, 'round.k']);
    sh.net(undefined, [w.out, 'round.w']);
    sh.net(undefined, ['round.y', 'y']);
    const pins = { y: [cx + g.w + 6, cy + g.ports.y.pos[1]] as [number, number] };
    return define({
      id: 'secret_sha_round_bench', name: 'SHA-256 round 0 on "abc"', category: 'arithmetic',
      summary: 'Round t = 0 of the NIST example: a..h are the initial hash value, K[0] = 428a2f98 and W[0] = 61626380 ("abc" and the padding bit). The new a on y is 5d6aebcd.',
      ports: [bus('y', 256, 'out')], symbol: { kind: 'box', label: 'ROUND 0' },
      netlist: () => ({ pins, instances: sh.instances, nets: sh.nets }),
    });
  });
}

function shaCoreBench(): ComponentDef {
  return bench('secret_sha_core_bench', () => {
    const { sh, pins } = coreBench({ chunks: [...H0], width: 32 }, { chunks: blocksOf(utf8(SHA_ABC))[0], width: 32 }, shaCore(), 'SHA-256', 'h', 'blk');
    return define({
      id: 'secret_sha_core_bench', name: 'SHA-256 core on the NIST "abc" block', category: 'sequential',
      summary: 'The compression core with the initial hash value and the padded block of "abc" as constants. Raise start for one clock, then pulse: 65 clocks later done is 1 and out is ba7816bf 8f01cfea … (the SHA-256 of "abc").',
      ports: [bit('clk', 'in', 'bottom', true), bit('rst', 'in'), bit('start', 'in'), bus('out', 256, 'out'), bit('done', 'out')], symbol: { kind: 'box', label: 'SHA-256' },
      netlist: () => ({ pins, instances: sh.instances, nets: sh.nets }),
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
