/// <reference types="@cloudflare/workers-types" />

import {
  DEFAULT_CONFIG,
  DRIVER_HUES,
  ENTRY_SIZE,
  LAP_OPTIONS,
  MAX_PLAYERS,
  MSG_SNAPSHOT,
  MSG_STATE,
  SNAPSHOT_HEADER,
  type ClientMessage,
  type PlayerInfo,
  type ResultRow,
  type RaceStatus,
  type RoomConfig,
  type ServerMessage,
} from "../../shared/protocol";

/**
 * One Durable Object per race room.
 *
 * Car state is relayed, not simulated here: each client runs the same
 * deterministic physics for its own car and reports the result, and the room
 * fans those reports out as batched 20 Hz snapshots. That keeps the object's
 * CPU cost near zero and the round-trip at one hop, which is what actually
 * decides how a race feels.
 *
 * Race *control* — who is in, what the lap count is, when the lights go out,
 * and the finishing order — is authoritative here, so a modified client cannot
 * start a race early, hand itself a win, or corrupt anyone else's lobby.
 */

const SNAPSHOT_HZ = 20;
const SNAPSHOT_MS = 1000 / SNAPSHOT_HZ;
const COUNTDOWN_MS = 5200;
/** How long stragglers get after the winner crosses the line. */
const FINISH_GRACE_MS = 90_000;
/** A lap this quick is not physically possible; treat it as a bad client. */
const MIN_LAP_MS = 12_000;
const IDLE_TIMEOUT_MS = 30_000;

interface Conn {
  ws: WebSocket;
  id: number;
  name: string;
  hue: number;
  ready: boolean;
  finished: boolean;
  lap: number;
  bestLapMs: number | null;
  totalMs: number | null;
  joinedAt: number;
  lastSeen: number;
  /** Latest car state record, already in wire format. */
  state: Uint8Array | null;
  position: number;
}

export class RaceRoom implements DurableObject {
  private readonly ctx: DurableObjectState;
  private conns = new Map<number, Conn>();
  private nextId = 1;
  private config: RoomConfig = { ...DEFAULT_CONFIG };
  private status: RaceStatus = "lobby";
  private hostId = 0;
  private startsAt: number | null = null;
  private firstFinishAt: number | null = null;
  private finishOrder = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private snapshotBuf: ArrayBuffer;
  private snapshotView: DataView;
  private snapshotBytes: Uint8Array;

  constructor(ctx: DurableObjectState, _env: unknown) {
    this.ctx = ctx;
    const size = SNAPSHOT_HEADER + ENTRY_SIZE * MAX_PLAYERS;
    this.snapshotBuf = new ArrayBuffer(size);
    this.snapshotView = new DataView(this.snapshotBuf);
    this.snapshotBytes = new Uint8Array(this.snapshotBuf);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    if (this.conns.size >= MAX_PLAYERS) {
      return new Response("room full", { status: 503 });
    }

    const url = new URL(request.url);
    const name = sanitiseName(url.searchParams.get("name") ?? "");
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();

    const id = this.claimId();
    const now = Date.now();
    const conn: Conn = {
      ws: server,
      id,
      name,
      hue: this.claimHue(),
      ready: false,
      finished: false,
      lap: 0,
      bestLapMs: null,
      totalMs: null,
      joinedAt: now,
      lastSeen: now,
      state: null,
      position: 0,
    };
    this.conns.set(id, conn);
    if (!this.conns.has(this.hostId)) this.hostId = id;

    server.addEventListener("message", (e: MessageEvent) => {
      try {
        this.onMessage(conn, e.data);
      } catch {
        // A malformed frame from one client must never take the room down.
      }
    });
    const drop = () => this.onClose(conn);
    server.addEventListener("close", drop);
    server.addEventListener("error", drop);

    this.send(conn, {
      t: "welcome",
      id,
      room: this.ctx.id.toString().slice(0, 8),
      hostId: this.hostId,
      status: this.status,
      config: this.config,
      players: this.playerList(),
      startsAt: this.startsAt,
      serverTime: now,
    });
    this.broadcastPlayers();
    this.ensureTimer();

    return new Response(null, { status: 101, webSocket: client });
  }

  // -------------------------------------------------------------------------

