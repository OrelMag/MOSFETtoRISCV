// The Campaign page (#/campaign[/intro | /n/<node> | /codex[/<entry>]]): the map of levels, a
// level's panel (why, the test set, tips, codex, Start / Skip / Show solution), the CPU anatomy
// intro and the codex. Loaded on demand (app.ts imports it dynamically). Levels are played in
// the sandbox: Start writes the level's chip into the saved workspace and opens #/sandbox/<chip>.

import '../../styles/campaign.css';
import { BLOCKS, blockNodes } from '../../campaign/anatomy';
import { CODEX, CODEX_KINDS, codexById } from '../../campaign/codex';
import { type Datasheet, datasheets } from '../../campaign/datasheet';
import { METRIC } from '../../campaign/grade';
import { ancestors, dependents, isDone, nextAvailable, statusOf } from '../../campaign/graph';
import { LESSONS } from '../../campaign/lessons';
import { levelChallenge, levelChipId, startCandidates, startFrom } from '../../campaign/levels';
import { ACTS, NODES, nodeById } from '../../campaign/nodes';
import { exportCampaign, importCampaign, progress } from '../../campaign/progress';
import type { CampaignNode, Metric } from '../../campaign/types';
import { PUZZLES } from '../../campaign/puzzles';
import { drillCard } from '../../campaign/ui/drillui';
import { puzzleCard } from '../../campaign/ui/puzzleui';
import { anatomySvg, mapSvg } from '../../campaign/ui/svgs';
import { type BuildChallenge, importAnswer, startChallenge } from '../../editor/challenges';
import { loadWorkspace, saveWorkspace } from '../../editor/store';
import { resolveComponent } from '../../lib/resolve';
import { h, icon } from '../dom';
import type { Page } from './chapter';

const html = (tag: 'div' | 'p' | 'span', cls: string, content: string) => {
  const el = h(tag, { class: cls });
  el.innerHTML = content;
  return el;
};

const KIND_LABEL: Record<CampaignNode['kind'], string> = { lesson: 'Lesson', drill: 'Drill', build: 'Build', program: 'Program', core: 'CPU core' };
const STATUS_LABEL = { locked: 'Locked', available: 'Available', started: 'In progress', solved: 'Solved', skipped: 'Skipped' };

/** What a challenge's test set is, in words (the level's success criteria). */
export function criteria(ch: BuildChallenge): string[] {
  const ins = ch.ports.filter((p) => p.dir === 'in' && !p.clock), outs = ch.ports.filter((p) => p.dir === 'out');
  const pin = (p: { name: string; width: number }) => (p.width > 1 ? `${p.name}[${p.width - 1}:0]` : p.name);
  const out = [`Pins: ${ins.map(pin).join(', ') || '—'}${ch.ports.some((p) => p.clock) ? ', clk' : ''} → ${outs.map(pin).join(', ')}.`];
  if (ch.check.kind === 'table') {
    const bits = ins.reduce((a, p) => a + p.width, 0);
    out.push(bits <= 16
      ? `Every input combination: all ${2 ** bits} rows of the truth table must match.`
      : `4096 random input vectors (${bits} input bits) must match.`);
    out.push('An output that is X (undriven, or a short) or Z counts as wrong; the circuit must settle (no oscillation).');
  } else if (ch.check.kind === 'sequence') {
    out.push(`A clocked sequence of ${ch.check.steps.length} steps from power-on: inputs change, the clock ticks, every expected output must match.`);
  } else {
    out.push(ch.check.describe);
  }
  out.push(typeof ch.allowed === 'string'
    ? ch.allowed === 'transistors' ? 'Built from transistors, rails and wiring (and your own chips made of them).' : 'Built from NAND gates (and your chips made of them).'
    : 'Built from NAND, wiring, constants, your own chips, and the parts unlocked below.');
  return out;
}

