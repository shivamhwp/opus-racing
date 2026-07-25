import { CAR, type CarInput, type CarSim } from "./physics";
import { STATIONS, type Track } from "./track";

/**
 * A reference driver, used for the attract-mode lap running behind the menus.
 *
 * Pure pursuit for steering, plus a corner-speed target solved from the
 * curvature ahead. Because grip itself grows with speed, `v² = grip/k` is a
 * fixed point rather than a formula — solving it in closed form is what stops
 * the target running away to the speed limiter on a fast sweeper:
 *
 *     v² = μg / (k − μg·df)      and if the denominator is not positive,
 *                                downforce wins and the corner is flat.
 *
 * This is the same controller the physics test suite uses to prove every
 * circuit can be driven cleanly, so the demo lap is a live regression check.
 */
export function autopilot(car: CarSim, track: Track, out: CarInput, pace = 0.88): CarInput {
  const v = Math.abs(car.speed);

  const ld = 8 + v * 0.5;
  const ai = (car.station + Math.round(ld / track.stationLength)) & (STATIONS - 1);
  let alpha = Math.atan2(track.px[ai] - car.x, track.pz[ai] - car.z) - car.heading;
  while (alpha > Math.PI) alpha -= Math.PI * 2;
  while (alpha < -Math.PI) alpha += Math.PI * 2;

  const delta = Math.atan2(2 * CAR.wheelbase * Math.sin(alpha), Math.max(4, ld));
  const rack = CAR.maxSteer / (1 + v * CAR.steerSpeedFalloff);
  // `delta` and `car.lateral` are both in the world's heading-increasing sense,
  // whereas `out.steer` is the driver-facing one where +1 means right. Negate.
  out.steer = Math.max(-1, Math.min(1, -(delta / rack + car.lateral * 0.04)));

  // Look ahead by the current braking distance, plus a margin.
  let maxK = 1e-6;
  const scan = Math.round((25 + ((v * v) / (2 * CAR.brakeAccel)) * 1.35) / track.stationLength);
  for (let k = 2; k < scan; k += 2) {
    const c = Math.abs(track.curv[(car.station + k) & (STATIONS - 1)]);
    if (c > maxK) maxK = c;
  }
  const mug = CAR.mu[0] * 9.81;
  const denom = maxK - mug * CAR.downforce;
  const target = Math.min(CAR.maxSpeed, denom > 1e-5 ? Math.sqrt(mug / denom) : CAR.maxSpeed) * pace;

  out.throttle = car.speed < target ? 1 : 0;
  out.brake = car.speed > target * 1.03 ? Math.min(1, (car.speed - target) / 6) : 0;
  out.handbrake = false;
  out.drs = track.corner[car.station] < 0.1 && car.speed > 45;
  return out;
}
