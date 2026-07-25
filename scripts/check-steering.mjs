// Verifies that steering goes the way the driver asked.
//
// This is the one property the rest of the physics suite structurally cannot
// catch: every other check measures a *magnitude* — how many g, how many
// metres, how many seconds — and a mirrored steering axis produces identical
// magnitudes. The reference driver even completes clean laps with the sign
// inverted, because its own correction is inverted in the same way.
//
// So the check has to reach all the way to the screen: set the camera up
// exactly as the game does, project world points through it, and asserts that
// pressing left moves the car toward the left-hand side of the frame.
import { Matrix4, PerspectiveCamera, Vector3 } from "three";
import { CarSim, CAR, rackLimit } from "../src/game/physics.ts";
import { Track, TRACKS } from "../src/game/track.ts";
import { DIMS } from "../src/game/carModel.ts";

let failed = false;
const check = (ok, label, extra = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${extra ? " — " + extra : ""}`);
  if (!ok) failed = true;
};

/** Flat, infinite tarmac: isolates the handling model from circuit layout. */
function proving() {
  const t = new Track(TRACKS[0]);
  t.project = (x, z, hint, out = {}) => {
    out.index = 0; out.lateral = 0; out.heading = 0;
    out.curvature = 0; out.distance = 0; out.progress = 0.5;
    return out;
  };
  t.heightAt = () => 0;
  t.bank[0] = 0;
  return t;
}

const inp = (steer) => ({ throttle: 1, brake: 0, steer, handbrake: false, drs: false });

// --- which world direction is screen-right? ---------------------------------
// Mirrors ChaseCamera: sit behind the car, aim along its forward axis.
const cam = new PerspectiveCamera(60, 16 / 9, 0.25, 6000);
const carPos = new Vector3(0, 0.34, 0);
const fwd = new Vector3(0, 0, 1); // heading 0 => forward is +Z
cam.position.copy(carPos).addScaledVector(fwd, -8.6).setY(carPos.y + 2.75);
cam.up.set(0, 1, 0);
cam.lookAt(carPos.clone().addScaledVector(fwd, 15).setY(carPos.y + 2.05));
cam.updateMatrixWorld(true);

const ndcX = (v) => v.clone().project(cam).x;
const SCREEN_RIGHT_IS_PLUS_X = ndcX(new Vector3(10, 0.34, 20)) > 0;

console.log("Steering");
console.log(
  `  world +X projects to screen ${SCREEN_RIGHT_IS_PLUS_X ? "RIGHT" : "LEFT"}`,
);

// --- the car goes where the driver pointed it -------------------------------
function driveFor(steer, seconds = 3) {
  const track = proving();
  const car = new CarSim();
  car.reset(track, 0, 0, 0, 0);
  for (let t = 0; t < seconds; t += 1 / 120) car.update(1 / 120, inp(steer), track);
  return car;
}

const right = driveFor(+1);
const left = driveFor(-1);

const wentScreenRight = (car) =>
  SCREEN_RIGHT_IS_PLUS_X ? car.x > 1 : car.x < -1;

check(wentScreenRight(right), "steer +1 (right arrow / stick right) turns right",
  `x = ${right.x.toFixed(1)}`);
check(!wentScreenRight(left) && Math.abs(left.x) > 1,
  "steer -1 (left arrow / stick left) turns left", `x = ${left.x.toFixed(1)}`);
check(Math.abs(right.x + left.x) < 0.5, "the two are mirror images",
  `${right.x.toFixed(1)} vs ${left.x.toFixed(1)}`);

// --- the front wheels point the same way ------------------------------------
// Rebuilds the transform chain from Game.updateCars so a change there is caught.
function frontWheelYaw(car) {
  const body = new Matrix4().makeRotationY(car.heading);
  body.multiply(new Matrix4().makeRotationZ(car.roll));
  const wheel = new Matrix4().makeTranslation(DIMS.frontTrack, DIMS.tyreRadius, DIMS.frontAxleZ);
  wheel.multiply(new Matrix4().makeRotationY(car.steerAngle));
  wheel.premultiply(body);
  // The wheel's local forward is +Z; take it into world space.
  const dir = new Vector3(0, 0, 1).transformDirection(wheel);
  return Math.atan2(dir.x, dir.z);
}

/** Signed difference, wrapped to (-pi, pi]. */
const delta = (a, b) => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
};

for (const [label, car, wantRight] of [["right", right, true], ["left", left, false]]) {
  // Compare the wheel's heading against the chassis heading. A wheel steered to
  // the driver's right must sit on the same side the car is turning toward.
  const turn = delta(car.heading, frontWheelYaw(car));
  // Turning right is a decreasing heading, so a right-steered wheel is negative.
  const wheelPointsRight = turn < 0;
  check(
    Math.abs(turn) > 1e-3 && wheelPointsRight === wantRight,
    `front wheels point ${wantRight ? "right" : "left"} when steering ${label}`,
    `${((turn * 180) / Math.PI).toFixed(1)}°`,
  );
}

// --- the body leans out of the corner ---------------------------------------
// Local +X is the car's left side, so a right-hand turn must roll negative.
check(right.roll < 0 && left.roll > 0, "body leans away from the corner",
  `right ${(right.roll * 180 / Math.PI).toFixed(1)}°, left ${(left.roll * 180 / Math.PI).toFixed(1)}°`);
check(Math.abs(right.roll) < 0.12, "body roll stays plausible",
  `${Math.abs(right.roll * 180 / Math.PI).toFixed(1)}° (want under 7°)`);

// --- the steering rack is sane ----------------------------------------------
check(Math.abs(right.steerAngle) <= CAR.maxSteer + 1e-6,
  "rack angle never exceeds the mechanical limit",
  `${Math.abs(right.steerAngle).toFixed(3)} rad`);

// --- full lock must mean the same thing at every speed -----------------------
// This is what makes steering feel linear. With a flat 1/(1+kv) rack, full lock
// asked for 0.6x the grip limit at 36 km/h and 4.0x at 288 — so most of the
// travel did nothing, and how much of it mattered changed with speed.
const G = 9.81;
console.log("\n  Steering authority (full lock vs. the grip limit):");
let minRatio = Infinity, maxRatio = 0;
for (const v of [20, 30, 45, 60, 80]) {
  const demand = (v * Math.tan(rackLimit(v))) / CAR.wheelbase;
  const cap = (CAR.mu[0] * G * (1 + CAR.downforce * v * v)) / Math.max(6, v);
  const ratio = demand / cap;
  minRatio = Math.min(minRatio, ratio);
  maxRatio = Math.max(maxRatio, ratio);
  console.log(`    ${String(Math.round(v * 3.6)).padStart(3)} km/h   ${ratio.toFixed(2)}x   corner radius ${(v / Math.min(demand, cap)).toFixed(0)} m`);
}
check(minRatio > 1.05, "full lock always reaches the grip limit", `min ${minRatio.toFixed(2)}x`);
check(maxRatio < 1.6, "full lock never wildly overshoots it", `max ${maxRatio.toFixed(2)}x`);
check(maxRatio - minRatio < 0.25, "authority is consistent across the speed range",
  `spread ${(maxRatio - minRatio).toFixed(2)}`);

// --- turn-in has to be prompt ------------------------------------------------
{
  const track = proving();
  const car = new CarSim();
  car.reset(track, 0, 0, 0, 0);
  // Get to ~200 km/h in a straight line first.
  for (let t = 0; t < 12; t += 1 / 120) car.update(1 / 120, inp(0), track);
  const v = car.speed;
  let settled = 0;
  const target = Math.min(
    (v * Math.tan(rackLimit(v))) / CAR.wheelbase,
    (CAR.mu[0] * G * (1 + CAR.downforce * v * v)) / Math.max(6, v),
  );
  for (let t = 0; t < 2; t += 1 / 120) {
    car.update(1 / 120, { throttle: 0, brake: 0, steer: 1, handbrake: false, drs: false }, track);
    if (Math.abs(car.yawRate) >= target * 0.9) { settled = t; break; }
  }
  check(settled > 0 && settled < 0.45, "reaches 90% of steady yaw promptly",
    `${(settled * 1000).toFixed(0)} ms at ${(v * 3.6).toFixed(0)} km/h`);
}

console.log(failed ? "\nFAILED" : "\nSteering OK");
process.exit(failed ? 1 : 0);
