---
description: Delegate an investigation, a question, or a fix to Gemini
argument-hint: '[--wait|--background] [--resume] [--plan] [--model <m>] [--effort <e>] <task>'
disable-model-invocation: true
allowed-tools: Bash(node:*), PowerShell(node:*), Write
---

Forward the request to Gemini in one Bash call. If `$ARGUMENTS` has no task text, ask what Gemini should do instead.
`--resume` continues the last Gemini conversation; `--plan` keeps the run read-only.

Use Bash with `run_in_background: true` and end the turn, unless `$ARGUMENTS` has `--wait` or the task is a quick question: then run in the foreground with `timeout: 600000`.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" task "$ARGUMENTS"
```

No Bash tool: write the arguments verbatim to a new UTF-8 file outside the repo, never into the command, then in PowerShell:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" task "--args-file=<file>"; exit $LASTEXITCODE
```

Then summarize Gemini's answer (do not repeat it verbatim) and name any files it changed. On failure, report the error and stop.
