import type { Track } from "./track";
import type { Projection } from "./track";

/**
 * Arcade-but-honest F1 handling model.
 *
 * A yaw-rate bicycle model whose cornering and braking are bounded by a
 * friction circle, with grip scaling by aerodynamic downforce. The tuned
 * numbers land where a real car does: ~5 g under brakes, ~6 g lateral at top
 * speed, ~340 km/h with DRS open. Everything is scalar maths on a flat object —
 * no allocation per tick, so 16 cars simulate inside a fraction of a frame.
 */

export const SURFACE_TARMAC = 0;
export const SURFACE_RUNOFF = 1;
export const SURFACE_GRASS = 2;

const G = 9.81;

export const CAR = {
  /** Hard clamp only — real top speed falls out of power vs. drag below. */
  maxSpeed: 100,
  /** Tyre-limited launch acceleration, m/s² (≈1.3 g). */
  tractionAccel: 13,
  /** Specific power, m²/s³ — 735 kW over 800 kg. Accel = power / speed. */
  power: 900,
  brakeAccel: 42, // ≈ 4.3 g
  wheelbase: 3.6,
  maxSteer: 0.54, // rad at parking speed
  steerSpeedFalloff: 0.043,
  steerRate: 9.5, // how fast the rack follows input
  /** Grip multiplier per (m/s)²: 1 + df·v². 3.3x at 300 km/h. */
  downforce: 0.00033,
  dragCoef: 0.00125,
  drsDragCoef: 0.00104,
  rollingResist: 0.55,
  wheelRadius: 0.36,
  halfLength: 2.6,
  halfWidth: 1.0,
  mu: [1.78, 1.12, 0.58], // tarmac, runoff, grass
  /** Constant scrub, m/s². Must stay under the surface's standing grip or the
   *  car could never drive out of the gravel again. */
  surfaceDrag: [0, 2.4, 3.2],
  /** Speed-proportional scrub — what actually caps off-track top speed. */
  surfaceDragV: [0, 0.06, 0.14],
  yawResponse: 11,
  driftYawGain: 1.55, // extra rotation available on the handbrake
} as const;

/** Speed (m/s) at which each gear tops out. */
const GEAR_TOPS = [14, 25, 37, 48, 59, 70, 80, 999];

export interface CarInput {
  throttle: number; // 0..1
  brake: number; // 0..1
  steer: number; // -1..1
  handbrake: boolean;
  drs: boolean;
}

export const NEUTRAL_INPUT: CarInput = {
  throttle: 0,
  brake: 0,
  steer: 0,
  handbrake: false,
  drs: false,
};

export class CarSim {
  x = 0;
  y = 0;
  z = 0;
  heading = 0;
  /** World-space velocity. */
  vx = 0;
  vz = 0;
  yawRate = 0;
  /** Signed forward speed, m/s. */
  speed = 0;
  /** Sideways slip velocity, m/s. */
  slip = 0;
  steerAngle = 0;
  wheelSpin = 0;
  /** Visual body roll / pitch, radians. */
  roll = 0;
  pitch = 0;
  /** Suspension travel proxy, metres. */
  bob = 0;
  private bobVel = 0;

  surface = SURFACE_TARMAC;
  drifting = false;
  offTrack = false;
  wallHit = 0;
  kerbHit = 0;
  /** 0..1 how saturated the tyres are — drives the HUD grip bar + tyre smoke. */
  gripUse = 0;

  station = 0;
  lateral = 0;
  progress = 0;
  lap = 0;
  /** Monotonic distance covered, metres — used for race position ordering. */
  distance = 0;
  private lastProgress = 0;
  finished = false;

  gear = 1;
  rpm = 0.12;

  private readonly proj: Projection = {
    index: 0,
    progress: 0,
    lateral: 0,
    heading: 0,
    curvature: 0,
    distance: 0,
  };

  /** Fires with the lap number when the car crosses the line forwards. */
  onLap: ((lap: number) => void) | null = null;

