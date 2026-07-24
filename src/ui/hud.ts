import { formatGap, formatMs } from "../../shared/protocol";
import type { HudFrame, Stats } from "../game/game";
import { CAMERA_LABELS } from "../game/camera";
import { icon } from "./icons";

/**
 * In-race overlay.
 *
 * Built once, then mutated. Per-frame updates only ever write `textContent` on
 * leaf nodes or set a CSS custom property that feeds a `transform` — never a
 * width, never innerHTML, never a class recalculation on a container. That is
 * what keeps a DOM HUD off the critical path at 240 fps.
 */

const REV_LIGHTS = 15;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  html?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

export class Hud {
  readonly root: HTMLElement;

  private lap!: HTMLElement;
  private lapTotal!: HTMLElement;
  private pos!: HTMLElement;
  private posTotal!: HTMLElement;

  private tCur!: HTMLElement;
  private tLast!: HTMLElement;
  private tBest!: HTMLElement;
  private tDelta!: HTMLElement;

  private kph!: HTMLElement;
  private gear!: HTMLElement;
  private revs: HTMLElement[] = [];
  private rpmArc!: SVGPathElement;

  private fThr!: HTMLElement;
  private fBrk!: HTMLElement;
  private fGrip!: HTMLElement;
  private fSteer!: HTMLElement;
  private drs!: HTMLElement;

  private board!: HTMLElement;
  private boardRows: HTMLElement[] = [];

  private mapSelf!: SVGCircleElement;
  private mapOthers!: SVGGElement;
  private mapDots: SVGCircleElement[] = [];

  private countdown!: HTMLElement;
  private lights: HTMLElement[] = [];
  private toasts!: HTMLElement;
  private camChip!: HTMLElement;

  private perf!: HTMLElement;
  private perfGrid!: HTMLElement;
  private perfSpark!: SVGPolylineElement;
  private perfExpanded = false;
  private fpsHistory: number[] = [];

  private lastSpeed = -1;
  private lastGear = -999;
  private lastRev = -1;
  private lastLap = -1;
  private lastPos = -1;

  constructor(root: HTMLElement) {
    this.root = root;
    root.innerHTML = "";
    this.build();
  }