  private claimId(): number {
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const candidate = ((this.nextId + i - 1) % MAX_PLAYERS) + 1;
      if (!this.conns.has(candidate)) {
        this.nextId = (candidate % MAX_PLAYERS) + 1;
        return candidate;
      }
    }
    return this.nextId;
  }

  private claimHue(): number {
    const taken = new Set([...this.conns.values()].map((c) => c.hue));
    for (const h of DRIVER_HUES) if (!taken.has(h)) return h;
    return DRIVER_HUES[0];
  }

  private onMessage(conn: Conn, data: string | ArrayBuffer) {
    conn.lastSeen = Date.now();

    if (typeof data !== "string") {
      const bytes = new Uint8Array(data);
      if (bytes.length !== ENTRY_SIZE || bytes[0] !== MSG_STATE) return;
      // Stamp the sender's real id over whatever they claimed.
      const copy = bytes.slice();
      copy[0] = conn.id;
      conn.state = copy;
      return;
    }

    const msg = JSON.parse(data) as ClientMessage;
    switch (msg.t) {
      case "hello":
        conn.name = sanitiseName(msg.name);
        if (DRIVER_HUES.includes(msg.hue)) {
          const taken = new Set(
            [...this.conns.values()].filter((c) => c !== conn).map((c) => c.hue),
          );
          if (!taken.has(msg.hue)) conn.hue = msg.hue;
        }
        this.broadcastPlayers();
        break;

      case "config": {
        if (conn.id !== this.hostId || this.status !== "lobby") return;
        if (msg.laps != null && (LAP_OPTIONS as readonly number[]).includes(msg.laps)) {
          this.config = { ...this.config, laps: msg.laps };
        }
        if (msg.trackId != null && /^[a-z]{3,16}$/.test(msg.trackId)) {
          this.config = { ...this.config, trackId: msg.trackId };
        }
        this.broadcast({ t: "config", config: this.config });
        break;
      }

      case "ready":
        if (this.status !== "lobby") return;
        conn.ready = !!msg.ready;
        this.broadcastPlayers();
        break;

      case "start": {
        if (conn.id !== this.hostId || this.status !== "lobby") return;
        this.status = "countdown";
        this.startsAt = Date.now() + COUNTDOWN_MS;
        this.firstFinishAt = null;
        this.finishOrder = 0;
        for (const c of this.conns.values()) {
          c.finished = false;
          c.lap = 0;
          c.bestLapMs = null;
          c.totalMs = null;
          c.position = 0;
        }
        this.broadcast({ t: "countdown", startsAt: this.startsAt, serverTime: Date.now() });
        this.broadcastPlayers();
        break;
      }

      case "lap": {
        if (this.status !== "racing" || conn.finished) return;
        // Laps must advance by one and take a physically possible amount of time.
        if (msg.lap !== conn.lap + 1) return;
        if (!Number.isFinite(msg.lapMs) || msg.lapMs < MIN_LAP_MS) return;
        conn.lap = msg.lap;
        if (conn.bestLapMs == null || msg.lapMs < conn.bestLapMs) conn.bestLapMs = msg.lapMs;
        this.broadcastPlayers();
        break;
      }

      case "finish": {
        if (this.status !== "racing" || conn.finished) return;
        if (conn.lap < this.config.laps) return;
        if (!Number.isFinite(msg.totalMs) || msg.totalMs < MIN_LAP_MS * this.config.laps) return;
        conn.finished = true;
        conn.totalMs = msg.totalMs;
        if (Number.isFinite(msg.bestLapMs) && msg.bestLapMs >= MIN_LAP_MS) {
          conn.bestLapMs = conn.bestLapMs == null ? msg.bestLapMs : Math.min(conn.bestLapMs, msg.bestLapMs);
        }
        conn.position = ++this.finishOrder;
        if (this.firstFinishAt == null) this.firstFinishAt = Date.now();
        this.broadcastPlayers();
        if ([...this.conns.values()].every((c) => c.finished)) this.endRace();
        break;
      }

      case "reset": {
        if (conn.id !== this.hostId) return;
        this.resetToLobby();
        break;
      }

      case "ping":
        this.send(conn, { t: "pong", c: msg.c, serverTime: Date.now() });
        break;
    }
  }

  private onClose(conn: Conn) {
    if (!this.conns.delete(conn.id)) return;
    if (this.hostId === conn.id) {
      // Oldest remaining connection inherits the room.
      let next = 0;
      let oldest = Infinity;
      for (const c of this.conns.values()) {
        if (c.joinedAt < oldest) {
          oldest = c.joinedAt;
          next = c.id;
        }
      }
      this.hostId = next;
    }
    if (this.conns.size === 0) {
      this.status = "lobby";
      this.startsAt = null;
      this.stopTimer();
      return;
    }
    this.broadcastPlayers();
    if (this.status === "racing" && [...this.conns.values()].every((c) => c.finished)) {
      this.endRace();
    }
  }

  // -------------------------------------------------------------------------

  private ensureTimer() {
    if (this.timer != null) return;
    this.timer = setInterval(() => this.tick(), SNAPSHOT_MS);
  }

  private stopTimer() {
    if (this.timer == null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private tick() {
    if (this.conns.size === 0) {
      this.stopTimer();
      return;
    }
    const now = Date.now();

    if (this.status === "countdown" && this.startsAt != null && now >= this.startsAt) {
      this.status = "racing";
      this.broadcast({ t: "status", status: "racing" });
    }

    if (
      this.status === "racing" &&
      this.firstFinishAt != null &&
      now - this.firstFinishAt > FINISH_GRACE_MS
    ) {
      this.endRace();
    }

    // Drop connections that have gone quiet — a half-open socket otherwise
    // keeps a ghost car on everyone's track.
    for (const c of this.conns.values()) {
      if (now - c.lastSeen > IDLE_TIMEOUT_MS) {
        try {
          c.ws.close(1001, "idle");
        } catch {
          /* already gone */
        }
        this.onClose(c);
      }
    }

    this.broadcastSnapshot(now);
  }

  private broadcastSnapshot(now: number) {
    let count = 0;
    let off = SNAPSHOT_HEADER;
    for (const c of this.conns.values()) {
      if (!c.state) continue;
      this.snapshotBytes.set(c.state, off);
      off += ENTRY_SIZE;
      count++;
      if (count >= MAX_PLAYERS) break;
    }
    if (count === 0) return;

    this.snapshotView.setUint8(0, MSG_SNAPSHOT);
    this.snapshotView.setUint8(1, count);
    this.snapshotView.setUint16(2, 0, true);
    // Low 32 bits of the wall clock: enough to align 40-day-old timestamps.
    this.snapshotView.setUint32(4, now >>> 0, true);

    const frame = this.snapshotBuf.slice(0, off);
    for (const c of this.conns.values()) {
      try {
        c.ws.send(frame);
      } catch {
        /* closing */
      }
    }
  }

  private endRace() {
    if (this.status === "finished") return;
    this.status = "finished";
    this.broadcast({ t: "results", results: this.results() });
  }

  private resetToLobby() {
    this.status = "lobby";
    this.startsAt = null;
    this.firstFinishAt = null;
    this.finishOrder = 0;
    for (const c of this.conns.values()) {
      c.ready = false;
      c.finished = false;
      c.lap = 0;
      c.bestLapMs = null;
      c.totalMs = null;
      c.position = 0;
      c.state = null;
    }
    this.broadcast({ t: "reset", config: this.config });
    this.broadcastPlayers();
  }

  private results(): ResultRow[] {
    const rows = [...this.conns.values()].map((c) => ({
      id: c.id,
      name: c.name,
      hue: c.hue,
      position: c.position,
      totalMs: c.totalMs,
      bestLapMs: c.bestLapMs,
      laps: c.lap,
      dnf: !c.finished,
    }));
    // Finishers by finishing order, then everyone else by distance covered.
    rows.sort((a, b) => {
      if (a.dnf !== b.dnf) return a.dnf ? 1 : -1;
      if (!a.dnf && !b.dnf) return a.position - b.position;
      return b.laps - a.laps;
    });
    rows.forEach((r, i) => (r.position = i + 1));
    return rows;
  }

  private playerList(): PlayerInfo[] {
    return [...this.conns.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((c) => ({
        id: c.id,
        name: c.name,
        hue: c.hue,
        ready: c.ready,
        finished: c.finished,
        lap: c.lap,
        bestLapMs: c.bestLapMs,
        totalMs: c.totalMs,
      }));
  }

  private broadcastPlayers() {
    this.broadcast({ t: "players", players: this.playerList(), hostId: this.hostId });
  }

  private send(conn: Conn, msg: ServerMessage) {
    try {
      conn.ws.send(JSON.stringify(msg));
    } catch {
      /* closing */
    }
  }

  private broadcast(msg: ServerMessage) {
    const text = JSON.stringify(msg);
    for (const c of this.conns.values()) {
      try {
        c.ws.send(text);
      } catch {
        /* closing */
      }
    }
  }
}

function sanitiseName(raw: string): string {
  const cleaned = raw
    // Strip control characters so a name cannot smuggle markup or newlines.
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim()
    .slice(0, 16);
  return cleaned || "DRIVER";
}

/**
 * This Worker exists only to host the Durable Object class. Rooms are reached
 * through the binding on the Pages project, which is what enforces the
 * password — there is deliberately no public route to a room from here.
 */
export default {
  fetch(): Response {
    return new Response("opus-racing rooms: bound-only", { status: 404 });
  },
};
