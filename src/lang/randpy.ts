// Seeded random programs in the Python subset, for fuzzing the compiler against the interpreter
// (tests/pylang.test.ts; PY_FUZZ=<n> for a longer sweep). Indices are masked to the list, loops are bounded.


function rng(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 2 ** 32; };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T>(xs: T[]): T => xs[Math.floor(next() * xs.length)] };
}

/** A seeded random program: globals, a list, up to two functions, nested blocks; every while loop is bounded. */
export function randomPyProgram(seed: number): string {
  const r = rng(seed);
  const out: string[] = [];
  const G = ['g0', 'g1', 'g2', 'g3'];
  const consts = () => r.pick([0, 1, 2, 3, 5, 7, 8, 16, -1, -3, 100, 2047, 2048, -2049, 65536, 0x7fffffff, -0x80000000, r.int(1000) - 500]);
  const funcs: { name: string; arity: number }[] = [];
  const expr = (vars: string[], depth: number, calls: boolean): string => {
    const k = depth <= 0 ? r.int(3) : r.int(14);
    switch (k) {
      case 0: return String(consts());
      case 1: case 2: return r.pick(vars);
      case 3: return `L[${expr(vars, depth - 1, calls)} & 7]`;
      case 4: case 5: case 6: {
        const op = r.pick(['+', '-', '*', '//', '%', '&', '|', '^', '<<', '>>', '+', '-']);
        const right = op === '<<' || op === '>>' ? String(r.int(40)) : r.next() < 0.4 ? String(consts()) : expr(vars, depth - 1, calls);
        return `(${expr(vars, depth - 1, calls)} ${op} ${right})`;
      }
      case 7: return `(${r.pick(['-', '~', 'not '])}${expr(vars, depth - 1, calls)})`;
      case 8: {
        const n = 1 + r.int(2);
        const parts = [expr(vars, depth - 1, calls)];
        for (let i = 0; i < n; i++) parts.push(r.pick(['<', '<=', '>', '>=', '==', '!=']), expr(vars, depth - 1, calls));
        return `(${parts.join(' ')})`;
      }
      case 9: return `(${expr(vars, depth - 1, calls)} ${r.pick(['and', 'or'])} ${expr(vars, depth - 1, calls)})`;
      case 10: return `(${expr(vars, depth - 1, calls)} if ${expr(vars, depth - 1, calls)} else ${expr(vars, depth - 1, calls)})`;
      case 11: {
        const f = r.pick(['abs', 'min', 'max']);
        return f === 'abs' ? `abs(${expr(vars, depth - 1, calls)})` : `${f}(${expr(vars, depth - 1, calls)}, ${expr(vars, depth - 1, calls)})`;
      }
      default: {
        if (!calls || !funcs.length) return r.pick(vars);
        const f = r.pick(funcs);
        return `${f.name}(${Array.from({ length: f.arity }, () => expr(vars, depth - 2, calls)).join(', ')})`;
      }
    }
  };
  let loopN = 0;
  const block = (ind: string, vars: string[], writable: string[], depth: number, calls: boolean, lines: string[], n: number) => {
    for (let i = 0; i < n; i++) {
      const k = depth <= 0 ? r.int(4) : r.int(8);
      switch (k) {
        case 0: lines.push(`${ind}${r.pick(writable)} = ${expr(vars, 3, calls)}`); break;
        case 1: lines.push(`${ind}${r.pick(writable)} ${r.pick(['+=', '-=', '*=', '^=', '//=', '%=', '|=', '&=', '<<=', '>>='])} ${expr(vars, 2, calls)}`); break;
        case 2: lines.push(`${ind}print(${expr(vars, 3, calls)})`); break;
        case 3: lines.push(`${ind}L[${expr(vars, 2, calls)} & 7] ${r.pick(['=', '+='])} ${expr(vars, 2, calls)}`); break;
        case 4: {
          lines.push(`${ind}if ${expr(vars, 2, calls)}:`);
          block(ind + '    ', vars, writable, depth - 1, calls, lines, 1 + r.int(2));
          if (r.next() < 0.5) {
            lines.push(`${ind}${r.next() < 0.5 ? `elif ${expr(vars, 2, calls)}` : 'else'}:`);
            block(ind + '    ', vars, writable, depth - 1, calls, lines, 1 + r.int(2));
          }
          break;
        }
        case 5: {
          const v = r.pick(writable);
          const step = r.pick([1, 1, 2, -1, 3]);
          lines.push(step > 0 ? `${ind}for ${v} in range(${r.int(3)}, ${expr(vars, 1, false)} & 3, ${step}):` : `${ind}for ${v} in range(${expr(vars, 1, false)} & 3, -1, -1):`);
          block(ind + '    ', vars, writable, depth - 1, calls, lines, 1 + r.int(2));
          if (r.next() < 0.2) lines.push(`${ind}    ${r.pick(['break', 'continue'])}`);
          break;
        }
        case 6: {
          const w = `w${loopN++}`;
          lines.push(`${ind}${w} = 0`, `${ind}while ${w} < ${1 + r.int(3)}:`, `${ind}    ${w} += 1`);
          block(ind + '    ', vars, writable, depth - 1, calls, lines, 1 + r.int(2));
          break;
        }
        default: lines.push(`${ind}print(${expr(vars, 2, calls)}, ${expr(vars, 2, calls)})`);
      }
    }
  };
  out.push(`L = [${Array.from({ length: 8 }, () => consts()).join(', ')}]`);
  for (const g of G) out.push(`${g} = ${consts()}`);
  const nf = r.int(3);
  for (let f = 0; f < nf; f++) {
    const arity = 1 + r.int(3);
    const params = Array.from({ length: arity }, (_, i) => `p${i}`);
    const locs = ['u', 'v'];
    const lines: string[] = [`def f${f}(${params.join(', ')}):`];
    const writes = r.next() < 0.5 ? [r.pick(G)] : [];
    if (writes.length) lines.push(`    global ${writes[0]}`);
    for (const l of locs) lines.push(`    ${l} = ${expr([...params, ...G], 2, true)}`);
    loopN = 100 * (f + 1);
    block('    ', [...params, ...locs, ...G], [...params, ...locs, ...writes], 2, true, lines, 2 + r.int(3));
    lines.push(`    return ${expr([...params, ...locs], 2, true)}`);
    out.push(...lines);
    funcs.push({ name: `f${f}`, arity });
  }
  loopN = 0;
  block('', G, G, 2, true, out, 3 + r.int(5));
  out.push(`print(${G.join(', ')})`, 'for i in range(8):', '    print(L[i])');
  return out.join('\n') + '\n';
}
