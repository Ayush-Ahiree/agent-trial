#!/usr/bin/env node
"use strict";

const config = require("../src/config.js");
const { connect } = require("../src/connect.js");

function usage() {
  console.log(
    [
      "agenttrail <command>",
      "",
      "Commands:",
      "  login --key <api-key> [--api-base <url>]   store your project's API key",
      "  connect [path]                              wire hooks into a project's .claude/settings.local.json",
      "  status                                       show what's currently configured",
      "  logout                                       forget the stored API key",
    ].join("\n")
  );
}

function cmdLogin(args) {
  const keyIdx = args.indexOf("--key");
  const key = keyIdx !== -1 ? args[keyIdx + 1] : null;
  if (!key) {
    console.error("error: --key <api-key> is required (find it on your project's page in the AgentTrail dashboard)");
    process.exit(1);
  }
  const baseIdx = args.indexOf("--api-base");
  const apiBase = baseIdx !== -1 ? args[baseIdx + 1] : config.DEFAULT_API_BASE;

  config.save({ apiKey: key, apiBase });
  console.log(`Saved. API base: ${apiBase}`);
  console.log("Now run `agenttrail connect` inside the project you want observed.");
}

function cmdConnect(args) {
  const saved = config.load();
  if (!saved.apiKey) {
    console.error("error: not logged in -- run `agenttrail login --key <api-key>` first");
    process.exit(1);
  }
  const projectDir = args.find((a) => !a.startsWith("--")) || process.cwd();
  const resolved = require("path").resolve(projectDir);

  let result;
  try {
    result = connect(resolved, { apiBase: saved.apiBase || config.DEFAULT_API_BASE, apiKey: saved.apiKey });
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
  console.log(result.messages.join("\n"));
}

function cmdStatus() {
  const saved = config.load();
  if (!saved.apiKey) {
    console.log("[not logged in] run `agenttrail login --key <api-key>`");
    return;
  }
  console.log(`[logged in] api base: ${saved.apiBase || config.DEFAULT_API_BASE}`);
  console.log(`Config file: ${config.CONFIG_PATH}`);
}

function cmdLogout() {
  config.save({});
  console.log("Logged out.");
}

function main() {
  const [, , command, ...args] = process.argv;
  switch (command) {
    case "login":
      return cmdLogin(args);
    case "connect":
      return cmdConnect(args);
    case "status":
      return cmdStatus();
    case "logout":
      return cmdLogout();
    default:
      usage();
      process.exit(command ? 1 : 0);
  }
}

main();
