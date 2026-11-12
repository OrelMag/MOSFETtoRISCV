# Placing and wiring in the sandbox by keyboard

> **Historical (2026-11-12).** Built: see docs/ROADMAP.md, Phase 23, Cross-cutting features. Kept as the record of the decisions; its future tense is
> as of the plan, and any mockup link in it is the author's private draft.

Roadmap: Phase 23 / Cross-cutting, "a part cursor on the stage …, then placing and wiring in the sandbox by keyboard".
The stage half is feat/key-cursor (batch 6). This is the sandbox half.

## What is there already (main at 48736b0a)

Most of it. A learner can already build a half adder without the mouse:

| Task | Keys today |
|---|---|
| Pick a part | Tab to the parts list, ↑ ↓ or type a name, ↵ arms it and moves to the canvas with the cursor on; `1`–`9` favourites; Ctrl K / `/` search lists every part |
| Place it | arrows (Alt arrows when something is selected) move the cursor, Shift ×5; ↵ or Space places; Shift ↵ keeps it armed; F / R flip and turn it first |
| Move it | ↵ on it selects; arrows nudge (Shift ×5); `[` `]` jump between parts (batch 6) |
| Start a wire | W from the pin under the cursor, else the selected part's first pin; N / Shift N step through pins |
| Route it | arrows; ↵ on empty grid adds a bend; Space or `/` flips the L; Backspace removes the last bend |
| End it | N steps to the next pin that can connect, ↵ connects (also ↵ on a wire: a junction); Esc cancels |
| Then | ↵ on an input toggles it; Ctrl ↵ runs; `.` steps (batch 6) |

## The gaps (found by reading tools.ts / editor.ts; to be confirmed in the browser before building)

1. **A part armed from the search or a favourite digit leaves the cursor off.** Only a pick from the parts list
   turns the keyboard cursor on and focuses the canvas (editor.ts armPart `fromList`). From Ctrl K or `1`–`9`, the
   toast says "click the canvas", and with the focus on the page the arrows do nothing until the learner finds the
   canvas. Fix: arm by key (the search's row picked with ↵, a digit) does what the list does: cursor on at its last
   place (else the view's centre), canvas focused, the same toast ("arrows move, ↵ places, Esc cancels"). A mouse
   pick in the search stays as it is.
2. **W cannot start a branch from a wire.** wireFromKeyboard refuses a wire under the cursor (`!('wire' in t.end)`),
   so a fan-out (one input to two gates) needs the mouse or a second wire from the far pin. Fix: W on a wire starts
   at its branch point (the mouse already does this: tools.ts target → `{ wire, at }`).
3. **The cursor is silent?** No: checked in the code, kcSet already says what is under the cursor after every move (a polite, atomic live region; once per move, never while it stays still). Nothing to build.
4. **N while wiring skips wires.** Ending on a wire works with ↵, but N only steps pins. Leave it: arrows reach any
   wire, and the cursor says when it is on one. (Listed so it is a decision, not an oversight.)

## Keys

No new key. Each fix rides a key that already means the same thing (W wire, ↵ act, the cursor's arrows), so:

- nothing new to learn, nothing new in `?`; the sheet's wording grows by a few words: sb.wirekey "… from the pin or
  wire under the cursor …", sb.fav "… (the keyboard cursor comes on)";
- no clash with K cut, B fault brush, O overlay, F9 breakpoints, `[ ] . + − 0` (batch 6) or the stage's keys
  (another page);
- the single-key switch: W and the digits already obey it; with single keys off, the menu key's "Start a wire
  from …" and the parts list remain, as today.

## Tests

- The editor's key handling needs the page (no test here builds an Editor: the repo has no DOM environment), so the
  check is a browser drive (CDP, as for the cut tool): a keyboard-only half adder from an empty chip. Parts armed from
  the search (↵) and by a favourite's digit, placed with ↵; a fan-out from each input by W on its wire; the inputs
  toggled; s and c read from the announcements; the chip compiled and its truth table checked from the page.

## Cost

tools.ts (W and the menu take a wire; a digit arms through armPart), editor.ts (armPart: armed by a key, read from the
event being handled, so the search needs no change), ui/keys.ts (two descriptions). Editor core: full gate on a runner.
