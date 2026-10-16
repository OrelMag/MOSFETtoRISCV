// A small WebGL2 renderer for the device close-ups and the machine hall: instanced unit meshes (box, cylinder),
// each instance moved, scaled, turned and coloured by its own record (gl/instances.ts); half-Lambert key light
// over a sky / ground ambient, a little specular, an emissive term; depth test, MSAA, device-pixel sized.
// Frames are drawn on demand (invalidate), never in a loop of their own. Loaded as its own chunk.

import { OrbitCamera } from './camera';
import { INSTANCE_ATTRS, INSTANCE_FLOATS, type RGB } from './instances';
import { norm3, type Vec3 } from './math';
import type { Mesh } from './mesh';
import { attachOrbit } from './orbit';

export interface BatchSpec {
  mesh: Mesh;
  /** Packed instance records (packInstances); `count` defaults to all of them. */
  data: Float32Array;
  count?: number;
  /** Drawn after the opaque batches, blended, without writing depth (glass). */
  transparent?: boolean;
}

export interface Lights {
  /** Ambient from above and from below (blended by the normal's height), and the key light's colour. */
  sky: RGB; ground: RGB; key: RGB;
  /** Direction towards the key light, in world space. */
  dir: Vec3;
}

export interface RendererOptions {
  /** Orbit controls on the canvas (default true). */
  controls?: boolean;
  /** After every drawn frame (HTML overlays re-project their anchors here). */
  onRender?: () => void;
  /** The context was lost (the page should show something else) / restored (drawing again). */
  onLost?: () => void;
  onRestored?: () => void;
  /** Device pixel ratio cap (default 2). */
  maxDpr?: number;
}

export interface Renderer {
  readonly camera: OrbitCamera;
  readonly canvas: HTMLCanvasElement;
  setScene(batches: BatchSpec[]): void;
  /** New instance data for batch i (same mesh). */
  updateBatch(i: number, data: Float32Array, count?: number): void;
  setLights(l: Partial<Lights>): void;
  /** Draw a frame on the next animation frame (once, however often it is called). */
  invalidate(): void;
  /** Draw now. */
  render(): void;
  /** A world point in CSS pixels of the canvas, or null behind the camera. */
  project(p: Vec3): [number, number] | null;
  destroy(): void;
}

const VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNor;
layout(location=2) in vec3 iPos;
layout(location=3) in vec3 iScale;
layout(location=4) in vec4 iRot;
layout(location=5) in vec4 iCol;
layout(location=6) in vec4 iMat;
uniform mat4 uVP;
out vec3 vN; out vec3 vW; out vec4 vC; out vec4 vM;
vec3 qrot(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
void main() {
  vec3 w = qrot(iRot, aPos * iScale) + iPos;
  vN = qrot(iRot, aNor / iScale);
  vW = w; vC = iCol; vM = iMat;
  gl_Position = uVP * vec4(w, 1.0);
}`;

// Lighting in linear light (colours arrive as sRGB), premultiplied alpha out.
const FS = `#version 300 es
precision highp float;
in vec3 vN; in vec3 vW; in vec4 vC; in vec4 vM;
uniform vec3 uSky, uGround, uKey, uDir, uEye;
out vec4 o;
vec3 lin(vec3 c) { return pow(c, vec3(2.2)); }
void main() {
  vec3 n = normalize(vN);
  float h = dot(n, uDir) * 0.5 + 0.5;
  vec3 amb = mix(lin(uGround), lin(uSky), n.y * 0.5 + 0.5);
  vec3 c = lin(vC.rgb) * (amb + lin(uKey) * h * h);
  vec3 hv = normalize(normalize(uEye - vW) + uDir);
  c += vM.w * lin(uKey) * pow(max(dot(n, hv), 0.0), 48.0);
  c += lin(vM.rgb);
  o = vec4(pow(c, vec3(1.0 / 2.2)) * vC.a, vC.a);
}`;

interface GpuMesh { vbo: WebGLBuffer; ibo: WebGLBuffer; count: number }
interface GpuBatch { spec: BatchSpec; vao: WebGLVertexArrayObject; ibuf: WebGLBuffer; count: number }

/** Null when WebGL2 is unavailable. */
export function createRenderer(canvas: HTMLCanvasElement, camera: OrbitCamera, opts: RendererOptions = {}): Renderer | null {
  const gl = canvas.getContext('webgl2', { antialias: true, alpha: true, premultipliedAlpha: true, powerPreference: 'low-power' });
  if (!gl) return null;

  let lights: Lights = { sky: [0.62, 0.64, 0.68], ground: [0.32, 0.31, 0.3], key: [0.85, 0.84, 0.8], dir: norm3([0.45, 0.8, 0.55]) };
  let specs: BatchSpec[] = [];
  let prog: WebGLProgram | null = null;
  let loc: Record<'vp' | 'sky' | 'ground' | 'key' | 'dir' | 'eye', WebGLUniformLocation | null> | null = null;
  let meshes = new Map<Mesh, GpuMesh>();
  let batches: GpuBatch[] = [];
  let lost = false, raf = 0, dead = false;
  let cssW = 1, cssH = 1;

  const compile = (type: number, src: string) => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error(`shader: ${gl.getShaderInfoLog(sh)}`);
    return sh;
  };

  const init = () => {
    const p = gl.createProgram()!, vs = compile(gl.VERTEX_SHADER, VS), fs = compile(gl.FRAGMENT_SHADER, FS);
    gl.attachShader(p, vs); gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs); gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(`program: ${gl.getProgramInfoLog(p)}`);
    prog = p;
    const u = (n: string) => gl.getUniformLocation(p, n);
    loc = { vp: u('uVP'), sky: u('uSky'), ground: u('uGround'), key: u('uKey'), dir: u('uDir'), eye: u('uEye') };
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    meshes = new Map();
    batches = specs.map(upload);
  };

  const meshOf = (m: Mesh): GpuMesh => {
    let g = meshes.get(m);
    if (!g) {
      const n = m.positions.length / 3, inter = new Float32Array(n * 6);
      for (let i = 0; i < n; i++) inter.set(m.positions.subarray(i * 3, i * 3 + 3), i * 6), inter.set(m.normals.subarray(i * 3, i * 3 + 3), i * 6 + 3);
      const vbo = gl.createBuffer()!, ibo = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, inter, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.indices, gl.STATIC_DRAW);
      g = { vbo, ibo, count: m.indices.length };
      meshes.set(m, g);
    }
    return g;
  };

  const upload = (spec: BatchSpec): GpuBatch => {
    const m = meshOf(spec.mesh), vao = gl.createVertexArray()!, ibuf = gl.createBuffer()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, m.vbo);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.ibo);
    gl.bindBuffer(gl.ARRAY_BUFFER, ibuf);
    gl.bufferData(gl.ARRAY_BUFFER, spec.data, gl.DYNAMIC_DRAW);
    INSTANCE_ATTRS.forEach((a, k) => {
      gl.enableVertexAttribArray(2 + k);
      gl.vertexAttribPointer(2 + k, a.size, gl.FLOAT, false, INSTANCE_FLOATS * 4, a.offset * 4);
      gl.vertexAttribDivisor(2 + k, 1);
    });
    gl.bindVertexArray(null);
    return { spec, vao, ibuf, count: spec.count ?? spec.data.length / INSTANCE_FLOATS };
  };

  const dropBatches = () => { for (const b of batches) { gl.deleteVertexArray(b.vao); gl.deleteBuffer(b.ibuf); } batches = []; };

  const resize = () => {
    const dpr = Math.min(opts.maxDpr ?? 2, window.devicePixelRatio || 1);
    cssW = Math.max(1, canvas.clientWidth); cssH = Math.max(1, canvas.clientHeight);
    const w = Math.round(cssW * dpr), h = Math.round(cssH * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  };

  const render = () => {
    if (lost || dead || !prog || !loc) return;
    resize();
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(prog);
    gl.uniformMatrix4fv(loc.vp, false, camera.viewProj(cssW / cssH));
    gl.uniform3fv(loc.sky, lights.sky); gl.uniform3fv(loc.ground, lights.ground); gl.uniform3fv(loc.key, lights.key);
    gl.uniform3fv(loc.dir, norm3(lights.dir)); gl.uniform3fv(loc.eye, camera.eye());
    for (const pass of [false, true]) {
      if (pass) { gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false); }
      for (const b of batches) {
        if (!!b.spec.transparent !== pass || !b.count) continue;
        gl.bindVertexArray(b.vao);
        gl.drawElementsInstanced(gl.TRIANGLES, meshOf(b.spec.mesh).count, gl.UNSIGNED_SHORT, 0, b.count);
      }
      if (pass) { gl.disable(gl.BLEND); gl.depthMask(true); }
    }
    gl.bindVertexArray(null);
    opts.onRender?.();
  };

  const invalidate = () => {
    if (raf || lost || dead) return;
    raf = requestAnimationFrame(() => { raf = 0; render(); });
  };

  const onLost = (e: Event) => {
    e.preventDefault(); // lets the browser restore the context
    lost = true;
    cancelAnimationFrame(raf); raf = 0;
    opts.onLost?.();
  };
  const onRestored = () => {
    lost = false;
    init();
    opts.onRestored?.();
    invalidate();
  };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);
  const detach = opts.controls === false ? () => {} : attachOrbit(canvas, camera, invalidate);
  const ro = new ResizeObserver(invalidate);
  ro.observe(canvas);
  init();

  return {
    camera, canvas, render, invalidate,
    setScene(list) {
      specs = list;
      if (lost) return;
      dropBatches();
      batches = list.map(upload);
      invalidate();
    },
    updateBatch(i, data, count) {
      const spec = specs[i];
      if (!spec) return;
      spec.data = data; spec.count = count;
      const b = batches[i];
      if (lost || !b) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, b.ibuf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      b.count = count ?? data.length / INSTANCE_FLOATS;
      invalidate();
    },
    setLights(l) { lights = { ...lights, ...l }; invalidate(); },
    project(p) { return camera.project(p, cssW, cssH); },
    destroy() {
      if (dead) return;
      dead = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      detach();
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      if (!lost) {
        dropBatches();
        for (const m of meshes.values()) { gl.deleteBuffer(m.vbo); gl.deleteBuffer(m.ibo); }
        if (prog) gl.deleteProgram(prog);
        // Free the context now rather than at garbage collection: browsers keep only a few alive per page.
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      }
    },
  };
}

// The chunk's other entry points, so a page loads the whole renderer with one import().
export { OrbitCamera } from './camera';
export { boxMesh, cylinderMesh } from './mesh';
