// Where are you starting? (#/start, its own chunk): four starting points, each a tier, and an optional twelve-question
// check that suggests one (learn/placement.ts). The choice goes to the learn store; every chapter stays open whatever it is.

import '../../styles/path.css';
import type { Tier } from '../../learn/capstones';
import { asker } from '../../learn/asker';
import { placementItems, suggestTier, type Item } from '../../learn/placement';
import { TIERS } from '../../learn/skills';
import { learn, type Persona } from '../../learn/store';
import { h } from '../dom';
import type { Page } from './chapter';

const CHOICES: { persona: Persona; title: string; text: string; tier: Tier; then: string }[] = [
  { persona: 'new', title: 'New to hardware and code', text: 'You can follow a recipe and do school algebra.', tier: 0, then: 'Tier 0: Before the switch, then the map' },
  { persona: 'software', title: 'I write software', text: 'Binary and if / else are familiar; gates and clocks are not.', tier: 1, then: 'Tier 1: transistors to memory' },
  { persona: 'logic', title: 'I know digital logic', text: 'Gates, flip-flops, maybe some Verilog.', tier: 2, then: 'Tier 2: the ALU to a CPU, tier 1 to test out' },
  { persona: 'hardware', title: 'I design hardware', text: 'Show me where this goes past a textbook.', tier: 3, then: 'Tier 3: pipelines, caches, floating point' },
];

export class StartPage implements Page {
  readonly kind = 'start';
  readonly el: HTMLElement;
  private check = h('section', { class: 'lp-check', 'aria-label': 'Placement questions' });

  constructor() {
    const cur = learn().state.start?.persona;
    this.el = h('div', { class: 'scroll' }, h('div', { class: 'lp-page lp-start' },
      h('div', { class: 'eyebrow' }, 'First visit'),
      h('h1', null, 'Where are you starting?'),
      h('p', { class: 'lp-lead' }, 'Pick the closest. You can change it at any time, and every chapter stays open whatever you choose.'),
      h('div', { class: 'lp-choices' }, ...CHOICES.map((c) => h('button', { class: `lp-choice${c.persona === cur ? ' sel' : ''}`, type: 'button',
        onclick: () => this.choose(c.persona, c.tier) }, h('b', null, c.title), h('span', null, c.text), h('span', { class: 'lp-then' }, `→ ${c.then}`)))),
      this.check,
      h('p', { class: 'lp-note' }, h('a', { href: '#/c/basics/0' }, 'Skip: let me explore'), ' · nothing is locked, and My path is in the top bar.')));
    this.intro();
  }

  destroy(): void {}

  private choose(persona: Persona, tier: number): void {
    learn().setStart(persona, tier);
    location.hash = '#/path';
  }

  private intro(): void {
    this.check.replaceChildren(h('div', { class: 'lp-nh' }, h('b', null, 'Not sure? Twelve questions, about 6 minutes')),
      h('p', { class: 'lp-sub' }, 'They climb from bits and truth tables to pipelines and caches. "I don\'t know yet" is a fine answer: it moves on. Nothing here counts toward the chapters\' own checks.'),
      h('button', { class: 'btn primary', type: 'button', onclick: () => this.run() }, 'Take the twelve questions'));
  }

  private run(): void {
    // the questions are chunks of their own (the drills, learn/recaps.ts), loaded on this click
    this.check.setAttribute('aria-busy', 'true');
    this.check.replaceChildren(h('p', { class: 'lp-sub', role: 'status' }, 'Loading the questions…'));
    placementItems().then((items) => { this.check.removeAttribute('aria-busy'); this.ask(items); }, () => {
      this.check.removeAttribute('aria-busy');
      this.check.replaceChildren(h('p', { class: 'lp-sub', role: 'status' }, 'The questions could not be loaded (offline?).'),
        h('div', { class: 'lp-nav' }, h('button', { class: 'btn primary', type: 'button', onclick: () => this.run() }, 'Try again'), h('button', { class: 'btn', type: 'button', onclick: () => this.intro() }, 'Back')));
    });
  }

  private ask(items: Item[]): void {
    this.check.replaceChildren(asker(items, (answers) => {
      const tier = suggestTier(answers);
      const right = answers.filter((a) => a.right).length;
      learn().setPlacement(right, answers.length, tier);
      const persona = CHOICES.find((c) => c.tier === Math.min(tier, 3))!.persona;
      const per = TIERS.slice(0, 4).map((t) => {
        const mine = answers.filter((a) => a.tier === t.tier);
        return h('li', null, `Tier ${t.tier} · ${t.title}: ${mine.filter((a) => a.right).length} of ${mine.length}`);
      });
      this.check.replaceChildren(h('div', { class: 'lp-nh' }, h('b', null, `${right} of ${answers.length} right`)),
        h('ul', { class: 'lp-per' }, ...per),
        h('p', null, tier >= 4 ? 'Every tier passed: start at tier 3, and test out of the chapters you know on My path.'
          : `Start at tier ${tier}, ${TIERS[tier].title}. On My path you can test out of chapters in it you already know.`),
        h('div', { class: 'lp-nav' }, h('button', { class: 'btn primary', type: 'button', onclick: () => this.choose(persona, Math.min(tier, 3)) }, `Start at tier ${Math.min(tier, 3)}`),
          h('button', { class: 'btn', type: 'button', onclick: () => this.intro() }, 'Back')));
    }));
  }
}
