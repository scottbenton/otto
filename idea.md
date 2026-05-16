# Otto

Otto is a GitHub-triggered local agent runner. A trusted user mentions `otto` in an issue, pull request conversation, or pull request line comment. Otto detects that mention by polling GitHub directly, runs a configured AI agent locally, and updates GitHub with progress and results — all as the authenticated user, with comments clearly marked as coming from Otto.

## Goals

- Let trusted users ask for code changes, ticket implementation, or read-only answers directly from GitHub comments.
- Keep everything local: polling, cloning, running agents, committing, pushing.
- No cloud backend. No accounts. No infrastructure to host.
- Stay agent-agnostic so Codex, Claude, local LLMs, Aider, or custom commands can all be used.
- Avoid duplicate work using GitHub comments as the source of truth and claim mechanism.

## High-Level Architecture

```text
Local Otto Daemon
  -> poll GitHub API per watched repo
  -> discard comments not authored by the authenticated user (first gate)
  -> discard comments where created_at predates last-polled timestamp
  -> detect otto trigger keyword
  -> debounce and batch mentions by target (issue/PR)
  -> check for existing Otto status comment before claiming
  -> post status comment (as user, clearly marked as Otto)
  -> hydrate fresh GitHub context
  -> classify task intent
  -> prepare repo/worktree when needed
  -> run configured agent
  -> update status comment with result
```

No cloud backend. No webhook infrastructure. No shared database.

## Why Pure Local Polling Works

GitHub exposes two endpoints that each accept a `since` timestamp:

- `GET /repos/{owner}/{repo}/issues/comments?since=<timestamp>` — all issue and PR conversation comments since that time.
- `GET /repos/{owner}/{repo}/pulls/comments?since=<timestamp>` — all PR line/review comments since that time.

This is **2 API calls per watched repo per poll interval**, regardless of how many open issues or PRs exist. The daemon keeps a last-seen timestamp per repo and filters results for the trigger keyword. At a 5-minute poll interval across 5 repos, that is 2 calls/minute — negligible against GitHub's 5,000 request/hour per-token rate limit.

When the machine is asleep, comments accumulate. When the daemon wakes, it catches up on everything it missed. For an async coding agent that already takes minutes to run, the latency is acceptable.

### Edited Comments

Otto only acts on comments based on `created_at`, not `updated_at`. If someone edits an existing comment to add `otto`, that edit is ignored. This avoids ambiguity around re-triggering and simplifies the seen-comment record.

GitHub's `since` parameter filters on `updated_at`, so edited comments may appear in poll results. Otto discards any comment where `created_at` is before the last-polled timestamp.

### Pagination

Otto always paginates each list endpoint until exhausted. The `since` window is overlapped slightly (subtract one second) and deduplication by comment ID handles any resulting duplicates.

## Authenticated User

On startup, Otto resolves the authenticated GitHub user via `GET /user` and stores that login. Only comments authored by this user trigger Otto. All other comments are silently discarded at poll time, before trigger keyword detection — Otto never inspects the body of a comment from anyone else.

This is a hard rule, not a configurable filter. If a teammate wants Otto, they run their own instance with their own PAT.

## Status Comments

Otto posts all status updates as the authenticated user (via their PAT), clearly marked so they are distinguishable from human comments. The comment uses a versioned invisible HTML marker for machine parsing and a visible header for human readability:

```md
<!-- otto:v1 status run=abc123 machine=f47ac10b source=issue_comment:987654321 -->
**[Otto]** Working on this.

Status: running
Agent: claude
Branch: otto/issue-123-short-slug
```

The `machine` field is a UUID generated once at daemon startup and persisted to local state. It identifies which Otto instance posted the comment without exposing the machine hostname.

As the run progresses, Otto edits that same comment in place:

```md
<!-- otto:v1 status run=abc123 machine=f47ac10b source=issue_comment:987654321 -->
**[Otto]** Done.

Status: completed
Agent: claude
Branch: otto/issue-123-short-slug
PR: #456
```

On failure:

```md
<!-- otto:v1 status run=abc123 machine=f47ac10b source=issue_comment:987654321 -->
**[Otto]** Something went wrong.

Status: failed
Agent: claude

To retry, post a new comment: `otto retry`
```