export class CampaignPage implements Page {
  readonly kind = 'campaign';
  readonly el: HTMLElement;
  private main = h('div', { class: 'cp-main' });
  private head = h('header', { class: 'cp-head' });
  private note = h('span', { class: 'cp-note', role: 'status', 'aria-live': 'polite' });
  private parts: string[] = [];
  private unsub: () => void;
  private mapScroll: { left: number; top: number } | null = null;
  /** Drill and puzzle cards keep their state (question, count, code) while the page redraws around them. */
  private cards = new Map<string, HTMLElement>();

  constructor(parts: string[]) {
    progress().reload();
    this.el = h('div', { class: 'scroll cp-page' }, h('div', { class: 'cp-wrap' }, this.head, this.main));
    this.unsub = progress().onChange(() => this.render());
    this.open(parts);
  }

  open(parts: string[]): void {
    this.parts = parts;
    this.render();
  }

  destroy(): void {
    this.unsub();
  }

  private render(): void {
    const sc = this.main.querySelector<HTMLElement>('.cp-map-scroll');
    if (sc) this.mapScroll = { left: sc.scrollLeft, top: sc.scrollTop };
    this.renderHead();
    const [a, b] = this.parts;
    if (a === 'intro') this.main.replaceChildren(this.introView());
    else if (a === 'codex') this.main.replaceChildren(this.codexView(b));
    else this.main.replaceChildren(this.mapView(a === 'n' ? b : undefined));
    const sc2 = this.main.querySelector<HTMLElement>('.cp-map-scroll');
    if (sc2 && this.mapScroll) {
      sc2.scrollLeft = this.mapScroll.left;
      sc2.scrollTop = this.mapScroll.top;
    }
  }

  // ---- header ---------------------------------------------------------------------------------

  private renderHead(): void {
    const p = progress();
    const sum = p.summary();
    const view = this.parts[0] ?? '';
    const tab = (href: string, label: string, on: boolean, ic: string) => h('a', { class: `cp-tab${on ? ' on' : ''}`, href }, icon(ic, 15), label);
    const unlock = h('label', { class: 'cp-unlock', title: 'Open every level, whatever you have solved (the parts each level may use do not change)' },
      h('input', { type: 'checkbox', ...(p.unlockAll ? { checked: true } : {}), onchange: (e: Event) => p.setUnlockAll((e.target as HTMLInputElement).checked) }),
      'Unlock all');
    const file = h('input', { type: 'file', accept: '.json,application/json', hidden: true }) as HTMLInputElement;
    file.addEventListener('change', () => {
      const f = file.files?.[0];
      if (f) void f.text().then((t) => this.importText(t));
      file.value = '';
    });
    this.head.replaceChildren(
      h('div', { class: 'cp-title' },
        h('h1', null, 'Campaign'),
        h('p', null, 'From a transistor NAND to a pipelined 16-bit RISC-V processor, one block at a time.')),
      h('div', { class: 'cp-stats' },
        h('span', null, h('b', null, `${sum.requiredDone}/${sum.required}`), ' required levels'),
        h('span', null, h('b', null, `${sum.done}`), ' done in all'),
        h('span', null, h('b', { class: 'cp-star' }, `★ ${sum.stars}`), `/${sum.maxStars}`)),
      h('nav', { class: 'cp-tabs' },
        tab('#/campaign', 'Map', view === '' || view === 'n', 'layers'),
        tab('#/campaign/intro', 'The CPU', view === 'intro', 'chip'),
        tab('#/campaign/codex', 'Codex', view === 'codex', 'book')),
      h('div', { class: 'cp-actions' }, unlock,
        h('button', { class: 'btn sm ghost', title: 'Your progress and your level chips, as one .json file', onclick: () => this.exportFile() }, 'Export'),
        h('button', { class: 'btn sm ghost', title: 'Merge a campaign file into your progress (your chips are never overwritten)', onclick: () => file.click() }, 'Import'),
        file, this.note));
  }

  private say(msg: string): void {
    this.note.textContent = msg;
    setTimeout(() => { if (this.note.textContent === msg) this.note.textContent = ''; }, 6000);
  }

