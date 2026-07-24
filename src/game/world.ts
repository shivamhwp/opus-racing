import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  Mesh,
  Object3D,
  PlaneGeometry,
  Scene,
  SphereGeometry,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { STATIONS, type Track } from "./track";
import {
  makeBarrierMaterial,
  makeGroundMaterial,
  makeKerbMaterial,
  makePropMaterial,
  makeRoadMaterial,
  makeRunoffMaterial,
  makeShadowMaterial,
  makeSkyMaterial,
  makeSkyUniforms,
  type SkyUniforms,
} from "./materials";

/**
 * Scene assembly.
 *
 * The entire circuit — 3.4 km of asphalt, run-off, kerbs, barriers, hoardings,
 * floodlights and grandstands — is six draw calls. Ribbons are generated once
 * into merged buffers and never touched again; repeated props are instanced.
 * Nothing in here is updated per frame except a handful of shader uniforms.
 */

const KERB_THRESHOLD = 0.16;
export const MAX_CARS = 16;

interface RibbonOpts {
  /** Lateral offset of the inner edge, per station. */
  inner: (i: number) => number;
  /** Lateral offset of the outer edge, per station. */
  outer: (i: number) => number;
  /** Height above the banked road plane. */
  lift: number;
  /** Emit a segment at station i? Used to place kerbs only in corners. */
  mask?: (i: number) => boolean;
  /** u value at the inner and outer edges. */
  uInner: number;
  uOuter: number;
  withCorner?: boolean;
}

/**
 * Build a strip that follows the centreline.
 *
 * Attributes: `aU` across the strip, `aV` metres travelled, `aCorner` how
 * tight the circuit is here. Vertices are banked around the centreline so the
 * camber is real geometry, not a shader trick.
 */