Failure messages must not include raw agent logs, shell output, file paths, or anything that could leak secrets. The agent prompt instructs the agent to return only a short user-facing summary; Otto posts that summary verbatim.

One status comment per original otto mention, updated in place throughout the run lifecycle.

## Duplicate Work Prevention

Deduplication happens at two layers:

- **Comment ID**: Otto records which GitHub comment IDs it has seen and processed, persisted to disk with atomic writes.
- **Status comment check**: Immediately before posting a status comment, Otto re-fetches the comment thread and checks for an existing Otto status comment (any `<!-- otto:v1 status ... -->` marker). If one is found, Otto skips this comment — it was already claimed.

### Duplicate Claim Behavior

If two Otto instances both pass the status comment check and both post a status comment (the race), both will be visible in the thread. On the next poll, each instance checks the thread and finds two status comments. The instance whose `run` ID is not the first (by comment creation order) self-aborts: it updates its own status comment to "aborted (duplicate claim)" and stops.

### Restart Recovery

On startup, Otto scans watched repos for status comments where `machine=<my-uuid>` and `status=running`. These are from a previous crashed session on this machine. Otto updates each to:

```md
<!-- otto:v1 status run=abc123 machine=f47ac10b source=issue_comment:987654321 -->
**[Otto]** Interrupted — the daemon stopped while this was running.

Status: interrupted

To retry, post a new comment: `otto retry`
```

Status comments from a different machine UUID are left untouched.

## Local State

Otto stores minimal local state:

- `state.json`: machine UUID, last-polled timestamp per repo, processed comment IDs. Written atomically (write to temp file, rename).
- `runs/`: per-run metadata files for active runs. Written on claim, removed on completion.
- `otto.lock`: advisory lock file to prevent two Otto processes on the same machine from running simultaneously.

No database. No cloud.

## Batching

Otto debounces mentions by target (repo + issue number, or repo + PR number):

- When a new mention is detected for a target, Otto waits N seconds (default 60, configurable) for additional mentions on the same target before starting.
- All mentions that arrive within the debounce window are processed as one batch by a single agent run.
- Each mention gets its own status comment, all updated individually.
- For MVP, if the batch partially succeeds, all status comments receive the same result summary. Per-mention granularity can be added when agent output contracts are more mature.

If a new mention arrives after the debounce window has closed and a run is already active for that target, Otto queues it and starts a new batch after the current run completes. The second batch fetches fresh GitHub context and sees all changes from the first run.

## Concurrency

Otto tracks in-flight targets in memory (`inFlightTargets: Set<string>`, keyed by `owner/repo#number`). Only one run per target (issue or PR) runs at a time. Different targets in the same repo run concurrently with separate worktrees and branches.

A global concurrency cap (default 3, configurable) limits total simultaneous runs to avoid overwhelming the machine.

## Task Classification

Natural comments should work without rigid syntax:

```text
otto
otto can you fix this?
otto why is this failing?
otto implement this issue
otto add tests for this case
otto retry
```

Internally, Otto normalizes each invocation into a structured classification:

- `answer`: read-only response, no worktree needed.
- `modify_existing_pr`: push changes to the current PR head branch (same-repo PRs only).
- `implement_issue`: create a branch/worktree and open a pull request.
- `clarify`: ask the user a question before acting.
- `ignore`: keyword was not an actual invocation, user is not in the allowed list, or the task is not actionable.

A bare `otto` with no other text attempts to infer intent from the surrounding thread (parent comments, issue body, PR description). If intent cannot be confidently determined, Otto responds with `clarify` rather than attempting a write operation. It never guesses on destructive actions.

`otto retry` re-triggers the task from the original invocation context. It creates a new task and new run, not a mutation of the failed one.

Classification starts rule-based and can become LLM-assisted later. Classification gates capabilities. A read-only task does not receive write/push permissions.

### Cancellation

Cancellation is not supported in MVP. `otto cancel`, `otto stop`, and similar phrases are reserved keywords that Otto responds to with a message explaining they are not yet supported. They do not trigger classification or agent runs.

## GitHub Context Hydration

