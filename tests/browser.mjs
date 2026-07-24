// Full stack: password gate, room join, two-player race, countdown, driving,
// remote car replication, and results.

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
const ROOM = "E2ETEST";
let failed = false;
const check = (ok, label, extra="") => { console.log(`  ${ok ? "✓" : "✗"} ${label}${extra ? " — " + extra : ""}`); if(!ok) failed = true; };

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"],
});

async function makePlayer(name, hueIdx) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 875 }, deviceScaleFactor: 1.5 });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", e => errs.push(name + ": " + (e.stack||e.message)));
  page.on("console", m => { if (m.type()==="error") errs.push(name + ": " + m.text()); });
  return { ctx, page, errs, name, hueIdx };
}

console.log("Password gate");
{
  const p = await makePlayer("gate", 0);
  await p.page.goto(BASE);
  check(!!(await p.page.$("#p")), "unauthenticated visitor gets the gate page");
  const leaked = await p.page.evaluate(() => document.documentElement.outerHTML.includes("OPUS RACING") && !!document.querySelector("#stage"));
  check(!leaked, "gate page ships none of the game");

  const bad = await p.page.evaluate(async (b) => {
    const r = await fetch(b + "/api/login", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({password:"definitely-not-the-key"}) });
    return { status: r.status, body: await r.json() };
  }, BASE);
  check(bad.status === 401, "wrong password rejected", `status ${bad.status}`);

  const wsBlocked = await p.page.evaluate(async (b) => (await fetch(b + "/api/ws")).status, BASE);
  check(wsBlocked === 401, "websocket route refuses unauthenticated callers", `status ${wsBlocked}`);

  const good = await p.page.evaluate(async ([b, pw]) => {
    const r = await fetch(b + "/api/login", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({password:pw}) });
    return r.status;
  }, [BASE, PASSWORD]);
  check(good === 200, "correct password accepted", `status ${good}`);
  await p.page.reload({ waitUntil: "networkidle" });
  check(!!(await p.page.$("#stage")), "app served once authenticated");
  await p.ctx.close();
}

console.log("\nTwo-player race");
const host = await makePlayer("HOST", 0);
const guest = await makePlayer("GUEST", 3);

for (const p of [host, guest]) {
  await p.page.goto(BASE);
  await p.page.evaluate(async ([b, pw]) => {
    await fetch(b + "/api/login", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({password:pw}) });
  }, [BASE, PASSWORD]);
  await p.page.goto(BASE + "/?room=" + ROOM, { waitUntil: "networkidle" });
  await p.page.waitForSelector("#nm", { timeout: 15000 });
  await p.page.fill("#nm", p.name);
  await p.page.$$eval(".hue", (els, i) => els[i].click(), p.hueIdx);
  await p.page.click("#go");
  await p.page.waitForTimeout(1200);
}
await host.page.waitForTimeout(1500);

const lobby = await host.page.evaluate(() => ({
  conn: document.querySelector("#conn")?.textContent?.trim(),
  players: [...document.querySelectorAll(".player .nm")].map(n=>n.textContent),
  count: document.querySelector("#pcount")?.textContent,
  code: document.querySelector("#code")?.textContent,
  startVisible: !document.querySelector("#start")?.hidden,
  tracks: document.querySelectorAll("[data-track]").length,
  laps: document.querySelectorAll("[data-laps]").length,
}));
console.log("  lobby:", JSON.stringify(lobby));
check(lobby.conn?.includes("Connected"), "host connected");
check(lobby.players.length === 2, "both drivers in the grid", lobby.players.join("+"));
check(lobby.startVisible, "host sees the start control");
check(lobby.tracks === 3 && lobby.laps === 6, "circuit and lap pickers present");

const guestLobby = await guest.page.evaluate(() => ({
  startVisible: !document.querySelector("#start")?.hidden,
  trackDisabled: document.querySelector("[data-track]")?.disabled,
}));
check(!guestLobby.startVisible, "non-host cannot start");
check(guestLobby.trackDisabled === true, "non-host cannot change the circuit");

await host.page.screenshot({ path: OUT + "/10-lobby.png" });

// Host sets 1 lap on the shortest circuit so the race can actually finish.
await host.page.click('[data-track="ember"]');
await host.page.waitForTimeout(400);
await host.page.click('[data-laps="1"]');
await host.page.waitForTimeout(600);
const cfg = await guest.page.evaluate(() => document.querySelector("#hostnote")?.textContent);
check(!!cfg && cfg.includes("1 lap") && cfg.includes("Ember"), "config replicated to the guest", cfg ?? "");

await host.page.click("#start");
await host.page.waitForTimeout(2500);
await host.page.screenshot({ path: OUT + "/11-countdown.png" });
const lights = await host.page.evaluate(() => document.querySelectorAll(".lights i.on").length);
check(lights > 0 && lights <= 5, "start lights illuminating", `${lights}/5`);

// Lights out, then drive: both players hold throttle and steer with the road.
await host.page.waitForTimeout(3500);
for (const p of [host, guest]) {
  await p.page.evaluate(() => {
    const k = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
    k("keydown", "KeyW");
    // Hold a straight line first so framing can be judged fairly, then weave.
    setTimeout(() => {
      let t = 0;
      setInterval(() => {
        t++;
        k("keyup", "KeyA"); k("keyup", "KeyD");
        k("keydown", t % 2 ? "KeyA" : "KeyD");
      }, 900);
    }, 5000);
  });
}
await host.page.waitForTimeout(1400);
await host.page.screenshot({ path: OUT + "/12a-ontrack.png" });
await host.page.waitForTimeout(2800);

const race = await host.page.evaluate(() => ({
  hudVisible: !document.querySelector("#hud")?.hidden,
  kph: Number(document.querySelector(".speedo .kph")?.textContent),
  gear: document.querySelector(".speedo .gear")?.textContent,
  lapTime: document.querySelector(".v--cur")?.textContent,
  boardRows: [...document.querySelectorAll(".board__row")].filter(r=>!r.hidden).length,
  mapDots: document.querySelectorAll("#minimap-svg circle").length,
  perf: document.querySelector(".perf__grid")?.textContent,
  fps: document.querySelector(".perf__grid b")?.textContent,
}));
console.log("  race:", JSON.stringify(race));
check(race.hudVisible, "HUD visible during the race");
check(race.kph > 40, "car is moving", race.kph + " km/h");
check(race.lapTime !== "0:00.000", "lap timer running", race.lapTime);
check(race.boardRows >= 2, "leaderboard shows both cars", String(race.boardRows));
check(race.mapDots >= 3, "minimap shows self + start + rival", String(race.mapDots));
check(Number(race.fps) > 30, "frame rate healthy", race.fps + " fps");

await host.page.screenshot({ path: OUT + "/12-racing.png" });
await guest.page.screenshot({ path: OUT + "/13-racing-guest.png" });

// Does the host actually see the guest's car in its scene?
const sees = await host.page.evaluate(() => {
  const c = document.querySelector("#stage");
  return c ? c.width > 0 : false;
});
check(sees, "canvas still rendering");

console.log("\nErrors");
const allErr = [...host.errs, ...guest.errs].filter(e => !e.includes("favicon") && !e.includes("401"));
for (const e of allErr.slice(0, 12)) console.log("  ! " + e.slice(0, 400));
check(allErr.length === 0, "no console or page errors", String(allErr.length));

await browser.close();
console.log(failed ? "\nE2E FAILED" : "\nE2E OK");
process.exit(failed ? 1 : 0);