  private build() {
    const r = this.root;

    // --- top left: lap + position ----------------------------------------
    const tl = el("div", "hud__corner hud__tl");
    const lapTile = el("div", "tile lapbox");
    const lapWrap = el("div");
    lapWrap.append(el("div", "label", "Lap"));
    const lapLine = el("div", "row");
    this.lap = el("span", "big", "1");
    this.lapTotal = el("span", "small", "/3");
    lapLine.append(this.lap, this.lapTotal);
    lapWrap.append(lapLine);

    const posWrap = el("div", "pos");
    posWrap.append(el("div", "label", "Pos"));
    const posLine = el("div", "row");
    this.pos = el("span", "big", "1");
    this.posTotal = el("span", "small", "/1");
    posLine.append(this.pos, this.posTotal);
    posWrap.append(posLine);

    lapTile.append(lapWrap, el("div", "sep"), posWrap);
    tl.append(lapTile);
    r.append(tl);

    // --- top right: timing ------------------------------------------------
    const tr = el("div", "hud__corner hud__tr");
    const timing = el("div", "tile timing");
    this.tCur = el("span", "v v--cur mono", "0:00.000");
    this.tLast = el("span", "v mono", "--:--.---");
    this.tBest = el("span", "v v--best mono", "--:--.---");
    this.tDelta = el("span", "v mono", "—");
    timing.append(
      el("span", "label", "Current"),
      this.tCur,
      el("span", "label", "Last"),
      this.tLast,
      el("span", "label", "Best"),
      this.tBest,
      el("span", "label", "Delta"),
      this.tDelta,
    );

    this.board = el("div", "tile board");
    tr.append(timing, this.board);
    r.append(tr);

    // --- bottom left: telemetry ------------------------------------------
    const bl = el("div", "hud__corner hud__bl");
    const tele = el("div", "tile tele");
    const bar = (label: string, cls: string) => {
      const row = el("div", "bar");
      const track = el("div", "bar__track");
      const fill = el("i", `fill ${cls}`);
      track.append(fill);
      row.append(el("span", "label", label), track);
      tele.append(row);
      return fill;
    };
    this.fThr = bar("Thr", "fill--thr");
    this.fBrk = bar("Brk", "fill--brk");
    this.fGrip = bar("Grip", "fill--grip");
    const steerRow = el("div", "bar");
    const steerTrack = el("div", "steer");
    this.fSteer = el("i");
    steerTrack.append(this.fSteer);
    steerRow.append(el("span", "label", "Steer"), steerTrack);
    tele.append(steerRow);

    this.perf = el("div", "tile perf");
    this.perfGrid = el("div", "perf__grid");
    const spark = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    spark.setAttribute("class", "perf__spark");
    spark.setAttribute("viewBox", "0 0 60 22");
    spark.setAttribute("preserveAspectRatio", "none");
    this.perfSpark = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    this.perfSpark.setAttribute("fill", "none");
    this.perfSpark.setAttribute("stroke", "currentColor");
    this.perfSpark.setAttribute("stroke-width", "1");
    this.perfSpark.setAttribute("vector-effect", "non-scaling-stroke");
    spark.append(this.perfSpark);
    this.perf.append(this.perfGrid, spark);
    this.perf.title = "Click to expand performance counters";
    this.perf.addEventListener("click", () => {
      this.perfExpanded = !this.perfExpanded;
    });

    bl.append(tele, this.perf);
    r.append(bl);

    // --- bottom centre: speed --------------------------------------------
    const speedWrap = el("div");
    speedWrap.style.cssText =
      "position:absolute;bottom:max(18px,env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:8px";

    const revs = el("div", "revs");
    for (let i = 0; i < REV_LIGHTS; i++) {
      const light = el("i");
      if (i >= REV_LIGHTS - 4) light.classList.add("max");
      else if (i >= REV_LIGHTS - 8) light.classList.add("hi");
      this.revs.push(light);
      revs.append(light);
    }

    const speedo = el("div", "tile speedo");
    const arcHolder = el("div", "speedo__arc");
    const arcSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    arcSvg.setAttribute("viewBox", "0 0 200 60");
    arcSvg.setAttribute("preserveAspectRatio", "none");
    const arcBg = document.createElementNS("http://www.w3.org/2000/svg", "path");
    arcBg.setAttribute("d", "M6 54 L194 54");
    arcBg.setAttribute("stroke", "rgba(255,255,255,0.08)");
    arcBg.setAttribute("stroke-width", "2");
    arcBg.setAttribute("fill", "none");
    this.rpmArc = document.createElementNS("http://www.w3.org/2000/svg", "path");
    this.rpmArc.setAttribute("d", "M6 54 L194 54");
    this.rpmArc.setAttribute("stroke", "var(--accent)");
    this.rpmArc.setAttribute("stroke-width", "2");
    this.rpmArc.setAttribute("fill", "none");
    this.rpmArc.setAttribute("pathLength", "1");
    this.rpmArc.setAttribute("stroke-dasharray", "1");
    arcSvg.append(arcBg, this.rpmArc);
    arcHolder.append(arcSvg);

    this.kph = el("span", "kph", "0");
    this.gear = el("span", "gear", "N");
    speedo.append(arcHolder, this.kph, el("span", "unit", "KM/H"), this.gear);

    this.drs = el("div", "drs", "DRS");
    speedWrap.append(revs, speedo, this.drs);
    r.append(speedWrap);

    // --- bottom right: minimap -------------------------------------------
    const br = el("div", "hud__corner hud__br");
    const map = el("div", "tile minimap");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.id = "minimap-svg";
    this.mapOthers = document.createElementNS("http://www.w3.org/2000/svg", "g");
    this.mapSelf = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    this.mapSelf.setAttribute("r", "3.4");
    this.mapSelf.setAttribute("fill", "#fff");
    this.mapSelf.setAttribute("stroke", "var(--accent)");
    this.mapSelf.setAttribute("stroke-width", "2");
    svg.append(this.mapOthers, this.mapSelf);
    map.append(svg);

    this.camChip = el("div", "tile label");
    this.camChip.style.cssText = "display:flex;align-items:center;gap:6px;padding:7px 11px";
    this.camChip.innerHTML = `${icon("camera")}<span>Chase</span>`;

    br.append(this.camChip, map);
    r.append(br);

    // --- centre overlays --------------------------------------------------
    this.countdown = el("div", "countdown");
    const lights = el("div", "lights");
    for (let i = 0; i < 5; i++) {
      const light = el("i");
      this.lights.push(light);
      lights.append(light);
    }
    this.countdown.append(lights);
    this.countdown.hidden = true;
    r.append(this.countdown);

    this.toasts = el("div", "toasts");
    r.append(this.toasts);

    // --- touch controls ---------------------------------------------------
    const touch = el("div", "touch");
    touch.innerHTML = `
      <div class="touch__pad touch__l" data-touch="left">${icon("caretLeft")}</div>
      <div class="touch__pad touch__r" data-touch="right">${icon("caretRight")}</div>
      <div class="touch__pad touch__brk" data-touch="brake">${icon("minus")}</div>
      <div class="touch__pad touch__thr" data-touch="throttle">${icon("caretDown")}</div>`;
    r.append(touch);
  }

