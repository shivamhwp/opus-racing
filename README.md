# Opus Racing

A real-time multiplayer Formula 1 circuit racer that runs entirely in the
browser, behind a password, on Cloudflare Pages.

**Live:** https://opus-racing.pages.dev

---

## What it is

Up to sixteen people share a room code and race each other around one of three
circuits over any of six lap counts. The whole site sits behind a single
password held in an environment variable.

The entire game ships as **164 KB gzipped** and holds 120 fps. There are no
downloaded assets — no models, no textures, no audio files, no icon fonts. Every
car, circuit, surface and engine note is generated at load time from code.

## The interesting parts

**The sky is a function, not a cubemap.** `skyBase(vec3 direction)` in
`src/game/materials.ts` returns the colour of the sky in any direction. The
skydome calls it for the background; the car shader calls it again along the
reflection vector to get environment reflections. One function, no cubemap, no
PMREM prefilter, no render-to-texture — and reflections that stay automatically
consistent with whatever sky a circuit is set in.

**Sixteen cars, two draw calls.** The F1 car is ~1250 triangles of merged
primitives plus a lofted monocoque, built once. Every vertex carries a `paint`
id selecting one of seven surface treatments (livery, accent, carbon, titanium,
rubber, emissive, glass); the driver's colour arrives per instance. So sixteen
visually distinct cars are one `InstancedMesh`, and their 64 wheels are one
more. A complete circuit — 3.4 km of asphalt, run-off, kerbs, barriers,
hoardings, floodlights, grandstands — is 12 draw calls.

**Physics tuned to real numbers.** A yaw-rate bicycle model bounded by a
friction circle, with grip scaling by speed-squared downforce. What the tyres
spend accelerating is not available for turning, so trail-braking and
throttle-on understeer emerge rather than being scripted. Measured by the test
suite: 0–100 km/h in 2.29 s, 317 km/h (337 with DRS), 3.0 g average braking over
104 m, 5.8 g lateral at 300 km/h, 67–79 s lap times.

**Daylight, lit properly.** Every surface uses the same outdoor lighting
triple: a warm directional sun, a cool hemispherical sky term, and a bounce
term coming back up off the ground. Circuits run at different times of day —
clear midday, bright afternoon, golden hour — and because the sky is one
function, moving the sun re-lights the tarmac, the grass, the barriers and the
reflections in the bodywork all at once.

**Rendering adapts to your display.** The renderer learns the panel's real
refresh rate from the 20th percentile of observed frame times, then trades
resolution in quantised steps to hold it, compositing back up to the canvas at
full native density. Post-processing is a bright-pass, a two-level separable
bloom at 1/4 and 1/8 resolution, and a single composite pass doing ACES
tonemapping, speed streaks, chromatic aberration, vignette and grain.

**The camera keeps the car centred.** It sits directly behind the car and aims
along the car's own axis, so the car never leaves the middle of the frame.
Corner anticipation comes from a small bounded yaw lead rather than from moving
the aim point onto the track, which is what breaks framing the moment a car
runs wide.

**The HUD never triggers layout.** It is built once and then mutated. Per-frame
updates only write `textContent` on leaf nodes or set a CSS custom property that
feeds a `transform` — never a width, never `innerHTML`.

## Multiplayer

One Durable Object per room. Each client simulates its own car with the same
deterministic physics and reports the result as a 32-byte binary record; the
room batches those into 20 Hz snapshots. Remote cars render 100 ms in the past,
interpolated between two real samples, dead-reckoning only when the buffer runs
dry.

Race *control* is authoritative server-side: who is in the room, the lap count,
when the lights go out, and the finishing order. A modified client cannot start
a race early, claim an impossible lap time, skip laps, or hand itself a win.

## Security

`APP_PASSWORD` is the only secret. An unauthenticated request receives a
self-contained gate page and nothing else — not the HTML shell, not the
JavaScript, not the track data. The session cookie is signed with a key derived
from the password itself, so rotating the password invalidates every existing
session. Failed logins cost a fixed 400 ms.

The realtime layer inherits the gate rather than duplicating it: the Durable
Object lives on a Worker with no public route, reachable only through a binding
on the Pages project, and that route only runs after the middleware has verified
the session.

## Controls

| | |
|---|---|
| `W` `A` `S` `D` / arrows | drive |
| `Shift` | DRS (straights only) |
| `Space` | handbrake |
| `C` | cycle camera — chase, close, cockpit, T-cam, broadcast |
| `R` | recover to the racing line |
| `M` | mute |

Gamepads work (analogue triggers and stick), as do on-screen controls on touch
devices.

## Running it

```bash
bun install
bun run dev          # client only, on http://localhost:5173

# full stack, in two terminals:
bun run dev:rooms    # the Durable Object
bun run dev:pages    # Pages + Functions, bound to it, on :8799
```

`dev:pages` needs a password: add `--binding APP_PASSWORD=letmein`, or put it
in `.dev.vars`.

The check scripts import the app's own TypeScript directly — Bun runs it with
no build step and no loader shims.

## Tests

The graphics and physics are covered by executable checks rather than by
eyeballing screenshots. They have earned their keep — see the commit log for
three bugs they caught that were completely silent at runtime, including a
racing surface that was invisible because its triangles were wound face-down
while still reporting 120 fps.

```bash
bun run check          # tracks, physics, car model, world geometry
bun run test:protocol  # race lifecycle + server authority, over real sockets
bun run test:browser   # two real browsers racing each other
```

`check` runs offline. The other two need a running deployment; point them
anywhere with `BASE=https://… APP_PASSWORD=…`.

- **check:tracks** — every circuit is closed, non-self-intersecting, arc-length
  uniform, has drivable corner radii, and projects correctly.
- **check:physics** — acceleration, top speed, braking g, cornering g at three
  speeds, surface penalties, stability under 120 s of random input, and a
  pure-pursuit reference driver that must complete a clean lap of every circuit.
- **check:car** — the car matches F1 regulation dimensions and stays in budget.
- **check:world** — every horizontal surface actually faces the sky, nothing
  sinks below the ground plane, draw calls stay in budget.

## Deploying

```bash
bun run deploy:rooms   # the Durable Object worker
bun run deploy:pages   # build + Pages
bun run deploy         # both
```

## Setting the password

```bash
bun run password 'my-access-key'
```

That uploads the secret, redeploys, and verifies that the new key is accepted
while an empty one and a wrong one are not.

Doing it by hand has two traps worth knowing about:

- `wrangler pages secret put` reads the value from **stdin**. Run it in a
  non-interactive shell and it will cheerfully upload an *empty* secret. The app
  fails closed on that — nobody can log in, including you — but it is a
  confusing five minutes.
- Pages binds secrets at **deployment** time. Setting a secret does nothing to
  the deployment currently serving traffic until you redeploy. The dashboard
  does not make this obvious.

Rotating the password invalidates every existing session, because the cookie
signing key is derived from the password itself.

## Layout

```
src/game/     track, physics, car model, shaders, world, post, net, audio
src/ui/       HUD, menus, generated Phosphor icons
shared/       wire protocol, shared by client and server
functions/    Pages Functions: the gate, login, websocket route
server/       the RaceRoom Durable Object
scripts/      offline validation
tests/        browser and protocol tests
```

Icons are [Phosphor](https://phosphoricons.com) (MIT), inlined at build time by
`bun run icons` so nothing is fetched at runtime.
