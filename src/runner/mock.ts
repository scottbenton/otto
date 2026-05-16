import type { AgentRunInput, AgentRunResult, AgentRunner, RunnerCapabilities } from "./types.js";

export type MockRunnerOptions = {
  id?: string;
  capabilities?: Partial<RunnerCapabilities>;
  result?: AgentRunResult | ((input: AgentRunInput) => AgentRunResult);
};

const DEFAULT_CAPABILITIES: RunnerCapabilities = {
  canEdit: true,
  canRunShell: false,
  supportsStructuredOutput: false,
};

const DEFAULT_RESULT: AgentRunResult = {
  success: true,
  summary: "Mock run completed.",
};

export class MockRunner implements AgentRunner {
  readonly id: string;
  readonly capabilities: RunnerCapabilities;
  readonly calls: AgentRunInput[] = [];

  private readonly _result: AgentRunResult | ((input: AgentRunInput) => AgentRunResult);

  constructor(opts: MockRunnerOptions = {}) {
    this.id = opts.id ?? "mock";
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...opts.capabilities };
    this._result = opts.result ?? DEFAULT_RESULT;
  }

  run(input: AgentRunInput): Promise<AgentRunResult> {
    this.calls.push(input);
    const result = typeof this._result === "function" ? this._result(input) : this._result;
    return Promise.resolve(result);
  }
}
