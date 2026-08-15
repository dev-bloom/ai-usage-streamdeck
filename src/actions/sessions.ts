import streamDeck, {
  action,
  SingletonAction,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type KeyUpEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";

import { focusSession, type FocusOutcome } from "../lib/focus.js";
import { PressTracker } from "../lib/press.js";
import { renderKey } from "../lib/render.js";
import type { SessionsProblem, SessionsState } from "../lib/sessions.js";
import { sessionsStore } from "../lib/sessions-store.js";
import { firstFocusableSession, sessionsViewFor, type SessionsSettings } from "../lib/view.js";

export type { SessionsSettings };

const logger = streamDeck.logger.createScope("sessions");

// Mirrors the UsageStore.onFailure wiring in meter.ts: sessions-store.ts
// deliberately imports nothing from the SDK so it stays testable without
// one, so this is the one place that can turn a recorded problem into an
// actual log line.
sessionsStore.onProblem = (problem: SessionsProblem) => {
  logger.error(`${problem.kind}: ${problem.message}`);
};

/** How long a peek at the raw session list stays up before reverting. */
const PEEK_MS = 4000;

/**
 * Default hold duration before a press counts as long, used when a key's
 * settings don't specify `longPressMs`. Kept in sync with press.ts's own
 * `DEFAULT_THRESHOLD_MS` — see that constant for why 300 is the number: a
 * deliberate hold clears it easily while an ordinary tap stays well under
 * it, and going much lower starts trading a harmless false peek for a false
 * hold that steals window focus.
 *
 * This used to be the *only* threshold, non-configurable, because
 * PressTracker took one value at construction and this class runs a single
 * shared tracker for every key — making it a setting would have meant
 * rebuilding the tracker (and losing any in-flight hold) on every settings
 * change. `PressTracker.down()` now resolves its threshold per call instead
 * of off the instance, so the per-key value below can be threaded straight
 * through without touching the tracker's own state.
 */
const LONG_PRESS_MS = 300;

/** How long the focus/raised flash stays up before reverting — matches launch.ts's SENT_MS for a plain success. */
const FOCUS_MS = 1200;
/** How long the empty-bucket/failure flash stays up — matches launch.ts's FLASH_MS, since both need a beat longer to read. */
const FLASH_MS = 1800;

// All four long-press outcomes flash `fill: true` — a whole-key colour
// flash, not a centred text card. The user is still holding the key down
// when the confirmation lands, so their finger covers the middle of it; a
// centred title is exactly the part that's hidden right when it matters.
// Filling the face means the signal survives at the edges instead.
//
// Colour now carries the meaning that used to split three ways
// (neutral/neutral/warn/crit): both successful-focus outcomes flash the
// same green, so the tab-vs-app precision distinction lives only in the
// subtitle below, not in a second colour.
const focusedFace = () => renderKey({ kind: "message", title: "FOCUSED", tone: "ok", fill: true });
// "RAISED", not "FOCUSED": macOS exposes no way to select VS Code's or
// Cursor's integrated terminal pane (see the ceiling buildActivateScript
// documents in focus.ts), so this face must not claim a precision the press
// didn't actually achieve — only the app came forward, not a specific tab.
const raisedFace = () =>
  renderKey({ kind: "message", title: "RAISED", subtitle: "app only", tone: "ok", fill: true });
// A hold that appears to do nothing is indistinguishable from a broken
// gesture, so an empty bucket still gets a face, not silence.
const emptyFace = () =>
  renderKey({ kind: "message", title: "EMPTY", subtitle: "no session", tone: "warn", fill: true });
const failedFace = () =>
  renderKey({ kind: "message", title: "FAILED", subtitle: "see logs", tone: "crit", fill: true });

// This UUID was rebranded once, deliberately, to its current value while
// this plugin had exactly one installation (the author's) — so no existing
// keybinding broke. It is now frozen for the same reason the old identifier
// was: Stream Deck matches an installed action back to a key already on
// someone's deck, so changing it again would make every existing user's key
// vanish on upgrade.
//
// No abstract base class here, unlike UsageMeterBase/LaunchBase: those exist
// because each has two provider variants (Claude/Codex) that need to share
// logic while supplying their own store or default command. There is
// exactly one kind of sessions key, so a shared base would just be a layer
// with a single subclass.
@action({ UUID: "com.devbloom.ai-usage.sessions" })
export class SessionsKey extends SingletonAction<SessionsSettings> {
  /** Unsubscribe callbacks, keyed by action context id. */
  private readonly unsubscribes = new Map<string, () => void>();
  /**
   * Pending revert timers for keys currently peeking at the raw session
   * list, keyed by action context id. Presence in the map means "currently
   * peeking"; the timer clears the peek and repaints when it fires.
   */
  private readonly peeking = new Map<string, NodeJS.Timeout>();
  /**
   * Pending revert timers for keys currently showing a long-press flash
   * (focused / raised / empty / failed), keyed by action context id — mirrors
   * `reverts` in launch.ts. Kept separate from `peeking`: that map's presence
   * doubles as "sessionsViewFor should draw the peek face", which a flash is
   * not, so folding the two together would make a stale flash reappear as a
   * peek, or vice versa, whichever timer happened to fire last.
   */
  private readonly flashing = new Map<string, NodeJS.Timeout>();
  /**
   * Latest settings per visible key, so a store update can repaint each one
   * with its own mode — mirrors UsageMeterBase's `settings` map in meter.ts.
   */
  private readonly settings = new Map<string, SessionsSettings>();
  /**
   * The current action target per visible key, so a long press — which
   * fires from a timer inside `press` well after `onKeyDown` returns, not
   * from an event handler that carries its own `ev.action` — still has
   * something to call `setImage` on.
   */
  private readonly targets = new Map<string, { setImage(image: string): Promise<void> }>();
  /**
   * The store's latest state, cached so a key press can repaint immediately
   * with the peek face instead of waiting for the next store tick. The
   * store holds one shared state for every key, so a single field suffices.
   */
  private lastState: SessionsState = { status: "loading" };
  /**
   * One tracker for every key this action manages, the same "single shared
   * instance keyed by action id" shape `unsubscribes`/`peeking`/`settings`
   * already use above. The threshold is still per-key even though the
   * tracker is shared: `onKeyDown` passes each key's own `longPressMs` into
   * `down()`, which resolves it fresh for that one press.
   */
  private readonly press = new PressTracker({
    thresholdMs: LONG_PRESS_MS,
    onLong: (id) => void this.handleLongPress(id),
  });

  override onWillAppear(ev: WillAppearEvent<SessionsSettings>): void {
    const id = ev.action.id;
    this.settings.set(id, ev.payload.settings ?? {});
    this.targets.set(id, ev.action);

    // Guard against a duplicate appear for the same context — profile
    // switches can deliver one — which would otherwise leak a subscription.
    this.unsubscribes.get(id)?.();

    const unsubscribe = sessionsStore.subscribe((state: SessionsState) => {
      this.lastState = state;
      void this.paint(ev.action, id, state);
    });
    this.unsubscribes.set(id, unsubscribe);
  }

  override onWillDisappear(ev: WillDisappearEvent<SessionsSettings>): void {
    const id = ev.action.id;
    this.unsubscribes.get(id)?.();
    this.unsubscribes.delete(id);
    this.settings.delete(id);
    this.targets.delete(id);
    // A timer firing after the key is gone would try to paint a dead action.
    clearTimeout(this.peeking.get(id));
    this.peeking.delete(id);
    clearTimeout(this.flashing.get(id));
    this.flashing.delete(id);
    // Drops any hold still in progress so a long press that never gets its
    // keyUp (the key was removed mid-hold) can't fire onLong afterwards.
    this.press.cancel(id);
  }

  /**
   * Repaint with the new mode immediately, rather than waiting for the
   * store's next tick — otherwise switching "Waiting only" to "Idle only" in
   * the property inspector would leave the key showing the old bucket for
   * up to a full poll interval.
   */
  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<SessionsSettings>): void {
    const id = ev.action.id;
    this.settings.set(id, ev.payload.settings ?? {});
    void this.paint(ev.action, id, this.lastState);
  }

  /**
   * Only starts the hold timer. The short-press peek fires from `onKeyUp`
   * below, not here — `press.up()` is what tells us whether this press
   * turned out short or long, and that answer only exists once the key is
   * released (or, for "long", the instant the threshold fires while still
   * held — see `handleLongPress`).
   */
  override onKeyDown(ev: KeyDownEvent<SessionsSettings>): void {
    const id = ev.action.id;
    // `settings` is populated in onWillAppear before any key can be pressed,
    // so the `?? {}` here only guards a settings blob with no longPressMs
    // set — `press.down()` treats that the same as an out-of-range one and
    // falls back to LONG_PRESS_MS.
    this.press.down(id, this.settings.get(id)?.longPressMs);
  }

  /**
   * Pressing the key shows the peek face — the raw ranked session list, or
   * whatever raw detail a problem face has to offer — for a few seconds,
   * then reverts to the summary face. Skipped when this press already
   * turned out long: `handleLongPress` has already taken the key's face for
   * its own flash, and letting the peek run too would either fight it for
   * the screen or, once the flash times out, make the release look like it
   * triggered a second, unrelated peek.
   */
  override async onKeyUp(ev: KeyUpEvent<SessionsSettings>): Promise<void> {
    const id = ev.action.id;
    if (this.press.up(id) === "long") return;

    // Pressing again while already peeking restarts the window rather than
    // stacking a second timer.
    clearTimeout(this.peeking.get(id));
    this.peeking.set(
      id,
      setTimeout(() => {
        this.peeking.delete(id);
        void this.paint(ev.action, id, this.lastState);
      }, PEEK_MS),
    );

    await this.paint(ev.action, id, this.lastState);
  }

  /**
   * Fires while the key is still held, ~LONG_PRESS_MS into the hold (see
   * PressTracker.onLong). Focuses the terminal window of the first session
   * in this key's bucket and flashes the outcome; every branch ends in a
   * flash, since a hold that appears to do nothing is indistinguishable from
   * a broken gesture.
   */
  private async handleLongPress(id: string): Promise<void> {
    const target = this.targets.get(id);
    if (!target) return; // key disappeared between down() and the threshold firing

    // Take the key's face outright: a peek that started at key-down and
    // hasn't reverted yet must not keep showing through a long press that
    // just decided something else belongs on screen.
    clearTimeout(this.peeking.get(id));
    this.peeking.delete(id);

    const settings = this.settings.get(id) ?? {};
    const session = firstFocusableSession(this.lastState, settings);
    if (!session) {
      this.flash(id, target, emptyFace(), FLASH_MS);
      return;
    }

    // A session that was live in the snapshot this pid came from can have
    // exited by the time the hold reaches threshold — `ok: false` here is
    // therefore an ordinary outcome, not evidence of a bug, which is why it
    // only warrants a log line and a flash, not an escalated one.
    const outcome: FocusOutcome = await focusSession(session.pid);
    if (!outcome.ok) {
      logger.error(`focus failed for pid ${session.pid}: ${outcome.reason}`);
      this.flash(id, target, failedFace(), FLASH_MS);
      return;
    }

    this.flash(id, target, outcome.precision === "tab" ? focusedFace() : raisedFace(), FOCUS_MS);
  }

  private async paint(
    target: { setImage(image: string): Promise<void> },
    id: string,
    state: SessionsState,
  ): Promise<void> {
    try {
      const settings = this.settings.get(id) ?? {};
      await target.setImage(renderKey(sessionsViewFor(state, settings, this.peeking.has(id))));
    } catch (e) {
      logger.error(`failed to paint key ${id}: ${(e as Error).message}`);
    }
  }

  /** Paint `face`, then revert to the key's normal face after `ms`, replacing any pending revert. */
  private flash(id: string, target: { setImage(image: string): Promise<void> }, face: string, ms: number): void {
    void target.setImage(face);
    clearTimeout(this.flashing.get(id));
    this.flashing.set(
      id,
      setTimeout(() => {
        this.flashing.delete(id);
        void this.paint(target, id, this.lastState);
      }, ms),
    );
  }
}
