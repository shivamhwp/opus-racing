import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  Matrix4,
  Euler,
  Vector3,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * A ground-effect-era Formula 1 car, generated from scratch at load time.
 *
 * Nothing here is downloaded: no glTF, no textures, no draco decoder. The whole
 * car is ~4k triangles of merged primitives plus one lofted monocoque, built
 * once and then drawn for every driver from a single InstancedMesh.
 *
 * Every vertex carries a `paint` id. The shader uses it to decide whether that
 * surface is bare carbon, the driver's livery colour, a bright accent, brushed
 * metal, rubber, or emissive — which is what lets sixteen differently-liveried
 * cars share one geometry and one draw call.
 */

export const PAINT_CARBON = 0;
export const PAINT_BODY = 1;
export const PAINT_ACCENT = 2;
export const PAINT_METAL = 3;
export const PAINT_RUBBER = 4;
export const PAINT_EMISSIVE = 5;
export const PAINT_GLASS = 6;

// Real-world dimensions, metres. Origin at the centre of the wheelbase,
// +Z forward, +Y up, +X right.
export const DIMS = {
  wheelbase: 3.6,
  frontAxleZ: 1.8,
  rearAxleZ: -1.8,
  frontTrack: 0.79,
  rearTrack: 0.75,
  tyreRadius: 0.36,
  frontTyreWidth: 0.305,
  rearTyreWidth: 0.405,
  noseTipZ: 2.62,
  rearWingZ: -2.72,
};

const _m = new Matrix4();
const _e = new Euler();
const _v = new Vector3();

/** Stamp a paint id onto every vertex of a geometry. */
function paint(geo: BufferGeometry, id: number): BufferGeometry {
  const n = geo.getAttribute("position").count;
  const arr = new Float32Array(n);
  if (id !== 0) arr.fill(id);
  geo.setAttribute("paint", new BufferAttribute(arr, 1));
  // Drop anything the car shader never reads — halves the vertex buffer.
  geo.deleteAttribute("uv");
  geo.deleteAttribute("uv1");
  return geo;
}

/** Position / rotate / scale a geometry in place. */
function place(
  geo: BufferGeometry,
  pos: [number, number, number],
  rot: [number, number, number] = [0, 0, 0],
  scale: [number, number, number] = [1, 1, 1],
): BufferGeometry {
  _m.makeRotationFromEuler(_e.set(rot[0], rot[1], rot[2]));
  _m.scale(_v.set(scale[0], scale[1], scale[2]));
  _m.setPosition(pos[0], pos[1], pos[2]);
  geo.applyMatrix4(_m);
  return geo;
}

function box(
  w: number,
  h: number,
  d: number,
  pos: [number, number, number],
  id: number,
  rot?: [number, number, number],
): BufferGeometry {
  return paint(place(new BoxGeometry(w, h, d), pos, rot), id);
}

// ---------------------------------------------------------------------------
// Lofting
// ---------------------------------------------------------------------------

export interface Section {
  z: number;
  /** Full width. */
  w: number;
  /** Height above `y`. */
  h: number;
  /** Bottom of the section. */
  y: number;
  /** Corner rounding, 0..0.5 of the smaller dimension. */
  r?: number;
}

/**
 * Loft a rectangular tube through a list of sections.
 *
 * Each of the four faces gets its own vertex ring, so normals stay smooth
 * *along* the body but stay crisp *across* the chamfers — bodywork edges read
 * sharp the way real carbon does, without the faceting a fully flat-shaded
 * loft would give.
 */
