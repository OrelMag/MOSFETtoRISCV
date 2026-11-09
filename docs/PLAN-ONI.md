# Plan: four features borrowed from Oxygen Not Included

Status: B (Breakpoints) built on feat/oni-breakpoints (2026-11-09); A, C, D not built. Source: a review of what *Oxygen Not Included* (ONI) does
well that fits this site. Four features were picked:

| # | ONI feature | Ours | Where | Size |
|---|---|---|---|---|
| A | Disconnect tool | **Cut tool**: drag a line, every wire it crosses is cut | sandbox | S |
| B | Pause on alert | **Breakpoints**: Run stops when a condition holds | sandbox, CPU drawer, chapter CPU panel | M |
| C | Overlay buttons | **Overlay bar**: one quantity at a time over the whole circuit, with a legend | stage + sandbox | L (mockup first) |
| D | Sandbox brushes | **Fault brush**: stuck-at, bit flip, slow gate | sandbox (+ bug-hunt levels later) | L |

Suggested order: A → B → C → D. A and B are small, self-contained and teach nothing new to the core.
C changes how every screen looks, so it needs an approved mockup first (CLAUDE.md, "Major changes"). D touches
the simulators, so it goes last, after B, which gives it a way to stop when a fault shows up.

What exists today (checked 2026-11-09): no simulation breakpoints (`breakpoint` in `src/` is a wire bend or
`ebreak`), no way to force a net in any `Sim`, no heat or power-density view, no cut tool. The slack heatmap
(`view/delayui.ts` heatToggle / heatLegend, `data-slack` on instances, app.css `--slack-0…4`) is the only
overlay, and C generalizes it.

---

## A. Cut tool (ONI's Disconnect)

**What the learner does.** Press `K` (knife; `X` reads as clipboard cut next to Ctrl+X, and bare `K` is free:
only Ctrl+K is bound) or pick Cut in the toolbar / the canvas right-click menu), then drag a line
across the canvas. Wires the line crosses light up while dragging. On release they are cut, as one undo step.
Esc cancels. A plain click on a wire with the tool cuts it at that point.

**Rule for a cut.** It cuts the wire *at the crossing*. It does not delete the whole net:
- A wire with no branches riding on it is removed (ends are on parts, pins or labels; nothing else changes).
- A wire that carries branches (`EndRef { wire, at }`) is split at the crossing. The model has no free wire ends,
  so each side that still holds a branch is merged into its nearest branch: the trunk from its end up to the
  branch point plus the branch become one wire. A side holding no branch disappears. Result: everything on one
  side stays connected to everything else on that side, and nothing crosses the cut.
- Today's `deleteSel` cascades to the branches of a deleted wire. The cut must never do that.
- Pointers are not cut. A drag that crosses a pointer flag leaves it (pointer edits have their own menu).

**Code.**
- `editor/ops.ts`: `cutWires(doc, a: Vec, b: Vec, defOf): Edited`. It is pure: crossings from the polylines
  (`polyline`), each wire split as above. Points are snapped to the half grid as `dragSegment` does.
- `editor/geom.ts`: `segmentCrossings(poly, a, b)`. It returns the crossing points per wire. A drag that only
  touches the end of a wire (on a pin) does not count.
- `editor/tools.ts`: a `cut` mode beside place / band. Preview: the view's hover class on every crossed wire, plus
  a dashed line. Finger: the same drag; a tap on a wire cuts it there.
- The toolbar action goes through `registerToolbarAction` with `active`. Add an entry in the `?` key sheet
  (`ui/keys.ts` KEYS) and in the search `>` actions.
- Not in level mode unless the level lists the action (EditorOptions.level).

**Tests.** `tests/editor-cut.test.ts`: a plain wire, a T junction cut on each of its three arms, a cut across a
bus with four branches, a cut through a bend, a cut that only touches a pin (nothing happens), and undo restores
the exact document. For every case, compile before and after (`compileChip`) and check that the nets split
exactly as expected (`netOfWire`).

**Done when** a cut never removes a wire on the far side and never leaves a wire end floating. The `?` sheet,
search and right-click menu list it, and it works on a phone.

---

## B. Breakpoints (ONI's pause on red alert)

**What the learner does.**
- **Sandbox:** in the Timing / probe pane or the properties of a selected wire or pin, "Stop when…" opens a row
  with a condition: `pc == 0x40`, `stall`, `count >= 12 && en`, `rose(miss)`. Run (cycle or gate mode), Step ×n,
  `runCycles` and the CPU drawer's Run to halt stop on the step where it holds. The run bar says
  "Stopped: `pc == 0x40` at cycle 1 284". The nets involved light up, and Back works as usual.
