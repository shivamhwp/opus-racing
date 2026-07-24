import {
  DRIVER_HUES,
  LAP_OPTIONS,
  formatMs,
  type PlayerInfo,
  type ResultRow,
  type RoomConfig,
} from "../../shared/protocol";
import type { Quality } from "../game/game";
import { TRACKS, getTrackDef, trackOutline } from "../game/track";
import { icon } from "./icons";

/**
 * Menu, lobby and results.
 *
 * Only one screen exists in the DOM at a time and the live circuit keeps
 * rendering behind all of them, so the transition from browsing to racing is a
 * fade rather than a load.
 */

export interface Profile {
  name: string;
  hue: number;
  room: string;
  quality: Quality;
}

export interface ScreenCallbacks {
  onJoin(profile: Profile): void;
  onLeave(): void;
  onReady(ready: boolean): void;
  onConfig(patch: { laps?: number; trackId?: string }): void;
  onStart(): void;
  onRematch(): void;
  onQuality(q: Quality): void;
  onTrackPreview(trackId: string): void;
}

const QUALITIES: { id: Quality; label: string; note: string }[] = [
  { id: "ultra", label: "Ultra", note: "Full resolution, full bloom" },
  { id: "high", label: "High", note: "Recommended" },
  { id: "balanced", label: "Balanced", note: "Lighter post, capped DPR" },
  { id: "efficient", label: "Efficient", note: "No bloom, minimum load" },
];

function h(html: string): HTMLElement {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

function randomRoom(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no look-alike glyphs
  let s = "";
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}

const STORE_KEY = "opus-racing/profile";

export function loadProfile(): Profile {
  const url = new URL(location.href);
  const roomFromLink = (url.searchParams.get("room") ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  let saved: Partial<Profile> = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}") as Partial<Profile>;
  } catch {
    /* first visit, or storage disabled */
  }
  return {
    name: saved.name ?? "",
    hue: typeof saved.hue === "number" && DRIVER_HUES.includes(saved.hue) ? saved.hue : DRIVER_HUES[0],
    room: roomFromLink || saved.room || randomRoom(),
    quality: (saved.quality as Quality) ?? "high",
  };
}

export function saveProfile(p: Profile) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(p));
  } catch {
    /* storage disabled; the session still works */
  }
}

export class Screens {
  private readonly root: HTMLElement;
  private readonly cb: ScreenCallbacks;
  profile: Profile;

  private players: PlayerInfo[] = [];
  private hostId = 0;
  private selfId = 0;
  private config: RoomConfig = { laps: 3, trackId: "vermilion" };
  private connection: { state: string; detail?: string } = { state: "idle" };
  private current: "menu" | "lobby" | "results" | "race" = "menu";
  private takenHues = new Set<number>();

  constructor(root: HTMLElement, cb: ScreenCallbacks, profile: Profile) {
    this.root = root;
    this.cb = cb;
    this.profile = profile;
  }

  // -------------------------------------------------------------------------

