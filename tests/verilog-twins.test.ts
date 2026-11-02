// Verilog twins (campaign/verilog.ts): a reference Verilog per twin passes its level's own check, a wrong one fails, a
// latch is refused with the line Yosys names, a wrong top module or pin set is reported. Yosys runs in Node (hdlkit).
import { describe, expect, it } from 'vitest';
import '../src/lib';
import { checkTwin, drawnNands, starsOf, TWINS, twinById, twinId, twinOf, twinReference, twinStart } from '../src/campaign/verilog';
import { nodeById } from '../src/campaign/nodes';
import { TWIN_LEVELS } from '../src/campaign/twinids';
import './hdlkit';

/** The stars each reference earns today (pinned: a change in the synthesizer or a level's par shows here). */

const withBody = (node: string, body: string) => { const t = twinOf(node)!; return twinStart(t).replace(t.start, body); };

describe('Verilog twins', () => {
  it('every twin names an existing build level, in acts 1 to 5, with a unique id', () => {
    const ids = new Set<string>();
    for (const t of TWINS) {
      const n = nodeById(t.twin);
      expect(n?.kind, t.twin).toBe('build');
      expect(n!.act).toBeGreaterThanOrEqual(1);
      expect(n!.act).toBeLessThanOrEqual(5);
      expect(twinById(twinId(t))).toBe(t);
      ids.add(twinId(t));
    }
    expect(ids.size).toBe(TWINS.length);
    // a few in each of the acts that have build levels among 2, 3, 5
    for (const act of [2, 3, 5]) expect(TWINS.filter((t) => nodeById(t.twin)!.act === act).length, `act ${act}`).toBeGreaterThanOrEqual(2);
  });

  it('the twinned levels of the map are the twins', () => {
    expect(TWIN_LEVELS).toEqual(TWINS.map((x) => x.twin));
  });

  it('grades by NANDs against the drawn reference', () => {
    expect(starsOf(10, 10)).toBe(3);
    expect(starsOf(15, 10)).toBe(2);
    expect(starsOf(16, 10)).toBe(1);
    expect(starsOf(0, 0)).toBe(3);
    expect(starsOf(1, 0)).toBe(1);
  });

  for (const t of TWINS) {
    it(`${t.twin}: the reference Verilog passes the level's check`, async () => {
      const r = await checkTwin(t, twinReference(t));
      expect(r.diags.filter((d) => d.level === 'error'), t.twin).toEqual([]);
      expect(r.check?.failures, t.twin).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.drawn).toBe(drawnNands(t));
      expect(r.ref).toBe(Math.max(r.drawn, r.verilog!));
      expect(r.stars, `${t.twin}: ${r.nand} NANDs against ${r.ref}`).toBe(3);
    }, 120_000);
  }

  it('the starting file has the right pins and fails the check (nothing is driven)', async () => {
    for (const t of TWINS) {
      const r = await checkTwin(t, twinStart(t));
      expect(r.ok, t.twin).toBe(false);
      expect(r.stars ?? 0).toBe(0);
      expect(r.diags.some((d) => /never driven/.test(d.msg)), t.twin).toBe(true);
    }
  }, 120_000);

  it('wrong designs fail with the level\'s own failure', async () => {
    const wrong: [string, string][] = [
      ['s_reg4', '  always @(posedge clk) q <= d;\n'],
      ['g_dec', '  assign y = 8\'d1 << a;\n'],
      ['s_cnt4', '  always @(posedge clk) q <= q + en;\n'],
      ['c_br', '  assign take = (cond[1] ? (a < b) : (a == b)) ^ cond[0];\n'],
    ];
    for (const [node, body] of wrong) {
      const r = await checkTwin(twinOf(node)!, withBody(node, body));
      expect(r.ok, node).toBe(false);
      expect(r.check?.failures.length, node).toBeGreaterThan(0);
      expect(r.stars, node).toBe(0);
    }
  }, 120_000);

  it('a latch is refused, with the line Yosys names', async () => {
    const src = withBody('g_dec', '  always @(*)\n    if (en) y = 8\'d1 << a;\n');
    const r = await checkTwin(twinOf('g_dec')!, src);
    expect(r.ok).toBe(false);
    const d = r.diags.find((x) => /latch/i.test(x.msg));
    expect(d?.level).toBe('error');
    expect(d?.line).toBeGreaterThan(0);
    expect(src.split('\n')[d!.line! - 1]).toMatch(/always|y/);
    expect(r.check).toBeUndefined();
  }, 60_000);

  it('a syntax error carries its line; a missing module and a wrong pin set are reported', async () => {
    const t = twinOf('s_reg4')!;
    const bad = twinStart(t).replace('endmodule', 'assign q = ;\nendmodule');
    const r1 = await checkTwin(t, bad);
    expect(r1.ok).toBe(false);
    expect(r1.diags.find((d) => d.level === 'error')?.line).toBeGreaterThan(0);
    const r2 = await checkTwin(t, 'module other(input a, output y); assign y = a; endmodule');
    expect(r2.diags[0].msg).toMatch(/reg4/);
    const r3 = await checkTwin(t, 'module reg4(input clk, input [3:0] d, output reg [3:0] q); always @(posedge clk) q <= d; endmodule');
    expect(r3.ok).toBe(false);
    expect(r3.check?.failures.join(' ')).toMatch(/en/);
  }, 120_000);
});

describe('twin progress', () => {
  it('records the best result under the twin id and keeps it through sanitizing; unknown ids are dropped', async () => {
    const { Progress, sanitizeCampaign, CAMPAIGN_KEY } = await import('../src/campaign/progress');
    const mem = new Map<string, string>();
    const kv = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
    const p = new Progress(kv);
    expect(p.solveTwin('vl_s_reg4', 1, 70)).toEqual({ first: true, best: true });
    expect(p.solveTwin('vl_s_reg4', 2, 60)).toEqual({ first: false, best: true });
    expect(p.solveTwin('vl_s_reg4', 1, 50)).toEqual({ first: false, best: false });
    p.setSource('vl_s_reg4', 'module reg4; endmodule');
    const again = new Progress(kv).get('vl_s_reg4');
    expect(again).toMatchObject({ status: 'solved', stars: 2, best: { nand: 60 }, src: 'module reg4; endmodule' });
    expect(mem.has(CAMPAIGN_KEY)).toBe(true);
    const st = sanitizeCampaign({ nodes: { vl_g_dec: { status: 'solved' }, vl_nonsense: { status: 'solved' } } });
    expect(Object.keys(st.nodes)).toEqual(['vl_g_dec']);
    // twins are outside the map's tallies and survive a merge (an import of a backup)
    expect(p.summary().done).toBe(0);
    const { mergeCampaign } = await import('../src/campaign/progress');
    const merged = mergeCampaign(p.state, sanitizeCampaign({ nodes: { vl_s_reg4: { status: 'solved', stars: 3, best: { nand: 52 } } } }));
    expect(merged.nodes.vl_s_reg4).toMatchObject({ status: 'solved', stars: 3 });
    // the learner-facing readers of the progress (My path's evidence, the backup summary) take it in stride
    const { summarize } = await import('../src/ui/backup');
    const { MapKV } = await import('../src/ui/backup');
    const s = summarize(new MapKV(mem));
    expect(s.campaignSolved).toBe(1);
  });
});
