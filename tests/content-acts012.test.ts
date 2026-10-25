// Acts 0, P, 1 and 2's written content (the content pass of 2026-10-25): every number in their whys, cases, thread
// clauses, tips, lessons and drills is measured here, the thread covers acts 0 and P too, and the Simplify drill's
// derivations are proved step by step.

import { describe, expect, it } from 'vitest';
import { caseOf } from '../src/campaign/cases';
import { DRILLS, evalBool, minimumCover, parseBool, rng, SIMPLIFY, sopLiterals } from '../src/campaign/drills';
import { dependents } from '../src/campaign/graph';
import { LESSONS } from '../src/campaign/lessons';
import { libCost } from '../src/campaign/measure';
import { NODES, nodeById } from '../src/campaign/nodes';
import { NUDGES } from '../src/campaign/nudges';
import { threadOf } from '../src/campaign/thread';
import { objectCard, seqText } from '../src/cards/card';
import { punchOf, rowsOf } from '../src/cards/hollerith';
import { copiesIn } from '../src/lib/usage';
import { resolveComponent } from '../src/lib/resolve';
import { CTL_WIDTHS, rv16Core } from '../src/lib/rv16/cpu';
import { RELAY_COIL_POWER, RELAY_STEP_MS, RELAY_SUPPLY, relaySim, relayStatic, relaySummary, Z3 } from '../src/phys/relay';
import { B_PLUS, V_BIAS, V_CUTOFF, V_LOW } from '../src/phys/triode';
import { stats } from '../src/sim/stats';

const par = (id: string) => nodeById(id)!.par!;
const cost = (id: string) => libCost(id)!;
const fmt = (v: number) => String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const plain = (html: string) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
/** A negative number as the texts write it, with a minus sign. */
const neg = (v: number) => String(v).replace('-', '−');
const why = (id: string) => nodeById(id)!.why;
const tips = (id: string) => nodeById(id)!.tips.join(' ');
const kase = (id: string) => { const c = caseOf(id)!; return plain(`${c.problem} ${c.without ?? ''} ${c.cost ?? ''}`); };
const T = (id: string) => Object.values(threadOf(id)?.usedFor ?? {}).concat(threadOf(id)?.pitfalls ?? []).join(' ');
const alt = (id: string, name: string) => caseOf(id)!.alts!.find((a) => a.name.startsWith(name))!;
const def = (id: string) => resolveComponent(id)!;
const MINE = [0, 11, 1, 2];
const mine = NODES.filter((n) => MINE.includes(n.act));

const core = rv16Core(true);
const copies = (id: string) => copiesIn(core, def(id));
const muxBits = copies('mux2') + 16 * copies('rv16_mux16');

describe('acts 0, P, 1, 2: the shape of the text', () => {
  it('every why is 2–4 sentences, every build has 2–3 tips or more, every drill and build a nudge', () => {
    for (const n of mine) {
      const s = (n.why.match(/[.?!](\s|$)/g) ?? []).length;
      expect(s, `${n.id}: sentences`).toBeGreaterThanOrEqual(2);
      expect(s, `${n.id}: sentences`).toBeLessThanOrEqual(4);
      expect(n.why.split(/\s+/).length, `${n.id}: words`).toBeLessThanOrEqual(60);
      if (n.kind === 'build') expect(n.tips.length, `${n.id}: tips`).toBeGreaterThanOrEqual(2);
      if (n.kind === 'build' || n.kind === 'drill') expect(NUDGES[n.id], `${n.id}: nudge`).toBeTruthy();
    }
  });

  it('every build and drill has a case (lessons carry their own text)', () => {
    for (const n of mine) if (n.kind !== 'lesson') expect(caseOf(n.id), n.id).toBeDefined();
    expect(caseOf('t_nor')!.without).toBeTruthy();
    expect(caseOf('n_twos')!.cost).toBeTruthy();
  });

  it('fills the thread for acts 0 and P: a clause for every dependent (required, and act P\'s own), pitfalls on every level', () => {
    for (const n of mine.filter((m) => m.act === 0 || m.act === 11)) {
      const t = threadOf(n.id);
      expect(t, n.id).toBeDefined();
      expect(t!.pitfalls?.length, `${n.id} pitfalls`).toBeGreaterThanOrEqual(2);
      for (const d of dependents(n.id)) if (!d.optional || d.act === 11) expect(t!.usedFor?.[d.id], `${n.id} → ${d.id}`).toBeTruthy();
      // act P builds no block of RV16
      if (n.act === 11) expect(t!.uses).toBeUndefined();
    }
  });

  it('calls Fast adders required, never a side quest', () => {
    expect(nodeById('o_fastadd')!.optional).toBeFalsy();
    for (const n of mine) expect(`${n.why} ${n.tips.join(' ')} ${caseOf(n.id) ? kase(n.id) : ''}`.toLowerCase(), n.id).not.toContain('side quest');
    expect(why('o_fastadd')).toContain('Required: Core IV');
  });
});