export function loft(sections: Section[], id: number, capFront = true, capBack = true) {
  const n = sections.length;
  const RING = 8; // 4 faces x 2 corners
  const pos: number[] = [];
  const idx: number[] = [];

  const corners = (s: Section) => {
    const hw = s.w / 2;
    return [
      [-hw, s.y],
      [hw, s.y],
      [hw, s.y + s.h],
      [-hw, s.y + s.h],
    ] as const;
  };

  for (const s of sections) {
    const c = corners(s);
    // bottom, right, top, left — each strip owns copies of its two corners.
    const strips = [
      [c[0], c[1]],
      [c[1], c[2]],
      [c[2], c[3]],
      [c[3], c[0]],
    ];
    for (const [a, b] of strips) {
      pos.push(a[0], a[1], s.z);
      pos.push(b[0], b[1], s.z);
    }
  }

  for (let i = 0; i < n - 1; i++) {
    const base = i * RING;
    const next = (i + 1) * RING;
    for (let f = 0; f < 4; f++) {
      const a = base + f * 2;
      const b = base + f * 2 + 1;
      const c = next + f * 2;
      const d = next + f * 2 + 1;
      idx.push(a, c, b, b, c, d);
    }
  }

  const capAt = (i: number, flip: boolean) => {
    const base = i * RING;
    // Two triangles across the section rectangle, using the bottom strip's
    // corners and the top strip's corners.
    const bl = base + 0;
    const br = base + 1;
    const tr = base + 5;
    const tl = base + 4;
    if (flip) idx.push(bl, br, tr, bl, tr, tl);
    else idx.push(bl, tr, br, bl, tl, tr);
  };
  if (capBack) capAt(0, true);
  if (capFront) capAt(n - 1, false);

  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return paint(geo, id);
}

/** Sweep a small ring along a path — used for the halo and suspension links. */
function tube(
  path: [number, number, number][],
  radius: number,
  segs: number,
  id: number,
): BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const up = new Vector3(0, 1, 0);
  const tangent = new Vector3();
  const normal = new Vector3();
  const binormal = new Vector3();
  const p = new Vector3();

  for (let i = 0; i < path.length; i++) {
    p.set(path[i][0], path[i][1], path[i][2]);
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(path.length - 1, i + 1)];
    tangent.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
    normal.crossVectors(tangent, up);
    if (normal.lengthSq() < 1e-6) normal.set(1, 0, 0);
    normal.normalize();
    binormal.crossVectors(tangent, normal).normalize();
    for (let s = 0; s < segs; s++) {
      const th = (s / segs) * Math.PI * 2;
      const cx = Math.cos(th) * radius;
      const cy = Math.sin(th) * radius;
      pos.push(
        p.x + normal.x * cx + binormal.x * cy,
        p.y + normal.y * cx + binormal.y * cy,
        p.z + normal.z * cx + binormal.z * cy,
      );
    }
  }
  for (let i = 0; i < path.length - 1; i++) {
    for (let s = 0; s < segs; s++) {
      const a = i * segs + s;
      const b = i * segs + ((s + 1) % segs);
      const c = (i + 1) * segs + s;
      const d = (i + 1) * segs + ((s + 1) % segs);
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return paint(geo, id);
}

/** A wing element: thin, cambered, with a slight taper toward the tips. */
function wingElement(
  span: number,
  chord: number,
  thickness: number,
  pos: [number, number, number],
  angle: number,
  id: number,
): BufferGeometry {
  const g = new BoxGeometry(span, thickness, chord, 1, 1, 4);
  // Camber: bow the trailing edge downward so it reads as an aerofoil.
  const p = g.getAttribute("position") as BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const z = p.getZ(i);
    const t = z / chord + 0.5;
    p.setY(i, p.getY(i) - Math.sin(t * Math.PI) * chord * 0.11);
  }
  g.computeVertexNormals();
  return paint(place(g, pos, [angle, 0, 0]), id);
}

// ---------------------------------------------------------------------------
// The car
// ---------------------------------------------------------------------------

