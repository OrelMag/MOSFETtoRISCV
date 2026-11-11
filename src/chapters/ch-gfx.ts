import { groupDigits } from '../sim/numfmt';
import { BILINEAR8, LERP8, bilinearRef } from '../lib/intc';
import { BLEND332 } from '../lib/raster';
import { stats } from '../sim/stats';
import { costWidget, pipelineScene } from '../widgets/gfxpipe';
import { drawScene } from '../widgets/drawpad';
import { crt3d } from '../widgets/crt3d';
import { depthScene, displayScene, edgeWidget, gpuScene } from '../widgets/screen';
import { warpCoreScene } from '../widgets/warps';
import { CLEAR_CYCLES, Z_WALK_START } from '../gfx/raster';
import type { Stage } from '../view/stage';
import type { Chapter } from './types';
import { numOf } from './order';

const fmt = groupDigits;
const nd = (d: Parameters<typeof stats>[0]) => stats(d).nands;
/** A 256 × 256 one-byte texture with its whole mipmap chain. */
const MIP_BYTES = Array.from({ length: 9 }, (_, k) => (256 >> k) ** 2).reduce((a, b) => a + b, 0);
/** The rasterizer's clear, from go: the cycles before the walk's first test, then every 4 × 4 tile of the screen (a test and 16 pixels). */
const CLEAR = CLEAR_CYCLES + 1;
/** The screen of chapters pixels-graphics: 64 x 64 pixels, one byte each, four to a word. */
const SCREEN = { w: 64, bytesPerPixel: 1, perWord: 4 };
const FRAME_BYTES = SCREEN.w * SCREEN.w * SCREEN.bytesPerPixel;
const FRAME_WORDS = FRAME_BYTES / SCREEN.perWord;
const pct = (a: number, b: number) => `${Math.round((100 * a) / b)} %`;
/** The edge function of chapter pixels's rasterizer at p, for vertices a to b (quarter pixels). */
const edgeAt = (a: [number, number], b: [number, number], p: [number, number]) => (a[1] - b[1]) * (p[0] - a[0]) + (b[0] - a[0]) * (p[1] - a[1]);
/** A frame ends at a flip, and flips happen only at vsync: cycles rounded up to whole scan-outs. */
const P: [number, number] = [98, 102];
const snap = (cycles: number) => Math.ceil(cycles / FRAME_WORDS) * FRAME_WORDS;

/** The warp core's `halted` output: every warp has run to its end (0 from power-on). */
function halted(st: Stage): boolean {
  try { return st.value('halted') === 1; } catch { return false; }
}

