import { describe, expect, it } from 'vitest';
import '../src/lib';
import { addExample, EXAMPLES } from '../src/editor/examples';
import { applyNetlist, bodyKey, detachGroup, hdlGroup, hdlHome, importNetlist, newVerilogChip, resynthesize, setSource, verilogModules } from '../src/editor/hdl';
import { UserLibrary } from '../src/editor/library';
import { emptyWorkspace } from '../src/editor/model';
import { sanitizeChip } from '../src/editor/store';
import type { Workspace } from '../src/editor/model';
import { setUserResolver } from '../src/lib/resolve';
import { evalOnce, forEachInput, simulate } from '../src/sim/harness';
import { synthesize } from '../src/hdl/yosys';
import { highlight } from '../src/editor/hdlui';
import './hdlkit';

const TWO = `module inv4(input [3:0] a, output [3:0] y); assign y = ~a; endmodule
module top(input [3:0] a, b, output [3:0] y, output z);
  wire [3:0] t;
  inv4 u(.a(a & b), .y(t));
  assign y = t;
  assign z = ^a;
endmodule`;

const compile = (ws: Workspace, id: string) => {
  const lib = new UserLibrary(ws);
  setUserResolver(lib.resolver());
  const errs = Object.keys(ws.chips).flatMap((c) => lib.compiled(c)!.diags.filter((d) => d.level === 'error').map((d) => `${c}: ${d.msg}`));
  expect(errs).toEqual([]);
  return lib.defOf(id)!;
};

async function synthed(ws: Workspace, home: string): Promise<Workspace> {
  const o = await resynthesize(ws, home);
  if (!o.ok) throw new Error(o.diags.map((d) => d.msg).join('; '));
  return o.ws;
}

