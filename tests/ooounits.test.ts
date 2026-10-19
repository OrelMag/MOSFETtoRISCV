// The out-of-order core's units (lib/ooo.ts) against the rules of riscv/ooomodel.ts, cycle by cycle on random
// sequences: what each unit holds and answers must be what the model's own data structures hold and answer.

import { describe, expect, it } from 'vitest';
import { btbCommit } from '../src/lib/ooo';
import { simulate } from '../src/sim/harness';
import { lcg, out, set, tick } from './util';

/** The model's BTB (riscv/ooomodel.ts predict / trainBtb, 16 entries). */
class ModelBtb {
  e: ({ tag: number; target: number; ctr: number; jump: boolean } | null)[] = new Array(16).fill(null);
  predict(pc: number): [number, number] {
    const x = this.e[(pc >>> 2) % 16];
    return x && x.tag === Math.floor((pc >>> 2) / 16) && (x.jump || x.ctr >= 2) ? [1, x.target] : [0, -1];
  }
  train(pc: number, kind: 'branch' | 'jump', taken: boolean, next: number): void {
    const i = (pc >>> 2) % 16, tag = Math.floor((pc >>> 2) / 16), x = this.e[i];
    if (kind === 'branch') {
      if (x && x.tag === tag && !x.jump) {
        x.ctr = Math.max(0, Math.min(3, x.ctr + (taken ? 1 : -1)));
        if (taken) x.target = next;
      } else if (taken) this.e[i] = { tag, target: next, ctr: 2, jump: false };
    } else this.e[i] = { tag, target: next, ctr: 3, jump: true };
  }
}

describe('BTB trained at commit', () => {
  it('two lookups and two in-order trainings a cycle, as the model', () => {
    const s = simulate(btbCommit()), r = lcg(31), m = new ModelBtb();
    // a few pcs over two tags, so entries are shared, hit, missed and replaced
    const pcs = Array.from({ length: 24 }, (_, i) => ((i % 2 ? 0x1000 : 0) + 4 * r(20)) >>> 0);
    const pick = () => pcs[r(pcs.length)];
    set(s, { clk: 0, pcF0: 0, pcF1: 4, pcC0: 0, v0: 0, branch0: 0, jump0: 0, taken0: 0, next0: 0, pcC1: 0, v1: 0, branch1: 0, jump1: 0, taken1: 0, next1: 0 });
    for (let t = 0; t < 1500; t++) {
      const pc = pick();
      set(s, { pcF0: pc, pcF1: (pc + 4) >>> 0 });
      for (const [k, p] of [[0, pc], [1, (pc + 4) >>> 0]] as const) {
        const [pt, tgt] = m.predict(p);
        expect(out(s, `pt${k}`), `t ${t} slot ${k} at ${p.toString(16)}`).toBe(pt);
        if (pt) expect(out(s, `tgt${k}`) >>> 0, `t ${t} target ${k}`).toBe(tgt >>> 0);
      }
      const tr = [0, 1].map(() => ({ v: r(3) ? 1 : 0, pc: pick(), jump: r(4) === 0 ? 1 : 0, taken: r(2), next: pick() }));
      tr.forEach((x, k) => set(s, { [`pcC${k}`]: x.pc, [`v${k}`]: x.v, [`branch${k}`]: x.jump ? 0 : 1, [`jump${k}`]: x.jump, [`taken${k}`]: x.jump ? 1 : x.taken, [`next${k}`]: x.next }));
      tick(s);
      for (const x of tr) if (x.v) m.train(x.pc, x.jump ? 'jump' : 'branch', x.jump ? true : !!x.taken, x.next);
    }
  }, 120_000);
});