describe('act 0', () => {
  it('pins the transistor counts and the finished machine', () => {
    const fin = par('y_final').nand!;
    expect(why('intro')).toContain(`${fmt(fin)} NANDs`);
    expect(why('t_nand')).toContain(`the finished RV16 is ${fmt(fin)} of them`);
    expect(cost('inv_cmos').transistors).toBe(2);
    expect(why('t_inv')).toContain('with 2 transistors');
    expect(cost('nand')).toMatchObject({ transistors: 4, depth: 1 });
    expect(why('t_nand')).toContain('4 transistors, 1 delay');
    expect(cost('nor_cmos').transistors).toBe(4);
    expect(cost('nor').nand).toBe(4);
    expect(why('t_nor')).toContain('a NOR is four NANDs');
  });

  it('pins the intro lesson\'s order of acts', () => {
    const L = plain(LESSONS.intro);
    expect(L).toContain('pc + 1');
    expect(L).toContain(`decoder picks the register to write (${par('g_dec').nand} NANDs), an equality test decides beq (${par('g_eq16').nand})`);
    expect(L).toContain(`The ALU is ${fmt(par('a_alu16').nand!)} NANDs, depth ${par('a_alu16').depth}; the fast adder (${par('o_fastadd').nand} NANDs, depth ${par('o_fastadd').depth} against the ripple adder's ${par('a_add16').depth})`);
    expect(L).toContain(`register file: ${fmt(par('m_rf').nand!)} NANDs`);
    const c3 = par('c_core3');
    expect(L).toContain(`(${fmt(c3.nand!)} NANDs, one instruction per ${c3.period}-delay cycle)`);
    expect(L).toContain(`period ${par('c_fast').period}`);
    expect(L).toContain(`(${fmt(par('pi_core3').nand!)} NANDs, period ${par('pi_core3').period})`);
    expect(L).toContain(`${fmt(par('y_final').nand!)} NANDs, the finale`);
    // the acts named in the order they come
    for (const [a, b] of [['Act 0', 'Act 1'], ['Act 1', 'Act 2'], ['Act 2', 'Act 3'], ['Act 3', 'Act 4'], ['Act 4', 'Act 5'], ['Act 5', 'Act 6']]) expect(L.indexOf(a)).toBeLessThan(L.indexOf(b));
  });
});

