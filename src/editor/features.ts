// The editor's feature modules, which register themselves (palette groups, property sections,
// toolbar actions, plugins) when imported. Every page that hosts an Editor imports this once:
// the sandbox and the campaign's level screen.

import './memui';
// Chip packaging, inspector, and their property sections.
import './package';
import './inspect';
import './chipprops';
// The canvas's right-click menu.
import './ctxmenu';
// The pins as a bar of switches and lamps above the run bar.
import './iobar';
// Keyboard keys driving key and keyboard parts.
import './keys';
// The analysis tools plug into every editor (probes, timing, lint).
import './analysis';
// Test tables on a chip (Digital's test syntax), run after every edit.
import './testsui';
// The CPU panel: program, registers, memory and the golden model for a chip that is a processor.
import './cpuui';
// Consoles, switch banks and screens: their property sections and the Screens drawer.
import './ioui';
// The card reader's properties and deck files (also dropped on the canvas).
import './cardui';
// Program puzzles: the Puzzles drawer, the start dialog and the strip while a puzzle chip is open.
import './puzzleui';
// Verilog chips: the text beside the canvas, Yosys in the page, .v / Yosys JSON import.
import './hdlui';
// Truth-table chips: the table beside the canvas, the minimized logic drawn.
import './tableui';
// State-machine chips: the diagram beside the canvas, the circuit built from it.
import './fsmchipui';
// The editor's actions in the search box (`>`).
import './searchactions';