  private exportFile(): void {
    const text = exportCampaign(progress().state, loadWorkspace());
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: `campaign-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    this.say('Exported');
  }

  private importText(text: string): void {
    const r = importCampaign(text, progress().state, loadWorkspace());
    if ('error' in r) return this.say(`Import failed: ${r.error}`);
    const saved = saveWorkspace(r.ws);
    if (!saved.ok) return this.say(`Import failed: ${saved.reason}`);
    progress().replace(r.state);
    this.say(`Imported: progress merged, ${r.chips.added.length} chip${r.chips.added.length === 1 ? '' : 's'} added`);
  }

  // ---- map + level panel ----------------------------------------------------------------------

  private mapView(selected: string | undefined): HTMLElement {
    const p = progress();
    const sel = selected ? nodeById(selected) : undefined;
    const svg = mapSvg(p.view, p.unlockAll, sel?.id, (id) => { location.hash = `#/campaign/n/${id}`; });
    const legend = h('div', { class: 'cp-legend' },
      h('span', { class: 'l available' }, 'available'), h('span', { class: 'l solved' }, 'solved'), h('span', { class: 'l skipped' }, 'skipped'),
      h('span', { class: 'l locked' }, 'locked'), h('span', { class: 'l opt' }, 'optional'), NODES.some((n) => n.soon) ? h('span', { class: 'l soon' }, 'coming soon') : null);
    return h('div', { class: 'cp-split' },
      h('section', { class: 'cp-map-pane' }, legend, h('div', { class: 'cp-map-scroll' }, svg)),
      h('aside', { class: 'cp-panel' }, sel ? this.nodePanel(sel) : this.welcome()));
  }

  private welcome(): HTMLElement {
    const p = progress();
    const next = nextAvailable(p.view, p.unlockAll);
    return h('div', { class: 'cp-welcome' },
      h('h2', null, p.summary().done ? 'Welcome back' : 'Start here'),
      h('p', null, 'Each level builds one block of a processor from the blocks before it. Pick a level on the map, or continue with the next one.'),
      next ? h('a', { class: 'btn primary', href: `#/campaign/n/${next.id}` }, `${p.summary().done ? 'Continue' : 'Begin'}: ${next.title}`, icon('chevR', 16)) : null,
      h('h3', null, 'Acts'),
      h('ol', { class: 'cp-acts', start: 0 }, ACTS.map((a) => h('li', null, h('b', null, a.title), html('span', 'sub', ` — ${a.blurb}`)))));
  }