describe('act P', () => {
  const s = relayStatic(), run = relaySummary(relaySim(RELAY_SUPPLY));
  const v1 = (x: number) => x.toFixed(1);

  it('pins the relay\'s numbers (why, case, pitfalls)', () => {
    expect(why('r_pull')).toContain(`pulls in at ${v1(s.pull!)} V of its ${RELAY_SUPPLY}, drops out only below ${v1(s.drop!)} V`);
    expect(why('r_pull')).toContain(`${RELAY_STEP_MS} ms after switch-on`);
    expect(v1(run.settled! * 1e3)).toBe(String(RELAY_STEP_MS));
    const c = kase('r_pull');
    expect(c).toContain(`needs ${v1(s.pull!)} V of its ${RELAY_SUPPLY}`);
    expect(c).toContain(`below ${v1(s.drop!)} V`);
    expect(c).toContain(`first touches ${v1(run.firstTouch! * 1e3)} ms after switch-on, bounces ${run.bounces} times and rests at ${RELAY_STEP_MS} ms`);
    expect(c).toContain(`opens ${v1(run.release! * 1e3)} ms after switch-off`);
    expect(c).toContain(`−${Math.round(-run.spike)} V`);
    expect(c).toContain(`${RELAY_COIL_POWER} W`);
    expect(c).toContain(`The Z3's ${fmt(Z3.relays)} relays drew about ${Z3.power / 1e3} kW`);
    expect(c).toContain(`the Z3 ran at ${Z3.hz} Hz`);
    expect(T('r_pull')).toContain(`pulled in at ${v1(s.pull!)} V stays in down to ${v1(s.drop!)} V`);
    expect(T('r_pull')).toContain(`bounces ${run.bounces} times`);
    expect(T('r_pull')).toContain(`${RELAY_STEP_MS} ms steps`);
  });

  it('pins the relay levels against their NAND-mapped prices', () => {
    expect(why('r_nand')).toContain(`${par('r_nand').relays} relays, one ${RELAY_STEP_MS} ms step`);
    expect(why('r_xor')).toContain(`XOR is ${cost('xor').relays} relays and ${cost('xor').steps} relay steps`);
    expect(why('r_xor')).toContain(`XOR is ${par('r_xor').relays} relays and one step`);
    expect(why('r_adder')).toContain(`${cost('rca4').relays} relays and ${cost('rca4').steps} relay steps`);
    expect(why('r_adder')).toContain(`${par('r_adder').relays} relays, and the sum is ready one step`);
    expect(why('r_clock')).toContain(`${par('r_clock').relays} relays for a counter bit, where the NAND-mapped T flip-flop alone is ${cost('tff').relays}`);
    expect(why('h_loader')).toContain(`${par('h_loader').relays} relays at par, ${cost('counter8').relays} of them the counter`);
  });

  it('pins the tube levels', () => {
    for (const id of ['v_inv', 'v_ff']) expect(why(id) + T(id)).toBeTruthy();
    expect(why('v_inv')).toContain(`between ${Math.round(V_LOW)} and ${B_PLUS} V`);
    expect(why('v_inv')).toContain(`${neg(V_CUTOFF)} V to stop`);
    expect(why('v_inv')).toContain(`divider to ${neg(V_BIAS)} V`);
    expect(why('v_inv')).toContain(`${par('v_inv').tubes} triode sections`);
    expect(T('v_inv')).toContain(`${Math.round(V_LOW)} V or more`);
    expect(T('v_inv')).toContain(`${neg(V_BIAS)} V, not to GND`);
    // 2 triode sections + 2 steering diodes
    expect(why('v_ff')).toContain('2 sections of one bulb and 2 steering diodes');
    expect(par('v_ff').tubes).toBe(4);
  });

  it('pins the cards', () => {
    expect(rowsOf(punchOf('A')!)).toBe('12-1');
    expect(rowsOf(punchOf('J')!)).toBe('11-1');
    expect(rowsOf(punchOf('S')!)).toBe('0-2');
    expect(tips('h_card')).toContain('S is 0-2');
    expect(objectCard(0x1234, '', seqText(0), 16).cols.length).toBe(80);
    expect(kase('h_card')).toContain('80 columns of 12 rows');
  });
});

