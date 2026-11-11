# Transparent boxes: zooming reveals what is inside

> **Reading of the request.** The author wrote "transport boxes". This design reads it as **transparent boxes**, the
> site's own promise (CLAUDE.md: "every component on screen is a transparent box"). If "transport" meant something
> else, say so and this is void.

Design and mockup only: nothing here is in the product (mockup-first rule). Mockup: `mockup.html` (open it beside the
SVGs in this folder). Measurements: the scripts in `docs/transparent/` on branch `docs/transparent-boxes`, numbers below
and in `route-levels.json`, `draw-levels.json`, `shape-ratios.txt`.

**The idea.** On the stage (chapters, workbench) and the sandbox's look inside, zooming toward a library box (ALU,
adder, register file…) opens it where it is: its own netlist with live values, the surrounding circuit kept. Drill
(double-click, the breadcrumb) stays as it is; this is added beside it, as a View option.

**In one paragraph.** The inside of a box is far bigger than its symbol (median 7.5×, up to 250×) and differently
shaped (median 3× in aspect). So it cannot be drawn inside the symbol, and the level cannot grow around it. It opens as
a **lens**: a window anchored on the box, at the inside's own legible scale, growing with the zoom until it fills the
stage, at which point the view becomes that level (a drill), from the same picture. One lens at a time. Its wires come
from a route cache made at build time. Off by default while it is new.

---

## Measurements (what the decisions rest on)

