# The sandbox

## What it is for

The sandbox is a free circuit editor. You place parts, wire them, run the circuit, and package what you built as a chip
that you can place in your next circuit, all the way up to a whole computer. Use it when you want to build something
of your own, try an idea from a chapter, or open one of the ready-made examples and take it apart. The journey explains,
the campaign sets you goals with rules, the workbench shows the library's parts one at a time; the sandbox is where you
build without rules. Everything you make is saved in your browser as you go.

## Quick start: a NAND gate as your own chip

You will place a NAND gate, wire two inputs and an output to it, try it, and package it as a chip.

1. On any page, click **Sandbox** in the top bar.

   ![The top bar: My path, Chapters, Campaign, Workbench and Sandbox](img/sandbox/01-top-bar.png)

2. You see an empty chip called **Main**: the parts list on the left, the canvas in the middle, the chip's properties on
   the right, and the run bar at the bottom.

   ![The empty sandbox: parts list, dark canvas, properties and run bar](img/sandbox/02-empty-sandbox.png)

3. In the parts list under **Basics**, click **NAND**, then click on the canvas. The gate appears where you clicked.
   (The hints on the right now say its inputs are not connected: they read X, unknown.)

   ![A NAND gate placed on the canvas](img/sandbox/03-nand-placed.png)

4. Click **Input** and click on the canvas to the left of the gate; do it again a little lower for a second input. Then
   click **Output** and click to the right of the gate. They are named **in1**, **in2** and **out1**.

   ![Two inputs, the NAND and an output on the canvas](img/sandbox/04-pins-placed.png)

5. Draw the wires: press on the right-hand edge of **in1**'s round knob and drag to the gate's top input, then release.
   Do the same from **in2** to the gate's bottom input, and from the gate's output to the left edge of **out1**'s knob.
   With both inputs at 0, the output lights up: a NAND gives 1 unless both inputs are 1.

   ![The three wires drawn; out1 is lit](img/sandbox/05-wired.png)

6. Click **in1**'s knob, then **in2**'s knob, to switch each to 1. The output goes dark: 1 NAND 1 is 0. (The same
   switches sit in the bar under the canvas, under **Inputs**.)

   ![Both inputs on, the output off](img/sandbox/06-inputs-on.png)

7. Click **Package** in the toolbar. The **Package as chip** dialog shows the box your circuit will become, with its pins
   on the edges.

   ![The Package as chip dialog: name, colour, notes and the box preview](img/sandbox/07-package-dialog.png)

8. Type a name in the **Name** box, for example *My NAND*, and click **Save & new circuit**. A message says the chip is
   in the palette under **My chips**, and a new empty chip opens in a second tab.

   ![My chips in the parts list, with My NAND](img/sandbox/09-my-chips-palette.png)

9. In the parts list under **My chips**, click **My NAND**, then click on the canvas. Your chip is now a part like any
   other, with **in1**, **in2** and **out1** on its box.

   ![The packaged chip placed in a new circuit](img/sandbox/10-chip-placed.png)

