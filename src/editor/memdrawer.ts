// The Memory drawer: every memory in the open chip and the chips it places (view/memfind.ts: RAM parts, register files,
// large RAMs, a learner's own RAM or register file found by probing its write port), one shown live in view/memview.ts's
// grid. It opens by itself on a chip with a memory (waiting behind a drawer already shown, like the Screens drawer), and
// stays closed for a chip whose drawer the user closed. Also on the campaign's level screen (its toolbar lists 'memory').

import { h, icon } from '../ui/dom';
import { findMemories, type MemInfo } from '../view/memfind';
import { memGrid } from '../view/memview';
import { memSize } from '../widgets/memgrid';
import { dockPane, paneShown, showPane, tightForDrawer, undockPane } from './dock';
import { type Editor, registerEditorPlugin, registerToolbarAction } from './editor';
import type { Sim } from '../sim/sim';

/** While the clock runs the drawer redraws at most this often (as the CPU drawer). */
const RUN_MS = 100;

const kindOf = (m: MemInfo): string => m.built ? 'yours' : m.src.kind === 'big' ? 'large RAM' : m.prefix ? 'register file' : 'RAM';

class MemoryDrawer {
  readonly el: HTMLElement;
  open = false;
  private auto = false;
  /** The chip it opened by itself on: it stays open while that chip is edited (a half-wired memory may vanish for a moment). */
  private autoChip = '';
  /** Chips whose drawer the user closed (not reopened automatically this session). */
  private closed = new Set<string>();
  private list = h('div', { class: 'sb-mem-list', role: 'listbox', 'aria-label': 'Memories' });
  private src = h('p', { class: 'sb-mem-src' });
  private note = h('p', { class: 'mem-note' });
  private goto = h('input', { type: 'text', class: 'sb-ram-goto', placeholder: 'go to word (hex)', 'aria-label': 'Go to word', spellcheck: 'false' }) as HTMLInputElement;
  private grid = memGrid({ scroll: true });
  private mems: MemInfo[] = [];
  private sim: Sim | null = null;
  /** The chosen memory's path, kept across rebuilds. */
  private chosen = '';
  private last = 0;
  private off: (() => void)[] = [];

  constructor(private ed: Editor) {
    drawers.set(ed, this);
    this.el = h('aside', { class: 'sb-drawer sb-mem', 'aria-label': 'Memory contents' },
      h('div', { class: 'sb-drawer-head' }, icon('table', 15), h('h3', null, 'Memory contents'),
        h('button', { class: 'btn ghost icon-only', title: 'Close', 'aria-label': 'Close the Memory panel', onclick: () => this.setOpen(false, true) }, icon('close', 15))),
      h('div', { class: 'sb-mem-body' }, this.list, this.src, this.goto, this.note, this.grid.el));
    this.el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.setOpen(false, true);
    });
    this.goto.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const m = this.current(), t = this.goto.value.trim().replace(/^0x/i, '');
      const i = /^[0-9a-f]+$/i.test(t) ? parseInt(t, 16) : NaN;
      if (m && i >= 0 && i < m.words) this.grid.reveal(i);
      else if (m) ed.toast(`Go to: a word index from 0 to ${(m.words - 1).toString(16).toUpperCase()} (hex)`, 'err');
    });
    this.off.push(ed.onSimChange(() => this.sync()), ed.onChange(() => this.sync()));
    this.sync();
  }

  get hasAny(): boolean {
    return this.mems.length > 0;
  }

  private current(): MemInfo | null {
    return this.mems.find((m) => m.path === this.chosen) ?? this.mems[0] ?? null;
  }

  private sync(): void {
    const sim = this.ed.sim.sim;
    const had = this.mems.length > 0;
    if (sim !== this.sim) {
      this.sim = sim;
      this.mems = sim ? findMemories(sim) : [];
    }
    if (this.mems.length > 0 !== had) this.ed.renderActions();
    if (!this.open && this.mems.length && !this.closed.has(this.ed.chipId) && !tightForDrawer()) {
      this.setOpen(true);
      this.auto = true;
      this.autoChip = this.ed.chipId;
    } else if (this.open && this.auto && !this.mems.length && this.ed.chipId !== this.autoChip) this.setOpen(false);
    if (this.open) this.build();
  }

  toggle(): void {
    if (!this.open) this.setOpen(true, true);
    else if (!paneShown(this.ed, 'memory')) showPane(this.ed, 'memory');
    else this.setOpen(false, true);
  }

  setOpen(on: boolean, byUser = false): void {
    if (on === this.open) return;
    this.open = on;
    this.auto = false;
    if (byUser && !on) this.closed.add(this.ed.chipId);
    if (byUser && on) this.closed.delete(this.ed.chipId);
    // opening by itself, it waits behind a drawer already shown (the CPU drawer of a computer)
    if (on) {
      dockPane(this.ed, { id: 'memory', label: 'Memory', icon: 'table', el: this.el, width: 340 }, byUser);
      this.build();
    } else undockPane(this.ed, 'memory');
    this.ed.renderActions();
  }

  private build(): void {
    const cur = this.current();
    this.list.replaceChildren(...(this.mems.length ? this.mems.map((m) => h('button', {
      class: `sb-mem-item${m === cur ? ' on' : ''}`, role: 'option', 'aria-selected': String(m === cur), title: m.node.def.name,
      onclick: () => { this.chosen = m.path; this.build(); },
    }, h('code', null, m.path ? m.path.split('.').join(' › ') : 'this chip'), h('small', null, `${m.words} × ${m.width} · ${kindOf(m)}`)))
      : [h('p', { class: 'sb-scr-none' }, this.sim ? 'No RAM or register file in this chip or the chips it places.' : 'Not simulated yet.')]));
    this.src.textContent = !cur ? '' : cur.built?.guessed
      ? `${memSize(cur)}, order guessed: the words as drawn, their addresses could not be read off the circuit.`
      : cur.built
      ? `${memSize(cur)}: each word's address found by writing every ${cur.prefix ? 'register number' : 'address'} on a copy of this circuit.`
      : `${memSize(cur)}${cur.src.kind === 'big' ? ', simulated as a lookup: words from its state' : ''}.`;
    this.src.hidden = !cur;
    this.goto.hidden = !cur || cur.words <= 64;
    const problems = cur?.built?.problems ?? [];
    this.note.textContent = problems.join('; ');
    this.note.hidden = !problems.length;
    this.grid.show(this.sim, cur);
  }

  paint(): void {
    if (!this.open || !paneShown(this.ed, 'memory')) return;
    const now = performance.now();
    if (this.ed.sim.running && now - this.last < RUN_MS) return;
    this.last = now;
    this.grid.refresh();
  }

  destroy(): void {
    this.off.forEach((f) => f());
    if (this.open) undockPane(this.ed, 'memory');
  }
}

const drawers = new WeakMap<Editor, MemoryDrawer>();

registerEditorPlugin((ed) => {
  const d = new MemoryDrawer(ed);
  const paint = () => d.paint();
  ed.paintHooks.add(paint);
  return () => {
    ed.paintHooks.delete(paint);
    d.destroy();
    drawers.delete(ed);
  };
});

registerToolbarAction({
  id: 'memory', title: 'Memory panel: the words of every RAM and register file in this chip and the chips it places, live', icon: 'table', label: 'Memory', order: 64,
  run: (ed) => drawers.get(ed)?.toggle(),
  // only on a chip with a memory somewhere inside
  shown: (ed) => !!drawers.get(ed)?.open || !!drawers.get(ed)?.hasAny,
  active: (ed) => !!drawers.get(ed)?.open,
});
