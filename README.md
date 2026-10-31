# Gemini plugin for Claude Code

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-blue.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-npm-green.svg)](tests/)

Claude Code calls Gemini through the [Antigravity CLI](https://antigravity.google/docs/cli/install/) (`agy`) for code review, adversarial review, and delegated tasks. Each turn is one `agy` process: no broker, no daemon, no session hooks.

## Installation

```text
/plugin marketplace add gphcod/gemini-plugin-cc
/plugin install gemini@gemini-plugin-cc
/reload-plugins
/gemini:setup --verify
```

`/reload-plugins` refreshes files the loader already knows. After installing or upgrading to a version that adds or removes commands or skills, start a new Claude Code session.

If you installed 1.x from `m-ghalib/gemini-plugin-cc`, which still runs the retired Gemini CLI, remove it first. Both marketplaces are named `gemini-plugin-cc`.

```text
/plugin uninstall gemini@gemini-plugin-cc
/plugin marketplace remove gemini-plugin-cc
```

## Prerequisites

- Claude Code, signed in.
- Node.js 22 or later on `PATH`.
- The Antigravity CLI installed and signed in: install it from [antigravity.google](https://antigravity.google/docs/cli/install/), then run `agy` once in your own terminal to sign in. Sign-in is interactive, so it cannot run through Claude's `!` prefix.

Version 2.0 replaced Google's Gemini CLI, whose consumer service ended in June 2026, with `agy`. The `/gemini:*` command names are unchanged.

On Windows the plugin runs `git`, `taskkill` and `agy.exe` directly, without a shell, so it does not depend on Git Bash or `cmd.exe` quoting. It has not yet been run on Windows: only macOS is verified.

## Commands

| Command | Purpose |
|---|---|
| `/gemini:review` | Review local changes: verdict and findings by severity |
| `/gemini:adversarial-review` | Challenge the design, its assumptions, and its failure modes |
| `/gemini:rescue` | Delegate an investigation, a question, or a fix |
| `/gemini:status` | List active and recent jobs |
| `/gemini:result` | Replay a finished job's output |
| `/gemini:cancel` | Cancel an active job and its `agy` process tree |
| `/gemini:setup` | Check `agy` and sign-in; toggle the stop-time review gate |

Claude can also start reviews on its own and use the plugin's `gemini` skill to ask, delegate, and follow up. The other commands run only when you type them.

### Which one to use

| You want | Use |
|---|---|
| "Is this change safe to ship?" | `/gemini:review` |
| "Is this the right approach at all?" | `/gemini:adversarial-review` |
| A narrow factual question ("is X true at line Y?") | `/gemini:rescue --plan …` |
| Gemini to investigate or fix something | `/gemini:rescue …` with a real brief: goal, files, what done looks like |
| To continue the last Gemini conversation | `/gemini:rescue --resume …` with only what changed |

Reviews never edit files. Do not fix findings in the same turn as the review; pick which ones to fix first.

## Quick flows

```text
/gemini:review --wait
/gemini:adversarial-review --base main challenge the retry logic under partial failure
/gemini:rescue --plan why does the auth middleware return 403 for valid tokens?
/gemini:rescue --background fix the flaky test in user-service
/gemini:rescue --resume also cover the timeout path
/gemini:setup --enable-review-gate
```

Without `--wait`, reviews and longer tasks run as Claude background tasks. Claude is notified when they finish, so nothing polls. `/gemini:status` and `/gemini:result` work at any time.

## Reference

### Reviews

`/gemini:review [--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [focus …]`

The plugin collects the diff (the working tree when it is dirty, otherwise the branch against its base) and sends it to `agy` as a read-only run (see below) with the review schema passed as `--json-schema`, so `agy` validates the result. Diffs up to 256 KB and 25 files go inline, untracked file contents included. Larger diffs are written to a file in the job folder that Gemini reads with its `read_file` tool, and untracked files are listed by path and size. Exit code 10 means the review has findings.

Read-only runs (reviews, the stop-time gate, and `--plan` tasks) pass `agy` a `--settings` deny list for every write, edit, shell command and MCP call, plus `--sandbox`. `agy` refuses those calls itself, so read-only does not depend on the prompt.

### `/gemini:rescue`

| Flag | Effect |
|---|---|
| `--plan` | Read-only run: `agy` refuses writes, edits, shell commands and MCP calls. Without it, Gemini may edit files, with `agy --sandbox` restricting its terminal commands |
| `--resume` | Continue the last Gemini conversation (`agy --conversation`) |
| `--model <id>` | Any model `agy models` lists; default is `agy`'s own |
| `--effort low\|medium\|high\|xhigh\|max` | Reasoning effort, passed to `agy` |
| `--timeout <s>` | Turn time limit in seconds (default 540, under Claude Code's 10-minute foreground limit) |
| `--wait` / `--background` | Run in the foreground, or as a Claude background task |

> [!WARNING]
> Without `--plan`, Gemini can modify files in your repository. Commit or stash first, and review the diff afterwards. `--sandbox` restricts terminal commands, not file edits.

### Output and exit codes

Each call prints the answer and one footer line, for example `gemini ok · job k3f9 · 41s`. Answers over 24 KiB are cut on screen and the footer adds `full: <file>` with the complete text. A progress line goes to stderr.

| Exit | Meaning |
|---|---|
| 0 | Success |
| 10 | Review completed with findings |
| 20 | `agy` denied a requested action; the task is incomplete |
| 1 | Runtime failure (including `agy`'s own timeout) |
| 2 | Usage error |

Pass `--request-id <id>` to make a retry safe: a call that reuses an id replays the first result instead of running Gemini again.

### Jobs

Jobs are stored per repository under Claude Code's plugin data directory: the last 50 finished jobs, plus every job still running. Each has a 4-character handle that `/gemini:status`, `/gemini:result` and `/gemini:cancel` accept. A job whose companion died, for example because its Bash call timed out, shows as `stalled` and stays cancellable while its `agy` process tree runs. Cancel stops the companion and the recorded `agy` process group, escalating to SIGKILL after 1.5 s.

### Stop-time review gate

`/gemini:setup --enable-review-gate` adds a review of Claude's last turn before each stop. Gemini answers `ALLOW` or `BLOCK`; a block, or a failure to reach Gemini, keeps Claude working with the reason. The gate runs once per stop: when Claude continues because of a block, the next stop is not reviewed again, so a persistent block cannot loop. Gate runs are read-only and never become `--resume` targets. Disable it with `/gemini:setup --disable-review-gate`.

Before calling Gemini, the gate fingerprints the repository (HEAD, `git status`, the staged and unstaged diffs, and untracked files' contents, or size and time for files over 1 MiB). If nothing changed since the last stop it allowed, it lets Claude stop without calling Gemini at all. Otherwise Gemini gets Claude's last message plus the changes since that stop as labelled parts (commits, staged, unstaged), so it judges what changed instead of exploring the repository. Up to 128 KB goes inline; larger changes go to a file Gemini reads. If the changes cannot be handed over, or the gate itself fails, it blocks rather than letting Claude stop unreviewed.

## How it works

```
Claude Code ──Bash──▶ gemini-companion.mjs ──stdin (one NDJSON message)──▶ agy --output-format stream-json
            ◀─answer + footer─            ◀──stream events + terminal result──
```

The companion writes the task to `agy`'s stdin, never to its argument list, so prompts of any size and content are safe. It reads `agy`'s stream events, records the conversation id as soon as `agy` reports it, and treats a denied action, an empty response, a non-success status, or `agy`'s own timeout as a failure. The job log names every tool call and, for a failed one, the target and `agy`'s reason. The `agy` flags and event shapes it relies on are pinned by a live contract test (`npm run test:live`).

`/gemini:setup --verify` runs one minimal read-only turn and reports what `agy` loads into every call on your machine: its input tokens and the number of tools it offers the model.

## Development

Only `plugins/gemini/` is installed; the rest of the repository is the marketplace manifest and tests. No dependencies are needed.

```bash
npm test
```

`npm test` runs the offline suite against a fake `agy` (`tests/fixtures/fake-agy.mjs`). It also fails if the command files drift from `scripts/generate-commands.mjs`, if `SKILL.md` exceeds 3,000 B or a command exceeds 1,000 B, or if the version differs between `package.json`, `plugins/gemini/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`.

```bash
npm run test:live
```

`npm run test:live` checks the `agy` behaviour the plugin relies on against the real CLI. It needs a signed-in `agy` and makes a few small paid calls. Run it after every `agy` upgrade.

```bash
npm run generate-commands
```

Command files are generated: edit `scripts/generate-commands.mjs`, then run `npm run generate-commands`.

`/reload-plugins` does not discover new command or skill files, so start a new Claude Code session after adding one. A command whose frontmatter names a deferred tool (such as `Monitor`) is dropped without an error.

## Attribution

> [!NOTE]
> This plugin is derived from OpenAI's [Codex plugin for Claude Code](https://github.com/openai/codex-plugin-cc), licensed under the Apache License 2.0. State management, job control, rendering, and argument parsing descend from that codebase. The `agy` runner is adapted from the Gemini dual-host bridge design. See [NOTICE](NOTICE).

## License

Apache License 2.0. See [LICENSE](LICENSE).
