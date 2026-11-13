# Transparent boxes: zooming reveals what is inside

> **Reading of the request.** The author wrote "transport boxes". This design reads it as **transparent boxes**, the
> site's own promise (CLAUDE.md: "every component on screen is a transparent box"). If "transport" meant something
> else, say so and this is void.

Design and mockup only: nothing here is in the product (mockup-first rule). Mockup: `mockup.html` (open it beside the
SVGs in this folder). Measurements: the scripts in `docs/transparent/` on branch `docs/transparent-boxes`, numbers below
and in `route-levels.json`, `draw-levels.json`, `shape-ratios.txt`, `cache-size.txt`.

*Revision 2 (after the coordinator's review):* a lens opens only from a zoom gesture (item 4); zooming out to go up is
phase 2, behind a cue and a fresh gesture (item 9); the route cache is measured, capped and ships first for drill as
phase 0 (item 2); overlays are painted inside in phase 1 (item 5); a touch screen gets the row disabled in phase 1
(item 6); one dim layer (item 5); the lens keeps out of covers and bars (item 1); no Shift+Enter, `+` and Esc instead
(item 8).

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

Route cache (`cache-size.ts`, phase 0): routing all 1 507 levels (the registry and the three CPU tops two deep)
takes 61 s on one thread; the 540 over 4 ms make 540 files, 3.2 MB raw, 681 KB gzipped, the largest 92 KB. The worst
first routes, which drill pays today: 5.5 s (`srt4terms32_36`), 4.3 s (`rvc_funct7`), 2.5 s (`rb_digits`), 2.2 s (`vseq`).

Shape (`shape-ratios.ts`, 66 distinct boxes on the three tops): the inside's extent over the symbol's is a median 7.5×,
p90 54×, max 250× (a 187-bit pipeline register: 25 × 1501 units behind a 10 × 6 symbol). Aspect differs by a median 3×,
p90 28×. A box's own labels, its inside fitted into the symbol, reach legible.ts's 7 px only when the box is drawn a
median 655 px tall. The ALU: symbol 8 × 12, inside 78 × 146 (12×), labels legible at a 650 × 970 px box.

---

## Revision 3: inside the box (2026-11-11, the author's decisions; supersedes the floating lens and its mockup)

The author tried phases 1–2 and decided: the inside is drawn **within the box's own outline**, never over its neighbours;
zooming out mirrors zooming in; the rule must be predictable. This section replaces items 1, 3, 4 and the lens parts of
5, 6 and 9 above. The approved mockup's floating lens, rim connectors and dim are **superseded**; screenshots of the
first build are in the tip for the author to check on return. Kept: the setting (off by default, and at first on touch), the
route cache, Why? / Break a part / CPU marks / look inside / overlays inside, closed boxes in print and image export,
reduced motion.

**The author's bug, reproduced** (a register with neighbours close by does not open; phase-2 build, single-cycle and
pipelined CPUs). Two causes in the floating lens: (1) it opened at 96 px on the box's *shorter* side, so a tall narrow
module (a pipeline register, 3 × 74 units) opened only at 1 936 px tall, three stages high, and `closesAt` ("more than
half outside the free stage") then closed it on the very next zoom or pan step: it never stayed open; (2) refusals were
cached by definition + canvas size (`refused`), so a box refused once with a panel open stayed refused after the panel
folded, at every zoom. Neither can exist below: the rule reads only the box and its inside, and nothing is cached
that the learner cannot see (the floor per definition is a constant of the netlist).

**R3.1 Where it is drawn.** In the box's outline, letterboxed: the inside's extent scaled to fit what the box leaves
free inside its edges and centred there (`lensplan.ts fitInside`). Each side keeps INSET (0.6 units), or more where the
box's own port names sit (`bandOf`: past the farthest name boxtext.ts lays out on that side, a clock's marker included, at
most 30 % of the box), so the inside's stubs and drawing never run through them. It grows on screen only through the view's zoom, with the box; neighbours and their wires never move
and are never covered. The box's ports stay on its edge as today; a short stub inside the outline joins each to its
inner pin (it never leaves the outline). The box's name and icon fade while its inside shows (the crumb carries the
name); its port names stay on its edge, so which pin is which still reads; its tinted body is the inside's background. The extent `E` is what the view draws, computed from the
netlist (`insideExtent`: parts, the level's pins with their knobs and names, the view's 3-unit margin), so the scale the
rule reads is the drawing's. **Tall bit-sliced parts** (a 32-bit register: its inside 60 × 270 units in an 8 × 6 box)
read as a narrow centred column of bit cells, its first and last named ("ff0", "ff31": the run rule, R3.2); the
single-cycle CPU's `pc` opens when the box is ~300 × 225 px, its column clear of its `clk` name. A pipeline register (3 × 74 units, its inside drawn 95 × 30)
opens at ~132 px wide (3 252 tall): a strip, so double-click stays the quick way in. That is the honest cost of drawing
inside the outline: their insides are the wrong shape for their symbols. Drill (double-click) stays the quick way in,
and the hint (R3.3) says how far away the opening is.

