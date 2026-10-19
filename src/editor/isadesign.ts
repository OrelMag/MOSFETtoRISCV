// The ISA editor's Design tab: an instruction's encoding painted on a bit grid instead of typed. A
// brush (0, 1, don't-care or one of its operand letters) dragged across the bits writes the same
// pattern text the table stores; while the drag lasts the problems, clashes, opcode map, coverage and
// decoder cost follow the draft, and letting go commits it (one undo step). Analysis: isa/design.ts.

import { analyze, bitsOf, groupPattern } from '../isa/design';
import { tableOf, type IsaDoc } from '../isa/table';
import { h, icon } from '../ui/dom';

export interface DesignState { row: number; brush: string }

/** The colour role of a pattern character (isa.css: k fixed, x ignored, reg / cond / imm, bad). */
function role(doc: IsaDoc, ch: string): string {
  if (ch === '0' || ch === '1') return 'k';
  if (ch === '-') return 'x';
  const d = doc.operands[ch];
  return !d ? 'bad' : d.kind === 'reg' ? 'reg' : d.kind === 'enum' ? 'cond' : 'imm';
}

const hexOf = (w: number, W: number) => `0x${(w >>> 0).toString(16).toUpperCase().padStart(W / 4, '0')}`;

/** commit: a changed table (one undo step, then a redraw); rerender: a redraw only (another row picked);
 *  openDecoder: build the table's decoder as a sandbox chip and open it. */
