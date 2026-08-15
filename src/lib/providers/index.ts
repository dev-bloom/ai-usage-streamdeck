import type { DisplayMode } from "../render.js";
import type { UsageSnapshot } from "../usage.js";

/**
 * A usage source the plugin can poll. Claude and Codex are shaped
 * differently underneath (a throwaway API probe vs. a dedicated read-only
 * endpoint, keychain vs. a plaintext file, refreshable vs. not) but both
 * reduce to this: give me a snapshot, and let me drop your cached
 * credentials when asked. Keeping the seam this small is what lets
 * store.ts and the actions stay provider-agnostic instead of growing an
 * if/else on `id` everywhere.
 */
export type Provider = {
  id: "claude" | "codex";
  /** Shown in logs and available for a future multi-provider UI; not yet surfaced on the key face. */
  label: string;
  /** Shown on the sign-in / expired card, e.g. "run claude" or "open ChatGPT". */
  signInHint: string;
  fetchUsage(opts: { allowRefresh: boolean }): Promise<UsageSnapshot>;
  /** Drop any in-memory credential cache so the next poll re-reads from disk/keychain. */
  invalidateCredentialCache(): void;
  /**
   * True when polling this provider consumes the user's own quota. Claude's
   * only usage source is a throwaway `/v1/messages` probe that counts as
   * real activity; Codex has a dedicated read-only usage endpoint that costs
   * nothing to poll. Exists so the settings UI can stop warning about tight
   * poll intervals for a provider where that warning would be false.
   */
  pollCostsQuota: boolean;
  /**
   * What a freshly-dragged key shows before anyone opens the property
   * inspector. Provider-specific because the windows themselves are: Codex
   * on a ChatGPT plan reports a weekly cap and no 5-hour window at all, so
   * defaulting it to the combined face would spend half the key drawing an
   * em dash forever. Overridden by the key's own `mode` setting the moment
   * the user picks one.
   */
  defaultMode: DisplayMode;
  /**
   * Which faces this provider can actually draw. Codex reports one window, so
   * offering the other two would only ever produce an em dash where a number
   * belongs — its inspector drops the selector entirely for that reason.
   *
   * Enforced here as well as in the UI on purpose: a key that stored
   * `mode: "both"` before this was known would otherwise keep rendering a dead
   * row forever, because Stream Deck persists per-key settings and nothing
   * would ever clear it.
   */
  supportedModes: readonly DisplayMode[];
};

export { claudeProvider } from "./claude.js";
export { codexProvider } from "./codex.js";