export const chPixels: Chapter = {
  id: 'pixels', num: numOf('pixels'), title: 'Pixels and triangles', level: 'Throughput',
  blurb: 'A framebuffer scanned out to the screen, double buffering and vsync; edge functions in fixed point, a rasterizer that walks a triangle in tiles, one pixel a cycle; a depth buffer and blending; your own drawing, cut into triangles.',
  goals: [
    'lay out a double-buffered frame in memory, and say why the flip waits for vsync',
    'decide with three edge functions whether a pixel centre is inside a triangle, the top-left rule included',
    'count a tile walk\'s cycles, and say why it needs adders but no multiplier per pixel',
    'say why the depth test makes draw order irrelevant (exact ties aside) and blending does not',
  ],
  builds: ['memory', 'muldiv'],
  recap: {
    keep: [
      'A 64 × 64 RGB332 frame is 4 KB; the scan-out reads a word, four pixels, a cycle: 1024 cycles a frame. Two frames and a flip at vsync stop tearing; a swap moves two address multiplexers and copies nothing.',
      'E<sub>i</sub>(p) = A<sub>i</sub>·(p.x − x<sub>i</sub>) + B<sub>i</sub>·(p.y − y<sub>i</sub>): inside when all three are ≥ 0. Their sum is twice the area (negative: a back face, culled). The top-left rule biases the other edges by −1, so a shared edge is drawn once.',
      'One pixel right adds 4A, one down 4B: products only at set-up, eight on one Booth multiplier. Tiles of 4 × 4 pixels are tested at their best corner: the large triangle takes 1914 cycles against 3368 pixel by pixel.',
      'Depth is a fourth plane, stepped with the edges. Its set-up needs two divisions: 76 more cycles per triangle and 12 032 NANDs. A pixel passes only if strictly nearer, and draw order stops mattering, except where two surfaces tie exactly in depth: there the first drawn keeps the pixel.',
      'Blending (α in eighths, 1074 NANDs) mixes with what is already in the frame, so order matters: opaque surfaces first with the depth test, translucent ones back to front.',
    ],
    practise: ['k_edge', 'k_tile', 'k_raster'],
    check: [
      {
        question: 'Swap is pressed mid-frame with "wait for vsync" off. What does the screen show?',
        options: ['The top of one picture and the bottom of the other: tearing', 'A black frame', 'Nothing changes until the copy is done', 'The frame from two swaps back'],
        answer: 0,
        explain: 'The scan-out keeps reading word by word; the swap moves its address multiplexers at once, so the rest of the frame comes from the other buffer.',
        why: ['', 'The scan-out never stops sending pixels; it only switches buffers part-way.', 'Nothing is copied: the swap moves two address multiplexers, so it takes effect at once.', 'A swap shows the frame just drawn, not an older one.'],
      },
      {
        question: 'Why does depth set-up cost more than the rest of the rasterizer?',
        options: ['Its slopes divide by twice the area: two runs of a 30-bit divider, 32 cycles each', 'Depth values are 32 bits wide', 'The depth buffer is cleared for every triangle', 'Every pixel needs a multiplication for z'],
        answer: 0,
        explain: 'Z<sub>x</sub> and Z<sub>y</sub> are quotients by 2·area: four products, two divisions and ten shift-and-add steps, about 80 cycles that start during the edge set-up, so 76 more cycles before the walk; 12 032 NANDs. Per pixel z is one add.',
        why: ['', 'Width costs adders, not cycles; the time goes into the two divisions.', 'The depth buffer is cleared once a frame, not per triangle.', 'z is linear like the edges: one add per pixel step, no multiplication.'],
      },
      {
        question: 'Depth test on. A translucent triangle is drawn first, then an opaque one behind it. What goes wrong where they overlap?',
        options: ['The opaque one fails the depth test there, and the translucent one was blended over the old background', 'Nothing: the depth test sorts it out', 'The opaque one overwrites the translucent one', 'The overlap is blended twice'],
        answer: 0,
        explain: 'The translucent pixels wrote their depth, so the surface behind fails "nearer"; the blend had already mixed with whatever was in the frame. Hence opaque first, translucent back to front.',
        why: ['', 'The depth test picks which pixel survives; it cannot redo a blend that mixed with the wrong colour.', 'It is behind, so the depth test rejects it where they overlap.', 'The opaque pixels are rejected, so there is no second blend: the problem is the first one.'],
      },
    ],
  },
  steps: [
    {
      title: 'A frame in memory',
      body: `
        <p>A picture is an array in memory: here 64 × 64 pixels of one byte each, <strong>RGB332</strong> (3 bits of red, 3 of green, 2 of blue, the colour
        the eye resolves least). Pixel (x, y) is byte y·64 + x, 4 KB a frame. The bytes sit in four banks, bank x mod 4, so one word address names four
        neighbouring pixels.</p>
        <p>The <span data-show="scan"><strong>scan-out</strong></span> sends the frame to the screen: a 10-bit counter steps through the words, one a cycle,
        1024 cycles a frame, and raises <span data-show="pin:vsync"><strong>vsync</strong></span> on the last word. It is the one client of memory that can never wait: a 1920 × 1080 display at 60 Hz needs 124 million
        pixels a second whatever else is happening.</p>
        <p>Drawing into the frame the screen is reading shows half-drawn pictures. So there are <span data-show="fb">two frames</span>, the
        <strong>front</strong> one read by the scan-out and the <strong>back</strong> one drawn into, and <span data-show="pin:swap"><strong>swap</strong></span>
        exchanges them: two address multiplexers change sides, nothing is copied. The flip <span data-show="pin:sync">waits for vsync</span>, so it falls between two frames. Without that wait the screen shows the top of one picture and the bottom of the other:
        <strong>tearing</strong>.</p>
        <p>Cost: the scan-out and its flip are 256 NANDs, the frames' own multiplexers 245. The two frames are 64 Kbit of flip-flops, 1.35 million NANDs as drawn, simulated as two
        lookups (open a bank to see its flip-flops); real framebuffers are DRAM.</p>
        <p>Why the flip is not a copy: a copy of 4 KB would take at least one cycle per word, 1024 of them, during which the scan-out would read a half-copied frame. Exchanging which
        buffer each address multiplexer selects is one cycle and cannot be seen, provided it lands between two frames. That timing constraint, not the memory, is why a display
        controller owns vsync.</p>
        <div class="try">Run, then Swap: the rings arrive with the next frame. Untick "wait for vsync" and Swap again mid-frame to see a tear.</div>`,
      scene: displayScene,
      tries: [(st) => st.getInput('sync') === 0],
      tour: {
        beats: [
          { title: 'Reading the front frame', reset: true, set: { swap: 1 }, show: ['scan'], expect: { pixels: 4294967295, vsync: 0 },
            say: `<p>Swap is held high, but sync is on: the flip waits for vsync. The scan-out is at word 0 of the front frame and sends four pixels at once, <code>pixels</code> = {b:pixels}, all four pixels set.</p>` },
          { title: 'A frame of words', cycles: FRAME_WORDS - 1, show: ['scan'], expect: { vsync: 1, pixels: 4294967295 },
            say: `<p>${FRAME_WORDS - 1} cycles on, the counter is at the last word, ${FRAME_WORDS - 1}, and <code>vsync</code> is {v:vsync}. One word a cycle, ${FRAME_WORDS} words: ${SCREEN.w} × ${SCREEN.w} pixels at four a word is exactly one frame. The pending swap lands on this edge.</p>` },
          { title: 'The other frame', cycles: 1, show: ['fb', 'scan'], expect: { vsync: 0, pixels: 50529251 },
            say: `<p>The next word comes from the other buffer: <code>pixels</code> = {b:pixels}, no longer the first picture's. No word was copied; two address multiplexers changed sides between frames, so no frame was torn.</p>` },
        ],
      },
      more: {
        derive: `<p>Memory: ${SCREEN.w} × ${SCREEN.w} pixels × ${SCREEN.bytesPerPixel} byte = ${fmt(FRAME_BYTES)} bytes, ${FRAME_WORDS} words of ${SCREEN.perWord} pixels, so the word counter is log<sub>2</sub> ${FRAME_WORDS} = ${Math.log2(FRAME_WORDS)} bits and a frame takes ${FRAME_WORDS} cycles.
          The bandwidth the display demands is fixed by the screen, not the program: at 1920 × 1080 × 60 Hz, ${fmt(1920 * 1080 * 60)} pixels a second, which at 4 bytes a pixel is ${fmt(1920 * 1080 * 60 * 4)} bytes a second
          of reads that nothing may delay. Two frames cost 2 × ${fmt(FRAME_BYTES)} = ${fmt(2 * FRAME_BYTES)} bytes here.</p>`,
        pitfall: `<p>Pressing Swap does not change the picture now; it changes it at the next vsync. If nothing seems to happen, you pressed it with sync on and the frame is still being scanned.
          With sync off the swap is immediate and lands in the middle of a frame: the rows above the flip come from one buffer and the rows below from the other.</p>`,
        real: `<p>Displays are refreshed from a scan-out engine that reads the frame buffer by DMA in bursts and cannot be stalled; compositors flip pointers, not pixels (page flipping), and triple buffering adds a third
          frame so the GPU never waits for the flip. Variable-refresh displays move the vsync to when the frame is ready.</p>`,
      },
    },
    {
      title: 'Inside a triangle',
      body: `
        <p>Vertices are in <strong>fixed point</strong>: quarter pixels, 0 to 255 across the screen, so a triangle can move by less than a pixel. Pixel (x, y) is
        sampled at its centre (4x + 2, 4y + 2). For the edge from vertex i to vertex i + 1,</p>
        <p class="eq">E<sub>i</sub>(p) = A<sub>i</sub>·(p.x − x<sub>i</sub>) + B<sub>i</sub>·(p.y − y<sub>i</sub>)<br>A<sub>i</sub> = y<sub>i</sub> − y<sub>i+1</sub>, &nbsp; B<sub>i</sub> = x<sub>i+1</sub> − x<sub>i</sub></p>
        <p>is a cross product: its sign says which side of the edge p lies on. A pixel is <strong>inside</strong> when all three are ≥ 0. Their sum is the same
        at every point, twice the triangle's area, so E<sub>i</sub> divided by the sum are the <strong>barycentric weights</strong> of the opposite vertices,
        what depth and colour are interpolated with. A negative area means the triangle is wound the other way (a back face, seen from behind): it is
        culled.</p>
        <p>A centre exactly on an edge shared by two triangles must be drawn once, not twice (blending would add it twice) and not zero times (a crack). The
        <strong>top-left rule</strong> keeps it for the triangle whose left edge (A &gt; 0) or top edge (A = 0, B &gt; 0) it lies on: every other edge
        is biased by −1.</p>
        <p>Widths: coordinates are 8 bits, so |E| ≤ 2·255² = 130 050 fits in 18 bits signed. And no multiplier per pixel: one pixel to the right adds 4A to E,
        one down adds 4B. The products are needed once per triangle, at the start.</p>
        <p>Why this form and not, say, slope comparisons: a cross product needs only subtractions and two multiplications, no division and no special case for vertical edges, and it is
        linear in p, which is what lets the walk step by addition. The price is that the sign convention matters (the winding decides which side is inside), and the arithmetic must be
        wide enough that E never wraps.</p>
        <div class="try">Drag a vertex across the opposite edge: the area turns negative and nothing is drawn. Point at pixels on an edge to see the bias decide.</div>`,
      widget: edgeWidget,
      more: {
        derive: `<p>Worked example, vertices a = (20, 20), b = (240, 60), c = (40, 230) (quarter pixels) and the centre of pixel (24, 25), p = (${P}). E<sub>ab</sub> = (20 − 60)·(${P[0]} − 20) + (240 − 20)·(${P[1]} − 20)
          = ${edgeAt([20, 20], [240, 60], P)}; E<sub>bc</sub> = ${edgeAt([240, 60], [40, 230], P)}; E<sub>ca</sub> = ${edgeAt([40, 230], [20, 20], P)}. All three are ≥ 0, so p is inside, and they sum to
          ${edgeAt([20, 20], [240, 60], P) + edgeAt([240, 60], [40, 230], P) + edgeAt([40, 230], [20, 20], P)}, twice the area (${edgeAt([20, 20], [240, 60], [40, 230])}, from the vertex c against edge ab). Width: |A|, |B| ≤ 255 so |E| ≤ 2 · 255² = ${fmt(2 * 255 * 255)}
          &lt; 2<sup>17</sup>: ${Math.ceil(Math.log2(2 * 255 * 255 + 1)) + 1} bits signed.</p>`,
        pitfall: `<p>A pixel is sampled at its centre, (4x + 2, 4y + 2), not its corner. Coverage is decided at that one point, not by area: a triangle covering three quarters of a pixel can still miss the centre. Sampling at a corner would crack nothing but would shift the picture half a pixel. The top-left rule is needed because samples can fall exactly on shared edges, often in fixed point.</p>`,
        real: `<p>GPUs evaluate the same edge equations, usually on a 4 × 4 or 8 × 8 pixel block at once, with 8 sub-pixel bits or more and 24-bit-wide arithmetic. Direct3D's specification mandates the top-left rule; Vulkan requires only that exactly one of the two triangles covers such a sample, so a
          shared edge is drawn once on every conforming GPU.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'One pixel to the right, by how much does edge i\'s value change?',
        options: ['A_i', '4·A_i', '4·B_i', 'It depends on x'], answer: 1,
        explain: 'E is linear in p, and one pixel is 4 quarter-pixel units in x: E grows by 4·A_i whatever the pixel. That is why the walk needs adders only.',
        why: ['A_i is the change for one quarter-pixel unit; a pixel is four of them.', '', 'B_i multiplies the y difference: 4·B_i is the step one pixel down.', 'E is linear in p, so the step is the same everywhere.'],
      },
    },
    {
      title: 'Walking tiles',
      body: `
        <p>The <span data-show="rast"><strong>rasterizer</strong></span> turns a triangle into pixel writes, one a cycle. Open it:</p>
        <ul>
          <li><strong>Set-up</strong> (6389 NANDs): A and B by subtraction, the top-left bias, the bounding box by comparators, and eight products on one
          10 × 10 Booth multiplier (<a href="#/c/muldiv/0">chapter ${numOf('muldiv')}</a>, 1601 NANDs) in eight cycles: twice the area (its sign culls), then each edge's value at the first tile.</li>
          <li>Three <strong>edge steppers</strong> (1330 NANDs each): E, a register R for the start of the current band, one adder / subtractor whose operand
          is dx = 4A, dy = 4B or four times either (a wired shift), and a second adder for the tile test.</li>
          <li>The <strong>tile walk</strong> (753 NANDs): a state machine over the box in 4 × 4-pixel tiles.</li>
        </ul>
        <p>Each tile starts with one TEST cycle: if any edge is negative at the tile's best corner, no pixel of the tile can be inside and the walk jumps on
        (E += 4dx). Otherwise its 16 pixels follow, one a cycle. A row of tiles is a <strong>band</strong>; the next band starts from R.</p>

        <p>The large triangle: 1369 pixels, 210 tiles tested, 106 walked, 1914 cycles. Visiting its box pixel by pixel would take 3368. A thin sliver gains
        more: 888 cycles against 3848. A real GPU tests whole tiles of pixels in parallel and writes dozens a cycle; this one writes at most one, 11 989 NANDs
        in all.</p>
        <div class="try">Draw, and watch the <span data-show="fb">back frame</span> fill (click the BACK frame under the screen: what it held before stays dimmed until something writes it). Swap to put it on the screen. Then try the sliver, and the
        back face: it stops after three set-up cycles.</div>`,
      scene: () => gpuScene('large'),
      more: {
        derive: `<p>The best corner for edge i is E + 12·(A⁺ + B⁺), where A⁺ is A when positive, else 0. The 16 pixels go column by column, down, up, down, up, so the
          tile ends at its top-right pixel and the next tile is one step right.</p>
          <p>The large triangle's cycles: 8 set-up (the products), 210 tile tests, 106 tiles walked at 16 pixels: ${8 + 210 + 106 * 16} cycles (1914 measured), against 3368 for every pixel of the box. The walk skips ${210 - 106} of 210 tiles
          (${pct(210 - 106, 210)}) for the price of one test cycle each. A tile test costs 1 cycle and saves up to 16, so it pays whenever more than 1 in 16 tested tiles is empty.</p>`,
        pitfall: `<p>The test is conservative: a tile passes if <em>any</em> pixel could be inside, judged by each edge's best corner separately. A tile near a vertex can pass all three edge tests and still contain no pixel
          centre. It then costs 17 cycles for nothing, and that is why most of a thin sliver's cost is not the pixels written: of its 888 cycles 358 visit empty pixels in tiles that passed, 240 test tiles and 282 write.</p>`,
        real: `<p>Hardware rasterizers walk a hierarchy: coarse tiles of 16 × 16 or more, then 4 × 4 or 8 × 8 blocks, then pixels, rejecting whole levels at once, and write a block of pixels per cycle. This chapter's walk is the same idea with one
          level and one pixel a cycle.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'The walk tests a tile and skips it. What is certain?',
        options: ['No pixel centre in the tile is inside the triangle', 'The tile is outside the bounding box', 'All three edges are negative at the tile\'s corners', 'The triangle is a back face'], answer: 0,
        explain: 'One edge is negative even at the tile\'s best corner, so it is negative at every pixel of the tile: none can be inside. The tile may well be inside the bounding box, and the other two edges can be positive.',
        why: ['', 'The walk only visits tiles of the bounding box, so a skipped tile is inside it.', 'One negative edge is enough to skip a tile; the other two may be positive.', 'A back face is culled at set-up, before any tile is tested.'],
      },
    },
    {
      title: 'Depth',
      body: `
        <p>Draw two triangles that cross in depth and no order is right: each is in front of the other somewhere. The fix is per pixel. Every vertex gets a
        depth z (8 bits, 0 nearest), and a <span data-show="rop"><strong>depth buffer</strong></span> keeps, for each pixel, the depth of what was drawn there. A pixel is written only
        if it is nearer than that, and then its depth is written too. The order of the triangles no longer matters, except at an exact tie: equal
        depth fails, so there the first triangle drawn keeps the pixel (these two never tie at a pixel centre).</p>
        <p>z is linear across the triangle, a plane like the edges: z = z<sub>0</sub> + Z<sub>x</sub>·Δx + Z<sub>y</sub>·Δy with
        Z<sub>x</sub> = (A<sub>0</sub>·(z<sub>2</sub> − z<sub>0</sub>) + A<sub>2</sub>·(z<sub>1</sub> − z<sub>0</sub>)) / (2·area) (the barycentric weights,
        differentiated), Z<sub>y</sub> the same with B. So a fourth stepper walks it with the edges. Its <span data-show="rast"><strong>depth set-up</strong></span>
        needs a division: four products on its own Booth multiplier, two divisions on <a href="#/c/muldiv/0">chapter ${numOf('muldiv')}</a>'s non-restoring divider (30 bits, 32 cycles each) and ten shift-and-add steps for
        z at the first tile. That is about 80 cycles that start during the edge set-up, so 76 more cycles before the walk, and 12 032 NANDs, more than the rest of the rasterizer; real GPUs share one set-up unit
        among many pixel pipelines.</p>
        <p>The buffer keeps 16 bits a pixel. The <span data-show="rop">ROP</span> (raster operations: the depth test and the blend) reads it at the pixel's
        address, compares and writes in the same cycle. Clearing it walks every tile of the screen: ${fmt(CLEAR)} cycles from go (${Z_WALK_START - 1} before the walk starts,
        then 256 tiles of 17: a test and 16 pixels), longer than drawing both triangles.</p>

        <div class="try">Draw these in both orders: the same picture, with the crossing line where the two depths are equal. Then with the
        <span data-show="pin:zt">depth test</span> off: the last triangle covers the other.</div>`,
      scene: () => depthScene('depth'),
      more: {
        derive: `<p>z has 12 fraction bits and the arithmetic is 32 bits that wrap: a thin sliver has a huge slope, and its z overflows far outside the triangle, but
          it is right at every pixel inside, to about a tenth of a z unit.</p>
          <p>Clear cost: ${Z_WALK_START - 1} cycles to the walk's start, 16 × 16 = 256 tiles of 17 cycles (a test and 16 pixels): ${Z_WALK_START - 1} + 256 × 17 = ${Z_WALK_START - 1 + 256 * 17}, and ${CLEAR} counted from go with the cycle that starts it.
          Per triangle the depth set-up adds two 32-cycle divisions plus the products and the shift-and-add steps: ${Z_WALK_START} cycles before the first tile, of which 8 are the edge products.</p>`,
        pitfall: `<p>Depth is compared as stored, 16 bits, so two surfaces closer than one step collide (z-fighting): which one wins depends on draw order and rounding, and flickers as they move. It
          is not a bug in the test but a precision limit; the cure is more bits or a larger gap between the surfaces.</p>`,
        real: `<p>GPUs test depth per pixel in hardware before or after shading (early-z lets the test skip shading hidden pixels), keep it compressed per tile and clear it with a flag (fast clear), and use 24 or 32 bits with a
          non-linear mapping that spends more steps near the viewer.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'The depth test is on. A pixel arrives with exactly the depth the buffer holds there. What happens?',
        options: ['It is written: it is not farther', 'It is not written: only nearer pixels pass', 'The colours are averaged', 'The rasterizer stalls'], answer: 1,
        explain: 'The comparator\'s output is "less than": equal does not pass, so the first triangle drawn at that depth keeps the pixel. Real APIs let the program choose the comparison (less, less-or-equal, …).',
        why: ['The comparator is "less than", not "less or equal": equal fails.', '', 'The depth test only passes or rejects a pixel; blending is a separate step, applied to a pixel that passes.', 'The ROP reads, compares and writes in the same cycle: nothing waits.'],
      },
    },
    {
      title: 'Blending',
      body: `
        <p>Glass, smoke, a fading sprite: the new colour is mixed with the one already in the frame, out = src·α + dst·(1 − α), channel by channel. Here
        <span data-show="pin:a">α</span> comes in eighths: (s·(a + 1) + d·(7 − a)) / 8, <span data-show="rop">six 4 × 4 array multipliers and three
        adders</span> (1074 NANDs); the division by 8 is wiring. The destination is the <span data-show="fb">back frame</span>'s pixel at the same address,
        read and rewritten in one cycle.</p>
        <p>Unlike the depth test, blending is not commutative: a blue at 3/8 over red is a dark purple, the same blue under an opaque red is red. Renderers therefore
        draw the opaque surfaces first, with the depth test, then the translucent ones sorted back to front. And here the top-left rule pays: a pixel on
        an edge shared by two translucent triangles is blended once, not twice.</p>
        <p>The cost is arithmetic, not memory or time: no extra cycle. What blending adds is a dependency: each pixel's result depends on the one before it at the same address, so two translucent triangles cannot be drawn in parallel without a rule for who goes first.</p>
        <div class="try">Draw these in both orders and compare the overlap.</div>`,
      scene: () => depthScene('blend'),
      more: {
        derive: `<p>The blend is (s·(a + 1) + d·(7 − a)) / 8 per channel with α = (a + 1) / 8 (a = 7 is opaque). Worked example: s = 200, d = 40, a = 2: (200 · 3 + 40 · 5) / 8 = ${(200 * 3 + 40 * 5) / 8}. Order matters because the result is not
          symmetric: blending s over d gives ${(200 * 3 + 40 * 5) / 8}, d over s with the same α gives (40 · 3 + 200 · 5) / 8 = ${(40 * 3 + 200 * 5) / 8}. The factors (a + 1) and (7 − a) always sum to 8, so a blend of two equal values returns that
          value, and the division is a shift by three.</p>`,
        pitfall: `<p>Depth-testing a translucent surface hides what is behind it: its pixels write their depth, and anything drawn later that is farther fails the test even though it should show through. Draw opaque first with depth on,
          then translucent back to front with depth <em>writes</em> off; this core has only one switch, so the order is the whole trick.</p>`,
        real: `<p>Hardware blenders do the same arithmetic with 8 bits a channel and a choice of factors (source alpha, one minus source alpha, constants), usually fused with the depth test in a raster operations unit. Order-independent
          transparency exists, but it costs extra passes or memory, so most renderers still sort.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'Why are translucent surfaces drawn after the opaque ones, back to front?',
        options: ['Blending needs the depth buffer cleared', 'Each blend mixes with what is already in the frame, so what is behind must be there first', 'Translucent pixels are faster to draw', 'The top-left rule requires it'], answer: 1,
        explain: 'out = src·α + dst·(1 − α) reads dst: the surface behind must already be in the frame. Drawn the other way round, the far surface would be mixed over the near one.',
        why: ['The depth buffer is cleared once a frame whatever is drawn; the order matters because of what dst holds.', '', 'Every pixel write takes one cycle, translucent or not.', 'The top-left rule decides edge pixels within one draw; it says nothing about the order of draws.'],
      },
    },
    {
      title: 'Your own picture',
      body: `
        <p>The <span data-show="rast">rasterizer</span> draws triangles and nothing else, so everything else is cut into triangles before it reaches the GPU,
        by the driver or a tessellation stage. The pad does it in TypeScript, the way a driver would: a polygon by ear clipping, a brush stroke as a triangle
        strip, a triangle as it is.</p>

        <p>Each shape gets a depth of its own, nearer than every shape before it, and the <span data-show="rop">depth test</span> is on. Shapes cover each other in the order they were
        drawn. Where two triangles of one shape overlap (a stroke crossing itself, a fanned outline), the second fails "nearer", so the pixel is blended
        once: a translucent stroke has no darker knots where it crosses itself.</p>
        <p>Cost: the house is 7 shapes, 25 triangles and 2136 pixel writes, 6453 cycles after the ${fmt(CLEAR)}-cycle clear. Every triangle spends ${Z_WALK_START} cycles before
        its first tile, mostly on depth's division: 2125 of the 6453 here. A scribble of short segments is almost all set-up. That is why a GPU has
        several set-up units, and why meshes are not cut finer than the pixels need. The scene runs on the cycle engine, and the screen is compared
        pixel for pixel with the reference rasterizer's picture of the same triangles.</p>
        <div class="try">Draw something, then Send to the GPU; click the BACK frame under the screen to watch the clear sweep it and the triangles land. Tick "show triangles"
        to see what was sent. Then tick "keep my winding" and click a triangle counter-clockwise.</div>`,
      scene: drawScene,
      more: {
        derive: `<ul>
          <li><strong>Polygon</strong>: <strong>ear clipping</strong>. A convex corner whose triangle holds no other corner is an ear; cut it off and
          repeat. n corners give n − 2 triangles, O(n²) work. An outline that crosses itself runs out of ears, and the rest is fanned.</li>
          <li><strong>Brush</strong>: the path is thinned (Ramer–Douglas–Peucker, half a pixel), then each point is pushed out both ways along its
          <strong>mitre</strong>, the bisector of its two segments' normals. Neighbouring segments share their edges: a triangle strip, two triangles a
          segment.</li>
          <li><strong>Triangle</strong>: sent as it is. Clicked counter-clockwise it is a back face, so the pad turns it round, unless you tick "keep my
          winding".</li>
          </ul>
          <p>For a polygon of n corners the rasterizer receives n − 2 triangles, each with ${Z_WALK_START} cycles of set-up before its first tile: 12 corners give 10 triangles and ${10 * Z_WALK_START} set-up cycles, against the ${fmt(CLEAR)}-cycle clear that precedes them. A brush stroke of m segments is 2m triangles, so a scribble of 100 short segments is ${2 * 100 * Z_WALK_START} cycles of set-up alone.</p>`,
        pitfall: `<p>Drawing a concave outline with a fan from one corner (the easy method) covers the wrong pixels where the outline turns back on itself. Ear clipping avoids it by never cutting across the polygon's outside; only
          a self-crossing outline falls back to a fan, and there the result depends on overlaps.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'You draw a polygon with 12 corners. How many triangles does the rasterizer receive, and what does each one cost before its first pixel?',
        options: ['12 triangles, nothing: set-up is shared', '10 triangles, 85 cycles each', '10 triangles, 8 cycles each', '1 polygon, 85 cycles'], answer: 1,
        explain: 'Ear clipping turns n corners into n − 2 triangles, and each is a separate draw for the rasterizer: its own set-up, here 85 cycles with the depth division, before the first tile test.',
        why: ['Ear clipping gives n − 2 triangles, and each one is a separate draw with its own set-up.', '', 'Eight cycles is the edge set-up\'s products alone; with depth\'s division, set-up takes 85.', 'The rasterizer draws triangles and nothing else: the polygon is cut before it arrives.'],
      },
    },
    {
      title: 'The beam on a tube',
      body: `
        <p>The <a href="#/c/pixels/0">scan-out of the first step</a> was designed for a tube. A cathode-ray tube shows one pixel at a time: an electron beam, whose position is the address. The counter's 10 bits <em>are</em> the beam's two coordinates (the low 4 pick the word along a row, the high 6 the row). Below, that same counter drives a picture tube, and every phosphor cell the beam passes lights with the byte the scan-out read.</p>
        <p><strong>Gun and yoke.</strong> A heater warms three cathodes (red, green, blue); a control grid held negative against each meters its beam current, which is the pixel's colour field, and the final anode at 24 to 32 kV accelerates the electrons (about 0.3 c at 25 kV). A deflection yoke bends the beam with a magnetic field: horizontal coils sweep it sideways, vertical coils step it down. Deflection is proportional to coil current, so a straight line needs a <strong>sawtooth</strong>: a steady ramp, then a fast return.</p>
        <p><strong>Retrace.</strong> The return takes time, because the yoke is an inductance: the current flies back in a short half-cycle of a resonance, with the grid driven past cut-off and the beam <em>blanked</em>. Horizontal retrace is fast; vertical retrace takes several tens of line times. VGA's 640 × 480 mode spends 160 of 800 clocks on each line's blanking (20 %) and 45 of 525 lines on the frame's (8.6 %): only 73 % of the time is picture. <strong>Our scan-out has none.</strong> The cycle after word 15 of a row is word 0 of the next, and word 1023 is followed by word 0; a real tube needs a controller that holds the address while the beam flies back. Choose "With VGA-proportioned retrace" and the clock is held for those cycles.</p>
        <p><strong>Phosphor and mask.</strong> Each cell glows for as long as its phosphor takes to decay, which is why a 60 Hz screen does not flicker. This scan runs hundreds of times slower than a real one, so the default fade is ×16 (almost a whole frame). For colour, a steel <em>shadow mask</em> has one hole per triad of red, green and blue dots, and the three beams cross in the hole, so each lands on its own colour's dot (open the <em>Mask</em> view).</p>
        <p><strong>Interlace.</strong> Broadcast video draws 525 lines a frame at 15.734 kHz in two fields of 262.5 lines (59.94 fields a second), odd lines first. Pick "Broadcast NTSC, interlaced" and set a long fade to see the comb. Before you run it: 63.5 µs a line, 525 lines, how long is a frame?</p>
        <div class="try">Run, then switch to the VGA retrace and watch the horizontal current: the ramp is the sweep, the near-vertical fall the flyback. Swap the frame and note that it changes at the bottom right, at vsync, just as in the circuit above.</div>`,
      widget: () => crt3d(),
      more: {
        derive: `<p><strong>The gun in detail.</strong> A screen grid, G2, a few hundred volts up, draws the electrons out of each cathode; three focus electrodes shape the beam; the final anode, G6, joins the aquadag (graphite) coating inside the funnel through the anode button. The neck is 29.1 mm across on a typical colour tube of this 90° class, and its stem has about ten pins (the model draws ten).</p><p><strong>The yoke in detail.</strong> The force on a beam electron is F = −e v × B. The yoke is copper saddle coils round a ferrite core, where the neck widens into the funnel. A <em>magnetic</em> lens is what makes 90° (110° on larger tubes) possible in a tube this short; the drive power grows with the angle, from tens of watts at 90° to roughly twice that at 120° (an order of magnitude, not a datasheet figure). On this tube the deflection centre is 170 mm from the face, so the corners of a 340 mm diagonal are exactly 45° off the axis.</p><p><strong>Interlace in detail.</strong> The first field is the odd lines 1, 3, 5 … (rows 0, 2, 4 … counted from 0), the second the even lines.</p><p><strong>Phosphor decay.</strong> The colour-television phosphors (P22) are short-persistence. A fade of about 1 ms is 6 % of a frame, a trail of about four of our 64 rows behind the beam, and that setting is there. The fade is drawn as one exponential; real phosphors do not decay quite so simply.</p><p><strong>The mask's geometry.</strong> A real pixel is many dots of each colour, which this model draws as one lit cell. The three beams leave the in-line gun 5.5 mm apart and keep that spacing through the yoke; the shadow mask sits a few millimetres behind the glass, with a pitch of 0.27 mm in one published design example. One of our 4.25 mm cells spans about 16 triads.</p>`,
        numbers: `<p>VGA 640 × 480 @ 59.94 Hz: 25.175 MHz / 800 = 31.469 kHz a line, / 525 = 59.94 Hz a frame. Scaled to this screen the blanking becomes 16 pixels (4 words) a line and 6 lines a frame: ${20 * 70} cycles a frame instead of ${FRAME_WORDS}, of which ${FRAME_WORDS} carry a word.</p>`,
        real: `<p>Flat panels dropped the beam and kept the timing: the blanking intervals of VGA, DVI and HDMI are the tube's retrace, kept so that the same signals drive both. CRT monitors recovered the flyback energy to make the anode voltage: the pulse of voltage across the horizontal coil's inductance on the return is stepped up by a flyback transformer.</p>`,
      },
    },
  ],
};