- **CPU drawer and the chapters' CPU panel:** click the gutter of a listing line for a PC breakpoint (stop when
  that instruction retires). A second click removes it, and right-click adds a condition.
- A list of breakpoints with enable boxes and hit counts. Breakpoints are kept per chip, in `ChipDoc` next to
  `tests` (outside the compile hash, like tests and comments). They are not stored in chapter scenes.

**Conditions.** Names resolve like probes (`editor/probes.ts` ProbeTarget: pin, pointer, wire name, `part.port`
path), then to flat nets on each build. The expression syntax is a small subset: `== != < <= > >=`, `& | ^ ~`,
`&& || !`, numbers in any radix, bit selects `x[3]` / `x[7:4]`, plus `rose(x)` / `fell(x)` / `changed(x)` (against
the value at the previous check). Evaluated with BigInt (pins are up to 1024 bits). First check whether
`editor/fsmd.ts` parseExpr / parseTest or `lib/boolexpr.ts` already parse enough to reuse. If they don't, write a
small parser in `editor/breakexpr.ts` (DOM-free, its own tests). X: a comparison involving X is false, shown as
"unknown" in the list.

**When it is checked.**
- Cycle granularity: after every rising edge (`EditorSim.edgeHooks` `after`; `stage.edgeHooks` for the CPU
  panel). This works on the cycle engine and on GateSim.
- Gate granularity, an option per breakpoint, gate mode only: on every change of its nets (`GateSim.watch()` /
  `onTrace`). The run then stops mid-cycle at that time. Like the analyzer, this pins DualSim to GateSim while it
  is set; the row says so.
- Stopping reuses the halt part's path in `runtime.ts` (Run / runCycles already stop "after the step where they
  read 1"). Generalize it into `stopWhen: (() => string | null)[]`; the halt part becomes one entry.
  `FrameBudget` loops check the list once per step, not per frame.

**Cost.** One evaluation per edge per enabled breakpoint, which is negligible next to a settle. Gate-granularity
breakpoints only cost while set.

**Tests.** `tests/breakexpr.test.ts` (the parser: radixes, slices, X, rose/fell). `tests/breakpoints.test.ts`:
the counter example stops at the right count in cycle and gate mode. The sandbox computer stops on
`pc == <addr of a label>` at the same cycle as the golden model reaches it, and Back from the stop restores the
state before it. CPU drawer: a gutter breakpoint on a loop body hits once per iteration.

**Done when** Run, Step ×n, Run to halt and the chapters' CPU panel all stop on the same cycle for the same
condition, and the reason and nets are shown.

---

## C. Overlay bar (ONI's overlays)

**Mockup first.** This is a new visual mode on every stage and in the sandbox. Show an HTML mockup (light + dark,
a CPU top and a small adder, desktop and phone) and get approval before building.

**What the learner sees.** A row of overlay buttons in the stage bar and in the sandbox's run bar, plus a key
(`O` cycles through them, `Shift+O` turns them off). One overlay at a time. Everything else fades to the
`.plumbing`-style 45 % (as the slack heatmap does now), and a legend with numbers sits in the corner. Overlays:

| Overlay | Colours | Data (exists) |
|---|---|---|
| Slack | today's heatmap | `sim/slack.ts` slackHeat, unchanged, moved into the bar |
| Activity | toggles per net over the last N cycles, wire thickness or hue | `GateSim.countToggles()` |
| Energy | switched C·V² per instance, from the driving child | `power.ts` PowerMeter.breakdown(node), measurePower when idle |
| Load | fan-out / load per net, hot above the buffer threshold | `techcount.ts` fanInfo, `delay.ts` netLoads / heavyNets |
| Unknown | nets at X, plus where they came from (uninitialized storage) | live values; X sources from `clusters.ts` storage |
| Clock | the clock net(s) only, everything else faded | `cyclesim.ts` clock groups / `clusters.ts` chainRoot |

Energy and Activity need toggle counts, which the cycle engine does not keep. While one of them is on, DualSim
runs on GateSim (as the open Timing panel does now), and the button's tooltip says so. On large scenes
(`Scene.engine: 'cycle'`) they are disabled, with a reason. Unknown, Load, Slack and Clock work on any engine.
On a switch-level scene, only Unknown and Load apply.

**Code.**
- `view/overlays.ts` (DOM-free core): `OverlayKind`, and per kind `compute(design, sim, path) → Map<instance |
  net, band 0…4> + legend`. Banding is shared, so it is the same five tokens for every overlay.
- Rendering generalizes `data-slack` into `data-ov` (band) on instances and wires, plus `svg.schematic.ov-<kind>`.
  The `--ov-0…4` tokens are defined for both themes and the dark board (`svg.schematic` in the dark token blocks,
  as vivid.css requires). Bands carry a text value in the tooltip and legend, so colour is never the only cue.
