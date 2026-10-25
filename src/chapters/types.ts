import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, NetDef } from '../sim/types';
import type { Scene, Stage, Widget } from '../view/stage';

/** A multiple-choice question (a step's quiz, a chapter recap's Check yourself). HTML in every text. */
export interface Quiz {
  question: string;
  options: string[];
  answer: number;
  /** Shown once answered (or revealed). */
  explain: string;
  /** Per option, why it is right or wrong: the misconception behind a wrong one. Shown when that option is picked. */
  why?: string[];
}

export type Challenge =
  | {
      kind: 'reach';
      /** What to achieve, shown to the learner. */
      goal: string;
      check: (stage: Stage) => boolean;
      /** Worked answer, revealed on request. */
      answer: string;
      /** Optional: perform the answer on the live circuit. */
      solve?: (stage: Stage) => void;
      /** Hints revealed one at a time before the answer: a nudge first, then more concrete. */
      hints?: string[];
    }
  | ({ kind: 'quiz' } & Quiz);

export interface StepAction {
  label: string;
  run: (stage: Stage) => void;
}

export interface Step {
  title: string;
  /** HTML. Keep it short; the circuit does the explaining. */
  body: string;
  scene?: () => Scene;
  widget?: () => Widget;
  challenge?: Challenge;
  actions?: StepAction[];
  /**
   * What the scene's highlight shows, in words (HTML). By default a line is made from the highlighted instances'
   * names; '' hides it. Names in the body marked data-show="inst other" light those instances (ui/pages/looks.ts).
   */
  lit?: string;
  /** Conditions for the body's .try boxes, in order: a box ticks itself once its condition holds. */
  tries?: ((stage: Stage) => boolean)[];
}

export interface Chapter {
  id: string;
  /** Order on the map; an appendix chapter continues the count but is shown by its letter. */
  num: number;
  /** The letter of an appendix chapter (shown instead of the number, after the main journey). */
  appendix?: string;
  /** The label of a prologue chapter (P1 …: before the transistor, between the map and chapter 1; num 0). */
  prologue?: string;
  title: string;
  /** One line for cards. */
  blurb: string;
  /** The abstraction level this chapter lives at. */
  level: string;
  /** What the learner will be able to do after it (HTML), shown on the first step. */
  goals?: string[];
  /** Chapters it builds on (ids), linked on the first step. */
  builds?: string[];
  /**
   * The step after the last: what to keep, questions to check yourself, the campaign levels that practise it (node ids;
   * else found from the campaign's links). Codex entries are added from their links.
   */
  recap?: { keep: string[]; check?: Quiz[]; practise?: string[] };
  steps: Step[];
  /** Titles of steps not built yet: dashed dots after the steps, not clickable. */
  soon?: string[];
}

/** How a chapter is numbered on screen: 07, P1 for a prologue chapter, A for an appendix. */
export const chapterNo = (c: { num: number; appendix?: string; prologue?: string }): string => c.prologue ?? c.appendix ?? String(c.num).padStart(2, '0');

/** Planned chapters, shown greyed out on the map. */
export interface FutureChapter {
  num: number;
  title: string;
  blurb: string;
  level: string;
}

const benchCache = new WeakMap<ComponentDef, ComponentDef>();

/**
 * Wrap a component in a test bench: the component appears as one closed symbol with the
 * scene's pins around it, so the learner sees it as a black box and can open it.
 */
export function bench(def: ComponentDef): ComponentDef {
  const hit = benchCache.get(def);
  if (hit) return hit;
  const g = symbolGeom(def);
  const at: [number, number] = [8, 3];
  const pins: Record<string, [number, number]> = {};
  const pinDirs: Record<string, 'left' | 'right' | 'up' | 'down'> = {};
  const nets: NetDef[] = [];
  for (const p of def.ports) {
    const pg = g.ports[p.name];
    const x = at[0] + pg.pos[0], y = at[1] + pg.pos[1];
    if (pg.exit === 'left') pins[p.name] = [x - 6, y];
    else if (pg.exit === 'right') pins[p.name] = [x + 6, y];
    else if (pg.exit === 'down') { pins[p.name] = [x, y + 5]; pinDirs[p.name] = 'up'; }
    else { pins[p.name] = [x, y - 5]; pinDirs[p.name] = 'down'; }
    nets.push({ name: p.name, ends: p.dir === 'out' ? [`u.${p.name}`, p.name] : [p.name, `u.${p.name}`] });
  }
  const b: ComponentDef = {
    id: `bench_${def.id}`, name: def.name, category: def.category, summary: def.summary,
    ports: def.ports, symbol: { kind: 'box', label: def.name },
    netlist: () => ({ pins, pinDirs, instances: [{ name: 'u', def, at, label: def.name }], nets }),
  };
  benchCache.set(def, b);
  return b;
}
