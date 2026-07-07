#!/usr/bin/env node
import {
  DEFAULT_ENDPOINT,
  loadConfig,
  logEvent,
  parseArgs,
  sendPushDeer,
} from "./pushdeer-lib.mjs";

const args = parseArgs();

const title = args.title || args.text || args._[0] || "";
const desp = args.desp || args.description || args._[1] || "";
const quiet = Boolean(args.quiet);
const dryRun = Boolean(args["dry-run"] || process.env.CODEX_PUSHDEER_DRY_RUN);
const config = loadConfig();

const endpoint = args.endpoint || config.endpoint || DEFAULT_ENDPOINT;
const pushkey = args.pushkey || config.pushkey || "";

if (!title) {
  const message = "Usage: pushdeer-notify.mjs --title <text> [--desp <description>]";
  if (!quiet) console.error(message);
  logEvent("error", message);
  process.exit(2);
}

try {
  const result = await sendPushDeer({
    title,
    desp,
    endpoint,
    pushkey,
    dryRun,
  });

  logEvent("info", "PushDeer notification sent", {
    dryRun,
    status: result.status,
    title,
    desp,
  });

  if (!quiet) {
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  logEvent("error", "PushDeer notification failed", {
    error: error?.message || String(error),
    title,
    desp,
  });
  if (!quiet) {
    console.error(error?.message || String(error));
  }
  process.exit(1);
}
