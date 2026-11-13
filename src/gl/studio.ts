// The studio renderer (the successor of gl/renderer.ts for the close-ups): real geometry from gl/kit/geo.ts, physically
// based materials (GGX specular, Schlick fresnel, a clear coat) lit by one key light with a soft shadow (a PCF shadow
// map fitted to the model, redrawn only when the model, a knob or a moved part changes, never for an orbit), glow
// lights from hot parts onto their neighbours, and a procedural studio environment (sky to floor gradient, a softbox, a
// strip light) for reflections without textures; ACES tone mapping; MSAA into renderbuffers, resolved by a blit.
// Emission is also written to a second target and bloomed (a half- and a quarter-resolution blur, added back over the
// frame), so a heater at 1100 K glows through its glass. Glass is drawn in two passes: its far side blended (far to
// near), then its near side over a copy of the frame so far, bent along the surface normal and mixed with the
// reflection by fresnel. Cut planes remove a wedge of the cut items; their inner faces seen through the cut are shaded
// as a flat cap (closed meshes look solid, with no CSG and no stencil). A floor disc catches the shadow over the page's
// own background. Data surfaces (a screen, a picture, a mask) are the one texture. Frames on demand; every GPU object is
// rebuilt after a lost context; quality steps down by itself when frames run slow. Loaded as its own chunk.

import { OrbitCamera } from './camera';
import { INSTANCE_ATTRS, INSTANCE_FLOATS, type RGB } from './instances';
import { mat4LookAt, mat4Mul, norm3, type Mat4, type Vec3 } from './math';
import { attachOrbit } from './orbit';
import { lathe, normalMatrix, type Geo } from './kit/geo';
import type { Colour, DataTex, Material } from './kit/materials';
import { boundsOf, cutsAt, explodeOffset, itemMatrix, type Item, type Knobs, type Model3, type Moves } from './kit/scene';

export interface StudioFlags {
  shadows: boolean; msaa: boolean; refraction: boolean; env: boolean; floor: boolean; bloom: boolean;
  /** MSAA samples when msaa is on (default 4, or 2 at 2 device pixels per CSS pixel or more); shadow filter taps. */
  samples: number; pcf: 4 | 9;
}

