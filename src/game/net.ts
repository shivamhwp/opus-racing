import {
  ENTRY_SIZE,
  MSG_SNAPSHOT,
  MSG_STATE,
  SNAPSHOT_HEADER,
  makeCarState,
  readEntry,
  writeEntry,
  type CarState,
  type ClientMessage,
  type PlayerInfo,
  type ResultRow,
  type RaceStatus,
  type RoomConfig,
  type ServerMessage,
} from "../../shared/protocol";

/**
 * Realtime client.
 *
 * Two things make remote cars look solid rather than teleporting:
 *
 *  1. Every peer keeps a short ring of timestamped samples and is rendered
 *     100 ms in the past, between two real samples. Interpolation beats
 *     extrapolation whenever you can afford the latency, and at these speeds
 *     100 ms is invisible while a mispredicted extrapolation is not.
 *  2. When the buffer runs dry (a dropped packet, a stalled sender) the car
 *     dead-reckons along its last known velocity for a short window instead of
 *     freezing, then decays to a stop.
 *
 * The clock offset is estimated from ping/pong so the countdown fires at the
 * same instant on every machine regardless of how far off the local clock is.
 */

const INTERP_MS = 100;
const BUFFER = 20;
const MAX_EXTRAPOLATE_MS = 250;
const SEND_HZ = 20;
const PING_INTERVAL_MS = 4000;

interface Sample {
  t: number;
  x: number;
  z: number;
  heading: number;
  speed: number;
  progress: number;
  wheelSpin: number;
  steer: number;
  lap: number;
  flags: number;
}

/** One peer's interpolated presence. */
export class RemoteCar {
  readonly id: number;
  private readonly buf: Sample[] = [];
  private head = 0;
  private len = 0;

  // Interpolated output, read by the renderer.
  x = 0;
  z = 0;
  y = 0;
  heading = 0;
  speed = 0;
  progress = 0;
  wheelSpin = 0;
  steer = 0;
  lap = 0;
  flags = 0;
  /** False once the peer has gone quiet for long enough to hide. */
  active = false;
  lastPacketAt = 0;

  constructor(id: number) {
    this.id = id;
    for (let i = 0; i < BUFFER; i++) {
      this.buf.push({
        t: 0, x: 0, z: 0, heading: 0, speed: 0,
        progress: 0, wheelSpin: 0, steer: 0, lap: 0, flags: 0,
      });
    }
  }

  push(s: CarState, t: number) {
    const slot = this.buf[this.head];
    slot.t = t;
    slot.x = s.x;
    slot.z = s.z;
    slot.heading = s.heading;
    slot.speed = s.speed;
    slot.progress = s.progress;
    slot.wheelSpin = s.wheelSpin;
    slot.steer = s.steer;
    slot.lap = s.lap;
    slot.flags = s.flags;
    this.head = (this.head + 1) % BUFFER;
    if (this.len < BUFFER) this.len++;
    this.lastPacketAt = t;
    this.active = true;
  }

  private at(i: number): Sample {
    return this.buf[(this.head - this.len + i + BUFFER * 2) % BUFFER];
  }

  /** Advance the visual state to `now - INTERP_MS`. */
  sample(now: number) {
    if (this.len === 0) return;
    const target = now - INTERP_MS;

    // Find the pair straddling the target time.
    let lo = -1;
    for (let i = this.len - 1; i >= 0; i--) {
      if (this.at(i).t <= target) {
        lo = i;
        break;
      }
    }

    if (lo < 0) {
      // Target is older than anything buffered: show the oldest sample.
      this.copy(this.at(0));
      return;
    }
    if (lo >= this.len - 1) {
      // Nothing newer yet — dead-reckon forward from the last known state.
      const s = this.at(this.len - 1);
      const dt = Math.min(target - s.t, MAX_EXTRAPOLATE_MS) / 1000;
      // Bleed off the assumed velocity so a lost peer coasts to a halt rather
      // than driving into the distance forever.
      const decay = Math.max(0, 1 - (target - s.t) / MAX_EXTRAPOLATE_MS);
      this.copy(s);
      this.x = s.x + Math.sin(s.heading) * s.speed * dt * decay;
      this.z = s.z + Math.cos(s.heading) * s.speed * dt * decay;
      this.wheelSpin = s.wheelSpin + s.speed * dt * decay * 2.78;
      if (target - s.t > 3000) this.active = false;
      return;
    }

    const a = this.at(lo);
    const b = this.at(lo + 1);
    const span = b.t - a.t;
    const f = span > 0 ? Math.min(1, Math.max(0, (target - a.t) / span)) : 0;

    this.x = a.x + (b.x - a.x) * f;
    this.z = a.z + (b.z - a.z) * f;
    this.speed = a.speed + (b.speed - a.speed) * f;
    this.steer = a.steer + (b.steer - a.steer) * f;
    this.wheelSpin = a.wheelSpin + (b.wheelSpin - a.wheelSpin) * f;
    this.heading = lerpAngle(a.heading, b.heading, f);
    // Progress wraps at the finish line; do not interpolate across the seam.
    this.progress = Math.abs(b.progress - a.progress) > 0.5 ? b.progress : a.progress + (b.progress - a.progress) * f;
    this.lap = b.lap;
    this.flags = b.flags;
  }

