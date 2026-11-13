# The campaign

## What it is for

The campaign is a game of levels. Each level asks you to build one block of a processor from the blocks you have
already built, and then checks your circuit against a test set. You start from transistors and a NAND gate and finish
with a pipelined 16-bit RISC-V processor with traps and interrupts. Optional acts go further: relays and vacuum tubes,
arithmetic units, a GPU, memory, links and signal processing.

Choose the campaign when you want to **build** rather than read. The journey (the chapters) explains each idea with
a finished circuit you can open and probe; the campaign hands you the empty chip and the pins and lets you find the
circuit yourself, with grades for how cheap and how fast it is. The workbench is for looking up one part, and the
sandbox is a free editor with no task. You can use the campaign without reading the chapters: every level has its
own explanation, tips and an answer.

## Quick start: your first level

You will read the first lesson and then build a CMOS inverter from two transistors. Expect Check to fail first:
that is how you see what the level wants.

1. On the home page, click **Play the campaign**.

   ![The home page with the Play the campaign button below Where are you starting?](img/campaign/01-home.png)

2. The campaign map opens. Each box is a level; the acts run from top to bottom. On the right, under **Start here**,
   click **Begin: Anatomy of a CPU**.

   ![The campaign map: act 0 at the top, the Start here panel on the right](img/campaign/02-map.png)

3. The right-hand panel shows the lesson *Anatomy of a CPU*: what a processor is made of and why the levels come in
   this order. Read it, then click **Done reading** at the bottom of the panel. The lesson's box on the map turns
   green (solved) and the next level, **CMOS inverter**, becomes available.

   ![The lesson panel with the Done reading and The full diagram buttons](img/campaign/03-lesson.png)

4. Click **CMOS inverter** on the map. The panel now shows why you need this block, which later levels it goes into,
   the problem it solves and what it costs. Click **Play**.

   ![The CMOS inverter level selected on the map, with Play, Show answer and Skip at the bottom of the panel](img/campaign/04-level-card.png)

5. The level screen opens. On the left are the level's tabs (**Why**, **Task**, **Tips**, **Codex**); in the middle,
   the parts you may use; on the right, the chip you are building, with its input pin **a** on the left and its
   output pin **y** on the right. The **Task** tab says what to build: y = not a, from one PMOS and one NMOS.

   ![The level screen: tabs on the left, the parts list, the canvas with pins a and y, Check below it](img/campaign/05-level-screen.png)

6. Click **Check** under the canvas before building anything. The result reads **Not yet**, and the test player
   opens below with the level's test cases: each row shows the inputs, and a red ✕ with the value it wanted where
   your circuit is wrong. Here both rows fail, because nothing drives y yet. Close the player with the **✕** at its
   right edge.

   ![Check says Not yet, 2 of 2 rows wrong; the test player lists both test rows with red crosses](img/campaign/06-check-fails.png)

7. Place the parts. Click **VDD** in the parts list, then click on the canvas near the top. Do the same for
   **PMOS** (below VDD), **NMOS** (below the PMOS) and **GND** (at the bottom). Each click on the canvas places one
   part; it is drawn selected, with dots on its connection points.

   ![VDD and a PMOS placed on the canvas, the PMOS selected with its three connection dots](img/campaign/07-place-part.png)

8. Wire it. Press on a connection dot and drag to another, then let go: a wire appears.
   - VDD to the PMOS's top (source),
   - the PMOS's bottom (drain) to the NMOS's top (drain),
   - the NMOS's bottom (source) to GND,
   - pin **a** to the NMOS's gate (its left side), and the PMOS's gate to pin **a** as well,
   - pin **y** to the NMOS's top (drain), where the two drains meet.

   The wires show their values as you build: a wire at 1 glows, a wire at 0 is dark. Click the **a** switch under the
   canvas (under **INPUTS**) to try both values; y should always be the opposite of a.

   ![The finished inverter: a drives both gates, the drains meet at y; a is 1 and y is 0](img/campaign/08-wired.png)

9. Click **Check** again. This time it reads **Passes**, and a card shows your grade: three stars, because you used
   2 transistors and the par is 2. The card compares your circuit with another way of building the block, lists the
   levels now within reach, and names the codex entries you have unlocked.

   ![Passed at par: three stars, Transistors 2 against par 2, Now within reach: CMOS NAND](img/campaign/09-passed.png)

10. Click **Back to the map**. The inverter's box now shows its stars, and **CMOS NAND** is available. Click
    **Next: CMOS NAND** on the card instead to go straight to the next level.

    ![The map after the first level: Anatomy of a CPU solved, CMOS inverter with three stars, CMOS NAND available](img/campaign/10-map-after.png)

Your circuit and your progress are saved in this browser as you go. To carry them to another computer, see
[Move your progress to another computer](#move-your-progress-to-another-computer).
