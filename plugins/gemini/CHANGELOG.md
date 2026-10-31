# Changelog

## 2.0.0

Runtime moved from Google's Gemini CLI (consumer service ended June 2026) to the Antigravity CLI, `agy`. Command names are unchanged.

- Each turn is one `agy` process: the task goes in on stdin as one NDJSON message and stream-json events come back. The ACP broker, its socket, the ACP client, and the SessionStart/SessionEnd hooks are removed.
- Reviews run in `agy`'s read-only plan mode with the review schema passed as `--json-schema`, so the schema actually reaches the model and `agy` validates the result. 1.0.0 never sent the schema.
- One model-visible skill (`gemini`, 2.4 KB) replaces three skills and the `gemini-rescue` subagent. `/gemini:rescue` now runs the companion in one Bash call.
- `/gemini:review` and `/gemini:adversarial-review` are model-invocable. They no longer size the diff with three git calls and a question first: they run in the background unless `--wait` is given.
- The seven command files are generated from one template (`scripts/generate-commands.mjs`) and checked for drift; together they are 4 KB instead of about 11 KB.
- Output is the answer plus one footer (`gemini ok · job k3f9 · 41s`), 59 B of overhead per call. Answers over 24 KiB are cut on stdout with the full text in a file.
- Exit codes: 0 ok, 10 review findings, 20 action denied, 1 failure, 2 usage.
- New: `reply` / `--resume` continue the last conversation through `agy --conversation`; `--request-id` makes retries replay the first result; `wait` replays a job when it finishes; 4-character job handles.
- `--model` and `--effort` pass through to `agy` unchanged (the Gemini CLI alias table is gone; `agy models` lists models). `--effort` now has an effect.
- Fixed: cancel now reaches a running job (it signals the companion, which kills the `agy` process group, and the recorded `agy` group directly); a cancelled job is no longer overwritten as completed; a failed process-group signal falls back to the pid.
- Fixed: a prompt passed as one argument was re-split into flags (`task "explain the --plan flag"`), losing quotes and backslashes.
- Fixed: the stop-gate marker string had drifted from its prompt, so gate runs could become `--resume` targets. Gate runs are now tagged explicitly. The gate also skips re-review when Claude is continuing because of its own block (`stop_hook_active`), so a persistent block cannot loop.
- Fixed: `agy` hitting its own `--print-timeout` exits 0 with `status: SUCCESS`; that is now reported as an incomplete run.
- The job store has one writer per file: a job's record is written only by the companion running it, `/gemini:cancel` creates a cancel marker that wins when the job is read, and `--request-id` is claimed by exclusively creating a claim file. No lock is needed, so none can go stale, and concurrent calls with one request id start agy once. Claims are never deleted; a retry whose job has been pruned is asked for a new id.
- The companion consumes a cancel itself: it checks the marker right before launching agy and every second while agy runs, so a cancel takes effect even when it could not signal the companion.
- A job whose companion died shows as `stalled` and stays cancellable while its agy process group lives; cancel escalates to SIGKILL for that group itself. Only finished jobs count toward the 50-job history, so a running job is never pruned.
- stdin reads stop after 10 s without input instead of hanging under Claude Code's Bash tool.
- Default turn timeout 540 s (under Claude Code's 10-minute foreground Bash limit).
- Node 22 or later is required. The TypeScript build step is gone.
- Tests run against a fake `agy` (offline) and a live contract suite (`npm run test:live`).

## 1.0.0

- First public release as a standalone open-source repository.
- Fixed Codex leftover references in stop-review-gate prompt.
- Aligned model alias documentation with verified Gemini CLI model IDs.
- Added comprehensive README, test suite, CI/CD, and version management tooling.
- Consolidated general-purpose delegation into `/gemini:rescue` (removed standalone `/gemini:delegate`).
- Removed hardcoded `DEFAULT_MODEL` fallback; Gemini now picks its own default when `--model` is unset.
- Fixed remaining `!gemini` / `GEMINI_API_KEY` auth remediation strings in stop-gate and settings discovery.
- Hardened `.gitignore` to ignore `.gemini/` and `.env.*` (prevents accidental credential commits).
- Added `/reload-plugins` to README install flow (matches upstream baseline).
- Removed `--worktree` flag (ACP mode does not support Gemini's `-w` worktree creation).
- Fixed setup auth guidance to use `gemini auth` instead of nonexistent `!gemini auth`.
- Added ACP capability probe to readiness check (catches incompatible Gemini builds).
- Fixed stop-gate auth remediation to use `/gemini:setup` instead of generic `GEMINI_API_KEY` suggestion.
- Fixed stop-gate review sessions polluting rescue resume state (`--resume` no longer picks up gate threads).
- Fixed `setup --verify` hanging against live Gemini CLI (switched to async spawn, added `mcpServers: []`).
- Removed false ACP filesystem capabilities (client no longer advertises unimplemented `readTextFile`/`writeTextFile`).
- Added runtime test coverage for stop-gate exclusion, ACP capabilities, and verify connectivity.

## 0.1.0

- Initial version of the Gemini plugin for Claude Code.
- Codex-parity architecture: background jobs, workspace-keyed state,
  ACP broker for multiplexed concurrent sessions, Stop-hook review gate,
  `/gemini:setup`, `/gemini:rescue`, `/gemini:review`,
  `/gemini:adversarial-review`, `/gemini:status`, `/gemini:result`,
  `/gemini:cancel` commands.
- `gemini-rescue` subagent (Bash-only forwarder) with default `--yolo --sandbox`.
- Integrates with Google's Gemini CLI via `gemini --acp` (JSON-RPC 2.0 over stdio).
