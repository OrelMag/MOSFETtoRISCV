// Chapter 32's vertex kernels and their data: a mesh (model vertices, triangles), a sine table, two vertex
// buffers. The kernel runs on one warp of four lanes with multipliers, one thread a vertex: it rotates the
// model by the frame's angle in 16.16 fixed point and packs each screen vertex into one word for the command
// unit (lib/gfxpipe.ts), which reads the triangles and the vertex buffer from the same memory.
//
// Data memory (words; 128 of them):
//   0 f, the frame number      1 NV, vertices (a multiple of 4: every lane takes as many)    2 NT, triangles
//   3, 4 cos, sin of the cube's tilt (16.16)
//   8 + 3i  vertex i of the model: x, y, z in quarter pixels around the screen's centre (signed)
//   32 … 95  sin(2πk / 64) in 16.16 (cos θ is sin at k + 16)
//   96 … 103, 104 … 111  vertex buffers 0 and 1: frame f's vertices go to buffer f mod 2, packed x | y << 8 | z << 16
//   112 + t  triangle t: i0 | i1 << 4 | i2 << 8 | colour << 16 (RGB332)

export const GFX_DMEM_K = 7;
export const GFX = { frame: 0, nv: 1, nt: 2, tilt: 3, model: 8, sin: 32, vbuf: 96, tri: 112 } as const;
/** Fixed point of the angles and the rotation: 16 fraction bits. */
export const FRAC = 16;
/** Frames per turn (the sine table's length). */
export const TURN = 64;
/** The background the command unit clears to (RGB332, dark blue). */
export const BG = 0x25;

/** sin(2πk / 64) in 16.16, rounded. */
export const SIN = Array.from({ length: TURN }, (_, k) => Math.round(Math.sin((2 * Math.PI * k) / TURN) * 2 ** FRAC));

export type V3 = [number, number, number];
export interface Tri { i: [number, number, number]; col: number }

export interface Mesh {
  id: 'triangle' | 'cube';
  title: string;
  verts: V3[];
  tris: Tri[];
  /** The depth test is on. */
  zt: boolean;
  /** The cube's tilt toward the viewer, as a k of the sine table (0: none). */
  tilt: number;
}

const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Order a triangle so that it is a front face (clockwise on the screen, y down) when n, its outward normal, points at the viewer (−z). */
function facing(v: V3[], i: [number, number, number], n: V3): [number, number, number] {
  const c = cross(sub(v[i[1]], v[i[0]]), sub(v[i[2]], v[i[0]]));
  // the rasterizer's front: twice the area = cross.z > 0 with n.z < 0, so the cross product points against n
  return dot(c, n) < 0 ? i : [i[0], i[2], i[1]];
}

/** An equilateral triangle of radius 100 quarter pixels (25 pixels), spinning in the screen's plane; a fourth vertex pads NV to 4. */
const TRIANGLE: Mesh = (() => {
  const verts: V3[] = [0, 1, 2].map((k) => {
    const a = (2 * Math.PI * k) / 3 - Math.PI / 2;
    return [Math.round(100 * Math.cos(a)), Math.round(100 * Math.sin(a)), 0] as V3;
  });
  verts.push([0, 0, 0]);
  return { id: 'triangle', title: 'A spinning triangle', verts, tris: [{ i: facing(verts, [0, 1, 2], [0, 0, -1]), col: 0xfc }], zt: false, tilt: 0 };
})();

/** A cube of side 112 quarter pixels (28 pixels), spinning about the vertical axis, tilted toward the viewer; a face a colour. */
const CUBE: Mesh = (() => {
  const S = 56;
  // vertex b: x = ±S by bit 0, y by bit 1, z by bit 2
  const verts: V3[] = Array.from({ length: 8 }, (_, b) => [b & 1 ? S : -S, b & 2 ? S : -S, b & 4 ? S : -S] as V3);
  const faces: { axis: number; side: number; col: number }[] = [
    { axis: 0, side: 1, col: 0xe0 }, { axis: 0, side: 0, col: 0x1c }, { axis: 1, side: 0, col: 0xfc },
    { axis: 1, side: 1, col: 0xe3 }, { axis: 2, side: 0, col: 0x1f }, { axis: 2, side: 1, col: 0xf4 },
  ];
  const tris: Tri[] = [];
  for (const f of faces) {
    const [u, w] = [0, 1, 2].filter((a) => a !== f.axis);
    const at = (a: number, b: number) => (f.side << f.axis) | (a << u) | (b << w);
    const n: V3 = [0, 0, 0];
    n[f.axis] = f.side ? 1 : -1;
    const q = [at(0, 0), at(1, 0), at(1, 1), at(0, 1)];
    tris.push({ i: facing(verts, [q[0], q[1], q[2]], n), col: f.col }, { i: facing(verts, [q[0], q[2], q[3]], n), col: f.col });
  }
  return { id: 'cube', title: 'A spinning cube, depth on', verts, tris, zt: true, tilt: 5 };
})();

