/**
 * Reusable long-press tracker for any Stream Deck action that wants to tell
 * a quick tap apart from a hold.
 *
 * The SDK only ever calls `keyDown` and `keyUp`, and neither payload carries
 * timing information — checked against the installed `@elgato/streamdeck`
 * types: no `duration`, `elapsed`, or `timestamp` field exists on either
 * event. So a hold can only be recognised by starting a timer on `down()`
 * and seeing whether it outlives the press, which is what this class does.
 */

export type PressKind = "short" | "long";

export type PressTrackerOptions = {
  /**
   * How long a hold must last before it counts as long, when a call site
   * doesn't override it per-press via `down()`'s second argument. Clamped
   * the same way a per-press value is — see `resolveThreshold`.
   */
  thresholdMs?: number;
  /**
   * Fires once, while the key is still physically held, the instant the
   * threshold elapses. Firing on release instead would make a hold feel
   * broken — nothing would happen until the user let go, defeating the
   * point of acting on a hold without waiting for it to end.
   */
  onLong: (id: string) => void;
  /** Injectable so tests can control firing without a real sleep. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

// A deliberate hold on a Stream Deck key runs well past 300ms, while an
// ordinary tap is typically under 150ms — 300 leaves comfortable headroom on
// both sides. Going much below ~200ms starts misreading ordinary taps as
// holds, and that floor exists because the cost of a false hold is not
// symmetric with a false tap: a false hold steals window focus away from
// whatever the user is doing, while a false tap merely shows the peek.
const DEFAULT_THRESHOLD_MS = 300;

// Bounds for a per-press threshold supplied by a key's settings. The floor
// mirrors the false-hold-vs-false-tap reasoning above; the ceiling keeps a
// mistyped or corrupted setting from turning "hold" into a gesture nobody
// would ever complete.
const THRESHOLD_FLOOR_MS = 200;
const THRESHOLD_CEILING_MS = 2000;

/**
 * Resolve the threshold to actually schedule against: `value` when it's a
 * sane, in-range number, `fallback` otherwise. Mirrors the defensive
 * posture `thresholdsFrom` in view.ts takes toward a bad slider value —
 * `Number.isFinite` rejects `NaN`, `Infinity`, `null`, `undefined`, and
 * non-numeric strings in one check, since none of those coerce to a usable
 * delay, and anything that does pass gets clamped into range rather than
 * trusted outright.
 */
function resolveThreshold(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(THRESHOLD_CEILING_MS, Math.max(THRESHOLD_FLOOR_MS, value as number));
}

export class PressTracker {
  private readonly thresholdMs: number;
  private readonly onLong: (id: string) => void;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  /**
   * Pending hold timers, keyed by action-context id rather than a single
   * slot, because several keys of the same action can be visible at once
   * and each holds independently.
   */
  private readonly timers = new Map<string, unknown>();
  /**
   * Ids whose hold timer already fired for the press currently in progress.
   * `up()` consults this to report "long" and to tell the caller to skip its
   * short-press behaviour — the two must never both run for one press.
   */
  private readonly fired = new Set<string>();

  constructor(opts: PressTrackerOptions) {
    this.thresholdMs = resolveThreshold(opts.thresholdMs, DEFAULT_THRESHOLD_MS);
    this.onLong = opts.onLong;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  /**
   * `thresholdMs` is resolved fresh on every call rather than read off the
   * instance, which is what makes a per-key setting possible without
   * rebuilding the tracker (and its whole `timers`/`fired` state) every time
   * a settings change lands — the old design shared one constructor-time
   * value for every id precisely to dodge that rebuild, at the cost of no
   * setting at all. Resolving per-press instead means a settings change
   * mid-hold can never corrupt an in-flight timer: the timer already
   * scheduled keeps the delay it was given, and only the *next* down() sees
   * the new value.
   */
  down(id: string, thresholdMs?: number): void {
    const ms = resolveThreshold(thresholdMs, this.thresholdMs);
    // A second down() for an id that already has a pending timer replaces it
    // rather than stacking one — the same rule the peek timer in meter.ts
    // follows for its own re-press case. Routing through cancel() also drops
    // any "fired" flag left over from a press that never reached up(), so a
    // fresh press always starts from a clean slate instead of inheriting a
    // stale "this was long" verdict.
    this.cancel(id);
    this.timers.set(
      id,
      this.setTimer(() => {
        this.timers.delete(id);
        this.fired.add(id);
        this.onLong(id);
      }, ms),
    );
  }

  /** "long" when the hold already fired for this id, otherwise "short". */
  up(id: string): PressKind {
    // The timer must never fire after release — a late fire would act on a
    // press that has already been answered by this very call.
    this.clearPendingTimer(id);
    return this.fired.delete(id) ? "long" : "short";
  }

  /** Drop any pending timer for this id — call from onWillDisappear. */
  cancel(id: string): void {
    // A timer firing after the key is gone would act on a dead action —
    // exactly the hazard meter.ts and launch.ts already document for their
    // own per-id timers.
    this.clearPendingTimer(id);
    this.fired.delete(id);
  }

  /** Drop everything. */
  cancelAll(): void {
    for (const handle of this.timers.values()) this.clearTimer(handle);
    this.timers.clear();
    // Also clears ids whose timer already fired but never reached up() —
    // those have no entry in `timers` any more but still owe a reset.
    this.fired.clear();
  }

  private clearPendingTimer(id: string): void {
    const handle = this.timers.get(id);
    if (handle === undefined) return;
    this.clearTimer(handle);
    this.timers.delete(id);
  }
}
