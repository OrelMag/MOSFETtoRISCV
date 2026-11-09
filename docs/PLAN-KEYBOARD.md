# Placing and wiring in the sandbox by keyboard

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
3. **The cursor is silent.** Arrows move it with no word for a screen reader, so a blind learner cannot tell when it
   reaches a pin. Fix: after the cursor stops (250 ms), announce what is under it when something is: "pin a of x
   (XOR)", "wire a → x.a, n.a", "part x (XOR)"; nothing on empty grid (it would chatter). The same words as the menu
   and ↵ use (hitName / endName).
4. **N while wiring skips wires.** Ending on a wire works with ↵, but N only steps pins. Leave it: arrows reach any
   wire, and gap 3 says when the cursor is on one. (Listed so it is a decision, not an oversight.)

## Keys

No new key. Each fix rides a key that already means the same thing (W wire, ↵ act, the cursor's arrows), so:

- nothing new to learn, nothing new in `?`; the sheet's wording grows by a few words: sb.wirekey "… from the pin or
  wire under the cursor …", sb.fav "… (the keyboard cursor comes on)";
- no clash with K cut, B fault brush, O overlay, F9 breakpoints, `[ ] . + − 0` (batch 6) or the stage's keys
  (another page);
- the single-key switch: W and the digits already obey it; with single keys off, the menu key's "Start a wire
  from …" and the parts list remain, as today.

## Tests

- tests/editor-keys.test.ts (jsdom, as the existing key tests): a digit arms with the cursor on and focus on the
  canvas; W on a wire's interior starts a draft from `{ wire, at }` and ↵ on a pin makes a junction (compileChip:
  the three ends on one net); the announcement after a cursor move names the pin.
- A keyboard-only half adder in the browser (CDP drive, as for the cut tool): two inputs, XOR, AND, two outputs,
  a fan-out from each input by W on a wire, toggle the inputs, read s and c from the announcements.

## Cost

tools.ts, editor.ts (armPart: a `byKey` flag), searchactions.ts (pass it), ui/keys.ts (two descriptions). Editor core:
full gate on a runner.