  showMenu(error?: string) {
    this.current = "menu";
    const p = this.profile;
    const screen = h(`<div class="screen"><div class="screen__inner"></div></div>`);
    const inner = screen.firstElementChild as HTMLElement;

    inner.append(
      h(`<div class="brand">
           <h1>OPUS RACING</h1>
           <span class="tag">Grand Prix // Live</span>
         </div>`),
      h(`<p class="blurb">
           A real-time Formula 1 circuit racer that runs entirely in your browser.
           Procedural cars, hand-written shaders, zero downloaded assets — and a
           physics model that brakes at 4&nbsp;g and corners at nearly 6.
           Share the room code and race anyone.
         </p>`),
    );

    const grid = h(`<div class="grid2"></div>`);

    // --- driver -----------------------------------------------------------
    const driver = h(`<div class="panel card">
      <h2>${icon("user")} Driver</h2>
      <div class="stack">
        <div class="field">
          <label class="label" for="nm">Name</label>
          <input id="nm" class="input" maxlength="16" placeholder="ENTER A NAME" autocomplete="off" spellcheck="false">
        </div>
        <div class="field">
          <span class="label">Livery</span>
          <div class="hues"></div>
        </div>
      </div>
    </div>`);
    const nameInput = driver.querySelector<HTMLInputElement>("#nm")!;
    nameInput.value = p.name;
    nameInput.addEventListener("input", () => {
      p.name = nameInput.value.toUpperCase();
      if (nameInput.value !== p.name) nameInput.value = p.name;
    });

    const hues = driver.querySelector<HTMLElement>(".hues")!;
    for (const hue of DRIVER_HUES) {
      const b = h(`<button class="hue" style="--h:${hue}" aria-label="Livery ${hue}"></button>`);
      b.setAttribute("aria-pressed", String(hue === p.hue));
      b.addEventListener("click", () => {
        p.hue = hue;
        hues.querySelectorAll("[aria-pressed]").forEach((n) =>
          n.setAttribute("aria-pressed", String(Number((n as HTMLElement).style.getPropertyValue("--h")) === hue)),
        );
      });
      hues.append(b);
    }

    // --- session ----------------------------------------------------------
    const session = h(`<div class="panel card">
      <h2>${icon("flagCheckered")} Session</h2>
      <div class="stack">
        <div class="field">
          <label class="label" for="rm">Room code</label>
          <div class="row">
            <input id="rm" class="input" maxlength="12" autocomplete="off" spellcheck="false">
            <button class="btn btn--sm" id="dice" title="New room code">${icon("arrowsClockwise")}</button>
          </div>
          <p class="hint">Anyone with this code and the site password joins the same race.</p>
        </div>
        <div class="field">
          <span class="label">Graphics</span>
          <div class="seg" id="q"></div>
          <p class="hint" id="qnote"></p>
        </div>
      </div>
    </div>`);

    const roomInput = session.querySelector<HTMLInputElement>("#rm")!;
    roomInput.value = p.room;
    roomInput.addEventListener("input", () => {
      p.room = roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (roomInput.value !== p.room) roomInput.value = p.room;
    });
    session.querySelector("#dice")!.addEventListener("click", (e) => {
      e.preventDefault();
      p.room = randomRoom();
      roomInput.value = p.room;
    });

    const qseg = session.querySelector<HTMLElement>("#q")!;
    const qnote = session.querySelector<HTMLElement>("#qnote")!;
    const paintQuality = () => {
      qseg.querySelectorAll("button").forEach((b) =>
        b.setAttribute("aria-pressed", String((b as HTMLElement).dataset.q === p.quality)),
      );
      qnote.textContent = QUALITIES.find((q) => q.id === p.quality)?.note ?? "";
    };
    for (const q of QUALITIES) {
      const b = h(`<button data-q="${q.id}">${q.label}</button>`);
      b.addEventListener("click", () => {
        p.quality = q.id;
        this.cb.onQuality(q.id);
        paintQuality();
      });
      qseg.append(b);
    }
    paintQuality();

    grid.append(driver, session);
    inner.append(grid);

    if (error) {
      inner.append(h(`<div class="err-box" style="margin-top:16px">${icon("warning")}<span>${escapeHtml(error)}</span></div>`));
    }

    const actions = h(`<div class="row row--end" style="margin-top:20px;gap:14px">
      <p class="hint" style="flex:1;margin:0">
        <span class="kbd">W A S D</span> drive ·
        <span class="kbd">Shift</span> DRS ·
        <span class="kbd">Space</span> handbrake ·
        <span class="kbd">C</span> camera ·
        <span class="kbd">R</span> recover
      </p>
      <button class="btn btn--primary" id="go">${icon("flagCheckered")} Join race</button>
    </div>`);
    const go = actions.querySelector<HTMLButtonElement>("#go")!;
    const submit = () => {
      p.name = (nameInput.value || "DRIVER").toUpperCase().slice(0, 16);
      p.room = (roomInput.value || randomRoom()).toUpperCase();
      saveProfile(p);
      this.cb.onJoin(p);
    };
    go.addEventListener("click", submit);
    nameInput.addEventListener("keydown", (e) => e.key === "Enter" && submit());
    roomInput.addEventListener("keydown", (e) => e.key === "Enter" && submit());

    inner.append(actions);
    this.swap(screen);
    if (!p.name) nameInput.focus();
  }

