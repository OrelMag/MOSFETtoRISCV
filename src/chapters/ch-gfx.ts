import { costWidget, pipelineScene } from '../widgets/gfxpipe';
import { drawScene } from '../widgets/drawpad';
import { depthScene, displayScene, edgeWidget, gpuScene } from '../widgets/screen';
import { warpCoreScene } from '../widgets/warps';
import type { Chapter } from './types';

export const chPixels: Chapter = {
  id: 'pixels', num: 30, title: 'Pixels and triangles', level: 'Throughput',
  blurb: 'A framebuffer scanned out to the screen, double buffering and vsync; edge functions in fixed point, a rasterizer that walks a triangle in tiles, one pixel a cycle; a depth buffer and blending; your own drawing, cut into triangles.',
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
        <div class="try">Draw, and watch the back frame fill (click the BACK frame under the screen: what it held before stays dimmed until something writes it). Swap to put it on the screen. Then try the sliver, and the
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
    {
      title: 'Your own picture',
      body: `
        <p>The rasterizer draws triangles and nothing else, so everything else is cut into triangles before it reaches the GPU, by the driver or a
        tessellation stage. The pad does it in TypeScript, the way a driver would:</p>
        <ul>
          <li><strong>Polygon</strong>: <strong>ear clipping</strong>. A convex corner whose triangle holds no other corner is an ear; cut it off and
          repeat. n corners give n − 2 triangles, O(n²) work. An outline that crosses itself runs out of ears, and the rest is fanned.</li>
          <li><strong>Brush</strong>: the path is thinned (Ramer–Douglas–Peucker, half a pixel), then each point is pushed out both ways along its
          <strong>mitre</strong>, the bisector of its two segments' normals. Neighbouring segments share their edges: a triangle strip, two triangles a
          segment.</li>
          <li><strong>Triangle</strong>: sent as it is. Clicked counter-clockwise it is a back face, so the pad turns it round, unless you tick "keep my
          winding".</li>
        </ul>
        <p>Each shape gets a depth of its own, nearer than every shape before it, and the depth test is on. Shapes cover each other in the order they were
        drawn. Where two triangles of one shape overlap (a stroke crossing itself, a fanned outline), the second fails "nearer", so the pixel is blended
        once: a translucent stroke has no darker knots where it crosses itself.</p>
        <p>Cost: the house is 7 shapes, 25 triangles and 2 136 pixel writes, 6 453 cycles after the 4 437-cycle clear. Every triangle spends 85 cycles before
        its first tile, mostly on depth's division: 2 125 of the 6 453 here. A scribble of short segments is almost all set-up. That is why a GPU has
        several set-up units, and why meshes are not cut finer than the pixels need. The scene runs on the cycle engine, and the screen is compared
        pixel for pixel with the reference rasterizer's picture of the same triangles.</p>
        <div class="try">Draw something, then Send to the GPU; click the BACK frame under the screen to watch the clear sweep it and the triangles land. Tick "show triangles"
        to see what was sent. Then tick "keep my winding" and click a triangle counter-clockwise.</div>`,
      scene: drawScene,
      challenge: {
        kind: 'quiz', question: 'You draw a polygon with 12 corners. How many triangles does the rasterizer receive, and what does each one cost before its first pixel?',
        options: ['12 triangles, nothing: set-up is shared', '10 triangles, 85 cycles each', '10 triangles, 8 cycles each', '1 polygon, 85 cycles'], answer: 1,
        explain: 'Ear clipping turns n corners into n − 2 triangles, and each is a separate draw for the rasterizer: its own set-up, here 85 cycles with the depth division, before the first tile test.',
      },
    },
  ],
};

