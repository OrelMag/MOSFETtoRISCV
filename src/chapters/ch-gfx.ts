import { depthScene, displayScene, edgeWidget, gpuScene } from '../widgets/screen';
import type { Chapter } from './types';

export const chPixels: Chapter = {
  id: 'pixels', num: 30, title: 'Pixels and triangles', level: 'Throughput',
  blurb: 'A framebuffer scanned out to the screen, double buffering and vsync; edge functions in fixed point, a rasterizer that walks a triangle in tiles, one pixel a cycle; a depth buffer and blending.',
  steps: [
    {
      title: 'A frame in memory',
      body: `
        <p>A picture is an array in memory: here 64 × 64 pixels of one byte each, <strong>RGB332</strong> (3 bits of red, 3 of green, 2 of blue, the colour
        the eye resolves least). Pixel (x, y) is byte y·64 + x, 4 KB a frame. The bytes sit in four banks, bank x mod 4, so one word address names four
        neighbouring pixels.</p>
        <p>The <strong>scan-out</strong> sends the frame to the screen: a 10-bit counter steps through the words, one a cycle, 1 024 cycles a frame, and
        raises <strong>vsync</strong> on the last word. It is the one client of memory that can never wait: a 1920 × 1080 display at 60 Hz needs 124 million
        pixels a second whatever else is happening.</p>
        <p>Drawing into the frame the screen is reading shows half-drawn pictures. So there are two frames, the <strong>front</strong> one read by the scan-out
        and the <strong>back</strong> one drawn into, and <strong>swap</strong> exchanges them: two address multiplexers change sides, nothing is copied. The
        flip waits for vsync, so it falls between two frames. Without that wait the screen shows the top of one picture and the bottom of the other:
        <strong>tearing</strong>.</p>
        <p>Cost: the scan-out and flip logic are 256 NANDs. The two frames are 64 Kbit of flip-flops, 1.35 million NANDs as drawn, simulated as two
        lookups (open a bank to see its flip-flops); real framebuffers are DRAM.</p>
        <div class="try">Run, then Swap: the rings arrive with the next frame. Untick "wait for vsync" and Swap again mid-frame to see a tear.</div>`,
      scene: displayScene,
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
        <p>Widths: coordinates are 8 bits, so |E| ≤ 2·255² = 130 050 fits in 18 bits signed. And no multiplier per pixel: one pixel to the right adds 4A to E,
        one down adds 4B. The products are needed once per triangle, at the start.</p>
        <div class="try">Drag a vertex across the opposite edge: the area turns negative and nothing is drawn. Point at pixels on an edge to see the bias decide.</div>`,
      widget: edgeWidget,
      challenge: {
        kind: 'quiz', question: 'One pixel to the right, by how much does edge i\'s value change?',
        options: ['A_i', '4·A_i', '4·B_i', 'It depends on x'], answer: 1,
        explain: 'E is linear in p, and one pixel is 4 quarter-pixel units in x: E grows by 4·A_i whatever the pixel. That is why the walk needs adders only.',
      },
    },
    {
      title: 'Walking tiles',
      body: `
        <p>The <strong>rasterizer</strong> turns a triangle into pixel writes, one a cycle. Open it:</p>
        <ul>
          <li><strong>Set-up</strong> (6 389 NANDs): A and B by subtraction, the top-left bias, the bounding box by comparators, and eight products on one
          10 × 10 Booth multiplier (chapter 20, 1 601 NANDs) in eight cycles: twice the area (its sign culls), then each edge's value at the first tile.</li>
          <li>Three <strong>edge steppers</strong> (1 330 NANDs each): E, a register R for the start of the current band, one adder / subtractor whose operand
          is dx = 4A, dy = 4B or four times either (a wired shift), and a second adder for the tile test.</li>
          <li>The <strong>tile walk</strong> (753 NANDs): a state machine over the box in 4 × 4-pixel tiles.</li>
        </ul>
        <p>Each tile starts with one TEST cycle. Its best corner for edge i is E + 12·(A⁺ + B⁺), where A⁺ is A when positive, else 0; if any edge is negative
        there, no pixel of the tile can be inside and the walk jumps on (E += 4dx). Otherwise its 16 pixels follow, column by column, down, up, down, up,
        so the tile ends at its top-right pixel and the next tile is one step right. A row of tiles is a <strong>band</strong>; the next band starts from R.</p>
        <p>The large triangle: 1 369 pixels, 210 tiles tested, 106 walked, 1 914 cycles. Visiting its box pixel by pixel would take 3 368. A thin sliver gains
        more: 888 cycles against 3 848. A real GPU tests whole tiles of pixels in parallel and writes dozens a cycle; this one writes at most one, 11 989 NANDs
        in all.</p>
        <div class="try">Draw, and watch the back frame fill (choose "Back frame" in the panel). Swap to put it on the screen. Then try the sliver, and the
        back face: it stops after three set-up cycles.</div>`,
      scene: () => gpuScene('large'),
      challenge: {
        kind: 'quiz', question: 'The walk tests a tile and skips it. What is certain?',
        options: ['No pixel centre in the tile is inside the triangle', 'The tile is outside the bounding box', 'All three edges are negative at the tile\'s corners', 'The triangle is a back face'], answer: 0,
        explain: 'One edge is negative even at the tile\'s best corner, so it is negative at every pixel of the tile: none can be inside. The tile may well be inside the bounding box, and the other two edges can be positive.',
      },
    },
    {
      title: 'Depth',
      body: `
        <p>Draw two triangles that cross in depth and no order is right: each is in front of the other somewhere. The fix is per pixel. Every vertex gets a
        depth z (8 bits, 0 nearest), and a <strong>depth buffer</strong> keeps, for each pixel, the depth of what was drawn there. A pixel is written only
        if it is nearer than that, and then its depth is written too. The order of the triangles no longer matters.</p>
        <p>z is linear across the triangle, a plane like the edges: z = z<sub>0</sub> + Z<sub>x</sub>·Δx + Z<sub>y</sub>·Δy with
        Z<sub>x</sub> = (A<sub>0</sub>·(z<sub>2</sub> − z<sub>0</sub>) + A<sub>2</sub>·(z<sub>1</sub> − z<sub>0</sub>)) / 2·area (the barycentric weights,
        differentiated), Z<sub>y</sub> the same with B. So a fourth stepper walks it with the edges. Its <strong>depth set-up</strong> needs a division: four
        products on its own Booth multiplier, two divisions on chapter 20's non-restoring divider (30 bits, 32 cycles each) and ten shift-and-add steps for
        z at the first tile. That is 76 more cycles per triangle and 12 032 NANDs, more than the rest of the rasterizer; real GPUs share one set-up unit
        among many pixel pipelines.</p>
        <p>z has 12 fraction bits and the arithmetic is 32 bits that wrap: a thin sliver has a huge slope, and its z overflows far outside the triangle, but
        it is right at every pixel inside, to about a tenth of a z unit. The buffer keeps 16 bits a pixel. The ROP reads it at the pixel's address,
        compares and writes in the same cycle; clearing it walks every tile of the screen, 4 436 cycles, longer than drawing both triangles.</p>
        <div class="try">Draw these in both orders: the same picture, with the crossing line where the two depths are equal. Then with the depth test off: the
        last triangle covers the other.</div>`,
      scene: () => depthScene('depth'),
      challenge: {
        kind: 'quiz', question: 'The depth test is on. A pixel arrives with exactly the depth the buffer holds there. What happens?',
        options: ['It is written: it is not farther', 'It is not written: only nearer pixels pass', 'The colours are averaged', 'The rasterizer stalls'], answer: 1,
        explain: 'The comparator\'s output is "less than": equal does not pass, so the first triangle drawn at that depth keeps the pixel. Real APIs let the program choose the comparison (less, less-or-equal, …).',
      },
    },
    {
      title: 'Blending',
      body: `
        <p>Glass, smoke, a fading sprite: the new colour is mixed with the one already in the frame, out = src·α + dst·(1 − α), channel by channel. Here α
        comes in eighths: (s·(a + 1) + d·(7 − a)) / 8, six 4 × 4 array multipliers and three adders (1 074 NANDs); the division by 8 is wiring. The
        destination is the back frame's pixel at the same address, read and rewritten in one cycle.</p>
        <p>Unlike the depth test, blending is not commutative: red under a blue at 3/8 is a dark purple, the same blue under red is red. Renderers therefore
        draw the opaque surfaces first, with the depth test, then the translucent ones sorted back to front. And here the top-left rule pays: a pixel on
        an edge shared by two translucent triangles is blended once, not twice.</p>
        <div class="try">Draw these in both orders and compare the overlap.</div>`,
      scene: () => depthScene('blend'),
      challenge: {
        kind: 'quiz', question: 'Why are translucent surfaces drawn after the opaque ones, back to front?',
        options: ['Blending needs the depth buffer cleared', 'Each blend mixes with what is already in the frame, so what is behind must be there first', 'Translucent pixels are faster to draw', 'The top-left rule requires it'], answer: 1,
        explain: 'out = src·α + dst·(1 − α) reads dst: the surface behind must already be in the frame. Drawn the other way round, the far surface would be mixed over the near one.',
      },
    },
  ],
};