- `SchematicView` and `EditorView` both take `overlay(kind | null)`. The sandbox's `editor/analysis.ts` slack
  toggle moves into the bar. The Timing panels keep their heat toggle as a shortcut to the same state.
- settings: `overlay` (last used, not auto-on at load). It is not part of the look presets.
- Drill levels: values are per instance of the open level (`slackAt`-style mapping through `HierNode`).

**Tests.** The DOM-free compute for each kind runs on a 4-bit adder, a counter and the single-cycle CPU, with
bands checked against hand-computed values (Activity on a counter: bit i toggles 2^(N−i) times). Layout: the
legend does not cover the stage's corner buttons (smoke at 1280 / 390 px). Smoke: every route with each overlay
on, with no errors.

**Done when** each overlay is one click away on any chapter stage and in the sandbox, and has a legend with units.
Each must read correctly in light and dark, vivid and plain, and on a phone.

---

## D. Fault brush (ONI's sandbox tools)

**What the learner does.** In the sandbox, the fault brush (Timing ▾ Fault brush, or `B` for break: Shift F already flips,
as tests/keys.test.ts pins): click a wire, pointer or
a pin and pick **stuck at 0**, **stuck at 1**, **flip once** (a stored bit: a flip-flop's output or a register
bit inside a look-inside view) or **slow** (+k gate delays). A faulted net gets a lightning badge, and a "Faults"
list shows them all with enable boxes. Clear all. Faults are volatile: saved with the chip, never compiled into
it, and shown in the props and lint so a chip is never silently broken.

Pairs well with B ("stop when the output differs from the golden model") and the ECC chapter (flip a bit in a
SEC-DED word, watch it be corrected). Later, bug-hunt levels could plant faults this way instead of in a
hand-edited chip.

**Where faults are applied.** All of this works on the flattened design, so every engine sees the same faults:
- **Stuck-at** is a rewrite after `flatten`: a fresh constant net, and every leaf input reading the faulted net
  gets it instead. Copy the affected input arrays: the flattener shares them, so never mutate one in place. The
  original driver still drives its net (`design.stuckTo` maps it to the constant: the sandbox draws the wire,
  its value pill and probe lanes as the readers see it; Why? still traces the driver). GateSim, CycleSim and BitSim need no change. It is part of `simKey`, so toggling
  one rebuilds the simulation with state carried (`carry.ts`).
- **Flip once** writes state, with no rebuild (as built): `flipBits` forces the clicked nets to their inverse
  (GateSim.forceNets, on DualSim through GateSim), settles, evaluates their drivers again and settles once more. A
  bit a loop stores keeps the flip; a net a gate computes goes back, and the toast says which. Big memories flip a
  word bit through `Sim.poke` on the leaf state (the Faults list). The sandbox has no Back history, so a flip is
  not undone (the next write or Reset moves on); the chapters' stage, which has Back, does not have the brush.
- **Slow** needs a per-leaf extra delay in GateSim (today it uses unit delay). Add an optional `extraDelay`
  typed array, with the transport-delay event queue unchanged otherwise. CycleSim ignores timing, so a slow fault
  pins DualSim to GateSim (`whyNot`: "a slow fault is set"). Static timing (`timing.ts`, `editor/sta.ts`) adds
  the delay too, so the critical path and the slack overlay show it.

**Code.** `sim/faults.ts` (DOM-free: `Fault`, `applyFaults(design, faults)`, the flip helper). Faults are kept on
`ChipDoc` (outside the compile hash) and mapped by ProbeTarget, so they survive rebuilds. Also
`editor/faultui.ts` (plugin: tool, badges, list, props section) and a `gatesim.ts` extraDelay.

**Tests.** `tests/faults.test.ts`:
- Stuck-at on a 4-bit adder's carry gives the expected wrong sums, the same on GateSim, CycleSim and BitSim.
- A flip on a counter's bit 2 changes the count by 4 and nothing else.
- A slow fault on the critical path raises the STA period by k and makes a fixed-period `runUntil` capture the
  wrong value.
- Clearing every fault restores the exact healthy simulation, and `npm test` stays green with no faults set
  (the rewrite is the identity).

**Done when** the three fault kinds show identical results on every engine they apply to and are always visible
(badge, list, lint). Clearing all faults must give back the healthy circuit bit for bit.

---

## Decisions (author, 2026-11-09)

1. A: a cut through a branched trunk **splits it and keeps both sides** (each side merged into its nearest
   branch), as described above.
2. B: breakpoints go in the **sandbox and the CPU panels** (the sandbox's CPU drawer and the chapters' CPU panel).
   Other chapter stages are left out for now.
