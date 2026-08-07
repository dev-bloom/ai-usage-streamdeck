import streamDeck, {
  action,
  SingletonAction,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";

import { renderKey } from "../lib/render.js";
import { usageStore, type StoreState } from "../lib/store.js";
import { viewFor, type MeterSettings } from "../lib/view.js";

export type { MeterSettings };

const logger = streamDeck.logger.createScope("meter");

/** How long a peek at the resets screen stays up before reverting. */
const PEEK_MS = 4000;

@action({ UUID: "com.alejo.claude-usage.meter" })
export class UsageMeter extends SingletonAction<MeterSettings> {
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

    const unsubscribe = usageStore.subscribe((state) => {
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
    usageStore.refreshNow();
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
    usageStore.resetConfig();
    for (const s of this.settings.values()) {
      usageStore.configure(s.intervalSeconds, s.allowRefresh);
    }
  }

  private async paint(
    target: { setImage(image: string): Promise<void> },
    id: string,
    state: StoreState,
  ): Promise<void> {
    const settings = this.settings.get(id) ?? {};
    try {
      await target.setImage(renderKey(viewFor(state, settings, this.peeking.has(id))));
    } catch (e) {
      logger.error(`failed to paint key ${id}: ${(e as Error).message}`);
    }
  }
}
