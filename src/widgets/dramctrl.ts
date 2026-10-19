// Chapter 35's controller panel: the scene is the gate-level controller driving a DRAM device; the
// panel raises line requests (the cache's side of the handshake), clocks until done, and shows every
// command the controller issued, the banks' open rows, the refresh counter and what each request cost.

import { CMD_NAMES, deviceIn, type DramConfig, fieldWidths, ST_NAMES } from '../dram/controller';
import { TIMING } from '../dram/timing';
import { dramSystem } from '../lib/dramctrl';
import { findNode } from '../sim/flatten';
import { pack } from '../sim/values';
import { h } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';

export interface MemCtrlSceneOptions {
  cfg: DramConfig;
  path?: string[];
  highlight?: string[];
}

interface Req { la: number; wr: boolean; outcome: string; cycles: number; first: number }
interface Cyc { n: number; cmd: number; data: boolean; done: boolean; req: boolean }
interface PanelState { reqs: Req[]; trace: Cyc[]; cycles: number; refreshes: number }
const states = new WeakMap<Stage, PanelState>();
/** The panel's record for a challenge: requests made, their outcomes and cycles. */
export const memCtrlState = (st: Stage): PanelState | undefined => states.get(st);
/** The panel's request button, for a challenge's solve. */
const actions = new WeakMap<Stage, (la: number, wr: boolean) => void>();
export const memCtrlRequest = (st: Stage) => actions.get(st);

export function memCtrlScene(opts: MemCtrlSceneOptions): Scene {
  return {
    root: dramSystem(opts.cfg),
    inputs: { req: 0, wr: 0, la: 0, seed: 0x5a, clk: 0 },
    hiddenInputs: ['req', 'wr', 'la', 'seed'],
    autoClock: false,
    path: opts.path,
    highlight: opts.highlight,
    panels: [memCtrlPanel(opts.cfg)],
  };
}

const TRACE = 36;

