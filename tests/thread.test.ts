// The thread (campaign/thread.ts): its data names real levels, dependents and anatomy blocks; every act of the
// main path has an end card; the numbers its texts quote are measured; and the derived pieces (the "Goes into"
// chain, the anatomy a level lights, "Now within reach", act seams) behave.

import { describe, expect, it } from 'vitest';
import { ACT_ENDS } from '../src/campaign/actends';
import { BLOCKS } from '../src/campaign/anatomy';
import { caseIds, caseOf } from '../src/campaign/cases';
import { coreTests } from '../src/campaign/coretests';
import { corePeriod, memLeaf } from '../src/campaign/corecheck';
import { dependents, type NodeState } from '../src/campaign/graph';
import { libCost } from '../src/campaign/measure';
import { CHAR_W, FOOT_LABEL_W, mapLayout, NODE_H, SUB_LINE, SUB_LINES, SUB_Y, wrapText } from '../src/campaign/layout';
import { ACTS, NODES, nodeById } from '../src/campaign/nodes';
import {
  actDone, actEnd, actNext, endLinks, blockUse, cardBlock, closedAct, goesInto, pitfallsOf, requiredOf, sideQuest, threadIds, threadOf, usedLater, whyStack, withinReach,
} from '../src/campaign/thread';
import { CTL_WIDTHS, rv16Core } from '../src/lib/rv16/cpu';
import { resolveComponent } from '../src/lib/resolve';
import { flatten } from '../src/sim/flatten';
import { stats } from '../src/sim/stats';
import { analyzeTiming } from '../src/sim/timing';
import type { ComponentDef } from '../src/sim/types';
import { netlistOf } from '../src/sim/types';

const par = (id: string) => nodeById(id)!.par!;
const nand = (id: string) => libCost(id)!.nand;
/** As the texts write numbers: a space between thousands. */
const fmt = (v: number) => String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const plain = (html: string) => html.replace(/<[^>]+>/g, '');
const blocks = new Set(BLOCKS.map((b) => b.id));
const view = (done: string[]) => (id: string): NodeState | undefined => (done.includes(id) ? { status: 'solved' } : undefined);

