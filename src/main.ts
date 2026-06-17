#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig } from "./config/index.js";
import { createDaemon } from "./daemon.js";
import { GitHubClient, resolveAuthenticatedUser } from "./github/index.js";
import { runInit, type InitFlags } from "./init/index.js";
import { createLogger } from "./logger.js";
import { DispatchOrchestrator, PollingLoop } from "./polling/index.js";
import { getTriggerTargetKey } from "./polling/dispatch.js";
import { recoverStaleComments } from "./polling/recovery.js";
import { detectTrigger } from "./polling/trigger.js";
import { RepoManager } from "./repo/index.js";
import { createAgentRunner } from "./runner/factory.js";
import { executeRun } from "./run/execute.js";
import { acquireLock } from "./state/index.js";
import { StateStore } from "./state/store.js";
import { registerShutdown } from "./shutdown.js";

const DEFAULT_STATE_DIR = join(homedir(), ".otto");
const DEFAULT_CONFIG_PATH = join(homedir(), ".otto", "config.yaml");
const SHUTDOWN_TIMEOUT_MS = 30_000;

type CleanupCommand = {
  target: "worktrees" | "branches";
  dryRun: boolean;
};

type ParsedArgs = {
  subcommand: "daemon" | "init" | "cleanup";
  configPath: string | undefined;
  stateDir: string;
  cleanup: CleanupCommand | undefined;
  init: InitFlags | undefined;
};

function parseArgs(argv: string[]): ParsedArgs | null {
  let configPath: string | undefined;
  let stateDir = DEFAULT_STATE_DIR;
  let cleanup: CleanupCommand | undefined;
  let subcommand: ParsedArgs["subcommand"] = "daemon";

  // init-specific flags
  let initToken: string | undefined;
  let initRunner: string | undefined;
  let initModel: string | undefined;
  let initApiKeyEnv: string | undefined;
  let initRepo: string | undefined;
  let initForce = false;
  let initConfigPath = DEFAULT_CONFIG_PATH;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "init") {
      subcommand = "init";
    } else if (arg === "--token") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        process.stderr.write("Error: --token requires a value\n");
        return null;
      }
      initToken = next;
      i++;
    } else if (arg === "--runner") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        process.stderr.write("Error: --runner requires a value\n");
        return null;
      }
      initRunner = next;
      i++;
    } else if (arg === "--model") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        process.stderr.write("Error: --model requires a value\n");
        return null;
      }
      initModel = next;
      i++;
    } else if (arg === "--api-key-env") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        process.stderr.write("Error: --api-key-env requires a value\n");
        return null;
      }
      initApiKeyEnv = next;
      i++;
    } else if (arg === "--repo") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        process.stderr.write("Error: --repo requires a value\n");
        return null;
      }
      initRepo = next;
      i++;
    } else if (arg === "--force") {
      initForce = true;
    } else if (arg === "--config") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        process.stderr.write("Error: --config requires a path argument\n");
        return null;
      }
      if (subcommand === "init") {
        initConfigPath = next;
      } else {
        configPath = next;
      }
      i++;
    } else if (arg === "--state-dir") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        process.stderr.write("Error: --state-dir requires a path argument\n");
        return null;
      }
      stateDir = next;
      i++;
    } else if (arg === "cleanup") {
      subcommand = "cleanup";
      const target = argv[i + 1];
      if (target !== "worktrees" && target !== "branches") {
        process.stderr.write("Error: cleanup requires 'worktrees' or 'branches'\n");
        return null;
      }
      cleanup = { target, dryRun: false };
      i++;
    } else if (arg === "--dry-run") {
      if (cleanup === undefined) {
        process.stderr.write("Error: --dry-run is only valid with cleanup commands\n");
        return null;
      }
      cleanup = { ...cleanup, dryRun: true };
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "otto — GitHub-triggered local agent runner",
          "",
          "Usage: otto [options]",
          "       otto init [--token <tok>] [--runner <r>] [--model <m>] [--repo <owner/repo>] [--force]",
          "       otto cleanup worktrees [options] [--dry-run]",
          "       otto cleanup branches [options] [--dry-run]",
          "",
          "Options:",
          "  --config <path>       Path to config file (default: ./otto.yaml or ~/.otto/config.yaml)",
          "  --state-dir <path>    Path to state directory (default: ~/.otto)",
          "  --dry-run             Print cleanup targets without deleting them",
          "  --version             Print version and exit",
          "  --help                Show this message",
          "",
          "Init options:",
          "  --token <token>       GitHub personal access token",
          "  --runner <runner>     Agent runner to use: claude or codex",
          "  --model <model>       Model name for the selected runner",
          "  --api-key-env <name>  Env var name for the OpenAI API key (codex runner only)",
          "  --repo <owner/repo>   First repo to watch",
          "  --force               Overwrite existing config",
          "  --config <path>       Output config path (default: ~/.otto/config.yaml)",
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

  const init: InitFlags | undefined =
    subcommand === "init"
      ? {
          token: initToken,
          runner: initRunner,
          model: initModel,
          apiKeyEnv: initApiKeyEnv,
          repo: initRepo,
          force: initForce,
          configPath: initConfigPath,
        }
      : undefined;

  return { subcommand, configPath, stateDir, cleanup, init };
}

function printCleanupSummary(
  title: string,
  items: { repo: string; branch: string; deleted: boolean; detail?: string }[],
  dryRun: boolean,
): void {
  if (items.length === 0) {
    process.stdout.write(`No ${title} found.\n`);
    return;
  }

  process.stdout.write(`${dryRun ? "Dry run" : "Deleted"} ${title}:\n`);
  for (const item of items) {
    const detail = item.detail !== undefined ? ` ${item.detail}` : "";
    process.stdout.write(`- ${item.repo} ${item.branch}${detail}\n`);
  }

  if (dryRun) {
    process.stdout.write("Run again without --dry-run to delete these items.\n");
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) return;

  if (args.subcommand === "init" && args.init !== undefined) {
    await runInit(args.init);
    return;
  }

  const { configPath, stateDir } = args;
  const logger = createLogger();

  const config = await loadConfig(configPath);
  const state = await StateStore.load(stateDir);
  const daemonLogger = logger.child({ machineId: state.machineId });
  const repoManager = new RepoManager({
    reposDir: config.workspace.reposDir,
    worktreesDir: config.workspace.worktreesDir,
    stateStore: state,
  });

  if (args.cleanup !== undefined) {
    if (args.cleanup.target === "worktrees") {
      const result = await repoManager.cleanupWorktrees({ dryRun: args.cleanup.dryRun });
      printCleanupSummary(
        "stale worktrees",
        result.stale.map((item) => ({
          repo: item.repo,
          branch: item.branch,
          deleted: item.deleted,
          detail: `${item.path} (${item.reason})`,
        })),
        args.cleanup.dryRun,
      );
    } else {
      const result = await repoManager.cleanupBranches({
        repos: config.github.repos,
        dryRun: args.cleanup.dryRun,
      });
      printCleanupSummary("merged remote branches", result.branches, args.cleanup.dryRun);
    }
    return;
  }

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

  const agentRunner = createAgentRunner(config.agent.default, defaultRunnerConfig);

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