  private copy(s: Sample) {
    this.x = s.x;
    this.z = s.z;
    this.heading = s.heading;
    this.speed = s.speed;
    this.progress = s.progress;
    this.wheelSpin = s.wheelSpin;
    this.steer = s.steer;
    this.lap = s.lap;
    this.flags = s.flags;
  }
}

function lerpAngle(a: number, b: number, f: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * f;
}

export type NetStatus = "idle" | "connecting" | "open" | "closed" | "error";

export interface NetHandlers {
  onWelcome?(m: Extract<ServerMessage, { t: "welcome" }>): void;
  onPlayers?(players: PlayerInfo[], hostId: number): void;
  onConfig?(config: RoomConfig): void;
  onCountdown?(startsAtLocal: number): void;
  onStatus?(status: RaceStatus): void;
  onResults?(results: ResultRow[]): void;
  onReset?(config: RoomConfig): void;
  onStatusChange?(status: NetStatus, detail?: string): void;
}

export class Net {
  private ws: WebSocket | null = null;
  private handlers: NetHandlers = {};
  private sendTimer: number | null = null;
  private pingTimer: number | null = null;
  private pingSentAt = new Map<number, number>();
  private pingSeq = 0;
  private closedByUs = false;
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private lastArgs: { room: string; name: string; hue: number } | null = null;

  readonly remotes = new Map<number, RemoteCar>();
  selfId = 0;
  hostId = 0;
  status: NetStatus = "idle";
  /** serverTime - performance-anchored local time, in ms. */
  clockOffset = 0;
  rttMs = 0;

  private readonly outBuf = new ArrayBuffer(ENTRY_SIZE);
  private readonly outView = new DataView(this.outBuf);
  private readonly outState = makeCarState();
  private readonly scratch = makeCarState();
  /** Set by the game each tick; sampled by the send timer. */
  pending: CarState | null = null;

  constructor(handlers: NetHandlers = {}) {
    this.handlers = handlers;
  }

