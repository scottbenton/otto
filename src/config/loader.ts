import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import yaml from "js-yaml";
import { ZodError } from "zod";

import { OttoConfigSchema, type OttoConfig } from "./schema.js";

export class ConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigError";
  }
}

const DEFAULT_SEARCH_PATHS = ["./otto.yaml", "~/.otto/config.yaml"];

function expandTilde(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return homedir() + p.slice(1);
  }
  return p;
}

function postProcess(config: OttoConfig): OttoConfig {
  return {
    ...config,
    workspace: {
      reposDir: expandTilde(config.workspace.reposDir),
      worktreesDir: expandTilde(config.workspace.worktreesDir),
    },
  };
}

async function tryReadFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(expandTilde(path), "utf8");
  } catch {
    return undefined;
  }
}

export async function loadConfig(
  configPath?: string,
  searchPaths: readonly string[] = DEFAULT_SEARCH_PATHS,
): Promise<OttoConfig> {
  let raw: string;
  let resolvedPath: string;

  if (configPath !== undefined) {
    resolvedPath = resolve(expandTilde(configPath));
    const contents = await tryReadFile(configPath);
    if (contents === undefined) {
      throw new ConfigError(`Config file not found: ${resolvedPath}`);
    }
    raw = contents;
  } else {
    let found: string | undefined;
    let foundPath = "";
    for (const candidate of searchPaths) {
      const contents = await tryReadFile(candidate);
      if (contents !== undefined) {
        found = contents;
        foundPath = candidate;
        break;
      }
    }
    if (found === undefined) {
      const searched = searchPaths.join(", ");
      throw new ConfigError(
        searchPaths.length === 0
          ? "No config search paths provided"
          : `No config file found. Searched: ${searched}`,
      );
    }
    raw = found;
    resolvedPath = foundPath;
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    throw new ConfigError(
      `Invalid YAML in config file ${resolvedPath}: ${String(err)}`,
      { cause: err },
    );
  }

  try {
    const config = OttoConfigSchema.parse(parsed);
    return postProcess(config);
  } catch (err) {
    if (err instanceof ZodError) {
      const messages = err.issues
        .map((i) => `  ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      throw new ConfigError(
        `Invalid config in ${resolvedPath}:\n${messages}`,
        { cause: err },
      );
    }
    throw err;
  }
}