  private nodePanel(n: CampaignNode): HTMLElement {
    const p = progress();
    if (!n.soon) p.open(n.id);
    const st = statusOf(n, p.view, p.unlockAll);
    const np = p.get(n.id);
    const ch = levelChallenge(n);
    const act = ACTS.find((a) => a.num === n.act)!;
    const el = h('div', { class: `cp-node-panel ${st}` });
    el.append(
      h('div', { class: 'cp-crumb' }, h('a', { href: '#/campaign' }, 'Map'), ' › ', `Act ${act.num}: ${act.title}`),
      h('h2', null, n.title),
      h('div', { class: 'cp-badges' },
        h('span', { class: 'cp-badge kind' }, KIND_LABEL[n.kind]),
        n.optional ? h('span', { class: 'cp-badge opt' }, 'optional') : null,
        n.soon ? h('span', { class: 'cp-badge soon' }, 'coming soon') : h('span', { class: `cp-badge st ${st}` }, STATUS_LABEL[st]),
        np?.stars ? h('span', { class: 'cp-badge stars', title: 'Best result' }, '★'.repeat(np.stars) + '☆'.repeat(3 - np.stars)) : null),
      h('div', { class: 'cp-why' }, h('h4', null, 'Why you need it'), html('p', '', n.why)));

    if (n.id === 'intro') {
      el.append(h('a', { class: 'cp-mini-anatomy', href: '#/campaign/intro', title: 'Open the full diagram' }, anatomySvg(p.view, undefined, () => { location.hash = '#/campaign/intro'; })));
    }
    if (n.body && LESSONS[n.body]) el.append(html('div', 'cp-lesson', LESSONS[n.body]));
    if (ch) el.append(h('div', { class: 'cp-brief' }, h('h4', null, 'The task'), html('p', '', ch.brief)));
    if (n.kind === 'drill' && n.drill && !n.soon && st !== 'locked') {
      let card = this.cards.get(n.id);
      if (!card) this.cards.set(n.id, (card = drillCard(n)));
      el.append(h('div', { class: 'cp-drill-wrap' }, h('h4', null, 'Practice'), card));
    }
    const pz = n.kind === 'program' && !n.soon ? PUZZLES[n.id] : undefined;
    if (pz) {
      el.append(h('div', { class: 'cp-brief' }, h('h4', null, 'The task'), html('p', '', pz.brief)),
        h('div', { class: 'cp-criteria' }, h('h4', null, 'Success criteria'),
          h('ul', null, h('li', null, `${pz.tests().length} tests on the golden model; each must halt within ${pz.maxSteps.toLocaleString()} instructions with the expected output.`),
            pz.tests().map((t) => h('li', null, t.name)))));
      if (st !== 'locked') {
        let card = this.cards.get(n.id);
        if (!card) this.cards.set(n.id, (card = puzzleCard(n)));
        el.append(h('div', { class: 'cp-drill-wrap' }, h('h4', null, 'Your program'), card));
      }
    }

    if (n.kind === 'drill' && n.par?.mistakes !== undefined) {
      el.append(h('div', { class: 'cp-grade' }, h('h4', null, 'Grading'),
        h('p', { class: 'sub' }, `Passed after the required number of correct answers. ★★★ with at most ${n.par.mistakes} mistakes (a shown answer counts as one), ★★ with at most ${Math.floor(n.par.mistakes * 1.5)}.`)));
    }
    if (pz) el.append(this.gradeTable(n));
    // Success criteria and grading.
    if (ch) {
      el.append(h('div', { class: 'cp-criteria' }, h('h4', null, 'Success criteria'),
        h('ul', null, criteria(ch).map((c) => h('li', null, c)))));
      el.append(this.gradeTable(n));
    }

    // What it builds on, what it unlocks.
    const req = n.requires.map((r) => nodeById(r)).filter((x): x is CampaignNode => !!x);
    const unlocks = (n.unlocks ?? []).map((u) => (u.endsWith('*') ? `${u.slice(0, -1)}…` : resolveComponent(u)?.name ?? u));
    const rule = ch && typeof ch.allowed === 'object' ? ch.allowed.lib.filter((x) => x !== 'nand') : [];
    el.append(h('div', { class: 'cp-deps' },
      req.length ? h('p', null, h('b', null, 'Builds on: '), req.map((r, i) => [i ? ', ' : '', h('a', { href: `#/campaign/n/${r.id}`, class: isDone(p.view(r.id)) ? 'done' : '' }, r.title)])) : null,
      rule.length ? h('p', null, h('b', null, 'Parts you may place: '), 'NAND, ', rule.map((u) => (u.endsWith('*') ? `${u.slice(0, -1)}…` : resolveComponent(u)?.name ?? u)).join(', ')) : null,
      unlocks.length ? h('p', null, h('b', null, 'Unlocks: '), unlocks.join(', ')) : null,
      dependents(n.id).length ? h('p', null, h('b', null, 'Leads to: '), dependents(n.id).map((d, i) => [i ? ', ' : '', h('a', { href: `#/campaign/n/${d.id}` }, d.title)])) : null));

    // Tips, one at a time.
    if (n.tips.length && !n.soon) {
      const shown = Math.min(np?.tips ?? 0, n.tips.length);
      el.append(h('div', { class: 'cp-tips' }, h('h4', null, 'Tips'),
        shown ? h('ol', null, n.tips.slice(0, shown).map((t) => { const li = h('li'); li.innerHTML = t; return li; })) : null,
        shown < n.tips.length ? h('button', { class: 'btn sm ghost', onclick: () => p.revealTip(n.id, n.tips.length) }, icon('info', 14), shown ? 'Another tip' : 'Show a tip') : null));
    }

    // Codex and chapters.
    const unlocked = p.codexUnlocked();
    if (n.codex.length) {
      el.append(h('div', { class: 'cp-codex-chips' }, h('h4', null, 'Codex'),
        n.codex.map((c) => {
          const e = codexById(c);
          if (!e) return null;
          return unlocked.has(c) ? h('a', { class: 'cp-chip', href: `#/campaign/codex/${c}` }, e.title) : h('span', { class: 'cp-chip locked', title: 'Unlocks when you finish this level' }, e.title);
        })));
    }
    if (n.chapters?.length) {
      el.append(h('div', { class: 'cp-chapters' }, h('h4', null, 'Go deeper'),
        n.chapters.map((c) => h('a', { class: 'cp-chip', href: `#/c/${c.chapter}/${c.step ?? 0}` }, icon('book', 13), c.label))));
    }
    el.append(this.actions(n, st, ch));
    return el;
  }

