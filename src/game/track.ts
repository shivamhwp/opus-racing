import { CatmullRomCurve3, Vector3 } from "three";

/**
 * Track math. A track is a closed Catmull-Rom spline resampled to a fixed
 * number of arc-length-uniform stations. Everything downstream (geometry,
 * physics projection, minimap, AI-less lap timing) reads the flat typed arrays
 * below, so the hot loop never touches the curve object again.
 */

export interface TrackDef {
  id: string;
  name: string;
  subtitle: string;
  /** Control points in metres, [x, z]. Closed loop — do not repeat the first. */
  points: readonly (readonly [number, number])[];
  /** Half-width of racing surface in metres. */
  halfWidth: number;
  /** Extra tarmac run-off beyond the white line. */
  runoff: number;
  /** UI + lighting accent, hex. */
  accent: number;
  accent2: number;
  /** Horizon / sky mood. */
  skyTop: number;
  skyHorizon: number;
  sunColor: number;
  fogColor: number;
  fogDensity: number;
  /** Index into the sample array where the start/finish line sits. */
  startOffset: number;
}

export const TRACKS: readonly TrackDef[] = [
  {
    id: "vermilion",
    name: "Vermilion Bay",
    subtitle: "Fast sweepers · 3.4 km · night",
    halfWidth: 8.5,
    runoff: 9,
    accent: 0xff2d55,
    accent2: 0x00e5ff,
    skyTop: 0x05060f,
    skyHorizon: 0x2a1140,
    sunColor: 0xff5a3c,
    fogColor: 0x120a1c,
    fogDensity: 0.0016,
    startOffset: 0,
    points: [
      [-40, -430],
      [190, -432],
      [352, -398],
      [438, -300],
      [452, -176],
      [408, -70],
      [300, -14],
      [232, 62],
      [268, 158],
      [372, 214],
      [428, 316],
      [356, 402],
      [232, 418],
      [148, 352],
      [138, 246],
      [40, 196],
      [-96, 224],
      [-236, 300],
      [-368, 286],
      [-444, 176],
      [-414, 40],
      [-306, -46],
      [-244, -166],
      [-282, -294],
      [-212, -400],
    ],
  },
  {
    id: "cobalt",
    name: "Cobalt Deep",
    subtitle: "Two DRS straights · 4.1 km · dusk",
    halfWidth: 9,
    runoff: 11,
    accent: 0x2d7bff,
    accent2: 0x7cffb2,
    skyTop: 0x030a18,
    skyHorizon: 0x0d3358,
    sunColor: 0x53c8ff,
    fogColor: 0x061420,
    fogDensity: 0.0013,
    startOffset: 0,
    points: [
      [-520, -300],
      [-120, -336],
      [280, -350],
      [470, -300],
      [536, -190],
      [486, -74],
      [352, -26],
      [214, -46],
      [128, 20],
      [156, 128],
      [286, 168],
      [430, 176],
      [520, 262],
      [452, 366],
      [300, 388],
      [120, 372],
      [-60, 348],
      [-224, 356],
      [-372, 322],
      [-482, 232],
      [-520, 96],
      [-448, -12],
      [-330, -60],
      [-366, -176],
      [-472, -212],
    ],
  },
  {
    id: "ember",
    name: "Ember Ring",
    subtitle: "Technical · 2.6 km · deep night",
    halfWidth: 7.5,
    runoff: 7,
    accent: 0xffb020,
    accent2: 0xff2d95,
    skyTop: 0x0a0408,
    skyHorizon: 0x3a1008,
    sunColor: 0xffa040,
    fogColor: 0x160809,
    fogDensity: 0.0021,
    startOffset: 0,
    points: [
      [-30, -330],
      [160, -336],
      [288, -286],
      [330, -178],
      [268, -96],
      [150, -80],
      [86, -6],
      [140, 78],
      [268, 96],
      [344, 186],
      [284, 288],
      [148, 312],
      [30, 262],
      [-64, 292],
      [-186, 314],
      [-300, 254],
      [-322, 132],
      [-244, 46],
      [-274, -60],
      [-336, -160],
      [-286, -272],
      [-160, -330],
    ],
  },
];

