#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig } from "./config/index.js";
import { createDaemon } from "./daemon.js";
import { GitHubClient, resolveAuthenticatedUser } from "./github/index.js";
import { acquireLock } from "./state/index.js";
import { StateStore } from "./state/store.js";
import { registerShutdown } from "./shutdown.js";

const DEFAULT_STATE_DIR = join(homedir(), ".otto");
const SHUTDOWN_TIMEOUT_MS = 30_000;

type ParsedArgs = {
  configPath: string | undefined;
  stateDir: string;
};

function parseArgs(argv: string[]): ParsedArgs | null {
  let configPath: string | undefined;
  let stateDir = DEFAULT_STATE_DIR;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        process.stderr.write("Error: --config requires a path argument\n");
        return null;
      }
      configPath = next;
      i++;
    } else if (arg === "--state-dir") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        process.stderr.write("Error: --state-dir requires a path argument\n");
        return null;
      }
      stateDir = next;
      i++;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "otto — GitHub-triggered local agent runner",
          "",
          "Usage: otto [options]",
          "",
          "Options:",
          "  --config <path>     Path to config file (default: ./otto.yaml or ~/.otto/config.yaml)",
          "  --state-dir <path>  Path to state directory (default: ~/.otto)",
          "  --version           Print version and exit",
          "  --help              Show this message",
          "",
        ].join("\n"),
      );
      process.exitCode = 0;
      return null;
    } else if (arg === "--version" || arg === "-v") {
      process.stdout.write("0.1.0\n");
      process.exitCode = 0;
      return null;
    }
  }

  return { configPath, stateDir };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) return;

  const { configPath, stateDir } = args;

  const config = await loadConfig(configPath);
  const state = await StateStore.load(stateDir);
  const releaseLock = await acquireLock(stateDir);

  const token = process.env[config.github.tokenEnvVar];
  if (token === undefined || token === "") {
    process.stderr.write(
      `Error: environment variable ${config.github.tokenEnvVar} is not set.\n`,
    );
    process.exitCode = 1;
    await releaseLock();
    return;
  }

  const github = new GitHubClient(token);
  const authenticatedLogin = await resolveAuthenticatedUser(github);

  const repoCount = String(config.github.repos.length);
  const interval = String(config.otto.pollIntervalSeconds);
  process.stdout.write(
    `Otto starting — authenticated as ${authenticatedLogin}, machine ${state.machineId}, polling ${repoCount} repo(s) every ${interval}s\n`,
  );

  const daemon = createDaemon({
    start: async () => { /* polling loop — future ticket */ },
    stop: async () => { /* cleanup — future ticket */ },
  });

  const shutdown = registerShutdown({ process });

  try {
    await daemon.start();
    await shutdown.signal;

    process.stdout.write("\nShutting down gracefully…\n");

    const timeoutController = new AbortController();
    const timeoutHandle = setTimeout(() => {
      timeoutController.abort();
    }, SHUTDOWN_TIMEOUT_MS);

    await Promise.race([
      daemon
        .stop({ signal: timeoutController.signal })
        .then(() => { clearTimeout(timeoutHandle); }),
      shutdown.escalation.then(() => {
        process.stderr.write("Forced exit on second signal.\n");
        process.exit(1);
      }),
    ]);
  } finally {
    shutdown.dispose();
    await releaseLock();
  }

  process.stdout.write("Otto stopped.\n");
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  });
}
