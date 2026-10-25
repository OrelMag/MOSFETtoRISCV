// The Tests pane (slots.bottom): a chip's test tables (ChipDoc.tests, Digital's test syntax: testtable.ts), one tab
// each, the text beside its results. A table runs after every edit of the chip or of the text (up to AUTO_STEPS steps;
// longer ones on Run), its rows listed with what the circuit showed; a failing row opens the test player on it, and
// "Fill outputs from the circuit" writes what the circuit shows into the table. Edits of the text are one undo step
// per pause in typing (TYPE_MS), as the Verilog pane's.

import '../styles/editor-tests.css';
import { h, icon } from '../ui/dom';
import type { CheckResult } from './challenges';
import { type Editor, registerEditorPlugin, registerToolbarAction } from './editor';
import type { ChipDoc, TestDoc } from './model';
import { registerPropsSection } from './props';
import { fillOutputs, parseTest, planTest, runTest, starterTest, type TestPlan, type TestRun, testsOf } from './testtable';
import { TestPlayer } from './testplayer';
import { testSet } from './testrun';

/** Steps a table may take to run by itself after an edit; a longer one waits for Run. */
const AUTO_STEPS = 20_000;
const TYPE_MS = 500;
const RUN_MS = 250;
/** Rows listed around the first failure (or from the top). */
const SHOWN = 200;

interface Outcome {
  plan?: TestPlan;
  names?: string[];
  run?: TestRun;
  error?: { msg: string; line: number };
  /** Too long to run by itself: waiting for Run. */
  waiting?: boolean;
  ms?: number;
}

const fmt = (bits: number[]): string => {
  if (bits.some((b) => b !== 0 && b !== 1)) return bits.length === 1 ? (bits[0] === 3 ? 'Z' : 'X') : bits.slice().reverse().map((b) => (b === 0 ? '0' : b === 1 ? '1' : b === 3 ? 'Z' : 'X')).join('');
  return bits.reduce((a, b, i) => a + (b ? 2n ** BigInt(i) : 0n), 0n).toString();
};
const cellText = (c: bigint | string) => (typeof c === 'bigint' ? c.toString() : c);

class TestsPane {
  open = false;
  readonly el = h('div', { class: 'sb-tests', role: 'region', 'aria-label': 'Tests' });
  private sel = 0;
  private auto = true;
  /** Results by chip id and table index, for the compiled circuit they ran on. */
  private outcomes = new Map<string, { built: unknown; srcs: string[]; res: Outcome[] }>();
  private typeTimer: ReturnType<typeof setTimeout> | null = null;
  private runTimer: ReturnType<typeof setTimeout> | null = null;
  private player: TestPlayer | null = null;
  private text: HTMLTextAreaElement | null = null;
  private off: (() => void)[] = [];

  constructor(private ed: Editor) {
    ed.slots.bottom.append(this.el);
    this.off.push(ed.onChange(() => this.changed()), ed.onSimChange(() => this.player?.simChanged()));
  }

  destroy(): void {
    this.closePlayer();
    if (this.typeTimer) clearTimeout(this.typeTimer);
    if (this.runTimer) clearTimeout(this.runTimer);
    this.off.forEach((f) => f());
    this.el.remove();
  }

  setOpen(on: boolean): void {
    this.open = on;
    if (on && !testsOf(this.ed.doc).length) this.addTable();
    if (!on) this.closePlayer();
    // the tables not run since the last edit of this chip (opening runs them; switching chips runs nothing by itself)
    if (on) this.runAll(false);
    this.render();
    this.ed.renderActions();
  }

  private get tests(): TestDoc[] {
    return testsOf(this.ed.doc);
  }

  /** The chip, its circuit or its tables changed: run again (the text being typed waits for its own timer). */
  private changed(): void {
    this.sel = Math.min(this.sel, Math.max(0, this.tests.length - 1));
    if (this.runTimer) clearTimeout(this.runTimer);
    this.runTimer = setTimeout(() => { this.runTimer = null; this.runAll(false); }, RUN_MS);
    if (this.open && !this.typing()) this.render();
  }

