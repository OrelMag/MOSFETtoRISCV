// Memory contents: the live words of the scene's memories (view/memfind.ts finds them at any depth: a RAM, a register
// file, a cache's arrays, a large RAM, rv16_rf), one at a time in view/memview.ts's grid, the addressed word (being
// read) and the word the next clock edge writes highlighted. A picker chooses between several; pointing at it lights
// the chosen memory's block on the circuit. Stage adds this panel by itself to a scene with a memory (autoMemPanel).

import { h } from '../ui/dom';
import { findMemories, type MemInfo } from '../view/memfind';
import { memGrid } from '../view/memview';
import type { ScenePanel, Stage, Widget } from '../view/stage';
import type { Sim } from '../sim/sim';

/** A memory's name in the picker: its path, or the circuit itself. */
export const memName = (m: MemInfo): string => m.path || 'this circuit';
export const memSize = (m: MemInfo): string => `${m.words} × ${m.width} bits`;

export const memGridPanel: ScenePanel = (stage: Stage): Widget => {
  const grid = memGrid();
  const size = h('span', { style: 'font-weight:500;color:var(--muted)' }, '');
  const title = h('h4', null, 'Memory contents', size);
  const pick = h('select', { class: 'mem-pick', 'aria-label': 'Memory' }) as HTMLSelectElement;
  const note = h('p', { class: 'mem-note' });
  // docked right like the CPU panel: the fit leaves room for it, and it starts folded where it would hide the circuit;
  // data-mem: a scene panel that shows memory, so Stage adds no second one
  const el = h('div', { class: 'mem-panel', 'data-dock': 'right', 'data-fold': 'narrow', 'data-mem': '' }, title, pick, grid.el, note);
  title.title = 'Click to collapse / expand'; // (the stage folds a right-docked panel: Stage.foldable)
  let mems: MemInfo[] = [], sim: Sim | null = null;
  const chosen = () => mems[pick.selectedIndex] ?? mems[0] ?? null;
  // the chosen memory's top-level block lit while the pointer is on the picker
  const top = () => chosen()?.path.split('.')[0] ?? '';
  pick.addEventListener('mouseenter', () => { if (top()) stage.highlight([top()]); });
  pick.addEventListener('mouseleave', () => stage.highlight(stage.scene?.highlight ?? []));
  pick.addEventListener('change', () => { if (top()) stage.highlight([top()]); update(); });
  const update = () => {
    const root = stage.rootCtx;
    if (!root) return;
    if (root.sim !== sim) {
      sim = root.sim;
      mems = findMemories(sim, root.node);
      pick.replaceChildren(...mems.map((m) => h('option', null, `${memName(m)} (${m.words} × ${m.width})`)));
      pick.hidden = mems.length < 2;
    }
    const m = chosen();
    size.textContent = m ? memSize(m) : '';
    grid.show(sim, m);
    const problems = m?.built?.problems ?? [];
    note.textContent = problems.join('; ');
    note.hidden = !problems.length;
  };
  update();
  return { el, update };
};
