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

/** Messages Pong prints when a side scores (tests read them). */
export const PONG_YOU = 'You score!\n', PONG_CPU = 'Computer scores\n', PONG_GAME = 'New game\n';

/**
 * Pong on the switches: the left paddle is the player's (switch 7 up, switch 6 down), the right one the computer's,
 * which only moves once the ball comes its way past column 40, so a steep ball beats it; switch 4 on hands it to a
 * second player (switch 1 up, 0 down). A miss scores for the other side: the LEDs hold the score (the left player's
 * in the high nibble), the console says who scored, and the ball is served again towards the side that missed; ten
 * points start a new game. Never halts.
 */
export const PONG = `# Pong: your paddle is on the left (switch 7 up, switch 6 down), the
# computer's on the right; switch 4 on gives it to a second player (switch 1
# up, switch 0 down). The LEDs keep the score, yours in the high four bits;
# ten points win, and a new game starts.
        li   s1, 0x80000000     # devices
        li   s0, 0xC0000000     # screen
${say('Pong!\n')}
        li   s7, 0              # score
        sw   s7, 4(s1)
        li   s4, -1             # first serve: towards you
serve:  li   s8, 27             # paddle tops: left, right
        li   s9, 27
        li   a0, 1
        mv   a1, s8
        call paddle
        li   a0, 62
        mv   a1, s9
        call paddle
        li   s2, 31             # the ball in the middle column
        andi t0, s6, 31         # at a height the frame count picks
        addi s3, t0, 16
        li   s5, 1
        andi t0, s6, 32
        beqz t0, frame
        li   s5, -1
frame:  li   a3, 0              # erase the ball
        call ball
        lw   t5, 8(s1)          # the left paddle: switch 7 up, switch 6 down
        srli t0, t5, 7
        andi t0, t0, 1
        srli t1, t5, 6
        andi t1, t1, 1
        sub  a2, t1, t0
        li   a0, 1
        mv   a1, s8
        call step
        mv   s8, a1
        lw   t5, 8(s1)          # the right paddle: a second player on switch 4
        andi t0, t5, 16
        beqz t0, cpu
        srli t0, t5, 1
        andi t0, t0, 1
        andi t1, t5, 1
        sub  a2, t1, t0
        j    right
cpu:    li   a2, 0              # the computer waits for the ball to come its way
        blez s4, right          # past column 40, then aims its middle at it
        li   t0, 40
        blt  s2, t0, right
        addi t0, s3, -4
        beq  t0, s9, right
        li   a2, 1
        bgt  t0, s9, right
        li   a2, -1
right:  li   a0, 62
        mv   a1, s9
        call step
        mv   s9, a1
        addi s6, s6, 1          # frames
        add  s2, s2, s4         # move the ball
        add  s3, s3, s5
        bgtz s3, ny0            # off the top: y = -y
        neg  s3, s3
        neg  s5, s5
ny0:    li   t0, 62             # and off the bottom: y = 124 - y
        blt  s3, t0, ny1
        li   t1, 124
        sub  s3, t1, s3
        neg  s5, s5
ny1:    li   t0, 2              # at the left paddle's column, moving left
        bne  s2, t0, nl
        bgtz s4, nl
        mv   a1, s8
        call hit
        beqz a0, nl
        li   s4, 1
        mv   s5, a0
nl:     li   t0, 60             # at the right paddle's, moving right
        bne  s2, t0, nr
        bltz s4, nr
        mv   a1, s9
        call hit
        beqz a0, nr
        li   s4, -1
        mv   s5, a0
nr:     beqz s2, lost           # past a paddle: a point
        li   t0, 62
        beq  s2, t0, won
        li   a3, 0xfc           # yellow
        call ball
        li   t0, 150            # wait a little
wait:   addi t0, t0, -1
        bnez t0, wait
        j    frame
lost:   addi s7, s7, 1
${say(PONG_CPU)}
        j    score
won:    addi s7, s7, 16
${say(PONG_YOU)}
score:  andi t0, s7, 15         # ten points win a game: a new one
        li   t1, 10
        beq  t0, t1, game
        srli t0, s7, 4
        bne  t0, t1, shown
game:   li   s7, 0
${say(PONG_GAME)}
shown:  sw   s7, 4(s1)
        j    serve

# paddle: column a0 white from row a1 for 10 rows, black elsewhere
paddle: slli t0, a0, 2
        add  t0, t0, s0         # (x, 0)
        li   t1, 0              # y
        addi t2, a1, 10
        li   t4, 64
pl:     li   t3, 0
        blt  t1, a1, pp
        bge  t1, t2, pp
        li   t3, 0xff
pp:     sw   t3, 0(t0)
        addi t0, t0, 256
        addi t1, t1, 1
        bne  t1, t4, pl
        ret

# step: the paddle in column a0 with its top at a1 moves by a2 (-1, 0, 1),
# staying on the screen: one row painted, one erased. Returns the top in a1.
step:   beqz a2, sret
        add  t2, a1, a2         # the new top
        bltz t2, sret
        li   t3, 54             # 64 - 10
        bgt  t2, t3, sret
        slli t4, a0, 2
        add  t4, t4, s0         # (x, 0)
        li   t6, 0xff
        bgtz a2, sdown
        slli t5, t2, 8          # up: the new top row white
        add  t5, t5, t4
        sw   t6, 0(t5)
        addi t5, a1, 9          # and the old bottom row black
        slli t5, t5, 8
        add  t5, t5, t4
        sw   zero, 0(t5)
        mv   a1, t2
        ret
sdown:  slli t5, a1, 8          # down: the old top row black
        add  t5, t5, t4
        sw   zero, 0(t5)
        addi t5, t2, 9          # and the new bottom row white
        slli t5, t5, 8
        add  t5, t5, t4
        sw   t6, 0(t5)
        mv   a1, t2
sret:   ret

# hit: does the ball (rows s3, s3 + 1) meet the paddle with its top at a1? a0 = 0: no;
# else the ball's new vertical step, by where it struck: -2 and -1 off the top part,
# 1 and 2 off the bottom part
hit:    addi t0, s3, 1
        sub  t0, t0, a1         # the ball's lower row, from the paddle's top: 0 .. 10 meet
        li   a0, 0
        bltz t0, hret
        li   t1, 10
        bgt  t0, t1, hret
        li   a0, -2
        li   t1, 2
        blt  t0, t1, hret
        li   a0, -1
        li   t1, 5
        blt  t0, t1, hret
        li   a0, 1
        li   t1, 8
        blt  t0, t1, hret
        li   a0, 2
hret:   ret

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
  { id: 'pong', name: 'Computer: Pong on the switches', source: PONG },
];
