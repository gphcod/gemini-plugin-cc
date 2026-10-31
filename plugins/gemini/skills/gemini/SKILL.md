---
name: gemini
description: Get a code review, second opinion, or delegated task from Gemini through the Antigravity CLI (agy). Use when the user names Gemini or agy.
---

# Gemini via agy

One Bash call per turn: `node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" <sub> [flags] -- <text>`.

| Need | Subcommand |
|---|---|
| Review local changes | `review [--base <ref>] [focus]` |
| Challenge the design | `adversarial-review [--base <ref>] [focus]` |
| Ask, investigate, delegate | `task [--plan] <prompt>` |
| Follow up the last task | `reply [--job <h>] <only what changed>` |
| Replay a finished job | `result [<h>]` |

Flags: `--plan` is read-only (reviews always are); tasks otherwise may edit inside agy's sandbox. `--model` and `--effort low|medium|high|xhigh|max` only when the user asks (`agy models` lists models). `--timeout <s>` (default 540). On a retry pass the same `--request-id <id>`: a repeat id replays the first result instead of starting Gemini again.

Pass long text on a quoted heredoc after `--`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" task --plan -- "$(cat <<'EOF'
<brief>
EOF
)"
```

Run small asks in the foreground with Bash `timeout: 600000`. Run reviews and anything longer with `run_in_background: true` and end the turn: completion arrives as a notification. Never poll status in a loop.

Output: the answer, then one footer `gemini ok · job k3f9 · 41s`. Past 24 KiB the answer is cut and the footer adds `full: <file>`. Exit 0 ok, 10 review has findings, 20 agy denied an action, 1 failure, 2 usage.

Briefs:
- Give a real brief: goal, files to read (paths, not pasted contents), what done looks like, what evidence to return. Not a one-liner.
- Name exact files: agy cannot expand globs such as `tests/*.mjs` and guesses names instead. List the files, or name the directory.
- Follow-ups go through `reply` with only the new instruction and changed facts.
- For a task that may edit, capture `git status` first and inspect the diff after; verify claims you rely on instead of redoing the work.

Results:
- Summarize; never repeat the answer verbatim. Keep file:line references exact and keep Gemini's inferences labelled as inferences.
- Review: list findings by severity, then stop and ask which to fix. Never fix in the same turn as the review.
- Failure: report the error line and stop. Do not substitute your own answer. Missing agy or sign-in: point to `/gemini:setup`.
