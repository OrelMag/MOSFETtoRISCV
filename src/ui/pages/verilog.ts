// A Verilog twin (#/campaign/play/vl_<level>): a campaign build level written in Verilog. The side pane is the spec (Spec /
// Tests / Drawn version), the main area the source with Yosys's diagnostics on their lines and the Check card; the model is
// campaign/verilog.ts (synthesize, then the level's own check). Optional: a pass is recorded under the twin's id and
// changes nothing on the map but a star beside the level. Loaded on demand with the editor's styles.

import '../../styles/editor.css';
import '../../styles/campaign.css';
import '../../styles/level.css';
import '../../styles/editor-hdl.css';
import '../../styles/capstone.css';
import '../../styles/verilog.css';
import { progress } from '../../campaign/progress';
import { nodeById } from '../../campaign/nodes';
import { drawnNands, drawnScore, type TwinResult, checkTwin, TWINS, twinById, twinChallenge, twinChipId, twinReference, twinStart, twinTitle, type VerilogTwin } from '../../campaign/verilog';
import { twinKey } from '../../campaign/twinids';
import { ins, importAnswer, outs, tableRows } from '../../editor/challenges';
import { highlight } from '../../editor/hdlhighlight';
import { newVerilogChip, setSource } from '../../editor/hdl';
import { openChip } from '../../editor/session';
import { loadWorkspace, saveWorkspace } from '../../editor/store';
import { YOSYS_BYTES, YOSYS_VERSION, yosysReady } from '../../hdl/yosys';
import type { HdlDiag } from '../../hdl/yosysjson';
import { h, icon } from '../dom';
import type { Page } from './chapter';

type Tab = 'spec' | 'tests' | 'drawn';

const TYPING_MS = 1200;
const narrow = () => matchMedia('(max-width: 900px)').matches;
const mb = (n: number) => `${Math.round(n / 1e6)} MB`;
const rich = (tag: 'p' | 'div', html: string) => { const el = h(tag); el.innerHTML = html; return el; };
const starText = (n: number) => '★'.repeat(n) + '☆'.repeat(3 - n);

export class VerilogPage implements Page {
  readonly kind = 'verilog';
  readonly el: HTMLElement;
  readonly nodeId: string;
  private t?: VerilogTwin;
  private bar = h('div', { class: 'lv-bar' });
  private side = h('aside', { class: 'lv-side', 'aria-label': 'The spec' });
  private tab: Tab = 'spec';
  private folded = narrow();
  private hl = h('pre', { class: 'hdl-hl', 'aria-hidden': 'true' });
  private ta = h('textarea', { class: 'hdl-ta', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', wrap: 'off', 'aria-label': 'Verilog source' }) as HTMLTextAreaElement;
  private stateEl = h('span', { class: 'hdl-state' });
  private diagEl = h('div', { class: 'hdl-diags', role: 'list', 'aria-label': 'Problems' });
  private logEl = h('div', { class: 'vl-log' });
  private checkEl = h('div', { class: 'vl-check card-body' });
  private runBtn = h('button', { class: 'btn primary sm', title: 'Synthesize and check (Ctrl/⌘ Enter)', onclick: () => void this.run() }, icon('play', 13), 'Synthesize & check');
  private result: TwinResult | null = null;
  private diags: HdlDiag[] = [];
  private busy: string | null = null;
  private dirty = false;
  private timer = 0;
  private token = 0;
  private compare = false;
  private shownRef = false;
  private drawnNandsN?: number;
  private offs: (() => void)[] = [];

  constructor(id: string) {
    this.nodeId = id;
    const t = TWINS.find((x) => twinKey(x.twin) === id) ?? twinById(id);
    if (!t || !nodeById(t.twin)) {
      this.el = h('div', { class: 'lv-page lv-notice' }, h('div', { class: 'panel' }, h('h3', null, `There is no Verilog twin “${id}”`),
        h('p', null, h('a', { class: 'btn', href: '#/campaign' }, icon('chevL', 14), 'Back to the campaign'))));
      return;
    }
    this.t = t;
    const p = progress();
    p.open(id, true);
    this.ta.value = p.get(id)?.src || twinStart(t);
    this.ta.addEventListener('input', () => this.typed());
    this.ta.addEventListener('scroll', () => { this.hl.scrollTop = this.ta.scrollTop; this.hl.scrollLeft = this.ta.scrollLeft; });
    this.ta.addEventListener('keydown', (e) => this.key(e));
    const code = h('div', { class: 'hdl-code' }, this.hl, this.ta);
    const editor = h('section', { class: 'vl-card vl-editor' },
      h('div', { class: 'vl-head' }, h('b', { class: 'hdl-file' }, `${t.module}.v`), h('span', { class: 'grow' }), this.stateEl,
        h('button', { class: 'btn ghost sm', title: 'Back to the starting file', onclick: () => this.reset() }, 'Start over'), this.runBtn),
      code, this.diagEl, this.logEl);
    const check = h('section', { class: 'vl-card vl-checkcard', 'aria-live': 'polite' }, h('h3', null, 'Check'), this.checkEl);
    this.el = h('div', { class: 'lv-page vl-page' }, this.bar, h('div', { class: 'lv-body' }, this.side, h('div', { class: 'vl-main' }, h('div', { class: 'vl-split' }, editor, check))));
    this.offs.push(p.onChange(() => this.renderBar()));
    this.paint();
    this.renderBar();
    this.renderSide();
    this.renderDiags();
    this.renderLog();
    this.renderCheck();
    this.renderState();
  }

  destroy(): void {
    clearTimeout(this.timer);
    this.token++;
    this.offs.forEach((f) => f());
  }

  // ---- the source ------------------------------------------------------------------------------------

  private paint(): void {
    const bad = new Set(this.diags.filter((d) => d.level === 'error' && d.line).map((d) => d.line!));
    const warn = new Set(this.diags.filter((d) => d.level === 'warn' && d.line).map((d) => d.line!));
    this.hl.innerHTML = highlight(this.ta.value).map((line, i) =>
      `<span class="ln${bad.has(i + 1) ? ' err' : warn.has(i + 1) ? ' warn' : ''}">${line || ' '}</span>`).join('') + '<span class="ln"> </span>';
  }

  private typed(): void {
    this.dirty = true;
    progress().setSource(this.nodeId, this.ta.value);
    this.paint();
    clearTimeout(this.timer);
    // Yosys is 78 MB the first time: it loads when asked, and from then on a pause in typing synthesizes again
    if (yosysReady()) this.timer = window.setTimeout(() => void this.run(), TYPING_MS);
    this.renderState();
  }

  private key(e: KeyboardEvent): void {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void this.run(); return; }
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault(); // (Shift+Tab leaves the field, so the keyboard can always get out)
      const { selectionStart: a, selectionEnd: b, value } = this.ta;
      this.ta.value = value.slice(0, a) + '  ' + value.slice(b);
      this.ta.setSelectionRange(a + 2, a + 2);
      this.typed();
    }
  }