export interface StudioEnv {
  sky: RGB; ground: RGB; key: RGB;
  /** Towards the key light (world). */
  dir: Vec3;
  exposure: number;
  /** The colour of the hovered part's rim. */
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

export interface FrameStats { cpuMs: number; gpuMs: number | null; draws: number; tris: number; px: number; shadowRedrawn: boolean; tier: string }

export interface Studio {
  readonly camera: OrbitCamera;
  readonly canvas: HTMLCanvasElement;
  readonly flags: StudioFlags;
  setModel(m: Model3, resolve: (c: Colour) => RGB): void;
  setKnobs(k: Partial<Knobs>): void;
  knobs(): Knobs;
  /** Parts the physics moves this frame (by name or group), replacing the last set; the shadow follows. */
  move(moves: Moves): void;
  moves(): Moves;
  /** Groups or names not drawn (a beat's hide). */
  setHidden(names: ReadonlySet<string> | null): void;
  /** A set of instances (particles): the 18-float records of gl/instances.ts on a geometry, in a material. */
  setInstances(key: string, geo: Geo, mat: Material, data: Float32Array, count?: number, casts?: boolean): void;
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
layout(location=7) in vec3 aCol;
layout(location=8) in vec2 aUV;
uniform mat4 uModel, uVP, uLightVP;
uniform mat3 uNorm;
out vec3 vN; out vec3 vW; out vec4 vL; out vec4 vC; out vec3 vE; out vec3 vVC; out vec2 vUV;
vec3 qrot(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
void main() {
  vec4 w = uModel * vec4(qrot(iRot, aPos * iScale) + iPos, 1.0);
  vN = uNorm * qrot(iRot, aNor / iScale);
  vW = w.xyz; vL = uLightVP * w; vC = iCol; vE = iMat.rgb; vVC = aCol; vUV = aUV;
  gl_Position = uVP * w;
}`;

const FS = `#version 300 es
precision highp float;
precision highp sampler2DShadow;
in vec3 vN; in vec3 vW; in vec4 vL; in vec4 vC; in vec3 vE; in vec3 vVC; in vec2 vUV;
uniform vec3 uEye, uKeyDir, uKeyCol, uSky, uGround, uAccent;
uniform vec3 uBase, uEmit, uTint;
uniform float uMetal, uRough, uCoat, uTransmit, uExposure, uDim, uRim, uBloomK;
uniform vec4 uHaze;       // depth haze: colour (sRGB), 1 / its distance (0: none)
uniform int uMode;        // 0 opaque, 1 thin glass (blended), 2 glass over the frame copy, 3 floor, 4 beam (additive)
uniform int uCutOn, uNCut;
uniform vec4 uCut[2];
uniform int uShadowOn, uEnvOn, uPcf;
uniform sampler2DShadow uShadow;
uniform float uShadowTexel;
uniform sampler2D uFrame, uData;
uniform int uDataMode;    // 0 none, 1 emit, 2 albedo, 3 mask
uniform vec2 uView;
uniform mat4 uVP;
uniform vec4 uFloor;      // centre x, y, z, radius
uniform int uNPL;
uniform vec4 uPL[4];      // glow lights: position, range
uniform vec3 uPLc[4];     // their colour × power (linear)
layout(location=0) out vec4 o;
layout(location=1) out vec4 og;

vec3 lin(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
vec3 display(vec3 c) { return pow(aces(c * uExposure), vec3(1.0 / 2.2)); }

float rect(vec3 d, float az0, float el0, vec2 hs, float soft) {
  float az = atan(d.x, d.z), el = asin(clamp(d.y, -1.0, 1.0));
  float da = abs(mod(az - az0 + 3.14159265, 6.2831853) - 3.14159265), de = abs(el - el0);
  return (1.0 - smoothstep(hs.x - soft, hs.x + soft, da)) * (1.0 - smoothstep(hs.y - soft, hs.y + soft, de));
}
// The studio: a gradient from floor to sky, a large softbox up front-left, a tall strip light back-right, a top strip;
// edges widen with roughness (a cheap stand-in for prefiltering).
vec3 env(vec3 d, float r) {
  vec3 sky = lin(uSky), ground = lin(uGround), key = lin(uKeyCol);
  vec3 c = mix(ground * 0.45, sky * 0.95, smoothstep(-0.25, 0.5, d.y));
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
  // glow lights: a hot heater lights the inside of its sleeve, the grid and the plate a little
  for (int i = 0; i < 4; i++) if (i < uNPL) {
    vec3 d = uPL[i].xyz - vW;
    float dist = length(d), att = 1.0 / (1.0 + (dist * dist) / (uPL[i].w * uPL[i].w));
    att *= 1.0 - smoothstep(uPL[i].w * 3.0, uPL[i].w * 4.0, dist);
    vec3 Lp = d / max(dist, 1e-4), Hp = normalize(Lp + V);
    float NoLp = max(dot(n, Lp), 0.0);
    c += (diff + ggx(max(dot(n, Hp), 0.0), rough) * vis(NoV, NoLp, rough) * F0 * 3.14159265) * uPLc[i] * NoLp * att;
  }
  if (coat > 0.0) {
    float Fc = 0.04 + 0.96 * pow(1.0 - NoV, 5.0);
    c = c * (1.0 - coat * Fc) + coat * (env(R, 0.06) * Fc + ggx(NoH, 0.08) * vis(NoV, NoL, 0.08) * 0.04 * key * NoL * sh);
  }
  return c;
}

void main() {
  og = vec4(0.0);
  vec3 V = normalize(uEye - vW);
  if (uMode == 3) {
    float r = length(vW.xz - uFloor.xz) / uFloor.w;
    float fade = 1.0 - smoothstep(0.35, 1.0, r);
    float a = (1.0 - shadowAt()) * 0.42 * fade + 0.10 * (1.0 - smoothstep(0.0, 0.42, r));
    o = vec4(0.0, 0.0, 0.0, a);
    return;
  }
  if (uCutOn == 1 && removed(vW)) discard;
  vec4 tex = vec4(1.0);
  if (uDataMode != 0) {
    tex = texture(uData, vUV);
    if (uDataMode == 3 && tex.a < 0.5) discard;
  }
  vec3 n = normalize(vN);
  vec3 base = lin(uBase) * lin(vC.rgb) * lin(vVC);
  if (uDataMode == 2) base *= lin(tex.rgb);
  vec3 emit = lin(uEmit) + lin(vE);
  if (uDataMode == 1) emit += lin(tex.rgb) * 2.0;
  if (uMode == 4) { // a beam: additive light, soft towards its silhouette
    float edge = pow(abs(dot(n, V)), 1.5);
    vec3 c = emit * edge;
    o = vec4(display(c), 0.0);
    og = vec4(min(c * uExposure * 0.5, vec3(1.0)), 0.0);
    return;
  }
  bool cap = false;
  if (!gl_FrontFacing) {
    n = -n;
    if (uCutOn == 1 && uNCut > 0) {
      vec3 d = normalize(vW - uEye);
      float best = 1e9; vec3 cn = n;
      for (int i = 0; i < 2; i++) if (i < uNCut) {
        float dn = dot(uCut[i].xyz, d);
        if (dn < -1e-5) { float t = (uCut[i].w - dot(uCut[i].xyz, uEye)) / dn; if (t < best) { best = t; cn = uCut[i].xyz; } }
      }
      n = cn; cap = true;
    }
  }
  // a cap is shaded at the back face it is drawn from, inside the solid: the shadow map would darken every section
  float sh = cap ? 1.0 : shadowAt();
  if (uMode == 0) {
    vec3 c = shade(n, V, base, uMetal, cap ? 0.75 : uRough, cap ? 0.0 : uCoat, sh) + emit;
    float NoV = max(dot(n, V), 0.0);
    c += lin(uAccent) * uRim * pow(1.0 - NoV, 2.0) * 1.6;
    vec3 outc = display(c);
    // depth haze, in display space so it fades to the page's own background colour
    if (uHaze.w > 0.0) outc = mix(outc, uHaze.rgb, 1.0 - exp(-length(vW - uEye) * uHaze.w));
    float l = dot(outc, vec3(0.299, 0.587, 0.114));
    outc = mix(outc, vec3(l) * 0.55 + 0.2, uDim);
    o = vec4(outc * vC.a, vC.a);
    og = vec4(min(emit * uBloomK * uExposure * 0.35 * (1.0 - uDim), vec3(1.0)), 1.0);
    return;
  }
  float NoV = max(dot(n, V), 1e-3);
  float F = 0.04 + 0.96 * pow(1.0 - NoV, 5.0);
  vec3 R = reflect(-V, n);
  vec3 L = normalize(uKeyDir), H = normalize(L + V);
  vec3 refl = env(R, uRough) + ggx(max(dot(n, H), 0.0), max(uRough, 0.05)) * vis(NoV, max(dot(n, L), 0.0), max(uRough, 0.05)) * lin(uKeyCol) * 3.0 * max(dot(n, L), 0.0) * sh;
  if (uMode == 1) {
    float a = clamp(F * 0.9 + (1.0 - uTransmit) * 0.6, 0.0, 1.0);
    vec3 body = shade(n, V, base, uMetal, uRough, 0.0, sh) * (1.0 - uTransmit) + emit;
    vec3 c = display(refl * F + body);
    float k = (1.0 - uDim * 0.6);
    o = vec4(c * a * k, a * k);
    return;
  }
  vec4 sn = uVP * vec4(n, 0.0);
  vec2 uv = gl_FragCoord.xy / uView - sn.xy * 0.035 * (1.0 - NoV);
  vec4 bg = texture(uFrame, clamp(uv, vec2(0.0), vec2(1.0)));
  vec3 tint = pow(lin(uTint), vec3(0.6));
  vec3 thru = bg.rgb * mix(vec3(1.0), pow(tint, vec3(1.0 / 2.2)), 0.7);
  vec3 c = thru * (1.0 - F) + display(refl) * F;
  float a = clamp(bg.a * (1.0 - F) + F * 0.95 + 0.05, 0.0, 1.0);
  o = vec4(c, a);
}`;

const SHADOW_FS = `#version 300 es
precision highp float;
in vec3 vN; in vec3 vW; in vec4 vL; in vec4 vC; in vec3 vE; in vec3 vVC; in vec2 vUV;
uniform int uCutOn, uNCut;
uniform vec4 uCut[2];
bool removed(vec3 p) {
  if (uNCut == 0) return false;
  for (int i = 0; i < 2; i++) if (i < uNCut && dot(uCut[i].xyz, p) <= uCut[i].w) return false;
  return true;
}
void main() { if (uCutOn == 1 && removed(vW)) discard; }`;

// A triangle covering the screen, uv 0..1.
const POST_VS = `#version 300 es
out vec2 uv;
void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); uv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
const BLUR_FS = `#version 300 es
precision mediump float;
in vec2 uv;
uniform sampler2D uSrc;
uniform vec2 uStep;
out vec4 o;
void main() {
  vec4 c = texture(uSrc, uv) * 0.2270270;
  c += (texture(uSrc, uv + uStep * 1.3846154) + texture(uSrc, uv - uStep * 1.3846154)) * 0.3162162;
  c += (texture(uSrc, uv + uStep * 3.2307692) + texture(uSrc, uv - uStep * 3.2307692)) * 0.0702703;
  o = c;
}`;
const COMP_FS = `#version 300 es
precision mediump float;
in vec2 uv;
uniform sampler2D uScene, uNear, uFar;
uniform float uK;
out vec4 o;
void main() {
  vec4 s = texture(uScene, uv);
  vec3 b = (texture(uNear, uv).rgb * 1.2 + texture(uFar, uv).rgb * 1.6) * uK;
  float a = max(s.a, clamp(max(b.r, max(b.g, b.b)), 0.0, 1.0));
  o = vec4(s.rgb + b, a);
}`;

// ---------------------------------------------------------------- the renderer

interface GpuGeo { vbo: WebGLBuffer; ibo: WebGLBuffer; vao: WebGLVertexArrayObject; count: number; cbo: WebGLBuffer | null; ubo: WebGLBuffer | null; rev: number }
interface Draw { item: Item; geo: GpuGeo; src: Geo; mat: ResolvedMat; glass: boolean; key: string[] }
interface ResolvedMat { base: RGB; emit: RGB; tint: RGB; metal: number; rough: number; coat: number; transmit: number; glow: number; bloom: number; beam: boolean; data: DataTex | null }
interface InstSet { casts: boolean; geo: Geo; src: Material; mat: ResolvedMat; vao: WebGLVertexArrayObject | null; buf: WebGLBuffer | null; data: Float32Array; count: number; gpu: GpuGeo | null }
interface Target { fb: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number }

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
  const flags: StudioFlags = { shadows: true, msaa: true, refraction: true, env: true, floor: true, bloom: true, samples: dense ? 2 : 4, pcf: coarse ? 4 : 9, ...opts.flags };
  let env: StudioEnv = { sky: [0.75, 0.78, 0.84], ground: [0.36, 0.34, 0.32], key: [0.95, 0.93, 0.88], dir: norm3([-0.5, 0.85, 0.45]), exposure: 1.35, accent: [0.25, 0.6, 1.0] };
  /** The key light a model gets back when its look stops naming one (a beat lowered it); the haze its look asks for. */
  const homeDir = env.dir;
  let haze: [number, number, number, number] = [0, 0, 0, 0];
  let model: Model3 | null = null, resolve: (c: Colour) => RGB = () => [1, 0, 1];
  let k: Knobs = { explode: 0, cut: 0 };
  let focus: ReadonlySet<string> | null = null, hover: string | null = null, hidden: ReadonlySet<string> | null = null;
  let moves: Moves = new Map();
  const inst = new Map<string, InstSet>();

  let prog: WebGLProgram | null = null, sprog: WebGLProgram | null = null, blur: WebGLProgram | null = null, comp: WebGLProgram | null = null;
  let U: Record<string, WebGLUniformLocation | null> = {}, SU: Record<string, WebGLUniformLocation | null> = {}, BU: Record<string, WebGLUniformLocation | null> = {}, CU: Record<string, WebGLUniformLocation | null> = {};
  let geos = new Map<Geo, GpuGeo>(), texs = new Map<DataTex, { tex: WebGLTexture; rev: number }>(), draws: Draw[] = [];
  let floorGeo: GpuGeo | null = null, emptyVao: WebGLVertexArrayObject | null = null;
  let fbo: WebGLFramebuffer | null = null, colorRb: WebGLRenderbuffer | null = null, glowRb: WebGLRenderbuffer | null = null, depthRb: WebGLRenderbuffer | null = null;
  let frameT: Target | null = null, glowT: Target | null = null, halfA: Target | null = null, halfB: Target | null = null, qA: Target | null = null, qB: Target | null = null;
  let shadowFbo: WebGLFramebuffer | null = null, shadowTex: WebGLTexture | null = null, shadowSize = SHADOW_SIZE_HI;
  let fbW = 0, fbH = 0, fbSamples = -1;
  let lightVP: Mat4 = new Float32Array(16), shadowDirty = true;
  let lost = false, raf = 0, dead = false, cssW = 1, cssH = 1;
  let stats: FrameStats = { cpuMs: 0, gpuMs: null, draws: 0, tris: 0, px: 0, shadowRedrawn: false, tier: '' };
  const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  let query: WebGLQuery | null = null;

  // Adaptive quality: while frames come back to back (an orbit, a run), a median interval over BUDGET_MS steps the
  // costliest pixel work down one tier at a time. Each step and what it drops: MSAA 4 → 2 (edges a little rougher);
  // the 3 × 3 shadow filter → 2 × 2 (shadow edges harder); MSAA off (jagged edges at dpr 1); refraction off (glass
  // stops bending what is behind it); bloom off (glow without its halo). Never back up within a page view.
  const BUDGET_MS = 24, gaps: number[] = [];
  let lastFrame = 0, tier = 0;
  const adapt = (now: number) => {
    const gap = now - lastFrame;
    lastFrame = now;
    if (gap > 250) { gaps.length = 0; return; }
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
      () => (flags.bloom && opts.flags?.bloom === undefined ? ((flags.bloom = false), true) : false),
    ];
    while (tier < steps.length && !steps[tier++]()) { /* a step already taken or pinned */ }
  };
  const tierName = () => `${flags.msaa ? `msaa${flags.samples}` : 'aa off'} · pcf${flags.pcf}${flags.refraction ? '' : ' · no refr'}${flags.bloom ? '' : ' · no bloom'}`;

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
    for (let i = 0; i < n; i++) { const u = gl.getActiveUniform(p, i)!; out[u.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, u.name); }
    return out;
  };