function memCtrlPanel(c: DramConfig): ScenePanel {
  return (stage: Stage): Widget => {
    const t = c.t ?? TIMING, lines = 2 ** (c.k - 2), { cb, bb } = fieldWidths(c);
    const st: PanelState = { reqs: [], trace: [], cycles: 0, refreshes: 0 };
    states.set(stage, st);
    let sel = { la: 0, wr: false };
    let doneSeen = false;
    const sim = () => stage.sim!;
    const root = () => sim().design.root;
    const out = (p: string) => pack(sim().getBits(root().ports[p]));
    const reg = (path: string[]) => { const n = findNode(root(), path); return n ? pack(sim().getBits(n.ports.q)) : -1; };
    const hook = {
      before: () => {
        const cmd = out('cmd'), done = out('done') === 1;
        st.trace.push({ n: st.cycles, cmd, data: out('dv') === 1 || out('wv') === 1, done, req: sim().getInput('req') === 1 });
        if (st.trace.length > TRACE) st.trace.shift();
        if (cmd === 6) st.refreshes++;
        if (done) doneSeen = true;
        st.cycles++;
      },
    };
    stage.edgeHooks.add(hook);
    stage.historyHooks.add({
      save: () => ({ reqs: st.reqs.map((r) => ({ ...r })), trace: st.trace.map((x) => ({ ...x })), cycles: st.cycles, refreshes: st.refreshes }),
      restore: (s) => { const v = s as PanelState; Object.assign(st, { reqs: v.reqs.map((r) => ({ ...r })), trace: v.trace.map((x) => ({ ...x })), cycles: v.cycles, refreshes: v.refreshes }); },
    });

    /** A request as the cache makes it: raise, clock until done, lower. */
    const request = (la: number, wr: boolean) => {
      stage.checkpoint();
      const start = st.cycles;
      sim().setInput('la', la);
      sim().setInput('wr', +wr);
      sim().setInput('req', 1);
      sim().settle();
      // how the controller will find the bank (when it starts: maybe after a refresh)
      let outcome = '';
      doneSeen = false;
      stage.runCycles(t.tRFC + 64, () => {
        if (!outcome) outcome = out('hit') ? 'row hit' : out('miss') ? 'row miss' : out('conflict') ? 'row conflict' : '';
        return doneSeen;
      });
      sim().setInput('req', 0);
      sim().settle();
      const dev = deviceIn(sim().leafState(findNode(root(), ['dev'])!.leafIndex!));
      st.reqs.push({ la, wr, outcome: outcome || '?', cycles: st.cycles - start, first: dev ? dev.read(la * 4) : -1 });
      if (st.reqs.length > 8) st.reqs.shift();
      stage.refresh();
    };
    const idle = (n: number) => () => { stage.checkpoint(); stage.runCycles(n); };
    actions.set(stage, request);

    const btn = (label: string, title: string, f: () => void, cls = 'btn sm') => {
      const b = h('button', { class: cls, title }, label);
      b.addEventListener('click', f);
      return b;
    };
    const laSel = h('select', { class: 'mc-sel', 'aria-label': 'Line address' }) as HTMLSelectElement;
    for (let l = 0; l < lines; l++) laSel.append(h('option', { value: String(l) }, `line ${l} (0x${(l * 16).toString(16).padStart(3, '0')})`));
    laSel.addEventListener('change', () => { sel.la = Number(laSel.value); update(); });
    const where = h('span', { class: 'mc-where' });
    const status = h('div', { class: 'mc-status' });
    const banks = h('div', { class: 'mc-banks' });
    const timeline = h('div', { class: 'mc-timeline' });
    const reqs = h('div', { class: 'mc-reqs' });
    const title = h('h4', null, 'DRAM controller', h('span', { class: 'fold-hint' }));
    const el = h('div', { class: 'mem-panel cpu-panel mc-panel', 'data-dock': 'right', 'data-fold': 'narrow' }, title,
      h('div', { class: 'mc-row' }, laSel, where),
      h('div', { class: 'dram-ops' },
        btn('Read line', 'Request the line (wr = 0) and clock until done', () => request(sel.la, false), 'btn sm primary'),
        btn('Write line', 'Write the line (wr = 1): each word gets {seed, line, word}', () => request(sel.la, true)),
        btn('Idle 50', 'Clock 50 cycles with no request (a refresh may come)', idle(50)),
        btn('Idle 500', 'Clock 500 cycles with no request', idle(500))),
      status, banks, h('div', { class: 'cpu-sec' }, `Commands, the last ${TRACE} cycles`), timeline, h('div', { class: 'cpu-sec' }, 'Requests'), reqs);
    title.addEventListener('click', () => el.classList.toggle('collapsed'));

    const update = () => {
      const s = sim();
      const lo = sel.la & ((1 << cb) - 1), bank = (sel.la >> cb) & ((1 << bb) - 1), row = sel.la >> (cb + bb);
      where.textContent = `${c.hash ? 'before the hash: ' : ''}bank ${bank}, row ${row}, column ${lo}`;
      const stBits = reg(['ctrl', 'st']), state = stBits <= 0 ? 0 : 1 + Math.log2(stBits & -stBits);
      const rc = reg(['ctrl', 'rc']), dev = deviceIn(s.leafState(findNode(root(), ['dev'])!.leafIndex!));
      status.replaceChildren(
        h('span', null, 'state ', h('b', null, ST_NAMES[state] ?? '?')),
        h('span', null, 'refresh in ', h('b', null, `${Math.max(0, t.tREFI - 1 - rc)}`), ' cycles', reg(['ctrl', 'pend']) === 1 ? ' (due)' : ''),
        h('span', null, `${st.refreshes} refreshes · ${st.cycles} cycles`),
        dev?.err ? h('span', { class: 'bad' }, `device: ${dev.why}`) : h('span', { class: 'good' }, 'no rule broken'));
      banks.replaceChildren(...Array.from({ length: c.banks }, (_, k) => {
        const open = reg(['ctrl', `v${k}`]) === 1;
        return h('span', { class: `mc-bank${open ? ' open' : ''}` }, `bank ${k}: ${open ? `row ${reg(['ctrl', `r${k}`])} open` : 'closed'}`);
      }));
      timeline.replaceChildren(...st.trace.map((x) => h('span', { class: `mc-c c${x.cmd}${x.data ? ' data' : ''}${x.done ? ' done' : ''}${x.req ? ' req' : ''}`, title: `cycle ${x.n}: ${CMD_NAMES[x.cmd]}${x.data ? ', a word' : ''}${x.done ? ', done' : ''}` },
        x.cmd ? CMD_NAMES[x.cmd].replace('PREA', 'PA') : x.data ? 'd' : '·')));
      reqs.replaceChildren(...(st.reqs.length ? st.reqs.slice().reverse() : []).map((r) =>
        h('div', { class: 'mc-req' }, h('span', null, `${r.wr ? 'write' : 'read'} line ${r.la}`), h('span', { class: `rb-kind ${r.outcome.replace('row ', '')}` }, r.outcome), h('b', null, `${r.cycles} cycles`))));
      if (!st.reqs.length) reqs.append(h('div', { class: 'sub' }, 'Pick a line and read it.'));
    };
    update();
    return { el, update, destroy: () => { stage.edgeHooks.delete(hook); states.delete(stage); actions.delete(stage); } };
  };
}