  private reset(): void {
    if (this.ta.value !== twinStart(this.t!) && !confirm('Replace your Verilog with the starting file?')) return;
    this.ta.value = twinStart(this.t!);
    this.result = null;
    this.diags = [];
    this.typed();
    this.paint();
    this.renderDiags();
    this.renderLog();
    this.renderCheck();
  }

  private goLine(line: number): void {
    const lines = this.ta.value.split('\n');
    const at = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
    this.ta.focus();
    this.ta.setSelectionRange(at, at + (lines[line - 1]?.length ?? 0));
    this.ta.scrollTop = Math.max(0, (line - 4) * (parseFloat(getComputedStyle(this.ta).lineHeight) || 18));
  }

  // ---- synthesize and check ----------------------------------------------------------------------------

  private async run(): Promise<void> {
    clearTimeout(this.timer);
    const t = this.t!, text = this.ta.value, tok = ++this.token;
    this.dirty = false;
    this.busy = yosysReady() ? 'synthesizing…' : `Loading Yosys (${mb(YOSYS_BYTES)}, once)…`;
    this.renderState();
    this.renderCheck();
    const r = await checkTwin(t, text, (done, total) => {
      if (tok !== this.token) return;
      this.busy = `Loading Yosys ${mb(done)} / ${mb(total)} (once)`;
      this.renderState();
    });
    if (tok !== this.token) return; // typed again meanwhile: the newer run answers
    this.busy = null;
    this.result = r;
    this.diags = r.diags;
    if (r.ok && r.stars && r.nand !== undefined) progress().solveTwin(this.nodeId, r.stars, r.nand);
    this.paint();
    this.renderDiags();
    this.renderLog();
    this.renderCheck();
    this.renderState();
    this.renderBar();
    this.renderSide();
  }

  private renderState(): void {
    const r = this.result;
    this.stateEl.className = 'hdl-state';
    this.runBtn.disabled = !!this.busy;
    if (this.busy) this.stateEl.textContent = this.busy;
    else if (this.dirty) this.stateEl.textContent = yosysReady() ? 'typing…' : 'not checked yet';
    else if (r && r.diags.some((d) => d.level === 'error')) { this.stateEl.textContent = '✕ errors'; this.stateEl.classList.add('bad'); }
    else if (r?.ok) { this.stateEl.textContent = '✓ passes'; this.stateEl.classList.add('ok'); }
    else if (r) { this.stateEl.textContent = '✕ fails the check'; this.stateEl.classList.add('bad'); }
    else this.stateEl.textContent = 'not checked yet';
  }