  reset(track: Track, x: number, y: number, z: number, heading: number) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.heading = heading;
    this.vx = 0;
    this.vz = 0;
    this.speed = 0;
    this.slip = 0;
    this.yawRate = 0;
    this.steerAngle = 0;
    this.roll = 0;
    this.pitch = 0;
    this.bob = 0;
    this.bobVel = 0;
    this.drifting = false;
    this.wallHit = 0;
    this.kerbHit = 0;
    const p = track.project(x, z, -1, this.proj);
    this.station = p.index;
    this.lateral = p.lateral;
    this.progress = p.progress;
    this.lastProgress = p.progress;
  }

  /** Put the car back on the racing line at its current station. */
  respawn(track: Track) {
    const i = this.station;
    this.x = track.px[i];
    this.z = track.pz[i];
    this.y = track.py[i];
    this.heading = Math.atan2(track.tx[i], track.tz[i]);
    this.vx = 0;
    this.vz = 0;
    this.speed = 0;
    this.slip = 0;
    this.yawRate = 0;
  }

  update(dt: number, input: CarInput, track: Track) {
    // --- where are we on the circuit -------------------------------------
    const p = track.project(this.x, this.z, this.station, this.proj);
    this.station = p.index;
    this.lateral = p.lateral;

    const halfW = track.halfW[p.index];
    const absLat = Math.abs(p.lateral);
    const runoffEdge = halfW + track.def.runoff;
    this.surface =
      absLat <= halfW
        ? SURFACE_TARMAC
        : absLat <= runoffEdge
          ? SURFACE_RUNOFF
          : SURFACE_GRASS;
    this.offTrack = this.surface !== SURFACE_TARMAC;

    // Kerb strip: the outer 12% of the racing surface.
    const onKerb = absLat > halfW * 0.88 && absLat <= halfW * 1.02;
    this.kerbHit = onKerb && Math.abs(this.speed) > 6 ? 1 : 0;

    // --- lap bookkeeping ---------------------------------------------------
    const prev = this.lastProgress;
    const cur = p.progress;
    if (prev > 0.75 && cur < 0.25) {
      this.lap++;
      this.onLap?.(this.lap);
    } else if (prev < 0.25 && cur > 0.75) {
      this.lap--;
    }
    this.lastProgress = cur;
    this.progress = cur;
    this.distance = (this.lap + cur) * track.length;

    // --- longitudinal ------------------------------------------------------
    const sinH = Math.sin(this.heading);
    const cosH = Math.cos(this.heading);
    let vLong = this.vx * sinH + this.vz * cosH;
    let vLat = this.vx * cosH - this.vz * sinH;

    const speedAbs = Math.abs(vLong);
    const mu = CAR.mu[this.surface];
    const gripLimit = mu * G * (1 + CAR.downforce * speedAbs * speedAbs);

    // Power-limited above ~70 m/s, traction-limited below it — the crossover is
    // what makes the last 40 km/h take so much longer than the first 100.
    let accel =
      input.throttle * Math.min(CAR.tractionAccel, CAR.power / Math.max(8, speedAbs));
    if (input.handbrake) accel *= 0.35;

    // Brakes act against motion; below walking pace they let you reverse.
    let longAccel = accel;
    if (input.brake > 0) {
      if (vLong > 0.6) longAccel -= input.brake * CAR.brakeAccel;
      else longAccel -= input.brake * CAR.tractionAccel * 0.55; // reverse
    }
    // Tyres cannot deliver more than the friction circle, whichever way it goes.
    if (longAccel > gripLimit) longAccel = gripLimit;
    else if (longAccel < -gripLimit) longAccel = -gripLimit;

    // Drag and rolling losses sit outside the circle — they are not tyre forces.
    const dragC = input.drs ? CAR.drsDragCoef : CAR.dragCoef;
    let resist = dragC * vLong * speedAbs;
    resist +=
      (CAR.rollingResist +
        CAR.surfaceDrag[this.surface] +
        CAR.surfaceDragV[this.surface] * speedAbs) *
      Math.sign(vLong);
    if (input.handbrake && vLong > 0) resist += 14;

    // Whatever the tyres spend going forwards is not available for turning.
    // This is what makes trail-braking and throttle-on understeer emerge
    // instead of being scripted.
    const longUsed = Math.abs(longAccel);
    const latCapacity = Math.sqrt(Math.max(0, gripLimit * gripLimit - longUsed * longUsed));

    vLong += (longAccel - resist) * dt;
    if (vLong > CAR.maxSpeed) vLong = CAR.maxSpeed;
    if (vLong < -12) vLong = -12;
    // Kill the residual creep that rolling resistance would otherwise oscillate.
    if (input.throttle < 0.02 && Math.abs(vLong) < 0.35) vLong = 0;

    // --- steering & yaw ----------------------------------------------------
    const steerTarget =
      CAR.maxSteer * input.steer * (1 / (1 + speedAbs * CAR.steerSpeedFalloff));
    this.steerAngle += (steerTarget - this.steerAngle) * Math.min(1, CAR.steerRate * dt);

    let desiredYaw = (vLong * Math.tan(this.steerAngle)) / CAR.wheelbase;
    // The tyres can only bend the path as hard as the friction circle allows.
    let yawCap = latCapacity / Math.max(6, speedAbs);
    if (input.handbrake) yawCap *= CAR.driftYawGain;
    if (desiredYaw > yawCap) desiredYaw = yawCap;
    else if (desiredYaw < -yawCap) desiredYaw = -yawCap;

    this.yawRate += (desiredYaw - this.yawRate) * Math.min(1, CAR.yawResponse * dt);
    this.heading += this.yawRate * dt;

    // Rotating the chassis leaves the velocity pointing where it was: that
    // difference *is* the slip angle. Grip then eats it, up to its capacity.
    const dH = this.yawRate * dt;
    const cs = Math.cos(dH);
    const sn = Math.sin(dH);
    const nLong = vLong * cs + vLat * sn;
    const nLat = vLat * cs - vLong * sn;
    vLong = nLong;
    vLat = nLat;

    let latGrip = latCapacity;
    if (input.handbrake) latGrip *= 0.42;
    const latDemand = Math.abs(vLat) / dt;
    const latApplied = Math.min(latDemand, latGrip);
    vLat -= Math.sign(vLat) * latApplied * dt;

    this.gripUse = gripLimit > 0 ? Math.min(1, (longUsed + latApplied) / gripLimit) : 0;
    this.drifting = Math.abs(vLat) > 2.4 || (input.handbrake && speedAbs > 8);
    this.slip = vLat;
    this.speed = vLong;

    // --- integrate ---------------------------------------------------------
    const sinH2 = Math.sin(this.heading);
    const cosH2 = Math.cos(this.heading);
    this.vx = vLong * sinH2 + vLat * cosH2;
    this.vz = vLong * cosH2 - vLat * sinH2;
    this.x += this.vx * dt;
    this.z += this.vz * dt;

    // --- barriers ----------------------------------------------------------
    this.wallHit = 0;
    const wall = runoffEdge + 3.5;
    const after = track.project(this.x, this.z, this.station, this.proj);
    if (Math.abs(after.lateral) > wall) {
      const side = Math.sign(after.lateral);
      const push = Math.abs(after.lateral) - wall;
      const i = after.index;
      this.x -= track.nx[i] * side * push;
      this.z -= track.nz[i] * side * push;
      // Reflect only the component into the wall, and scrub speed.
      const intoWall = this.vx * track.nx[i] * side + this.vz * track.nz[i] * side;
      if (intoWall > 0) {
        this.vx -= track.nx[i] * side * intoWall * 1.45;
        this.vz -= track.nz[i] * side * intoWall * 1.45;
        this.wallHit = Math.min(1, intoWall / 22);
      }
      this.speed *= 0.86;
      this.yawRate *= 0.5;
      this.station = after.index;
      this.lateral = after.lateral;
    }

    // --- ride height, roll, pitch -----------------------------------------
    const targetY = track.heightAt(this.station + after.lateral * 0) + 0.34;
    // Kerbs and grass shake the car; a critically damped spring keeps it sane.
    const bumpFreq = this.surface === SURFACE_GRASS ? 34 : onKerb ? 52 : 0;
    const bumpAmp = this.surface === SURFACE_GRASS ? 0.09 : onKerb ? 0.055 : 0;
    const bump =
      bumpAmp > 0
        ? Math.sin(this.wheelSpin * bumpFreq * 0.1) * bumpAmp * Math.min(1, speedAbs / 25)
        : 0;
    const k = 220,
      c = 26;
    this.bobVel += (-k * (this.bob - bump) - c * this.bobVel) * dt;
    this.bob += this.bobVel * dt;
    this.y = targetY + this.bob;

    const bankRoll = track.bank[this.station];
    const targetRoll = bankRoll - this.yawRate * Math.abs(vLong) * 0.0058 - vLat * 0.011;
    const targetPitch = -longAccel * 0.0032;
    this.roll += (targetRoll - this.roll) * Math.min(1, 8 * dt);
    this.pitch += (targetPitch - this.pitch) * Math.min(1, 10 * dt);

    // --- drivetrain readouts ----------------------------------------------
    const lock = input.brake > 0.55 && speedAbs > 4 ? 0.15 : 1;
    const spinUp = this.drifting && input.throttle > 0.7 ? 1.5 : 1;
    this.wheelSpin += ((vLong * spinUp * lock) / CAR.wheelRadius) * dt;

    let g = 0;
    while (g < GEAR_TOPS.length - 1 && speedAbs > GEAR_TOPS[g]) g++;
    this.gear = vLong < -0.5 ? -1 : g + 1;
    const lo = g === 0 ? 0 : GEAR_TOPS[g - 1];
    const hi = GEAR_TOPS[g] === 999 ? 94 : GEAR_TOPS[g];
    const band = (speedAbs - lo) / Math.max(1, hi - lo);
    const targetRpm = 0.18 + Math.min(1, Math.max(0, band)) * 0.82;
    this.rpm += (targetRpm - this.rpm) * Math.min(1, 12 * dt);
  }

  /** True when the car is on a straight and close enough to use DRS. */
  drsAvailable(track: Track): boolean {
    return track.corner[this.station] < 0.12 && this.speed > 45;
  }
}

/**
 * Resolve car-vs-car contact as equal-mass circle pushes. O(n²) but n ≤ 16, so
 * it is a rounding error next to a single draw call.
 */
export function resolveCarCollisions(cars: CarSim[]) {
  const r = 2.3;
  const minDist = r * 2;
  for (let i = 0; i < cars.length; i++) {
    const a = cars[i];
    for (let j = i + 1; j < cars.length; j++) {
      const b = cars[j];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > minDist * minDist || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const nx = dx / d;
      const nz = dz / d;
      const overlap = (minDist - d) * 0.5;
      a.x -= nx * overlap;
      a.z -= nz * overlap;
      b.x += nx * overlap;
      b.z += nz * overlap;
      // Exchange the closing component of momentum with heavy damping so
      // contact nudges rather than launches.
      const rel = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
      if (rel < 0) {
        const imp = rel * 0.55;
        a.vx += nx * imp;
        a.vz += nz * imp;
        b.vx -= nx * imp;
        b.vz -= nz * imp;
        a.wallHit = Math.max(a.wallHit, Math.min(1, -rel / 25));
        b.wallHit = Math.max(b.wallHit, Math.min(1, -rel / 25));
      }
    }
  }
}
