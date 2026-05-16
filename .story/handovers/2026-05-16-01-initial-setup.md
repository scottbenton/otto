# Session Handover: Initial Setup

## What happened this session

Designed and structured the Otto project from scratch via extended design discussion, then initialized the storybloq project.

## Key design decisions made

- **Architecture**: Pure local daemon, no cloud backend. GitHub polling only (2 API calls per watched repo per interval).
- **Auth gate**: Only the authenticated user (resolved via GET /user on startup) can trigger Otto. Hard rule, not configurable.
- **Claim mechanism**: Status comment is the distributed lock. Re-fetch thread before posting; if marker found, skip.
- **Duplicate claim**: Two status comments detected → second instance self-aborts (first by creation order wins).
- **Restart recovery**: Machine UUID in status comment marker allows daemon to identify and mark its own stale 'running' comments as 'interrupted' on restart.
- **Edited comments**: Only act on created_at, not updated_at. GitHub since param returns updated comments; filter them out.
- **Batching**: Debounce window (default 60s) per target. One agent run per batch. inFlightTargets prevents same-target concurrency.
- **No force-push**: Ever. Non-fast-forward → fail with message.
- **Agent owns commits**: Better commit messages, multiple commits for large changes.
- **Fork PRs excluded from MVP**: Cannot push to fork branches reliably.
- **PR line comments**: In scope but outdated comments → clarify response.
- **No allowedUsers config**: Removed entirely. Single user only.
- **Status comment format**: <!-- otto:v1 status run=<uuid> machine=<uuid> source=<type>:<id> -->

## PRD location

Full design doc is at idea.md in the project root.

## Quality pipeline configured

TDD (WRITE_TESTS) + tests (TEST) + build (BUILD) enabled. No VERIFY (daemon has no web server).

## What to work on next

Start with T-001: TypeScript scaffold. Run /story to load context and see the full ticket list.