  const fillGeo = (g: Geo, r: GpuGeo, first: boolean) => {
    const n = g.positions.length / 3, inter = new Float32Array(n * 6);
    for (let i = 0; i < n; i++) { inter.set(g.positions.subarray(i * 3, i * 3 + 3), i * 6); inter.set(g.normals.subarray(i * 3, i * 3 + 3), i * 6 + 3); }
    gl.bindBuffer(gl.ARRAY_BUFFER, r.vbo);
    if (first) gl.bufferData(gl.ARRAY_BUFFER, inter, g.rev ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW); else gl.bufferSubData(gl.ARRAY_BUFFER, 0, inter);
    if (g.colors && r.cbo) { gl.bindBuffer(gl.ARRAY_BUFFER, r.cbo); if (first) gl.bufferData(gl.ARRAY_BUFFER, g.colors, gl.DYNAMIC_DRAW); else gl.bufferSubData(gl.ARRAY_BUFFER, 0, g.colors); }
    r.rev = g.rev ?? 0;
  };
  const upGeo = (g: Geo): GpuGeo => {
    let r = geos.get(g);
    if (r) {
      if ((g.rev ?? 0) !== r.rev) {
        // a geometry that gained colours after its upload: rebuild it
        if (g.colors && !r.cbo) { geos.delete(g); return upGeo(g); }
        fillGeo(g, r, false);
      }
      return r;
    }
    const vbo = gl.createBuffer()!, ibo = gl.createBuffer()!, vao = gl.createVertexArray()!;
    r = { vbo, ibo, vao, count: g.indices.length, cbo: g.colors ? gl.createBuffer() : null, ubo: g.uvs ? gl.createBuffer() : null, rev: 0 };
    gl.bindVertexArray(vao);
    fillGeo(g, r, true);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    if (r.cbo) { gl.bindBuffer(gl.ARRAY_BUFFER, r.cbo); gl.enableVertexAttribArray(7); gl.vertexAttribPointer(7, 3, gl.FLOAT, false, 0, 0); }
    if (r.ubo) { gl.bindBuffer(gl.ARRAY_BUFFER, r.ubo); gl.bufferData(gl.ARRAY_BUFFER, g.uvs!, gl.STATIC_DRAW); gl.enableVertexAttribArray(8); gl.vertexAttribPointer(8, 2, gl.FLOAT, false, 0, 0); }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, g.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    geos.set(g, r);
    return r;
  };