export const MESHES: Mesh[] = [TRIANGLE, CUBE];
export const meshById = (id: string) => MESHES.find((m) => m.id === id)!;

/** The data memory at power-on. */
export function meshData(m: Mesh): number[] {
  const d = new Array<number>(2 ** GFX_DMEM_K).fill(0);
  d[GFX.nv] = m.verts.length;
  d[GFX.nt] = m.tris.length;
  d[GFX.tilt] = SIN[(m.tilt + TURN / 4) % TURN];
  d[GFX.tilt + 1] = SIN[m.tilt];
  m.verts.forEach((v, i) => v.forEach((c, j) => { d[GFX.model + 3 * i + j] = c >>> 0; }));
  SIN.forEach((s, k) => { d[GFX.sin + k] = s >>> 0; });
  m.tris.forEach((t, k) => { d[GFX.tri + k] = t.i[0] | (t.i[1] << 4) | (t.i[2] << 8) | (t.col << 16); });
  return d;
}

const B = (w: number) => 4 * w;

/** The rotation of one vertex (x, y, z in a0 … a2) into screen coordinates a3, a4, a5. */
const TRANSFORM: Record<Mesh['id'], string> = {
  triangle: `        mul   a3, a0, s3         # x·cos θ
        mul   a4, a1, s2         # y·sin θ
        sub   a3, a3, a4
        srai  a3, a3, 16
        addi  a3, a3, 128        # X = 128 + x cos θ − y sin θ
        mul   a4, a0, s2         # x·sin θ
        mul   a5, a1, s3         # y·cos θ
        add   a4, a4, a5
        srai  a4, a4, 16
        addi  a4, a4, 128        # Y = 128 + x sin θ + y cos θ
        addi  a5, a2, 128        # Z = 128 + z`,
  cube: `        mul   a3, a0, s3         # spin about the vertical axis: x·cos θ
        mul   a4, a2, s2         # z·sin θ
        add   a3, a3, a4
        srai  a3, a3, 16         # x1 = x cos θ + z sin θ
        mul   a4, a2, s3
        mul   a5, a0, s2
        sub   a4, a4, a5
        srai  a4, a4, 16         # z1 = z cos θ − x sin θ
        mul   a5, a1, s4         # then the tilt, about the horizontal axis
        mul   a6, a4, s5
        sub   a5, a5, a6
        srai  a5, a5, 16         # y2 = y cos φ − z1 sin φ
        mul   a6, a1, s5
        mul   a7, a4, s4
        add   a6, a6, a7
        srai  a6, a6, 16         # z2 = y sin φ + z1 cos φ
        addi  a3, a3, 128        # X
        addi  a4, a5, 128        # Y
        addi  a5, a6, 128        # Z`,
};

/** The vertex kernel: every thread takes vertices tid, tid + 4, …; the last thing it does is count the frame. */
export function vertexKernel(m: Mesh): string {
  return `# vertex kernel (${m.id}): one thread a vertex, 4 lanes
        csrr  t0, tid            # i = tid
        lw    s0, ${B(GFX.frame)}(x0)          # f, the frame number
        lw    s1, ${B(GFX.nv)}(x0)          # NV vertices, a multiple of 4
        lw    s4, ${B(GFX.tilt)}(x0)         # cos φ, sin φ: the tilt
        lw    s5, ${B(GFX.tilt + 1)}(x0)
        andi  t1, s0, 63
        slli  t1, t1, 2
        lw    s2, ${B(GFX.sin)}(t1)        # sin θ = sin[f mod 64]
        addi  t1, s0, 16
        andi  t1, t1, 63
        slli  t1, t1, 2
        lw    s3, ${B(GFX.sin)}(t1)        # cos θ = sin[(f + 16) mod 64]
        andi  t2, s0, 1
        slli  t2, t2, 5
        addi  t2, t2, ${B(GFX.vbuf)}        # this frame's vertex buffer
loop:   slli  t3, t0, 1
        add   t3, t3, t0
        slli  t3, t3, 2          # 12·i
        lw    a0, ${B(GFX.model)}(t3)         # the model's x, y, z
        lw    a1, ${B(GFX.model + 1)}(t3)
        lw    a2, ${B(GFX.model + 2)}(t3)
${TRANSFORM[m.id]}
        slli  a4, a4, 8
        slli  a5, a5, 16
        or    a3, a3, a4
        or    a3, a3, a5
        slli  t4, t0, 2
        add   t4, t4, t2
        sw    a3, 0(t4)          # x | y << 8 | z << 16
        addi  t0, t0, 4
        blt   t0, s1, loop       # every lane the same number of times
        addi  s0, s0, 1
        sw    s0, ${B(GFX.frame)}(x0)          # the next frame (every lane stores the same)
end:    j     end`;
}