  setHandlers(handlers: NetHandlers) {
    this.handlers = handlers;
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(room: string, name: string, hue: number) {
    this.disconnect();
    this.closedByUs = false;
    this.lastArgs = { room, name, hue };
    this.setStatus("connecting");

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/api/ws?room=${encodeURIComponent(room)}&name=${encodeURIComponent(name)}`;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.setStatus("open");
      this.send({ t: "hello", name, hue, v: 1 });
      this.sendTimer = window.setInterval(() => this.flush(), 1000 / SEND_HZ);
      this.pingTimer = window.setInterval(() => this.ping(), PING_INTERVAL_MS);
      this.ping();
    };
    ws.onmessage = (e) => this.onMessage(e);
    ws.onerror = () => this.setStatus("error");
    ws.onclose = (e) => {
      this.teardownTimers();
      this.remotes.clear();
      if (this.closedByUs) {
        this.setStatus("closed");
        return;
      }
      this.setStatus("closed", e.reason || undefined);
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (!this.lastArgs || this.reconnectTimer != null) return;
    // Exponential backoff with a ceiling; racers reconnect fast, then back off.
    const delay = Math.min(8000, 400 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt++;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      const a = this.lastArgs;
      if (a && !this.closedByUs) this.connect(a.room, a.name, a.hue);
    }, delay);
  }

  private onMessage(e: MessageEvent) {
    if (typeof e.data !== "string") {
      this.readSnapshot(e.data as ArrayBuffer);
      return;
    }
    let msg: ServerMessage;
    try {
      msg = JSON.parse(e.data) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.t) {
      case "welcome":
        this.selfId = msg.id;
        this.hostId = msg.hostId;
        this.clockOffset = msg.serverTime - Date.now();
        this.handlers.onWelcome?.(msg);
        this.handlers.onPlayers?.(msg.players, msg.hostId);
        this.handlers.onConfig?.(msg.config);
        if (msg.startsAt != null) this.handlers.onCountdown?.(msg.startsAt - this.clockOffset);
        this.handlers.onStatus?.(msg.status);
        break;
      case "players":
        this.hostId = msg.hostId;
        this.handlers.onPlayers?.(msg.players, msg.hostId);
        break;
      case "config":
        this.handlers.onConfig?.(msg.config);
        break;
      case "countdown":
        this.clockOffset = msg.serverTime - Date.now();
        this.handlers.onCountdown?.(msg.startsAt - this.clockOffset);
        break;
      case "status":
        this.handlers.onStatus?.(msg.status);
        break;
      case "results":
        this.handlers.onResults?.(msg.results);
        break;
      case "reset":
        for (const r of this.remotes.values()) r.active = false;
        this.handlers.onReset?.(msg.config);
        break;
      case "pong": {
        const sent = this.pingSentAt.get(msg.c);
        if (sent != null) {
          this.pingSentAt.delete(msg.c);
          const rtt = Date.now() - sent;
          this.rttMs = this.rttMs === 0 ? rtt : this.rttMs * 0.7 + rtt * 0.3;
          // Assume a symmetric path: the server's clock at reply time was
          // serverTime, which was rtt/2 ago locally.
          const offset = msg.serverTime + rtt / 2 - Date.now();
          this.clockOffset = this.clockOffset === 0 ? offset : this.clockOffset * 0.8 + offset * 0.2;
        }
        break;
      }
      case "error":
        this.setStatus("error", msg.message);
        break;
    }
  }

  private readSnapshot(buf: ArrayBuffer) {
    const view = new DataView(buf);
    if (view.byteLength < SNAPSHOT_HEADER || view.getUint8(0) !== MSG_SNAPSHOT) return;
    const count = view.getUint8(1);
    const now = Date.now();
    const seen = new Set<number>();

    for (let i = 0; i < count; i++) {
      const off = SNAPSHOT_HEADER + i * ENTRY_SIZE;
      if (off + ENTRY_SIZE > view.byteLength) break;
      readEntry(view, off, this.scratch);
      if (this.scratch.id === this.selfId) continue;
      seen.add(this.scratch.id);
      let r = this.remotes.get(this.scratch.id);
      if (!r) {
        r = new RemoteCar(this.scratch.id);
        this.remotes.set(this.scratch.id, r);
      }
      r.push(this.scratch, now);
    }
  }

  /** Advance every remote to its interpolated present. Call once per frame. */
  interpolate(now: number) {
    for (const r of this.remotes.values()) r.sample(now);
  }

  dropRemote(id: number) {
    this.remotes.delete(id);
  }

  private flush() {
    const s = this.pending;
    if (!s || !this.connected) return;
    this.outState.id = this.selfId;
    this.outState.flags = s.flags;
    this.outState.lap = s.lap;
    this.outState.x = s.x;
    this.outState.z = s.z;
    this.outState.heading = s.heading;
    this.outState.speed = s.speed;
    this.outState.progress = s.progress;
    this.outState.wheelSpin = s.wheelSpin;
    this.outState.steer = s.steer;
    writeEntry(this.outView, 0, this.outState);
    this.outView.setUint8(0, MSG_STATE);
    try {
      this.ws!.send(this.outBuf);
    } catch {
      /* socket closing */
    }
  }

  private ping() {
    const c = ++this.pingSeq & 0xffff;
    this.pingSentAt.set(c, Date.now());
    // Never let unanswered pings accumulate.
    if (this.pingSentAt.size > 8) {
      const oldest = this.pingSentAt.keys().next().value;
      if (oldest !== undefined) this.pingSentAt.delete(oldest);
    }
    this.send({ t: "ping", c });
  }

  send(msg: ClientMessage) {
    if (!this.connected) return;
    try {
      this.ws!.send(JSON.stringify(msg));
    } catch {
      /* socket closing */
    }
  }

  private teardownTimers() {
    if (this.sendTimer != null) window.clearInterval(this.sendTimer);
    if (this.pingTimer != null) window.clearInterval(this.pingTimer);
    this.sendTimer = null;
    this.pingTimer = null;
  }

  private setStatus(s: NetStatus, detail?: string) {
    this.status = s;
    this.handlers.onStatusChange?.(s, detail);
  }

  disconnect() {
    this.closedByUs = true;
    if (this.reconnectTimer != null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.teardownTimers();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      try {
        this.ws.close();
      } catch {
        /* already closed */
      }
      this.ws = null;
    }
    this.remotes.clear();
    this.setStatus("idle");
  }
}
