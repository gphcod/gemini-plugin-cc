---
description: Run a Gemini review that challenges the implementation approach and design choices
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [focus ...]'
allowed-tools: Bash(node:*), PowerShell(node:*), Write
---

Run an adversarial Gemini review that questions the design, its assumptions, and how it fails under real conditions.
Review only: do not edit files or start fixing anything.

Use Bash with `run_in_background: true` and end the turn (the completion notification brings the output), unless `$ARGUMENTS` has `--wait`: then run in the foreground with `timeout: 600000`.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" adversarial-review "$ARGUMENTS"
```

No Bash tool: write the arguments verbatim to a new UTF-8 file outside the repo, never into the command, then in PowerShell:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" adversarial-review "--args-file=<file>"; exit $LASTEXITCODE
```

When the output arrives: give the verdict, list every finding by severity with exact file:line, then ask which findings to fix. Exit 10 means findings, not failure. Do not repeat the output verbatim.