describe('thread data', () => {
  it('names real levels, dependents, blocks and side quests', () => {
    for (const id of threadIds()) {
      const n = nodeById(id);
      expect(n, id).toBeDefined();
      const t = threadOf(id)!;
      const deps = new Set(dependents(id).map((d) => d.id));
      for (const k of Object.keys(t.usedFor ?? {})) expect(deps.has(k), `${id}.usedFor.${k} is not a dependent`).toBe(true);
      for (const b of t.uses ?? []) expect(b === 'all' || blocks.has(b), `${id}.uses ${b}`).toBe(true);
      if (t.side) expect(nodeById(t.side)?.optional, `${id}.side`).toBe(true);
      for (const p of t.pitfalls ?? []) expect(p.length).toBeGreaterThan(10);
    }
  });

  it('fills acts 1–2 (the pilot): uses, a clause for every required consumer, pitfalls', () => {
    for (const n of NODES.filter((m) => (m.act === 1 || m.act === 2))) {
      const t = threadOf(n.id);
      expect(t?.uses?.length || n.anatomy?.length, `${n.id} uses`).toBeTruthy();
      expect(t?.pitfalls?.length, `${n.id} pitfalls`).toBeTruthy();
      for (const d of dependents(n.id)) if (!d.optional) expect(t?.usedFor?.[d.id], `${n.id} → ${d.id}`).toBeTruthy();
    }
  });

  it('has an end card for every act of the main path', () => {
    for (let a = 0; a <= 7; a++) expect(actEnd(a), `act ${a}`).toBeDefined();
    for (const [k, e] of Object.entries(ACT_ENDS)) {
      expect(ACTS.some((a) => a.num === Number(k))).toBe(true);
      if (e.next) {
        const n = nodeById(e.next)!;
        expect(n, e.next).toBeDefined();
        expect(n.optional).toBeFalsy();
        expect(n.act).not.toBe(Number(k));
      }
      for (const sq of e.sides ?? []) expect(nodeById(sq.node)?.optional, sq.node).toBe(true);
    }
  });

  it('offers act 7’s three optional acts, memory first, as links on the card and the map footer', () => {
    const links = endLinks(ACT_ENDS[7]);
    expect(links.map((l) => [l.node.id, l.node.act, l.side])).toEqual([['m_lesson', 10, true], ['k_lesson', 9, true], ['o_lesson', 8, true]]);
    for (const l of links) expect(l.label).toContain(`Act ${l.node.act}`);
    // act 5 closes with Core IV and goes on to the pipeline; the next level leads, its label kept
    expect(endLinks(ACT_ENDS[5])[0]).toMatchObject({ side: false, label: 'Act 6: cut the path into stages' });
    expect(endLinks(ACT_ENDS[5])[0].node.id).toBe('pi_lesson');
    expect(requiredOf(5).map((n) => n.id)).toContain('c_fast');
    const L = mapLayout(1, new Set(), { blurb: () => undefined, end: (a) => ({ ...ACT_ENDS[a], links: endLinks(ACT_ENDS[a]).map((l) => l.label) }) }, new Set([7]));
    const foot = L.bands.find((b) => b.act === 7)!.foot!;
    expect(foot.links.map((p) => p.label)).toEqual(links.map((l) => l.label));
    for (const p of foot.links) {
      expect(p.x + p.w).toBeLessThanOrEqual(L.w);
      expect(p.y).toBeLessThan(L.bands.find((b) => b.act === 7)!.y + L.bands.find((b) => b.act === 7)!.h);
    }
  });
});