That is the whole cycle: build, try, package, reuse. Every part you place can be opened again: double-click it to look
inside (see [Look inside a part](#look-inside-a-part)).

## The screen

![The sandbox with the Computer example open and the CPU drawer on the right](img/sandbox/22-computer-cpu-drawer.png)

- **Top bar**: the site's sections, search (magnifier), the number base for bus values (**HEX**, **BIN**, **DEC**),
  view options and the theme.
- **Tabs and toolbar** (second row): your open chips as tabs, **New chip** (and the arrow beside it for other kinds of
  chip), the save state (**Saved**), **File**, undo / redo, zoom out / in, **Fit to screen**, the section tool, **Cut**,
  **I/O**, **Examples**, **Package**, **Timing**, **Tests**, **Play**, the inspector, the keys sheet (**?**) and the
  bookmark. On a narrow window the least used of these move into **More**.
- **Left**: the project switcher (**Project: Main project**), the parts search, **Purist** (only NAND and the parts
  built from it), and the parts list in groups.
- **Middle**: the canvas. A line of hints along its bottom edge names the basic gestures.
- **Right**: the properties of what is selected (or of the chip), with hints about problems at the top. Drawers such as
  **CPU**, **Memory** and **Screens** open here too, as tabs.
- **Bottom**: the **I/O** bar (the chip's inputs to switch and outputs to read), then the run bar (**Cycle** / **Gate
  delay**, **Run**, **Step**, the speed, **Reset**, the power-on state) and the overlays (**Slack**, **Activity**,
  **Load**, **Unknown**, **Cost**, **Energy**, **Depth**).

## How to …

### Place, move and delete parts

1. Click a part in the parts list, then click on the canvas. Hold **Shift** while you click to place several.
2. Or press a number key **1** to **9** (the numbers beside the **Basics** parts) to arm that part, and click or press
   **Enter** to place it.
3. Drag a part to move it. Drag on empty canvas to select several with a rubber band; **Shift** + click adds to the
   selection.
4. **Delete** or **Backspace** deletes the selection. **R** turns it a quarter turn, **F** flips it left to right.
5. Click the ☆ beside a part in the list to pin it to **Favorites** at the top of the list.

### Wire parts together

1. Press on a pin's knob (on the side its wire leaves from) or on a part's port, and drag to another port. Release on
   the target.
2. To make corners, click on empty canvas while drawing; **Backspace** removes the last corner, **Esc** cancels.
3. To branch, end a new wire on an existing wire, or **Ctrl** / **Alt** + drag from a wire.
4. Drag a wire to reshape it; double-click a corner to remove it. Right-click a wire for **Add a bend here**.
5. **Cut** (**K**) lets you drag a line across wires to cut them.

### Use pointers (named wires)

A pointer is a wire by name: every pointer with the same name is the same wire, so you can connect distant places
without drawing a long wire.

1. Press **L** (or click **Pointer** in **Basics**) and place it on a port.
2. Give it a name (**F2**), and place another pointer with the same name where the signal should arrive.
3. Click a selected pointer to jump to the next one with that name.

### Rename, undo and redo

- Select a part, pin or pointer and press **F2**, or click its name once it is selected, to rename it where it is drawn.
  The name is also in the properties on the right.
- **Ctrl Z** undoes, **Ctrl Y** or **Ctrl Shift Z** redoes (or the arrows in the toolbar). A drag is one step.

### Use the right-click menu

Right-click a part, a wire or empty canvas to see what you can do with it: start a wire from a pin, **Rename**, **Look
inside**, **Inspect**, **Measure**, **Explain**, **Flip**, **Rotate**, **Group in a section**, **Duplicate**, **Copy**,
**Cut**, **Delete**, each with its key. On a touch screen, press and hold.

![The right-click menu of a NAND gate](img/sandbox/16-part-menu.png)

### Pins and buses

- **Input** and **Output** are 1-bit pins. **Input bus** and **Output bus** carry several bits: pick the width on the
  part (the **8-bit ▾** tag) before placing it, or in its properties afterwards.
- Click a 1-bit input to toggle it; click a bus input to type its value.
- The **Wiring** group has splitters and mergers (for example **Split 8 → 1×8**, **Merge 8×4 → 32**) to cut a bus into
  wires or bytes and join them again. They cost nothing: they are only wiring.
- **HEX**, **BIN** and **DEC** in the top bar choose how bus values are written.

### Run a circuit

- A circuit without a clock simply follows its inputs: change an input and the outputs follow.
- A chip with a **Clock** pin runs on the run bar: **Run** starts it (or **Ctrl Enter**), **Step** (or **.**) does one
  clock cycle, the speed box sets cycles per second, **Reset** powers it on again.
- **Cycle** runs one whole clock cycle at a time (fast); **Gate delay** steps one gate delay at a time, so you can watch
  a signal travel. The box after **Reset** chooses what storage holds at power-on.
- The overlays below the run bar colour the circuit by **Slack**, **Activity**, **Load**, **Unknown** values, **Cost**,
  **Energy** or logic **Depth** (**O** cycles through them).

### Look inside a part

1. Double-click any library part (or right-click ▸ **Look inside**). Its circuit opens beside yours, with live values,
   driven by your circuit.
2. Double-click a part inside it to go one level deeper; the path is shown at the top (**INSIDE**). You can go all the
   way down to transistors.
3. **Why?** traces the selected wire's value back to what caused it. **Close** (or **Esc**) goes back.

![Looking inside a NAND: its four transistors, live](img/sandbox/17-look-inside.png)

### Package a chip and edit its face

1. Click **Package** (or **Package…** in the chip's properties).
2. Set **Name**, **Colour** and **Notes**. Untick **Show the name on the box** to hide the name.
3. In the box preview, drag a pin along an edge or onto another side; a pin dropped on another swaps with it. Drag the
   corner to resize the box. **Auto layout** puts everything back.
4. Under **Displays on the box**, tick the LEDs, digits, screens or switch banks inside the chip that should show on its
   box, then move and scale them on the preview.
5. **Save**, or **Save & new circuit** to start the next chip at once. The chip stays editable: every chip that uses it
   follows your changes.

### Start other kinds of chip

The arrow beside **New chip** offers:

![The New chip menu](img/sandbox/11-new-chip-menu.png)

- **Empty chip**: draw it from parts.
- **Verilog chip**: write it as text; it is synthesized and drawn for you.
- **Truth table**: fill in a table; the minimized logic is drawn.
- **State machine**: draw a state diagram; the circuit is built from it.
- **State machine + datapath**: states load registers, arcs test them (it starts from a GCD example).

### The parts list

The groups are **Basics**, **My chips** (once you package one), **Inputs & outputs** (pins, buttons, clocks, switches,
keys, keyboard, and under **Special I/O** the puzzle ports, card reader, counters, random source and timer), **Sources**,
**Transistors**, **Switch level** (strong and weak transistors, resistors, pull-ups, capacitors, transmission gates,
tri-state parts), **Relays and tubes**, **Constants**, **Displays**, **ASCII**, **Wiring**, **Memory**, **Processor
cores**, **Communication** and **Library** (every gate, adder, register and larger block of the site). Type in **Search…**
to find a part by name. Tick **Purist** to see only NAND and what you have built from it.

### Memory: ROM and RAM

- In **Memory**, **ROM (words)** is a lookup table written as hex words; **Program ROM (RV32)** holds a RISC-V program;
  **RAM** is read-write memory. Their size and contents are in the properties.
- To write a ROM's program, open its program editor with the **Edit…** button in the CPU drawer.
  Type assembly in **Text**; **Tiles** shows each instruction as a tile you can drag to reorder.
- **Build instruction** opens the instruction builder under the editor: pick an instruction, set its operands or click
  its bits, and see which parts of the CPU it uses. **Replace line** or **Insert below** puts it in the program.
- **Apply** writes the program into the ROM; **Save as deck** and **Load deck…** use punched-card decks.

![The program editor with the instruction builder open](img/sandbox/25-instruction-builder.png)

### Displays, keys, console, screen and switches

- **Displays** has **LED**, **LED bank**, **7-segment**, **Hex digit**, **Value**, **Buzzer** and **Halt** (stops
  **Run** when its input is 1).
- **Inputs & outputs** has **Switches** (a bank of toggles), **Key** (1 while a chosen key is held) and **Keyboard** (typed
  keys wait in order).
- **ASCII** has **Console** (prints a character at each clock edge) and **Screen** (a pixel screen you write by x, y and
  colour).
- When a chip has a console, screen or switch bank, even deep inside, the **Screens** drawer shows them all live, with
  **Clear** and **PNG**.

![The Screens drawer: the screen, the console and the switches](img/sandbox/27-screens-drawer.png)

### Open an example

1. Click **Examples** in the toolbar. The gallery is grouped into **First circuits**, **Whole computers**, **RISC-V
   widths** and **Circuit techniques**.
2. Type in **Search examples** to filter, or use the arrow keys between cards.
3. Click a card. It opens as a new chip; your own chips are untouched. Cards marked **CPU drawer** open with the CPU
   drawer.

![The Examples gallery](img/sandbox/20-examples.png)

### Run a program with the CPU drawer

When a chip holds a complete CPU and its program ROM (try **Examples** ▸ **Computer: RISC-V with a screen and a
console**), the **CPU** drawer opens on the right on a wide window (on a narrow one, click **CPU** in the toolbar).

1. **Run to halt** runs the program to its end; **Step** runs one instruction; **Slow** runs at the rate beside it.
   **Reset** starts the program over.
2. The listing marks the current instruction; click a line to light the parts it uses on the circuit. Click the dot at
   the start of a line to set a breakpoint there.
3. Under it: the instruction's fields, the registers and the memory. The drawer runs a reference model beside your
   circuit and says **matches golden model** while the two agree, or names the first difference.
4. **Edit…** opens the program editor; **Custom…** lets you add your own instructions to the core.

### The Memory and Screens drawers

The tabs at the top of the drawer area switch between **CPU**, **Memory** (the contents of every RAM and register file in
the chip, live: pick one at the top) and **Screens**. Each opens by itself on a wide window when the chip has something
to show.

![The Memory drawer: the register file and the RAM, picked at the top](img/sandbox/26-memory-drawer.png)

### Probe wires and use the timing panel

1. **Timing ▾** ▸ **Probe mode** (**P**), then click wires to record them.
2. **Timing ▾** ▸ **Timing panel** opens the recording under the canvas: each probed wire over time, with cursors. It
   records only while it is open, in **Gate delay** detail.
3. **Fault brush** (**B**) breaks a wire, so you can see what depends on it.

### Write test tables

1. Click **Tests**. A pane opens under the canvas with a table of the chip's inputs and expected outputs (it starts with
   one row whose expected values are X, unchecked).
2. Write rows in the text beside the table, in the test syntax of the Digital simulator.
3. **Fill outputs from the circuit** copies what the circuit does into the expected column. **Run all** checks every
   table; **Run on every edit** keeps checking as you change the circuit.

![The Tests pane](img/sandbox/18-tests.png)

### Challenges and puzzles

**Play ▾** ▸ **Challenges** lists circuits to build, each checked and scored: open one, build it, click **Check**. A
failing check opens the test player on the first failing case. **Play ▾** ▸ **Puzzles** lists program puzzles: write a
program for a ready-wired computer and check it against the tests.

### Sections and comments

- Select some parts and press **G** (or the section button in the toolbar) to put a titled frame around them. Drag the
  frame's border or title to move it with what is inside; double-click the title to rename it. **Delete** removes only
  the frame.
- Press **T** to place a comment: free text on the canvas, saved with the chip, never part of the circuit. Double-click
  it to edit.

### The minimap

Press **M** to show or hide the minimap at the bottom right of the canvas. It hides itself while the whole chip is in
view. Drag its frame to pan, or click to jump.

### Projects and folders

- **Project: Main project** above the parts list switches between projects: separate sets of chips. Its menu has **New
  project**, **Duplicate**, **Rename…**, **Export this project**, **Import a file as a new project** and **Delete this
  project…**. Campaign levels always open in the first project.
- In **My chips**, the folder button makes a folder; drag chips onto a folder to file them.

![The project menu](img/sandbox/15-project-menu.png)

### Export, import, share

**File ▾** has:

![The File menu](img/sandbox/12-file-menu.png)

- **Export this chip…** and **Export all chips…**: a .json file to keep or send.
- **Import…**: chips from such a file, Verilog (.v, .sv), Digital (.dig) or Logisim (.circ) circuits, or a Yosys netlist.
  You can also drop the file on the canvas.
- **Share link…**: the circuit packed into a link. Nothing is uploaded; whoever opens the link gets a copy.
- **Export Verilog**, **Export Verilog for FPGA…** (a .zip ready for a Tang Nano 9K board) and **Export for Digital
  (.dig)…**.
- **Export image (SVG)** and **Export image (PNG)**.
- **Instruction sets…** (your own instruction sets), **Memory map…** (on a chip with a bus), **Manage chips…** and
  **Delete local data…**.

## Keys and gestures

Press **?** in the sandbox for the full list. The most used:

| Key | Does |
|---|---|
| **1** … **9** | arm a part from **Basics** (**Shift**: several) |
| **L** · **T** | a pointer · a comment |
| **W** | start a wire from the pin under the cursor |
| **F2** | rename |
| **R** · **Shift R** · **F** | turn clockwise · anticlockwise · flip |
| **Del** | delete the selection |
| **Ctrl C** / **X** / **V** / **D** | copy · cut · paste · duplicate |
| **Ctrl Z** · **Ctrl Y** | undo · redo |
| **G** | group the selection in a section |
| **Ctrl Enter** · **.** | run / pause · one step |
| **P** · **K** · **B** | probe mode · cut tool · fault brush |
| **O** · **Shift O** | next overlay · overlay off |
| **M** | minimap |
| **+** · **−** · **0** | zoom in · out · fit |
| **Ctrl K** or **/** | search; type **>** for every toolbar action |

Mouse and touch: drag from a pin or port to wire; drag empty canvas to select; **Space** + drag, the middle button or two
fingers to pan; the wheel or a pinch to zoom; right-click (or press and hold on a touch screen) for a part's menu.

## If something looks wrong

- **A wire or output shows X (unknown).** An input somewhere is not connected. The hints at the top right name it: wire
  it, or tie it to **Constant 0** or **Constant 1**.
- **A wire did not connect.** Start the drag on the side of a pin's knob where its wire leaves; a drag from the far side
  moves the pin instead. Release exactly on a port: ports show as dots when you hover a part.
- **Nothing happens when I press Run.** A circuit without a **Clock** has nothing to run: it follows its inputs as you
  change them.
- **A drawer covers my circuit.** Close it with its **×**, or switch it with the tabs; **Fit to screen** (**0**) refits
  the view to the space that is left.
- **A key does nothing.** Keys go to the canvas only while you are not typing in a field; click the canvas first. A key
  that a **Key** part listens to drives that part instead while the chip is open.
- **I lost my work.** Chips are saved in this browser as you go (**Saved** in the toolbar). Use **File ▾** ▸ **Export
  all chips…** to keep a copy elsewhere, and **Ctrl Z** to undo a mistake.
