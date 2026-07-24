import { PerspectiveCamera, Vector3 } from "three";
import type { CarSim } from "./physics";
import type { Track } from "./track";

/**
 * Chase camera.
 *
 * The camera is not parented to the car — it is a critically damped spring
 * chasing a target point, with the target biased toward where the car is
 * *going* rather than where it is pointing. That is what stops the view
 * snapping around during a slide and what makes drifts readable.
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
  back: number;
  up: number;
  lookAhead: number;
  lookUp: number;
  stiffness: number;
  fov: number;
  fovKick: number;
  roll: number;
}

const RIGS: Record<CameraMode, Rig> = {
  chase: { back: 9.4, up: 3.5, lookAhead: 13, lookUp: 1.1, stiffness: 7.5, fov: 62, fovKick: 22, roll: 0.30 },
  close: { back: 6.4, up: 2.5, lookAhead: 11, lookUp: 0.9, stiffness: 11, fov: 66, fovKick: 24, roll: 0.42 },
  cockpit: { back: -0.15, up: 1.16, lookAhead: 22, lookUp: 0.9, stiffness: 26, fov: 76, fovKick: 14, roll: 0.85 },
  hood: { back: -1.35, up: 1.32, lookAhead: 20, lookUp: 0.85, stiffness: 22, fov: 72, fovKick: 16, roll: 0.7 },
  cinematic: { back: 12.5, up: 4.6, lookAhead: 16, lookUp: 1.3, stiffness: 4.2, fov: 52, fovKick: 16, roll: 0.18 },
};

const _v = new Vector3();

export class ChaseCamera {
  readonly camera: PerspectiveCamera;
  mode: CameraMode = "chase";

  private readonly pos = new Vector3();
  private readonly look = new Vector3();
  private roll = 0;
  private fov = 62;
  private initialised = false;
  /** Extra shake fed to the post pass. */
  shake = 0;

  constructor(aspect: number) {
    this.camera = new PerspectiveCamera(62, aspect, 0.25, 4200);
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
    const sinH = Math.sin(car.heading);
    const cosH = Math.cos(car.heading);

    // Anchor point behind and above the car, in car space.
    const ax = car.x - sinH * rig.back;
    const az = car.z - cosH * rig.back;
    const ay = car.y + rig.up;

    // Look up the road rather than up the car's nose: through a slide the car
    // points one way and travels another, and the camera should follow the
    // road. But aim at the point on the road *abreast of where the car is* —
    // biasing toward the centreline would shove a car that has run wide out of
    // frame exactly when the driver most needs to see it.
    const ahead = Math.round((rig.lookAhead + speedNorm * 15) / track.stationLength);
    const li = (car.station + ahead) & (track.n - 1);
    const lat = Math.max(-24, Math.min(24, car.lateral)) * 0.82;
    const aheadX = track.px[li] + track.nx[li] * lat;
    const aheadZ = track.pz[li] + track.nz[li] * lat;

    const blend = this.mode === "cockpit" || this.mode === "hood" ? 0.38 : 0.52;
    const tx = car.x + sinH * rig.lookAhead * (1 - blend) + (aheadX - car.x) * blend;
    const tz = car.z + cosH * rig.lookAhead * (1 - blend) + (aheadZ - car.z) * blend;
    const ty = car.y + rig.lookUp + (track.py[li] - car.y) * blend * 0.5;

    if (!this.initialised) {
      this.pos.set(ax, ay, az);
      this.look.set(tx, ty, tz);
      this.initialised = true;
    } else {
      // Exponential smoothing, framerate independent.
      const k = 1 - Math.exp(-rig.stiffness * dt);
      this.pos.x += (ax - this.pos.x) * k;
      this.pos.y += (ay - this.pos.y) * k;
      this.pos.z += (az - this.pos.z) * k;
      const kl = 1 - Math.exp(-(rig.stiffness * 1.5) * dt);
      this.look.x += (tx - this.look.x) * kl;
      this.look.y += (ty - this.look.y) * kl;
      this.look.z += (tz - this.look.z) * kl;
    }

    // Never let the camera clip through the road.
    const minY = track.heightAt(car.station) + 0.55;
    if (this.pos.y < minY) this.pos.y = minY;

    // Bank the horizon with the car, plus a little into the corner.
    const targetRoll = (car.roll * 1.3 - car.yawRate * 0.16 + car.slip * 0.006) * rig.roll;
    this.roll += (targetRoll - this.roll) * Math.min(1, 6 * dt);

    // FOV rises with speed. This does more for the sensation of pace than any
    // amount of motion blur.
    const targetFov = rig.fov + speedNorm * speedNorm * rig.fovKick;
    this.fov += (targetFov - this.fov) * Math.min(1, 4 * dt);

    const cam = this.camera;
    cam.position.copy(this.pos);
    cam.up.set(Math.sin(this.roll), Math.cos(this.roll), 0).applyAxisAngle(
      _v.set(0, 1, 0),
      Math.atan2(this.look.x - this.pos.x, this.look.z - this.pos.z),
    );
    cam.lookAt(this.look);
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }

    // Shake: kerbs rattle, walls thump, and the whole car buzzes at top speed.
    const target =
      car.wallHit * 22 + car.kerbHit * 3.4 * speedNorm + (car.offTrack ? 2.6 * speedNorm : 0) +
      speedNorm * speedNorm * 1.6;
    this.shake += (target - this.shake) * Math.min(1, 12 * dt);
  }

  setAspect(aspect: number) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