/** Frame f's screen vertices [X, Y, Z], each 0 … 255, exactly as the kernel computes them. */
export function transformed(m: Mesh, f: number): V3[] {
  const s = SIN[f % TURN], c = SIN[(f + TURN / 4) % TURN];
  const ct = SIN[(m.tilt + TURN / 4) % TURN], st = SIN[m.tilt];
  const mul = Math.imul, sh = (v: number) => (v | 0) >> FRAC;
  return m.verts.map(([x, y, z]) => {
    if (m.id === 'triangle') return [128 + sh(mul(x, c) - mul(y, s)), 128 + sh(mul(x, s) + mul(y, c)), 128 + z];
    const x1 = sh(mul(x, c) + mul(z, s)), z1 = sh(mul(z, c) - mul(x, s));
    return [128 + x1, 128 + sh(mul(y, ct) - mul(z1, st)), 128 + sh(mul(y, st) + mul(z1, ct))];
  });
}

/** A packed vertex-buffer word. */
export const packVertex = (v: V3) => v[0] | (v[1] << 8) | (v[2] << 16);

// ---- the same frame in software (chapter 32, "Where the gates go") ---------------------------------------
//
// Two kernels for chapter 29's core (four warps of four lanes, multipliers): a clear, then one triangle by the
// same edge functions and top-left rule as the rasterizer, so the picture is the same byte for byte. Data
// memory: the triangle at words 0 … 6 (v0x, v0y, v1x, v1y, v2x, v2y in quarter pixels, the colour), the 64 × 64
// frame at byte SOFT_FB + 64·y + x. Thread tid takes the columns x ≡ px0 + tid (mod 16) of the bounding box;
// a column is a split (lanes past the box sit it out), its rows a loop with the three E stepped by 4B.

export const SOFT_FB = 64;
export const SOFT_DMEM_WORDS = 2048;

/** Warp 0 starts the other three; then t0 = tid. */
const SOFT_START = `        csrr  t0, nwarps
        la    t1, start
        wspawn t0, t1           # warps 1 … 3 begin at start
start:  csrr  t0, tid`;

/** Every word of the frame ← the background, four pixels a store. */
export const SOFT_CLEAR = `# clear: thread tid stores words tid, tid + 16, …
${SOFT_START}
        li    a0, ${BG * 0x01010101}
        slli  t1, t0, 2
        addi  t1, t1, ${SOFT_FB}
        li    t3, ${SOFT_FB + 4096}
clr:    sw    a0, 0(t1)
        addi  t1, t1, 64         # 16 threads × 4 bytes
        blt   t1, t3, clr
end:    j     end`;

