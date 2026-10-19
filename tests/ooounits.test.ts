// The out-of-order core's units (lib/ooo.ts) against the rules of riscv/ooomodel.ts, cycle by cycle on random
// sequences: what each unit holds and answers must be what the model's own data structures hold and answer.

import { describe, expect, it } from 'vitest';
import { btbCommit, issueQueue, RAT } from '../src/lib/ooo';
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

/** The issue queue's rules, kept in plain TypeScript: entries with their dispatch order. */
interface Ent { seq: number; port: number; load: number; div: number; lat2: number; tagA: number; rdyA: number; valA: number; tagB: number; rdyB: number; valB: number; smask: number; pay: number }

describe('issue queue', () => {
  it('each port picks its oldest ready entry; wakeup, loads behind stores, bus slots, the divider, allocation, flush', () => {
    const P = 8, s = simulate(issueQueue(P)), r = lcg(41);
    const ents: (Ent | null)[] = new Array(8).fill(null);
    let seq = 0;
    const fields = ['port', 'load', 'div', 'lat2', 'tagA', 'rdyA', 'valA', 'tagB', 'rdyB', 'valB', 'smask', 'pay'] as const;
    const zeroSlot = (k: number) => Object.fromEntries(fields.map((f) => [`s${k}_${f}`, 0]));
    set(s, { clk: 0, alloc0: 0, alloc1: 0, ...zeroSlot(0), ...zeroSlot(1), bv0: 0, bt0: 0, bx0: 0, bv1: 0, bt1: 0, bx1: 0, sdone: 0, busNext0: 0, busNext1: 0, divFree: 0, flush: 0 });
    let picked = 0;
    for (let t = 0; t < 3000; t++) {
      const startFree = [0, 1, 2, 3, 4, 5, 6, 7].filter((i) => !ents[i]), nFree = startFree.length;
      const mk = (): Ent => {
        const port = r(2), load = port === 0 && r(4) === 0 ? 1 : 0, div = port === 1 && !load && r(8) === 0 ? 1 : 0;
        return { seq: 0, port, load, div, lat2: load || (!div && r(4) === 0) ? 1 : 0, tagA: r(16), rdyA: r(3) ? 0 : 1, valA: r(2 ** 32), tagB: r(16), rdyB: r(2) ? 0 : 1, valB: r(2 ** 32), smask: load ? r(16) : 0, pay: r(256) };
      };
      const want0 = nFree >= 1 && r(3) > 0, want1 = r(3) > 0 && nFree >= (want0 ? 2 : 1);
      const n0 = mk(), n1 = mk();
      const io = {
        alloc0: want0 ? 1 : 0, alloc1: want1 ? 1 : 0,
        ...Object.fromEntries(fields.map((f) => [`s0_${f}`, n0[f]])), ...Object.fromEntries(fields.map((f) => [`s1_${f}`, n1[f]])),
        bv0: r(2), bt0: r(16), bx0: r(2 ** 32), bv1: r(2), bt1: r(16), bx1: r(2 ** 32), sdone: r(16),
        busNext0: r(3) === 0 ? 1 : 0, busNext1: r(3) === 0 ? 1 : 0, divFree: r(2), flush: r(150) === 0 ? 1 : 0,
      };
      set(s, io);
      // what the queue must answer now
      const wake = (tag: number) => (io.bv0 && io.bt0 === tag) || (io.bv1 && io.bt1 === tag);
      const bus = (tag: number) => (io.bv1 && io.bt1 === tag ? io.bx1 : io.bx0);
      const ready = (e: Ent) => (e.rdyA || wake(e.tagA)) && (e.rdyB || wake(e.tagB)) && !(e.load && (e.smask & ~io.sdone & 15));
      const ok = (e: Ent) => (e.div ? io.divFree === 1 : e.lat2 === 1 || (e.port ? io.busNext1 : io.busNext0) === 0);
      const grant = [0, 1].map((p) => {
        let best = -1;
        ents.forEach((e, i) => { if (e && e.port === p && ready(e) && ok(e) && (best < 0 || e.seq < ents[best]!.seq)) best = i; });
        return best;
      });
      expect([out(s, 'free1'), out(s, 'free2')], `t ${t} free`).toEqual([nFree >= 1 ? 1 : 0, nFree >= 2 ? 1 : 0]);
      for (const p of [0, 1]) {
        const g = grant[p];
        expect(out(s, `go${p}`), `t ${t} go${p}`).toBe(g >= 0 ? 1 : 0);
        if (g >= 0) {
          const e = ents[g]!;
          picked++;
          expect([out(s, `pay${p}`), out(s, `load${p}`), out(s, `div${p}`), out(s, `lat2${p}`)], `t ${t} port ${p} picks ${g}`).toEqual([e.pay, e.load, e.div, e.lat2]);
          expect(out(s, `opA${p}`) >>> 0, `t ${t} opA${p}`).toBe((e.rdyA ? e.valA : bus(e.tagA)) >>> 0);
          expect(out(s, `opB${p}`) >>> 0, `t ${t} opB${p}`).toBe((e.rdyB ? e.valB : bus(e.tagB)) >>> 0);
        }
        expect(out(s, `cnt${p}`), `t ${t} cnt${p}`).toBe(ents.filter((e, i) => e && e.port === p && grant[0] !== i && grant[1] !== i).length);
      }
      tick(s);
      // the next state
      for (let i = 0; i < 8; i++) {
        const e = ents[i];
        if (!e) continue;
        if (grant[0] === i || grant[1] === i) { ents[i] = null; continue; }
        if (!e.rdyA && wake(e.tagA)) { e.rdyA = 1; e.valA = bus(e.tagA); }
        if (!e.rdyB && wake(e.tagB)) { e.rdyB = 1; e.valB = bus(e.tagB); }
        e.smask &= ~io.sdone & 15;
      }
      // allocation: the lowest entries free at the start of the cycle (a picked one is free from the next)
      let k = 0;
      if (want0) ents[startFree[k++]] = { ...n0, seq: seq++ };
      if (want1) ents[startFree[k++]] = { ...n1, seq: seq++ };
      if (io.flush) ents.fill(null);
    }
    expect(picked).toBeGreaterThan(1000);
  }, 300_000);
});