  private typing(): boolean {
    return !!this.text && document.activeElement === this.text && this.typeTimer !== null;
  }

  /** Outcomes for the current chip: rerun the tables whose text or circuit changed (`force`: long ones too). */
  runAll(force: boolean): Outcome[] {
    const doc = this.ed.doc, c = this.ed.compiled;
    const srcs = this.tests.map((t) => t.src);
    const prev = this.outcomes.get(doc.id);
    const res: Outcome[] = srcs.map((src, i) => {
      const old = prev && prev.built === c && prev.srcs[i] === src ? prev.res[i] : undefined;
      if (old && !(force && old.waiting)) return old;
      return this.runOne(doc, this.tests[i], force);
    });
    this.outcomes.set(doc.id, { built: c, srcs, res });
    if (this.open && !this.typing()) this.render();
    this.ed.props.update();
    return res;
  }

  private runOne(doc: ChipDoc, t: TestDoc, force: boolean): Outcome {
    const c = this.ed.compiled;
    if (!c || c.diags.some((d) => d.level === 'error')) return { error: { msg: 'the circuit has errors: fix them to run its tests', line: 0 } };
    const plan = planTest(c.def, t);
    if ('error' in plan) return { error: { msg: plan.error, line: plan.line } };
    const parsed = parseTest(t.src);
    const names = 'error' in parsed ? [] : parsed.names;
    const n = plan.ch.check.kind === 'sequence' ? plan.ch.check.steps.length : 0;
    if (n > AUTO_STEPS && !force) return { plan, names, waiting: true };
    const t0 = performance.now();
    const run = runTest(c.def, c.mode === 'switch' ? 'switch' : 'gate', plan, names);
    void doc;
    return { plan, names, run, ms: performance.now() - t0 };
  }

  private outcome(i: number): Outcome | undefined {
    const o = this.outcomes.get(this.ed.doc.id);
    return o && o.srcs[i] === this.tests[i]?.src ? o.res[i] : undefined;
  }

  /** ✓ / ✗ / … for a table, from its last run. */
  status(i: number): 'pass' | 'fail' | 'none' {
    const o = this.outcome(i);
    if (!o || o.waiting) return 'none';
    if (o.error || !o.run) return 'fail';
    return o.run.failed.length || o.run.error ? 'fail' : 'pass';
  }

  // ---- editing -------------------------------------------------------------------------------

  private setTests(f: (ts: TestDoc[]) => TestDoc[]): void {
    this.ed.edit((d) => {
      const ts = f(testsOf(d));
      const next = { ...d, tests: ts.length ? ts : undefined };
      if (!ts.length) delete next.tests;
      return next;
    });
  }

  private addTable(): void {
    const doc = this.ed.doc;
    const used = new Set(this.tests.map((t) => t.name));
    let name = 'test';
    for (let k = 2; used.has(name); k++) name = `test ${k}`;
    this.setTests((ts) => [...ts, starterTest(doc, name)]);
    this.sel = this.tests.length - 1;
  }

  private typed(src: string): void {
    if (this.typeTimer) clearTimeout(this.typeTimer);
    const i = this.sel;
    this.typeTimer = setTimeout(() => {
      this.typeTimer = null;
      this.setTests((ts) => ts.map((t, k) => (k === i ? { ...t, src } : t)));
    }, TYPE_MS);
  }

  /** Writes pending typing now (before a button acts on the text). */
  private flush(): void {
    if (!this.typeTimer || !this.text) return;
    clearTimeout(this.typeTimer);
    this.typeTimer = null;
    const src = this.text.value, i = this.sel;
    this.setTests((ts) => ts.map((t, k) => (k === i ? { ...t, src } : t)));
  }

  private rename(): void {
    const t = this.tests[this.sel];
    if (!t) return;
    const n = prompt('Name of this table', t.name)?.trim();
    if (!n || n === t.name) return;
    const i = this.sel;
    this.setTests((ts) => ts.map((x, k) => (k === i ? { ...x, name: n } : x)));
  }