After claiming a task, Otto fetches fresh context. Everything is re-fetched at run time; nothing from the webhook or poll payload is used as authoritative content.

Context fetched per comment type:

- **Issue comments**: issue title, body, labels, author, state, all comments.
- **PR conversation comments**: PR title, body, labels, state, base/head refs, all comments, review comments.
- **PR line comments**: file path, diff hunk, review thread, PR body, related comments. Only non-outdated line comments are acted on; outdated comments trigger a `clarify` response explaining the context is stale.

Large PRs with many comments are truncated at a configurable limit (default: 200 comments). Truncation is noted in the context passed to the agent.

### MVP Scope: Comment Types

MVP triggers on:
- `issue_comment.created` (covers both issues and PR conversation)
- `pull_request_review_comment.created` (PR line comments, non-outdated only)

MVP excludes:
- PR review bodies (`pull_request_review.submitted`) — design for this can be added later.
- Fork PR modifications — Otto does not push to branches in forked repos. If `modify_existing_pr` is classified and the PR head is from a fork, Otto responds with `clarify` explaining the limitation.

## Repository And Worktree Management

Otto uses configured roots:

- `reposDir`: repository checkouts.
- `worktreesDir`: per-task worktrees.

Behavior:

- Reuse existing local repo or clone if missing.
- Before using a worktree, assert it is clean. If uncommitted changes exist from a previous run, fail with a message rather than silently overwriting.
- For `implement_issue`: fetch, update primary branch, create deterministic branch and worktree, run agent, push.
- For `modify_existing_pr`: check out PR head branch in a deterministic worktree, run agent, push. Same-repo PRs only.
- For `answer`: skip worktree unless the agent needs a checkout.

**Branch naming**: `otto/{issue-or-pr-type}-{number}-{short-slug}` where the slug is derived from the issue title, lowercased and hyphenated, truncated to 40 characters.

**Branch collision**: If a branch with the deterministic name already exists, Otto reuses it rather than creating a new one. The worktree is reset to the base branch tip before running the agent. If the existing branch has unmerged work that would be lost, Otto fails with a message instead.

**No force-push**: Otto never force-pushes. If a push is non-fast-forward, Otto fails the run and reports it in the status comment.

Otto does not delete repos or worktrees automatically. Operator cleanup commands are documented separately.

## Commits

The agent is responsible for creating commits. This allows agents to produce meaningful commit messages and multiple commits when appropriate for large changes. Otto's role is to verify that at least one new commit was created and that the push succeeded.

Agent prompts include an instruction not to leak secrets, paths, tokens, or internal state in commit messages or GitHub-facing output.

## Agent-Agnostic Runner Interface

```ts
interface AgentRunner {
  id: string;
  capabilities: {
    canEdit: boolean;
    canRunShell: boolean;
    supportsStructuredOutput: boolean;
  };
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

interface AgentRunInput {
  task: NormalizedTask;
  context: HydratedGitHubContext;
  repoPaths: { repoDir: string; worktreeDir?: string };
  capabilityGrants: CapabilityGrants;
  timeoutMs: number;
}

interface AgentRunResult {
  success: boolean;
  summary: string;       // short, user-facing, no secrets
  branch?: string;
  commits?: string[];
  error?: string;        // short, user-facing, no secrets
}
```

Runner types:

- Mock runner for deterministic tests.
- Generic command runner: runs a configured shell command, captures exit code and stdout as `summary`.
- Claude adapter.
- Codex adapter.

Every runner has a configurable timeout (default 10 minutes). Exceeded timeout marks the run as failed.

### Output Contract For Generic Command Runners

For MVP, the generic command runner treats stdout as the user-facing summary and exit code as success/failure. Structured JSON output is a later addition. Otto truncates stdout to 500 characters before posting to GitHub.

## Configuration

```yaml
otto:
  trigger: otto
  pollIntervalSeconds: 300
  debounceSeconds: 60
  maxConcurrentRuns: 3

github:
  tokenEnv: GITHUB_TOKEN
  repos:
    - owner/repo

workspace:
  reposDir: ~/dev/otto/repos
  worktreesDir: ~/dev/otto/worktrees

agent:
  default: claude
  timeoutSeconds: 600
  runners:
    claude:
      type: command
      command: claude
    codex:
      type: command
      command: codex
    local:
      type: command
      command: ./scripts/run-local-agent
```

