import streamDeck, { LogLevel } from "@elgato/streamdeck";

import { LaunchClaude, LaunchCodex } from "./actions/launch.js";
import { CodexUsageMeter, UsageMeter } from "./actions/meter.js";
import { SessionsKey } from "./actions/sessions.js";

// TRACE would log the full websocket conversation; INFO keeps the rolling log
// files small while still recording the failures users actually report.
streamDeck.logger.setLevel(LogLevel.INFO);

streamDeck.actions.registerAction(new UsageMeter());
streamDeck.actions.registerAction(new CodexUsageMeter());
streamDeck.actions.registerAction(new LaunchClaude());
streamDeck.actions.registerAction(new LaunchCodex());
streamDeck.actions.registerAction(new SessionsKey());

streamDeck.connect();