  private gradeTable(n: CampaignNode): HTMLElement {
    const np = progress().get(n.id);
    const par = n.par ?? {};
    const keys = Object.keys(par) as Metric[];
    return h('div', { class: 'cp-grade' }, h('h4', null, 'Grading'),
      keys.length
        ? h('table', null, h('tr', null, h('th', null, 'Metric'), h('th', null, 'Par'), h('th', null, 'Your best')),
          keys.map((k) => h('tr', { title: METRIC[k].hint }, h('td', null, METRIC[k].label), h('td', null, String(par[k])),
            h('td', { class: np?.best?.[k] !== undefined ? (np.best[k]! <= par[k]! ? 'par' : 'over') : '' }, np?.best?.[k] !== undefined ? String(np.best[k]) : '—'))))
        : h('p', { class: 'sub' }, 'Passing earns all three stars: nothing to optimise here.'),
      keys.length ? h('p', { class: 'sub' }, '★ passes · ★★ every metric within 1.5 × par · ★★★ every metric at or under par.') : null);
  }

  private actions(n: CampaignNode, st: ReturnType<typeof statusOf>, ch: BuildChallenge | undefined): HTMLElement {
    const p = progress();
    const bar = h('div', { class: 'cp-node-actions' });
    if (n.soon) {
      bar.append(h('p', { class: 'sub' }, 'This level is being built (see docs/CAMPAIGN.md). You can skip it so that what follows opens.'));
      if (st !== 'skipped' && st !== 'solved') bar.append(h('button', { class: 'btn', onclick: () => p.skip(n.id) }, 'Skip'));
      return bar;
    }
    if (st === 'locked') {
      const missing = n.requires.filter((r) => !isDone(p.view(r))).map((r) => nodeById(r)?.title ?? r);
      bar.append(h('p', { class: 'sub' }, `Finish or skip first: ${missing.join(', ')}. Or tick Unlock all.`));
      return bar;
    }
    if (n.kind === 'lesson') {
      bar.append(st === 'solved'
        ? h('span', { class: 'cp-done' }, icon('check', 15), 'Read')
        : h('button', { class: 'btn primary', onclick: () => p.solve(n.id) }, icon('check', 15), 'Done reading'));
      if (n.id === 'intro') bar.append(h('a', { class: 'btn', href: '#/campaign/intro' }, 'The full diagram'));
    } else if (ch) {
      const chip = levelChipId(n);
      const exists = !!loadWorkspace().chips[chip];
      bar.append(h('button', { class: 'btn primary', onclick: () => this.start(n, ch) }, icon('play', 14), exists ? 'Continue in the sandbox' : 'Start in the sandbox'));
      // A core level: start from a copy of the core you built for an earlier level.
      const from = exists ? undefined : startCandidates(n, loadWorkspace())[0];
      if (from) bar.append(h('button', { class: 'btn', title: `A copy of your “${from.title}” chip, with this level's pins added`, onclick: () => this.start(n, ch, levelChipId(from)) }, `Start from ${from.title}`));
      bar.append(h('button', { class: 'btn', title: 'Import the reference solution as new chips and open it in the sandbox', onclick: () => this.solution(ch) }, 'Show solution'));
    }
    if (n.kind !== 'lesson' && st !== 'solved') {
      bar.append(st === 'skipped'
        ? h('button', { class: 'btn ghost', title: 'Back to unfinished', onclick: () => p.unskip(n.id) }, 'Un-skip')
        : h('button', { class: 'btn ghost', title: 'Count this level as done: its part unlocks (the reference solution stands in for yours)', onclick: () => p.skip(n.id) }, 'Skip'));
    }
    const next = isDone(p.view(n.id)) ? nextAvailable(p.view, p.unlockAll, n.id) : undefined;
    if (next) bar.append(h('a', { class: 'btn ghost', href: `#/campaign/n/${next.id}` }, `Next: ${next.title}`, icon('chevR', 14)));
    return bar;
  }