function ribbon(track: Track, o: RibbonOpts): BufferGeometry | null {
  const pos: number[] = [];
  const nrm: number[] = [];
  const au: number[] = [];
  const av: number[] = [];
  const ac: number[] = [];
  const idx: number[] = [];

  const emitPair = (i: number, v: number) => {
    const s = i & (STATIONS - 1);
    const bank = track.bank[s];
    const cb = Math.cos(bank);
    const sb = Math.sin(bank);
    for (const [lat, u] of [
      [o.inner(s), o.uInner],
      [o.outer(s), o.uOuter],
    ] as const) {
      // Rotate the cross-section about the centreline to apply camber.
      const y = track.py[s] + lat * sb + o.lift * cb;
      const l = lat * cb - o.lift * sb;
      pos.push(track.px[s] + track.nx[s] * l, y, track.pz[s] + track.nz[s] * l);
      // Surface normal, tilted by the same bank.
      nrm.push(-track.nx[s] * sb, cb, -track.nz[s] * sb);
      au.push(u);
      av.push(v);
      ac.push(track.corner[s]);
    }
  };

  // A strip's triangles must face the sky, but "inner" is not always on the
  // same side of the centreline: the right-hand run-off and kerbs run outward
  // in −n while their left-hand mirrors run outward in +n. Emitting one fixed
  // winding would leave exactly half of every mirrored pair backface-culled —
  // invisible, silent, and with no measurable cost to point at it. So pick the
  // winding from the strip's actual orientation.
  let orient = 0;
  for (let i = 0; i < STATIONS; i += 64) orient += o.outer(i) - o.inner(i);
  const flip = orient < 0;

  const quad = (v0: number, v1: number, v2: number, v3: number) => {
    // v0 inner@i, v1 outer@i, v2 inner@i+1, v3 outer@i+1
    if (flip) idx.push(v0, v2, v1, v1, v2, v3);
    else idx.push(v0, v1, v2, v1, v3, v2);
  };

  let count = 0;
  if (o.mask) {
    // Masked strips (kerbs) are emitted as free-standing quads so a run can
    // start and stop anywhere without stitching.
    for (let i = 0; i < STATIONS; i++) {
      if (!o.mask(i)) continue;
      const base = count * 4;
      emitPair(i, i * track.stationLength);
      emitPair(i + 1, (i + 1) * track.stationLength);
      quad(base, base + 1, base + 2, base + 3);
      count++;
    }
    if (count === 0) return null;
  } else {
    for (let i = 0; i <= STATIONS; i++) emitPair(i, i * track.stationLength);
    for (let i = 0; i < STATIONS; i++) {
      const a = i * 2;
      quad(a, a + 1, a + 2, a + 3);
    }
  }

  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute("normal", new BufferAttribute(new Float32Array(nrm), 3));
  g.setAttribute("aU", new BufferAttribute(new Float32Array(au), 1));
  g.setAttribute("aV", new BufferAttribute(new Float32Array(av), 1));
  if (o.withCorner) g.setAttribute("aCorner", new BufferAttribute(new Float32Array(ac), 1));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** Vertical wall following the circuit, on one or both sides. */
function barrierWall(track: Track, offset: number, height: number, side: 1 | -1) {
  const pos: number[] = [];
  const nrm: number[] = [];
  const ah: number[] = [];
  const av: number[] = [];
  const idx: number[] = [];

  for (let i = 0; i <= STATIONS; i++) {
    const s = i & (STATIONS - 1);
    const lat = offset * side;
    const x = track.px[s] + track.nx[s] * lat;
    const z = track.pz[s] + track.nz[s] * lat;
    const y = track.py[s];
    const v = i * track.stationLength;
    // Face inward, toward the racing surface.
    const nX = -track.nx[s] * side;
    const nZ = -track.nz[s] * side;
    pos.push(x, y - 0.2, z, x, y + height, z);
    nrm.push(nX, 0, nZ, nX, 0, nZ);
    ah.push(0, 1);
    av.push(v, v);
  }
  for (let i = 0; i < STATIONS; i++) {
    const a = i * 2;
    if (side > 0) idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    else idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }

  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute("normal", new BufferAttribute(new Float32Array(nrm), 3));
  g.setAttribute("aH", new BufferAttribute(new Float32Array(ah), 1));
  g.setAttribute("aV", new BufferAttribute(new Float32Array(av), 1));
  g.setIndex(idx);
  return g;
}

/** Stamp an `aGlow` attribute so a prop can mix matte body and emissive panel. */
function glow(g: BufferGeometry, v: number) {
  const n = g.getAttribute("position").count;
  const a = new Float32Array(n);
  if (v !== 0) a.fill(v);
  g.setAttribute("aGlow", new BufferAttribute(a, 1));
  g.deleteAttribute("uv");
  return g;
}

const _m4 = new Matrix4();
const _o3 = new Object3D();

export class World {
  readonly scene = new Scene();
  readonly track: Track;
  readonly sky: SkyUniforms;
  readonly shadows: InstancedMesh;

  private readonly timed: { uniforms: Record<string, { value: unknown }> }[] = [];
  private readonly disposables: { dispose(): void }[] = [];

  /** Draw calls needed to render the static circuit — reported in the HUD. */
  readonly staticDrawCalls: number;

  constructor(track: Track) {
    this.track = track;
    const def = track.def;
    this.sky = makeSkyUniforms(def);
    let calls = 0;

    // --- sky ---------------------------------------------------------------
    const skyMat = makeSkyMaterial(this.sky);
    const skyGeo = new SphereGeometry(1, 24, 16);
    const skyMesh = new Mesh(skyGeo, skyMat);
    skyMesh.frustumCulled = false;
    skyMesh.renderOrder = -1000;
    this.scene.add(skyMesh);
    this.disposables.push(skyGeo, skyMat);
    calls++;

    // --- ground ------------------------------------------------------------
    const groundMat = makeGroundMaterial(this.sky, def);
    const groundGeo = new PlaneGeometry(9000, 9000, 1, 1);
    groundGeo.rotateX(-Math.PI / 2);
    const ground = new Mesh(groundGeo, groundMat);
    // Below the lowest point of the circuit, or the plane cuts up through the
    // tarmac wherever the track dips.
    ground.position.y = track.minY - 1.4;
    ground.frustumCulled = false;
    this.scene.add(ground);
    this.disposables.push(groundGeo, groundMat);
    calls++;

    // --- run-off apron -----------------------------------------------------
    const runoffMat = makeRunoffMaterial(this.sky, def);
    const runoffGeos: BufferGeometry[] = [];
    for (const side of [-1, 1] as const) {
      const g = ribbon(track, {
        inner: (i) => side * track.halfW[i],
        outer: (i) => side * (track.halfW[i] + def.runoff),
        lift: -0.03,
        uInner: 0,
        uOuter: 1,
        withCorner: true,
      });
      if (g) runoffGeos.push(g);
    }
    const runoffGeo = mergeGeometries(runoffGeos, false)!;
    for (const g of runoffGeos) g.dispose();
    const runoff = new Mesh(runoffGeo, runoffMat);
    runoff.frustumCulled = false;
    this.scene.add(runoff);
    this.disposables.push(runoffGeo, runoffMat);
    calls++;

    // --- racing surface ----------------------------------------------------
    const roadMat = makeRoadMaterial(this.sky, def, track.length);
    const roadGeo = ribbon(track, {
      inner: (i) => -track.halfW[i],
      outer: (i) => track.halfW[i],
      lift: 0,
      uInner: -1,
      uOuter: 1,
      withCorner: true,
    })!;
    const road = new Mesh(roadGeo, roadMat);
    road.frustumCulled = false;
    this.scene.add(road);
    this.disposables.push(roadGeo, roadMat);
    this.timed.push(roadMat as never);
    calls++;

    // --- kerbs, in the corners only ---------------------------------------
    const kerbMat = makeKerbMaterial(this.sky, def);
    kerbMat.uniforms.uKerbPitch.value = track.length / Math.round(track.length / 3.2);
    const kerbGeos: BufferGeometry[] = [];
    for (const side of [-1, 1] as const) {
      const g = ribbon(track, {
        // Kerbs sit on the outside of the corner and on the apex inside.
        inner: (i) => side * track.halfW[i] * 0.9,
        outer: (i) => side * (track.halfW[i] * 1.02 + 1.5),
        lift: 0.06,
        mask: (i) => track.corner[i] > KERB_THRESHOLD,
        uInner: 0,
        uOuter: 1,
      });
      if (g) kerbGeos.push(g);
    }
    if (kerbGeos.length) {
      const kerbGeo = mergeGeometries(kerbGeos, false)!;
      for (const g of kerbGeos) g.dispose();
      const kerbs = new Mesh(kerbGeo, kerbMat);
      kerbs.frustumCulled = false;
      this.scene.add(kerbs);
      this.disposables.push(kerbGeo, kerbMat);
      this.timed.push(kerbMat as never);
      calls++;
    }

    // --- barriers ----------------------------------------------------------
    const barrierMat = makeBarrierMaterial(this.sky, def);
    barrierMat.uniforms.uSegLen.value = track.length / Math.round(track.length / 45);
    barrierMat.uniforms.uPanelLen.value = track.length / Math.round(track.length / 3);
    const wallOffset = def.halfWidth * 1.14 + def.runoff + 3.5;
    const wallGeo = mergeGeometries(
      [barrierWall(track, wallOffset, 1.15, 1), barrierWall(track, wallOffset, 1.15, -1)],
      false,
    )!;
    const walls = new Mesh(wallGeo, barrierMat);
    walls.frustumCulled = false;
    this.scene.add(walls);
    this.disposables.push(wallGeo, barrierMat);
    this.timed.push(barrierMat as never);
    calls++;

    // --- trackside props ---------------------------------------------------
    const propMat = makePropMaterial(this.sky, def);
    this.disposables.push(propMat);
    calls += this.buildProps(track, wallOffset, propMat, def.accent, def.accent2);

    // --- contact shadows ---------------------------------------------------
    const shadowMat = makeShadowMaterial();
    const shadowGeo = new PlaneGeometry(6.4, 6.4);
    shadowGeo.rotateX(-Math.PI / 2);
    this.shadows = new InstancedMesh(shadowGeo, shadowMat, MAX_CARS);
    this.shadows.instanceMatrix.setUsage(DynamicDrawUsage);
    this.shadows.frustumCulled = false;
    this.shadows.renderOrder = 5;
    this.shadows.count = 0;
    this.scene.add(this.shadows);
    this.disposables.push(shadowGeo, shadowMat);
    calls++;

    this.staticDrawCalls = calls;
  }

  /** Floodlights, hoardings, grandstands and the start gantry. */
  private buildProps(
    track: Track,
    wallOffset: number,
    mat: ReturnType<typeof makePropMaterial>,
    accent: number,
    accent2: number,
  ): number {
    const cA = new Color(accent);
    const cB = new Color(accent2);
    const white = new Color(0xdfe8ff);
    let calls = 0;

    const place = (
      geo: BufferGeometry,
      slots: {
        i: number;
        side: number;
        out: number;
        scale?: number;
        yawOffset?: number;
        tint: Color;
      }[],
      yaw = true,
    ) => {
      const mesh = new InstancedMesh(geo, mat, slots.length);
      mesh.frustumCulled = false;
      for (let k = 0; k < slots.length; k++) {
        const { i, side, out, scale = 1, yawOffset = 0, tint } = slots[k];
        const s = i & (STATIONS - 1);
        const lat = side * (wallOffset + out);
        _o3.position.set(
          track.px[s] + track.nx[s] * lat,
          track.py[s],
          track.pz[s] + track.nz[s] * lat,
        );
        _o3.rotation.set(0, (yaw ? Math.atan2(track.tx[s], track.tz[s]) : 0) + yawOffset, 0);
        _o3.scale.setScalar(scale);
        _o3.updateMatrix();
        mesh.setMatrixAt(k, _o3.matrix);
        mesh.setColorAt(k, tint);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.scene.add(mesh);
      this.disposables.push(geo);
      calls++;
      return mesh;
    };

    // --- advertising hoardings, right behind the barrier -------------------
    const boardGeo = mergeGeometries(
      [
        glow(new BoxGeometry(0.16, 1.5, 11).translate(0, 1.9, 0), 0),
        glow(new BoxGeometry(0.06, 1.15, 10.4).translate(0.1, 1.9, 0), 1),
      ],
      false,
    )!;
    const boardSlots = [];
    const boardStep = Math.max(20, Math.round(26 / track.stationLength));
    for (let i = 0; i < STATIONS; i += boardStep) {
      // Skip the tightest corners, where a straight 11 m board would clip
      // through the barrier it is supposed to sit behind.
      if (track.corner[i] > 0.55) continue;
      for (const side of [-1, 1]) {
        boardSlots.push({
          i,
          side,
          out: 0.7,
          tint: (i / boardStep) % 3 === 0 ? cA : (i / boardStep) % 3 === 1 ? cB : white,
        });
      }
    }
    place(boardGeo, boardSlots);

    // --- floodlight pylons -------------------------------------------------
    const pylonGeo = mergeGeometries(
      [
        glow(new BoxGeometry(0.5, 15, 0.5).translate(0, 7.5, 0), 0),
        glow(new BoxGeometry(3.4, 0.9, 0.35).translate(0, 15.4, 0), 0),
        glow(new BoxGeometry(3.1, 0.55, 0.12).translate(0, 15.4, -0.22), 1),
      ],
      false,
    )!;
    const pylonSlots = [];
    const pylonStep = Math.max(40, Math.round(78 / track.stationLength));
    for (let i = 0; i < STATIONS; i += pylonStep) {
      pylonSlots.push({ i, side: i % (pylonStep * 2) === 0 ? 1 : -1, out: 9, tint: white });
    }
    place(pylonGeo, pylonSlots);

    // --- grandstands, on the fast open sections ---------------------------
    // Local +Z is the direction of travel after `place()` yaws the instance, so
    // the seating must be long in Z and step away from the circuit in +X.
    const standParts: BufferGeometry[] = [];
    for (let r = 0; r < 5; r++) {
      standParts.push(glow(new BoxGeometry(4, 2.6, 46).translate(r * 3.6, 1.3 + r * 2.4, 0), 0));
      // The crowd: a dim band on each tier, facing back toward the track.
      standParts.push(
        glow(new BoxGeometry(0.3, 1.1, 45).translate(r * 3.6 - 2.0, 2.4 + r * 2.4, 0), 1),
      );
    }
    standParts.push(glow(new BoxGeometry(20, 1.0, 48).translate(7, 15.5, 0), 0));
    const standGeo = mergeGeometries(standParts, false)!;
    for (const p of standParts) p.dispose();
    const standSlots = [];
    for (let k = 0; k < 7; k++) {
      const i = Math.round((STATIONS / 7) * k);
      if (track.corner[i] > 0.4) continue;
      // A stand on the track-left sits at +lateral, so it must face about-face
      // for its tiers to climb away from the circuit rather than into it.
      const side = k % 2 === 0 ? 1 : -1;
      standSlots.push({ i, side, out: 30, yawOffset: side > 0 ? Math.PI : 0, tint: k % 2 ? cB : cA });
    }
    place(standGeo, standSlots);

    // --- marshal posts -----------------------------------------------------
    const postGeo = mergeGeometries(
      [
        glow(new BoxGeometry(0.3, 3.2, 0.3).translate(0, 1.6, 0), 0),
        glow(new BoxGeometry(1.5, 0.7, 0.2).translate(0, 3.3, 0), 1),
      ],
      false,
    )!;
    const postSlots = [];
    const postStep = Math.max(24, Math.round(45 / track.stationLength));
    for (let i = 0; i < STATIONS; i += postStep) {
      postSlots.push({ i, side: -1, out: 3.2, tint: i % 2 ? cA : white });
    }
    place(postGeo, postSlots);

    // --- start / finish gantry --------------------------------------------
    const s0 = track.def.startOffset & (STATIONS - 1);
    const span = (track.halfW[s0] + track.def.runoff + 6) * 2;
    const gantryParts = [
      glow(new BoxGeometry(1.2, 9, 1.2).translate(-span / 2, 4.5, 0), 0),
      glow(new BoxGeometry(1.2, 9, 1.2).translate(span / 2, 4.5, 0), 0),
      glow(new BoxGeometry(span, 1.6, 1.6).translate(0, 9.4, 0), 0),
      glow(new BoxGeometry(span * 0.62, 0.9, 0.2).translate(0, 8.4, 0.85), 1),
    ];
    // The five start lamps: dark housings, since the actual start signal is
    // shown on the HUD where the driver is already looking.
    for (let k = 0; k < 5; k++) {
      gantryParts.push(
        glow(new BoxGeometry(1.0, 1.0, 0.3).translate((k - 2) * 1.6, 7.2, 0.9), 0),
      );
      gantryParts.push(
        glow(new BoxGeometry(0.74, 0.74, 0.06).translate((k - 2) * 1.6, 7.2, 1.06), 0),
      );
    }
    const gantryGeo = mergeGeometries(gantryParts, false)!;
    for (const p of gantryParts) p.dispose();
    const gantry = new InstancedMesh(gantryGeo, mat, 1);
    _o3.position.set(track.px[s0], track.py[s0], track.pz[s0]);
    _o3.rotation.set(0, Math.atan2(track.tx[s0], track.tz[s0]), 0);
    _o3.scale.setScalar(1);
    _o3.updateMatrix();
    gantry.setMatrixAt(0, _o3.matrix);
    gantry.setColorAt(0, white);
    gantry.instanceMatrix.needsUpdate = true;
    if (gantry.instanceColor) gantry.instanceColor.needsUpdate = true;
    gantry.frustumCulled = false;
    this.scene.add(gantry);
    this.disposables.push(gantryGeo);
    calls++;

    return calls;
  }

  /** Position the contact shadow under each active car. */
  setShadows(cars: { x: number; y: number; z: number; heading: number }[], n: number) {
    for (let i = 0; i < n; i++) {
      const c = cars[i];
      _m4.makeRotationY(c.heading);
      _m4.setPosition(c.x, c.y - 0.3, c.z);
      this.shadows.setMatrixAt(i, _m4);
    }
    this.shadows.count = n;
    this.shadows.instanceMatrix.needsUpdate = true;
  }

  update(time: number) {
    for (const m of this.timed) {
      const u = m.uniforms.uTime;
      if (u) u.value = time;
    }
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    this.scene.clear();
  }
}
