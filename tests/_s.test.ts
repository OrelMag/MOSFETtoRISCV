import { it } from 'vitest';
import { runPy } from '../src/lang/interp';
import { PY_STRING_PROGRAMS } from '../src/lang/pyprograms';
it('x', () => { for (const p of PY_STRING_PROGRAMS) { const r = runPy(p.source); console.log(p.id, r.error?.message, r.heapUsed, JSON.stringify(r.output), String.fromCharCode(...r.output.filter((_, i) => r.strOut[i]))); } });
