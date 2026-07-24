import "./styles.css";
import { formatMs, type PlayerInfo, type RaceStatus } from "../shared/protocol";
import { Game, type Quality } from "./game/game";
import { getTrackDef } from "./game/track";
import { Hud } from "./ui/hud";
import { icon } from "./ui/icons";
import { loadProfile, saveProfile, Screens, type Profile } from "./ui/screens";

/**
 * Application shell: owns the screen state machine and translates room events
 * into game state. The renderer starts before anything else and never stops —
 * the menus are drawn over a live circuit, so there is no loading screen
 * between browsing and racing.
 */

const canvas = document.querySelector<HTMLCanvasElement>("#stage")!;
const uiRoot = document.querySelector<HTMLElement>("#ui")!;
const hudRoot = document.querySelector<HTMLElement>("#hud")!;

showBoot();

if (!supportsWebGL2()) {
  fatal(
    "This browser cannot create a WebGL2 context.",
    "Opus Racing needs WebGL2. Try a current version of Chrome, Edge, Firefox or Safari, and make sure hardware acceleration is enabled.",
  );
} else {
  void boot();
}

async function boot() {
  const profile = loadProfile();

  const hud = new Hud(hudRoot);
  let game: Game;

  // --- state ---------------------------------------------------------------
  let players: PlayerInfo[] = [];
  let joined = false;

  const screens = new Screens(
    uiRoot,
    {
      onJoin: (p) => join(p),
      onLeave: () => leave(),
      onReady: (r) => game.net.send({ t: "ready", ready: r }),
      onConfig: (patch) => game.net.send({ t: "config", ...patch }),
      onStart: () => game.net.send({ t: "start" }),
      onRematch: () => game.net.send({ t: "reset" }),
      onQuality: (q: Quality) => {
        game.setQuality(q);
        profile.quality = q;
        saveProfile(profile);
      },
      onTrackPreview: (trackId) => {
        // Only preview from the lobby, and never mid-race.
        if (screens.screen === "lobby" && !game.racing) previewTrack(trackId);
      },
    },
    profile,
  );

  game = new Game(canvas, {
    onHud: (f) => hud.update(f),
    onStats: (s) => hud.stats(s),
    onLap: (lap, ms, best) => {
      hud.toast(`Lap ${lap} · ${formatMs(ms)}`, best);
    },
    onFinish: (total) => {
      hud.toast(`Finished · ${formatMs(total)}`, true);
    },
    onCameraChange: () => {
      /* the HUD picks this up from the next frame */
    },
  });

  game.setQuality(profile.quality);
  game.loadTrack("vermilion");
  applyAccent(getTrackDef("vermilion").accent);
  game.startAttract();
  game.start();

  window.addEventListener("resize", () => game.resize(), { passive: true });
  // Some mobile browsers change the viewport without firing `resize`.
  window.visualViewport?.addEventListener("resize", () => game.resize(), { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) game.audio.suspend();
  });

  if (matchMedia("(pointer: coarse)").matches) {
    document.body.classList.add("is-touch");
    game.input.bindTouch(hudRoot);
  }

  // --- room wiring ---------------------------------------------------------
  game.net.setHandlers({
      onWelcome: (m: { id: number; hostId: number }) => {
        joined = true;
        screens.setPlayers(players, m.hostId, m.id);
      },
      onPlayers: (list: PlayerInfo[], hostId: number) => {
        players = list;
        screens.setPlayers(list, hostId, game.net.selfId);
        game.setDrivers(list.map((p) => ({ id: p.id, name: p.name, hue: p.hue })));
        pruneRemotes(list);
      },
      onConfig: (config: { laps: number; trackId: string }) => {
        screens.setConfig(config);
        if (!game.racing) previewTrack(config.trackId);
      },
      onCountdown: (atLocalMs: number) => {
        beginRace(atLocalMs);
      },
      onStatus: (s: RaceStatus) => {
        if (s === "racing" && screens.screen !== "race") {
          // Joined a race already in progress: drop straight in.
          beginRace(Date.now());
        }
      },
      onResults: (rows: Parameters<typeof screens.showResults>[0]) => {
        game.stop();
        hud.hide();
        game.startAttract();
        game.start();
        screens.showResults(rows);
      },
      onReset: (config: { laps: number; trackId: string }) => {
        hud.hide();
        game.startAttract();
        screens.setConfig(config);
        screens.showLobby();
      },
      onStatusChange: (s: string, detail?: string) => {
        screens.setConnection(s, detail);
        if (s === "closed" && joined && screens.screen === "menu") {
          screens.showMenu(detail ?? "Lost connection to the room.");
        }
      },
  });

  function pruneRemotes(list: PlayerInfo[]) {
    const ids = new Set(list.map((p) => p.id));
    for (const id of [...game.net.remotes.keys()]) {
      if (!ids.has(id)) game.net.dropRemote(id);
    }
  }

  function previewTrack(trackId: string) {
    const def = getTrackDef(trackId);
    if (game.trackRef?.def.id === def.id) return;
    game.loadTrack(trackId);
    applyAccent(def.accent);
    hud.setTrack(game.minimapPath(), game.minimapStart(), hexOf(def.accent));
    if (!game.racing) game.startAttract();
  }

  function join(p: Profile) {
    saveProfile(p);
    screens.showLobby();
    screens.setConnection("connecting");
    game.net.connect(p.room, p.name, p.hue);
  }

  function leave() {
    joined = false;
    game.net.disconnect();
    game.stopAttract();
    game.startAttract();
    hud.hide();
    screens.showMenu();
  }

  function beginRace(atLocalMs: number) {
    const config = screens.roomConfig;
    previewTrack(config.trackId);
    hud.setTrack(
      game.minimapPath(),
      game.minimapStart(),
      hexOf(getTrackDef(config.trackId).accent),
    );

    const slot = Math.max(
      0,
      players.findIndex((p) => p.id === game.net.selfId),
    );
    game.stopAttract();
    game.prepareGrid(slot, config.laps);
    game.beginCountdown(atLocalMs);
    screens.enterRace();
    hud.show();
    // Audio can only start from a gesture; joining the race was one.
    void game.audio.start();
    // Fire the "GO" flourish exactly when the lights go out.
    const delay = Math.max(0, atLocalMs - Date.now());
    window.setTimeout(() => hud.lightsOut(), delay);
  }

  screens.showMenu();
  hideBoot();
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

function applyAccent(accent: number) {
  document.documentElement.style.setProperty("--accent", hexOf(accent));
}

function hexOf(n: number): string {
  return `#${n.toString(16).padStart(6, "0")}`;
}

function supportsWebGL2(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!c.getContext("webgl2");
  } catch {
    return false;
  }
}

function showBoot() {
  const boot = document.createElement("div");
  boot.className = "boot";
  boot.id = "boot";
  boot.innerHTML = `<div class="boot__inner">
      <div class="label" style="letter-spacing:.4em;font-size:11px">OPUS RACING</div>
      <div class="boot__bar"><i></i></div>
    </div>`;
  document.body.append(boot);
}

function hideBoot() {
  const boot = document.querySelector("#boot");
  if (!boot) return;
  boot.classList.add("boot--gone");
  setTimeout(() => boot.remove(), 600);
}

function fatal(title: string, detail: string) {
  hideBoot();
  uiRoot.innerHTML = `<div class="screen"><div class="screen__inner" style="max-width:520px">
      <div class="panel card">
        <h2>${icon("warning")} ${title}</h2>
        <p class="hint">${detail}</p>
      </div>
    </div></div>`;
}