export const chGfxPipeline: Chapter = {
  id: 'graphics', num: 31, title: 'The graphics pipeline', level: 'Throughput',
  blurb: 'A vertex kernel on the warp core, a command unit feeding the rasterizer, the frames double-buffered: a spinning triangle and a cube at gate level, and where the gates and cycles go.',
  steps: [
    {
      title: 'Vertices are a kernel',
      body: `
        <p>Every vertex of a mesh goes through the same arithmetic, independently of the others: rotate it, place it on the screen. That is a
        <strong>kernel</strong>, one thread a vertex, on chapter 28's warp core: here one warp of four lanes with chapter 29's multipliers.</p>
        <p>Fixed point, <strong>16.16</strong>: sin θ comes from a table of 64 entries (a turn in 64 frames), cos θ is the same table a quarter turn on.
        Model coordinates are quarter pixels around the centre (|x| ≤ 100), so x·cos θ stays below 2<sup>24</sup>: <code>mul</code>'s low word is the whole
        product and <code>srai 16</code> drops the fraction. Then</p>
        <p class="eq">X = 128 + (x cos θ − y sin θ) &gt;&gt; 16<br>Y = 128 + (x sin θ + y cos θ) &gt;&gt; 16</p>
        <p>and the thread packs X | Y &lt;&lt; 8 | Z &lt;&lt; 16 into one word of the <strong>vertex buffer</strong>, buffer f mod 2 for frame f. The triangle has a
        fourth, unused vertex so that every lane runs the loop the same number of times: a uniform branch needs no split. One frame is 44 instructions,
        60 cycles. The cube (eight vertices, a spin then a fixed tilt toward the viewer: eight multiplies a vertex) is 86 instructions, 109 cycles.</p>
        <p>Cost: each lane is 35 255 NANDs, multiplier included; the core is 182 214 without its memories.</p>
        <div class="try">Run to halt, then switch to the cube's kernel. The vertex buffer is at word 96: one packed word a vertex.</div>`,
      scene: () => warpCoreScene('vertexTri', { warps: 1, highlight: ['lane0', 'lane1', 'lane2', 'lane3'], programs: ['vertexTri', 'vertexCube'] }),
      challenge: {
        kind: 'quiz', question: 'Why does the triangle carry a fourth vertex that no triangle uses?',
        options: ['The rasterizer needs four vertices', 'So that all four lanes loop the same number of times: the loop\'s branch stays uniform', 'To keep the vertex buffer aligned to 16 bytes', 'The multipliers work in pairs'], answer: 1,
        explain: 'With three vertices on four lanes, lane 3 would leave the loop while the others stay: a divergent branch, which needs split and join. Padding to a multiple of the lane count keeps every branch uniform, at the cost of one wasted lane-pass.',
      },
    },
    {
      title: 'The pipeline',
      body: `
        <p>Six blocks, the first one programmable: the warp core running the vertex kernel, the <strong>command unit</strong>, chapter 30's rasterizer with its
        depth set-up, the depth test and blend, the two frames and the scan-out. The command unit (1 997 NANDs, one flip-flop a state) runs every frame:</p>
        <ul>
          <li><strong>launch</strong>: start the kernel on the <em>next</em> frame (warp 0 back to PC 0, every lane on) and, in the same cycle, start the
          clear of the back frame;</li>
          <li>read the triangle count, then per triangle its word (three vertex indices, a colour) and its three vertices from this frame's vertex buffer:
          four reads on a spare read port of the core's memory, then <strong>go</strong>, and wait while the rasterizer is busy;</li>
          <li><strong>swap</strong>, then wait for the flip at vsync and for the kernel; the next frame reads the other vertex buffer.</li>
        </ul>
        <p>The vertex buffer is double-buffered like the framebuffer, so the kernel computes frame f + 1 while frame f is drawn. A real command processor
        does the same over the memory system: it reads command buffers, launches kernels and waits on fences.</p>
        <p>The triangle's frame is 6 144 cycles: the clear 4 438, the triangle 1 268, waiting for vsync 438; the kernel's 60 cycles hide inside the clear.
        A frame ends at a flip, and flips happen only at vsync, every 1 024 cycles: the frame time snaps to six scan-outs.</p>
        <div class="try">One frame, then read the timeline: who works when. Click the BACK frame under the screen and step through a frame: the clear sweeps away the picture from two frames ago, then each triangle lands, and the two vertex buffers trade roles. Open the command unit and watch its state register.</div>`,
      scene: () => pipelineScene('triangle', { highlight: ['cmd'] }),
      challenge: {
        kind: 'quiz', question: 'The vertex kernel is busy 60 cycles of a 6 144-cycle frame. What would a second warp core gain?',
        options: ['Twice the frame rate', 'Nothing: the frame is spent clearing and rasterizing', 'Half the vsync wait', 'Room for the depth test'], answer: 1,
        explain: 'The kernel already finishes during the clear, a frame ahead of its use. The frame is bound by the clear (4 438 cycles) and the rasterizer (one pixel a cycle); more vertex throughput changes nothing until the mesh is far larger.',
      },
    },
    {
      title: 'A spinning triangle',
      body: `
        <p>Run: every gate of the pipeline is simulated, 413 594 leaves (gates and memory blocks). This scene runs on the <strong>cycle engine</strong>: the
        same settled values after every clock edge as the event-driven simulator, flip-flops as tables, several times faster; it has no gate delays, so
        probes and the timing diagram are off here. The panel measures frames per second in this page: a few (about three for the triangle on the machine
        this was written on), for a frame that a 1 GHz chip would draw in 6 µs.</p>
        <p>Nothing is taken on trust. The vertex kernel runs in lock-step with its golden model, its vertex buffer is compared when the command unit starts
        reading it, and every frame is compared, pixel for pixel, with the reference rasterizer's picture of the same vertices.</p>
        <p>Then the cube: twelve triangles, a colour a face. Half of them face away, so set-up culls them after three cycles (twice their area is negative).
        For a single convex solid that alone hides everything behind; depth is on all the same, and earns its 76 set-up cycles per triangle only where
        solids overlap. Its frames take 7 168 to 8 192 cycles: two or three faces, 2 300 to 3 000 cycles of drawing.</p>
        <div class="try">Run for a few frames, then pick the cube. Pause and open the rasterizer: its tile walk is wherever the timeline says.</div>`,
      scene: () => pipelineScene('triangle', { highlight: ['core', 'rast'] }),
      challenge: {
        kind: 'quiz', question: 'A cube is convex. Which triangles would be drawn wrongly with the depth test off?',
        options: ['None: back-face culling already removes every hidden face', 'The faces seen at a grazing angle', 'Every triangle drawn after the first', 'Pixels on shared edges'], answer: 0,
        explain: 'On a convex solid every face that points away is hidden and every face that points toward the viewer is fully visible, so culling alone gives the right picture. Two solids, or a concave one, need the depth test.',
      },
    },
    {
      title: 'Where the gates go',
      body: `
        <p>The programmable part is the largest and the idlest: 182 214 NANDs of warp core, busy 1 % of the frame. The rasterizer, a seventh of its
        size, is busy most of it. Real GPUs answer with <strong>unified shaders</strong>: vertex and pixel work run on the same lanes, so the lanes never
        wait for a kind of work that is not there; edge stepping, the depth test and blending stay fixed-function, because per pixel they are a handful
        of adders.</p>
        <p>The surprise is the clear: 72 % of the triangle's frame, one pixel a cycle. The same 16 threads clear the frame in software in 804 cycles,
        four pixels per store. Real GPUs never clear pixel by pixel: they mark tiles as cleared (fast clear) and supply the colour when a tile is first
        read. Drawing goes the other way: the software kernel takes 6 825 cycles for the triangle the rasterizer draws in 1 268, on chapter 28's four-warp core, whose logic alone is 488 609 NANDs: matching the rasterizer in software would take five or six of them,
        against 26 708.</p>
        <p>Scaled to 1920 × 1080, this design would spend two million cycles a frame on the clear alone.</p>`,
      widget: costWidget,
      challenge: {
        kind: 'quiz', question: 'Which change halves the triangle\'s frame time?',
        options: ['A second warp core', 'Clearing four pixels a cycle', 'A faster vertex kernel', 'Flipping without waiting for vsync'], answer: 1,
        explain: 'The clear falls from 4 438 cycles to 1 026 (the next step builds it), so the frame snaps to three scan-outs: 3 072 cycles instead of 6 144. The kernel is hidden in the clear already; flipping without vsync saves at most one scan-out, and tears.',
      },
    },
    {
      title: 'A faster clear',
      body: `
        <p>The clear writes the same colour into every pixel and the same far depth into every depth entry: it needs no edge functions, no tile walk,
        no depth test. Chapter 30 let the rasterizer do it because the rasterizer was there, a pixel a cycle: 4 438 of the triangle's 6 144 cycles.</p>
        <p>The <strong>clear unit</strong> is a 10-bit word counter, 278 NANDs. The command unit starts it at launch, instead of the rasterizer, and it drives one
        word address a cycle with a write enable that reaches all four byte banks of the back frame: four RGB332 pixels a cycle, 1 024 cycles a frame. The
        depth buffer takes the frame's shape, four banks of 1 024 × 16 (pixel x mod 4), so four depths clear in the same cycle. Drawing still writes one
        pixel and one bank, picked by x mod 4. The banks cost the depth test 307 NANDs of multiplexers (1 728 against 1 421), and the command unit no longer
        steers the background colour into the rasterizer (1 963 against 1 997): about 580 NANDs in all.</p>
        <p>The triangle's frame: the clear 1 026 cycles, the triangle 1 268, waiting for vsync 778, so 3 072 cycles, three scan-outs instead of six. The cube's is
        4 096 or 5 120, four or five scan-outs (it was 7 168 to 8 192). The triangle's frame rate doubles, and the rasterizer's pixel a cycle now bounds the frame.</p>
        <p>Real GPUs go further: a clear only marks tiles as cleared, a bit each, and the colour is supplied when a tile is first read or written, so a clear
        costs a few cycles whatever the screen size. The price is that flag, checked by the depth test and the scan-out on every access.</p>
        <div class="try">Switch the clear and run a few frames each way: the timeline gains a clear unit lane, and the triangle's frames per second double. Click the BACK
        frame under the screen: the clear now sweeps it four pixels at a time. Open the clear unit and watch its word count.</div>`,
      scene: () => pipelineScene('triangle', { clear: 'word', clearSwitch: true, highlight: ['clear', 'rop'] }),
      challenge: {
        kind: 'quiz', question: 'With the clear a word a cycle, what bounds the cube\'s frame?',
        options: ['The clear', 'The rasterizer: one pixel a cycle', 'The vertex kernel', 'The scan-out\'s word a cycle'], answer: 1,
        explain: 'The clear is 1 026 cycles; drawing the cube\'s two or three faces takes the rest, and the frame snaps to the next scan-out: 4 096 cycles, or 5 120 when the faces cover more of the screen. Drawing faster takes more pixels a cycle: several rasterizers, each on its own tiles, as real GPUs have.',
      },
    },
  ],
};