describe('act 1', () => {
  it('pins the gates\' whys', () => {
    expect(copies('not')).toBe(196);
    expect(why('g_not')).toContain(`the single-cycle core holds ${copies('not')} of them`);
    expect(why('g_and')).toContain(`${cost('and').nand} NANDs; the single-cycle core holds ${copies('and')} of them`);
    expect(why('g_or')).toContain(`${par('g_or').nand} NANDs`);
    expect(why('g_xor')).toContain(`${par('g_xor').nand} NANDs where the textbook sum of products is ${alt('g_xor', 'Sum of products').nand}`);
    const aoi = alt('g_mux', 'AND–OR');
    expect(why('g_mux')).toContain(`${par('g_mux').nand} NANDs, depth ${par('g_mux').depth} (as AND–OR, ${aoi.nand} NANDs, depth ${aoi.depth})`);
    expect(muxBits).toBe(705);
    expect(why('g_mux')).toContain(`${muxBits} bits of it`);
    expect(why('l_bool')).toContain(`${aoi.nand} NANDs; rewritten into NAND–NAND it is ${par('g_mux').nand}`);
  });

  it('pins the method levels and the wide blocks', () => {
    const outs = CTL_WIDTHS.reduce((a, b) => a + b, 0);
    expect(why('d_kmap')).toContain(`control unit is ${outs} output bits`);
    expect(why('g_sop')).toContain(`NAND–NAND, ${alt('g_sop', 'Minimal sum').nand} NANDs; par is ${par('g_sop').nand}`);
    expect(why('g_sop')).toContain(`each of its ${outs} outputs`);
    const chain = alt('g_wide', 'Chain');
    expect(why('g_wide')).toContain(`${par('g_wide').nand} NANDs with the NOT, but a chain is ${chain.depth} NAND delays deep and a balanced tree ${par('g_wide').depth}`);
    expect(why('g_dec')).toContain(`${alt('g_dec', 'Eight 4-input').nand} NANDs; decoding two bits at a time and sharing the halves, in ${par('g_dec').nand}`);
    expect(why('g_mux8')).toContain(`${par('g_mux8').nand} NANDs instead of ${cost('mux2x16').nand}, and the single-cycle core holds ${copies('rv16_mux16')} of them`);
    expect(tips('g_mux8')).toContain(`${cost('mux2x16').nand - par('g_mux8').nand!} NANDs over par`);
    const z = alt('g_eq16', 'Zero detect');
    expect(why('g_eq16')).toContain(`${par('g_eq16').nand} NANDs, depth ${par('g_eq16').depth}`);
    expect(why('g_eq16')).toContain(`would save ${par('g_eq16').nand! - z.nand!} NANDs but wait for its carry chain, depth ${z.depth}`);
  });

  it('pins the drills\' cases and the bool lesson', () => {
    expect(kase('n_bin')).toContain(`0 to ${fmt(2 ** 16 - 1)}`);
    expect(kase('n_bin')).toContain(`names ${fmt(2 ** 16)} instruction words`);
    expect(why('n_bin')).toContain(`0 to ${fmt(2 ** 16 - 1)}`);
    const L = kase('l_bool');
    expect(L).toContain(`the multiplexer ${alt('g_mux', 'AND–OR').nand} NANDs instead of ${par('g_mux').nand}, XOR ${alt('g_xor', 'Sum of products').nand} instead of ${par('g_xor').nand}, the full adder ${cost('full_adder_ha').nand} instead of ${par('a_fa').nand}`);
    expect(L).toContain(`${muxBits} bits of multiplexer and ${copies('full_adder')} full adders`);
    expect(kase('d_kmap')).toContain(`${CTL_WIDTHS.reduce((a, b) => a + b, 0)} output bits`);
    const B = plain(LESSONS.bool);
    expect(B).toContain(`${muxBits} bits of 2:1 mux and ${copies('full_adder')} full adders`);
    expect(B).toContain(`¬(¬a · ¬b), De Morgan: ${par('g_or').nand} NANDs`);
    expect(B).toContain(`¬a·b + a·¬b: ${alt('g_xor', 'Sum of products').nand} NANDs`);
    expect(B).toContain(`8 NANDs, depth 5`);
    expect(alt('g_mux', 'AND–OR')).toMatchObject({ nand: 8, depth: 5 });
    expect(B).toContain(`NAND–NAND: ${par('g_mux').nand}, depth ${par('g_mux').depth}`);
    expect(B).toContain(`two half adders and an OR: ${cost('full_adder_ha').nand} NANDs`);
    expect(B).toContain(`first NANDs: ${par('a_fa').nand}`);
    expect(B).toContain(`${alt('g_wide', 'Chain').depth} delays as a chain, ${par('g_wide').depth} as a tree`);
  });
});

