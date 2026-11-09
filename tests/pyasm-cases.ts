// Every program the Python tests and widgets compile, under the options they use, as a hash of the generated assembly. The `user`
// target of src/lang (stage 3b of docs/PLAN-VM-OS.md) must leave all of it identical: tests/pyasm-snapshot.test.ts holds the hashes
// recorded before that change (tests/fixtures/py-asm-snapshot.json; regenerate with scripts/py-asm-snapshot.ts only on purpose).
import { compilePy } from '../src/lang/compile';
import { PY_PROGRAMS, PY_STRING_PROGRAMS } from '../src/lang/pyprograms';
import { randomPyProgram, randomStrProgram } from '../src/lang/randpy';

function fnv(s: string): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) { a = Math.imul(a ^ s.charCodeAt(i), 0x01000193) >>> 0; b = (Math.imul(b, 31) + s.charCodeAt(i)) >>> 0; }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0') + s.length.toString(16);
}

export function snapshotCases(): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (name: string, src: string, o: Parameters<typeof compilePy>[1]) => {
    const c = compilePy(src, o);
    out[name] = c.error ? `error:${c.error.message}` : fnv(c.asm);
  };
  for (const p of PY_PROGRAMS) for (const dm of [64, 512, 1024]) for (const m of [false, true]) add(`${p.id}/${dm}/${m ? 'm' : ''}`, p.source, { dmemWords: dm, m });
  // the options the tests and widgets pass: dmemWords 64 (PY_DMEM_K 6), 512, 1024; heapBytes 200 / 400 / the default; seeds 1..300 as pylang.test.ts runs them
  for (const p of PY_STRING_PROGRAMS) for (const m of [false, true]) for (const dm of [512, 1024]) for (const hb of [undefined, 200, 400]) add(`str:${p.id}/${dm}/${hb ?? ''}/${m ? 'm' : ''}`, p.source, { dmemWords: dm, m, heapBytes: hb });
  for (let s = 1; s <= 300; s++) { add(`rand${s}`, randomPyProgram(s), { dmemWords: 512 }); add(`rand${s}/m`, randomPyProgram(s), { dmemWords: 512, m: true }); }
  for (let s = 1; s <= 300; s++) add(`randmem${s}`, randomPyProgram(s, true), { dmemWords: 512 });
  for (let s = 1; s <= 300; s++) { add(`randstr${s}`, randomStrProgram(s), { dmemWords: 1024, heapBytes: 400 }); add(`randstr${s}/512`, randomStrProgram(s), { dmemWords: 512 }); }
  add('default', 'print(1)\n', {});
  return out;
}
