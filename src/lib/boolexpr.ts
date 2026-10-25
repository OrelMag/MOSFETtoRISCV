// Boolean expressions over named variables (DOM-free): the campaign's K-map drills check answers with them, the
// sandbox's truth-table chips fill an output from one (editor/tableui.ts).

export type BoolEx = { k: 'v'; i: number } | { k: 'c'; v: 0 | 1 } | { k: 'not'; a: BoolEx } | { k: 'and' | 'or' | 'xor'; a: BoolEx; b: BoolEx };

/**
 * Parse a Boolean expression over the given variables. NOT: prefix ¬ ~ ! or postfix ' ; AND: · * &
 * or juxtaposition; OR: + |; XOR: ^ ⊕; constants 0 / 1; parentheses. With one-letter variables `ab` is a·b; when a
 * name is longer (d3, rst) names are whole identifiers, ANDed by a space or ·.
 */
export function parseBool(src: string, vars: string[]): { ex: BoolEx; literals: number } | { error: string } {
  const multi = vars.some((v) => v.length > 1);
  const toks = src.replace(/\s+/g, ' ').trim().match(multi ? /[A-Za-z_][A-Za-z0-9_]*|[01]|[()¬~!'+|^⊕·*&]|./g : /[A-Za-z]|[01]|[()¬~!'+|^⊕·*&]|./g) ?? [];
  let pos = 0, literals = 0;
  const peek = () => (pos < toks.length ? toks[pos] : '');
  const fail = (m: string): never => { throw new Error(m); };
  const atomStart = (t: string) => /^[A-Za-z_01(¬~!]/.test(t);
  const orE = (): BoolEx => {
    let a = xorE();
    while (peek() === '+' || peek() === '|') { pos++; a = { k: 'or', a, b: xorE() }; }
    return a;
  };
  const xorE = (): BoolEx => {
    let a = andE();
    while (peek() === '^' || peek() === '⊕') { pos++; a = { k: 'xor', a, b: andE() }; }
    return a;
  };
  const andE = (): BoolEx => {
    let a = unary();
    for (;;) {
      if (['·', '*', '&'].includes(peek())) { pos++; a = { k: 'and', a, b: unary() }; } else if (peek() === ' ') { pos++; } else if (atomStart(peek())) a = { k: 'and', a, b: unary() };
      else return a;
    }
  };
  const unary = (): BoolEx => {
    while (peek() === ' ') pos++;
    let e: BoolEx;
    const t = peek();
    if (t === '¬' || t === '~' || t === '!') { pos++; e = { k: 'not', a: unary() }; } else if (t === '(') {
      pos++;
      e = orE();
      while (peek() === ' ') pos++;
      if (peek() !== ')') fail('missing )');
      pos++;
    } else if (t === '0' || t === '1') { pos++; e = { k: 'c', v: t === '1' ? 1 : 0 }; } else if (/^[A-Za-z_]/.test(t)) {
      const i = vars.includes(t) ? vars.indexOf(t) : vars.indexOf(t.toLowerCase());
      if (i < 0) fail(`unknown variable ${t} (use ${vars.join(', ')})`);
      pos++;
      literals++;
      e = { k: 'v', i };
    } else return fail(t ? `unexpected ${t}` : 'incomplete expression');
    while (peek() === "'") { pos++; e = { k: 'not', a: e }; }
    while (peek() === ' ' && toks[pos + 1] === "'") pos++;
    return e;
  };
  try {
    const ex = orE();
    while (peek() === ' ') pos++;
    if (pos < toks.length) fail(`unexpected ${peek()}`);
    return { ex, literals };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Evaluate with variable values packed in `x` (vars[0] is the most significant bit). */
export function evalBool(e: BoolEx, x: number, n: number): number {
  switch (e.k) {
    case 'v': return (x >> (n - 1 - e.i)) & 1;
    case 'c': return e.v;
    case 'not': return evalBool(e.a, x, n) ^ 1;
    case 'and': return evalBool(e.a, x, n) & evalBool(e.b, x, n);
    case 'or': return evalBool(e.a, x, n) | evalBool(e.b, x, n);
    default: return evalBool(e.a, x, n) ^ evalBool(e.b, x, n);
  }
}
