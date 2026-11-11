// Transparent boxes, measurement 2 and renders (prototype, not product). Built on its own (vite.config.ts beside it) from the
// site's real renderer: SchematicView, ViewCtx, svgImage. Driven by drive.mjs over the DevTools Protocol.
//   ?mode=measure  every child level of three CPU tops: ctx.child (sub-simulation or reuse), view.show (wires-first + route
//                  + DOM), view.update (live values), the DOM size; results in window.__out
//   ?mode=render&theme=light|dark&w=..&h=..  the single-cycle CPU's top level and its ALU's inside with live values after a
//                  few clock cycles, as standalone SVGs, with the ALU box's rectangle in the top's coordinates
import '../../../src/styles/fonts.css';
import '../../../src/styles/theme.css';
import '../../../src/styles/palettes.css';
import '../../../src/styles/app.css';
import '../../../src/styles/vivid.css';
import '../../../src/styles/cmos.css';
import '../../../src/lib';
import { singleCycleCpu } from '../../../src/lib/cpu';
import { pipelinedCpu } from '../../../src/lib/pipeline';
import { oooCpu } from '../../../src/lib/ooocore';
import { assemble } from '../../../src/riscv/asm';
import { PROGRAMS } from '../../../src/riscv/programs';
import { flatten } from '../../../src/sim/flatten';
import { GateSim } from '../../../src/sim/gatesim';
import { ViewCtx } from '../../../src/view/context';
import { SchematicView } from '../../../src/view/schematic';
import { svgImage } from '../../../src/view/image';
import { applyTheme, settings } from '../../../src/ui/settings';
import type { ComponentDef } from '../../../src/sim/types';

const q = new URLSearchParams(location.search);
settings.set('theme', (q.get('theme') as 'light' | 'dark') ?? 'light');
settings.set('board', q.get('board') !== 'off');
applyTheme();
const W = Number(q.get('w') ?? 1200), H = Number(q.get('h') ?? 800);
const host = document.getElementById('host')!;
host.style.cssText = `width:${W}px;height:${H}px;position:relative;overflow:hidden`;
host.className = 'canvas';

const noop = () => {};
const events = { open: noop, select: noop, toggleInput: noop, editInput: noop };
const words = assemble(PROGRAMS.find((p) => p.id === 'fib')!.source).words;
const tops: [string, () => ComponentDef][] = [
  ['single-cycle', () => singleCycleCpu(words)],
  ['pipeline', () => pipelinedCpu(words)],
  ['ooo', () => oooCpu(words, { imemK: 6, dmemK: 6 })],
];
const out: Record<string, unknown> = {};
(window as unknown as { __out: unknown }).__out = out;
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

function rootCtx(def: ComponentDef, cycles: number): ViewCtx {
  const design = flatten(def);
  const sim = new GateSim(design);
  sim.reset('zero');
  for (let i = 0; i < cycles; i++) { sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle(); }
  return new ViewCtx(sim, design.root);
}

async function measure(): Promise<void> {
  const rows: unknown[] = [];
  for (const [top, make] of tops) {
    let t = performance.now();
    const root = rootCtx(make(), 4);
    const buildMs = performance.now() - t;
    const view = new SchematicView(host, events);
    t = performance.now();
    view.show(root, true);
    await frame();
    rows.push({ top, inst: '(top)', id: root.def.id, showMs: performance.now() - t, buildMs, nodes: view.el.querySelectorAll('*').length });
    const seen = new Set<string>();
    for (const [name, child] of root.node.children ?? []) {
      if (seen.has(child.def.id) || !root.canOpen(name)) continue;
      seen.add(child.def.id);
      t = performance.now();
      const c = root.child(name);
      const ctxMs = performance.now() - t;
      if (!c) continue;
      t = performance.now();
      view.show(c, true);
      const showMs = performance.now() - t;
      // update() after a real clock edge (values changed), the median of 8 edges; the edge itself timed apart
      const ups: number[] = [], edges: number[] = [];
      for (let k = 0; k < 8; k++) {
        t = performance.now();
        root.sim.setInput('clk', 1); root.sim.settle(); root.sim.setInput('clk', 0); root.sim.settle();
        c.sync();
        edges.push(performance.now() - t);
        t = performance.now();
        view.update();
        ups.push(performance.now() - t);
      }
      ups.sort((a, b) => a - b); edges.sort((a, b) => a - b);
      const updateMs = ups[4], updateMax = ups[7], edgeMs = edges[4];
      await frame();
      rows.push({ top, inst: name, id: child.def.id, ctxMs, showMs, updateMs, updateMax, edgeMs, nodes: view.el.querySelectorAll('*').length, sub: c.isSubSim });
    }
    view.clear();
    host.replaceChildren();
    await frame();
  }
  out.rows = rows;
  out.done = true;
}

async function render(): Promise<void> {
  const root = rootCtx(singleCycleCpu(words), 6);
  const view = new SchematicView(host, events);
  view.show(root, true);
  view.fit();
  await frame(); await frame();
  const bg = getComputedStyle(host).backgroundColor;
  const g = view.el.querySelector<SVGGElement>('[data-inst="alu"]')!;
  const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(g.getAttribute('transform') ?? '')!;
  const b = g.getBBox();
  out.alu = { x: Number(m[1]) + b.x, y: Number(m[2]) + b.y, w: b.width, h: b.height };
  out.topBox = view.contentBox();
  out.top = svgImage(view.el, view.contentBox(), bg);
  const alu = root.child('alu')!;
  view.show(alu, true);
  view.fit();
  await frame(); await frame();
  out.aluBox = view.contentBox();
  out.inside = svgImage(view.el, view.contentBox(), bg);
  out.ports = alu.def.ports.map((p) => ({ name: p.name, dir: p.dir, width: p.width }));
  out.done = true;
}

void (q.get('mode') === 'render' ? render() : measure()).catch((e) => { out.error = String(e?.stack ?? e); out.done = true; });