export function getTrackDef(id: string): TrackDef {
  return TRACKS.find((t) => t.id === id) ?? TRACKS[0];
}

/**
 * A circuit outline as an SVG path in a 0..100 box, for menus and minimaps.
 * Samples the spline directly so it costs microseconds — building the full
 * `Track` just to draw a 40 px thumbnail would be absurd.
 */
export function trackOutline(def: TrackDef, samples = 96): string {
  const curve = new CatmullRomCurve3(
    def.points.map(([x, z]) => new Vector3(x, 0, z)),
    true,
    "centripetal",
    0.5,
  );
  const pts: [number, number][] = [];
  const v = new Vector3();
  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < samples; i++) {
    curve.getPoint(i / samples, v);
    pts.push([v.x, v.z]);
    if (v.x < minX) minX = v.x;
    if (v.x > maxX) maxX = v.x;
    if (v.z < minZ) minZ = v.z;
    if (v.z > maxZ) maxZ = v.z;
  }
  // Uniform scale keeps the circuit's real proportions instead of stretching it.
  const span = Math.max(maxX - minX, maxZ - minZ) || 1;
  const ox = (span - (maxX - minX)) / 2;
  const oz = (span - (maxZ - minZ)) / 2;
  let d = "";
  for (let i = 0; i < pts.length; i++) {
    const x = ((pts[i][0] - minX + ox) / span) * 96 + 2;
    const y = ((pts[i][1] - minZ + oz) / span) * 96 + 2;
    d += `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return d + "Z";
}

/** Number of arc-length stations. Power of two keeps the modulo cheap. */
export const STATIONS = 2048;

export interface Projection {
  /** Station index of the closest point. */
  index: number;
  /** Normalised lap progress, 0..1. */
  progress: number;
  /** Signed distance from centreline; positive = track-left. */
  lateral: number;
  /** Centreline heading (radians, atan2(tx, tz) convention used by the sim). */
  heading: number;
  /** Signed curvature at that station (1/m). */
  curvature: number;
  /** Distance along the lap in metres. */
  distance: number;
}

const _proj: Projection = {
  index: 0,
  progress: 0,
  lateral: 0,
  heading: 0,
  curvature: 0,
  distance: 0,
};

export class Track {
  readonly def: TrackDef;
  readonly n = STATIONS;
  /** Centreline positions. */
  readonly px = new Float32Array(STATIONS);
  readonly pz = new Float32Array(STATIONS);
  /** Unit tangents (direction of travel). */
  readonly tx = new Float32Array(STATIONS);
  readonly tz = new Float32Array(STATIONS);
  /** Unit left-normals. */
  readonly nx = new Float32Array(STATIONS);
  readonly nz = new Float32Array(STATIONS);
  /** Signed curvature, 1/m. */
  readonly curv = new Float32Array(STATIONS);
  /** Smoothed |curvature| in 0..1, used for kerb + camera + light placement. */
  readonly corner = new Float32Array(STATIONS);
  /** Track surface half-width at each station. */
  readonly halfW = new Float32Array(STATIONS);
  /** Bank angle in radians (positive banks into a left turn). */
  readonly bank = new Float32Array(STATIONS);
  /** Elevation of the centreline. */
  readonly py = new Float32Array(STATIONS);

  readonly stationLength: number;
  readonly length: number;
  /** Lowest point of the centreline — the ground plane sits below this. */
  readonly minY: number = 0;
  readonly maxY: number = 0;

  /** Coarse bucket grid for cold-start projection. */
  private readonly cell: number;
  private readonly gridMinX: number;
  private readonly gridMinZ: number;
  private readonly gridW: number;
  private readonly gridH: number;
  private readonly buckets: Int32Array[];

  constructor(def: TrackDef) {
    this.def = def;

    const pts = def.points.map(([x, z]) => new Vector3(x, 0, z));
    const curve = new CatmullRomCurve3(pts, true, "centripetal", 0.5);

    // Curve.getSpacedPoints() builds its arc-length LUT from only 200
    // divisions, which drifts badly on a 4 km spline with hairpins. Resample by
    // hand from a dense polyline instead: 32x oversampling keeps every station
    // within a fraction of a percent of true arc-length uniform.
    const DENSE = STATIONS * 32;
    const dx = new Float64Array(DENSE + 1);
    const dz = new Float64Array(DENSE + 1);
    const cum = new Float64Array(DENSE + 1);
    const tmp = new Vector3();
    for (let i = 0; i <= DENSE; i++) {
      curve.getPoint((i % DENSE) / DENSE, tmp);
      dx[i] = tmp.x;
      dz[i] = tmp.z;
      if (i > 0) cum[i] = cum[i - 1] + Math.hypot(dx[i] - dx[i - 1], dz[i] - dz[i - 1]);
    }
    const perimeter = cum[DENSE];

    let cursor = 0;
    for (let i = 0; i < STATIONS; i++) {
      const target = (perimeter * i) / STATIONS;
      while (cursor < DENSE - 1 && cum[cursor + 1] < target) cursor++;
      const seg = cum[cursor + 1] - cum[cursor];
      const f = seg > 1e-9 ? (target - cum[cursor]) / seg : 0;
      this.px[i] = dx[cursor] + (dx[cursor + 1] - dx[cursor]) * f;
      this.pz[i] = dz[cursor] + (dz[cursor + 1] - dz[cursor]) * f;
    }

    // Arc length from the resampled polyline.
    let total = 0;
    for (let i = 0; i < STATIONS; i++) {
      const j = (i + 1) & (STATIONS - 1);
      total += Math.hypot(this.px[j] - this.px[i], this.pz[j] - this.pz[i]);
    }
    this.length = total;
    this.stationLength = total / STATIONS;

    // Central-difference tangents.
    for (let i = 0; i < STATIONS; i++) {
      const a = (i - 1 + STATIONS) & (STATIONS - 1);
      const b = (i + 1) & (STATIONS - 1);
      let dx = this.px[b] - this.px[a];
      let dz = this.pz[b] - this.pz[a];
      const inv = 1 / (Math.hypot(dx, dz) || 1);
      dx *= inv;
      dz *= inv;
      this.tx[i] = dx;
      this.tz[i] = dz;
      // Left normal in a Y-up right-handed world where forward is +Z-ish.
      this.nx[i] = -dz;
      this.nz[i] = dx;
    }

    // Signed curvature from the tangent turn rate.
    for (let i = 0; i < STATIONS; i++) {
      const b = (i + 1) & (STATIONS - 1);
      const cross = this.tx[i] * this.tz[b] - this.tz[i] * this.tx[b];
      const dot = this.tx[i] * this.tx[b] + this.tz[i] * this.tz[b];
      const dTheta = Math.atan2(cross, dot);
      this.curv[i] = dTheta / this.stationLength;
    }

    // Smooth |curvature| into a 0..1 "cornerness" field.
    const maxK = 1 / 25; // 25 m radius = full corner
    const raw = new Float32Array(STATIONS);
    for (let i = 0; i < STATIONS; i++) raw[i] = Math.min(1, Math.abs(this.curv[i]) / maxK);
    smoothWrap(raw, this.corner, 26);

    // Widen on straights, tighten slightly through corners — reads as a real circuit.
    for (let i = 0; i < STATIONS; i++) {
      this.halfW[i] = def.halfWidth * (1 + 0.14 * (1 - this.corner[i]));
      // Bank into the corner, up to ~6 degrees.
      this.bank[i] = -Math.sign(this.curv[i]) * this.corner[i] * 0.105;
    }
    smoothWrapInPlace(this.halfW, 12);
    smoothWrapInPlace(this.bank, 20);

    // Gentle elevation change so the circuit is not a flat disc. Harmonics of
    // the lap position are inherently seamless at the start/finish wrap.
    //
    // The amplitude is deliberately small: the world beyond the barriers is a
    // single flat plane, so a circuit that climbed 20 m would visibly float
    // above its own surroundings. A few metres reads as undulation; more reads
    // as a bug.
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < STATIONS; i++) {
      const u = (i / STATIONS) * Math.PI * 2;
      const y =
        Math.sin(u * 1) * 2.3 + Math.sin(u * 2 + 1.1) * 1.25 + Math.sin(u * 3 + 2.7) * 0.6;
      this.py[i] = y;
      if (y < lo) lo = y;
      if (y > hi) hi = y;
    }
    this.minY = lo;
    this.maxY = hi;

    // Build the coarse lookup grid.
    let minX = Infinity,
      maxX = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity;
    for (let i = 0; i < STATIONS; i++) {
      if (this.px[i] < minX) minX = this.px[i];
      if (this.px[i] > maxX) maxX = this.px[i];
      if (this.pz[i] < minZ) minZ = this.pz[i];
      if (this.pz[i] > maxZ) maxZ = this.pz[i];
    }
    const pad = 120;
    this.cell = 48;
    this.gridMinX = minX - pad;
    this.gridMinZ = minZ - pad;
    this.gridW = Math.ceil((maxX + pad - this.gridMinX) / this.cell) + 1;
    this.gridH = Math.ceil((maxZ + pad - this.gridMinZ) / this.cell) + 1;

    const lists: number[][] = new Array(this.gridW * this.gridH);
    for (let i = 0; i < STATIONS; i++) {
      const cx = Math.floor((this.px[i] - this.gridMinX) / this.cell);
      const cz = Math.floor((this.pz[i] - this.gridMinZ) / this.cell);
      // Stamp into a 3x3 neighbourhood so a query cell always has candidates.
      for (let ox = -1; ox <= 1; ox++) {
        for (let oz = -1; oz <= 1; oz++) {
          const gx = cx + ox,
            gz = cz + oz;
          if (gx < 0 || gz < 0 || gx >= this.gridW || gz >= this.gridH) continue;
          const k = gz * this.gridW + gx;
          (lists[k] ||= []).push(i);
        }
      }
    }
    this.buckets = lists.map((l) => Int32Array.from(l ?? []));
  }

  /** World position of a station, including elevation. */
  stationY(i: number): number {
    return this.py[i & (STATIONS - 1)];
  }

  /** Interpolated centreline height at a fractional station. */
  heightAt(fIndex: number): number {
    const i = Math.floor(fIndex) & (STATIONS - 1);
    const j = (i + 1) & (STATIONS - 1);
    const f = fIndex - Math.floor(fIndex);
    return this.py[i] * (1 - f) + this.py[j] * f;
  }

  /**
   * Project a world position onto the centreline.
   *
   * `hint` is the caller's previous station index. When supplied, only a small
   * window around it is searched — O(1) per car per tick, no allocation. Pass
   * -1 for a cold lookup (uses the bucket grid).
   */
  project(x: number, z: number, hint: number, out: Projection = _proj): Projection {
    let best = -1;
    let bestD = Infinity;

    if (hint >= 0) {
      const W = 48;
      for (let d = -W; d <= W; d++) {
        const i = (hint + d + STATIONS) & (STATIONS - 1);
        const dx = x - this.px[i];
        const dz = z - this.pz[i];
        const dist = dx * dx + dz * dz;
        if (dist < bestD) {
          bestD = dist;
          best = i;
        }
      }
      // If the winner sits on the window edge the car outran the window; fall
      // back to the grid rather than returning a wrong station.
      const delta = Math.abs(((best - hint + STATIONS * 1.5) % STATIONS) - STATIONS * 0.5);
      if (delta >= 46) best = -1;
    }

    if (best < 0) {
      const gx = Math.min(
        this.gridW - 1,
        Math.max(0, Math.floor((x - this.gridMinX) / this.cell)),
      );
      const gz = Math.min(
        this.gridH - 1,
        Math.max(0, Math.floor((z - this.gridMinZ) / this.cell)),
      );
      const bucket = this.buckets[gz * this.gridW + gx];
      bestD = Infinity;
      if (bucket && bucket.length) {
        for (let k = 0; k < bucket.length; k++) {
          const i = bucket[k];
          const dx = x - this.px[i];
          const dz = z - this.pz[i];
          const dist = dx * dx + dz * dz;
          if (dist < bestD) {
            bestD = dist;
            best = i;
          }
        }
      } else {
        // Far outside the circuit: brute force with a stride, then refine.
        for (let i = 0; i < STATIONS; i += 8) {
          const dx = x - this.px[i];
          const dz = z - this.pz[i];
          const dist = dx * dx + dz * dz;
          if (dist < bestD) {
            bestD = dist;
            best = i;
          }
        }
        for (let d = -8; d <= 8; d++) {
          const i = (best + d + STATIONS) & (STATIONS - 1);
          const dx = x - this.px[i];
          const dz = z - this.pz[i];
          const dist = dx * dx + dz * dz;
          if (dist < bestD) {
            bestD = dist;
            best = i;
          }
        }
      }
    }

    // Refine with a projection onto the segment [best, best+1] / [best-1, best].
    const i = best;
    const dx = x - this.px[i];
    const dz = z - this.pz[i];
    const along = dx * this.tx[i] + dz * this.tz[i];
    const frac = Math.max(-0.5, Math.min(0.5, along / this.stationLength));

    out.index = i;
    out.lateral = dx * this.nx[i] + dz * this.nz[i];
    out.heading = Math.atan2(this.tx[i], this.tz[i]);
    out.curvature = this.curv[i];
    out.distance = (i + frac) * this.stationLength;
    out.progress = (i + frac) / STATIONS;
    if (out.progress < 0) out.progress += 1;
    if (out.progress >= 1) out.progress -= 1;
    return out;
  }

  /** Half-width at a station. */
  widthAt(i: number): number {
    return this.halfW[i & (STATIONS - 1)];
  }

  /** Grid slot position for the pre-race grid — staggered, F1 style. */
  gridSlot(slot: number, out: { x: number; y: number; z: number; heading: number }) {
    const backFromLine = 22 + Math.floor(slot / 2) * 15;
    const side = slot % 2 === 0 ? 1 : -1;
    const stations = backFromLine / this.stationLength;
    const fi = this.def.startOffset - stations;
    const i = ((Math.round(fi) % STATIONS) + STATIONS) & (STATIONS - 1);
    const lateral = side * this.halfW[i] * 0.42;
    out.x = this.px[i] + this.nx[i] * lateral;
    out.z = this.pz[i] + this.nz[i] * lateral;
    out.y = this.py[i];
    out.heading = Math.atan2(this.tx[i], this.tz[i]);
    return out;
  }
}

// ---------------------------------------------------------------------------

function smoothWrap(src: Float32Array, dst: Float32Array, radius: number) {
  const n = src.length;
  const inv = 1 / (radius * 2 + 1);
  let acc = 0;
  for (let k = -radius; k <= radius; k++) acc += src[(k + n) % n];
  for (let i = 0; i < n; i++) {
    dst[i] = acc * inv;
    acc -= src[(i - radius + n) % n];
    acc += src[(i + radius + 1) % n];
  }
}

function smoothWrapInPlace(arr: Float32Array, radius: number) {
  const copy = Float32Array.from(arr);
  smoothWrap(copy, arr, radius);
}
