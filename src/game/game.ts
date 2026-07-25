import {
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  WebGLRenderer,
} from "three";
import { buildF1Body, buildWheel, DIMS } from "./carModel";
import { autopilot } from "./autopilot";
import { ChaseCamera, type CameraMode } from "./camera";
import { EngineAudio } from "./audio";
import { Input } from "./input";
import { makeCarMaterial } from "./materials";
import { Net } from "./net";
import { Particles, KIND_SMOKE, KIND_SPARK } from "./particles";
import { CarSim, CAR, NEUTRAL_INPUT, type CarInput } from "./physics";
import { Post, type PostState } from "./post";
import { getTrackDef, STATIONS, Track } from "./track";
import { MAX_CARS, World } from "./world";
import { FLAG_BRAKING, FLAG_DRIFT, FLAG_OFFTRACK, FLAG_BOOST, makeCarState } from "../../shared/protocol";

/**
 * The game loop and everything hanging off it.
 *
 * Simulation runs at a fixed 120 Hz regardless of display rate, so handling is
 * identical on a 60 Hz laptop and a 240 Hz monitor, and every client's physics
 * agrees closely enough that relayed positions line up. Rendering is decoupled
 * and adapts its resolution to hold the display's refresh rate.
 */

const SIM_HZ = 120;
const SIM_DT = 1 / SIM_HZ;
const MAX_SUBSTEPS = 6;

export type Quality = "ultra" | "high" | "balanced" | "efficient";

interface QualityTier {
  maxDpr: number;
  bloom: number;
  particles: number;
  grain: number;
  vignette: number;
  minScale: number;
}

// Bloom is deliberately restrained: in daylight it is a glint off bodywork and
// a haze around the sun, not a glow on everything.
const TIERS: Record<Quality, QualityTier> = {
  ultra: { maxDpr: 2, bloom: 0.55, particles: 1, grain: 0.8, vignette: 0.7, minScale: 0.72 },
  high: { maxDpr: 1.75, bloom: 0.5, particles: 0.8, grain: 0.8, vignette: 0.7, minScale: 0.62 },
  balanced: { maxDpr: 1.35, bloom: 0.4, particles: 0.5, grain: 0.5, vignette: 0.6, minScale: 0.55 },
  efficient: { maxDpr: 1, bloom: 0, particles: 0.2, grain: 0, vignette: 0.5, minScale: 0.5 },
};

const SCALE_STEPS = [0.5, 0.58, 0.66, 0.75, 0.85, 0.92, 1];

export interface Stats {
  fps: number;
  frameMs: number;
  simMs: number;
  gpuScale: number;
  drawCalls: number;
  triangles: number;
  particles: number;
  cars: number;
  ping: number;
  quality: Quality;
}

export interface RaceRow {
  id: number;
  name: string;
  hue: number;
  lap: number;
  progress: number;
  distance: number;
  isSelf: boolean;
  finished: boolean;
  gapMs: number | null;
}

export interface HudFrame {
  speedKph: number;
  gear: number;
  rpm: number;
  drs: boolean;
  drsAvailable: boolean;
  grip: number;
  throttle: number;
  brake: number;
  steer: number;
  offTrack: boolean;
  lap: number;
  totalLaps: number;
  lapMs: number;
  lastLapMs: number | null;
  bestLapMs: number | null;
  deltaMs: number | null;
  position: number;
  fieldSize: number;
  countdownMs: number | null;
  racing: boolean;
  finished: boolean;
  order: RaceRow[];
  /** Local car position on the minimap, 0..1 in track-normalised space. */
  selfPoint: [number, number];
  others: { x: number; y: number; hue: number }[];
  camera: CameraMode;
}

export interface GameEvents {
  onHud?(frame: HudFrame): void;
  onStats?(stats: Stats): void;
  onLap?(lap: number, lapMs: number, best: boolean): void;
  onFinish?(totalMs: number, bestLapMs: number | null): void;
  onCameraChange?(mode: CameraMode): void;
}

interface Driver {
  id: number;
  name: string;
  hue: number;
}

const _m = new Matrix4();
const _mw = new Matrix4();
const _tmp = new Matrix4();
const _color = new Color();

