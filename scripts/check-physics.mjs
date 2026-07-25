// Verifies the handling model produces real F1 numbers, and that a simple
// pure-pursuit driver can complete a clean lap of every circuit — which is the
// only honest proof that the track + physics combination is actually driveable.
import { TRACKS, Track, STATIONS } from "../src/game/track.ts";
import { CarSim, CAR } from "../src/game/physics.ts";

const DT = 1 / 120;
let failed = false;
const fail = (m) => { failed = true; console.error("  ✗ " + m); };
const ok = (m) => console.log("  ✓ " + m);

const inp = (o = {}) => ({ throttle: 0, brake: 0, steer: 0, handbrake: false, drs: false, ...o });

/**
 * An infinite flat tarmac plane. Isolates the handling model from circuit
 * layout so acceleration, braking and steady-state cornering measure the car
 * and nothing else.
 */
function proving(surface = 0) {
  const t = new Track(TRACKS[0]);
  t.halfW[0] = 12;
  t.def = { ...t.def, runoff: 10 };
  // 0..12 tarmac, 12..22 runoff, 22..25.5 grass (the barrier sits at 25.5).
  const lateral = surface === 0 ? 0 : surface === 1 ? 16 : 24;
  t.project = (x, z, hint, out = {}) => {
    out.index = 0; out.lateral = lateral; out.heading = 0;
    out.curvature = 0; out.distance = 0; out.progress = 0.5;
    return out;
  };
  t.heightAt = () => 0;
  t.bank[0] = 0;
  return t;
}

const track = proving();

function fresh(tk = track) {
  const c = new CarSim();
  c.reset(tk, 0, 0, 0, 0);
  return c;
}

console.log("Handling model");

// --- 0-100 km/h and top speed ---
{
  const c = fresh();
  let t = 0, to100 = null, to200 = null;
  while (t < 30) {
    c.update(DT, inp({ throttle: 1 }), track);
    t += DT;
    if (to100 === null && c.speed * 3.6 >= 100) to100 = t;
    if (to200 === null && c.speed * 3.6 >= 200) to200 = t;
  }
  const top = c.speed * 3.6;
  console.log(`  0-100 km/h    ${to100?.toFixed(2)} s`);
  console.log(`  0-200 km/h    ${to200?.toFixed(2)} s`);
  console.log(`  top speed     ${top.toFixed(0)} km/h`);
  if (!(to100 > 1.5 && to100 < 3.5)) fail(`0-100 of ${to100?.toFixed(2)}s is not F1-like (want 1.5-3.5s)`);
  if (!(top > 300 && top < 350)) fail(`top speed ${top.toFixed(0)} km/h out of range`);
}

// --- DRS actually does something ---
{
  const run = (drs) => {
    const c = fresh();
    for (let t = 0; t < 40; t += DT) c.update(DT, inp({ throttle: 1, drs }), track);
    return c.speed * 3.6;
  };
  const a = run(false), b = run(true);
  console.log(`  DRS gain      +${(b - a).toFixed(0)} km/h`);
  if (b - a < 10) fail("DRS gives less than 10 km/h");
}

// --- braking from 300 km/h ---
{
  const c = fresh();
  for (let t = 0; t < 40; t += DT) c.update(DT, inp({ throttle: 1 }), track);
  const v0 = c.speed;
  let dist = 0, time = 0;
  while (c.speed > 0.5 && time < 20) {
    const before = c.speed;
    c.update(DT, inp({ brake: 1 }), track);
    dist += ((before + c.speed) / 2) * DT;
    time += DT;
  }
  const g = v0 / time / 9.81;
  console.log(`  brake ${(v0 * 3.6).toFixed(0)}→0  ${dist.toFixed(0)} m in ${time.toFixed(2)} s (${g.toFixed(1)} g avg)`);
  if (!(g > 2.5 && g < 7)) fail(`average braking ${g.toFixed(1)}g out of range`);
}

// --- steady-state cornering g at speed ---
{
  for (const [targetKph, lo, hi] of [[100, 1.5, 3.0], [200, 2.6, 4.6], [300, 4.0, 7.0]]) {
    const c = fresh();
    const target = targetKph / 3.6;
    for (let t = 0; t < 60; t += DT) {
      c.update(DT, inp({
        throttle: c.speed < target ? 1 : 0,
        brake: c.speed > target + 1 ? 0.25 : 0,
        steer: 1,
      }), track);
    }
    const lat = Math.abs(c.yawRate * c.speed) / 9.81;
    const radius = Math.abs(c.speed / c.yawRate);
    console.log(`  lateral @${targetKph} km/h  ${lat.toFixed(1)} g (radius ${radius.toFixed(0)} m)`);
    if (!(lat > lo && lat < hi)) fail(`${lat.toFixed(1)}g at ${targetKph} km/h outside ${lo}-${hi}g`);
  }
}

// --- grass must be genuinely slower than tarmac ---
{
  const names = ["tarmac", "runoff", "grass"];
  const speeds = names.map((_, s) => {
    const c = fresh(proving(s));
    const tk = proving(s);
    const car = fresh(tk);
    for (let t = 0; t < 8; t += DT) car.update(DT, inp({ throttle: 1 }), tk);
    void c;
    return car.speed * 3.6;
  });
  console.log(`  8 s from rest: ${names.map((n, i) => `${n} ${speeds[i].toFixed(0)}`).join(" · ")} km/h`);
  if (!(speeds[0] > speeds[1] && speeds[1] > speeds[2])) fail("surfaces are not ordered tarmac > runoff > grass");
  else if (speeds[2] > speeds[0] * 0.8) fail("grass is not meaningfully slower than tarmac");
  else if (speeds[2] < 25) fail("grass is so slow a car could never rejoin");
  else ok("off-track surfaces punish but stay recoverable");
}