## Suggested Implementation Phases

### Phase 0: Foundation

- TypeScript project scaffold.
- Strict typecheck/lint/test scripts.
- Basic repo README.
- Push to GitHub.

### Phase 1: Polling, Detection, And Claiming

- Config loader and validation.
- GitHub API client (PAT auth, pagination, rate limit handling).
- Per-repo polling loop with atomic `since` timestamp persistence.
- `created_at` filtering.
- Trigger keyword and allowed-user detection.
- Seen-comment deduplication (local state, atomic writes, lock file).
- Status comment existence check (re-fetch before claim).
- Status comment creation and duplicate claim self-abort.
- Startup restart recovery (scan for stale running comments by machine UUID).
- Structured log output.

### Phase 2: Context, Classification, And Batching

- GitHub context hydration (issue, PR conversation, PR line comment).
- Outdated line comment detection.
- Task classification (rule-based).
- Bare `otto` intent inference with `clarify` fallback.
- Debounce/batch accumulator per target.
- `inFlightTargets` concurrency tracking.
- Status comment updates (running → completed/failed/interrupted).

### Phase 3: Agent Execution

- Repo clone/reuse.
- Worktree create/reuse with clean-state assertion.
- Deterministic branch naming and collision handling.
- Agent runner interface.
- Mock runner.
- Generic command runner with timeout.
- Push with non-fast-forward detection (no force-push).
- PR creation for `implement_issue`.
- Per-task status comment final update.
- Failure reporting with retry instructions.
- Secret redaction reminder in agent prompts.

### Phase 4: Hardening

- End-to-end fixture tests with fake GitHub API server.
- CI pipeline: typecheck, lint, tests.
- Retry/backoff on GitHub API errors and secondary rate limits.
- Operator cleanup commands for worktrees and branches.
- Security model documentation.
- Setup docs (token scopes, config, first run).
- Observability.

## Test Strategy

Tests must not require real GitHub credentials. Use a fake GitHub HTTP server for all integration tests.

Coverage targets:

- Authenticated-user check is the first filter applied (comment body never inspected for other authors).
- Trigger detection in comment text.
- `created_at` vs `updated_at` filtering (edited comments ignored).
- Pagination through comment list endpoints.
- Same-timestamp comment deduplication.
- Seen-comment ID deduplication across restarts.
- Status comment existence check before claim.
- Duplicate claim self-abort (two status comments present).
- Restart recovery (stale running comment by machine UUID).
- Bare `otto` clarify fallback.
- Outdated PR line comment handling.
- GitHub context hydration from fixtures.
- Debounce/batch accumulation.
- `inFlightTargets` blocking same-target concurrent runs.
- Task classification.
- Agent runner success/failure/timeout.
- Non-fast-forward push detection.
- Dirty worktree assertion failure.
- Branch collision handling.
- Existing Otto branch reuse.
- Status comment update lifecycle.
- Runner stdout truncation.
- End-to-end task flow: poll → claim → hydrate → classify → run → report.

CI:

```sh
npm run typecheck
npm run lint
npm run test
```

## Open Decisions

- Whether to support `pull_request_review.submitted` as a trigger source (Phase 4+).
- First real agent adapter to ship after the generic command runner.
- Per-mention granularity in batch result reporting (requires structured agent output).
- Whether fork PR support is worth adding and under what restrictions.
- Large PR context summarization strategy.
- LLM-assisted task classification.

## MVP Definition

The MVP is successful when:

- A trusted user comments `otto ...` on a GitHub issue or PR.
- The local daemon detects the comment on the next poll (created_at filter).
- Otto re-fetches the thread and finds no existing status comment.
- Otto posts a status comment with a versioned marker and machine UUID.
- Otto hydrates fresh GitHub context.
- Otto runs a mock or generic command agent.
- Otto updates the status comment with success or failure (no raw logs).
- A duplicate mention of the same comment does not start a second run.
- A duplicate claim self-aborts cleanly.
- A crashed and restarted daemon marks its stale running comments as interrupted.