  private renderDiags(): void {
    if (!this.diags.length) {
      this.diagEl.replaceChildren(h('div', { class: 'hdl-diag none' }, this.result && !this.dirty ? 'No problems.' : ''));
      return;
    }
    this.diagEl.replaceChildren(...this.diags.slice(0, 30).map((d) => h('button', {
      class: `hdl-diag ${d.level}`, role: 'listitem', title: d.line ? `Go to line ${d.line}` : '',
      onclick: () => d.line && this.goLine(d.line),
    }, h('span', { class: 'hdl-diag-at' }, `${d.level === 'error' ? '✕' : '⚠'} ${d.line ? `line ${d.line}` : (d.module ?? '')}`), ' ', d.msg)));
  }

  private renderLog(): void {
    const r = this.result;
    if (!r?.cells || r.diags.some((d) => d.level === 'error' && !d.line && !r.ws)) { this.logEl.replaceChildren(); return; }
    const parts = Object.entries(r.cells).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`);
    this.logEl.replaceChildren(h('span', { class: r.diags.some((d) => d.level === 'error') ? 'bad' : 'ok' }, r.diags.some((d) => d.level === 'error') ? '✕ refused' : '✓ synthesized'),
      ` · Yosys ${YOSYS_VERSION.replace(/\.\d+$/, '')} onto NAND gates · `, parts.length ? parts.join(', ') : r.diags.some((d) => d.level === 'error') ? 'no gates' : 'wires only', ' · ',
      h('span', { class: 'sub' }, 'Open the netlist to see it drawn, down to the NANDs'));
  }

  // ---- the Check card ---------------------------------------------------------------------------------

  private renderCheck(): void {
    const t = this.t!, r = this.result, el = this.checkEl;
    if (this.busy && !r) { el.replaceChildren(h('p', { class: 'vl-wait' }, this.busy)); return; }
    if (!r) {
      el.replaceChildren(...[
        h('p', null, 'Write the module, then ', h('b', null, 'Synthesize & check'), '. Yosys turns it into NANDs and flip-flops; the level\'s own tests run on the result.'),
        yosysReady() ? null : h('p', { class: 'note' }, `The first synthesis loads Yosys (${mb(YOSYS_BYTES)}, once; the browser keeps it). Nothing is uploaded.`),
        this.links()].filter((x): x is HTMLElement => !!x));
      return;
    }
    const errs = r.diags.filter((d) => d.level === 'error');
    const ref = r.ref;
    const kids: (HTMLElement | null)[] = [];
    if (!r.check) {
      kids.push(h('div', { class: 'vl-verdict bad' }, `✕ not checked: ${errs.length} error${errs.length === 1 ? '' : 's'} in the Verilog`),
        h('p', { class: 'note' }, 'Yosys\'s messages are on their lines. A design that synthesizes to latches, or has the wrong module or pins, stops here.'));
    } else {
      const c = r.check;
      const kind = twinChallenge(t).check.kind === 'sequence' ? 'test steps' : 'input vectors';
      kids.push(c.ok
        ? h('div', { class: 'vl-verdict ok' }, `✓ ${c.tested} of ${c.tested} ${kind}`)
        : h('div', { class: 'vl-verdict bad' }, `✕ fails the level's check (${c.tested} ${kind} run)`));
      if (!c.ok) kids.push(h('ul', { class: 'vl-fail' }, c.failures.slice(0, 4).map((f) => h('li', null, f))));
      kids.push(h('div', { class: 'vl-scores' },
        h('div', { class: 'vl-score' }, h('b', null, (r.nand ?? 0).toLocaleString()), 'NANDs · yours'),
        h('div', { class: 'vl-score' }, h('b', null, ref.toLocaleString()), 'NANDs · drawn reference'),
        h('div', { class: 'vl-score' }, h('b', { class: 'lv-stars' }, r.stars ? starText(r.stars) : '☆☆☆'),
          r.stars === 3 ? 'at or under the reference' : r.stars === 2 ? `within 1.5 × (≤ ${Math.floor(ref * 1.5)})` : r.stars === 1 ? `a pass; ★★ at ≤ ${Math.floor(ref * 1.5)}` : 'no stars yet')));
    }
    if (this.compare) kids.push(this.compareEl(r));
    kids.push(this.links(r));
    if (this.shownRef) kids.push(h('div', { class: 'vl-ref' }, h('b', null, 'A Verilog solution'), h('pre', { class: 'vl-code' }, twinReference(t))));
    el.replaceChildren(...kids.filter((x): x is HTMLElement => !!x));
  }

  private passed(): boolean {
    return !!this.result?.ok || progress().get(this.nodeId)?.status === 'solved' || progress().get(this.t!.twin)?.status === 'solved';
  }

  private links(r?: TwinResult): HTMLElement {
    const t = this.t!;
    return h('div', { class: 'vl-links' },
      h('button', { class: 'btn sm', disabled: !r?.check, title: 'The drawn reference against your synthesized chip', onclick: () => { this.compare = !this.compare; this.renderCheck(); } }, 'Compare with the drawn one'),
      h('button', { class: 'btn sm', title: 'Your Verilog as a chip in the sandbox: open it, then open any part down to the NANDs', onclick: () => this.openNetlist() }, 'Open the netlist'),
      this.passed() ? h('button', { class: 'btn sm ghost', onclick: () => { this.shownRef = !this.shownRef; this.renderCheck(); } }, this.shownRef ? 'Hide a Verilog solution' : 'Show a Verilog solution') : null,
      this.passed() ? h('button', { class: 'btn sm ghost', title: 'The drawn reference answer, as chips in the sandbox', onclick: () => this.openDrawn() }, 'Open the drawn answer') : null,
      h('a', { class: 'btn sm ghost', href: `#/campaign/n/${t.twin}` }, 'The drawn level', icon('chevR', 12)));
  }

  private compareEl(r: TwinResult): HTMLElement {
    const t = this.t!;
    const d = drawnScore(t), me = r.check!.score;
    const row = (label: string, a: number | null | undefined, b: number | null | undefined) => h('tr', null, h('td', null, label),
      h('td', null, a == null ? '—' : a.toLocaleString()), h('td', null, b == null ? '—' : b.toLocaleString()));
    return h('table', { class: 'lv-res-table vl-cmp' }, h('tr', null, h('th', null, 'Metric'), h('th', null, 'Yours (Verilog)'), h('th', null, 'Drawn')),
      row('NANDs', me.nand, d.nand), row('Logic depth', me.depth, d.depth), row('Clock period', me.period, d.period));
  }

  private openNetlist(): void {
    const t = this.t!;
    // one chip per twin: opening the netlist again replaces its text (a chip of the same id that is not this twin's is left alone)
    const ws0 = loadWorkspace(), id0 = twinChipId(t), file = `${t.module}.v`;
    const made = ws0.chips[id0]?.hdl?.src?.file === file
      ? { ws: openChip(setSource(ws0, id0, { text: this.ta.value, gates: 'nand', top: t.module }), id0), id: id0 }
      : newVerilogChip(ws0, this.ta.value, file, 'nand', t.module);
    const saved = saveWorkspace(made.ws);
    if (!saved.ok) { this.checkEl.prepend(h('p', { class: 'note' }, saved.reason)); return; }
    location.hash = `#/sandbox/${made.id}`;
  }

  private openDrawn(): void {
    const r = importAnswer(loadWorkspace(), twinChallenge(this.t!));
    const saved = saveWorkspace(r.ws);
    if (!saved.ok) return;
    location.hash = `#/sandbox/${r.main}`;
  }

  // ---- the bar and the spec ---------------------------------------------------------------------------------

  private renderBar(): void {
    const t = this.t!, node = nodeById(t.twin)!;
    const np = progress().get(this.nodeId);
    this.bar.replaceChildren(...[
      h('a', { class: 'lv-back', href: `#/campaign/n/${t.twin}`, title: 'The drawn level on the map' }, icon('chevL', 14), 'Campaign'),
      h('span', { class: 'lv-badge vl-tier' }, `VERILOG CHALLENGE · ACT ${node.act}`),
      h('span', { class: 'lv-crumb' }, h('b', null, `${twinTitle(t)}, in Verilog`)),
      np?.stars ? h('span', { class: 'lv-badge good' }, `PASSED ${starText(np.stars)}`) : null,
      h('span', { class: 'lv-spacer' }),
      h('a', { class: 'btn sm ghost', href: `#/campaign/n/${t.twin}` }, h('span', { class: 'lbl' }, 'Draw it instead')),
    ].filter((x): x is HTMLElement => !!x));
  }

  private renderSide(): void {
    const tabs: [Tab, string][] = [['spec', 'Spec'], ['tests', 'Tests'], ['drawn', 'Drawn version']];
    const bar = h('div', { class: 'lv-tabs', role: 'tablist' }, tabs.map(([id, label]) => {
      const on = this.tab === id && !this.folded;
      return h('button', { class: on ? 'on' : '', role: 'tab', 'aria-selected': String(on), 'aria-expanded': narrow() ? String(on) : null,
        onclick: () => { this.folded = narrow() && on; this.tab = id; this.renderSide(); } }, label);
    }));
    const body = h('div', { class: 'lv-sidebody', role: 'tabpanel' });
    if (this.tab === 'spec') this.specTab(body);
    else if (this.tab === 'tests') this.testsTab(body);
    else this.drawnTab(body);
    this.side.replaceChildren(bar, body);
    this.side.classList.toggle('folded', this.folded);
  }

  private ref(): number {
    return (this.drawnNandsN ??= drawnNands(this.t!));
  }

  private specTab(el: HTMLElement): void {
    const t = this.t!, ch = twinChallenge(t);
    const pin = (p: { name: string; dir: string; width: number }) => h('tr', null, h('td', null, p.name), h('td', null, String(p.width)), h('td', null, p.dir === 'in' ? 'in' : 'out'));
    const ref = this.ref();
    el.append(
      h('section', null, h('h4', null, 'Write it, don\'t draw it'),
        h('p', null, `The same block as the level “${twinTitle(t)}”, described in Verilog. Yosys (in your browser) turns it into NANDs and flip-flops; the level's own tests check the result, and its cost is counted like a drawn chip's.`)),
      h('section', null, h('h4', null, 'The level'), rich('p', ch.brief)),
      h('section', null, h('h4', null, `Ports of module ${t.module}`), h('div', { class: 'cap-tw' }, h('table', { class: 'cap-pins' },
        h('thead', null, h('tr', null, ['port', 'w', 'dir'].map((x) => h('th', null, x)))), h('tbody', null, [...ins(ch.ports), ...outs(ch.ports)].map(pin)))),
        h('p', { class: 'sub' }, 'Other modules may follow in the file; the top one must have exactly these ports.')),
      h('section', null, h('h4', null, 'Graded'), h('ul', null,
        h('li', null, `★ the level's ${ch.check.kind === 'sequence' ? 'test sequence' : 'truth-table check'} passes`),
        h('li', null, `★★ within 1.5 × the drawn reference's NANDs (${ref.toLocaleString()} → at most ${Math.floor(ref * 1.5).toLocaleString()})`),
        h('li', null, `★★★ at or under it (${ref.toLocaleString()})`))),
      h('section', null, h('h4', null, 'Watch for'), rich('p', t.note)),
      h('p', { class: 'cap-note' }, h('b', null, 'Optional: '), 'a Verilog twin sits beside its level and changes nothing else on the map. A latch is refused with its line.'));
  }

  private testsTab(el: HTMLElement): void {
    const ch = twinChallenge(this.t!);
    const c = ch.check;
    el.append(h('section', null, h('h4', null, 'The level\'s own tests'),
      h('p', null, c.kind === 'table'
        ? `${tableRows(c, ch.ports).length.toLocaleString()} input vectors, every output compared with the level's truth function (directed edge cases first, then the rest of the input space or a spread of it).`
        : c.kind === 'sequence' ? `${c.steps.length} clocked steps, every output compared after each step (including steps that change an input between edges and must change nothing).` : 'A bench of the level\'s own programs.'),
      h('p', { class: 'sub' }, 'Your netlist is run on the same gate-level simulator as a drawn chip. A failing case is named in the Check card with the inputs and the expected outputs.')));
  }

  private drawnTab(el: HTMLElement): void {
    const t = this.t!, node = nodeById(t.twin)!;
    const ref = this.ref();
    const done = progress().get(t.twin);
    el.append(h('section', null, h('h4', null, node.title),
      h('p', null, h('b', null, `${ref.toLocaleString()} NANDs`), ' drawn', node.par?.nand !== undefined ? ` (the level's par is ${node.par.nand.toLocaleString()})` : '', '.'),
      h('p', null, done?.stars ? `You solved the drawn level with ${starText(done.stars)}.` : 'You have not solved the drawn level yet; its answer opens after you pass this one or it.'),
      h('p', null, h('a', { class: 'btn sm', href: `#/campaign/n/${t.twin}` }, 'Open the drawn level', icon('chevR', 12)))),
      h('section', null, h('h4', null, 'Why the counts differ'),
        h('p', null, 'You choose every gate when you draw; a synthesizer chooses them from the logic, with ABC mapping onto NAND and NOT. It is often as good as a careful drawing, sometimes a little worse (a flip-flop it maps costs more than the 9-NAND one you drew), sometimes better.')));
  }
}
