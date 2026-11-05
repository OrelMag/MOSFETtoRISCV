import { symbolGeom } from '../sim/geometry';
import { isSwitchPrim, type ComponentDef, type NetDef } from '../sim/types';
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

/**
 * One beat of a tour: what the stage does, then what the caption says. Beats run in order from the scene's opening
 * state; Back undoes a beat on the stage (its checkpoints). Names are the scene's (instances of the level at `at`).
 */
export interface Beat {
  /** The caption (HTML): {v:port} is a root port's value in decimal, {b:port} in binary at its width. */
  say: string;
  /** A short heading for the beat (shown above the caption). */
  title?: string;
  /** First beat only: put the scene back to power-on (Reset), so cycle counts start from the first instruction. */
  reset?: boolean;
  /** Root inputs to set first (one change: Back undoes them together). */
  set?: Record<string, number>;
  /** After setting: clock cycles to run (the scene's clock). */
  cycles?: number;
  /** Open this drill path first (from the scene's root; [] the top). Omitted: stay where the last beat was. */
  at?: string[];
  /** Instances of the open level to light (the rest fade), and frame. */
  show?: string[];
  /** Instances drawn as if removed: dashed, faded (a derivation's "before"). */
  ghost?: string[];
  /** Root port values the beat must leave (checked by tests/tours.test.ts). */
  expect?: Record<string, number>;
}

export interface Tour {
  /** The button's label (default "Walk me through it"). */
  label?: string;
  beats: Beat[];
}

/** A live worked sum beside the prose (ui/ledger.ts): the step's arithmetic in its own notation, from the scene's ports. */
export type Ledger =
  | {
      kind: 'add';
      a: string;
      b: string;
      sum: string;
      width: number;
      cin?: string;
      cout?: string;
      /** a − b: b is inverted and the carry-in is 1 while this port is 1. */
      sub?: string;
      /** Instances computing column i (lit while the column is hovered). */
      col?: (i: number) => string[];
    };

/** Layers under a step's body, each opened on request: the reasoning worked out, real chips, the usual mistake, numbers. */
export interface Layers {
  derive?: string;
  real?: string;
  pitfall?: string;
  numbers?: string;
}

/** A short passage of the RISC-V manual beside what the step builds, with three questions tied to the build (Step.reading). */
export interface Reading {
  /** Which volume: "RISC-V Unprivileged ISA" or "RISC-V Privileged ISA". */
  source: string;
  /** The section cited. */
  section: string;
  /** The quoted sentences, verbatim (kept short), one paragraph each. */
  quote: string[];
  /** How the passage maps onto the circuit the step shows (HTML). */
  note: string;
  /** Questions with a why per option; asked in the review queue like a step's quiz. */
  quizzes: Quiz[];
}

export interface Step {
  title: string;
  /** HTML: the explanation itself, as long as the idea needs (what, why, what it costs); depth beyond that in `more`. */
  body: string;
  /** "Walk me through it": the step's mechanism played on the live circuit, beat by beat. */
  tour?: Tour;
  /** A live worked sum next to the prose. */
  ledger?: Ledger;
  /** "Read the spec": a folded block under the body quoting the manual, with questions. */
  reading?: Reading;
  /** Derivation / In real silicon / Common mistake / Numbers, under the body. */
  more?: Layers;
  scene?: () => Scene;
  widget?: () => Widget;
  challenge?: Challenge;
  actions?: StepAction[];
  /**
   * What the scene's highlight shows, in words (HTML). By default a line is made from the highlighted instances'
   * names; '' hides it. Names in the body marked data-show="inst other" light those instances (ui/pages/looks.ts).
   */
  lit?: string;
  /** A deep dive: marked in the chapter's part list; it stays in order, is never hidden or locked, and nothing later relies on it (tests/chapter-guide.test.ts). */
  deep?: boolean;
  /** Conditions for the body's .try boxes, in order: a box ticks itself once its condition holds. */
  tries?: ((stage: Stage) => boolean)[];
}

export interface Chapter {
  id: string;
  /** numOf(id) (chapters/order.ts places the chapter); an appendix chapter continues the count but is shown by its letter. */
  num: number;
  /** The letter of an appendix chapter (shown instead of the number, after the main journey). */
  appendix?: string;
  /** The label of a prologue chapter (P1 …: before the transistor, between the map and chapter 1; num 0). */
  prologue?: string;
  /** Shown in place of the number (Basics: "Start", before the map; still a journey chapter, num 0). */
  label?: string;
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
  /**
   * Named parts of a chapter of 15 steps or more (PARTS_MIN), as [name, step count] in order: they only group the steps
   * (no step moves, so addresses and saved progress keep their numbers). The counts add up to the steps.
   */
  parts?: [name: string, steps: number][];
  steps: Step[];
  /** Titles of steps not built yet: dashed dots after the steps, not clickable. */
  soon?: string[];
}

export { chapterNo } from './meta';
export type { FutureChapter } from './meta';

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
    netlist: () => ({ ...(isSwitchPrim(def) ? { level: 'switch' as const } : {}), pins, pinDirs, instances: [{ name: 'u', def, at, label: def.name }], nets }),
  };
  benchCache.set(def, b);
  return b;
}
