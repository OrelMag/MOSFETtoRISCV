import { describe, expect, it } from 'vitest';
import { MC_MICRO, MC_PROGRAM, MC_STATES, microController, microprogramOf, multicycleCpu } from '../src/lib';
import { addWord, bookProgram, cyclesByClass, isBook, setField, setNext, validate, type Microprogram } from '../src/lib/ucode';
import { bookReport, checkProgram } from '../src/lib/ucodecheck';
import { breathe } from './setup';

/** I-type in 3 cycles: ExecuteI writes rd from the ALU result itself and retires, back to Fetch. */
export function threeCycleI(): Microprogram {
  let p = bookProgram();
  p = setField(p, 8, 'resultSrc', 2);
  p = setField(p, 8, 'regWrite', 1);
  p = setField(p, 8, 'retire', 1);
  return setNext(p, 8, 0);
}

describe('the microprogram as data', () => {
  it('the book\'s program builds the book\'s objects', () => {
    expect(microController(bookProgram())).toBe(MC_MICRO);
    expect(multicycleCpu([0x13], { control: 'micro', microcode: bookProgram() })).toBe(multicycleCpu([0x13], { control: 'micro' }));
    expect(isBook(MC_PROGRAM)).toBe(true);
    expect(validate(bookProgram())).toEqual([]);
    expect(cyclesByClass(bookProgram())).toMatchObject({ R: 4, I: 4, LOAD: 5, STORE: 4, BRANCH: 3, JAL: 4, JALR: 5, LUI: 3, AUIPC: 3 });
  });

  it('an edit builds another controller, memoized by content', () => {
    const p = threeCycleI();
    const c = microController(p);
    expect(c).not.toBe(MC_MICRO);
    expect(microController(threeCycleI())).toBe(c);
    expect(microprogramOf(c)).toEqual(p);
    expect(multicycleCpu([0x13], { control: 'micro', microcode: p }).id).not.toBe(multicycleCpu([0x13], { control: 'micro' }).id);
    expect(cyclesByClass(p).I).toBe(3);
  });

  it('validation names what cannot work', () => {
    let p = bookProgram();
    p = setField(p, 4, 'retire', 0); // MemWB no longer retires
    expect(validate(p).some((x) => x.level === 'bad' && /LOAD: no word/.test(x.text))).toBe(true);
    p = setField(bookProgram(), 7, 'retire', 0);
    expect(validate(p).filter((x) => x.level === 'bad').map((x) => x.text.split(':')[0])).toEqual(expect.arrayContaining(['R', 'I']));
    expect(validate(setField(bookProgram(), 8, 'retire', 1)).some((x) => /retire; an instruction retires once|2 words/.test(x.text))).toBe(true);
    const loop = setNext(bookProgram(), 7, 7);
    expect(validate(loop).some((x) => /never gets back to Fetch/.test(x.text))).toBe(true);
    const orphan = addWord(bookProgram());
    expect(validate(orphan).some((x) => x.level === 'warn' && /never reached/.test(x.text))).toBe(true);
    expect(MC_STATES.length).toBe(13);
  });
});

describe('the check against the golden model', () => {
  it('the book\'s microprogram passes riscv-tests and the benchmarks', async () => {
    const r = await bookReport();
    await breathe();
    expect(r.tests.length).toBeGreaterThan(30);
    expect(r.tests.filter((t) => !t.pass).map((t) => `${t.name}: ${t.text}`)).toEqual([]);
    expect(r.benches.filter((b) => !b.ok).map((b) => `${b.id}: ${b.diff}`)).toEqual([]);
    expect(r.allPass).toBe(true);
    console.log(`book: ${r.tests.length} tests, ${r.benches.length} benchmarks, CPI ${r.cpi?.toFixed(3)}, ${Math.round(r.ms)} ms, controller ${r.nands} NANDs`);
  }, 300_000);

  it('I-type in three cycles passes everything and lowers the CPI', async () => {
    const book = await bookReport();
    const r = await checkProgram(threeCycleI());
    await breathe();
    expect(r.tests.filter((t) => !t.pass).map((t) => `${t.name}: ${t.text}`)).toEqual([]);
    expect(r.allPass).toBe(true);
    expect(r.cpi!).toBeLessThan(book.cpi!);
    expect(r.nands).toBe(book.nands);
    console.log(`I in 3 cycles: CPI ${book.cpi!.toFixed(3)} -> ${r.cpi!.toFixed(3)}, ${Math.round(r.ms)} ms`);
  }, 300_000);

  it('a broken edit fails with the first mismatch named', async () => {
    // ALUWB writes the load result register from Data instead of ALUOut: R-type results are wrong
    const bad = setField(bookProgram(), 7, 'resultSrc', 1);
    const r = await checkProgram(bad);
    await breathe();
    expect(r.allPass).toBe(false);
    expect(r.tests.some((t) => !t.pass)).toBe(true);
    expect(r.firstMismatch).toMatch(/after .* at pc 0x[0-9a-f]+: .*(x\d+|[a-z]\d+|PC|mem)/);
    console.log('first mismatch:', r.firstMismatch);
  }, 300_000);
});