**R3.2 The one rule.** A box opens when **(a)** it is at least **64 px** on its shorter side (`BOX_MIN_PX`: smaller, its
own name and ports are what reads) **and (b)** its inside's smallest named block, scaled into the box, is at least
**10 px** on its longer side at the current zoom (`FLOOR_PX` = legible.ts `minBlockPx`: where the block's name is
drawn). Both reduce to one number per box, `openAtPx` (the view's px per unit at which it opens), from the box's size and
its inside alone (`smallestNamed(def)`: from the netlist, memoized per definition). It closes below **¾** of that
(`CLOSE_SHARE`): outside that band the answer is the geometry's alone, inside it the previous answer's alone
(`decide(prev, px, openAt)`); nothing else is state. Only a zoom out closes a box: a panel docking or folding, a resize
or a pan moves the cap or the box, never the answer, and a box panned out of reach keeps it (its drawing is dropped).
Constants (tie cells) never open. Every box on screen that meets the rule opens (R3.6), so nothing
depends on where the pointer was. On a touch screen as with a mouse (item 6: the setting starts off there): a pinch opens a box
past its opening zoom like the wheel; a tap on an inner part at least 40 px selects it, anywhere else in the inside steps
into the box; a double tap on a part drills. Not in an NMOS scene. **Runs.** RUN_MIN (4) or more identical parts (one definition and orientation: a register's flip-flops, a register file's
registers, a mux array's gates) count as one block, the run's extent, as long as each cell is at least CELL_PX (4) on
screen; while the cells are too small for their own names the lens names the run's first and last (`runsOf`).
**The canvas cap** (`capOpenAt`, the author's target, 2026-11-12): no box opens later than when its shorter side is
CAP_SHARE (40 %) of the canvas's shorter side, nor past the view's deepest zoom (camera.ts MIN_VIEW_UNITS: no dead end,
the hint never asks for a zoom the view cannot reach). The one place the canvas enters the rule (never its free area: a
panel docking opens or closes nothing); it decides the big insides on the out-of-order core (the issue queue, the reorder
buffer, the store queue, the instruction classifiers, the operand units, `rf` on the pipelined and single-cycle CPUs), which
then open before every inner name is drawn; those names appear as the zoom goes on. `data-open-at` is the capped value.
Measured opening zooms before the cap (px per unit, fib, with the port-name band): single-cycle `pc` 37.5, `alu` 42.9,
`rf` 35.7, `imm` 16.0, `ctl` 6.5, `npc` 38.0; pipeline `FD` / `DE` 44.0, `hz` 20.5 (tests/lens-hone.test.ts; the cap
opens `alu`, `rf`, `npc`, `hz` earlier, their inner names appearing as the zoom goes on); tests/lens-target.test.ts holds every box
of the three CPUs' tops to the cap at two canvas sizes.

**R3.3 Shown to the learner.** Hovering a closed box that can open shows "zoom in to see inside (×2.4)": the zoom factor
still needed, from the box's `data-open-at`; past ×4, "zoom in ×7.5 to see inside, or double-click to step in". It sits
below the box (above it, or inside its top edge, when there is no room), never over its name or under the bar. The level
badges stay above the insides; a category icon is hidden once it would pass 36 px. A hand-off takes only the box under
the pointer: zooming on a small part never steps into a big neighbour. Open, its crumb reads "cpu ▸ *alu (inside)*" while the pointer is over it, and Enter /
double-click step in. The `?` sheet and View options say the rule in one line: "A block opens in place once it is big
enough for the names inside it to read."

**R3.4 Zooming out.** (a) The inside shrinks with its box and crossfades back to the symbol when the rule closes it: the
mirror of opening (FADE_MS 160 both ways, a CSS opacity transition; none with reduced motion). Never a sudden close.
(b) Going up after stepping in (a hand-off, a double-click, the crumb): a line under the breadcrumb says the rule the
whole time, "Zoom out to see all of alu, then once more to go up to cpu", then "Zoom out once more to go up to cpu" once
the level fits; from then a fresh gesture (zoomout.ts: 400 ms without a wheel event, a new pinch closing to 0.9, the `−`
key or the zoom-out button; never the event that raised the cue) goes up, and the level left is drawn open in its box
exactly where its drawing was, shrinking with the zoom until the rule closes it. (c)
The wheel zooms the whole view, insides included; nothing is caught by the inside.

**R3.5 The hand-off.** When the drawn inside (the fit, on screen) under the pointer covers the canvas in width or in
height (`handsOff`), or a zoom-in step comes at the view's deepest zoom (an inside drawn small in its box is then never a
dead end), the view becomes that level, at the scale and place where its drawing was (`handOffView`: the inner
drawing *is* the drilled level's drawing, so nothing jumps), with a history entry as for a double-click.

**R3.6 Many boxes.** Every box that meets the rule opens, built one per animation frame, nearest the pointer first, each
under DESIGN.md's 50 ms (the route cache). A build is two tasks: the level (`ctx.child`) in one frame, the drawing in the
next; a behavioural leaf's level (the program ROM: a lock-step sub-simulation, ~42 ms) waits until the zoom has settled
(160 ms), so its task never lands in a moving gesture. Measured (1400 × 900, headless Chrome, quiet machine): single-cycle
top, every build ≤ 7.4 ms but the ROM's 41.9 + 6.6, no long task in a zoom from fit to ×12; out-of-order top, every
build ≤ 8.1 ms (div 6.6, ex0 / ex1 7–8, mule 5.1), and its zoom and pan long tasks (50–166 ms) are the level's own,
the same with the setting off. A level with more qualifying boxes than frames allow builds the nearest first; the rest
show their symbol until their turn.

**R3.7 Print, export, interaction.** Each inside is its own SchematicView in an overlay positioned exactly on the box's
outline (clipped to it) and moved with the view's camera: so the level's own svg never contains an inside, and print and
image export draw closed boxes with no special case. The inside is read-only for arranging; a click selects an inner
part (the inspector shows `alu.add`), a wire click traces it (Why?), the wheel and drags go to the view. Overlays, CPU
marks (per box, by prefix), Why?, Break a part and look inside work per inside as they did per lens.

**R3.8 Removed.** The free-stage placement and cap, rim connectors and deep-pin rings, the stage dim on opening, the
focus target, `refused`, the 96 / 72 px thresholds, `closesAt`, `growPlan`, `openPlan`, `rimJogs` and their tests (deleted
with the floating lens; tests/lens-hone.test.ts keeps the old open / close rule as the regression's fixture). Esc no
longer closes anything (nothing is modal): it goes up as without the setting.


## 1. Shape mismatch

**Decision: (b) a lens.** A rounded window anchored on the box (centred on it, pushed inside the stage's edges), drawing
the box's inside at its own scale, over the level, which stays drawn and dimmed around it. The lens opens from the box's
rectangle (the transition: the box's outline grows into the lens while the inside fades in). Its size is capped at
**60 % of the free stage's width and 85 % of its height**, so a band of the circuit always shows on both sides.

**The free stage**, not the stage's rectangle: the canvas less everything the camera already keeps clear (camera.ts
covers, `Stage.covers()`: right-docked panels through `--dock-space`, the Why? card, the challenge notes, the LEVEL tag
and the layout pill), less the stage bar above and the run bar below. The lens is placed centred on its box, then
pushed into the largest free rectangle that holds it; **it never sits under a docked panel, the run bar or the stage
bar.** If that free rectangle cannot hold the lens at its opening scale (item 4), the box does not open and its hint
says "double-click to step in". The placement is recomputed when a cover changes (a panel docked or folded, the Why?
card opened), as `setCover` refits the camera today. The lens's
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
- **Routes from a build-time cache:** `scripts/route-cache.ts` (run by `npm run build`, like `hwstats.ts`) routes every
  registered library level and every level the chapters' CPU tops reach, and writes those whose first route takes over
  4 ms to `public/routes/<id>.json` (routed paths, dots, bus-label spots), keyed by the netlist fingerprint layout.ts
  already computes (`drawingKey(nl)`) for "redrawn since you arranged it" plus a version of the router's rules (route.ts, wirefirst.ts). A
  level's view fetches its file lazily; a stale or missing key routes on the main thread as today. Not precached by the
  service worker (only `assets/` is); the desktop build ships it as part of `dist/`.
  - **Measured** (`cache-size.ts`, 1 507 levels: the registry and the three CPU tops two deep): **540 files, 3.2 MB raw,
    681 KB gzipped**, the largest 92 KB. Routing them all takes **61 s on one thread**; spread over the build machine's
    cores with `worker_threads` (the script, unlike the page, can build the defs itself in each worker), about 15–20 s on
    four, beside `hwstats.ts`'s 20 s.
  - **Ceilings**, checked by the script (the build fails, with the levels to blame, past them): **≤ 1.5 MB gzipped in
    all, ≤ 200 KB per file, ≤ 60 s of build time on CI**. Past the size ceiling the 4 ms threshold rises (8 ms keeps
    the 44 worst CPU levels and most of the registry's tail) rather than the cache being dropped.
  - **It serves drill too.** The same first routes are paid today by every double-click: the worst measured are 5.5 s
    (`srt4terms32_36`), 4.3 s (`rvc_funct7`), 2.5 s (`rb_digits`), 2.2 s (`vseq`), 1.4 s (the issue queue's entry). **It
    ships first, as its own change (phase 0), independent of the setting**: SchematicView.show() takes a cached route
    when its key matches, for any level, drilled or not.
- **DOM built off screen:** a second `SchematicView` on a detached host (as `image.ts` `exportInside` already draws a
  part's inside with live values), in one task, then moved into the lens. Budget: **≤ 50 ms for that task** (the
  single-cycle CPU's worst level is 32 ms with routing, the pipeline's 23 ms), **≤ 2 ms per frame** for the lens while
  zooming, **≤ 1 ms per frame** for live values (measured: 0.6 ms worst).
- **Caching:** the routed data of the last 16 levels (by id + fingerprint); the lens's DOM is dropped when it closes
  (rebuilt from cached data in about the DOM time, under 25 ms). A sub-simulation (`ViewCtx.child`, 38–68 ms for the
  ROM) is kept by ViewCtx as it is today.
- **Out-of-order core levels** (DOM 100–270 ms) are out of the first phase: the lens shows "too large to open here:
  double-click to step in" instead.

**Why.** First routes have a tail no frame budget survives (861 ms among the CPU levels, 5.5 s in the registry), and part counts cannot tell which levels are slow,
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

**What opens a lens: a zoom gesture, and nothing else.** A lens opens only when a zoom gesture (wheel, pinch, the `+`
key on the keyboard cursor's part) settles with the focused box past the opening threshold. **Never on load, a fit, a
resize, a scene change, a step change, a drill or going back up**, even where a box is already 96 px or more at fit (the
gates and adder chapters' small scenes): those views stay as they are today until the learner zooms.
- **Panning the box off screen closes the lens** (the box's rectangle leaves the free stage by more than half); panning
  back does not reopen it: the next zoom does.
- **The next zoom settling over another box moves the lens to it**: the old lens closes (no transition) as the new one
  opens; there are never two. A zoom that settles over no box past the threshold closes the lens.
- A lens is never restored from an address, a share link or a note's pin: they name drill paths (item 9).

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
| overlays (Slack, Cost / Energy / Depth, Activity, Load, Unknown) | **painted inside the lens in phase 1.** Every overlay is already computed per level from a HierNode (`costOverlay(node)`, `loadOverlay(design, node)`, depth from the timing graph, `slackAt(s, path)`, Activity / Energy from the stage's toggle counts per node): the lens computes its own with its ViewCtx's node and paints its parts with the same bands. The legend keeps the outer level's counts and gains one line: "Inside alu: its parts' own shares". The one case with no data, a sub-simulation (the ROM: its toggles are another Sim's), says so in the lens's tag: "Activity not drawn inside". | an unpainted lens under a painted legend would read as "nothing here"; the data costs one more call per overlay, cached with the lens |
| the focus dim (the CPU panel's `highlight(names, true)`, Slow mode's instruction marks) | **one dim layer.** The lens draws no shade of its own: opening it puts the outer view in the same focus mode (`svg.schematic.focus .faded`, opacity 0.18) with the lit set = what was lit ∪ the box, so the box's wires stay bright up to the rim. A highlight arriving while the lens is open adds to the lit set; closing the lens restores the highlight as it stood (`lastHl`). Inside the lens nothing fades unless the highlight names inner parts (phase 2) | two dims multiply to near black, and they would disagree about what is lit |
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

**Phase 1 on a touch screen.** The setting is global, but phase 1 does not build or test the touch rules above. So on a
coarse pointer the View options row is shown **disabled, with "Not yet on touch screens"** in place of its description
(and the `>` action says the same), and a stored "on" has no effect there: a pinch zooms exactly as today. Phase 2
enables it with the rules above.

**Why.** At 390 px the lens is nearly the whole stage, so it is close to a drill anyway; most inner parts are under
40 px there, and a tap that misses is worse than a drill that lands. Phase 1 disables it rather than letting a pinch
open a lens with the desktop's rules: a pinch that also pans would open and close lenses as the fingers move, and the
tap-to-drill rule is what keeps the lens usable at that size.

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
- **Keyboard: no new key.** With the keyboard cursor (kcursor.ts) on a box, **`+`** (stagekeys.ts `cursor.zoomin`)
  zooms toward that part instead of the view's centre; that is a zoom gesture, so the lens follows the trigger rule of
  item 4 like the wheel. **Enter drills** as today (`cursor.act`). **Esc** (`stage.up`) closes an open lens first and
  goes up a level only when none is open. Focus does **not** move into the lens: its parts are reached by drilling.
  (A peek is for looking; tabbing into it would need a second cursor.) The KEYS entries change their words, so the ?
  sheet says it: `cursor.zoomin` "zoom in (toward the cursor's part; with Open blocks as you zoom, its inside opens)",
  `stage.up` "close the open block, else up a level".
  - *Shift+Enter, proposed in the first draft, is dropped:* it is in neither ui/keys.ts nor stagekeys.ts, and
    `Stage.cursorKey` takes any Enter without Ctrl, so Shift+Enter drills today. Giving it a second meaning would make
    the same key do two things depending on a setting.

**Why.** Exports and print are documents of a level; a lens is a transient view. Keyboard users get the same peek
without a second focus model.

## 9. Relation to drill and look inside

**Decision.**
- **Double-click still drills**, on a closed box or on a part inside a lens. The breadcrumb, `#/…/<inst>` history (one
  entry per level, ui/drillpath.ts) and look inside are unchanged.
- **Zooming in past the lens's full size hands off to a drill**: when the lens would exceed the stage, the view becomes
  that level at the same on-screen scale and position (no jump), and a history entry is pushed as for a double-click.
- **Zooming out to go back up is phase 2, with a cue.** In phase 1, a level entered by the hand-off shows, once the
  zoom-out reaches fit, a cue under the breadcrumb: "Esc or cpu goes back up" (the crumb is a link; the browser's Back
  works too, as the hand-off pushed a history entry). Nothing pops by itself. In phase 2 the cue becomes "Keep zooming
  out to go up to cpu", and **only a fresh gesture after the cue** pops one level: a new pinch, or wheel events after a
  pause of at least 400 ms with the cue shown; the parent then opens with the lens at full size, shrinking as the zoom
  continues.
  - *The 300 ms rule of the first draft is dropped:* trackpad momentum keeps sending wheel events for a second or more
    after the fingers leave, so a time rule would pop a level the learner never asked to leave. Phase 1 still has three
    ways up, so it loses nothing by waiting; phase 2 needs the gesture-boundary detection (and its tests on real
    trackpad traces) that the pop requires.
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
  in. Off: a block opens only when you double-click it" (the touch-screen clause went when it became the default everywhere).
- **Type and default:** `zoomOpen: boolean | null`, null = the device default, as `moveParts`. **Off everywhere in the
  first phase** (opt-in while it is new: it changes what a zoom does, and the out-of-order levels cannot open yet).
  When phase 3 makes it the default, null means **on with a mouse, off on a touch screen** (at 390 px a lens is nearly a
  drill, item 6).
- **Default since 2026-11-13 (the author's call): on, desktop and touch alike**, with Opened blocks without colour on too.
  null = never chosen = on; a stored false is kept. lensPlain's old default false had been saved for everyone, so a stored
  false without the `lensV` marker is read as unset once (settings.ts load; tests/lens-default.test.ts).
- **Off restores today exactly:** no lens element is ever created, the zoom never hands off and zooming out never goes
  up a level, the stage hint is today's text, double-click and the breadcrumb drill as now. **The one difference from
  today is the route cache (phase 0), which is not part of the setting:** drill uses it whatever the setting, so a
  first drill into a slow level is faster than today with the setting off too. Its pictures are identical (a test
  holds the cached routes equal to live ones).
  (The tests of item 10 run the existing stage tests with it off and on.)
- **Reset and presets:** it joins **VIEW_KEYS** (Reset view sets it back to null), not LOOK_KEYS or PRESETS (it is
  behaviour, not looks).
- **Live preview** (ui/viewpreview.ts): the preview never zooms, so switching the row on draws the preview's adder with
  its lens open, as a picture of what the row does; switching it off closes it.

**Why.** The author asked for a View option first; `moveParts` already set the pattern (null = device default, a stage
bar control and a search action). Off at first because a zoom that suddenly opens things is a surprise to everyone used
to today's stage.

## 10. Rollout, tests and what is cut

**Phase 0, on its own (no setting).** The build-time route cache (item 2), used by every SchematicView.show(): drill,
look inside, the workbench. It removes today's multi-second first drills (5.5 s at worst) whatever comes after, and it
is the lens's prerequisite. Its own tests (cached equal to live, a changed netlist misses, the size and time ceilings).

**Phase 1 (MVP).** The stage only (chapters, workbench), mouse and keyboard: the setting (off; disabled on a touch
screen), the lens on the focused box opened only by a zoom gesture (item 4), placed in the free stage (item 1), rim
jogs, live values and flowing bits, **overlays painted inside**, **one dim layer**, select inside, double-click to drill,
the hand-off, the "Esc or cpu goes back up" cue, reduced motion, the breadcrumb's peek crumb, `+` toward the cursor and
Esc closing first. Single-cycle and pipeline CPUs and every smaller scene; out-of-order levels say "double-click to step
in".

**Phase 2**, after phase 1 lands, split into tracks that can run in parallel (each its own branch from main, each
gated on its own; the lens module from phase 1 is the shared surface, so a track that needs a change to it says so to
the others before making it):

| track | scope | touches | depends on | done when |
|---|---|---|---|---|
| **2a. Look inside** | the lens over the sandbox's look inside (editor/inside.ts, a SchematicView): its covers are the dock (`--dock-space`), the canvas toolbar and the run bar; the setting is the same one | editor/inside.ts, the lens's placement inputs | phase 1 | zooming onto a library part inside look inside opens a lens; the sandbox's own smoke routes pass with it on and off |
| **2b. Why? and Break a part across the rim** | a Why? trace that reaches the rim continues on the outer level and the other way (whyNet on the lens's ViewCtx, foldAt per level); Break a part in the lens's right-click menu (`ablate(def, path)`) | view/whypanel.ts, sim/explain.ts's fold, the lens's menu | phase 1 | tests: a trace from an inner net to an outer pin names the same causes as on the drilled level; the ablation table equals the drilled level's |
| **2c. CPU panel marks inside** | insthw names the units an instruction uses inside a box (alu.add, rf.w5…); the lens shows them, the rim glows as in phase 1 when only the box is known | widgets/insthw.ts (`coreUnitNames`-style inner names), the lens's highlight | phase 1 | tests/insthw.test.ts covers the inner names for every RV32I instruction class; the CPU panel's click lights them in an open lens |
| **2d. The phone** | the row enabled on a touch screen with the rules of item 6: pinch opens, the cap within 16 px gutters below the stage bar, a tap selects a part ≥ 40 px else steps in, double-tap drills; "Starts off on a touch screen" (null = off on coarse pointers) | the lens's gesture input (view/pinch.ts), its tap rule, app.css's coarse-pointer block | phase 1 | smoke at 390 and 360 px with touch emulation: pinch onto the ALU opens a lens, a tap steps in, nothing lands under the stage or run bar |
| **2e. Zoom out to go up** | the cue becomes "Keep zooming out to go up to cpu"; a fresh gesture after it (a new pinch, or wheel events after a ≥ 400 ms pause) pops one level, the parent's lens at full size shrinking with the zoom; momentum never pops | the stage's zoom handling, ui/drillpath.ts's history | phase 1 (2d for the pinch half) | tests on recorded wheel traces (a trackpad fling with momentum, a mouse wheel, a second deliberate gesture): only the deliberate one pops |
| **2f. Out-of-order levels** | measure the lens's DOM build on the ooo core's levels on a quiet machine; if they fit 50 ms (with the route cache, the DOM alone), lift the "too large to open here" guard for those that fit, level by level; if not, leave them to phase 3's sliced DOM | the guard's list, a measurement script beside docs/transparent/ | phase 1 | each ooo level either opens under budget (a long-task check in the smoke) or keeps its "double-click to step in" |

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
- Trigger: no lens after load, fit, resize, a scene or step change, a drill or going up, even on scenes whose boxes are
  ≥ 96 px at fit (the gates and adders chapters); panning the box off closes it; a zoom over another box moves it (never
  two `.lens` elements).
- Placement: with each right-docked panel, the Why? card and the challenge notes open, the lens's rectangle never meets
  a cover, the stage bar or the run bar (`lensPlan` takes the covers).
- Dims: with a CPU-panel highlight on, opening and closing a lens leaves one `focus` class and the highlight's lit set
  restored.
- Overlays: with each overlay on, the lens's parts carry its bands; a sub-simulation's lens carries the "not drawn
  inside" tag.
- Keys: the ? sheet's `cursor.zoomin` and `stage.up` lines; Esc closes the lens before going up.
- Off restores today: the stage's existing tests and the smoke's stage routes run with the setting on and off; with it
  off no `.lens` element exists after zooming every box.
- Smoke: a route per CPU scene that zooms onto the ALU (desktop and 390 px, both themes, both boards), checks the lens
  appears, values update over a few cycles, no long task over 50 ms after the gesture settles (PerformanceObserver), the
  hand-off drills to `#/…/alu`, and zooming out returns.
- Print / export: Print this chapter and Image ▸ SVG with a lens open contain no lens.

**Cut.** (a) and (c) as general mechanisms; recursion; arranging parts inside a lens; probes in sub-simulations;
keyboard focus inside a lens; NmosSim scenes; a worker router; merging working gates into this.