describe('the numbers the thread quotes', () => {
  const T = (id: string) => Object.values(threadOf(id)?.usedFor ?? {}).concat(threadOf(id)?.pitfalls ?? []).join(' ');

  it('pins the act-end cards', () => {
    const e = (a: number) => plain(`${ACT_ENDS[a].can} ${ACT_ENDS[a].cannot}`);
    expect(libCost('nand')!.transistors).toBe(4);
    expect(e(0)).toContain('four transistors');
    expect(e(1)).toContain(`decoder, ${par('g_dec').nand} NANDs`);
    expect(e(1)).toContain(`${par('g_eq16').nand} NANDs, depth ${par('g_eq16').depth}`);
    expect(e(2)).toContain(`${fmt(par('a_alu16').nand!)} NANDs, depth ${par('a_alu16').depth}`);
    expect(e(2)).toContain(`depth ${par('o_fastadd').depth} instead of ${par('a_add16').depth}, for ${par('o_fastadd').nand} NANDs instead of ${par('a_add16').nand}`);
    expect(e(3)).toContain(`${fmt(par('m_rf').nand!)} NANDs`);
    const half = par('m_rf').nand! / par('c_core3').nand!;
    expect(half).toBeGreaterThan(0.4);
    expect(half).toBeLessThan(0.5);
    expect(e(4)).toContain(`${par('p_mul').cycles} on average`);
    expect(plain(caseOf('p_mul')!.cost!)).toContain('28 to 134');
    const c3 = par('c_core3');
    expect(e(5)).toContain(`${fmt(c3.nand!)} NANDs, one instruction per ${c3.period}-delay cycle, the ${coreTests(3).length} test programs in ${fmt(c3.period! * c3.cycles!)} NAND delays`);
    const c4 = par('c_fast');
    expect(c4.cycles).toBe(c3.cycles);
    expect(e(5)).toContain(`${fmt(stats(rv16Core(true, true)).nands)} NANDs at period ${c4.period}, ${fmt(c4.period! * c4.cycles!)} delays`);
    const p3 = par('pi_core3');
    expect(e(6)).toContain(`period ${p3.period} (${fmt(p3.nand!)} NANDs)`);
    expect(e(6)).toContain(`${Math.round(100 * (1 - (p3.period! * p3.cycles!) / (c3.period! * c3.cycles!)))}% faster than Core III, and slower than Core IV`);
    expect(p3.period! * p3.cycles!).toBeGreaterThan(c4.period! * c4.cycles!);
    expect(e(7)).toContain(`${fmt(par('y_final').nand!)} NANDs`);
  });

  it('pins the ALU\'s share of the single-cycle critical path', () => {
    const core = rv16Core(true);
    expect(corePeriod(core)).toBe(par('c_core3').period);
    const IMEM = memLeaf('bench_imem', 'instruction memory'), DMEM = memLeaf('bench_dmem', 'data memory');
    const bench: ComponentDef = {
      id: 'bench_thread', name: 'core bench', category: 'cpu', symbol: { kind: 'box' },
      ports: [{ name: 'clk', width: 1, dir: 'in' }, { name: 'rst', width: 1, dir: 'in' }],
      netlist: () => ({
        instances: [{ name: 'core', def: core }, { name: 'imem', def: IMEM }, { name: 'dmem', def: DMEM }],
        nets: [{ ends: ['clk', 'core.clk'] }, { ends: ['rst', 'core.rst'] }, { ends: ['core.pc', 'imem.addr'] }, { ends: ['imem.data', 'core.instr'] },
          { ends: ['core.daddr', 'dmem.addr'] }, { ends: ['dmem.data', 'core.drdata'] }],
      }),
    };
    const r = analyzeTiming(flatten(bench, { mode: 'gate' }))!;
    const alu = netlistOf(core)!.instances.find((i) => i.def.id === 'rv16_alu16')!.name;
    const inAlu = r.path.filter((p) => p.node[0] === 'core' && p.node[1] === alu).length;
    expect(plain(ACT_ENDS[5].can)).toContain(`ALU was ${inAlu} of those ${r.period} delays`);
  });

  it('pins the pilot\'s clauses and pitfalls', () => {
    expect(T('g_eq16')).toContain(`${nand('rv16_eq16')} of the comparator's ${nand('rv16_branch')} NANDs`);
    expect(T('a_slt')).toContain(`${nand('rv16_cmp16')} of the comparator's ${nand('rv16_branch')} NANDs`);
    expect(T('a_shift16')).toContain(`${nand('rv16_shift16')} of its ${fmt(nand('rv16_alu16'))} NANDs`);
    expect(T('g_wide')).toContain(`${nand('rv16_wide16')} of its ${nand('rv16_eq16')} NANDs`);
    expect(T('g_wide')).toContain(`depth ${par('g_wide').depth}`);
    expect(T('a_add16')).toContain(`depth ${par('a_add16').depth} against ${par('o_fastadd').depth}`);
    expect(T('a_ha')).toContain(`${nand('full_adder_ha')} NANDs; par ${par('a_fa').nand}`);
    expect(T('a_ha')).toContain(`par ${par('a_ha').nand}`);
    expect(T('a_inc16')).toContain(`${nand('inc16') - par('a_inc16').nand!} NANDs over par`);
    expect(T('g_mux8')).toContain(`${nand('mux2x16') - par('g_mux8').nand!} NANDs over par`);
    expect(T('g_mux')).toContain(`${par('g_mux').nand} NANDs, depth ${par('g_mux').depth}`);
    expect(T('g_or')).toContain(`par is ${par('g_xor').nand}`);
    expect(T('g_sop')).toContain(`par ${par('g_sop').nand}`);
    expect(T('o_fastadd')).toContain(`from ${par('c_core3').period} to ${par('c_fast').period}`);
    expect(T('d_kmap')).toContain(`${CTL_WIDTHS.reduce((a, b) => a + b, 0)} output bits`);
    const rf = resolveComponent('rv16_rf')!;
    const read = netlistOf(rf)!.instances.filter((i) => stats(i.def).nands > 300);
    expect(read.length).toBe(2);
    expect(T('g_mux8')).toContain(`two 8:1 read ports, ${stats(read[0].def).nands} NANDs each`);
  });
});