  // -------------------------------------------------------------------------

  showLobby() {
    this.current = "lobby";
    const screen = h(`<div class="screen"><div class="screen__inner"></div></div>`);
    const inner = screen.firstElementChild as HTMLElement;

    inner.append(
      h(`<div class="brand"><h1>PADDOCK</h1><span class="tag" id="conn"></span></div>`),
    );

    const grid = h(`<div class="grid2"></div>`);

    const left = h(`<div class="panel card">
      <h2>${icon("usersThree")} Grid <span id="pcount" style="margin-left:auto;color:var(--dim)"></span></h2>
      <div class="stack">
        <div class="room-code">
          <div>
            <div class="label">Room</div>
            <div class="code" id="code"></div>
          </div>
          <button class="btn btn--sm" id="copy">${icon("copy")} Invite</button>
        </div>
        <div class="players" id="plist"></div>
      </div>
    </div>`);

    const right = h(`<div class="panel card">
      <h2>${icon("gearSix")} Race setup</h2>
      <div class="stack">
        <div class="field">
          <span class="label">Circuit</span>
          <div class="tracks" id="tracks"></div>
        </div>
        <div class="field">
          <span class="label">Laps</span>
          <div class="seg" id="laps"></div>
        </div>
        <p class="hint" id="hostnote"></p>
      </div>
    </div>`);

    grid.append(left, right);
    inner.append(grid);

    const actions = h(`<div class="row" style="margin-top:20px;gap:12px">
      <button class="btn btn--ghost" id="leave">${icon("signOut")} Leave</button>
      <div style="flex:1"></div>
      <button class="btn" id="ready">${icon("check")} Ready</button>
      <button class="btn btn--primary" id="start">${icon("play")} Start race</button>
    </div>`);
    inner.append(actions);

    actions.querySelector("#leave")!.addEventListener("click", () => this.cb.onLeave());
    actions.querySelector("#ready")!.addEventListener("click", () => {
      const me = this.players.find((p) => p.id === this.selfId);
      this.cb.onReady(!me?.ready);
    });
    actions.querySelector("#start")!.addEventListener("click", () => this.cb.onStart());

    left.querySelector("#copy")!.addEventListener("click", async (e) => {
      const btn = e.currentTarget as HTMLElement;
      const link = `${location.origin}/?room=${encodeURIComponent(this.profile.room)}`;
      try {
        await navigator.clipboard.writeText(link);
        btn.innerHTML = `${icon("checkCircle")} Copied`;
      } catch {
        // Clipboard can be blocked; showing the link is still useful.
        btn.innerHTML = `${icon("shareNetwork")} ${escapeHtml(link)}`;
      }
      setTimeout(() => (btn.innerHTML = `${icon("copy")} Invite`), 2200);
    });

    // Circuits
    const tracksEl = right.querySelector<HTMLElement>("#tracks")!;
    for (const t of TRACKS) {
      const b = h(`<button class="track" data-track="${t.id}" style="--tint:#${t.accent
        .toString(16)
        .padStart(6, "0")}">
        <svg class="map" viewBox="0 0 100 100">
          <path d="${trackOutline(t)}" fill="none" stroke="currentColor" stroke-width="5"
                stroke-linejoin="round" opacity="0.85"/>
        </svg>
        <span>
          <div class="name">${t.name}</div>
          <div class="sub">${t.subtitle}</div>
        </span>
      </button>`);
      b.addEventListener("click", () => {
        if (!this.isHost) return;
        this.cb.onConfig({ trackId: t.id });
      });
      b.addEventListener("pointerenter", () => this.cb.onTrackPreview(t.id));
      tracksEl.append(b);
    }

    // Laps
    const lapsEl = right.querySelector<HTMLElement>("#laps")!;
    for (const n of LAP_OPTIONS) {
      const b = h(`<button data-laps="${n}">${n}</button>`);
      b.addEventListener("click", () => {
        if (!this.isHost) return;
        this.cb.onConfig({ laps: n });
      });
      lapsEl.append(b);
    }

    this.swap(screen);
    this.paintLobby();
  }