export class Game {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: WebGLRenderer;
  readonly net: Net;
  readonly input: Input;
  readonly audio = new EngineAudio();

  private post: Post;
  private world!: World;
  private track!: Track;
  private cam: ChaseCamera;
  private particles!: Particles;

  private bodies!: InstancedMesh;
  private wheels!: InstancedMesh;
  private carMat!: ReturnType<typeof makeCarMaterial>;

  /** The local player's car. Remote cars are interpolated, not simulated. */
  readonly car = new CarSim();
  private readonly localState = makeCarState();

  private drivers = new Map<number, Driver>();
  private events: GameEvents = {};

  quality: Quality = "high";
  private tier = TIERS.high;
  private scaleIndex = SCALE_STEPS.length - 1;
  private baseDpr = 1;
  private cssWidth = 1;
  private cssHeight = 1;

  private running = false;
  private raf = 0;
  private lastFrame = 0;
  private accumulator = 0;
  private simTimeMs = 0;
  private frameAvg = 16.7;
  private simAvg = 0;
  private fpsAvg = 60;
  private targetFrameMs = 1000 / 60;
  private refreshSamples: number[] = [];
  private scaleCooldown = 0;
  private statsCooldown = 0;

  // --- race state ---------------------------------------------------------
  totalLaps = 3;
  racing = false;
  finished = false;
  private countdownAt: number | null = null;
  private raceStart = 0;
  private lapStart = 0;
  lastLapMs: number | null = null;
  bestLapMs: number | null = null;
  private sessionBest: number | null = null;
  private smokeCarry = 0;
  private hudCarry = 0;
  /** Attract mode: the reference driver laps the circuit behind the menus. */
  attract = false;
  private readonly attractInput: CarInput = { throttle: 0, brake: 0, steer: 0, handbrake: false, drs: false };

  private readonly postState: PostState = {
    speed: 0,
    shake: 0,
    flash: 0,
    flashColor: [1, 1, 1],
    time: 0,
    bloom: 1,
    vignette: 1,
    grain: 1,
  };

