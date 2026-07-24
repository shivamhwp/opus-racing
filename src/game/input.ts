import type { CarInput } from "./physics";

/**
 * Keyboard, gamepad and touch, unified.
 *
 * Digital keys are ramped into analogue axes — instantly snapping the rack to
 * full lock is unrecoverable at 300 km/h. The ramp is speed-aware so the car
 * stays precise on the straights and still responsive in a hairpin.
 */

const LEFT = new Set(["ArrowLeft", "KeyA"]);
const RIGHT = new Set(["ArrowRight", "KeyD"]);
const UP = new Set(["ArrowUp", "KeyW"]);
const DOWN = new Set(["ArrowDown", "KeyS"]);

export interface InputActions {
  onCamera?: () => void;
  onRespawn?: () => void;
  onPause?: () => void;
  onToggleHud?: () => void;
  onMute?: () => void;
}

export class Input {
  readonly state: CarInput = {
    throttle: 0,
    brake: 0,
    steer: 0,
    handbrake: false,
    drs: false,
  };

  /** Which device last produced input — shown in the HUD hint line. */
  device: "keyboard" | "gamepad" | "touch" = "keyboard";
  enabled = false;

  private readonly keys = new Set<string>();
  private touchSteer = 0;
  private touchThrottle = 0;
  private touchBrake = 0;
  private touchHandbrake = false;
  private gamepadIndex: number | null = null;
  private readonly actions: InputActions;
  private readonly onKeyDown: (e: KeyboardEvent) => void;
  private readonly onKeyUp: (e: KeyboardEvent) => void;
  private readonly onBlur: () => void;

  constructor(actions: InputActions = {}) {
    this.actions = actions;

    this.onKeyDown = (e) => {
      if (e.repeat) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      this.keys.add(e.code);
      this.device = "keyboard";
      switch (e.code) {
        case "KeyC":
          this.actions.onCamera?.();
          break;
        case "KeyR":
          this.actions.onRespawn?.();
          break;
        case "KeyH":
          this.actions.onToggleHud?.();
          break;
        case "KeyM":
          this.actions.onMute?.();
          break;
        case "Escape":
          this.actions.onPause?.();
          break;
      }
      // Stop the page scrolling out from under the race.
      if (
        LEFT.has(e.code) ||
        RIGHT.has(e.code) ||
        UP.has(e.code) ||
        DOWN.has(e.code) ||
        e.code === "Space"
      ) {
        if (this.enabled) e.preventDefault();
      }
    };
    this.onKeyUp = (e) => this.keys.delete(e.code);
    this.onBlur = () => {
      this.keys.clear();
      this.touchThrottle = this.touchBrake = this.touchSteer = 0;
      this.touchHandbrake = false;
    };

    window.addEventListener("keydown", this.onKeyDown, { passive: false });
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    window.addEventListener("gamepadconnected", (e) => {
      this.gamepadIndex = (e as GamepadEvent).gamepad.index;
    });
    window.addEventListener("gamepaddisconnected", () => {
      this.gamepadIndex = null;
    });
  }

  /** Wire up the on-screen controls used on touch devices. */
  bindTouch(root: HTMLElement) {
    const set = (name: string, down: boolean) => {
      this.device = "touch";
      if (name === "left") this.touchSteer = down ? -1 : this.touchSteer === -1 ? 0 : this.touchSteer;
      else if (name === "right") this.touchSteer = down ? 1 : this.touchSteer === 1 ? 0 : this.touchSteer;
      else if (name === "throttle") this.touchThrottle = down ? 1 : 0;
      else if (name === "brake") this.touchBrake = down ? 1 : 0;
      else if (name === "handbrake") this.touchHandbrake = down;
    };
    for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-touch]"))) {
      const name = el.dataset.touch!;
      const start = (e: Event) => {
        e.preventDefault();
        el.classList.add("is-down");
        set(name, true);
      };
      const end = (e: Event) => {
        e.preventDefault();
        el.classList.remove("is-down");
        set(name, false);
      };
      el.addEventListener("pointerdown", start);
      el.addEventListener("pointerup", end);
      el.addEventListener("pointercancel", end);
      el.addEventListener("pointerleave", end);
    }
  }

  private pollGamepad(): Gamepad | null {
    if (!navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    if (this.gamepadIndex != null) {
      const p = pads[this.gamepadIndex];
      if (p?.connected) return p;
    }
    for (const p of pads) if (p?.connected) return p;
    return null;
  }

  update(dt: number, speedNorm: number) {
    const s = this.state;
    if (!this.enabled) {
      s.throttle = s.brake = s.steer = 0;
      s.handbrake = s.drs = false;
      return;
    }

    const pad = this.pollGamepad();
    let steerTarget = 0;
    let throttle = 0;
    let brake = 0;
    let handbrake = false;
    let drs = false;
    let analogue = false;

    if (pad) {
      const ax = pad.axes[0] ?? 0;
      const dead = 0.12;
      const padSteer = Math.abs(ax) < dead ? 0 : (ax - Math.sign(ax) * dead) / (1 - dead);
      const rt = pad.buttons[7]?.value ?? 0;
      const lt = pad.buttons[6]?.value ?? 0;
      if (Math.abs(padSteer) > 0.01 || rt > 0.02 || lt > 0.02) {
        this.device = "gamepad";
        analogue = true;
        steerTarget = padSteer;
        throttle = rt;
        brake = lt;
      }
      handbrake = pad.buttons[0]?.pressed ?? false;
      drs = (pad.buttons[1]?.pressed ?? false) || (pad.buttons[5]?.pressed ?? false);
      if (pad.buttons[3]?.pressed) this.actions.onCamera?.();
    }

    if (!analogue) {
      const k = this.keys;
      let kx = 0;
      for (const c of LEFT) if (k.has(c)) kx -= 1;
      for (const c of RIGHT) if (k.has(c)) kx += 1;
      let kt = 0;
      for (const c of UP) if (k.has(c)) kt = 1;
      let kb = 0;
      for (const c of DOWN) if (k.has(c)) kb = 1;

      if (kx || kt || kb || this.touchSteer || this.touchThrottle || this.touchBrake) {
        steerTarget = kx || this.touchSteer;
        throttle = Math.max(kt, this.touchThrottle);
        brake = Math.max(kb, this.touchBrake);
      }
      handbrake = handbrake || k.has("Space") || this.touchHandbrake;
      drs = drs || k.has("ShiftLeft") || k.has("ShiftRight");
    }

    if (analogue) {
      s.steer = steerTarget;
    } else {
      // Digital input: accelerate the rack toward the target, and centre it
      // faster than it turns. Both rates fall off with speed so high-speed
      // corrections stay delicate.
      const speedScale = 1 / (1 + speedNorm * 2.1);
      const turnRate = 3.6 * speedScale + 1.2;
      const centreRate = 7.5;
      const diff = steerTarget - s.steer;
      const rate = steerTarget === 0 || Math.sign(steerTarget) !== Math.sign(s.steer) ? centreRate : turnRate;
      const step = rate * dt;
      s.steer += Math.abs(diff) <= step ? diff : Math.sign(diff) * step;
      s.steer = Math.max(-1, Math.min(1, s.steer));
    }

    s.throttle = throttle;
    s.brake = brake;
    s.handbrake = handbrake;
    s.drs = drs;
  }

  dispose() {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
  }
}
