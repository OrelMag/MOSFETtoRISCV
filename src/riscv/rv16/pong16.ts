// Pong for the campaign's RV16 cores, on the core bench's screen (campaign/bench.ts with io): the sandbox
// computer's Pong (riscv/ioprograms.ts PONG) rewritten for eight registers, word addresses, six-bit
// immediates and branches that reach 31 words. The game's state lives in the bench's RAM (words 0–8,
// reached as imm(zero)), sp holds the screen's base for good. No DOM.

/** Where the game keeps its state in the bench's RAM (word addresses; tests and the drawer read them). */
export const PONG16_RAM = { ballX: 0, ballY: 1, dx: 2, dy: 3, left: 4, right: 5, score: 6, frames: 7, games: 8 } as const;

/** Points that win a game. */
export const PONG16_WIN = 5;

/**
 * Pong on the 32 × 32 screen at SCREEN16_IO (0xF000 + 32·y + x, RGB565): the left paddle is the player's (switch 7
 * up, switch 6 down), the right one the computer's, which only moves once the ball comes its way past column 20, so a
 * steep ball beats it; switch 4 on hands it to a second player (switch 1 up, 0 down). A miss scores for the other
 * side: the LEDs hold the score (the left player's in bits 7–4) and the ball is served again towards the side that
 * missed; five points end the game, count it and start a new one. Never halts.
 */
