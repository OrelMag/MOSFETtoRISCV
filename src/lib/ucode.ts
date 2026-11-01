// The microcode painter's model (DOM-free): a microprogram is the multicycle controller's state table as data
// (multicycle.ts Microprogram: words of control-field values + a next / dispatch sequencing, and the two dispatch
// tables). Edits are pure functions returning a new program; `validate` says what cannot work; `pathsOf` counts
// the cycles each instruction class takes; `unitsLit` names the datapath instances a word drives (the stage's own
// names, so the chapter's scene can light the real circuit). multicycleCpu(program, { control: 'micro', microcode })
// builds the CPU; lib/ucodecheck.ts runs it against the golden model.

import { MC_FIELDS, MC_PROGRAM, microKey, type McNext, type McState, type Microprogram } from './multicycle';

export type { Microprogram } from './multicycle';

/** The microcode ROM is addressed by the 4-bit µPC. */
export const MAX_WORDS = 16;
/** Sequencing modes as the ROM's 2-bit field says them (mode 3 would read the constant 0: Fetch). */
export const SEQ_NAMES = ['next', 'dispatch 1', 'dispatch 2'] as const;
export const CLASS_NAMES = ['LOAD', 'STORE', 'R', 'I', 'JAL', 'BRANCH', 'JALR', 'LUI', 'AUIPC'];

/** A grid column: one control field. `names`: the named values of a multi-bit field, in value order. */
export interface UColumn { field: string; head: string; width: number; names?: string[] }
const COL: Record<string, Omit<UColumn, 'field' | 'width'>> = {
  pcUpdate: { head: 'pc up' }, branch: { head: 'br' }, irWrite: { head: 'ir wr' }, regWrite: { head: 'rg wr' }, memWrite: { head: 'mem wr' },
  adrSrc: { head: 'adr', names: ['PC', 'ALUOut'] },
  resultSrc: { head: 'result', names: ['ALUOut', 'Data', 'ALUResult', 'imm'] },
  aluSrcA: { head: 'alu A', names: ['PC', 'OldPC', 'A'] },
  aluSrcB: { head: 'alu B', names: ['B', 'imm', '4'] },
  aluFunct: { head: 'op', names: ['add', 'funct'] },
  retire: { head: 'ret' },
};
export const U_COLUMNS: UColumn[] = MC_FIELDS.map(([field, width]) => ({ field, width, ...COL[field] }));
const WIDTH = Object.fromEntries(MC_FIELDS);
/** Control bits + 4-bit next address + 2-bit mode. */
export const WORD_BITS = MC_FIELDS.reduce((a, [, n]) => a + n, 0) + 6;

export const cloneProgram = (p: Microprogram): Microprogram => structuredClone(p);
export const bookProgram = (): Microprogram => cloneProgram(MC_PROGRAM);
/** Does the program build the book's circuit? */
export const isBook = (p: Microprogram) => microKey(p) === microKey(MC_PROGRAM);
export const sameProgram = (a: Microprogram, b: Microprogram) => microKey(a) === microKey(b);

const clampField = (f: string, v: number) => Math.max(0, Math.min(2 ** (WIDTH[f] ?? 1) - 1, Math.trunc(v) || 0));

/** A program from untrusted data (a share link, a saved part): the book's shape or null. */
export function sanitizeProgram(x: unknown): Microprogram | null {
  const p = x as Microprogram | null;
  if (!p || !Array.isArray(p.states) || p.states.length < 1 || p.states.length > MAX_WORDS) return null;
  const n = p.states.length;
  const num = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < n ? v : 0);
  const table = (t: unknown, names: string[]): [string, number][] => names.map((c) => [c, num((Array.isArray(t) ? (t as [string, number][]).find((e) => e?.[0] === c) : undefined)?.[1]) ]);
  return {
    states: p.states.map((s, i) => {
      const sig: Record<string, number> = {};
      for (const [f] of MC_FIELDS) { const v = clampField(f, s?.sig?.[f] ?? 0); if (v) sig[f] = v; }
      const next: McNext = s?.next === 'decode' || s?.next === 'mem' ? s.next : num(s?.next);
      return { name: typeof s?.name === 'string' && s.name.length <= 24 ? s.name : `Word ${i}`, does: typeof s?.does === 'string' ? s.does.slice(0, 160) : '', sig, next };
    }),
    dispatch: table(p.dispatch, CLASS_NAMES),
    dispatch2: table(p.dispatch2, ['LOAD', 'STORE']),
  };
}

