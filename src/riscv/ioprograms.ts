// Programs for the sandbox computer (editor/examples.ts computerChip): RV32I with word accesses
// only (the single-cycle core has no byte or halfword loads and stores), talking to its devices
// through the memory map:
//
//   0x0000_0000  RAM, 4K words (16 KB; the address wraps every 16 KB)
//   0x8000_0000  console: a store prints the low byte          (the ISS's IO.CONSOLE)
//   0x8000_0004  LEDs: a store sets them from the low byte      (IO.LEDS)
//   0x8000_0008  switches: a load reads them                    (IO.SWITCHES)
//   0xC000_0000  screen, 64 × 64 RGB332: the word at 0xC000_0000 + 256·y + 4·x is pixel (x, y),
//                a store sets its colour from the low byte (write only)
//
// Text goes to the console four characters per word: `print` sends the bytes of a0 from the
// lowest up, stopping at the first zero byte, so "Hell" is 0x6c6c6548.

export interface IoProgram { id: string; name: string; source: string }

/** The bytes of up to four characters as one word, the first in the low byte. */
export const packChars = (s: string): number => [...s].reduceRight((w, c) => (w * 256 + c.charCodeAt(0)) >>> 0, 0);

/** `li a0, <four characters>` and a call to print, for every four characters of s. */
const say = (s: string) => {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += 4) {
    const part = s.slice(i, i + 4);
    out.push(`        li   a0, 0x${packChars(part).toString(16).padStart(8, '0')}     # ${JSON.stringify(part)}`, '        call print');
  }
  return out.join('\n');
};

const PRINT = `# print: send the characters packed in a0 to the console, the lowest byte first,
# up to the first zero byte (a word holds four)
print:  andi t0, a0, 0xff       # the next character
        sw   t0, 0(s1)          # console
        srli a0, a0, 8
        bnez a0, print
        ret`;

const HLINE = `# hline: pixels x = a1 .. a2 - 1 of row a0 in colour a3
hline:  slli t0, a0, 8          # 256 * y: the row's address
        add  t0, t0, s0
        slli t1, a2, 2
        add  t1, t1, t0         # end: 4 * x1 into the row
        slli t2, a1, 2
        add  t0, t0, t2         # start: 4 * x0 into the row
hl:     sw   a3, 0(t0)          # one pixel
        addi t0, t0, 4
        bne  t0, t1, hl
        ret`;

export const GREETING = 'Hello from RISC-V!\n';
export const DONE_TEXT = 'Picture drawn.\n';

/** Prints a greeting, paints a gradient, a sun and a triangle in the switches' colour, then halts. */
export const PICTURE = `# A RISC-V computer: greet on the console, then paint the screen.
# Memory map: RAM 0x0000_0000, console 0x8000_0000, LEDs 0x8000_0004,
# switches 0x8000_0008, screen 0xC000_0000 + 256*y + 4*x (64 x 64, RGB332:
# rrrgggbb). Flip the switches before Run: they pick the triangle's colour.
        li   s1, 0x80000000     # devices
        li   s0, 0xC0000000     # screen
${say(GREETING)}
# background: red grows down the rows, green across, in 8 x 8 tiles
        mv   t0, s0             # pixel address
        li   t4, 0              # y
        li   t6, 64
bg:     srli t1, t4, 3          # y / 8
        slli t1, t1, 5          # as the red field (bits 7:5)
        ori  t1, t1, 1          # and a little blue
        addi t5, t0, 256        # the end of the row
tile:   sw   t1, 0(t0)          # 8 pixels of one colour
        sw   t1, 4(t0)
        sw   t1, 8(t0)
        sw   t1, 12(t0)
        sw   t1, 16(t0)
        sw   t1, 20(t0)
        sw   t1, 24(t0)
        sw   t1, 28(t0)
        addi t0, t0, 32
        addi t1, t1, 4          # green + 1 (bits 4:2)
        bne  t0, t5, tile
        addi t4, t4, 1
        bne  t4, t6, bg
# the sun: a 10 x 10 yellow square at (48, 4)
        li   a3, 0xfc           # yellow: red 7, green 7, blue 0
        li   a0, 4              # y
        li   s2, 14
sun:    li   a1, 48
        li   a2, 58
        call hline
        addi a0, a0, 1
        bne  a0, s2, sun
# the triangle: apex (32, 10), 2r + 1 pixels wide on row 10 + r, drawn
# in the switches' colour (all off: white)
        lw   a3, 8(s1)          # switches
        sw   a3, 4(s1)          # shown on the LEDs
        bnez a3, tri
        li   a3, 0xff           # white
tri:    li   a0, 10             # y
        li   s2, 54             # last row + 1
        li   s3, 32             # the apex's x
row:    addi t3, a0, -10        # r = y - 10
        srli t3, t3, 1          # half width r / 2
        sub  a1, s3, t3
        add  a2, s3, t3
        addi a2, a2, 1
        call hline
        addi a0, a0, 1
        bne  a0, s2, row
${say(DONE_TEXT)}
halt:   j    halt

${PRINT}

${HLINE}`;

