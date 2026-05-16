#!/usr/bin/env node
import { Daemon } from "./daemon.js";
import { loadConfig } from "./config/index.js";

type ParsedArgs = {
  configPath: string | undefined;
};

function parseArgs(argv: string[]): ParsedArgs {
  let configPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        console.error("Error: --config requires a path argument");
        process.exit(1);
      }
      configPath = next;
      i++;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "otto — GitHub-triggered local agent runner",
          "",
          "Usage: otto [options]",
          "",
          "Options:",
          "  --config <path>  Path to config file (default: ./otto.yaml or ~/.otto/config.yaml)",
          "  --version        Print version and exit",
          "  --help           Show this message",
        ].join("\n"),
      );
      process.exit(0);
    } else if (arg === "--version" || arg === "-v") {
      console.log("0.1.0");
      process.exit(0);
    }
  }

  return { configPath };
}

async function main(): Promise<void> {
  const { configPath } = parseArgs(process.argv.slice(2));

  const config = await loadConfig(configPath);

  const repoCount = String(config.github.repos.length);
  const interval = String(config.otto.pollIntervalSeconds);
  console.log(`Otto starting — polling ${repoCount} repo(s) every ${interval}s`);

  const daemon = new Daemon();

  const shutdown = () => {
    console.log("\nShutting down…");
    daemon.stop();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  await daemon.start();

  console.log("Otto stopped.");
}

main().catch((err: unknown) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