describe('act 2', () => {
  it('pins the adders', () => {
    expect(why('a_ha')).toContain(`${par('a_ha').nand} NANDs`);
    expect(why('a_ha')).toContain(`fifteen in a row`);
    expect(copies('half_adder')).toBe(15);
    expect(copies('full_adder')).toBe(64);
    expect(why('a_fa')).toContain(`the single-cycle core holds ${copies('full_adder')}, four 16-bit chains`);
    expect(why('a_add16')).toContain('in four places');
    // the ripple carry costs 2 delays a bit at par: the 16-bit adder is 12 bits longer than the 4-bit one
    const perBit = (par('a_add16').depth! - par('a_add4').depth!) / 12;
    expect(perBit).toBe(2);
    expect(why('a_fa')).toContain(`${perBit} delays from cin to cout at par, 4 in the ${cost('full_adder_ha').nand}-NAND version`);
    expect(why('a_add4')).toContain(`${par('a_add4').nand} NANDs, depth ${par('a_add4').depth}, ${perBit} more delays for every bit`);
    expect(why('a_add16')).toContain(`${par('a_add16').nand} NANDs, depth ${par('a_add16').depth}`);
    expect(why('a_add16')).toContain(`The ALU is 50 of the single-cycle core's ${par('c_core3').period}-delay period`);
    expect(why('o_fastadd')).toContain(`the ALU is 50 of its ${par('c_core3').period} delays`);
    expect(why('o_fastadd')).toContain(`${par('o_fastadd').nand} NANDs, depth ${par('o_fastadd').depth}, against the ripple adder's ${par('a_add16').nand} and ${par('a_add16').depth}`);
    expect(why('o_fastadd')).toContain(`the ALU, period ${par('c_fast').period}`);
    expect(why('a_inc16')).toContain(`${par('a_inc16').nand} NANDs against the adder's ${par('a_add16').nand}`);
    expect(why('a_inc16')).toContain(`depth ${par('a_inc16').depth}, and alone sets the PC's period, ${par('s_pc').period}`);
    expect(tips('a_inc16')).toContain(`${cost('inc16').nand - par('a_inc16').nand!} NANDs over par`);
    expect(why('a_addsub16')).toContain(`would cost ${alt('a_addsub16', 'Separate').nand} NANDs`);
    expect(why('a_addsub16')).toContain(`${par('a_addsub16').nand} NANDs`);
  });

  it('pins the comparator, shifter and ALU', () => {
    const br = cost('rv16_branch'), lt = cost('rv16_cmp16');
    expect(copiesIn(def('rv16_branch'), def('rv16_cmp16'))).toBe(1);
    expect(lt.nand).toBe(par('a_slt').nand);
    expect(why('a_slt')).toContain(`${lt.nand} of the branch comparator's ${br.nand} NANDs and ${lt.depth} of its ${br.depth} delays`);
    expect(kase('a_slt')).toContain('its carry chain is the comparator\'s critical path');
    expect(kase('a_slt')).toContain(`${cost('xor').nand + cost('not').nand} NANDs more`);
    expect(alt('a_slt', 'Adder / subtractor').nand).toBe(par('a_addsub16').nand! + cost('xor').nand + cost('not').nand);
    expect(why('a_shift16')).toContain(`${par('a_shift16').nand} NANDs, depth ${par('a_shift16').depth}`);
    expect(-8 >> 1).toBe(-4);
    expect(why('a_alu16')).toContain(`${fmt(par('a_alu16').nand!)} NANDs, depth ${par('a_alu16').depth}`);
    expect(stats(def('rv16_imm')).nands).toBe(0);
    expect(kase('n_twos')).toContain('the immediate generator is wiring (0 NANDs)');
    expect(why('n_twos')).toContain(`−${fmt(2 ** 15)} to ${fmt(2 ** 15 - 1)}`);
  });
});