// --- no NaNs under abusive input, on a real circuit with real barriers ---
{
  const real = new Track(TRACKS[0]);
  const c = fresh(real);
  const track = real;
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let t = 0; t < 120; t += DT) {
    c.update(DT, inp({
      throttle: rnd(), brake: rnd() > 0.7 ? rnd() : 0,
      steer: rnd() * 2 - 1, handbrake: rnd() > 0.9, drs: rnd() > 0.8,
    }), track);
    if (!Number.isFinite(c.x + c.z + c.speed + c.heading + c.yawRate + c.y)) {
      fail(`state went non-finite at t=${t.toFixed(2)}`);
      break;
    }
  }
  if (Number.isFinite(c.x)) ok("stable under 120 s of random input");
  const p = track.project(c.x, c.z, -1, {});
  const wall = track.halfW[p.index] + track.def.runoff + 4;
  if (Math.abs(p.lateral) > wall) fail(`car escaped the barriers (lateral ${p.lateral.toFixed(1)} > ${wall.toFixed(1)})`);
  else ok("barriers contained the car");
}

// --- pure-pursuit driver must complete a lap of every circuit ---
console.log("\nDriveability (pure-pursuit reference driver)");
for (const def of TRACKS) {
  const tk = new Track(def);
  const c = new CarSim();
  const i0 = 0;
  c.reset(tk, tk.px[i0], tk.py[i0], tk.pz[i0], Math.atan2(tk.tx[i0], tk.tz[i0]));

  let t = 0, offTicks = 0, wallTicks = 0;
  const LIMIT = 240;
  while (c.lap < 1 && t < LIMIT) {
    const v = Math.abs(c.speed);

    // Pure pursuit: aim at a lookahead point on the centreline, convert the
    // required arc into a steering angle, then normalise against the rack
    // travel actually available at this speed.
    const ld = 8 + v * 0.5;
    const ai = (c.station + Math.round(ld / tk.stationLength)) & (STATIONS - 1);
    const dx = tk.px[ai] - c.x, dz = tk.pz[ai] - c.z;
    let alpha = Math.atan2(dx, dz) - c.heading;
    while (alpha > Math.PI) alpha -= Math.PI * 2;
    while (alpha < -Math.PI) alpha += Math.PI * 2;
    const delta = Math.atan2(2 * CAR.wheelbase * Math.sin(alpha), Math.max(4, ld));
    const rackAtSpeed = CAR.maxSteer / (1 + v * CAR.steerSpeedFalloff);
    // `delta` and `lateral` are both in the world's heading-increasing sense.
    // `steer` is the driver-facing convention where +1 means right, which is a
    // decreasing heading — so the whole thing is negated.
    const steer = Math.max(-1, Math.min(1, -(delta / rackAtSpeed + c.lateral * 0.04)));

    // Speed target from the tightest curvature inside the braking zone ahead.
    // v² = grip/k where grip itself grows with v², so solve it in closed form:
    // v² = μg / (k − μg·df). A non-positive denominator means downforce wins
    // and the corner is flat out.
    let maxK = 1e-6;
    const scan = Math.round((25 + (v * v) / (2 * CAR.brakeAccel) * 1.35) / tk.stationLength);
    for (let k = 2; k < scan; k += 2) maxK = Math.max(maxK, Math.abs(tk.curv[(c.station + k) & (STATIONS - 1)]));
    const mug = CAR.mu[0] * 9.81;
    const denom = maxK - mug * CAR.downforce;
    let vTarget = denom > 1e-5 ? Math.sqrt(mug / denom) : CAR.maxSpeed;
    vTarget = Math.min(CAR.maxSpeed, vTarget) * 0.88;

    c.update(DT, inp({
      throttle: c.speed < vTarget ? 1 : 0,
      brake: c.speed > vTarget * 1.03 ? Math.min(1, (c.speed - vTarget) / 6) : 0,
      steer,
      drs: tk.corner[c.station] < 0.1,
    }), tk);
    if (c.offTrack) offTicks++;
    if (c.wallHit > 0) wallTicks++;
    t += DT;
  }

  const pct = (n) => ((n * DT) / t * 100).toFixed(1);
  if (c.lap < 1) {
    fail(`${def.name}: driver failed to finish a lap in ${LIMIT}s (reached ${(c.progress * 100).toFixed(0)}%)`);
  } else {
    const avg = (tk.length / t) * 3.6;
    console.log(`  ${def.name.padEnd(14)} lap ${t.toFixed(2)}s · avg ${avg.toFixed(0)} km/h · off-track ${pct(offTicks)}% · wall ${pct(wallTicks)}%`);
    if (t > 150) fail(`${def.name}: lap time ${t.toFixed(1)}s is implausibly slow`);
    if (offTicks * DT / t > 0.25) fail(`${def.name}: reference driver spent ${pct(offTicks)}% off track`);
  }
}

console.log(failed ? "\nFAILED" : "\nPhysics OK");
process.exit(failed ? 1 : 0);
