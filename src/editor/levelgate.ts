// What a campaign level's chip may not hand out: a level's menu must not give away an answer. The rule follows the chip,
// not the page: the level screen, and a level or walkthrough chip opened in the sandbox.

import type { ComponentDef } from '../sim/types';
import type { Editor } from './editor';

/** A level's chip (u_ch_cp_<node>) or a walkthrough's (u_walk_<node>). */
export const isLevelChipId = (id: string): boolean => /^u_(ch_cp|walk)_/.test(id);

/** What may leave this chip. A walkthrough's chips are the reference answer: nothing goes. A level's: only the learner's own, and only as itself. */
export function handout(o: { chipId: string; level: boolean; own: boolean }): { none: boolean; sandbox: boolean; verilog: boolean; image: boolean; link: boolean } {
  if (o.chipId.startsWith('u_walk_')) return { none: true, sandbox: false, verilog: false, image: false, link: false };
  if (!o.level && !isLevelChipId(o.chipId)) return { none: false, sandbox: !o.own, verilog: true, image: true, link: true };
  return { none: !o.own, sandbox: false, verilog: o.own, image: o.own, link: false };
}

/** A library part as a chip of the open project (one undo step), opened. */
export function copyAsChip(ed: Editor, def: ComponentDef): void {
  void import('./remix').then(({ remixDef }) => {
    let err = '';
    ed.editWs((ws) => {
      const r = remixDef(ws, def);
      if ('error' in r) { err = r.error; return ws; }
      return r.ws;
    });
    if (err) ed.toast(`It could not be copied: ${err}`, 'err');
  }, () => ed.toast('Could not load: reload the page', 'err'));
}
