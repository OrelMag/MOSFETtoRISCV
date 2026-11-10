// .dig export (editor/digexport.ts): every chip of every Examples gallery workspace written as Digital files, read
// back by our own importer (import/digital.ts), compiled and simulated beside the original. A chip whose export says
// it is exact must read back with no import problems and compute the same outputs: a whole truth table for small
// combinational chips, a seeded run with clock pulses for the rest. A part with no Digital equivalent gets a problem line.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { digExport, MAX_FILES } from '../src/editor/digexport';
import { EXAMPLES, addExample } from '../src/editor/examples';
import { UserLibrary } from '../src/editor/library';
import { emptyWorkspace, SCHEMA, type ChipDoc, type Workspace } from '../src/editor/model';
import { importDigital } from '../src/import/digital';
import { parseXml } from '../src/import/xml';
import { estimateInstances } from '../src/sim/flatten';
import { simulate } from '../src/sim/harness';
import type { ComponentDef } from '../src/sim/types';
import { tick } from './yieldtick';

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

/** Outputs of both chips, step by step: the same inputs, clocks pulsed; the first difference, or null. */
function compare(a: ComponentDef, b: ComponentDef, clocks: Set<string>): string | null {
  const sa = simulate(a), sb = simulate(b);
  sa.reset('zero');
  sb.reset('zero');
  const ins = a.ports.filter((p) => p.dir === 'in'), outs = a.ports.filter((p) => p.dir === 'out');
  const data = ins.filter((p) => !clocks.has(p.name));
  const read = (s: typeof sa) => outs.map((p) => s.getBits(s.design.root.ports[p.name]).join('')).join(' ');
  const set = (name: string, bits: number[]) => { sa.setInputBits(name, bits); sb.setInputBits(name, bits); };
  const settle = (what: string) => { sa.settle(); sb.settle(); const x = read(sa), y = read(sb); return x === y ? null : `${what}: ${x} against ${y}`; };
  const total = data.reduce((n, p) => n + p.width, 0);
  const steps: number[][][] = [];
  if (!clocks.size && total <= 12) {
    for (let v = 0; v < 2 ** total; v++) {
      let k = 0;
      steps.push(data.map((p) => Array.from({ length: p.width }, () => (v >> k++) & 1)));
    }
  } else {
    const r = rng(total * 7919 + outs.length);
    for (let i = 0; i < 40; i++) steps.push(data.map((p) => Array.from({ length: p.width }, () => (r() < 0.5 ? 1 : 0))));
  }
  for (const c of clocks) set(c, [0]);
  for (const [i, s] of steps.entries()) {
    data.forEach((p, j) => set(p.name, s[j]));
    const d = settle(`step ${i}`);
    if (d) return d;
    for (const c of clocks) {
      set(c, [1]);
      const e = settle(`step ${i}, ${c} rises`);
      if (e) return e;
      set(c, [0]);
      const f = settle(`step ${i}, ${c} falls`);
      if (f) return f;
    }
  }
  return null;
}

/** Instances past which an exact chip is read back but not simulated (a whole CPU core: minutes on two GateSims). */
const SIM_MAX = 20_000;
const workspaces = EXAMPLES.map((ex) => ({ ex, ...addExample(emptyWorkspace(), ex) }));

describe('.dig export', () => {
  it('writes Digital files: version 2, the top first, sub-circuits by file name, XML that reads back', () => {
    const { ws, id } = workspaces.find((w) => w.ex.id === 'verilog-adder')!;
    const out = digExport(ws, id);
    expect(out.files[0].name).toBe(out.top);
    for (const f of out.files) {
      expect(f.text).toMatch(/^<\?xml version="1.0" encoding="utf-8"\?>\n<circuit>\n {2}<version>2<\/version>/);
      expect(f.name).toMatch(/^[a-z0-9_]+\.dig$/);
    }
    expect(new Set(out.files.map((f) => f.name.toLowerCase())).size).toBe(out.files.length);
    const r = importDigital(out.files, { taken: new Set() });
    expect(r).not.toHaveProperty('error');
  });

  it('names what it cannot write: a part with no Digital element and no gates is an empty circuit, with a problem line', () => {
    const { ws, id } = workspaces.find((w) => w.ex.id === 'console')!;
    const out = digExport(ws, id);
    expect(out.exact).toBe(false);
    expect(out.problems.some((p) => /console/i.test(p) && /empty circuit/.test(p)), out.problems.join('\n')).toBe(true);
  });

  it('every Examples chip exports; the exact ones read back without problems and compute the same', async () => {
    let compared = 0, exact = 0, chips = 0, large = 0;
    const failures: string[] = [];
    for (const { ex, ws } of workspaces) {
      for (const id of Object.keys(ws.chips)) {
        chips++;
        const out = digExport(ws, id);
        expect(out.files.length, `${ex.id} ${id}`).toBeLessThanOrEqual(MAX_FILES + 1);
        // every file is XML, and every circuit a file places is one of the files (Digital finds them by name)
        const names = new Set(out.files.map((f) => f.name));
        for (const f of out.files) {
          expect(() => parseXml(f.text), `${ex.id} ${id} ${f.name}`).not.toThrow();
          for (const m of f.text.matchAll(/<elementName>([^<]+\.dig)<\/elementName>/g)) expect(names.has(m[1]), `${f.name} places ${m[1]}`).toBe(true);
          expect(f.text, f.name).not.toMatch(/<data>[^<]*\*|Splitting<\/string>\s*<string>[^<]*\*/);
        }
        if (!out.exact) { expect(out.problems.length, `${ex.id} ${id}: inexact with no problem line`).toBeGreaterThan(0); continue; }
        exact++;
        const a = new UserLibrary(ws).defOf(id)!;
        const r = importDigital(out.files, { taken: new Set() });
        if ('error' in r) { failures.push(`${ex.id} ${id}: ${r.error}`); continue; }
        if (r.problems.length) { failures.push(`${ex.id} ${id}: import problems: ${r.problems.slice(0, 3).join('; ')}`); continue; }
        const back: Workspace = { schema: SCHEMA, chips: Object.fromEntries(r.chips.map((c: ChipDoc) => [c.id, c])), open: [r.top] };
        const lb = new UserLibrary(back), b = lb.defOf(r.top)!;
        const errs = lb.compiled(r.top)!.diags.filter((d) => d.level === 'error');
        if (errs.length) { failures.push(`${ex.id} ${id}: ${errs.map((d) => d.msg).join('; ')}`); continue; }
        const portsA = a.ports.map((p) => `${p.dir}:${p.name}:${p.width}`), portsB = new Set(b.ports.map((p) => `${p.dir}:${p.name}:${p.width}`));
        const missing = portsA.filter((p) => !portsB.has(p));
        if (missing.length) { failures.push(`${ex.id} ${id}: ports ${missing.join(', ')} not read back`); continue; }
        if (estimateInstances(a) > SIM_MAX) { large++; await tick(); continue; }
        const clocks = new Set(ws.chips[id].pins.filter((p) => p.kind === 'clock' || (p.dir === 'in' && /^(clk|clock)$/i.test(p.name))).map((p) => p.name));
        const d = compare(a, b, clocks);
        if (d) failures.push(`${ex.id} ${id}: ${d}`);
        else compared++;
        await tick();
      }
    }
    console.log(`.dig export: ${chips} chips, ${exact} exact, ${compared} compared, ${large} read back but too large to simulate`);
    expect(failures).toEqual([]);
    expect(compared).toBeGreaterThanOrEqual(50);
    expect(large, 'the RV64 and vector cores read back').toBeGreaterThanOrEqual(2);
  }, 300_000);
});