// ---- edits ----------------------------------------------------------------------------------------

const withState = (p: Microprogram, i: number, f: (s: McState) => McState): Microprogram => ({ ...p, states: p.states.map((s, k) => (k === i ? f(s) : s)) });

export function setField(p: Microprogram, word: number, field: string, value: number): Microprogram {
  return withState(p, word, (s) => {
    const sig = { ...s.sig }, v = clampField(field, value);
    if (v) sig[field] = v; else delete sig[field];
    return { ...s, sig };
  });
}

/** Next the value of a field in a cycle of its named values (a click on a multi-bit cell). */
export function cycleField(p: Microprogram, word: number, field: string, step = 1): Microprogram {
  const n = 2 ** WIDTH[field], v = p.states[word].sig[field] ?? 0;
  return setField(p, word, field, (v + step + n) % n);
}

/** Sequencing: 0 next address, 1 dispatch 1, 2 dispatch 2. */
export const seqOf = (s: McState) => (typeof s.next === 'number' ? 0 : s.next === 'decode' ? 1 : 2);
export function setSeq(p: Microprogram, word: number, mode: number): Microprogram {
  return withState(p, word, (s) => ({ ...s, next: mode === 1 ? 'decode' : mode === 2 ? 'mem' : typeof s.next === 'number' ? s.next : 0 }));
}
export function setNext(p: Microprogram, word: number, next: number): Microprogram {
  return withState(p, word, (s) => ({ ...s, next: Math.max(0, Math.min(p.states.length - 1, next)) }));
}
export function setDispatch(p: Microprogram, table: 1 | 2, cls: string, word: number): Microprogram {
  const set = (t: [string, number][]): [string, number][] => t.map(([c, w]) => (c === cls ? [c, word] : [c, w]));
  return table === 1 ? { ...p, dispatch: set(p.dispatch) } : { ...p, dispatch2: set(p.dispatch2) };
}
/** A new, empty word at the end (next: Fetch). */
export function addWord(p: Microprogram): Microprogram {
  if (p.states.length >= MAX_WORDS) return p;
  return { ...p, states: [...p.states, { name: `Word ${p.states.length}`, does: '', sig: {}, next: 0 }] };
}
/** Remove the last word; whatever pointed at it goes to Fetch. */
export function removeLast(p: Microprogram): Microprogram {
  const n = p.states.length - 1;
  if (n < 2) return p;
  const fix = (w: number) => (w >= n ? 0 : w);
  return {
    states: p.states.slice(0, n).map((s) => (typeof s.next === 'number' ? { ...s, next: fix(s.next) } : s)),
    dispatch: p.dispatch.map(([c, w]) => [c, fix(w)]), dispatch2: p.dispatch2.map(([c, w]) => [c, fix(w)]),
  };
}

// ---- reading ------------------------------------------------------------------------------------------