  private start(n: CampaignNode, ch: BuildChallenge, from?: string): void {
    const r = from ? startFrom(loadWorkspace(), ch, from) : startChallenge(loadWorkspace(), ch);
    const saved = saveWorkspace(r.ws);
    if (!saved.ok) return this.say(saved.reason);
    progress().open(n.id, true);
    location.hash = `#/sandbox/${r.chipId}`;
  }

  private solution(ch: BuildChallenge): void {
    const r = importAnswer(loadWorkspace(), ch);
    const saved = saveWorkspace(r.ws);
    if (!saved.ok) return this.say(saved.reason);
    location.hash = `#/sandbox/${r.main}`;
  }

  // ---- intro: the CPU anatomy -------------------------------------------------------------------

  private introView(): HTMLElement {
    const p = progress();
    const by = blockNodes();
    const info = h('div', { class: 'cp-block-info' });
    const pick = (id: string) => {
      const b = BLOCKS.find((x) => x.id === id);
      if (!b) return;
      for (const g of svgWrap.querySelectorAll('.cp-block')) g.classList.toggle('sel', (g as SVGElement).dataset.block === id);
      const ns = (by.get(id) ?? []).map((x) => nodeById(x)).filter((x): x is CampaignNode => !!x);
      const all = new Set<string>();
      for (const x of ns) {
        all.add(x.id);
        ancestors(x.id).forEach((a) => all.add(a));
      }
      const doneCount = [...all].filter((a) => isDone(p.view(a))).length;
      info.replaceChildren(h('div', null, h('h3', null, b.label), html('p', '', b.why),
        ns.length ? h('p', null, h('b', null, 'Built in: '), ns.map((x, i) => [i ? ', ' : '', h('a', { href: `#/campaign/n/${x.id}` }, x.title)])) : null,
        all.size ? h('p', { class: 'sub' }, `${doneCount} of the ${all.size} levels leading to it done.`) : null));
    };
    const svgWrap = h('div', { class: 'cp-anatomy-wrap' }, anatomySvg(p.view, undefined, pick));
    info.append(h('p', { class: 'sub' }, 'Click a block: what it does, and the levels that build it.'));
    const intro = nodeById('intro')!;
    return h('div', { class: 'cp-intro' },
      h('div', { class: 'cp-intro-top' }, svgWrap, info),
      html('div', 'cp-lesson', LESSONS.intro),
      h('div', { class: 'cp-node-actions' },
        statusOf(intro, p.view, p.unlockAll) !== 'solved' ? h('button', { class: 'btn primary', onclick: () => { p.solve('intro'); location.hash = '#/campaign'; } }, 'Got it: to the map', icon('chevR', 15))
          : h('a', { class: 'btn primary', href: '#/campaign' }, 'To the map', icon('chevR', 15))));
  }

  // ---- codex ----------------------------------------------------------------------------------

