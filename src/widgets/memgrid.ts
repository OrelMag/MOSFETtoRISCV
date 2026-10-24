// Live view of a RAM scene's contents: one row per word, one cell per bit. The addressed
// word (being read) and the word that the next clock edge will write are highlighted.
// A register file (write port wa, read ports ra1 / ra2) is shown by register number, x0
// included: it has no storage (hard-wired zero), but its absence would shift every row.

import { B0, B1, BX } from '../sim/types';
import type { Bit } from '../sim/types';
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
    const kids = root.node.children!;
    const rf = 'wa' in root.node.ports;
    const words = [...kids.keys()].filter((n) => /^w\d+$/.test(n)).map((n) => Number(n.slice(1))).sort((a, b) => a - b);
    const width = kids.get(`w${words[0]}`)!.ports.q.length;
    const at = rf ? stage.getInput('wa') : stage.getInput('addr');
    const reads = rf ? [stage.getInput('ra1'), stage.getInput('ra2')] : [at];
    const we = stage.getInput('we');
    if (rf && words[0] !== 0) words.unshift(0);
    (title.lastChild as HTMLElement).textContent = `${words.length} × ${width} bits`;
    rows.replaceChildren();
    for (const i of words) {
      const node = kids.get(`w${i}`);
      const bits = node ? root.sim.getBits(node.ports.q) : new Array<Bit>(width).fill(B0);
      const v = pack(bits);
      const cells = h('div', { class: 'cells' });
      for (let b = bits.length - 1; b >= 0; b--) cells.append(h('span', { class: `cell${bits[b] === B1 ? ' one' : bits[b] === BX ? ' x' : ''}` }));
      // x0 ignores writes, so it is never marked as the one the next edge writes.
      const write = we && i === at && !(rf && i === 0);
      const read = reads.includes(i);
      const cls = `row${write ? ' write' : read ? ' read' : ''}`;
      const tip = write ? 'will be written on the next rising clock edge' : read ? 'being read' : rf && i === 0 ? 'x0: hard-wired to zero, no storage' : '';
      rows.append(h('div', { class: cls, title: tip },
        h('span', { class: 'addr' }, rf ? `x${i}` : `[${i}]`), cells,
        h('span', { class: 'hex' }, v < 0 ? 'x' : '0x' + v.toString(16).toUpperCase().padStart(Math.ceil(bits.length / 4), '0'))));
    }
  };
  update();
  return { el, update };
};
