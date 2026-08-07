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

const idleFace = () => renderKey({ kind: "message", title: "CLAUDE", subtitle: "skip perms" });
const sentFace = () => renderKey({ kind: "message", title: "SENT", tone: "neutral" });
const refusedFace = () => renderKey({ kind: "message", title: "NOT A", subtitle: "TERMINAL", tone: "warn" });
const failedFace = () => renderKey({ kind: "message", title: "FAILED", subtitle: "see logs", tone: "crit" });

@action({ UUID: "com.alejo.claude-usage.launch" })
export class LaunchClaude extends SingletonAction<LaunchSettings> {
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
    void ev.action.setImage(idleFace());
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<LaunchSettings>): void {
    this.settings.set(ev.action.id, ev.payload.settings ?? {});
    void ev.action.setImage(idleFace());
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
    const command = settings.command || DEFAULT_COMMAND;
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
        void ev.action.setImage(idleFace());
      }, ms),
    );
  }
}