  constructor(canvas: HTMLCanvasElement, events: GameEvents = {}) {
    this.canvas = canvas;
    this.events = events;

    this.renderer = new WebGLRenderer({
      canvas,
      antialias: false, // we resolve aliasing with resolution scaling + post
      alpha: false,
      powerPreference: "high-performance",
      stencil: false,
      depth: true,
      preserveDrawingBuffer: false,
    });
    this.renderer.autoClear = false;
    this.renderer.setClearColor(0x000000, 1);
    this.baseDpr = Math.min(window.devicePixelRatio || 1, this.tier.maxDpr);

    this.post = new Post(this.renderer);
    this.cam = new ChaseCamera(1);
    this.net = new Net();

    this.input = new Input({
      onCamera: () => {
        const mode = this.cam.cycle();
        this.events.onCameraChange?.(mode);
      },
      onRespawn: () => {
        if (this.racing && !this.finished) this.car.respawn(this.track);
      },
      onMute: () => this.audio.setMuted(!this.audio.muted),
    });

    this.car.onLap = (lap) => this.onLapCrossed(lap);
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  /** Build (or rebuild) the circuit. Safe to call between races. */
  loadTrack(trackId: string) {
    const def = getTrackDef(trackId);
    if (this.world && this.track?.def.id === def.id) return;

    this.world?.dispose();
    this.particles?.dispose();

    this.track = new Track(def);
    this.world = new World(this.track);
    this.particles = new Particles(this.world.sky, def);
    this.world.scene.add(this.particles.mesh);

    // Cars: one instanced body + one instanced wheel buffer for the whole grid.
    this.carMat?.dispose();
    this.carMat = makeCarMaterial(this.world.sky, def);

    const bodyGeo = buildF1Body();
    this.bodies = new InstancedMesh(bodyGeo, this.carMat, MAX_CARS);
    this.bodies.instanceMatrix.setUsage(DynamicDrawUsage);
    this.bodies.frustumCulled = false;
    this.bodies.count = 0;
    this.world.scene.add(this.bodies);

    // Front and rear tyres differ in width, so the buffer holds both and the
    // per-instance matrix scales the shared geometry across its axle.
    const wheelGeo = buildWheel(DIMS.frontTyreWidth);
    this.wheels = new InstancedMesh(wheelGeo, this.carMat, MAX_CARS * 4);
    this.wheels.instanceMatrix.setUsage(DynamicDrawUsage);
    this.wheels.frustumCulled = false;
    this.wheels.count = 0;
    this.world.scene.add(this.wheels);

    this.cam.reset();
    this.resize();
  }

  setQuality(q: Quality) {
    this.quality = q;
    this.tier = TIERS[q];
    this.baseDpr = Math.min(window.devicePixelRatio || 1, this.tier.maxDpr);
    this.scaleIndex = SCALE_STEPS.length - 1;
    this.postState.bloom = this.tier.bloom;
    this.postState.grain = this.tier.grain;
    this.postState.vignette = this.tier.vignette;
    this.resize();
  }

  setDrivers(list: Driver[]) {
    this.drivers = new Map(list.map((d) => [d.id, d]));
  }

  /** Park the car on the racing line and let the reference driver lap it. */
  startAttract() {
    this.attract = true;
    this.racing = false;
    this.finished = false;
    this.input.enabled = false;
    this.cam.mode = "cinematic";
    const i = Math.floor(Math.random() * STATIONS);
    this.car.reset(
      this.track,
      this.track.px[i],
      this.track.py[i],
      this.track.pz[i],
      Math.atan2(this.track.tx[i], this.track.tz[i]),
    );
    this.cam.reset();
  }

  stopAttract() {
    this.attract = false;
    this.cam.mode = "chase";
  }

  /** Place the local car on its grid slot and clear all race timing. */
  prepareGrid(slot: number, totalLaps: number) {
    this.attract = false;
    this.totalLaps = totalLaps;
    this.racing = false;
    this.finished = false;
    this.lastLapMs = null;
    this.bestLapMs = null;
    this.countdownAt = null;
    this.particles.clear();

    const slotPos = { x: 0, y: 0, z: 0, heading: 0 };
    this.track.gridSlot(slot, slotPos);
    this.car.reset(this.track, slotPos.x, slotPos.y, slotPos.z, slotPos.heading);
    this.car.lap = 0;
    this.input.enabled = false;
    this.cam.reset();
  }

  /**
   * `atLocalMs` is the lights-out instant on the local wall clock, i.e. the
   * `Date.now()` epoch. Everything inside the loop is timed with
   * `performance.now()` — a monotonic clock that an NTP correction cannot drag
   * sideways mid-race — so rebase it here, once, at the boundary.
   */
  beginCountdown(atLocalMs: number) {
    this.countdownAt = atLocalMs - Date.now() + performance.now();
    this.racing = false;
    this.finished = false;
    this.input.enabled = false;
  }

  private goRacing() {
    if (this.racing) return;
    this.racing = true;
    this.countdownAt = null;
    this.input.enabled = true;
    this.raceStart = performance.now();
    this.lapStart = this.raceStart;
    this.postState.flash = 0.5;
    this.postState.flashColor = [0.2, 1, 0.35];
    this.audio.beep(880, 0.4, 0.32);
  }

  private onLapCrossed(lap: number) {
    if (this.attract || !this.racing || this.finished) return;
    const now = performance.now();
    if (lap === 1) {
      // Crossing the line for the first time starts the timed lap.
      this.lapStart = now;
      return;
    }
    const lapMs = now - this.lapStart;
    this.lapStart = now;
    const completed = lap - 1;
    this.lastLapMs = lapMs;
    const isBest = this.bestLapMs == null || lapMs < this.bestLapMs;
    if (isBest) this.bestLapMs = lapMs;
    if (this.sessionBest == null || lapMs < this.sessionBest) this.sessionBest = lapMs;

    this.net.send({ t: "lap", lap: completed, lapMs, totalMs: now - this.raceStart });
    this.events.onLap?.(completed, lapMs, isBest);
    this.audio.beep(isBest ? 1320 : 660, 0.1, 0.2);

    if (completed >= this.totalLaps) {
      this.finished = true;
      this.input.enabled = false;
      const totalMs = now - this.raceStart;
      this.net.send({ t: "finish", totalMs, bestLapMs: this.bestLapMs ?? lapMs });
      this.postState.flash = 0.65;
      this.postState.flashColor = [1, 0.95, 0.6];
      this.audio.beep(1560, 0.5, 0.3);
      this.events.onFinish?.(totalMs, this.bestLapMs);
    }
  }

  // -------------------------------------------------------------------------
  // Loop
  // -------------------------------------------------------------------------

  start() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    this.accumulator = 0;
    const loop = (t: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      this.frame(t);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.input.enabled = false;
  }

  private frame(now: number) {
    let dt = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    // A tab that was backgrounded must not fast-forward the whole race.
    if (dt > 0.25) dt = 0.25;

    const frameMs = dt * 1000;
    this.frameAvg += (frameMs - this.frameAvg) * 0.08;
    this.fpsAvg += (1 / Math.max(dt, 1e-4) - this.fpsAvg) * 0.08;
    this.measureRefresh(frameMs);

    // --- countdown ---------------------------------------------------------
    if (this.countdownAt != null && now >= this.countdownAt) this.goRacing();

    // --- simulate ----------------------------------------------------------
    const simT0 = performance.now();
    this.accumulator += dt;
    let steps = 0;
    const input = this.attract
      ? autopilot(this.car, this.track, this.attractInput)
      : this.racing && !this.finished
        ? this.input.state
        : NEUTRAL_INPUT;
    while (this.accumulator >= SIM_DT && steps < MAX_SUBSTEPS) {
      if (!this.attract) {
        this.input.update(SIM_DT, Math.min(1, Math.abs(this.car.speed) / CAR.maxSpeed));
      }
      this.car.update(SIM_DT, input, this.track);
      this.accumulator -= SIM_DT;
      this.simTimeMs += SIM_DT * 1000;
      steps++;
    }
    if (steps === MAX_SUBSTEPS) this.accumulator = 0; // give up rather than spiral
    this.simAvg += (performance.now() - simT0 - this.simAvg) * 0.1;

    // --- network -----------------------------------------------------------
    this.net.interpolate(Date.now());
    this.publishState();
    this.pushRemoteCollisions();

    // --- visuals -----------------------------------------------------------
    const speedNorm = Math.min(1, Math.max(0, this.car.speed) / CAR.maxSpeed);
    this.cam.update(dt, this.car, this.track, speedNorm);
    this.world.update(now / 1000);
    this.updateCars();
    this.spawnEffects(dt, speedNorm);
    this.particles.update(dt);

    const drs = input.drs && this.car.drsAvailable(this.track);
    this.audio.update(
      this.car.rpm,
      speedNorm,
      input.throttle,
      Math.abs(this.car.slip),
      this.car.offTrack,
    );

    // --- render ------------------------------------------------------------
    this.postState.speed = speedNorm * speedNorm * (drs ? 1.25 : 1);
    this.postState.shake = this.cam.shake;
    this.postState.time = now / 1000;
    this.postState.flash *= Math.max(0, 1 - dt * 3.2);

    this.renderer.info.reset();
    this.post.beginScene();
    this.post.renderScene(this.world.scene, this.cam.camera);
    this.post.render(this.postState, this.cssWidth, this.cssHeight);

    this.adaptResolution(frameMs);
    this.emitHud(now, drs);
    this.emitStats(now);
  }

  /** Learn the display's real refresh rate from the fastest frames observed. */
  private measureRefresh(frameMs: number) {
    if (this.refreshSamples.length < 90) {
      if (frameMs > 3 && frameMs < 40) this.refreshSamples.push(frameMs);
      if (this.refreshSamples.length === 90) {
        const sorted = [...this.refreshSamples].sort((a, b) => a - b);
        // 20th percentile: fast enough to represent the panel, robust to hitches.
        this.targetFrameMs = sorted[Math.floor(sorted.length * 0.2)];
      }
    }
  }

  /**
   * Hold the display's refresh rate by trading resolution.
   *
   * Steps are quantised and rate-limited, so the render targets are only
   * reallocated on a genuine sustained change, never oscillating frame to frame.
   */
  private adaptResolution(frameMs: number) {
    this.scaleCooldown -= frameMs;
    if (this.scaleCooldown > 0) return;

    const budget = this.targetFrameMs;
    const min = SCALE_STEPS.findIndex((s) => s >= this.tier.minScale);
    if (this.frameAvg > budget * 1.22 && this.scaleIndex > Math.max(0, min)) {
      this.scaleIndex--;
      this.applyScale();
      this.scaleCooldown = 900;
    } else if (this.frameAvg < budget * 0.78 && this.scaleIndex < SCALE_STEPS.length - 1) {
      this.scaleIndex++;
      this.applyScale();
      this.scaleCooldown = 1600;
    } else {
      this.scaleCooldown = 320;
    }
  }

  /**
   * Resize only the offscreen targets. The viewport is deliberately never
   * touched: three sets it from the bound render target, and leaves it at the
   * canvas size for the default framebuffer. Pinning it to the scaled size
   * instead makes the final composite fill only part of the canvas and letterbox
   * the rest in black — and it only shows up once the scaler actually drops
   * resolution, which is exactly on the machines it exists to help.
   */
  private applyScale() {
    const s = SCALE_STEPS[this.scaleIndex] * this.baseDpr;
    this.post.setSize(
      Math.max(2, Math.round(this.cssWidth * s)),
      Math.max(2, Math.round(this.cssHeight * s)),
    );
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.cssWidth = w;
    this.cssHeight = h;
    // The canvas backing store is full native resolution; only the scene and
    // bloom targets shrink. The composite upscales into it, so HUD-adjacent
    // edges and the tonemap always resolve at the display's real pixel density.
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(
      Math.round(w * this.baseDpr),
      Math.round(h * this.baseDpr),
      false,
    );
    this.cam.setAspect(w / Math.max(1, h));
    this.applyScale();
  }

  // -------------------------------------------------------------------------
  // Cars
  // -------------------------------------------------------------------------

  private publishState() {
    if (this.attract) {
      this.net.pending = null;
      return;
    }
    const s = this.localState;
    s.id = this.net.selfId;
    s.x = this.car.x;
    s.z = this.car.z;
    s.heading = this.car.heading;
    s.speed = this.car.speed;
    s.progress = this.car.progress;
    s.wheelSpin = this.car.wheelSpin;
    s.steer = this.car.steerAngle;
    s.lap = Math.max(0, Math.min(255, this.car.lap));
    s.flags =
      (this.car.drifting ? FLAG_DRIFT : 0) |
      (this.car.offTrack ? FLAG_OFFTRACK : 0) |
      (this.input.state.brake > 0.1 ? FLAG_BRAKING : 0) |
      (this.input.state.drs ? FLAG_BOOST : 0);
    this.net.pending = s;
  }

  /** Nudge the local car out of remote cars. Remotes are not ours to move. */
  private pushRemoteCollisions() {
    const r = 2.3;
    const min = r * 2;
    for (const other of this.net.remotes.values()) {
      if (!other.active) continue;
      const dx = this.car.x - other.x;
      const dz = this.car.z - other.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > min * min || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const nx = dx / d;
      const nz = dz / d;
      // Only the local car moves: both ends do the same, so contact resolves
      // symmetrically without either client fighting the other's authority.
      this.car.x += nx * (min - d);
      this.car.z += nz * (min - d);
      const into = this.car.vx * nx + this.car.vz * nz;
      if (into < 0) {
        this.car.vx -= nx * into * 1.4;
        this.car.vz -= nz * into * 1.4;
        this.car.wallHit = Math.max(this.car.wallHit, Math.min(1, -into / 25));
      }
    }
  }

  private updateCars() {
    let n = 0;
    let w = 0;
    const shadowSrc: { x: number; y: number; z: number; heading: number }[] = [];

    const addCar = (
      x: number,
      y: number,
      z: number,
      heading: number,
      roll: number,
      pitch: number,
      steer: number,
      spin: number,
      hue: number,
    ) => {
      if (n >= MAX_CARS) return;
      // body = T * Ry(heading) * Rz(roll) * Rx(pitch)
      _m.makeRotationY(heading);
      _tmp.makeRotationZ(roll);
      _m.multiply(_tmp);
      _tmp.makeRotationX(pitch);
      _m.multiply(_tmp);
      _m.setPosition(x, y, z);
      this.bodies.setMatrixAt(n, _m);

      _color.setHSL(hue / 360, 0.82, 0.5);
      this.bodies.setColorAt(n, _color);

      const axles: [number, number, number, boolean][] = [
        [-DIMS.frontTrack, DIMS.frontAxleZ, DIMS.frontTyreWidth, true],
        [DIMS.frontTrack, DIMS.frontAxleZ, DIMS.frontTyreWidth, true],
        [-DIMS.rearTrack, DIMS.rearAxleZ, DIMS.rearTyreWidth, false],
        [DIMS.rearTrack, DIMS.rearAxleZ, DIMS.rearTyreWidth, false],
      ];
      for (const [ox, oz, width, isFront] of axles) {
        _mw.makeTranslation(ox, DIMS.tyreRadius, oz);
        if (isFront) {
          _tmp.makeRotationY(steer);
          _mw.multiply(_tmp);
        }
        _tmp.makeRotationX(spin);
        _mw.multiply(_tmp);
        // The shared wheel geometry is cut at front width; widen for the rears.
        _tmp.makeScale(width / DIMS.frontTyreWidth, 1, 1);
        _mw.multiply(_tmp);
        _mw.premultiply(_m);
        this.wheels.setMatrixAt(w++, _mw);
        this.wheels.setColorAt(w - 1, _color);
      }

      shadowSrc.push({ x, y, z, heading });
      n++;
    };

    const selfHue = this.drivers.get(this.net.selfId)?.hue ?? 6;
    addCar(
      this.car.x,
      this.car.y,
      this.car.z,
      this.car.heading,
      this.car.roll,
      this.car.pitch,
      this.car.steerAngle,
      this.car.wheelSpin,
      selfHue,
    );

    for (const r of this.net.remotes.values()) {
      if (!r.active) continue;
      const d = this.drivers.get(r.id);
      // Roll and pitch are not on the wire — they are cosmetic, and deriving
      // them from transmitted steer and speed costs nothing and looks right.
      const roll = r.steer * Math.min(1, Math.abs(r.speed) / 40) * 0.18;
      const y = this.track.heightAt(r.progress * STATIONS) + 0.34;
      addCar(r.x, y, r.z, r.heading, roll, 0, r.steer, r.wheelSpin, d?.hue ?? 200);
    }

    this.bodies.count = n;
    this.wheels.count = w;
    this.bodies.instanceMatrix.needsUpdate = true;
    this.wheels.instanceMatrix.needsUpdate = true;
    if (this.bodies.instanceColor) this.bodies.instanceColor.needsUpdate = true;
    if (this.wheels.instanceColor) this.wheels.instanceColor.needsUpdate = true;
    this.world.setShadows(shadowSrc, n);
  }

  // -------------------------------------------------------------------------
  // Effects
  // -------------------------------------------------------------------------

  private spawnEffects(dt: number, speedNorm: number) {
    const budget = this.tier.particles;
    if (budget <= 0) return;
    const c = this.car;
    const sinH = Math.sin(c.heading);
    const cosH = Math.cos(c.heading);

    // Rear contact patches, in world space.
    const rearZ = DIMS.rearAxleZ;
    const rear = (side: number) => ({
      x: c.x + sinH * rearZ + cosH * side * DIMS.rearTrack,
      z: c.z + cosH * rearZ - sinH * side * DIMS.rearTrack,
    });

    const slip = Math.abs(c.slip);
    const smoking = (c.drifting && slip > 3.2) || (this.input.state.brake > 0.75 && c.speed > 22);
    const dusty = c.offTrack && Math.abs(c.speed) > 8;

    if (smoking || dusty) {
      // Rate is proportional to how hard the tyre is working, then carried
      // across frames so the emission is framerate independent.
      const rate = (smoking ? Math.min(1, slip / 12) * 90 : 0) + (dusty ? speedNorm * 70 : 0);
      this.smokeCarry += rate * dt * budget;
      while (this.smokeCarry >= 1) {
        this.smokeCarry -= 1;
        const side = Math.random() < 0.5 ? -1 : 1;
        const p = rear(side);
        const jitter = () => (Math.random() - 0.5) * 2.4;
        if (dusty) {
          this.spawnDust(p.x, p.z, jitter(), jitter());
        } else {
          this.particles.spawn(
            p.x + jitter() * 0.3,
            0.22,
            p.z + jitter() * 0.3,
            jitter() - sinH * c.speed * 0.06,
            0.6 + Math.random() * 0.8,
            jitter() - cosH * c.speed * 0.06,
            0.5 + Math.random() * 0.5,
            0.75 + Math.random() * 0.5,
            KIND_SMOKE,
            0.42, 0.4, 0.45,
            2.6,
          );
        }
      }
    }

    // Sparks: the plank grounding out over kerbs, and anything hitting a wall.
    if (c.kerbHit && speedNorm > 0.25 && Math.random() < 28 * dt * budget) {
      this.spawnSparks(c.x - sinH * 1.6, c.z - cosH * 1.6, 4, sinH, cosH, c.speed);
    }
    if (c.wallHit > 0.12) {
      this.spawnSparks(c.x, c.z, Math.round(14 * c.wallHit * budget), sinH, cosH, c.speed);
    }
  }

  private spawnDust(x: number, z: number, jx: number, jz: number) {
    this.particles.spawn(
      x + jx * 0.4, 0.2, z + jz * 0.4,
      jx * 1.6, 1.1 + Math.random(), jz * 1.6,
      0.7 + Math.random() * 0.8, 1.1 + Math.random() * 0.7,
      KIND_SMOKE,
      0.34, 0.28, 0.2,
      3.2,
    );
  }

  private spawnSparks(x: number, z: number, count: number, sinH: number, cosH: number, speed: number) {
    for (let i = 0; i < count; i++) {
      const spread = (Math.random() - 0.5) * 7;
      this.particles.spawn(
        x, 0.12 + Math.random() * 0.1, z,
        -sinH * speed * 0.28 + cosH * spread,
        1.5 + Math.random() * 4.5,
        -cosH * speed * 0.28 - sinH * spread,
        0.10 + Math.random() * 0.07,
        0.32 + Math.random() * 0.4,
        KIND_SPARK,
        1.0, 0.55 + Math.random() * 0.35, 0.15,
        0,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Readouts
  // -------------------------------------------------------------------------

  private emitHud(now: number, drs: boolean) {
    this.hudCarry += 1;
    // The HUD is DOM; 30 Hz is plenty and halves its layout cost.
    if (this.hudCarry < 2) return;
    this.hudCarry = 0;

    const c = this.car;
    const order = this.raceOrder();
    const self = order.findIndex((r) => r.isSelf);
    const lapMs = this.racing && !this.finished ? now - this.lapStart : 0;

    const others: { x: number; y: number; hue: number }[] = [];
    for (const r of this.net.remotes.values()) {
      if (!r.active) continue;
      const p = this.mapPoint(r.x, r.z);
      others.push({ x: p[0], y: p[1], hue: this.drivers.get(r.id)?.hue ?? 200 });
    }

    this.events.onHud?.({
      speedKph: Math.abs(c.speed) * 3.6,
      gear: c.gear,
      rpm: c.rpm,
      drs,
      drsAvailable: c.drsAvailable(this.track),
      grip: c.gripUse,
      throttle: this.input.state.throttle,
      brake: this.input.state.brake,
      steer: this.input.state.steer,
      offTrack: c.offTrack,
      lap: Math.min(this.totalLaps, Math.max(1, c.lap)),
      totalLaps: this.totalLaps,
      lapMs,
      lastLapMs: this.lastLapMs,
      bestLapMs: this.bestLapMs,
      deltaMs: this.lastLapMs != null && this.bestLapMs != null ? this.lastLapMs - this.bestLapMs : null,
      position: self >= 0 ? self + 1 : 1,
      fieldSize: order.length,
      countdownMs: this.countdownAt != null ? this.countdownAt - now : null,
      racing: this.racing,
      finished: this.finished,
      order,
      selfPoint: this.mapPoint(c.x, c.z),
      others,
      camera: this.cam.mode,
    });
  }

  /** Everyone on track, sorted by distance covered. */
  raceOrder(): RaceRow[] {
    const rows: RaceRow[] = [];
    const selfDriver = this.drivers.get(this.net.selfId);
    rows.push({
      id: this.net.selfId,
      name: selfDriver?.name ?? "YOU",
      hue: selfDriver?.hue ?? 6,
      lap: this.car.lap,
      progress: this.car.progress,
      distance: this.car.lap + this.car.progress,
      isSelf: true,
      finished: this.finished,
      gapMs: null,
    });
    for (const r of this.net.remotes.values()) {
      if (!r.active) continue;
      const d = this.drivers.get(r.id);
      rows.push({
        id: r.id,
        name: d?.name ?? `CAR ${r.id}`,
        hue: d?.hue ?? 200,
        lap: r.lap,
        progress: r.progress,
        distance: r.lap + r.progress,
        isSelf: false,
        finished: false,
        gapMs: null,
      });
    }
    rows.sort((a, b) => b.distance - a.distance);
    // Gap to the leader, estimated from distance at the local car's pace.
    const leader = rows[0];
    const pace = Math.max(18, Math.abs(this.car.speed));
    for (const r of rows) {
      r.gapMs = r === leader ? 0 : ((leader.distance - r.distance) * this.track.length * 1000) / pace;
    }
    return rows;
  }

  /** World position to 0..1 minimap space. */
  private mapPoint(x: number, z: number): [number, number] {
    const b = this.mapBounds();
    return [(x - b.minX) / b.spanX, (z - b.minZ) / b.spanZ];
  }

  private mapCache: { minX: number; minZ: number; spanX: number; spanZ: number } | null = null;
  private mapBounds() {
    if (this.mapCache) return this.mapCache;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const t = this.track;
    for (let i = 0; i < STATIONS; i++) {
      if (t.px[i] < minX) minX = t.px[i];
      if (t.px[i] > maxX) maxX = t.px[i];
      if (t.pz[i] < minZ) minZ = t.pz[i];
      if (t.pz[i] > maxZ) maxZ = t.pz[i];
    }
    const pad = 40;
    this.mapCache = {
      minX: minX - pad,
      minZ: minZ - pad,
      spanX: maxX - minX + pad * 2,
      spanZ: maxZ - minZ + pad * 2,
    };
    return this.mapCache;
  }

  /** SVG path of the circuit in 0..100 viewBox space, for the minimap. */
  minimapPath(samples = 220): string {
    const b = this.mapBounds();
    const t = this.track;
    let d = "";
    for (let k = 0; k < samples; k++) {
      const i = Math.round((k / samples) * STATIONS) & (STATIONS - 1);
      const x = ((t.px[i] - b.minX) / b.spanX) * 100;
      const y = ((t.pz[i] - b.minZ) / b.spanZ) * 100;
      d += `${k === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
    }
    return d + "Z";
  }

  /** Start/finish marker in minimap space. */
  minimapStart(): [number, number] {
    const i = this.track.def.startOffset & (STATIONS - 1);
    const p = this.mapPoint(this.track.px[i], this.track.pz[i]);
    return [p[0] * 100, p[1] * 100];
  }

  private emitStats(now: number) {
    if (now - this.statsCooldown < 250) return;
    this.statsCooldown = now;
    const info = this.renderer.info.render;
    this.events.onStats?.({
      fps: this.fpsAvg,
      frameMs: this.frameAvg,
      simMs: this.simAvg,
      gpuScale: SCALE_STEPS[this.scaleIndex] * this.baseDpr,
      drawCalls: info.calls,
      triangles: info.triangles,
      particles: this.particles.count,
      cars: this.bodies.count,
      ping: this.net.rttMs,
      quality: this.quality,
    });
  }

  get trackRef() {
    return this.track;
  }

  dispose() {
    this.stop();
    this.net.disconnect();
    this.input.dispose();
    this.audio.dispose();
    this.particles?.dispose();
    this.bodies?.geometry.dispose();
    this.wheels?.geometry.dispose();
    this.carMat?.dispose();
    this.world?.dispose();
    this.post.dispose();
    this.renderer.dispose();
  }
}