Conditions: a Windows desktop shared with other sessions' builds; Node v22.13.1; headless Chrome (`--headless=new
--disable-gpu`); the single-cycle CPU, the plain pipeline and the out-of-order core running `fib`. Every box of the
three top levels that opens, and (for routing) one level further down: 199 distinct levels.

| per opened level | median | p90 | max |
|---|---|---|---|
| wires-first + route, **first open** (Node, cold) | 0.8 ms | 51 ms | 861 ms |
| the same, a level opened before (wires-first is memoized per netlist) | 0.4 ms | 15 ms | 267 ms |
| `SchematicView.show()` in Chrome, single-cycle (14 boxes) | 9.6 ms | 25 ms | 32 ms |
| the same, pipeline (19) | 5.7 ms | 19 ms | 23 ms |
| the same, out-of-order core (53) | 12 ms | 140 ms | 269 ms |
| `update()` after a clock edge (median of 8 edges) | 0.1 ms | 0.3 ms | 0.6 ms |
| a sub-simulation (opening the ROM) | 38–68 ms once | | |

44 of 199 levels take more than 8 ms on first open, 15 more than 100 ms. **Size does not predict it**: a 10-part
`control_signals` takes 192 ms, a 5-part `btblookup` 123 ms (the cost is wires-first's crossing checks and the
untangle search, not the part count).

Shape (`shape-ratios.ts`, 66 distinct boxes on the three tops): the inside's extent over the symbol's is a median 7.5×,
p90 54×, max 250× (a 187-bit pipeline register: 25 × 1501 units behind a 10 × 6 symbol). Aspect differs by a median 3×,
p90 28×. A box's own labels, its inside fitted into the symbol, reach legible.ts's 7 px only when the box is drawn a
median 655 px tall. The ALU: symbol 8 × 12, inside 78 × 146 (12×), labels legible at a 650 × 970 px box.

---

## 1. Shape mismatch

**Decision: (b) a lens.** A rounded window anchored on the box (centred on it, pushed inside the stage's edges), drawing
the box's inside at its own scale, over the level, which stays drawn and dimmed around it. The lens opens from the box's
rectangle (the transition: the box's outline grows into the lens while the inside fades in). Its size is capped at
**60 % of the stage's width and 85 % of its height**, so a band of the circuit always shows on both sides. The lens's
scale follows the zoom: chosen at opening so the inside fills the cap, it then grows with every zoom step until the lens
reaches the whole stage, where the hand-off to a drill happens (item 9). A tall bit-sliced inside (a 32-bit register)
is drawn at the same rule, so it is cut by the cap: the lens then shows the part of the inside nearest the zoom point
and pans with it.

**Why.** The lens is the only one of the three whose readability does not depend on the box's ratio: its scale is the
inside's own. Measured, any box works, from 5.5× to 250×. The circuit around it does not move, so what the learner was
reading stays where it was, and the outer wires still visibly reach the box (item 3).

**Alternatives rejected.**
- **(a) The box grows and its neighbours move** (shown in the mockup by sliding half the level). The ALU would have to
  grow 12×, a register 43×, one pipeline register 250×; the level re-routes at every threshold (the top levels' own
  `show()`: 70–400 ms), and everything the learner was reading jumps away. It is also a second layout of every level,
  to test for overlaps at every zoom.
- **(c) The inside fitted into the symbol, truly in place.** Honest and cheap, but illegible until the box is about
  650 px tall (median), and for bit-sliced parts never (a 32-bit register's labels: 2 300 px). It is what working gates
  already does for the one case where it works (item 7).

## 2. Performance

**Decision.**
- **Lazy:** only one box opens: the box under the zoom's focus (the pointer for the wheel, the pinch centre, the
  keyboard cursor's part), on screen, past the threshold of item 4. Boxes near the focus that are also past it are
  prefetched (route data only, no DOM), at most two.
- **Nothing is built during a gesture:** while a zoom or pan runs, the lens only moves, scales and fades (a CSS
  transform on an existing element: ≤ 2 ms a frame). Building starts when the gesture settles (the stage already plans
  legible names at that moment).
- **Routes from a build-time cache:** `scripts/lens-routes.ts` (run by `npm run build`, like `hwstats.ts`) routes every
  registered library level that a stage can show and whose first route takes over 4 ms, and writes its routed paths,
  tags and hops to `public/lens/<id>.json`, keyed by the netlist fingerprint layout.ts already computes for "redrawn
  since you arranged it". The lens fetches it lazily; a stale or missing key routes on the main thread instead.
- **DOM built off screen:** a second `SchematicView` on a detached host (as `image.ts` `exportInside` already draws a
  part's inside with live values), in one task, then moved into the lens. Budget: **≤ 50 ms for that task** (the
  single-cycle CPU's worst level is 32 ms with routing, the pipeline's 23 ms), **≤ 2 ms per frame** for the lens while
  zooming, **≤ 1 ms per frame** for live values (measured: 0.6 ms worst).
- **Caching:** the routed data of the last 16 levels (by id + fingerprint); the lens's DOM is dropped when it closes
  (rebuilt from cached data in about the DOM time, under 25 ms). A sub-simulation (`ViewCtx.child`, 38–68 ms for the
  ROM) is kept by ViewCtx as it is today.
- **Out-of-order core levels** (DOM 100–270 ms) are out of the first phase: the lens shows "too large to open here:
  double-click to step in" instead.

**Why.** First routes have a tail no frame budget survives (861 ms), and part counts cannot tell which levels are slow,
so a guard on size would be wrong both ways. Routes are deterministic per level and rules (the registry-wide route tests
already route every registered netlist), so they can be made once at build time. DOM time is what remains, and it is
within one acceptable task for the CPUs a learner zooms around in the first chapters.

**Alternatives rejected.**
- **A worker.** `routeNetlist(def, nl)` takes ComponentDefs, which carry functions (`netlist()`, behaviours, specs) and
  generated ids, so it cannot be posted. It would need a plain-data router core (pin geometry, symbol rects, nets): a
  refactor of route.ts and wirefirst.ts for a cost the cache removes. Revisit if cache misses hurt.
- **Time-slicing the router with yields** (as `flattenAsync` does): the router's untangle search is not written as
  steps; the cache makes it unnecessary for library levels.
- **Opening every box above a threshold.** At 12× its box, two lenses cannot share a stage, and the DOM cost multiplies.

## 3. Pin mapping

**Decision: wires end at the rim; a short labelled jog along the rim reaches each inner pin.** The lens has a rim
channel (10 px). Each outer wire, which runs to the box's edge under the lens, is drawn on top up to the rim at its own
height; there it turns along the channel to the inner port's pin and ends on a terminal dot with the port's name. The
jog carries the net's live value and colour (same classes, `--nh` hue). Inputs on the left rim, outputs on the right, as
the inside draws them; rim terminals keep the inside's order, and jogs never cross (they are assigned in order of the
outer wires' heights, the inner pins' order being the box's port order).

**Why.** The outer wire and the inner pin are rarely at the same height (the lens is 5–250× the box), and the learner
must see which outside wire is which inside port. A jog is the shortest drawing that says it, and it reads like the
router's own wires.

**Alternatives rejected.** **Stubs only** (the inside's pins with dangling names): the link to the outside is lost.
**A ring of every port around the lens** (as a chip face): duplicates the inner pins, and a 32-bit bus port becomes a
crowd. **Leader lines from the box to the lens across the circuit**: they cross the very wires they name.

## 4. Depth and thresholds

**Decision: one level at a time.** Inside a lens, boxes do not open lenses; going deeper is a drill (item 9), after
which the drilled level's own boxes can open. **The live breadcrumb** shows the peek as a last crumb in italics,
"cpu ▸ *alu (peek)*", with crumbvals' live value as for any crumb; a click on it drills.

**Thresholds** (in on-screen pixels of the focused box, tied to legible.ts):
- **opens** when the box's shorter side reaches **96 px** (8 × `NAME_PX` 12): by then the box's own label (1.05 units) is past
  `MIN_TEXT_PX` 7 for any box up to 14 units tall (96 / 14 × 1.05 = 7.2 px), the box is plainly the target, **and** the lens, at its cap, can draw the inside with every block at least
  10 px (legible.ts `planNames` `minBlockPx`), so the inside's block names are drawn at their fixed 12 px. A box whose
  inside cannot meet that within the cap (a few huge levels) does not open; its hint says "double-click to step in".
- **closes** under **72 px** (hysteresis of ¾, so a zoom wobble does not flicker it).
- **hands off to a drill** when the lens reaches the stage's size (item 9).

**Why.** Recursion would put a lens inside a lens at 12 × 12 = 144× the outer scale, past anything a stage can show
legibly, and the lazy budget assumes one level. The breadcrumb is where the learner already reads depth.

**Alternatives rejected.** **Recursive down to transistors**: illegible and unbudgetable. **The breadcrumb following
the deepest box under the cursor without a lens** (hover as navigation): the crumb would flicker as the pointer crosses
boxes. **Thresholds in grid units per pixel only**: they would ignore the box's size, and a 4-unit mux and a 76-unit
issue queue would open at the same zoom.

## 5. Interactions with what exists

| what | decision | why |
|---|---|---|
| click / select inside a lens | selects the inner part; the inspector shows it with its path (`alu.add`); double-click drills into it | the lens is a level, so it behaves like one |
| Why? | works on lens wires (whyNet on the lens's ViewCtx); a trace that reaches the rim continues on the outer level | same Sim, so the trace is honest across the rim |
| Break a part | in the lens's right-click menu, as on a drilled level (`ablate(def, path)` per level) | it is per level already |
| probes, Timing panel | only where `ctx.sim === stage.sim` (expanded children: yes; a sub-simulation such as the ROM: no, as today) | the existing rule; no new engine path |
| overlays (Slack, Cost / Energy / Depth, Activity, Load, Unknown) | the open overlay also paints the lens's parts for its level (`slackAt(s, path)` per level; the others per node); the legend stays the outer level's, with a line "inside alu: the same scale" | one overlay, one legend; per-level computation already exists |
| layout lock, dragging | the lens is read-only for arranging; a drag in it pans the outer view (the lens follows its box); the inside is drawn with the learner's saved layout of that level | arranging two levels at once would need two undo stacks |
| highlights, data-show, tours | unchanged: they name drill paths and drill, as today; a highlight that names the box lights the lens's rim; a tour closes any lens before its first beat | tours are tested on drill paths; a lens must not change them |
| flowing bits | run on lens wires (flow.ts, flowtokens.ts over its polylines), only while the lens is open; off with reduced motion as everywhere | live values are the point |
| CPU panel's instruction highlight | lights the box (rim glow) when the instruction uses it; marks inside the lens are phase 2 (insthw names are top-level) | needs insthw to name inner units |

## 6. Phone

**Decision.** The lens opens on a **pinch** (its centre is the focus), never on a tap. On a 390 px screen the cap is
the width less two 16 px gutters and 85 % of the stage's height, below the stage bar. **A tap inside the lens** on a part
at least 40 × 40 px (the coarse-pointer target size) selects it; on anything smaller it drills into the box (the hint in
the lens's tag says "tap to step in"). Double-tap drills, as today. The setting starts **off on a touch screen** even
after it becomes the default with a mouse (see the setting).

**Why.** At 390 px the lens is nearly the whole stage, so it is close to a drill anyway; most inner parts are under
40 px there, and a tap that misses is worse than a drill that lands.

**Alternatives rejected.** **Opening on a tap** (no zoom): collides with selecting. **Lens below the box as a sheet**:
covers the run bar and the panels.

## 7. Engines

**Decision.**
- **Cycle engine** (DualSim preferring it): the lens shows settled values, like a drilled level today; nothing new.
- **NmosSim scenes** (Appendix A's 6502): **off**. The levels are transistor-level blocks whose insides are the chip's
  own drawing; a lens adds nothing a drill does not, at a cost the measurements did not cover.
- **Switch-level children** (a NAND's transistors, cells): **working gates stays as it is** and is the special case of
  this design where (c) works: an inside about the symbol's size (`CMOS_GATES`, drawn in the body at `CMOS_MID_PX` 11
  and `CMOS_FULL_PX` 22). The rule written down: a box whose inside is within 1.5× of its symbol in both directions
  opens in place (c); everything else opens a lens. No CPU-top box qualifies (the smallest ratio measured is 5.5×), so
  the two features do not meet in practice, and they are not merged in this work.
- **Sub-simulations** (`ViewCtx.child` for a leaf: the ROM, a NAND at gate level): allowed, built when the zoom settles
  (38–68 ms measured), kept by ViewCtx.

**Why.** Each engine keeps its current contract; the lens is a view.

## 8. Print, image export, reduced motion, accessibility

**Decision.**
- **Print and image export draw closed boxes.** The lens is a separate overlay element, never in `view.el`'s level
  drawing, so `svgImage` / `exportSchematic` / Print this chapter never see it; the attribute (`data-lens`) is also in
  `printfig.ts` PAPER, forced off for a figure.
- **Reduced motion** (`reducedMotion()`): no grow and fade; the lens appears and goes at once.
- **Screen readers**: the lens is `role="group"` with `aria-label="Inside alu (alu32): 17 parts, live"`; its opening is
  announced once on the breadcrumb's live region ("alu opened in place; Enter steps in").
- **Keyboard**: the keyboard cursor (kcursor.ts) on a box: **Shift+Enter** opens its lens (the keyboard's zoom), Esc
  closes it and gives the focus back to the box, **Enter drills** as today. Focus does **not** move into the lens: its
  parts are reached by drilling. (A peek is for looking; tabbing into it would need a second cursor.)

**Why.** Exports and print are documents of a level; a lens is a transient view. Keyboard users get the same peek
without a second focus model.

## 9. Relation to drill and look inside

**Decision.**
- **Double-click still drills**, on a closed box or on a part inside a lens. The breadcrumb, `#/…/<inst>` history (one
  entry per level, ui/drillpath.ts) and look inside are unchanged.