  private remove(): void {
    const t = this.tests[this.sel];
    if (!t) return;
    const i = this.sel;
    this.setTests((ts) => ts.filter((_, k) => k !== i));
    this.sel = Math.max(0, i - 1);
    this.ed.toast(`Deleted the table “${t.name}”: Ctrl+Z brings it back`);
  }

  private fill(): void {
    this.flush();
    const i = this.sel, t = this.tests[i];
    const o = this.runAll(true)[i];
    if (!t || !o?.plan || !o.run || !o.names) return void this.ed.toast(o?.error ? `Line ${o.error.line}: ${o.error.msg}` : 'Nothing to fill', 'err');
    const f = fillOutputs(t.src, o.plan, o.names, o.run);
    if (!f.filled) return void this.ed.toast('No plain rows to fill: rows inside repeat or loop, and rows with expressions, stay as written', 'err');
    this.setTests((ts) => ts.map((x, k) => (k === i ? { ...x, src: f.src } : x)));
    this.ed.toast(`Filled the outputs of ${f.filled} row${f.filled > 1 ? 's' : ''} from the circuit${f.kept ? ` (${f.kept} left as written)` : ''}. Check them: a table filled from a wrong circuit tests nothing`);
  }

  // ---- the test player -------------------------------------------------------------------------

  private play(step: number): void {
    const o = this.outcome(this.sel);
    if (!o?.plan || !o.run) return;
    this.closePlayer();
    const set = testSet(o.plan.ch);
    if (!set) return;
    const r: CheckResult = {
      ok: !o.run.failed.length, failures: [], restrictionViolations: [], tested: o.run.steps.length, failed: o.run.failed,
      score: { nand: 0, transistors: 0, depth: null },
    };
    this.player = new TestPlayer(this.ed, o.plan.ch, set, r, () => { this.closePlayer(); this.render(); });
    this.player.goto(step);
    this.render();
  }

  private closePlayer(): void {
    const p = this.player;
    if (!p) return;
    this.player = null;
    p.close();
  }

  // ---- drawing -------------------------------------------------------------------------------

