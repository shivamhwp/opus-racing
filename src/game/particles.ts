import {
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  PlaneGeometry,
} from "three";
import { makeParticleMaterial, type SkyUniforms } from "./materials";
import type { TrackDef } from "./track";

/**
 * Tyre smoke, dust, sparks and exhaust — every effect in the game — from a
 * single fixed-size pool drawn in one instanced call.
 *
 * The pool never allocates after construction and never sorts. Dead particles
 * are swapped with the tail of the live range, so the instanced attributes stay
 * densely packed and only the live prefix is uploaded each frame.
 */

export const KIND_SMOKE = 0;
export const KIND_SPARK = 1;

const MAX = 900;

export class Particles {
  readonly mesh: Mesh;
  private readonly iPos = new Float32Array(MAX * 3);
  private readonly iData = new Float32Array(MAX * 4); // size, life, kind, seed
  private readonly iColor = new Float32Array(MAX * 3);
  private readonly vel = new Float32Array(MAX * 3);
  private readonly decay = new Float32Array(MAX);
  private readonly grow = new Float32Array(MAX);
  private live = 0;

  private readonly aPos: InstancedBufferAttribute;
  private readonly aData: InstancedBufferAttribute;
  private readonly aColor: InstancedBufferAttribute;

  constructor(sky: SkyUniforms, def: TrackDef) {
    const quad = new PlaneGeometry(1, 1);
    const geo = new InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute("position", quad.getAttribute("position"));
    geo.setAttribute("uv", quad.getAttribute("uv"));

    this.aPos = new InstancedBufferAttribute(this.iPos, 3).setUsage(DynamicDrawUsage);
    this.aData = new InstancedBufferAttribute(this.iData, 4).setUsage(DynamicDrawUsage);
    this.aColor = new InstancedBufferAttribute(this.iColor, 3).setUsage(DynamicDrawUsage);
    geo.setAttribute("iPos", this.aPos);
    geo.setAttribute("iData", this.aData);
    geo.setAttribute("iColor", this.aColor);
    geo.instanceCount = 0;
    // The pool is scattered across the whole circuit, so culling it as one
    // object would be wrong; it is small enough to always draw.
    geo.boundingSphere = null;

    this.mesh = new Mesh(geo, makeParticleMaterial(sky, def));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
  }

  /** Spawn one particle. Silently drops if the pool is saturated. */
  spawn(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    size: number,
    ttl: number,
    kind: number,
    r: number,
    g: number,
    b: number,
    grow = 1.6,
  ) {
    if (this.live >= MAX) return;
    const i = this.live++;
    this.iPos[i * 3] = x;
    this.iPos[i * 3 + 1] = y;
    this.iPos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.iData[i * 4] = size;
    this.iData[i * 4 + 1] = 1;
    this.iData[i * 4 + 2] = kind;
    this.iData[i * 4 + 3] = Math.random();
    this.iColor[i * 3] = r;
    this.iColor[i * 3 + 1] = g;
    this.iColor[i * 3 + 2] = b;
    this.decay[i] = 1 / ttl;
    this.grow[i] = grow;
  }

  update(dt: number) {
    const pos = this.iPos;
    const data = this.iData;
    const vel = this.vel;
    let i = 0;
    while (i < this.live) {
      const d = i * 4;
      data[d + 1] -= this.decay[i] * dt;
      if (data[d + 1] <= 0) {
        // Swap-remove: move the tail into this slot and re-test it.
        const last = --this.live;
        if (last !== i) {
          pos.copyWithin(i * 3, last * 3, last * 3 + 3);
          vel.copyWithin(i * 3, last * 3, last * 3 + 3);
          data.copyWithin(i * 4, last * 4, last * 4 + 4);
          this.iColor.copyWithin(i * 3, last * 3, last * 3 + 3);
          this.decay[i] = this.decay[last];
          this.grow[i] = this.grow[last];
        }
        continue;
      }
      const p = i * 3;
      const spark = data[d + 2] > 0.5;
      if (spark) {
        vel[p + 1] -= 22 * dt; // sparks are heavy and fall fast
        vel[p] *= 1 - 2.4 * dt;
        vel[p + 2] *= 1 - 2.4 * dt;
      } else {
        vel[p + 1] += 1.4 * dt; // smoke rises
        const drag = 1 - 1.9 * dt;
        vel[p] *= drag;
        vel[p + 1] *= drag;
        vel[p + 2] *= drag;
        data[d] += this.grow[i] * dt; // and expands
      }
      pos[p] += vel[p] * dt;
      pos[p + 1] += vel[p + 1] * dt;
      pos[p + 2] += vel[p + 2] * dt;
      if (pos[p + 1] < 0.05) {
        pos[p + 1] = 0.05;
        vel[p + 1] = spark ? -vel[p + 1] * 0.35 : 0;
      }
      i++;
    }

    const geo = this.mesh.geometry as InstancedBufferGeometry;
    geo.instanceCount = this.live;
    if (this.live > 0) {
      // Upload only the live prefix.
      this.aPos.clearUpdateRanges();
      this.aData.clearUpdateRanges();
      this.aColor.clearUpdateRanges();
      this.aPos.addUpdateRange(0, this.live * 3);
      this.aData.addUpdateRange(0, this.live * 4);
      this.aColor.addUpdateRange(0, this.live * 3);
      this.aPos.needsUpdate = true;
      this.aData.needsUpdate = true;
      this.aColor.needsUpdate = true;
    }
  }

  get count() {
    return this.live;
  }

  clear() {
    this.live = 0;
    (this.mesh.geometry as InstancedBufferGeometry).instanceCount = 0;
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as { dispose(): void }).dispose();
  }
}
