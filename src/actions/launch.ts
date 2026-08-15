import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

import streamDeck, {
  action,
  SingletonAction,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";

import { renderKey } from "../lib/render.js";
import {
  CODEX_DEFAULT_COMMAND,
  DEFAULT_COMMAND,
  buildDeliveryScript,
  buildFrontmostScript,
  classifyApp,
} from "../lib/terminal.js";

const execFile = promisify(execFileCb);

export type LaunchSettings = {
  command?: string;
  pressEnter?: boolean;
  allowEditors?: boolean;
};

const logger = streamDeck.logger.createScope("launch");

/** How long the sent/refused/failed flash stays up before reverting to idle. */
const SENT_MS = 1200;
const FLASH_MS = 1800;

const OSASCRIPT = "/usr/bin/osascript";
// osascript talks to the Accessibility/Automation subsystems, which can hang
// waiting on a permission dialog the user has not answered yet; a timeout
// keeps a stuck press from leaving the key showing "SENT" forever.
const OSASCRIPT_TIMEOUT_MS = 8000;

const sentFace = () => renderKey({ kind: "message", title: "SENT", tone: "neutral" });
const refusedFace = () => renderKey({ kind: "message", title: "NOT A", subtitle: "TERMINAL", tone: "warn" });
const failedFace = () => renderKey({ kind: "message", title: "FAILED", subtitle: "see logs", tone: "crit" });

/**
 * Shared logic behind both launch actions. Not decorated with `@action`
 * itself; each concrete subclass supplies its own default command and idle
 * face so this class never has to branch on which CLI it's launching.
 */
abstract class LaunchBase extends SingletonAction<LaunchSettings> {
  protected abstract readonly defaultCommand: string;
  protected abstract idleFace(): string;

  /** Latest settings per visible key, so a press can read them without a round trip. */
  private readonly settings = new Map<string, LaunchSettings>();
  /**
   * Pending revert-to-idle timers, keyed by action context id. A second
   * press while a flash is showing clears and restarts the timer rather than
   * stacking one, mirroring the peek timer in meter.ts.
   */
  private readonly reverts = new Map<string, NodeJS.Timeout>();

  override onWillAppear(ev: WillAppearEvent<LaunchSettings>): void {
    this.settings.set(ev.action.id, ev.payload.settings ?? {});
    void ev.action.setImage(this.idleFace());
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<LaunchSettings>): void {
    this.settings.set(ev.action.id, ev.payload.settings ?? {});
    void ev.action.setImage(this.idleFace());
  }

  override onWillDisappear(ev: WillDisappearEvent<LaunchSettings>): void {
    const id = ev.action.id;
    this.settings.delete(id);
    // A timer firing after the key is gone would try to paint a dead action.
    clearTimeout(this.reverts.get(id));
    this.reverts.delete(id);
  }

  /**
   * The whole point of this action is the guard: never let a misclassified
   * frontmost app turn a Claude session with permission checks disabled into
   * keystrokes typed at Slack or a source file. So every press re-checks the
   * frontmost app fresh rather than trusting anything cached.
   */
  override async onKeyDown(ev: KeyDownEvent<LaunchSettings>): Promise<void> {
    const id = ev.action.id;
    const settings = this.settings.get(id) ?? {};
    const command = settings.command || this.defaultCommand;
    const pressEnter = settings.pressEnter !== false;
    const allowEditors = settings.allowEditors === true;

    let bundleId: string | null;
    try {
      const { stdout } = await execFile(OSASCRIPT, ["-e", buildFrontmostScript()], {
        timeout: OSASCRIPT_TIMEOUT_MS,
      });
      bundleId = stdout.trim();
    } catch (e) {
      this.fail(ev, id, e);
      return;
    }

    const kind = classifyApp(bundleId);
    if (kind === "unsupported" || (kind === "editor" && !allowEditors)) {
      logger.info(`refused to type into frontmost app "${bundleId}" (kind=${kind})`);
      this.flash(ev, id, refusedFace(), FLASH_MS);
      return;
    }

    try {
      const script = buildDeliveryScript(kind, command, pressEnter);
      // The keystroke form returns two statements joined by a newline, one
      // per required "-e" argument; the do-script/write-text forms return a
      // single statement, which still splits into an array of one.
      const args = script.split("\n").flatMap((stmt) => ["-e", stmt]);
      await execFile(OSASCRIPT, args, { timeout: OSASCRIPT_TIMEOUT_MS });
    } catch (e) {
      this.fail(ev, id, e);
      return;
    }

    this.flash(ev, id, sentFace(), SENT_MS);
  }

  private fail(ev: KeyDownEvent<LaunchSettings>, id: string, e: unknown): void {
    const stderr = (e as { stderr?: string }).stderr ?? (e as Error).message;
    logger.error(`osascript failed: ${stderr}`);
    this.flash(ev, id, failedFace(), FLASH_MS);
  }

  /** Paint `face`, then revert to idle after `ms`, replacing any pending revert. */
  private flash(ev: KeyDownEvent<LaunchSettings>, id: string, face: string, ms: number): void {
    void ev.action.setImage(face);
    clearTimeout(this.reverts.get(id));
    this.reverts.set(
      id,
      setTimeout(() => {
        this.reverts.delete(id);
        void ev.action.setImage(this.idleFace());
      }, ms),
    );
  }
}

// This UUID was rebranded once, deliberately, to its current value while
// this plugin had exactly one installation (the author's) — so no existing
// keybinding broke. It is now frozen for the same reason the old identifier
// was: Stream Deck matches an installed action back to a key already on
// someone's deck, so changing it again would make every existing user's key
// vanish on upgrade.
@action({ UUID: "com.devbloom.ai-usage.launch" })
export class LaunchClaude extends LaunchBase {
  protected readonly defaultCommand = DEFAULT_COMMAND;
  protected idleFace(): string {
    return renderKey({ kind: "message", title: "CLAUDE", subtitle: "skip perms" });
  }
}

@action({ UUID: "com.devbloom.ai-usage.codex-launch" })
export class LaunchCodex extends LaunchBase {
  protected readonly defaultCommand = CODEX_DEFAULT_COMMAND;
  protected idleFace(): string {
    // No "skip perms" subtitle here: unlike Claude's default command, the
    // Codex default carries no verified permission-bypass flag (see
    // CODEX_DEFAULT_COMMAND in terminal.ts), so that subtitle would promise
    // something this key doesn't actually do out of the box.
    return renderKey({ kind: "message", title: "CODEX" });
  }
}