describe('rename table', () => {
  it('maps each register to its youngest in-flight writer, as the model\'s rat()', () => {
    const s = simulate(RAT), r = lcg(53);
    let inflight: { tag: number; rd: number }[] = [];
    let tail = 0;
    set(s, { clk: 0, rs1_0: 0, rs2_0: 0, rs1_1: 0, rs2_1: 0, rd0: 0, we0: 0, tag0: 0, rd1: 0, we1: 0, tag1: 0, crd0: 0, cv0: 0, ctag0: 0, crd1: 0, cv1: 0, ctag1: 0, flush: 0 });
    const youngest = (list: { tag: number; rd: number }[], reg: number) => {
      if (!reg) return [0, -1];
      for (let i = list.length - 1; i >= 0; i--) if (list[i].rd === reg) return [1, list[i].tag];
      return [0, -1];
    };
    for (let t = 0; t < 2000; t++) {
      const nC = Math.min(inflight.length, r(3)), room = 16 - inflight.length;
      const nD = Math.min(room, r(3));
      const reg = () => (r(4) === 0 ? 0 : 1 + r(8));
      const disp = Array.from({ length: nD }, () => ({ tag: 0, rd: reg() }));
      disp.forEach((d) => { d.tag = tail; tail = (tail + 1) % 16; });
      const src = [reg(), reg(), reg(), reg()];
      const flush = r(80) === 0 ? 1 : 0;
      const io: Record<string, number> = { rs1_0: src[0], rs2_0: src[1], rs1_1: src[2], rs2_1: src[3], flush };
      [0, 1].forEach((k) => {
        io[`we${k}`] = k < nD ? 1 : 0; io[`rd${k}`] = disp[k]?.rd ?? 0; io[`tag${k}`] = disp[k]?.tag ?? 0;
        io[`cv${k}`] = k < nC ? 1 : 0; io[`crd${k}`] = inflight[k]?.rd ?? 0; io[`ctag${k}`] = inflight[k]?.tag ?? 0;
      });
      set(s, io);
      // lookups see the mappings at the start of the cycle; slot 1's also slot 0's destination
      const want = [youngest(inflight, src[0]), youngest(inflight, src[1]),
        youngest([...inflight, ...disp.slice(0, 1)], src[2]), youngest([...inflight, ...disp.slice(0, 1)], src[3])];
      ['a0', 'b0', 'a1', 'b1'].forEach((nm, i) => {
        expect(out(s, `${nm}v`), `t ${t} ${nm} mapped`).toBe(want[i][0]);
        if (want[i][0]) expect(out(s, `${nm}t`), `t ${t} ${nm} tag`).toBe(want[i][1]);
      });
      tick(s);
      inflight = [...inflight.slice(nC), ...disp];
      if (flush) { inflight = []; }
    }
  }, 120_000);
});
