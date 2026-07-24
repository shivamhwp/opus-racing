// Verifies the procedural F1 car matches real-world regulation dimensions and
// stays inside a sane triangle budget.
import { buildF1Body, buildWheel, DIMS } from "../src/game/carModel.ts";
import { Box3, Vector3 } from "three";

let failed = false;
const fail = (m) => { failed = true; console.error("  ✗ " + m); };
const near = (a, b, tol, label) => {
  const okv = Math.abs(a - b) <= tol;
  console.log(`  ${okv ? "✓" : "✗"} ${label}: ${a.toFixed(2)} m (expect ~${b} ±${tol})`);
  if (!okv) failed = true;
};

const body = buildF1Body();
const bb = new Box3().setFromBufferAttribute(body.getAttribute("position"));
const size = bb.getSize(new Vector3());
const tris = body.index.count / 3;

console.log("F1 body");
console.log(`  triangles     ${tris}`);
console.log(`  vertices      ${body.getAttribute("position").count}`);
console.log(`  bounds        x ${bb.min.x.toFixed(2)}..${bb.max.x.toFixed(2)}  y ${bb.min.y.toFixed(2)}..${bb.max.y.toFixed(2)}  z ${bb.min.z.toFixed(2)}..${bb.max.z.toFixed(2)}`);

// 2022+ regulations: max width 2.00 m, max length ~5.6 m, wheelbase 3.6 m.
near(size.z, 5.34, 0.5, "length");
near(size.x, 2.0, 0.12, "width (front wing spans the legal max)");
near(size.y, 1.06, 0.25, "height to airbox/halo");
if (bb.min.y < -0.02) fail(`body dips below the ground plane (${bb.min.y.toFixed(3)})`);
if (tris > 9000) fail(`${tris} triangles is over budget for an instanced car`);

const pos = body.getAttribute("position").array;
for (let i = 0; i < pos.length; i++) if (!Number.isFinite(pos[i])) { fail("non-finite vertex in body"); break; }
const pa = body.getAttribute("paint");
if (!pa) fail("body is missing the paint attribute");
else {
  const used = new Set();
  for (let i = 0; i < pa.count; i++) used.add(pa.getX(i));
  console.log(`  paint ids     ${[...used].sort().join(", ")}`);
  if (used.size < 5) fail("body uses fewer than 5 paint channels — livery will be flat");
}
if (body.getAttribute("uv")) fail("uv attribute survived; vertex buffer is larger than needed");

console.log("\nWheels");
for (const [label, w] of [["front", DIMS.frontTyreWidth], ["rear", DIMS.rearTyreWidth]]) {
  const g = buildWheel(w);
  const b = new Box3().setFromBufferAttribute(g.getAttribute("position"));
  const s = b.getSize(new Vector3());
  const t = g.index.count / 3;
  console.log(`  ${label}: ${t} tris, ${s.x.toFixed(3)} wide, ${s.y.toFixed(3)} diameter`);
  if (Math.abs(s.y - DIMS.tyreRadius * 2) > 0.025) fail(`${label} tyre diameter ${s.y.toFixed(3)} != ${(DIMS.tyreRadius*2).toFixed(3)}`);
  if (Math.abs(s.x - w) > 0.02) fail(`${label} tyre width ${s.x.toFixed(3)} != ${w}`);
  if (t > 1600) fail(`${label} wheel is ${t} tris, too heavy for 4x per car`);
}

console.log(failed ? "\nFAILED" : "\nCar model OK");
process.exit(failed ? 1 : 0);
