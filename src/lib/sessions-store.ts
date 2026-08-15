import { readSessions, type SessionsProblem, type SessionsState } from "./sessions.js";

type Subscriber = (state: SessionsState) => void;
type Reader = () => Promise<SessionsState>;

/**
 * How often the store re-reads the registry. Fixed, unlike UsageStore's
 * configurable per-key interval — there is no network quota to conserve
 * here, only a `ps` call cached ~10s inside sessions.ts, so nothing is
 * gained by letting a key ask for a slower poll.
 */
const POLL_MS = 3_000;

/**
 * A single shared poller behind every key that shows running-sessions data,
 * the same reason UsageStore is shared per provider: two keys on screen
 * should cost one `readSessions()` call, not two.
 *
 * Sibling of UsageStore, not a generalisation of it — see the two
 * divergences documented on `state` and `consecutiveNoRegistry` below.
 */
export class SessionsStore {
  private subscribers = new Set<Subscriber>();
  private timer: NodeJS.Timeout | undefined;

  /**
   * Divergence #1 from UsageStore: no `lastGood` carried into the fail
   * state. UsageStore keeps stale numbers through a blip because "stale
   * data beats none" for a usage percentage. For liveness that's backwards:
   * showing "2 waiting" after the registry has become unreadable is a lie,
   * worse than showing nothing — so SessionsState's fail variant has no
   * field to put one in, and this store doesn't invent one.
   */
  private state: SessionsState = { status: "loading" };

  private inFlight: Promise<void> | undefined;
  private readonly reader: Reader;

  /**
   * Divergence #2: a `no-registry` verdict only ever gets published after
   * two consecutive reads agree. A single read reporting it is exactly what
   * a session that started 200ms before this poll (and hasn't written its
   * file yet) looks like — corroborationVerdict's zero-overlap rule already
   * guards against one straggler pid, but this guards the same flake at the
   * level of an entire read attempt.
   */
  private consecutiveNoRegistry = 0;

  /** Dedupe by message, exactly like UsageStore's onFailure — see there for why. */
  private lastLoggedProblemMessage: string | undefined;

  /**
   * Called at most once per distinct problem message. Left unset, problems
   * are simply never logged — sessions-store.ts stays free of any
   * @elgato/streamdeck import so it can be unit-tested directly; the actual
   * `streamDeck.logger` call lives wherever this is wired up, the same
   * split store.ts uses for onFailure.
   */
  onProblem: ((problem: SessionsProblem) => void) | undefined;

  constructor(reader: Reader = readSessions) {
    this.reader = reader;
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    fn(this.state);

    if (this.timer === undefined) {
      this.timer = setInterval(() => void this.poll(), POLL_MS);
      // Don't hold the event loop open on our account; the Stream Deck
      // websocket is what keeps this process alive.
      this.timer.unref?.();
      void this.poll();
    }

    return () => {
      this.subscribers.delete(fn);
      if (this.subscribers.size === 0 && this.timer !== undefined) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    };
  }

  /** Force a read on the next tick regardless of POLL_MS. */
  refreshNow(): void {
    void this.poll();
  }

  private async poll(): Promise<void> {
    if (this.inFlight !== undefined) return;
    this.inFlight = this.doPoll().finally(() => {
      this.inFlight = undefined;
    });
    await this.inFlight;
  }

  private async doPoll(): Promise<void> {
    const result = await this.reader();

    if (result.status === "fail" && result.problem.kind === "no-registry") {
      this.consecutiveNoRegistry++;
      if (this.consecutiveNoRegistry < 2) {
        // Not confirmed yet: publish nothing new this tick. Subscribers
        // still get repainted so any countdown they render keeps moving,
        // but `this.state` deliberately keeps whatever it already was.
        this.emit();
        return;
      }
    } else {
      this.consecutiveNoRegistry = 0;
    }

    this.state = result;

    if (result.status === "fail") {
      if (result.problem.message !== this.lastLoggedProblemMessage) {
        this.lastLoggedProblemMessage = result.problem.message;
        this.onProblem?.(result.problem);
      }
    } else {
      // Re-arm: a problem that shows up again after a recovery is a new
      // thing to know about, not a continuation of the last one.
      this.lastLoggedProblemMessage = undefined;
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

export const sessionsStore = new SessionsStore();