const eq = (a: McState | undefined, b: McState) => !!a && a.next === b.next && MC_FIELDS.every(([f]) => (a.sig[f] ?? 0) === (b.sig[f] ?? 0));
/** Is cell (word, field) different from the book's word at that place? */
export function changedCell(p: Microprogram, word: number, field: string): boolean {
  const s = p.states[word], b = MC_PROGRAM.states[word];
  return !b || (s.sig[field] ?? 0) !== (b.sig[field] ?? 0);
}
export function changedNext(p: Microprogram, word: number): boolean {
  const s = p.states[word], b = MC_PROGRAM.states[word];
  return !b || s.next !== b.next;
}
export const changedWord = (p: Microprogram, word: number) => !eq(MC_PROGRAM.states[word], p.states[word]);
export function changedDispatch(p: Microprogram): boolean {
  const same = (a: [string, number][], b: [string, number][]) => a.every(([c, w]) => b.find(([x]) => x === c)?.[1] === w);
  return !same(p.dispatch, MC_PROGRAM.dispatch) || !same(p.dispatch2, MC_PROGRAM.dispatch2);
}
export const wordCount = (p: Microprogram) => p.states.length;

export const nextText = (p: Microprogram, s: McState) =>
  typeof s.next === 'number' ? (p.states[s.next]?.name ?? '?') : s.next === 'decode' ? 'by opcode' : 'load / store';

/** What a word does, in register-transfer words: the book's text when unchanged, else made from the fields. */
export function doesOf(p: Microprogram, i: number): string {
  const s = p.states[i];
  if (eq(MC_PROGRAM.states[i], s) && MC_PROGRAM.states[i].name === s.name && MC_PROGRAM.states[i].next === s.next) return MC_PROGRAM.states[i].does;
  return `${describe(s)}; next: ${nextText(p, s)}`;
}

const A_NAME = ['PC', 'OldPC', 'A'], B_NAME = ['B', 'imm', '4'], R_NAME = ['ALUOut', 'Data', 'ALUResult', 'imm'];
function describe(s: McState): string {
  const g = (f: string) => s.sig[f] ?? 0;
  const parts: string[] = [];
  const result = R_NAME[g('resultSrc')];
  const alu = `${A_NAME[g('aluSrcA')] ?? '?'} ${g('aluFunct') ? 'op' : '+'} ${B_NAME[g('aluSrcB')] ?? '?'}`;
  if (g('irWrite')) parts.push('IR ← mem[PC]; OldPC ← PC');
  if (g('memWrite')) parts.push(`mem[${g('adrSrc') ? 'ALUOut' : 'PC'}] ← B`);
  else if (g('adrSrc')) parts.push('Data ← mem[ALUOut]');
  if (g('regWrite')) parts.push(`rd ← ${result === 'ALUResult' ? alu : result}`);
  if (g('pcUpdate')) parts.push(`PC ← ${result === 'ALUResult' ? alu : result}`);
  if (g('branch')) parts.push(`if taken, PC ← ${result}`);
  // ALUOut is written every cycle; say so unless the result went straight to its destination
  const direct = result === 'ALUResult' && (g('regWrite') || g('pcUpdate') || g('branch'));
  if (!direct) parts.push(`ALUOut ← ${alu}`);
  if (g('retire')) parts.push('instruction retires');
  return parts.join('; ');
}

/**
 * The datapath instances a word drives, by the multicycle CPU's instance names (and the controller): lit on the
 * real stage, or in the dialog's sketch. The ALU, its two input multiplexers and ALUOut work in every cycle.
 */
export function unitsLit(s: McState): string[] {
  const g = (f: string) => s.sig[f] ?? 0;
  const u = new Set<string>(['ctrl', 'alu', 'aluout', 'srcA', 'srcB']);
  u.add(['pc', 'oldpc', 'ra'][g('aluSrcA')] ?? 'ra');
  u.add(['rb', 'imm', 'c4'][g('aluSrcB')] ?? 'rb');
  if (g('aluFunct')) u.add('actl');
  if (g('adrSrc') === 0) { u.add('pc'); u.add('imem'); } else u.add('dm');
  u.add('adr'); u.add('memsel');
  if (g('irWrite')) { u.add('ir'); u.add('oldpc'); }
  if (g('adrSrc') === 1 && !g('memWrite')) u.add('data');
  if (g('memWrite')) { u.add('dm'); u.add('rb'); }
  const needsResult = g('regWrite') || g('pcUpdate') || g('branch');
  if (needsResult) { u.add('res'); u.add(['aluout', 'data', 'alu', 'imm'][g('resultSrc')]); }
  if (g('regWrite')) u.add('rf');
  if (g('pcUpdate') || g('branch')) { u.add('pc'); u.add('pcw'); if (g('branch')) u.add('npc'); }
  return [...u];
}

