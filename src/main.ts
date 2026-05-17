#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig } from "./config/index.js";
import { createDaemon } from "./daemon.js";
import { GitHubClient, resolveAuthenticatedUser } from "./github/index.js";
import { createLogger } from "./logger.js";
import { DispatchOrchestrator, PollingLoop } from "./polling/index.js";
import { getTriggerTargetKey } from "./polling/dispatch.js";
import { recoverStaleComments } from "./polling/recovery.js";
import { detectTrigger } from "./polling/trigger.js";
import { RepoManager } from "./repo/index.js";
import { CommandRunner } from "./runner/command.js";
import { executeRun } from "./run/execute.js";
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
  const logger = createLogger();

  const config = await loadConfig(configPath);
  const state = await StateStore.load(stateDir);
  const daemonLogger = logger.child({ machineId: state.machineId });
  const releaseLock = await acquireLock(stateDir);

  const token = process.env[config.github.tokenEnvVar];
  if (token === undefined || token === "") {
    daemonLogger.error({ tokenEnvVar: config.github.tokenEnvVar }, "github token env var missing");
    process.exitCode = 1;
    await releaseLock();
    return;
  }

  const defaultRunnerConfig = config.agent.runners[config.agent.default];
  if (defaultRunnerConfig === undefined) {
    daemonLogger.error(
      { defaultRunner: config.agent.default },
      "default agent runner not found in config",
    );
    process.exitCode = 1;
    await releaseLock();
    return;
  }

  const github = new GitHubClient(token);
  const authenticatedLogin = await resolveAuthenticatedUser(github);

  daemonLogger.info(
    {
      authenticatedUser: authenticatedLogin,
      repoCount: config.github.repos.length,
      pollIntervalSeconds: config.otto.pollIntervalSeconds,
    },
    "otto starting",
  );

  const repoManager = new RepoManager({
    reposDir: config.workspace.reposDir,
    worktreesDir: config.workspace.worktreesDir,
    stateStore: state,
  });

  const agentRunner = new CommandRunner({
    id: config.agent.default,
    command: defaultRunnerConfig.command,
  });

  const orchestrator = new DispatchOrchestrator({
    windowMs: config.otto.debounceSeconds * 1000,
    maxConcurrentRuns: config.otto.maxConcurrentRuns,
    onRunReady: (batch) => {
      void executeRun(batch, {
        github,
        machineId: state.machineId,
        repoManager,
        agentRunner,
        timeoutMs: config.agent.timeoutSeconds * 1000,
        onRunComplete: (targetKey) => { orchestrator.onRunComplete(targetKey); },
        logger: daemonLogger,
      });
    },
  });

  await recoverStaleComments(github, config.github.repos, state.machineId, authenticatedLogin);

  const pollingLoop = new PollingLoop({
    client: github,
    state,
    repos: config.github.repos,
    intervalMs: config.otto.pollIntervalSeconds * 1000,
    authenticatedUser: authenticatedLogin,
    logger: daemonLogger,
    onNewComments: (repo, comments) => {
      for (const comment of comments) {
        const match = detectTrigger(comment, repo, config.otto.trigger);
        if (match === null) continue;
        const targetKey = getTriggerTargetKey(match);
        daemonLogger.info(
          { repo, commentId: comment.id, targetKey, taskDescription: match.taskDescription },
          "trigger detected",
        );
        orchestrator.addTrigger(match);
      }
    },
  });

  const daemon = createDaemon({
    start: () => {
      pollingLoop.start();
      return Promise.resolve();
    },
    stop: () => Promise.resolve(),
    beginShutdown: () => { pollingLoop.beginShutdown(); },
    waitForIdle: () => pollingLoop.waitForIdle(),
  });

  const shutdown = registerShutdown({ process });

  try {
    await daemon.start();
    await shutdown.signal;

    daemonLogger.info({}, "shutdown signal received");

    const timeoutController = new AbortController();
    const timeoutHandle = setTimeout(() => {
      timeoutController.abort();
    }, SHUTDOWN_TIMEOUT_MS);

    await Promise.race([
      daemon
        .stop({ signal: timeoutController.signal })
        .then(() => { clearTimeout(timeoutHandle); }),
      shutdown.escalation.then(() => {
        daemonLogger.warn({}, "forced exit on second signal");
        process.exit(1);
      }),
    ]);
  } finally {
    shutdown.dispose();
    await releaseLock();
  }

  daemonLogger.info({}, "otto stopped");
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((err: unknown) => {
    createLogger().error(
      { error: err instanceof Error ? err.message : String(err) },
      "fatal error",
    );
    process.exitCode = 1;
  });
}
