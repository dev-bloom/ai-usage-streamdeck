import { recordSample, type Sample } from "./burn.js";
import { claudeProvider, codexProvider, type Provider } from "./providers/index.js";
import { UsageError, type UsageFailure, type UsageSnapshot } from "./usage.js";

export type StoreState =
  | { status: "loading" }
  | { status: "ok"; snapshot: UsageSnapshot; history?: Sample[] }
  | { status: "fail"; failure: UsageFailure; lastGood?: UsageSnapshot; history?: Sample[] };

type Subscriber = (state: StoreState) => void;

/**
 * How often the store wakes up. Each tick re-notifies subscribers so
 * countdowns stay live, and triggers a network fetch only once the
 * configured poll interval has actually elapsed.
 */
const TICK_MS = 15_000;

const MIN_INTERVAL_SECONDS = 15;
const MAX_INTERVAL_SECONDS = 3600;

/**
 * A single shared poller behind every key of one provider.
 *
 * Two keys showing session and weekly usage for the same provider should
 * cost one fetch, not two, so instances subscribe here rather than each
 * running their own timer. The timer only runs while at least one key is on
 * screen — Stream Deck profiles switch constantly, and a plugin that keeps
 * polling for a key nobody can see is wasteful, and for Claude specifically
 * (whose probe counts as activity) quietly misleading about your session
 * window.
 *
 * Parameterised by Provider, one instance per provider (see claudeStore /
 * codexStore below), so the two poll completely independently: a Codex
 * outage or a signed-out Codex CLI can never blank a Claude key, and vice
 * versa.
 */
export class UsageStore {
  /** Exposed so an action can read provider-specific copy (see signInHint in view.ts). */
  readonly provider: Provider;
  private subscribers = new Set<Subscriber>();
  private timer: NodeJS.Timeout | undefined;
  private state: StoreState = { status: "loading" };
  private lastFetchAt = 0;
  private inFlight: Promise<void> | undefined;
  private history: Sample[] = [];

  private intervalSeconds = 60;
  private allowRefresh = false;

  /**
   * The most recently logged failure message, so a failure that repeats
   * every poll is written once, not once per tick. Cleared on the next
   * successful fetch so a *recurrence* of the same message after a recovery
   * is logged again rather than staying silenced forever.
   */
  private lastLoggedFailureMessage: string | undefined;

  /**
   * Called at most once per distinct failure message (see
   * `lastLoggedFailureMessage`). Optional and settable after construction —
   * left unset, failures are simply never logged, which is what every
   * existing unit test against UsageStore expects.
   *
   * store.ts stays free of Stream Deck imports on purpose (see the class
   * comment above) so it can be unit-tested directly; wiring this from
   * meter.ts, which already imports the SDK for `streamDeck.logger`, is what
   * lets the actual logging live behind that import instead of one being
   * added here. Doing it here rather than in each subscriber's callback in
   * meter.ts also gets cross-key dedupe for free: doFetch runs once per
   * shared store no matter how many keys are subscribed, so this fires once
   * per failure regardless of how many keys of that provider are on screen.
   */
  onFailure: ((failure: UsageFailure) => void) | undefined;

  constructor(provider: Provider) {
    this.provider = provider;
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    fn(this.state);

    if (this.timer === undefined) {
      this.timer = setInterval(() => void this.tick(), TICK_MS);
      // Don't hold the event loop open on our account; the Stream Deck
      // websocket is what keeps this process alive.
      this.timer.unref?.();
      void this.tick();
    }

    return () => {
      this.subscribers.delete(fn);
      if (this.subscribers.size === 0 && this.timer !== undefined) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    };
  }

  /**
   * Apply settings from a key. With several keys on screen the shortest
   * requested interval wins, and auto-refresh is enabled if any key asks for
   * it — both keys share one poller, so the more eager setting has to be the
   * one that takes effect.
   */
  configure(intervalSeconds: number | undefined, allowRefresh: boolean | undefined): void {
    const requested = clampInterval(intervalSeconds);
    if (requested < this.intervalSeconds) this.intervalSeconds = requested;
    if (allowRefresh) this.allowRefresh = true;
  }

  /** Reset config aggregation, then let visible keys re-apply theirs. */
  resetConfig(): void {
    this.intervalSeconds = MAX_INTERVAL_SECONDS;
    this.allowRefresh = false;
  }

  /** Force a fetch on the next tick regardless of the interval. */
  refreshNow(): void {
    this.lastFetchAt = 0;
    void this.tick();
  }

  private async tick(): Promise<void> {
    const due = Date.now() - this.lastFetchAt >= this.intervalSeconds * 1000;
    if (due && this.inFlight === undefined) {
      this.inFlight = this.doFetch().finally(() => {
        this.inFlight = undefined;
      });
      await this.inFlight;
    } else {
      // Not due for a network call, but subscribers still want a repaint so
      // the "resets in" countdown ticks down between fetches.
      this.emit();
    }
  }

  private async doFetch(): Promise<void> {
    this.lastFetchAt = Date.now();
    try {
      const snapshot = await this.provider.fetchUsage({ allowRefresh: this.allowRefresh });
      // Only a successful probe observed anything worth recording — a failed
      // one tells us nothing about the trend, so it must not be sampled.
      this.history = recordSample(this.history, snapshot, snapshot.fetchedAt.getTime());
      this.state = { status: "ok", snapshot, history: this.history };
      // Re-arm logging: a failure that shows up again after a recovery is a
      // new thing to know about, not a continuation of the last one.
      this.lastLoggedFailureMessage = undefined;
    } catch (e) {
      const failure: UsageFailure =
        e instanceof UsageError
          ? e.failure
          : { kind: "error", message: (e as Error).message ?? "unknown error" };
      // Keep the last good snapshot around: a transient network blip should
      // dim the key, not blank out numbers the user was mid-glance at.
      const lastGood = this.state.status === "ok" ? this.state.snapshot
        : this.state.status === "fail" ? this.state.lastGood
        : undefined;
      this.state = { status: "fail", failure, lastGood, history: this.history };
      // One store instance is shared by every visible key of this provider
      // (see the class comment), so this runs once per failure no matter how
      // many keys are subscribed — logging here, rather than per-subscriber
      // in meter.ts, is what keeps two keys from writing the same line twice.
      if (failure.message !== this.lastLoggedFailureMessage) {
        this.lastLoggedFailureMessage = failure.message;
        this.onFailure?.(failure);
      }
    }
    this.emit();
  }

  private emit(): void {
    for (const fn of this.subscribers) {
      try {
        fn(this.state);
      } catch {
        // A throwing subscriber must not stop the others from repainting.
      }
    }
  }
}

function clampInterval(seconds: number | undefined): number {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return 60;
  return Math.max(MIN_INTERVAL_SECONDS, Math.min(MAX_INTERVAL_SECONDS, Math.round(seconds)));
}

export const claudeStore = new UsageStore(claudeProvider);
export const codexStore = new UsageStore(codexProvider);