// ---- paths, validation --------------------------------------------------------------------------------

/** Words visited from Fetch to Fetch by an instruction of class `cls` (a load or store: through the memory dispatch); null: no way back. */
export function pathOf(p: Microprogram, cls: string): number[] | null {
  const d1 = p.dispatch.find(([c]) => c === cls)?.[1] ?? 0;
  const d2 = p.dispatch2.find(([c]) => c === cls)?.[1] ?? 0;
  const path = [0];
  let w = 0;
  for (let guard = 0; guard < 4 * MAX_WORDS; guard++) {
    const s = p.states[w];
    w = typeof s.next === 'number' ? s.next : s.next === 'decode' ? d1 : d2;
    if (w === 0) return path;
    path.push(w);
  }
  return null;
}

/** Clock cycles per instruction class (null: never returns to Fetch). A class dispatched straight to Fetch takes 2. */
export function cyclesByClass(p: Microprogram): Record<string, number | null> {
  return Object.fromEntries(CLASS_NAMES.map((c) => [c, pathOf(p, c)?.length ?? null]));
}

export interface UProblem { level: 'bad' | 'warn'; text: string; word?: number }

export function validate(p: Microprogram): UProblem[] {
  const out: UProblem[] = [];
  const n = p.states.length;
  if (n < 2 || n > MAX_WORDS) out.push({ level: 'bad', text: `The microcode ROM holds 2 to ${MAX_WORDS} words (a 4-bit µPC); this has ${n}.` });
  const bad = (w: number) => !Number.isInteger(w) || w < 0 || w >= n;
  p.states.forEach((s, i) => { if (typeof s.next === 'number' && bad(s.next)) out.push({ level: 'bad', text: `${s.name} points past the last word.`, word: i }); });
  for (const [c, w] of [...p.dispatch, ...p.dispatch2]) if (bad(w)) out.push({ level: 'bad', text: `The ${c} dispatch points past the last word.` });
  if (out.some((x) => x.level === 'bad')) return out;
  const seen = new Set<number>([0]);
  if (!p.states.some((s) => s.sig.irWrite)) out.push({ level: 'bad', text: 'No word writes IR: the CPU never loads an instruction.' });
  for (const c of CLASS_NAMES) {
    const path = pathOf(p, c);
    if (!path) { out.push({ level: 'bad', text: `${c} never gets back to Fetch (a loop of words).` }); continue; }
    path.forEach((w) => seen.add(w));
    if (path.length === 1) continue;
    const mem = c === 'LOAD' || c === 'STORE';
    const rets = path.filter((w) => p.states[w].sig.retire).length;
    if (rets === 0) out.push({ level: 'bad', text: `${c}: no word on its path retires the instruction${path.length <= 2 && !mem ? ' (it dispatches back to Fetch)' : ''}.` });
    else if (rets > 1) out.push({ level: 'bad', text: `${c}: ${rets} words on its path retire; an instruction retires once.` });
  }
  for (const c of CLASS_NAMES) if ((p.dispatch.find(([x]) => x === c)?.[1] ?? 0) === 0) out.push({ level: 'warn', text: `${c} is not dispatched: it falls back to Fetch and is skipped.` });
  p.states.forEach((s, i) => { if (!seen.has(i)) out.push({ level: 'warn', text: `${s.name} (word ${i}) is never reached.`, word: i }); });
  return out;
}
