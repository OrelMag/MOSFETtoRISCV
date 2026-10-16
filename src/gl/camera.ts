// An orbit camera: it circles a target at a distance, yaw about the vertical, pitch above the horizon. Pure (no
// DOM), so the controls (gl/orbit.ts), the renderer and HTML label overlays share one projection.

import { mat4Apply, mat4LookAt, mat4Mul, mat4Perspective, type Mat4, type Vec3 } from './math';

export interface OrbitView { target: Vec3; yaw: number; pitch: number; dist: number }

export interface OrbitLimits {
  minDist: number; maxDist: number;
  /** Radians; the default keeps the camera between straight down and just under the horizon. */
  minPitch: number; maxPitch: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export class OrbitCamera implements OrbitView {
  target: Vec3; yaw: number; pitch: number; dist: number;
  /** Vertical field of view (radians). */
  fov = (35 * Math.PI) / 180;
  readonly limits: OrbitLimits;
  private readonly home: OrbitView;

  constructor(view: OrbitView, limits: Partial<OrbitLimits> = {}) {
    this.limits = { minDist: view.dist / 4, maxDist: view.dist * 4, minPitch: -0.2, maxPitch: Math.PI / 2 - 0.01, ...limits };
    this.target = [...view.target]; this.yaw = view.yaw; this.pitch = view.pitch; this.dist = view.dist;
    this.clamp();
    this.home = { target: [...this.target], yaw: this.yaw, pitch: this.pitch, dist: this.dist };
  }

  /** Back to the view it was made with. */
  reset(): void {
    this.target = [...this.home.target]; this.yaw = this.home.yaw; this.pitch = this.home.pitch; this.dist = this.home.dist;
  }

  /** Is it at the view it was made with? */
  atHome(): boolean {
    const h = this.home;
    return this.yaw === h.yaw && this.pitch === h.pitch && this.dist === h.dist && this.target.every((v, i) => v === h.target[i]);
  }

  orbit(dYaw: number, dPitch: number): void { this.yaw += dYaw; this.pitch += dPitch; this.clamp(); }

  /** Multiply the distance (< 1 moves in). */
  zoom(factor: number): void { this.dist *= factor; this.clamp(); }

  eye(): Vec3 {
    const cp = Math.cos(this.pitch), [tx, ty, tz] = this.target;
    return [tx + this.dist * cp * Math.sin(this.yaw), ty + this.dist * Math.sin(this.pitch), tz + this.dist * cp * Math.cos(this.yaw)];
  }

  view(): Mat4 { return mat4LookAt(this.eye(), this.target); }

  /** Near and far planes follow the distance, so depth precision stays put while zooming. */
  proj(aspect: number): Mat4 { return mat4Perspective(this.fov, aspect, this.dist / 50, this.dist * 20); }

  viewProj(aspect: number): Mat4 { return mat4Mul(this.proj(aspect), this.view()); }

  /** A world point in CSS pixels of a w × h view (y down), or null behind the camera. */
  project(p: Vec3, w: number, h: number, vp: Mat4 = this.viewProj(w / h)): [number, number] | null {
    const [x, y, , q] = mat4Apply(vp, p);
    if (q <= 1e-9) return null;
    return [((x / q) * 0.5 + 0.5) * w, (0.5 - (y / q) * 0.5) * h];
  }

  private clamp(): void {
    const l = this.limits;
    this.pitch = clamp(this.pitch, l.minPitch, l.maxPitch);
    this.dist = clamp(this.dist, l.minDist, l.maxDist);
    this.yaw = ((((this.yaw + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
  }
}
