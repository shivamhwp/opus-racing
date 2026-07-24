/**
 * Wire protocol shared by the browser client and the Durable Object race room.
 *
 * Hot path (car state) is a fixed-stride binary record so a full 16-car snapshot
 * is 524 bytes and decodes with zero allocation. Cold path (lobby, results,
 * chat-ish control flow) is plain JSON text frames — readability where it's free.
 */

export const PROTOCOL_VERSION = 1;

export const MSG_STATE = 0x01; // client -> server, one entry (the sender's car)
export const MSG_SNAPSHOT = 0x81; // server -> client, N entries

/** id | flags | lap | reserved | 7 x f32 */
export const ENTRY_SIZE = 32;
export const SNAPSHOT_HEADER = 8; // type | count | u16 pad | f32 serverTimeMs (low bits)
export const MAX_PLAYERS = 16;

export const FLAG_DRIFT = 1 << 0;
export const FLAG_OFFTRACK = 1 << 1;
export const FLAG_FINISHED = 1 << 2;
export const FLAG_BRAKING = 1 << 3;
export const FLAG_AIRBORNE = 1 << 4;
export const FLAG_BOOST = 1 << 5;

export interface CarState {
  id: number;
  flags: number;
  lap: number;
  x: number;
  z: number;
  heading: number;
  speed: number;
  progress: number;
  wheelSpin: number;
  steer: number;
}

export function makeCarState(id = 0): CarState {
  return {
    id,
    flags: 0,
    lap: 0,
    x: 0,
    z: 0,
    heading: 0,
    speed: 0,
    progress: 0,
    wheelSpin: 0,
    steer: 0,
  };
}

export function writeEntry(view: DataView, off: number, s: CarState): void {
  view.setUint8(off, s.id);
  view.setUint8(off + 1, s.flags);
  view.setUint8(off + 2, s.lap);
  view.setUint8(off + 3, 0);
  view.setFloat32(off + 4, s.x, true);
  view.setFloat32(off + 8, s.z, true);
  view.setFloat32(off + 12, s.heading, true);
  view.setFloat32(off + 16, s.speed, true);
  view.setFloat32(off + 20, s.progress, true);
  view.setFloat32(off + 24, s.wheelSpin, true);
  view.setFloat32(off + 28, s.steer, true);
}

export function readEntry(view: DataView, off: number, out: CarState): CarState {
  out.id = view.getUint8(off);
  out.flags = view.getUint8(off + 1);
  out.lap = view.getUint8(off + 2);
  out.x = view.getFloat32(off + 4, true);
  out.z = view.getFloat32(off + 8, true);
  out.heading = view.getFloat32(off + 12, true);
  out.speed = view.getFloat32(off + 16, true);
  out.progress = view.getFloat32(off + 20, true);
  out.wheelSpin = view.getFloat32(off + 24, true);
  out.steer = view.getFloat32(off + 28, true);
  return out;
}

// ---------------------------------------------------------------------------
// Control plane (JSON)
// ---------------------------------------------------------------------------

export type RaceStatus = "lobby" | "countdown" | "racing" | "finished";

export interface PlayerInfo {
  id: number;
  name: string;
  hue: number;
  ready: boolean;
  finished: boolean;
  lap: number;
  bestLapMs: number | null;
  totalMs: number | null;
}

export interface RoomConfig {
  laps: number;
  trackId: string;
}

export interface ResultRow {
  id: number;
  name: string;
  hue: number;
  position: number;
  totalMs: number | null;
  bestLapMs: number | null;
  laps: number;
  dnf: boolean;
}

export type ClientMessage =
  | { t: "hello"; name: string; hue: number; v: number }
  | { t: "config"; laps?: number; trackId?: string }
  | { t: "ready"; ready: boolean }
  | { t: "start" }
  | { t: "lap"; lap: number; lapMs: number; totalMs: number }
  | { t: "finish"; totalMs: number; bestLapMs: number }
  | { t: "reset" }
  | { t: "ping"; c: number };

export type ServerMessage =
  | {
      t: "welcome";
      id: number;
      room: string;
      hostId: number;
      status: RaceStatus;
      config: RoomConfig;
      players: PlayerInfo[];
      startsAt: number | null;
      serverTime: number;
    }
  | { t: "players"; players: PlayerInfo[]; hostId: number }
  | { t: "config"; config: RoomConfig }
  | { t: "countdown"; startsAt: number; serverTime: number }
  | { t: "status"; status: RaceStatus }
  | { t: "results"; results: ResultRow[] }
  | { t: "reset"; config: RoomConfig }
  | { t: "error"; message: string }
  | { t: "pong"; c: number; serverTime: number };

export const DEFAULT_CONFIG: RoomConfig = { laps: 3, trackId: "vermilion" };
export const LAP_OPTIONS = [1, 2, 3, 5, 8, 12] as const;

/** Palette of driver colors (hue degrees), spaced for max distinguishability. */
export const DRIVER_HUES = [
  6, 28, 45, 78, 140, 165, 188, 205, 224, 250, 272, 292, 312, 332, 350, 118,
];

export function formatMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "--:--.---";
  const neg = ms < 0;
  const v = Math.abs(ms);
  const m = Math.floor(v / 60000);
  const s = Math.floor((v % 60000) / 1000);
  const f = Math.floor(v % 1000);
  return `${neg ? "-" : ""}${m}:${s.toString().padStart(2, "0")}.${f
    .toString()
    .padStart(3, "0")}`;
}

export function formatGap(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const v = Math.abs(ms);
  if (v >= 60000) return `+${formatMs(v)}`;
  return `+${(v / 1000).toFixed(3)}`;
}