  const texOf = (d: DataTex): WebGLTexture => {
    let t = texs.get(d);
    if (!t) { t = { tex: gl.createTexture()!, rev: -1 }; texs.set(d, t); }
    if (t.rev !== d.rev) {
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, d.w, d.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, d.pixels);
      const f = d.smooth ? gl.LINEAR : gl.NEAREST;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      t.rev = d.rev;
    }
    return t.tex;
  };

  const resolveMat = (m: Material): ResolvedMat => ({
    base: resolve(m.base), emit: m.emit ? resolve(m.emit).map((v) => v * (m.glow ?? 1)) as RGB : [0, 0, 0],
    tint: m.tint ? resolve(m.tint) : [1, 1, 1], metal: m.metal, rough: m.rough, coat: m.coat ?? 0, transmit: m.transmit ?? 0, glow: m.glow ?? 0, bloom: m.bloom ?? 1,
    beam: !!m.beam, data: m.data ?? null,
  });

  const keysOf = (it: Item) => [it.name, it.group].filter((x): x is string => !!x);
  const build = () => {
    draws = [];
    if (!model) return;
    for (const it of model.items) draws.push({ item: it, src: it.geo, geo: upGeo(it.geo), mat: resolveMat(it.mat), glass: (it.mat.transmit ?? 0) > 0.3 && !it.mat.beam, key: keysOf(it) });
    // free what no item and no instance set draws any more: a model that builds a geometry per frame (a growing beam)
    // would otherwise keep every one of them on the GPU
    const used = new Set<Geo>(model.items.map((i) => i.geo));
    for (const s of inst.values()) used.add(s.geo);
    for (const [g, r] of geos) if (!used.has(g) && r !== floorGeo) {
      gl.deleteVertexArray(r.vao); gl.deleteBuffer(r.vbo); gl.deleteBuffer(r.ibo);
      if (r.cbo) gl.deleteBuffer(r.cbo);
      if (r.ubo) gl.deleteBuffer(r.ubo);
      geos.delete(g);
    }
    shadowDirty = true;
  };

  const target = (w: number, h: number): Target => {
    const tex = gl.createTexture()!, fb = gl.createFramebuffer()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { fb, tex, w, h };
  };
  const dropTarget = (t: Target | null) => { if (t) { gl.deleteFramebuffer(t.fb); gl.deleteTexture(t.tex); } };

  const ensureTargets = (w: number, h: number) => {
    const samples = flags.msaa ? Math.min(flags.samples, gl.getParameter(gl.MAX_SAMPLES) as number) : 0;
    if (fbo && fbW === w && fbH === h && fbSamples === samples) return;
    if (fbo) { gl.deleteFramebuffer(fbo); gl.deleteRenderbuffer(colorRb); gl.deleteRenderbuffer(glowRb); gl.deleteRenderbuffer(depthRb); [frameT, glowT, halfA, halfB, qA, qB].forEach(dropTarget); }
    fbW = w; fbH = h; fbSamples = samples;
    fbo = gl.createFramebuffer(); colorRb = gl.createRenderbuffer(); glowRb = gl.createRenderbuffer(); depthRb = gl.createRenderbuffer();
    for (const [rb, fmt] of [[colorRb, gl.RGBA8], [glowRb, gl.RGBA8], [depthRb, gl.DEPTH_COMPONENT24]] as const) {
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, fmt, w, h);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, colorRb);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.RENDERBUFFER, glowRb);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRb);
    frameT = target(w, h); glowT = target(w, h);
    const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1), qw = Math.max(1, w >> 2), qh = Math.max(1, h >> 2);
    halfA = target(hw, hh); halfB = target(hw, hh); qA = target(qw, qh); qB = target(qw, qh);
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
    prog = link(VS, FS); sprog = link(VS, SHADOW_FS); blur = link(POST_VS, BLUR_FS); comp = link(POST_VS, COMP_FS);
    U = uniforms(prog); SU = uniforms(sprog); BU = uniforms(blur); CU = uniforms(comp);
    geos = new Map(); texs = new Map(); fbo = null; shadowFbo = null; fbW = 0; fbSamples = -1;
    shadowSize = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, coarse ? SHADOW_SIZE_LO : SHADOW_SIZE_HI);
    floorGeo = upGeo(lathe([[0, 0], [1, 0], [0, 0.0001]], { seg: 64 }));
    emptyVao = gl.createVertexArray();
    for (const s of inst.values()) { s.vao = null; s.buf = null; s.gpu = null; }
    build();
  };

  // A static item: the instance attributes (and absent colour / uv arrays) read as constants.
  const staticAttrs = (g: GpuGeo | null) => {
    for (let a = 2; a <= 6; a++) gl.disableVertexAttribArray(a);
    gl.vertexAttrib3f(2, 0, 0, 0); gl.vertexAttrib3f(3, 1, 1, 1); gl.vertexAttrib4f(4, 0, 0, 0, 1); gl.vertexAttrib4f(5, 1, 1, 1, 1); gl.vertexAttrib4f(6, 0, 0, 0, 0);
    if (!g?.cbo) gl.vertexAttrib3f(7, 1, 1, 1);
    if (!g?.ubo) gl.vertexAttrib2f(8, 0, 0);
  };

  const instVao = (s: InstSet) => {
    if (s.vao && s.gpu) return s.vao;
    const g = upGeo(s.geo), vao = gl.createVertexArray()!, buf = gl.createBuffer()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, g.vbo);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    // the geometry's own per-vertex colours and UVs (a painted or data-textured mesh drawn as instances); without them
    // the draw's constant attributes (white, uv 0) stand in
    if (g.cbo) { gl.bindBuffer(gl.ARRAY_BUFFER, g.cbo); gl.enableVertexAttribArray(7); gl.vertexAttribPointer(7, 3, gl.FLOAT, false, 0, 0); }
    if (g.ubo) { gl.bindBuffer(gl.ARRAY_BUFFER, g.ubo); gl.enableVertexAttribArray(8); gl.vertexAttribPointer(8, 2, gl.FLOAT, false, 0, 0); }
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
    if (u.uBloomK) gl.uniform1f(u.uBloomK, m.bloom);
    gl.uniform1f(u.uMetal, m.metal); gl.uniform1f(u.uRough, m.rough); gl.uniform1f(u.uCoat, m.coat); gl.uniform1f(u.uTransmit, m.transmit);
    if (m.data) {
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, texOf(m.data)); gl.uniform1i(u.uData, 2);
      gl.uniform1i(u.uDataMode, m.data.mode === 'emit' ? 1 : m.data.mode === 'albedo' ? 2 : 3);
    } else gl.uniform1i(u.uDataMode, 0);
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
  const isHidden = (d: Draw) => !!hidden && d.key.some((x) => hidden!.has(x));

  /** The model's items (as placed now) and every instance set that casts. */
  const sceneBounds = (k0: number): { min: Vec3; max: Vec3 } => {
    const b = model && model.items.length ? boundsOf(model, k0) : { min: [Infinity, Infinity, Infinity] as Vec3, max: [-Infinity, -Infinity, -Infinity] as Vec3 };
    for (const s of inst.values()) {
      if (!s.casts) continue;
      for (let i = 0; i < s.count; i++) {
        const o = i * INSTANCE_FLOATS, r = Math.hypot(s.data[o + 3], s.data[o + 4], s.data[o + 5]) / 2;
        for (let a = 0; a < 3; a++) { b.min[a] = Math.min(b.min[a], s.data[o + a] - r); b.max[a] = Math.max(b.max[a], s.data[o + a] + r); }
      }
    }
    return b;
  };

  const drawShadow = () => {
    if (!sprog) return;
    ensureShadow();
    const { min, max } = sceneBounds(k.explode), c: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const R = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2 * 1.05, L = norm3(env.dir);
    if (!Number.isFinite(R)) return;
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
      if (d.glass || d.mat.beam || d.item.shadow === false || isHidden(d)) continue;
      gl.bindVertexArray(d.geo.vao); staticAttrs(d.geo);
      gl.uniformMatrix4fv(SU.uModel, false, itemMatrix(d.item, k.explode, M, moves));
      gl.uniformMatrix3fv(SU.uNorm, false, ID3);
      cutUniforms(SU, d.item);
      gl.drawElements(gl.TRIANGLES, d.geo.count, gl.UNSIGNED_INT, 0);
    }
    gl.uniformMatrix4fv(SU.uModel, false, ID); gl.uniform1i(SU.uCutOn, 0);
    for (const s of inst.values()) {
      if (!s.count || !s.casts) continue;
      gl.bindVertexArray(instVao(s));
      gl.vertexAttrib3f(7, 1, 1, 1); gl.vertexAttrib2f(8, 0, 0);
      gl.drawElementsInstanced(gl.TRIANGLES, s.gpu!.count, gl.UNSIGNED_INT, 0, s.count);
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.bindVertexArray(null);
    shadowDirty = false;
  };

  const post = (p: WebGLProgram, to: Target | null, w: number, h: number) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, to ? to.fb : null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(p);
    gl.bindVertexArray(emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  const blurPass = (src: WebGLTexture, sw: number, sh: number, to: Target, dx: number, dy: number) => {
    gl.useProgram(blur);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src); gl.uniform1i(BU.uSrc, 0);
    gl.uniform2f(BU.uStep, dx / sw, dy / sh);
    post(blur!, to, to.w, to.h);
  };

  const render = () => {
    if (lost || dead || !prog || !model) return;
    const t0 = performance.now();
    adapt(t0);
    resize();
    const W = canvas.width, H = canvas.height;
    ensureTargets(W, H);
    for (const d of draws) if ((d.src.rev ?? 0) !== d.geo.rev) { upGeo(d.src); if (d.item.shadow !== false) shadowDirty = true; }
    let nDraws = 0, nTris = 0;
    const redraw = flags.shadows && shadowDirty;
    if (redraw) drawShadow();
    if (timer && !query) { query = gl.createQuery(); gl.beginQuery(timer.TIME_ELAPSED_EXT, query); }

    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(prog);
    const vp = camera.viewProj(cssW / cssH);
    gl.uniformMatrix4fv(U.uVP, false, vp);
    gl.uniformMatrix4fv(U.uLightVP, false, lightVP);
    const eye = camera.eye();
    gl.uniform3fv(U.uEye, eye); gl.uniform3fv(U.uKeyDir, norm3(env.dir));
    gl.uniform3fv(U.uKeyCol, env.key); gl.uniform3fv(U.uSky, env.sky); gl.uniform3fv(U.uGround, env.ground); gl.uniform3fv(U.uAccent, env.accent);
    gl.uniform1f(U.uExposure, env.exposure);
    gl.uniform4f(U.uHaze, haze[0], haze[1], haze[2], haze[3]);
    gl.uniform1i(U.uShadowOn, flags.shadows ? 1 : 0); gl.uniform1i(U.uEnvOn, flags.env ? 1 : 0);
    gl.uniform1f(U.uShadowTexel, 1 / shadowSize); gl.uniform1i(U.uPcf, flags.pcf);
    gl.uniform2f(U.uView, W, H);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, flags.shadows ? shadowTex : null); gl.uniform1i(U.uShadow, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, frameT!.tex); gl.uniform1i(U.uFrame, 1);
    // every sampler on a unit of its own type: the shadow map (a depth compare) must not share unit 0 with uData
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, null); gl.uniform1i(U.uData, 2);
    // glow lights, riding with their items when exploded
    const pl = new Float32Array(16), plc = new Float32Array(12), lights = (model.lights ?? []).slice(0, 4);
    lights.forEach((l, i) => {
      const it = l.on ? model!.items.find((x) => x.name === l.on || x.group === l.on) : undefined, off = it ? explodeOffset(it, k.explode) : [0, 0, 0];
      pl.set([l.p[0] + off[0], l.p[1] + off[1], l.p[2] + off[2], l.range], i * 4);
      const c = resolve(l.colour).map((v) => Math.pow(v, 2.2) * l.power);
      plc.set(c, i * 3);
    });
    gl.uniform1i(U.uNPL, lights.length); gl.uniform4fv(U.uPL, pl); gl.uniform3fv(U.uPLc, plc);

    const lit = (d: Draw) => !focus || d.key.some((x) => focus!.has(x));
    const item = (d: Draw, mode: number, cull: number | null) => {
      gl.bindVertexArray(d.geo.vao); staticAttrs(d.geo);
      const m = itemMatrix(d.item, k.explode, M, moves);
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
    const visible = draws.filter((d) => !isHidden(d));

    // 1. opaque items, then the particle sets
    gl.disable(gl.BLEND); gl.depthMask(true);
    for (const d of visible) if (!d.glass && !d.mat.beam) item(d, 0, gl.BACK);
    gl.uniformMatrix4fv(U.uModel, false, ID); gl.uniformMatrix3fv(U.uNorm, false, ID3); gl.uniform1i(U.uCutOn, 0); gl.uniform1f(U.uDim, 0); gl.uniform1f(U.uRim, 0); gl.uniform1i(U.uMode, 0);
    gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
    for (const s of inst.values()) {
      if (!s.count) continue;
      setMat(U, s.mat);
      gl.bindVertexArray(instVao(s));
      gl.vertexAttrib3f(7, 1, 1, 1); gl.vertexAttrib2f(8, 0, 0);
      gl.drawElementsInstanced(gl.TRIANGLES, s.gpu!.count, gl.UNSIGNED_INT, 0, s.count);
      nDraws++; nTris += (s.gpu!.count / 3) * s.count;
    }
    // 2. the floor's shadow over the page (colour only: no glow)
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.NONE]);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
    const fb = sceneBounds(0), fy = model.floor ?? fb.min[1];
    if (flags.floor && floorGeo && eye[1] > fy && Number.isFinite(fy)) {
      const { min, max } = fb, R = Math.max(max[0] - min[0], max[2] - min[2]) * 1.15;
      const cx = (min[0] + max[0]) / 2, cz = (min[2] + max[2]) / 2;
      // a little below the model's foot, so the foot's own depth in the shadow map does not fight the floor (acne)
      const fm = new Float32Array([R, 0, 0, 0, 0, 1, 0, 0, 0, 0, R, 0, cx, fy - R * 0.006, cz, 1]);
      gl.bindVertexArray(floorGeo.vao); staticAttrs(floorGeo);
      gl.uniformMatrix4fv(U.uModel, false, fm); gl.uniformMatrix3fv(U.uNorm, false, ID3);
      gl.uniform1i(U.uMode, 3); gl.uniform4f(U.uFloor, cx, fy, cz, R); gl.uniform1i(U.uDataMode, 0);
      gl.disable(gl.CULL_FACE);
      gl.drawElements(gl.TRIANGLES, floorGeo.count, gl.UNSIGNED_INT, 0);
      nDraws++;
    }
    // 3. see-through items far to near (an `order` first), their far sides when they will also be drawn near
    const depthOf = (d: Draw) => {
      const m = itemMatrix(d.item, k.explode, M, moves), c: Vec3 = [(d.src.min[0] + d.src.max[0]) / 2, (d.src.min[1] + d.src.max[1]) / 2, (d.src.min[2] + d.src.max[2]) / 2];
      const x = m[0] * c[0] + m[4] * c[1] + m[8] * c[2] + m[12] - eye[0], y = m[1] * c[0] + m[5] * c[1] + m[9] * c[2] + m[13] - eye[1], z = m[2] * c[0] + m[6] * c[1] + m[10] * c[2] + m[14] - eye[2];
      return x * x + y * y + z * z;
    };
    const glass = visible.filter((d) => d.glass).map((d) => ({ d, o: d.item.order ?? 0, z: depthOf(d) })).sort((a, b) => a.o - b.o || b.z - a.z).map((x) => x.d);
    for (const d of glass) item(d, 1, flags.refraction && d.mat.transmit >= 0.9 ? gl.FRONT : null);
    // 4. beams: additive, glow included
    const beams = visible.filter((d) => d.mat.beam);
    if (beams.length) {
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      gl.blendFunc(gl.ONE, gl.ONE);
      for (const d of beams) item(d, 4, null);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.NONE]);
    }
    // 5. the near sides of clear glass over a copy of the frame so far
    if (flags.refraction && glass.some((d) => d.mat.transmit >= 0.9)) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo); gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, frameT!.fb);
      gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.NONE]);
      gl.disable(gl.BLEND);
      for (const d of glass) if (d.mat.transmit >= 0.9) item(d, 2, gl.BACK);
    }
    gl.disable(gl.BLEND); gl.depthMask(true);
    gl.bindVertexArray(null);
    // 6. resolve; bloom the glow and add it back, or blit straight to the canvas
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo);
    if (flags.bloom) {
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, frameT!.fb);
      gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo);
      gl.readBuffer(gl.COLOR_ATTACHMENT1);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, glowT!.fb);
      gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
      blurPass(glowT!.tex, W, H, halfA!, 2, 0);
      blurPass(halfA!.tex, halfA!.w, halfA!.h, halfB!, 0, 1);
      blurPass(halfB!.tex, halfB!.w, halfB!.h, qA!, 2, 0);
      blurPass(qA!.tex, qA!.w, qA!.h, qB!, 0, 2);
      gl.useProgram(comp);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, frameT!.tex); gl.uniform1i(CU.uScene, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, halfB!.tex); gl.uniform1i(CU.uNear, 1);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, qB!.tex); gl.uniform1i(CU.uFar, 2);
      gl.uniform1f(CU.uK, 1);
      post(comp!, null, W, H);
      gl.enable(gl.DEPTH_TEST);
      nDraws += 5;
    } else {
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);

    const gpuMs: number | null = stats.gpuMs;
    if (timer && query) {
      gl.endQuery(timer.TIME_ELAPSED_EXT);
      const q = query;
      query = null;
      const poll = () => {
        if (dead || lost) return;
        if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) { setTimeout(poll, 16); return; }
        if (!gl.getParameter(timer.GPU_DISJOINT_EXT)) stats.gpuMs = (gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6;
        gl.deleteQuery(q);
      };
      setTimeout(poll, 16);
    }
    stats = { cpuMs: performance.now() - t0, gpuMs, draws: nDraws, tris: Math.round(nTris), px: W * H, shadowRedrawn: redraw, tier: tierName() };
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

  const self: Studio = {
    camera, canvas, flags, render, invalidate,
    setModel(m, r) {
      model = m; resolve = r;
      // instance sets resolved before this resolver came (a model filling them while it builds) take its colours now
      for (const s of inst.values()) s.mat = resolveMat(s.src);
      if (m.look?.exposure !== undefined) env.exposure = m.look.exposure;
      const dir = m.look?.keyDir ? norm3(m.look.keyDir) : homeDir;
      if (dir.some((v, i) => v !== env.dir[i])) { env.dir = dir; shadowDirty = true; }
      haze = m.look?.haze ? [...r(m.look.haze.colour), 1 / m.look.haze.dist] : [0, 0, 0, 0];
      if (!lost) build();
      invalidate();
    },
    setKnobs(n) {
      const was = k;
      k = { ...k, ...n };
      if (was.explode !== k.explode || was.cut !== k.cut) shadowDirty = true;
      invalidate();
    },
    knobs: () => k,
    move(m) { moves = m; shadowDirty = true; invalidate(); },
    moves: () => moves,
    setHidden(h) { hidden = h; shadowDirty = true; invalidate(); },
    setInstances(key, geo, mat, data, count, casts = false) {
      let s = inst.get(key);
      const rm = resolveMat(mat);
      if (s && s.geo !== geo && !lost) { if (s.vao) gl.deleteVertexArray(s.vao); if (s.buf) gl.deleteBuffer(s.buf); }
      if (!s || s.geo !== geo) { s = { casts, geo, src: mat, mat: rm, vao: null, buf: null, data, count: count ?? data.length / INSTANCE_FLOATS, gpu: null }; inst.set(key, s); }
      s.src = mat; s.mat = rm; s.data = data; s.count = count ?? data.length / INSTANCE_FLOATS; s.casts = casts;
      if (!lost && s.vao && s.buf) { gl.bindBuffer(gl.ARRAY_BUFFER, s.buf); gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW); }
      if (casts) shadowDirty = true;
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
  return self;
}

export { OrbitCamera } from './camera';
