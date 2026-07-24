// Exercises the Durable Object's race lifecycle and its authority rules
// directly over the wire, from inside an authenticated page so the session
// cookie applies. Much faster than driving 70 seconds of real laps, and it can
// probe the cheating paths a well-behaved client never takes.

import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

/**
 * Chrome is driven rather than bundled: playwright-core is a few megabytes and
 * uses whatever browser is already installed. Override with CHROME=/path/to/bin.
 */
const CHROME =
  process.env.CHROME ??
  (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "/usr/bin/google-chrome");
const BASE = process.env.BASE ?? "http://localhost:8799";
const PASSWORD = process.env.APP_PASSWORD ?? "letmein";
const OUT = process.env.SHOTS ?? "tests/screenshots";
mkdirSync(OUT, { recursive: true });
let failed = false;
const check = (ok, label, extra = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${extra ? " — " + extra : ""}`);
  if (!ok) failed = true;
};

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
});
const page = await browser.newPage();
await page.goto(BASE);
await page.evaluate(async ([b, pw]) => {
  await fetch(b + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw }) });
}, [BASE, PASSWORD]);
await page.goto(BASE, { waitUntil: "domcontentloaded" });

const result = await page.evaluate(async () => {
  const ROOM = "PROTO" + Math.floor(Math.random() * 100000);
  const log = [];

  function open(name) {
    return new Promise((res, rej) => {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}/api/ws?room=${ROOM}&name=${name}`);
      ws.binaryType = "arraybuffer";
      ws.msgs = [];
      ws.onmessage = (e) => { if (typeof e.data === "string") ws.msgs.push(JSON.parse(e.data)); };
      ws.onopen = () => res(ws);
      ws.onerror = () => rej(new Error("ws error"));
      setTimeout(() => rej(new Error("ws timeout")), 8000);
    });
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const last = (ws, t) => [...ws.msgs].reverse().find((m) => m.t === t);
  const send = (ws, o) => ws.send(JSON.stringify(o));

  const a = await open("ALPHA");
  const b = await open("BRAVO");
  await wait(400);

  const welcomeA = last(a, "welcome");
  const welcomeB = last(b, "welcome");
  log.push(["two clients get distinct ids", welcomeA.id !== welcomeB.id, `${welcomeA.id} vs ${welcomeB.id}`]);
  log.push(["first client is host", welcomeA.hostId === welcomeA.id, String(welcomeA.hostId)]);
  log.push(["distinct liveries assigned",
    last(a, "players").players[0].hue !== last(a, "players").players[1].hue, ""]);

  // Authority: the non-host must not be able to reconfigure or start.
  send(b, { t: "config", laps: 12 });
  send(b, { t: "start" });
  await wait(300);
  log.push(["non-host cannot change laps", (last(a, "config")?.config.laps ?? 3) !== 12, ""]);
  log.push(["non-host cannot start", last(a, "countdown") === undefined, ""]);

  // Host configures and starts.
  send(a, { t: "config", laps: 1, trackId: "ember" });
  await wait(200);
  const cfg = last(a, "config").config;
  log.push(["host set 1 lap of ember", cfg.laps === 1 && cfg.trackId === "ember", JSON.stringify(cfg)]);

  send(a, { t: "config", laps: 999 });
  await wait(200);
  log.push(["absurd lap count rejected", last(a, "config").config.laps === 1, ""]);

  send(a, { t: "start" });
  await wait(300);
  const cd = last(a, "countdown");
  log.push(["countdown broadcast with a future start", !!cd && cd.startsAt > Date.now(), ""]);

  // Wait for lights out.
  await wait(5600);
  log.push(["room entered racing", last(a, "status")?.status === "racing", last(a, "status")?.status ?? "none"]);

  // A physically impossible lap must be refused.
  send(a, { t: "lap", lap: 1, lapMs: 500, totalMs: 500 });
  await wait(250);
  let players = last(a, "players").players;
  log.push(["impossibly fast lap rejected", players.every((p) => p.lap === 0), JSON.stringify(players.map(p=>p.lap))]);

  // A lap that skips ahead must be refused.
  send(a, { t: "lap", lap: 5, lapMs: 70000, totalMs: 70000 });
  await wait(250);
  players = last(a, "players").players;
  log.push(["out-of-order lap rejected", players.every((p) => p.lap === 0), ""]);

  // Legitimate laps.
  send(a, { t: "lap", lap: 1, lapMs: 68000, totalMs: 68000 });
  send(b, { t: "lap", lap: 1, lapMs: 71000, totalMs: 71000 });
  await wait(300);
  players = last(a, "players").players;
  log.push(["valid laps recorded", players.every((p) => p.lap === 1), JSON.stringify(players.map(p=>p.lap))]);

  // Finishing: A first, then B. Order must follow arrival, not reported time.
  send(a, { t: "finish", totalMs: 68000, bestLapMs: 68000 });
  await wait(250);
  send(b, { t: "finish", totalMs: 71000, bestLapMs: 71000 });
  await wait(500);

  const res = last(a, "results");
  log.push(["results broadcast once everyone finished", !!res, ""]);
  if (res) {
    const rows = res.results;
    log.push(["two classified", rows.length === 2, String(rows.length)]);
    log.push(["winner is the first to cross", rows[0].name === "ALPHA", rows[0].name]);
    log.push(["positions are 1..n", rows[0].position === 1 && rows[1].position === 2, ""]);
    log.push(["total times preserved", rows[0].totalMs === 68000 && rows[1].totalMs === 71000, ""]);
    log.push(["best laps preserved", rows[0].bestLapMs === 68000, String(rows[0].bestLapMs)]);
    log.push(["nobody marked DNF", rows.every((r) => !r.dnf), ""]);
  }

  // Reset returns the room to the lobby with timing cleared.
  send(a, { t: "reset" });
  await wait(400);
  log.push(["reset returns to lobby", !!last(a, "reset"), ""]);
  const after = last(a, "players").players;
  log.push(["timing cleared on reset",
    after.every((p) => p.lap === 0 && p.totalMs === null && !p.finished), ""]);

  // Host migration when the host leaves.
  a.close();
  await wait(600);
  const migrated = last(b, "players");
  log.push(["host migrates when host leaves", migrated.hostId === welcomeB.id, `${migrated.hostId} vs ${welcomeB.id}`]);
  log.push(["departed driver removed", migrated.players.length === 1, String(migrated.players.length)]);

  b.close();
  return log;
});

console.log("Race room protocol");
for (const [label, ok, extra] of result) check(ok, label, extra);
await browser.close();
console.log(failed ? "\nPROTOCOL FAILED" : "\nProtocol OK");
process.exit(failed ? 1 : 0);