export function designPane(doc: IsaDoc, preset: boolean, st: DesignState, commit: (doc: IsaDoc) => void, rerender: () => void, patternBits: (doc: IsaDoc, p: string) => HTMLElement, openDecoder?: () => void): HTMLElement {
  const W = doc.wordBits;
  if (st.row >= doc.instrs.length) st.row = Math.max(0, doc.instrs.length - 1);
  const list = h('div', { class: 'isd-list' });
  const right = h('div', { class: 'isd-main' });
  const pane = h('div', { class: 'isa-pane isd' }, h('p', { class: 'sb-sum' },
    preset ? 'A preset: look around, then copy it to paint your own.' : 'Pick a brush and drag across the bits. 0 / 1 are fixed bits, · is ignored, a letter is that operand\'s bits (most significant first; it may be split). Letting go saves it (Ctrl+Z undoes).'),
  h('div', { class: 'isd-cols' }, list, right));

  const row = doc.instrs[st.row];
  const draft = row ? [...row.pattern.replace(/\s+/g, '').padEnd(W, '-').slice(0, W)] : [];
  const draftDoc = (): IsaDoc => ({ ...doc, instrs: doc.instrs.map((r, i) => (i === st.row ? { ...r, pattern: groupPattern(draft.join('')) } : r)) });

  // ---- the list of instructions ----
  const renderList = (d: IsaDoc, bad: Set<number>) => {
    list.replaceChildren(...d.instrs.map((r, i) => h('button', {
      type: 'button', class: `isd-item${i === st.row ? ' on' : ''}${bad.has(i) ? ' bad' : ''}`,
      onclick: () => { st.row = i; st.brush = '1'; rerender(); },
    }, h('span', null, h('b', null, r.mnemonic), r.operands.length ? ` ${r.operands.join(', ')}` : ''), patternBits(d, r.pattern))),
    preset ? '' : h('button', {
      type: 'button', class: 'btn sm isd-add',
      onclick: () => { st.row = doc.instrs.length; st.brush = '0'; commit({ ...doc, instrs: [...doc.instrs, { mnemonic: 'NEW', operands: [], pattern: '-'.repeat(W) }] }); },
    }, icon('plus', 13), 'Add an instruction'));
  };

  const grid = h('div', { class: 'isd-grid', style: `--n:${W}`, role: 'grid', 'aria-label': 'Encoding bits' });
  const side = h('div', { class: 'isd-side' });
  /** The row as the table stores it. */
  const patLine = h('code', { class: 'isd-pat' });

  // ---- everything that follows the draft ----
  const renderDraft = () => {
    const d = draftDoc();
    if (row) patLine.textContent = `${row.mnemonic}${row.operands.length ? ` ${row.operands.join(', ')}` : ''}   ${groupPattern(draft.join(''))}`;
    const a = analyze(d);
    const t = tableOf(d);
    const bad = new Set(a.clashes.flatMap((c) => [c.a, c.b]).concat(t.problems.map((p) => p.instr).filter((i) => i >= 0)));
    renderList(d, bad);
    if (!row) { right.replaceChildren(h('p', { class: 'sb-sum' }, 'No instructions yet.')); return; }

    grid.replaceChildren(
      ...Array.from({ length: W }, (_, k) => h('span', { class: 'isd-bn' }, W - 1 - k)),
      ...draft.map((ch, k) => h('span', {
        class: `isd-cell ${role(d, ch)}${k && (W - k) % 4 === 0 ? ' gap' : ''}`, 'data-k': k, role: 'gridcell',
        title: `bit ${W - 1 - k}: ${ch === '-' ? 'ignored' : ch === '0' || ch === '1' ? `fixed ${ch}` : `operand ${ch}`}`,
      }, ch === '-' ? '·' : ch)));

    const r = d.instrs[st.row];
    const mine = t.problems.filter((p) => p.instr === st.row).map((p) => p.message);
    const msgs: HTMLElement[] = [];
    for (const m of mine) msgs.push(h('div', { class: 'bad' }, m));
    for (const c of a.clashes) if (c.a === st.row || c.b === st.row) {
      const o = c.a === st.row ? c.b : c.a;
      if (!mine.some((m) => m.includes(d.instrs[o].mnemonic))) msgs.push(h('div', { class: 'bad' }, `${r.mnemonic} and ${d.instrs[o].mnemonic} both decode ${hexOf(c.word, W)}: no fixed bit tells them apart.`));
    }
    const names = (xs: number[]) => xs.map((i) => d.instrs[i].mnemonic).join(', ');
    const over = a.shadows.filter((s) => s.special === st.row).map((s) => s.general);
    const under = a.shadows.filter((s) => s.general === st.row).map((s) => s.special);
    if (over.length) msgs.push(h('div', { class: 'note' }, `A special case of ${names(over)}: the words it matches go to ${r.mnemonic} (the most specific pattern wins).`));
    if (under.length) msgs.push(h('div', { class: 'note' }, `${names(under)} ${under.length > 1 ? 'take' : 'takes'} some of its words (more fixed bits).`));
    // Each operand: its bits against what it must hold.
    for (const l of r.operands) {
      const op = d.operands[l], n = bitsOf(r.pattern, l);
      if (!op || !n) continue;
      if (op.kind === 'reg') {
        const need = Math.ceil(Math.log2(Math.max(2, op.names.length)));
        if (n < need) msgs.push(h('div', { class: 'warn' }, `${l}: ${n} bit${n > 1 ? 's' : ''} reach ${2 ** n} of its ${op.names.length} registers (${op.names[2 ** n]}… unreachable).`));
        else msgs.push(h('div', { class: 'ok' }, `${l}: ${n} bits, ${op.names.length} registers${n > need ? ` (${n - need} bit${n - need > 1 ? 's' : ''} to spare)` : ''}.`));
      } else if (op.kind === 'imm' || op.kind === 'addr') {
        const s = op.kind === 'addr' ? (op.rel ? op.scale ?? 1 : 1) : 1;
        const signed = (op.kind === 'imm' && op.signed) || (op.kind === 'addr' && op.rel);
        msgs.push(h('div', { class: 'ok' }, `${l}: ${n} bits, ${signed ? `${-(2 ** (n - 1)) * s} … ${(2 ** (n - 1) - 1) * s}` : `0 … ${2 ** n - 1}`}${op.kind === 'addr' && op.rel ? ' from the instruction' : ''}.`));
      }
    }
    if (!msgs.some((m) => m.classList.contains('bad'))) msgs.unshift(h('div', { class: 'ok' }, 'No clash: every word this pattern matches decodes to one instruction.'));

    const win = a.window;
    const omap = h('div', { class: 'isd-omap', style: `--cols:${a.cells.length > 8 ? 8 : a.cells.length}` }, a.cells.map((c) => h('button', {
      type: 'button', class: `${c.clash ? 'clash' : c.rows.length > 1 ? 'many' : c.rows.length ? 'one' : ''}${c.rows.includes(st.row) ? ' sel' : ''}`,
      title: c.rows.length ? c.rows.map((i) => d.instrs[i].mnemonic).join(', ') : 'free',
      onclick: () => { if (c.rows.length && !c.rows.includes(st.row)) { st.row = c.rows[0]; rerender(); } },
    }, h('b', null, c.value.toString(2).padStart(win.hi - win.lo + 1, '0')), c.rows.length ? c.rows.map((i) => d.instrs[i].mnemonic).join(' ') : 'free')));
    const pct = (100 * a.decoded) / a.total;
    const dec = a.decoder;
    side.replaceChildren(
      h('div', { class: 'isd-probs' }, msgs),
      h('div', null, h('h4', null, `Opcode map · bits [${win.hi}:${win.lo}]`), omap),
      h('div', { class: 'isd-fill' },
        h('div', { class: 'sb-sum' }, `${a.exact ? '' : 'at most '}${a.decoded.toLocaleString('en')} of ${a.total.toLocaleString('en')} words decode (${pct < 0.1 && pct > 0 ? '< 0.1' : pct.toFixed(1)}%): room for ${a.exact ? '' : 'at least '}${(a.total - a.decoded).toLocaleString('en')} more.`),
        h('div', { class: 'isd-bar' }, h('i', { style: `width:${Math.min(100, pct)}%` }))),
      h('div', { class: 'isd-dec' }, h('h4', null, 'Decoder'),
        h('p', null, h('b', null, `${dec.nands.toLocaleString('en')} NANDs`), `, ${dec.depth} gate delays: one AND per instruction over its fixed bits (${dec.ands} NANDs), and ${dec.nots} shared inverters${a.shadows.length ? ' (a special case\'s match, inverted, keeps the general one off)' : ''}. Fewer fixed bits per instruction, a cheaper decoder.`),
        // Built from the saved table (not a drag in progress): a match line per instruction and valid
        openDecoder && !a.clashes.length ? h('button', { type: 'button', class: 'btn sm', title: 'The decoder as a chip of your own: open it, drill into it, simulate it', onclick: openDecoder }, 'Open the decoder in the sandbox') : '',
        openDecoder && a.clashes.length ? h('p', { class: 'sb-sum' }, 'Fix the clashes first: a word two instructions both claim has no single match line.') : ''));
  };

  // ---- painting ----
  const operandLetters = row ? row.operands : [];
  const brushes = h('div', { class: 'isd-brushes', role: 'toolbar', 'aria-label': 'Brush' },
    h('span', null, 'Brush'),
    ['0', '1', '-', ...operandLetters].map((c) => h('button', {
      type: 'button', class: `isd-brush ${role(doc, c)}${st.brush === c ? ' on' : ''}`, disabled: preset,
      'aria-pressed': String(st.brush === c), title: c === '-' ? 'ignored: assembled as 0, not decoded' : c === '0' || c === '1' ? `a fixed ${c}` : `operand ${c}`,
      onclick: () => { st.brush = c; brushes.querySelectorAll('.isd-brush').forEach((b) => b.classList.toggle('on', b.textContent === (c === '-' ? '·' : c))); },
    }, c === '-' ? '·' : c)),
    preset ? null : (() => {
      const free = Object.keys(doc.operands).filter((l) => !operandLetters.includes(l)).sort();
      if (!free.length) return null;
      const sel = h('select', { 'aria-label': 'Add an operand to this instruction' }, h('option', { value: '' }, '+ operand…'), free.map((l) => h('option', { value: l }, `${l} (${doc.operands[l].kind})`))) as HTMLSelectElement;
      sel.addEventListener('change', () => {
        if (!sel.value) return;
        st.brush = sel.value;
        commit({ ...doc, instrs: doc.instrs.map((r, i) => (i === st.row ? { ...r, operands: [...r.operands, sel.value] } : r)) });
      });
      return sel;
    })());

  let painting = false;
  const paintAt = (e: PointerEvent) => {
    const cell = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>('.isd-cell');
    if (!cell || !grid.contains(cell)) return;
    const k = Number(cell.dataset.k);
    if (draft[k] === st.brush) return;
    draft[k] = st.brush;
    renderDraft();
  };
  if (!preset) {
    grid.addEventListener('pointerdown', (e) => { painting = true; grid.setPointerCapture(e.pointerId); paintAt(e); });
    grid.addEventListener('pointermove', (e) => { if (painting) paintAt(e); });
    const end = () => {
      if (!painting) return;
      painting = false;
      const p = groupPattern(draft.join(''));
      if (row && p !== groupPattern(row.pattern.replace(/\s+/g, ''))) commit(draftDoc());
    };
    grid.addEventListener('pointerup', end);
    grid.addEventListener('pointercancel', end);
  }

  if (row) {
    right.replaceChildren(
      h('div', { class: 'isd-head' }, h('b', null, row.mnemonic), row.summary ? h('span', { class: 'sb-sum' }, row.summary) : null),
      brushes,
      h('div', { class: 'isd-scroll' }, grid),
      patLine,
      side);
  }
  renderDraft();
  return pane;
}
