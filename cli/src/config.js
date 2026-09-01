"use strict";

// ~/.argox/config.json -- { apiBase, apiKey }, written by `login`,
// read by `connect`. Stdlib only, same "no extra deps to install" choice
// the Python cli.py already made for its own connect/status/stop commands.
//
// Named ~/.argox (not ~/.agenttrail) because the npm package is published
// as `argox` -- the name `agenttrail` was already taken by an unrelated
// package on the public registry.

const fs = require("fs");
const os = require("os");
const path = require("path");

const CONFIG_DIR = path.join(os.homedir(), ".argox");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

// Placeholder until the real domain is live -- login/connect always let
// you override with --api-base, this is just the fallback default.
const DEFAULT_API_BASE = "https://api.agenttrail.dev";

function load() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function save(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

module.exports = { CONFIG_PATH, DEFAULT_API_BASE, load, save };