describe('Verilog chips (hdl.ts)', () => {
  it('scans module names without Yosys', () => {
    expect(verilogModules(TWO)).toEqual(['inv4', 'top']);
    expect(verilogModules('// module fake\n/* module no */ module real_1 #(parameter W = 4) (); endmodule')).toEqual(['real_1']);
  });

  it('a new chip is stale until synthesized; then one chip per module, the top on the home chip', async () => {
    const r = newVerilogChip(emptyWorkspace(), TWO, 'two.v');
    const home = r.ws.chips[r.id];
    expect(home.hdl).toMatchObject({ module: 'top', stale: true, src: { file: 'two.v', gates: 'std' } });
    const ws = await synthed(r.ws, r.id);
    const group = hdlGroup(ws, r.id);
    expect(group.map((c) => c.hdl!.module)).toEqual(['top', 'inv4']);
    expect(ws.chips[r.id].hdl!.stale).toBeUndefined();
    expect(hdlHome(ws, group[1].id)!.id).toBe(r.id);
    const def = compile(ws, r.id);
    const sim = simulate(def);
    forEachInput(def, ([a, b]) => {
      const par = [0, 1, 2, 3].reduce((p, i) => p ^ ((a >> i) & 1), 0);
      expect(evalOnce(sim, [a, b])).toEqual([~(a & b) & 15, par]);
    });
  }, 60_000);

  it('keeps chip ids across edits, so a parent placing the chip keeps its wires', async () => {
    const r = newVerilogChip(emptyWorkspace(), TWO, 'two.v');
    let ws = await synthed(r.ws, r.id);
    const inv = hdlGroup(ws, r.id)[1].id;
    ws = setSource(ws, r.id, { text: TWO.replace('assign z = ^a;', 'assign z = &b;') });
    expect(ws.chips[r.id].hdl!.stale).toBe(true);
    ws = await synthed(ws, r.id);
    expect(hdlGroup(ws, r.id).map((c) => c.id)).toEqual([r.id, inv]);
    // Renaming the top module still lands on the home chip.
    ws = await synthed(setSource(ws, r.id, { text: TWO.replace('module top', 'module top2') }), r.id);
    expect(ws.chips[r.id].hdl!.module).toBe('top2');
  }, 60_000);

  it('a module gone from the text is deleted, or detached when another chip places it', async () => {
    const r = newVerilogChip(emptyWorkspace(), TWO, 'two.v');
    let ws = await synthed(r.ws, r.id);
    const inv = hdlGroup(ws, r.id)[1].id;
    const flat = TWO.replace('inv4 u(.a(a & b), .y(t));', 'assign t = ~(a & b);');
    const gone = await synthed(setSource(ws, r.id, { text: flat }), r.id);
    expect(gone.chips[inv]).toBeUndefined();
    // Another chip places inv4: it survives as a drawn chip.
    ws = { ...ws, chips: { ...ws.chips, u_user: { id: 'u_user', name: 'user', pins: [], parts: [{ id: 'x', ref: { chip: inv }, at: [4, 4] }], wires: [], labels: [] } } };
    const kept = await synthed(setSource(ws, r.id, { text: flat }), r.id);
    expect(kept.chips[inv]).toBeDefined();
    expect(kept.chips[inv].hdl).toBeUndefined();
  }, 60_000);

  it('a text with errors keeps the last drawing and says where', async () => {
    const r = newVerilogChip(emptyWorkspace(), TWO, 'two.v');
    const ws = await synthed(r.ws, r.id);
    const before = bodyKey(ws.chips[r.id]);
    const bad = setSource(ws, r.id, { text: TWO.replace('assign y = t;', 'assign y = t') });
    const o = await resynthesize(bad, r.id);
    expect(o.ok).toBe(false);
    expect(o.diags[0]).toMatchObject({ level: 'error', file: 'two.v', line: 6 });
    expect(bodyKey(bad.chips[r.id])).toBe(before);
  }, 60_000);

  it('detach makes every chip of the group a drawn chip', async () => {
    const r = newVerilogChip(emptyWorkspace(), TWO, 'two.v');
    const ws = await synthed(r.ws, r.id);
    const d = detachGroup(ws, hdlGroup(ws, r.id)[1].id);
    expect(d.ids.length).toBe(2);
    for (const id of d.ids) expect(d.ws.chips[id].hdl).toBeUndefined();
  }, 60_000);

  it('survives the store sanitizer (saved, exported, shared)', async () => {
    const r = newVerilogChip(emptyWorkspace(), TWO, 'two.v');
    const ws = await synthed(r.ws, r.id);
    for (const c of hdlGroup(ws, r.id)) expect(sanitizeChip(JSON.parse(JSON.stringify(c)))).toEqual(c);
  }, 60_000);

  it('imports a Yosys netlist as drawn chips', async () => {
    const y = await synthesize({ 'two.v': TWO });
    const r = importNetlist(emptyWorkspace(), y.json);
    if ('error' in r) throw new Error(r.error);
    expect(r.added.length).toBe(2);
    for (const id of r.added) expect(r.ws.chips[id].hdl).toBeUndefined();
    compile(r.ws, r.top);
  }, 60_000);

  it('applyNetlist refuses a design it cannot draw, keeping the chip', async () => {
    const r = newVerilogChip(emptyWorkspace(), 'module m(inout a); endmodule', 'm.v');
    const y = await synthesize({ 'm.v': 'module m(inout a); endmodule' });
    const o = applyNetlist(r.ws, r.id, y.json);
    expect(o.ok).toBe(false);
    expect(o.diags.at(-1)!.msg).toContain('inout');
  }, 60_000);

  it('Examples ▸ the same adder in Verilog: both adders give the same sums', async () => {
    const ex = EXAMPLES.find((e) => e.id === 'verilog-adder')!;
    const { ws, id } = addExample(emptyWorkspace(), ex);
    const home = Object.values(ws.chips).find((c) => c.hdl?.src)!;
    const done = await synthed(ws, home.id);
    expect(done.chips[home.id].pins.map((p) => p.name)).toEqual(expect.arrayContaining(['a', 'b', 'ci', 's', 'co']));
    const def = compile(done, id);
    const sim = simulate(def);
    forEachInput(def, ([a, b, ci]) => {
      const t = a + b + ci;
      expect(evalOnce(sim, [a, b, ci])).toEqual([t & 15, t >> 4, t & 15, t >> 4]);
    });
  }, 60_000);

  it('highlights Verilog line by line, block comments across lines', () => {
    const l = highlight('module m; /* a\nb */ wire [3:0] x = 4\'hA; // c\n$display("hi");');
    expect(l[0]).toContain('<i class="kw">module</i>');
    expect(l[1]).toMatch(/^<i class="cm">b \*\/<\/i>/);
    expect(l[1]).toContain('<i class="nm">4\'hA</i>');
    expect(l[2]).toContain('<i class="sys">$display</i>');
  });
});
