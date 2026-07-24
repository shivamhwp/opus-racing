// Verifies the generated circuit geometry.
//
// The check that matters here is triangle winding. A ribbon wound the wrong way
// round is invisible under backface culling but throws no error, compiles fine,
// and still reports healthy frame times — the failure mode is a silently black
// road. So every horizontal surface is asserted to actually face the sky.
import { Vector3 } from "three";
import { TRACKS, Track } from "../src/game/track.ts";
import { World } from "../src/game/world.ts";

let failed = false;
const fail = (m) => { failed = true; console.error("  ✗ " + m); };

const a = new Vector3(), b = new Vector3(), c = new Vector3();
const e1 = new Vector3(), e2 = new Vector3(), n = new Vector3();

/** Fraction of triangles whose geometric normal points along +Y. */
function facingUp(geo) {
  const pos = geo.getAttribute("position");
  const idx = geo.getIndex();
  if (!idx) return { up: 0, total: 0 };
  let up = 0;
  const total = idx.count / 3;
  for (let t = 0; t < idx.count; t += 3) {
    a.fromBufferAttribute(pos, idx.getX(t));
    b.fromBufferAttribute(pos, idx.getX(t + 1));
    c.fromBufferAttribute(pos, idx.getX(t + 2));
    e1.subVectors(b, a);
    e2.subVectors(c, a);
    n.crossVectors(e1, e2);
    if (n.y > 0) up++;
  }
  return { up, total };
}

for (const def of TRACKS) {
  console.log(`\n${def.name}`);
  const track = new Track(def);
  const world = new World(track);

  const meshes = [];
  world.scene.traverse((o) => { if (o.isMesh || o.isInstancedMesh) meshes.push(o); });
  console.log(`  meshes        ${meshes.length} (${world.staticDrawCalls} static draw calls)`);
  if (world.staticDrawCalls > 14) fail(`${world.staticDrawCalls} static draw calls is over budget`);

  let tris = 0;
  for (const m of meshes) {
    const g = m.geometry;
    const count = g.getIndex() ? g.getIndex().count / 3 : g.getAttribute("position").count / 3;
    tris += count * (m.isInstancedMesh ? Math.max(1, m.count) : 1);
  }
  console.log(`  triangles     ${Math.round(tris)}`);

  // The road, run-off and kerbs are the ribbons: they carry an `aU` attribute.
  const ribbons = meshes.filter((m) => m.geometry.getAttribute("aU"));
  if (ribbons.length < 3) fail(`expected road + run-off + kerbs, found ${ribbons.length} ribbons`);
  for (const m of ribbons) {
    const { up, total } = facingUp(m.geometry);
    const pct = total ? (up / total) * 100 : 0;
    const label = `ribbon(${total} tris)`;
    if (pct < 99.5) {
      fail(`${label} has ${(100 - pct).toFixed(1)}% of triangles facing away from the camera — backface culling will hide them`);
    } else {
      console.log(`  ✓ ${label} faces up`);
    }
  }

  // Barrier walls are vertical; assert they are not degenerate instead.
  const walls = meshes.filter((m) => m.geometry.getAttribute("aH"));
  if (walls.length !== 1) fail(`expected one merged barrier mesh, found ${walls.length}`);
  for (const m of walls) {
    const pos = m.geometry.getAttribute("position");
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < pos.count; i++) { const y = pos.getY(i); lo = Math.min(lo, y); hi = Math.max(hi, y); }
    console.log(`  barrier span  y ${lo.toFixed(2)} .. ${hi.toFixed(2)}`);
    if (hi - lo < 1) fail("barrier wall has no height");
  }

  // Nothing may sit below the ground plane, or it will be clipped by it.
  const ground = meshes.find((m) => m.geometry.type === "PlaneGeometry" && m.position.y < 0);
  if (!ground) fail("no ground plane found");
  else {
    let lowest = Infinity;
    for (const m of ribbons) {
      const pos = m.geometry.getAttribute("position");
      for (let i = 0; i < pos.count; i++) lowest = Math.min(lowest, pos.getY(i));
    }
    const clearance = lowest - ground.position.y;
    console.log(`  ground clear  ${clearance.toFixed(2)} m below the lowest tarmac`);
    if (clearance <= 0) fail("ground plane cuts up through the racing surface");
    if (clearance < 0.5) fail(`only ${clearance.toFixed(2)}m of clearance — expect z-fighting`);
  }

  world.dispose();
}

console.log(failed ? "\nFAILED" : "\nWorld OK");
process.exit(failed ? 1 : 0);