export function buildF1Body(): BufferGeometry {
  const parts: BufferGeometry[] = [];

  // --- monocoque: nose tip -> cockpit -> engine cover -> gearbox ------------
  parts.push(
    loft(
      [
        { z: -2.35, w: 0.28, h: 0.26, y: 0.16 }, // gearbox
        { z: -2.0, w: 0.42, h: 0.4, y: 0.14 },
        { z: -1.5, w: 0.62, h: 0.62, y: 0.12 },
        { z: -1.0, w: 0.76, h: 0.78, y: 0.11 }, // engine cover shoulder
        { z: -0.55, w: 0.8, h: 0.82, y: 0.1 },
        { z: -0.2, w: 0.78, h: 0.6, y: 0.1 }, // behind the driver's head
        { z: 0.15, w: 0.76, h: 0.44, y: 0.1 }, // cockpit rim
        { z: 0.6, w: 0.74, h: 0.46, y: 0.1 },
        { z: 1.05, w: 0.7, h: 0.5, y: 0.1 },
        { z: 1.45, w: 0.56, h: 0.44, y: 0.12 }, // nose starts pinching
        { z: 1.9, w: 0.38, h: 0.34, y: 0.16 },
        { z: 2.3, w: 0.26, h: 0.24, y: 0.2 },
        { z: DIMS.noseTipZ, w: 0.15, h: 0.15, y: 0.24 }, // tip
      ],
      PAINT_BODY,
    ),
  );

  // Airbox above and behind the driver's head.
  parts.push(
    loft(
      [
        { z: -0.34, w: 0.3, h: 0.26, y: 0.88 },
        { z: -0.62, w: 0.36, h: 0.3, y: 0.9 },
        { z: -1.1, w: 0.3, h: 0.24, y: 0.86 },
        { z: -1.7, w: 0.2, h: 0.14, y: 0.76 },
      ],
      PAINT_BODY,
    ),
  );
  // Intake mouth.
  parts.push(box(0.24, 0.2, 0.05, [0, 1.0, -0.32], PAINT_CARBON));

  // --- cockpit opening + driver ------------------------------------------
  parts.push(box(0.5, 0.16, 0.72, [0, 0.5, 0.32], PAINT_CARBON));
  // Helmet.
  parts.push(
    paint(place(new CylinderGeometry(0.15, 0.145, 0.28, 12, 1), [0, 0.72, 0.02]), PAINT_ACCENT),
  );
  parts.push(box(0.24, 0.1, 0.06, [0, 0.72, 0.16], PAINT_GLASS)); // visor

  // --- sidepods ------------------------------------------------------------
  for (const s of [-1, 1]) {
    parts.push(
      loft(
        [
          { z: 0.52, w: 0.3, h: 0.34, y: 0.16 }, // inlet
          { z: 0.2, w: 0.44, h: 0.46, y: 0.14 },
          { z: -0.3, w: 0.5, h: 0.5, y: 0.12 }, // widest
          { z: -0.9, w: 0.44, h: 0.42, y: 0.12 },
          { z: -1.5, w: 0.3, h: 0.26, y: 0.14 }, // coke-bottle taper
          { z: -1.95, w: 0.16, h: 0.16, y: 0.16 },
        ],
        PAINT_BODY,
      ).translate(s * 0.56, 0, 0),
    );
    // Sidepod inlet mouth.
    parts.push(box(0.26, 0.3, 0.04, [s * 0.56, 0.32, 0.54], PAINT_CARBON));
    // Upper deflector / winglet.
    parts.push(box(0.42, 0.02, 0.34, [s * 0.6, 0.66, 0.16], PAINT_ACCENT, [0.14, 0, s * 0.1]));
  }

  // --- floor & diffuser ----------------------------------------------------
  parts.push(box(1.5, 0.05, 3.5, [0, 0.075, -0.35], PAINT_CARBON));
  // Floor edges flare out toward the rear.
  parts.push(box(1.86, 0.04, 1.7, [0, 0.09, -1.15], PAINT_CARBON));
  parts.push(
    loft(
      [
        { z: -1.95, w: 1.6, h: 0.12, y: 0.06 },
        { z: -2.4, w: 1.45, h: 0.3, y: 0.06 },
        { z: -2.72, w: 1.25, h: 0.42, y: 0.06 },
      ],
      PAINT_CARBON,
    ),
  );
  // Diffuser strakes.
  for (const s of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      parts.push(box(0.02, 0.24, 0.5, [s * (0.22 + i * 0.22), 0.19, -2.5], PAINT_CARBON));
    }
  }

  // --- front wing ----------------------------------------------------------
  const fwZ = 2.5;
  parts.push(wingElement(1.96, 0.4, 0.028, [0, 0.1, fwZ], -0.1, PAINT_BODY));
  parts.push(wingElement(1.92, 0.3, 0.024, [0, 0.19, fwZ - 0.16], -0.22, PAINT_ACCENT));
  parts.push(wingElement(1.86, 0.24, 0.022, [0, 0.28, fwZ - 0.3], -0.34, PAINT_BODY));
  // Endplates, canted outward like the real thing.
  for (const s of [-1, 1]) {
    parts.push(box(0.03, 0.34, 0.62, [s * 1.0, 0.24, fwZ - 0.14], PAINT_ACCENT, [0, 0, s * -0.1]));
  }
  // Nose pillars tying the wing to the nose.
  for (const s of [-1, 1]) {
    parts.push(box(0.04, 0.16, 0.3, [s * 0.14, 0.2, fwZ - 0.22], PAINT_CARBON));
  }

  // --- rear wing -----------------------------------------------------------
  const rwZ = DIMS.rearWingZ;
  parts.push(wingElement(1.05, 0.34, 0.03, [0, 0.86, rwZ], 0.22, PAINT_BODY));
  parts.push(wingElement(1.02, 0.2, 0.026, [0, 1.02, rwZ - 0.08], 0.42, PAINT_ACCENT)); // DRS flap
  parts.push(box(0.9, 0.03, 0.3, [0, 0.52, rwZ + 0.02], PAINT_CARBON, [0.2, 0, 0])); // beam wing
  for (const s of [-1, 1]) {
    parts.push(box(0.028, 0.62, 0.44, [s * 0.53, 0.78, rwZ - 0.02], PAINT_BODY));
  }
  // Swan-neck pylon + rain light.
  parts.push(box(0.07, 0.5, 0.14, [0, 0.62, rwZ + 0.06], PAINT_CARBON));
  parts.push(box(0.1, 0.12, 0.05, [0, 0.42, rwZ - 0.08], PAINT_EMISSIVE));

  // --- halo ----------------------------------------------------------------
  const haloPath: [number, number, number][] = [];
  for (let i = 0; i <= 22; i++) {
    const t = i / 22;
    const a = Math.PI * (1 - t);
    // An ellipse around the cockpit, tilted forward.
    const x = Math.cos(a) * 0.4;
    const z = 0.18 + Math.sin(a) * 0.62;
    const y = 0.74 + Math.sin(a) * 0.1;
    haloPath.push([x, y, z]);
  }
  parts.push(tube(haloPath, 0.032, 6, PAINT_METAL));
  // Central forward pillar.
  parts.push(
    tube(
      [
        [0, 0.5, 0.86],
        [0, 0.66, 0.82],
        [0, 0.78, 0.8],
      ],
      0.035,
      6,
      PAINT_METAL,
    ),
  );
  // Rear roll hoop.
  parts.push(box(0.16, 0.2, 0.1, [0, 0.92, -0.28], PAINT_METAL));

  // --- mirrors -------------------------------------------------------------
  for (const s of [-1, 1]) {
    parts.push(box(0.03, 0.02, 0.18, [s * 0.34, 0.56, 0.3], PAINT_CARBON));
    parts.push(box(0.12, 0.07, 0.03, [s * 0.42, 0.57, 0.24], PAINT_GLASS));
  }

  // --- suspension ----------------------------------------------------------
  for (const s of [-1, 1]) {
    // Front wishbones.
    parts.push(
      tube(
        [
          [s * 0.3, 0.28, DIMS.frontAxleZ + 0.28],
          [s * DIMS.frontTrack, 0.3, DIMS.frontAxleZ + 0.06],
        ],
        0.026,
        5,
        PAINT_CARBON,
      ),
    );
    parts.push(
      tube(
        [
          [s * 0.3, 0.24, DIMS.frontAxleZ - 0.34],
          [s * DIMS.frontTrack, 0.28, DIMS.frontAxleZ - 0.04],
        ],
        0.026,
        5,
        PAINT_CARBON,
      ),
    );
    // Rear wishbones.
    parts.push(
      tube(
        [
          [s * 0.2, 0.3, DIMS.rearAxleZ + 0.34],
          [s * DIMS.rearTrack, 0.32, DIMS.rearAxleZ + 0.05],
        ],
        0.03,
        5,
        PAINT_CARBON,
      ),
    );
    parts.push(
      tube(
        [
          [s * 0.2, 0.26, DIMS.rearAxleZ - 0.3],
          [s * DIMS.rearTrack, 0.3, DIMS.rearAxleZ - 0.05],
        ],
        0.03,
        5,
        PAINT_CARBON,
      ),
    );
  }

  // --- barge boards / floor fences ----------------------------------------
  for (const s of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      parts.push(
        box(0.02, 0.2, 0.44, [s * (0.66 + i * 0.08), 0.2, 0.9 - i * 0.1], PAINT_CARBON, [
          0,
          s * 0.12,
          0,
        ]),
      );
    }
  }

  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) throw new Error("failed to merge car geometry");
  merged.computeBoundingSphere();
  return merged;
}