- **Zooming in past the lens's full size hands off to a drill**: when the lens would exceed the stage, the view becomes
  that level at the same on-screen scale and position (no jump), and a history entry is pushed as for a double-click.
- **Zooming out past fit on a drilled level goes back up**, but only with the setting on: a zoom-out continuing for
  300 ms after the level is at fit pops one level (as the breadcrumb's parent does), reopening the parent with the lens
  at its full size, which then shrinks as the zoom-out continues. Without it a learner could zoom in but never back out.
- **Look inside (sandbox)**: the same lens over look inside's schematic (it is a SchematicView), phase 2.

**Why.** Drill is the tested, addressable navigation (links, tours, notes' pins use its paths); the lens is a way to it,
not a replacement. The hand-off makes zoom a continuous path from a CPU to an adder's gates.

**Alternatives rejected.** **The lens replacing drill**: loses addresses, tours and history. **No hand-off** (the lens
stops growing): the learner then has to find double-click at the very moment zoom was working.

## The setting (added to the brief)

**Decision.**
- **Where:** View options ▸ **Behaviour**, right after "Move parts by dragging" (both are about what a gesture does on
  the stage). In the search: `> Open blocks as you zoom`, keywords zoom, inside, peek, transparent, lens, open (a
  `searchbuiltin.ts` `act()` like moveParts's).
- **Wording:** **Open blocks as you zoom** · "Zoom into a block and its inside opens over it, live; zoom further to step
  in. Off: a block opens only when you double-click it. Starts off on a touch screen".
- **Type and default:** `zoomOpen: boolean | null`, null = the device default, as `moveParts`. **Off everywhere in the
  first phase** (opt-in while it is new: it changes what a zoom does, and the out-of-order levels cannot open yet).
  When phase 3 makes it the default, null means **on with a mouse, off on a touch screen** (at 390 px a lens is nearly a
  drill, item 6).
- **Off restores today exactly:** no lens element is ever created, no route cache is fetched, the zoom never hands off
  and zooming out never goes up a level, the stage hint is today's text, double-click and the breadcrumb drill as now.
  (The tests of item 10 run the existing stage tests with it off and on.)
- **Reset and presets:** it joins **VIEW_KEYS** (Reset view sets it back to null), not LOOK_KEYS or PRESETS (it is
  behaviour, not looks).
- **Live preview** (ui/viewpreview.ts): the preview never zooms, so switching the row on draws the preview's adder with
  its lens open, as a picture of what the row does; switching it off closes it.

**Why.** The author asked for a View option first; `moveParts` already set the pattern (null = device default, a stage
bar control and a search action). Off at first because a zoom that suddenly opens things is a surprise to everyone used
to today's stage.

## 10. Rollout, tests and what is cut

**Phase 1 (MVP).** The stage only (chapters, workbench): the setting (off), the lens on the focused box with the
thresholds of item 4, rim jogs, live values and flowing bits, select inside, double-click to drill, the hand-off and the
zoom-out back up, the build-time route cache, reduced motion, the breadcrumb's peek crumb, Esc / Shift+Enter. Single-cycle
and pipeline CPUs and every smaller scene; out-of-order levels say "double-click to step in".

**Phase 2.** The sandbox's look inside; overlays inside the lens; Why? across the rim; Break a part inside; the CPU
panel's marks inside (insthw naming inner units); the phone.

**Phase 3.** The default becomes on with a mouse (null), after the author tries it; the out-of-order core's levels, if
the DOM can be built in slices (a SchematicView refactor) or turns out under budget on a quieter machine.

**Tests to add.**
- `lensPlan(boxRect, insideExtent, stage) → { rect, scale, terminals }`, DOM-free, over all 66 measured boxes and every
  registered netlist: the lens inside the stage and the cap; never over the LEVEL tag, the layout pill or the stage bar;
  block names legible at the opening scale (≥ 10 px blocks); rim terminals in port order; jogs that do not cross each
  other or a terminal.
- The route cache: every cached level equals a live `routeNetlist` (same paths), and a changed netlist misses (the
  fingerprint), as tests/route.test.ts routes every netlist today.
- Thresholds: open at 96, close under 72, no flicker over a scripted zoom wobble.
- Off restores today: the stage's existing tests and the smoke's stage routes run with the setting on and off; with it
  off no `.lens` element exists after zooming every box.
- Smoke: a route per CPU scene that zooms onto the ALU (desktop and 390 px, both themes, both boards), checks the lens
  appears, values update over a few cycles, no long task over 50 ms after the gesture settles (PerformanceObserver), the
  hand-off drills to `#/…/alu`, and zooming out returns.
- Print / export: Print this chapter and Image ▸ SVG with a lens open contain no lens.

**Cut.** (a) and (c) as general mechanisms; recursion; arranging parts inside a lens; probes in sub-simulations;
keyboard focus inside a lens; NmosSim scenes; a worker router; merging working gates into this.