export const PONG16 = `# Pong on the bench's 32 x 32 screen (pixel (x, y) at 0xF000 + 32*y + x).
# Your paddle is on the left (switch 7 up, switch 6 down), the computer's on
# the right; switch 4 on gives it to a second player (switch 1 up, switch 0
# down). The LEDs keep the score, yours in bits 7-4; five points win a game.
# RAM: 0 ball x, 1 ball y, 2 its step across (+-1), 3 its step down (-2..2),
# 4 left paddle's top, 5 right paddle's top, 6 score, 7 frames, 8 games
        lui  sp, 960            # sp = 0xF000: the screen, for good
        sw   zero, 6(zero)      # score
        sw   zero, -5(zero)     # LEDs (0xFFFB)
        li   t0, -1             # first serve: towards you
        sw   t0, 2(zero)
serve:  li   a1, 13             # both paddles in the middle
        sw   a1, 4(zero)
        sw   a1, 5(zero)
        li   a0, 1
        call paddle
        li   a0, 30
        call paddle
        li   t0, 15             # the ball in the middle column
        sw   t0, 0(zero)
        lw   t0, 7(zero)        # at a height the frame count picks: 8 + frames mod 16
        slli t1, t0, 12
        srli t1, t1, 12
        addi t1, t1, 8
        sw   t1, 1(zero)
        slli t0, t0, 11         # up or down: bit 4 of the frame count
        srli t0, t0, 15
        add  t0, t0, t0
        addi t0, t0, -1
        sw   t0, 3(zero)
frame:  li   a0, 0              # erase the ball
        call ball
        lw   t1, -6(zero)       # the left paddle: switch 7 up, switch 6 down (0xFFFA)
        srli t0, t1, 7
        slli t1, t1, 9
        srli t1, t1, 15
        sub  a2, t1, t0
        li   a0, 1
        lw   a1, 4(zero)
        call step
        sw   a1, 4(zero)
        lw   t1, -6(zero)       # the right paddle: a second player on switch 4
        slli t0, t1, 11
        srli t0, t0, 15
        beqz t0, cpu
        slli t0, t1, 14         # switch 1 up
        srli t0, t0, 15
        slli t1, t1, 15         # switch 0 down
        srli t1, t1, 15
        sub  a2, t1, t0
        j    right
cpu:    li   a2, 0              # the computer waits for the ball to come its way
        lw   t0, 2(zero)        # past column 20, then aims its middle at it
        blez t0, right
        lw   t0, 0(zero)
        li   t1, 20
        blt  t0, t1, right
        lw   t0, 1(zero)
        addi t0, t0, -2
        lw   t1, 5(zero)
        beq  t0, t1, right
        li   a2, 1
        bgt  t0, t1, right
        li   a2, -1
right:  li   a0, 30
        lw   a1, 5(zero)
        call step
        sw   a1, 5(zero)
        lw   t0, 7(zero)        # frames
        addi t0, t0, 1
        sw   t0, 7(zero)
        lw   t0, 0(zero)        # move the ball
        lw   t1, 2(zero)
        add  t0, t0, t1
        sw   t0, 0(zero)
        lw   a0, 1(zero)
        lw   t1, 3(zero)
        add  a0, a0, t1
        bgez a0, ny0            # off the top: y = -y
        neg  a0, a0
        neg  t1, t1
ny0:    li   t0, 31             # off the bottom: y = 62 - y
        bge  t0, a0, ny1
        li   t0, 62
        sub  a0, t0, a0
        neg  t1, t1
ny1:    sw   a0, 1(zero)
        sw   t1, 3(zero)
        lw   t0, 0(zero)
        li   t1, 2              # at the left paddle's column?
        bne  t0, t1, nl
        lw   a1, 4(zero)
        call hit
        li   t0, 1              # off it: to the right
        j    bounce
nl:     li   t1, 29             # at the right paddle's?
        bne  t0, t1, nr
        lw   a1, 5(zero)
        call hit
        li   t0, -1
bounce: beqz a0, nr             # missed it
        sw   t0, 2(zero)
        sw   a0, 3(zero)
nr:     lw   t0, 0(zero)        # past a paddle: a point
        li   t1, 1
        beq  t0, t1, lost
        li   t1, 30
        beq  t0, t1, won
        li   a0, -32            # the ball, yellow (0xFFE0)
        call ball
        li   t0, 60             # wait a little
wait:   addi t0, t0, -1
        bnez t0, wait
        j    frame
lost:   lw   t0, 6(zero)        # the computer scores
        addi t0, t0, 1
        j    score
won:    lw   t0, 6(zero)        # you score
        addi t0, t0, 16
score:  slli t1, t0, 12         # five points win a game: a new one
        srli t1, t1, 12
        li   a0, 5
        beq  t1, a0, game
        srli t1, t0, 4
        bne  t1, a0, shown
game:   lw   t1, 8(zero)        # games played
        addi t1, t1, 1
        sw   t1, 8(zero)
        li   t0, 0
shown:  sw   t0, 6(zero)
        sw   t0, -5(zero)       # the LEDs
        j    serve

# paddle: column a0 white from row a1 for 6 rows, black elsewhere
paddle: add  t0, sp, a0         # (x, 0)
        li   t1, 0              # y
pl:     sub  a2, t1, a1         # the row from the paddle's top: 0..5 white
        bltz a2, pb
        addi a2, a2, -6
        bgez a2, pb
        li   a2, -1             # white (0xFFFF)
        j    pp
pb:     li   a2, 0
pp:     sw   a2, 0(t0)
        addi t0, t0, 31         # the next row: + 32
        addi t0, t0, 1
        addi t1, t1, 1
        li   a2, 32
        bne  t1, a2, pl
        ret

# step: the paddle in column a0 with its top at a1 moves by a2 (-1, 0, 1),
# staying on the screen: one row painted, one erased. Returns the top in a1.
step:   beqz a2, sret
        add  t1, a1, a2         # the new top
        bltz t1, sret
        li   t0, 26             # 32 - 6
        blt  t0, t1, sret
        bgtz a2, sdown
        slli t0, t1, 5          # up: the new top row white
        add  t0, t0, a0
        add  t0, t0, sp
        li   a2, -1
        sw   a2, 0(t0)
        addi t0, a1, 5          # and the old bottom row black
        slli t0, t0, 5
        add  t0, t0, a0
        add  t0, t0, sp
        sw   zero, 0(t0)
        mv   a1, t1
        ret
sdown:  slli t0, a1, 5          # down: the old top row black
        add  t0, t0, a0
        add  t0, t0, sp
        sw   zero, 0(t0)
        addi t0, t1, 5          # and the new bottom row white
        slli t0, t0, 5
        add  t0, t0, a0
        add  t0, t0, sp
        li   a2, -1
        sw   a2, 0(t0)
        mv   a1, t1
sret:   ret

# hit: does the ball meet the paddle with its top at a1? a0 = 0: no; else the
# ball's new step down, by where it struck: -2 off the top row, -1 off rows 1
# and 2, 1 off rows 3 and 4, 2 off the bottom row
hit:    lw   t0, 1(zero)
        sub  t0, t0, a1
        li   a0, 0
        bltz t0, hret
        li   t1, 5
        blt  t1, t0, hret
        li   a0, -2
        beqz t0, hret
        li   a0, -1
        li   t1, 3
        blt  t0, t1, hret
        li   a0, 1
        li   t1, 5
        blt  t0, t1, hret
        li   a0, 2
hret:   ret

# ball: the pixel at (ball x, ball y) in colour a0
ball:   lw   t0, 1(zero)
        slli t0, t0, 5
        lw   t1, 0(zero)
        add  t0, t0, t1
        add  t0, t0, sp
        sw   a0, 0(t0)
        ret
`;
