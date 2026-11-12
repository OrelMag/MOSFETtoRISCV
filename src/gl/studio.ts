// The studio renderer (the proposed successor of gl/renderer.ts for the close-ups): real geometry from gl/kit/geo.ts,
// physically based materials (GGX specular, Schlick fresnel, a clear coat) lit by one key light with a soft shadow
// (a 3 × 3 PCF shadow map fitted to the model, redrawn only when the model or a knob changes, never for an orbit) and a
// procedural studio environment (sky to floor gradient, a softbox, a strip light) for reflections without textures;
// ACES tone mapping; 4 × MSAA into a renderbuffer, resolved by a blit. Glass is drawn in two passes: its far side
// blended, then its near side over a copy of the frame so far, bent along the surface normal (refraction-ish) and
// mixed with the reflection by fresnel. Cut planes remove a wedge of the cut items; their inner faces seen through the
// cut are shaded as a flat cap in the plane (closed meshes look solid, with no CSG and no stencil). A floor disc
// catches the shadow over the page's own background. Frames on demand, as before; every GPU object is rebuilt after
// a lost context. Loaded as its own chunk.

import { OrbitCamera } from './camera';
import { INSTANCE_ATTRS, INSTANCE_FLOATS, type RGB } from './instances';
import { mat4LookAt, mat4Mul, norm3, type Mat4, type Vec3 } from './math';
import { attachOrbit } from './orbit';
import { lathe, normalMatrix, type Geo } from './kit/geo';
import type { Colour, Material } from './kit/materials';
import { boundsOf, cutsAt, itemMatrix, type Item, type Knobs, type Model3 } from './kit/scene';

export interface StudioFlags {
  shadows: boolean; msaa: boolean; refraction: boolean; env: boolean; floor: boolean;
  /** MSAA samples when msaa is on (default: 4, or 2 on a screen of 2 device pixels per CSS pixel or more, where the
   *  pixels are already small); shadow filter taps 9 (3 × 3) or 4 (2 × 2, phones). */
  samples: number; pcf: 4 | 9;
}

export interface StudioEnv {
  sky: RGB; ground: RGB; key: RGB;
  /** Towards the key light (world). */
  dir: Vec3;
  exposure: number;
  /** The colour of a cut face's rim highlight and of the hovered part's rim. */
  accent: RGB;
}

export interface StudioOptions {
  controls?: boolean;
  onRender?: () => void;
  onLost?: () => void;
  onRestored?: () => void;
  maxDpr?: number;
  flags?: Partial<StudioFlags>;
}

export interface FrameStats { cpuMs: number; gpuMs: number | null; draws: number; tris: number; px: number; shadowRedrawn: boolean }

export interface Studio {
  readonly camera: OrbitCamera;
  readonly canvas: HTMLCanvasElement;
  readonly flags: StudioFlags;
  setModel(m: Model3, resolve: (c: Colour) => RGB): void;
  setKnobs(k: Partial<Knobs>): void;
  knobs(): Knobs;
  /** A set of instances (particles): the 18-float records of gl/instances.ts on a geometry, in a material. */
  setInstances(key: string, geo: Geo, mat: Material, data: Float32Array, count?: number): void;
  /** Names / groups lit (the rest dimmed), or null for all. */
  setFocus(names: ReadonlySet<string> | null): void;
  /** The part under the pointer: drawn with a rim. */
  setHover(name: string | null): void;
  setEnv(e: Partial<StudioEnv>): void;
  setFlags(f: Partial<StudioFlags>): void;
  invalidate(): void;
  render(): void;
  project(p: Vec3): [number, number] | null;
  /** The ray through a canvas point (CSS px). */
  ray(x: number, y: number): { o: Vec3; d: Vec3 };
  last(): FrameStats;
  destroy(): void;
}

// ---------------------------------------------------------------- shaders

const VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNor;
layout(location=2) in vec3 iPos;
layout(location=3) in vec3 iScale;
layout(location=4) in vec4 iRot;
layout(location=5) in vec4 iCol;
layout(location=6) in vec4 iMat;
uniform mat4 uModel, uVP, uLightVP;
uniform mat3 uNorm;
out vec3 vN; out vec3 vW; out vec4 vL; out vec4 vC; out vec3 vE;
vec3 qrot(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
void main() {
  vec4 w = uModel * vec4(qrot(iRot, aPos * iScale) + iPos, 1.0);
  vN = uNorm * qrot(iRot, aNor / iScale);
  vW = w.xyz; vL = uLightVP * w; vC = iCol; vE = iMat.rgb;
  gl_Position = uVP * w;
}`;

const FS = `#version 300 es
precision highp float;
precision highp sampler2DShadow;
in vec3 vN; in vec3 vW; in vec4 vL; in vec4 vC; in vec3 vE;
uniform vec3 uEye, uKeyDir, uKeyCol, uSky, uGround, uAccent;
uniform vec3 uBase, uEmit, uTint;
uniform float uMetal, uRough, uCoat, uTransmit, uExposure, uDim, uRim;
uniform int uMode;        // 0 opaque, 1 thin glass (blended), 2 glass over the frame copy, 3 floor
uniform int uCutOn, uNCut;
uniform vec4 uCut[2];
uniform int uShadowOn, uEnvOn;
uniform sampler2DShadow uShadow;
uniform float uShadowTexel;
uniform int uPcf;
uniform sampler2D uFrame;
uniform vec2 uView;
uniform mat4 uVP;
uniform vec4 uFloor;      // centre x, y, z, radius
out vec4 o;

vec3 lin(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
vec3 display(vec3 c) { return pow(aces(c * uExposure), vec3(1.0 / 2.2)); }

// The studio: a gradient from floor to sky, a large softbox up front-left, a tall strip light back-right; edges widen
// with roughness (a cheap stand-in for prefiltering).
float rect(vec3 d, float az0, float el0, vec2 hs, float soft) {
  float az = atan(d.x, d.z), el = asin(clamp(d.y, -1.0, 1.0));
  float da = abs(mod(az - az0 + 3.14159265, 6.2831853) - 3.14159265), de = abs(el - el0);
  return (1.0 - smoothstep(hs.x - soft, hs.x + soft, da)) * (1.0 - smoothstep(hs.y - soft, hs.y + soft, de));
}
vec3 env(vec3 d, float r) {
  vec3 sky = lin(uSky), ground = lin(uGround), key = lin(uKeyCol);
  vec3 c = mix(ground * 0.35, sky * 0.9, smoothstep(-0.25, 0.5, d.y));
  if (uEnvOn == 0) return c;
  float soft = 0.03 + 0.5 * r * r;
  c += key * 3.2 * rect(d, -0.75, 0.62, vec2(0.42, 0.22), soft);
  c += key * 1.6 * rect(d, 2.3, 0.15, vec2(0.07, 0.55), soft);
  c += key * 0.6 * rect(d, 1.1, 0.95, vec2(0.6, 0.12), soft);
  return c;
}
vec3 envBRDF(vec3 F0, float r, float NoV) {
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022), c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 rr = r * c0 + c1;
  float a = min(rr.x * rr.x, exp2(-9.28 * NoV)) * rr.x + rr.y;
  vec2 AB = vec2(-1.04, 1.04) * a + rr.zw;
  return F0 * AB.x + AB.y;
}
float ggx(float NoH, float r) { float a = r * r, a2 = a * a, d = NoH * NoH * (a2 - 1.0) + 1.0; return a2 / (3.14159265 * d * d); }
float vis(float NoV, float NoL, float r) { float k = (r + 1.0) * (r + 1.0) / 8.0; return 0.25 / ((NoV * (1.0 - k) + k) * (NoL * (1.0 - k) + k)); }

float shadowAt() {
  if (uShadowOn == 0) return 1.0;
  vec3 p = vL.xyz / vL.w * 0.5 + 0.5;
  if (p.x < 0.0 || p.y < 0.0 || p.x > 1.0 || p.y > 1.0 || p.z > 1.0) return 1.0;
  float s = 0.0;
  if (uPcf == 4) {
    // four bilinear-filtered taps (each a 2 × 2 compare in hardware): 16 texels' worth
    for (int i = 0; i < 4; i++) s += texture(uShadow, vec3(p.xy + (vec2(float(i & 1), float(i >> 1)) - 0.5) * uShadowTexel * 2.0, p.z - 0.0015));
    return s / 4.0;
  }
  for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++)
    s += texture(uShadow, vec3(p.xy + vec2(float(i), float(j)) * uShadowTexel * 1.5, p.z - 0.0015));
  return s / 9.0;
}

bool removed(vec3 p) {
  if (uNCut == 0) return false;
  for (int i = 0; i < 2; i++) if (i < uNCut && dot(uCut[i].xyz, p) <= uCut[i].w) return false;
  return true;
}