  render(): void {
    this.el.classList.toggle('on', this.open);
    // the player takes the pane's body while it plays (its own rows; Close gives the table back)
    this.el.classList.toggle('playing', !!this.player);
    if (!this.open) return void this.el.replaceChildren();
    const tests = this.tests;
    const tabs = tests.map((t, i) => {
      const st = this.status(i);
      return h('button', {
        class: `btn sm sb-tests-tab ${st}${i === this.sel ? ' sel' : ''}`, 'aria-pressed': String(i === this.sel), title: `${t.name}: ${st === 'pass' ? 'passes' : st === 'fail' ? 'fails' : 'not run'}`,
        onclick: () => { this.flush(); this.sel = i; this.closePlayer(); this.render(); },
        ondblclick: () => this.rename(),
      }, t.name, h('span', { class: 'mark', 'aria-hidden': 'true' }, st === 'pass' ? '✓' : st === 'fail' ? '✗' : '·'));
    });
    const head = h('div', { class: 'sb-tests-head' },
      h('b', null, 'Tests'),
      ...tabs,
      h('button', { class: 'btn sm ghost', title: 'A new table for this chip, its pins as the header', onclick: () => this.addTable() }, icon('plus', 12), 'Table'),
      h('span', { class: 'spacer' }),
      h('label', { class: 'sb-tests-auto', title: `Run the tables after every edit (up to ${AUTO_STEPS.toLocaleString('en')} steps each)` },
        h('input', { type: 'checkbox', checked: this.auto, onchange: (e: Event) => { this.auto = (e.target as HTMLInputElement).checked; } }), 'Run on every edit'),
      tests.length ? h('button', { class: 'btn sm', title: 'Write what the circuit shows into the outputs of the plain rows', onclick: () => this.fill() }, 'Fill outputs from the circuit') : null,
      tests.length ? h('button', { class: 'btn sm primary', title: 'Run every table now', onclick: () => { this.flush(); this.runAll(true); } }, icon('play', 12), 'Run all') : null,
      h('button', { class: 'btn sm ghost icon-only', 'aria-label': 'Close the Tests pane', title: 'Close', onclick: () => this.setOpen(false) }, icon('close', 14)));
    const t = tests[this.sel];
    if (!t) return void this.el.replaceChildren(head, h('p', { class: 'sb-tests-empty' }, 'No tables yet: + Table starts one with this chip\'s pins.'));
    const text = h('textarea', {
      class: 'sb-tests-src', spellcheck: 'false', 'aria-label': `Table ${t.name}, Digital test syntax`,
      oninput: (e: Event) => this.typed((e.target as HTMLTextAreaElement).value),
      onblur: () => this.flush(),
    }) as HTMLTextAreaElement;
    text.value = t.src;
    this.text = text;
    const tools = h('div', { class: 'sb-tests-tools' },
      h('button', { class: 'btn sm ghost', onclick: () => this.rename() }, 'Rename'),
      h('button', { class: 'btn sm ghost', onclick: () => this.remove() }, 'Delete'),
      h('a', { class: 'sb-tests-help', href: 'https://github.com/hneemann/Digital', target: '_blank', rel: 'noopener', title: 'Names, then rows: 0 1 X Z C, numbers (0x, 0b), (expressions), repeat(n), loop(v, n) … end loop, let v = e;' }, 'Syntax: Digital\'s'));
    this.el.replaceChildren(head, h('div', { class: 'sb-tests-body' }, h('div', { class: 'sb-tests-left' }, text, tools), this.results(this.sel)), ...(this.player ? [this.player.el] : []));
  }

