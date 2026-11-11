// Chapter "Designing state machines" (chapters/ch-fsm.ts): every number its prose quotes is computed here from the machines of
// lib/fsmbook.ts, held to the figures the codex entries type, and the circuits are held to their diagrams (read-back), to the
// reference model (GCD) and to the claims about timing and unused codes.

import { describe, expect, it } from 'vitest';
import { CODEX, codexById } from '../src/campaign/codex';
import { CHECKS } from '../src/campaign/codexcheck';
import { ALIASES_FSM, CODEX_FSM, FSM_AWAITING_LEVELS } from '../src/campaign/codexfsm';
import { moreOf } from '../src/campaign/codexmore';
import { Glossary } from '../src/campaign/glossary';
import { NODES, nodeById } from '../src/campaign/nodes';
import { chFsm } from '../src/chapters/ch-fsm';
import { chapters } from '../src/chapters';
import { numOf } from '../src/chapters/order';
import { TAUGHT } from '../src/chapters/taught';
import { equation } from '../src/editor/ttable';
import { nextTable, outTable } from '../src/editor/fsmchip';
import { fsmdStep, GCD_FSMD, type FsmdState } from '../src/editor/fsmd';
import {
  CANDIDATES, candidateCircuit, circuitNands, codeCosts, debounceBits, fsmCircuit, fsmSpecOf, fsmTableChip, gcdCircuit, gcdCosts, gcdRun, MEALY101, MOORE101, RING3, ringCircuit, runFsm,
  runPair, TRAFFIC, TRAFFIC_START, upset, kmapHtml,
} from '../src/lib/fsmbook';
import { BUTTON3, debouncer, debounceSamples } from '../src/lib/debounce';
import { readbackOk, readbackSpec, readFsm } from '../src/sim/fsmread';
import { simulate } from '../src/sim/harness';
import { stats } from '../src/sim/stats';
import { pack } from '../src/sim/values';