/**
 * The switches paint: a 16 × 16 square in the middle of the screen takes the switches' colour
 * (and the LEDs show them) every time they change; it never halts.
 */
export const LIVE_SWITCHES = `# Live switches: the LEDs follow the switches, and the square in the
# middle of the screen repaints in their colour (RGB332) whenever they change.
        li   s1, 0x80000000     # devices
        li   s0, 0xC0000000     # screen
${say('Flip the switches.\n')}
        li   s4, -1             # last value seen: none
poll:   lw   a3, 8(s1)          # switches
        beq  a3, s4, poll       # unchanged
        mv   s4, a3
        sw   a3, 4(s1)          # LEDs
        li   a0, 24             # repaint rows 24 .. 39, x = 24 .. 39
        li   s2, 40
sq:     li   a1, 24
        li   a2, 40
        call hline
        addi a0, a0, 1
        bne  a0, s2, sq
        j    poll

${PRINT}

${HLINE}`;

/** A 2 × 2 ball bouncing off the edges of the screen, leaving a fading trail; never halts. */
export const BOUNCE = `# Bounce: a ball moves one pixel per frame and bounces off the edges;
# its old position is painted dark blue, so it leaves a trail.
        li   s1, 0x80000000     # devices
        li   s0, 0xC0000000     # screen
${say('Bounce!\n')}
        li   s2, 5              # x
        li   s3, 20             # y
        li   s4, 1              # dx
        li   s5, 1              # dy
        li   s6, 62             # the last x / y a 2 x 2 ball fits at
frame:  li   a3, 0x02           # erase: dark blue
        call ball
        add  s2, s2, s4         # move
        add  s3, s3, s5
        bnez s2, nx0            # bounce off the left / right edge
        neg  s4, s4
nx0:    bne  s2, s6, nx1
        neg  s4, s4
nx1:    bnez s3, ny0            # and off the top / bottom
        neg  s5, s5
ny0:    bne  s3, s6, ny1
        neg  s5, s5
ny1:    lw   a3, 8(s1)          # the switches choose its colour
        sw   a3, 4(s1)
        bnez a3, draw
        li   a3, 0xff           # white
draw:   call ball
        li   t0, 200            # wait a little
wait:   addi t0, t0, -1
        bnez t0, wait
        j    frame

# ball: a 2 x 2 square at (s2, s3) in colour a3
ball:   slli t0, s3, 8
        add  t0, t0, s0
        slli t1, s2, 2
        add  t0, t0, t1
        sw   a3, 0(t0)
        sw   a3, 4(t0)
        sw   a3, 256(t0)
        sw   a3, 260(t0)
        ret

${PRINT}`;

export const COMPUTER_PROGRAMS: IoProgram[] = [
  { id: 'picture', name: 'Computer: greeting and a picture', source: PICTURE },
  { id: 'liveswitches', name: 'Computer: live switches', source: LIVE_SWITCHES },
  { id: 'bounce', name: 'Computer: a bouncing ball', source: BOUNCE },
];
