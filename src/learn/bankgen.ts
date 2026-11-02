// The review bank's generator (DOM-free, Node only: it builds every combinational tour's scene and ablates codex
// figures). scripts/review-bank.ts writes its output; tests/reviewbank.test.ts checks the checked-in file against it.

import '../lib';
import { CODEX } from '../campaign/codex';
import { moreOf } from '../campaign/codexmore';
import { chapters } from '../chapters';
import { resolveComponent } from '../lib/resolve';
import { ablate, ablationRefusal } from '../sim/ablate';
import { reachesTransistors } from '../sim/harness';
import type { BankQ } from './bank';

/** At most this many removal questions per codex figure. */
const PER_FIGURE = 3;

const fmt = (v: number) => String(v);
/** A part's name inside a sentence: lower case, unless it starts with an acronym (ALU, SR latch). */
const lower = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);

/** Three wrong values a careless reader might give for `v` on a `w`-bit port: a bit off, one up or down, the top bit. */
function distractors(v: number, w: number): number[] {
  if (w === 1) return [v ^ 1];
  const mask = w >= 31 ? 0x7fffffff : (1 << w) - 1;
  const out: number[] = [];
  for (const c of [v ^ 1, (v + 1) & mask, (v - 1) & mask, v ^ (1 << (w - 1)), v ^ 2, (v + 2) & mask, 0, mask])
    if (c !== v && c >= 0 && !out.includes(c)) out.push(c);
  return out.slice(0, 3);
}

/** A fixed order for the options, from the key: the answer is not always first. */
function placed(key: string, right: string, wrong: string[]): { options: string[]; answer: number } {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const options = [...wrong];
  const at = h % (wrong.length + 1);
  options.splice(at, 0, right);
  return { options, answer: at };
}

export function buildBank(): BankQ[] {
  const out: BankQ[] = [];
  for (const c of chapters) c.steps.forEach((s, i) => {
    const t = s.tour;
    if (!t || !s.scene || t.beats.some((b) => b.cycles || b.reset)) return;
    const scene = s.scene();
    const width = new Map(scene.root.ports.map((p) => [p.name, p.width]));
    const inputs: Record<string, number> = { ...(scene.inputs ?? {}) };
    t.beats.forEach((b, k) => {
      if (b.set) Object.assign(inputs, b.set);
      if (!b.set || !b.expect) return;
      const ports = Object.keys(b.expect).filter((p) => width.has(p));
      if (!ports.length) return;
      // the widest output asked about, so the question is about the result rather than a flag
      const port = ports.reduce((a, p) => (width.get(p)! > width.get(a)! ? p : a));
      const v = b.expect[port], w = width.get(port)!;
      const key = `predict:${c.id}:${i}:${k}`;
      const ins = scene.root.ports.filter((p) => p.dir === 'in').map((p) => p.name);
      const listed = Object.entries(inputs).filter(([p]) => ins.includes(p));
      const given = listed.map(([p, x]) => `${p} = ${x}`).join(', ') + (listed.length < ins.length ? ', other inputs 0' : '');
      out.push({
        kind: 'predict', key, chapter: c.id, step: i,
        question: `${s.title}: with ${given}, what is <code>${port}</code>${w > 1 ? ` (${w} bits, as an unsigned number)` : ''}?`,
        ...placed(key, fmt(v), distractors(v, w).map(fmt)),
        explain: `The beat "${b.title ?? `${k + 1}`}" of the step's tour shows it: ${port} = ${v}. Open the step and play the tour to watch it settle.`,
      });
    });
  });
  // one set of questions per figure, counted toward every codex entry that draws it
  const figures = new Map<string, string[]>();
  for (const e of CODEX) {
    const lib = moreOf(e.id)?.lib;
    if (lib) figures.set(lib, [...(figures.get(lib) ?? []), e.id]);
  }
  for (const [lib, codex] of figures) {
    const def = resolveComponent(lib);
    if (!def || ablationRefusal(def) || reachesTransistors(def)) continue;
    let ab: ReturnType<typeof ablate>;
    try { ab = ablate(def); } catch { continue; }
    if (typeof ab === 'string' || ab.outputs.length < 2) continue;
    const name = (o: string[]) => (o.length === ab.outputs.length ? 'every output' : o.length ? o.join(' and ') : 'none: no output needs it');
    const picked = ab.parts.filter((p) => p.serves.length && p.serves.length < ab.outputs.length).slice(0, PER_FIGURE);
    for (const p of picked) {
      const key = `ablate:${lib}:${p.inst}`;
      const right = name(p.serves);
      const wrong = [...new Set([...ab.outputs.map((o) => [o]), ab.outputs, []].map(name))].filter((x) => x !== right).slice(0, 3);
      out.push({
        kind: 'ablate', key, codex,
        question: `In the ${lower(def.name)} (<code>${def.id}</code>), part <code>${p.inst}</code> is removed and its output left open. Which outputs go wrong on some input?`,
        ...placed(key, right, wrong),
        explain: `Removing ${p.inst} changes ${right} over the whole truth table: the part serves ${p.serves.join(' and ')}. The codex entry's figure shows where it sits.`,
      });
    }
  }
  return out;
}