const text = (id: string) => (codexById(id)!.body + JSON.stringify(moreOf(id))).replace(/<[^>]+>/g, ' ').replace(/\\'/g, "'");

describe('the cost of the codes (step 3, codex stateenc)', () => {
  const c = codeCosts();
  it('the 101 detector: flip-flops / logic / NANDs of binary, Gray and one-hot, from the builder\'s own count', () => {
    expect(c.mealy.map((x) => [x.enc, x.dffs, x.logic, x.nands])).toEqual([['binary', 2, 10, 32], ['gray', 2, 15, 37], ['onehot', 3, 18, 51]]);
    expect(c.moore.map((x) => x.nands)).toEqual([36, 51, 74]);
  });
  it('and the circuit the builder makes has that many NANDs', () => {
    for (const enc of ['binary', 'gray', 'onehot'] as const) {
      const est = (k: 'mealy' | 'moore') => c[k].find((x) => x.enc === enc)!.nands;
      // binary and Gray are the estimate exactly; the one-hot circuit shares a couple of gates the estimate counts
      expect(circuitNands('mealy', { ...MEALY101, encoding: enc })).toBe(enc === 'onehot' ? 49 : est('mealy'));
      expect(circuitNands('moore', { ...MOORE101, encoding: enc })).toBe(enc === 'onehot' ? 71 : est('moore'));
    }
  });
  it('every encoding reads back as the same diagram', () => {
    for (const doc of [MEALY101, MOORE101]) for (const enc of ['binary', 'gray', 'onehot'] as const) {
      const d = { ...doc, encoding: enc };
      const r = readFsm(simulate(fsmCircuit(doc === MEALY101 ? 'mealy' : 'moore', d)), fsmSpecOf(d, true));
      expect(readbackOk(r), `${doc === MEALY101 ? 'Mealy' : 'Moore'} ${enc}`).toBe(true);
    }
  });
  it('the text of the codex entry quotes them', () => {
    const t = text('stateenc');
    for (const n of ['32 / 37 / 51', '36 / 51 / 74']) expect(t).toContain(n);
    expect(t).toMatch(/binary\s+2\s+10\s+32\s+36/);
    expect(t).toMatch(/Gray\s+2\s+15\s+37\s+51/);
    expect(t).toMatch(/one-hot\s+3\s+18\s+51\s+74/);
  });
  it('a ring controller with two entering arcs per state (6 states: a table takes 8 inputs at most): one-hot logic per bit is an OR of two terms (the step\'s quiz)', () => {
    // 12 states in a ring, each entered from one state (plus itself on hold): one-hot next-state bit = a short OR
    const ring = { ins: ['go'], outs: ['y'], states: Array.from({ length: 6 }, (_, i) => ({ name: `Q${i}`, at: [60 + 30 * i, 100] as [number, number] })),
      arcs: Array.from({ length: 6 }, (_, i) => [{ from: i, to: (i + 1) % 6, when: { go: 1 as const } }, { from: i, to: i, when: { go: 0 as const } }]).flat(),
      reset: 0, encoding: 'onehot' as const, form: 'nand' as const };
    const t = nextTable(ring, 'onehot');
    for (let j = 0; j < 6; j++) expect(equation(t, j).split('+').length, equation(t, j)).toBe(2);
  });
});

describe('Moore against Mealy (step 2)', () => {
  const run = runPair([1, 0, 1, 0, 1, 1, 0]);
  it('the Mealy y rises in the cycle the last 1 arrives, the Moore y in the next', () => {
    expect(run.map((r) => r.mealy)).toEqual([0, 0, 1, 0, 1, 0, 0]);
    expect(run.map((r) => r.moore)).toEqual([0, 0, 0, 1, 0, 1, 0]);
  });
  it('the Moore version costs a state and some NANDs: 4 states in 2 bits, 36 against 32', () => {
    expect(MOORE101.states.length).toBe(4);
    expect(MEALY101.states.length).toBe(3);
  });
});

describe('from the table to the logic (step 4)', () => {
  it('the equations the step prints, and the rows of the table', () => {
    const t = nextTable(MEALY101), o = outTable(MEALY101);
    expect([equation(t, 0), equation(t, 1), equation(o, 0)]).toEqual(['n1 = s0·¬x', 'n0 = x', 'y = s1·x']);
    expect(t.rows).toEqual(['001000--', '010101--']);
    expect(kmapHtml(t, 0)).toContain('<td class="km one">1</td>');
  });
  it('the reach: from the unused code 11 with x = 0 the minimized logic goes to S2 (n1 n0 = 1 0)', () => {
    const sim = simulate(fsmTableChip('mealy', MEALY101, 'next'));
    for (const [k, v] of Object.entries({ s1: 1, s0: 1, x: 0 })) sim.setInput(k, v);
    sim.settle();
    expect([pack(sim.getBits(sim.design.root.ports.n1)), pack(sim.getBits(sim.design.root.ports.n0))]).toEqual([1, 0]);
  });
});

describe('unused codes (step 5)', () => {
  it('with don\'t cares every single upset of the one-hot sequencer is permanent; the safe version comes back to a hot state', () => {
    for (let s = 0; s < 3; s++) for (let b = 0; b < 3; b++) {
      const free = upset(false, s, b), safe = upset(true, s, b);
      expect(free.held, `${s}/${b}`).toBe(true);
      expect(free.valid, `free ${s}/${b}`).toBe(false);
      expect(safe.valid, `safe ${s}/${b}`).toBe(true);
    }
  });
  it('the all-zero code maps to itself and the two-hot codes rotate for good (a multiple of three edges returns to the same code)', () => {
    expect(upset(false, 0, 0).after).toBe(0);
    const two = upset(false, 0, 1, 6);
    expect(two.code).toBe(0b011);
    expect(upset(false, 0, 1, 9).after).toBe(two.code);
    expect(upset(false, 0, 1, 7).after).not.toBe(two.code);
  });
  it('safe costs more: the step quotes both counts', () => {
    expect(stats(ringCircuit(false)).nands).toBe(51);
    expect(stats(ringCircuit(true)).nands).toBe(96);
  });
  it('the sequencer steps A, B, C, A while go = 1', () => {
    const sim = simulate(ringCircuit(false));
    sim.setInput('go', 1); sim.setInput('rst', 1); sim.setInput('clk', 0); sim.settle();
    const tick = () => { sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle(); };
    tick(); sim.setInput('rst', 0); sim.settle();
    const lamps = () => ['a', 'b', 'c'].map((p) => pack(sim.getBits(sim.design.root.ports[p]))).join('');
    const seen = [lamps()];
    for (let i = 0; i < 3; i++) { tick(); seen.push(lamps()); }
    expect(seen).toEqual(['100', '010', '001', '100']);
    expect(RING3.states.length).toBe(3);
  });
});

describe('read it back (step 6)', () => {
  const spec = fsmSpecOf(MEALY101, true);
  const reads = CANDIDATES.map((c) => readFsm(simulate(candidateCircuit(c.key)), spec));
  it('only circuit B is the diagram; A has one wrong arc, C two', () => {
    expect(reads.map((r) => readbackOk(r))).toEqual([false, true, false]);
    expect(CANDIDATES.map((c) => c.right)).toEqual([false, true, false]);
    expect(reads.map((r) => r.arcs.filter((a) => !a.ok).length)).toEqual([1, 0, 2]);
  });
  it('all three report the plain 1, 0, 1; on 1, 0, 1, 0, 1 they differ (the overlap)', () => {
    for (const c of CANDIDATES) expect(runFsm(candidateCircuit(c.key), [1, 0, 1]).join(''), c.name).toMatch(c.key === 'c' ? /010/ : /001/);
    expect(CANDIDATES.map((c) => runFsm(candidateCircuit(c.key), [1, 0, 1, 0, 1]).join(''))).toEqual(['00100', '00101', '01010']);
  });
  it('the read-back draws the wrong arcs red over the diagram', () => {
    const drawn = readbackSpec(spec, reads[0]);
    expect(drawn.arcs.some((a) => a.cls === 'bad')).toBe(true);
    expect(drawn.arcs.some((a) => a.cls === 'spec')).toBe(true);
    expect(readbackSpec(spec, reads[1]).arcs.some((a) => a.cls === 'bad')).toBe(false);
  });
});

describe('a controller and a datapath (step 7)', () => {
  const ref = gcdRun(48, 18);
  it('gcd(48, 18): 10 edges to DONE with 6 in a, the reference model\'s count', () => {
    expect(ref.cycles).toBe(10);
    expect(ref.states.at(-1)).toBe('DONE');
    expect(ref.a.at(-1)).toBe(6);
    expect(ref.b.at(-1)).toBe(6);
  });
  it('the gates agree with the reference every edge: state, a and b', () => {
    const sim = simulate(gcdCircuit());
    const port = (p: string) => pack(sim.getBits(sim.design.root.ports[p]));
    for (const [k, v] of Object.entries({ start: 1, x: 48, y: 18, rst: 0, clk: 0 })) sim.setInput(k, v);
    sim.reset('zero'); sim.settle();
    const regs = () => ['r_a', 'r_b'].map((n) => pack(sim.getBits(sim.design.root.children!.get(n)!.ports.q)));
    let st: FsmdState = { s: GCD_FSMD.reset, regs: { a: 0, b: 0 } };
    for (let i = 0; i < ref.cycles; i++) {
      sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle();
      st = fsmdStep(GCD_FSMD, st, { bits: { start: 1 }, data: { x: 48, y: 18 } }).next;
      expect(regs(), `edge ${i + 1}`).toEqual([st.regs.a, st.regs.b]);
      expect(port('done'), `edge ${i + 1}`).toBe(GCD_FSMD.states[st.s].out?.includes('done') ? 1 : 0);
    }
    expect(port('gcd')).toBe(6);
  });
  it('the controller is 76 of 678 NANDs, 11 %', () => {
    expect(gcdCosts()).toEqual({ total: 678, controller: 76 });
    expect(Math.round((100 * 76) / 678)).toBe(11);
    expect(text('fsmd')).toContain('76 NANDs steering a datapath of 602 (678 NANDs in all)');
  });
});

describe('inputs from outside (step 8)', () => {
  it('a 3-bit debouncer wants 8 samples; 5 samples of bounce need 3 bits; 12 need 4', () => {
    expect(debounceSamples(3)).toBe(8);
    expect(debounceBits(5)).toBe(3);
    expect(debounceBits(12)).toBe(4);
    expect(debounceBits(40)).toBe(6);
    expect(text('debounce')).toContain('8 samples');
  });
  it('its NAND counts', () => {
    expect(stats(BUTTON3).nands).toBeGreaterThan(stats(debouncer(3)).nands);
  });
});

describe('a traffic light (step 9)', () => {
  it('serves the side road in two edges and returns', () => {
    const def = fsmCircuit('traffic', TRAFFIC);
    const sim = simulate(def);
    const lamps = () => ['mg', 'my', 'sg', 'sy'].map((p) => pack(sim.getBits(sim.design.root.ports[p]))).join('');
    const tick = () => { sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle(); };
    sim.setInput('car', 0); sim.setInput('rst', 1); sim.setInput('clk', 0); sim.settle(); tick(); sim.setInput('rst', 0); sim.settle();
    expect(lamps()).toBe('1000');
    sim.setInput('car', 1); sim.settle(); tick(); expect(lamps()).toBe('0100');
    tick(); expect(lamps()).toBe('0010');
    sim.setInput('car', 0); sim.settle(); tick(); expect(lamps()).toBe('0001');
    tick(); expect(lamps()).toBe('1000');
  });
  it('reads back as drawn, and the sandbox starter has the lamps but no arcs', () => {
    expect(readbackOk(readFsm(simulate(fsmCircuit('traffic', TRAFFIC)), fsmSpecOf(TRAFFIC, true)))).toBe(true);
    expect(TRAFFIC_START.states.length).toBe(4);
    expect(TRAFFIC_START.arcs.length).toBe(0);
  });
});

describe('the chapter and its codex entries', () => {
  it('is placed after registers and before memory, with nine steps and a recap', () => {
    const ids = chapters.map((c) => c.id);
    expect(ids.indexOf('fsm')).toBe(ids.indexOf('registers') + 1);
    expect(ids.indexOf('memory')).toBe(ids.indexOf('fsm') + 1);
    expect(chFsm.num).toBe(numOf('fsm'));
    expect(chFsm.steps.length).toBe(9);
    expect(chFsm.goals!.length).toBe(4);
    expect(chFsm.recap!.check!.length).toBe(3);
    expect(chFsm.recap!.practise).toEqual(['s_fsm', 'o_div', 'd_kmap']);
    expect(chFsm.steps.map((s) => s.challenge?.kind)).toEqual([undefined, 'quiz', 'quiz', 'reach', 'quiz', 'reach', 'reach', 'quiz', 'reach']);
  });
  it('the campaign levels link to it', () => {
    expect(nodeById('s_fsm')!.chapters!.some((c) => c.chapter === 'fsm' && c.step === 0)).toBe(true);
    expect(nodeById('o_div')!.chapters!.some((c) => c.chapter === 'fsm' && c.step === 6)).toBe(true);
  });
  it('three new entries with fuller text, two questions each, a taught row, and no level lists them', () => {
    for (const e of CODEX_FSM) {
      expect(CODEX.includes(e), e.id).toBe(true);
      expect(moreOf(e.id)?.idea, e.id).toBeTruthy();
      expect(CHECKS[e.id]?.length, e.id).toBe(2);
      // stateenc is taught where the registers chapter's State machines step already names the codes
      expect(TAUGHT[e.id], e.id).toBe(e.id === 'stateenc' ? 'registers' : 'fsm');
      for (const r of e.related ?? []) expect(codexById(r), `${e.id} → ${r}`).toBeTruthy();
      expect(NODES.some((n) => n.codex.includes(e.id)), `${e.id} is in a level now: drop it from FSM_AWAITING_LEVELS`).toBe(false);
      expect(FSM_AWAITING_LEVELS.has(e.id)).toBe(true);
      for (const l of (moreOf(e.id)!.chapters ?? []).filter((x) => x.chapter === 'fsm')) expect(chFsm.steps[l.step!].title, `${e.id} ${l.label}`).toBe(l.label);
    }
  });
  it('the existing entries fsm, metastability, kmap link to the chapter, fsm keeps its taught chapter', () => {
    for (const id of ['fsm', 'metastability', 'kmap']) {
      const links = (moreOf(id)!.chapters ?? []).filter((c) => c.chapter === 'fsm');
      expect(links.length, id).toBeGreaterThan(0);
      for (const l of links) expect(chFsm.steps[l.step!].title, `${id}: ${l.label}`).toBe(l.label);
    }
    expect(TAUGHT.fsm).toBe('registers');
  });
  it('the aliases mark their entry in prose', () => {
    const g = new Glossary();
    const ids = (s: string) => g.find(s).map((m) => m.id);
    for (const [id, names] of Object.entries(ALIASES_FSM)) for (const n of names) expect(ids(`about the ${n} here`), `${id}: ${n}`).toContain(id);
  });
});