describe('the why stack', () => {
  it('leads with the why and carries every case (map panel and level screen render this stack)', () => {
    for (const id of caseIds()) {
      const w = whyStack(id)!;
      expect(w, id).toBeDefined();
      expect(w.lead).toBe(nodeById(id)!.why);
      expect(w.problem).toBe(caseOf(id)!.problem);
    }
    // the program levels' cases, once shown nowhere
    for (const id of ['p_add', 'p_loop', 'p_mem', 'p_call', 'p_mul', 'p_handler', 'p_boot']) expect(whyStack(id)?.problem, id).toBeTruthy();
  });

  it('draws the 16-bit adder\'s chain to the ALU block', () => {
    const c = goesInto('a_add16')!;
    expect(c.nodes.map((n) => n.id)).toEqual(['a_add16', 'a_addsub16', 'a_alu16', 'c_core1']);
    expect(c.block).toEqual({ id: 'alu', label: 'ALU' });
    expect(goesInto('a_slt')!.nodes.slice(0, 2).map((n) => n.id)).toEqual(['a_slt', 'c_br']);
    expect(goesInto('a_slt')!.block).toEqual({ id: 'br', label: 'Branch' });
    // a universal brick goes everywhere; every chain ends in a core
    expect(goesInto('g_not')!.block).toBe('all');
    for (const id of ['g_dec', 'g_mux8', 'a_inc16', 'n_twos', 'g_not']) expect(goesInto(id)!.nodes.at(-1)!.kind, id).toBe('core');
    // the earliest core that holds it, not a pipeline core one hop nearer
    expect(goesInto('g_not')!.nodes.at(-1)!.id).toBe('c_core1');
  });

  it('lists the consumers, required first, with their clauses', () => {
    const l = usedLater('a_add16');
    expect(l[0].node.optional).toBeFalsy();
    expect(l.find((u) => u.node.id === 'c_npc')?.clause).toContain('pc + imm');
    expect(l.findIndex((u) => u.node.optional)).toBeGreaterThan(l.findIndex((u) => u.node.id === 'c_npc'));
  });

  it('merges a level\'s pitfalls with its codex mistakes, each once', () => {
    const n = nodeById('a_slt')!;
    const mine = threadOf('a_slt')!.pitfalls!;
    const out = pitfallsOf(n, (c) => (c === 'overflow' ? ['New one.', mine[0]] : undefined));
    expect(out).toEqual([...mine, 'New one.']);
  });
});

describe('the map\'s band texts', () => {
  const text = { blurb: (a: number) => ACTS.find((x) => x.num === a)?.blurb, end: actEnd };
  it('puts each blurb under its title and each end card at its band\'s foot, the levels between them', () => {
    const ended = new Set([0, 1, 2, 3, 4, 5, 6, 7]);
    for (const cols of [1, 2, 4, Infinity]) {
      const L = mapLayout(cols, new Set(), text, ended);
      for (const b of L.bands) {
        if (b.folded) continue;
        const ns = [...L.nodes.values()].filter((p) => p.node.act === b.act);
        expect(b.sub?.length, `act ${b.act}`).toBeGreaterThan(0);
        expect(b.sub!.length).toBeLessThanOrEqual(SUB_LINES);
        const subBottom = b.y + SUB_Y + (b.sub!.length - 1) * SUB_LINE + 4;
        for (const p of ns) expect(p.y, `${p.node.id} under the subtitle`).toBeGreaterThan(subBottom);
        if (actEnd(b.act)) {
          const f = b.foot!;
          expect(f, `act ${b.act} foot`).toBeDefined();
          for (const p of ns) expect(p.y + NODE_H, `${p.node.id} above the foot`).toBeLessThan(f.y - 28);
          expect(f.y + (f.can.length + f.cannot.length - 1) * SUB_LINE).toBeLessThan(b.y + b.h);
          // every line fits the map at the estimated character width
          for (const line of [...f.can, ...f.cannot]) expect(16 + FOOT_LABEL_W + line.length * CHAR_W).toBeLessThanOrEqual(L.w);
        }
      }
    }
  });

  it('wraps and cuts text', () => {
    expect(wrapText('a b c', 1000, 2)).toEqual(['a b c']);
    const w = wrapText('word '.repeat(100), 100, 2);
    expect(w.length).toBe(2);
    expect(w[1].endsWith('…')).toBe(true);
    expect(wrapText('<b>bold</b> &lt;x&gt;', 1000, 1)).toEqual(['bold <x>']);
  });
});