  private get isHost() {
    return this.selfId !== 0 && this.selfId === this.hostId;
  }

  /** Re-render the volatile parts of the lobby. */
  private paintLobby() {
    if (this.current !== "lobby") return;
    const root = this.root;

    const code = root.querySelector<HTMLElement>("#code");
    if (code) code.textContent = this.profile.room;

    const conn = root.querySelector<HTMLElement>("#conn");
    if (conn) {
      const live = this.connection.state === "open";
      const bad = this.connection.state === "error" || this.connection.state === "closed";
      conn.innerHTML = `<span class="status-line"><i class="dot ${
        live ? "dot--live" : bad ? "dot--bad" : ""
      }"></i>${
        live ? "Connected" : this.connection.state === "connecting" ? "Connecting…" : "Offline"
      }</span>`;
    }

    const count = root.querySelector<HTMLElement>("#pcount");
    if (count) count.textContent = `${this.players.length}/16`;

    const list = root.querySelector<HTMLElement>("#plist");
    if (list) {
      list.innerHTML = "";
      for (const p of this.players) {
        const badges: string[] = [];
        if (p.id === this.hostId) badges.push(`<span class="badge badge--host">${icon("crown")} Host</span>`);
        if (p.ready) badges.push(`<span class="badge badge--ready">${icon("check")} Ready</span>`);
        list.append(
          h(`<div class="player ${p.id === this.selfId ? "player--self" : ""}">
               <i class="chip" style="--h:${p.hue}"></i>
               <span class="nm">${escapeHtml(p.name)}</span>
               ${badges.join("")}
             </div>`),
        );
      }
      if (this.players.length === 0) {
        list.append(h(`<p class="hint">Waiting for the room…</p>`));
      }
    }

    this.takenHues = new Set(this.players.filter((p) => p.id !== this.selfId).map((p) => p.hue));

    for (const b of Array.from(root.querySelectorAll<HTMLButtonElement>("[data-track]"))) {
      b.setAttribute("aria-pressed", String(b.dataset.track === this.config.trackId));
      b.disabled = !this.isHost;
    }
    for (const b of Array.from(root.querySelectorAll<HTMLButtonElement>("[data-laps]"))) {
      b.setAttribute("aria-pressed", String(Number(b.dataset.laps) === this.config.laps));
      b.disabled = !this.isHost;
    }

    const note = root.querySelector<HTMLElement>("#hostnote");
    if (note) {
      const def = getTrackDef(this.config.trackId);
      note.textContent = this.isHost
        ? `You are the host. ${this.config.laps} lap${this.config.laps === 1 ? "" : "s"} of ${def.name}.`
        : `The host picks the circuit and lap count. ${this.config.laps} lap${
            this.config.laps === 1 ? "" : "s"
          } of ${def.name}.`;
    }

    const start = root.querySelector<HTMLButtonElement>("#start");
    if (start) {
      start.hidden = !this.isHost;
      start.disabled = this.connection.state !== "open";
    }
    const ready = root.querySelector<HTMLButtonElement>("#ready");
    if (ready) {
      const me = this.players.find((p) => p.id === this.selfId);
      ready.innerHTML = me?.ready ? `${icon("checkCircle")} Ready` : `${icon("check")} Ready up`;
      ready.classList.toggle("btn--primary", !!me?.ready && !this.isHost);
      ready.disabled = this.connection.state !== "open";
    }
  }

