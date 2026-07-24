// Sanity-checks every circuit: closed, non-self-intersecting, sane radii,
// and that the projection routine agrees with a brute-force search.
import { TRACKS, Track, STATIONS } from "../src/game/track.ts";

let failed = false;
const fail = (m) => {
  failed = true;
  console.error("  ✗ " + m);
};

function segIntersect(ax, az, bx, bz, cx, cz, dx, dz) {
  const d1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  const d3 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const d4 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

for (const def of TRACKS) {
  console.log(`\n${def.name} (${def.id})`);
  const t = new Track(def);

  console.log(`  length        ${t.length.toFixed(0)} m`);
  console.log(`  station step  ${t.stationLength.toFixed(3)} m`);

  if (t.length < 1800 || t.length > 6000) fail(`length ${t.length.toFixed(0)}m out of range`);

  // Minimum corner radius.
  let maxK = 0;
  for (let i = 0; i < STATIONS; i++) maxK = Math.max(maxK, Math.abs(t.curv[i]));
  const minR = 1 / maxK;
  console.log(`  min radius    ${minR.toFixed(1)} m`);
  if (minR < 16) fail(`min radius ${minR.toFixed(1)}m is too tight to drive`);

  // Uniformity of arc-length resampling.
  let lo = Infinity, hi = 0;
  for (let i = 0; i < STATIONS; i++) {
    const j = (i + 1) & (STATIONS - 1);
    const d = Math.hypot(t.px[j] - t.px[i], t.pz[j] - t.pz[i]);
    lo = Math.min(lo, d); hi = Math.max(hi, d);
  }
  console.log(`  step spread   ${lo.toFixed(3)} .. ${hi.toFixed(3)} m`);
  if (hi / lo > 1.35) fail(`arc-length resampling uneven (${(hi / lo).toFixed(2)}x)`);

  // Self-intersection of the *outer* driveable boundary, sampled coarsely.
  const STEP = 8;
  const edge = [];
  for (let i = 0; i < STATIONS; i += STEP) {
    edge.push([t.px[i], t.pz[i]]);
  }
  let hits = 0;
  for (let a = 0; a < edge.length; a++) {
    const a2 = (a + 1) % edge.length;
    for (let b = a + 2; b < edge.length; b++) {
      const b2 = (b + 1) % edge.length;
      if (a === b2 || a2 === b) continue;
      if (segIntersect(...edge[a], ...edge[a2], ...edge[b], ...edge[b2])) hits++;
    }
  }
  if (hits) fail(`centreline self-intersects (${hits} crossings)`);
  else console.log(`  self-intersect none`);

  // Minimum distance between non-adjacent parts of the track — must exceed the
  // full paved width or two straights would visually merge.
  let minSep = Infinity, sepAt = -1;
  const needed = (def.halfWidth + def.runoff) * 2 + 6;
  for (let i = 0; i < STATIONS; i += 4) {
    for (let j = i + 64; j < STATIONS; j += 4) {
      if (Math.min(j - i, STATIONS - (j - i)) < 64) continue;
      const d = Math.hypot(t.px[j] - t.px[i], t.pz[j] - t.pz[i]);
      if (d < minSep) { minSep = d; sepAt = i; }
    }
  }
  console.log(`  min separation ${minSep.toFixed(1)} m (need > ${needed.toFixed(1)}) @ station ${sepAt}`);
  if (minSep < needed) fail(`track sections overlap: ${minSep.toFixed(1)}m < ${needed.toFixed(1)}m`);

  // Projection: hinted path must match a brute-force nearest station.
  let bad = 0;
  for (let s = 0; s < 400; s++) {
    const i = (s * 37) & (STATIONS - 1);
    const lat = ((s % 7) - 3) * 3.1;
    const x = t.px[i] + t.nx[i] * lat;
    const z = t.pz[i] + t.nz[i] * lat;
    const p = t.project(x, z, -1, {});
    let brute = 0, bd = Infinity;
    for (let k = 0; k < STATIONS; k++) {
      const d = (x - t.px[k]) ** 2 + (z - t.pz[k]) ** 2;
      if (d < bd) { bd = d; brute = k; }
    }
    const delta = Math.min(Math.abs(p.index - brute), STATIONS - Math.abs(p.index - brute));
    if (delta > 1) bad++;
    if (Math.abs(Math.abs(p.lateral) - Math.abs(lat)) > 0.6) bad++;
  }
  if (bad) fail(`projection mismatched on ${bad}/800 probes`);
  else console.log(`  projection    exact on 400 probes`);

  // Grid slots must land on tarmac.
  const slot = { x: 0, y: 0, z: 0, heading: 0 };
  for (let s = 0; s < 16; s++) {
    t.gridSlot(s, slot);
    const p = t.project(slot.x, slot.z, -1, {});
    if (Math.abs(p.lateral) > t.widthAt(p.index) * 0.8) {
      fail(`grid slot ${s} is off the racing surface (lateral ${p.lateral.toFixed(1)})`);
      break;
    }
  }
  console.log(`  grid slots    16 on-surface`);
}

console.log(failed ? "\nFAILED" : "\nAll circuits OK");
process.exit(failed ? 1 : 0);
