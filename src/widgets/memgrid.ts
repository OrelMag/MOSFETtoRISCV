// Live view of a RAM scene's contents: one row per word, one cell per bit. The addressed
// word (being read) and the word that the next clock edge will write are highlighted.

import { B1, BX } from '../sim/types';
import { pack } from '../sim/values';
import { h } from '../ui/dom';
import type { ScenePanel, Stage, Widget } from '../view/stage';

export const memGridPanel: ScenePanel = (stage: Stage): Widget => {
  const rows = h('div', { class: 'memgrid' });
  const title = h('h4', null, 'Memory contents', h('span', { style: 'font-weight:500;color:var(--muted)' }, ''));
  const el = h('div', { class: 'mem-panel' }, title, rows);
  title.title = 'Click to collapse / expand';
  title.addEventListener('click', () => el.classList.toggle('collapsed'));
  const update = () => {
    const root = stage.rootCtx;
    if (!root) return;
    const words = [...(root.node.children?.keys() ?? [])].filter((n) => /^w\d+$/.test(n)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    const addr = stage.getInput('addr');
    const we = stage.getInput('we');
    (title.lastChild as HTMLElement).textContent = `${words.length} × ${root.node.children!.get(words[0])!.ports.q.length} bits`;
    rows.replaceChildren();
    words.forEach((name, i) => {
      const bits = root.sim.getBits(root.node.children!.get(name)!.ports.q);
      const v = pack(bits);
      const cells = h('div', { class: 'cells' });
      for (let b = bits.length - 1; b >= 0; b--) cells.append(h('span', { class: `cell${bits[b] === B1 ? ' one' : bits[b] === BX ? ' x' : ''}` }));
      const cls = `row${i === addr ? (we ? ' write' : ' read') : ''}`;
      rows.append(h('div', { class: cls, title: i === addr ? (we ? 'will be written on the next rising clock edge' : 'being read') : '' },
        h('span', { class: 'addr' }, `[${i}]`), cells,
        h('span', { class: 'hex' }, v < 0 ? 'x' : '0x' + v.toString(16).toUpperCase().padStart(Math.ceil(bits.length / 4), '0'))));
    });
  };
  update();
  return { el, update };
};