// Light at a point with normal n: key (with shadow), hemisphere fill, environment reflection, clear coat.
vec3 shade(vec3 n, vec3 V, vec3 base, float metal, float rough, float coat, float sh) {
  vec3 L = normalize(uKeyDir), H = normalize(L + V);
  float NoL = max(dot(n, L), 0.0), NoV = max(dot(n, V), 1e-3), NoH = max(dot(n, H), 0.0), VoH = max(dot(V, H), 0.0);
  rough = clamp(rough, 0.04, 1.0);
  vec3 F0 = mix(vec3(0.04), base, metal), F = F0 + (1.0 - F0) * pow(1.0 - VoH, 5.0);
  vec3 diff = base * (1.0 - metal);
  vec3 key = lin(uKeyCol) * 3.0;
  vec3 c = (diff * (1.0 - F) + ggx(NoH, rough) * vis(NoV, NoL, rough) * F * 3.14159265) * key * NoL * sh;
  vec3 hemi = mix(lin(uGround), lin(uSky), n.y * 0.5 + 0.5);
  c += diff * hemi * (0.9 + 0.5 * sh);
  vec3 R = reflect(-V, n);
  c += env(R, rough) * envBRDF(F0, rough, NoV) * (0.6 + 0.4 * sh);
  if (coat > 0.0) {
    float Fc = 0.04 + 0.96 * pow(1.0 - NoV, 5.0);
    c = c * (1.0 - coat * Fc) + coat * (env(R, 0.06) * Fc + ggx(NoH, 0.08) * vis(NoV, NoL, 0.08) * 0.04 * key * NoL * sh);
  }
  return c;
}

