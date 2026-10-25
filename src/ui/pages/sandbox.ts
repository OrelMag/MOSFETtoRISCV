// The Sandbox page (#/sandbox[/<chipId>], #/sandbox/s/<payload> for a share link): a
// Digital-Logic-Sim-style editor where the learner builds chips from transistors and gates up.
// Loaded on demand (app.ts imports it dynamically), so the editor stays out of the main bundle.
//
// The editor works on one project (editor/projects.ts); switching saves it and builds a new
// editor on the other one in its place. A campaign level's chip lives in the first project, so
// opening one switches there.

import '../../styles/editor.css';
import '../../styles/sbchips.css';
import { Editor } from '../../editor/editor';
import { SHARE_SEG, shareRoute } from '../../editor/files';
import { FSM_TEMPLATE, newFsmChip } from '../../editor/fsmchip';
import { GCD_FSMD } from '../../editor/fsmd';
import type { Workspace } from '../../editor/model';
import { newTableChip } from '../../editor/ttable';

const NEW_SEG = 'new';
import { installChallenges } from '../../editor/challengeui';
import { installFiles, type FilesUi } from '../../editor/fileui';
import { installProjects } from '../../editor/projectui';
import { MAIN_PROJECT, readProjects, setCurrentProject } from '../../editor/projects';
// Every feature module (palette groups, property sections, toolbar actions, plugins).
import '../../editor/features';
import type { Page } from './chapter';

/** Chips of campaign levels (campaign/levels.ts levelChipId): kept in the first project. */
const isLevelChip = (id?: string) => !!id?.startsWith('u_ch_cp_');

export class SandboxPage implements Page {
  readonly kind = 'sandbox';
  el: HTMLElement;
  editor: Editor;
  private parts: { destroy(): void }[] = [];
  private files!: FilesUi;

  constructor(chipId?: string) {
    const share = chipId === SHARE_SEG, made = chipId === NEW_SEG ? location.hash.split('/')[3] ?? '' : null;
    this.editor = this.build(share || made !== null ? undefined : chipId, this.projectFor(chipId));
    this.el = this.editor.el;
    if (share) this.files.openShare(shareRoute(location.hash));
    if (made !== null) this.makeNew(made);
  }

  /** #/sandbox/new/<kind> (a chapter's link): a new chip of that kind, opened, the address then its own. */
  private makeNew(kind = location.hash.split('/')[3]): void {
    const make = kind === 'fsm' ? (ws: Workspace) => newFsmChip(ws, FSM_TEMPLATE, '101 detector') : kind === 'fsmd' ? (ws: Workspace) => newFsmChip(ws, GCD_FSMD, 'GCD')
      : kind === 'table' ? (ws: Workspace) => newTableChip(ws) : null;
    if (!make) return void history.replaceState(null, '', '#/sandbox');
    let id = '';
    this.editor.editWs((ws) => { const r = make(ws); id = r.id; return r.ws; });
    history.replaceState(null, '', id ? `#/sandbox/${id}` : '#/sandbox');
  }

  /** The project to open a chip in: the first one for a level's chip, else the current one. */
  private projectFor(chipId?: string): string {
    if (!isLevelChip(chipId)) return readProjects().current;
    setCurrentProject(MAIN_PROJECT);
    return MAIN_PROJECT;
  }

  private build(chipId: string | undefined, project: string): Editor {
    const ed = new Editor(chipId, { project });
    this.files = installFiles(ed);
    this.parts = [installChallenges(ed), this.files, installProjects(ed, { switchTo: (id, note) => this.switchTo(id, undefined, note) })];
    return ed;
  }

  /** Save this project and put an editor on another in its place (opening `chipId` there). */
  private switchTo(id: string, chipId?: string, note?: string): void {
    if (!setCurrentProject(id)) return this.editor.toast('Cannot switch projects: browser storage is not available', 'err');
    const old = this.editor;
    this.teardown();
    this.editor = this.build(chipId, id);
    old.el.replaceWith(this.editor.el);
    this.el = this.editor.el;
    // #/sandbox/<chip> named a chip of the project left behind.
    if (!chipId && /^#\/?sandbox\/./.test(location.hash)) history.replaceState(null, '', '#/sandbox');
    if (note) this.editor.toast(note);
  }

  /** The hash changed to another chip (#/sandbox/<id>) or to a share link. */
  open(chipId?: string): void {
    if (chipId === SHARE_SEG) return this.files.openShare(shareRoute(location.hash));
    if (chipId === NEW_SEG) return this.makeNew();
    if (isLevelChip(chipId) && this.editor.project !== MAIN_PROJECT) return this.switchTo(MAIN_PROJECT, chipId);
    if (chipId && chipId !== this.editor.chipId) this.editor.openChip(chipId);
  }

  private teardown(): void {
    this.parts.forEach((p) => p.destroy());
    this.parts = [];
    this.editor.destroy();
  }

  destroy(): void {
    this.teardown();
  }
}