/** One wheel: tyre, sidewall marking band, aero cover, brake duct glow. */
export function buildWheel(width: number): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const R = DIMS.tyreRadius;

  // Tyre. Cylinder axis is Y by default, so roll it onto X.
  const tyre = new CylinderGeometry(R, R, width, 22, 1, true);
  parts.push(paint(place(tyre, [0, 0, 0], [0, 0, Math.PI / 2]), PAINT_RUBBER));
  // Shoulders, so the tyre is not an open tube. The narrow end faces outboard,
  // and the piece is inset so the tyre's overall width stays exactly `width`.
  for (const s of [-1, 1]) {
    const shoulder = new CylinderGeometry(R * 0.86, R * 0.995, width * 0.09, 22, 1);
    parts.push(
      paint(
        place(shoulder, [s * (width / 2 - width * 0.045), 0, 0], [0, 0, (s * Math.PI) / 2]),
        PAINT_RUBBER,
      ),
    );
  }
  // Sidewall band — the coloured Pirelli stripe. Reads brilliantly under speed.
  for (const s of [-1, 1]) {
    const band = new CylinderGeometry(R * 0.87, R * 0.87, 0.012, 22, 1, true);
    parts.push(
      paint(place(band, [s * (width / 2 - 0.02), 0, 0], [0, 0, Math.PI / 2]), PAINT_ACCENT),
    );
  }
  // 2022-spec aero wheel cover.
  for (const s of [-1, 1]) {
    const cover = new CylinderGeometry(R * 0.68, R * 0.68, 0.02, 18, 1);
    parts.push(
      paint(place(cover, [s * (width / 2 - 0.012), 0, 0], [0, 0, Math.PI / 2]), PAINT_METAL),
    );
  }
  // Brake disc, glowing when hot.
  const disc = new CylinderGeometry(R * 0.55, R * 0.55, width * 0.35, 16, 1);
  parts.push(paint(place(disc, [0, 0, 0], [0, 0, Math.PI / 2]), PAINT_EMISSIVE));

  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) throw new Error("failed to merge wheel geometry");
  merged.computeBoundingSphere();
  return merged;
}