void main() {
  vec3 V = normalize(uEye - vW);
  if (uMode == 3) { // the floor: only its shadow and a soft contact pool, over the page
    float r = length(vW.xz - uFloor.xz) / uFloor.w;
    float fade = 1.0 - smoothstep(0.35, 1.0, r);
    float a = (1.0 - shadowAt()) * 0.42 * fade + 0.10 * (1.0 - smoothstep(0.0, 0.42, r));
    o = vec4(0.0, 0.0, 0.0, a);
    return;
  }
  if (uCutOn == 1 && removed(vW)) discard;
  vec3 n = normalize(vN);
  vec3 base = lin(uBase) * lin(vC.rgb);
  vec3 emit = lin(uEmit) + lin(vE);
  bool cap = false;
  if (!gl_FrontFacing) {
    n = -n;
    if (uCutOn == 1 && uNCut > 0) {
      // Seen through the cut: the cap lies where the eye's ray leaves the removed wedge.
      vec3 d = normalize(vW - uEye);
      float best = 1e9; vec3 cn = n;
      for (int i = 0; i < 2; i++) if (i < uNCut) {
        float dn = dot(uCut[i].xyz, d);
        if (dn < -1e-5) { float t = (uCut[i].w - dot(uCut[i].xyz, uEye)) / dn; if (t < best) { best = t; cn = uCut[i].xyz; } }
      }
      n = cn; cap = true;
    }
  }
  float sh = shadowAt();
  if (uMode == 0) {
    vec3 c = shade(n, V, base, uMetal, cap ? 0.75 : uRough, cap ? 0.0 : uCoat, sh) + emit;
    if (cap) c = c * 0.92 + lin(uAccent) * 0.04;
    float NoV = max(dot(n, V), 0.0);
    c += lin(uAccent) * uRim * pow(1.0 - NoV, 2.0) * 1.6;
    vec3 outc = display(c);
    float l = dot(outc, vec3(0.299, 0.587, 0.114));
    outc = mix(outc, vec3(l) * 0.55 + 0.2, uDim);
    o = vec4(outc * vC.a, vC.a);
    return;
  }
  // Glass.
  float NoV = max(dot(n, V), 1e-3);
  float F = 0.04 + 0.96 * pow(1.0 - NoV, 5.0);
  vec3 R = reflect(-V, n);
  vec3 L = normalize(uKeyDir), H = normalize(L + V);
  vec3 refl = env(R, uRough) + ggx(max(dot(n, H), 0.0), max(uRough, 0.05)) * vis(NoV, max(dot(n, L), 0.0), max(uRough, 0.05)) * lin(uKeyCol) * 3.0 * max(dot(n, L), 0.0) * sh;
  if (uMode == 1) {
    float a = clamp(F * 0.9 + (1.0 - uTransmit) * 0.35, 0.0, 1.0);
    vec3 body = base * mix(lin(uGround), lin(uSky), n.y * 0.5 + 0.5) * (1.0 - uTransmit);
    vec3 c = display(refl * F + body + emit);
    float k = (1.0 - uDim * 0.6);
    o = vec4(c * a * k + display(emit) * 0.0, a * k);
    return;
  }
  // uMode 2: the near side over the frame so far, bent by the surface's slope on screen.
  vec4 sn = uVP * vec4(n, 0.0);
  vec2 uv = gl_FragCoord.xy / uView - sn.xy * 0.035 * (1.0 - NoV);
  vec4 bg = texture(uFrame, clamp(uv, vec2(0.0), vec2(1.0)));
  vec3 tint = pow(lin(uTint), vec3(0.6));
  vec3 thru = bg.rgb * mix(vec3(1.0), pow(tint, vec3(1.0 / 2.2)), 0.7);
  vec3 rc = display(refl);
  vec3 c = thru * (1.0 - F) + rc * F + display(emit) * 0.0;
  float a = clamp(bg.a * (1.0 - F) + F * 0.95 + 0.05, 0.0, 1.0);
  o = vec4(c, a);
}`;

const SHADOW_FS = `#version 300 es
precision highp float;
in vec3 vN; in vec3 vW; in vec4 vL; in vec4 vC; in vec3 vE;
uniform int uCutOn, uNCut;
uniform vec4 uCut[2];
bool removed(vec3 p) {
  if (uNCut == 0) return false;
  for (int i = 0; i < 2; i++) if (i < uNCut && dot(uCut[i].xyz, p) <= uCut[i].w) return false;
  return true;
}
void main() { if (uCutOn == 1 && removed(vW)) discard; }`;

// ---------------------------------------------------------------- the renderer

interface GpuGeo { vbo: WebGLBuffer; ibo: WebGLBuffer; vao: WebGLVertexArrayObject; count: number }
interface Draw { item: Item; geo: GpuGeo; mat: ResolvedMat; glass: boolean; key: string[] }
interface ResolvedMat { base: RGB; emit: RGB; tint: RGB; metal: number; rough: number; coat: number; transmit: number; glow: number }
interface InstSet { geo: Geo; mat: ResolvedMat; vao: WebGLVertexArrayObject | null; buf: WebGLBuffer | null; data: Float32Array; count: number; gpu: GpuGeo | null }

const SHADOW_SIZE_HI = 2048, SHADOW_SIZE_LO = 1024;

function ortho(l: number, r: number, b: number, t: number, n: number, f: number): Mat4 {
  const m = new Float32Array(16);
  m[0] = 2 / (r - l); m[5] = 2 / (t - b); m[10] = -2 / (f - n);
  m[12] = -(r + l) / (r - l); m[13] = -(t + b) / (t - b); m[14] = -(f + n) / (f - n); m[15] = 1;
  return m;
}

export function createStudio(canvas: HTMLCanvasElement, camera: OrbitCamera, opts: StudioOptions = {}): Studio | null {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: true, depth: false, powerPreference: 'high-performance' });
  if (!gl) return null;
  const dense = Math.min(opts.maxDpr ?? 2, window.devicePixelRatio || 1) >= 2, coarse = matchMedia('(pointer: coarse)').matches;
  const flags: StudioFlags = { shadows: true, msaa: true, refraction: true, env: true, floor: true, samples: dense ? 2 : 4, pcf: coarse ? 4 : 9, ...opts.flags };
  let env: StudioEnv = { sky: [0.75, 0.78, 0.84], ground: [0.36, 0.34, 0.32], key: [0.95, 0.93, 0.88], dir: norm3([-0.5, 0.85, 0.45]), exposure: 1.35, accent: [0.25, 0.6, 1.0] };
  let model: Model3 | null = null, resolve: (c: Colour) => RGB = () => [1, 0, 1];
  let k: Knobs = { explode: 0, cut: 0 };
  let focus: ReadonlySet<string> | null = null, hover: string | null = null;
  const inst = new Map<string, InstSet>();

  let prog: WebGLProgram | null = null, sprog: WebGLProgram | null = null;
  let U: Record<string, WebGLUniformLocation | null> = {}, SU: Record<string, WebGLUniformLocation | null> = {};
  let geos = new Map<Geo, GpuGeo>(), draws: Draw[] = [];
  let floorGeo: GpuGeo | null = null;
  let fbo: WebGLFramebuffer | null = null, colorRb: WebGLRenderbuffer | null = null, depthRb: WebGLRenderbuffer | null = null;
  let copyFbo: WebGLFramebuffer | null = null, copyTex: WebGLTexture | null = null;
  let shadowFbo: WebGLFramebuffer | null = null, shadowTex: WebGLTexture | null = null, shadowSize = SHADOW_SIZE_HI;
  let fbW = 0, fbH = 0, fbSamples = 0;
  let lightVP: Mat4 = new Float32Array(16), shadowDirty = true;
  let lost = false, raf = 0, dead = false, cssW = 1, cssH = 1;
  let stats: FrameStats = { cpuMs: 0, gpuMs: null, draws: 0, tris: 0, px: 0, shadowRedrawn: false };
  const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  let query: WebGLQuery | null = null;
  // Adaptive quality: while frames come back to back (an orbit, a run), a median interval over BUDGET_MS steps the
  // costliest pixel work down one tier at a time: MSAA 4 → 2 → off, the 3 × 3 shadow filter → 2 × 2, refraction off.
  // Never back up within a page view (no oscillation); opts.flags pins a feature.
  const BUDGET_MS = 24, gaps: number[] = [];
  let lastFrame = 0, tier = 0;
  const adapt = (now: number) => {
    const gap = now - lastFrame;
    lastFrame = now;
    if (gap > 250) { gaps.length = 0; return; } // a pause: the next frames start a new run
    gaps.push(gap);
    if (gaps.length < 20) return;
    const med = [...gaps].sort((a, b) => a - b)[gaps.length >> 1];
    gaps.length = 0;
    if (med <= BUDGET_MS) return;
    const steps: (() => boolean)[] = [
      () => (flags.msaa && flags.samples > 2 && !opts.flags?.samples ? ((flags.samples = 2), true) : false),
      () => (flags.pcf === 9 && !opts.flags?.pcf ? ((flags.pcf = 4), true) : false),
      () => (flags.msaa && opts.flags?.msaa === undefined ? ((flags.msaa = false), true) : false),
      () => (flags.refraction && opts.flags?.refraction === undefined ? ((flags.refraction = false), true) : false),
    ];
    while (tier < steps.length && !steps[tier++]()) { /* skip a step already taken or pinned */ }
  };

  const compile = (type: number, src: string) => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error(`shader: ${gl.getShaderInfoLog(sh)}`);
    return sh;
  };
  const link = (vs: string, fs: string) => {
    const p = gl.createProgram()!, a = compile(gl.VERTEX_SHADER, vs), b = compile(gl.FRAGMENT_SHADER, fs);
    gl.attachShader(p, a); gl.attachShader(p, b); gl.linkProgram(p); gl.deleteShader(a); gl.deleteShader(b);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(`program: ${gl.getProgramInfoLog(p)}`);
    return p;
  };
  const uniforms = (p: WebGLProgram) => {
    const out: Record<string, WebGLUniformLocation | null> = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < n; i++) { const u = gl.getActiveUniform(p, i)!; const name = u.name.replace(/\[0\]$/, ''); out[name] = gl.getUniformLocation(p, u.name); }
    return out;
  };

  const upGeo = (g: Geo): GpuGeo => {
    let r = geos.get(g);
    if (r) return r;
    const n = g.positions.length / 3, inter = new Float32Array(n * 6);
    for (let i = 0; i < n; i++) { inter.set(g.positions.subarray(i * 3, i * 3 + 3), i * 6); inter.set(g.normals.subarray(i * 3, i * 3 + 3), i * 6 + 3); }
    const vbo = gl.createBuffer()!, ibo = gl.createBuffer()!, vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.bufferData(gl.ARRAY_BUFFER, inter, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, g.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    r = { vbo, ibo, vao, count: g.indices.length };
    geos.set(g, r);
    return r;
  };

  const resolveMat = (m: Material): ResolvedMat => ({
    base: resolve(m.base), emit: m.emit ? resolve(m.emit).map((v) => v * (m.glow ?? 1)) as RGB : [0, 0, 0],
    tint: m.tint ? resolve(m.tint) : [1, 1, 1], metal: m.metal, rough: m.rough, coat: m.coat ?? 0, transmit: m.transmit ?? 0, glow: m.glow ?? 0,
  });

  const keysOf = (it: Item) => [it.name, it.group].filter((x): x is string => !!x);
  const build = () => {
    draws = [];
    if (!model) return;
    for (const it of model.items) draws.push({ item: it, geo: upGeo(it.geo), mat: resolveMat(it.mat), glass: (it.mat.transmit ?? 0) > 0.3, key: keysOf(it) });
    for (const s of inst.values()) { s.mat = s.mat; }
    shadowDirty = true;
  };

  const ensureTargets = (w: number, h: number) => {
    const samples = flags.msaa ? Math.min(flags.samples, gl.getParameter(gl.MAX_SAMPLES) as number) : 0;
    if (fbo && fbW === w && fbH === h && fbSamples === samples) return;
    if (fbo) { gl.deleteFramebuffer(fbo); gl.deleteRenderbuffer(colorRb); gl.deleteRenderbuffer(depthRb); gl.deleteFramebuffer(copyFbo); gl.deleteTexture(copyTex); }
    fbW = w; fbH = h; fbSamples = samples;
    fbo = gl.createFramebuffer(); colorRb = gl.createRenderbuffer(); depthRb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, colorRb);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, w, h);
    gl.bindRenderbuffer(gl.RENDERBUFFER, depthRb);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, colorRb);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRb);
    copyTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, copyTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    copyFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, copyFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, copyTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };

  const ensureShadow = () => {
    if (shadowFbo) return;
    shadowTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, shadowTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, shadowSize, shadowSize);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    shadowFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, shadowTex, 0);
    gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };

  const init = () => {
    prog = link(VS, FS); sprog = link(VS, SHADOW_FS);
    U = uniforms(prog); SU = uniforms(sprog);
    geos = new Map(); fbo = null; shadowFbo = null; fbW = 0;
    // phones: a smaller shadow map
    shadowSize = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, matchMedia('(pointer: coarse)').matches ? SHADOW_SIZE_LO : SHADOW_SIZE_HI);
    floorGeo = upGeo(lathe([[0, 0], [1, 0], [0, 0.0001]], { seg: 64 }));
    for (const s of inst.values()) { s.vao = null; s.buf = null; s.gpu = null; }
    build();
  };

  // A static item: the instance attributes read as constants (identity record).
  const staticAttrs = () => {
    for (let a = 2; a <= 6; a++) gl.disableVertexAttribArray(a);
    gl.vertexAttrib3f(2, 0, 0, 0); gl.vertexAttrib3f(3, 1, 1, 1); gl.vertexAttrib4f(4, 0, 0, 0, 1); gl.vertexAttrib4f(5, 1, 1, 1, 1); gl.vertexAttrib4f(6, 0, 0, 0, 0);
  };

  const instVao = (s: InstSet) => {
    if (s.vao && s.gpu) return s.vao;
    const g = upGeo(s.geo), vao = gl.createVertexArray()!, buf = gl.createBuffer()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, g.vbo);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, g.ibo);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, s.data, gl.DYNAMIC_DRAW);
    INSTANCE_ATTRS.forEach((a, k) => {
      gl.enableVertexAttribArray(2 + k);
      gl.vertexAttribPointer(2 + k, a.size, gl.FLOAT, false, INSTANCE_FLOATS * 4, a.offset * 4);
      gl.vertexAttribDivisor(2 + k, 1);
    });
    gl.bindVertexArray(null);
    s.vao = vao; s.buf = buf; s.gpu = g;
    return vao;
  };

  const resize = () => {
    const dpr = Math.min(opts.maxDpr ?? 2, window.devicePixelRatio || 1);
    cssW = Math.max(1, canvas.clientWidth); cssH = Math.max(1, canvas.clientHeight);
    const w = Math.round(cssW * dpr), h = Math.round(cssH * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  };

  const setMat = (u: Record<string, WebGLUniformLocation | null>, m: ResolvedMat) => {
    gl.uniform3fv(u.uBase, m.base); gl.uniform3fv(u.uEmit, m.emit); gl.uniform3fv(u.uTint, m.tint);
    gl.uniform1f(u.uMetal, m.metal); gl.uniform1f(u.uRough, m.rough); gl.uniform1f(u.uCoat, m.coat); gl.uniform1f(u.uTransmit, m.transmit);
  };
  const M = new Float32Array(16), ID = (() => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; })();
  const ID3 = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

  const cutUniforms = (u: Record<string, WebGLUniformLocation | null>, it: Item | null) => {
    const cuts = model ? cutsAt(model, k.cut) : [];
    const on = !!it && cuts.length > 0 && (it.cut ?? 'section') !== 'none';
    gl.uniform1i(u.uCutOn, on ? 1 : 0);
    gl.uniform1i(u.uNCut, cuts.length);
    const arr = new Float32Array(8);
    cuts.slice(0, 2).forEach((c, i) => arr.set([c.n[0], c.n[1], c.n[2], c.d], i * 4));
    gl.uniform4fv(u.uCut, arr);
    return on;
  };

  const drawShadow = () => {
    if (!model || !sprog) return;
    ensureShadow();
    const { min, max } = boundsOf(model, k.explode), c: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const R = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2 * 1.05, L = norm3(env.dir);
    const eye: Vec3 = [c[0] + L[0] * 2 * R, c[1] + L[1] * 2 * R, c[2] + L[2] * 2 * R];
    lightVP = mat4Mul(ortho(-R, R, -R, R, 0.01, 4 * R), mat4LookAt(eye, c, Math.abs(L[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0]));
    gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFbo);
    gl.viewport(0, 0, shadowSize, shadowSize);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.useProgram(sprog);
    gl.uniformMatrix4fv(SU.uVP, false, lightVP);
    gl.uniformMatrix4fv(SU.uLightVP, false, lightVP);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1.5, 3);
    for (const d of draws) {
      if (d.glass || d.item.shadow === false) continue;
      gl.bindVertexArray(d.geo.vao); staticAttrs();
      gl.uniformMatrix4fv(SU.uModel, false, itemMatrix(d.item, k.explode, M));
      gl.uniformMatrix3fv(SU.uNorm, false, ID3);
      cutUniforms(SU, d.item);
      gl.drawElements(gl.TRIANGLES, d.geo.count, gl.UNSIGNED_INT, 0);
    }
    gl.uniformMatrix4fv(SU.uModel, false, ID); gl.uniform1i(SU.uCutOn, 0);
    for (const s of inst.values()) {
      if (!s.count) continue;
      gl.bindVertexArray(instVao(s));
      gl.drawElementsInstanced(gl.TRIANGLES, s.gpu!.count, gl.UNSIGNED_INT, 0, s.count);
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.bindVertexArray(null);
    shadowDirty = false;
  };

  const render = () => {
    if (lost || dead || !prog || !model) return;
    const t0 = performance.now();
    adapt(t0);
    resize();
    const W = canvas.width, H = canvas.height;
    ensureTargets(W, H);
    let nDraws = 0, nTris = 0;
    const redraw = flags.shadows && shadowDirty;
    if (redraw) drawShadow();
    if (timer && !query) { query = gl.createQuery(); gl.beginQuery(timer.TIME_ELAPSED_EXT, query); }

    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(prog);
    const vp = camera.viewProj(cssW / cssH);
    gl.uniformMatrix4fv(U.uVP, false, vp);
    gl.uniformMatrix4fv(U.uLightVP, false, lightVP);
    gl.uniform3fv(U.uEye, camera.eye()); gl.uniform3fv(U.uKeyDir, norm3(env.dir));
    gl.uniform3fv(U.uKeyCol, env.key); gl.uniform3fv(U.uSky, env.sky); gl.uniform3fv(U.uGround, env.ground); gl.uniform3fv(U.uAccent, env.accent);
    gl.uniform1f(U.uExposure, env.exposure);
    gl.uniform1i(U.uShadowOn, flags.shadows ? 1 : 0); gl.uniform1i(U.uEnvOn, flags.env ? 1 : 0);
    gl.uniform1f(U.uShadowTexel, 1 / shadowSize); gl.uniform1i(U.uPcf, flags.pcf);
    gl.uniform2f(U.uView, W, H);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, flags.shadows ? shadowTex : null); gl.uniform1i(U.uShadow, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, copyTex); gl.uniform1i(U.uFrame, 1);

    const lit = (d: Draw) => !focus || d.key.some((x) => focus!.has(x));
    const item = (d: Draw, mode: number, cull: number | null) => {
      gl.bindVertexArray(d.geo.vao); staticAttrs();
      const m = itemMatrix(d.item, k.explode, M);
      gl.uniformMatrix4fv(U.uModel, false, m);
      gl.uniformMatrix3fv(U.uNorm, false, normalMatrix(m));
      setMat(U, d.mat);
      gl.uniform1i(U.uMode, mode);
      gl.uniform1f(U.uDim, lit(d) ? 0 : 0.75);
      gl.uniform1f(U.uRim, hover && d.key.includes(hover) ? 1 : 0);
      const cut = cutUniforms(U, d.item);
      if (cut || cull === null) gl.disable(gl.CULL_FACE); else { gl.enable(gl.CULL_FACE); gl.cullFace(cull); }
      gl.drawElements(gl.TRIANGLES, d.geo.count, gl.UNSIGNED_INT, 0);
      nDraws++; nTris += d.geo.count / 3;
    };

    // 1. opaque items, then the particle sets
    gl.disable(gl.BLEND); gl.depthMask(true);
    for (const d of draws) if (!d.glass) item(d, 0, gl.BACK);
    gl.uniformMatrix4fv(U.uModel, false, ID); gl.uniformMatrix3fv(U.uNorm, false, ID3); gl.uniform1i(U.uCutOn, 0); gl.uniform1f(U.uDim, 0); gl.uniform1f(U.uRim, 0); gl.uniform1i(U.uMode, 0);
    gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
    for (const s of inst.values()) {
      if (!s.count) continue;
      setMat(U, s.mat);
      gl.bindVertexArray(instVao(s));
      gl.drawElementsInstanced(gl.TRIANGLES, s.gpu!.count, gl.UNSIGNED_INT, 0, s.count);
      nDraws++; nTris += (s.gpu!.count / 3) * s.count;
    }
    // 2. the floor's shadow, over the page
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
    const fb = boundsOf(model, 0), fy = model.floor ?? fb.min[1];
    // seen from below the floor there is nothing for a shadow to fall on
    if (flags.floor && floorGeo && camera.eye()[1] > fy) {
      const { min, max } = fb, y = fy, R = Math.max(max[0] - min[0], max[2] - min[2]) * 1.15;
      const cx = (min[0] + max[0]) / 2, cz = (min[2] + max[2]) / 2;
      const fm = new Float32Array([R, 0, 0, 0, 0, 1, 0, 0, 0, 0, R, 0, cx, y - 0.05, cz, 1]);
      gl.bindVertexArray(floorGeo.vao); staticAttrs();
      gl.uniformMatrix4fv(U.uModel, false, fm); gl.uniformMatrix3fv(U.uNorm, false, ID3);
      gl.uniform1i(U.uMode, 3); gl.uniform4f(U.uFloor, cx, y, cz, R);
      gl.disable(gl.CULL_FACE);
      gl.drawElements(gl.TRIANGLES, floorGeo.count, gl.UNSIGNED_INT, 0);
      nDraws++;
    }
    // 3. glass: the far sides (and thin glass, both sides) blended
    const glass = draws.filter((d) => d.glass);
    for (const d of glass) {
      const refr = flags.refraction && d.mat.transmit >= 0.9;
      item(d, 1, refr ? gl.FRONT : null);
    }
    // 4. the near sides of clear glass over a copy of the frame so far
    if (flags.refraction && glass.some((d) => d.mat.transmit >= 0.9)) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, copyFbo);
      gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.disable(gl.BLEND);
      for (const d of glass) if (d.mat.transmit >= 0.9) item(d, 2, gl.BACK);
    }
    gl.disable(gl.BLEND); gl.depthMask(true);
    gl.bindVertexArray(null);
    // 5. resolve to the canvas
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    let gpuMs: number | null = stats.gpuMs;
    if (timer && query) {
      gl.endQuery(timer.TIME_ELAPSED_EXT);
      const q = query;
      query = null;
      // read it back a few frames later (never stalls)
      const poll = () => {
        if (dead || lost) return;
        if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) { setTimeout(poll, 16); return; }
        if (!gl.getParameter(timer.GPU_DISJOINT_EXT)) stats.gpuMs = (gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6;
        gl.deleteQuery(q);
      };
      setTimeout(poll, 16);
    }
    stats = { cpuMs: performance.now() - t0, gpuMs, draws: nDraws, tris: Math.round(nTris), px: W * H, shadowRedrawn: redraw };
    opts.onRender?.();
  };

  const invalidate = () => { if (raf || lost || dead) return; raf = requestAnimationFrame(() => { raf = 0; render(); }); };
  const onLost = (e: Event) => { e.preventDefault(); lost = true; cancelAnimationFrame(raf); raf = 0; opts.onLost?.(); };
  const onRestored = () => { lost = false; init(); opts.onRestored?.(); invalidate(); };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);
  const detach = opts.controls === false ? () => {} : attachOrbit(canvas, camera, invalidate);
  const ro = new ResizeObserver(invalidate);
  ro.observe(canvas);
  init();

  return {
    camera, canvas, flags, render, invalidate,
    setModel(m, r) { model = m; resolve = r; if (!lost) build(); invalidate(); },
    setKnobs(n) {
      const was = k;
      k = { ...k, ...n };
      if (was.explode !== k.explode || was.cut !== k.cut) shadowDirty = true;
      invalidate();
    },
    knobs: () => k,
    setInstances(key, geo, mat, data, count) {
      let s = inst.get(key);
      const rm = resolveMat(mat);
      if (!s || s.geo !== geo) { s = { geo, mat: rm, vao: null, buf: null, data, count: count ?? data.length / INSTANCE_FLOATS, gpu: null }; inst.set(key, s); }
      s.mat = rm; s.data = data; s.count = count ?? data.length / INSTANCE_FLOATS;
      if (!lost && s.vao && s.buf) { gl.bindBuffer(gl.ARRAY_BUFFER, s.buf); gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW); }
      // particles do not move the shadow enough to redraw it every frame
      invalidate();
    },
    setFocus(f) { focus = f; invalidate(); },
    setHover(nm) { if (hover !== nm) { hover = nm; invalidate(); } },
    setEnv(e) { env = { ...env, ...e }; if (e.dir) shadowDirty = true; if (model && !lost) build(); invalidate(); },
    setFlags(f) { Object.assign(flags, f); shadowDirty = true; invalidate(); },
    project(p) { return camera.project(p, cssW, cssH); },
    ray(x, y) {
      const eye = camera.eye(), f = norm3([camera.target[0] - eye[0], camera.target[1] - eye[1], camera.target[2] - eye[2]]), [r, u] = camera.axes();
      const t = Math.tan(camera.fov / 2), nx = (x / cssW) * 2 - 1, ny = 1 - (y / cssH) * 2, a = cssW / cssH;
      return { o: eye, d: norm3([f[0] + (r[0] * nx * a + u[0] * ny) * t, f[1] + (r[1] * nx * a + u[1] * ny) * t, f[2] + (r[2] * nx * a + u[2] * ny) * t]) };
    },
    last: () => stats,
    destroy() {
      if (dead) return;
      dead = true;
      cancelAnimationFrame(raf); ro.disconnect(); detach();
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      if (!lost) gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}

export { OrbitCamera } from './camera';
