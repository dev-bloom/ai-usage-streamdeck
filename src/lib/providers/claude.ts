import { fetchUsage, invalidateCredentialCache } from "../usage.js";
import type { Provider } from "./index.js";

/**
 * Wraps the pre-existing Claude Code probe (usage.ts) behind the Provider
 * seam. Deliberately a thin adapter rather than folding usage.ts's logic in
 * here: usage.ts's exports (fetchUsage, parsePct, parseReset, ...) and the
 * tests written directly against them keep working unchanged, and the
 * probe/caching/refresh machinery is intricate enough that rewriting it
 * would risk changing Claude's behaviour, which must not happen.
 */
export const claudeProvider: Provider = {
  id: "claude",
  label: "Claude",
  signInHint: "run claude",
  fetchUsage: ({ allowRefresh }) => fetchUsage(allowRefresh),
  invalidateCredentialCache,
  // Claude reports both windows on every response, so both are worth showing.
  defaultMode: "both",
  supportedModes: ["both", "session", "weekly"],
  pollCostsQuota: true,
};