  /** Draw the circuit outline once, when the track is chosen. */
  setTrack(path: string, start: [number, number], accent: string) {
    const svg = this.root.querySelector<SVGSVGElement>("#minimap-svg");
    if (!svg) return;
    svg.querySelectorAll(".route, .route-in, .start-mark").forEach((n) => n.remove());

    const outer = document.createElementNS("http://www.w3.org/2000/svg", "path");
    outer.setAttribute("class", "route");
    outer.setAttribute("d", path);
    const inner = document.createElementNS("http://www.w3.org/2000/svg", "path");
    inner.setAttribute("class", "route-in");
    inner.setAttribute("d", path);

    const mark = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    mark.setAttribute("class", "start-mark");
    mark.setAttribute("cx", String(start[0]));
    mark.setAttribute("cy", String(start[1]));
    mark.setAttribute("r", "2.6");
    mark.setAttribute("fill", accent);

    svg.prepend(outer, inner, mark);
    this.mapSelf.setAttribute("stroke", accent);
  }

  // -------------------------------------------------------------------------

  update(f: HudFrame) {
    // Speed and gear change constantly; everything else is guarded so we only
    // touch the DOM when the displayed value actually differs.
    const kph = Math.round(f.speedKph);
    if (kph !== this.lastSpeed) {
      this.kph.textContent = String(kph);
      this.lastSpeed = kph;
    }
    if (f.gear !== this.lastGear) {
      this.gear.textContent = f.gear < 0 ? "R" : f.gear === 0 ? "N" : String(f.gear);
      this.lastGear = f.gear;
    }

    this.rpmArc.setAttribute("stroke-dashoffset", String(1 - f.rpm));
    this.rpmArc.setAttribute(
      "stroke",
      f.rpm > 0.93 ? "var(--accent)" : f.rpm > 0.78 ? "var(--warn)" : "var(--accent2)",
    );

    const lit = Math.round(f.rpm * REV_LIGHTS);
    if (lit !== this.lastRev) {
      for (let i = 0; i < REV_LIGHTS; i++) this.revs[i].classList.toggle("on", i < lit);
      this.lastRev = lit;
    }

    this.fThr.style.setProperty("--v", f.throttle.toFixed(3));
    this.fBrk.style.setProperty("--v", f.brake.toFixed(3));
    this.fGrip.style.setProperty("--v", f.grip.toFixed(3));
    // The steer bar grows from the centre in whichever direction is applied.
    const s = f.steer;
    this.fSteer.style.left = s < 0 ? "0%" : "50%";
    this.fSteer.style.transformOrigin = s < 0 ? "right center" : "left center";
    this.fSteer.style.setProperty("--v", Math.abs(s).toFixed(3));

    const drsCls = f.drs ? "drs drs--on" : f.drsAvailable ? "drs drs--avail" : "drs";
    if (this.drs.className !== drsCls) this.drs.className = drsCls;

    if (f.lap !== this.lastLap) {
      this.lap.textContent = String(f.lap);
      this.lapTotal.textContent = `/${f.totalLaps}`;
      this.lastLap = f.lap;
    }
    if (f.position !== this.lastPos) {
      this.pos.textContent = String(f.position);
      this.posTotal.textContent = `/${f.fieldSize}`;
      this.lastPos = f.position;
    }

    this.tCur.textContent = formatMs(f.lapMs);
    this.tLast.textContent = formatMs(f.lastLapMs);
    this.tBest.textContent = formatMs(f.bestLapMs);
    if (f.deltaMs == null) {
      this.tDelta.textContent = "—";
      this.tDelta.className = "v mono";
    } else {
      const d = f.deltaMs / 1000;
      this.tDelta.textContent = `${d >= 0 ? "+" : ""}${d.toFixed(3)}`;
      this.tDelta.className = `v mono ${d > 0 ? "delta--up" : "delta--down"}`;
    }

    this.updateBoard(f);
    this.updateMap(f);
    this.updateCountdown(f);

    const camLabel = CAMERA_LABELS[f.camera];
    const span = this.camChip.querySelector("span");
    if (span && span.textContent !== camLabel) span.textContent = camLabel;
  }