  // -------------------------------------------------------------------------

  showResults(rows: ResultRow[]) {
    this.current = "results";
    const screen = h(`<div class="screen"><div class="screen__inner"></div></div>`);
    const inner = screen.firstElementChild as HTMLElement;

    const winner = rows[0];
    inner.append(
      h(`<div class="brand">
           <h1>CHEQUERED FLAG</h1>
           <span class="tag">${winner ? escapeHtml(winner.name) + " takes it" : "Race over"}</span>
         </div>`),
    );

    const panel = h(`<div class="panel card"><h2>${icon("trophy")} Classification</h2>
      <div class="results"></div></div>`);
    const list = panel.querySelector<HTMLElement>(".results")!;

    let fastest: ResultRow | null = null;
    for (const r of rows) {
      if (r.bestLapMs != null && (fastest?.bestLapMs == null || r.bestLapMs < fastest.bestLapMs)) {
        fastest = r;
      }
    }

    rows.forEach((r, i) => {
      const row = h(`<div class="result ${r.id === this.selfId ? "result--self" : ""} ${
        i === 0 && !r.dnf ? "result--p1" : ""
      }" style="animation-delay:${i * 55}ms">
        <span class="pos">${r.position}</span>
        <i class="swatch" style="--h:${r.hue}"></i>
        <span class="who">${escapeHtml(r.name)}</span>
        <span class="times">
          ${
            r.dnf
              ? `<span class="dnf">DNF · ${r.laps} lap${r.laps === 1 ? "" : "s"}</span>`
              : `<div class="total">${formatMs(r.totalMs)}</div>
                 <div class="best">${
                   fastest && fastest.id === r.id ? `${icon("lightning")} ` : ""
                 }Best ${formatMs(r.bestLapMs)}</div>`
          }
        </span>
        <span></span>
      </div>`);
      list.append(row);
    });

    inner.append(panel);

    const actions = h(`<div class="row" style="margin-top:20px;gap:12px">
      <button class="btn btn--ghost" id="leave">${icon("signOut")} Leave</button>
      <div style="flex:1"></div>
      <button class="btn btn--primary" id="again">${icon("arrowClockwise")} Back to paddock</button>
    </div>`);
    actions.querySelector("#leave")!.addEventListener("click", () => this.cb.onLeave());
    const again = actions.querySelector<HTMLButtonElement>("#again")!;
    again.hidden = !this.isHost;
    again.addEventListener("click", () => this.cb.onRematch());
    if (!this.isHost) {
      actions.insertBefore(
        h(`<p class="hint" style="margin:0">Waiting for the host to reset the room…</p>`),
        again,
      );
    }
    inner.append(actions);

    this.swap(screen);
  }

  /** Hide all menus so only the HUD and the road remain. */
  enterRace() {
    this.current = "race";
    this.root.innerHTML = "";
  }

  // -------------------------------------------------------------------------

  setPlayers(players: PlayerInfo[], hostId: number, selfId: number) {
    this.players = players;
    this.hostId = hostId;
    this.selfId = selfId;
    this.paintLobby();
  }

  setConfig(config: RoomConfig) {
    this.config = config;
    this.paintLobby();
  }

  setConnection(state: string, detail?: string) {
    this.connection = { state, detail };
    this.paintLobby();
  }

  get roomConfig() {
    return this.config;
  }

  get playerList() {
    return this.players;
  }

  get unavailableHues() {
    return this.takenHues;
  }

  get screen() {
    return this.current;
  }

  private swap(next: HTMLElement) {
    this.root.innerHTML = "";
    this.root.append(next);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
