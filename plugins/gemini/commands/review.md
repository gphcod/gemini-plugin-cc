---
description: Run a Gemini code review of local git changes (working tree or branch diff)
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [focus ...]'
allowed-tools: Bash(node:*), PowerShell(node:*), Write
---

Run a Gemini code review focused on correctness and regression risk.
Review only: do not edit files or start fixing anything.

Use Bash with `run_in_background: true` and end the turn (the completion notification brings the output), unless `$ARGUMENTS` has `--wait`: then run in the foreground with `timeout: 600000`.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" review "$ARGUMENTS"
```

No Bash tool: write the arguments verbatim to a new UTF-8 file outside the repo, never into the command, then in PowerShell:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" review "--args-file=<file>"; exit $LASTEXITCODE
```

When the output arrives: give the verdict, list every finding by severity with exact file:line, then ask which findings to fix. Exit 10 means findings, not failure. Do not repeat the output verbatim.
