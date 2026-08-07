import streamDeck, { LogLevel } from "@elgato/streamdeck";

import { LaunchClaude } from "./actions/launch.js";
import { UsageMeter } from "./actions/meter.js";

// TRACE would log the full websocket conversation; INFO keeps the rolling log
// files small while still recording the failures users actually report.
streamDeck.logger.setLevel(LogLevel.INFO);

streamDeck.actions.registerAction(new UsageMeter());
streamDeck.actions.registerAction(new LaunchClaude());

streamDeck.connect();