describe('anatomy', () => {
  it('lights the blocks a level names, all of them for a brick, the old rule otherwise', () => {
    expect(blockUse(nodeById('t_nand')!)).toMatchObject({ all: true, own: false });
    expect(blockUse(nodeById('t_nand')!)!.ids.length).toBe(BLOCKS.length);
    expect(blockUse(nodeById('a_slt')!)!.ids).toEqual(['br']);
    expect(blockUse(nodeById('a_alu16')!)).toEqual({ ids: ['alu'], all: false, own: true });
    // the inverter no longer lights the F/D pipeline register
    expect(blockUse(nodeById('t_inv')!)!.ids).not.toEqual(['p1']);
    expect(cardBlock(nodeById('g_not')!)).toEqual({ label: 'everywhere', all: true });
    expect(cardBlock(nodeById('m_rf')!)?.label).toBe('Registers');
  });
});

describe('after a pass', () => {
  it('lists what is now within reach, closest to ready first', () => {
    const r = withinReach('g_dec', view(['intro', 't_inv', 't_nand', 'g_not', 'g_and', 'g_or', 'g_wide', 'g_dec', 'g_mux', 'g_mux8']));
    const rf = r.find((x) => x.node.id === 'm_rf')!;
    expect(rf.done).toBe(2);
    expect(rf.total).toBe(3);
    expect(rf.missing.map((m) => m.id)).toEqual(['s_reg16']);
    expect(rf.clause).toBeTruthy();
    expect(r.every((x) => !x.node.optional)).toBe(true);
    for (let i = 1; i < r.length; i++) expect(r[i].missing.length).toBeGreaterThanOrEqual(r[i - 1].missing.length);
  });

  it('offers the side quest the thread names, else an optional dependent', () => {
    // fast adders are required now: the 16-bit adder's side quests are the multipliers
    expect(sideQuest('a_add16', view([]))?.optional).toBe(true);
    expect(sideQuest('a_add16', view([]))?.id).not.toBe('o_fastadd');
    expect(sideQuest('t_inv', view([]))?.id).toBe('t_nor');
  });

  it('knows when a pass closes an act, and where its card leads', () => {
    const act1 = requiredOf(1).map((n) => n.id);
    const v = view(['intro', 't_inv', 't_nand', ...act1]);
    expect(actDone(1, v)).toBe(true);
    expect(closedAct(nodeById('g_eq16')!, v)).toBe(1);
    expect(closedAct(nodeById('g_eq16')!, view(act1.slice(1)))).toBeUndefined();
    expect(actDone(1, view([]))).toBe(false);
    // the next act's first level, or its first open one when that is done
    const open = () => true;
    expect(actNext(ACT_ENDS[1], v, open)?.id).toBe('a_ha');
    expect(actNext(ACT_ENDS[1], view([...act1, 'a_ha']), open)?.act).toBe(2);
    expect(actNext(ACT_ENDS[1], view([...act1, 'a_ha']), open)?.id).not.toBe('a_ha');
  });
});