/** One triangle: set-up in every thread (the same values, so its branches are uniform), then the pixels. */
export const SOFT_TRIANGLE = `# one triangle by edge functions, 16 threads
${SOFT_START}
        lw    s0, 0(x0)          # v0x, v0y, v1x, v1y, v2x, v2y, colour
        lw    s1, 4(x0)
        lw    s2, 8(x0)
        lw    s3, 12(x0)
        lw    s4, 16(x0)
        lw    s5, 20(x0)
        lw    s6, 24(x0)
        sub   a0, s1, s3         # A0 = v0y − v1y
        sub   a1, s2, s0         # B0 = v1x − v0x
        sub   a2, s3, s5         # A1
        sub   a3, s4, s2         # B1
        sub   a4, s5, s1         # A2
        sub   a5, s0, s4         # B2
        sub   t1, s4, s0
        mul   t1, a0, t1
        sub   t2, s5, s1
        mul   t2, a1, t2
        add   t1, t1, t2         # twice the area
        blez  t1, end            # a back face: nothing
        mv    t1, s0             # the box: min and max x
        mv    t2, s0
        bge   s2, t1, bx1
        mv    t1, s2
bx1:    ble   s2, t2, bx2
        mv    t2, s2
bx2:    bge   s4, t1, bx3
        mv    t1, s4
bx3:    ble   s4, t2, bx4
        mv    t2, s4
bx4:    addi  s7, t1, 1
        srai  s7, s7, 2          # px0 = (min + 1) >> 2: the first centre at or right of min
        addi  s8, t2, -2
        srai  s8, s8, 2          # px1 = (max − 2) >> 2
        mv    t1, s1             # min and max y
        mv    t2, s1
        bge   s3, t1, by1
        mv    t1, s3
by1:    ble   s3, t2, by2
        mv    t2, s3
by2:    bge   s5, t1, by3
        mv    t1, s5
by3:    ble   s5, t2, by4
        mv    t2, s5
by4:    addi  s9, t1, 1
        srai  s9, s9, 2          # py0
        addi  s10, t2, -2
        srai  s10, s10, 2        # py1
        sub   s10, s10, s9
        addi  s10, s10, 1        # rows
        blez  s10, end
        sub   s11, s8, s7
        addi  s11, s11, 16
        srai  s11, s11, 4        # column passes: ⌈(px1 − px0 + 1) / 16⌉
        add   s7, s7, t0         # this thread's first column
        slli  t3, s7, 2
        addi  t3, t3, 2          # its centre, 4x + 2
        slli  t4, s9, 2
        addi  t4, t4, 2          # the first row's centre
        # E_i at (x, y) = A_i (cx − v_i.x) + B_i (cy − v_i.y) − bias_i; bias_i = 0 for a left or top edge
${[0, 1, 2].map((i) => {
    const [A, B, vx, vy] = [`a${2 * i}`, `a${2 * i + 1}`, `s${2 * i}`, `s${2 * i + 1}`];
    return `        sub   t5, t3, ${vx}
        mul   t5, ${A}, t5
        sub   t6, t4, ${vy}
        mul   t6, ${B}, t6
        add   t5, t5, t6
        slt   t6, x0, ${A}          # left: A > 0
        seqz  t1, ${A}
        slt   t2, x0, ${B}
        and   t1, t1, t2         # top: A = 0, B > 0
        or    t6, t6, t1
        xori  t6, t6, 1
        sub   ${['ra', 'sp', 'gp'][i]}, t5, t6         # E${i} at the first pixel`;
  }).join('\n')}
        slli  s0, a0, 6          # a column pass: 16 pixels right, E += 64A
        slli  s1, a2, 6
        slli  s2, a4, 6
        slli  a0, a1, 2          # a row down: E += 4B
        slli  a1, a3, 2
        slli  a2, a5, 2
        slli  a3, s9, 6
        add   a3, a3, s7
        addi  a3, a3, ${SOFT_FB}         # the first pixel's address
col:    blez  s11, end
        slt   t3, s8, s7         # past the box?
        xori  t3, t3, 1
        split t3                 # the lanes inside the box run the column
        beqz  t3, next
        mv    a4, ra
        mv    a5, sp
        mv    a6, gp
        mv    a7, a3
        mv    t1, s10
row:    or    t4, a4, a5
        or    t4, t4, a6
        srai  t4, t4, 31         # −1 when some edge is negative: outside
        lbu   t5, 0(a7)
        xor   t2, t5, s6
        and   t2, t2, t4
        xor   t2, t2, s6         # inside: the colour, else what was there
        sb    t2, 0(a7)
        add   a4, a4, a0
        add   a5, a5, a1
        add   a6, a6, a2
        addi  a7, a7, 64
        addi  t1, t1, -1
        bgtz  t1, row
next:   join
        add   ra, ra, s0
        add   sp, sp, s1
        add   gp, gp, s2
        addi  s7, s7, 16
        addi  a3, a3, 16
        addi  s11, s11, -1
        j     col
end:    j     end`;

/** The software kernels' data: a triangle (frame f of a one-triangle mesh) and nothing in the frame yet. */
export function softData(v: V3[], col: number): number[] {
  const d = new Array<number>(SOFT_DMEM_WORDS).fill(0);
  v.forEach((p, i) => { d[2 * i] = p[0]; d[2 * i + 1] = p[1]; });
  d[6] = col;
  return d;
}