  private codexView(sel: string | undefined): HTMLElement {
    const p = progress();
    const unlocked = p.codexUnlocked();
    const foundIn = (id: string) => NODES.filter((n) => n.codex.includes(id));
    const list = h('nav', { class: 'cp-codex-list' },
      h('p', { class: 'sub' }, `${[...unlocked].filter((u) => codexById(u)).length} of ${CODEX.length} entries discovered`),
      CODEX_KINDS.map((k) => {
        const es = CODEX.filter((e) => e.kind === k.id);
        return [h('h4', null, k.title), h('ul', null, es.map((e) => h('li', null, unlocked.has(e.id)
          ? h('a', { href: `#/campaign/codex/${e.id}`, class: e.id === sel ? 'on' : '' }, e.title)
          : h('a', { href: `#/campaign/codex/${e.id}`, class: `locked${e.id === sel ? ' on' : ''}`, title: 'Not discovered yet' }, icon('flag', 11), e.title))))];
      }));
    const e = sel ? codexById(sel) : undefined;
    let detail: HTMLElement;
    if (!e) {
      detail = h('div', { class: 'cp-codex-entry' }, h('h2', null, 'Codex'),
        h('p', null, 'Every component you build, every law and tool you use, collected as you go. Entries unlock when you finish (or skip) the level that teaches them; Unlock all reveals them all.'));
    } else if (!unlocked.has(e.id)) {
      const where = foundIn(e.id);
      detail = h('div', { class: 'cp-codex-entry locked' }, h('h2', null, e.title),
        h('p', null, 'Not discovered yet. Found in: ', where.map((n, i) => [i ? ', ' : '', h('a', { href: `#/campaign/n/${n.id}` }, n.title)])));
    } else {
      detail = h('div', { class: 'cp-codex-entry' }, h('span', { class: 'cp-badge kind' }, CODEX_KINDS.find((k) => k.id === e.kind)!.title.replace(/s$/, '')),
        h('h2', null, e.title), html('div', 'cp-codex-body', e.body),
        ...(e.kind === 'component' ? datasheets(e.id).map(sheetEl) : []),
        e.related?.length ? h('p', null, h('b', null, 'See also: '), e.related.map((r, i) => [i ? ', ' : '', h('a', { href: `#/campaign/codex/${r}` }, codexById(r)?.title ?? r)])) : null,
        h('p', { class: 'sub' }, 'Taught in: ', foundIn(e.id).map((n, i) => [i ? ', ' : '', h('a', { href: `#/campaign/n/${n.id}` }, n.title)])));
    }
    return h('div', { class: 'cp-codex' }, list, detail);
  }
}

/** A library part's datasheet: cost, pins, and a small part's truth table. */
function sheetEl(d: Datasheet): HTMLElement {
  const fmt = (v: number, w: number) => (w > 4 ? `0x${v.toString(16)}` : w > 1 ? v.toString(2).padStart(w, '0') : String(v));
  const ins = d.pins.filter((p) => p.dir !== 'out').length;
  const widths = [...d.pins.filter((p) => p.dir !== 'out'), ...d.pins.filter((p) => p.dir === 'out')].map((p) => p.width);
  return h('div', { class: 'cp-sheet' },
    h('h4', null, 'Datasheet: ', h('a', { href: `#/workbench/${d.id}`, title: 'Open it in the workbench' }, d.name)),
    h('p', { class: 'sub' }, `${d.nand.toLocaleString('en')} NAND · ${d.transistors.toLocaleString('en')} transistors · ${d.depth !== null ? `depth ${d.depth}` : 'sequential'}`),
    h('div', { class: 'cp-sheet-cols' },
      h('table', null, h('tr', null, h('th', null, 'pin'), h('th', null, 'dir'), h('th', null, 'bits')),
        d.pins.map((p) => h('tr', null, h('td', null, p.name), h('td', null, p.dir), h('td', null, String(p.width))))),
      d.table ? h('table', null, h('tr', null, d.table.head.map((x, i) => h('th', i >= ins ? { class: 'out' } : null, x))),
        d.table.rows.map((r) => h('tr', null, r.map((v, i) => h('td', i >= ins ? { class: 'out' } : null, fmt(v, widths[i])))))) : null));
}