3. C: the first version has **Slack, Activity, Load and Unknown**. Energy and Clock come in a second round.
   Mockup first.
4. D: faults go in the **sandbox and a campaign "break it" mode**. A level can plant faults (`sim/faults.ts`
   entries in the level's BuildChallenge) for the learner to locate. The learner answers by naming the faulty
   net, or by pointing at it with the fault tool's pick, and the answer is checked against the planted fault.
   This builds on the bug-hunt levels (13 fix-the-fault levels): the faults move out of hand-edited reference
   chips into planted entries. It needs its own short design (UI of the answer, grading, which levels) before
   it is built, after the sandbox brush ships.

---

## D2. "Break it": the campaign's fault-finding mode (design, for the author's approval; not built)

**What it is.** An optional kind of level, `kind: 'locate'`, placed like a bug hunt after the level whose block it
breaks. The learner gets that level's own reference answer, drawn as in a bug hunt (docFromDef, same part names),
with one fault planted as a `sim/faults.ts` entry, not as a wiring edit: the drawing is right, the circuit
misbehaves. The task is to find *where*, not to fix it. Bug hunts stay as they are (find and repair a wiring
mistake, graded on edits); "break it" is the other half of debugging: a manufacturing defect in a correct design,
as a chip tester sees it.

**What is planted.** `BuildChallenge.planted: FaultDoc[]` (usually one; a later level two), held outside the
learner's chip: the level's simulation applies it the way EditorSim applies `ChipDoc.faults`, but the badge, the
Faults list and the diagnostics never show it. Kinds: stuck at 0 / 1 on a net or one bit of a bus, and slow on
one gate (then the level runs at a fixed clock period and the symptom is a wrong capture). Flip once is not a
planted fault: it leaves no trace to find afterwards.

**The answer UI.** The level's strip gains an **Accuse** button (and `B` on a level chip turns the fault brush
into an accuse brush). With it, a click on a wire, pointer or pin, or on a net inside a look-inside view, opens
the same picker as the brush, with its rows reading "It is stuck at 0 here", "It is stuck at 1 here", "This gate
is slow" (a bus offers its bits). The pick is the answer. Before accusing, the learner may test hypotheses with
the ordinary fault brush on their own copy: planting their guess and seeing whether the symptoms match is the
skill being taught. Their own faults are theirs (shown, listed); the planted one never is.

**Grading.** An accusation is right when its flat nets (resolved as faults are, `resolveProbe`) contain the
planted net and the kind matches. Equivalent faults count as right: a stuck-at on a net with one reader is the
same fault as a stuck-at on that reader's input, and a fault behind an inverter chain can be named on either side
with the value inverted. "Equivalent" is decided by simulation, not by a table: the accused fault applied to the
healthy design must fail exactly the same test vectors as the planted one (Check's vectors, exhaustive up to 12
input bits as today, else the level's sequence). A wrong accusation says which vectors tell the two apart (the
first one, played in the test player) and costs a star. Stars: ★ found, ★★ found within 3 accusations, ★★★ found
with no wrong accusation and at most `par` probes (probes placed, counted by the analysis plugin). No edit count:
nothing is repaired.

**Which levels.** Start with four, each one a different way to look:
1. after `a_add4` (the 4-bit adder): a carry stuck at 0 in bit 2. Read the truth table's failing rows; the
   pattern (only sums that carry through bit 2 are wrong) names the net.
2. after `g_dec` (the decoder): one output bit stuck at 1. Two outputs high at once; a probe on each output
   finds it.
3. after `s_cnt4` (the counter): a stuck-at 0 on a flip-flop's D. A sequence test: the count skips; the timing
   panel shows which bit never rises.
4. after `c_core3` (the RV16 single-cycle core): one bit of the ALU's B operand stuck at 1. The CPU bench's first
   mismatch against the golden model points at an instruction; Why? and the drill-down find the bit.
A fifth, after the pipelined core, with a slow gate on the forwarding path, comes once B (breakpoints) gives a
"stop at the first mismatch".

**Code (when approved).** `campaign/locate.ts` (the hunts as data: `after`, `planted`, `par`, report text);
`BuildChallenge.planted` applied in `checkChallenge` and the level screen's EditorSim (a hidden `FaultState`
next to the visible one); `editor/faultui.ts` gains an accuse mode used by `challengeui.ts`; the equivalence check
in `sim/faults.ts` (`sameSymptoms(design, a, b, vectors)`) with tests: each planted fault and its equivalents are
accepted, a neighbouring net is rejected with a distinguishing vector.

**Open for the author.** (1) Whether a wrong accusation should cost a star or only show the distinguishing vector.
(2) Whether these sit beside the bug hunts on the map (folded into one "Debugging" header) or after each level.
