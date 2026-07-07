#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), "..");
const pluginRoot = path.join(projectRoot, "plugins", "codex-pushdeer-notifier");
const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
const marketplacePath = path.join(projectRoot, ".agents", "plugins", "marketplace.json");

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON at ${filePath}: ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const manifest = readJson(manifestPath);
assert(manifest.name === "codex-pushdeer-notifier", "Unexpected plugin name.");
assert(/^\d+\.\d+\.\d+/.test(manifest.version), "Plugin version must look semver-like.");
assert(manifest.skills === "./skills/", "Manifest skills path should be ./skills/.");
assert(fs.existsSync(path.join(pluginRoot, "skills")), "Missing plugin skills directory.");
assert(fs.existsSync(path.join(pluginRoot, "scripts", "pushdeer-notify-event.mjs")), "Missing notify event script.");

const marketplace = readJson(marketplacePath);
assert(marketplace.name === "codex-pushdeer", "Unexpected marketplace name.");
const entry = marketplace.plugins?.find((item) => item.name === manifest.name);
assert(entry, "Marketplace is missing the plugin entry.");
assert(entry.source?.path === "./plugins/codex-pushdeer-notifier", "Marketplace source.path is wrong.");
assert(entry.policy?.installation === "AVAILABLE", "Marketplace installation policy should be AVAILABLE.");
assert(entry.policy?.authentication === "ON_INSTALL", "Marketplace authentication policy should be ON_INSTALL.");

console.log("Plugin structure validation passed.");