export const chGfxPipeline: Chapter = {
  id: 'graphics', num: numOf('graphics'), title: 'The graphics pipeline', level: 'Throughput',
  blurb: 'A vertex kernel on the warp core, a command unit feeding the rasterizer, the frames double-buffered: a spinning triangle and a cube at gate level, and where the gates and cycles go.',
  goals: [
    'write the vertex transform as a kernel in 16.16 fixed point, and say why the vertex count is padded to a multiple of the lane count',
    'follow a frame through the command unit: launch, clear, triangles, swap, vsync',
    'say where a frame\'s cycles go, and why the frame time snaps to whole scan-outs',
    'say why the clear, not the vertex work, bounded the frame, and what a word-wide clear buys',
    'filter a texture: bilinear as three lerps, its gate cost, and why a mipmap chain costs 4/3 of the image',
  ],
  builds: ['warps', 'feed', 'pixels'],
  recap: {
    keep: [
      'The vertex kernel: sin θ from a 64-entry table, <code>mul</code> and <code>srai 16</code> in 16.16 fixed point, one packed word per vertex in a double-buffered vertex buffer. The triangle is 44 instructions, 60 cycles a frame.',
      'The command unit (1997 NANDs, one flip-flop a state) launches the next frame\'s kernel and the clear, feeds each triangle\'s word and vertices to the rasterizer through a spare read port, swaps, and waits for the flip and the kernel.',
      'Flips happen only at vsync, every 1024 cycles, so a frame snaps to whole scan-outs: the triangle\'s frame was 6144 cycles, 4438 of them the clear.',
      'The warp core is 182 121 NANDs and busy 1 % of the frame; the rasterizer, a seventh of its size, is busy most of it. Software matches the rasterizer only with five or six four-warp cores, but clears the frame in 804 cycles.',
      'A clear unit (a 10-bit word counter, 278 NANDs) with a banked depth buffer clears four pixels a cycle: the triangle\'s frame falls to 3072 cycles, and the rasterizer\'s pixel a cycle now bounds it.',
      `A texture sample is a bilinear filter: three lerps per channel, y = (a · (16 − f) + b · f) >> 4 each, ${fmt(nd(BILINEAR8))} NANDs per channel and 4 texel reads; a mipmap chain (level ≈ log₂ of the texels per pixel) costs ${(MIP_BYTES / 65536).toFixed(3)}× the image.`,
    ],
    practise: ['k_frame', 'p_spin'],
    check: [
      {
        question: 'Why is the vertex buffer double-buffered?',
        options: ['So the kernel computes frame f + 1 while the command unit reads frame f\'s vertices', 'Because a vertex takes two words', 'To make room for the triangle\'s fourth vertex', 'Because the scan-out reads it'],
        answer: 0,
        explain: 'Buffer f mod 2 holds frame f. The kernel launched at the start of a frame writes the other buffer, so it never overwrites vertices the command unit is still reading.',
        why: ['', 'A vertex is one packed word: X | Y << 8 | Z << 16.', 'The fourth vertex pads the vertex count to a multiple of the lane count; it sits in the same buffer.', 'The scan-out reads the framebuffer; vertices reach the rasterizer through the command unit.'],
      },
      {
        question: 'With the pixel-a-cycle clear, the cube\'s frames took 7168 to 8192 cycles. Why always a multiple of 1024?',
        options: ['A frame ends at a flip, and flips happen only at vsync, once per 1024-cycle scan-out', 'The rasterizer works in blocks of 1024 pixels', 'The clear takes 1024 cycles', 'The vertex kernel runs once every 1024 cycles'],
        answer: 0,
        explain: 'Whatever the drawing takes, the frame waits for the next vsync to flip: 7168 = 7 × 1024, 8192 = 8 × 1024.',
        why: ['', 'The rasterizer walks 4 × 4 tiles, one pixel a cycle, for as long as the triangle needs.', 'That clear took 4438 cycles, not a multiple of 1024.', 'The kernel runs once a frame (109 cycles for the cube), hidden in the clear.'],
      },
      {
        question: 'How long does the rasterizer spend on a cube face that points away?',
        options: ['Three set-up cycles: twice its area is negative', 'Nothing: the command unit skips it', 'Its whole 85-cycle set-up', 'One cycle per pixel it would have covered'],
        answer: 0,
        explain: 'Set-up computes twice the area first; a negative sign culls the triangle after three cycles, before the depth division and before any tile.',
        why: ['', 'The command unit sends every triangle; the rasterizer\'s set-up decides to cull.', 'Set-up stops at the area\'s sign, before the depth division.', 'Culling happens before any tile is walked: no pixel is visited.'],
      },
    ],
  },
  steps: [
    {
      title: 'Vertices are a kernel',
      body: `
        <p>Every vertex of a mesh goes through the same arithmetic, independently of the others: rotate it, place it on the screen. That is a
        <strong>kernel</strong>, one thread a vertex, on <a href="#/c/warps/0">chapter ${numOf('warps')}</a>'s warp core: here <span data-show="warp0">one warp</span> of
        <span data-show="lane0 lane1 lane2 lane3">four lanes</span> with <a href="#/c/feed/0">chapter ${numOf('feed')}</a>'s multipliers.</p>
        <p>Fixed point, <strong>16.16</strong>: sin θ comes from a table of 64 entries (a turn in 64 frames), cos θ is the same table a quarter turn on.
        Model coordinates are quarter pixels around the centre (|x| ≤ 100), so x·cos θ stays below 2<sup>24</sup>: <code>mul</code>'s low word is the whole
        product and <code>srai 16</code> drops the fraction. Then</p>
        <p class="eq">X = 128 + ((x cos θ − y sin θ) &gt;&gt; 16)<br>Y = 128 + ((x sin θ + y cos θ) &gt;&gt; 16)</p>
        <p>and the thread packs X | Y &lt;&lt; 8 | Z &lt;&lt; 16 into one word of the <strong>vertex buffer</strong>, buffer f mod 2 for frame f. Thread tid takes
        vertices tid, tid + 4, …, and the loop is tested at the bottom, so every lane runs its body at least once. The kernel therefore wants the vertex count
        a multiple of 4: each lane then takes exactly as many vertices, and the loop's branch is uniform for any mesh (six vertices would send lanes 0 and 1
        round twice and lanes 2 and 3 once: a divergent branch, needing split and join). The triangle's three vertices get a fourth, unused one, which lane 3
        would have transformed anyway: padded, it reads a defined vertex rather than whatever follows the model. One frame is 44 instructions,
        60 cycles. The cube (eight vertices, a spin then a fixed tilt toward the viewer: eight multiplies a vertex) is 86 instructions, 109 cycles.</p>
        <p>Cost: each lane is 35 255 NANDs, multiplier included; the core is 182 121 without its memories.</p>

        <div class="try">Run to halt, then switch to the cube's kernel. The vertex buffer is at word 96 of the <span data-show="mem">data memory</span>: one packed word a vertex.</div>`,
      scene: () => warpCoreScene('vertexTri', { warps: 1, highlight: ['lane0', 'lane1', 'lane2', 'lane3'], programs: ['vertexTri', 'vertexCube'] }),
      tries: [halted],
      tour: {
        beats: [
          { title: 'Four lanes, four vertices', reset: true, show: ['lane0', 'lane1', 'lane2', 'lane3'], expect: { pcOut: 0, maskOut: 15, halted: 0 },
            say: `<p>One warp, four lanes, mask {b:maskOut}. Each lane will transform one vertex: lane l takes vertex tid = l. The kernel is 44 instructions long.</p>` },
          { title: 'Waiting for the table', cycles: 5, show: ['mem'], expect: { pcOut: 20, retire: 0 },
            say: `<p>At PC {v:pcOut} the warp stops (<code>retire</code> {v:retire}): a load is in flight and the next instruction needs its result. With one warp there is nothing else to run.</p>` },
          { title: 'Loaded', cycles: 7, show: ['mem'], expect: { pcOut: 20, retire: 1 },
            say: `<p>Seven cycles later the word is back and the instruction issues; the multiply chain follows (<code>mul</code>, then <code>srai 16</code> to drop the fraction).</p>` },
          { title: 'Done', cycles: 48, show: ['warp0'], expect: { pcOut: 172, halted: 1 },
            say: `<p>44 instructions and 60 cycles after power-on, <code>halted</code> is {v:halted}: every vertex of the frame is transformed and stored in the vertex buffer, PC {v:pcOut}. The kernel is idle for the rest of the frame.</p>` },
        ],
      },
      more: {
        derive: `<p>16.16 fixed point means a value v is stored as v · 2<sup>16</sup> = v · ${fmt(65536)}. With |x|, |y| ≤ 100 and cos θ, sin θ scaled to ±${fmt(65536)}, each product is at most 100 · ${fmt(65536)} = ${fmt(100 * 65536)} and the
          sum of two at most ${fmt(200 * 65536)} &lt; 2<sup>24</sup> = ${fmt(2 ** 24)}, so the low 32 bits of <code>mul</code> hold the whole result and <code>srai 16</code> divides by 2<sup>16</sup>. The angle resolution is 360° / 64 = ${360 / 64}° a table step, the
          reason a turn takes 64 frames. Vertex count n over 4 lanes needs ⌈n / 4⌉ · 4 threads: ${Math.ceil(3 / 4) * 4} for the triangle, ${Math.ceil(8 / 4) * 4} for the cube.</p>`,
        pitfall: `<p>Overflow in the multiplication is silent and wraps at 32 bits. The 2<sup>24</sup> bound holds with room here, but a mesh with coordinates around 40 000 would make a product reach ${fmt(40000 * 65536)} and the vertex would land at a wrong place,
          not stop the program. Change the mesh and check the bound.</p>`,
        real: `<p>This scene is <strong>orthographic</strong>: a rotation, then x and y straight onto the screen, z kept for the depth test, and the meshes small
          enough that every vertex stays on screen (the triangle's within 100 quarter pixels of the centre, the cube's corners within 97). A real pipeline
          does more between the vertex kernel and the rasterizer:</p>
          <ul>
          <li>The vertex shader multiplies by a 4 × 4 model-view-projection matrix into <strong>clip space</strong>, (x, y, z, w), where w carries the
          distance from the eye.</li>
          <li><strong>Clipping</strong>: a triangle crossing the near plane must be cut into smaller ones (w ≤ 0 behind the eye would flip it). The other
          planes are mostly left to a <strong>guard band</strong>: the rasterizer's fixed point covers several screens' width, and its bounding box simply
          stops at the screen's edge, so only triangles that leave even the guard band are clipped.</li>
          <li>The <strong>perspective divide</strong>, x / w, y / w, z / w, gives normalized coordinates (−1 … 1), and the <strong>viewport</strong>
          transform scales them to pixels in fixed point (8 sub-pixel bits is common; here 2).</li>
          <li><strong>Perspective-correct interpolation</strong>: z / w is linear on the screen, so depth stays a plane as in chapter ${numOf('pixels')}; but texture
          coordinates and colours are not. The rasterizer interpolates a / w and 1 / w linearly and divides per pixel, one reciprocal a pixel.</li>
          </ul>`,
      },
      challenge: {
        kind: 'quiz', question: 'Why does the triangle carry a fourth vertex that no triangle uses?',
        options: ['The rasterizer needs four vertices', 'Lane 3 runs the loop body anyway (the loop is tested at the bottom): the pad gives it a defined vertex, and the count stays a multiple of 4','To keep the vertex buffer aligned to 16 bytes', 'The multipliers work in pairs'], answer: 1,
        explain: 'Thread tid takes vertices tid, tid + 4, … and tests at the bottom. With three vertices every lane would still run the body once and leave after it (tid + 4 ≥ 3): the branch stays uniform, but lane 3 transforms the words after the model. The multiple of 4 is what keeps the branch uniform in general: with five to seven vertices some lanes would loop twice and others once, a divergent branch needing split and join. The cost is one wasted lane-pass.',
        why: ['A triangle has three vertices, and the command unit reads three per triangle.', '', 'The padding is about lanes, not bytes: the kernel takes vertices in passes of four.', 'Each lane has a multiplier of its own; nothing pairs them.'],
      },
    },
    {
      title: 'The pipeline',
      body: `
        <p>Six blocks, the first one programmable: the <span data-show="core">warp core</span> running the vertex kernel, the
        <span data-show="cmd"><strong>command unit</strong></span>, <a href="#/c/pixels/0">chapter ${numOf('pixels')}</a>'s <span data-show="rast">rasterizer</span> with its
        depth set-up, the <span data-show="rop">depth test and blend</span>, the <span data-show="fb">two frames</span> and the
        <span data-show="scan">scan-out</span>. The command unit (1997 NANDs, one flip-flop a state) runs every frame:</p>
        <ul>
          <li><strong>launch</strong>: start the kernel on the <em>next</em> frame (warp 0 back to PC 0, every lane on) and, in the same cycle, start the
          clear of the back frame;</li>
          <li>read the triangle count, then per triangle its word (three vertex indices, a colour) and its three vertices from this frame's vertex buffer:
          four reads on a spare read port of the core's memory, then <strong>go</strong>, and wait while the rasterizer is busy;</li>
          <li><strong>swap</strong>, then wait for the flip at vsync and for the kernel; the next frame reads the other vertex buffer.</li>
        </ul>
        <p>The vertex buffer is double-buffered like the framebuffer, so the kernel computes frame f + 1 while frame f is drawn.</p>

        <p>The triangle's frame is 6144 cycles: the clear 4438 (the launch cycle, then <a href="#/c/pixels/0">chapter ${numOf('pixels')}</a>'s ${fmt(CLEAR)}-cycle clear
        from go), the triangle 1268, waiting for vsync 438; the kernel's 60 cycles hide inside the clear.
        A frame ends at a flip, and flips happen only at vsync, every 1024 cycles: the frame time snaps to six scan-outs.</p>
        <div class="try">One frame, then read the timeline: who works when. Click the BACK frame under the screen and step through a frame: the clear sweeps away the picture from two frames ago, then each triangle lands, and the two vertex buffers trade roles. Open the command unit and watch its state register.</div>`,
      scene: () => pipelineScene('triangle', { highlight: ['cmd'] }),
      more: {
        derive: `<p>The triangle's frame adds up: clear 4438 + triangle 1268 + vsync wait 438 = ${4438 + 1268 + 438} cycles, which is ${(4438 + 1268 + 438) / FRAME_WORDS} scan-outs of ${FRAME_WORDS}. The drawing itself ends at 4438 + 1268 = ${4438 + 1268} cycles; the flip rounds that up to
          ${snap(4438 + 1268)}, ${snap(4438 + 1268) - (4438 + 1268)} cycles of waiting. Any drawing time inside the same 1024-cycle window gives the same frame time, and one cycle over the boundary costs a whole extra scan-out.</p>`,
        pitfall: `<p>Do not read a frame time as the drawing time. Making the rasterizer 10 % faster does nothing if the end of the drawing stays in the same 1024-cycle window; the frame snaps back to the same flip.
          Measure the timeline's busy spans (clear, triangle, kernel), not the frame count.</p>`,
        real: `<p>A real command processor does the same over the memory system: it reads command buffers, launches kernels and waits on fences.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'The vertex kernel is busy 60 cycles of a 6144-cycle frame. What would a second warp core gain?',
        options: ['Twice the frame rate', 'Nothing: the frame is spent clearing and rasterizing', 'Half the vsync wait', 'Room for the depth test'], answer: 1,
        explain: 'The kernel already finishes during the clear, a frame ahead of its use. The frame is bound by the clear (4438 cycles) and the rasterizer (one pixel a cycle); more vertex throughput changes nothing until the mesh is far larger.',
        why: ['The kernel is 60 of 6144 cycles and already hidden in the clear: doubling its throughput saves nothing.', '', 'The vsync wait depends on where drawing ends within a scan-out, not on the kernel.', 'The depth test is fixed-function in its own block; it does not run on the warp core.'],
      },
    },
    {
      title: 'A spinning triangle',
      body: `
        <p>Run: every gate of the pipeline is simulated, 413 501 leaves (gates and memory blocks). This scene runs on the <strong>cycle engine</strong>: the
        same settled values after every clock edge as the event-driven simulator, flip-flops as tables, several times faster; it has no gate delays, so
        probes and the timing diagram are off here. The panel measures frames per second in this page: a few (about three for the triangle on the machine
        this was written on), for a frame that a 1 GHz chip would draw in 6 µs.</p>
        <p>Nothing is taken on trust. The <span data-show="core">vertex kernel</span> runs in lock-step with the instruction-set simulator (a reference model of
        the warp core in software), its vertex buffer is compared when the command unit starts reading it, and every frame is compared, pixel for pixel, with
        the reference rasterizer's picture of the same vertices.</p>
        <p>Then the cube: twelve triangles, a colour a face. Half of them or more face away (six or eight, with the angle), so the <span data-show="rast">rasterizer's set-up</span> culls them after
        three cycles (twice their area is negative).
        For a single convex solid that alone hides everything behind; depth is on all the same, and earns its 76 set-up cycles per triangle only where
        solids overlap. Its frames take 7168 to 8192 cycles: two or three faces, 2300 to 3200 cycles of drawing.</p>
        <p>What the scene proves is agreement, not speed. A gate-level bug anywhere in 413 501 leaves would show up as a pixel that differs from the reference in some frame, which is why the pipeline can be trusted at this size.</p>
        <div class="try">Run for a few frames, then pick the cube. Pause and open the rasterizer: its tile walk is wherever the timeline says.</div>`,
      scene: () => pipelineScene('triangle', { highlight: ['core', 'rast'] }),
      more: {
        derive: `<p>A back-facing triangle costs 3 set-up cycles, a front-facing one ${Z_WALK_START} plus its walk. A cube has 12 triangles, 2 per face; with the angle, 6 to 8 of them face away: those cost ${6 * 3} to ${8 * 3} cycles, the visible ones
          ${12 - 8} to ${12 - 6} triangles at ${Z_WALK_START} each plus their tiles. The measured frame is 7168 to 8192 cycles: ${7168 / FRAME_WORDS} to ${8192 / FRAME_WORDS} scan-outs, two or three faces drawn, with the clear (4438) taking most of it.</p>`,
        pitfall: `<p>The cycle engine shows settled values only, so the timing diagram and probes are off; slowing the clock down will not show gate delays here. To watch one gate switch, use the earlier chapters' scenes, which run on the event-driven simulator.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'A cube is convex. Which triangles would be drawn wrongly with the depth test off?',
        options: ['None: back-face culling already removes every hidden face', 'The faces seen at a grazing angle', 'Every triangle drawn after the first', 'Pixels on shared edges'], answer: 0,
        explain: 'On a convex solid every face that points away is hidden and every face that points toward the viewer is fully visible, so culling alone gives the right picture. Two solids, or a concave one, need the depth test.',
        why: ['', 'A face at a grazing angle still points toward or away from the viewer, and culling settles both cases.', 'On a convex solid the faces that point toward the viewer never overlap, so their order does not matter.', 'The top-left rule draws shared-edge pixels once, with or without the depth test.'],
      },
    },
    {
      title: 'Where the gates go',
      body: `
        <p>The programmable part is the largest and the idlest: 182 121 NANDs of warp core, busy 1 % of the frame. The rasterizer, a seventh of its
        size, is busy most of it. Real GPUs answer with <strong>unified shaders</strong>: vertex and pixel work run on the same lanes, so the lanes never
        wait for a kind of work that is not there; edge stepping, the depth test and blending stay fixed-function, because per pixel they are a handful
        of adders.</p>

        <p>The surprise is the clear: 72 % of the triangle's frame, one pixel a cycle. The same 16 threads clear the frame in software in 804 cycles,
        four pixels per store. Real GPUs never clear pixel by pixel: they mark tiles as cleared (fast clear) and supply the colour when a tile is first
        read. Drawing goes the other way: the software kernel takes 6825 cycles for the triangle the rasterizer draws in 1268, on <a href="#/c/warps/0">chapter ${numOf('warps')}</a>'s four-warp core, whose logic alone is 488 609 NANDs: matching the rasterizer in software would take five or six of them,
        against 26 708.</p>
        <p>Scaled to 1920 × 1080, this design would spend two million cycles a frame on the clear alone.</p>
        <p>Read the widget as a budget: gates on one axis, cycles on the other, per block. A block that is large and idle (the warp core) is a candidate for sharing with other work; a block that is small and busy (the rasterizer)
        is a candidate for copying. Unified shaders and several rasterizers are those two moves.</p>`,
      widget: costWidget,
      more: {
        derive: `<p>Utilization of each block over a ${fmt(6144)}-cycle frame: the warp core runs its kernel 60 cycles, ${pct(60, 6144)} busy; the clear takes 4438, ${pct(4438, 6144)}; the rasterizer spends its triangle's 1268 plus the clear it performs, almost the whole frame.
          Area against use: the core is 182 121 NANDs and the rasterizer a seventh of that (about ${fmt(Math.round(182121 / 7))}), so the biggest block is the idlest. At 1920 × 1080 the clear alone, one pixel a cycle, is ${fmt(1920 * 1080)} cycles, ${(1920 * 1080 / FRAME_WORDS).toFixed(0)} of this screen's scan-outs.</p>`,
        pitfall: `<p>Gate counts and cycle counts answer different questions. The warp core is large because it is general, not because it is slow; a review that only looks at area would shrink it and make vertex work the bottleneck at a larger mesh.
          Compare gates <em>and</em> busy time, per block.</p>`,
        real: `<p>Here a triangle has one flat colour and the ROP does the only per-pixel work. On a real GPU the rasterizer hands each covered pixel to a
          <strong>pixel shader</strong>, a kernel on the same lanes as the vertex shader, with the interpolated attributes as input. Pixels go in 2 × 2 quads
          (a lane each; a pixel the triangle misses still runs, as a helper, to complete its quad), so the shader can difference neighbours for the
          screen-space derivatives of its texture coordinates. A <strong>texture unit</strong> beside the lanes turns (u, v) and those derivatives into a
          mipmap level, fetches 4 texels (bilinear) or 8 (trilinear, two levels) through its own cache, and filters them: dozens of multiplies per sample, in
          fixed-function hardware because every pixel needs them. The shader's colour then goes through the depth test and blend exactly as here; a shader that
          writes no depth lets the depth test run first and skip shading hidden pixels (early z).</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'Which change halves the triangle\'s frame time?',
        options: ['A second warp core', 'Clearing four pixels a cycle', 'A faster vertex kernel', 'Flipping without waiting for vsync'], answer: 1,
        explain: 'The clear falls from 4438 cycles to 1026 (the next step builds it), so the frame snaps to three scan-outs: 3072 cycles instead of 6144. The kernel is hidden in the clear already; flipping without vsync saves at most one scan-out, and tears.',
        why: ['The warp core is busy 1 % of the frame: a second one would have nothing to do.', '', 'The kernel already hides inside the clear.', 'That saves at most one scan-out of 1024 cycles, and the picture tears.'],
      },
    },
    {
      title: 'Texturing',
      body: `
        <p>The triangle so far has one colour. Texturing gives every pixel a colour read from an image: the rasterizer interpolates <strong>(u, v)</strong> across the triangle, and the pixel looks up the
        <strong>texel</strong> at that position. Almost never does (u, v) land on a texel centre. Taking the nearest texel is blocky when magnified; <strong>bilinear filtering</strong> blends the four around it, weighted by how
        close the point is to each: with fractions <em>fx</em>, <em>fy</em> of the way across, first interpolate along x in both rows, then along y between the results. Three linear interpolations
        (<span data-show="u0 u1 u2">lerps</span>), each y = (a · (16 − f) + b · f) &gt;&gt; 4 for a 4-bit fraction: two 8 × 8 multipliers, an adder, and the low four bits dropped.</p>
        <p>One lerp is ${fmt(nd(LERP8))} NANDs, a bilinear unit ${fmt(nd(BILINEAR8))}, and an RGB332 pixel needs one per colour channel: ${fmt(3 * nd(BILINEAR8))}. For scale, chapter ${numOf('pixels')}'s whole blend unit (<code>BLEND332</code>) is ${fmt(nd(BLEND332))}.
        Each sample also reads <strong>4 texels</strong> from memory, and a texture cache exists mainly to serve them: neighbouring pixels share most of their texels. Each stage truncates, so the result can fall up to 1.875 below the exact weighted
        average, never above it (${bilinearRef(0, 255, 0, 255, 8, 0)} here against 127.5 for the midpoint of 0 and 255): the tests check the circuit against the reference over random inputs.</p>
        <p>Minified textures are the harder half. A 256 × 256 image drawn 32 pixels wide steps 8 texels per pixel; bilinear would read 4 texels spread over 8 and shimmer. A <strong>mipmap</strong> keeps the image at half size,
        quarter size and so on, and the unit picks the level whose texel is about one pixel: ρ = 8 texels per pixel gives level log<sub>2</sub> 8 = 3, the ${256 >> 3} × ${256 >> 3} image. The chain costs ${fmt(MIP_BYTES)} bytes for a ${fmt(256 * 256)}-byte texture,
        ${(MIP_BYTES / 65536).toFixed(3)}× (the series 1 + ¼ + 1/16 + … = 4/3). <strong>Trilinear</strong> blends two adjacent levels (8 texels, 7 lerps per channel); <strong>anisotropic</strong> filtering takes up to 16 such samples along the
        long axis of a stretched footprint, which is why texture units are fixed-function: the shader asks for a colour and the unit does 100-odd multiplies.</p>
        <div class="try">Put 0 in the left texels and 255 in the right ones, and find the fraction that returns the middle.</div>`,
      scene: () => ({ root: BILINEAR8, inputs: { t00: 0, t01: 255, t10: 0, t11: 255, fx: 4, fy: 0 } }),
      more: {
        derive: `<p>Bilinear as weights: y = Σ t<sub>ij</sub> · w<sub>ij</sub> with w = (1 − fx)(1 − fy), fx(1 − fy), (1 − fx)fy, fx·fy, summing to 1. Three lerps of the form a·(16 − f) + b·f need 6 multiplies; the weights need one, fx·fy (the other three follow by subtraction: fx − fx·fy, fy − fx·fy, 1 − fx − fy + fx·fy), then 4 for the texels, 5 in all but on wider operands. The two-stage form keeps each multiplier 8 × 5 useful bits and is how most hardware is built. Truncating between the stages loses at most 1 per stage; a unit that keeps 12 bits through the second lerp rounds once, at the cost of wider multipliers.</p>`,
        pitfall: `<p>Filtering gamma-encoded colours as if they were linear light darkens the blend: the average of black and white texels is 128 in the buffer but about 22 % reflectance. Hardware with sRGB textures converts to linear before the lerp, with a lookup per channel; this unit, like RGB332, filters the stored values.</p>`,
        real: `<p>A modern texture unit filters about one bilinear sample (4 texels) per clock, behind an L1 texture cache; sampling is also how shaders read ordinary data tables. The same lerp, exposed as <code>mix(a, b, f)</code>, is one instruction on the lanes.</p>`,
      },
      challenge: {
        kind: 'reach', goal: 'With 0 on the left and 255 on the right, find the fraction fx that returns the closest value to the midpoint 127.5.',
        check: (st) => st.getInput('t00') === 0 && st.getInput('t10') === 0 && st.getInput('t01') === 255 && st.getInput('t11') === 255 && st.value('y') === 127,
        hints: ['fx is in sixteenths: fx = 8 is half way.', 'y = 255 · fx / 16, rounded down.'],
        answer: `fx = 8: y = (255 · 8) >> 4 = ${bilinearRef(0, 255, 0, 255, 8, 0)}. The truncation costs half a level; fx = 9 would give ${bilinearRef(0, 255, 0, 255, 9, 0)}.`,
        solve: (st) => st.setInputs({ t00: 0, t01: 255, t10: 0, t11: 255, fx: 8, fy: 0 }),
      },
    },
    {
      title: 'A faster clear',
      body: `
        <p>The clear writes the same colour into every pixel and the same far depth into every depth entry: it needs no edge functions, no tile walk,
        no depth test. <a href="#/c/pixels/0">Chapter ${numOf('pixels')}</a> let the rasterizer do it because the rasterizer was there, a pixel a cycle: 4438 of the triangle's 6144 cycles.</p>
        <p>The <span data-show="clear"><strong>clear unit</strong></span> is a 10-bit word counter, 278 NANDs. The <span data-show="cmd">command unit</span>
        starts it at launch, instead of the rasterizer, and it drives one word address a cycle with a write enable that reaches all four byte banks of the
        <span data-show="fb">back frame</span>: four RGB332 pixels a cycle, 1024 cycles a frame. The
        depth buffer takes the frame's shape, four banks of 1024 × 16 (pixel x mod 4), so four depths clear in the same cycle. Drawing still writes one
        pixel and one bank, picked by x mod 4. The banks cost the <span data-show="rop">depth test</span> 307 NANDs of multiplexers (1728 against 1421), and the command unit no longer
        steers the background colour into the rasterizer (1963 against 1997): about 580 NANDs of logic.</p>
        <p>The triangle's frame: the clear 1026 cycles, the triangle 1268, waiting for vsync 778, so 3072 cycles, three scan-outs instead of six. The cube's is
        4096 or 5120, four or five scan-outs (it was 7168 to 8192). The triangle's frame rate doubles, and the rasterizer's pixel a cycle now bounds the frame.</p>

        <div class="try">Switch the clear and run a few frames each way: the timeline gains a clear unit lane, and the triangle's frames per second double. Click the BACK
        frame under the screen: the clear now sweeps it four pixels at a time. Open the clear unit and watch its word count.</div>`,
      scene: () => pipelineScene('triangle', { clear: 'word', clearSwitch: true, highlight: ['clear', 'rop'] }),
      more: {
        derive: `<p>Clearing words instead of pixels: ${fmt(FRAME_BYTES)} pixels / ${SCREEN.perWord} per cycle = ${FRAME_WORDS} cycles, plus 2 to start, 1026. The frame is then clear + triangle = 1026 + 1268 = ${1026 + 1268} cycles of work, rounded up to ${snap(1026 + 1268)} (${snap(1026 + 1268) / FRAME_WORDS} scan-outs),
          against ${snap(4438 + 1268)} before: ${pct(snap(1026 + 1268), snap(4438 + 1268))} of the old time. The cube's two or three faces (2300 to 3200 cycles) plus the clear land in ${snap(1026 + 2300) / FRAME_WORDS} to ${snap(1026 + 3200) / FRAME_WORDS} scan-outs.</p>`,
        pitfall: `<p>A faster clear moves the bottleneck, it does not remove it: with the clear at ${FRAME_WORDS} cycles the rasterizer's one pixel a cycle bounds the frame, and a clear twice as fast would still save a scan-out here (3072 to 2048), but no clear at all would save no more: 1268 cycles of drawing still round up to 2048. Find the next limit before spending gates on this one.</p>`,
        real: `<p>Real GPUs go further: a clear only marks tiles as cleared, a bit each, and the colour is supplied when a tile is first read or written, so a clear
          costs a few cycles whatever the screen size. The price is that flag, checked by the depth test and the scan-out on every access.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'With the clear a word a cycle, what bounds the cube\'s frame?',
        options: ['The clear', 'The rasterizer: one pixel a cycle', 'The vertex kernel', 'The scan-out\'s word a cycle'], answer: 1,
        why: ['The clear is down to 1026 cycles, a quarter of the frame at most.', '', 'The cube\'s kernel is 109 cycles, hidden in the clear.', 'The scan-out reads while the frame is drawn; it only sets where a flip can fall.'],
        explain: 'The clear is 1026 cycles; drawing the cube\'s two or three faces takes the rest, and the frame snaps to the next scan-out: 4096 cycles, or 5120 when the faces cover more of the screen. Drawing faster takes more pixels a cycle: several rasterizers, each on its own tiles, as real GPUs have.',
      },
    },
  ],
};
