import { PerspectiveCamera, Vector3 } from "three";
import type { CarSim } from "./physics";
import type { Track } from "./track";

/**
 * Chase camera.
 *
 * The one rule this obeys: the camera sits directly behind the car and looks
 * along the car's own axis, so the car is always horizontally centred. An
 * earlier version aimed at a point on the track centreline ahead, which reads
 * fine on the racing line and then shoves the car to the edge of the frame the
 * moment it runs wide — exactly when you most need to see it.
 *
 * Corner anticipation comes from a small bounded yaw lead, not from moving the
 * aim point off the car, so the framing never breaks.
 */

export const CAMERA_MODES = ["chase", "close", "cockpit", "hood", "cinematic"] as const;
export type CameraMode = (typeof CAMERA_MODES)[number];

export const CAMERA_LABELS: Record<CameraMode, string> = {
  chase: "Chase",
  close: "Close",
  cockpit: "Cockpit",
  hood: "T-cam",
  cinematic: "Broadcast",
};

interface Rig {
  /** Distance behind the car's origin. Negative puts the camera in front. */
  back: number;
  /** Height above the car. */
  up: number;
  /** How far up the road the camera aims. */
  lookAhead: number;
  /** Height of the aim point above the car. Larger lifts the car in frame. */
  lookUp: number;
  /** Position follow rate. */
  stiffness: number;
  fov: number;
  fovKick: number;
  roll: number;
  /** Max yaw lead into a corner, radians. Kept small on purpose. */
  lead: number;
}

const RIGS: Record<CameraMode, Rig> = {
  chase: { back: 8.6, up: 2.75, lookAhead: 15, lookUp: 2.05, stiffness: 9, fov: 60, fovKick: 20, roll: 0.28, lead: 0.10 },
  close: { back: 6.2, up: 2.25, lookAhead: 13, lookUp: 1.75, stiffness: 12, fov: 64, fovKick: 22, roll: 0.38, lead: 0.12 },
  cockpit: { back: -0.15, up: 1.16, lookAhead: 26, lookUp: 1.02, stiffness: 26, fov: 74, fovKick: 13, roll: 0.85, lead: 0.05 },
  hood: { back: -1.35, up: 1.3, lookAhead: 24, lookUp: 1.16, stiffness: 22, fov: 70, fovKick: 15, roll: 0.7, lead: 0.06 },
  cinematic: { back: 11.5, up: 3.7, lookAhead: 18, lookUp: 2.7, stiffness: 5, fov: 50, fovKick: 14, roll: 0.16, lead: 0.08 },
};

const _v = new Vector3();

/** Shortest signed difference between two angles. */
function angleDelta(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export class ChaseCamera {
  readonly camera: PerspectiveCamera;
  mode: CameraMode = "chase";

  private readonly pos = new Vector3();
  private readonly look = new Vector3();
  private yaw = 0;
  private roll = 0;
  private fov = 60;
  private initialised = false;
  /** Extra shake fed to the post pass. */
  shake = 0;

  constructor(aspect: number) {
    this.camera = new PerspectiveCamera(60, aspect, 0.25, 6000);
  }

  cycle(): CameraMode {
    const i = CAMERA_MODES.indexOf(this.mode);
    this.mode = CAMERA_MODES[(i + 1) % CAMERA_MODES.length];
    return this.mode;
  }

  reset() {
    this.initialised = false;
  }

  update(dt: number, car: CarSim, track: Track, speedNorm: number) {
    const rig = RIGS[this.mode];

    // --- where the camera is pointing --------------------------------------
    // Start from the car's own heading, then lean a bounded amount toward the
    // road ahead so a corner opens up before the car reaches it.
    const ahead = Math.round((18 + speedNorm * 40) / track.stationLength);
    const li = (car.station + ahead) & (track.n - 1);
    const roadYaw = Math.atan2(track.tx[li], track.tz[li]);
    const lead = Math.max(-rig.lead, Math.min(rig.lead, angleDelta(car.heading, roadYaw)));
    const targetYaw = car.heading + lead;

    if (!this.initialised) {
      this.yaw = targetYaw;
    } else {
      // Follow through the shortest arc so the camera never unwinds the long
      // way round when the car crosses the ±π seam.
      this.yaw += angleDelta(this.yaw, targetYaw) * Math.min(1, rig.stiffness * 1.15 * dt);
    }

    const sinY = Math.sin(this.yaw);
    const cosY = Math.cos(this.yaw);

    // --- position and aim ---------------------------------------------------
    // Both are built on the same axis through the car, which is what keeps the
    // car centred no matter where on the track it is.
    const ax = car.x - sinY * rig.back;
    const az = car.z - cosY * rig.back;
    const ay = car.y + rig.up;

    const tx = car.x + sinY * rig.lookAhead;
    const tz = car.z + cosY * rig.lookAhead;
    const ty = car.y + rig.lookUp;

    if (!this.initialised) {
      this.pos.set(ax, ay, az);
      this.look.set(tx, ty, tz);
      this.initialised = true;
    } else {
      const k = 1 - Math.exp(-rig.stiffness * dt);
      this.pos.x += (ax - this.pos.x) * k;
      this.pos.y += (ay - this.pos.y) * k;
      this.pos.z += (az - this.pos.z) * k;
      // The aim point tracks harder than the position: lag in the position
      // reads as weight, lag in the aim reads as a broken camera.
      const kl = 1 - Math.exp(-rig.stiffness * 2.2 * dt);
      this.look.x += (tx - this.look.x) * kl;
      this.look.y += (ty - this.look.y) * kl;
      this.look.z += (tz - this.look.z) * kl;
    }

    // Never let the camera drop through the road.
    const minY = track.heightAt(car.station) + 0.5;
    if (this.pos.y < minY) this.pos.y = minY;

    // --- roll and field of view --------------------------------------------
    const targetRoll = (car.roll * 1.2 - car.yawRate * 0.13 + car.slip * 0.005) * rig.roll;
    this.roll += (targetRoll - this.roll) * Math.min(1, 6 * dt);

    const targetFov = rig.fov + speedNorm * speedNorm * rig.fovKick;
    this.fov += (targetFov - this.fov) * Math.min(1, 4 * dt);

    const cam = this.camera;
    cam.position.copy(this.pos);
    // Roll about the view axis: tilt "up" by `roll` in the camera's own
    // right-hand direction, which is the view direction turned 90° about Y.
    const viewYaw = Math.atan2(this.look.x - this.pos.x, this.look.z - this.pos.z);
    cam.up
      .set(Math.sin(this.roll), Math.cos(this.roll), 0)
      .applyAxisAngle(_v.set(0, 1, 0), viewYaw);
    cam.lookAt(this.look);

    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }

    // Shake: kerbs rattle, walls thump, and the car buzzes at top speed.
    const target =
      car.wallHit * 20 +
      car.kerbHit * 3.0 * speedNorm +
      (car.offTrack ? 2.4 * speedNorm : 0) +
      speedNorm * speedNorm * 1.3;
    this.shake += (target - this.shake) * Math.min(1, 12 * dt);
  }

  setAspect(aspect: number) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
