import streamDeck, {
  action,
  SingletonAction,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";

import { renderKey } from "../lib/render.js";
import { claudeStore, codexStore, type StoreState, type UsageStore } from "../lib/store.js";
import { viewFor, type MeterSettings } from "../lib/view.js";

export type { MeterSettings };

const logger = streamDeck.logger.createScope("meter");

/** How long a peek at the resets screen stays up before reverting. */
const PEEK_MS = 4000;

// A card that says "see logs" is a promise, and until this line existed
// nothing kept it: store.ts records every failure in its `state` but had no
// way to write to disk, since it deliberately imports nothing from the SDK
// (see the class comment on UsageStore) so it stays testable without one.
// Wiring UsageStore.onFailure here, where streamDeck.logger already exists,
// keeps that constraint intact while making "see logs" true. The provider
// name is included because both meters now share one log file.
for (const store of [claudeStore, codexStore]) {
  store.onFailure = (failure) => {
    logger.error(`[${store.provider.label}] ${failure.kind}: ${failure.message}`);
  };
}

/**
 * Shared logic behind every usage-meter action, whichever provider it
 * polls. Not itself decorated with `@action` — Stream Deck needs a concrete
 * UUID per key type, and each concrete subclass below supplies its own
 * store instance so this class never has to branch on which provider it is.
 */
abstract class UsageMeterBase extends SingletonAction<MeterSettings> {
  protected abstract readonly store: UsageStore;

  /** Unsubscribe callbacks, keyed by action context id. */
  private readonly unsubscribes = new Map<string, () => void>();
  /** Latest settings per visible key, so a store update can repaint each one. */
  private readonly settings = new Map<string, MeterSettings>();
  /**
   * Pending revert timers for keys currently peeking at the resets screen,
   * keyed by action context id. Presence in the map means "currently
   * peeking"; the timer clears the peek and repaints when it fires.
   */
  private readonly peeking = new Map<string, NodeJS.Timeout>();
  /**
   * The store's latest state, cached so a key press can repaint immediately
   * with the resets screen instead of waiting for the next store tick. The
   * store holds one shared state for every key, so a single field suffices.
   */
  private lastState: StoreState = { status: "loading" };

  override onWillAppear(ev: WillAppearEvent<MeterSettings>): void {
    const id = ev.action.id;
    this.settings.set(id, ev.payload.settings ?? {});
    this.applyConfig();

    // Guard against a duplicate appear for the same context — profile
    // switches can deliver one — which would otherwise leak a subscription.
    this.unsubscribes.get(id)?.();

    const unsubscribe = this.store.subscribe((state) => {
      this.lastState = state;
      void this.paint(ev.action, id, state);
    });
    this.unsubscribes.set(id, unsubscribe);
  }

  override onWillDisappear(ev: WillDisappearEvent<MeterSettings>): void {
    const id = ev.action.id;
    this.unsubscribes.get(id)?.();
    this.unsubscribes.delete(id);
    this.settings.delete(id);
    // A timer firing after the key is gone would try to paint a dead action.
    clearTimeout(this.peeking.get(id));
    this.peeking.delete(id);
    this.applyConfig();
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<MeterSettings>): void {
    this.settings.set(ev.action.id, ev.payload.settings ?? {});
    this.applyConfig();
    this.store.refreshNow();
  }

  /**
   * Pressing the key shows the dedicated resets screen for a few seconds,
   * then reverts to whatever mode the settings specify. It does not call
   * `refreshNow()`: the countdowns tick locally off the last snapshot and
   * need no network, and an API probe counts as usage activity, so a peek
   * must never fire a request. It does not touch settings either — a peek is
   * transient and must not persist as a mode change.
   */
  override async onKeyDown(ev: KeyDownEvent<MeterSettings>): Promise<void> {
    const id = ev.action.id;

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
   * Recompute the shared poller's configuration from every visible key.
   * Called on any appear/disappear/settings change so a key going away can
   * relax an interval it had tightened.
   */
  private applyConfig(): void {
    this.store.resetConfig();
    for (const s of this.settings.values()) {
      this.store.configure(s.intervalSeconds, s.allowRefresh);
    }
  }

  private async paint(
    target: { setImage(image: string): Promise<void> },
    id: string,
    state: StoreState,
  ): Promise<void> {
    const stored = this.settings.get(id) ?? {};
    // Fall back to the provider's default when the user has never chosen, and
    // also when their stored choice names a window this provider does not
    // report — a Codex key carrying `mode: "both"` from before that was known
    // would otherwise draw a dead row forever, since Stream Deck persists
    // per-key settings and nothing else would ever clear it.
    const { defaultMode, supportedModes } = this.store.provider;
    const mode =
      stored.mode !== undefined && supportedModes.includes(stored.mode)
        ? stored.mode
        : defaultMode;
    const settings = { ...stored, mode };
    try {
      await target.setImage(
        renderKey(
          viewFor(state, settings, this.peeking.has(id), new Date(), this.store.provider.signInHint),
        ),
      );
    } catch (e) {
      logger.error(`failed to paint key ${id}: ${(e as Error).message}`);
    }
  }
}

// This UUID was rebranded once, deliberately, to its current value while
// this plugin had exactly one installation (the author's) — so no existing
// keybinding broke. It is now frozen for the same reason the old identifier
// was: Stream Deck matches an installed action back to a key already on
// someone's deck, so changing it again would make every existing user's key
// vanish on upgrade.
@action({ UUID: "com.devbloom.ai-usage.meter" })
export class UsageMeter extends UsageMeterBase {
  protected readonly store = claudeStore;
}

@action({ UUID: "com.devbloom.ai-usage.codex-meter" })
export class CodexUsageMeter extends UsageMeterBase {
  protected readonly store = codexStore;
}