  private results(i: number): HTMLElement {
    const o = this.outcome(i);
    const box = h('div', { class: 'sb-tests-res', role: 'status' });
    if (!o) return box.appendChild(h('p', { class: 'sb-tests-sum muted' }, 'Running…')), box;
    if (o.error) {
      box.append(h('p', { class: 'sb-tests-err' }, o.error.line ? `Line ${o.error.line}: ` : '', o.error.msg));
      return box;
    }
    const steps = o.plan!.ch.check.kind === 'sequence' ? o.plan!.ch.check.steps.length : 0;
    if (o.waiting || !o.run) {
      box.append(h('p', { class: 'sb-tests-sum' }, `${steps.toLocaleString('en')} rows: too many to run after every edit. `, h('button', { class: 'btn sm primary', onclick: () => this.runAll(true) }, 'Run')));
      return box;
    }
    const run = o.run, plan = o.plan!, names = o.names!;
    const bad = run.failed.length;
    box.append(h('p', { class: 'sb-tests-sum' },
      h('b', null, `${steps.toLocaleString('en')} rows`), ' ',
      h('span', { class: 'ok' }, `${(run.steps.length - bad + (run.error ? 1 : 0)).toLocaleString('en')} pass`), ' ',
      bad ? h('span', { class: 'bad' }, `${bad} fail${bad > 1 ? '' : 's'}`) : null, ' ',
      h('span', { class: 'muted' }, `${o.ms! < 10 ? o.ms!.toFixed(1) : Math.round(o.ms!)} ms`),
      ...plan.notes.map((n) => h('span', { class: 'muted note' }, n))));
    const first = run.failed[0];
    const from = first === undefined ? 0 : Math.max(0, first - 3);
    const to = Math.min(steps, from + SHOWN);
    const ins = plan.ch.ports.filter((p) => p.dir === 'in' && names.includes(p.name)).map((p) => p.name);
    const outs = run.outputs;
    const c = plan.ch.check.kind === 'sequence' ? plan.ch.check : null;
    const grid = h('table', { class: 'sb-tests-grid' },
      h('thead', null, h('tr', null, h('th', null, 'row'), ...ins.map((n) => h('th', null, n)), ...outs.flatMap((n) => [h('th', null, `${n} expected`), h('th', null, `${n} got`)]), h('th', null, ''))));
    const body = h('tbody');
    const failed = new Set(run.failed);
    for (let k = from; k < to; k++) {
      const st = c!.steps[k], row = plan.rows[plan.rowOf[k]];
      const res = run.steps[k];
      const isBad = failed.has(k);
      body.append(h('tr', { class: isBad ? 'bad' : res ? '' : 'notrun', title: `line ${row.line}${row.where ? `, ${row.where}` : ''}`, ondblclick: () => this.play(k) },
        h('td', null, String(k + 1)),
        ...ins.map((n) => h('td', null, n === plan.ch.ports.find((p) => p.clock)?.name && st.tick ? 'C' : String(st.set?.[n] ?? '0'))),
        ...outs.flatMap((n, j) => {
          const want = st.expect[n];
          const got = res ? fmt(res.got[j]) : 'not run';
          return [h('td', null, want === undefined ? 'X' : String(want)), h('td', { class: isBad && want !== undefined && got !== String(want) ? 'wrong' : '' }, got)];
        }),
        h('td', { class: 'mark' }, isBad ? '✗' : res ? '✓' : '·')));
    }
    grid.append(body);
    box.append(h('div', { class: 'sb-tests-scroll' }, grid));
    if (to < steps || from > 0) box.append(h('p', { class: 'muted sb-tests-more' }, `Rows ${from + 1}–${to} of ${steps.toLocaleString('en')}`));
    if (first !== undefined) {
      const row = plan.rows[plan.rowOf[first]];
      const res = run.steps[first];
      const st = c!.steps[first];
      const why = run.error && first >= run.steps.length ? run.error
        : outs.flatMap((n, j) => (st.expect[n] !== undefined && res && fmt(res.got[j]) !== String(st.expect[n]) ? [`${n} expected ${st.expect[n]}, got ${fmt(res.got[j])}`] : [])).join('; ');
      box.append(h('div', { class: 'sb-tests-fail' },
        h('span', null, `Row ${first + 1} (line ${row.line}${row.where ? `, ${row.where}` : ''}): ${why}${bad > 1 ? `, and ${bad - 1} more` : ''}.`),
        first < run.steps.length || !run.error ? h('button', { class: 'btn sm sb-tests-play', onclick: () => this.play(first) }, icon('play', 12), 'Play this row') : null));
    }
    void cellText;
    return box;
  }
}

const of = new WeakMap<Editor, TestsPane>();

registerEditorPlugin((ed) => {
  if (ed.level) return;
  const p = new TestsPane(ed);
  of.set(ed, p);
  return () => p.destroy();
});

registerToolbarAction({
  id: 'tests', title: 'Tests: tables of inputs and expected outputs for this chip, run after every edit', icon: 'table', label: 'Tests', order: 62,
  run: (ed) => { const p = of.get(ed); p?.setOpen(!p.open); },
  active: (ed) => !!of.get(ed)?.open,
});

registerPropsSection({
  id: 'tests', order: 16,
  render: (ed) => {
    const p = of.get(ed);
    const n = testsOf(ed.doc).length;
    if (!p || ed.selCount || !n) return null;
    const st = testsOf(ed.doc).map((_, i) => p.status(i));
    const fails = st.filter((s) => s === 'fail').length, passes = st.filter((s) => s === 'pass').length;
    return h('section', { class: `sb-sec-props sb-tests-props ${fails ? 'bad' : passes === n ? 'ok' : ''}` },
      h('h4', null, 'Tests'),
      h('p', null, `${n} table${n > 1 ? 's' : ''}: `, fails ? h('b', { class: 'bad' }, `${fails} fail${fails > 1 ? '' : 's'}`) : passes === n ? h('b', { class: 'ok' }, 'all pass') : 'not run yet', ' ',
        h('button', { class: 'btn sm ghost', onclick: () => p.setOpen(true) }, 'Open')));
  },
});