  private updateBoard(f: HudFrame) {
    const rows = f.order.slice(0, 8);
    // Grow the row pool as drivers join; never rebuild it.
    while (this.boardRows.length < rows.length) {
      const row = el("div", "board__row");
      row.innerHTML = `<span class="p"></span><i class="c"></i><span class="n"></span><span class="g"></span>`;
      this.boardRows.push(row);
      this.board.append(row);
    }
    for (let i = 0; i < this.boardRows.length; i++) {
      const row = this.boardRows[i];
      const d = rows[i];
      if (!d) {
        if (!row.hidden) row.hidden = true;
        continue;
      }
      if (row.hidden) row.hidden = false;
      const p = row.children[0] as HTMLElement;
      const c = row.children[1] as HTMLElement;
      const n = row.children[2] as HTMLElement;
      const g = row.children[3] as HTMLElement;
      const posText = String(i + 1);
      if (p.textContent !== posText) p.textContent = posText;
      const hue = String(d.hue);
      if (c.style.getPropertyValue("--h") !== hue) c.style.setProperty("--h", hue);
      if (n.textContent !== d.name) n.textContent = d.name;
      const gap = i === 0 ? "LEADER" : formatGap(d.gapMs);
      if (g.textContent !== gap) g.textContent = gap;
      row.classList.toggle("board__row--self", d.isSelf);
    }
  }

  private updateMap(f: HudFrame) {
    this.mapSelf.setAttribute("cx", (f.selfPoint[0] * 100).toFixed(2));
    this.mapSelf.setAttribute("cy", (f.selfPoint[1] * 100).toFixed(2));

    while (this.mapDots.length < f.others.length) {
      const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("r", "2.4");
      this.mapDots.push(dot);
      this.mapOthers.append(dot);
    }
    for (let i = 0; i < this.mapDots.length; i++) {
      const dot = this.mapDots[i];
      const o = f.others[i];
      if (!o) {
        dot.setAttribute("opacity", "0");
        continue;
      }
      dot.setAttribute("opacity", "1");
      dot.setAttribute("cx", (o.x * 100).toFixed(2));
      dot.setAttribute("cy", (o.y * 100).toFixed(2));
      dot.setAttribute("fill", `hsl(${o.hue} 82% 58%)`);
    }
  }

  private updateCountdown(f: HudFrame) {
    if (f.countdownMs == null) {
      if (!this.countdown.hidden) {
        this.countdown.hidden = true;
        this.countdown.querySelector(".countdown__go")?.remove();
      }
      return;
    }
    this.countdown.hidden = false;
    // Five lights come on one per second; they all go out together at zero,
    // which is the actual start signal in Formula 1.
    const secs = f.countdownMs / 1000;
    const litCount = Math.max(0, Math.min(5, 5 - Math.floor(secs)));
    for (let i = 0; i < 5; i++) this.lights[i].classList.toggle("on", i < litCount);
  }

  toast(text: string, best = false) {
    const t = el("div", `toast${best ? " toast--best" : ""}`, text);
    this.toasts.append(t);
    setTimeout(() => t.remove(), 2500);
  }

  lightsOut() {
    for (const l of this.lights) l.classList.remove("on");
    const go = el("div", "countdown__go", "GO");
    this.countdown.append(go);
    setTimeout(() => {
      go.remove();
      this.countdown.hidden = true;
    }, 900);
  }

  stats(s: Stats) {
    this.fpsHistory.push(s.fps);
    if (this.fpsHistory.length > 60) this.fpsHistory.shift();

    const cls = s.fps >= 100 ? "fps--good" : s.fps >= 55 ? "fps--ok" : "fps--bad";
    const rows: [string, string, string?][] = [["fps", s.fps.toFixed(0), cls]];
    if (this.perfExpanded) {
      rows.push(
        ["frame", `${s.frameMs.toFixed(2)} ms`],
        ["sim", `${s.simMs.toFixed(2)} ms`],
        ["scale", `${s.gpuScale.toFixed(2)}x`],
        ["draws", String(s.drawCalls)],
        ["tris", s.triangles > 9999 ? `${(s.triangles / 1000).toFixed(0)}k` : String(s.triangles)],
        ["parts", String(s.particles)],
        ["cars", String(s.cars)],
        ["ping", s.ping > 0 ? `${s.ping.toFixed(0)} ms` : "—"],
        ["quality", s.quality],
      );
    }
    // Rebuilding this at 4 Hz with fewer than a dozen rows is free, and it
    // keeps the expanded/collapsed transition trivial.
    this.perfGrid.innerHTML = rows
      .map(([k, v, c]) => `<span>${k}</span><b class="${c ?? ""}">${v}</b>`)
      .join("");

    if (this.perfExpanded && this.fpsHistory.length > 1) {
      const max = Math.max(120, ...this.fpsHistory);
      const pts = this.fpsHistory
        .map((v, i) => `${(i / (this.fpsHistory.length - 1)) * 60},${22 - (v / max) * 22}`)
        .join(" ");
      this.perfSpark.setAttribute("points", pts);
    } else {
      this.perfSpark.setAttribute("points", "");
    }
  }

  show() {
    this.root.hidden = false;
  }

  hide() {
    this.root.hidden = true;
  }
}