describe('drills', () => {
  it('Simplify: every step of every derivation is the expression, the last one minimal, in one notation', () => {
    expect(SIMPLIFY.length).toBeGreaterThanOrEqual(24);
    for (const q of SIMPLIFY) {
      const n = q.vars.length;
      const truth = (src: string) => {
        const p = parseBool(src, q.vars);
        if ('error' in p) throw new Error(`${src}: ${p.error}`);
        return { t: Array.from({ length: 2 ** n }, (_, x) => evalBool(p.ex, x, n)).join(''), lits: p.literals };
      };
      const want = truth(q.src).t;
      for (const s of q.steps) expect(truth(s).t, `${q.src} = ${s}`).toBe(want);
      const ones = [...want].flatMap((c, x) => (c === '1' ? [x] : []));
      const L = sopLiterals(minimumCover(n, ones), n);
      expect(truth(q.steps.at(-1)!).lits, `${q.src}: last step`).toBeLessThanOrEqual(L);
      for (const s of [q.src, ...q.steps]) expect(s, 'one notation: ¬, not \'').not.toContain("'");
      expect(q.why.length).toBeGreaterThan(10);
    }
    // the levels' circuits are among them
    for (const src of ['¬(¬(s·b)·¬(¬s·a))', 'a·b + c·(a ⊕ b)', '¬(a + b + c + d)']) expect(SIMPLIFY.some((q) => q.src === src), src).toBe(true);
  });

  it('Simplify: the explanation shows that expression\'s own derivation', () => {
    const r = rng(3);
    for (let i = 0; i < 60; i++) {
      const q = DRILLS.boolean.make(r);
      const src = q.prompt.match(/<code>(.*?)<\/code>/)![1];
      const s = SIMPLIFY.find((x) => x.src === src)!;
      expect(q.explain).toContain(s.why);
      expect(q.check(q.answer).ok).toBe(true);
    }
  });

  it('binary and two\'s complement ask 16-bit and signed-or-unsigned questions, answered exactly', () => {
    const r = rng(11);
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const q = DRILLS.binary.make(r);
      let m: RegExpMatchArray | null;
      if ((m = q.prompt.match(/bit <b>(\d+)<\/b> of <code>0x([0-9A-F]{4})/))) { seen.add('bit'); expect(q.answer).toBe(String((parseInt(m[2], 16) >> Number(m[1])) & 1)); }
      if ((m = q.prompt.match(/Write <code>0x([0-9A-F]{4})<\/code> in binary \(16 bits\)/))) { seen.add('hex16'); expect(q.answer.replace(/ /g, '')).toBe(parseInt(m[1], 16).toString(2).padStart(16, '0')); }
      if ((m = q.prompt.match(/<b>(\d+)-bit<\/b> word holds/))) { seen.add('range'); expect(q.answer).toBe(String(2 ** Number(m[1]) - 1)); }
    }
    for (let i = 0; i < 400; i++) {
      const q = DRILLS.twos.make(r);
      let m: RegExpMatchArray | null;
      const s16 = (v: number) => (v >= 0x8000 ? v - 0x10000 : v);
      if ((m = q.prompt.match(/16-bit pattern <code>0x([0-9A-F]{4})<\/code> as a signed/))) { seen.add('s16'); expect(q.answer).toBe(String(s16(parseInt(m[1], 16)))); }
      if ((m = q.prompt.match(/Is <code>0x([0-9A-F]{4})<\/code> &lt; <code>0x([0-9A-F]{4})<\/code> as <b>(signed|unsigned)<\/b>/))) {
        seen.add(m[3]);
        const a = parseInt(m[1], 16), b = parseInt(m[2], 16);
        expect(q.answer).toBe((m[3] === 'signed' ? s16(a) < s16(b) : a < b) ? 'yes' : 'no');
        if ((a ^ b) & 0x8000) seen.add('disagree');
      }
      if ((m = q.prompt.match(/a = <code>0x([0-9A-F]{4})<\/code>, b = <code>0x([0-9A-F]{4})<\/code>: does a \+ ¬b \+ 1/))) {
        seen.add('carry');
        const a = parseInt(m[1], 16), b = parseInt(m[2], 16);
        expect(q.answer).toBe(a + ((~b) & 0xffff) + 1 > 0xffff ? 'yes' : 'no');
      }
    }
    expect([...seen].sort()).toEqual(['bit', 'carry', 'disagree', 'hex16', 'range', 's16', 'signed', 'unsigned']);
  });
});
